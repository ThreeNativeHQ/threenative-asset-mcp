import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runEffectsDumpHarness, type EffectsDumpHarnessRun } from "./helpers/effects-dump-harness.js";
import { describeWithTools } from "./helpers/require-tool.js";

/**
 * PROOF REQUIRED FIRST (PRD-584): the compiled production EffectDump serializer must survive a typed
 * object with a self cycle and a UObject owner field, keep all 32 array elements, and raise an
 * explicit refusal past its depth budget. The harness compiles the converter's own Program.cs, so
 * this exercises the shipped helper, not a copy.
 */
describeWithTools(["modern-converter"], "effect dump serializer is bounded (PRD-584)", () => {
  let directory = "";
  let run: EffectsDumpHarnessRun | undefined;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "tn-effects-dump-"));
    run = await runEffectsDumpHarness(join(directory, "build"));
  }, 900_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const result = (): Record<string, unknown> => {
    if (run?.build.code !== 0 || run.result === undefined) {
      throw new Error(`the effects dump harness did not run; exit ${run?.build.code}: ${run?.build.output ?? ""}`);
    }
    return run.result;
  };

  it("compiles the converter program with the harness", () => {
    expect(run?.build.code, run?.build.output).toBe(0);
  });

  it("breaks a self cycle instead of recursing", () => {
    expect(result()["self"]).toMatchObject({ kind: "cycle" });
    expect(result()["cycleError"]).toBeUndefined();
  });

  it("never follows a UObject owner graph", () => {
    expect(result()["owner"]).toMatchObject({ kind: "unsupported" });
    expect(Number(result()["cycleSize"])).toBeLessThan(4000);
  });

  it("keeps all 32 array elements, not a silent 16", () => {
    expect(result()["arrayCount"]).toBe(32);
    expect(result()["arrayError"]).toBeUndefined();
  });

  it("raises an explicit refusal past the depth budget", () => {
    expect(String(result()["deep"])).toMatch(/deeper than/);
  });
});
