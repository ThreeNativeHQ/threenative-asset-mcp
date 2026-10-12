import { describe, expect, it } from "vitest";

import {
  BLEND_AXIS_DEFAULTS,
  animationArtifactPackage,
  animationArtifactPath,
  blendAxes,
  buildAnimationLogic,
  canonicalAnimationPath,
  normalizeClipSidecar,
  parseAnimationDescriptor,
  parseAnimationReference,
  resolveClip,
  sectionStart,
  type RawAnimationAsset,
} from "../src/unreal/animation-data.js";

const clips = [
  { name: "M_Walk", package: "/Game/Anim/M_Walk" },
  { name: "M_Run", package: "/Game/Anim/M_Run" },
];

describe("blend-space axis defaults (AC-3)", () => {
  it("restores Min 0, Max 100 and GridNum 4 on all three axes when the typed array omits them", () => {
    const axes = blendAxes([{ displayName: "Speed" }]);
    expect(axes).toHaveLength(3);
    for (const axis of axes) {
      expect(axis.min).toBe(BLEND_AXIS_DEFAULTS.min);
      expect(axis.max).toBe(BLEND_AXIS_DEFAULTS.max);
      expect(axis.gridNum).toBe(BLEND_AXIS_DEFAULTS.gridNum);
    }
    expect(axes[0]!.name).toBe("Speed");
  });

  it("restores the defaults from a fully absent fixed array, as a flattened Properties read cannot", () => {
    const axes = blendAxes(undefined);
    expect(axes.map((axis) => [axis.min, axis.max, axis.gridNum])).toEqual([
      [0, 100, 4],
      [0, 100, 4],
      [0, 100, 4],
    ]);
  });

  it("keeps the typed values of an axis that stores them", () => {
    const axes = blendAxes([{ displayName: "Yaw", min: -90, max: 90, gridNum: 2, snapToGrid: true, wrapInput: true }]);
    expect(axes[0]).toEqual({ name: "Yaw", min: -90, max: 90, gridNum: 2, wrap: true, snap: true });
    expect(axes[1]).toEqual({ name: "", min: 0, max: 100, gridNum: 4, wrap: false, snap: false });
  });
});

describe("montage section starts per LinkMethod (AC-5)", () => {
  it("resolves Absolute, Relative and Proportional against the segment", () => {
    expect(sectionStart({ linkMethod: "Absolute", linkValue: 1.25 })).toBeCloseTo(1.25);
    expect(sectionStart({ linkMethod: "Relative", segmentBeginTime: 2, linkValue: 0.5 })).toBeCloseTo(2.5);
    expect(sectionStart({ linkMethod: "Proportional", segmentBeginTime: 2, segmentLength: 4, linkValue: 0.25 })).toBeCloseTo(3);
  });

  it("treats an unnamed method as Absolute, as Unreal's FAnimLinkableElement does", () => {
    expect(sectionStart({ linkValue: 3 })).toBeCloseTo(3);
  });

  it("carries the resolved starts and clip names into the montage descriptor", () => {
    const raw: RawAnimationAsset = {
      kind: "montage",
      name: "M_Combo",
      package: "/Game/Anim/M_Combo",
      skeleton: "SK_Hero",
      length: 4,
      rateScale: 1,
      slots: [{ name: "UpperBody", segments: [{ animation: "M_Walk", startPos: 1, clipStart: 0, clipEnd: 1, playRate: 2, loopCount: 1 }] }],
      sections: [
        { name: "Start", next: "Loop", linkMethod: "Absolute", linkValue: 0 },
        { name: "Loop", next: "End", linkMethod: "Relative", segmentBeginTime: 1, linkValue: 0.5 },
      ],
    };
    const result = buildAnimationLogic([raw], clips, ["SK_Hero"]);
    expect(result.unresolved).toEqual([]);
    const montage = result.assets[0]!.value;
    if (montage.kind !== "montage") throw new Error("expected a montage");
    expect(montage.sections).toEqual([
      { name: "Start", start: 0, next: "Loop" },
      { name: "Loop", start: 1.5, next: "End" },
    ]);
    expect(montage.slots[0]!.segments[0]).toMatchObject({ clip: "M_Walk", startPos: 1, playRate: 2 });
  });
});

describe("clip resolution and reporting (AC-4, AC-5)", () => {
  it("reports a clip with no exported animation instead of dropping it", () => {
    expect(resolveClip("M_Missing", clips)).toMatchObject({ clip: "M_Missing", unresolved: expect.stringMatching(/no exported animation/) });
  });

  it("reports a clip whose name two packages both export as ambiguous", () => {
    const ambiguous = [...clips, { name: "M_Walk", package: "/Game/Other/M_Walk" }];
    expect(resolveClip("m_walk", ambiguous)).toMatchObject({ unresolved: expect.stringMatching(/ambiguous/) });
  });

  it("resolves case-insensitively to the exported animation name", () => {
    expect(resolveClip("m_run", clips)).toEqual({ clip: "M_Run" });
  });

  it("lists every unresolved sample clip and keeps the descriptor", () => {
    const raw: RawAnimationAsset = {
      kind: "blendSpace",
      blendSpaceType: "1D",
      name: "BS_Locomotion",
      package: "/Game/Anim/BS_Locomotion",
      skeleton: "SK_Hero",
      axes: [{ displayName: "Speed", min: 0, max: 600, gridNum: 6 }],
      samples: [{ animation: "M_Walk", sampleValue: [150, 0, 0] }, { animation: "M_Ghost", sampleValue: [600, 0, 0] }],
    };
    const result = buildAnimationLogic([raw], clips, ["SK_Hero"]);
    expect(result.unresolved).toEqual([
      { package: "/Game/Anim/BS_Locomotion", asset: "BS_Locomotion", kind: "blendSpace", clip: "M_Ghost", reason: "no exported animation has this name" },
    ]);
    const space = result.assets[0]!.value;
    if (space.kind !== "blendSpace") throw new Error("expected a blend space");
    expect(space.samples.map((sample) => sample.clip)).toEqual(["M_Walk", "M_Ghost"]);
    expect(space.samples[1]!.unresolved).toMatch(/no exported animation/);
  });
});

describe("skeleton reporting", () => {
  it("reports a logic asset whose skeleton was not imported", () => {
    const raw: RawAnimationAsset = { kind: "montage", name: "M_X", package: "/Game/Anim/M_X", skeleton: "SK_Absent", slots: [], sections: [] };
    const result = buildAnimationLogic([raw], clips, ["SK_Hero"]);
    expect(result.unresolved).toContainEqual({ package: "/Game/Anim/M_X", asset: "M_X", kind: "montage", clip: "SK_Absent", reason: "the skeleton was not imported" });
    expect(result.assets[0]!.skeleton).toBeUndefined();
  });

  it("reports a skeleton two imported meshes both use as ambiguous", () => {
    const raw: RawAnimationAsset = { kind: "blendSpace", name: "BS_X", package: "/Game/Anim/BS_X", skeleton: "SK_Hero", samples: [] };
    const result = buildAnimationLogic([raw], clips, ["SK_Hero", "sk_hero"]);
    expect(result.unresolved[0]!.reason).toMatch(/ambiguous/);
  });
});

describe("unsupported and clip sidecars", () => {
  it("keeps an unsupported clip's metadata as a sidecar and reports the disposition", () => {
    const raw: RawAnimationAsset = {
      kind: "clip",
      name: "M_58",
      package: "/Game/Anim/M_58",
      skeleton: "SK_Hero",
      unsupportedReason: "bone tracks live in an AnimationDataModel export the pinned reader does not map",
      notifies: [{ name: "Footstep", time: 0.5, className: "AnimNotify_Footstep" }],
      syncMarkers: [{ name: "Sync_0", time: 0.25 }],
    };
    const result = buildAnimationLogic([raw], clips, ["SK_Hero"]);
    expect(result.assets).toEqual([]);
    expect(result.unsupported).toEqual([{ package: "/Game/Anim/M_58", asset: "M_58", reason: "bone tracks live in an AnimationDataModel export the pinned reader does not map" }]);
    expect(result.sidecars).toHaveLength(1);
    expect(result.sidecars[0]!.value.notifies).toHaveLength(1);
    expect(result.sidecars[0]!.value.syncMarkers).toEqual([{ name: "Sync_0", time: 0.25 }]);
    expect(result.sidecars[0]!.value.unsupportedReason).toMatch(/AnimationDataModel/);
  });

  it("reads notifies and float curves from a sidecar with every key preserved", () => {
    const sidecar = normalizeClipSidecar({
      kind: "clip",
      name: "M_Walk",
      notifies: [{ name: "Footstep_L", time: 0.2, duration: 0, track: 1, kind: "queued", className: "AnimNotify_Footstep" }],
      curves: [{ name: "contact_l", keys: [{ time: 0, value: 1, arrive: 0, leave: 0, interp: "Constant" }, { time: 0.5, value: 0, arrive: 0, leave: 0, interp: "Constant" }] }],
      syncMarkers: [{ name: "Sync_0", time: 0.25 }],
    });
    expect(sidecar.notifies[0]).toMatchObject({ name: "Footstep_L", track: 1, class: "AnimNotify_Footstep" });
    expect(sidecar.curves[0]!.keys).toHaveLength(2);
    expect(sidecar.curves[0]!.name).toBe("contact_l");
    expect(sidecar.syncMarkers).toEqual([{ name: "Sync_0", time: 0.25 }]);
  });
});

describe("blend-space sample flags (AC-3, AC-4)", () => {
  it("keeps a sample's mirror flag and defaults loop to Unreal's true", () => {
    const raw: RawAnimationAsset = {
      kind: "blendSpace",
      blendSpaceType: "2D",
      name: "BS_Walk",
      package: "/Game/Anim/BS_Walk",
      skeleton: "SK_Hero",
      mirrorDataTable: "MDT_Hero",
      samples: [{ animation: "M_Walk", sampleValue: [0, 0, 0], mirror: true }],
    };
    const space = buildAnimationLogic([raw], clips, ["SK_Hero"]).assets[0]!.value;
    if (space.kind !== "blendSpace") throw new Error("expected a blend space");
    expect(space.samples[0]!.mirror).toBe(true);
    expect(space.loop).toBe(true);
    const { mirrorDataTable: _table, ...withoutTable } = raw;
    expect(buildAnimationLogic([withoutTable], clips, ["SK_Hero"]).unresolved.map((issue) => issue.reason)).toContain(
      "a mirrored sample needs a MirrorDataTable the import does not carry",
    );
  });

  it("reports an additive space with no base pose but not an aim offset", () => {
    const additive: RawAnimationAsset = { kind: "blendSpace", blendSpaceType: "2D", additive: true, name: "BS_Add", package: "/Game/Anim/BS_Add", samples: [] };
    const consequence = buildAnimationLogic([additive], clips, undefined).unresolved.map((issue) => issue.reason);
    expect(consequence).toContain("an additive blend space names no base pose the import can apply");
    const aim: RawAnimationAsset = { kind: "blendSpace", blendSpaceType: "aimOffset", additive: true, name: "AO_Hero", package: "/Game/Anim/AO_Hero", samples: [] };
    expect(buildAnimationLogic([aim], clips, undefined).unresolved).toEqual([]);
  });
});

describe("animation descriptor trust boundary", () => {
  it("accepts the adapter envelope and returns the descriptor", () => {
    const parsed = parseAnimationDescriptor({
      format: "threenative-unreal-animation",
      version: 1,
      kind: "blendSpace",
      name: "BS_Locomotion",
      package: "/Game/Anim/BS_Locomotion",
    });
    expect(parsed.reason).toBeUndefined();
    expect(parsed.descriptor?.name).toBe("BS_Locomotion");
  });

  it("rejects valid JSON of the wrong shape with a precise reason", () => {
    // A converter that writes `{}` or a document with an unrecognised kind must be reported for its
    // package, never pushed into buildAnimationLogic where an unknown kind is silently dropped.
    expect(parseAnimationDescriptor({}).reason).toBe('format is not "threenative-unreal-animation"');
    expect(parseAnimationDescriptor({ format: "threenative-unreal-animation", version: 2 }).reason).toBe("version is not 1");
    expect(parseAnimationDescriptor({ format: "threenative-unreal-animation", version: 1, kind: "unknown" }).reason).toBe(
      "kind is not one of blendSpace, montage, composite, clip",
    );
    const noName = parseAnimationDescriptor({ format: "threenative-unreal-animation", version: 1, kind: "clip", package: "/Game/Anim/X" });
    expect(noName.reason).toBe("name is missing or empty");
    const noPackage = parseAnimationDescriptor({ format: "threenative-unreal-animation", version: 1, kind: "clip", name: "X" });
    expect(noPackage.reason).toBe("package is missing or empty");
    expect(parseAnimationDescriptor([]).reason).toBe("the document is not a JSON object");
  });
});

describe("canonical animation identity (AC-4, AC-5)", () => {
  it("normalizes a mounted path and splits a canonical object path", () => {
    expect(canonicalAnimationPath("D:/proj/Content/A/Walk.uasset")).toBe("/Game/A/Walk");
    expect(parseAnimationReference("/Game/A/Walk.Walk")).toEqual({ name: "Walk", package: "/Game/A/Walk", canonical: true });
    // A package-only reference takes its object name from the last segment.
    expect(parseAnimationReference("/Game/A/Walk")).toEqual({ name: "Walk", package: "/Game/A/Walk", canonical: true });
    // A bare legacy name carries no package and is never treated as canonical.
    expect(parseAnimationReference("M_Walk.Walk")).toEqual({ name: "M_Walk.Walk", canonical: false });
  });

  it("resolves a canonical reference to the exact package, even when two packages share a basename", () => {
    const duplicate = [
      { name: "Walk", package: "/Game/A/Walk", object: "Walk" },
      { name: "B_Walk", package: "/Game/B/Walk", object: "Walk" },
    ];
    expect(resolveClip("/Game/B/Walk.Walk", duplicate)).toEqual({ clip: "B_Walk" });
    expect(resolveClip("/Game/A/Walk.Walk", duplicate)).toEqual({ clip: "Walk" });
  });

  it("does not fall back to a same-basename clip on an explicit canonical mismatch", () => {
    const one = [{ name: "Walk", package: "/Game/A/Walk", object: "Walk" }];
    expect(resolveClip("/Game/B/Walk.Walk", one)).toMatchObject({
      clip: "Walk",
      unresolved: expect.stringMatching(/no exported animation matches/),
    });
  });

  it("resolves a bare reference only when it is unique", () => {
    const unique = [{ name: "Walk", package: "/Game/A/Walk", object: "Walk" }];
    expect(resolveClip("Walk", unique)).toEqual({ clip: "Walk" });
    const duplicated = [...unique, { name: "B_Walk", package: "/Game/B/Walk", object: "Walk" }];
    expect(resolveClip("Walk", duplicated)).toMatchObject({ unresolved: expect.stringMatching(/ambiguous across 2 packages/) });
  });

  it("resolves a canonical reference whose glTF name was disambiguated to the source object", () => {
    const duplicate = [
      { name: "Wave", package: "/Game/A/Walk", object: "Wave" },
      { name: "B_Walk_Wave", package: "/Game/B/Walk", object: "Wave" },
    ];
    expect(resolveClip("/Game/B/Walk.Wave", duplicate)).toEqual({ clip: "B_Walk_Wave" });
  });

  it("writes package-distinct artifact paths and reads the package back, refusing traversal", () => {
    expect(animationArtifactPath("/Game/A/Walk", "Walk", ".psa")).toBe("Animation/A/Walk/Walk.psa");
    expect(animationArtifactPath("/Game/B/Walk", "Walk", ".psa")).toBe("Animation/B/Walk/Walk.psa");
    expect(animationArtifactPath("/Game/../../etc", "x", ".json")).toBe("Animation/etc/x.json");
    expect(animationArtifactPackage("A/Walk/Walk.psa")).toBe("/Game/A/Walk");
    expect(animationArtifactPackage("BS_Locomotion.json")).toBeUndefined();
  });
});
