/** Chapter 3: one Pegasus 1.6 streamed summary per ready clip.
 * twelvelabs-js 1.3.6: client.analyzeStream(AnalyzeStreamRequest, RequestOptions).
 * Events are stream_start, text_generation, and stream_end.
 * stream_end.finishReason is "stop" or "length". A missing end or any other
 * reason is incomplete, so that clip's file is not written.
 * Chapter 2 stores ids on state.items. This file does not read state.assets.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OPTIONS = Object.freeze({ maxRetries: 0, timeoutInSeconds: 120 });
// Sync analyze maxTokens is 1..4096. Set the maximum so a short summary is not cut at the default.
const MAX_TOKENS = 4096;
const PROMPT = 'Summarize what happens in this clip in three sentences. Describe visible actions in order and state uncertainty explicitly.';

function stop(message) {
  const error = new Error(message);
  error.name = 'LabError';
  throw error;
}

function clipRecords(state) {
  const items = state?.items;
  if (!items || typeof items !== 'object' || Array.isArray(items)) {
    stop('state.json has no clip items. Asset ids from Chapter 2 are under items.');
  }
  const records = [];
  for (const clipId of Object.keys(items)) {
    if (clipId !== path.basename(clipId)) stop('A clip id is not a single filename. Nothing was summarized.');
    const assetId = items[clipId]?.asset_id;
    if (typeof assetId !== 'string' || assetId.trim() === '') stop('A clip is missing a saved asset id. Nothing was summarized.');
    if (items[clipId].asset_status !== 'ready') stop('A saved asset is not ready. Nothing was summarized.');
    records.push({ clipId, assetId });
  }
  if (records.length === 0) stop('state.json items is empty. Nothing was summarized.');
  return records;
}

export function eventsFromNdjson(raw) {
  const events = [];
  for (const line of String(raw).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { events.push(JSON.parse(trimmed)); }
    catch { return { events, unreadable: true }; }
  }
  return { events, unreadable: false };
}

export function streamDecision(sawEnd, finishReason) {
  if (finishReason === 'length') return 'length';
  if (sawEnd && finishReason === 'stop') return 'stop';
  if (!sawEnd) return 'no-end';
  return 'absent';
}

const REJECTION = {
  length: 'Stream finish was length. This clip was not saved.',
  'no-end': 'Stream ended before stream_end. This clip was not saved.',
  absent: 'Stream end had no finish reason. This clip was not saved.',
};

async function readBody(body) {
  if (body != null && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    return raw + decoder.decode();
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function summarize(client, assetId) {
  const textParts = [];
  let finishReason = null;
  let sawEnd = false;
  try {
    const sdkStream = await client.analyzeStream({
      modelName: 'pegasus1.6',
      video: { type: 'asset_id', assetId },
      prompt: PROMPT,
      maxTokens: MAX_TOKENS,
    }, OPTIONS);
    // The SDK iterator drops a final line that has no newline. Read the body and keep that line.
    const { events, unreadable } = eventsFromNdjson(await readBody(sdkStream.stream));
    if (unreadable) sawEnd = false;
    else {
      for (const event of events) {
        const type = event?.event_type ?? event?.eventType;
        if (type === 'text_generation') textParts.push(event.text ?? '');
        else if (type === 'stream_end') {
          sawEnd = true;
          finishReason = event.finish_reason ?? event.finishReason ?? null;
        }
      }
    }
  } catch (error) {
    if (error?.name === 'LabError') throw error;
    stop('Summary stream failed. Details redacted. This clip was not saved.');
  }
  const decision = streamDecision(sawEnd, finishReason);
  if (decision !== 'stop') {
    const failure = new Error(REJECTION[decision]);
    failure.name = 'ClipRejected';
    throw failure;
  }
  return textParts.join('');
}

async function main() {
  if (process.argv.length !== 2) stop('Run node pegasus-summaries.mjs without arguments.');
  const state = JSON.parse(readFileSync(path.join(ROOT, 'state.json'), 'utf8'));
  const records = clipRecords(state);
  const { default: dotenv } = await import('dotenv');
  const loaded = dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
  if (loaded.error || !process.env.TWELVELABS_API_KEY) stop('Local .env/API key unavailable; values redacted.');
  const { TwelveLabs } = await import('twelvelabs-js');
  const client = new TwelveLabs({ apiKey: process.env.TWELVELABS_API_KEY });
  const results = path.join(ROOT, 'local-results');
  mkdirSync(results, { recursive: true });
  let rejected = 0;
  for (const { clipId, assetId } of records) {
    const output = path.join(results, `${clipId}-summary.txt`);
    if (existsSync(output) && statSync(output).size > 0) {
      console.log(`${clipId}: kept existing summary`);
      continue;
    }
    try {
      const text = await summarize(client, assetId);
      writeFileSync(output, text);
      console.log(`${clipId}: ${text.length} chars`);
    } catch (error) {
      if (error?.name !== 'ClipRejected' && error?.name !== 'LabError') throw error;
      rejected += 1;
      console.error(`${clipId}: ${error.message}`);
    }
  }
  if (rejected > 0) stop(`${rejected} clip stream(s) were not saved.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error?.name === 'LabError' ? error.message : 'Run stopped; details redacted.');
    process.exitCode = 1;
  });
}
