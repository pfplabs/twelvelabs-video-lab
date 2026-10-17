export type Status = 'ready' | 'processing' | 'failed';
export interface Video {
  filename: string;
  source: string;
  license: string;
  attribution: string;
  duration_seconds: number;
  status: Status;
  failure_reason: string | null;
}

export function parseVideos(input: unknown): Video[] {
  if (!Array.isArray(input)) throw new Error('Inventory must be a list');
  const names = new Set<string>();
  return input.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid record');
    const fields = ['filename', 'source', 'license', 'attribution', 'duration_seconds', 'status', 'failure_reason'];
    if (Object.keys(row).some(key => !fields.includes(key))) throw new Error('Unknown field');
    for (const field of ['filename', 'source', 'license', 'attribution']) {
      if (typeof row[field] !== 'string' || !row[field].trim()) throw new Error('Missing metadata');
    }
    if (typeof row.duration_seconds !== 'number' || !Number.isFinite(row.duration_seconds) || row.duration_seconds <= 0) throw new Error('Invalid duration');
    if (!['ready', 'processing', 'failed'].includes(row.status)) throw new Error('Invalid status');
    if (row.failure_reason != null && typeof row.failure_reason !== 'string') throw new Error('Invalid failure reason');
    if (names.has(row.filename)) throw new Error('Duplicate filename');
    names.add(row.filename);
    return { ...row, failure_reason: row.failure_reason ?? null } as Video;
  });
}

export const analysisEligible = (video: Video): boolean => video.status === 'ready';
export function statusDetail(video: Video): string {
  if (video.status === 'failed') return video.failure_reason?.trim() || 'Failure reason unavailable.';
  return video.status === 'processing' ? 'Processing; not eligible for analysis.' : 'Ready for analysis.';
}
