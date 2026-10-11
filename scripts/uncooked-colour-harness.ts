import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO, type Primitive } from "@gltf-transform/core";

import { patchUncookedModuleSources, toolchainCacheDir, UNCOOKED_CONVERTER } from "../src/unreal/provision.js";

/**
 * Real-converter harness for the uncooked colour and UV patches.
 *
 * Unlike `tests/unreal-uncooked-vertex-colours.test.ts` (which mirrors the upstream anchors in reduced
 * stubs), this script runs the pinned GPL converter's own decoder and writer, `uasset.uncooked_mesh.extract_geometry`
 * and `uasset.mesh.StaticMesh.from_package` / `export_glb` (pygltflib), under the cached venv's interpreter and
 * dependencies. The module is the pinned wheel exactly as pip ships it, checked against the RECORD of the cached venv,
 * then patched by `patchUncookedModuleSources`: the provisioner's own sequence, so the anchors are the ones a fresh
 * provision matches. The cached package is never imported or written; the provisioner has already patched it, so its
 * anchors no longer match. The synthetic MeshDescription is injected through a narrow seam (the bulk decode/parse is
 * replaced by a dict shaped like `parse_mesh_description`'s output). It is deliberately a script, not a vitest suite:
 * ordinary CI must not provision the uncooked converter. The fresh-toolchain workflow runs it after provisioning,
 * where a missing converter is a failure, never a skip.
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


UV_SLOTS = 12
UV_CHANNELS = 8
COLOUR_MODES = ('colour', 'dense', 'no-colour', 'wrong-type', 'wrong-count')
UV_MODES = ('uv-full', 'uv-two', 'uv-none', 'uv-seam', 'uv-hole-nan', 'uv-excess', 'uv-short', 'uv-nonfinite', 'uv-negative',
            'uv-none-negative', 'uv-none-above', 'uv-none-map-negative', 'uv-none-map-above')


def uv_attr(channels):
    """A TextureCoordinate entry: one bulk array per UV channel, each a FVector2 per allocated vertex instance."""
    arrays = []
    for values in channels:
        data = struct.pack('<%df' % len(values), *values)
        arrays.append({'kind': 'bulk', 'elem_size': 8, 'count': len(values) // 2, 'data': data})
    return {'type': 2, 'type_name': '?', 'num_elements': UV_SLOTS, 'num_indices': len(arrays),
            'arrays': arrays, 'default': b'', 'flags': 0}


def no_uv_channel():
    """A TextureCoordinate entry that carries no UV channel at all."""
    return {'type': 2, 'type_name': '?', 'num_elements': UV_SLOTS, 'num_indices': 0, 'arrays': [], 'default': b'', 'flags': 0}


def channel_values(channel, slots):
    """Distinct, exactly representable (multiples of 1/64) coordinates for every channel and slot."""
    values = []
    for slot in range(slots):
        values += [(channel * 16 + slot) / 64.0, (slot * 4 + channel) / 64.0]
    return values


def uv_desc(mode):
    """MeshDescriptions for the UV channel modes. Live instances are [2, 5, 9] in 12 slots unless noted."""
    vi_ids, vi_elems, slots = [2, 5, 9], [1, 0, 2], UV_SLOTS
    positions = [0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0, 0.0]
    channels = [channel_values(channel, slots) for channel in range(UV_CHANNELS)]
    triangles = [{'vi': (2, 5, 9), 'polygon_id': 0}]
    if mode == 'uv-seam':
        # Instances 0 and 3 sit on the same vertex with the same normal and UV0, and differ only in UV1.
        vi_ids, vi_elems, slots = [0, 1, 2, 3], [0, 1, 2, 0], 4
        uv0 = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
        uv1 = [0.25, 0.5, 0.5, 0.5, 0.5, 0.75, 0.75, 0.5]
        texcoords = uv_attr([uv0, uv1])
        triangles = [{'vi': (0, 1, 2), 'polygon_id': 0}, {'vi': (3, 2, 1), 'polygon_id': 0}]
    elif mode == 'uv-full':
        texcoords = uv_attr(channels)
    elif mode == 'uv-two':
        texcoords = uv_attr(channels[:2])
    elif mode == 'uv-none':
        texcoords = no_uv_channel()
    elif mode == 'uv-hole-nan':
        # Slot 0 is a hole (live ids are 2, 5, 9): a non-finite value there is never read, so it is not refused.
        holed = [list(channels[0]), list(channels[1])]
        holed[1][0] = float('nan')
        holed[1][1] = float('nan')
        texcoords = uv_attr(holed)
    elif mode == 'uv-excess':
        texcoords = uv_attr([channel_values(channel, slots) for channel in range(UV_CHANNELS + 1)])
    elif mode == 'uv-short':
        # Channel 1 covers slots 0..5 only, so live instance 9 has no coordinate there.
        texcoords = uv_attr([channels[0], channels[1][:12]])
    elif mode == 'uv-negative':
        # A triangle corner reads -1, which the parser's signed index can carry from a corrupt table. Python would
        # read it from the end of each channel, so the export must refuse rather than substitute the last sample.
        triangles = [{'vi': (2, 5, -1), 'polygon_id': 0}]
        texcoords = uv_attr(channels)
    elif mode == 'uv-none-negative':
        # No UV reader runs, so the position path alone must refuse an instance of -1 (Python would read vi_to_vertex[-1]).
        triangles = [{'vi': (2, 5, -1), 'polygon_id': 0}]
        texcoords = no_uv_channel()
    elif mode == 'uv-none-above':
        # One past the map (instances 0..9): the writer would otherwise zero-fill its position.
        triangles = [{'vi': (2, 5, 10), 'polygon_id': 0}]
        texcoords = no_uv_channel()
    elif mode == 'uv-none-map-negative':
        # Instance 9 maps to vertex -1, which Python would read as the last vertex.
        vi_elems = [1, 0, -1]
        texcoords = no_uv_channel()
    elif mode == 'uv-none-map-above':
        # Instance 9 maps to vertex 3 of 3, past the end of the position array.
        vi_elems = [1, 0, 3]
        texcoords = no_uv_channel()
    elif mode == 'uv-nonfinite':
        # Channel 1 at live instance 5 (slot 5, value index 10) is NaN.
        bad = list(channels[1])
        bad[10] = float('nan')
        texcoords = uv_attr([channels[0], bad])
    else:
        texcoords = uv_attr(channels)
    return {
        'vertex_ids': [0, 1, 2],
        'vertex_instance_ids': vi_ids,
        'vertex_instance_elements': vi_elems,
        'vertex_attributes': {'attributes': {'Position': _attr(1, 3, 3, positions)}},
        # (1, 0, 0) converts to (0, 0, -1); the writer's fallback is (0, 1, 0), so an unread normal would not match.
        'vertex_instance_attributes': {'attributes': {'Normal': _attr(1, 3, slots, [1.0, 0.0, 0.0] * slots), 'TextureCoordinate': texcoords}},
        'polygon_ids': [0],
        'polygon_elements': [{'vis': [vi_ids[0], vi_ids[1], vi_ids[2]], 'polygon_group_id': 0}],
        'polygon_group_ids': [],
        'polygon_group_attributes': {'attributes': {}},
        'triangles': triangles,
    }


def build_desc(mode):
    if mode in UV_MODES:
        return uv_desc(mode)
    # Live vertex-instance ids are sparse and ascending (as _allocated_indices yields), mapped to a
    # shuffled vertex order. Color is indexed by vertex-instance id over the allocated slots.
    vi_ids = [2, 5, 9]
    vi_elems = [1, 0, 2]
    positions = [0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0, 0.0]
    vi_attrs = {
        'Normal': _attr(1, 3, 3, [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]),
        # A UV channel is serialized over every allocated slot, as Normal and Color are; 12 covers the sparse ids.
        'TextureCoordinate': _attr(2, 2, 12, [0.0, 0.0] * 12),
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
    for mode in COLOUR_MODES + UV_MODES:
        desc = build_desc(mode)
        # Narrow seam: the real StaticMesh.from_package -> parser -> extract_geometry chain runs, with
        # only the raw bulk decode/parse replaced by the synthetic description.
        uncooked.extract_mesh_description_bulk = lambda pkg, d=desc: b'synthetic'
        uncooked.parse_mesh_description = lambda raw, d=desc: d
        mesh = meshmod.StaticMesh.from_package(_FakePackage())
        target = os.path.join(root, mode + '.glb')
        try:
            meshmod.export_glb(mesh, target)
        except ValueError as error:
            # A refused export writes no GLB; the message names the channel or instance it could not carry.
            results[mode] = {'error': str(error)}
            continue
        results[mode] = {'colors': len(getattr(mesh, 'colors', []) or []), 'uv_channels': len(mesh.uvs)}
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

/** The synthetic coordinate of UV channel `channel` at allocated slot `slot`: exact multiples of 1/64, distinct everywhere. */
function uvAt(channel: number, slot: number): number[] {
  return [(channel * 16 + slot) / 64, (slot * 4 + channel) / 64];
}

function onlyPrimitive(document: Awaited<ReturnType<NodeIO["read"]>>): Primitive {
  const primitive = document.getRoot().listMeshes()[0]?.listPrimitives()[0];
  if (!primitive) fail("the writer produced no primitive");
  return primitive;
}

function texcoordAt(primitive: Primitive, channel: number, vertex: number): number[] {
  const values = primitive.getAttribute(`TEXCOORD_${channel}`)?.getArray();
  if (!values) fail(`TEXCOORD_${channel} is missing`);
  return [values[vertex * 2]!, values[vertex * 2 + 1]!];
}

function texcoordSets(primitive: Primitive): string[] {
  return primitive.listSemantics().filter((name) => name.startsWith("TEXCOORD_")).sort();
}

function vertexPositions(primitive: Primitive): string[] {
  const positions = primitive.getAttribute("POSITION")!;
  const values = positions.getArray()!;
  return Array.from({ length: positions.getCount() }, (_, vertex) =>
    [values[vertex * 3]!, values[vertex * 3 + 1]!, values[vertex * 3 + 2]!].map((value) => value.toFixed(2)).join(","),
  );
}

function normalsOf(primitive: Primitive): string[] {
  const normals = primitive.getAttribute("NORMAL")!;
  const values = normals.getArray()!;
  return Array.from({ length: normals.getCount() }, (_, vertex) =>
    [values[vertex * 3]!, values[vertex * 3 + 1]!, values[vertex * 3 + 2]!].map((value) => value.toFixed(2)).join(","),
  );
}

function indicesOf(primitive: Primitive): number[] {
  return Array.from(primitive.getIndices()!.getArray()!);
}

function expectEqual(mode: string, what: string, actual: unknown, expected: unknown): void {
  const got = JSON.stringify(actual);
  const want = JSON.stringify(expected);
  if (got !== want) fail(`${mode}: ${what} is ${got}, expected ${want}`);
}

/** Every file under `directory`, as forward-slash paths relative to it. */
function filesUnder(directory: string, prefix = ""): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(directory, path) : [path];
  });
}

/**
 * Fetches the pinned converter as pip publishes it, before any provisioner patch. The wheel is downloaded with no pip
 * cache into an empty directory, extracted by an isolated interpreter into a second empty directory, and every file it
 * carries is checked against the RECORD that pip wrote when the cached venv was installed. The venv's own copies cannot
 * serve here: the provisioner has patched them, so their hashes no longer match that RECORD.
 */
function fetchPristineModule(
  python: string,
  root: string,
  environment: NodeJS.ProcessEnv,
): { sitePackages: string; wheelSha256: string; verified: number } {
  const wheels = join(root, "wheel");
  const sitePackages = join(root, "pristine");
  mkdirSync(wheels);
  mkdirSync(sitePackages);
  execFileSync(
    python,
    ["-m", "pip", "download", "--disable-pip-version-check", "--no-cache-dir", "--no-deps", "--only-binary=:all:", "--dest", wheels, UNCOOKED_CONVERTER.package],
    { encoding: "utf8", timeout: 300_000, env: environment },
  );
  const downloaded = readdirSync(wheels);
  if (downloaded.length !== 1 || !downloaded[0]!.endsWith(".whl")) fail(`pip did not download exactly one wheel for ${UNCOOKED_CONVERTER.package}`);
  const wheel = join(wheels, downloaded[0]!);
  execFileSync(python, ["-I", "-c", "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", wheel, sitePackages], {
    encoding: "utf8",
    timeout: 120_000,
    env: environment,
  });

  const purelib = execFileSync(python, ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"], {
    encoding: "utf8",
    env: environment,
  }).trim();
  const [name, version] = UNCOOKED_CONVERTER.package.split("==");
  const record = readFileSync(join(purelib, `${name!.replace(/-/g, "_")}-${version}.dist-info`, "RECORD"), "utf8");
  const pinned = new Map<string, { digest: string; size: number }>();
  for (const line of record.split("\n")) {
    const fields = line.trim().split(",");
    const size = fields.pop();
    const digest = fields.pop();
    const path = fields.join(",");
    // Script entries live outside the wheel, and the RECORD of a RECORD cannot describe itself.
    if (!path || !digest || path.startsWith("../") || path.endsWith("/RECORD")) continue;
    pinned.set(path, { digest, size: Number(size) });
  }

  let verified = 0;
  const shipped = filesUnder(sitePackages);
  for (const path of shipped) {
    if (path.endsWith("/RECORD")) continue;
    const bytes = readFileSync(join(sitePackages, path));
    const expected = pinned.get(path);
    if (!expected || expected.digest !== `sha256=${createHash("sha256").update(bytes).digest("base64url")}` || expected.size !== bytes.length) {
      fail(`${path} is not the file the pinned ${UNCOOKED_CONVERTER.package} installs (RECORD mismatch)`);
    }
    verified++;
  }
  // pip writes INSTALLER and REQUESTED at install time, so the wheel legitimately lacks them.
  for (const path of pinned.keys()) {
    if (!shipped.includes(path) && !/\/(INSTALLER|REQUESTED)$/.test(path)) fail(`the pinned RECORD lists ${path}, which the wheel does not carry`);
  }
  return { sitePackages, wheelSha256: createHash("sha256").update(readFileSync(wheel)).digest("hex"), verified };
}

async function main(): Promise<void> {
  // The cached venv is shared and read-only: no child interpreter may write bytecode into its site-packages.
  const environment: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
  const cache = toolchainCacheDir(environment);
  const python = join(cache, "uncooked", "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!existsSync(python)) {
    fail(`the uncooked converter is not provisioned at ${python}; provision it (THREENATIVE_TOOLCHAIN_DIR=${cache}) before running this harness`);
  }

  const root = await mkdtemp(join(tmpdir(), "uncooked-colour-harness-"));
  try {
    const pristine = fetchPristineModule(python, root, environment);
    await patchUncookedModuleSources(join(pristine.sitePackages, "uasset"));

    // The driver sits in its own directory, apart from the untrusted package it imports.
    const driverDir = join(root, "driver");
    mkdirSync(driverDir);
    const driver = join(driverDir, "driver.py");
    await writeFile(driver, DRIVER);

    const output = execFileSync(python, [driver, root], {
      encoding: "utf8",
      timeout: 120_000,
      cwd: pristine.sitePackages,
      env: { ...environment, PYTHONPATH: pristine.sitePackages },
    });
    const counts = JSON.parse(output.trim().split("\n").at(-1)!) as Record<string, { colors?: number; uv_channels?: number; error?: string }>;

    const io = new NodeIO();
    const load = async (mode: string): Promise<Colours> => ({ colors: counts[mode]?.colors ?? fail(`${mode} wrote no GLB`), document: await io.read(join(root, `${mode}.glb`)) });

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

    // UV channels: every channel the source carries is written at its own TEXCOORD index, read at each live
    // vertex instance (2, 5, 9 in local order), and a channel that cannot be written exactly refuses the export.
    const full = onlyPrimitive((await load("uv-full")).document);
    expectEqual("uv-full", "TEXCOORD sets", texcoordSets(full), [0, 1, 2, 3, 4, 5, 6, 7].map((channel) => `TEXCOORD_${channel}`));
    expectEqual("uv-full", "vertex positions", vertexPositions(full), ["0.00,0.00,-10.00", "0.00,0.00,0.00", "10.00,0.00,0.00"]);
    expectEqual("uv-full", "normals", normalsOf(full), ["0.00,0.00,-1.00", "0.00,0.00,-1.00", "0.00,0.00,-1.00"]);
    expectEqual("uv-full", "indices", indicesOf(full), [0, 1, 2]);
    for (let channel = 0; channel < 8; channel++) {
      LIVE_IDS.forEach((slot, local) => expectEqual("uv-full", `TEXCOORD_${channel} at slot ${slot}`, texcoordAt(full, channel, local), uvAt(channel, slot)));
    }

    const seam = onlyPrimitive((await load("uv-seam")).document);
    expectEqual("uv-seam", "vertex positions", vertexPositions(seam), ["0.00,0.00,0.00", "0.00,0.00,-10.00", "10.00,0.00,0.00", "0.00,0.00,0.00"]);
    expectEqual("uv-seam", "normals", normalsOf(seam), ["0.00,0.00,-1.00", "0.00,0.00,-1.00", "0.00,0.00,-1.00", "0.00,0.00,-1.00"]);
    expectEqual("uv-seam", "indices", indicesOf(seam), [0, 1, 2, 3, 2, 1]);
    expectEqual("uv-seam", "TEXCOORD_0 of the two seam instances", [texcoordAt(seam, 0, 0), texcoordAt(seam, 0, 3)], [[0, 0], [0, 0]]);
    expectEqual("uv-seam", "TEXCOORD_1 of the two seam instances", [texcoordAt(seam, 1, 0), texcoordAt(seam, 1, 3)], [[0.25, 0.5], [0.75, 0.5]]);

    expectEqual("uv-two", "TEXCOORD sets", texcoordSets(onlyPrimitive((await load("uv-two")).document)), ["TEXCOORD_0", "TEXCOORD_1"]);
    expectEqual("uv-none", "TEXCOORD sets", texcoordSets(onlyPrimitive((await load("uv-none")).document)), []);

    const hole = onlyPrimitive((await load("uv-hole-nan")).document);
    LIVE_IDS.forEach((slot, local) => expectEqual("uv-hole-nan", `TEXCOORD_1 at slot ${slot}`, texcoordAt(hole, 1, local), uvAt(1, slot)));

    for (const [mode, message] of [
      // No UV reader runs for these, so only the position path can refuse them.
      ["uv-none-negative", "vertex instance -1 is outside the mesh's 10 mapped instances"],
      ["uv-none-above", "vertex instance 10 is outside the mesh's 10 mapped instances"],
      ["uv-none-map-negative", "vertex instance 9 maps to vertex -1, outside the mesh's 3 vertices"],
      ["uv-none-map-above", "vertex instance 9 maps to vertex 3, outside the mesh's 3 vertices"],
      ["uv-excess", "mesh has 9 UV channels; Unreal allows 8"],
      ["uv-short", "UV channel 1 has 6 values and does not cover vertex instance 9"],
      ["uv-nonfinite", "UV channel 1 is not finite at vertex instance 5"],
      ["uv-negative", "vertex instance -1 is outside the mesh's 10 mapped instances"],
    ] as const) {
      expectEqual(mode, "refusal", counts[mode]?.error, message);
      expectEqual(mode, "GLB written", existsSync(join(root, `${mode}.glb`)), false);
    }

    console.log(
      `uncooked-colour-harness: ok — ${UNCOOKED_CONVERTER.package} wheel sha256 ${pristine.wheelSha256}, ${pristine.verified} files match its RECORD, production patches applied; sparse live ids ${LIVE_IDS.join(",")} in ${COLOUR_SLOTS} slots, dense, three no-colour cases, eight UV channels at their own TEXCOORD index, a UV1 seam, absent channels and eight refusals (four with no UV channel), through the installed converter's interpreter`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`uncooked-colour-harness: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
