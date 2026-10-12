import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";

import { importUnrealDirectory } from "../src/unreal/importer.js";
import { Document, NodeIO } from "@gltf-transform/core";
import { writeFakeUmodel, writePsaFixture } from "./helpers/unreal-fixture.js";

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
  fs.writeFileSync(join(animation, "BS_WrongShape.json"), JSON.stringify({ format: "something-else", name: "x" }));
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
  for (const name of ["BS_Locomotion", "BS_Empty", "BS_Bad", "BS_WrongShape"]) await writeFile(join(animation, `${name}.uasset`), Buffer.from("\u0000BlendSpace\u0000"));
  const tools = await writeAnimationTools(directory, ["BS_Locomotion", "BS_Empty", "BS_Bad", "BS_WrongShape"]);

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
  expect(report.failed.some((entry) => entry.package === "/Game/Anim/BS_Bad" && /not valid JSON/.test(entry.reason))).toBe(true);
  // Valid JSON of the wrong shape is a defect reported for its package, not silently ignored.
  expect(
    report.failed.some((entry) => entry.package === "/Game/Anim/BS_WrongShape" && /not a threenative-unreal-animation descriptor: format is not/.test(entry.reason)),
  ).toBe(true);
  expect(report.failed.some((entry) => entry.package.endsWith("BS_Empty.uasset") && /wrote no clip or descriptor/.test(entry.reason))).toBe(true);
});

/**
 * The nested-artifact regression: two packages that share the asset basename `Walk` must resolve to
 * their exact package by the artifact's own directory, never collapse to a last write or a basename
 * guess. A flat artifact whose basename is shared is an ambiguity; a nested artifact whose declared
 * package disagrees with its directory is refused.
 */
it("maps nested animation artifacts to exact packages and refuses ambiguity and mismatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tn-animation-nested-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const sourceDir = join(directory, "source");
  const outputDir = join(directory, "output");
  for (const folder of ["A", "B"]) {
    await mkdir(join(sourceDir, "Content", folder), { recursive: true });
    await writeFile(join(sourceDir, "Content", folder, "Walk.uasset"), Buffer.from("\u0000BlendSpace\u0000"));
  }
  const tools = await writeAnimationTools(directory, ["Walk"]);
  const descriptor = (name: string, packagePath: string) => JSON.stringify({
    format: "threenative-unreal-animation", version: 1, kind: "blendSpace", name, package: packagePath,
    className: "BlendSpace1D", skeleton: "SK_Absent", blendSpaceType: "1D", axes: [], samples: [],
  });
  await writeFile(
    tools.modern,
    `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const exportAt = argv.indexOf("--export-dir");
if (argv.includes("--animations") && exportAt >= 0) {
  const root = join(argv[exportAt + 1], "Animation");
  const write = (relative, body) => {
    const target = join(root, relative);
    fs.mkdirSync(join(target, ".."), { recursive: true });
    fs.writeFileSync(target, body);
  };
  write("A/Walk/Walk.json", ${JSON.stringify(descriptor("Walk", "/Game/A/Walk"))});
  write("B/Walk/Walk.json", ${JSON.stringify(descriptor("Walk", "/Game/B/Walk"))});
  // A nested artifact whose declared package disagrees with its directory must be refused.
  write("A/Walk/Bad.json", ${JSON.stringify(descriptor("Bad", "/Game/B/Walk"))});
  // A flat artifact whose package is only a shared basename is an ambiguity, never a last-write winner.
  write("Walk.json", ${JSON.stringify(descriptor("Walk", "Walk"))});
}
process.exit(0);
`,
  );
  await chmod(tools.modern, 0o755);

  const report = await importUnrealDirectory({
    sourceDir,
    outputDir,
    concurrency: 1,
    graphBake: false,
    freeSpaceBytes: 30_000_000_000,
    umodel: { name: "umodel", path: tools.umodel, version: "fixture" },
    modernConverter: { name: "modern", path: tools.modern, version: "fake-converter 1" },
  });

  // The two nested descriptors keep their exact packages; the flat one is not assigned to either.
  expect(report.animationLogic.map((asset) => asset.package).sort()).toEqual(["/Game/A/Walk", "/Game/B/Walk"]);
  expect(new Set(report.animationLogic.map((asset) => asset.json)).size).toBe(2);
  for (const asset of report.animationLogic) {
    expect(asset.json).toContain(`${asset.package.slice("/Game/".length)}/`);
    expect(JSON.parse(await readFile(join(outputDir, asset.json), "utf8"))).toHaveProperty("samples");
  }
  expect(report.failed.some((entry) => /matches 2 source packages/.test(entry.reason))).toBe(true);
  expect(
    report.failed.some((entry) => entry.package === "/Game/B/Walk" && /declares package .* but was written under \/Game\/A\/Walk/.test(entry.reason)),
  ).toBe(true);
});

it.each([{ secondExported: false, foreign: false, foreignRig: false }, { secondExported: true, foreign: false, foreignRig: false }, { secondExported: true, foreign: true, foreignRig: false }, { secondExported: false, foreign: false, foreignRig: true }])("keeps nested clip capabilities distinct across every LOD ($secondExported, foreign: $foreign, foreignRig: $foreignRig)", async ({ secondExported, foreign, foreignRig }) => {
  const directory = await mkdtemp(join(tmpdir(), "tn-animation-capability-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const sourceDir = join(directory, "source");
  const outputDir = join(directory, "output");
  const fixtureDir = join(directory, "mesh");
  await mkdir(fixtureDir, { recursive: true });
  const document = new Document();
  const buffer = document.createBuffer();
  const root = document.createNode("root");
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer))
    .setAttribute("JOINTS_0", document.createAccessor().setType("VEC4").setArray(new Uint16Array(12)).setBuffer(buffer))
    .setAttribute("WEIGHTS_0", document.createAccessor().setType("VEC4").setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])).setBuffer(buffer));
  document.createScene().addChild(root).addChild(document.createNode("Hero")
    .setMesh(document.createMesh().addPrimitive(primitive)).setSkin(document.createSkin().addJoint(root)));
  await new NodeIO().write(join(fixtureDir, "Hero.gltf"), document);
  if (foreignRig) await new NodeIO().write(join(fixtureDir, "HeroB.gltf"), document);
  if (foreign) {
    await new NodeIO().write(join(fixtureDir, "Hero.glb"), document);
    await new NodeIO().write(join(fixtureDir, "Hero_LOD1.glb"), document);
  }
  const psa = join(directory, "Walk.psa");
  await writePsaFixture(psa, { animation: "Walk" });
  const classes = { Hero: foreign ? ["SkeletalMesh", "SkeletalMeshSocket"] : ["SkeletalMesh"], HeroB: ["SkeletalMesh"], Walk: ["AnimSequence"], Ref: ["BlendSpace"] };
  for (const relative of ["Characters/Hero", ...(foreignRig ? ["Characters/HeroB"] : []), "A/Walk", "B/Walk", "Logic/A/Ref", "Logic/B/Ref"]) {
    await mkdir(join(sourceDir, "Content", relative, ".."), { recursive: true });
    const header = Buffer.alloc(24);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(relative.endsWith("Walk") ? -8 : -7, 4);
    header.writeInt32LE(864, 8);
    header.writeInt32LE(522, 12);
    header.writeInt32LE(1004, 16);
    await writeFile(join(sourceDir, "Content", `${relative}.uasset`), header);
  }
  const umodel = join(directory, "umodel");
  await writeFakeUmodel(umodel, { classes, exportFromByPackage: { Hero: fixtureDir, HeroB: fixtureDir } });
  const modern = join(directory, "modern");
  await writeFile(modern, `#!/usr/bin/env node
const fs = require("node:fs");
const { join, dirname } = require("node:path");
const args = process.argv.slice(2), out = args[args.indexOf("--export-dir") + 1];
const write = (path, value) => { const target = join(out, path); fs.mkdirSync(dirname(target), {recursive:true}); fs.writeFileSync(target, JSON.stringify(value)); };
if (args.includes("--animations")) {
  for (const folder of ["A", "B"]) {
    write("Animation/" + folder + "/Walk/Walk.clip.json", {format:"threenative-unreal-animation",version:1,kind:"clip",name:"Walk",package:"/Game/" + folder + "/Walk",className:"AnimSequence",skeleton: folder === "B" && ${foreign} ? "/Game/B/Skeleton" : "/Game/Characters/Skeleton"});
    if (folder === "A" || ${secondExported}) fs.copyFileSync(${JSON.stringify(psa)}, join(out,"Animation",folder,"Walk","Walk.psa"));
    write("Animation/Logic/" + folder + "/Ref/Ref.json", {format:"threenative-unreal-animation",version:1,kind:"blendSpace",name:"Ref",package:"/Game/Logic/"+folder+"/Ref",className:"BlendSpace1D",axes:[],samples:[{animation:"/Game/"+folder+"/Walk.Walk",sampleValue:[0,0,0]}]});
  }
} else {
  write("Gameplay/Content/Characters/Hero.json", {version:1,package:"Content/Characters/Hero",skeletonRef:"/Game/Characters/Skeleton"});
  if (${foreignRig}) write("Gameplay/Content/Characters/HeroB.json", {version:1,package:"Content/Characters/HeroB",skeletonRef:"/Game/B/Skeleton"});
  if (${foreign}) {
    fs.mkdirSync(join(out,"Meshes"),{recursive:true});
    for (const name of ["Hero", "Hero_LOD1"]) fs.copyFileSync(join(${JSON.stringify(fixtureDir)},name+".glb"),join(out,"Meshes",name+".glb"));
  }
}
`);
  await chmod(modern, 0o755);
  const report = await importUnrealDirectory({ sourceDir, outputDir, concurrency: 1, graphBake: false,
    ...(foreign ? { lods: [0, 1] } : {}),
    freeSpaceBytes: 30_000_000_000, umodel: { name: "umodel", path: umodel, version: "fixture" },
    modernConverter: { name: "modern", path: modern, version: "fixture" } });
  expect(report.models).toHaveLength(foreign || foreignRig ? 2 : 1);
  for (const model of report.models) {
    const glb = await new NodeIO().read(join(outputDir, model.glb));
    const names = glb.getRoot().listAnimations().map((animation) => animation.getName());
    expect(names).toEqual(foreignRig && model.name === "HeroB" ? [] : secondExported && !foreign ? ["Walk", "B_Walk_Walk"] : ["Walk"]);
  }
  if (foreignRig) expect(report.failed.filter((entry) => entry.package === "/Game/A/Walk")).toEqual([]);
  if (foreign) {
    const failures = report.failed.filter((entry) => entry.package === "/Game/B/Walk");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toMatch(/skeleton package .* differs/);
  }
  for (const folder of ["A", "B"]) {
    const descriptor = report.animationLogic.find((asset) => asset.package === `/Game/Logic/${folder}/Ref`)!;
    if (folder === "A") expect(descriptor.unresolvedClips).toEqual([]);
    const value = JSON.parse(await readFile(join(outputDir, descriptor.json), "utf8"));
    const sidecar = report.animationClips.find((asset) => asset.package === `/Game/${folder}/Walk`)!;
    const clip = JSON.parse(await readFile(join(outputDir, sidecar.json), "utf8"));
    if (folder === "B" && (!secondExported || foreign)) {
      expect(descriptor.unresolvedClips).toHaveLength(1);
      expect(clip.unsupportedReason).toMatch(/no exported glTF animation/);
    } else {
      const expected = folder === "A" ? "Walk" : "B_Walk_Walk";
      expect(value.samples[0].clip).toBe(expected);
      expect(clip.clip).toBe(expected);
      expect(descriptor.unresolvedClips).toEqual([]);
    }
  }
});
