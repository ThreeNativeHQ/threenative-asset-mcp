import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";

import {
  patchUncookedMeshColorExport,
  patchUncookedMeshDescriptionColors,
  toolchainCacheDir,
} from "../src/unreal/provision.js";

/**
 * Real-converter harness for the uncooked per-vertex-instance colour patch.
 *
 * Unlike `tests/unreal-uncooked-vertex-colours.test.ts` (which mirrors the upstream anchors in reduced
 * stubs), this script runs the *installed* GPL converter: the real `uasset.uncooked_mesh.extract_geometry`
 * decoder and the real `uasset.mesh.StaticMesh.from_package` / `export_glb` writer (pygltflib). The
 * synthetic MeshDescription is injected through a narrow seam — the bulk decode/parse is replaced with a
 * dict shaped exactly like `parse_mesh_description`'s output — so the real decode/transport/GLB path runs
 * end to end. It is deliberately a script, not a vitest suite: ordinary CI must not provision the uncooked
 * converter. The fresh-toolchain workflow runs it after provisioning, where a missing converter is a
 * failure, never a skip.
 *
 * Usage: THREENATIVE_TOOLCHAIN_DIR=<cache> npx tsx scripts/uncooked-colour-harness.ts
 */

const COLOUR_SLOTS = 12;
const LIVE_IDS = [2, 5, 9] as const;

const DRIVER = String.raw`"""Injects synthetic MeshDescriptions into the installed uncooked converter and exports GLBs."""
import json
import os
import struct
import sys

import uasset.mesh as meshmod
import uasset.uncooked_mesh as uncooked


def _attr(kind, per_elem, num_elements, values):
    data = struct.pack('<%df' % len(values), *values)
    return {
        'type': kind,
        'type_name': '?',
        'num_elements': num_elements,
        'num_indices': 1,
        'arrays': [{'kind': 'bulk', 'elem_size': per_elem * 4,
                    'count': len(values) // per_elem, 'data': data}],
        'default': b'',
        'flags': 0,
    }


def build_desc(mode):
    # Live vertex-instance ids are sparse and ascending (as _allocated_indices yields), mapped to a
    # shuffled vertex order. Color is indexed by vertex-instance id over the allocated slots.
    vi_ids = [2, 5, 9]
    vi_elems = [1, 0, 2]
    positions = [0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0, 0.0]
    vi_attrs = {
        'Normal': _attr(1, 3, 3, [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]),
        'TextureCoordinate': _attr(2, 2, 3, [0.0, 0.0, 1.0, 0.0, 0.0, 1.0]),
    }
    if mode == 'colour':
        # 12 allocated slots (trailing holes after the last live id 9); holes keep the default so a
        # mis-indexed read lands on white, never on a live colour.
        slots = [(1.0, 1.0, 1.0, 1.0) for _ in range(12)]
        slots[2] = (1.0, 0.5, 0.0, 0.7)
        slots[5] = (0.0, 1.0, 0.25, 0.5)
        slots[9] = (0.2, 0.4, 0.6, 0.9)
        vi_attrs['Color'] = _attr(0, 4, 12, [channel for slot in slots for channel in slot])
    elif mode == 'dense':
        vi_ids = [0, 1, 2]
        vi_elems = [1, 2, 0]
        vi_attrs['Color'] = _attr(0, 4, 3, [1.0, 0.5, 0.0, 0.7, 0.0, 1.0, 0.25, 0.5, 0.2, 0.4, 0.6, 0.9])
    elif mode == 'wrong-type':
        vi_attrs['Color'] = _attr(1, 3, 12, [0.0, 0.0, 0.0] * 12)
    elif mode == 'wrong-count':
        # Declared 12 allocated slots but only 3 serialized: a truncated source, not one to guess at.
        vi_attrs['Color'] = _attr(0, 4, 12, [1.0, 1.0, 1.0, 1.0] * 3)
    return {
        'vertex_ids': [0, 1, 2],
        'vertex_instance_ids': vi_ids,
        'vertex_instance_elements': vi_elems,
        'vertex_attributes': {'attributes': {'Position': _attr(1, 3, 3, positions)}},
        'vertex_instance_attributes': {'attributes': vi_attrs},
        'polygon_ids': [0],
        'polygon_elements': [{'vis': [vi_ids[0], vi_ids[1], vi_ids[2]], 'polygon_group_id': 0}],
        'polygon_group_ids': [],
        'polygon_group_attributes': {'attributes': {}},
        'triangles': [{'vi': (vi_ids[0], vi_ids[1], vi_ids[2]), 'polygon_id': 0}],
    }


class _FakePackage:
    export_count = 1
    name_map = []
    imports = []
    file_version_ue5 = 0

    def get_export_class_name(self, index):
        return 'StaticMesh'

    def get_export_data(self, index):
        return None


def main():
    root = sys.argv[1]
    results = {}
    for mode in ('colour', 'dense', 'no-colour', 'wrong-type', 'wrong-count'):
        desc = build_desc(mode)
        # Narrow seam: the real StaticMesh.from_package -> parser -> extract_geometry chain runs, with
        # only the raw bulk decode/parse replaced by the synthetic description.
        uncooked.extract_mesh_description_bulk = lambda pkg, d=desc: b'synthetic'
        uncooked.parse_mesh_description = lambda raw, d=desc: d
        mesh = meshmod.StaticMesh.from_package(_FakePackage())
        target = os.path.join(root, mode + '.glb')
        meshmod.export_glb(mesh, target)
        results[mode] = {'colors': len(getattr(mesh, 'colors', []) or [])}
    print(json.dumps(results))


if __name__ == '__main__':
    main()
`;

interface Colours {
  readonly colors: number;
  readonly document: Awaited<ReturnType<NodeIO["read"]>>;
}

function fail(message: string): never {
  throw new Error(message);
}

function colourByPosition(document: Awaited<ReturnType<NodeIO["read"]>>): Map<string, number[]> | null {
  const primitive = document.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives())[0];
  if (!primitive) fail("the writer produced no primitive");
  const attribute = primitive.getAttribute("COLOR_0");
  if (!attribute) return null;
  const positions = primitive.getAttribute("POSITION")!.getArray()!;
  const components = attribute.getArray()!;
  const byPosition = new Map<string, number[]>();
  for (let vertex = 0; vertex < attribute.getCount(); vertex++) {
    const key = [positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!]
      .map((value) => value.toFixed(2))
      .join(",");
    byPosition.set(
      key,
      [components[vertex * 4]!, components[vertex * 4 + 1]!, components[vertex * 4 + 2]!, components[vertex * 4 + 3]!],
    );
  }
  return byPosition;
}

function expectColours(
  mode: string,
  result: Colours,
  expectedCount: number,
  expected: ReadonlyArray<readonly [string, ReadonlyArray<number>]>,
): void {
  if (result.colors !== expectedCount) fail(`${mode}: decoder reported ${result.colors} colour slots, expected ${expectedCount}`);
  const primitive = result.document.getRoot().listMeshes()[0]?.listPrimitives()[0];
  if (!primitive) fail(`${mode}: writer produced no primitive`);
  const attribute = primitive.getAttribute("COLOR_0")!;
  if (attribute.getType() !== "VEC4") fail(`${mode}: COLOR_0 is ${attribute.getType()}, expected VEC4`);
  if (attribute.getComponentType() !== 5121) fail(`${mode}: COLOR_0 component ${attribute.getComponentType()}, expected 5121 (UNSIGNED_BYTE)`);
  if (!attribute.getNormalized()) fail(`${mode}: COLOR_0 is not normalized`);
  if (attribute.getCount() !== 3) fail(`${mode}: COLOR_0 count ${attribute.getCount()}, expected 3`);
  const byPosition = colourByPosition(result.document)!;
  for (const [position, rgba] of expected) {
    const found = byPosition.get(position);
    if (!found) fail(`${mode}: no vertex at ${position}`);
    rgba.forEach((channel, index) => {
      if (found[index] !== channel) fail(`${mode}: ${position} channel ${index} is ${found[index]}, expected ${channel}`);
    });
  }
}

function expectNoColours(mode: string, result: Colours): void {
  if (result.colors !== 0) fail(`${mode}: decoder reported ${result.colors} colour slots, expected none`);
  if (colourByPosition(result.document) !== null) fail(`${mode}: a COLOR_0 was written for a source without trustable colours`);
}

async function main(): Promise<void> {
  const environment = process.env;
  const cache = toolchainCacheDir(environment);
  const python = join(cache, "uncooked", "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!existsSync(python)) {
    fail(`the uncooked converter is not provisioned at ${python}; provision it (THREENATIVE_TOOLCHAIN_DIR=${cache}) before running this harness`);
  }

  const uassetDir = execFileSync(python, ["-c", "import pathlib,uasset;print(pathlib.Path(uasset.__file__).parent)"], {
    encoding: "utf8",
  }).trim();
  if (!uassetDir || !existsSync(uassetDir)) fail(`could not locate the installed uasset package via ${python}`);

  const root = await mkdtemp(join(tmpdir(), "uncooked-colour-harness-"));
  try {
    const overlay = join(root, "overlay");
    await cp(uassetDir, join(overlay, "uasset"), { recursive: true });
    await rm(join(overlay, "uasset", "__pycache__"), { recursive: true, force: true });

    // The provisioned source may already carry the colour patch (a fresh provision does); the patch is
    // idempotent, so applying it here either adds it or proves it is already present. Like the
    // provisioner, normalise CRLF first so the anchors match the installed (CRLF) file.
    const uncookedPath = join(overlay, "uasset", "uncooked_mesh.py");
    const meshPath = join(overlay, "uasset", "mesh.py");
    const patchedUncooked = patchUncookedMeshDescriptionColors((await readFile(uncookedPath, "utf8")).replace(/\r\n/g, "\n"));
    const patchedMesh = patchUncookedMeshColorExport((await readFile(meshPath, "utf8")).replace(/\r\n/g, "\n"));
    await writeFile(uncookedPath, patchedUncooked);
    await writeFile(meshPath, patchedMesh);
    const driver = join(overlay, "driver.py");
    await writeFile(driver, DRIVER);

    const output = execFileSync(python, [driver, root], {
      encoding: "utf8",
      timeout: 120_000,
      cwd: overlay,
      env: { ...environment, PYTHONPATH: overlay },
    });
    const counts = JSON.parse(output.trim().split("\n").at(-1)!) as Record<string, { colors: number }>;

    const io = new NodeIO();
    const load = async (mode: string): Promise<Colours> => ({ colors: counts[mode]!.colors, document: await io.read(join(root, `${mode}.glb`)) });

    expectColours("colour", await load("colour"), COLOUR_SLOTS, [
      ["0.00,0.00,0.00", [0, 255, 137, 127]], // linear (0, 1, 0.25, 0.5): legacy alpha floors to 127
      ["0.00,0.00,-10.00", [255, 188, 0, 179]], // linear (1, 0.5, 0, 0.7)
      ["10.00,0.00,0.00", [124, 170, 204, 230]], // linear (0.2, 0.4, 0.6, 0.9)
    ]);
    expectColours("dense", await load("dense"), 3, [
      ["0.00,0.00,0.00", [124, 170, 204, 230]], // linear (0.2, 0.4, 0.6, 0.9)
      ["0.00,0.00,-10.00", [255, 188, 0, 179]], // linear (1, 0.5, 0, 0.7)
      ["10.00,0.00,0.00", [0, 255, 137, 127]], // linear (0, 1, 0.25, 0.5)
    ]);
    for (const mode of ["no-colour", "wrong-type", "wrong-count"]) expectNoColours(mode, await load(mode));

    console.log(`uncooked-colour-harness: ok — sparse live ids ${LIVE_IDS.join(",")} in ${COLOUR_SLOTS} slots, dense, and three no-colour cases, through the installed converter`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`uncooked-colour-harness: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
