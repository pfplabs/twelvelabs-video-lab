/** Chapter 4: Jockey knowledge store for the two ready clips.
 * Docs checked for twelvelabs-js 1.3.6:
 * https://docs.twelvelabs.io/sdk-reference/node-js/knowledge-stores
 * https://docs.twelvelabs.io/agents/guides/add-assets
 * Video asset ids are on state.items. The store id is state.knowledge_store_id.
 * Each item id is saved on state.store_items before polling. The store itself has no status.
 */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, LabError, readJson, saveJson } from './media-manifest.mjs';

const OPTIONS = Object.freeze({ maxRetries: 0, timeoutInSeconds: 120 });
const STORE_NAME = 'video-lab-store';
const WAITING = Object.freeze(['queued', 'pending', 'processing']);
const TIMEOUT_MS = 900_000;

function stop(message) {
  throw new LabError(message);
}

const validId = value => typeof value === 'string' && value.trim().length > 0;

function clipRecords(state) {
  if (!Array.isArray(state?.clips) || state.clips.length === 0) stop('state.json has no clips.');
  return state.clips.map(clip => {
    const record = state.items?.[clip?.id];
    if (!validId(clip?.id) || !record || record.sha256 !== clip.sha256) {
      stop('Saved state does not match this clip. Nothing was added to a store.');
    }
    if (!validId(record.asset_id) || record.asset_status !== 'ready') {
      stop('A clip has no ready asset. Nothing was added to a store.');
    }
    return { clipId: clip.id, assetId: record.asset_id };
  });
}

async function ensureStore(client, state, statePath) {
  if (state.knowledge_store_id !== undefined && !validId(state.knowledge_store_id)) {
    stop('Saved knowledge store id is invalid. Reconcile it before creating another store.');
  }
  if (validId(state.knowledge_store_id)) return state.knowledge_store_id;
  let store;
  try {
    // https://docs.twelvelabs.io/sdk-reference/node-js/knowledge-stores#create-a-knowledge-store
    store = await client.knowledgeStores.create({ name: STORE_NAME }, OPTIONS);
  } catch {
    stop('Knowledge store creation failed or its outcome is uncertain. Reconcile TwelveLabs before running again. A rerun would create another store because no store id was saved.');
  }
  if (!validId(store?.id)) stop('Knowledge store creation returned no usable ID. Stop and reconcile before running again.');
  state.knowledge_store_id = store.id;
  try { await saveJson(statePath, state); }
  catch { stop('A knowledge store may exist but saving its ID failed. Stop and reconcile before any further run.'); }
  console.log('knowledge store saved');
  return store.id;
}

async function addItems(client, state, statePath, clips) {
  const storeId = await ensureStore(client, state, statePath);
  state.store_items ??= {};
  if (!state.store_items || typeof state.store_items !== 'object' || Array.isArray(state.store_items)) {
    stop('state.json store_items is not an object. Nothing was added.');
  }
  for (const { clipId, assetId } of clips) {
    const saved = state.store_items[clipId];
    if (saved) {
      if (!validId(saved.item_id)) stop(`Saved store item for ${clipId} is invalid. Reconcile it before adding another.`);
      console.log(`skip ${clipId}: already added`);
      continue;
    }
    let item;
    try {
      // https://docs.twelvelabs.io/agents/guides/add-assets
      item = await client.knowledgeStoreItems.create(storeId, { assetId }, OPTIONS);
    } catch {
      stop(`Adding ${clipId} failed or its outcome is uncertain. Reconcile TwelveLabs before running again. A rerun would add it again because no item id was saved.`);
    }
    if (!validId(item?.id)) stop(`Adding ${clipId} returned no usable ID. Stop and reconcile before running again.`);
    state.store_items[clipId] = { item_id: item.id };
    try { await saveJson(statePath, state); }
    catch { stop(`A store item for ${clipId} may exist but saving its ID failed. Stop and reconcile before any further run.`); }
    console.log(`added ${clipId}`);
  }
  return storeId;
}

async function waitItemsReady(client, state, storeId) {
  const pending = new Map(Object.entries(state.store_items).map(([clipId, item]) => [clipId, item.item_id]));
  const deadline = Date.now() + TIMEOUT_MS;
  let delay = 5_000;
  while (pending.size && Date.now() < deadline) {
    for (const [clipId, itemId] of pending) {
      let current;
      try {
        current = await client.knowledgeStoreItems.retrieve(storeId, itemId, OPTIONS);
      } catch {
        stop(`Store item status request failed for ${clipId}; no automatic retry. The saved item id was kept. Details redacted.`);
      }
      const status = current?.status;
      if (status === 'ready') {
        console.log(`ready: ${clipId}`);
        pending.delete(clipId);
        continue;
      }
      if (status === 'failed') stop(`${clipId}: store item failed. The saved item id was kept.`);
      if (!WAITING.includes(status)) stop(`Unknown store item status for ${clipId}. The saved item id was kept.`);
    }
    if (!pending.size) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(delay, remaining)));
    delay = Math.min(delay * 2, 30_000);
  }
  if (pending.size) {
    stop(`items still processing: ${[...pending.keys()].sort().join(', ')}. Re-run to resume. Saved ids were kept.`);
  }
}

export async function runJockeyStore({ root = ROOT, client } = {}) {
  const statePath = join(root, 'state.json');
  const state = await readJson(statePath);
  const clips = clipRecords(state);
  if (!client) stop('Knowledge store client is unavailable. Nothing was created.');
  const storeId = await addItems(client, state, statePath, clips);
  await waitItemsReady(client, state, storeId);
  console.log('all store items ready');
}

async function main() {
  if (process.argv.length !== 2) stop('Run node jockey-store.mjs without arguments.');
  const state = await readJson(join(ROOT, 'state.json'));
  clipRecords(state);
  const { default: dotenv } = await import('dotenv');
  const loaded = dotenv.config({ path: join(ROOT, '.env'), quiet: true });
  if (loaded.error || !process.env.TWELVELABS_API_KEY) stop('Local .env/API key unavailable; values redacted.');
  const { TwelveLabs } = await import('twelvelabs-js');
  // https://docs.twelvelabs.io/sdk-reference/node-js/the-twelve-labs-class#the-constructor
  const client = new TwelveLabs({ apiKey: process.env.TWELVELABS_API_KEY });
  const lock = join(ROOT, 'state.json.lock');
  try { await mkdir(lock); }
  catch { stop('State is locked. Check for an active or interrupted run before reconciling the lock.'); }
  try { await runJockeyStore({ client }); }
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
