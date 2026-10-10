/**
 * The fidelity ratchet. Reads the per-pack sheet JSONs a `parity:fab` sweep wrote (<out>/sheets/*.json, each
 * with per-tile fidelity) and compares them with docs/parity/fidelity-baseline.json.
 *
 *   npx tsx scripts/fidelity-baseline.ts check  <sweep out dir> [baseline.json]   exit 1 on a regression
 *   npx tsx scripts/fidelity-baseline.ts update <sweep out dir> [baseline.json]   record, never lowering a number
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { aggregateFidelity, fidelityRegressions, ratchetUp, type FidelityBaseline, type PackFidelity } from "../src/unreal/fidelity-baseline.js";

const [mode, sweepDir, baselinePath = "docs/parity/fidelity-baseline.json"] = process.argv.slice(2);
if ((mode !== "check" && mode !== "update") || !sweepDir) {
  console.error("usage: fidelity-baseline.ts check|update <sweep out dir> [baseline.json]");
  process.exit(2);
}
const current: Record<string, PackFidelity> = {};
const sheets = join(sweepDir, "sheets");
for (const file of existsSync(sheets) ? readdirSync(sheets).filter((name) => name.endsWith(".json")) : []) {
  const parsed = JSON.parse(readFileSync(join(sheets, file), "utf8")) as { judge?: Parameters<typeof aggregateFidelity>[0] };
  const aggregate = aggregateFidelity(parsed.judge ?? []);
  if (aggregate) current[basename(file, ".json")] = aggregate;
}
const baseline: FidelityBaseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};
if (mode === "update") {
  const next = ratchetUp(baseline, current);
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 1)}\n`);
  console.log(`baseline updated: ${Object.keys(current).length} pack(s) recorded in ${baselinePath}`);
} else {
  const regressions = fidelityRegressions(current, baseline);
  for (const r of regressions) console.log(`REGRESSION ${r.pack}: ${r.reason}`);
  console.log(`${Object.keys(current).length} pack(s) checked, ${Object.keys(current).filter((k) => baseline[k]).length} with a baseline, ${regressions.length} regression(s)`);
  process.exit(regressions.length > 0 ? 1 : 0);
}
