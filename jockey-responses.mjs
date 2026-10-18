/** Chapter 4: two Jockey answers in one session.
 * Docs checked for twelvelabs-js 1.3.6:
 * https://docs.twelvelabs.io/v1.3/sdk-reference/node-js/responses
 * Uses the store id saved by jockey-store.mjs. A completed answer is not evidence.
 */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, LabError, readJson, saveJson } from './media-manifest.mjs';

const OPTIONS = Object.freeze({ maxRetries: 0, timeoutInSeconds: 180 });
const FIRST_PROMPT = 'Across all clips in this store, what happens to the red mug? Cite the clip and approximate time for each event.';
const SECOND_PROMPT = 'Which of those moments would make the best 5-second highlight, and why? Propose exactly three intervals with start and end times.';

function stop(message) {
  throw new LabError(message);
}

const validId = value => typeof value === 'string' && value.trim().length > 0;

function clipForItem(state, itemId) {
  for (const [clipId, item] of Object.entries(state.store_items ?? {})) {
    if (item?.item_id === itemId) return clipId;
  }
  return null;
}

function citations(part, state) {
  if (!Array.isArray(part?.annotations)) return [];
  return part.annotations.map(annotation => ({
    type: annotation?.type ?? null,
    start_index: annotation?.startIndex ?? null,
    end_index: annotation?.endIndex ?? null,
    item_id: annotation?.itemId ?? null,
    clip_id: clipForItem(state, annotation?.itemId),
    collection_id: annotation?.collectionId ?? null,
    start_sec: annotation?.startSec ?? null,
    end_sec: annotation?.endSec ?? null,
    title: annotation?.title ?? null,
  }));
}

function answerFrom(response, state) {
  if (response?.status !== 'completed') {
    stop(`Jockey response was not completed (status ${response?.status ?? 'missing'}). It was not saved.`);
  }
  if (!validId(response.sessionId)) stop('Jockey response had no session id. It was not saved.');
  const texts = [];
  const annotations = [];
  for (const item of response.output ?? []) {
    if (item?.type !== 'message') continue;
    if (item.phase && item.phase !== 'final_answer') continue;
    for (const part of item.content ?? []) {
      if (typeof part?.text === 'string') texts.push(part.text);
      annotations.push(...citations(part, state));
    }
  }
  if (texts.length === 0) stop('Jockey response had no answer text. It was not saved.');
  return { text: texts.join('\n'), annotations, session_id: response.sessionId };
}

async function ask(client, storeId, state, prompt, sessionId) {
  let response;
  try {
    // https://docs.twelvelabs.io/v1.3/sdk-reference/node-js/responses#create-a-response
    response = await client.responses.create({
      knowledgeStoreId: storeId,
      input: [{ type: 'message', role: 'user', content: prompt }],
      ...(sessionId ? { sessionId } : {}),
    }, OPTIONS);
  } catch {
    stop('Jockey response failed. Details redacted.');
  }
  return answerFrom(response, state);
}

function savedTurn(value, prompt) {
  return !!value && value.prompt === prompt && value.status === 'completed' &&
    typeof value.text === 'string' && validId(value.session_id);
}

export async function runJockeyResponses({ root = ROOT, client } = {}) {
  const state = await readJson(join(root, 'state.json'));
  if (!validId(state?.knowledge_store_id)) stop('No knowledge store id in state.json. Run jockey-store.mjs first.');
  const resultsDir = join(root, 'local-results');
  await mkdir(resultsDir, { recursive: true });
  const outputPath = join(resultsDir, 'jockey-highlights.json');
  const existing = await readJson(outputPath);
  if (existing !== undefined && existing.knowledge_store_id !== state.knowledge_store_id) {
    stop('Existing Jockey output belongs to a different store. It was not replaced.');
  }
  const output = existing ?? { knowledge_store_id: state.knowledge_store_id };
  if (savedTurn(output.first, FIRST_PROMPT) && savedTurn(output.second, SECOND_PROMPT)) {
    console.log('ANSWER 1:', output.first.text);
    console.log('ANSWER 2:', output.second.text);
    console.log('Kept local-results/jockey-highlights.json. Review each proposed interval against your footage. The answers are not evidence.');
    return output;
  }
  if (!client) stop('Jockey client is unavailable. Nothing was asked.');
  if (!savedTurn(output.first, FIRST_PROMPT)) {
    const first = await ask(client, state.knowledge_store_id, state, FIRST_PROMPT);
    output.first = { prompt: FIRST_PROMPT, status: 'completed', ...first };
    await saveJson(outputPath, output);
    console.log('ANSWER 1:', first.text);
  } else {
    console.log('ANSWER 1: kept existing answer');
  }
  const second = await ask(client, state.knowledge_store_id, state, SECOND_PROMPT, output.first.session_id);
  output.second = { prompt: SECOND_PROMPT, status: 'completed', ...second };
  await saveJson(outputPath, output);
  console.log('ANSWER 2:', second.text);
  console.log('Saved local-results/jockey-highlights.json. Review each proposed interval against your footage. The answers are not evidence.');
  return output;
}

async function main() {
  if (process.argv.length !== 2) stop('Run node jockey-responses.mjs without arguments.');
  const state = await readJson(join(ROOT, 'state.json'));
  if (!validId(state?.knowledge_store_id)) stop('No knowledge store id in state.json. Run jockey-store.mjs first.');
  const existing = await readJson(join(ROOT, 'local-results', 'jockey-highlights.json'));
  const cached = existing?.knowledge_store_id === state.knowledge_store_id &&
    savedTurn(existing.first, FIRST_PROMPT) && savedTurn(existing.second, SECOND_PROMPT);
  let client;
  if (!cached) {
    const { default: dotenv } = await import('dotenv');
    const loaded = dotenv.config({ path: join(ROOT, '.env'), quiet: true });
    if (loaded.error || !process.env.TWELVELABS_API_KEY) stop('Local .env/API key unavailable; values redacted.');
    const { TwelveLabs } = await import('twelvelabs-js');
    // https://docs.twelvelabs.io/sdk-reference/node-js/the-twelve-labs-class#the-constructor
    client = new TwelveLabs({ apiKey: process.env.TWELVELABS_API_KEY });
  }
  await runJockeyResponses({ client });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof LabError ? error.message : 'Run stopped; details redacted.');
    process.exitCode = 1;
  });
}
