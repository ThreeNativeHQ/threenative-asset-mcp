import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { KHRMaterialsUnlit } from "@gltf-transform/extensions";
import sharp from "sharp";
import { describe, expect, it, onTestFinished } from "vitest";

import { parsePaperTileMapDescriptor, parsePaperTileSetDescriptor, writePaperTileMapGlb } from "../src/unreal/paper-tilemaps.js";

const tileSet = {
  Name: "Tiles", PackagePath: "/Game/Tiles.Tiles", Class: "PaperTileSet", Texture: "Tiles.png", RelatedExports: [],
  Properties: { TileSize: { X: 2, Y: 2 }, WidthInTiles: 2, HeightInTiles: 1 },
};
const tileMap = {
  Name: "Map", PackagePath: "/Game/Map.Map", Class: "PaperTileMap",
  Properties: { MapWidth: 2, MapHeight: 1, TileWidth: 2, TileHeight: 2, PixelsPerUnrealUnit: 1, SelectedTileSet: { AssetPathName: "/Game/Tiles.Tiles" } },
  RelatedExports: [{ Name: "Layer", Class: "PaperTileLayer", Properties: {
    AllocatedWidth: 2, AllocatedHeight: 1,
    AllocatedCells: [
      { TileSet: { ObjectName: "PaperTileSet'Tiles'" }, PackedTileIndex: 0 },
      { TileSet: { ObjectName: "PaperTileSet'Tiles'" }, PackedTileIndex: 1 },
    ],
  } }],
};

describe("PaperTileMap conversion", () => {
  it("writes populated cells as an indexed unlit GLB", async () => {
    const root = await mkdtemp(join(tmpdir(), "tn-tilemap-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const texturePath = join(root, "Tiles.png");
    const outputPath = join(root, "Map.glb");
    await sharp({ create: { width: 4, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toFile(texturePath);
    const result = await writePaperTileMapGlb({
      map: parsePaperTileMapDescriptor(tileMap), tileSet: parsePaperTileSetDescriptor(tileSet), texturePath, outputPath,
    });
    const document = await new NodeIO().registerExtensions([KHRMaterialsUnlit]).read(outputPath);
    const primitive = document.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    expect(result).toMatchObject({ vertices: 8, tiles: 2, bounds: [0.04, 0.02, 0.0001] });
    expect(primitive.getIndices()?.getCount()).toBe(12);
    expect(primitive.getMaterial()?.getExtension("KHR_materials_unlit")).not.toBeNull();
    expect((await readFile(outputPath)).byteLength).toBeGreaterThan(500);
  });

  it("rejects inconsistent layer storage before allocating geometry", () => {
    expect(() => parsePaperTileMapDescriptor({
      ...tileMap,
      RelatedExports: [{ Name: "bad", Properties: { AllocatedWidth: 2, AllocatedHeight: 2, AllocatedCells: [] } }],
    })).toThrow(/cell count/);
    expect(() => parsePaperTileMapDescriptor({
      ...tileMap, Properties: { ...tileMap.Properties, ProjectionMode: "ETileMapProjectionMode::IsometricDiamond" },
    })).toThrow(/projection/);
    expect(parsePaperTileSetDescriptor({
      ...tileSet, Properties: { ...tileSet.Properties, BorderMargin: { Left: 1, Top: 2, Right: 3, Bottom: 4 }, PerTileSpacing: { X: 5, Y: 6 } },
    })).toMatchObject({ borderMargin: [1, 2, 3, 4], spacing: [5, 6] });
  });
});
