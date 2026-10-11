import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  applyThumbnailReferenceLighting,
  assertThumbnailSourceRadiance,
  prepareThumbnailSourceEnvironment,
  type ThumbnailSourceRadiance,
} from "../src/unreal/thumbnail-lighting.js";

describe("UE 4.19.2 thumbnail reference lighting", () => {
  it("lights from the source world directions independently of camera, object position and scale", () => {
    const scene = new THREE.Scene();
    const rig = applyThumbnailReferenceLighting(THREE, scene, { shadows: true });
    // Independently verified shader L=-component forward, then UModel's (X,Z,Y) conversion.
    const expected = [
      [-0.437510125, 0.82178619, -0.365037462],
      [0.625027649, 0.64278761, 0.442904648],
      [0.400033738, 0.872623898, -0.280179481],
    ];
    const camera = new THREE.PerspectiveCamera();
    scene.add(camera);
    for (const [center, radius] of [[new THREE.Vector3(), 1], [new THREE.Vector3(10, -3, 7), 0.01]] as const) {
      camera.position.set(-15, 2, 9); camera.lookAt(center);
      rig.place(center, radius);
      scene.updateMatrixWorld(true);
      rig.lights.forEach((light, i) => {
        const towardLight = light.getWorldPosition(new THREE.Vector3()).sub(light.target.getWorldPosition(new THREE.Vector3())).normalize();
        expected[i]!.forEach((component, axis) => expect(towardLight.getComponent(axis)).toBeCloseTo(component, 7));
      });
    }
    expect(rig.lights.map((light) => light.intensity)).toEqual([0.2, 5, 1]);
    expect(rig.lights.every((light) => light.color.equals(new THREE.Color(0xffffff)))).toBe(true);
    expect(rig.lights.map((light) => light.castShadow)).toEqual([false, true, false]);
    expect(rig.primary).toBe(rig.lights[1]);
    expect(rig.limitations.join(" ")).toMatch(/hemisphere.*cubemap/i);
  });

  it("uses a supplied decoded environment without inventing a sky colour or changing the texture", () => {
    const scene = new THREE.Scene();
    const environment = new THREE.DataTexture(new Float32Array([2.18, 0.13, 0.16, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    const rig = applyThumbnailReferenceLighting(THREE, scene, { environment, shadows: false });
    expect(scene.environment).toBe(environment);
    expect(scene.children.some((child) => child instanceof THREE.HemisphereLight)).toBe(false);
    expect(rig.lights.every((light) => !light.castShadow)).toBe(true);
    expect(environment.image.data![0]).toBeCloseTo(2.18);
    expect(rig.limitations.join(" ")).toMatch(/environment.*unverified/i);
  });

  it("preserves source HDR radiance and orients the explicit source longlat against independently verified directions", () => {
    const source = { reference: "/Engine/MapTemplates/Sky/DaylightAmbientCubemap", engine: "5.8", bytesSha256: "a".repeat(64), layout: "ue-source-longlat-rgb-f32" as const, radianceDecode: "ue4.19-rgbe" as const };
    const prepared = prepareThumbnailSourceEnvironment(THREE, { width: 1, height: 1, rgb: new Float32Array([2.1875, 0.13331, 0.15842]), source });
    const scene = new THREE.Scene();
    const rig = applyThumbnailReferenceLighting(THREE, scene, { sourceEnvironment: prepared });
    expect(scene.environment).toBe(prepared.texture);
    expect(scene.environmentIntensity).toBe(1.69);
    expect(prepared.texture.image.data![0]).toBe(2.1875);
    expect(prepared.texture.image.data![3]).toBe(1);
    expect(prepared.texture.type).toBe(THREE.FloatType);
    expect(prepared.texture.colorSpace).toBe(THREE.LinearSRGBColorSpace);
    expect(prepared.texture.mapping).toBe(THREE.EquirectangularReflectionMapping);
    expect(prepared.texture.flipY).toBe(true);
    // Three sends the inverse environment rotation to the irradiance/reflection shader.
    const inverse = new THREE.Matrix4().makeRotationFromEuler(scene.environmentRotation).invert();
    for (const [direction, want] of [
      [[1, 0, 0], [0.75, 0.5]], [[-1, 0, 0], [0.25, 0.5]],
      [[0, 0, 1], [1, 0.5]], [[0, 0, -1], [0.5, 0.5]],
      [[0, 1, 0], [0.5, 0]], [[0, -1, 0], [0.5, 1]],
      [[0.3, 0.4, 0.5], [0.9139895651886847, 0.30861165562248066]],
      [[-0.2, 0.7, -0.3], [0.40641647909450057, 0.1514001870826343]],
    ] as const) {
      const q = new THREE.Vector3(...direction).normalize().applyMatrix4(inverse);
      const u = 0.5 + Math.atan2(q.z, q.x) / (2 * Math.PI);
      const topRowV = 1 - (0.5 + Math.asin(q.y) / Math.PI);
      // Longitude is undefined at the two poles; latitude still has to select the correct source row.
      if (Math.abs(direction[1]) !== 1) expect(u).toBeCloseTo(want[0], 12);
      expect(topRowV).toBeCloseTo(want[1], 12);
    }
    expect(scene.children.some((child) => child instanceof THREE.HemisphereLight)).toBe(false);
    expect(rig.limitations.join(" ")).toMatch(/5.8.*4.19.2/);
    expect(rig.limitations.join(" ")).toMatch(/1.69.*unproved/);
    prepared.texture.dispose();
  });

  it("refuses nonfinite source radiance before creating a GPU texture", () => {
    expect(() => prepareThumbnailSourceEnvironment(THREE, {
      width: 1, height: 1, rgb: new Float32Array([Number.NaN, 0, 0]),
      source: { reference: "/Engine/Test", engine: "5.8", bytesSha256: "b".repeat(64), layout: "ue-source-longlat-rgb-f32", radianceDecode: "ue4.19-rgbe" },
    })).toThrow(/radiance must be finite/);
  });

  it("refuses a radiance array that is not exactly width*height*3 floats before creating a GPU texture", () => {
    expect(() => prepareThumbnailSourceEnvironment(THREE, {
      width: 2, height: 1, rgb: new Float32Array(5),
      source: { reference: "/Engine/Test", engine: "5.8", bytesSha256: "b".repeat(64), layout: "ue-source-longlat-rgb-f32", radianceDecode: "ue4.19-rgbe" },
    })).toThrow(/exactly width\*height\*3/);
  });
});

describe("UE source radiance validation", () => {
  const PROVENANCE = {
    reference: "/Engine/Test",
    engine: "5.8",
    bytesSha256: "b".repeat(64),
    layout: "ue-source-longlat-rgb-f32" as const,
    radianceDecode: "ue4.19-rgbe" as const,
  };
  const malformed: [string, Record<string, unknown>][] = [
    ["a non-string reference", { reference: ["/Engine/Test"] }],
    ["a non-string engine", { engine: 5 }],
    ["a SHA-256 array that stringifies to a digest", { bytesSha256: ["b".repeat(64)] }],
  ];

  // A Float64Array or Uint8Array can match the byte count of width*height*3 float32 values and still hold other numbers.
  it.each([
    ["a Float64Array of three values (24 bytes)", () => new Float64Array([2, 3, 4])],
    ["a Uint8Array of 24 bytes", () => new Uint8Array(24)],
  ])("refuses %s before it is read as radiance", (_label, makeRgb) => {
    const input = { width: 2, height: 1, rgb: makeRgb(), source: PROVENANCE } as unknown as ThumbnailSourceRadiance;
    expect(() => assertThumbnailSourceRadiance(input)).toThrow(/must be a Float32Array/);
    expect(() => prepareThumbnailSourceEnvironment(THREE, input)).toThrow(/must be a Float32Array/);
  });

  it("accepts a Float32Array of exactly width*height*3 values and keeps them in order", () => {
    const input: ThumbnailSourceRadiance = { width: 2, height: 1, rgb: new Float32Array([1, 2, 3, 4, 5, 6]), source: PROVENANCE };
    expect(() => assertThumbnailSourceRadiance(input)).not.toThrow();
    const prepared = prepareThumbnailSourceEnvironment(THREE, input);
    expect(Array.from(prepared.texture.image.data!)).toEqual([1, 2, 3, 1, 4, 5, 6, 1]);
    prepared.texture.dispose();
  });

  it.each(malformed)("refuses malformed provenance: %s", (_label, override) => {
    const source = { ...PROVENANCE, ...override };
    const input = { width: 1, height: 1, rgb: new Float32Array([0.5, 0.5, 0.5]), source } as unknown as ThumbnailSourceRadiance;
    expect(() => assertThumbnailSourceRadiance(input)).toThrow(/explicit UE source longlat layout/);
  });

  it("keeps only the declared provenance fields on the prepared source", () => {
    const source = { ...PROVENANCE, extraRadiance: new Float32Array([12, 13, 14]) };
    const prepared = prepareThumbnailSourceEnvironment(THREE, { width: 1, height: 1, rgb: new Float32Array([1, 2, 3]), source });
    expect(prepared.source).toEqual(PROVENANCE);
    prepared.texture.dispose();
  });
});
