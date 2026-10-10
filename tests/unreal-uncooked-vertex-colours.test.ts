import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
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
// which decode through the uncooked route) rendered without it.
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
    expect(UNCOOKED_CONVERTER.version).toBe("4.27.2.0+threenative.10");
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

  function colourByPosition(document: Awaited<ReturnType<NodeIO["read"]>>): Map<string, number[]> | null {
    const primitive = document.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives())[0];
    if (!primitive) throw new Error("the writer produced no primitive");
    const attribute = primitive.getAttribute("COLOR_0");
    if (!attribute) return null;
    const positions = primitive.getAttribute("POSITION")!.getArray()!;
    const components = attribute.getArray()!;
    const byPosition = new Map<string, number[]>();
    for (let vertex = 0; vertex < attribute.getCount(); vertex++) {
      const key = [positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!]
        .map((value) => value.toFixed(2))
        .join(",");
      byPosition.set(key, [components[vertex * 4]!, components[vertex * 4 + 1]!, components[vertex * 4 + 2]!, components[vertex * 4 + 3]!]);
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
});
