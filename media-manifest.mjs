/** Build the article's manifest locally. Requires ffprobe, not API credentials. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir, lstat, rename, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
export class LabError extends Error {}

export async function readJson(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new LabError('Cannot read valid local JSON; details redacted. Existing data was not replaced.');
  }
}

export async function saveJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function durationSec(path) {
  try {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path],
    { timeout: 30_000, maxBuffer: 64 * 1024 });
    const seconds = Math.round(Number(stdout.trim()) * 100) / 100;
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error();
    return seconds;
  } catch { throw new LabError('Duration check failed. Check ffprobe and the media locally; details redacted.'); }
}

function clipPath(root, clip) {
  if (!clip || typeof clip.file !== 'string' || !clip.file.startsWith('media/')) {
    throw new LabError('Each clip must have a relative media/filename.mp4 path.');
  }
  const name = clip.file.slice(6);
  if (!name || name !== basename(name) || name.includes('\\') || !name.endsWith('.mp4') ||
      clip.id !== name.slice(0, -4)) throw new LabError('Clip path or local ID does not match the article format.');
  return join(root, 'media', name);
}

export async function verifyManifest(root, manifest) {
  if (!manifest || typeof manifest.corpus !== 'string' || !manifest.corpus.trim() ||
      !Array.isArray(manifest.clips) || manifest.clips.length !== 2) {
    throw new LabError('The manifest must identify a corpus and exactly two clips.');
  }
  const ids = new Set();
  for (const clip of manifest.clips) {
    const path = clipPath(root, clip);
    if (ids.has(clip.id)) throw new LabError('Duplicate local clip ID.');
    ids.add(clip.id);
    if (!/^[a-f0-9]{64}$/.test(clip.sha256) || !Array.isArray(clip.ground_truth) ||
        !Number.isFinite(clip.duration_sec) || clip.duration_sec <= 0) {
      throw new LabError('Invalid checksum, duration or handwritten ground_truth list.');
    }
    let info;
    try { info = await lstat(path); }
    catch { throw new LabError('A manifest file is missing; fix its path before continuing.'); }
    if (!info.isFile() || info.isSymbolicLink()) throw new LabError('Manifest paths must select regular local files.');
    if (await sha256(path) !== clip.sha256) throw new LabError('A manifest checksum changed; stop and review the corpus.');
  }
  return manifest.clips;
}

export async function buildManifest(root = ROOT, probe = durationSec) {
  let names;
  try { names = (await readdir(join(root, 'media'))).filter(name => name.endsWith('.mp4')).sort(); }
  catch { throw new LabError('Cannot find media/. Put the two selected MP4s there first.'); }
  if (names.length !== 2) throw new LabError('media/ must contain the two selected MP4s before generating the manifest.');
  const output = join(root, 'media-manifest.json');
  const existing = await readJson(output);
  if (existing !== undefined) {
    await verifyManifest(root, existing);
    const oldNames = existing.clips.map(clip => clip.file.slice(6)).sort();
    if (JSON.stringify(oldNames) !== JSON.stringify(names)) {
      throw new LabError('Corpus membership changed; existing manifest and ground truth preserved for review.');
    }
    return { manifest: existing, preserved: true }; // Keep the actual file bytes, too.
  }
  const clips = [];
  for (const name of names) {
    const path = join(root, 'media', name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new LabError('Select regular local MP4 files.');
    const checksum = await sha256(path);
    const seconds = await probe(path);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new LabError('Invalid clip duration.');
    if (await sha256(path) !== checksum) throw new LabError('Media changed during manifest generation.');
    clips.push({ id: name.slice(0, -4), file: `media/${name}`, sha256: checksum,
      duration_sec: seconds, ground_truth: [] });
  }
  const manifest = { corpus: 'desk-corpus', clips };
  await saveJson(output, manifest);
  return { manifest, preserved: false };
}

export function reportError(error) {
  console.error(error instanceof LabError ? error.message : 'Local operation failed; details redacted.');
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) reportError(new LabError('Run node media-manifest.mjs without arguments.'));
  else buildManifest().then(({ preserved }) => console.log(preserved
    ? 'Verified two clips; existing corpus and ground_truth preserved.'
    : 'Wrote media-manifest.json with two clips. Fill ground_truth by hand.')).catch(reportError);
}
