import * as THREE from 'three';

import { ATLAS_GUTTER_TEXELS } from './atlas-pixels.js';

export const MAX_ATLAS_PAGES = 4;
export const TARGET_TEXELS_PER_METRE = 120;
export const MIN_MULTIPAGE_ATLAS = 2048;
export const MAX_PAGE_ATLAS = 4096;

const USABLE_PACK_FILL = 0.75;
const PACK_SEARCH_STEPS = 36;

export interface UvIsland {
  readonly index: number;
  readonly triangleIndices: number[];
  readonly worldArea: number;
  readonly uvArea: number;
  readonly minU: number;
  readonly maxU: number;
  readonly minV: number;
  readonly maxV: number;
  /** Width in metres after area-preserving texel-density normalisation. */
  readonly widthMetres: number;
  /** Height in metres after area-preserving texel-density normalisation. */
  readonly heightMetres: number;
}

export interface PackedAtlasPage {
  readonly index: number;
  readonly geometry: THREE.BufferGeometry;
  readonly triangleCount: number;
  readonly islandCount: number;
  readonly worldArea: number;
  readonly texelsPerMetre: number;
}

export interface AtlasPagesBuild {
  readonly pages: PackedAtlasPage[];
  readonly pageAtlasSize: number;
  readonly texelsPerMetre: number;
}

interface PlacedIsland {
  readonly island: UvIsland;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rotated: boolean;
}

/**
 * Pick 1..4 atlas pages so large levels approach `TARGET_TEXELS_PER_METRE` instead of starving
 * thousands of square metres in a single UV atlas. Explicit small preview atlases (`< 1024`) stay single-page.
 */
export function autoAtlasPages(surfaceArea: number, atlasSize: number): number {
  if (!(surfaceArea > 0) || atlasSize < 1024) return 1;
  const pageSide = Math.min(MAX_PAGE_ATLAS, Math.max(atlasSize, MIN_MULTIPAGE_ATLAS));
  const usableTexels = pageSide * pageSide * USABLE_PACK_FILL;
  const areaPerPage = usableTexels / (TARGET_TEXELS_PER_METRE * TARGET_TEXELS_PER_METRE);
  return Math.min(MAX_ATLAS_PAGES, Math.max(1, Math.ceil(surfaceArea / Math.max(areaPerPage, 1))));
}

/**
 * Partition non-indexed/indexed level geometry into connected UV islands with world surface area
 * and world-scale bounding dimensions for multi-page repacking.
 */
export function extractUvIslands(geometry: THREE.BufferGeometry): UvIsland[] {
  const pos = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  if (!pos || !uv) return [];
  const idx = geometry.index;
  const triCount = Math.floor((idx ? idx.count : pos.count) / 3);
  if (triCount === 0) return [];

  const parent = new Int32Array(triCount);
  for (let i = 0; i < triCount; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r]! !== r) r = parent[r]!;
    let cur = x;
    while (parent[cur]! !== r) {
      const next = parent[cur]!;
      parent[cur] = r;
      cur = next;
    }
    return r;
  };
  const unite = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  // Key on both quantized 3D position and UV so welded mesh seams merge within an island
  // without merging unrelated geometry that happens to overlap in raw blockout UVs.
  const cornerOwner = new Map<string, number>();
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = idx ? idx.getX(3 * t + k) : 3 * t + k;
      const key =
        `${Math.round(pos.getX(vi) * 1e3)},${Math.round(pos.getY(vi) * 1e3)},${Math.round(pos.getZ(vi) * 1e3)}|` +
        `${Math.round(uv.getX(vi) * 1e4)},${Math.round(uv.getY(vi) * 1e4)}`;
      const prev = cornerOwner.get(key);
      if (prev === undefined) cornerOwner.set(key, t);
      else unite(prev, t);
    }
  }

  const groups = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const root = find(t);
    let list = groups.get(root);
    if (!list) {
      list = [];
      groups.set(root, list);
    }
    list.push(t);
  }

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();

  const islands: UvIsland[] = [];
  for (const tris of groups.values()) {
    let worldArea = 0;
    let uvArea = 0;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;

    for (const t of tris) {
      const i0 = idx ? idx.getX(3 * t) : 3 * t;
      const i1 = idx ? idx.getX(3 * t + 1) : 3 * t + 1;
      const i2 = idx ? idx.getX(3 * t + 2) : 3 * t + 2;

      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      cross.crossVectors(ab, ac);
      worldArea += 0.5 * cross.length();

      const u0 = uv.getX(i0);
      const v0 = uv.getY(i0);
      const u1 = uv.getX(i1);
      const v1 = uv.getY(i1);
      const u2 = uv.getX(i2);
      const v2 = uv.getY(i2);
      uvArea += 0.5 * Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0));

      minU = Math.min(minU, u0, u1, u2);
      maxU = Math.max(maxU, u0, u1, u2);
      minV = Math.min(minV, v0, v1, v2);
      maxV = Math.max(maxV, v0, v1, v2);
    }

    const spanU = Math.max(maxU - minU, 1e-5);
    const spanV = Math.max(maxV - minV, 1e-5);
    const areaScale = uvArea > 1e-10 && worldArea > 0
      ? Math.sqrt(worldArea / uvArea)
      : Math.sqrt(Math.max(worldArea, 1e-6) / (spanU * spanV));

    islands.push({
      index: islands.length,
      triangleIndices: tris,
      worldArea,
      uvArea,
      minU,
      maxU,
      minV,
      maxV,
      widthMetres: Math.max(spanU * areaScale, 1e-4),
      heightMetres: Math.max(spanV * areaScale, 1e-4),
    });
  }

  return islands;
}

/** Shelf-pack `islands` at `texelsPerMetre` inside a square atlas of `atlasSize` with `gutterPx` margins. */
function packIslandsAtScale(
  islands: readonly UvIsland[],
  texelsPerMetre: number,
  atlasSize: number,
  gutterPx: number,
): PlacedIsland[] | undefined {
  const usable = atlasSize - 2 * gutterPx;
  if (usable <= 0) return undefined;

  const sized = islands.map((island) => {
    const rw = Math.max(4, Math.ceil(island.widthMetres * texelsPerMetre));
    const rh = Math.max(4, Math.ceil(island.heightMetres * texelsPerMetre));
    // Place long side horizontally so each shelf's row height is minimal.
    const rotated = rh > rw;
    const w = rotated ? rh : rw;
    const h = rotated ? rw : rh;
    return { island, w, h, rotated };
  });

  sized.sort((a, b) => b.h - a.h || b.w - a.w || a.island.index - b.island.index);

  let x = gutterPx;
  let y = gutterPx;
  let shelfH = 0;
  const placed: PlacedIsland[] = [];

  for (const item of sized) {
    if (item.w > usable || item.h > usable) return undefined;
    if (x > gutterPx && x + item.w > atlasSize - gutterPx) {
      y += shelfH + gutterPx;
      x = gutterPx;
      shelfH = 0;
    }
    if (y + item.h > atlasSize - gutterPx) return undefined;
    placed.push({ island: item.island, x, y, w: item.w, h: item.h, rotated: item.rotated });
    x += item.w + gutterPx;
    shelfH = Math.max(shelfH, item.h);
  }
  return placed;
}

function packPageMaxDensity(
  islands: readonly UvIsland[],
  atlasSize: number,
  gutterPx: number,
): { placed: PlacedIsland[]; texelsPerMetre: number } {
  const usable = atlasSize - 2 * gutterPx;
  let maxLong = 1e-4;
  let boxAreaSum = 0;
  for (const isl of islands) {
    maxLong = Math.max(maxLong, Math.max(isl.widthMetres, isl.heightMetres));
    boxAreaSum += isl.widthMetres * isl.heightMetres;
  }
  let lo = 1e-3;
  let hi = Math.min(usable / maxLong, (usable / Math.sqrt(Math.max(boxAreaSum, 1e-6))) * 1.5);
  hi = Math.max(hi, lo * 2);

  let best: PlacedIsland[] | undefined = packIslandsAtScale(islands, lo, atlasSize, gutterPx);
  let bestScale = lo;

  for (let iter = 0; iter < PACK_SEARCH_STEPS; iter++) {
    const mid = 0.5 * (lo + hi);
    const attempt = packIslandsAtScale(islands, mid, atlasSize, gutterPx);
    if (attempt) {
      best = attempt;
      bestScale = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  if (!best) throw new Error(`could not pack ${islands.length} islands into ${atlasSize}px page`);
  return { placed: best, texelsPerMetre: bestScale };
}

function buildPageGeometry(
  source: THREE.BufferGeometry,
  placed: readonly PlacedIsland[],
  atlasSize: number,
): { geometry: THREE.BufferGeometry; triangleCount: number } {
  const pos = source.getAttribute('position');
  const nrm = source.getAttribute('normal');
  const uv = source.getAttribute('uv');
  const lbl = source.getAttribute('label');
  const idx = source.index;

  let triCount = 0;
  for (const item of placed) triCount += item.island.triangleIndices.length;

  const vertexCount = triCount * 3;
  const outPos = new Float32Array(vertexCount * 3);
  const outNrm = new Float32Array(vertexCount * 3);
  const outUv = new Float32Array(vertexCount * 2);
  const outLbl = lbl ? new Float32Array(vertexCount) : undefined;

  let cursor = 0;
  for (const item of placed) {
    const isl = item.island;
    const spanU = Math.max(isl.maxU - isl.minU, 1e-5);
    const spanV = Math.max(isl.maxV - isl.minV, 1e-5);
    const dstU = item.x / atlasSize;
    const dstV = item.y / atlasSize;
    const dstW = item.w / atlasSize;
    const dstH = item.h / atlasSize;

    for (const t of isl.triangleIndices) {
      for (let k = 0; k < 3; k++) {
        const srcVi = idx ? idx.getX(3 * t + k) : 3 * t + k;
        outPos[3 * cursor] = pos.getX(srcVi);
        outPos[3 * cursor + 1] = pos.getY(srcVi);
        outPos[3 * cursor + 2] = pos.getZ(srcVi);

        outNrm[3 * cursor] = nrm.getX(srcVi);
        outNrm[3 * cursor + 1] = nrm.getY(srcVi);
        outNrm[3 * cursor + 2] = nrm.getZ(srcVi);

        const nu = (uv.getX(srcVi) - isl.minU) / spanU;
        const nv = (uv.getY(srcVi) - isl.minV) / spanV;
        if (item.rotated) {
          outUv[2 * cursor] = dstU + nv * dstW;
          outUv[2 * cursor + 1] = dstV + (1 - nu) * dstH;
        } else {
          outUv[2 * cursor] = dstU + nu * dstW;
          outUv[2 * cursor + 1] = dstV + nv * dstH;
        }

        if (outLbl && lbl) outLbl[cursor] = lbl.getX(srcVi);
        cursor += 1;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(outNrm, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(outUv, 2));
  if (outLbl) geometry.setAttribute('label', new THREE.BufferAttribute(outLbl, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, triangleCount: triCount };
}

/**
 * Partition `geometry` across up to `targetPages` balanced atlas pages, repack every UV island at
 * uniform world texel density with gutter padding, and return one sub-geometry per page.
 */
export function buildAtlasPages(
  geometry: THREE.BufferGeometry,
  targetPages: number,
  pageAtlasSize: number,
  gutterPx = ATLAS_GUTTER_TEXELS * 2,
): AtlasPagesBuild {
  const islands = extractUvIslands(geometry);
  const pageCount = Math.min(Math.max(1, targetPages), Math.max(1, islands.length));
  if (islands.length === 0) {
    return { pages: [], pageAtlasSize, texelsPerMetre: 0 };
  }

  // LPT assignment by packing bbox area so each page gets balanced UV area demand.
  const sorted = [...islands].sort(
    (a, b) => b.widthMetres * b.heightMetres - a.widthMetres * a.heightMetres || a.index - b.index,
  );
  const buckets: { islands: UvIsland[]; load: number; worldArea: number }[] = Array.from(
    { length: pageCount },
    () => ({ islands: [], load: 0, worldArea: 0 }),
  );
  for (const isl of sorted) {
    let best = buckets[0]!;
    for (let p = 1; p < buckets.length; p++) {
      if (buckets[p]!.load < best.load) best = buckets[p]!;
    }
    best.islands.push(isl);
    best.load += isl.widthMetres * isl.heightMetres;
    best.worldArea += isl.worldArea;
  }

  const pages: PackedAtlasPage[] = [];
  let weightedArea = 0;
  let weightedDensity = 0;

  for (const bucket of buckets) {
    if (bucket.islands.length === 0) continue;
    const { placed, texelsPerMetre } = packPageMaxDensity(bucket.islands, pageAtlasSize, gutterPx);
    const built = buildPageGeometry(geometry, placed, pageAtlasSize);
    pages.push({
      index: pages.length,
      geometry: built.geometry,
      triangleCount: built.triangleCount,
      islandCount: bucket.islands.length,
      worldArea: bucket.worldArea,
      texelsPerMetre,
    });
    weightedArea += bucket.worldArea;
    weightedDensity += bucket.worldArea * texelsPerMetre;
  }

  return {
    pages,
    pageAtlasSize,
    texelsPerMetre: weightedArea > 0 ? weightedDensity / weightedArea : 0,
  };
}
