import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO, type Primitive } from "@gltf-transform/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  UNCOOKED_CONVERTER,
  patchUncookedMeshColorExport,
  patchUncookedMeshDescriptionColors,
} from "../src/unreal/provision.js";
import { describeWithTools } from "./helpers/require-tool.js";

// The uncooked UE4.27 converter is a GPL Python package installed at provision time. Its
// `extract_geometry` read a MeshDescription's Normal and TextureCoordinate attributes but dropped the
// per-vertex-instance Color, so a material that samples VertexColor (the Hornbeam UE 5.1 foliage icons,
// which decode through the uncooked route) rendered without it. The writer also kept only UV channel 0.
//
// The Color attribute is a `TArray` indexed by vertex-instance *element* ID, serialized across the
// allocated slots with holes retained — not packed by live id. These fixtures mirror the exact upstream
// regions the patch anchors on and model that storage: sparse ascending live ids, a full allocated colour
// array with holes and trailing holes, and a dense source. The full pipeline (patched `extract_geometry`
// -> `StaticMesh` -> GLB) is exercised; a real installed-converter harness lives in
// `scripts/uncooked-colour-harness.ts` and runs only in the fresh-toolchain workflow.

const FIXTURES = join(import.meta.dirname, "fixtures", "uncooked-colours");

describe("uncooked vertex-colour patches (embedded source)", () => {
  it("is a new converter build, so an installed older revision is re-provisioned", () => {
    expect(UNCOOKED_CONVERTER.version).toBe("4.27.2.0+threenative.11");
  });

  it("reads a per-vertex-instance FVector4 Color indexed by VI id, and is idempotent", async () => {
    const source = await readFile(join(FIXTURES, "upstream_stub.py"), "utf8");
    const patched = patchUncookedMeshDescriptionColors(source);
    expect(patched).not.toBe(source);
    expect(patched).toContain("color_entry['type'] == 0");
    // The array is used as read; it is validated against the allocated slot count, not re-zipped.
    expect(patched).toContain("colors = color_values");
    expect(patched).toContain("color_entry.get('num_elements')");
    expect(patched).toContain("len(color_values) == allocated and max(vi_ids) < allocated");
    expect(patched).not.toContain("zip(vi_ids, color_values)");
    expect(patched).toContain("'colors': colors,");
    expect(patchUncookedMeshDescriptionColors(patched)).toBe(patched);
  });

  it("carries the colours through StaticMesh and writes a normalized COLOR_0, and is idempotent", async () => {
    const source = await readFile(join(FIXTURES, "writer_stub.py"), "utf8");
    const patched = patchUncookedMeshColorExport(source);
    expect(patched).not.toBe(source);
    expect(patched).toContain("self.colors: List[Optional[Tuple[float, float, float, float]]] = []");
    expect(patched).toContain("mesh.colors = geo.get('colors') or []");
    expect(patched).toContain("prim.attributes.COLOR_0 = color_acc");
    expect(patched).toContain("accessors[color_acc].normalized = True");
    expect(patched).toContain("COMP_UNSIGNED_BYTE = 5121");
    expect(patchUncookedMeshColorExport(patched)).toBe(patched);
  });

  it("writes every present UV channel as its own TEXCOORD_<n>, read at the vertex instance, and is idempotent", async () => {
    const source = await readFile(join(FIXTURES, "writer_stub.py"), "utf8");
    const patched = patchUncookedMeshColorExport(source);
    expect(patched).toContain("for uv_index, channel in enumerate(mesh.uvs):");
    expect(patched).toContain("uv_values = _uv_values_at(uv_index, channel, vertex_instances)");
    expect(patched).toContain("setattr(prim.attributes, 'TEXCOORD_%d' % uv_index, uv_acc)");
    // The channel-0-only writer is gone: no single UV array, no UV0 read through the position's loop.
    expect(patched).not.toContain("prim.attributes.TEXCOORD_0 = uv_acc");
    expect(patched).not.toContain("uv_arr");
    expect(patched).not.toContain("u, v = uvs[vi]");
    expect(patchUncookedMeshColorExport(patched)).toBe(patched);
  });

  it("refuses a UV channel set it cannot write exactly, rather than padding or renumbering it", async () => {
    const source = await readFile(join(FIXTURES, "writer_stub.py"), "utf8");
    const patched = patchUncookedMeshColorExport(source);
    expect(patched).toContain('raise ValueError(f"mesh has {len(mesh.uvs)} UV channels; Unreal allows 8")');
    expect(patched).toContain("does not cover vertex instance {vi}");
    expect(patched).toContain("is negative, so UV channel {uv_index} cannot be read there");
    expect(patched).toContain("is not finite at vertex instance {vi}");
    expect(patched).not.toContain("u, v = 0.0, 0.0");
  });

  it("refuses the real installed source rather than silently no-op when an anchor drifts", () => {
    // A missing anchor must throw, not return the source unchanged: replaceRequired is the guard.
    expect(() => patchUncookedMeshDescriptionColors("# not the converter\n")).toThrow(/uncooked vertex colours/);
    expect(() => patchUncookedMeshColorExport("# not the converter\n")).toThrow(/StaticMesh colours field/);
  });
});

describeWithTools(["python-imaging"], "uncooked vertex colours (patched Python, geometry -> StaticMesh -> GLB)", () => {
  let root = "";
  let harness = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "uncooked-colours-"));
    const upstream = await readFile(join(FIXTURES, "upstream_stub.py"), "utf8");
    const writer = await readFile(join(FIXTURES, "writer_stub.py"), "utf8");
    await writeFile(join(root, "upstream.py"), patchUncookedMeshDescriptionColors(upstream));
    await writeFile(join(root, "writer.py"), patchUncookedMeshColorExport(writer));
    await writeFile(join(root, "harness.py"), await readFile(join(FIXTURES, "harness.py"), "utf8"));
    harness = join(root, "harness.py");
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function render(mode: string): Promise<{ colors: number; glb: string; document: Awaited<ReturnType<NodeIO["read"]>> }> {
    const glb = join(root, `${mode}.glb`);
    const output = execFileSync("python3", [harness, mode, glb], { encoding: "utf8", timeout: 60_000, cwd: root });
    const { colors } = JSON.parse(output) as { colors: number };
    return { colors, glb, document: await new NodeIO().read(glb) };
  }

  /** Like `render`, but a refused export (the writer's ValueError) is reported rather than thrown, with no GLB. */
  async function renderOutcome(mode: string): Promise<{ error?: string; glb: string; document?: Awaited<ReturnType<NodeIO["read"]>> }> {
    const glb = join(root, `${mode}.glb`);
    const output = execFileSync("python3", [harness, mode, glb], { encoding: "utf8", timeout: 60_000, cwd: root });
    const result = JSON.parse(output) as { error?: string };
    if (result.error !== undefined) return { error: result.error, glb };
    return { glb, document: await new NodeIO().read(glb) };
  }

  function colourByPosition(document: Awaited<ReturnType<NodeIO["read"]>>): Map<string, number[]> | null {
    const primitive = document.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives())[0];
    if (!primitive) throw new Error("the writer produced no primitive");
    const attribute = primitive.getAttribute("COLOR_0");
    if (!attribute) return null;
    const positions = primitive.getAttribute("POSITION")!.getArray()!;
    const components = attribute.getArray()!;
    const byPosition = new Map<string, number[]>();
    for (let vertex = 0; vertex < attribute.getCount(); vertex++) {
      const position = [positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!].map((value) => value.toFixed(2)).join(",");
      byPosition.set(position, [components[vertex * 4]!, components[vertex * 4 + 1]!, components[vertex * 4 + 2]!, components[vertex * 4 + 3]!]);
    }
    return byPosition;
  }

  async function expectColours(
    mode: string,
    colours: number,
    expected: ReadonlyArray<readonly [string, ReadonlyArray<number>]>,
  ): Promise<void> {
    const { colors, document } = await render(mode);
    expect(colors).toBe(colours);
    const primitive = document.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    const attribute = primitive.getAttribute("COLOR_0")!;
    expect(attribute.getType()).toBe("VEC4");
    expect(attribute.getComponentType()).toBe(5121); // UNSIGNED_BYTE
    expect(attribute.getNormalized()).toBe(true);
    expect(attribute.getCount()).toBe(3);
    const byPosition = colourByPosition(document)!;
    for (const [position, rgba] of expected) {
      const found = byPosition.get(position);
      expect(found, `no vertex at ${position}`).toBeDefined();
      rgba.forEach((channel, index) => expect(found![index]).toBe(channel));
    }
  }

  // Expected channels are the bytes Unreal's shader reads: the UE4 build packs the linear FVector4f with
  // FLinearColor::ToFColor(true) (sRGB RGB with the standard .0031308 breakpoint, linear alpha, then
  // floor(channel * 255.999)), and VET_Color reads byte/255 with no gamma decode. Computed independently of
  // the patch. Legacy alpha .5 packs to 127, unlike the modern rounded 128.
  it("maps a sparse, hole-retaining per-vertex-instance colour array by VI id", async () => {
    // Live VI ids (2, 5, 9) inside an allocated array of 12 slots (trailing holes after 9). The decoder
    // reports the source's allocated count; colour follows the vertex instance, not the vertex.
    // Instance 2 -> vertex 1 (glTF z = -UE x), 5 -> vertex 0, 9 -> vertex 2 (glTF x = UE y).
    await expectColours("colour", 12, [
      ["0.00,0.00,0.00", [0, 255, 137, 127]], // linear (0, 1, 0.25, 0.5)
      ["0.00,0.00,-10.00", [255, 188, 0, 179]], // linear (1, 0.5, 0, 0.7)
      ["10.00,0.00,0.00", [124, 170, 204, 230]], // linear (0.2, 0.4, 0.6, 0.9)
    ]);
  });

  it("keeps a dense source's colours correct", async () => {
    await expectColours("dense", 3, [
      ["0.00,0.00,0.00", [124, 170, 204, 230]], // linear (0.2, 0.4, 0.6, 0.9)
      ["0.00,0.00,-10.00", [255, 188, 0, 179]], // linear (1, 0.5, 0, 0.7)
      ["10.00,0.00,0.00", [0, 255, 137, 127]], // linear (0, 1, 0.25, 0.5)
    ]);
  });

  it.each(["no-colour", "wrong-type", "wrong-count"] as const)(
    "writes no COLOR_0 for a %s source instead of inventing or crashing on one",
    async (mode) => {
      const { colors, document } = await render(mode);
      expect(colors).toBe(0);
      expect(colourByPosition(document)).toBeNull();
    },
  );

  describe("UV channels as TEXCOORD_<n>", () => {
    // The live instances, in the order the writer emits them, and the stub's coordinate map: 2 sits on (0,0,-10),
    // 5 on (0,0,0), 9 on (10,0,0).
    const LIVE_SLOTS = [2, 5, 9];
    const LOCAL_POSITIONS = ["0.00,0.00,-10.00", "0.00,0.00,0.00", "10.00,0.00,0.00"] as const;
    // The synthetic value of channel `channel` at allocated slot `slot`: exact multiples of 1/64, distinct everywhere.
    const uvAt = (channel: number, slot: number): number[] => [(channel * 16 + slot) / 64, (slot * 4 + channel) / 64];

    function primitiveOf(document: Awaited<ReturnType<NodeIO["read"]>>): Primitive {
      return document.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    }
    function texcoord(primitive: Primitive, channel: number, vertex: number): number[] {
      const values = primitive.getAttribute(`TEXCOORD_${channel}`)!.getArray()!;
      return [values[vertex * 2]!, values[vertex * 2 + 1]!];
    }
    function vertexPositions(primitive: Primitive): string[] {
      const values = primitive.getAttribute("POSITION")!.getArray()!;
      const count = primitive.getAttribute("POSITION")!.getCount();
      return Array.from({ length: count }, (_, vertex) =>
        [values[vertex * 3]!, values[vertex * 3 + 1]!, values[vertex * 3 + 2]!].map((value) => value.toFixed(2)).join(","),
      );
    }
    const indices = (primitive: Primitive): number[] => Array.from(primitive.getIndices()!.getArray()!);
    const texcoordSemantics = (primitive: Primitive): string[] => primitive.listSemantics().filter((name) => name.startsWith("TEXCOORD_")).sort();

    it("writes all eight channels of a sparse instance set at their own TEXCOORD index, read per vertex instance", async () => {
      const { document } = await renderOutcome("uv-full");
      const primitive = primitiveOf(document!);
      expect(texcoordSemantics(primitive)).toEqual(["TEXCOORD_0", "TEXCOORD_1", "TEXCOORD_2", "TEXCOORD_3", "TEXCOORD_4", "TEXCOORD_5", "TEXCOORD_6", "TEXCOORD_7"]);
      expect(vertexPositions(primitive)).toEqual([...LOCAL_POSITIONS]);
      expect(indices(primitive)).toEqual([0, 1, 2]);
      for (let channel = 0; channel < 8; channel++) {
        LIVE_SLOTS.forEach((slot, local) => expect(texcoord(primitive, channel, local), `channel ${channel}, slot ${slot}`).toEqual(uvAt(channel, slot)));
      }
    });

    it("keeps a seam between instances that differ only in a later channel", async () => {
      // Instances 0 and 3 share vertex 0, normal and UV0; only UV1 differs, so they must stay two vertices.
      const { document } = await renderOutcome("uv-seam");
      const primitive = primitiveOf(document!);
      expect(primitive.getAttribute("POSITION")!.getCount()).toBe(4);
      expect(indices(primitive)).toEqual([0, 1, 2, 3, 2, 1]);
      expect(texcoord(primitive, 0, 0)).toEqual([0, 0]);
      expect(texcoord(primitive, 0, 3)).toEqual([0, 0]);
      expect(texcoord(primitive, 1, 0)).toEqual([0.25, 0.5]);
      expect(texcoord(primitive, 1, 3)).toEqual([0.75, 0.5]);
      expect(vertexPositions(primitive)[0]).toBe(vertexPositions(primitive)[3]);
    });

    it("writes only the channels a two-channel source carries", async () => {
      const { document } = await renderOutcome("uv-two");
      const primitive = primitiveOf(document!);
      expect(texcoordSemantics(primitive)).toEqual(["TEXCOORD_0", "TEXCOORD_1"]);
      LIVE_SLOTS.forEach((slot, local) => {
        expect(texcoord(primitive, 0, local)).toEqual(uvAt(0, slot));
        expect(texcoord(primitive, 1, local)).toEqual(uvAt(1, slot));
      });
    });

    it("writes no TEXCOORD for a source that carries no UV channel", async () => {
      const { document } = await renderOutcome("uv-none");
      expect(texcoordSemantics(primitiveOf(document!))).toEqual([]);
    });

    it("does not read a non-finite value in an unused hole, so it refuses nothing", async () => {
      const { document } = await renderOutcome("uv-hole-nan");
      const primitive = primitiveOf(document!);
      [2, 5, 9].forEach((slot, local) => expect(texcoord(primitive, 1, local)).toEqual(uvAt(1, slot)));
      expect(Array.from(primitive.getAttribute("TEXCOORD_1")!.getArray()!).every(Number.isFinite)).toBe(true);
    });

    it.each([
      // No UV reader runs for these, so the position path must refuse an instance outside the map, or a mapped vertex
      // outside the position array, rather than read it from the end (-1) or zero-fill it (past the end).
      ["uv-none-negative", "vertex instance -1 is outside the mesh's 10 mapped instances"],
      ["uv-none-above", "vertex instance 10 is outside the mesh's 10 mapped instances"],
      ["uv-none-map-negative", "vertex instance 9 maps to vertex -1, outside the mesh's 3 vertices"],
      ["uv-none-map-above", "vertex instance 9 maps to vertex 3, outside the mesh's 3 vertices"],
      ["uv-excess", "mesh has 9 UV channels; Unreal allows 8"],
      ["uv-short", "UV channel 1 has 6 values and does not cover vertex instance 9"],
      ["uv-nonfinite", "UV channel 1 is not finite at vertex instance 5"],
      // Python reads a -1 from the end of a list: the export must refuse, not take the last sample.
      ["uv-negative", "vertex instance -1 is outside the mesh's 10 mapped instances"],
    ] as const)("refuses %s, writing no GLB rather than padding, renumbering or wrapping", async (mode, message) => {
      const outcome = await renderOutcome(mode);
      expect(outcome.error).toBe(message);
      expect(existsSync(outcome.glb)).toBe(false);
    });
  });
});
