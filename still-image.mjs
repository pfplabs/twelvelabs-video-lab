/** Middle frame of each manifest clip, uploaded once, then described with Pegasus 1.6.
 * Docs checked for twelvelabs-js 1.3.6:
 * https://docs.twelvelabs.io/sdk-reference/node-js/the-twelve-labs-class#the-constructor
 * https://docs.twelvelabs.io/sdk-reference/node-js/the-twelve-labs-class#request-options
 * https://docs.twelvelabs.io/sdk-reference/node-js/upload-files/direct-uploads#create-an-asset
 * https://docs.twelvelabs.io/sdk-reference/node-js/manage-assets#retrieve-an-asset
 * https://docs.twelvelabs.io/sdk-reference/node-js/analyze-videos/sync-analysis#sync-analysis-with-streaming-responses
 * https://docs.twelvelabs.io/docs/guides/analyze-videos-and-images/images
 * Asset ids are saved on state.frames before the readiness poll and reused on reruns.
 * A comparison file is written only when stream_end.finishReason is "stop".
 */
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, LabError, readJson, saveJson, sha256, verifyManifest } from './media-manifest.mjs';

const exec = promisify(execFile);
const OPTIONS = Object.freeze({ maxRetries: 0, timeoutInSeconds: 120 });
const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 120;
const MAX_IMAGE_BYTES = 20_000_000;
const MAX_PIXELS = 16_777_216;
const MAX_TOKENS = 4096;
const IMAGE_NAME = 'still';
const PROMPT = 'Describe only what is visible in <@still>. This is one still frame, so do not infer motion, sound, or events outside this image. State uncertainty explicitly.';

function stop(message) {
  throw new LabError(message);
}

const validId = value => typeof value === 'string' && value.trim().length > 0;

function frameRelative(clipId) {
  return `local-results/frames/${clipId}.png`;
}

function checkState(state, manifest) {
  const corpus = manifest.clips.map(({ id, file, sha256: checksum }) => ({ id, file, sha256: checksum }));
  if (!state || state.schema_version !== 1 || state.corpus !== manifest.corpus ||
      JSON.stringify(state.clips) !== JSON.stringify(corpus) ||
      !state.items || typeof state.items !== 'object' || Array.isArray(state.items)) {
    stop('Saved state does not match this manifest; reconcile it without deleting remote IDs.');
  }
  if (state.pending_creation || Object.values(state.items ?? {}).some(record => record?.pending_creation)) {
    stop('Creation outcome is uncertain. Reconcile the saved intent with TwelveLabs before running again; nothing will be recreated.');
  }
  if (state.frames === undefined) return;
  if (!state.frames || typeof state.frames !== 'object' || Array.isArray(state.frames)) {
    stop('state.json frames is not an object. Nothing was uploaded.');
  }
  const clipIds = new Set(corpus.map(clip => clip.id));
  for (const [clipId, record] of Object.entries(state.frames)) {
    if (!clipIds.has(clipId)) stop('state.json frames has an unknown clip. Reconcile it before running again.');
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      stop('A saved frame record is not an object. Reconcile it before running again.');
    }
    if (record.pending_creation) {
      stop('Frame asset creation outcome is uncertain. Reconcile the saved intent with TwelveLabs before running again; nothing will be recreated.');
    }
    if (record.asset_id !== undefined && !validId(record.asset_id)) stop('Invalid saved frame asset id; reconcile state.');
    if (record.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(record.sha256)) {
      stop('Invalid saved frame checksum; reconcile state.');
    }
    if (record.asset_id && record.sha256 === undefined) stop('Saved frame asset has no checksum; reconcile state.');
  }
}

async function middleSeconds(file) {
  try {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
    { timeout: 30_000, maxBuffer: 64 * 1024 });
    const seconds = Number(stdout.trim());
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error();
    return seconds / 2;
  } catch (error) {
    if (error instanceof LabError) throw error;
    stop('Duration check failed. Check ffprobe and the media locally; details redacted.');
  }
}

async function extractMiddleFrame(videoPath, framePath) {
  const middle = await middleSeconds(videoPath);
  const temporary = `${framePath}.${randomUUID()}.png`;
  try {
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', videoPath,
      '-ss', String(middle), '-frames:v', '1', temporary],
    { timeout: 120_000, maxBuffer: 1024 * 1024 });
    const info = await lstat(temporary);
    if (!info.isFile() || info.size === 0) throw new Error();
    await rename(temporary, framePath);
  } catch (error) {
    await unlink(temporary).catch(unlinkError => { if (unlinkError.code !== 'ENOENT') throw unlinkError; });
    if (error instanceof LabError) throw error;
    stop('Middle-frame extraction failed. Check ffmpeg and the clip locally; details redacted.');
  }
}

async function imagePixels(file) {
  try {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file],
    { timeout: 30_000, maxBuffer: 64 * 1024 });
    const [width, height] = stdout.trim().split('x').map(Number);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error();
    return width * height;
  } catch (error) {
    if (error instanceof LabError) throw error;
    stop('Could not read the extracted frame size. Check ffprobe locally; details redacted.');
  }
}

async function prepareFrames(root, clips) {
  const framesDir = join(root, 'local-results', 'frames');
  await mkdir(framesDir, { recursive: true });
  const prepared = [];
  for (const clip of clips) {
    if (clip.id !== basename(clip.id)) stop('A clip id is not a single filename. Nothing was extracted.');
    const summaryPath = join(root, 'local-results', `${clip.id}-summary.txt`);
    let summary;
    try { summary = await readFile(summaryPath, 'utf8'); }
    catch { stop(`Missing Step 1 summary for ${clip.id}. Nothing was uploaded.`); }
    if (summary.length === 0) stop(`Step 1 summary for ${clip.id} is empty. Nothing was uploaded.`);
    const framePath = join(framesDir, `${clip.id}.png`);
    let info;
    try { info = await lstat(framePath); }
    catch (error) {
      if (error.code !== 'ENOENT') stop('Could not read an extracted frame. Details redacted.');
      info = null;
    }
    if (info && (!info.isFile() || info.isSymbolicLink())) stop('An extracted frame path is not a regular file.');
    if (!info) await extractMiddleFrame(join(root, clip.file), framePath);
    const frameInfo = await lstat(framePath);
    if (!frameInfo.isFile() || frameInfo.isSymbolicLink() || frameInfo.size === 0) {
      stop('An extracted frame is missing. Nothing was uploaded.');
    }
    if (frameInfo.size > MAX_IMAGE_BYTES) stop('An extracted frame exceeds the 20 MB image analysis limit.');
    if (await imagePixels(framePath) > MAX_PIXELS) stop('An extracted frame exceeds the image pixel limit.');
    prepared.push({
      clipId: clip.id,
      framePath,
      frame: frameRelative(clip.id),
      checksum: await sha256(framePath),
      summary,
    });
  }
  return prepared;
}

function keptComparison(value, clipId, frame, summary) {
  return !!value && value.clip === clipId && value.frame === frame &&
    typeof value.still_answer === 'string' && typeof value.video_summary === 'string' &&
    value.video_summary === summary && typeof value.your_notes === 'string' &&
    Object.keys(value).length === 5;
}

async function waitReady(client, assetId) {
  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    let asset;
    try {
      // https://docs.twelvelabs.io/sdk-reference/node-js/manage-assets#retrieve-an-asset
      asset = await client.assets.retrieve(assetId, OPTIONS);
    } catch {
      stop('Frame asset readiness request failed; no automatic retry. The saved asset id was kept. Details redacted.');
    }
    if (asset?.status === 'failed') stop('Frame asset processing failed. The saved asset id was kept.');
    if (asset?.status === 'ready') return;
    if (asset?.status !== 'processing') stop('Unknown frame asset status. Review it locally before continuing.');
    if (attempt + 1 < MAX_POLLS) await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  stop('Frame asset readiness deadline reached. The saved asset id was kept; a later approved run can resume polling.');
}

async function ensureFrameAsset(client, state, statePath, clipId, checksum, framePath) {
  if (state.frames === undefined) state.frames = {};
  const record = state.frames[clipId] ?? {};
  if (record.pending_creation) {
    stop('Frame asset creation outcome is uncertain. Reconcile the saved intent with TwelveLabs before running again; nothing will be recreated.');
  }
  if (record.sha256 && record.sha256 !== checksum) {
    stop('Saved frame checksum does not match the extracted frame. Reconcile it without uploading another asset.');
  }
  if (record.asset_id) return record.asset_id;
  record.sha256 = checksum;
  record.pending_creation = 'asset';
  state.frames[clipId] = record;
  await saveJson(statePath, state);
  let response;
  try {
    const stream = createReadStream(framePath);
    // https://docs.twelvelabs.io/sdk-reference/node-js/upload-files/direct-uploads#create-an-asset
    try { response = await client.assets.create({ method: 'direct', file: stream }, OPTIONS); }
    finally { stream.destroy(); }
  } catch {
    stop('Frame asset creation failed or its outcome is uncertain. Reconcile the saved intent before running again; details redacted.');
  }
  if (!validId(response?.id)) stop('Frame asset creation returned no usable ID. Stop and reconcile the saved intent.');
  record.asset_id = response.id;
  record.sha256 = checksum;
  delete record.pending_creation;
  try { await saveJson(statePath, state); }
  catch { stop('Remote frame asset may have succeeded but saving its ID failed. Stop and reconcile before any further run.'); }
  return record.asset_id;
}

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

function eventsFromNdjson(raw) {
  const events = [];
  for (const line of String(raw).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { events.push(JSON.parse(trimmed)); }
    catch { return { events, unreadable: true }; }
  }
  return { events, unreadable: false };
}

async function describeStill(client, assetId) {
  const textParts = [];
  let finishReason = null;
  let sawEnd = false;
  try {
    // https://docs.twelvelabs.io/sdk-reference/node-js/analyze-videos/sync-analysis#sync-analysis-with-streaming-responses
    const sdkStream = await client.analyzeStream({
      modelName: 'pegasus1.6',
      image: [{ name: IMAGE_NAME, assetId }],
      prompt: PROMPT,
      maxTokens: MAX_TOKENS,
    }, OPTIONS);
    // The SDK iterator drops a final line that has no newline. Read the body and keep that line.
    const { events, unreadable } = eventsFromNdjson(await readBody(sdkStream.stream));
    if (!unreadable) {
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
    if (error instanceof LabError) throw error;
    stop('Still-image stream failed. Details redacted. This comparison was not saved.');
  }
  if (!(sawEnd && finishReason === 'stop')) {
    const reason = finishReason === 'length' ? 'length' : (sawEnd ? 'absent' : 'missing');
    stop(`Still-image stream finish was ${reason}, not stop. This comparison was not saved.`);
  }
  return textParts.join('');
}

async function main() {
  if (process.argv.length !== 2) stop('Run node still-image.mjs without arguments.');
  const manifest = await readJson(join(ROOT, 'media-manifest.json'));
  const clips = await verifyManifest(ROOT, manifest);
  const prepared = await prepareFrames(ROOT, clips);
  const statePath = join(ROOT, 'state.json');
  const lock = join(ROOT, 'state.json.lock');
  try { await mkdir(lock); }
  catch { stop('State is locked. Check for an active or interrupted run before reconciling the lock.'); }
  try {
    const state = await readJson(statePath);
    if (!state) stop('state.json is missing.');
    checkState(state, manifest);
    for (const item of prepared) {
      const saved = state.frames?.[item.clipId];
      if (saved?.sha256 && saved.sha256 !== item.checksum) {
        stop('Saved frame checksum does not match the extracted frame. Reconcile it without uploading another asset.');
      }
    }
    const { default: dotenv } = await import('dotenv');
    const loaded = dotenv.config({ path: join(ROOT, '.env'), quiet: true });
    if (loaded.error || !process.env.TWELVELABS_API_KEY) stop('Local .env/API key unavailable; values redacted.');
    const { TwelveLabs } = await import('twelvelabs-js');
    // https://docs.twelvelabs.io/sdk-reference/node-js/the-twelve-labs-class#the-constructor
    const client = new TwelveLabs({ apiKey: process.env.TWELVELABS_API_KEY });
    const results = join(ROOT, 'local-results');
    await mkdir(results, { recursive: true });
    for (const item of prepared) {
      const outputPath = join(results, `${item.clipId}-still-comparison.json`);
      const existing = await readJson(outputPath);
      if (existing) {
        if (!keptComparison(existing, item.clipId, item.frame, item.summary)) {
          stop('Existing still comparison does not match this clip and Step 1 summary. Review it locally before proceeding.');
        }
        const saved = state.frames?.[item.clipId];
        if (saved?.sha256 !== item.checksum || !validId(saved?.asset_id)) {
          stop('Existing still comparison has no matching saved frame asset. Reconcile state before running again.');
        }
        console.log(`${item.clipId}: kept existing comparison`);
        continue;
      }
      const assetId = await ensureFrameAsset(client, state, statePath, item.clipId, item.checksum, item.framePath);
      await waitReady(client, assetId);
      const stillAnswer = await describeStill(client, assetId);
      await saveJson(outputPath, {
        clip: item.clipId,
        frame: item.frame,
        still_answer: stillAnswer,
        video_summary: item.summary,
        your_notes: '',
      });
      console.log(`${item.clipId}: ${stillAnswer.length} chars`);
    }
  } finally {
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
