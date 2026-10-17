/** One async Pegasus 1.6 segmentation task per ready clip.
 * Docs checked for twelvelabs-js 1.3:
 * https://docs.twelvelabs.io/sdk-reference/node-js/analyze-videos/async-analysis
 * https://docs.twelvelabs.io/docs/guides/segment-videos
 * https://docs.twelvelabs.io/sdk-reference/node-js/the-twelve-labs-class#request-options
 * Chapter 2 stores asset ids on state.items. Task ids are stored on state.segment_tasks.
 * A prompt is not sent: time_based_metadata rejects prompt and promptV2.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LabError, ROOT, readJson, saveJson } from './media-manifest.mjs';

const OPTIONS = Object.freeze({ maxRetries: 0, timeoutInSeconds: 120 });
const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 120;
const DEFINITION_ID = 'desk-actions';
const SEGMENT_DEFINITION = Object.freeze({
  id: DEFINITION_ID,
  description: 'A continuous visible action, from when it starts until it ends or a different action begins.',
  fields: Object.freeze([
    Object.freeze({
      name: 'action',
      type: 'string',
      description: 'The visible action in this segment.',
    }),
    Object.freeze({
      name: 'uncertainty',
      type: 'string',
      description: 'What is uncertain, occluded, or not clearly visible about this action.',
    }),
  ]),
});
const WAITING = Object.freeze(['queued', 'pending', 'processing']);

function stop(message) {
  throw new LabError(message);
}

function clipRecords(state) {
  const items = state?.items;
  if (!items || typeof items !== 'object' || Array.isArray(items)) {
    stop('state.json has no clip items. Asset ids from Chapter 2 are under items.');
  }
  if (!Array.isArray(state.clips) || state.clips.length === 0) stop('state.json has no clips.');
  if (state.clips.length !== Object.keys(items).length) {
    stop('state.json clips and items do not match. Nothing was segmented.');
  }
  const records = [];
  const seen = new Set();
  for (const clip of state.clips) {
    const clipId = clip?.id;
    if (typeof clipId !== 'string' || clipId !== path.basename(clipId) || seen.has(clipId)) {
      stop('A clip id is not a single filename. Nothing was segmented.');
    }
    seen.add(clipId);
    const assetId = items[clipId]?.asset_id;
    if (typeof assetId !== 'string' || assetId.trim() === '') {
      stop('A clip is missing a saved asset id. Nothing was segmented.');
    }
    if (items[clipId].asset_status !== 'ready') stop('A saved asset is not ready. Nothing was segmented.');
    records.push({ clipId, assetId });
  }
  return records;
}

function existingTaskId(state, clipId) {
  if (state.segment_tasks === undefined) return undefined;
  const tasks = state.segment_tasks;
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) {
    stop('state.json segment_tasks is not an object. Nothing was segmented.');
  }
  if (!Object.hasOwn(tasks, clipId)) return undefined;
  const taskId = tasks[clipId];
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    stop('A saved segment task id is invalid. Reconcile it before creating another task.');
  }
  return taskId;
}

export function segmentsFromPayload(data) {
  if (typeof data !== 'string') stop('Analysis result data was not a JSON string. Nothing was saved.');
  let parsed;
  try { parsed = JSON.parse(data); }
  catch { stop('Analysis result data was not valid JSON. Nothing was saved.'); }
  const list = parsed?.[DEFINITION_ID];
  if (!Array.isArray(list)) stop('Analysis result has no desk-actions array. Nothing was saved.');
  return list.map(segment => {
    const start = segment?.start_time;
    const end = segment?.end_time;
    const metadata = segment?.metadata;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0 || start >= end) {
      stop('A segment has invalid times. Nothing was saved.');
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
        typeof metadata.action !== 'string' || typeof metadata.uncertainty !== 'string') {
      stop('A segment is missing string action and uncertainty. Nothing was saved.');
    }
    return {
      start_sec: start,
      end_sec: end,
      metadata: { action: metadata.action, uncertainty: metadata.uncertainty },
    };
  });
}

async function createTask(client, state, statePath, clipId, assetId) {
  if (typeof state.pending_segment_task === 'string') {
    stop('Segment task creation outcome is uncertain. Reconcile the saved intent with TwelveLabs before running again; nothing will be recreated.');
  }
  state.pending_segment_task = clipId;
  await saveJson(statePath, state);
  let created;
  try {
    // https://docs.twelvelabs.io/sdk-reference/node-js/analyze-videos/async-analysis#create-an-async-analysis-task
    created = await client.analyzeAsync.tasks.create({
      modelName: 'pegasus1.6',
      video: { type: 'asset_id', assetId },
      analysisMode: 'time_based_metadata',
      responseFormat: {
        type: 'segment_definitions',
        segmentDefinitions: [SEGMENT_DEFINITION],
      },
    }, OPTIONS);
  } catch {
    stop('Segment task creation failed or its outcome is uncertain. Reconcile the saved intent before running again; details redacted.');
  }
  const taskId = created?.taskId;
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    stop('Segment task creation returned no task id. Stop and reconcile the saved intent.');
  }
  if (state.segment_tasks === undefined) state.segment_tasks = {};
  if (!state.segment_tasks || typeof state.segment_tasks !== 'object' || Array.isArray(state.segment_tasks)) {
    stop('state.json segment_tasks is not an object. The new task id was not saved.');
  }
  state.segment_tasks[clipId] = taskId;
  delete state.pending_segment_task;
  try { await saveJson(statePath, state); }
  catch { stop('Remote task may exist but saving its ID failed. Stop and reconcile before any further run.'); }
  return taskId;
}

async function waitReady(client, taskId) {
  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    let task;
    try {
      // https://docs.twelvelabs.io/sdk-reference/node-js/analyze-videos/async-analysis#retrieve-task-status-and-results
      task = await client.analyzeAsync.tasks.retrieve(taskId, OPTIONS);
    } catch {
      stop('Analysis status request failed. Re-run to resume.');
    }
    if (task?.status === 'failed' || task?.status === 'canceled') stop(`Analysis task ${task.status}.`);
    if (task?.status === 'ready') {
      if (task.error) stop('Analysis task reported incomplete segment results. Nothing was saved.');
      return task;
    }
    if (!WAITING.includes(task?.status)) stop('Unknown analysis status. Review it locally before continuing.');
    if (attempt + 1 < MAX_POLLS) await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  stop('Local timeout waiting for the analysis task. Re-run to resume.');
}

async function main() {
  if (process.argv.length !== 2) stop('Run node pegasus-segments.mjs without arguments.');
  const statePath = path.join(ROOT, 'state.json');
  const state = await readJson(statePath);
  if (!state) stop('state.json is missing.');
  const records = clipRecords(state);
  if (typeof state.pending_segment_task === 'string') {
    stop('Segment task creation outcome is uncertain. Reconcile the saved intent with TwelveLabs before running again; nothing will be recreated.');
  }
  for (const { clipId } of records) existingTaskId(state, clipId);
  const { default: dotenv } = await import('dotenv');
  const loaded = dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
  if (loaded.error || !process.env.TWELVELABS_API_KEY) stop('Local .env/API key unavailable; values redacted.');
  const { TwelveLabs } = await import('twelvelabs-js');
  // https://docs.twelvelabs.io/sdk-reference/node-js/the-twelve-labs-class#the-constructor
  const client = new TwelveLabs({ apiKey: process.env.TWELVELABS_API_KEY });
  const results = path.join(ROOT, 'local-results');
  await mkdir(results, { recursive: true });
  for (const { clipId, assetId } of records) {
    const taskId = existingTaskId(state, clipId) ?? await createTask(client, state, statePath, clipId, assetId);
    const task = await waitReady(client, taskId);
    const segments = segmentsFromPayload(task.result?.data);
    await saveJson(path.join(results, `${clipId}-segments.json`), segments);
    console.log(`${clipId}: ${segments.length} segments`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof LabError ? error.message : 'Run stopped; details redacted. Keep saved state for reconciliation.');
    process.exitCode = 1;
  });
}
