import { describe, expect, it } from "vitest";
import type { ImportedMaterialSection, ImportedModel, ImportReport } from "../src/unreal/importer.js";
import { objectName, packageKey, scorePack } from "../src/unreal/parity.js";
import { failureClasses } from "../src/unreal/parity-run.js";
import type { PropertyDump } from "../src/unreal/property-dump.js";

type Exp = NonNullable<PropertyDump["packages"][number]["exports"]>[number];

const pkg = (path: string, ...exports: Exp[]): PropertyDump["packages"][number] => ({ path, exports });
const dumpOf = (...packages: PropertyDump["packages"]): PropertyDump => ({ format: 1, game: "GAME_UE4_18", packages });

const mesh = (name: string, material: string, extent: [number, number, number] | null = [100, 200, 50]): Exp => ({
  name,
  class: "StaticMesh",
  slots: [{ name: "Slot0", material }],
  bounds: extent ? { origin: [0, 0, 0], boxExtent: extent, sphereRadius: 1, property: "ExtendedBounds" } : null,
});

function section(name: string, textures: string[], over: Partial<ImportedMaterialSection> = {}): ImportedMaterialSection {
  return {
    name,
    resolved: true,
    bindings: textures.map((texture, i) => ({
      slot: i === 0 ? "baseColor" : "normal",
      texture,
      source: "test",
      confidence: "high",
      transform: {} as never,
    })),
    unsupported: [],
    alphaMode: "OPAQUE",
    limitations: [],
    doubleSided: false,
    factors: { baseColor: [1, 1, 1, 1], emissive: [0, 0, 0], metallic: 0, roughness: 1 },
    textured: textures.length > 0,
    sidecarTextures: [],
    ...over,
  };
}

function model(pkgPath: string, sections: ImportedMaterialSection[], bounds: [number, number, number] = [2, 1, 4]): ImportedModel {
  return {
    name: pkgPath.split("/").pop()!.replace(".uasset", ""),
    package: pkgPath,
    kind: "static",
    glb: "x.glb",
    bytes: 1,
    sha256: "x",
    vertices: 1,
    primitives: sections.length,
    skins: 0,
    joints: 0,
    morphTargets: 0,
    animations: 0,
    boundsMetres: bounds,
    materials: sections,
  };
}

const reportOf = (
  models: ImportedModel[],
  extra: { failed?: { package: string; reason: string }[]; skipped?: { package: string; reason: string }[] } = {},
): ImportReport => ({ models, failed: extra.failed ?? [], skipped: extra.skipped ?? [] }) as unknown as ImportReport;

// Soul Cave: the instance overrides two parameters of its master.
const master: Exp = {
  name: "M_Cave_Rock_MASTER",
  class: "Material",
  textureParameters: [
    { name: "Mask", texture: "/Game/C/T_Cave_Rock_Stalactite_M.T_Cave_Rock_Stalactite_M" },
    { name: "MainNormal", texture: "/Game/C/T_Cave_Rock_Large_N.T_Cave_Rock_Large_N" },
  ],
  textures: ["/Game/C/T_Cave_Rock_Stalactite_M.T_Cave_Rock_Stalactite_M", "/Game/C/T_Cave_Rock_Large_N.T_Cave_Rock_Large_N"],
  vectorParameters: [{ name: "Tint", value: [0.5, 0.4, 0.3, 1] }],
  constantColors: 0,
};
const pillarInstance: Exp = {
  name: "MI_Cave_Rock_Pillar",
  class: "MaterialInstanceConstant",
  parent: "/Game/C/M_Cave_Rock_MASTER.M_Cave_Rock_MASTER",
  textureParameters: [
    { name: "Mask", texture: "/Game/C/T_Cave_Rock_Pillar_M.T_Cave_Rock_Pillar_M" },
    { name: "MainNormal", texture: "/Game/C/T_Cave_Rock_Pillar_N.T_Cave_Rock_Pillar_N" },
  ],
};
const MESH_PKG = "Content/C/SM_Pillar.uasset";
const caveDump = (): PropertyDump =>
  dumpOf(
    pkg("/Game/C/SM_Pillar", mesh("SM_Pillar", "/Game/C/MI_Cave_Rock_Pillar.MI_Cave_Rock_Pillar")),
    pkg("/Game/C/MI_Cave_Rock_Pillar", pillarInstance),
    pkg("/Game/C/M_Cave_Rock_MASTER", master),
  );

describe("parity key normalisation", () => {
  it("handles Content/, /Game/ and other mount styles", () => {
    expect(packageKey("Content/SoulCave/Meshes/SM_A.uasset")).toBe("soulcave/meshes/sm_a");
    expect(packageKey("/Game/SoulCave/Meshes/SM_A")).toBe("soulcave/meshes/sm_a");
    expect(packageKey("Pack/Content/SoulCave/Meshes/SM_A")).toBe("soulcave/meshes/sm_a");
    expect(packageKey("/Pack/SoulCave/Meshes/SM_A")).toBe("soulcave/meshes/sm_a");
    expect(objectName("/Game/A/MI_X.MI_X")).toBe("mi_x");
    expect(objectName("T_Cave_Pillar_N")).toBe("t_cave_pillar_n");
  });
});

describe("scorePack", () => {
  it("passes a perfect pack", () => {
    const score = scorePack(
      caveDump(),
      reportOf([model(MESH_PKG, [section("MI_Cave_Rock_Pillar", ["T_Cave_Rock_Pillar_M", "T_Cave_Rock_Pillar_N"])])]),
    );
    expect(score.reasons).toEqual([]);
    expect(score.status).toBe("pass");
    expect(score.identity.verified).toBe(1);
  });

  it("flags parent-default leakage (the Soul Cave bug) and passes the overrides", () => {
    const leaky = scorePack(
      caveDump(),
      reportOf([model(MESH_PKG, [section("MI_Cave_Rock_Pillar", ["T_Cave_Rock_Stalactite_M", "T_Cave_Rock_Large_N"])])]),
    );
    expect(leaky.identity.violations.map((v) => v.kind)).toEqual(["overridden-parent-default", "overridden-parent-default"]);
    expect(leaky.status).toBe("fail");
    const fixed = scorePack(
      caveDump(),
      reportOf([model(MESH_PKG, [section("MI_Cave_Rock_Pillar", ["T_Cave_Rock_Pillar_M", "T_Cave_Rock_Pillar_N"])])]),
    );
    expect(fixed.identity.violationsTotal).toBe(0);
  });

  it("marks a texture that belongs to no parameter as foreign", () => {
    const score = scorePack(
      caveDump(),
      reportOf([model(MESH_PKG, [section("MI_Cave_Rock_Pillar", ["T_Other_D"])])]),
    );
    expect(score.identity.violations[0]?.kind).toBe("foreign");
  });

  it("fails coverage with the report's reason when a mesh is missing", () => {
    const score = scorePack(
      caveDump(),
      reportOf([], { failed: [{ package: MESH_PKG, reason: "UE Viewer could not decode the mesh" }] }),
    );
    expect(score.coverage.ok).toBe(false);
    expect(score.coverage.missing).toEqual([{ package: "c/sm_pillar", reason: "UE Viewer could not decode the mesh" }]);
    expect(score.status).toBe("fail");
  });

  it("detects swapped bounds axes and wrong sizes", () => {
    // extent [100,200,50] cm -> UE size (2,4,1) m -> glTF (x,y-up,z) = (2,1,4)
    const secs = [section("MI_Cave_Rock_Pillar", ["T_Cave_Rock_Pillar_M", "T_Cave_Rock_Pillar_N"])];
    const swapped = scorePack(caveDump(), reportOf([model(MESH_PKG, secs, [2, 4, 1])]));
    expect(swapped.shape.violations[0]?.kind).toBe("bounds-axis");
    const wrong = scorePack(caveDump(), reportOf([model(MESH_PKG, secs, [20, 1, 4])]));
    expect(wrong.shape.violations[0]?.kind).toBe("bounds-size");
  });

  it("flags more sections than slots and tolerates unverified bounds", () => {
    const d = dumpOf(
      pkg("/Game/C/SM_Pillar", mesh("SM_Pillar", "/Game/C/MI_Cave_Rock_Pillar.MI_Cave_Rock_Pillar", null)),
      pkg("/Game/C/MI_Cave_Rock_Pillar", pillarInstance),
      pkg("/Game/C/M_Cave_Rock_MASTER", master),
    );
    const two = [
      section("MI_Cave_Rock_Pillar", ["T_Cave_Rock_Pillar_M"]),
      section("MI_Other", ["T_Cave_Rock_Pillar_M"]),
    ];
    const score = scorePack(d, reportOf([model(MESH_PKG, two)]));
    expect(score.shape.violations.map((v) => v.kind)).toEqual(["slot-count"]);
    expect(score.shape.boundsUnverified).toBe(1);
  });

  it("counts a grey section on a mask x tint material against colour", () => {
    const grey = section("MI_Cave_Rock_Pillar", ["T_Cave_Rock_Pillar_N"], {
      textured: false,
      factors: { baseColor: [0.8, 0.8, 0.8, 1], emissive: [0, 0, 0], metallic: 0, roughness: 1 },
    });
    const score = scorePack(caveDump(), reportOf([model(MESH_PKG, [grey])]));
    expect(score.colour.expectsColour).toBe(1);
    expect(score.colour.coloured).toBe(0);
    expect(score.colour.misses).toHaveLength(1);
    expect(score.status).toBe("fail");
  });

  it("does not expect colour from a normal-only material", () => {
    const d = dumpOf(
      pkg("/Game/C/SM_Pillar", mesh("SM_Pillar", "/Game/C/M_N.M_N")),
      pkg("/Game/C/M_N", { name: "M_N", class: "Material", textures: ["/Game/C/T_Rock_N.T_Rock_N"], constantColors: 0 }),
    );
    const s = section("M_N", ["T_Rock_N"], { textured: false });
    expect(scorePack(d, reportOf([model(MESH_PKG, [s])])).colour.expectsColour).toBe(0);
  });

  it("treats a parent outside the dump as unverified, not a violation", () => {
    const d = dumpOf(
      pkg("/Game/C/SM_Pillar", mesh("SM_Pillar", "/Game/C/MI_Cave_Rock_Pillar.MI_Cave_Rock_Pillar")),
      pkg("/Game/C/MI_Cave_Rock_Pillar", pillarInstance),
    );
    const score = scorePack(
      d,
      reportOf([model(MESH_PKG, [section("MI_Cave_Rock_Pillar", ["T_Anything"])])]),
    );
    expect(score.identity.unverified).toBe(1);
    expect(score.identity.violationsTotal).toBe(0);
    expect(score.status).toBe("unverified");
  });

  it("is unverified when the dump has no meshes", () => {
    expect(scorePack(dumpOf(pkg("/Game/C/M", master)), reportOf([])).status).toBe("unverified");
  });
});

describe("unreadable meshes", () => {
  const goodSections = [section("MI_Cave_Rock_Pillar", ["T_Cave_Rock_Pillar_M", "T_Cave_Rock_Pillar_N"])];
  const dumpWith = (...meshPackages: PropertyDump["packages"]): PropertyDump =>
    dumpOf(
      ...meshPackages,
      pkg("/Game/C/MI_Cave_Rock_Pillar", pillarInstance),
      pkg("/Game/C/M_Cave_Rock_MASTER", master),
    );
  const MAT = "/Game/C/MI_Cave_Rock_Pillar.MI_Cave_Rock_Pillar";
  const GOOD_PKG = "Content/C/SM_Good.uasset";

  it("treats a mesh export that carries an error as unverified, not a slot-count violation", () => {
    const broken: Exp = { name: "SM_Pillar", class: "StaticMesh", error: "could not read", slots: [] };
    const score = scorePack(dumpWith(pkg("/Game/C/SM_Pillar", broken)), reportOf([model(MESH_PKG, goodSections)]));
    expect(score.shape.violationsTotal).toBe(0);
    expect(score.shape.unverifiedModels).toBe(1);
    expect(score.identity.unverified).toBe(1);
    expect(score.status).toBe("unverified");
    expect(score.reasons.join(" ")).toMatch(/unreadable/);
  });

  it("treats a mesh with an empty slot list as unreadable", () => {
    const empty: Exp = { name: "SM_Pillar", class: "StaticMesh", slots: [], bounds: null };
    const score = scorePack(dumpWith(pkg("/Game/C/SM_Pillar", empty)), reportOf([model(MESH_PKG, goodSections)]));
    expect(score.shape.violations).toEqual([]);
    expect(score.shape.unverifiedModels).toBe(1);
    expect(score.status).toBe("unverified");
  });

  it("treats a mesh in a package that failed to load as unreadable", () => {
    const m = mesh("SM_Pillar", MAT);
    const withPackageError = scorePack(
      dumpWith({ path: "/Game/C/SM_Pillar", error: "bad magic", exports: [m] }),
      reportOf([model(MESH_PKG, goodSections)]),
    );
    expect(withPackageError.shape.unverifiedModels).toBe(1);
    expect(withPackageError.shape.violationsTotal).toBe(0);
    expect(withPackageError.status).toBe("unverified");

    // The package failed to load, so it has no exports at all, yet the report exported a model.
    const noExports = scorePack(
      dumpWith({ path: "/Game/C/SM_Pillar", error: "bad magic" }, pkg("/Game/C/SM_Good", mesh("SM_Good", MAT))),
      reportOf([model(GOOD_PKG, goodSections), model(MESH_PKG, goodSections)]),
    );
    expect(noExports.shape.unverifiedModels).toBe(1);
    expect(noExports.shape.checked).toBe(1);
    expect(noExports.status).toBe("unverified");
  });

  it("never passes a pack with one unreadable mesh, but a verified failure still wins", () => {
    const broken: Exp = { name: "SM_Bad", class: "StaticMesh", error: "x" };
    const dump = dumpWith(pkg("/Game/C/SM_Good", mesh("SM_Good", MAT)), pkg("/Game/C/SM_Bad", broken));
    const good = model(GOOD_PKG, goodSections);
    const bad = model("Content/C/SM_Bad.uasset", goodSections);
    const mixed = scorePack(dump, reportOf([good, bad]));
    expect(mixed.status).toBe("unverified");
    expect(mixed.reasons.join(" ")).toMatch(/unreadable/);

    const wrongBounds = model(GOOD_PKG, goodSections, [20, 1, 4]);
    const failing = scorePack(dump, reportOf([wrongBounds, bad]));
    expect(failing.status).toBe("fail");
    expect(failing.reasons.join(" ")).toMatch(/unreadable/);
  });

  it("counts failure classes from the uncapped totals", () => {
    const packages: PropertyDump["packages"] = [];
    const models: ImportedModel[] = [];
    const secs = [section("MI_Cave_Rock_Pillar", ["T_Cave_Rock_Pillar_M", "T_Cave_Rock_Pillar_N"])];
    for (let i = 0; i < 55; i++) {
      packages.push(pkg(`/Game/C/SM_${i}`, mesh(`SM_${i}`, "/Game/C/MI_Cave_Rock_Pillar.MI_Cave_Rock_Pillar")));
      models.push(model(`Content/C/SM_${i}.uasset`, secs, [2, 4, 1]));
    }
    const score = scorePack(dumpWith(...packages), reportOf(models));
    expect(score.shape.violationsTotal).toBe(55);
    expect(score.shape.violations).toHaveLength(50);
    expect(failureClasses(score).filter((c) => c === "S2:bounds-axis")).toHaveLength(55);
  });

  it("classifies an unreadable-mesh pack", () => {
    const broken: Exp = { name: "SM_Pillar", class: "StaticMesh", error: "x" };
    const score = scorePack(dumpWith(pkg("/Game/C/SM_Pillar", broken)), reportOf([model(MESH_PKG, goodSections)]));
    expect(failureClasses(score)).toEqual(["unverified:unreadable-mesh"]);
  });
});
