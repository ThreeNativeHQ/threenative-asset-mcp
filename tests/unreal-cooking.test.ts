import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readPackageCooking } from "../src/unreal/cooking.js";

const PACKAGE_MAGIC = 0x9e2a83c1;

/** A package head shaped like the real thing: the magic, a plausible version block, then the names
 * the detector looks for stored as length-prefixed ASCII the way Unreal's name table stores them. */
function packageHead(names: readonly string[], magic = PACKAGE_MAGIC): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(magic, 0);
  header.writeInt32LE(-7, 4); // LegacyFileVersion
  header.writeInt32LE(864, 8); // LegacyUE3Version
  header.writeInt32LE(522, 12); // FileVersionUE4 — 522 is UE 4.26
  header.writeInt32LE(0, 16); // FileVersionLicenseeUE4
  header.writeInt32LE(names.length, 20);
  const table = names.map((name) => {
    const bytes = Buffer.from(`${name}\0`, "latin1");
    const length = Buffer.alloc(4);
    length.writeInt32LE(bytes.length, 0);
    return Buffer.concat([length, bytes]);
  });
  return Buffer.concat([header, ...table]);
}

describe("readPackageCooking", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "tn-cooking-"));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function write(name: string, contents: Buffer): Promise<string> {
    const file = join(directory, name);
    await writeFile(file, contents);
    return file;
  }

  it("reports uncooked when a package carries editor-only names", async () => {
    const file = await write(
      "SM_Table.uasset",
      packageHead(["/Script/Engine", "/Script/UnrealEd", "AssetImportData", "StaticMesh", "SourceModels"]),
    );
    const cooking = await readPackageCooking(file);
    expect(cooking.state).toBe("uncooked");
    expect(cooking.markers).toContain("/Script/UnrealEd");
    expect(cooking.markers).toContain("SourceModels");
    expect(cooking.meshKindHint).toBe("static");
  });

  it("recognizes a modern editor SkeletalMesh only with corroborating editor data", async () => {
    const head = packageHead(["AssetImportData", "SkeletalMesh", "SkeletalMeshEditorData", "MeshEditorDataObject"]);
    head.writeInt32LE(-8, 4);
    const file = await write("SK_UE5.uasset", head);
    await expect(readPackageCooking(file)).resolves.toMatchObject({
      state: "uncooked",
      legacyFileVersion: -8,
      fileVersionUE4: 522,
      meshKindHint: "skeletal",
    });
  });

  it("recognizes a UE5.5 editor SkeletalMesh saved with skeletal source models", async () => {
    // The MetaHuman sample's Ada_FaceMesh (UE 5.5): no SkeletalMeshEditorData, no Default__SkeletalMesh.
    const head = packageHead(["AssetImportData", "SkeletalMesh", "SkeletalMeshSourceModel", "SkeletalMeshDescriptionBulkData"]);
    head.writeInt32LE(-8, 4);
    const file = await write("Ada_FaceMesh.uasset", head);
    await expect(readPackageCooking(file)).resolves.toMatchObject({ legacyFileVersion: -8, meshKindHint: "skeletal" });
  });

  it("recognizes a cooked modern StaticMesh only with its default class object", async () => {
    const head = packageHead(["StaticMesh", "Default__StaticMesh"]);
    head.writeInt32LE(-8, 4);
    const file = await write("SM_UE55_Cooked.uasset", head);
    await expect(readPackageCooking(file)).resolves.toMatchObject({
      state: "unknown",
      legacyFileVersion: -8,
      meshKindHint: "static",
    });
  });

  it("recognizes a modern editor Texture2D only with editor import data", async () => {
    const head = packageHead(["AssetImportData", "Texture2D"]);
    head.writeInt32LE(-8, 4);
    const file = await write("T_UE5.uasset", head);
    await expect(readPackageCooking(file)).resolves.toMatchObject({
      state: "uncooked",
      legacyFileVersion: -8,
      textureHint: true,
    });
  });

  it("does not infer a Texture2D from a modern class-name fragment without editor evidence", async () => {
    const head = packageHead(["Texture2D"]);
    head.writeInt32LE(-8, 4);
    const file = await write("M_TextureReference.uasset", head);
    await expect(readPackageCooking(file)).resolves.toMatchObject({ textureHint: false });
  });

  it("recognizes a modern editor TextureCube only with editor import data", async () => {
    const head = packageHead(["AssetImportData", "TextureCube"]);
    head.writeInt32LE(-8, 4);
    const file = await write("C_UE5.uasset", head);
    await expect(readPackageCooking(file)).resolves.toMatchObject({
      state: "uncooked",
      legacyFileVersion: -8,
      cubemapHint: true,
    });
  });

  it("does not infer a TextureCube from a class-name fragment without editor evidence", async () => {
    const head = packageHead(["TextureCube"]);
    head.writeInt32LE(-8, 4);
    const file = await write("M_CubemapReference.uasset", head);
    await expect(readPackageCooking(file)).resolves.toMatchObject({ cubemapHint: false });
  });

  it("recognizes modern multidimensional textures only from their default class objects", async () => {
    for (const className of ["Texture2DArray", "TextureCubeArray", "VolumeTexture"]) {
      const head = packageHead([className, `Default__${className}`]);
      head.writeInt32LE(-8, 4);
      const file = await write(`${className}.uasset`, head);
      await expect(readPackageCooking(file)).resolves.toMatchObject({ textureStackClassHint: className });
    }
  });

  it("does not infer a multidimensional texture from a class-name reference alone", async () => {
    const head = packageHead(["VolumeTexture"]);
    head.writeInt32LE(-8, 4);
    const file = await write("M_VolumeReference.uasset", head);
    await expect(readPackageCooking(file)).resolves.toMatchObject({ textureStackClassHint: undefined });
  });

  it("recognizes a versionless composite Font package from FontBulkData evidence", async () => {
    const head = packageHead(["Font", "FontBulkData", "CompositeFont"]);
    head.writeInt32LE(-7, 4);
    head.writeInt32LE(0, 12);
    const file = await write("Roboto.uasset", head);
    await expect(readPackageCooking(file)).resolves.toMatchObject({ fontHint: true });
  });

  it("does not infer a Font from a UI package that only references one", async () => {
    const head = packageHead(["Font", "FontObject"]);
    const file = await write("WBP_Label.uasset", head);
    await expect(readPackageCooking(file)).resolves.toMatchObject({ fontHint: false });
  });

  it("recognizes a modern editor SoundWave only with editor import data", async () => {
    const head = packageHead(["AssetImportData", "SoundWave"]);
    head.writeInt32LE(-8, 4);
    const file = await write("A_UE5.uasset", head);
    await expect(readPackageCooking(file)).resolves.toMatchObject({
      state: "uncooked",
      legacyFileVersion: -8,
      soundHint: true,
    });
  });

  it("does not infer a SoundWave from a class-name fragment without editor evidence", async () => {
    const head = packageHead(["SoundWave"]);
    head.writeInt32LE(-8, 4);
    const file = await write("BP_AudioReference.uasset", head);
    await expect(readPackageCooking(file)).resolves.toMatchObject({ soundHint: false });
  });

  it("recognizes a modern DataTable only from its default class object", async () => {
    const head = packageHead(["DataTable", "Default__DataTable"]);
    head.writeInt32LE(-8, 4);
    const file = await write("DT_Items.uasset", head);
    await expect(readPackageCooking(file)).resolves.toMatchObject({ dataClassHint: "DataTable" });
  });

  it("does not infer structured data from a class-name reference alone", async () => {
    const head = packageHead(["DataTable"]);
    head.writeInt32LE(-8, 4);
    const file = await write("BP_DataReference.uasset", head);
    await expect(readPackageCooking(file)).resolves.toMatchObject({ dataClassHint: undefined });
  });

  it("recognizes a serialized Blueprint prefab only with generated-class and SCS evidence", async () => {
    const head = packageHead(["BlueprintGeneratedClass", "SimpleConstructionScript", "SCS_Node"]);
    head.writeInt32LE(-9, 4);
    const file = await write("BP_Character.uasset", head);
    await expect(readPackageCooking(file)).resolves.toMatchObject({ blueprintPrefabHint: true });

    const referenceOnly = await write("DA_BlueprintReference.uasset", packageHead(["BlueprintGeneratedClass"]));
    await expect(readPackageCooking(referenceOnly)).resolves.toMatchObject({ blueprintPrefabHint: false });
  });

  it("does not infer a cooked modern mesh from a class-name fragment alone", async () => {
    const head = packageHead(["StaticMesh"]);
    head.writeInt32LE(-8, 4);
    const file = await write("M_StaticMeshReference.uasset", head);
    await expect(readPackageCooking(file)).resolves.toMatchObject({ meshKindHint: undefined });
  });

  it("does not infer a skeletal package from a class-name fragment alone", async () => {
    const file = await write("M_Reference.uasset", packageHead(["AssetImportData", "SkeletalMesh"]));
    await expect(readPackageCooking(file)).resolves.toMatchObject({
      state: "uncooked",
      meshKindHint: undefined,
    });
  });

  it("reports no UE5 object version on a UE4 header, where that offset holds something else", async () => {
    const head = packageHead(["StaticMesh", "Default__StaticMesh"]);
    head.writeInt32LE(518, 4); // LegacyFileVersion 518 is UE 4.26
    head.writeInt32LE(1008, 16); // FileVersionLicenseeUE4, which the diagnostic must not quote
    const file = await write("SM_UE426.uasset", head);
    await expect(readPackageCooking(file)).resolves.toMatchObject({
      legacyFileVersion: 518,
      fileVersionUE4: 522,
      fileVersionUE5: undefined,
    });
  });

  it("stays unknown for a package with no editor-only names, never claiming cooked", async () => {
    const file = await write(
      "SM_Cooked.uasset",
      packageHead(["/Script/Engine", "/Script/CoreUObject", "StaticMesh"]),
    );
    const cooking = await readPackageCooking(file);
    expect(cooking.state).toBe("unknown");
    expect(cooking.markers).toEqual([]);
  });

  it("stays unknown for a file that is not an Unreal package", async () => {
    const file = await write("notes.txt", Buffer.from("SourceModels AssetImportData", "latin1"));
    // The marker words are present, so only the magic check can keep this honest.
    await expect(readPackageCooking(file)).resolves.toMatchObject({ state: "unknown" });
  });

  it("stays unknown for a truncated file and for one that does not exist", async () => {
    const file = await write("short.uasset", Buffer.from([0x9e, 0x2a]));
    await expect(readPackageCooking(file)).resolves.toMatchObject({ state: "unknown" });
    await expect(readPackageCooking(join(directory, "absent.uasset"))).resolves.toMatchObject({
      state: "unknown",
    });
  });

  it("finds markers past the header, where a real name table sits", async () => {
    const padding = Buffer.alloc(64 * 1024, 0x41);
    const file = await write(
      "SM_Padded.uasset",
      Buffer.concat([packageHead(["/Script/Engine"]), padding, packageHead(["AssetImportData"]).subarray(24)]),
    );
    await expect(readPackageCooking(file)).resolves.toMatchObject({ state: "uncooked" });
  });
});
