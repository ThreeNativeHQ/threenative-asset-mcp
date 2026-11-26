import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";

import {
  autoAtlasPages,
  buildAtlasPages,
  extractUvIslands,
  MAX_ATLAS_PAGES,
} from "../src/texture-projection/atlas-pages.js";
import { markProjectedAtlas, readProjectedAtlasMarker } from "../src/texture-projection/glb-marker.js";
import { ATLAS_GUTTER_TEXELS } from "../src/texture-projection/atlas-pixels.js";

function appendQuad(
  positions: number[],
  normals: number[],
  uvs: number[],
  originX: number,
  originY: number,
  wMetres: number,
  hMetres: number,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
) {
  const x0 = originX;
  const x1 = originX + wMetres;
  const y0 = originY;
  const y1 = originY + hMetres;
  // Two non-indexed CCW triangles forming one world-space quad with independent UVs.
  positions.push(
    x0, y0, 0,  x1, y0, 0,  x1, y1, 0,
    x0, y0, 0,  x1, y1, 0,  x0, y1, 0,
  );
  for (let i = 0; i < 6; i++) normals.push(0, 0, 1);
  uvs.push(
    u0, v0,  u1, v0,  u1, v1,
    u0, v0,  u1, v1,  u0, v1,
  );
}

function buildMultiIslandGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  // 8 walls (8m x 4m = 32 m^2 each) packed poorly into tiny UV rects [0..0.06]
  // + 4 small trim panels (1m x 1m = 1 m^2 each) given disproportionately huge UVs [0.5..0.9].
  for (let i = 0; i < 8; i++) {
    appendQuad(positions, normals, uvs, i * 10, 0, 8, 4, 0.01, i * 0.06, 0.05, i * 0.06 + 0.02);
  }
  for (let i = 0; i < 4; i++) {
    appendQuad(positions, normals, uvs, i * 3, 10, 1, 1, 0.5 + (i % 2) * 0.22, 0.5 + Math.floor(i / 2) * 0.22, 0.68 + (i % 2) * 0.22, 0.68 + Math.floor(i / 2) * 0.22);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

describe("texture-projection multi-page UV atlas packing", () => {
  it("picks 1..MAX_ATLAS_PAGES proportional to world surface area", () => {
    expect(autoAtlasPages(500, 256)).toBe(1);
    expect(autoAtlasPages(80, 2048)).toBe(1);
    expect(autoAtlasPages(400, 4096)).toBe(1);
    expect(autoAtlasPages(2000, 4096)).toBeGreaterThan(1);
    expect(autoAtlasPages(6100, 4096)).toBe(MAX_ATLAS_PAGES);
  });

  it("splits islands cleanly into balanced [0,1]^2 pages with gutter separation and preserves all triangles", () => {
    const geometry = buildMultiIslandGeometry();
    const islands = extractUvIslands(geometry);
    expect(islands).toHaveLength(12);
    const totalArea = islands.reduce((sum, isl) => sum + isl.worldArea, 0);
    expect(totalArea).toBeCloseTo(8 * 32 + 4 * 1, 3);

    const single = buildAtlasPages(geometry, 1, 2048);
    const multi = buildAtlasPages(geometry, 4, 2048);
    expect(multi.pages).toHaveLength(4);
    expect(multi.pages.reduce((sum, p) => sum + p.triangleCount, 0)).toBe(24);
    expect(multi.texelsPerMetre).toBeGreaterThan(single.texelsPerMetre * 1.8);

    for (const page of multi.pages) {
      const uv = page.geometry.getAttribute("uv");
      for (let i = 0; i < uv.count; i++) {
        expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
        expect(uv.getX(i)).toBeLessThanOrEqual(1);
        expect(uv.getY(i)).toBeGreaterThanOrEqual(0);
        expect(uv.getY(i)).toBeLessThanOrEqual(1);
      }
      // Re-extracted islands on the packed page must remain disjoint with at least ATLAS_GUTTER_TEXELS margin.
      const packedIslands = extractUvIslands(page.geometry);
      for (let i = 0; i < packedIslands.length; i++) {
        for (let j = i + 1; j < packedIslands.length; j++) {
          const a = packedIslands[i]!;
          const b = packedIslands[j]!;
          const gapX = Math.max(a.minU - b.maxU, b.minU - a.maxU) * multi.pageAtlasSize;
          const gapY = Math.max(a.minV - b.maxV, b.minV - a.maxV) * multi.pageAtlasSize;
          expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(ATLAS_GUTTER_TEXELS - 0.5);
        }
      }
    }
  });

  it("falls back to 1 page when a mesh only has 1 connected UV island", () => {
    const pos: number[] = [];
    const nrm: number[] = [];
    const uvs: number[] = [];
    appendQuad(pos, nrm, uvs, 0, 0, 10, 10, 0, 0, 1, 1);
    const single = new THREE.BufferGeometry();
    single.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    single.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
    single.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    const built = buildAtlasPages(single, 4, 2048);
    expect(built.pages).toHaveLength(1);
    expect(built.pages[0]!.triangleCount).toBe(2);
  });

  it("marks every baseColor texture and image across multi-material GLBs", async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 9, g: 8, b: 7, alpha: 1 } } })
      .png()
      .toBuffer();
    const doc = new Document();
    const buf = doc.createBuffer();
    const pos = doc.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buf);
    const uv = doc.createAccessor().setType("VEC2").setArray(new Float32Array([0, 0, 1, 0, 0, 1])).setBuffer(buf);
    const scene = doc.createScene();
    for (let i = 0; i < 2; i++) {
      const tex = doc.createTexture(`page_${i}`).setImage(new Uint8Array(png)).setMimeType("image/png");
      const mat = doc.createMaterial(`mat_${i}`).setBaseColorTexture(tex);
      const mesh = doc.createMesh(`mesh_${i}`).addPrimitive(
        doc.createPrimitive().setAttribute("POSITION", pos).setAttribute("TEXCOORD_0", uv).setMaterial(mat),
      );
      scene.addChild(doc.createNode(`node_${i}`).setMesh(mesh));
    }
    const rawGlb = await new NodeIO().writeBinary(doc);
    const marked = markProjectedAtlas(rawGlb, { atlas: 2048, runId: "multi-run", paintedMask: "multi.painted.png" });
    expect(readProjectedAtlasMarker(marked)).toEqual({
      atlas: 2048,
      runId: "multi-run",
      paintedMask: "multi.painted.png",
    });
    const outDoc = await new NodeIO().readBinary(marked);
    expect(outDoc.getRoot().listTextures()).toHaveLength(2);
    for (const tex of outDoc.getRoot().listTextures()) {
      expect(tex.getExtras()).toMatchObject({ threenative: { textureProjection: { atlas: 2048, runId: "multi-run" } } });
    }
  });
});
