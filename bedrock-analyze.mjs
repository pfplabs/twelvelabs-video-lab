/** One Pegasus 1.5 description of one uploaded clip.
 * Docs:
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-pegasus-1-5.html
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-twelvelabs-pegasus-v1-5.html
 * Pegasus 1.5 is cross-Region only. modelId is the US geo inference profile.
 * The request body matches the official S3 example: analysis_mode, inputPrompt,
 * mediaSource.s3Location.uri, mediaSource.s3Location.bucketOwner, temperature, maxOutputTokens.
 * InvokeModel returns message and stopReason in the response body. There is no
 * invocation ARN and no S3 output object to discover.
 * bedrock-state.json stores a pending flag before the call. A timeout or other
 * failure leaves that flag set so a rerun does not call again.
 * This file does not read or write vectors/.
 *
 * The S3 URI is built from .env LAB_BUCKET, which overrides a shell value:
 *   s3://<LAB_BUCKET>/lab/input/sintel_trailer-720p.mp4
 * Also set .env LAB_ACCOUNT_ID (12-digit bucket owner; not 123456789012),
 * AWS_REGION=us-east-1, and AWS_PROFILE. The bucket must be in us-east-1.
 * output local-results/sintel_trailer-720p-bedrock.txt
 * state bedrock-state.json
 */
import { randomUUID } from 'node:crypto';
import { open, lstat, mkdir, rename, unlink, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, LabError, readJson, saveJson } from './media-manifest.mjs';

export const CLIP_FILE = 'sintel_trailer-720p.mp4';
export const CLIP_ID = 'sintel_trailer-720p';
export const QUESTION = 'Describe the visible actions in this clip, in order, and state uncertainty explicitly.';
export const MODEL_ID = 'us.twelvelabs.pegasus-1-5-v1:0';
export const REQUIRED_REGION = 'us-east-1';
export const INPUT_PREFIX = 'lab/input';
export const OUTPUT_REL = `local-results/${CLIP_ID}-bedrock.txt`;
const TIMEOUT_MS = 180_000;
const PLACEHOLDER_BUCKET = 'your-unique-bucket-name';
const PLACEHOLDER_ACCOUNT = '123456789012';

function stop(message) {
  throw new LabError(message);
}

export function requestBody({ uri, bucketOwner }) {
  return {
    analysis_mode: 'general',
    inputPrompt: QUESTION,
    mediaSource: {
      s3Location: {
        uri,
        bucketOwner,
      },
    },
    temperature: 0.2,
    maxOutputTokens: 2048,
  };
}

export function clipUri(bucket) {
  return `s3://${bucket}/${INPUT_PREFIX}/${CLIP_FILE}`;
}

export function validateIdentity({ bucket, accountId, region }) {
  if (region !== REQUIRED_REGION) {
    stop('AWS_REGION must be us-east-1 so the bucket region matches this US inference profile. Value redacted.');
  }
  if (typeof accountId !== 'string' || !/^[0-9]{12}$/.test(accountId) || accountId === PLACEHOLDER_ACCOUNT) {
    stop('LAB_ACCOUNT_ID must be your 12-digit bucket owner. The example value was not used.');
  }
  if (typeof bucket !== 'string' || bucket === PLACEHOLDER_BUCKET || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    stop('LAB_BUCKET is missing or still the example name. Nothing was called.');
  }
  return { uri: clipUri(bucket), bucketOwner: accountId };
}

export function planRun(state, outputText, s3Uri) {
  if (state === undefined) return { action: 'invoke' };
  if (!state || state.schema_version !== 1 || state.clip_id !== CLIP_ID || state.prompt !== QUESTION ||
      state.model_id !== MODEL_ID || state.s3_uri !== s3Uri || state.output_file !== OUTPUT_REL) {
    return { action: 'stop', message: 'Saved Bedrock state does not match this clip, question, model, or S3 URI. It was not replaced.' };
  }
  if (state.pending_invoke === true) {
    const name = typeof state.failure_name === 'string' ? state.failure_name : '';
    const detail = typeof state.failure_message === 'string' ? state.failure_message : '';
    const result = name ? ` Last result: ${name}. ${detail}` : '';
    return { action: 'stop', message: `An earlier InvokeModel outcome is uncertain.${result} Reconcile bedrock-state.json before running again. Nothing was called.` };
  }
  if (state.stop_reason === 'length') {
    return { action: 'stop', message: 'The saved response reached maxOutputTokens. The truncated text was not kept. Nothing was called.' };
  }
  if (state.stop_reason === 'stop' && typeof outputText === 'string' && outputText.length > 0) return { action: 'print' };
  if (state.stop_reason === 'stop') {
    return { action: 'stop', message: 'Saved state says the answer was kept, but the output file is missing. Nothing was called.' };
  }
  return { action: 'stop', message: 'Saved Bedrock state is incomplete. Reconcile it before running again. Nothing was called.' };
}

export function acceptAnswer(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, kind: 'unreadable' };
  }
  if (payload.segments != null || payload.finish_reason != null || payload.finishReason != null) {
    return { ok: false, kind: 'other-route' };
  }
  if (payload.stopReason === 'length') return { ok: false, kind: 'length' };
  if (payload.stopReason !== 'stop') return { ok: false, kind: 'unexpected' };
  if (typeof payload.message !== 'string' || payload.message.trim() === '') return { ok: false, kind: 'empty' };
  return { ok: true, message: payload.message };
}

async function saveText(filePath, text) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(text.endsWith('\n') ? text : `${text}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, filePath);
    const directory = await open(dirname(filePath), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
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

function identityRecord(uri) {
  return {
    schema_version: 1,
    clip_id: CLIP_ID,
    prompt: QUESTION,
    model_id: MODEL_ID,
    s3_uri: uri,
    output_file: OUTPUT_REL,
  };
}

async function readOutput(root) {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(join(root, OUTPUT_REL), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    stop('Cannot read the saved Bedrock answer. It was not replaced. Details redacted.');
  }
}

function printAnswer(text, kept) {
  console.log(text.trimEnd());
  console.log('stopReason=stop');
  console.log(kept
    ? `Kept ${OUTPUT_REL}. This description is not evidence. Replay the clip yourself.`
    : 'This description is not evidence. Replay the clip yourself.');
}

async function invokeModel(region, body) {
  let bedrock;
  try {
    bedrock = await import('@aws-sdk/client-bedrock-runtime');
  } catch {
    stop('Bedrock client package is unavailable. Nothing was called. Details redacted.');
  }
  const client = new bedrock.BedrockRuntimeClient({ region, maxAttempts: 1 });
  try {
    return await client.send(new bedrock.InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof LabError) throw error;
    const name = typeof error?.name === 'string' ? error.name : 'Error';
    const detail = typeof error?.message === 'string' ? error.message.slice(0, 500) : 'Details unavailable.';
    const failure = new LabError(`InvokeModel failed: ${name}. ${detail} The pending flag was kept so a rerun will not call again.`);
    failure.failureName = name;
    failure.failureMessage = detail;
    throw failure;
  }
}

function decodePayload(response) {
  try {
    const bytes = response?.body;
    const text = new TextDecoder().decode(bytes);
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
    return payload;
  } catch {
    stop('InvokeModel response was not JSON. The pending flag was kept. Details redacted.');
  }
}

export async function runBedrockAnalyze({ root = ROOT, env = process.env, invoke = invokeModel } = {}) {
  await assertClip(root);
  const { uri, bucketOwner } = validateIdentity({
    bucket: env.LAB_BUCKET,
    accountId: env.LAB_ACCOUNT_ID,
    region: env.AWS_REGION,
  });
  const statePath = join(root, 'bedrock-state.json');
  const outputPath = join(root, OUTPUT_REL);
  let state = await readJson(statePath);
  let outputText = await readOutput(root);
  let plan = planRun(state, outputText, uri);
  if (plan.action === 'print') {
    printAnswer(outputText, true);
    return;
  }
  if (plan.action === 'stop') stop(plan.message);
  if (typeof env.AWS_PROFILE !== 'string' || env.AWS_PROFILE.trim() === '') {
    stop('AWS_PROFILE is unavailable. Nothing was called. Value redacted.');
  }
  if (outputText !== undefined) stop('An output file already exists. It was not replaced. Nothing was called.');
  const lock = join(root, 'bedrock-state.json.lock');
  try { await mkdir(lock); }
  catch { stop('Bedrock state is locked. Check for an active or interrupted run before reconciling the lock.'); }
  try {
    state = await readJson(statePath);
    outputText = await readOutput(root);
    plan = planRun(state, outputText, uri);
    if (plan.action === 'print') {
      printAnswer(outputText, true);
      return;
    }
    if (plan.action === 'stop') stop(plan.message);
    if (outputText !== undefined) stop('An output file already exists. It was not replaced. Nothing was called.');
    const pending = { ...identityRecord(uri), pending_invoke: true };
    await saveJson(statePath, pending);
    let response;
    try {
      response = await invoke(env.AWS_REGION, requestBody({ uri, bucketOwner }));
    } catch (error) {
      if (error instanceof LabError && typeof error.failureName === 'string') {
        await saveJson(statePath, {
          ...pending,
          failure_name: error.failureName,
          failure_message: error.failureMessage ?? '',
        });
      }
      throw error;
    }
    const decision = acceptAnswer(decodePayload(response));
    if (!decision.ok && decision.kind === 'length') {
      await saveJson(statePath, { ...identityRecord(uri), stop_reason: 'length' });
      stop('stopReason=length. The truncated text was not saved. A rerun will not call again.');
    }
    if (!decision.ok) {
      stop('The response was not a completed general answer. The pending flag was kept. Details redacted.');
    }
    await mkdir(dirname(outputPath), { recursive: true });
    await saveText(outputPath, decision.message);
    try {
      await saveJson(statePath, { ...identityRecord(uri), stop_reason: 'stop' });
    } catch {
      stop('The answer file was written but saving bedrock-state.json failed. Reconcile before any further run.');
    }
    printAnswer(decision.message, false);
  } finally {
    await rmdir(lock);
  }
}

async function main() {
  if (process.argv.length !== 2) stop('Run node bedrock-analyze.mjs without arguments.');
  const { default: dotenv } = await import('dotenv');
  const loaded = dotenv.config({ path: join(ROOT, '.env'), quiet: true, override: true });
  if (loaded.error) stop('Local .env is unavailable. Nothing was called. Values redacted.');
  await runBedrockAnalyze();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof LabError ? error.message : 'Run stopped; details redacted.');
    process.exitCode = 1;
  });
}
