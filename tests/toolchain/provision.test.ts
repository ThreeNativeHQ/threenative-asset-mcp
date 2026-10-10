import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  UNCOOKED_CONVERTER,
  ensureUncookedConverter,
  patchUncookedCliRevision,
  uncookedConverterPath,
} from "../../src/unreal/provision.js";

// The uncooked converter is a pip package installed into a private venv. Its upstream `--version`
// is `4.27.2.0` and cannot tell a stale install from the current one, so provisioning stamps the
// pinned threenative revision onto the CLI as `--threenative-version`. These tests fake the
// executable and the pip install (through the explicit seam) so a stale cache is detected and
// upgraded without running pip, and a user's own tool is never overwritten.

const HELP = "UE 4.27 UAsset Parser\ngpu instances/landscapes\n";

/** An install from before the revision flag: the help ABI passes, but the flag is rejected. */
const LEGACY = `#!/bin/sh
case " $* " in
  *" --threenative-version "*) echo "unrecognized arguments: --threenative-version" >&2; exit 2;;
esac
printf '${HELP}'
exit 0
`;

/** Reports `revision` on the flag; `--help` prints the ABI markers and exits `helpStatus` (0 unless a test breaks it). */
function revisionTool(revision: string, helpStatus = 0): string {
  return `#!/bin/sh
case " $* " in
  *" --threenative-version "*) printf '%s\\n' '${revision}'; exit 0;;
esac
printf '${HELP}'
exit ${helpStatus}
`;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeExecutable(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await chmod(path, 0o755);
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "uncooked-revision-"));
  roots.push(root);
  return root;
}

/** A cache with the given script installed at the owned path, plus the environment to resolve it. */
async function fixture(options: {
  cached?: string;
  autoInstall?: boolean;
  pathTool?: string;
  override?: string;
}) {
  const root = await makeRoot();
  const toolchain = join(root, "toolchain");
  const cached = uncookedConverterPath({ THREENATIVE_TOOLCHAIN_DIR: toolchain });
  if (options.cached !== undefined) await writeExecutable(cached, options.cached);
  const bin = join(root, "bin");
  if (options.pathTool !== undefined) await writeExecutable(join(bin, "unreal-assets-to-glb"), options.pathTool);
  const environment: NodeJS.ProcessEnv = {
    THREENATIVE_TOOLCHAIN_DIR: toolchain,
    THREENATIVE_TOOLCHAIN_AUTOINSTALL: options.autoInstall === false ? "0" : "1",
  };
  if (options.pathTool !== undefined) environment.PATH = bin;
  if (options.override !== undefined) environment.THREENATIVE_UNCOOKED_CONVERTER_PATH = options.override;
  return { root, toolchain, cached, bin, environment };
}

/** Records seam calls and installs a fresh tool reporting `revision`, with `--help` exiting `helpStatus`. */
function seam(installs: string[], revision: string, helpStatus = 0) {
  return {
    install: async (executable: string): Promise<void> => {
      installs.push(executable);
      await writeExecutable(executable, revisionTool(revision, helpStatus));
    },
  };
}

describe("uncooked converter revision resolution", () => {
  it("accepts an owned cache at the exact pinned revision and reports the read revision", async () => {
    const { cached, environment } = await fixture({ cached: revisionTool(UNCOOKED_CONVERTER.version), autoInstall: false });
    const tool = await ensureUncookedConverter(environment);
    expect(tool.path).toBe(cached);
    expect(tool.version).toBe(UNCOOKED_CONVERTER.version);
  });

  it("refuses an owned cache at the exact revision whose --help exits non-zero, and never reports it current", async () => {
    const broken = revisionTool(UNCOOKED_CONVERTER.version, 1);
    const { cached, environment } = await fixture({ cached: broken, autoInstall: false });
    const installs: string[] = [];
    await expect(ensureUncookedConverter(environment, () => {}, seam(installs, UNCOOKED_CONVERTER.version)))
      .rejects.toMatchObject({ code: "UNREAL_TOOL_UNUSABLE", message: expect.stringContaining("--help") });
    expect(installs).toEqual([]);
    expect(await readFile(cached, "utf8")).toBe(broken);
  });

  it("re-provisions an owned cache at the exact revision whose --help exits non-zero when auto-install is on", async () => {
    const { cached, environment } = await fixture({ cached: revisionTool(UNCOOKED_CONVERTER.version, 1) });
    const installs: string[] = [];
    const tool = await ensureUncookedConverter(environment, () => {}, seam(installs, UNCOOKED_CONVERTER.version));
    expect(tool.path).toBe(cached);
    expect(tool.version).toBe(UNCOOKED_CONVERTER.version);
    expect(installs).toEqual([cached]);
  });

  it("refuses a provisioned converter at the exact revision whose --help exits non-zero", async () => {
    const { environment } = await fixture({});
    const installs: string[] = [];
    await expect(ensureUncookedConverter(environment, () => {}, seam(installs, UNCOOKED_CONVERTER.version, 1)))
      .rejects.toMatchObject({ code: "UNREAL_TOOL_UNUSABLE", message: expect.stringContaining("does not run") });
    expect(installs).toHaveLength(1);
  });

  it("rejects an explicit override at the exact revision whose --help exits non-zero, and never replaces it", async () => {
    const root = await makeRoot();
    const override = join(root, "user-tool");
    const broken = revisionTool(UNCOOKED_CONVERTER.version, 1);
    await writeExecutable(override, broken);
    const installs: string[] = [];
    const environment: NodeJS.ProcessEnv = {
      THREENATIVE_TOOLCHAIN_DIR: join(root, "toolchain"),
      THREENATIVE_TOOLCHAIN_AUTOINSTALL: "1",
      THREENATIVE_UNCOOKED_CONVERTER_PATH: override,
    };
    await expect(ensureUncookedConverter(environment, () => {}, seam(installs, UNCOOKED_CONVERTER.version)))
      .rejects.toMatchObject({ code: "UNREAL_TOOL_UNUSABLE", message: expect.stringContaining("is not the expected") });
    expect(installs).toEqual([]);
    expect(await readFile(override, "utf8")).toBe(broken);
  });

  it("does not relabel a legacy owned cache whose help passes but which cannot report a revision", async () => {
    const { cached, environment } = await fixture({ cached: LEGACY, autoInstall: false });
    const installs: string[] = [];
    await expect(ensureUncookedConverter(environment, () => {}, seam(installs, UNCOOKED_CONVERTER.version)))
      .rejects.toMatchObject({
        code: "UNREAL_TOOL_UNUSABLE",
        message: expect.stringContaining("THREENATIVE_TOOLCHAIN_AUTOINSTALL"),
      });
    expect(installs).toEqual([]);
    expect(await readFile(cached, "utf8")).toBe(LEGACY);
  });

  it("does not relabel an owned cache that reports a different threenative revision", async () => {
    const { cached, environment } = await fixture({
      cached: revisionTool("4.27.2.0+threenative.9"),
      autoInstall: false,
    });
    const installs: string[] = [];
    await expect(ensureUncookedConverter(environment, () => {}, seam(installs, UNCOOKED_CONVERTER.version)))
      .rejects.toMatchObject({
        code: "UNREAL_TOOL_UNUSABLE",
        message: expect.stringContaining("4.27.2.0+threenative.9"),
      });
    expect(installs).toEqual([]);
    expect(await readFile(cached, "utf8")).toContain("+threenative.9");
  });

  it("re-provisions a stale owned cache through the install seam when auto-install is on", async () => {
    const { cached, environment } = await fixture({ cached: LEGACY });
    const installs: string[] = [];
    const tool = await ensureUncookedConverter(environment, () => {}, seam(installs, UNCOOKED_CONVERTER.version));
    expect(tool.path).toBe(cached);
    expect(tool.version).toBe(UNCOOKED_CONVERTER.version);
    expect(installs).toEqual([cached]);
  });

  it("rejects an explicit override at the wrong revision and never replaces the user's tool", async () => {
    const root = await makeRoot();
    const override = join(root, "user-tool");
    const stale = revisionTool("4.27.2.0+threenative.9");
    await writeExecutable(override, stale);
    const installs: string[] = [];
    const environment: NodeJS.ProcessEnv = {
      THREENATIVE_TOOLCHAIN_DIR: join(root, "toolchain"),
      THREENATIVE_TOOLCHAIN_AUTOINSTALL: "1",
      THREENATIVE_UNCOOKED_CONVERTER_PATH: override,
    };
    await expect(ensureUncookedConverter(environment, () => {}, seam(installs, UNCOOKED_CONVERTER.version)))
      .rejects.toMatchObject({
        code: "UNREAL_TOOL_UNUSABLE",
        message: expect.stringContaining("THREENATIVE_UNCOOKED_CONVERTER_PATH"),
      });
    expect(installs).toEqual([]);
    expect(await readFile(override, "utf8")).toBe(stale);
  });

  it("rejects a wrong-revision tool found on PATH", async () => {
    const { environment } = await fixture({ pathTool: revisionTool("4.27.2.0+threenative.9") });
    await expect(ensureUncookedConverter(environment)).rejects.toMatchObject({
      code: "UNREAL_TOOL_UNUSABLE",
      message: expect.stringContaining("PATH"),
    });
  });

  it.each(["4.27.2.0", "4.27.2.0+threenative.10-extra", "not-a-revision"])(
    "does not accept %s as the pinned revision",
    async (bogus) => {
      const { environment } = await fixture({ cached: revisionTool(bogus), autoInstall: false });
      await expect(ensureUncookedConverter(environment)).rejects.toMatchObject({ code: "UNREAL_TOOL_UNUSABLE" });
    },
  );

  it("installs nothing and reports NOT_FOUND when the cache is empty and auto-install is off", async () => {
    const { environment } = await fixture({ autoInstall: false });
    await expect(ensureUncookedConverter(environment)).rejects.toMatchObject({ code: "UNREAL_TOOL_NOT_FOUND" });
  });
});

describe("uncooked CLI revision patch", () => {
  const STUB = `    parser.add_argument(
        '--filter', metavar='SUBSTRING', dest='mesh_filter',
        help='Only export meshes whose name contains this substring (case-insensitive)'
    )
`;

  it("stamps the pinned revision onto a version action, idempotently", () => {
    const patched = patchUncookedCliRevision(STUB);
    expect(patched).not.toBe(STUB);
    expect(patched).toContain("action='version'");
    expect(patched).toContain(`version='${UNCOOKED_CONVERTER.version}'`);
    expect(patchUncookedCliRevision(patched)).toBe(patched);
  });

  it("refuses a drifted anchor rather than silently no-op", () => {
    expect(() => patchUncookedCliRevision("# not the converter\n")).toThrow(/threenative revision flag/);
  });
});
