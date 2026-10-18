/** Timed visual vectors for one uploaded clip, then one local text ranking.
 * Docs:
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-marengo-3.html
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_StartAsyncInvoke.html
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GetAsyncInvoke.html
 * https://docs.twelvelabs.io/docs/cloud-partner-integrations/amazon-bedrock/create-embeddings
 * Video uses StartAsyncInvoke and the base model id. The modelInput keeps the
 * reference video fields and adds embeddingOption visual plus embeddingScope clip
 * so the saved rows are timed visual vectors. Text uses InvokeModel and the US
 * inference profile. The text body is inputType plus text.inputText.
 * Async output is <output prefix>/<invocation id>/output.json. InvokeModel text
 * returns its vector in the response body.
 * bedrock-embed-state.json stores pending_invoke before StartAsyncInvoke. A start
 * with no saved invocation ARN is uncertain, and a rerun does not start another.
 * A saved ARN is resumed with GetAsyncInvoke. pending_text is stored before
 * InvokeModel, and a rerun does not send that call again.
 * This file does not read or write vectors/ or bedrock-state.json.
 *
 * Edit these together. The bucket comes from .env LAB_BUCKET:
 *   clip media/sintel_trailer-720p.mp4
 *   clip id sintel_trailer-720p
 *   question Birds are flying in the scene
 *   input s3://<LAB_BUCKET>/lab/input/sintel_trailer-720p.mp4
 *   output s3://<LAB_BUCKET>/lab/output/bedrock-embed/sintel_trailer-720p
 *   segments local-results/sintel_trailer-720p-bedrock-segments.json
 *   query local-results/sintel_trailer-720p-bedrock-query.json
 *   state bedrock-embed-state.json
 * Also set .env LAB_ACCOUNT_ID (12-digit bucket owner; not 123456789012),
 * AWS_REGION=us-east-1, and AWS_PROFILE. The bucket must be in us-east-1.
 */
import { mkdir, lstat, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, LabError, readJson, saveJson } from './media-manifest.mjs';
import { assertRankable } from './embeddings.mjs';
import { rank } from './rank.mjs';

export const CLIP_FILE = 'sintel_trailer-720p.mp4';
export const CLIP_ID = 'sintel_trailer-720p';
export const QUESTION = 'Birds are flying in the scene';
export const VIDEO_MODEL_ID = 'twelvelabs.marengo-embed-3-0-v1:0';
export const TEXT_MODEL_ID = 'us.twelvelabs.marengo-embed-3-0-v1:0';
export const REQUIRED_REGION = 'us-east-1';
export const INPUT_PREFIX = 'lab/input';
export const OUTPUT_PREFIX = `lab/output/bedrock-embed/${CLIP_ID}`;
export const DIMENSION = 512;
export const SEGMENTS_REL = `local-results/${CLIP_ID}-bedrock-segments.json`;
export const QUERY_REL = `local-results/${CLIP_ID}-bedrock-query.json`;
export const STATE_REL = 'bedrock-embed-state.json';
const POLL_TIMEOUT_MS = 600_000;
const CALL_TIMEOUT_MS = 60_000;
const PLACEHOLDER_BUCKET = 'your-unique-bucket-name';
const PLACEHOLDER_ACCOUNT = '123456789012';
const ARN_PATTERN = /^arn:aws(?:-[^:]+)?:bedrock:[a-z0-9-]{1,20}:[0-9]{12}:async-invoke\/[a-z0-9]{12}$/;

function stop(message) {
  throw new LabError(message);
}

export function videoModelInput({ uri, bucketOwner }) {
  return {
    inputType: 'video',
    video: {
      mediaSource: {
        s3Location: {
          uri,
          bucketOwner,
        },
      },
      embeddingOption: ['visual'],
      embeddingScope: ['clip'],
    },
  };
}

export function outputDataConfig({ s3Uri, bucketOwner }) {
  return {
    s3OutputDataConfig: {
      s3Uri,
      bucketOwner,
    },
  };
}

export function textModelInput(text = QUESTION) {
  return {
    inputType: 'text',
    text: {
      inputText: text,
    },
  };
}

export function clipUri(bucket) {
  return `s3://${bucket}/${INPUT_PREFIX}/${CLIP_FILE}`;
}

export function outputPrefixUri(bucket) {
  return `s3://${bucket}/${OUTPUT_PREFIX}`;
}

export function outputObjectUri(prefix, invocationArn) {
  const id = invocationArn.slice(invocationArn.lastIndexOf('/') + 1);
  const base = prefix.replace(/\/$/, '');
  return `${base}/${id}/output.json`;
}

export function validateIdentity({ bucket, accountId, region }) {
  if (region !== REQUIRED_REGION) {
    stop('AWS_REGION must be us-east-1 so the bucket region matches this US model. Value redacted.');
  }
  if (typeof accountId !== 'string' || !/^[0-9]{12}$/.test(accountId) || accountId === PLACEHOLDER_ACCOUNT) {
    stop('LAB_ACCOUNT_ID must be your 12-digit bucket owner. The example value was not used.');
  }
  if (typeof bucket !== 'string' || bucket === PLACEHOLDER_BUCKET || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    stop('LAB_BUCKET is missing or still the example name. Nothing was called.');
  }
  return { uri: clipUri(bucket), bucketOwner: accountId, outputS3Uri: outputPrefixUri(bucket) };
}

function validArn(value) {
  return typeof value === 'string' && ARN_PATTERN.test(value);
}

function failureDetail(state) {
  const name = typeof state?.failure_name === 'string' ? state.failure_name : '';
  const detail = typeof state?.failure_message === 'string' ? state.failure_message : '';
  return name ? ` Last result: ${name}. ${detail}` : '';
}

function sameIdentity(state, s3Uri, outputS3Uri) {
  return Boolean(state) && state.schema_version === 1 && state.clip_id === CLIP_ID && state.prompt === QUESTION &&
    state.model_id === VIDEO_MODEL_ID && state.text_model_id === TEXT_MODEL_ID && state.s3_uri === s3Uri &&
    state.output_s3_uri === outputS3Uri && state.segments_file === SEGMENTS_REL && state.query_file === QUERY_REL;
}

function segmentsAreComplete(value, s3Uri, outputS3Uri) {
  if (!value || value.clip_id !== CLIP_ID || value.prompt !== QUESTION || value.model !== VIDEO_MODEL_ID ||
      value.dimension !== DIMENSION || value.embedding_option !== 'visual' || value.embedding_scope !== 'clip' ||
      value.s3_uri !== s3Uri || value.output_s3_uri !== outputS3Uri || !Array.isArray(value.segments) ||
      value.segments.length === 0) return false;
  return value.segments.every(segment => {
    try {
      assertRankable(segment?.embedding);
      const start = segment.start_sec;
      const end = segment.end_sec;
      return segment.embedding_option === 'visual' && segment.embedding_scope === 'clip' &&
        typeof start === 'number' && typeof end === 'number' && Number.isFinite(start) &&
        Number.isFinite(end) && start >= 0 && end > start;
    } catch (error) {
      if (error instanceof LabError) return false;
      throw error;
    }
  });
}

function queryIsComplete(value) {
  if (!value || value.text !== QUESTION || value.model !== TEXT_MODEL_ID || value.dimension !== DIMENSION) return false;
  try {
    assertRankable(value.embedding);
    return true;
  } catch (error) {
    if (error instanceof LabError) return false;
    throw error;
  }
}

export function planRun(state, segmentsValue, queryValue, s3Uri, outputS3Uri) {
  if (state === undefined) {
    if (segmentsValue !== undefined || queryValue !== undefined) {
      return { action: 'stop', message: 'An output file already exists. It was not replaced. Nothing was called.' };
    }
    return { action: 'start-video' };
  }
  if (!sameIdentity(state, s3Uri, outputS3Uri)) {
    return { action: 'stop', message: 'Saved Bedrock embed state does not match this clip, question, model, or S3 URI. It was not replaced.' };
  }
  if (state.video_status === 'Failed') {
    return { action: 'stop', message: `The saved async invoke failed.${failureDetail(state)} Reconcile bedrock-embed-state.json before running again. Nothing was called.` };
  }
  if (state.pending_invoke === true && !validArn(state.invocation_arn)) {
    return { action: 'stop', message: `An earlier StartAsyncInvoke outcome is uncertain.${failureDetail(state)} Reconcile bedrock-embed-state.json before running again. Nothing was called.` };
  }
  const segmentsOk = segmentsAreComplete(segmentsValue, s3Uri, outputS3Uri);
  if (segmentsValue !== undefined && !segmentsOk) {
    return { action: 'stop', message: 'Existing segment vectors do not match this clip, model, and S3 URI. They were not replaced.' };
  }
  if (!segmentsOk) {
    if (validArn(state.invocation_arn)) return { action: 'resume-video', invocationArn: state.invocation_arn };
    return { action: 'stop', message: 'Saved Bedrock embed state is incomplete. Reconcile it before running again. Nothing was called.' };
  }
  if (state.pending_invoke === true) {
    return { action: 'stop', message: 'Segment vectors exist but the async invoke is still marked pending. Reconcile bedrock-embed-state.json before running again. Nothing was called.' };
  }
  if (state.pending_text === true) {
    return { action: 'stop', message: `An earlier InvokeModel outcome is uncertain.${failureDetail(state)} Reconcile bedrock-embed-state.json before running again. Nothing was called.` };
  }
  const queryOk = queryIsComplete(queryValue);
  if (queryValue !== undefined && !queryOk) {
    return { action: 'stop', message: 'Existing query vector does not match this question, model, and dimension. It was not replaced.' };
  }
  if (!queryOk) return { action: 'embed-text' };
  return { action: 'rank' };
}

function optionIsVisual(value) {
  return value === 'visual' || (Array.isArray(value) && value.length === 1 && value[0] === 'visual');
}

function scopeIsClip(value) {
  return value === 'clip' || (Array.isArray(value) && value.length === 1 && value[0] === 'clip');
}

function rowsFrom(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && typeof payload.data === 'object') return [payload.data];
  return null;
}

export function acceptSegments(payload) {
  const rows = rowsFrom(payload);
  if (!rows || rows.length === 0) return { ok: false, kind: 'empty' };
  const segments = [];
  for (const [index, row] of rows.entries()) {
    if (!optionIsVisual(row?.embeddingOption)) return { ok: false, kind: 'option', index };
    if (!scopeIsClip(row?.embeddingScope)) return { ok: false, kind: 'scope', index };
    const start = row.startSec;
    const end = row.endSec;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) ||
        start < 0 || end <= start) return { ok: false, kind: 'time', index };
    try {
      segments.push({
        start_sec: start,
        end_sec: end,
        embedding_option: 'visual',
        embedding_scope: 'clip',
        embedding: assertRankable(row.embedding),
      });
    } catch (error) {
      if (error instanceof LabError) return { ok: false, kind: 'vector', index };
      throw error;
    }
  }
  return { ok: true, segments };
}

export function acceptQuery(payload) {
  const rows = rowsFrom(payload);
  if (!rows || rows.length !== 1) return { ok: false, kind: 'count' };
  const row = rows[0];
  if (row?.embeddingOption != null && !optionIsVisual(row.embeddingOption)) return { ok: false, kind: 'option' };
  if (row?.embeddingScope != null || row?.startSec != null || row?.endSec != null) return { ok: false, kind: 'other-route' };
  try {
    return { ok: true, embedding: assertRankable(row.embedding) };
  } catch (error) {
    if (error instanceof LabError) return { ok: false, kind: 'vector' };
    throw error;
  }
}

function identityRecord(uri, outputS3Uri) {
  return {
    schema_version: 1,
    clip_id: CLIP_ID,
    prompt: QUESTION,
    model_id: VIDEO_MODEL_ID,
    text_model_id: TEXT_MODEL_ID,
    s3_uri: uri,
    output_s3_uri: outputS3Uri,
    segments_file: SEGMENTS_REL,
    query_file: QUERY_REL,
  };
}

function segmentRecord(uri, outputS3Uri, segments) {
  return {
    clip_id: CLIP_ID,
    prompt: QUESTION,
    model: VIDEO_MODEL_ID,
    dimension: DIMENSION,
    embedding_option: 'visual',
    embedding_scope: 'clip',
    s3_uri: uri,
    output_s3_uri: outputS3Uri,
    segments,
  };
}

async function assertClip(root) {
  const manifest = await readJson(join(root, 'media-manifest.json'));
  const clips = manifest?.clips;
  const listed = Array.isArray(clips) && clips.some(clip => clip?.id === CLIP_ID && clip?.file === `media/${CLIP_FILE}`);
  if (!listed) stop('Manifest has no matching clip id and filename. Nothing was called.');
  let info;
  try { info = await lstat(join(root, 'media', CLIP_FILE)); }
  catch { stop('Local clip file is missing. Nothing was called.'); }
  if (!info.isFile()) stop('Local clip path is not a file. Nothing was called.');
}

function asFailure(error, label, kept) {
  if (error instanceof LabError) throw error;
  const name = typeof error?.name === 'string' ? error.name : 'Error';
  const detail = typeof error?.message === 'string' ? error.message.slice(0, 500) : 'Details unavailable.';
  const failure = new LabError(`${label} failed: ${name}. ${detail} ${kept}`);
  failure.failureName = name;
  failure.failureMessage = detail;
  throw failure;
}

function decodePayload(response) {
  try {
    const text = new TextDecoder().decode(response?.body);
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
    return payload;
  } catch {
    stop('InvokeModel response was not JSON. The pending flag was kept. Details redacted.');
  }
}

async function loadBedrock(region) {
  let bedrock;
  try {
    bedrock = await import('@aws-sdk/client-bedrock-runtime');
  } catch {
    stop('Bedrock client package is unavailable. Nothing was called. Details redacted.');
  }
  return { bedrock, client: new bedrock.BedrockRuntimeClient({ region, maxAttempts: 1 }) };
}

async function startVideo(region, modelInput, dataConfig) {
  const { bedrock, client } = await loadBedrock(region);
  try {
    return await client.send(new bedrock.StartAsyncInvokeCommand({
      modelId: VIDEO_MODEL_ID,
      modelInput,
      outputDataConfig: dataConfig,
    }), { abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch (error) {
    asFailure(error, 'StartAsyncInvoke', 'The pending flag was kept so a rerun will not call again.');
  }
}

async function getVideo(region, invocationArn) {
  const { bedrock, client } = await loadBedrock(region);
  try {
    return await client.send(new bedrock.GetAsyncInvokeCommand({
      invocationArn,
    }), { abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch (error) {
    asFailure(error, 'GetAsyncInvoke', 'The saved invocation was kept. A rerun resumes it and does not start another.');
  }
}

async function embedText(region, body) {
  const { bedrock, client } = await loadBedrock(region);
  try {
    return await client.send(new bedrock.InvokeModelCommand({
      modelId: TEXT_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    }), { abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch (error) {
    asFailure(error, 'InvokeModel', 'The pending flag was kept so a rerun will not call again.');
  }
}

function parseS3Uri(uri) {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) stop('The output object URI is not an s3://bucket/key path. Nothing was replaced.');
  return { bucket: match[1], key: match[2] };
}

async function readOutputJson(region, uri) {
  let s3;
  try {
    s3 = await import('@aws-sdk/client-s3');
  } catch {
    stop('S3 client package is unavailable. The saved invocation was kept. Details redacted.');
  }
  const { bucket, key } = parseS3Uri(uri);
  const client = new s3.S3Client({ region, maxAttempts: 1 });
  try {
    const response = await client.send(new s3.GetObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const bytes = await response.Body.transformToByteArray();
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload || typeof payload !== 'object') throw new Error();
    return payload;
  } catch (error) {
    if (error instanceof LabError) throw error;
    stop('The async output could not be read. The saved invocation was kept. Details redacted.');
  }
}

function reportedPrefixMatches(reported, prefix) {
  if (reported == null) return true;
  if (typeof reported !== 'string') return false;
  const left = reported.replace(/\/$/, '');
  const right = prefix.replace(/\/$/, '');
  return left === right || left.startsWith(`${right}/`);
}

async function waitVideo(region, invocationArn, outputS3Uri, getInvoke) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let delay = 5_000;
  while (Date.now() < deadline) {
    const response = await getInvoke(region, invocationArn);
    const status = response?.status;
    if (status === 'Completed') {
      const reported = response?.outputDataConfig?.s3OutputDataConfig?.s3Uri;
      if (!reportedPrefixMatches(reported, outputS3Uri)) {
        stop('GetAsyncInvoke reported a different output S3 URI. The saved invocation was kept. Nothing was replaced.');
      }
      return response;
    }
    if (status === 'Failed') {
      const detail = typeof response?.failureMessage === 'string' ? response.failureMessage.slice(0, 500) : '';
      const failure = new LabError('Async invoke ended with status=Failed. The saved invocation was kept.');
      failure.failureName = 'Failed';
      failure.failureMessage = detail;
      failure.terminal = true;
      throw failure;
    }
    if (status !== 'InProgress') {
      stop('Unknown async status. The saved invocation was kept. Review it locally before continuing.');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(delay, remaining)));
    delay = Math.min(delay * 2, 30_000);
  }
  stop('local timeout — invocation may still run; re-run to resume. The saved invocation was kept.');
}

function printHits(hits, kept) {
  for (const hit of hits) {
    console.log(`${hit.score.toFixed(3)}  ${CLIP_ID}  ${hit.start_sec.toFixed(1)}-${hit.end_sec.toFixed(1)}s  visual`);
  }
  console.log(kept
    ? `Kept ${SEGMENTS_REL} and ${QUERY_REL}. These scores are not evidence. Replay the timestamps yourself.`
    : 'These scores are not evidence. Replay the timestamps yourself.');
}

async function saveFailure(statePath, record, error) {
  if (!(error instanceof LabError) || typeof error.failureName !== 'string') return;
  await saveJson(statePath, {
    ...record,
    failure_name: error.failureName,
    failure_message: error.failureMessage ?? '',
    ...(error.terminal ? { pending_invoke: false, video_status: 'Failed' } : {}),
  });
}

export async function runBedrockEmbed({
  root = ROOT,
  env = process.env,
  startInvoke = startVideo,
  getInvoke = getVideo,
  readOutput = readOutputJson,
  invokeText = embedText,
} = {}) {
  await assertClip(root);
  const { uri, bucketOwner, outputS3Uri } = validateIdentity({
    bucket: env.LAB_BUCKET,
    accountId: env.LAB_ACCOUNT_ID,
    region: env.AWS_REGION,
  });
  const statePath = join(root, STATE_REL);
  const segmentsPath = join(root, SEGMENTS_REL);
  const queryPath = join(root, QUERY_REL);
  let state = await readJson(statePath);
  let segmentsValue = await readJson(segmentsPath);
  let queryValue = await readJson(queryPath);
  let plan = planRun(state, segmentsValue, queryValue, uri, outputS3Uri);
  if (plan.action === 'rank') {
    printHits(rank(segmentsValue.segments, queryValue.embedding), true);
    return;
  }
  if (plan.action === 'stop') stop(plan.message);
  if (typeof env.AWS_PROFILE !== 'string' || env.AWS_PROFILE.trim() === '') {
    stop('AWS_PROFILE is unavailable. Nothing was called. Value redacted.');
  }
  const lock = join(root, `${STATE_REL}.lock`);
  try { await mkdir(lock); }
  catch { stop('Bedrock embed state is locked. Check for an active or interrupted run before reconciling the lock.'); }
  try {
    state = await readJson(statePath);
    segmentsValue = await readJson(segmentsPath);
    queryValue = await readJson(queryPath);
    plan = planRun(state, segmentsValue, queryValue, uri, outputS3Uri);
    if (plan.action === 'rank') {
      printHits(rank(segmentsValue.segments, queryValue.embedding), true);
      return;
    }
    if (plan.action === 'stop') stop(plan.message);
    const identity = identityRecord(uri, outputS3Uri);
    let arn = plan.invocationArn;
    if (plan.action === 'start-video') {
      const pending = { ...identity, pending_invoke: true };
      await saveJson(statePath, pending);
      let started;
      try {
        started = await startInvoke(env.AWS_REGION, videoModelInput({ uri, bucketOwner }), outputDataConfig({
          s3Uri: outputS3Uri,
          bucketOwner,
        }));
      } catch (error) {
        await saveFailure(statePath, pending, error);
        throw error;
      }
      arn = started?.invocationArn;
      if (!validArn(arn)) {
        stop('StartAsyncInvoke returned no usable invocation ARN. The pending flag was kept. Nothing else was called.');
      }
      try {
        await saveJson(statePath, { ...pending, invocation_arn: arn });
      } catch {
        stop('Remote invocation may exist but saving its ARN failed. Stop and reconcile before any further run.');
      }
    }
    if (plan.action === 'start-video' || plan.action === 'resume-video') {
      const pending = { ...identity, pending_invoke: true, invocation_arn: arn };
      try {
        await waitVideo(env.AWS_REGION, arn, outputS3Uri, getInvoke);
      } catch (error) {
        await saveFailure(statePath, pending, error);
        throw error;
      }
      const payload = await readOutput(env.AWS_REGION, outputObjectUri(outputS3Uri, arn));
      const decision = acceptSegments(payload);
      if (!decision.ok) {
        stop('The async output was not timed visual clip vectors. The saved invocation was kept. Details redacted.');
      }
      await mkdir(dirname(segmentsPath), { recursive: true });
      await saveJson(segmentsPath, segmentRecord(uri, outputS3Uri, decision.segments));
      try {
        await saveJson(statePath, { ...identity, invocation_arn: arn, pending_invoke: false, video_status: 'Completed' });
      } catch {
        stop('Segment vectors were written but saving bedrock-embed-state.json failed. Reconcile before any further run.');
      }
      segmentsValue = await readJson(segmentsPath);
      console.log(`${decision.segments.length} segment vectors`);
    }
    state = await readJson(statePath);
    queryValue = await readJson(queryPath);
    plan = planRun(state, segmentsValue, queryValue, uri, outputS3Uri);
    if (plan.action === 'rank') {
      printHits(rank(segmentsValue.segments, queryValue.embedding), false);
      return;
    }
    if (plan.action !== 'embed-text') stop(plan.message ?? 'Saved Bedrock embed state is incomplete. Reconcile it before running again. Nothing was called.');
    const pendingText = { ...state, pending_text: true };
    await saveJson(statePath, pendingText);
    let response;
    try {
      response = await invokeText(env.AWS_REGION, textModelInput());
    } catch (error) {
      await saveFailure(statePath, pendingText, error);
      throw error;
    }
    const queryDecision = acceptQuery(decodePayload(response));
    if (!queryDecision.ok) {
      stop('The response was not one text vector. The pending flag was kept. Details redacted.');
    }
    await mkdir(dirname(queryPath), { recursive: true });
    await saveJson(queryPath, {
      text: QUESTION,
      model: TEXT_MODEL_ID,
      dimension: DIMENSION,
      embedding: queryDecision.embedding,
    });
    try {
      await saveJson(statePath, { ...pendingText, pending_text: false });
    } catch {
      stop('The query file was written but saving bedrock-embed-state.json failed. Reconcile before any further run.');
    }
    queryValue = await readJson(queryPath);
    printHits(rank(segmentsValue.segments, queryValue.embedding), false);
  } finally {
    await rmdir(lock);
  }
}

async function main() {
  if (process.argv.length !== 2) stop('Run node bedrock-embed.mjs without arguments.');
  const { default: dotenv } = await import('dotenv');
  const loaded = dotenv.config({ path: join(ROOT, '.env'), quiet: true, override: true });
  if (loaded.error) stop('Local .env is unavailable. Nothing was called. Values redacted.');
  await runBedrockEmbed();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof LabError ? error.message : 'Run stopped; details redacted.');
    process.exitCode = 1;
  });
}
