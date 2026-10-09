import { describe, expect, it } from "vitest";

import { rasteriseSurfaceNormals, surfaceKey } from "../src/unreal/surface-normals.js";

// Two triangles that tile the left and right half of UV space; the left faces up (+Y), the right faces sideways (+X).
const quad = (normalLeft: number[], normalRight: number[]) => ({
  uv: [0, 0, 0.5, 0, 0, 1, 0.5, 0, 0.5, 1, 0, 1, 0.5, 0, 1, 0, 0.5, 1, 1, 0, 1, 1, 0.5, 1],
  normal: [...normalLeft, ...normalLeft, ...normalLeft, ...normalLeft, ...normalLeft, ...normalLeft, ...normalRight, ...normalRight, ...normalRight, ...normalRight, ...normalRight, ...normalRight],
});

describe("rasteriseSurfaceNormals", () => {
  const at = (surface: ReturnType<typeof rasteriseSurfaceNormals>, x: number, y: number): number[] => [...surface.normals.subarray((y * surface.width + x) * 3, (y * surface.width + x) * 3 + 3)];

  it("lays each triangle's normal into the texels its UVs cover", () => {
    const surface = rasteriseSurfaceNormals([quad([0, 1, 0], [1, 0, 0])], 8);
    expect(at(surface, 1, 4)).toEqual([0, 1, 0]);
    expect(at(surface, 6, 4)).toEqual([1, 0, 0]);
    expect(surface.covered).toBe(64);
  });

  it("interpolates and renormalises a smooth normal across a triangle", () => {
    const surface = rasteriseSurfaceNormals(
      [{ uv: [0, 0, 1, 0, 0, 1], normal: [0, 1, 0, 1, 0, 0, 0, 0, 1], indices: [0, 1, 2] }],
      16,
    );
    const [x, y, z] = at(surface, 2, 2) as [number, number, number];
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 5);
    expect(y).toBeGreaterThan(x);
    expect(y).toBeGreaterThan(z);
  });

  it("fills the gutter around an island with the nearest covered normal and reports the raw coverage", () => {
    const surface = rasteriseSurfaceNormals([{ uv: [0, 0, 0.5, 0, 0, 0.5], normal: [0, 1, 0, 0, 1, 0, 0, 1, 0] }], 16);
    expect(surface.covered).toBeLessThan(16 * 16 / 2);
    // Just outside the triangle's hypotenuse the dilation hands over the island's normal; far away nothing is invented.
    expect(at(surface, 5, 5)).toEqual([0, 1, 0]);
    expect(at(surface, 15, 15)).toEqual([0, 0, 0]);
  });

  it("ignores degenerate triangles and out-of-range indices", () => {
    const surface = rasteriseSurfaceNormals([{ uv: [0, 0, 0, 0, 0, 0], normal: [0, 1, 0, 0, 1, 0, 0, 1, 0] }, { uv: [0, 0, 1, 0, 0, 1], normal: [0, 1, 0, 0, 1, 0, 0, 1, 0], indices: [0, 1, 9] }], 4);
    expect(surface.covered).toBe(0);
  });

  it("gives equal maps one key and different maps another", () => {
    const a = rasteriseSurfaceNormals([quad([0, 1, 0], [1, 0, 0])], 4);
    const b = rasteriseSurfaceNormals([quad([0, 1, 0], [1, 0, 0])], 4);
    const c = rasteriseSurfaceNormals([quad([1, 0, 0], [0, 1, 0])], 4);
    expect(surfaceKey(a)).toBe(surfaceKey(b));
    expect(surfaceKey(a)).not.toBe(surfaceKey(c));
  });
});
