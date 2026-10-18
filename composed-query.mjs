/** Chapter 4: one image-plus-text query, then a local ranking. No second index.
 * Docs checked:
 * https://docs.twelvelabs.io/sdk-reference/node-js/create-embeddings-v-2/create-sync-embeddings
 * The reference image is the middle frame still-image.mjs saved at state.frames[clipId].
 * Clip ids come from state.clips. A score is not evidence.
 */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, LabError, readJson, saveJson, verifyManifest } from './media-manifest.mjs';
import { assertRankable } from './embeddings.mjs';
import { loadSegments, rank } from './rank.mjs';

const OPTIONS = Object.freeze({ maxRetries: 0, timeoutInSeconds: 120 });
const MODEL = 'marengo3.5';
const DIMENSION = 512;
const CONSTRAINT = 'after the notebook opens';

function stop(message) {
  throw new LabError(message);
}

const validId = value => typeof value === 'string' && value.trim().length > 0;

function queryIsComplete(value, clipId, assetId) {
  if (!value || value.clip_id !== clipId || value.asset_id !== assetId || value.text !== CONSTRAINT ||
      value.model !== MODEL || value.dimension !== DIMENSION) return false;
  try {
    assertRankable(value.embedding);
    return true;
  } catch (error) {
    if (error instanceof LabError) return false;
    throw error;
  }
}

async function embedComposed(client, assetId) {
  let result;
  try {
    // https://docs.twelvelabs.io/sdk-reference/node-js/create-embeddings-v-2/create-sync-embeddings
    result = await client.embed.v2.create({
      modelName: MODEL,
      inputType: 'multi_input',
      multiInput: {
        inputText: CONSTRAINT,
        mediaSources: [{ mediaType: 'image', assetId }],
      },
      embeddingDimension: DIMENSION,
    }, OPTIONS);
  } catch {
    stop('Composed query failed. No query file was written. Details redacted.');
  }
  if (!Array.isArray(result?.data) || result.data.length !== 1) {
    stop('Composed query did not return one vector. Nothing was ranked.');
  }
  return assertRankable(result.data[0].embedding);
}

async function printHits(root, clipIds, embedding) {
  const hits = rank(await loadSegments(root, clipIds), embedding);
  for (const hit of hits) {
    const option = hit.embedding_option ?? 'unknown';
    console.log(`${hit.score.toFixed(3)}  ${hit.clip_id}  ${hit.start_sec.toFixed(1)}-${hit.end_sec.toFixed(1)}s  ${option}`);
  }
  console.log('These scores are not evidence. Replay the timestamps yourself.');
}

export async function runComposedQuery({ root = ROOT, client, manifest: suppliedManifest } = {}) {
  const manifest = suppliedManifest ?? await readJson(join(root, 'media-manifest.json'));
  const clips = await verifyManifest(root, manifest);
  const clip = clips[0];
  const state = await readJson(join(root, 'state.json'));
  const clipIds = Array.isArray(state?.clips) ? state.clips.map(item => item?.id) : [];
  if (clipIds.length === 0 || !clipIds.includes(clip.id)) stop('Saved state does not match this manifest.');
  const assetId = state.frames?.[clip.id]?.asset_id;
  if (!validId(assetId)) stop(`No saved frame for ${clip.id}. Run still-image.mjs first.`);
  const queryPath = join(root, 'vectors', 'composed-query.json');
  const existing = await readJson(queryPath);
  if (existing !== undefined && !queryIsComplete(existing, clip.id, assetId)) {
    stop('Existing composed query does not match this frame and text. It was not replaced.');
  }
  if (existing !== undefined) {
    console.log(`${clip.id}: kept existing composed query`);
    await printHits(root, clipIds, existing.embedding);
    return;
  }
  if (!client) stop('Composed query client is unavailable. Nothing was embedded.');
  let asset;
  try {
    // https://docs.twelvelabs.io/sdk-reference/node-js/manage-assets#retrieve-an-asset
    asset = await client.assets.retrieve(assetId, OPTIONS);
  } catch {
    stop('Frame asset lookup failed. Nothing was embedded. Details redacted.');
  }
  if (asset?.status !== 'ready') stop('The saved frame is not ready. Nothing was embedded.');
  const embedding = await embedComposed(client, assetId);
  await saveJson(queryPath, {
    clip_id: clip.id,
    asset_id: assetId,
    text: CONSTRAINT,
    model: MODEL,
    dimension: DIMENSION,
    embedding,
  });
  console.log(`${clip.id}: composed query saved`);
  await printHits(root, clipIds, embedding);
}

async function main() {
  if (process.argv.length !== 2) stop('Run node composed-query.mjs without arguments.');
  const manifest = await readJson(join(ROOT, 'media-manifest.json'));
  const clips = await verifyManifest(ROOT, manifest);
  const state = await readJson(join(ROOT, 'state.json'));
  const assetId = state?.frames?.[clips[0]?.id]?.asset_id;
  const existing = await readJson(join(ROOT, 'vectors', 'composed-query.json'));
  const cached = validId(assetId) && queryIsComplete(existing, clips[0].id, assetId);
  let client;
  if (!cached) {
    const { default: dotenv } = await import('dotenv');
    const loaded = dotenv.config({ path: join(ROOT, '.env'), quiet: true });
    if (loaded.error || !process.env.TWELVELABS_API_KEY) stop('Local .env/API key unavailable; values redacted.');
    const { TwelveLabs } = await import('twelvelabs-js');
    // https://docs.twelvelabs.io/sdk-reference/node-js/the-twelve-labs-class#the-constructor
    client = new TwelveLabs({ apiKey: process.env.TWELVELABS_API_KEY });
  }
  await runComposedQuery({ client, manifest });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof LabError ? error.message : 'Run stopped; details redacted.');
    process.exitCode = 1;
  });
}
