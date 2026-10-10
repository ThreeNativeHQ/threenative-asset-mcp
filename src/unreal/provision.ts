import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ExternalTool,
  ToolchainError,
  assertSupportedHost,
  childEnvironment,
  resolveExecutable,
  runBounded,
} from "./toolchain.js";
import {
  CUE4PARSE_PATCH,
  CUE4PARSE_ENGINE_CONTENT,
  CUE4PARSE_PROGRAM,
  CUE4PARSE_PROJECT,
  CUE4PARSE_SOURCE,
} from "./cue4parse-adapter.js";

/**
 * The two external executables install themselves on first use. The PRD that specified this flow
 * required the opposite — resolve-or-fail, never auto-install — so that using FabCLI's unofficial
 * Fab API stayed an explicit user act. The owner overruled that on 2026-08-30: an agent that hits
 * "umodel not found" has no way forward, and a tool that cannot run is worse than one that
 * installs. The explicitness survives as an opt-out, not a default:
 * THREENATIVE_TOOLCHAIN_AUTOINSTALL=0 restores resolve-or-fail. Authentication is still never
 * automated — a login is the user's act at their terminal.
 */
export function autoInstallEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = environment.THREENATIVE_TOOLCHAIN_AUTOINSTALL?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export function toolchainCacheDir(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const root =
    environment.THREENATIVE_TOOLCHAIN_DIR?.trim() ||
    join(
      environment.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"),
      "threenative-asset-mcp",
      "toolchain",
    );
  return root;
}

/** UE Viewer has no releases; this is the commit the import contract was proven against. */
export const UEVIEWER_SOURCE = Object.freeze({
  repository: "https://github.com/gildor2/UEViewer.git",
  commit: "a0bfb468d42be831b126632fd8a0ae6b3614f981",
  prebuiltLinux: "https://www.gildor.org/down/47/umodel/umodel_linux.tar.gz",
  prebuiltWindows: "https://www.gildor.org/down/47/umodel/umodel_win32.zip",
  referer: "https://www.gildor.org/en/projects/umodel",
});

export const FABCLI_RELEASE = Object.freeze({
  tag: "v0.1.0",
  base: "https://github.com/zirklerite/FabCLI/releases/download/v0.1.0",
  linux: "fabcli-v0.1.0-linux64.tar.gz",
  windows: "fabcli-v0.1.0-windows64.zip",
  sums: "SHA256SUMS.txt",
});

/** GPL-3.0-or-later command-line converter, always executed out-of-process. */
export const UNCOOKED_CONVERTER = Object.freeze({
  package: "unreal-assets-to-glb==4.27.2.0",
  version: "4.27.2.0+threenative.9",
});

export interface ProvisionLog {
  (message: string): void;
}

const silent: ProvisionLog = () => {};

async function fetchToFile(
  url: string,
  destination: string,
  headers: Record<string, string> = {},
): Promise<Buffer> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "threenative-asset-mcp",
      ...headers,
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new ToolchainError(
      "UNREAL_TOOL_UNUSABLE",
      `Downloading ${url} failed with HTTP ${response.status}.`,
      response.status >= 500,
    );
  }
  const body = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, body);
  return body;
}

async function extractTarGz(archive: string, into: string): Promise<void> {
  await mkdir(into, { recursive: true });
  const run = await runBounded("tar", ["xzf", archive, "-C", into], {
    timeoutMs: 300_000,
  });
  if (run.code !== 0) {
    throw new ToolchainError(
      "UNREAL_TOOL_UNUSABLE",
      `Extracting ${archive} failed (tar exit ${run.code}).`,
    );
  }
}

async function extractZip(archive: string, into: string): Promise<void> {
  const { BlobReader, ZipReader } = await import("@zip.js/zip.js");
  const { Uint8ArrayWriter } = await import("@zip.js/zip.js");
  await mkdir(into, { recursive: true });
  const bytes = await readFile(archive);
  const reader = new ZipReader(new BlobReader(new Blob([new Uint8Array(bytes)])));
  try {
    for (const entry of await reader.getEntries()) {
      if (entry.directory || !entry.getData) continue;
      const target = join(into, entry.filename.replace(/\\/g, "/"));
      if (!target.startsWith(into)) continue;
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, await entry.getData(new Uint8ArrayWriter()));
    }
  } finally {
    await reader.close();
  }
}

async function canRun(executable: string, args: readonly string[], marker: RegExp): Promise<boolean> {
  try {
    const run = await runBounded(executable, args, { timeoutMs: 30_000 });
    return marker.test(`${run.stdout}\n${run.stderr}`);
  } catch {
    return false;
  }
}

/**
 * Installs UE Viewer into the toolchain cache. Gildor publishes a 32-bit Linux build that most
 * current distributions cannot load (libpng12, 32-bit SDL2), so the prebuilt is only ever tried,
 * never trusted: whatever it does, the source build is the fallback that actually produces a
 * runnable binary on a modern host.
 */
export async function provisionUmodel(
  environment: NodeJS.ProcessEnv = process.env,
  log: ProvisionLog = silent,
): Promise<string> {
  assertSupportedHost();
  const cache = join(toolchainCacheDir(environment), "umodel");
  await mkdir(cache, { recursive: true });
  const installed = join(cache, process.platform === "win32" ? "umodel.exe" : "umodel");

  const staging = await mkdtemp(join(tmpdir(), "tn-umodel-"));
  try {
    const isWindows = process.platform === "win32";
    const archive = join(staging, isWindows ? "umodel.zip" : "umodel.tar.gz");
    // The Linux prebuilt is a 32-bit i386 ELF. Without the i386 loader it cannot even start, so a
    // 64-bit-only host goes straight to the source build instead of downloading it to find out.
    const prebuiltRunnable =
      isWindows || (await access("/lib/ld-linux.so.2").then(() => true, () => false));
    if (!prebuiltRunnable) {
      log("UE Viewer's Linux prebuilt is 32-bit and this host has no i386 loader; building from source.");
    } else {
      log("Downloading UE Viewer prebuilt binary…");
      try {
        await fetchToFile(
          isWindows ? UEVIEWER_SOURCE.prebuiltWindows : UEVIEWER_SOURCE.prebuiltLinux,
          archive,
          { referer: UEVIEWER_SOURCE.referer },
        );
        const unpacked = join(staging, "prebuilt");
        if (isWindows) await extractZip(archive, unpacked);
        else await extractTarGz(archive, unpacked);
        const candidate = join(unpacked, isWindows ? "umodel.exe" : "umodel");
        await chmod(candidate, 0o755).catch(() => {});
        if (await canRun(candidate, ["-version"], /UE Viewer/i)) {
          await rename(candidate, installed).catch(async () => {
            await writeFile(installed, await readFile(candidate));
            await chmod(installed, 0o755);
          });
          log(`Installed prebuilt UE Viewer at ${installed}`);
          return installed;
        }
        log("Prebuilt UE Viewer cannot run on this host; building from source.");
      } catch (error) {
        log(
          `Prebuilt UE Viewer unavailable (${error instanceof Error ? error.name : "error"}); building from source.`,
        );
      }
    }

    if (process.platform !== "linux") {
      throw new ToolchainError(
        "UNREAL_TOOL_UNUSABLE",
        "UE Viewer could not be installed automatically on this host. Install it from https://www.gildor.org/en/projects/umodel and set THREENATIVE_UMODEL_PATH.",
      );
    }

    log("Building UE Viewer from source (one time, ~2 minutes)…");
    const source = join(staging, "UEViewer");
    await mkdir(source, { recursive: true });
    const initialized = await runBounded("git", ["init", "--quiet"], {
      cwd: source,
      timeoutMs: 30_000,
    });
    const remote = initialized.code === 0
      ? await runBounded("git", ["remote", "add", "origin", UEVIEWER_SOURCE.repository], {
          cwd: source,
          timeoutMs: 30_000,
        })
      : initialized;
    const fetched = remote.code === 0
      ? await runBounded("git", ["fetch", "--depth", "1", "origin", UEVIEWER_SOURCE.commit], {
          cwd: source,
          timeoutMs: 600_000,
        })
      : remote;
    const checkedOut = fetched.code === 0
      ? await runBounded("git", ["checkout", "--detach", UEVIEWER_SOURCE.commit], {
          cwd: source,
          timeoutMs: 60_000,
        })
      : fetched;
    if (checkedOut.code !== 0) {
      throw new ToolchainError(
        "UNREAL_TOOL_UNUSABLE",
        "The pinned UE Viewer source commit could not be fetched. Install umodel manually and set THREENATIVE_UMODEL_PATH.",
      );
    }
    const build = await runBounded("./build.sh", [], {
      cwd: source,
      timeoutMs: 1_800_000,
      maxOutputBytes: 64 * 1024 * 1024,
    });
    const built = join(source, "umodel");
    if (build.code !== 0 || !(await canRun(built, ["-version"], /UE Viewer/i))) {
      throw new ToolchainError("UNREAL_TOOL_UNUSABLE", umodelBuildFailure(`${build.stdout}\n${build.stderr}`));
    }
    await writeFile(installed, await readFile(built));
    await chmod(installed, 0o755);
    log(`Built UE Viewer at ${installed}`);
    return installed;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Debian/Ubuntu packages for the headers and tools UE Viewer's build.sh needs. */
const UMODEL_BUILD_PACKAGES: Readonly<Record<string, string>> = {
  "png.h": "libpng-dev",
  "SDL.h": "libsdl2-dev",
  "zlib.h": "zlib1g-dev",
  "g++": "g++",
  "c++": "g++",
  perl: "perl",
};

/**
 * Names what a failed UE Viewer source build was missing, from the build's own output. On a fresh
 * Debian 13 host the fixed list of prerequisites sent people after SDL2 while the compiler was
 * asking for png.h.
 */
export function umodelBuildFailure(output: string): string {
  const fallback = "Install umodel yourself and set THREENATIVE_UMODEL_PATH.";
  const header = /fatal error: (?:[\w./]+\/)?([\w.+-]+\.h): No such file/.exec(output)?.[1];
  const tool = /(?:^|\s)(g\+\+|c\+\+|perl)(?::| -)[^\n]*(?:not found|No such file)/m.exec(output)?.[1];
  const missing = header ?? tool;
  if (missing) {
    const pkg = UMODEL_BUILD_PACKAGES[missing];
    return pkg
      ? `UE Viewer could not be built here: ${missing} is missing. On Debian/Ubuntu install it with \`sudo apt install ${pkg}\` and retry, or ${fallback.charAt(0).toLowerCase()}${fallback.slice(1)}`
      : `UE Viewer could not be built here: ${missing} is missing; install the development package that provides it and retry, or ${fallback.charAt(0).toLowerCase()}${fallback.slice(1)}`;
  }
  return `UE Viewer could not be built here. It needs g++, perl, and the zlib, libpng and SDL2 development headers. ${fallback}`;
}

/** The shallowest file named `name` inside an unpacked archive, or undefined. */
async function findArchiveEntry(root: string, name: string): Promise<string | undefined> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name === name)
    .map((entry) => join(entry.parentPath, entry.name))
    .sort((left, right) => left.split(/[\\/]/).length - right.split(/[\\/]/).length)[0];
}

/** Installs FabCLI from its public GitHub release, checked against the release SHA256SUMS file. */
export async function provisionFabcli(
  environment: NodeJS.ProcessEnv = process.env,
  log: ProvisionLog = silent,
): Promise<string> {
  assertSupportedHost();
  const cache = join(toolchainCacheDir(environment), "fabcli");
  await mkdir(cache, { recursive: true });
  const installed = join(cache, process.platform === "win32" ? "fabcli.exe" : "fabcli");

  const staging = await mkdtemp(join(tmpdir(), "tn-fabcli-"));
  try {
    const isWindows = process.platform === "win32";
    const assetName = isWindows ? FABCLI_RELEASE.windows : FABCLI_RELEASE.linux;
    log(`Downloading FabCLI ${FABCLI_RELEASE.tag}…`);
    const archive = join(staging, assetName);
    const bytes = await fetchToFile(`${FABCLI_RELEASE.base}/${assetName}`, archive);
    const sumsFile = join(staging, FABCLI_RELEASE.sums);
    await fetchToFile(`${FABCLI_RELEASE.base}/${FABCLI_RELEASE.sums}`, sumsFile);
    const sums = await readFile(sumsFile, "utf8");
    const expected = sums
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find((parts) => parts[1]?.replace(/^\*/, "") === assetName)?.[0];
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (!expected || expected.toLowerCase() !== actual) {
      throw new ToolchainError(
        "UNREAL_TOOL_UNUSABLE",
        `FabCLI download did not match the published SHA-256 for ${assetName}.`,
      );
    }
    const unpacked = join(staging, "unpacked");
    if (isWindows) await extractZip(archive, unpacked);
    else await extractTarGz(archive, unpacked);
    // Release archives wrap the binary in a `fabcli-<tag>-<platform>/` folder; older ones did not.
    const candidate = await findArchiveEntry(unpacked, isWindows ? "fabcli.exe" : "fabcli");
    if (candidate) await chmod(candidate, 0o755).catch(() => {});
    if (!candidate || !(await canRun(candidate, ["--version"], /fabcli/i))) {
      throw new ToolchainError(
        "UNREAL_TOOL_UNUSABLE",
        "The downloaded FabCLI binary does not run on this host. Install it yourself and set THREENATIVE_FABCLI_PATH.",
      );
    }
    await writeFile(installed, await readFile(candidate));
    await chmod(installed, 0o755);
    log(`Installed FabCLI at ${installed}`);
    return installed;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function pythonExecutable(environment: NodeJS.ProcessEnv): Promise<string> {
  const safeEnvironment = childEnvironment(environment);
  for (const candidate of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    try {
      const run = await runBounded(candidate, ["--version"], { timeoutMs: 30_000, environment: safeEnvironment });
      if (run.code === 0 && /Python 3\.(?:1\d|[89])/.test(`${run.stdout}${run.stderr}`)) return candidate;
    } catch {
      // Try the next conventional executable name.
    }
  }
  throw new ToolchainError(
    "UNREAL_TOOL_UNUSABLE",
    "Converting uncooked Unreal editor meshes requires Python 3.10 or newer; no usable Python 3 executable was found.",
  );
}

function replaceRequired(source: string, before: string, after: string, label: string): string {
  // `after` contains `before` for the append-style patches, so check it first: a second application is
  // a no-op rather than appending the inserted lines again.
  if (source.includes(after)) return source;
  if (!source.includes(before)) {
    throw new ToolchainError(
      "UNREAL_TOOL_UNUSABLE",
      `The pinned uncooked converter no longer matches the verified ${label} patch.`,
    );
  }
  return source.replace(before, after);
}

/** The pinned converter's package-owner constants sit a step below Unreal's own, which reads the
 * PersistentGuid header fields out of phase. Align both gates before the header patches below run. */
export function patchUncookedPackageVersionGates(source: string): string {
  source = replaceRequired(source, "VER_UE4_ADDED_PACKAGE_OWNER = 517", "VER_UE4_ADDED_PACKAGE_OWNER = 518", "UE4 package-owner start version");
  return replaceRequired(source, "VER_UE4_NON_OUTER_PACKAGE_IMPORT = 519", "VER_UE4_NON_OUTER_PACKAGE_IMPORT = 520", "UE4 package-owner end version");
}

/**
 * Teaches the uncooked MeshDescription parser to read the per-vertex-instance ``Color`` attribute,
 * which ``extract_geometry`` read as Normal/TextureCoordinate only and dropped. Unreal's editor meshes
 * (the Hornbeam UE 5.1 foliage icons) store a linear FVector4f here; a material that samples VertexColor
 * multiplies it into the base colour, so without it those pieces render as the material's untinted
 * default.
 *
 * Like ``Normal`` and ``TextureCoordinate``, the ``Color`` attribute is a ``TArray`` indexed by
 * vertex-instance *element* ID: Unreal serializes it over the allocated slots, so holes between live
 * instances are retained and ``color_values[vi]`` is instance ``vi``'s colour. It is therefore returned
 * as read (never re-zipped through the live-id list), and only when the serialized array matches the
 * source's allocated slot count (``num_elements``) and spans every live instance. A truncated array or
 * an instance id past its end cannot be trusted, so no colour is written rather than a fabricated white
 * for a malformed record. Mirrors the cooked writer (`EditorVertexColor`) in `cue4parse-adapter.ts`.
 */
export function patchUncookedMeshDescriptionColors(source: string): string {
  source = replaceRequired(
    source,
    `    # --- Normals (per vertex instance, FVector) ---
    normals = []
    normal_entry = vi_attrs.get('Normal')
    if normal_entry and normal_entry['type'] == 1 and normal_entry['arrays']:
        normals = _bulk_floats(normal_entry, 3)

    # --- UV channels (per vertex instance, FVector2D) ---`,
    `    # --- Normals (per vertex instance, FVector) ---
    normals = []
    normal_entry = vi_attrs.get('Normal')
    if normal_entry and normal_entry['type'] == 1 and normal_entry['arrays']:
        normals = _bulk_floats(normal_entry, 3)

    # --- Vertex colours (per vertex instance, FVector4) ---
    # Indexed by vertex-instance ID (holes retained), so it is used as read. Accept it only when the
    # array matches the source's allocated slot count and every live instance is inside it; otherwise
    # leave it empty so no COLOR_0 (and no invented white) is written for a malformed record.
    colors = []
    color_entry = vi_attrs.get('Color')
    if color_entry and color_entry['type'] == 0 and color_entry['arrays']:
        color_values = _bulk_floats(color_entry, 4)
        allocated = color_entry.get('num_elements')
        if (isinstance(allocated, int) and allocated > 0 and vi_ids
                and len(color_values) == allocated and max(vi_ids) < allocated):
            colors = color_values

    # --- UV channels (per vertex instance, FVector2D) ---`,
    "uncooked vertex colours",
  );
  return replaceRequired(
    source,
    `        'normals': normals,
        'uvs': uv_channels,`,
    `        'normals': normals,
        'colors': colors,
        'uvs': uv_channels,`,
    "uncooked vertex colours in geometry",
  );
}

/**
 * Carries the decoded per-vertex-instance colours from `StaticMesh.from_package` through the GLB
 * writer as glTF `COLOR_0`. Only the uncooked branch fills `mesh.colors`; the cooked/fallback branch
 * leaves it empty, and an empty buffer writes no `COLOR_0` at all. The accessor is normalized
 * UNSIGNED_BYTE RGBA holding the packed value Unreal's shader reads (sRGB RGB, linear alpha), matching
 * the cooked writer.
 */
export function patchUncookedMeshColorExport(source: string): string {
  source = replaceRequired(
    source,
    `        self.uvs: List[List[Tuple[float, float]]] = []  # list of UV channels`,
    `        self.uvs: List[List[Tuple[float, float]]] = []  # list of UV channels
        # Per vertex instance, linear RGBA from the source's Color attribute; empty when absent.
        self.colors: List[Optional[Tuple[float, float, float, float]]] = []`,
    "StaticMesh colours field",
  );
  source = replaceRequired(
    source,
    `                mesh.uvs = geo['uvs']
                mesh.triangles = geo['triangles']`,
    `                mesh.uvs = geo['uvs']
                mesh.colors = geo.get('colors') or []
                mesh.triangles = geo['triangles']`,
    "StaticMesh colours transport",
  );
  source = replaceRequired(
    source,
    `    uvs = mesh.uvs[0] if mesh.uvs else []
    has_normals = bool(mesh.normals)
    has_uvs = bool(uvs)`,
    `    uvs = mesh.uvs[0] if mesh.uvs else []
    has_normals = bool(mesh.normals)
    has_uvs = bool(uvs)
    has_colors = bool(mesh.colors)`,
    "GLB colour presence",
  );
  source = replaceRequired(
    source,
    `                    if has_uvs and vi < len(uvs):
                        u, v = uvs[vi]
                    else:
                        u, v = 0.0, 0.0

                    local_verts.append((px, py, pz, nx, ny, nz, u, v))`,
    `                    if has_uvs and vi < len(uvs):
                        u, v = uvs[vi]
                    else:
                        u, v = 0.0, 0.0

                    # Colour — per vertex instance; Unreal's default white when the mesh has no
                    # colour buffer or the instance is outside it.
                    if has_colors and vi < len(mesh.colors) and mesh.colors[vi] is not None:
                        cr, cg, cb, ca = mesh.colors[vi]
                    else:
                        cr, cg, cb, ca = 1.0, 1.0, 1.0, 1.0

                    local_verts.append((px, py, pz, nx, ny, nz, u, v, cr, cg, cb, ca))`,
    "GLB per-instance colour",
  );
  source = replaceRequired(
    source,
    `        pos_arr = np.array([(v[0], v[1], v[2]) for v in local_verts], dtype=np.float32)
        norm_arr = np.array([(v[3], v[4], v[5]) for v in local_verts], dtype=np.float32)
        uv_arr = np.array([(v[6], v[7]) for v in local_verts], dtype=np.float32)`,
    `        pos_arr = np.array([(v[0], v[1], v[2]) for v in local_verts], dtype=np.float32)
        norm_arr = np.array([(v[3], v[4], v[5]) for v in local_verts], dtype=np.float32)
        uv_arr = np.array([(v[6], v[7]) for v in local_verts], dtype=np.float32)
        color_arr = np.array([(v[8], v[9], v[10], v[11]) for v in local_verts], dtype=np.float32)`,
    "GLB colour array",
  );
  source = replaceRequired(
    source,
    `    COMP_FLOAT = 5126
    COMP_UNSIGNED_SHORT = 5123
    COMP_UNSIGNED_INT = 5125`,
    `    COMP_FLOAT = 5126
    COMP_UNSIGNED_SHORT = 5123
    COMP_UNSIGNED_INT = 5125
    COMP_UNSIGNED_BYTE = 5121`,
    "GLB unsigned-byte component type",
  );
  source = replaceRequired(
    source,
    `        # UV accessor
        uv_acc = None
        if has_uvs:
            uv_bv = _add_buffer_view(uv_arr.tobytes(), target=ARRAY_BUFFER)
            uv_acc = _add_accessor(uv_bv, COMP_FLOAT, num_verts, "VEC2")

        # Index accessor`,
    `        # UV accessor
        uv_acc = None
        if has_uvs:
            uv_bv = _add_buffer_view(uv_arr.tobytes(), target=ARRAY_BUFFER)
            uv_acc = _add_accessor(uv_bv, COMP_FLOAT, num_verts, "VEC2")

        # Vertex colour accessor — normalized UNSIGNED_BYTE RGBA in the channel order Unreal's shader
        # reads. The source's Color is a linear FVector4, but the static-mesh build packs it with
        # FLinearColor::ToFColor(true): sRGB-encode RGB (standard .0031308 breakpoint), keep alpha linear,
        # then floor(channel * 255.999). VET_Color reads that byte / 255 with no gamma decode, so COLOR_0
        # carries the shader value, not the raw linear source.
        color_acc = None
        if has_colors:
            rgb = np.clip(color_arr[:, :3], 0.0, 1.0)
            srgb = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(rgb, 1.0 / 2.4) - 0.055)
            alpha = np.clip(color_arr[:, 3:4], 0.0, 1.0)
            packed = np.concatenate([srgb, alpha], axis=1)
            color_bytes = np.clip(np.floor(packed * 255.999), 0.0, 255.0).astype(np.uint8).tobytes()
            color_bv = _add_buffer_view(color_bytes, target=ARRAY_BUFFER)
            color_acc = _add_accessor(color_bv, COMP_UNSIGNED_BYTE, num_verts, "VEC4")
            accessors[color_acc].normalized = True

        # Index accessor`,
    "GLB colour accessor",
  );
  return replaceRequired(
    source,
    `        if uv_acc is not None:
            prim.attributes.TEXCOORD_0 = uv_acc
        prim.indices = idx_acc`,
    `        if uv_acc is not None:
            prim.attributes.TEXCOORD_0 = uv_acc
        if color_acc is not None:
            prim.attributes.COLOR_0 = color_acc
        prim.indices = idx_acc`,
    "GLB colour attribute",
  );
}

/**
 * Installs the GPL converter in its own virtual environment and applies narrow compatibility
 * fixes to that external program. The fixes preserve uncooked-package PersistentGuid fields,
 * preserve numbered FNames (M_Wood_2), and make --skip-textures actually skip its multi-gigabyte
 * pixel cache. A fourth patch exposes its existing level parser as bounded JSON instead of starting
 * a preview web server. The fifth patch merges serialized Blueprint component templates into
 * placed level instances; it does not execute Blueprint bytecode. A sixth patch decodes bounded
 * UE4 ISM/HISM/foliage matrix arrays for standards-based GPU instancing. A seventh patch decodes
 * editor LandscapeComponent heightmaps from their package-relative bulk payloads. No converter
 * code is linked into this Node package.
 */
export async function provisionUncookedConverter(
  environment: NodeJS.ProcessEnv = process.env,
  log: ProvisionLog = silent,
): Promise<string> {
  assertSupportedHost();
  const cache = join(toolchainCacheDir(environment), "uncooked");
  const venv = join(cache, "venv");
  const executable = join(
    venv,
    process.platform === "win32" ? "Scripts/unreal-assets-to-glb.exe" : "bin/unreal-assets-to-glb",
  );
  const python = await pythonExecutable(environment);
  const safeEnvironment = childEnvironment(environment);
  // Python console scripts embed the interpreter's absolute path in their shebang, so a venv
  // cannot be built in /tmp and renamed. Build at its final path and remove it on any failure.
  await rm(venv, { recursive: true, force: true });
  await mkdir(cache, { recursive: true });
  try {
    log(`Installing uncooked Unreal converter ${UNCOOKED_CONVERTER.package}…`);
    const create = await runBounded(python, ["-m", "venv", venv], {
      timeoutMs: 300_000,
      environment: safeEnvironment,
    });
    if (create.code !== 0) {
      throw new ToolchainError("UNREAL_TOOL_UNUSABLE", "Python could not create the converter virtual environment.");
    }
    const stagedPython = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const install = await runBounded(
      stagedPython,
      ["-m", "pip", "install", "--disable-pip-version-check", UNCOOKED_CONVERTER.package],
      { timeoutMs: 900_000, maxOutputBytes: 32 * 1024 * 1024, environment: safeEnvironment },
    );
    if (install.code !== 0) {
      throw new ToolchainError(
        "UNREAL_TOOL_UNUSABLE",
        `Installing ${UNCOOKED_CONVERTER.package} failed (pip exit ${install.code}).`,
        true,
      );
    }
    const locate = await runBounded(
      stagedPython,
      ["-c", "import pathlib,uasset; print(pathlib.Path(uasset.__file__).parent)"],
      { timeoutMs: 30_000, environment: safeEnvironment },
    );
    const moduleDir = locate.stdout.trim();
    if (locate.code !== 0 || !moduleDir) {
      throw new ToolchainError("UNREAL_TOOL_UNUSABLE", "The installed converter package could not be located.");
    }

    const packagePath = join(moduleDir, "package.py");
    let packageSource = patchUncookedPackageVersionGates(
      (await readFile(packagePath, "utf8")).replace(/\r\n/g, "\n"),
    );
    packageSource = replaceRequired(
      packageSource,
      `        # 24. PersistentGuid (ObjectVersion >= VER_UE4_ADDED_PACKAGE_OWNER) - SKIPPED for cooked packages\n        # 25. OwnerPersistentGuid (VER_UE4_ADDED_PACKAGE_OWNER <= ObjectVersion < VER_UE4_NON_OUTER_PACKAGE_IMPORT) - SKIPPED for cooked packages\n        # Note: These editor-only fields may not be present in some packages`,
      `        # 24. PersistentGuid exists when editor-only data was not filtered.\n        if (self.package_flags & 0x80000000) == 0 and self.file_version_ue4 >= VER_UE4_ADDED_PACKAGE_OWNER:\n            r.skip(16)\n\n        # 25. OwnerPersistentGuid existed for one package-version window.\n        if ((self.package_flags & 0x80000000) == 0 and\n                VER_UE4_ADDED_PACKAGE_OWNER <= self.file_version_ue4 < VER_UE4_NON_OUTER_PACKAGE_IMPORT):\n            r.skip(16)`,
      "uncooked package-header",
    );
    packageSource = replaceRequired(
      packageSource,
      `            entry.object_name = self.name_map[on_idx] if 0 <= on_idx < len(self.name_map) else f"#{on_idx}"\n\n            if has_package_name:`,
      `            entry.object_name = self.name_map[on_idx] if 0 <= on_idx < len(self.name_map) else f"#{on_idx}"\n            if _on_num > 0:\n                entry.object_name += f"_{_on_num - 1}"\n\n            if has_package_name:`,
      "numbered import FName",
    );
    packageSource = replaceRequired(
      packageSource,
      `            entry.object_name = self.name_map[on_idx] if 0 <= on_idx < len(self.name_map) else f"#{on_idx}"\n\n            entry.object_flags`,
      `            entry.object_name = self.name_map[on_idx] if 0 <= on_idx < len(self.name_map) else f"#{on_idx}"\n            if _on_num > 0:\n                entry.object_name += f"_{_on_num - 1}"\n\n            entry.object_flags`,
      "numbered export FName",
    );
    await writeFile(packagePath, packageSource);

    const cliPath = join(moduleDir, "cli.py");
    let cliSource = (await readFile(cliPath, "utf8")).replace(/\r\n/g, "\n");
    cliSource = replaceRequired(
      cliSource,
      `    base_color_textures = [(fp, n) for fp, n in textures]  # export ALL textures`,
      `    base_color_textures = [] if skip_textures else [(fp, n) for fp, n in textures]`,
      "skip-textures",
    );
    cliSource = replaceRequired(
      cliSource,
      `def find_umap_path(input_dir, umap_filename):`,
      `def export_scene_jsons(input_dir, output_dir):
    """Write bounded, non-interactive level data for the Node importer."""
    import math
    import struct
    from uasset.umap import (
        parse_level, _read_export_properties, _get_vector, _get_rotator,
        _make_ue_transform, _decompose_ue_transform, resolve_package_index,
    )
    os.makedirs(output_dir, exist_ok=True)
    component_types = {
        "SceneComponent", "StaticMeshComponent", "DirectionalLightComponent",
        "PointLightComponent", "SpotLightComponent", "RectLightComponent",
    }
    content_component_types = component_types - {"SceneComponent"}

    def component_key(name):
        suffix = "_GEN_VARIABLE"
        return name[:-len(suffix)] if name.endswith(suffix) else name

    def is_instanced_component(class_name):
        return str(class_name).endswith("InstancedStaticMeshComponent")

    def serialized_properties_end(pkg, export_index):
        """Find the end of tagged UObject properties without trusting optional UE5 offsets."""
        entry = pkg.exports[export_index]
        data = pkg.get_export_data(export_index)
        if data is None:
            return 0
        if entry.script_serialization_start_offset > 0:
            data.seek(entry.script_serialization_start_offset)
            read_properties(data, pkg.name_map, pkg.file_version_ue5)
            return data.position()
        expected = entry.script_serialization_end_offset if entry.script_serialization_end_offset > 0 else None
        best_count, best_end = -1, 0
        for offset in range(min(len(data.data), 256)):
            data.seek(offset)
            try:
                parsed = read_properties(data, pkg.name_map, pkg.file_version_ue5)
                end = data.position()
            except Exception:
                continue
            if expected is not None and abs(end - expected) <= 8:
                return end
            if len(parsed) > best_count:
                best_count, best_end = len(parsed), end
        return best_end

    def read_instance_matrices(pkg, export_index, props):
        """Decode UE4's native BulkSerialize array of 64-byte FMatrix records."""
        import struct
        import math
        import numpy as np
        data_reader = pkg.get_export_data(export_index)
        if data_reader is None:
            return []
        data = data_reader.data
        start = serialized_properties_end(pkg, export_index)
        expected = props.get("NumBuiltInstances", props.get("InstanceCountToRender", 0))
        expected = expected if isinstance(expected, int) and 0 < expected <= 1000000 else 0
        candidates = []
        for offset in range(start, min(len(data) - 8, start + 4096)):
            element_size, count = struct.unpack_from("<ii", data, offset)
            if element_size != 64 or count <= 0 or count > 1000000:
                continue
            if expected and count != expected:
                continue
            end = offset + 8 + count * element_size
            if end > len(data):
                continue
            first = struct.unpack_from("<16f", data, offset + 8)
            last = struct.unpack_from("<16f", data, end - element_size)
            def matrix_is_affine(values):
                return (all(math.isfinite(value) and abs(value) < 1.0e12 for value in values)
                        and abs(values[3]) < 1.0e-4 and abs(values[7]) < 1.0e-4
                        and abs(values[11]) < 1.0e-4 and abs(values[15] - 1.0) < 1.0e-4)
            if matrix_is_affine(first) and matrix_is_affine(last):
                candidates.append((offset, count))
        if len(candidates) != 1:
            return []
        offset, count = candidates[0]
        matrices = []
        for index in range(count):
            values = struct.unpack_from("<16f", data, offset + 8 + index * 64)
            if not all(math.isfinite(value) and abs(value) < 1.0e12 for value in values):
                return []
            # UE FMatrix is row-major with translation in row 3; math helpers use column vectors.
            matrices.append(np.array(values, dtype=float).reshape((4, 4)).T)
        return matrices

    def read_landscape_texture(pkg, export_index):
        """Decode mip 0 from an embedded uncooked UE4 TSF_BGRA8 texture export."""
        import struct
        from uasset.reader import BinaryReader
        from uasset.uncooked_texture import decompress_texture_bulk
        props = _read_export_properties(pkg, export_index)
        source_blob = props.get("Source")
        if not isinstance(source_blob, bytes):
            return None
        try:
            source = read_properties(BinaryReader(source_blob), pkg.name_map, pkg.file_version_ue5)
            width, height = int(source.get("SizeX", 0)), int(source.get("SizeY", 0))
            mip_count = int(source.get("NumMips", 1))
        except Exception:
            return None
        if width <= 0 or height <= 0 or width > 16384 or height > 16384 or mip_count <= 0:
            return None
        expected = sum(max(1, width >> mip) * max(1, height >> mip) * 4
                       for mip in range(min(mip_count, 32)))
        export_data = pkg.get_export_data(export_index)
        if export_data is None:
            return None
        data = export_data.data
        start = serialized_properties_end(pkg, export_index)
        candidates = []
        for offset in range(start, min(len(data) - 19, start + 96)):
            flags = struct.unpack_from("<I", data, offset)[0]
            size_64 = bool(flags & (1 << 13))
            try:
                if size_64:
                    count, size_on_disk, payload_offset = struct.unpack_from("<qqq", data, offset + 4)
                    header_end = offset + 28
                else:
                    count, size_on_disk, payload_offset = struct.unpack_from("<iiq", data, offset + 4)
                    header_end = offset + 20
            except struct.error:
                continue
            if count != expected or size_on_disk <= 0 or size_on_disk > len(pkg.reader.data):
                continue
            if flags & 1:
                absolute = int(payload_offset) + int(pkg.bulk_data_start_offset)
            else:
                absolute = header_end
            if absolute < 0 or absolute + size_on_disk > len(pkg.reader.data):
                continue
            candidates.append((flags, absolute, int(size_on_disk)))
        if len(candidates) != 1:
            return None
        flags, absolute, size_on_disk = candidates[0]
        blob = pkg.reader.data[absolute:absolute + size_on_disk]
        pixels = decompress_texture_bulk(blob) if flags & 2 else blob
        if pixels is None or len(pixels) < width * height * 4:
            return None
        return width, height, pixels[:width * height * 4]

    # Compiled Blueprint component defaults live in the Blueprint package, while placed map
    # components usually serialize only overrides. Index them by generated class and component.
    blueprint_templates = {}
    uassets, _ = find_uasset_files(input_dir)
    for asset_path in sorted(uassets):
        try:
            blueprint_pkg = Package(asset_path)
            for class_index, class_export in enumerate(blueprint_pkg.exports):
                if blueprint_pkg.get_export_class_name(class_index) != "BlueprintGeneratedClass":
                    continue
                components = {}
                for component_index, component_export in enumerate(blueprint_pkg.exports):
                    class_name = blueprint_pkg.get_export_class_name(component_index)
                    if component_export.outer_index != class_index + 1 or class_name not in component_types:
                        continue
                    props = _read_export_properties(blueprint_pkg, component_index)
                    mesh_name = ""
                    mesh_ref = props.get("StaticMesh")
                    if class_name == "StaticMeshComponent" and isinstance(mesh_ref, int):
                        mesh_name = resolve_package_index(blueprint_pkg, mesh_ref)
                    components[component_key(component_export.object_name)] = {
                        "className": class_name,
                        "meshName": mesh_name,
                        "props": props,
                    }
                if components:
                    blueprint_templates[class_export.object_name] = components
        except Exception:
            continue

    _, umaps = find_uasset_files(input_dir)
    written = 0
    for umap_path in sorted(umaps):
        level = parse_level(umap_path)
        pkg = Package(umap_path)
        def vec(value):
            return {"x": float(value[0]), "y": float(value[1]), "z": float(value[2])}
        def rot(value):
            return {"pitch": float(value[0]), "yaw": float(value[1]), "roll": float(value[2])}
        lights = []
        light_types = {
            "DirectionalLightComponent": "directional",
            "PointLightComponent": "point",
            "SpotLightComponent": "spot",
            "RectLightComponent": "rect",
        }
        for export_index, export in enumerate(pkg.exports):
            class_name = pkg.get_export_class_name(export_index)
            light_type = light_types.get(class_name)
            if light_type is None:
                continue
            props = _read_export_properties(pkg, export_index)
            # A Blueprint instance stores inherited values in its component template. Those are
            # handled separately; a component with no intensity here is not a complete light.
            if "Intensity" not in props:
                continue
            actor_name = export.object_name
            if export.outer_index > 0 and export.outer_index <= len(pkg.exports):
                actor_index = export.outer_index - 1
                actor = pkg.exports[actor_index]
                actor_props = _read_export_properties(pkg, actor_index)
                actor_name = actor_props.get("ActorLabel", actor.object_name)
            color = props.get("LightColor", {})
            if isinstance(color, dict):
                channels = [color.get(key, 255) for key in ("r", "g", "b")]
                if max(channels) > 1:
                    channels = [float(channel) / 255.0 for channel in channels]
                else:
                    channels = [float(channel) for channel in channels]
            else:
                channels = [1.0, 1.0, 1.0]
            lights.append({
                "name": str(actor_name) + "/" + str(export.object_name),
                "type": light_type,
                "location": vec(_get_vector(props, "RelativeLocation", (0.0, 0.0, 0.0))),
                "rotation": rot(_get_rotator(props, "RelativeRotation", (0.0, 0.0, 0.0))),
                "color": channels,
                "intensity": float(props.get("Intensity", 1.0)),
                "range": float(props.get("AttenuationRadius", 0.0)) * 0.01,
                "innerConeAngle": float(props.get("InnerConeAngle", 0.0)),
                "outerConeAngle": float(props.get("OuterConeAngle", 44.0)),
                "temperature": float(props.get("Temperature", 6500.0)),
                "useTemperature": bool(props.get("bUseTemperature", False)),
                "sourceWidth": float(props.get("SourceWidth", 0.0)) * 0.01,
                "sourceHeight": float(props.get("SourceHeight", 0.0)) * 0.01,
            })
        scene_actors = [{
            "name": str(actor.name),
            "meshName": str(actor.mesh_name),
            "location": vec(actor.world_location),
            "rotation": rot(actor.world_rotation),
            "scale": vec(actor.world_scale),
            "parent": str(actor.parent),
        } for actor in level.actors]
        instance_groups = []
        all_components = {}
        for component_index, component_export in enumerate(pkg.exports):
            class_name = pkg.get_export_class_name(component_index)
            if not (str(class_name).endswith("Component") or is_instanced_component(class_name)):
                continue
            all_components[component_index] = _read_export_properties(pkg, component_index)

        all_world_cache = {}
        def all_component_world(component_index, visiting=None):
            if component_index in all_world_cache:
                return all_world_cache[component_index]
            props = all_components.get(component_index)
            if props is None:
                return _make_ue_transform((0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (1.0, 1.0, 1.0))
            visiting = set() if visiting is None else visiting
            if component_index in visiting:
                return _make_ue_transform((0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (1.0, 1.0, 1.0))
            visiting.add(component_index)
            local = _make_ue_transform(
                _get_vector(props, "RelativeLocation", (0.0, 0.0, 0.0)),
                _get_rotator(props, "RelativeRotation", (0.0, 0.0, 0.0)),
                _get_vector(props, "RelativeScale3D", (1.0, 1.0, 1.0)),
            )
            parent_ref = props.get("AttachParent", 0)
            parent_index = parent_ref - 1 if isinstance(parent_ref, int) and parent_ref > 0 else -1
            world = all_component_world(parent_index, visiting) @ local if parent_index in all_components else local
            all_world_cache[component_index] = world
            visiting.remove(component_index)
            return world

        for component_index, component_export in enumerate(pkg.exports):
            class_name = pkg.get_export_class_name(component_index)
            if not is_instanced_component(class_name):
                continue
            props = all_components.get(component_index, {})
            matrices = read_instance_matrices(pkg, component_index, props)
            mesh_ref = props.get("StaticMesh")
            mesh_name = resolve_package_index(pkg, mesh_ref) if isinstance(mesh_ref, int) else ""
            if not matrices or not mesh_name:
                continue
            actor_name = str(component_export.object_name)
            if component_export.outer_index > 0 and component_export.outer_index <= len(pkg.exports):
                actor_export = pkg.exports[component_export.outer_index - 1]
                actor_props = _read_export_properties(pkg, component_export.outer_index - 1)
                actor_name = str(actor_props.get("ActorLabel", actor_export.object_name))
            component_transform = all_component_world(component_index)
            transforms = []
            for local_matrix in matrices:
                location, rotation, scale = _decompose_ue_transform(component_transform @ local_matrix)
                transforms.append({
                    "location": vec(location),
                    "rotation": rot(rotation),
                    "scale": vec(scale),
                })
            instance_groups.append({
                "name": actor_name + "/" + str(component_export.object_name),
                "meshName": str(mesh_name),
                "transforms": transforms,
                "parent": actor_name,
                "sourceClass": str(class_name),
            })
        landscapes = []
        landscape_actor_props = {}
        for actor_index, actor_export in enumerate(pkg.exports):
            if pkg.get_export_class_name(actor_index) in ("Landscape", "LandscapeStreamingProxy"):
                landscape_actor_props[actor_index] = _read_export_properties(pkg, actor_index)
        for component_index, component_export in enumerate(pkg.exports):
            if pkg.get_export_class_name(component_index) != "LandscapeComponent":
                continue
            props = all_components.get(component_index, {})
            heightmap_ref = props.get("HeightmapTexture")
            if not isinstance(heightmap_ref, int) or heightmap_ref <= 0:
                continue
            texture_index = heightmap_ref - 1
            if texture_index >= len(pkg.exports) or pkg.get_export_class_name(texture_index) != "Texture2D":
                continue
            decoded = read_landscape_texture(pkg, texture_index)
            if decoded is None:
                continue
            width, height, pixels = decoded
            size_quads = int(props.get("ComponentSizeQuads", 0))
            subsection_quads = int(props.get("SubsectionSizeQuads", 0))
            num_subsections = int(props.get("NumSubsections", 0))
            if (size_quads <= 0 or size_quads > 8192 or subsection_quads <= 0
                    or num_subsections <= 0 or size_quads != subsection_quads * num_subsections):
                continue
            scale_bias = props.get("HeightmapScaleBias")
            if not isinstance(scale_bias, bytes) or len(scale_bias) < 16:
                continue
            _, _, bias_x, bias_y = struct.unpack_from("<4f", scale_bias)
            offset_x = round(bias_x * width)
            offset_y = round(bias_y * height)
            side = size_quads + 1
            heights, normals = [], []
            valid = True
            for y in range(side):
                sub_y, local_y = ((0, 0) if y == 0 else ((y - 1) // subsection_quads, (y - 1) % subsection_quads + 1))
                tex_y = offset_y + sub_y * (subsection_quads + 1) + local_y
                for x in range(side):
                    sub_x, local_x = ((0, 0) if x == 0 else ((x - 1) // subsection_quads, (x - 1) % subsection_quads + 1))
                    tex_x = offset_x + sub_x * (subsection_quads + 1) + local_x
                    if tex_x < 0 or tex_y < 0 or tex_x >= width or tex_y >= height:
                        valid = False
                        break
                    pixel = (tex_y * width + tex_x) * 4
                    blue, green, red, alpha = pixels[pixel:pixel + 4]
                    heights.append(((red << 8) | green) - 32768.0)
                    heights[-1] /= 128.0
                    normal_x = 2.0 * blue / 255.0 - 1.0
                    normal_y = 2.0 * alpha / 255.0 - 1.0
                    normal_z = math.sqrt(max(0.0, 1.0 - normal_x * normal_x - normal_y * normal_y))
                    normals.extend((normal_x, normal_y, normal_z))
                if not valid:
                    break
            if not valid or len(heights) != side * side:
                continue
            location, rotation, scale = _decompose_ue_transform(all_component_world(component_index))
            owner_index = component_export.outer_index - 1 if component_export.outer_index > 0 else -1
            owner_props = landscape_actor_props.get(owner_index, {})
            material_ref = props.get("OverrideMaterial", owner_props.get("LandscapeMaterial"))
            material_name = resolve_package_index(pkg, material_ref) if isinstance(material_ref, int) else ""
            actor_name = str(owner_props.get("ActorLabel", pkg.exports[owner_index].object_name
                             if 0 <= owner_index < len(pkg.exports) else "Landscape"))
            landscapes.append({
                "name": actor_name + "/" + str(component_export.object_name),
                "materialName": str(material_name or "Landscape_Default"),
                "location": vec(location),
                "rotation": rot(rotation),
                "scale": vec(scale),
                "sizeQuads": size_quads,
                "heights": heights,
                "normals": normals,
            })
        blueprint_component_count = 0

        for actor_index, actor_export in enumerate(pkg.exports):
            templates = blueprint_templates.get(pkg.get_export_class_name(actor_index))
            if not templates:
                continue
            actor_props = _read_export_properties(pkg, actor_index)
            actor_name = str(actor_props.get("ActorLabel", actor_export.object_name))
            components = {
                index: export for index, export in enumerate(pkg.exports)
                if export.outer_index == actor_index + 1
                and pkg.get_export_class_name(index) in component_types
            }
            merged = {}
            for component_index, component_export in components.items():
                instance_props = _read_export_properties(pkg, component_index)
                template = templates.get(component_key(component_export.object_name), {})
                props = dict(template.get("props", {}))
                props.update(instance_props)
                merged[component_index] = (template, props, instance_props)

            world_cache = {}
            def component_world(component_index, visiting=None):
                if component_index in world_cache:
                    return world_cache[component_index]
                visiting = set() if visiting is None else visiting
                if component_index in visiting:
                    return _make_ue_transform((0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (1.0, 1.0, 1.0))
                visiting.add(component_index)
                _, props, _ = merged[component_index]
                local = _make_ue_transform(
                    _get_vector(props, "RelativeLocation", (0.0, 0.0, 0.0)),
                    _get_rotator(props, "RelativeRotation", (0.0, 0.0, 0.0)),
                    _get_vector(props, "RelativeScale3D", (1.0, 1.0, 1.0)),
                )
                parent_ref = props.get("AttachParent", 0)
                parent_index = parent_ref - 1 if isinstance(parent_ref, int) and parent_ref > 0 else -1
                world = component_world(parent_index, visiting) @ local if parent_index in merged else local
                world_cache[component_index] = world
                visiting.remove(component_index)
                return world

            for component_index, component_export in components.items():
                template, props, instance_props = merged[component_index]
                class_name = pkg.get_export_class_name(component_index)
                if class_name not in content_component_types:
                    continue
                location, rotation, scale = _decompose_ue_transform(component_world(component_index))
                component_name = actor_name + "/" + str(component_export.object_name)
                if class_name == "StaticMeshComponent":
                    mesh_name = template.get("meshName", "")
                    # A template FPackageIndex belongs to the Blueprint package's import table.
                    # Resolve only an actual map override against the map package here.
                    mesh_ref = instance_props.get("StaticMesh")
                    if isinstance(mesh_ref, int):
                        mesh_name = resolve_package_index(pkg, mesh_ref) or mesh_name
                    if mesh_name:
                        scene_actors.append({
                            "name": component_name,
                            "meshName": str(mesh_name),
                            "location": vec(location),
                            "rotation": rot(rotation),
                            "scale": vec(scale),
                            "parent": actor_name,
                        })
                        blueprint_component_count += 1
                    continue
                light_type = light_types.get(class_name)
                if light_type is None or "Intensity" not in props:
                    continue
                color = props.get("LightColor", {})
                if isinstance(color, dict):
                    channels = [color.get(key, 255) for key in ("r", "g", "b")]
                    channels = ([float(channel) / 255.0 for channel in channels]
                                if max(channels) > 1 else [float(channel) for channel in channels])
                else:
                    channels = [1.0, 1.0, 1.0]
                lights.append({
                    "name": component_name,
                    "type": light_type,
                    "location": vec(location),
                    "rotation": rot(rotation),
                    "color": channels,
                    "intensity": float(props.get("Intensity", 1.0)),
                    "range": float(props.get("AttenuationRadius", 0.0)) * 0.01,
                    "innerConeAngle": float(props.get("InnerConeAngle", 0.0)),
                    "outerConeAngle": float(props.get("OuterConeAngle", 44.0)),
                    "temperature": float(props.get("Temperature", 6500.0)),
                    "useTemperature": bool(props.get("bUseTemperature", False)),
                    "sourceWidth": float(props.get("SourceWidth", 0.0)) * 0.01,
                    "sourceHeight": float(props.get("SourceHeight", 0.0)) * 0.01,
                })
                blueprint_component_count += 1
        payload = {
            "format": "threenative-unreal-scene-source",
            "version": 1,
            "mapName": level.map_name,
            "sourceFile": os.path.relpath(umap_path, input_dir).replace(os.sep, "/"),
            "actors": scene_actors,
            "instanceGroups": instance_groups,
            "landscapes": landscapes,
            "lights": lights,
            "blueprintComponents": blueprint_component_count,
            "camera": {
                "hasCamera": bool(level.has_camera),
                "location": vec(level.camera_location),
                "rotation": rot(level.camera_rotation),
            },
        }
        target = os.path.join(output_dir, level.map_name + ".scene-source.json")
        with open(target, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        written += 1
    print(f"Scene manifests: {written}")
    return written


def find_umap_path(input_dir, umap_filename):`,
      "scene-json exporter",
    );
    cliSource = replaceRequired(
      cliSource,
      `    parser.add_argument(
        '--filter', metavar='SUBSTRING', dest='mesh_filter',
        help='Only export meshes whose name contains this substring (case-insensitive)'
    )`,
      `    parser.add_argument(
        '--filter', metavar='SUBSTRING', dest='mesh_filter',
        help='Only export meshes whose name contains this substring (case-insensitive)'
    )
    parser.add_argument(
        '--scene-json-dir', metavar='DIR',
        help='Write parsed .umap actors/lights/blueprint components/gpu instances/landscapes as JSON without starting the preview server'
    )`,
      "scene-json argument",
    );
    cliSource = replaceRequired(
      cliSource,
      `    else:
        print("Skipping export (using existing Export/ directory)")

    # Preview if requested`,
      `    else:
        print("Skipping export (using existing Export/ directory)")

    if args.scene_json_dir:
        export_scene_jsons(input_dir, os.path.abspath(args.scene_json_dir))

    # Preview if requested`,
      "scene-json invocation",
    );
    await writeFile(cliPath, cliSource);

    const uncookedMeshPath = join(moduleDir, "uncooked_mesh.py");
    let uncookedMeshSource = (await readFile(uncookedMeshPath, "utf8")).replace(/\r\n/g, "\n");
    uncookedMeshSource = patchUncookedMeshDescriptionColors(uncookedMeshSource);
    await writeFile(uncookedMeshPath, uncookedMeshSource);

    const meshPath = join(moduleDir, "mesh.py");
    let meshSource = (await readFile(meshPath, "utf8")).replace(/\r\n/g, "\n");
    meshSource = replaceRequired(
      meshSource,
      `        mat = Material()\n        mat.pbrMetallicRoughness = PbrMetallicRoughness()`,
      `        mat = Material()\n        if mesh.material_slots:\n            slot_idx = (mesh.section_info_map[mat_idx]\n                        if mesh.section_info_map and mat_idx < len(mesh.section_info_map)\n                        else mat_idx)\n            if slot_idx < len(mesh.material_slots):\n                mat.name = mesh.material_slots[slot_idx][1]\n        mat.pbrMetallicRoughness = PbrMetallicRoughness()`,
      "material names",
    );
    meshSource = patchUncookedMeshColorExport(meshSource);
    await writeFile(meshPath, meshSource);

    if (!(await canRun(executable, ["--help"], /gpu instances\/landscapes/))) {
      throw new ToolchainError("UNREAL_TOOL_UNUSABLE", "The patched uncooked converter does not run.");
    }
    log(`Installed uncooked Unreal converter at ${executable}`);
    return executable;
  } catch (error) {
    await rm(venv, { recursive: true, force: true });
    throw error;
  }
}

const DOTNET_SDK_VERSION = "10.0.400";

async function ensureDotnetSdk(
  environment: NodeJS.ProcessEnv,
  cache: string,
  log: ProvisionLog,
): Promise<string> {
  const safeEnvironment = childEnvironment(environment);
  try {
    const run = await runBounded("dotnet", ["--version"], { timeoutMs: 30_000, environment: safeEnvironment });
    if (run.code === 0 && /^10\./.test(run.stdout.trim())) return "dotnet";
  } catch {
    // Install the pinned SDK below.
  }
  const sdkRoot = join(cache, "dotnet");
  const executable = join(sdkRoot, process.platform === "win32" ? "dotnet.exe" : "dotnet");
  if (await canRun(executable, ["--version"], /^10\./m)) return executable;
  await mkdir(sdkRoot, { recursive: true });
  log(`Installing .NET SDK ${DOTNET_SDK_VERSION} for the modern Unreal decoder…`);
  const installer = join(cache, process.platform === "win32" ? "dotnet-install.ps1" : "dotnet-install.sh");
  await fetchToFile(
    process.platform === "win32"
      ? "https://dot.net/v1/dotnet-install.ps1"
      : "https://dot.net/v1/dotnet-install.sh",
    installer,
  );
  if (process.platform !== "win32") await chmod(installer, 0o755);
  const install = process.platform === "win32"
    ? await runBounded("powershell", ["-NoProfile", "-File", installer, "-Version", DOTNET_SDK_VERSION, "-InstallDir", sdkRoot], {
        timeoutMs: 900_000,
        maxOutputBytes: 32 * 1024 * 1024,
        environment: safeEnvironment,
      })
    : await runBounded(installer, ["--version", DOTNET_SDK_VERSION, "--install-dir", sdkRoot, "--no-path"], {
        timeoutMs: 900_000,
        maxOutputBytes: 32 * 1024 * 1024,
        environment: safeEnvironment,
      });
  if (install.code !== 0 || !(await canRun(executable, ["--version"], /^10\./m))) {
    throw new ToolchainError("UNREAL_TOOL_UNUSABLE", `Installing .NET SDK ${DOTNET_SDK_VERSION} failed.`);
  }
  return executable;
}

/** Builds the pinned CUE4Parse adapter as a self-contained process; Unreal Engine is not needed. */
export async function provisionModernConverter(
  environment: NodeJS.ProcessEnv = process.env,
  log: ProvisionLog = silent,
): Promise<string> {
  assertSupportedHost();
  const cache = join(toolchainCacheDir(environment), "modern");
  const bin = join(cache, "bin");
  const executable = join(bin, process.platform === "win32" ? "ThreeNativeConverter.exe" : "ThreeNativeConverter");
  await mkdir(cache, { recursive: true });
  const dotnet = await ensureDotnetSdk(environment, cache, log);
  const source = join(cache, "source");
  await rm(source, { recursive: true, force: true });
  await mkdir(source, { recursive: true });
  try {
    log(`Building modern Unreal decoder ${CUE4PARSE_SOURCE.version} (one time, ~3 minutes)…`);
    const safeEnvironment = childEnvironment(environment);
    for (const args of [
      ["init"],
      ["remote", "add", "origin", CUE4PARSE_SOURCE.repository],
      ["fetch", "--depth", "1", "origin", CUE4PARSE_SOURCE.commit],
      ["checkout", "--detach", "FETCH_HEAD"],
    ]) {
      const run = await runBounded("git", args, { cwd: source, timeoutMs: 600_000, environment: safeEnvironment });
      if (run.code !== 0) throw new ToolchainError("UNREAL_TOOL_UNUSABLE", "The pinned CUE4Parse source could not be fetched.", true);
    }
    const patchPath = join(source, "threenative-skeletal.patch");
    await writeFile(patchPath, CUE4PARSE_PATCH);
    const applied = await runBounded("git", ["apply", "--check", patchPath], { cwd: source, timeoutMs: 30_000, environment: safeEnvironment });
    if (applied.code !== 0) throw new ToolchainError("UNREAL_TOOL_UNUSABLE", "The pinned CUE4Parse source did not match the verified skeletal decoder patch.");
    const apply = await runBounded("git", ["apply", patchPath], { cwd: source, timeoutMs: 30_000, environment: safeEnvironment });
    if (apply.code !== 0) throw new ToolchainError("UNREAL_TOOL_UNUSABLE", "Applying the verified CUE4Parse skeletal decoder patch failed.");
    const adapter = join(source, "ThreeNativeConverter");
    await mkdir(adapter, { recursive: true });
    const project = join(adapter, "ThreeNativeConverter.csproj");
    await writeFile(project, CUE4PARSE_PROJECT);
    await writeFile(join(adapter, "Program.cs"), CUE4PARSE_PROGRAM);
    await writeFile(join(adapter, "EngineContent.cs"), CUE4PARSE_ENGINE_CONTENT);
    await rm(bin, { recursive: true, force: true });
    const runtime = process.platform === "win32"
      ? process.arch === "arm64" ? "win-arm64" : "win-x64"
      : process.arch === "arm64" ? "linux-arm64" : "linux-x64";
    const publish = await runBounded(dotnet, ["publish", project, "-c", "Release", "-r", runtime, "--self-contained", "true", "-o", bin], {
      timeoutMs: 1_800_000,
      maxOutputBytes: 64 * 1024 * 1024,
      environment: safeEnvironment,
    });
    if (publish.code !== 0 || !(await canRun(executable, ["--version"], new RegExp(CUE4PARSE_SOURCE.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))))) {
      throw new ToolchainError("UNREAL_TOOL_UNUSABLE", "The modern Unreal decoder could not be built from the pinned source.");
    }
    log(`Installed modern Unreal decoder at ${executable}`);
    return executable;
  } catch (error) {
    await rm(bin, { recursive: true, force: true });
    throw error;
  }
}

async function resolveOrProvision(
  name: "umodel" | "fabcli" | "uncooked" | "modern",
  environment: NodeJS.ProcessEnv,
  log: ProvisionLog,
): Promise<string> {
  try {
    const found = await resolveExecutable(name, environment);
    // A PATH umodel is whatever the user happened to install; the 2022 upstream release rejects
    // `-psk`, which every animation export passes. An explicit override stays the user's call.
    if (name !== "umodel" || environment.THREENATIVE_UMODEL_PATH?.trim() || (await canRun(found, UMODEL_PROBE, /UE Viewer/i))) {
      return found;
    }
    log(`Ignoring ${found}: that UE Viewer build does not accept -psk.`);
    throw new ToolchainError("UNREAL_TOOL_NOT_FOUND", `${found} does not accept -psk; no capable UE Viewer was found.`);
  } catch (error) {
    if (!(error instanceof ToolchainError) || error.code !== "UNREAL_TOOL_NOT_FOUND") throw error;
    const cached = name === "uncooked"
      ? join(
          toolchainCacheDir(environment),
          "uncooked",
          "venv",
          process.platform === "win32" ? "Scripts/unreal-assets-to-glb.exe" : "bin/unreal-assets-to-glb",
        )
      : name === "modern"
        ? join(toolchainCacheDir(environment), "modern", "bin", process.platform === "win32" ? "ThreeNativeConverter.exe" : "ThreeNativeConverter")
        : join(
          toolchainCacheDir(environment),
          name,
          process.platform === "win32" ? `${name}.exe` : name,
        );
    const marker = name === "umodel"
      ? /UE Viewer/i
      : name === "fabcli"
        ? /fabcli/i
        : name === "modern"
          ? new RegExp(CUE4PARSE_SOURCE.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          : /gpu instances\/landscapes/;
    const probe = name === "umodel" ? UMODEL_PROBE : name === "fabcli" ? ["--version"] : name === "modern" ? ["--version"] : ["--help"];
    if (await canRun(cached, probe, marker)) return cached;
    if (!autoInstallEnabled(environment)) throw error;
    if (name === "umodel") return await provisionUmodel(environment, log);
    if (name === "fabcli") return await provisionFabcli(environment, log);
    if (name === "modern") return await provisionModernConverter(environment, log);
    return await provisionUncookedConverter(environment, log);
  }
}

const UMODEL_VERSION = /^UE Viewer.*$\n^(Compiled .*)$/m;

/** Prints the banner only when the build parses `-psk`; older builds fail the command line first. */
export const UMODEL_PROBE = ["-export", "-psk", "-version"] as const;

/** UE Viewer, resolved from the environment, PATH, the toolchain cache, or a fresh install. */
export async function ensureUmodel(
  environment: NodeJS.ProcessEnv = process.env,
  log: ProvisionLog = silent,
): Promise<ExternalTool> {
  assertSupportedHost();
  const path = await resolveOrProvision("umodel", environment, log);
  const run = await runBounded(path, UMODEL_PROBE, { timeoutMs: 30_000 });
  const text = `${run.stdout}\n${run.stderr}`;
  if (!/UE Viewer/i.test(text)) {
    throw new ToolchainError(
      "UNREAL_TOOL_UNUSABLE",
      /invalid option: -psk/.test(text)
        ? `"${path}" is a UE Viewer build too old to accept -psk, which animation export needs. Unset THREENATIVE_UMODEL_PATH to let the importer provision a current build.`
        : `"${path}" does not identify itself as UE Viewer (umodel).`,
    );
  }
  return {
    name: "umodel",
    path,
    version: UMODEL_VERSION.exec(text)?.[1]?.trim() ?? "UE Viewer (unversioned)",
  };
}

/** FabCLI, resolved the same way. Installing it never logs in — that stays the user's act. */
export async function ensureFabcli(
  environment: NodeJS.ProcessEnv = process.env,
  log: ProvisionLog = silent,
): Promise<ExternalTool> {
  assertSupportedHost();
  const path = await resolveOrProvision("fabcli", environment, log);
  const run = await runBounded(path, ["--version"], { timeoutMs: 30_000 });
  const text = `${run.stdout}${run.stderr}`.trim();
  if (!/fabcli/i.test(text)) {
    throw new ToolchainError(
      "UNREAL_TOOL_UNUSABLE",
      `"${path}" does not identify itself as fabcli.`,
    );
  }
  return { name: "fabcli", path, version: text.split("\n")[0]?.trim() ?? "fabcli" };
}

/** Uncooked UE4.26/4.27 MeshDescription converter, isolated as an external GPL process. */
export async function ensureUncookedConverter(
  environment: NodeJS.ProcessEnv = process.env,
  log: ProvisionLog = silent,
): Promise<ExternalTool> {
  assertSupportedHost();
  const path = await resolveOrProvision("uncooked", environment, log);
  const run = await runBounded(path, ["--help"], { timeoutMs: 30_000 });
  if (!/UE 4\.27 UAsset Parser/.test(`${run.stdout}${run.stderr}`) || !/gpu instances\/landscapes/.test(`${run.stdout}${run.stderr}`)) {
    throw new ToolchainError("UNREAL_TOOL_UNUSABLE", `"${path}" is not the expected uncooked Unreal converter.`);
  }
  return { name: "uncooked", path, version: UNCOOKED_CONVERTER.version };
}

export async function ensureModernConverter(
  environment: NodeJS.ProcessEnv = process.env,
  log: ProvisionLog = silent,
): Promise<ExternalTool> {
  assertSupportedHost();
  const path = await resolveOrProvision("modern", environment, log);
  const run = await runBounded(path, ["--version"], { timeoutMs: 30_000 });
  if (!`${run.stdout}${run.stderr}`.includes(CUE4PARSE_SOURCE.version)) {
    throw new ToolchainError("UNREAL_TOOL_UNUSABLE", `"${path}" is not the expected modern Unreal converter.`);
  }
  return { name: "modern", path, version: CUE4PARSE_SOURCE.version };
}

/**
 * The .NET 10 SDK that builds the modern converter, found without installing one: the host's `dotnet` or the copy the
 * provisioner cached. A test that compiles against the pinned CUE4Parse source uses it; a missing SDK is a provisioning
 * failure, so the test refuses rather than installing from inside a test.
 */
export async function modernSdkExecutable(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const host = await runBounded("dotnet", ["--version"], { timeoutMs: 30_000, environment: childEnvironment(environment) }).catch(() => undefined);
  if (host?.code === 0 && /^10\./.test(host.stdout.trim())) return "dotnet";
  const cached = join(toolchainCacheDir(environment), "modern", "dotnet", process.platform === "win32" ? "dotnet.exe" : "dotnet");
  if (await canRun(cached, ["--version"], /^10\./m)) return cached;
  throw new ToolchainError("UNREAL_TOOL_NOT_FOUND", "The .NET 10 SDK that builds the modern Unreal converter is missing; run npm run provision:toolchain.");
}
