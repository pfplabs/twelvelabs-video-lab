import { describe, expect, it } from "vitest";
import { normalize, rankForQuery, rankSegments } from "./rank";
import { validateFixtures } from "./fixtures";
import type { Fixtures } from "../types";
import demo from "../../public/demo/fixtures.json";

const seg = (embedding: number[], startSec = 0) => ({
  startSec,
  endSec: startSec + 6,
  embedding,
  source: "test",
  clipId: "clip",
});

describe("normalize", () => {
  it("rejects zero-norm vectors", () => {
    expect(() => normalize([0, 0, 0])).toThrow(/zero-norm/);
  });
  it("rejects non-finite values", () => {
    expect(() => normalize([1, Number.NaN])).toThrow(/non-finite/);
  });
  it("produces unit length", () => {
    const v = normalize([3, 4]);
    expect(Math.hypot(...v)).toBeCloseTo(1);
  });
});

describe("rankSegments", () => {
  it("ranks identical direction first", () => {
    const hits = rankSegments([seg([1, 0]), seg([0, 1])], [1, 0]);
    expect(hits[0].score).toBeCloseTo(1);
    expect(hits[1].score).toBeCloseTo(0);
  });
  it("throws on dimension mismatch", () => {
    expect(() => rankSegments([seg([1, 0, 0])], [1, 0])).toThrow(/dimension mismatch/);
  });
  it("respects topK", () => {
    const hits = rankSegments(
      [seg([1, 0]), seg([0.9, 0.1]), seg([0, 1])], [1, 0], 2,
    );
    expect(hits).toHaveLength(2);
  });
});

describe("rankForQuery", () => {
  it("surfaces malformed vectors as an error instead of empty results", () => {
    const out = rankForQuery([seg([0, 0])], { text: "q", embedding: [1, 0] });
    expect(out.results).toEqual([]);
    expect(out.error).toMatch(/zero-norm/);
  });
});

describe("validateFixtures", () => {
  it("accepts the committed synthetic fixture with durationSec", () => {
    expect(validateFixtures(demo as Fixtures).clips.every((c) => c.durationSec > 0)).toBe(true);
  });
  it("rejects snake_case duration_sec", () => {
    const bad = { corpus: "x", synthetic: true, queries: [], clips: [{ id: "c", duration_sec: 5 }] };
    expect(() => validateFixtures(bad as unknown as Fixtures)).toThrow(/durationSec/);
  });
});
