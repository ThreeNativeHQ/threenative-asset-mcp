/**
 * The mesh's own vertex normals laid out in UV space, for graph nodes whose value depends on the surface (a moss mask that
 * follows the world-space normal, as in Landscape Pro's rock master). A bake is one colour per texel, so the only way to
 * honour such a node is to know, for each texel, which way the surface faces.
 *
 * Normals are the glTF ones (+Y is up for UE Viewer's export of a Z-up Unreal mesh). A mesh is baked unrotated, which is how
 * the editor thumbnail places it; a placed instance with another rotation would get another mask.
 */
import { createHash } from "node:crypto";

export interface SurfaceNormals {
  readonly width: number;
  readonly height: number;
  /** Unit normals, three floats per texel; texels no triangle covers hold the nearest covered texel's normal. */
  readonly normals: Float32Array;
  /** Texels covered by a triangle. */
  readonly covered: number;
}

export interface SurfaceTriangles {
  /** Two floats per vertex: glTF UV0 (v grows downward, like the bake's rows). */
  readonly uv: ArrayLike<number>;
  /** Three floats per vertex. */
  readonly normal: ArrayLike<number>;
  /** Vertex indices, three per triangle; absent means the vertices are already a triangle list. */
  readonly indices?: ArrayLike<number> | undefined;
}

const DILATION_PASSES = 6;

/** Rasterises the triangles' vertex normals into a `size` x `size` UV-space map; later triangles overwrite earlier ones. */
export function rasteriseSurfaceNormals(primitives: readonly SurfaceTriangles[], size: number): SurfaceNormals {
  const normals = new Float32Array(size * size * 3);
  const covered = new Uint8Array(size * size);
  for (const primitive of primitives) {
    const vertexCount = Math.floor(primitive.uv.length / 2);
    const count = primitive.indices ? primitive.indices.length : vertexCount;
    for (let corner = 0; corner + 2 < count; corner += 3) {
      const ia = primitive.indices ? primitive.indices[corner]! : corner;
      const ib = primitive.indices ? primitive.indices[corner + 1]! : corner + 1;
      const ic = primitive.indices ? primitive.indices[corner + 2]! : corner + 2;
      if (ia < 0 || ia >= vertexCount || ib < 0 || ib >= vertexCount || ic < 0 || ic >= vertexCount) continue;
      const u0 = primitive.uv[ia * 2]! * size;
      const u1 = primitive.uv[ib * 2]! * size;
      const u2 = primitive.uv[ic * 2]! * size;
      const v0 = primitive.uv[ia * 2 + 1]! * size;
      const v1 = primitive.uv[ib * 2 + 1]! * size;
      const v2 = primitive.uv[ic * 2 + 1]! * size;
      const determinant = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
      if (Math.abs(determinant) < 1e-12) continue;
      const minX = Math.max(0, Math.floor(Math.min(u0, u1, u2)));
      const maxX = Math.min(size - 1, Math.floor(Math.max(u0, u1, u2)));
      const minY = Math.max(0, Math.floor(Math.min(v0, v1, v2)));
      const maxY = Math.min(size - 1, Math.floor(Math.max(v0, v1, v2)));
      const n0x = primitive.normal[ia * 3]!;
      const n0y = primitive.normal[ia * 3 + 1]!;
      const n0z = primitive.normal[ia * 3 + 2]!;
      const n1x = primitive.normal[ib * 3]!;
      const n1y = primitive.normal[ib * 3 + 1]!;
      const n1z = primitive.normal[ib * 3 + 2]!;
      const n2x = primitive.normal[ic * 3]!;
      const n2y = primitive.normal[ic * 3 + 1]!;
      const n2z = primitive.normal[ic * 3 + 2]!;
      for (let y = minY; y <= maxY; y += 1) {
        const py = y + 0.5;
        for (let x = minX; x <= maxX; x += 1) {
          const px = x + 0.5;
          const w0 = ((v1 - v2) * (px - u2) + (u2 - u1) * (py - v2)) / determinant;
          const w1 = ((v2 - v0) * (px - u2) + (u0 - u2) * (py - v2)) / determinant;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const at = (y * size + x) * 3;
          const nx = n0x * w0 + n1x * w1 + n2x * w2;
          const ny = n0y * w0 + n1y * w1 + n2y * w2;
          const nz = n0z * w0 + n1z * w1 + n2z * w2;
          const length = Math.hypot(nx, ny, nz) || 1;
          normals[at] = nx / length;
          normals[at + 1] = ny / length;
          normals[at + 2] = nz / length;
          covered[y * size + x] = 1;
        }
      }
    }
  }
  let coveredCount = 0;
  for (const flag of covered) coveredCount += flag;
  // Fill the gutters so a bilinear sample at an island's edge does not read a made-up normal.
  for (let pass = 0; pass < DILATION_PASSES; pass += 1) {
    const grown: number[] = [];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (covered[y * size + x]) continue;
        const at = y * size + x;
        // Neighbour order matters (left, right, up, down): the first covered one wins.
        let from = -1;
        if (x > 0 && covered[at - 1]) from = at - 1;
        else if (x < size - 1 && covered[at + 1]) from = at + 1;
        else if (y > 0 && covered[at - size]) from = at - size;
        else if (y < size - 1 && covered[at + size]) from = at + size;
        if (from < 0) continue;
        normals[at * 3] = normals[from * 3]!;
        normals[at * 3 + 1] = normals[from * 3 + 1]!;
        normals[at * 3 + 2] = normals[from * 3 + 2]!;
        grown.push(at);
      }
    }
    for (const texel of grown) covered[texel] = 1;
  }
  return { width: size, height: size, normals, covered: coveredCount };
}

/** A stable identity of a surface map, so two meshes with one graph do not share a bake and one mesh always does. */
export function surfaceKey(surface: SurfaceNormals): string {
  return createHash("sha256").update(Buffer.from(surface.normals.buffer, surface.normals.byteOffset, surface.normals.byteLength)).digest("hex").slice(0, 16);
}
