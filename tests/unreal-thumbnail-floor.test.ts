import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createThumbnailReferenceFloor, thumbnailFloorInputs, thumbnailFloorSurface } from "../src/unreal/thumbnail-floor.js";

describe("UE 4.19.2 source thumbnail floor", () => {
  it("uses absolute world metres as UE centimetres, independently of object bounds", () => {
    expect(thumbnailFloorInputs(2.56, -2.56, 5.12)).toEqual({ coarse: [1, -1], fine: [10, -10], fade: 1 });
    expect(thumbnailFloorInputs(0.256, 0.512, 7.68)).toEqual({ coarse: [0.1, 0.2], fine: [1, 2], fade: 0.5 });
    expect(thumbnailFloorInputs(0, 0, 10.24).fade).toBe(0);
    expect(thumbnailFloorInputs(0, 0, -1).fade).toBe(1);
  });

  it("evaluates source linear reflectance and coarse-only roughness, including the second half lerp", () => {
    for (const [g, h, fade, q] of [[0, 0, 1, 0.25], [1, 1, 1, 0.875], [0, 1, 0.5, 0.3125], [1, 1, 0, 0.75]]) {
      const result = thumbnailFloorSurface(g!, h!, fade!);
      expect(result.baseColor).toBeCloseTo(0.20000000298023224 * (0.33000001311302185 + (0.6054844260215759 - 0.33000001311302185) * q!), 12);
      expect(result.roughness).toBeCloseTo(0.4000000059604645 + (0.800000011920929 - 0.4000000059604645) * g!, 12);
    }
  });

  it("retains Standard lighting and shadows while installing the source formula on world coordinates", () => {
    const floor = createThumbnailReferenceFloor(THREE);
    expect(floor.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(floor.material.metalness).toBe(0);
    const shader = { uniforms: {}, vertexShader: "#include <common>\n#include <begin_vertex>", fragmentShader: "#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <lights_fragment_begin>\n#include <shadowmap_pars_fragment>" };
    floor.material.onBeforeCompile(shader as never, {} as never);
    expect(shader.vertexShader).toContain("modelMatrix * vec4(transformed, 1.0)");
    expect(shader.fragmentShader).toContain("cameraPosition.y * 100.0");
    expect(shader.fragmentShader).toContain("#include <lights_fragment_begin>");
    expect(shader.fragmentShader).toContain("#include <shadowmap_pars_fragment>");
    expect(floor.limitations.join(" ")).toMatch(/procedural.*Grid.*approximation/i);
    floor.dispose();
  });

  it("marks a caller supplied Grid as sRGB and retains explicit source provenance without copying it", () => {
    const texture = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    const source = { reference: "/Engine/EngineMaterials/Grid.Grid", engine: "4.19.2", bytesSha256: "a".repeat(64) };
    const floor = createThumbnailReferenceFloor(THREE, { texture, source });
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.wrapT).toBe(THREE.RepeatWrapping);
    expect(floor.source).toEqual(source);
    expect(floor.limitations.join(" ")).toMatch(/filter.*approximation/i);
    expect(floor.limitations.join(" ")).not.toMatch(/procedural/);
    floor.dispose();
    texture.dispose();
  });

  it("keeps only the three provenance fields of a supplied Grid, so an extra array never reaches the floor's record", () => {
    const texture = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    const source = { reference: "/Engine/EngineMaterials/Grid.Grid", engine: "4.19.2", bytesSha256: "a".repeat(64), extraRgba: new Uint8Array(4) };
    const floor = createThumbnailReferenceFloor(THREE, { texture, source });
    expect(floor.source).toEqual({ reference: "/Engine/EngineMaterials/Grid.Grid", engine: "4.19.2", bytesSha256: "a".repeat(64) });
    expect(floor.material.userData.thumbnailFloor.source).toEqual(floor.source);
    floor.dispose();
    texture.dispose();
  });

  it.each([
    ["a reference that is an array", { reference: ["/Engine/EngineMaterials/Grid.Grid"] }],
    ["a SHA-256 array that stringifies to a digest", { bytesSha256: ["a".repeat(64)] }],
  ])("refuses a supplied Grid with %s before creating the floor", (_label, override) => {
    const texture = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    const source = { reference: "/Engine/EngineMaterials/Grid.Grid", engine: "4.19.2", bytesSha256: "a".repeat(64), ...override };
    expect(() => createThumbnailReferenceFloor(THREE, { texture, source: source as never })).toThrow(/SHA-256 provenance/);
    texture.dispose();
  });
});
