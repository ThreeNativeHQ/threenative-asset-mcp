import { NodeIO, Primitive, type Document } from "@gltf-transform/core";

/**
 * UV stretch, measured from the GLB (A.3). Each triangle's texel density is its UV area over its
 * world area; the mesh median is the typical density. A triangle whose UV area is `ratio` times
 * smaller than the median has that many times coarser texels, so the atlas cannot be sharp there.
 * Area-weighted, so a thousand slivers cannot outweigh the surface they cover.
 */
export interface UvStretchReport {
  /** 95th percentile of (median density / triangle density); 1 = uniform, 4 = four times coarser. */
  readonly p95: number;
  /** Material whose triangles are stretched the most (its own p95). */
  readonly worstMaterial: string;
  readonly worstMaterialP95: number;
  readonly triangles: number;
  /** True when p95 <= UV_STRETCH_LIMIT: the atlas can be sharp everywhere that matters. */
  readonly uniform: boolean;
}

/** Beyond 4x the atlas cannot be sharp on that surface; the quote warns (A.3). */
export const UV_STRETCH_LIMIT = 4;
/** A degenerate UV triangle has zero UV area; report a finite, obviously bad stretch. */
const MAX_STRETCH = 1_000;

interface TriangleDensity {
  readonly density: number;
  readonly area: number;
}

function areaWeightedPercentile(values: readonly TriangleDensity[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a.density - b.density);
  const total = sorted.reduce((sum, value) => sum + value.area, 0);
  if (total <= 0) return 1;
  let seen = 0;
  for (const value of sorted) {
    seen += value.area;
    if (seen >= total * quantile) return value.density;
  }
  return sorted[sorted.length - 1]?.density ?? 1;
}

function triangleDensities(primitive: Primitive): TriangleDensity[] {
  const position = primitive.getAttribute("POSITION");
  const uv = primitive.getAttribute("TEXCOORD_0");
  if (!position || !uv) return [];
  const indices = primitive.getIndices();
  const vertexCount = position.getCount();
  const triangleCount = (indices ? indices.getCount() : vertexCount) / 3;
  const out: TriangleDensity[] = [];
  const corners = [0, 0, 0];
  const worldArea = (a: number, b: number, c: number): number => {
    const pa = position.getElement(a, [0, 0, 0] as unknown as number[]);
    const pb = position.getElement(b, [0, 0, 0] as unknown as number[]);
    const pc = position.getElement(c, [0, 0, 0] as unknown as number[]);
    const ux = pb[0]! - pa[0]!;
    const uy = pb[1]! - pa[1]!;
    const uz = pb[2]! - pa[2]!;
    const vx = pc[0]! - pa[0]!;
    const vy = pc[1]! - pa[1]!;
    const vz = pc[2]! - pa[2]!;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    return Math.hypot(cx, cy, cz) / 2;
  };
  const uvArea = (a: number, b: number, c: number): number => {
    const ta = uv.getElement(a, [0, 0] as unknown as number[]);
    const tb = uv.getElement(b, [0, 0] as unknown as number[]);
    const tc = uv.getElement(c, [0, 0] as unknown as number[]);
    const ux = tb[0]! - ta[0]!;
    const uy = tb[1]! - ta[1]!;
    const vx = tc[0]! - ta[0]!;
    const vy = tc[1]! - ta[1]!;
    return Math.abs(ux * vy - uy * vx) / 2;
  };
  for (let t = 0; t < triangleCount; t++) {
    for (let k = 0; k < 3; k++) corners[k] = indices ? indices.getScalar(3 * t + k) : 3 * t + k;
    const world = worldArea(corners[0]!, corners[1]!, corners[2]!);
    if (world <= 1e-9) continue;
    const uvA = uvArea(corners[0]!, corners[1]!, corners[2]!);
    out.push({ density: uvA / world, area: world });
  }
  return out;
}

export async function measureUvStretch(path: string): Promise<UvStretchReport> {
  const document: Document = await new NodeIO().read(path);
  const all: TriangleDensity[] = [];
  const byMaterial = new Map<string, TriangleDensity[]>();
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== Primitive.Mode.TRIANGLES) continue;
      const triangles = triangleDensities(primitive);
      if (triangles.length === 0) continue;
      all.push(...triangles);
      const material = primitive.getMaterial()?.getName() || "default";
      byMaterial.set(material, [...(byMaterial.get(material) ?? []), ...triangles]);
    }
  }
  if (all.length === 0) return { p95: 1, worstMaterial: "default", worstMaterialP95: 1, triangles: 0, uniform: true };
  const densities = all.map((triangle) => triangle.density).sort((a, b) => a - b);
  const median = densities[Math.floor(densities.length / 2)] ?? 1;
  const stretch = (value: number): number => Math.min(MAX_STRETCH, median > 0 ? median / value : MAX_STRETCH);
  const scaled = (triangles: TriangleDensity[]): TriangleDensity[] =>
    triangles.map((triangle) => ({ density: stretch(triangle.density), area: triangle.area }));
  const p95 = areaWeightedPercentile(scaled(all), 0.95);
  let worstMaterial = "default";
  let worstMaterialP95 = 1;
  for (const [material, triangles] of byMaterial) {
    const materialP95 = areaWeightedPercentile(scaled(triangles), 0.95);
    if (materialP95 > worstMaterialP95) {
      worstMaterial = material;
      worstMaterialP95 = materialP95;
    }
  }
  return {
    p95,
    worstMaterial,
    worstMaterialP95,
    triangles: all.length,
    uniform: p95 <= UV_STRETCH_LIMIT,
  };
}
