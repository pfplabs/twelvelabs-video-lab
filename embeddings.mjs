/** Chapter 4: Marengo 3.5 direct embeddings — async video, sync text.
 * Docs checked for twelvelabs-js 1.3:
 * https://docs.twelvelabs.io/sdk-reference/node-js/create-embeddings-v-2/create-async-embeddings
 * https://docs.twelvelabs.io/sdk-reference/node-js/create-embeddings-v-2/create-sync-embeddings
 * https://docs.twelvelabs.io/sdk-reference/node-js/the-twelve-labs-class#request-options
 * Chapter 2 stores asset ids on state.items. Task ids are stored on state.embed_tasks
 * before polling. A 512-dim task is never reused for another dimension.
 * New tasks request clip scope only. A task created earlier can still include
 * whole-file asset rows; those rows have no timestamps and are skipped.
 * Saved vectors are not evidence. rank.mjs is the next file and is not imported here.
 */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, LabError, readJson, saveJson, verifyManifest } from './media-manifest.mjs';

const OPTIONS = Object.freeze({ maxRetries: 0, timeoutInSeconds: 120 });
const MODEL = 'marengo3.5';
const DIMENSION = 512;
const EMBEDDING_OPTIONS = Object.freeze(['visual', 'audio']);
const QUERY_TEXT = 'a person opens a blue notebook';
const TIMEOUT_MS = 1_800_000;

function stop(message) {
  throw new LabError(message);
}

const validId = value => typeof value === 'string' && value.trim().length > 0;

export function assertRankable(vector) {
  if (!Array.isArray(vector) || vector.length !== DIMENSION) stop(`expected ${DIMENSION}-dim vector`);
  if (!vector.every(value => typeof value === 'number' && Number.isFinite(value))) {
    stop('non-finite or nonnumeric value in vector');
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm)) stop('non-finite vector norm');
  if (norm === 0) stop('zero-norm vector cannot be ranked');
  return vector;
}

function embedKey(clip) {
  return `${clip.id}:${clip.sha256.slice(0, 12)}:${MODEL}:${DIMENSION}:${EMBEDDING_OPTIONS.join('+')}`;
}

function readyAssetId(state, clip) {
  const record = state.items?.[clip.id];
  if (!record || record.sha256 !== clip.sha256) stop('Saved state does not match this clip checksum.');
  if (!validId(record.asset_id)) stop('A clip is missing a saved asset id. Nothing was embedded.');
  if (record.asset_status !== 'ready') stop('A saved asset is not ready. Nothing was embedded.');
  return record.asset_id;
}

function existingTaskId(state, key) {
  if (state.embed_tasks === undefined) return undefined;
  const tasks = state.embed_tasks;
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) {
    stop('state.json embed_tasks is not an object. Nothing was embedded.');
  }
  if (!Object.hasOwn(tasks, key)) return undefined;
  const taskId = tasks[key];
  if (!validId(taskId)) stop('A saved embedding task id is invalid. Reconcile it before creating another task.');
  return taskId;
}

function segmentTimes(segment, index) {
  const start = segment?.startSec;
  const end = segment?.endSec;
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) ||
      start < 0 || end <= start) {
    stop(`segment ${index}: invalid start_sec/end_sec`);
  }
  return { start_sec: start, end_sec: end };
}

export function segmentsFromTask(done) {
  if (done?.status !== 'ready' || !Array.isArray(done.data) || done.data.length === 0) {
    stop('A ready embedding task returned no segment vectors. The saved task id was kept.');
  }
  const segments = [];
  for (const [index, segment] of done.data.entries()) {
    const scope = segment?.embeddingScope ?? null;
    if (scope === 'asset') continue;
    if (scope !== 'clip') stop(`segment ${index}: unexpected embedding_scope`);
    const option = segment.embeddingOption ?? null;
    if (option !== 'visual' && option !== 'audio') stop(`segment ${index}: unexpected embedding_option`);
    assertRankable(segment.embedding);
    segments.push({
      ...segmentTimes(segment, index),
      embedding_option: option,
      embedding_scope: scope,
      embedding: segment.embedding,
    });
  }
  if (segments.length === 0) stop('A ready embedding task returned no clip vectors. The saved task id was kept.');
  return segments;
}

function vectorFileIsComplete(value, clipId) {
  if (!value || value.clip_id !== clipId || value.model !== MODEL || value.dimension !== DIMENSION ||
      JSON.stringify(value.options) !== JSON.stringify(EMBEDDING_OPTIONS) || !Array.isArray(value.segments) ||
      value.segments.length === 0) return false;
  return value.segments.every((segment, index) => {
    try {
      assertRankable(segment?.embedding);
      segmentTimes({ startSec: segment.start_sec, endSec: segment.end_sec }, index);
      return true;
    } catch (error) {
      if (error instanceof LabError) return false;
      throw error;
    }
  });
}

function queryFileIsComplete(value) {
  if (!value || value.text !== QUERY_TEXT || value.model !== MODEL || value.dimension !== DIMENSION) return false;
  try {
    assertRankable(value.embedding);
    return true;
  } catch (error) {
    if (error instanceof LabError) return false;
    throw error;
  }
}

async function startVideoTask(client, state, statePath, clip, assetId) {
  state.embed_tasks ??= {};
  const key = embedKey(clip);
  const saved = existingTaskId(state, key);
  if (saved) {
    console.log(`resuming ${clip.id}: task ${saved}`);
    return saved;
  }
  let task;
  try {
    // https://docs.twelvelabs.io/sdk-reference/node-js/create-embeddings-v-2/create-async-embeddings#create-an-async-embedding-task
    task = await client.embed.v2.tasks.create({
      modelName: MODEL,
      inputType: 'video',
      video: {
        mediaSource: { assetId },
        embeddingOption: [...EMBEDDING_OPTIONS],
        embeddingScope: ['clip'],
      },
      embeddingDimension: DIMENSION,
    }, OPTIONS);
  } catch {
    stop('Embedding task creation failed or its outcome is uncertain. Reconcile TwelveLabs before running again. A rerun would create another task because no task id was saved.');
  }
  if (!validId(task?.id)) {
    stop('Embedding task creation returned no usable ID. Stop and reconcile before running again.');
  }
  state.embed_tasks[key] = task.id;
  try { await saveJson(statePath, state); }
  catch { stop('Remote embedding task may exist but saving its ID failed. Stop and reconcile before any further run.'); }
  return task.id;
}

async function waitTask(client, taskId) {
  const deadline = Date.now() + TIMEOUT_MS;
  let delay = 5_000;
  while (Date.now() < deadline) {
    let done;
    try {
      // https://docs.twelvelabs.io/sdk-reference/node-js/create-embeddings-v-2/create-async-embeddings#retrieve-task-status-and-results
      done = await client.embed.v2.tasks.retrieve(taskId, OPTIONS);
    } catch {
      stop('Embedding status request failed; no automatic retry. The saved task id was kept. Details redacted.');
    }
    const status = done?.status;
    if (status === 'ready') return done;
    if (status === 'failed') stop(`embedding task ended with status=failed. The saved task id was kept.`);
    if (status !== 'processing') stop('Unknown embedding status saved; review it locally before continuing. The saved task id was kept.');
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(delay, remaining)));
    delay = Math.min(delay * 2, 30_000);
  }
  stop(`local timeout — task may still run; re-run to resume. The saved task id was kept.`);
}

async function embedText(client, text) {
  let result;
  try {
    // https://docs.twelvelabs.io/sdk-reference/node-js/create-embeddings-v-2/create-sync-embeddings
    result = await client.embed.v2.create({
      modelName: MODEL,
      inputType: 'multi_input',
      multiInput: { inputText: text },
      embeddingDimension: DIMENSION,
    }, OPTIONS);
  } catch {
    stop('Text embedding failed. No query file was written. Details redacted.');
  }
  const vector = result?.data?.[0]?.embedding;
  return assertRankable(vector);
}

async function planEmbeddings(root, manifest) {
  const clips = await verifyManifest(root, manifest);
  const statePath = join(root, 'state.json');
  const state = await readJson(statePath);
  if (!state || state.schema_version !== 1 || state.corpus !== manifest.corpus) {
    stop('Saved state does not match this manifest; reconcile it without deleting remote IDs.');
  }
  const vectorsDir = join(root, 'vectors');
  const pending = [];
  const kept = [];
  for (const clip of clips) {
    const assetId = readyAssetId(state, clip);
    const vectorPath = join(vectorsDir, `${clip.id}.json`);
    const existing = await readJson(vectorPath);
    const complete = existing !== undefined && vectorFileIsComplete(existing, clip.id);
    if (existing !== undefined && !complete) {
      stop(`Existing vectors for ${clip.id} do not match this model and dimension. They were not replaced.`);
    }
    const taskId = existingTaskId(state, embedKey(clip));
    if (taskId && complete) {
      kept.push(clip.id);
      continue;
    }
    if (complete && !taskId) {
      stop(`Vectors exist for ${clip.id} without a saved task id. Reconcile them before creating another task.`);
    }
    pending.push({ clip, assetId, vectorPath });
  }
  const queryPath = join(vectorsDir, 'query-notebook.json');
  const existingQuery = await readJson(queryPath);
  if (existingQuery !== undefined && !queryFileIsComplete(existingQuery)) {
    stop('Existing query vector does not match this text, model, and dimension. It was not replaced.');
  }
  return {
    state, statePath, vectorsDir, pending, kept, queryPath, needQuery: existingQuery === undefined,
  };
}

function reportKept(plan) {
  for (const clipId of plan.kept) console.log(`${clipId}: kept existing segment vectors`);
  if (!plan.needQuery) console.log('query vector kept');
}

export async function runEmbeddings({ root = ROOT, client, manifest: suppliedManifest } = {}) {
  const manifest = suppliedManifest ?? await readJson(join(root, 'media-manifest.json'));
  const plan = await planEmbeddings(root, manifest);
  reportKept(plan);
  if (!plan.pending.length && !plan.needQuery) {
    console.log('Saved segment and query vectors. Similarity is not evidence; replay the timestamps yourself.');
    return;
  }
  if (!client) stop('Embeddings client is unavailable. Nothing was embedded.');
  const { state, statePath, vectorsDir, pending, queryPath, needQuery } = plan;
  await mkdir(vectorsDir, { recursive: true });
  for (const { clip, assetId, vectorPath } of pending) {
    const taskId = await startVideoTask(client, state, statePath, clip, assetId);
    const done = await waitTask(client, taskId);
    const segments = segmentsFromTask(done);
    await saveJson(vectorPath, {
      clip_id: clip.id,
      model: MODEL,
      dimension: DIMENSION,
      options: [...EMBEDDING_OPTIONS],
      segments,
    });
    console.log(`${clip.id}: ${segments.length} segment vectors`);
  }
  if (needQuery) {
    const embedding = await embedText(client, QUERY_TEXT);
    await saveJson(queryPath, {
      text: QUERY_TEXT,
      model: MODEL,
      dimension: DIMENSION,
      embedding,
    });
    console.log('query vector saved');
  }
  console.log('Saved segment and query vectors. Similarity is not evidence; replay the timestamps yourself.');
}

async function main() {
  if (process.argv.length !== 2) stop('Run node embeddings.mjs without arguments.');
  const manifest = await readJson(join(ROOT, 'media-manifest.json'));
  const plan = await planEmbeddings(ROOT, manifest);
  if (!plan.pending.length && !plan.needQuery) {
    reportKept(plan);
    console.log('Saved segment and query vectors. Similarity is not evidence; replay the timestamps yourself.');
    return;
  }
  const { default: dotenv } = await import('dotenv');
  const loaded = dotenv.config({ path: join(ROOT, '.env'), quiet: true });
  if (loaded.error || !process.env.TWELVELABS_API_KEY) stop('Local .env/API key unavailable; values redacted.');
  const { TwelveLabs } = await import('twelvelabs-js');
  // https://docs.twelvelabs.io/sdk-reference/node-js/the-twelve-labs-class#the-constructor
  const client = new TwelveLabs({ apiKey: process.env.TWELVELABS_API_KEY });
  const lock = join(ROOT, 'state.json.lock');
  try { await mkdir(lock); }
  catch { stop('State is locked. Check for an active or interrupted run before reconciling the lock.'); }
  try { await runEmbeddings({ client, manifest }); }
  finally {
    const { rmdir } = await import('node:fs/promises');
    await rmdir(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof LabError ? error.message : 'Run stopped; details redacted. Keep saved state for reconciliation.');
    process.exitCode = 1;
  });
}
