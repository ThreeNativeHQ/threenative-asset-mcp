import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import sharp from "sharp";

import { loadLevel } from "../src/texture-projection/app/core/scene.js";
import { measureScaleAnchor } from "../src/texture-projection/app/core/scale.js";
import { forwardChatRequest } from "../src/texture-projection/openrouter-proxy.js";
import { StoredRunSchema, type StoredRun } from "../src/texture-projection/runs.js";
import { DEFAULT_VERIFY_MODEL, parseVerifyAnswer, verifyModelFor, verifyUsageUsd, verifyPrompt } from "../src/texture-projection/verify.js";

/**
 * Calibrate the vision check on a finished run's stored image pairs, with the production prompt and
 * the production server-side call path (never a browser). It reads the run directory only; the key
 * comes from OPENROUTER_API_KEY and is never printed or written.
 *
 *   OPENROUTER_API_KEY=… npx tsx scripts/verify-calibration.ts --run <run dir> --out <dir>
 *
 * The report lists every view's verdict (the structures it adds, whether its detail is at a
 * plausible size) so the flagged pairs can be looked at by eye and the prompt tuned until the real
 * inventions are flagged and plain good views pass.
 */

interface CalibrationRow {
  index: number;
  kind: string;
  verdict: string;
  added: string[];
  scaleOk: boolean;
  reason?: string;
  cameraHeightM: number;
  centreDistanceM: number;
  cost: number;
}

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
}

async function jpegDataUrl(path: string, quality: number): Promise<string> {
  const jpeg = await sharp(await readFile(path)).jpeg({ quality }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

async function main(): Promise<void> {
  const runDir = argument("run");
  const outDir = argument("out");
  if (runDir === undefined || outDir === undefined) {
    process.stderr.write("usage: verify-calibration.ts --run <run dir> --out <dir> [--model <id>] [--limit N]\n");
    process.exitCode = 2;
    return;
  }
  const model = argument("model") ?? DEFAULT_VERIFY_MODEL.id;
  const limit = Number(argument("limit") ?? "0") || Number.POSITIVE_INFINITY;
  const only = argument("views")?.split(",").map((value) => Number(value.trim())).filter(Number.isFinite);
  const parsedRun = StoredRunSchema.safeParse(
    await readFile(join(resolve(runDir), "run.json"), "utf8").then(
      (text) => JSON.parse(text) as unknown,
      () => undefined,
    ),
  );
  if (!parsedRun.success) {
    process.stderr.write(`no readable run.json under ${runDir}\n`);
    process.exitCode = 1;
    return;
  }
  const run: StoredRun = parsedRun.data;
  const bytes = await readFile(run.levelPath);
  const level = await loadLevel(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    run.level,
  );
  await mkdir(outDir, { recursive: true });

  const rows: CalibrationRow[] = [];
  const views = run.views
    .filter((view) => only === undefined || only.includes(view.index))
    .slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit);
  for (const view of views) {
    const anchor = measureScaleAnchor(level, view.spec);
    const prompt = verifyPrompt({
      cameraHeightM: anchor.cameraHeight,
      centreDistanceM: anchor.centreDistance,
      ...(view.spec.kind === undefined ? {} : { kind: view.spec.kind }),
    });
    const images: [string, string] = [
      await jpegDataUrl(join(runDir, `view_${view.index}_clay.png`), 95),
      await jpegDataUrl(join(runDir, `view_${view.index}_gen.png`), 90),
    ];
    const response = await forwardChatRequest({ model, prompt, images }, {});
    const text = new TextDecoder().decode(response.bytes);
    let content: unknown;
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    try {
      const parsed = JSON.parse(text) as { choices?: { message?: { content?: unknown } }[]; usage?: typeof usage };
      content = parsed.choices?.[0]?.message?.content;
      usage = parsed.usage;
    } catch {
      content = undefined;
    }
    const answer =
      typeof content === "string"
        ? parseVerifyAnswer(content)
        : { added: [], scaleOk: false, verdict: "unparsed" as const, reason: `status ${response.status}` };
    if (answer.verdict === "unparsed") {
      // Only the model's own answer, never the request: the prompt carries no key.
      process.stdout.write(`  raw: ${String(content).slice(0, 400)}\n`);
    }
    const row: CalibrationRow = {
      index: view.index,
      kind: view.spec.kind ?? "ground",
      verdict: answer.verdict,
      added: [...answer.added],
      scaleOk: answer.scaleOk,
      ...(answer.reason === undefined ? {} : { reason: answer.reason }),
      cameraHeightM: +anchor.cameraHeight.toFixed(2),
      centreDistanceM: +anchor.centreDistance.toFixed(2),
      cost: verifyUsageUsd(verifyModelFor(model), usage, run.viewSize),
    };
    rows.push(row);
    process.stdout.write(
      `view ${String(row.index).padStart(2)} ${row.kind.padEnd(6)} ${row.verdict.padEnd(8)} scaleOk=${row.scaleOk} ` +
        `${row.cameraHeightM}m/${row.centreDistanceM}m ` +
        `${row.added.length ? row.added.join("; ") : "-"}${row.reason === undefined ? "" : ` (${row.reason})`}\n`,
    );
  }

  const report = {
    runId: run.runId,
    model,
    views: rows.length,
    rejected: rows.filter((row) => row.verdict === "rejected").length,
    unparsed: rows.filter((row) => row.verdict === "unparsed").length,
    scaleFailed: rows.filter((row) => !row.scaleOk).length,
    costUsd: +rows.reduce((sum, row) => sum + row.cost, 0).toFixed(4),
    flagged: rows.filter((row) => row.verdict !== "ok").map((row) => row.index),
    rows,
  };
  const path = join(outDir, `verify-calibration-${model.replace(/[^a-z0-9]+/gi, "-")}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 1)}\n`);
  process.stdout.write(
    `\n${report.views} views · ${report.rejected} rejected · ${report.unparsed} unparsed · ` +
      `${report.scaleFailed} implausible sizes · $${report.costUsd}\nflagged: ${report.flagged.join(", ") || "none"}\n` +
      `report: ${path}\n`,
  );
}

await main();
