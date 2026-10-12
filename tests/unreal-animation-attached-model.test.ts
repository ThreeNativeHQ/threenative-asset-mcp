import { expect, it } from "vitest";

import { duplicateBoneNameWarnings, recordAttachedPsa } from "../src/unreal/importer.js";

// The clip-attachment map is keyed by clip name and valued by the mesh that accepted the clip. Two LODs
// of one mesh share the base mesh name, so they group into one rig; two genuinely different rigs that
// merely share bone names must not.

it("warns when one clip attaches to two different rigs by bone name", () => {
  const byModel = new Map<string, Set<string>>();
  recordAttachedPsa(byModel, "Hero", ["Idle_Loop"]);
  recordAttachedPsa(byModel, "Villain", ["Idle_Loop"]);
  const warnings = duplicateBoneNameWarnings(byModel);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("idle_loop");
  expect(warnings[0]).toContain("Hero");
  expect(warnings[0]).toContain("Villain");
});

it("does not warn when two LODs of the same mesh take the same clip", () => {
  const byModel = new Map<string, Set<string>>();
  recordAttachedPsa(byModel, "Hero", ["Idle_Loop"]);
  recordAttachedPsa(byModel, "Hero", ["Idle_Loop"]);
  expect(duplicateBoneNameWarnings(byModel)).toEqual([]);
});
