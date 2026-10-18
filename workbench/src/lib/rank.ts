import type { QueryFixture, Segment } from "../types";

export interface RankedSegment extends Segment {
  clipId: string;
  score: number;
}

export function normalize(v: number[]): number[] {
  if (!v.every(Number.isFinite)) throw new Error("non-finite value in vector");
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  if (norm === 0) throw new Error("zero-norm vector cannot be ranked");
  return v.map((x) => x / norm);
}

/** Cosine similarity ranking — the same math as the Python lab. */
export function rankSegments(
  segments: (Segment & { clipId: string })[],
  queryEmbedding: number[],
  topK = 5,
): RankedSegment[] {
  const q = normalize(queryEmbedding);
  return segments
    .map((seg) => {
      const v = normalize(seg.embedding);
      if (v.length !== q.length) {
        throw new Error(`dimension mismatch: ${v.length} vs query ${q.length}`);
      }
      const score = v.reduce((sum, x, i) => sum + x * q[i], 0);
      return { ...seg, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** Rank one query; malformed vectors surface as an error, never as "no results". */
export function rankForQuery(
  segments: (Segment & { clipId: string })[],
  query: QueryFixture | undefined,
): { results: RankedSegment[]; error: string | null } {
  if (!query || segments.length === 0) return { results: [], error: null };
  try {
    return { results: rankSegments(segments, query.embedding), error: null };
  } catch (e) {
    return { results: [], error: e instanceof Error ? e.message : String(e) };
  }
}
