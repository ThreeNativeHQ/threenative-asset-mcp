import { describe, expect, it } from "vitest";

import { aggregateFidelity, fidelityRegressions, ratchetUp, type FidelityBaseline } from "../src/unreal/fidelity-baseline.js";
import type { FidelityMetrics } from "../src/unreal/render-fidelity.js";

const metrics = (score: number): FidelityMetrics => ({
  comparable: true,
  hueEmdDegrees: 0,
  saturationRatio: 1,
  densityRatio: 1,
  massRatio: 1,
  lightnessRatio: 1,
  parts: { hue: 1, saturation: 1, density: 1, lightness: 1 },
  score,
});

describe("fidelity ratchet", () => {
  const baseline: FidelityBaseline = { "pack-a": { compared: 12, meanScore: 84, minScore: 70, suspect: 1, fail: 0 } };

  it("aggregates comparable tiles only", () => {
    const aggregate = aggregateFidelity([
      { verdict: "ok", fidelity: metrics(80) },
      { verdict: "suspect", fidelity: metrics(60) },
      { verdict: "fail" },
    ]);
    expect(aggregate).toEqual({ compared: 2, meanScore: 70, minScore: 60, suspect: 1, fail: 1 });
    expect(aggregateFidelity([{ verdict: "fail" }])).toBeUndefined();
  });

  it("passes a pack that holds its numbers, within render noise", () => {
    expect(fidelityRegressions({ "pack-a": { compared: 12, meanScore: 82.5, minScore: 66, suspect: 1, fail: 0 } }, baseline)).toEqual([]);
  });

  it("reports each way a pack can get worse: another fix undoing this pack's parity", () => {
    const worse = fidelityRegressions({ "pack-a": { compared: 10, meanScore: 70, minScore: 40, suspect: 4, fail: 2 } }, baseline).map((r) => r.reason);
    expect(worse).toHaveLength(4);
    expect(worse.join(" | ")).toMatch(/mean fidelity 84 -> 70.*worst piece fidelity 70 -> 40.*failing tiles 0 -> 2.*compared pieces 12 -> 10/);
  });

  it("treats a pack without a baseline as new, and only ever ratchets numbers upward", () => {
    expect(fidelityRegressions({ "pack-b": { compared: 3, meanScore: 10, minScore: 5, suspect: 3, fail: 3 } }, baseline)).toEqual([]);
    const next = ratchetUp(baseline, { "pack-a": { compared: 12, meanScore: 80, minScore: 75, suspect: 0, fail: 0 } });
    expect(next["pack-a"]).toEqual({ compared: 12, meanScore: 84, minScore: 75, suspect: 0, fail: 0 });
  });
});
