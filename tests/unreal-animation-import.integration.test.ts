import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";

import { importUnrealDirectory } from "../src/unreal/importer.js";

/**
 * A UE Viewer stand-in that lists a blend-space class (so the package routes to the CUE4Parse animation
 * route) and exports nothing. The modern converter answers `--animations` with a good descriptor, a
 * malformed one and nothing at all, so the public import route exercises the three dispositions.
 */
async function writeAnimationTools(directory: string, packages: readonly string[]): Promise<{ umodel: string; modern: string }> {
  const umodel = join(directory, "umodel");
  await writeFile(
    umodel,
    `#!/usr/bin/env node
"use strict";
const { basename } = require("node:path");
const argv = process.argv.slice(2);
const classes = ${JSON.stringify(Object.fromEntries(packages.map((name) => [name, ["BlendSpace"]])))};
if (argv.includes("-version")) { process.stdout.write("UE Viewer (UModel)\\nCompiled fixture\\n"); process.exit(0); }
const target = basename(argv.filter((entry) => !entry.startsWith("-")).pop() || "").replace(/\\.(uasset|umap)$/i, "");
if (argv.includes("-list")) {
  process.stdout.write("Found 1 game files (0 skipped) in 1 folders\\n");
  (classes[target] || []).forEach((className, index) => process.stdout.write("   " + index + "    1000       10 " + className + " " + target + "\\n"));
  process.exit(0);
}
process.exit(0);
`,
  );
  await chmod(umodel, 0o755);
  const modern = join(directory, "modern-converter");
  await writeFile(
    modern,
    `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const exportAt = argv.indexOf("--export-dir");
if (argv.includes("--animations") && exportAt >= 0) {
  const animation = join(argv[exportAt + 1], "Animation");
  fs.mkdirSync(animation, { recursive: true });
  fs.writeFileSync(join(animation, "BS_Locomotion.json"), JSON.stringify({
    format: "threenative-unreal-animation", version: 1, kind: "blendSpace", name: "BS_Locomotion",
    package: "/Game/Anim/BS_Locomotion", className: "BlendSpace1D", skeleton: "SK_Absent", blendSpaceType: "1D",
    axes: [{ displayName: "Speed", min: 0, max: 600, gridNum: 6 }],
    samples: [{ animation: "M_Walk", sampleValue: [150, 0, 0], rateScale: 1, mirror: false }],
  }));
  fs.writeFileSync(join(animation, "BS_Bad.json"), "{ not json");
}
process.exit(0);
`,
  );
  await chmod(modern, 0o755);
  return { umodel, modern };
}

it("imports logic-only animation packages without failing empty and reports each disposition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tn-animation-import-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const sourceDir = join(directory, "source");
  const outputDir = join(directory, "output");
  const animation = join(sourceDir, "Content", "Anim");
  await mkdir(animation, { recursive: true });
  for (const name of ["BS_Locomotion", "BS_Empty", "BS_Bad"]) await writeFile(join(animation, `${name}.uasset`), Buffer.from("\u0000BlendSpace\u0000"));
  const tools = await writeAnimationTools(directory, ["BS_Locomotion", "BS_Empty", "BS_Bad"]);

  const report = await importUnrealDirectory({
    sourceDir,
    outputDir,
    concurrency: 1,
    graphBake: false,
    freeSpaceBytes: 30_000_000_000,
    umodel: { name: "umodel", path: tools.umodel, version: "fixture" },
    modernConverter: { name: "modern", path: tools.modern, version: "fake-converter 1" },
  });

  // A logic-only pack is not UNREAL_EXPORT_EMPTY: the good descriptor is written and its reference is
  // reported unresolved because no mesh exported the clip it names.
  expect(report.animationLogic).toHaveLength(1);
  expect(report.animationLogic[0]!.name).toBe("BS_Locomotion");
  expect(report.animationLogic[0]!.unresolvedClips).toEqual([{ clip: "M_Walk", reason: "no exported animation has this name" }]);
  expect(report.failed.some((entry) => entry.package.endsWith("BS_Bad.uasset") && /not valid JSON/.test(entry.reason))).toBe(true);
  expect(report.failed.some((entry) => entry.package.endsWith("BS_Empty.uasset") && /wrote no clip or descriptor/.test(entry.reason))).toBe(true);
});
