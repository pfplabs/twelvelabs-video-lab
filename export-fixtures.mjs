/** Chapter 6: build the workbench fixture from saved local results.
 * No TwelveLabs or AWS calls, and no packages beyond Node itself.
 * Reads media-manifest.json, local-results/ and vectors/. Copies clips into
 * workbench/public/media/ and writes workbench/public/fixtures.json.
 * Both of those outputs are gitignored. Without a manifest, writes the
 * synthetic demo to workbench/public/demo/fixtures.json.
 * Same behaviour as the chapter listing for export_fixtures.py.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, LabError, readJson, saveJson, reportError } from './media-manifest.mjs';

const PUB = join(ROOT, 'workbench', 'public');
const RESULTS = join(ROOT, 'local-results');
const VECTORS = join(ROOT, 'vectors');
const MANIFEST = join(ROOT, 'media-manifest.json');

function stop(message) {
  throw new LabError(message);
}

function durationSec(value, id) {
  const seconds = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    stop(`Clip ${id} is missing a positive numeric durationSec.`);
  }
  return seconds;
}

function finitePair(start, end, label) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    stop(`${label} has invalid start or end seconds.`);
  }
  return { startSec: start, endSec: end };
}

function textOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** Chapter 2 stores query, start_sec, end_sec, observation. The listing's
 * invented start/end/event shape is accepted too. The site only has label. */
function groundTruth(entries, id) {
  if (entries == null) return [];
  if (!Array.isArray(entries)) stop(`Clip ${id} ground_truth is not a list.`);
  return entries.map((entry, index) => {
    const times = finitePair(
      entry?.startSec ?? entry?.start_sec ?? entry?.start,
      entry?.endSec ?? entry?.end_sec ?? entry?.end,
      `Clip ${id} ground truth ${index + 1}`,
    );
    const observation = textOr(entry?.observation, '');
    const query = textOr(entry?.query, '');
    const label = textOr(entry?.label, '') || [query, observation].filter(Boolean).join(' — ')
      || textOr(entry?.event, '');
    return { ...times, label };
  });
}

function listed(value, label) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.segments)) return value.segments;
  stop(`${label} is not a list.`);
}

function scenesFrom(value, id) {
  return listed(value, `Scenes for ${id}`).map((scene, index) => {
    const times = finitePair(scene?.start_sec ?? scene?.startSec, scene?.end_sec ?? scene?.endSec,
      `Scene ${index + 1} of ${id}`);
    const metadata = scene?.metadata && typeof scene.metadata === 'object' ? scene.metadata : scene;
    return {
      ...times,
      action: textOr(metadata?.action, ''),
      uncertainty: textOr(metadata?.uncertainty, ''),
    };
  });
}

function segmentsFrom(value, id) {
  return listed(value, `Vectors for ${id}`).map((segment, index) => {
    const times = finitePair(segment?.start_sec ?? segment?.startSec, segment?.end_sec ?? segment?.endSec,
      `Vector row ${index + 1} of ${id}`);
    return {
      ...times,
      embedding: segment?.embedding,
      source: textOr(segment?.embedding_option ?? segment?.source, 'unknown'),
    };
  });
}

function citations(annotations) {
  if (!Array.isArray(annotations)) return [];
  return annotations.map(annotation => {
    const citation = {};
    if (typeof annotation?.type === 'string') citation.type = annotation.type;
    const itemId = annotation?.itemId ?? annotation?.item_id;
    if (typeof itemId === 'string') citation.itemId = itemId;
    const start = annotation?.startSec ?? annotation?.start_sec;
    const end = annotation?.endSec ?? annotation?.end_sec;
    if (Number.isFinite(start)) citation.startSec = start;
    if (Number.isFinite(end)) citation.endSec = end;
    return citation;
  });
}

function clipSource(clip) {
  if (!clip || typeof clip.file !== 'string' || !clip.file.startsWith('media/')) {
    stop('Each clip must have a relative media/filename.mp4 path.');
  }
  const name = clip.file.slice(6);
  if (!name || name !== basename(name) || name.includes('\\') || !name.endsWith('.mp4') ||
      clip.id !== name.slice(0, -4)) {
    stop('Clip path or local ID does not match the article format.');
  }
  return join(ROOT, 'media', name);
}

function copyClip(clip) {
  const src = clipSource(clip);
  if (!existsSync(src)) return null;
  const info = lstatSync(src);
  if (!info.isFile() || info.isSymbolicLink()) stop('Manifest paths must select regular local files.');
  const mediaOut = join(PUB, 'media');
  mkdirSync(mediaOut, { recursive: true });
  const mediaFile = `media/${basename(clip.file)}`;
  copyFileSync(src, join(PUB, mediaFile));
  return mediaFile;
}

/** Scene files are JSON arrays. media-manifest readJson rejects arrays. */
async function readJsonValue(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    stop('Cannot read valid local JSON; details redacted. Existing data was not replaced.');
  }
}

function optionalJson(path) {
  if (!existsSync(path)) return undefined;
  return readJsonValue(path);
}

export function syntheticFixture() {
  const fakeVector = (seed, dim = 8) => Array.from({ length: dim }, (_, i) =>
    Math.round((((seed * (i + 3)) % 17) / 17 - 0.5) * 10000) / 10000);
  return {
    corpus: 'synthetic-demo',
    synthetic: true,
    clips: [
      {
        id: 'demo-clip-01',
        title: 'Demo: notebook and mug',
        durationSec: 30,
        mediaFile: null,
        groundTruth: [
          { startSec: 2, endSec: 6, label: 'person opens notebook' },
          { startSec: 12, endSec: 15, label: 'red mug moves right' },
        ],
        scenes: [
          { startSec: 0, endSec: 6, action: 'a person opens a notebook', uncertainty: 'unconfirmed' },
          { startSec: 12, endSec: 15, action: 'a red mug moves right', uncertainty: 'unconfirmed' },
        ],
        segments: [
          { startSec: 0, endSec: 6, embedding: fakeVector(1), source: 'synthetic' },
          { startSec: 6, endSec: 12, embedding: fakeVector(2), source: 'synthetic' },
          { startSec: 12, endSec: 18, embedding: fakeVector(3), source: 'synthetic' },
        ],
        summary: 'Synthetic summary: a person opens a notebook, then moves a red mug.',
        corrections: [
          { startSec: 12, endSec: 15, decision: 'accept', note: 'matches ground truth' },
        ],
      },
      {
        id: 'demo-clip-02',
        title: 'Demo: pen and clap',
        durationSec: 24,
        mediaFile: null,
        groundTruth: [
          { startSec: 4, endSec: 7, label: 'pen rolls off table' },
          { startSec: 16, endSec: 17, label: 'single clap' },
        ],
        scenes: [
          { startSec: 4, endSec: 7, action: 'a pen rolls off the table', uncertainty: 'unconfirmed' },
        ],
        segments: [
          { startSec: 0, endSec: 8, embedding: fakeVector(4), source: 'synthetic' },
          { startSec: 8, endSec: 16, embedding: fakeVector(5), source: 'synthetic' },
          { startSec: 16, endSec: 24, embedding: fakeVector(6), source: 'synthetic' },
        ],
        summary: 'Synthetic summary: a pen rolls away; later, one clap.',
        corrections: [],
      },
    ],
    queries: [
      { text: 'a person opens a notebook', embedding: fakeVector(1) },
      { text: 'a single clap', embedding: fakeVector(6) },
      { text: 'a window opens', embedding: fakeVector(9) },
    ],
    jockey: [
      {
        question: 'Synthetic example: what happens to the red mug?',
        answer: 'Synthetic answer: the mug moves right once. Real answers appear here after chapter 4.',
        citations: [{ startSec: 12, endSec: 15 }],
      },
    ],
  };
}

export async function realFixture() {
  const manifest = await readJson(MANIFEST);
  if (!manifest || !Array.isArray(manifest.clips)) stop('media-manifest.json has no clips array.');
  const clips = [];
  for (const clip of manifest.clips) {
    if (!clip || typeof clip.id !== 'string' || !clip.id) stop('A manifest clip is missing its id.');
    const summaryPath = join(RESULTS, `${clip.id}-summary.txt`);
    const summary = existsSync(summaryPath) ? (await readFile(summaryPath, 'utf8')).trim() : null;
    const scenesFile = await optionalJson(join(RESULTS, `${clip.id}-segments.json`));
    const vectorsFile = await optionalJson(join(VECTORS, `${clip.id}.json`));
    clips.push({
      id: clip.id,
      title: clip.id,
      durationSec: durationSec(clip.duration_sec ?? clip.durationSec, clip.id),
      mediaFile: copyClip(clip),
      groundTruth: groundTruth(clip.ground_truth, clip.id),
      scenes: scenesFile === undefined ? [] : scenesFrom(scenesFile, clip.id),
      segments: vectorsFile === undefined ? [] : segmentsFrom(vectorsFile, clip.id),
      summary,
      corrections: [],
    });
  }
  const queries = [];
  if (existsSync(VECTORS)) {
    const names = readdirSync(VECTORS).filter(name => name.startsWith('query-') && name.endsWith('.json')).sort();
    for (const name of names) {
      const query = await readJsonValue(join(VECTORS, name));
      if (!query || typeof query !== 'object') stop(`Query file ${name} is not an object.`);
      queries.push({
        text: textOr(query.text, name.slice(6, -5).replace(/-/g, ' ')),
        embedding: query.embedding,
      });
    }
  }
  const jockey = [];
  const highlights = await optionalJson(join(RESULTS, 'jockey-highlights.json'));
  if (highlights?.first) {
    jockey.push({
      question: 'Store-wide question (chapter 4, first turn)',
      answer: highlights.first.text,
      citations: citations(highlights.first.annotations),
    });
  }
  if (highlights?.second) {
    jockey.push({
      question: 'Highlight follow-up (chapter 4, second turn)',
      answer: highlights.second.text,
      citations: citations(highlights.second.annotations),
    });
  }
  return {
    corpus: typeof manifest.corpus === 'string' && manifest.corpus.trim() ? manifest.corpus : 'local-results',
    synthetic: false,
    clips,
    queries,
    jockey,
  };
}

export async function exportFixtures() {
  if (existsSync(MANIFEST)) {
    const fixture = await realFixture();
    for (const clip of fixture.clips) durationSec(clip.durationSec, clip.id);
    const out = join(PUB, 'fixtures.json');
    mkdirSync(dirname(out), { recursive: true });
    await saveJson(out, fixture);
    console.log(`wrote ${fixture.clips.length} clips from your saved results -> ${out}`);
    console.log('fixture and media stay gitignored; commit code only');
    return fixture;
  }
  const out = join(PUB, 'demo', 'fixtures.json');
  mkdirSync(dirname(out), { recursive: true });
  const fixture = syntheticFixture();
  for (const clip of fixture.clips) durationSec(clip.durationSec, clip.id);
  await saveJson(out, fixture);
  console.log(`no media-manifest.json — wrote synthetic demo fixture -> ${out}`);
  return fixture;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) reportError(new LabError('Run node export-fixtures.mjs without arguments.'));
  else exportFixtures().catch(reportError);
}
