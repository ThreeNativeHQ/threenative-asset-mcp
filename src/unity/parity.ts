/**
 * The Unity parity sweep (PRD-617): imports each corpus pack (`U1`..`U3`), scores it against R1 (else R2) with
 * `runUnityFidelity`, and writes what `scripts/fidelity-baseline.ts check` reads (`<out>/sheets/<id>.json`).
 *
 * Corpus layout (local only, see the epic README): `<corpus>/<id>/*.unitypackage`, an optional `<id>/reference/` (R1) and
 * an optional `<id>/slice.json` (`{ "assets": [...] }`, the model paths the PR renders). A missing corpus is not a failure.
 * Everything written under `<out>` derives from a licensed pack: local-only, never commit it.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { runUnityFidelity, summaryLine, unityTable, type UnityFidelityResult } from "./fidelity.js";
import { type UnityImportOptions, type UnityImportReport, importUnityPackage } from "./importer.js";
import { inventoryUnityAssets } from "./inventory.js";
import { openUnityPackage } from "./package.js";

export const CORPUS_IDS = ["U1", "U2", "U3"] as const;
export const DEFAULT_CORPUS = join(homedir(), ".cache", "threenative-asset-mcp", "unity-corpus");

export interface PackStructure {
  /** Prefabs in the package against GLBs out: the PRD-618 gap shows here. */
  readonly prefabsIn: number;
  readonly modelsIn: number;
  readonly glbsOut: number;
  readonly boundSlots: number;
  readonly embeddedSlots: number;
  readonly texturesResolved: number;
  readonly materials: number;
  readonly fallbackMaterials: number;
  /** Fallback materials grouped by reason, with how many materials each. Reasons name shaders, never assets. */
  readonly fallbackReasons: readonly { readonly reason: string; readonly materials: number }[];
  readonly failed: number;
  readonly skipped: number;
}

export function structureOf(report: UnityImportReport, prefabsIn: number, modelsIn: number): PackStructure {
  const reasons = new Map<string, number>();
  for (const material of report.materialAssets) {
    if (material.status === "fallback") reasons.set(material.fallbackReason ?? "unknown", (reasons.get(material.fallbackReason ?? "unknown") ?? 0) + 1);
  }
  return {
    prefabsIn,
    modelsIn,
    glbsOut: report.counts.models,
    boundSlots: report.counts.boundSlots,
    embeddedSlots: report.models.reduce((sum, model) => sum + model.slots.filter((slot) => slot.status === "embedded").length, 0),
    texturesResolved: report.counts.textures,
    materials: report.counts.materials,
    fallbackMaterials: report.counts.fallbackMaterials,
    fallbackReasons: [...reasons].map(([reason, materials]) => ({ reason, materials })).sort((a, b) => b.materials - a.materials),
    failed: report.counts.failed,
    skipped: report.counts.skipped,
  };
}

export interface PackOutcome {
  readonly id: string;
  readonly status: "measured" | "absent";
  readonly note?: string;
  readonly reference?: string;
  readonly structure?: PackStructure;
  readonly summary?: UnityFidelityResult["summary"];
}

export interface ParityOptions {
  readonly corpusDir: string;
  readonly outDir: string;
  readonly ids?: readonly string[];
  /** Pieces drawn per sheet. */
  readonly max?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly log?: (line: string) => void;
  /** Tests inject the importer's Blender. */
  readonly blender?: UnityImportOptions["blender"];
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

export async function runUnityParity(options: ParityOptions): Promise<PackOutcome[]> {
  const log = options.log ?? ((line: string) => console.log(line));
  const outcomes: PackOutcome[] = [];
  const sheets = join(resolve(options.outDir), "sheets");
  await mkdir(sheets, { recursive: true });
  for (const id of options.ids ?? CORPUS_IDS) {
    const packDir = join(resolve(options.corpusDir), id);
    const packages = (await readdir(packDir).catch(() => [] as string[])).filter((name) => name.endsWith(".unitypackage")).sort();
    if (packages.length === 0) {
      outcomes.push({ id, status: "absent", note: `no .unitypackage in ${packDir}` });
      log(`${id}: absent (no .unitypackage in ${packDir})`);
      continue;
    }
    const packagePath = join(packDir, packages[0]!);
    const out = join(resolve(options.outDir), id);
    await rm(out, { recursive: true, force: true });
    const slice = JSON.parse(await readFile(join(packDir, "slice.json"), "utf8").catch(() => "{}")) as { assets?: string[] };
    const referenceDir = join(packDir, "reference");

    const database = await openUnityPackage(packagePath);
    const inventory = inventoryUnityAssets(database);
    await database.dispose();

    const importDir = join(out, "import");
    const report = await importUnityPackage({
      source: packagePath,
      outputDir: importDir,
      ...(slice.assets && slice.assets.length > 0 ? { assets: slice.assets } : {}),
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.blender ? { blender: options.blender } : {}),
    });
    const structure = structureOf(report, inventory.prefab, inventory.model);
    const fidelity = await runUnityFidelity({
      importDir,
      out,
      packagePath,
      ...((await exists(referenceDir)) ? { referenceDir } : {}),
      ...(options.max !== undefined ? { max: options.max } : {}),
    });

    // The ratchet reads `{ judge }`; the rest is for people. Numbers and verdicts, no pixels.
    await writeFile(
      join(sheets, `${id}.json`),
      `${JSON.stringify({ judge: fidelity.pieces, reference: fidelity.reference, referenceNote: fidelity.referenceNote, summary: fidelity.summary, structure }, null, 1)}\n`,
    );
    log(`${id}: ${fidelity.referenceNote}`);
    log(
      `${id}: prefabs in ${structure.prefabsIn} vs GLBs out ${structure.glbsOut} (models in ${structure.modelsIn}); bound slots ${structure.boundSlots}, ` +
        `unbound ${structure.embeddedSlots}; textures resolved ${structure.texturesResolved}; materials ${structure.materials}; ` +
        `fallback materials ${structure.fallbackMaterials}; failed ${structure.failed}, skipped ${structure.skipped}`,
    );
    for (const entry of structure.fallbackReasons) log(`${id}:   fallback x${entry.materials}: ${entry.reason}`);
    log(`${id}: ${summaryLine(fidelity)}`);
    if (process.env.UNITY_PARITY_TABLE !== undefined) console.table(unityTable(fidelity));
    outcomes.push({ id, status: "measured", reference: fidelity.reference, structure, summary: fidelity.summary });
  }
  await writeFile(join(resolve(options.outDir), "structure.json"), `${JSON.stringify(outcomes, null, 1)}\n`);
  if (outcomes.every((outcome) => outcome.status === "absent")) {
    log(
      `No corpus: none of ${(options.ids ?? CORPUS_IDS).join(", ")} found under ${options.corpusDir}. Nothing imported, nothing measured. ` +
        "Put each pack's .unitypackage in <corpus>/<id>/ (see docs/PRDs/unity-asset-store-import/README.md, \"Verification corpus\").",
    );
  } else {
    log(`Sheets and numbers: ${options.outDir}. Next: npx tsx scripts/fidelity-baseline.ts check ${options.outDir}`);
  }
  return outcomes;
}
