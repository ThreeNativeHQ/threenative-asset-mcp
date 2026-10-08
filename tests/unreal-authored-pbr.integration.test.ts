import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { afterEach, expect, it } from "vitest";
import { importUnrealDirectory, packageGlb } from "../src/unreal/importer.js";
import type { SourceMaterial } from "../src/unreal/source-material.js";
import { writeFakeUmodel, writeMeshFixture, writePng } from "./helpers/unreal-fixture.js";
import { bool, materialPackage, subsetInstance, subsetMaster } from "./helpers/unreal-material-source.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it.each([{ meshOnly: false, duplicatePng: false }, { meshOnly: true, duplicatePng: false }, { meshOnly: false, duplicatePng: true }])("actual importer packages authored AO.R and raw roughness through selected source switches (%j)", async ({ meshOnly, duplicatePng }) => {
  const directory = await mkdtemp(join(tmpdir(), "authored-pbr-")); directories.push(directory);
  const sourceDir = join(directory, "source"); const kit = join(sourceDir, "Content", "Kit");
  const fixture = join(directory, "fixture"); const outputDir = join(directory, "output");
  await mkdir(kit, { recursive: true });
  await writeFile(join(kit, "Master.uasset"), subsetMaster());
  await writeFile(join(kit, "Instance.uasset"), subsetInstance());
  await writeFile(join(kit, "Packed.uasset"), materialPackage([{ name: "Packed", className: "Texture2D", properties: [bool("SRGB", false)] }]));
  await writeFile(join(kit, "Huge.uasset"), materialPackage([{ name: "Huge", className: "Texture2D", properties: [bool("SRGB", false)] }]));
  await truncate(join(kit, "Huge.uasset"), 32 * 1024 * 1024 + 1);
  await writeFile(join(kit, "Mesh.uasset"), Buffer.alloc(16));
  await writeMeshFixture(fixture, { name: "Mesh", materialName: "Instance", mat: "Diffuse=Albedo\nOther[0]=Packed", props: "", textures: ["Albedo", "Packed", "Huge"] });
  await writePng(join(fixture, "Albedo.png"), [120, 110, 100, 255]);
  await writePng(join(fixture, "Packed.png"), [64, 210, 17, 255]);
  if (duplicatePng) {
    await mkdir(join(sourceDir, "Content", "Other"), { recursive: true });
    await writeFile(join(sourceDir, "Content", "Other", "Packed.uasset"), materialPackage([{ name: "Packed", className: "Texture2D", properties: [bool("SRGB", false)] }]));
    await mkdir(join(fixture, "ZOther"), { recursive: true });
    await writePng(join(fixture, "ZOther", "Packed.png"), [203, 90, 80, 255]);
  }
  const tool = join(directory, "umodel");
  await writeFakeUmodel(tool, { exportFrom: fixture, emptyExports: ["Master"], classes: { Mesh: ["StaticMesh"], Master: ["Material"], Instance: ["MaterialInstanceConstant"], Packed: ["Texture2D"], Huge: ["Texture2D"] } });
  const report = await importUnrealDirectory({ sourceDir, outputDir, ...(meshOnly ? { onlyPackages: ["Mesh"] } : {}), concurrency: 1, graphBake: false, freeSpaceBytes: 30_000_000_000, umodel: { name: "umodel", path: tool, version: "fixture" } });
  expect(report.models).toHaveLength(1);
  const section = report.models[0]!.materials[0]!;
  expect(section.factors.roughness).toBe(1);
  expect(section.limitations.join("\n")).toContain("authored Roughness 5");
  expect(section.limitations.join("\n")).toContain("OpaqueNormal");
  expect(section.limitations.join("\n")).toContain("Specular");
  expect(section.limitations.join("\n")).toContain("MSM_TwoSidedFoliage");
  const glb = await new NodeIO().read(join(outputDir, report.models[0]!.glb));
  const material = glb.getRoot().listMaterials()[0]!;
  if (duplicatePng) {
    expect(material.getOcclusionTexture() === null).toBe(true);
    expect(section.bindings.some((b) => b.slot === "occlusion")).toBe(false);
    expect(section.limitations.join("\n")).toContain("ambiguous exported PNG basename Packed");
  } else {
    expect(material.getOcclusionTexture()).not.toBeNull();
    expect(material.getOcclusionTextureInfo()!.getTexCoord()).toBe(material.getBaseColorTextureInfo()!.getTexCoord());
    const sharp = (await import("sharp")).default;
    const pixels = await sharp(material.getOcclusionTexture()!.getImage()!).raw().toBuffer();
    expect(pixels[0]).toBe(64);
  }
  if (!meshOnly) {
    const library = await new NodeIO().read(join(outputDir, "Materials", "UnrealMaterialLibrary.glb"));
    expect(library.getRoot().listMaterials().find((m) => m.getName().endsWith("Instance"))?.getRoughnessFactor()).toBe(1);
  } else expect(report.materialAssets).toHaveLength(0);
  expect(report.materials).toBe("degraded");
  expect((await readFile(join(outputDir, report.models[0]!.glb))).length).toBeGreaterThan(0);
});

const implicit = { kind: "implicit" as const, samplerClass: "MaterialExpressionTextureSample" };
function authoredAo(options: { factor?: number; coordinates?: SourceMaterial["baseColorSamples"][number]["coordinates"]; samples?: SourceMaterial["baseColorSamples"]; sampling?: { status: "linear" | "unresolved"; reason: string } } = {}): SourceMaterial {
  return { channels: { AmbientOcclusion: { kind: "texture", path: "/Game/Kit/Packed.Packed", channel: 0, factor: options.factor ?? 1, coordinates: options.coordinates ?? implicit, sampling: options.sampling ?? { status: "linear", reason: "explicit SRGB=false and LinearColor" } } }, baseColorSamples: options.samples ?? [{ path: "/Game/Kit/Albedo.Albedo", node: "AlbedoSampler", coordinates: options.coordinates ?? implicit }], limitations: [] };
}
async function packagedSource(authored: SourceMaterial, options: { rejectAlbedo?: boolean; albedoTexCoord?: number; mat?: string; priorAo?: boolean; priorBase?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "authored-package-")); directories.push(directory);
  await writeMeshFixture(directory, { name: "Mesh", materialName: "Instance", mat: options.mat ?? "Diffuse=Albedo\nOther[0]=Packed", props: "", textures: ["Albedo", "Packed"] });
  await writePng(join(directory, "Albedo.png"), [120, 110, 100, 255]);
  if (options.rejectAlbedo) {
    const sharp = (await import("sharp")).default;
    const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 255, 255, 255, 0, 255, 255, 0, 255, 0, 255]);
    await writeFile(join(directory, "Albedo.png"), await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer());
  }
  const io = new NodeIO(); const gltfPath = join(directory, "Mesh.gltf");
  if (options.albedoTexCoord !== undefined || options.priorAo || options.priorBase) {
    const document = await io.read(gltfPath); const material = document.getRoot().listMaterials()[0]!;
    if (options.priorBase) await writePng(join(directory, "Unrelated.png"), [90, 80, 70, 255]);
    material.setBaseColorTexture(document.createTexture("PriorAlbedo").setImage(await readFile(join(directory, options.priorBase ? "Unrelated.png" : "Albedo.png"))).setMimeType("image/png"));
    if (options.albedoTexCoord !== undefined) material.getBaseColorTextureInfo()!.setTexCoord(options.albedoTexCoord);
    if (options.priorAo) { material.setOcclusionTexture(document.createTexture("PriorAO").setImage(await readFile(join(directory, "Packed.png"))).setMimeType("image/png")); material.setOcclusionStrength(0.5); }
    await io.write(gltfPath, document);
  }
  const result = await packageGlb({ gltfPath, glbPath: join(directory, "out.glb"), keepAllUvSets: false, maxTextureSize: undefined,
    assets: { gltf: new Map(), mat: new Map([["Instance", join(directory, "Instance.mat")]]), props: new Map(), png: new Map([["Albedo", join(directory, "Albedo.png")], ["Packed", join(directory, "Packed.png")], ["Packed_AO", join(directory, "Packed.png")]]), psa: new Map(), audio: new Map(), dna: new Map() }, sourceMaterial: () => authored });
  const document = await io.read(join(directory, "out.glb")); return { result, document, material: document.getRoot().listMaterials()[0]! };
}

it("refuses nonidentity AO products, unknown coordinates and ambiguous albedo source paths", async () => {
  const products = await packagedSource(authoredAo({ factor: 0.5 })); expect(products.material.getOcclusionTexture()).toBeNull();
  expect(products.result.sections[0]!.limitations.join("\n")).toContain("occlusionStrength is not equivalent");
  const unknown = await packagedSource(authoredAo({ coordinates: { kind: "unresolved", reason: "missing index" } })); expect(unknown.material.getOcclusionTexture()).toBeNull();
  const different = await packagedSource(authoredAo({ samples: [{ path: "/Game/Kit/Albedo.Albedo", node: "AlbedoSampler", coordinates: { kind: "explicit", index: 0, u: 1, v: 1 } }] })); expect(different.material.getOcclusionTexture()).toBeNull();
  const ambiguous = await packagedSource(authoredAo({ samples: [{ path: "/Game/Kit/Albedo.Albedo", node: "One", coordinates: implicit }, { path: "/Game/Other/Albedo.Albedo", node: "Two", coordinates: implicit }] })); expect(ambiguous.material.getOcclusionTexture()).toBeNull();
});

it("refuses raw AO when source color interpretation is unresolved, including old filename AO", async () => {
  const { material, result } = await packagedSource(authoredAo({ sampling: { status: "unresolved", reason: "SRGB and SamplerType omitted" } }), { mat: "Diffuse=Albedo\nOther[0]=Packed_AO" });
  expect(material.getOcclusionTexture()).toBeNull();
  expect(result.sections[0]!.limitations.join("\n")).toContain("SRGB and SamplerType omitted");
  expect(result.sections[0]!.bindings.some((b) => b.slot === "occlusion")).toBe(false);
});

it("clears incoming unsupported AO and resets prior strength for accepted identity AO", async () => {
  const refused = await packagedSource(authoredAo({ sampling: { status: "unresolved", reason: "SRGB and sampler unresolved" } }), { priorAo: true });
  expect(refused.material.getOcclusionTexture() === null).toBe(true);
  const accepted = await packagedSource(authoredAo(), { priorAo: true });
  expect(accepted.material.getOcclusionStrength()).toBe(1);
});

it("reuses the consumer albedo mapping for matching explicit source coordinates", async () => {
  const { material, document, result } = await packagedSource(authoredAo({ coordinates: { kind: "explicit", index: 1, u: 1, v: 1 } }));
  expect(material.getOcclusionTextureInfo()!.getTexCoord()).toBe(0);
  expect(document.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute("TEXCOORD_1")).toBeNull();
  expect(result.sections[0]!.limitations.join("\n")).toContain("source coordinate 1");
});

it("preserves an existing consumer UV1 when the bound albedo and AO use it", async () => {
  const { material, document } = await packagedSource(authoredAo(), { albedoTexCoord: 1 });
  expect(material.getOcclusionTextureInfo()!.getTexCoord()).toBe(1);
  expect(document.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute("TEXCOORD_1")).not.toBeNull();
});

it("refuses AO when its albedo reference is rejected and reports no exact AO binding", async () => {
  const { material, result } = await packagedSource(authoredAo(), { rejectAlbedo: true });
  expect(material.getBaseColorTexture()).toBeNull(); expect(material.getOcclusionTexture()).toBeNull();
  expect(result.sections[0]!.bindings.some((b) => b.slot === "occlusion" && b.source === "authored-source")).toBe(false);
  expect(result.sections[0]!.limitations.join("\n")).toContain("albedo reference was not bound");
});

it("refuses AO through an incoming unrelated base when the selected source albedo is rejected", async () => {
  const { material, result } = await packagedSource(authoredAo(), { rejectAlbedo: true, priorBase: true });
  expect(material.getBaseColorTexture()?.getName()).toBe("PriorAlbedo");
  expect(material.getOcclusionTexture()).toBeNull();
  expect(result.sections[0]!.bindings.some((b) => b.slot === "occlusion" && b.source === "authored-source")).toBe(false);
  expect(result.sections[0]!.unsupported.some((entry) => entry.texture === "Albedo" && entry.reason.includes("packed mask"))).toBe(true);
  expect(result.sections[0]!.limitations.join("\n")).toContain("albedo reference was not bound");
});

it("authored scalar roughness replaces a prior heuristic roughness texture contribution", async () => {
  const { material, result } = await packagedSource({ channels: { Roughness: { kind: "scalar", value: 0.4 } }, baseColorSamples: [], limitations: [] }, { mat: "Diffuse=Albedo\nSpecPower=Packed" });
  const pixels = await (await import("sharp")).default(material.getMetallicRoughnessTexture()!.getImage()!).raw().toBuffer();
  expect(pixels[1]).toBe(255); expect(pixels[2]).toBe(0);
  expect(material.getRoughnessFactor()).toBe(0.4);
  expect(result.sections[0]!.limitations.join("\n")).toContain("roughness texture contribution replaced");
});

it("reports recovered Metallic when the bounded packaging subset does not apply it", async () => {
  const { material, result } = await packagedSource({ channels: { Metallic: { kind: "scalar", value: 1 } }, baseColorSamples: [], limitations: [] });
  expect(material.getMetallicFactor()).toBe(0);
  expect(result.sections[0]!.limitations.join("\n")).toContain("Source Metallic 1");
});

it("keeps same-named source material caches in separate Content namespaces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "authored-namespaces-")); directories.push(directory);
  const sourceDir = join(directory, "source"); const fixture = join(directory, "fixture"); const outputDir = join(directory, "output");
  for (const [project, mesh, roughness] of [["One", "MeshOne", 5], ["Two", "MeshTwo", 0.2]] as const) {
    const kit = join(sourceDir, project, "Content", "Kit"); await mkdir(kit, { recursive: true });
    await writeFile(join(kit, "Master.uasset"), subsetMaster()); await writeFile(join(kit, "Instance.uasset"), subsetInstance("Instance", roughness)); await writeFile(join(kit, `${mesh}.uasset`), Buffer.alloc(16));
    await writeMeshFixture(fixture, { name: mesh, materialName: "Instance", mat: "Diffuse=Albedo", props: "", textures: ["Albedo"] });
  }
  const tool = join(directory, "umodel"); await writeFakeUmodel(tool, { exportFrom: fixture, emptyExports: ["Master", "Instance"], classes: { MeshOne: ["StaticMesh"], MeshTwo: ["StaticMesh"], Master: ["Material"], Instance: ["MaterialInstanceConstant"] } });
  const report = await importUnrealDirectory({ sourceDir, outputDir, concurrency: 1, graphBake: false, freeSpaceBytes: 30_000_000_000, umodel: { name: "umodel", path: tool, version: "fixture" } });
  expect(report.models.find((m) => m.name === "MeshOne")!.materials[0]!.factors.roughness).toBe(1);
  expect(report.models.find((m) => m.name === "MeshTwo")!.materials[0]!.factors.roughness).toBeCloseTo(0.2);
});

it.each([{ references: ["Kit"], expected: 1 }, { references: ["Winter"], expected: 0.2 }, { references: ["Kit", "Winter"], expected: 0.8 }])("routes mesh-only source materials by exact mesh imports and refuses multiple candidates (%j)", async ({ references, expected }) => {
  const directory = await mkdtemp(join(tmpdir(), "authored-mesh-references-")); directories.push(directory);
  const sourceDir = join(directory, "source"); const kit = join(sourceDir, "Content", "Kit");
  const fixture = join(directory, "fixture"); const outputDir = join(directory, "output");
  await mkdir(kit, { recursive: true }); await mkdir(join(sourceDir, "Content", "Winter"), { recursive: true });
  await writeFile(join(kit, "Master.uasset"), subsetMaster());
  await writeFile(join(kit, "Instance.uasset"), subsetInstance("Instance", 5));
  await writeFile(join(sourceDir, "Content", "Winter", "Instance.uasset"), subsetInstance("Instance", 0.2));
  const external = references.map((area) => `/Game/${area}/Instance`);
  await writeFile(join(kit, "Mesh.uasset"), materialPackage([{ name: "Mesh", className: "StaticMesh", properties: [] }], external, { externalClasses: Object.fromEntries(external.map((path) => [path, "MaterialInstanceConstant"])) }));
  await writeMeshFixture(fixture, { name: "Mesh", materialName: "Instance", mat: "Diffuse=Albedo", props: "", textures: ["Albedo"] });
  const tool = join(directory, "umodel"); await writeFakeUmodel(tool, { exportFrom: fixture, classes: { Mesh: ["StaticMesh"] } });
  const report = await importUnrealDirectory({ sourceDir, outputDir, onlyPackages: ["Mesh"], concurrency: 1, graphBake: false, freeSpaceBytes: 30_000_000_000, umodel: { name: "umodel", path: tool, version: "fixture" } });
  expect(report.models).toHaveLength(1); expect(report.materialAssets).toHaveLength(0);
  const section = report.models[0]!.materials[0]!;
  expect(section.factors.roughness).toBeCloseTo(expected);
  if (references.length > 1) expect(section.limitations.join("\n")).toContain("ambiguous mesh material import references");
  else expect(section.limitations.join("\n")).toContain(`authored Roughness ${references[0] === "Kit" ? "5" : "0.2"}`);
});
