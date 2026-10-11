import { access, chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepStaleStaging } from "../src/unreal/importer.js";
import {
  UMODEL_BOOLTAGS,
  UMODEL_NORMALPACK,
  ensureUmodel,
  patchUmodelBoolTagDeserialization,
  patchUmodelNormalPacking,
  patchUmodelSourceTree,
  patchUmodelVersionMarker,
  umodelBuildFailure,
  umodelCorrected,
} from "../src/unreal/provision.js";
import { runBounded } from "../src/unreal/toolchain.js";
import { describeWithTools } from "./helpers/require-tool.js";

/** The 2022 upstream UE Viewer lists -psk in its help yet rejects it on the command line. */
const OLD_UMODEL = `#!/bin/sh
case " $* " in *" -psk "*) echo "UModel: bad command line: invalid option: -psk"; exit 1;; esac
printf 'UE Viewer (UModel)\\nCompiled Jan  7 2022 (build 1584)\\n'
`;
const CURRENT_UMODEL = `#!/bin/sh
printf 'UE Viewer (UModel)\\nCompiled Sep 24 2026 (build 1)\\n'
`;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: { cached: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "umodel-resolution-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "umodel"), OLD_UMODEL);
  await chmod(join(bin, "umodel"), 0o755);
  const toolchain = join(root, "toolchain");
  const cached = join(toolchain, "umodel", "umodel");
  if (options.cached) {
    await mkdir(join(toolchain, "umodel"), { recursive: true });
    await writeFile(cached, CURRENT_UMODEL);
    await chmod(cached, 0o755);
  }
  const environment = {
    PATH: bin,
    THREENATIVE_TOOLCHAIN_DIR: toolchain,
    THREENATIVE_TOOLCHAIN_AUTOINSTALL: "0",
  };
  return { oldPath: join(bin, "umodel"), cached, environment };
}

describe("UE Viewer resolution", () => {
  it("skips a PATH umodel that rejects -psk in favour of the provisioned build", async () => {
    const { cached, environment } = await fixture({ cached: true });
    const tool = await ensureUmodel(environment);
    expect(tool.path).toBe(cached);
    expect(tool.version).toContain("Sep 24 2026");
  });

  it("does not fall back to an incapable PATH umodel when nothing better exists", async () => {
    const { environment } = await fixture({ cached: false });
    await expect(ensureUmodel(environment)).rejects.toMatchObject({ code: "UNREAL_TOOL_NOT_FOUND" });
  });

  it("names the -psk gap when an explicit override points at an old build", async () => {
    const { oldPath, environment } = await fixture({ cached: true });
    await expect(ensureUmodel({ ...environment, THREENATIVE_UMODEL_PATH: oldPath })).rejects.toMatchObject({
      code: "UNREAL_TOOL_UNUSABLE",
      message: expect.stringContaining("-psk"),
    });
  });
});

describe("UE Viewer source build failures", () => {
  it("names the package for the header the compiler could not find", () => {
    // Verbatim from build.sh on a fresh Debian 13 host with SDL2 headers but no libpng.
    const output = [
      "Unreal/Wrappers/TexturePNG.cpp:1:10: fatal error: png.h: No such file or directory",
      "compilation terminated.",
      "make: *** [obj/umodel-linux64.mak:1586: obj/umodel-unix64/TexturePNG.o] Error 1",
    ].join("\n");
    expect(umodelBuildFailure(output)).toMatch(/png\.h is missing.*sudo apt install libpng-dev/);
  });

  it("maps a nested SDL header to its package", () => {
    expect(umodelBuildFailure("x.cpp:3:10: fatal error: SDL2/SDL.h: No such file or directory"))
      .toMatch(/SDL\.h is missing.*libsdl2-dev/);
  });

  it("keeps the full prerequisite list when the output names nothing", () => {
    expect(umodelBuildFailure("make: *** Error 2")).toMatch(/zlib, libpng and SDL2/);
  });
});

describe("stale import staging", () => {
  it("removes run directories older than a day and keeps fresh ones and cached results", async () => {
    const root = await mkdtemp(join(tmpdir(), "staging-sweep-"));
    roots.push(root);
    const stale = join(root, "key", "run-old");
    const fresh = join(root, "key", "run-new");
    const result = join(root, "key", "result");
    await Promise.all([stale, fresh, result].map((path) => mkdir(path, { recursive: true })));
    const dayAndABit = Date.now() - 25 * 60 * 60 * 1000;
    await utimes(stale, dayAndABit / 1000, dayAndABit / 1000);
    await utimes(result, dayAndABit / 1000, dayAndABit / 1000);

    await sweepStaleStaging(root);

    await expect(access(stale)).rejects.toThrow();
    await expect(access(fresh)).resolves.toBeUndefined();
    await expect(access(result)).resolves.toBeUndefined();
  });
});

/** UnObject.cpp's two Boolean sites (upstream a0bfb468) as upstream writes them: tab-indented, `// byte` comments. */
const UPSTREAM_BOOL_SITES = [
  "void SerializeBoolUE4(FArchive& Ar, FPropertyTag& Tag)",
  "{",
  "\tif (Tag.Type == NAME_BoolProperty)",
  "\t{",
  "\t\tAr << (byte&)Tag.BoolValue;\t\t// byte",
  "\t}",
  "}",
  "",
  "void SerializeBoolUE3(FArchive& Ar, FPropertyTag& Tag)",
  "{",
  "\tif (Tag.Type == NAME_BoolProperty)",
  "\t{",
  "\t\tif (Ar.ArVer < 673)",
  "\t\t\tAr << Tag.BoolValue;\t\t\t// int",
  "\t\telse",
  "\t\t\tAr << (byte&)Tag.BoolValue;\t\t// byte",
  "\t}",
  "}",
  "",
].join("\n");

/**
 * UnMesh4.cpp's ConvertSourceModels vertex loop around the normal packing, as upstream a0bfb468 writes it. The loop body is
 * three tabs deep, so the nesting is kept with an `if` around the loop; only the lines the patch touches are included.
 */
const UPSTREAM_NORMAL_PACK = [
  "void ConvertVertices(CLod* Lod, CRawMesh& RawMesh, int NumVerts)",
  "{",
  "\tif (NumVerts > 0)",
  "\t{",
  "\t\tfor (int i = 0; i < NumVerts; i++)",
  "\t\t{",
  "\t\t\tCStaticMeshVertex &V = Lod->Verts[i];",
  "",
  "\t\t\t// Pack normals",
  "\t\t\tif (Lod->HasNormals)",
  "\t\t\t{",
  "\t\t\t\tCVec3 Normal = CVT(RawMesh.WedgeNormal[i]);",
  "\t\t\t\tif (Lod->HasTangents)",
  "\t\t\t\t{",
  "\t\t\t\t\tCVec3 Tangent = CVT(RawMesh.WedgeTangent[i]);",
  "\t\t\t\t\tCVec3 Binormal = CVT(RawMesh.WedgeBinormal[i]);",
  "\t\t\t\t\tPack(V.Normal, Normal);",
  "\t\t\t\t\tPack(V.Tangent, Tangent);",
  "\t\t\t\t\tCVec3 ComputedBinormal;",
  "\t\t\t\t\tcross(Normal, Tangent, ComputedBinormal);",
  "\t\t\t\t\tfloat Sign = dot(Binormal, ComputedBinormal);",
  "\t\t\t\t\tV.Normal.SetW(Sign > 0 ? 1.0f : -1.0f);",
  "\t\t\t\t}",
  "\t\t\t}",
  "\t\t}",
  "\t}",
  "}",
  "",
].join("\n");

/** The compiled harness's stubs: the vertex and mesh types, `CVT`, `Pack`, `cross` and `dot`, reduced to what the block uses. */
const NORMAL_PACK_HEAD = [
  "#include <cstdio>",
  "",
  "struct CVec3 { float X, Y, Z; };",
  "struct CPackedNormal { float X, Y, Z, W; void SetW(float w) { W = w; } };",
  "struct CStaticMeshVertex { CPackedNormal Normal, Tangent; };",
  "struct CLod { bool HasNormals, HasTangents; CStaticMeshVertex* Verts; };",
  "struct CRawMesh { CVec3 WedgeNormal[1], WedgeTangent[1], WedgeBinormal[1]; };",
  "",
  "static CVec3 CVT(const CVec3& v) { return v; }",
  "static void Pack(CPackedNormal& P, const CVec3& V) { P.X = V.X; P.Y = V.Y; P.Z = V.Z; P.W = 0; }",
  "static void cross(const CVec3& a, const CVec3& b, CVec3& o) { o.X = a.Y * b.Z - a.Z * b.Y; o.Y = a.Z * b.X - a.X * b.Z; o.Z = a.X * b.Y - a.Y * b.X; }",
  "static float dot(const CVec3& a, const CVec3& b) { return a.X * b.X + a.Y * b.Y + a.Z * b.Z; }",
  "",
].join("\n");

/**
 * The case table: the authored normal (0.6, 0, 0.8) and tangent (0, 1, 0) with a binormal whose dot with their cross product
 * is +1 or -1, so the handedness sign is exercised both ways. Each case prints the packed normal and tangent.
 */
const NORMAL_PACK_MAIN = [
  "",
  "static void Run(const char* name, CLod& lod, CRawMesh& raw)",
  "{",
  "\tCStaticMeshVertex verts[1] = {};",
  "\tlod.Verts = verts;",
  "\tConvertVertices(&lod, raw, 1);",
  "\tconst CStaticMeshVertex& v = verts[0];",
  '\tprintf("%s normal=%.4f,%.4f,%.4f,%.1f tangent=%.4f,%.4f,%.4f,%.1f\\n", name,',
  "\t\tv.Normal.X, v.Normal.Y, v.Normal.Z, v.Normal.W, v.Tangent.X, v.Tangent.Y, v.Tangent.Z, v.Tangent.W);",
  "}",
  "",
  "int main()",
  "{",
  "\tconst CVec3 normal = {0.6f, 0.0f, 0.8f};",
  "\tconst CVec3 tangent = {0.0f, 1.0f, 0.0f};",
  "\tconst CVec3 positive = {-0.8f, 0.0f, 0.6f};",
  "\tconst CVec3 negative = {0.8f, 0.0f, -0.6f};",
  "\tstruct Case { const char* name; bool hasNormals; bool hasTangents; CVec3 binormal; };",
  "\tconst Case cases[] = {",
  '\t\t{"normal-only", true, false, positive},',
  '\t\t{"tangent-positive", true, true, positive},',
  '\t\t{"tangent-negative", true, true, negative},',
  '\t\t{"no-normals", false, true, positive},',
  "\t};",
  "\tfor (const Case& c : cases) {",
  "\t\tCLod lod = {c.hasNormals, c.hasTangents, nullptr};",
  "\t\tCRawMesh raw = {{normal}, {tangent}, {c.binormal}};",
  "\t\tRun(c.name, lod, raw);",
  "\t}",
  "\treturn 0;",
  "}",
  "",
].join("\n");

type PackedVertex = { normal: number[]; tangent: number[] };

/** Compiles a normal-packing fixture into the harness with g++, runs it, and returns each case's packed normal and tangent. */
async function runNormalPack(source: string): Promise<Map<string, PackedVertex>> {
  const dir = await mkdtemp(join(tmpdir(), "umodel-normal-pack-"));
  roots.push(dir);
  const sourcePath = join(dir, "normal-pack.cpp");
  const executable = join(dir, "normal-pack");
  await writeFile(sourcePath, `${NORMAL_PACK_HEAD}\n${source}\n${NORMAL_PACK_MAIN}`);
  const compiled = await runBounded("g++", ["-std=c++17", "-O0", "-o", executable, sourcePath], {
    cwd: dir,
    timeoutMs: 120_000,
  });
  if (compiled.code !== 0) throw new Error(`g++ rejected the harness: ${compiled.stderr}`);
  const ran = await runBounded(executable, [], { timeoutMs: 10_000 });
  if (ran.code !== 0) throw new Error(`the harness exited ${ran.code}: ${ran.stderr}`);
  const vector = (text = "") => text.split(",").map(Number);
  const cases = new Map<string, PackedVertex>();
  for (const match of ran.stdout.matchAll(/^(\S+) normal=(\S+) tangent=(\S+)$/gm)) {
    cases.set(match[1] ?? "", { normal: vector(match[2]), tangent: vector(match[3]) });
  }
  return cases;
}

describe("UE Viewer normal packing source patch", () => {
  it("moves the normal pack ahead of the tangent guard and changes nothing on a second application", () => {
    const once = patchUmodelNormalPacking(UPSTREAM_NORMAL_PACK);
    const lines = once.split("\n");
    const tangentGuard = lines.indexOf("\t\t\t\tif (Lod->HasTangents)");
    expect(lines.indexOf("\t\t\t\tPack(V.Normal, Normal);")).toBeGreaterThan(-1);
    expect(lines.indexOf("\t\t\t\tPack(V.Normal, Normal);")).toBeLessThan(tangentGuard);
    expect(lines.indexOf("\t\t\t\t\tV.Normal.SetW(Sign > 0 ? 1.0f : -1.0f);")).toBeGreaterThan(tangentGuard);
    expect(patchUmodelNormalPacking(once)).toBe(once);
  });

  it("keeps CRLF line endings, and refuses a block that is missing or repeated", () => {
    const once = patchUmodelNormalPacking(UPSTREAM_NORMAL_PACK);
    expect(patchUmodelNormalPacking(UPSTREAM_NORMAL_PACK.replace(/\n/g, "\r\n"))).toBe(once.replace(/\n/g, "\r\n"));
    expect(() => patchUmodelNormalPacking(UPSTREAM_NORMAL_PACK.replace("\t\t\t// Pack normals\n", ""))).toThrow(
      /not one of each/,
    );
    expect(() => patchUmodelNormalPacking(UPSTREAM_NORMAL_PACK + UPSTREAM_NORMAL_PACK)).toThrow(/not one of each/);
  });
});

describeWithTools(["g++"], "UE Viewer normal packing (compiled)", () => {
  it("writes the authored normal on a mesh with normals and no tangents, and leaves its tangent alone", async () => {
    const cases = await runNormalPack(patchUmodelNormalPacking(UPSTREAM_NORMAL_PACK));
    expect(cases.get("normal-only")).toEqual({ normal: [0.6, 0, 0.8, 0], tangent: [0, 0, 0, 0] });
  });

  it("gives the tangent-guarded cases the same XYZ, tangent and handedness sign as upstream", async () => {
    const upstream = await runNormalPack(UPSTREAM_NORMAL_PACK);
    const patched = await runNormalPack(patchUmodelNormalPacking(UPSTREAM_NORMAL_PACK));
    expect(patched.get("tangent-positive")).toEqual(upstream.get("tangent-positive"));
    expect(patched.get("tangent-negative")).toEqual(upstream.get("tangent-negative"));
    expect(patched.get("tangent-positive")?.normal[3]).toBe(1);
    expect(patched.get("tangent-negative")?.normal[3]).toBe(-1);
  });

  it("leaves a mesh without normals as upstream left it", async () => {
    const upstream = await runNormalPack(UPSTREAM_NORMAL_PACK);
    const patched = await runNormalPack(patchUmodelNormalPacking(UPSTREAM_NORMAL_PACK));
    expect(patched.get("no-normals")).toEqual(upstream.get("no-normals"));
    expect(patched.get("no-normals")).toEqual({ normal: [0, 0, 0, 0], tangent: [0, 0, 0, 0] });
  });

  it("shows the upstream shape dropping the authored normal when there are no tangents, so the harness can fail", async () => {
    const cases = await runNormalPack(UPSTREAM_NORMAL_PACK);
    expect(cases.get("normal-only")?.normal).toEqual([0, 0, 0, 0]);
  });
});

/** Main.cpp's PrintVersionInfo as upstream writes it (the upstream file itself is CRLF). */
const UPSTREAM_VERSION_BANNER = [
  "static void PrintVersionInfo()",
  "{",
  "\tappPrintf(",
  '\t\t\t"UE Viewer (UModel)\\n" "%s\\n" "%s\\n" "%s\\n%s\\n",',
  "\t\t\tGBuildString, GCopyrightString, GLicenseString, GUmodelHomepage",
  "\t);",
  "}",
  "",
].join("\n");

/**
 * The compiled harness. The stub archive reads one byte for `operator<<(byte&)` and four little-endian bytes for
 * `operator<<(int&)`, the two reads the Boolean sites make. Each case starts from a tag whose upper bytes are poisoned.
 */
const HARNESS_HEAD = [
  "#include <cstddef>",
  "#include <cstdio>",
  "",
  "typedef unsigned char byte;",
  "enum { NAME_BoolProperty = 1 };",
  "",
  "struct FArchive {",
  "\tint ArVer;",
  "\tconst byte* data;",
  "\tsize_t pos;",
  "\tFArchive& operator<<(byte& value) { value = data[pos++]; return *this; }",
  "\tFArchive& operator<<(int& value)",
  "\t{",
  "\t\tunsigned bits = 0;",
  "\t\tfor (int i = 0; i < 4; i++) bits |= (unsigned)data[pos + i] << (8 * i);",
  "\t\tvalue = (int)bits;",
  "\t\tpos += 4;",
  "\t\treturn *this;",
  "\t}",
  "};",
  "",
  "struct FPropertyTag {",
  "\tint Type;",
  "\tint BoolValue;",
  "};",
  "",
].join("\n");

const HARNESS_MAIN = [
  "",
  "typedef void (*Serializer)(FArchive&, FPropertyTag&);",
  "",
  "static void Run(const char* name, Serializer serialize, int arVer, const byte* bytes)",
  "{",
  "\tFArchive ar = {arVer, bytes, 0};",
  "\tFPropertyTag tag = {NAME_BoolProperty, 0x7f7f7f00};",
  "\tserialize(ar, tag);",
  '\tprintf("%s value=%d pos=%zu\\n", name, tag.BoolValue, ar.pos);',
  "}",
  "",
  "int main()",
  "{",
  "\tstatic const byte zero[] = {0, 0, 0, 0};",
  "\tstatic const byte one[] = {1, 0, 0, 0};",
  "\tstatic const byte byte0[] = {0};",
  "\tstatic const byte byte1[] = {1};",
  '\tRun("ue4-false", SerializeBoolUE4, 0, byte0);',
  '\tRun("ue4-true", SerializeBoolUE4, 0, byte1);',
  '\tRun("ue3-673-false", SerializeBoolUE3, 673, byte0);',
  '\tRun("ue3-673-true", SerializeBoolUE3, 673, byte1);',
  '\tRun("ue3-672-false", SerializeBoolUE3, 672, zero);',
  '\tRun("ue3-672-true", SerializeBoolUE3, 672, one);',
  "\treturn 0;",
  "}",
  "",
].join("\n");

type BoolCase = { value: number; pos: number };

/** Compiles a Boolean-site fixture into the harness with g++, runs it, and returns each case's value and archive position. */
async function runBoolTags(source: string): Promise<Map<string, BoolCase>> {
  const dir = await mkdtemp(join(tmpdir(), "umodel-bool-tags-"));
  roots.push(dir);
  const sourcePath = join(dir, "bool-tags.cpp");
  const executable = join(dir, "bool-tags");
  await writeFile(sourcePath, `${HARNESS_HEAD}\n${source}\n${HARNESS_MAIN}`);
  const compiled = await runBounded("g++", ["-std=c++17", "-O2", "-o", executable, sourcePath], {
    cwd: dir,
    timeoutMs: 120_000,
  });
  if (compiled.code !== 0) throw new Error(`g++ rejected the harness: ${compiled.stderr}`);
  const ran = await runBounded(executable, [], { timeoutMs: 10_000 });
  if (ran.code !== 0) throw new Error(`the harness exited ${ran.code}: ${ran.stderr}`);
  const cases = new Map<string, BoolCase>();
  for (const match of ran.stdout.matchAll(/^(\S+) value=(-?\d+) pos=(\d+)$/gm)) {
    cases.set(match[1] ?? "", { value: Number(match[2]), pos: Number(match[3]) });
  }
  return cases;
}

describeWithTools(["g++"], "UE Viewer Boolean tags (compiled)", () => {
  it("reads a serialized false as 0 and true as 1 on UE4 and UE3 >= 673, over poisoned upper bytes", async () => {
    const cases = await runBoolTags(patchUmodelBoolTagDeserialization(UPSTREAM_BOOL_SITES));
    expect(cases.get("ue4-false")).toEqual({ value: 0, pos: 1 });
    expect(cases.get("ue4-true")).toEqual({ value: 1, pos: 1 });
    expect(cases.get("ue3-673-false")).toEqual({ value: 0, pos: 1 });
    expect(cases.get("ue3-673-true")).toEqual({ value: 1, pos: 1 });
  });

  it("leaves the UE3 < 673 full-int read as it was", async () => {
    const cases = await runBoolTags(patchUmodelBoolTagDeserialization(UPSTREAM_BOOL_SITES));
    expect(cases.get("ue3-672-false")).toEqual({ value: 0, pos: 4 });
    expect(cases.get("ue3-672-true")).toEqual({ value: 1, pos: 4 });
  });

  it("shows the upstream shape reading a serialized false as true, so the harness can fail", async () => {
    const cases = await runBoolTags(UPSTREAM_BOOL_SITES);
    expect(cases.get("ue4-false")?.value).not.toBe(0);
    expect(cases.get("ue3-673-false")?.value).not.toBe(0);
  });
});

describe("UE Viewer Boolean tag source patch", () => {
  it("rewrites both Boolean sites and changes nothing on a second application", () => {
    const once = patchUmodelBoolTagDeserialization(UPSTREAM_BOOL_SITES);
    expect(once).not.toContain("Ar << (byte&)Tag.BoolValue;");
    expect(once.split("Tag.BoolValue = SerializedBool;")).toHaveLength(3);
    expect(patchUmodelBoolTagDeserialization(once)).toBe(once);
  });

  it("refuses a file whose Boolean sites no longer match the pinned upstream", () => {
    const oneSite = UPSTREAM_BOOL_SITES.replace("Ar << (byte&)Tag.BoolValue;", "Ar << Tag.BoolValue;");
    expect(() => patchUmodelBoolTagDeserialization(oneSite)).toThrow(/not the 2 expected/);
  });
});

describe("UE Viewer version marker source patch", () => {
  it("adds both markers once after the banner, in the file's CRLF line endings", () => {
    const crlf = UPSTREAM_VERSION_BANNER.replace(/\n/g, "\r\n");
    const once = patchUmodelVersionMarker(crlf);
    expect(once).toBe(
      crlf.replace(
        "\t);\r\n",
        '\t);\r\n\tappPrintf("ThreeNative-UModel-BoolTags-1\\n");\r\n\tappPrintf("ThreeNative-UModel-NormalPack-1\\n");\r\n',
      ),
    );
    expect(once.replace(/\r\n/g, "")).not.toContain("\n");
    expect(patchUmodelVersionMarker(once)).toBe(once);
  });

  it("completes a Boolean-tag-only source with the normal-packing marker, and does not count that build as corrected", () => {
    const booleanOnly = UPSTREAM_VERSION_BANNER.replace("\t);\n", '\t);\n\tappPrintf("ThreeNative-UModel-BoolTags-1\\n");\n');
    const completed = patchUmodelVersionMarker(booleanOnly);
    expect(completed).toContain('\tappPrintf("ThreeNative-UModel-NormalPack-1\\n");\n');
    expect(patchUmodelVersionMarker(completed)).toBe(completed);
    expect(umodelCorrected("UE Viewer (UModel)\nThreeNative-UModel-BoolTags-1\n")).toBe(false);
    expect(umodelCorrected("UE Viewer (UModel)\nThreeNative-UModel-BoolTags-1\nThreeNative-UModel-NormalPack-1\n")).toBe(
      true,
    );
  });

  it("refuses a Main.cpp whose version banner no longer matches", () => {
    expect(() => patchUmodelVersionMarker("static void PrintVersionInfo()\n{\n}\n")).toThrow(
      /no longer matches the version banner/,
    );
  });
});

describe("UE Viewer source tree layout", () => {
  // The pinned a0bfb468 checkout keeps these at its repository root, with no src/ directory above them.
  const BOOL_TAGS = "Unreal/UnObject.cpp";
  const VERSION_BANNER = "UmodelTool/Main.cpp";
  const NORMAL_PACK = "Unreal/UnrealMesh/UnMesh4.cpp";

  async function checkout(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "umodel-layout-"));
    roots.push(root);
    for (const [relative, text] of Object.entries(files)) {
      const path = join(root, ...relative.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    return root;
  }

  async function snapshot(root: string): Promise<Record<string, string>> {
    const found: Record<string, string> = {};
    for (const relative of [BOOL_TAGS, VERSION_BANNER, NORMAL_PACK]) {
      found[relative] = await readFile(join(root, ...relative.split("/")), "utf8");
    }
    return found;
  }

  it("applies each fix to its own file at the checkout path, and a second run changes nothing", async () => {
    const crlfBanner = UPSTREAM_VERSION_BANNER.replace(/\n/g, "\r\n");
    const root = await checkout({
      [BOOL_TAGS]: UPSTREAM_BOOL_SITES,
      [VERSION_BANNER]: crlfBanner,
      [NORMAL_PACK]: UPSTREAM_NORMAL_PACK,
    });

    await patchUmodelSourceTree(root);
    const once = await snapshot(root);
    expect(once[BOOL_TAGS]).toBe(patchUmodelBoolTagDeserialization(UPSTREAM_BOOL_SITES));
    expect(once[VERSION_BANNER]).toBe(patchUmodelVersionMarker(crlfBanner));
    expect(once[NORMAL_PACK]).toBe(patchUmodelNormalPacking(UPSTREAM_NORMAL_PACK));

    await patchUmodelSourceTree(root);
    expect(await snapshot(root)).toEqual(once);
  });

  it("refuses a checkout that lacks one of the three files, naming the missing path", async () => {
    const root = await checkout({
      [BOOL_TAGS]: UPSTREAM_BOOL_SITES,
      [VERSION_BANNER]: UPSTREAM_VERSION_BANNER,
    });
    await expect(patchUmodelSourceTree(root)).rejects.toThrow("has no Unreal/UnrealMesh/UnMesh4.cpp");
  });
});

/** A UE Viewer that prints both fix markers on `-version`, as the patched source build does. */
const PATCHED_UMODEL = `#!/bin/sh
printf 'UE Viewer (UModel)\\nCompiled Oct 10 2026 (build 2)\\nThreeNative-UModel-BoolTags-1\\nThreeNative-UModel-NormalPack-1\\n'
`;

/** The Boolean-tag fix alone, as the cache held before normal packing. It is not a corrected build. */
const BOOLTAGS_ONLY_UMODEL = `#!/bin/sh
printf 'UE Viewer (UModel)\\nCompiled Oct 10 2026 (build 2)\\nThreeNative-UModel-BoolTags-1\\n'
`;

/** Prints both fix markers and then fails. Its output looks corrected; its exit status says it is not. */
const FAILING_UMODEL = `#!/bin/sh
printf 'UE Viewer (UModel)\\nCompiled Oct 10 2026 (build 2)\\nThreeNative-UModel-BoolTags-1\\nThreeNative-UModel-NormalPack-1\\n'
exit 1
`;

async function installUmodel(path: string, script: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, script);
  await chmod(path, 0o755);
  return path;
}

/** A sandbox with optional UE Viewer builds at PATH, the legacy owned cache, and the Boolean-tag versioned cache. */
async function sandbox(builds: { path?: string; legacy?: string; versioned?: string }, autoinstall = "0") {
  const root = await mkdtemp(join(tmpdir(), "umodel-provenance-"));
  roots.push(root);
  const bin = join(root, "bin");
  const toolchain = join(root, "toolchain");
  const legacy = join(toolchain, "umodel", "umodel");
  const versioned = join(toolchain, UMODEL_BOOLTAGS.cacheDir, "umodel");
  await mkdir(bin);
  if (builds.path !== undefined) await installUmodel(join(bin, "umodel"), builds.path);
  if (builds.legacy !== undefined) await installUmodel(legacy, builds.legacy);
  if (builds.versioned !== undefined) await installUmodel(versioned, builds.versioned);
  return {
    bin,
    legacy,
    versioned,
    environment: { PATH: bin, THREENATIVE_TOOLCHAIN_DIR: toolchain, THREENATIVE_TOOLCHAIN_AUTOINSTALL: autoinstall },
  };
}

describe("UE Viewer build provenance", () => {
  it("prefers a marker-verified versioned build over a runnable PATH build, and reports it verified", async () => {
    const { environment, versioned } = await sandbox({ path: CURRENT_UMODEL, versioned: PATCHED_UMODEL });
    const tool = await ensureUmodel(environment);
    expect(tool.path).toBe(versioned);
    expect(tool.version).toContain("ThreeNative-UModel-BoolTags-1 and ThreeNative-UModel-NormalPack-1 parser-verified");
  });

  it("uses a runnable PATH build without provisioning, and reports it unverified", async () => {
    const { environment, bin } = await sandbox({ path: CURRENT_UMODEL }, "1");
    const tool = await ensureUmodel(environment, undefined, {
      build: async () => {
        throw new Error("a runnable PATH build must not be provisioned over");
      },
    });
    expect(tool.path).toBe(join(bin, "umodel"));
    expect(tool.version).toContain("unverified");
  });

  it("gives an explicit override precedence over a verified versioned build", async () => {
    const { environment, legacy } = await sandbox({ legacy: CURRENT_UMODEL, versioned: PATCHED_UMODEL });
    const tool = await ensureUmodel({ ...environment, THREENATIVE_UMODEL_PATH: legacy });
    expect(tool.path).toBe(legacy);
    expect(tool.version).toContain("unverified");
  });

  it("does not report a failing explicit override as verified, even when it prints both markers", async () => {
    const { environment, bin } = await sandbox({ path: FAILING_UMODEL });
    const override = { ...environment, THREENATIVE_UMODEL_PATH: join(bin, "umodel") };
    await expect(ensureUmodel(override)).rejects.toMatchObject({
      code: "UNREAL_TOOL_UNUSABLE",
      message: expect.stringContaining("exit code 1"),
    });
  });

  it("keeps a valid explicit override that prints both markers and exits 0 as verified", async () => {
    const { environment, bin } = await sandbox({ path: PATCHED_UMODEL });
    const tool = await ensureUmodel({ ...environment, THREENATIVE_UMODEL_PATH: join(bin, "umodel") });
    expect(tool.version).toContain("parser-verified");
  });

  it("with auto-install off, keeps a legacy owned build and reports it unverified", async () => {
    const { environment, legacy } = await sandbox({ legacy: CURRENT_UMODEL });
    const tool = await ensureUmodel(environment);
    expect(tool.path).toBe(legacy);
    expect(tool.version).toContain("unverified");
  });

  it.runIf(process.platform === "linux")(
    "upgrades a legacy owned build through the patched build when auto-install is on",
    async () => {
      const { environment, versioned } = await sandbox({ legacy: CURRENT_UMODEL }, "1");
      const built: string[] = [];
      const tool = await ensureUmodel(environment, undefined, {
        build: async (destination) => {
          built.push(destination);
          await installUmodel(destination, PATCHED_UMODEL);
        },
      });
      expect(built).toEqual([versioned]);
      expect(tool.path).toBe(versioned);
      expect(tool.version).toContain("parser-verified");
    },
  );

  it.runIf(process.platform === "linux")("refuses an upgrade whose build does not print the marker", async () => {
    const { environment } = await sandbox({ legacy: CURRENT_UMODEL }, "1");
    await expect(
      ensureUmodel(environment, undefined, {
        build: async (destination) => {
          await installUmodel(destination, CURRENT_UMODEL);
        },
      }),
    ).rejects.toMatchObject({ code: "UNREAL_TOOL_UNUSABLE" });
  });

  it("reports a Boolean-tag build without the normal-packing marker as unverified", async () => {
    const { environment, bin } = await sandbox({ path: BOOLTAGS_ONLY_UMODEL }, "0");
    const tool = await ensureUmodel(environment);
    expect(tool.path).toBe(join(bin, "umodel"));
    expect(tool.version).toContain("unverified: no ThreeNative-UModel-NormalPack-1 marker");
  });

  it.runIf(process.platform === "linux")(
    "rebuilds a Boolean-tag-only build in the versioned cache instead of reusing it",
    async () => {
      const { environment, versioned } = await sandbox({ versioned: BOOLTAGS_ONLY_UMODEL }, "1");
      const built: string[] = [];
      const tool = await ensureUmodel(environment, undefined, {
        build: async (destination) => {
          built.push(destination);
          await installUmodel(destination, PATCHED_UMODEL);
        },
      });
      expect(built).toEqual([versioned]);
      expect(tool.version).toContain("parser-verified");
    },
  );

  it("does not reuse a versioned build that exits non-zero, even when it prints both markers", async () => {
    const { environment } = await sandbox({ versioned: FAILING_UMODEL });
    await expect(ensureUmodel(environment)).rejects.toMatchObject({ code: "UNREAL_TOOL_NOT_FOUND" });
  });

  it.runIf(process.platform === "linux")(
    "rebuilds a versioned build that exits non-zero instead of reusing it",
    async () => {
      const { environment, versioned } = await sandbox({ versioned: FAILING_UMODEL }, "1");
      const built: string[] = [];
      const tool = await ensureUmodel(environment, undefined, {
        build: async (destination) => {
          built.push(destination);
          await installUmodel(destination, PATCHED_UMODEL);
        },
      });
      expect(built).toEqual([versioned]);
      expect(tool.version).toContain("parser-verified");
    },
  );
});
