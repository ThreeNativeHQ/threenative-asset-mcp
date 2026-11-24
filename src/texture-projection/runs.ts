import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

/** What the vision check said about a stored view (phase 2c). */
const ViewVerifySchema = z.object({
  model: z.string().min(1),
  added: z.array(z.string()),
  /** Of `added`, the bands along an edge (coping, plinth): recorded, never a rejection on their own. */
  bands: z.array(z.string()).optional(),
  scaleOk: z.boolean(),
  verdict: z.enum(["ok", "rejected", "unparsed"]),
});

/** One view of a run, as stored in run.json: everything a resume needs, and no image pixels. */
const StoredViewSchema = z.object({
  index: z.number().int().nonnegative(),
  wave: z.number().int().nonnegative(),
  spec: z.object({
    id: z.number().int().nonnegative(),
    position: z.tuple([z.number(), z.number(), z.number()]),
    yaw: z.number(),
    pitch: z.number(),
    fov: z.number(),
    kind: z.enum(["ground", "aerial", "roof", "fill"]).optional(),
  }),
  model: z.string().min(1),
  first: z.boolean(),
  unknownFraction: z.number(),
  prompt: z.string().optional(),
  left: z.number().optional(),
  seconds: z.number(),
  price: z.number(),
  coverage: z.number(),
  predicted: z.number(),
  /** Why nothing was projected: grazing surfaces only, an image that invented geometry, the vision check, or the caller's own verdict. */
  rejected: z.enum(["grazing", "structure", "verify", "caller"]).optional(),
  structureDeviation: z.number().optional(),
  /** Share of the view's clay-sky cells the model painted solid surface into (structure.ts, B.2). */
  silhouetteMismatch: z.number().optional(),
  /** Share of the view's painted strong edges that lie on no clay edge (structure.ts, phase 2q). */
  edgeMisalignment: z.number().optional(),
  grazingFraction: z.number().optional(),
  /** Share of the view's pixels the strip along the clay's own edges left out of the projection. */
  edgeBandShare: z.number().optional(),
  /** The vision check's verdict on the image this view kept (a repaint's verdict when it was repainted). */
  verify: ViewVerifySchema.optional(),
  /** The vision check rejected the first attempt, so the view was painted once more. */
  repainted: z.boolean().optional(),
});

const PlanSchema = z.object({
  points: z.array(z.tuple([z.number(), z.number(), z.number()])),
  views: z.array(StoredViewSchema.shape.spec),
  waves: z.array(z.array(z.number().int().nonnegative())),
  predicted: z.array(z.number()),
  grid: z.number().int().positive(),
  reachableCells: z.number().int().nonnegative(),
});

export const StoredRunSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  level: z.string().min(1),
  levelPath: z.string().min(1),
  lighting: z.enum(["outdoor", "overcast", "indoor"]),
  atlas: z.number().int().positive(),
  viewSize: z.number().int().positive(),
  /** Only what the caller chose; the pipeline's defaults fill the rest on resume. */
  options: z.record(z.string(), z.unknown()),
  plan: PlanSchema,
  views: z.array(StoredViewSchema),
  cost: z.number(),
  seconds: z.number(),
  complete: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type StoredView = z.infer<typeof StoredViewSchema>;
export type StoredPlan = z.infer<typeof PlanSchema>;
export type StoredRun = z.infer<typeof StoredRunSchema>;

export interface RunSummaryRow {
  readonly runId: string;
  readonly level: string;
  readonly views: number;
  readonly complete: boolean;
  readonly cost: number;
  readonly seconds: number;
  readonly updatedAt: string;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A run id that is safe as a directory name (no separators, no `..`, no dotfiles). */
export function isSafeRunId(runId: string): boolean {
  return SAFE_NAME.test(runId) && !runId.includes("..");
}

export function isSafeRunFile(file: string): boolean {
  return SAFE_NAME.test(file) && !file.includes("..");
}

export function defaultRunRoot(cwd = process.cwd()): string {
  return join(cwd, ".threenative", "texture-projection");
}

export function runDirectory(runRoot: string, runId: string): string {
  if (!isSafeRunId(runId)) throw new Error(`unsafe run id: ${runId}`);
  return join(runRoot, runId);
}

/** Writes run.json beside the view images: a temp file in the same directory, then a rename. */
export async function writeRun(runRoot: string, run: StoredRun): Promise<void> {
  const parsed = StoredRunSchema.parse(run);
  const directory = runDirectory(runRoot, run.runId);
  await mkdir(directory, { recursive: true });
  const target = join(directory, "run.json");
  const temporary = join(directory, `.run.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(temporary, `${JSON.stringify(parsed, null, 1)}\n`);
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readRun(runRoot: string, runId: string): Promise<StoredRun | undefined> {
  try {
    const text = await readFile(join(runDirectory(runRoot, runId), "run.json"), "utf8");
    const parsed = StoredRunSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Stored runs under `runRoot`, newest first. A run whose run.json is unreadable is skipped. */
export async function listRuns(runRoot: string): Promise<RunSummaryRow[]> {
  let entries: string[];
  try {
    entries = await readdir(runRoot);
  } catch {
    return [];
  }
  const rows: RunSummaryRow[] = [];
  for (const entry of entries) {
    if (!isSafeRunId(entry)) continue;
    try {
      if (!(await stat(join(runRoot, entry))).isDirectory()) continue;
    } catch {
      continue;
    }
    const run = await readRun(runRoot, entry);
    if (!run) continue;
    rows.push({
      runId: run.runId,
      level: run.level,
      views: run.views.length,
      complete: run.complete,
      cost: run.cost,
      seconds: run.seconds,
      updatedAt: run.updatedAt,
    });
  }
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
