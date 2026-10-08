import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  ensureFabcli,
  ensureModernConverter,
  ensureUmodel,
  ensureUncookedConverter,
  type ProvisionLog,
} from "../src/unreal/provision.js";
import { type ExternalTool, childEnvironment } from "../src/unreal/toolchain.js";

// Each override would skip provisioning and resolve from the host, which proves nothing about a
// fresh cache. PATH lookup is also kept out of the answer: a path outside the cache fails below.
const OVERRIDES = [
  "THREENATIVE_UMODEL_PATH",
  "THREENATIVE_FABCLI_PATH",
  "THREENATIVE_UNCOOKED_CONVERTER_PATH",
  "THREENATIVE_MODERN_UNREAL_CONVERTER_PATH",
];

interface Step {
  readonly name: string;
  readonly ensure: (environment: NodeJS.ProcessEnv, log: ProvisionLog) => Promise<ExternalTool>;
  // Tools whose ensure probe does not already prove identity get an explicit --version check.
  readonly versionCheck?: { readonly expect: RegExp };
}

const STEPS: readonly Step[] = [
  { name: "fabcli", ensure: ensureFabcli, versionCheck: { expect: /fabcli/i } },
  { name: "umodel", ensure: ensureUmodel },
  { name: "uncooked", ensure: ensureUncookedConverter },
  { name: "modern", ensure: ensureModernConverter, versionCheck: { expect: /threenative-cue4parse/ } },
];

function fail(code: number, message: string): never {
  console.error(`provision-toolchain: ${message}`);
  process.exit(code);
}

function requireEmptyRoot(): string {
  const configured = process.env.THREENATIVE_TOOLCHAIN_DIR?.trim();
  if (!configured) fail(2, "THREENATIVE_TOOLCHAIN_DIR must name an empty or absent directory.");
  const root = resolve(configured);
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (entries.length > 0) fail(2, `${root} is not empty; a fresh-cache check needs an empty directory.`);
  return root;
}

function isInside(path: string, root: string): boolean {
  const offset = relative(root, resolve(path));
  return offset !== "" && !offset.startsWith("..") && !isAbsolute(offset);
}

async function provision(
  step: Step,
  environment: NodeJS.ProcessEnv,
  root: string,
): Promise<{ ok: boolean; line: string; detail?: string }> {
  const log: ProvisionLog = (message) => console.log(`[${step.name}] ${message}`);
  const started = performance.now();
  let tool: ExternalTool | undefined;
  try {
    tool = await step.ensure(environment, log);
    if (!isInside(tool.path, root)) {
      throw new Error(`resolved ${tool.path} outside ${root}; it came from PATH, which proves nothing`);
    }
    if (step.versionCheck) {
      const output = execFileSync(tool.path, ["--version"], {
        encoding: "utf8",
        timeout: 30_000,
        env: childEnvironment(environment),
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!step.versionCheck.expect.test(output)) {
        throw new Error(`--version did not match ${step.versionCheck.expect}: ${output.trim().split("\n")[0]}`);
      }
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    return {
      ok: true,
      line: `ok    ${step.name.padEnd(9)} ${tool.version}  ${seconds}s  ${tool.path}`,
    };
  } catch (error) {
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      line: `FAIL  ${step.name.padEnd(9)} -  ${seconds}s  ${tool?.path ?? "-"}`,
      detail: `        ${message}`,
    };
  }
}

async function main(): Promise<number> {
  const root = requireEmptyRoot();
  const environment: NodeJS.ProcessEnv = { ...process.env, THREENATIVE_TOOLCHAIN_DIR: root };
  for (const key of OVERRIDES) delete environment[key];

  let failures = 0;
  // Every tool runs even after one fails, so a single run reports the whole fresh-host picture.
  for (const step of STEPS) {
    const result = await provision(step, environment, root);
    console.log(result.line);
    if (result.detail) console.log(result.detail);
    if (!result.ok) failures += 1;
  }
  console.log(failures === 0 ? "provision-toolchain: all tools provisioned" : `provision-toolchain: ${failures} failed`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`provision-toolchain: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
