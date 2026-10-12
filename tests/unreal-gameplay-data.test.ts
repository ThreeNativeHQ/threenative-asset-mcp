import { Document } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";

import {
  attachGameplayData,
  convertCollision,
  convertConstraintFrame,
  convertPhysics,
  convertShape,
  convertSocket,
  cueWaveLeaves,
  cueWaveObjectName,
  mergeSockets,
  parseCueSidecar,
  parseGameplaySidecar,
  resolveCueWaves,
  rotatorToUeQuaternion,
  ueQuaternionToGltf,
  ueVectorToGltf,
  wavePackageSelector,
  type RawSocket,
} from "../src/unreal/gameplay-data.js";

const close = (actual: readonly number[], expected: readonly number[], tolerance = 1e-4): void => {
  expect(actual.length).toBe(expected.length);
  for (const [index, value] of expected.entries()) expect(actual[index]!).toBeCloseTo(value, 4);
};

describe("gameplay data: Unreal to glTF basis", () => {
  it("swaps a vector to (x, z, y) and a quaternion to (x, z, y, -w), matching the converter's bone writer", () => {
    expect(ueVectorToGltf([1, 2, 3])).toEqual([1, 3, 2]);
    close(ueQuaternionToGltf([0.1, 0.2, 0.3, 0.4]), [0.1, 0.3, 0.2, -0.4]);
  });

  it("computes FRotator::Quaternion for a 90 degree yaw", () => {
    const [x, y, z, w] = rotatorToUeQuaternion([0, 90, 0]);
    close([x, y, z, w], [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
  });
});

describe("gameplay data: sockets", () => {
  it("lands a socket with a non-zero rotator and offset at the hand-computed glTF TRS", () => {
    const socket: RawSocket = {
      name: "Muzzle_R",
      bone: "hand_r",
      source: "skeleton",
      location: [100, 200, 300],
      rotation: [0, 90, 0],
      scale: [1, 1, 1],
    };
    const converted = convertSocket(socket, 0.01);
    close(converted.translation, [1, 3, 2]);
    close(converted.rotation, [0, Math.SQRT1_2, 0, -Math.SQRT1_2]);
  });

  it("gives the mesh socket precedence on a name clash", () => {
    const skeleton: RawSocket = { name: "Muzzle", bone: "b", location: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const mesh: RawSocket = { name: "Muzzle", bone: "b", location: [10, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const merged = mergeSockets([skeleton], [mesh]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe("mesh");
    expect(merged[0]!.location).toEqual([10, 0, 0]);
  });

  it("swaps a non-uniform socket scale into glTF axes without touching the geometry scale", () => {
    const socket: RawSocket = { name: "S", bone: "b", source: "mesh", location: [0, 0, 0], rotation: [0, 0, 0], scale: [2, 3, 4] };
    expect(convertSocket(socket, 0.01).scale).toEqual([2, 4, 3]);
  });

  it("lets the mesh source win a name clash through attachGameplayData, in either arrival order", () => {
    const skeleton = (location: readonly [number, number, number]): RawSocket => ({ name: "Muzzle", bone: "hand_r", source: "skeleton", location, rotation: [0, 0, 0], scale: [1, 1, 1] });
    const mesh = (location: readonly [number, number, number]): RawSocket => ({ name: "Muzzle", bone: "hand_r", source: "mesh", location, rotation: [0, 0, 0], scale: [1, 1, 1] });
    for (const skeletalSockets of [
      [mesh([100, 0, 0]), skeleton([1, 0, 0])],
      [skeleton([1, 0, 0]), mesh([100, 0, 0])],
    ]) {
      const document = new Document();
      const hand = document.createNode("hand_r");
      document.createScene().addChild(hand);
      const attached = attachGameplayData(document, { version: 1, skeletalSockets }, { meshName: "SK_Test", geometryScale: 0.01 });
      expect(attached.sockets).toEqual(["Muzzle"]);
      const node = document.getRoot().listNodes().find((candidate) => candidate.getName() === "socket:Muzzle")!;
      expect(node.getExtras().unrealSocket).toMatchObject({ name: "Muzzle", bone: "hand_r", source: "mesh" });
      close(node.getTranslation(), [1, 0, 0]);
    }
  });

  it("parents a socket node to the joint its BoneName names and reports a missing bone", () => {
    const document = new Document();
    const hand = document.createNode("hand_r");
    document.createScene().addChild(hand);
    const attached = attachGameplayData(
      document,
      {
        version: 1,
        skeletalSockets: [
          { name: "Muzzle", bone: "hand_r", source: "skeleton", location: [100, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          { name: "Ghost", bone: "missing_bone", source: "mesh", location: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        ],
      },
      { meshName: "SK_Test", geometryScale: 0.01 },
    );
    expect(attached.sockets).toEqual(["Muzzle"]);
    expect(attached.missingBones).toEqual(["missing_bone"]);
    const node = document.getRoot().listNodes().find((candidate) => candidate.getName() === "socket:Muzzle")!;
    expect(node.getParentNode()).toBe(hand);
    close(node.getTranslation(), [1, 0, 0]);
    expect(node.getExtras().unrealSocket).toEqual({ name: "Muzzle", bone: "hand_r", source: "skeleton" });
  });
});

describe("gameplay data: collision", () => {
  it("converts sphere, box, capsule and convex elements to metres", () => {
    const scale = 0.01;
    const sphere = convertShape({ type: "sphere", center: [0, 0, 0], radius: 50 }, scale);
    expect(sphere.radius).toBeCloseTo(0.5, 5);
    const box = convertShape({ type: "box", center: [0, 0, 0], rotation: [0, 0, 0], x: 100, y: 50, z: 25 }, scale);
    close(box.size!, [1, 0.25, 0.5]);
    const capsule = convertShape({ type: "capsule", center: [0, 0, 0], rotation: [0, 0, 0], radius: 20, length: 100 }, scale);
    expect(capsule.radius).toBeCloseTo(0.2, 5);
    expect(capsule.halfHeight).toBeCloseTo(0.7, 5);
    const convex = convertShape(
      { type: "convex", center: [0, 0, 0], rotation: [0, 0, 0], vertices: [[100, 0, 0], [0, 100, 0], [0, 0, 100]], indices: [0, 1, 2] },
      scale,
    );
    close(convex.vertices![0]!, [1, 0, 0]);
    close(convex.vertices![1]!, [0, 0, 1]);
    expect(convex.indices).toEqual([0, 1, 2]);
  });

  it("emits no simple shapes for CTF_UseComplexAsSimple", () => {
    const converted = convertCollision(
      { traceFlag: "CTF_UseComplexAsSimple", shapes: [{ type: "sphere", center: [0, 0, 0], radius: 50 }] },
      0.01,
    );
    expect(converted!.shapes).toEqual([]);
    expect(converted!.traceFlag).toBe("CTF_UseComplexAsSimple");
  });

  it("scales a non-uniform shape by Unreal's own rule: sphere uses the smallest absolute axis", () => {
    // Unreal's FKSphereElem::GetFinalScaled multiplies the radius by MinScaleAbs.
    const sphere = convertShape({ type: "sphere", center: [0, 0, 0], radius: 100 }, [2, 4, 3]);
    expect(sphere.radius).toBeCloseTo(200, 5);
  });

  it("scales a box by each absolute axis and never emits a negative extent", () => {
    const box = convertShape({ type: "box", center: [0, 0, 0], rotation: [0, 0, 0], x: 100, y: 100, z: 100 }, [-2, 4, 3]);
    close(box.size!, [200, 400, 300]);
  });

  it("keeps a capsule's two cross-section radius axes and its axis half-length", () => {
    // glTF x is Unreal X, glTF y is Unreal Z, glTF z is Unreal Y under the (x, z, y) basis.
    const capsule = convertShape({ type: "capsule", center: [0, 0, 0], rotation: [0, 0, 0], radius: 100, length: 200 }, [2, 4, 3]);
    expect(capsule.radius).toBeCloseTo(300, 5); // max(|X|, |Y|) = max(2, 3)
    expect(capsule.halfHeight).toBeCloseTo(((200 + 200) * 4) / 2, 5); // |Z| = 4
  });

  it("preserves both radii of a tapered capsule instead of averaging them", () => {
    const capsule = convertShape(
      { type: "capsule", center: [0, 0, 0], rotation: [0, 0, 0], radius: 80, radius0: 50, radius1: 80, length: 100 },
      0.01,
    );
    expect(capsule.radius0).toBeCloseTo(0.5, 5);
    expect(capsule.radius1).toBeCloseTo(0.8, 5);
    expect(capsule.halfHeight).toBeCloseTo(((100 + 50 + 80) * 0.01) / 2, 5);
  });

  it("applies a convex hull's local scale and names the approximation when it is combined with a rotation", () => {
    const flat = convertShape(
      { type: "convex", center: [0, 0, 0], rotation: [0, 0, 0], vertices: [[100, 0, 0]], indices: [0], scale: [2, 1, 1] },
      0.01,
    );
    close(flat.vertices![0]!, [2, 0, 0]);
    expect(flat.limitations).toBeUndefined();
    const rotated = convertShape(
      { type: "convex", center: [0, 0, 0], rotation: [0, 90, 0], vertices: [[100, 0, 0]], indices: [0], scale: [2, 1, 1] },
      0.01,
    );
    expect(rotated.limitations).toHaveLength(1);
  });
});

describe("gameplay data: physics asset", () => {
  it("rebuilds an orthogonal right-handed constraint frame", () => {
    const frame = convertConstraintFrame(
      { location: [0, 0, 0], primaryAxis: [1, 0, 0], secondaryAxis: [0.5, 0.5, 0] },
      0.01,
    );
    close(frame.primaryAxis, [1, 0, 0]);
    // The secondary axis is orthogonalized against the cross product, then swapped into glTF axes.
    close(frame.secondaryAxis, [0, 0, 1]);
  });

  it("keeps body shapes, constraint limits and collision-disabled pairs in metres", () => {
    const physics = convertPhysics(
      {
        asset: "PA_Mannequin",
        bodies: [{ bone: "hand_r", physicsType: "PhysType_Simulated", damping: { linear: 0.1 }, shapes: [{ type: "sphere", center: [100, 0, 0], radius: 10 }] }],
        constraints: [
          {
            child: "hand_r",
            parent: "lowerarm_r",
            childFrame: { location: [0, 0, 0], primaryAxis: [1, 0, 0], secondaryAxis: [0, 1, 0] },
            parentFrame: { location: [0, 0, 0], primaryAxis: [1, 0, 0], secondaryAxis: [0, 1, 0] },
            swing1Deg: 45,
            twistDeg: 15,
            disableCollision: true,
          },
        ],
        collisionDisabledPairs: [[0, 1]],
      },
      0.01,
    );
    expect(physics!.bodies[0]!.damping).toEqual({ linear: 0.1 });
    close(physics!.bodies[0]!.shapes[0]!.center, [1, 0, 0]);
    expect(physics!.constraints[0]!.swing1Deg).toBe(45);
    expect(physics!.constraints[0]!.disableCollision).toBe(true);
    expect(physics!.collisionDisabledPairs).toEqual([[0, 1]]);
  });

  it("converts a constraint's linear limit from centimetres to metres", () => {
    const physics = convertPhysics(
      {
        asset: "PA",
        bodies: [],
        constraints: [
          {
            child: "a",
            parent: "b",
            childFrame: { location: [0, 0, 0], primaryAxis: [1, 0, 0], secondaryAxis: [0, 1, 0] },
            parentFrame: { location: [0, 0, 0], primaryAxis: [1, 0, 0], secondaryAxis: [0, 1, 0] },
            linearLimit: 50,
          },
        ],
        collisionDisabledPairs: [],
      },
      0.01,
    );
    expect(physics!.constraints[0]!.linearLimit).toBeCloseTo(0.5, 6);
  });

  it("carries decoded drives through, converting only the linear targets to metres", () => {
    const physics = convertPhysics(
      {
        asset: "PA",
        bodies: [],
        constraints: [
          {
            child: "a",
            parent: "b",
            childFrame: { location: [0, 0, 0], primaryAxis: [1, 0, 0], secondaryAxis: [0, 1, 0] },
            parentFrame: { location: [0, 0, 0], primaryAxis: [1, 0, 0], secondaryAxis: [0, 1, 0] },
            drives: {
              linear: { positionTarget: [100, 0, 0], x: { stiffness: 12, damping: 1, maxForce: 3, positionDrive: true } },
              angular: { swing: { stiffness: 5, velocityDrive: true }, mode: "TwistAndSwing" },
            },
          },
        ],
        collisionDisabledPairs: [],
      },
      0.01,
    );
    const drives = physics!.constraints[0]!.drives!;
    close(drives.linear!.positionTarget!, [1, 0, 0]);
    expect(drives.linear!.x).toMatchObject({ stiffness: 12, maxForce: 3, positionDrive: true });
    expect(drives.angular!.mode).toBe("TwistAndSwing");
  });

  it("converts asymmetric linear targets and the angular orientation and velocity targets", () => {
    const physics = convertPhysics(
      {
        asset: "PA",
        bodies: [],
        constraints: [
          {
            child: "a",
            parent: "b",
            childFrame: { location: [0, 0, 0], primaryAxis: [1, 0, 0], secondaryAxis: [0, 1, 0] },
            parentFrame: { location: [0, 0, 0], primaryAxis: [1, 0, 0], secondaryAxis: [0, 1, 0] },
            drives: {
              linear: { positionTarget: [100, 200, 300], velocityTarget: [10, 20, 30] },
              angular: { orientationTarget: [0, 90, 0], angularVelocityTarget: [7, 8, 9], mode: "SLERP" },
            },
          },
        ],
        collisionDisabledPairs: [],
      },
      0.01,
    );
    const drives = physics!.constraints[0]!.drives!;
    // A length target becomes metres and glTF axes: [x, z, y] then times 0.01.
    close(drives.linear!.positionTarget!, [1, 3, 2]);
    close(drives.linear!.velocityTarget!, [0.1, 0.3, 0.2]);
    // The orientation target is an FRotator, converted exactly like a bone rotation (90 degree yaw).
    close(drives.angular!.orientationTarget!, [0, Math.SQRT1_2, 0, -Math.SQRT1_2]);
    // The angular velocity target is a rate in revolutions per second: the basis swaps, the magnitude does not.
    close(drives.angular!.angularVelocityTarget!, [7, 9, 8]);
    expect(drives.angular!.mode).toBe("SLERP");
  });

  it("reports missing body and constraint sub-exports instead of dropping them silently", () => {
    const physics = convertPhysics({ asset: "PA", bodies: [], constraints: [], collisionDisabledPairs: [], missingBodies: 2, missingConstraints: 1 }, 0.01);
    expect(physics!.missingBodies).toBe(2);
    expect(physics!.missingConstraints).toBe(1);
  });

  it("reports a physics-asset bone the mesh does not name", () => {
    const document = new Document();
    const mesh = document.createNode("SK_Test");
    mesh.setMesh(document.createMesh("M"));
    document.createScene().addChild(mesh);
    const hand = document.createNode("hand_r");
    mesh.addChild(hand);
    const attached = attachGameplayData(document, { version: 1 }, {
      meshName: "SK_Test",
      geometryScale: 0.01,
      physics: {
        asset: "PA_Test",
        physics: {
          asset: "PA_Test",
          bodies: [
            { bone: "hand_r", shapes: [] },
            { bone: "cloth_bone", shapes: [] },
          ],
          constraints: [],
          collisionDisabledPairs: [],
        },
      },
    });
    expect(attached.physicsMissingBones).toEqual(["cloth_bone"]);
    expect(attached.physicsAsset).toBe("PA_Test");
    expect(mesh.getExtras().unrealPhysicsAsset).toBe("PA_Test");
  });
});

describe("gameplay data: parsing", () => {
  it("refuses a sidecar with an unsupported version or a non-finite socket", () => {
    expect(() => parseGameplaySidecar(JSON.stringify({ version: 2 }))).toThrow(/unsupported version/);
    expect(() =>
      parseGameplaySidecar(
        JSON.stringify({
          version: 1,
          skeletalSockets: [{ name: "S", bone: "b", location: [0, 0, Number.NaN], rotation: [0, 0, 0], scale: [1, 1, 1] }],
        }),
      ),
    ).toThrow(/three finite numbers/);
  });
});

describe("gameplay data: SoundCue", () => {
  it("reads the wave object name from a soft asset path", () => {
    expect(cueWaveObjectName("/Game/Audio/SW_Footstep.SW_Footstep")).toBe("SW_Footstep");
    expect(cueWaveObjectName("/Game/Audio/SW_Footstep")).toBe("SW_Footstep");
    expect(cueWaveObjectName(undefined)).toBeUndefined();
  });

  it("walks the cue graph for every wave leaf", () => {
    const cue = parseCueSidecar(
      JSON.stringify({
        name: "SC_Footstep",
        volume: 0.75,
        pitch: 1,
        root: {
          type: "USoundNodeRandom",
          children: [
            { type: "USoundNodeWavePlayer", params: { wave: "/Game/Audio/SW_A.SW_A" } },
            { type: "USoundNodeWavePlayer", params: { wave: "/Game/Audio/SW_B.SW_B" } },
          ],
        },
      }),
    );
    expect(cueWaveLeaves(cue)).toEqual(["SW_A", "SW_B"]);
  });

  it("rewrites a wave leaf to its exported audio file and reports one no export matched", () => {
    const cue = parseCueSidecar(
      JSON.stringify({
        name: "SC_Footstep",
        root: {
          type: "USoundNodeRandom",
          children: [
            { type: "USoundNodeWavePlayer", params: { wave: "/Game/Audio/SW_A.SW_A" } },
            { type: "USoundNodeWavePlayer", params: { wave: "/Game/Audio/SW_Missing.SW_Missing" } },
          ],
        },
      }),
    );
    const { cue: resolved, missing } = resolveCueWaves(cue, new Map([["SW_A", "audio/Content/SW_A.wav"]]));
    expect(missing).toEqual(["SW_Missing"]);
    const children = resolved.root!.children!;
    expect(children[0]!.params).toMatchObject({ wave: "/Game/Audio/SW_A.SW_A", waveExport: "audio/Content/SW_A.wav" });
    expect(children[1]!.params).not.toHaveProperty("waveExport");
  });

  it("normalizes a wave soft path and an imported package to one full selector", () => {
    expect(wavePackageSelector("/Game/Audio/SW_Footstep.SW_Footstep")).toBe("audio/sw_footstep");
    expect(wavePackageSelector("Content/Audio/SW_Footstep.uasset")).toBe("audio/sw_footstep");
    expect(wavePackageSelector("/Game/Audio/SW_Footstep")).toBe("audio/sw_footstep");
    expect(wavePackageSelector(undefined)).toBeUndefined();
  });

  it("resolves a wave by its full selector before a bare name, so a same-named wave never binds the wrong file", () => {
    const cue = parseCueSidecar(
      JSON.stringify({
        name: "SC_Foot",
        root: {
          type: "USoundNodeRandom",
          children: [
            { type: "USoundNodeWavePlayer", params: { wave: "/Game/Audio/A/SW_Hit.SW_Hit" } },
            { type: "USoundNodeWavePlayer", params: { wave: "/Game/Audio/B/SW_Hit.SW_Hit" } },
          ],
        },
      }),
    );
    const index = new Map([
      ["audio/a/sw_hit", "audio/Content/Audio/A/SW_Hit.wav"],
      ["audio/b/sw_hit", "audio/Content/Audio/B/SW_Hit.wav"],
    ]);
    const { cue: resolved, missing } = resolveCueWaves(cue, index);
    expect(missing).toEqual([]);
    const children = resolved.root!.children!;
    expect(children[0]!.params!.waveExport).toBe("audio/Content/Audio/A/SW_Hit.wav");
    expect(children[1]!.params!.waveExport).toBe("audio/Content/Audio/B/SW_Hit.wav");
  });

  it("reports an ambiguous bare wave name instead of guessing at one of two same-named waves", () => {
    const cue = parseCueSidecar(
      JSON.stringify({
        name: "SC_Foot",
        root: { type: "USoundNodeWavePlayer", params: { wave: "/Game/Audio/Unknown/SW_Hit.SW_Hit" } },
      }),
    );
    // Only a bare fallback is available, and it is ambiguous: report it, never bind either file.
    const { cue: resolved, missing } = resolveCueWaves(
      cue,
      new Map([["sw_hit", "audio/Content/Audio/A/SW_Hit.wav"]]),
      new Set(["sw_hit"]),
    );
    expect(missing).toEqual(["SW_Hit"]);
    expect(resolved.root!.params).not.toHaveProperty("waveExport");
  });
});
