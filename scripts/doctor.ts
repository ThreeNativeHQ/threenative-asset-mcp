import { pathToFileURL } from "node:url";

import {
  infoLines,
  PREREQUISITES,
  type Prerequisite,
  type PrerequisiteGroup,
} from "./prerequisites.js";

export interface DoctorOptions {
  env: NodeJS.ProcessEnv;
  /** Make the toolchain group required. Otherwise a missing toolchain item is a warning. */
  toolchain?: boolean;
  /** Which groups to check. Defaults to both. */
  groups?: readonly PrerequisiteGroup[];
}

export interface DoctorResult {
  lines: string[];
  exitCode: number;
}

const STATUS_WIDTH = 8;

function line(status: string, label: string, detail: string): string {
  return `${status.padEnd(STATUS_WIDTH)}${label.padEnd(40)} ${detail}`.trimEnd();
}

export function runDoctor(options: DoctorOptions): DoctorResult {
  const groups = options.groups ?? ["test", "toolchain"];
  const lines: string[] = [];
  let exitCode = 0;
  for (const group of groups) {
    const required = group === "test" || options.toolchain === true;
    lines.push(`${group} prerequisites${required ? "" : " (needed only for Unreal imports; use --toolchain to require)"}`);
    for (const prerequisite of PREREQUISITES.filter((entry: Prerequisite) => entry.group === group)) {
      const result = prerequisite.check(options.env);
      if (result.ok) {
        lines.push(line("ok", prerequisite.label, result.detail ?? ""));
      } else if (required) {
        exitCode = 1;
        lines.push(line("missing", prerequisite.label, `fix: ${prerequisite.fix}`));
      } else {
        lines.push(line("warn", prerequisite.label, `missing; fix: ${prerequisite.fix}`));
      }
    }
  }
  if (groups.includes("toolchain")) {
    lines.push("toolchain cache");
    for (const info of infoLines(options.env)) lines.push(line("info", info.label, info.detail));
  }
  return { lines, exitCode };
}

function main(): void {
  const flags = new Set(process.argv.slice(2));
  const toolchainOnly = flags.has("--toolchain-only");
  const result = runDoctor({
    env: process.env,
    toolchain: flags.has("--toolchain") || toolchainOnly,
    ...(toolchainOnly ? { groups: ["toolchain"] as const } : {}),
  });
  console.log(result.lines.join("\n"));
  process.exit(result.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
