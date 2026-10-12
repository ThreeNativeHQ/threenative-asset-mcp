import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runEffectsDumpHarness, type EffectsDumpHarnessRun } from "./helpers/effects-dump-harness.js";
import { describeWithTools } from "./helpers/require-tool.js";
import { effectDescriptorRelativePath } from "../src/unreal/effects-dump.js";

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

  const identity = (pkg: string, system: string) => ({ package: pkg, system });

  it("sanitizes the compiled descriptor pointer exactly as the Node writer", () => {
    // The pointer and the written file must agree; a raw name with a space used to diverge.
    expect(result()["pointerCascade"]).toBe(effectDescriptorRelativePath(identity("/Game/A/P fire", "P fire"), "cascade"));
    expect(result()["pointerNiagara"]).toBe(effectDescriptorRelativePath(identity("/Game/A/P fire", "P fire"), "niagara"));
    expect(String(result()["pointerCascade"])).toMatch(/^Effects\/P_fire-[0-9a-f]{16}\.cascade\.json$/);
    expect(result()["pointerError"]).toBeUndefined();
  });

  it("keeps same-basename, case-variant and sanitization-collision identities distinct", () => {
    // Same basename in two folders: two different files, so the level pointer cannot resolve the wrong one.
    expect(result()["pointerFolderA"]).not.toBe(result()["pointerFolderB"]);
    expect(result()["pointerFolderA"]).toBe(effectDescriptorRelativePath(identity("/Game/A/P_effect", "P_effect"), "cascade"));
    expect(result()["pointerFolderB"]).toBe(effectDescriptorRelativePath(identity("/Game/B/P_effect", "P_effect"), "cascade"));
    // A package case variant and a `/Content/` mount are the same identity, so the same file.
    expect(result()["pointerCaseVariant"]).toBe(result()["pointerFolderA"]);
    // `P fire` and `P_fire` sanitize to the same display label but are different canonical identities.
    expect(String(result()["pointerUnderscore"])).toMatch(/^Effects\/P_fire-[0-9a-f]{16}\.cascade\.json$/);
    expect(result()["pointerUnderscore"]).not.toBe(result()["pointerCascade"]);
    expect(result()["pointerUnderscore"]).toBe(effectDescriptorRelativePath(identity("/Game/A/P_fire", "P_fire"), "cascade"));
  });

  it("keeps a traversal name under Effects/ and an empty name deterministic", () => {
    const traversal = String(result()["pointerTraversal"]);
    expect(traversal.startsWith("Effects/")).toBe(true);
    expect(traversal.split("/")).not.toContain("..");
    expect(result()["pointerTraversal"]).toBe(effectDescriptorRelativePath(identity("/Game/A/P_evil", "../../evil"), "cascade"));
    expect(String(result()["pointerEmpty"])).toMatch(/^Effects\/Effect-[0-9a-f]{16}\.cascade\.json$/);
    expect(result()["pointerEmpty"]).toBe(effectDescriptorRelativePath(identity("/Game/A/P_empty", ""), "cascade"));
  });

  it("returns no pointer for a null reference or an unresolvable path", () => {
    expect(result()["pointerNull"]).toBeNull();
    expect(result()["pointerNullPath"]).toBeNull();
  });
});
