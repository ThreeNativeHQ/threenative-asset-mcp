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
      const index = [0, 1, 2].map((offset) => (primitive.indices ? primitive.indices[corner + offset]! : corner + offset));
      if (index.some((value) => value < 0 || value >= vertexCount)) continue;
      const [a, b, c] = index as [number, number, number];
      const u = [primitive.uv[a * 2]!, primitive.uv[b * 2]!, primitive.uv[c * 2]!].map((value) => value * size);
      const v = [primitive.uv[a * 2 + 1]!, primitive.uv[b * 2 + 1]!, primitive.uv[c * 2 + 1]!].map((value) => value * size);
      const determinant = (v[1]! - v[2]!) * (u[0]! - u[2]!) + (u[2]! - u[1]!) * (v[0]! - v[2]!);
      if (Math.abs(determinant) < 1e-12) continue;
      const minX = Math.max(0, Math.floor(Math.min(...u)));
      const maxX = Math.min(size - 1, Math.floor(Math.max(...u)));
      const minY = Math.max(0, Math.floor(Math.min(...v)));
      const maxY = Math.min(size - 1, Math.floor(Math.max(...v)));
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w0 = ((v[1]! - v[2]!) * (px - u[2]!) + (u[2]! - u[1]!) * (py - v[2]!)) / determinant;
          const w1 = ((v[2]! - v[0]!) * (px - u[2]!) + (u[0]! - u[2]!) * (py - v[2]!)) / determinant;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const at = (y * size + x) * 3;
          let nx = 0;
          let ny = 0;
          let nz = 0;
          for (const [vertex, weight] of [[a, w0], [b, w1], [c, w2]] as const) {
            nx += primitive.normal[vertex * 3]! * weight;
            ny += primitive.normal[vertex * 3 + 1]! * weight;
            nz += primitive.normal[vertex * 3 + 2]! * weight;
          }
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
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size || !covered[ny * size + nx]) continue;
          const to = (y * size + x) * 3;
          const from = (ny * size + nx) * 3;
          normals[to] = normals[from]!;
          normals[to + 1] = normals[from + 1]!;
          normals[to + 2] = normals[from + 2]!;
          grown.push(y * size + x);
          break;
        }
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
