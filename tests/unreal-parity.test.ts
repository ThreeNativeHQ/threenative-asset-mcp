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
  it("does not expect meshes inside World Partition external actor packages, and counts them", () => {
    const dump = dumpOf(
      pkg("/Game/C/SM_Pillar", mesh("SM_Pillar", "/Game/C/MI_Cave_Rock_Pillar.MI_Cave_Rock_Pillar")),
      pkg("/Game/C/MI_Cave_Rock_Pillar", pillarInstance),
      pkg("/Game/C/M_Cave_Rock_MASTER", master),
      pkg("/Game/__ExternalActors__/Pack/0/23/abc123", mesh("SM_Actor", "/Game/C/MI_Cave_Rock_Pillar.MI_Cave_Rock_Pillar")),
      pkg("/Game/__ExternalObjects__/Pack/1/45/def456", mesh("SM_Object", "/Game/C/MI_Cave_Rock_Pillar.MI_Cave_Rock_Pillar")),
    );
    const score = scorePack(
      dump,
      reportOf([model(MESH_PKG, [section("MI_Cave_Rock_Pillar", ["T_Cave_Rock_Pillar_M", "T_Cave_Rock_Pillar_N"])])]),
    );
    expect(score.coverage.expected).toBe(1);
    expect(score.coverage.missingTotal).toBe(0);
    expect(score.coverage.externalActorPackages).toBe(2);
    expect(score.reasons).toEqual([]);
    expect(score.status).toBe("pass");
  });

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

  it("does not call a baked graph texture foreign (it is derived, not one of the pack's textures)", () => {
    const fromGraph = (s: ImportedMaterialSection): ImportedMaterialSection => ({
      ...s,
      bindings: s.bindings.map((b, i) => (i === 0 ? { ...b, source: "graph" } : b)),
    });
    const baked = fromGraph(section("MI_Cave_Rock_Pillar", ["MI_Cave_Rock_Pillar_graph_baseColor", "T_Cave_Rock_Pillar_N"]));
    const ok = scorePack(caveDump(), reportOf([model(MESH_PKG, [baked])]));
    expect(ok.identity.violationsTotal).toBe(0);
    // A pack texture that really is foreign is still caught next to a graph binding.
    const mixed = fromGraph(section("MI_Cave_Rock_Pillar", ["MI_Cave_Rock_Pillar_graph_baseColor", "T_Other_D"]));
    const bad = scorePack(caveDump(), reportOf([model(MESH_PKG, [mixed])]));
    expect(bad.identity.violations.map((v) => v.texture)).toEqual(["t_other_d"]);
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

  it("tolerates authored bounds that lag the geometry by up to 10 % and counts the drift", () => {
    const secs = [section("MI_Cave_Rock_Pillar", ["T_Cave_Rock_Pillar_M", "T_Cave_Rock_Pillar_N"])];
    // expected (2, 1, 4); the geometry is 5 % bigger on the long axis, a Soul Cave-style stale bound
    const drifted = scorePack(caveDump(), reportOf([model(MESH_PKG, secs, [2, 1, 4.2])]));
    expect(drifted.shape.violations).toEqual([]);
    expect(drifted.shape.boundsDrift).toBe(1);
    const exact = scorePack(caveDump(), reportOf([model(MESH_PKG, secs, [2, 1, 4])]));
    expect(exact.shape.boundsDrift).toBe(0);
    // a 2.54x unit error is still a violation
    const unit = scorePack(caveDump(), reportOf([model(MESH_PKG, secs, [2, 1, 4 * 2.54])]));
    expect(unit.shape.violations[0]?.kind).toBe("bounds-size");
  });

  it("accepts both valid glTF axis conventions but still flags a swapped up axis", () => {
    // extent [100,200,50] cm -> UE size (2,4,1) m. UE Viewer: (x,z,y) = (2,1,4); converters: (y,z,x) = (4,1,2).
    const secs = [section("MI_Cave_Rock_Pillar", ["T_Cave_Rock_Pillar_M", "T_Cave_Rock_Pillar_N"])];
    const viewer = scorePack(caveDump(), reportOf([model(MESH_PKG, secs, [2, 1, 4])]));
    const converter = scorePack(caveDump(), reportOf([model(MESH_PKG, secs, [4, 1, 2])]));
    expect(viewer.shape.violations).toEqual([]);
    expect(converter.shape.violations).toEqual([]);
    // UE Z on glTF Z instead of Y (a Z-up export) is a real error under both conventions
    const zUp = scorePack(caveDump(), reportOf([model(MESH_PKG, secs, [2, 4, 1])]));
    expect(zUp.shape.violations[0]?.kind).toBe("bounds-axis");
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

  describe("graph outcomes (PRD-538)", () => {
    const grey = (name: string, graph?: ImportedMaterialSection["graph"]): ImportedMaterialSection =>
      section(name, ["T_Cave_Rock_Pillar_N"], {
        textured: false,
        factors: { baseColor: [0.8, 0.8, 0.8, 1], emissive: [0, 0, 0], metallic: 0, roughness: 1 },
        ...(graph ? { graph } : {}),
      });
    const unsupported = (...nodes: string[]): ImportedMaterialSection["graph"] => ({
      status: "unsupported",
      unsupportedNodes: nodes,
      approximations: [],
    });

    it("counts sections naming each node class, not occurrences", () => {
      // One section names Divide twice and Power once; another names Divide; a third is baked.
      const sections = [
        grey("MI_Cave_Rock_Pillar", unsupported("Divide", "Divide", "Power")),
        grey("MI_Cave_Rock_Pillar", unsupported("Divide")),
        grey("MI_Cave_Rock_Pillar", { status: "baked", confidence: "exact", unsupportedNodes: [], approximations: [] }),
      ];
      const score = scorePack(caveDump(), reportOf([model(MESH_PKG, sections)]));
      expect(score.colour.unsupportedNodes).toEqual({ Divide: 2, Power: 1 });
      expect(score.colour.graphBaked).toBe(1);
      expect(score.colour.graphUnsupported).toBe(2);
      expect(score.colour.graphUnavailable).toBe(0);
    });

    it("normalises unavailable reasons so names do not split the count", () => {
      const sections = [
        grey("MI_Cave_Rock_Pillar", { status: "unavailable", unsupportedNodes: [], approximations: [], reason: "texture T_Rock_M could not be loaded" }),
        grey("MI_Cave_Rock_Pillar", { status: "unavailable", unsupportedNodes: [], approximations: [], reason: "texture T_Other_M could not be loaded" }),
        grey("MI_Cave_Rock_Pillar", { status: "unavailable", unsupportedNodes: [], approximations: [], reason: "no dumped graph for MI_X or its parents" }),
        grey("MI_Cave_Rock_Pillar", { status: "unavailable", unsupportedNodes: [], approximations: [], reason: "no dumped graph for MI_Y or its parents" }),
        grey("MI_Cave_Rock_Pillar", { status: "unavailable", unsupportedNodes: [], approximations: [] }),
      ];
      const score = scorePack(caveDump(), reportOf([model(MESH_PKG, sections)]));
      expect(score.colour.unavailableReasons).toEqual({
        "texture could not be loaded": 2,
        "no dumped graph": 2,
        "no reason given": 1,
      });
      expect(score.colour.graphUnavailable).toBe(5);
    });

    it("attributes each S4 miss to its graph outcome", () => {
      const sections = [
        grey("MI_Cave_Rock_Pillar", unsupported("Divide")),
        grey("MI_Cave_Rock_Pillar", { status: "unavailable", unsupportedNodes: [], approximations: [], reason: "no dumped graph for X or its parents" }),
        grey("MI_Cave_Rock_Pillar"),
        grey("MI_Cave_Rock_Pillar", { status: "baked", unsupportedNodes: [], approximations: [] }), // baked, still grey
        section("MI_Cave_Rock_Pillar", ["T_Cave_Rock_Pillar_N"], {
          factors: { baseColor: [0.2, 0.4, 0.1, 1], emissive: [0, 0, 0], metallic: 0, roughness: 1 },
          textured: false,
          graph: { status: "baked", confidence: "exact", unsupportedNodes: [], approximations: [] },
        }),
      ];
      const score = scorePack(caveDump(), reportOf([model(MESH_PKG, sections)]));
      expect(score.colour.misses.map((m) => m.graphStatus)).toEqual(["unsupported", "unavailable", "none", "baked"]);
      expect(score.colour.misses[0]).toMatchObject({ unsupportedNodes: ["Divide"] });
      expect(score.colour.missAttribution).toEqual({
        bakedAway: 1,
        bakedStillGrey: 1,
        unsupportedNode: 1,
        unavailable: 1,
        noGraph: 1,
      });
      expect(score.colour.missesTotal).toBe(4);
    });

    it("scores an older report with no graph field without crashing", () => {
      const score = scorePack(caveDump(), reportOf([model(MESH_PKG, [grey("MI_Cave_Rock_Pillar")])]));
      expect(score.colour.graphBaked).toBe(0);
      expect(score.colour.unsupportedNodes).toEqual({});
      expect(score.colour.unavailableReasons).toEqual({});
      expect(score.colour.misses[0]?.graphStatus).toBe("none");
      expect(score.colour.missAttribution.noGraph).toBe(1);
    });
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
