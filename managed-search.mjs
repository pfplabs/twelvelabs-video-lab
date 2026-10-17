/** Manifest -> assets -> indexed assets -> five searches. No flags.
 * Run only after reviewing this file and approving a live/billable run.
 * Prerequisites: Node.js 20+, twelvelabs-js, dotenv (installed separately).
 * No credentials or private response bodies are logged. JSON keys are lab-owned.
 */
import { createReadStream } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, LabError, readJson, saveJson, sha256, verifyManifest } from './media-manifest.mjs';

export const QUERIES = Object.freeze([
  'A dragon', 'Red birds flying', 'Snowy mountains', 'A character running', 'A traffic light',
]);
// Every SDK request uses zero retries, including searches and readiness GETs.
// https://docs.twelvelabs.io/sdk-reference/node-js/the-twelve-labs-class#request-options
const OPTIONS = Object.freeze({ maxRetries: 0, timeoutInSeconds: 120 });
const MODEL = { modelName: 'marengo3.0', modelOptions: ['visual', 'audio'] };
const delay = () => new Promise(resolve => setTimeout(resolve, 5000));
const validId = value => typeof value === 'string' && value.trim().length > 0;

function stop(message) { throw new LabError(message); }

function checkState(state, manifest) {
  const corpus = manifest.clips.map(({ id, file, sha256 }) => ({ id, file, sha256 }));
  if (!state || state.schema_version !== 1 || state.corpus !== manifest.corpus ||
      JSON.stringify(state.clips) !== JSON.stringify(corpus) || !state.items ||
      Object.keys(state.items).length !== corpus.length ||
      corpus.some(clip => state.items[clip.id]?.sha256 !== clip.sha256)) {
    stop('Saved state does not match this manifest; reconcile it without deleting remote IDs.');
  }
  for (const record of Object.values(state.items)) {
    for (const key of ['asset_id', 'indexed_asset_id']) {
      if (record[key] !== undefined && !validId(record[key])) stop('Invalid saved remote ID; reconcile state.');
    }
    if (record.indexed_asset_id && !record.asset_id) stop('Indexed entry has no associated asset; reconcile state.');
  }
  if (state.index_id !== undefined && !validId(state.index_id)) stop('Invalid saved index ID; reconcile state.');
  if (Object.values(state.items).some(record => record.asset_id) && !state.index_id) stop('Saved assets have no index; reconcile state.');
  if (state.pending_creation || Object.values(state.items).some(record => record.pending_creation)) {
    stop('Creation outcome is uncertain. Reconcile the saved intent with TwelveLabs before running again; nothing will be recreated.');
  }
}

async function createAndSave(owner, field, stage, state, statePath, create) {
  if (owner[field]) return;
  owner.pending_creation = stage;
  await saveJson(statePath, state);
  let response;
  try { response = await create(); }
  catch { stop('Creation failed or its outcome is uncertain. Reconcile the saved intent before running again; details redacted.'); }
  if (!validId(response?.id)) stop('Creation returned no usable ID. Stop and reconcile the saved intent.');
  owner[field] = response.id;
  delete owner.pending_creation;
  try { await saveJson(statePath, state); }
  catch { stop('Remote creation may have succeeded but saving its ID failed. Stop and reconcile before any further run.'); }
}

async function waitReady(record, stage, state, statePath, get, pause, maxPolls) {
  const key = `${stage}_status`;
  const waiting = stage === 'asset' ? ['processing'] : ['pending', 'queued', 'indexing'];
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    let response;
    try { response = await get(); }
    catch {
      record.last_error = 'Readiness request failed; no automatic retry. Details redacted.';
      await saveJson(statePath, state);
      stop(record.last_error);
    }
    record[key] = response?.status ?? 'unknown';
    delete record.last_error;
    if (response?.status === 'failed') {
      record.status = 'failed';
      // Do not invent an error field: the SDK interfaces don't guarantee a reason.
      record.failure_reason = 'Failure reason unavailable.';
    }
    await saveJson(statePath, state);
    if (record.status === 'failed') return false;
    if (response?.status === 'ready') return true;
    if (!waiting.includes(response?.status)) stop('Unknown readiness status saved; review it locally before continuing.');
    if (attempt + 1 < maxPolls) await pause();
  }
  stop('Readiness deadline reached. IDs retained; a later approved run can resume polling.');
}

export async function runManagedSearch({ root = ROOT, client, configuredIndexId,
  pause = delay, maxPolls = 120, manifest: suppliedManifest } = {}) {
  const manifest = suppliedManifest ?? await readJson(join(root, 'media-manifest.json'));
  const clips = await verifyManifest(root, manifest); // All files before ALL SDK calls.
  for (const clip of clips) {
    if ((await lstat(join(root, clip.file))).size > 200_000_000) stop('A listed clip exceeds the direct-upload 200 MB lab limit.');
  }
  const statePath = join(root, 'state.json');
  const state = await readJson(statePath) ?? {
    schema_version: 1, corpus: manifest.corpus,
    clips: clips.map(({ id, file, sha256 }) => ({ id, file, sha256 })),
    items: Object.fromEntries(clips.map(clip => [clip.id, { sha256: clip.sha256, status: 'not_started' }])),
  };
  checkState(state, manifest);
  if (configuredIndexId && state.index_id && configuredIndexId !== state.index_id) stop('Configured index conflicts with saved state; reconcile it first.');
  if (!state.index_id && configuredIndexId) state.index_id = configuredIndexId;
  if (!state.index_id) {
    // https://docs.twelvelabs.io/sdk-reference/node-js/manage-indexes#create-an-index
    await createAndSave(state, 'index_id', 'index', state, statePath,
      () => client.indexes.create({ indexName: manifest.corpus, models: [MODEL] }, OPTIONS));
  }
  await saveJson(statePath, state); // Reused index ID is also durable before retrieval.
  let index;
  // https://docs.twelvelabs.io/sdk-reference/node-js/manage-indexes#retrieve-an-index
  try { index = await client.indexes.retrieve(state.index_id, OPTIONS); }
  catch { stop('Index lookup failed; no retry or replacement index created. Details redacted.'); }
  if (!index.models?.some(model => model.modelName === MODEL.modelName &&
      Array.isArray(model.modelOptions) && model.modelOptions.length === 2 &&
      MODEL.modelOptions.every(option => model.modelOptions.includes(option)))) {
    stop('Index must use Marengo 3.0 with visual and audio; saved IDs retained.');
  }
  for (const [position, clip] of clips.entries()) {
    const record = state.items[clip.id];
    if (record.status === 'failed') {
      console.log(`Clip ${position + 1}: failed (retained; not re-uploaded).`);
      continue;
    }
    const path = join(root, clip.file);
    if (await sha256(path) !== clip.sha256) stop('Media changed after preflight; stop and review the corpus.');
    await createAndSave(record, 'asset_id', 'asset', state, statePath, async () => {
      const stream = createReadStream(path);
      // https://docs.twelvelabs.io/sdk-reference/node-js/upload-files/direct-uploads#create-an-asset
      try { return await client.assets.create({ method: 'direct', file: stream }, OPTIONS); }
      finally { stream.destroy(); }
    });
    // https://docs.twelvelabs.io/sdk-reference/node-js/manage-assets#retrieve-an-asset
    if (!await waitReady(record, 'asset', state, statePath,
      () => client.assets.retrieve(record.asset_id, OPTIONS), pause, maxPolls)) {
      console.log(`Clip ${position + 1}: failed. Failure reason unavailable.`);
      continue;
    }
    await createAndSave(record, 'indexed_asset_id', 'indexed_asset', state, statePath,
      // https://docs.twelvelabs.io/sdk-reference/node-js/index-content#index-an-asset
      () => client.indexes.indexedAssets.create(state.index_id, { assetId: record.asset_id }, OPTIONS));
    // requestOptions is FOURTH; the third argument is the optional request object.
    // https://docs.twelvelabs.io/sdk-reference/node-js/index-content#retrieve-an-indexed-asset
    if (!await waitReady(record, 'indexed_asset', state, statePath,
      () => client.indexes.indexedAssets.retrieve(state.index_id, record.indexed_asset_id, {}, OPTIONS), pause, maxPolls)) {
      console.log(`Clip ${position + 1}: failed. Failure reason unavailable.`);
      continue;
    }
    record.status = 'ready';
    await saveJson(statePath, state);
    console.log(`Clip ${position + 1}: searchable.`);
  }
  const ready = clips.filter(clip => state.items[clip.id].status === 'ready');
  if (!ready.length) stop('No searchable clips. Failed records remain in state.json.');
  const sources = ready.map(clip => ({ clip_id: clip.id, file: clip.file,
    duration_sec: clip.duration_sec, indexed_asset_id: state.items[clip.id].indexed_asset_id }));
  const identity = { corpus: manifest.corpus, clips: state.clips, index_id: state.index_id,
    sources, queries: QUERIES, search_options: ['visual', 'audio'] };
  const resultsDir = join(root, 'local-results');
  await mkdir(resultsDir, { recursive: true });
  const resultsPath = join(resultsDir, 'managed-search.json');
  const output = await readJson(resultsPath) ?? { identity, results: [] };
  if (JSON.stringify(output.identity) !== JSON.stringify(identity) || !Array.isArray(output.results)) {
    stop('Existing search output belongs to a different run configuration; review it locally before proceeding.');
  }
  for (const query of QUERIES) {
    const prior = output.results.find(result => result.query === query);
    if (prior?.status === 'complete') continue;
    if (prior) stop('A query previously failed or was interrupted. Reconcile results before issuing another paid query.');
    const result = { query, status: 'pending', hits: [] };
    output.results.push(result);
    await saveJson(resultsPath, output); // Prevent silent paid replays after a crash.
    try {
      // https://docs.twelvelabs.io/sdk-reference/node-js/search#make-a-search-request
      const page = await client.search.query({ indexId: state.index_id, queryText: query,
        searchOptions: ['visual', 'audio'], groupBy: 'clip',
        filter: JSON.stringify({ id: sources.map(source => source.indexed_asset_id) }) }, OPTIONS);
      // Official Page async iterator traverses pages; never claim first-page completeness.
      for await (const hit of page) {
        const source = sources.find(source => source.indexed_asset_id === hit.videoId);
        if (!source || !Number.isFinite(hit.start) || !Number.isFinite(hit.end) ||
            hit.start < 0 || hit.end <= hit.start) stop('Unexpected hit source or timestamp fields; review locally.');
        result.hits.push({ clip_id: source.clip_id, file: source.file, video_id: hit.videoId,
          start: hit.start, end: hit.end, rank: hit.rank ?? null,
          boundary_review_required: hit.end > source.duration_sec });
        await saveJson(resultsPath, output); // Keep partial hits if a later page fails.
      }
      result.status = 'complete';
    } catch {
      result.status = 'failed';
      result.error = 'Search failed or response needs review; partial hits retained. Details redacted.';
      await saveJson(resultsPath, output);
      stop('Query stopped without retry; inspect local-results/managed-search.json locally.');
    }
    await saveJson(resultsPath, output);
  }
  console.log(`Saved five searches from ${ready.length} ready clips. Replay the timestamps and grade them yourself; rank is not proof.`);
  if (ready.length !== clips.length) console.log('Failed clips remain visible in state.json and were excluded from search.');
  return output;
}

async function main() {
  if (process.argv.length !== 2) stop('Run node managed-search.mjs without arguments.');
  const manifest = await readJson(join(ROOT, 'media-manifest.json'));
  await verifyManifest(ROOT, manifest); // No .env read until local preflight succeeds.
  const { default: dotenv } = await import('dotenv');
  const loaded = dotenv.config({ path: join(ROOT, '.env'), quiet: true });
  if (loaded.error || !process.env.TWELVELABS_API_KEY) stop('Local .env/API key unavailable; values redacted.');
  const { TwelveLabs } = await import('twelvelabs-js');
  // https://docs.twelvelabs.io/sdk-reference/node-js/the-twelve-labs-class#the-constructor
  const client = new TwelveLabs({ apiKey: process.env.TWELVELABS_API_KEY });
  // Short-lived exclusive lock protects state without adding another persistent file.
  // A crash may leave this directory; do not remove it until the prior process is gone
  // and pending creation intents have been reconciled.
  const lock = join(ROOT, 'state.json.lock');
  try { await mkdir(lock); }
  catch { stop('State is locked. Check for an active or interrupted run before reconciling the lock.'); }
  try { await runManagedSearch({ client, manifest, configuredIndexId: process.env.TWELVELABS_INDEX_ID }); }
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
