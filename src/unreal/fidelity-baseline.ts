/**
 * The fidelity ratchet (PRD-537). Once a pack reaches parity with Unreal's thumbnails its numbers are recorded
 * in `docs/parity/fidelity-baseline.json`; a later sweep that scores a pack lower than its baseline is a
 * regression and is reported, so a fix for one pack cannot silently undo another's. Numbers only: no pack, asset
 * or texture names and no images, so the file is safe to commit.
 */
import type { TileJudgement } from "./contact-sheet.js";

export interface PackFidelity {
  /** Tiles that had a comparable Unreal thumbnail. */
  readonly compared: number;
  readonly meanScore: number;
  readonly minScore: number;
  /** Tiles the judge marked suspect / fail (any rule, not only fidelity). */
  readonly suspect: number;
  readonly fail: number;
}

export type FidelityBaseline = Readonly<Record<string, PackFidelity>>;

/** A pack may lose this many mean points / minimum points before it counts as a regression (render noise). */
export const MEAN_TOLERANCE = 2;
export const MIN_TOLERANCE = 6;

export function aggregateFidelity(tiles: readonly Pick<TileJudgement, "verdict" | "fidelity">[]): PackFidelity | undefined {
  const scores = tiles.flatMap((tile) => (tile.fidelity?.comparable ? [tile.fidelity.score] : []));
  if (scores.length === 0) return undefined;
  const round = (value: number): number => Math.round(value * 10) / 10;
  return {
    compared: scores.length,
    meanScore: round(scores.reduce((a, b) => a + b, 0) / scores.length),
    minScore: round(Math.min(...scores)),
    suspect: tiles.filter((tile) => tile.verdict === "suspect").length,
    fail: tiles.filter((tile) => tile.verdict === "fail").length,
  };
}

export interface FidelityRegression {
  readonly pack: string;
  readonly reason: string;
}

/** Packs in `current` that score worse than their baseline entry. A pack absent from the baseline is new, not a regression. */
export function fidelityRegressions(current: FidelityBaseline, baseline: FidelityBaseline): FidelityRegression[] {
  const found: FidelityRegression[] = [];
  for (const [pack, now] of Object.entries(current)) {
    const was = baseline[pack];
    if (!was) continue;
    if (now.meanScore < was.meanScore - MEAN_TOLERANCE) found.push({ pack, reason: `mean fidelity ${was.meanScore} -> ${now.meanScore}` });
    if (now.minScore < was.minScore - MIN_TOLERANCE) found.push({ pack, reason: `worst piece fidelity ${was.minScore} -> ${now.minScore}` });
    if (now.fail > was.fail) found.push({ pack, reason: `failing tiles ${was.fail} -> ${now.fail}` });
    if (now.compared < was.compared) found.push({ pack, reason: `compared pieces ${was.compared} -> ${now.compared} (thumbnails or renders lost)` });
  }
  return found;
}

/** A baseline entry only ever improves: the better of the recorded and the new numbers per field. */
export function ratchetUp(baseline: FidelityBaseline, current: FidelityBaseline): FidelityBaseline {
  const next: Record<string, PackFidelity> = { ...baseline };
  for (const [pack, now] of Object.entries(current)) {
    const was = baseline[pack];
    next[pack] = was
      ? {
          compared: Math.max(was.compared, now.compared),
          meanScore: Math.max(was.meanScore, now.meanScore),
          minScore: Math.max(was.minScore, now.minScore),
          suspect: Math.min(was.suspect, now.suspect),
          fail: Math.min(was.fail, now.fail),
        }
      : now;
  }
  return next;
}
