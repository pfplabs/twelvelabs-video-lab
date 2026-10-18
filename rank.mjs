/** Chapter 4: local cosine retrieval over saved segment vectors. No API calls.
 * Clip ids come from state.clips. Chapter 2 does not write state.assets.
 * A score is not evidence. Picture and sound rows for the same times are separate.
 */
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, LabError, readJson } from './media-manifest.mjs';

function stop(message) {
  throw new LabError(message);
}

export function normalize(vector) {
  if (!Array.isArray(vector) || !vector.every(value => typeof value === 'number' && Number.isFinite(value))) {
    stop('non-finite or nonnumeric value in vector');
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm)) stop('non-finite vector norm');
  if (norm === 0) stop('zero-norm vector cannot be ranked');
  return vector.map(value => value / norm);
}

export function rank(segments, query, topK = 5) {
  const normalizedQuery = normalize(query);
  return segments
    .map(segment => {
      const vector = normalize(segment.embedding);
      if (vector.length !== normalizedQuery.length) {
        stop(`dimension mismatch: ${vector.length} vs query ${normalizedQuery.length}`);
      }
      const score = vector.reduce((sum, value, index) => sum + value * normalizedQuery[index], 0);
      return { ...segment, score };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, topK);
}

export async function loadSegments(root, clipIds) {
  const segments = [];
  for (const clipId of clipIds) {
    const data = await readJson(join(root, 'vectors', `${clipId}.json`));
    if (!data || !Array.isArray(data.segments) || data.segments.length === 0) {
      stop(`No saved segment vectors for ${clipId}. Run embeddings.mjs first.`);
    }
    for (const segment of data.segments) segments.push({ clip_id: clipId, ...segment });
  }
  return segments;
}

export async function runRank({ root = ROOT, topK = 5 } = {}) {
  const state = await readJson(join(root, 'state.json'));
  const clipIds = Array.isArray(state?.clips) ? state.clips.map(clip => clip?.id) : [];
  if (clipIds.length === 0 || clipIds.some(id => typeof id !== 'string' || !id)) {
    stop('state.json has no clip ids to rank.');
  }
  const query = await readJson(join(root, 'vectors', 'query-notebook.json'));
  if (!query || !Array.isArray(query.embedding)) stop('No saved query vector. Run embeddings.mjs first.');
  const hits = rank(await loadSegments(root, clipIds), query.embedding, topK);
  for (const hit of hits) {
    const option = hit.embedding_option ?? 'unknown';
    console.log(`${hit.score.toFixed(3)}  ${hit.clip_id}  ${hit.start_sec.toFixed(1)}-${hit.end_sec.toFixed(1)}s  ${option}`);
  }
  console.log('These scores are not evidence. Replay the timestamps yourself.');
  return hits;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {
    console.error('Run node rank.mjs without arguments.');
    process.exitCode = 1;
  } else {
    runRank().catch(error => {
      console.error(error instanceof LabError ? error.message : 'Run stopped; details redacted.');
      process.exitCode = 1;
    });
  }
}
