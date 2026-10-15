/**
 * PRD-617 Unity parity sweep: imports the corpus packs U1-U3 with the PRD-616 importer, scores each against R1 (else R2)
 * and writes sheets, structural numbers and `sheets/<id>.json` for `scripts/fidelity-baseline.ts`.
 *
 *   npm run parity:unity -- [--dir <corpus dir>] [--out <dir>] [--ids U1,U2] [--max 36]
 *
 * The corpus defaults to ~/.cache/threenative-asset-mcp/unity-corpus (<id>/*.unitypackage, optional <id>/reference/ for R1
 * and <id>/slice.json). With no pack present it prints a note and exits 0. Output defaults to artifacts/parity/unity and
 * derives from licensed packs: local-only, never commit it. Then run
 * `npx tsx scripts/fidelity-baseline.ts check <out>` (and `update` once the sheets have been inspected).
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

import { DEFAULT_CORPUS, runUnityParity } from "../src/unity/parity.js";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

if (process.argv.includes("--help")) {
  console.log("usage: npm run parity:unity -- [--dir <corpus dir>] [--out <dir>] [--ids U1,U2,U3] [--max N]");
  process.exit(0);
}
const corpus = resolve((arg("--dir") ?? DEFAULT_CORPUS).replace(/^~(?=\/)/, homedir()));
await runUnityParity({
  corpusDir: corpus,
  outDir: resolve(arg("--out") ?? "artifacts/parity/unity"),
  ...(arg("--ids") ? { ids: arg("--ids")!.split(",").map((id) => id.trim()).filter(Boolean) } : {}),
  ...(arg("--max") ? { max: Number(arg("--max")) } : {}),
});
