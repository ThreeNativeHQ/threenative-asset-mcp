import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { materialGraphSchema, type MaterialGraph } from "../src/unreal/graph-dump.js";
import { bakeGraph, type BakeResult, type GraphParameters, type TextureRaster } from "../src/unreal/material-graph.js";

// Synthetic only. The shape mirrors an ivy leaf card: BaseColor = leaf texture, Opacity = Desaturation(mask texture), where
// the silhouette of the leaf lives only in the mask. The bake used to write alpha 255 everywhere, so every card was a
// solid rectangle.

type Raw = Record<string, unknown>;
const pin = (node: string, output = 0, mask: number[] | null = null) => ({ node, output, mask });
const node = (id: string, cls: string, extra: Raw = {}): Raw => ({ id, class: cls, inputs: {}, constants: {}, ...extra });
const NO_PARAMETERS: GraphParameters = { textures: new Map(), vectors: new Map(), scalars: new Map(), switches: new Map() };

const textureSample = (id: string, texture: string): Raw =>
  node(id, "TextureSample", { texture: `/Game/Test/${texture}.${texture}`, samplerType: "Color" });

function leafGraph(outputs: { opacity?: ReturnType<typeof pin>; opacityMask?: ReturnType<typeof pin> }, extraNodes: Raw[] = []): MaterialGraph {
  const nodes = [
    textureSample("leaf", "T_Leaf"),
    textureSample("mask", "T_Mask"),
    node("gray", "Desaturation", { inputs: { Input: pin("mask", 0, [1, 1, 1, 0]) } }),
    node("amount", "ScalarParameter", { parameter: { name: "Amount", group: "" }, default: 0.5 }),
    ...extraNodes,
  ];
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Leaf",
    package: "/Game/Test/M_Leaf",
    truncated: false,
    nodeCount: nodes.length,
    outputs: {
      baseColor: pin("leaf", 0, [1, 1, 1, 0]),
      roughness: null,
      metallic: null,
      emissive: null,
      opacity: outputs.opacity ?? null,
      opacityMask: outputs.opacityMask ?? null,
      normal: null,
      materialAttributes: null,
    },
    nodes,
  });
}

async function raster(texel: (x: number) => [number, number, number]): Promise<TextureRaster> {
  const size = 4;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) rgba.set([...texel(x), 255], (y * size + x) * 4);
  }
  return { width: size, height: size, rgba, srgb: true };
}

/** Left half of the mask is white (the leaf), right half black (the background). */
const loader = async (reference: string): Promise<TextureRaster | undefined> => {
  if (reference.includes("T_Leaf")) return raster(() => [40, 120, 50]);
  if (reference.includes("T_Mask")) return raster((x) => (x < 2 ? [255, 255, 255] : [0, 0, 0]));
  return undefined;
};

async function pixels(result: BakeResult): Promise<{ at: (x: number, y: number) => number[] }> {
  if (result.status !== "baked") throw new Error(`expected a baked result, got ${JSON.stringify(result)}`);
  const { data, info } = await sharp(result.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { at: (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)] };
}

const bake = (graph: MaterialGraph, alpha?: "opacity" | "opacityMask") =>
  bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader, size: 4, ...(alpha ? { alpha } : {}) });

describe("bakeGraph writes the cut-out into the alpha channel", () => {
  it("bakes a translucent material's Opacity: the leaf is opaque, the card around it is clear, the colour is unchanged", async () => {
    const { at } = await pixels(await bake(leafGraph({ opacity: pin("gray") }), "opacity"));
    expect(at(0, 0)[3]).toBe(255);
    expect(at(1, 2)[3]).toBe(255);
    expect(at(2, 0)[3]).toBe(0);
    expect(at(3, 3)[3]).toBe(0);
    // The RGB under a clear texel is still the card's colour, so mip filtering does not bleed black into the leaf edge.
    expect(at(3, 3).slice(0, 3)).toEqual(at(0, 0).slice(0, 3));
    expect(at(0, 0).slice(0, 3)).toEqual([40, 120, 50]);
  });

  it("reports a leaf-shaped mask as a binary cut-out with its opaque share, and a soft one as a gradient", async () => {
    const hard = await bake(leafGraph({ opacity: pin("gray") }), "opacity");
    expect(hard.status === "baked" && hard.alpha).toMatchObject({ pin: "opacity", binary: true });
    expect(hard.status === "baked" && hard.alpha!.opaqueShare).toBeCloseTo(0.5, 1);
    const soft = await bakeGraph({
      graph: leafGraph({ opacity: pin("gray") }),
      output: "baseColor",
      parameters: NO_PARAMETERS,
      loadTexture: async (reference) => (reference.includes("T_Mask") ? raster(() => [128, 128, 128]) : loader(reference)),
      size: 4,
      alpha: "opacity",
    });
    expect(soft.status === "baked" && soft.alpha).toMatchObject({ binary: false, opaqueShare: 0 });
  });

  it("bakes a masked material's OpacityMask the same way", async () => {
    const { at } = await pixels(await bake(leafGraph({ opacityMask: pin("gray") }), "opacityMask"));
    expect([at(0, 0)[3], at(3, 0)[3]]).toEqual([255, 0]);
  });

  it("uses the pin the caller names, not whichever is wired", async () => {
    const graph = leafGraph({ opacity: pin("gray"), opacityMask: pin("amount") });
    const { at } = await pixels(await bake(graph, "opacity"));
    expect([at(0, 0)[3], at(3, 0)[3]]).toEqual([255, 0]);
  });

  it("keeps alpha 255 without a request, as before", async () => {
    const { at } = await pixels(await bake(leafGraph({ opacity: pin("gray") })));
    expect([at(0, 0)[3], at(3, 0)[3]]).toEqual([255, 255]);
  });

  it("keeps alpha 255 when the pin is unwired", async () => {
    const { at } = await pixels(await bake(leafGraph({}), "opacity"));
    expect(at(3, 0)[3]).toBe(255);
  });

  it("leaves a uniform opacity to the section's colour factor instead of baking it", async () => {
    const result = await bake(leafGraph({ opacity: pin("amount") }), "opacity");
    const { at } = await pixels(result);
    expect(at(0, 0)[3]).toBe(255);
    expect(result.status === "baked" && result.confidence).toBe("exact");
  });

  it("keeps the colour and names the loss when the opacity path cannot be evaluated", async () => {
    const graph = leafGraph({ opacity: pin("noise") }, [node("noise", "Noise")]);
    const result = await bake(graph, "opacity");
    const { at } = await pixels(result);
    expect(at(0, 0)).toEqual([40, 120, 50, 255]);
    if (result.status !== "baked") throw new Error("expected a bake");
    expect(result.confidence).toBe("heuristic");
    expect(result.approximations.join("\n")).toContain("opacity could not be evaluated (unsupported nodes Noise)");
  });
});
