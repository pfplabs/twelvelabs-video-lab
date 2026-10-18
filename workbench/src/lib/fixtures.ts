import type { Fixtures } from "../types";

/**
 * Load the real fixture exported from your saved API results first;
 * fall back to the committed synthetic demo when no export exists.
 * A missing /fixtures.json comes back as the SPA's index.html in dev,
 * so only a JSON content-type counts as a real export.
 */
export async function loadFixtures(): Promise<Fixtures> {
  const real = await fetch("/fixtures.json");
  const isJson = (real.headers.get("content-type") ?? "").includes("json");
  if (real.ok && isJson) return validateFixtures((await real.json()) as Fixtures);
  const demo = await fetch("/demo/fixtures.json");
  if (!demo.ok) throw new Error(`fixture load failed: ${demo.status}`);
  return validateFixtures((await demo.json()) as Fixtures);
}

/** Schema check: the exporter must emit camelCase durationSec, never duration_sec. */
export function validateFixtures(data: Fixtures): Fixtures {
  if (!Array.isArray(data.clips)) throw new Error("fixture has no clips array");
  for (const clip of data.clips) {
    if (!Number.isFinite(clip.durationSec)) {
      throw new Error(`clip ${clip.id} is missing numeric durationSec`);
    }
  }
  return data;
}
