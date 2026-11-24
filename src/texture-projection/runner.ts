import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import { NodeIO, Primitive } from "@gltf-transform/core";

import { DEFAULT_MODEL, resolveModel } from "./models.js";
import { defaultRunRoot, readRun, writeRun, type StoredPlan, type StoredRun, type StoredView } from "./runs.js";
import { openAppSession, type AppEvent } from "./session.js";
import { startUiServer } from "./ui-server.js";

export type TextureProjectionErrorCode =
  | "TEXTURE_PROJECT_MISSING_UV"
  | "TEXTURE_PROJECT_MISSING_API_KEY"
  | "TEXTURE_PROJECT_LEVEL_NOT_FOUND"
  | "TEXTURE_PROJECT_LEVEL_UNREADABLE"
  | "TEXTURE_PROJECT_RUN_NOT_FOUND"
  | "TEXTURE_PROJECT_FAILED";

export class TextureProjectionError extends Error {
  constructor(
    readonly code: TextureProjectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TextureProjectionError";
  }
}

export interface TextureProjectionPlanInput {
  /** Ground cameras to paint, capped by the planner's budget. */
  readonly maxViews?: number;
  readonly aerial?: number;
  readonly roofs?: number;
  readonly holes?: number;
  readonly spacing?: number;
}

export interface TextureProjectionHooks {
  /** Called once a view is on disk. Throwing interrupts the run; its paid views stay resumable. */
  readonly onViewDone?: (view: StoredView, run: StoredRun) => void | Promise<void>;
}

export interface TextureProjectionRequest {
  /** Level GLB to texture. Required unless resuming, where the stored run names it. */
  readonly levelPath?: string;
  readonly resumeRunId?: string;
  /** Paint a single planned view (a prompt test) instead of the whole run. */
  readonly promptTestView?: number;
  readonly runId?: string;
  readonly outputPath?: string;
  readonly firstModel?: string;
  readonly fillModel?: string;
  readonly style?: string;
  readonly roofStyle?: string;
  readonly lighting?: "outdoor" | "overcast" | "indoor";
  readonly atlas?: number;
  readonly viewSize?: number;
  readonly styleImagePath?: string;
  readonly plan?: TextureProjectionPlanInput;
  readonly hooks?: TextureProjectionHooks;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly onEvent?: (event: AppEvent) => void;
  readonly onLog?: (line: string) => void;
  readonly timeoutMs?: number;
}

export interface TextureProjectionQuote {
  readonly level: string;
  readonly model: string;
  readonly pricePerView: number;
  readonly views: number;
  readonly aerial: number;
  readonly roofs: number;
  readonly holes: number;
  readonly points: number;
  readonly predicted: number;
  readonly estimatedUsd: number;
}

export interface TextureProjectionResult {
  readonly runId: string;
  readonly level: string;
  readonly outputPath: string;
  readonly views: number;
  readonly viewsPainted: number;
  readonly coveragePercent: number;
  readonly estimatedUsd: number;
  readonly seconds: number;
  readonly complete: boolean;
}

/** Plan summary the browser app returns (see app/api.ts). */
interface BrowserPlan {
  readonly views: number;
  readonly points: number;
  readonly waves: number;
  readonly aerial: number;
  readonly roofs: number;
  readonly holes: number;
  readonly predicted: number;
  readonly plan: StoredPlan;
}

interface BrowserRun {
  readonly runId: string;
  readonly views: number;
  readonly painted: number;
  readonly cost: number;
  readonly seconds: number;
  readonly coverage: number;
}

interface BrowserPromptTest {
  readonly index: number;
  readonly price: number;
  readonly seconds: number;
  readonly coverage: number;
}

interface PreparedLevel {
  readonly absolute: string;
  readonly name: string;
}

async function prepareLevel(levelPath: string, cwd: string): Promise<PreparedLevel> {
  const absolute = isAbsolute(levelPath) ? levelPath : resolve(cwd, levelPath);
  const extension = extname(absolute).toLowerCase();
  try {
    if (!(await stat(absolute)).isFile()) throw new Error("not a file");
  } catch {
    throw new TextureProjectionError("TEXTURE_PROJECT_LEVEL_NOT_FOUND", `level not found: ${levelPath}`);
  }
  if (extension !== ".glb" && extension !== ".gltf") {
    throw new TextureProjectionError("TEXTURE_PROJECT_LEVEL_UNREADABLE", `not a glTF file: ${levelPath}`);
  }
  await assertUvMapped(absolute);
  return { absolute, name: basename(absolute).replace(/\.\w+$/, "") };
}

/**
 * Fails closed before a browser is launched: the projection bakes into UV space, so a primitive with
 * no TEXCOORD_0 cannot be textured at all.
 */
async function assertUvMapped(path: string): Promise<void> {
  let root;
  try {
    root = (await new NodeIO().read(path)).getRoot();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TextureProjectionError("TEXTURE_PROJECT_LEVEL_UNREADABLE", `could not read ${path}: ${reason}`);
  }
  const meshes = root.listMeshes();
  if (meshes.length === 0) {
    throw new TextureProjectionError("TEXTURE_PROJECT_LEVEL_UNREADABLE", `${path} has no meshes`);
  }
  for (const mesh of meshes) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== Primitive.Mode.TRIANGLES) continue;
      if (!primitive.listSemantics().includes("TEXCOORD_0")) {
        const name = mesh.getName() || "unnamed mesh";
        throw new TextureProjectionError(
          "TEXTURE_PROJECT_MISSING_UV",
          `mesh "${name}" in ${path} has no TEXCOORD_0; unwrap the level before projecting a texture onto it`,
        );
      }
    }
  }
}

function requireApiKey(env: NodeJS.ProcessEnv): void {
  if (!env.OPENROUTER_API_KEY?.trim()) {
    throw new TextureProjectionError(
      "TEXTURE_PROJECT_MISSING_API_KEY",
      "OPENROUTER_API_KEY is not set; painting calls OpenRouter image models with your own key",
    );
  }
}

function planInput(request: TextureProjectionRequest): Record<string, number> {
  const plan = request.plan ?? {};
  const out: Record<string, number> = {};
  for (const key of ["maxViews", "aerial", "roofs", "holes", "spacing"] as const) {
    const value = plan[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Only what the caller chose; the pipeline's own defaults fill the rest, on resume too. */
function pipelineOptions(request: TextureProjectionRequest): Record<string, unknown> {
  const options: Record<string, unknown> = { plan: planInput(request) };
  if (request.style !== undefined) options.style = request.style;
  if (request.roofStyle !== undefined) options.roofStyle = request.roofStyle;
  if (request.firstModel !== undefined) options.firstModel = request.firstModel;
  if (request.fillModel !== undefined) options.fillModel = request.fillModel;
  return options;
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(temporary, bytes);
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Plans cameras in the browser and reports what a run would buy. No model calls, so no key is needed. */
export async function quoteTextureProjection(
  request: TextureProjectionRequest & { readonly levelPath: string },
): Promise<TextureProjectionQuote> {
  const cwd = request.cwd ?? process.cwd();
  const level = await prepareLevel(request.levelPath, cwd);
  const alias = request.firstModel ?? DEFAULT_MODEL;
  const price = resolveModel(alias)?.price ?? 0;
  const server = await startUiServer({
    levelPath: level.absolute,
    runRoot: defaultRunRoot(cwd),
    ...(request.env === undefined ? {} : { env: request.env }),
    ...(request.styleImagePath === undefined ? {} : { styleImagePath: request.styleImagePath }),
  });
  const app = await openAppSession({
    url: server.url,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.onLog === undefined ? {} : { onLog: request.onLog }),
  });
  try {
    await app.call("load", "/api/level", {
      lighting: request.lighting ?? "overcast",
      atlasSize: request.atlas ?? 4096,
      viewSize: request.viewSize ?? 1024,
      name: level.name,
    });
    const plan = await app.call<BrowserPlan>("plan", planInput(request));
    // Every planned view is one image, and the hole pass may add up to its budget on top.
    return {
      level: level.name,
      model: alias,
      pricePerView: price,
      views: plan.views,
      aerial: plan.aerial,
      roofs: plan.roofs,
      holes: plan.holes,
      points: plan.points,
      predicted: plan.predicted,
      estimatedUsd: (plan.views + plan.holes) * price,
    };
  } finally {
    await app.close();
    await server.close();
  }
}

/**
 * Paints a level, or resumes a stored run, and writes the baked GLB atomically. Each finished view is
 * persisted with run.json before the next one starts, so an interrupted run keeps every paid view and
 * a resume requests only the views still missing.
 */
export async function paintTextureProjection(request: TextureProjectionRequest): Promise<TextureProjectionResult> {
  const cwd = request.cwd ?? process.cwd();
  const env = request.env ?? process.env;
  const runRoot = defaultRunRoot(cwd);
  if (request.resumeRunId !== undefined && request.promptTestView !== undefined) {
    throw new TextureProjectionError(
      "TEXTURE_PROJECT_FAILED",
      "promptTestView paints a freshly planned view, so it cannot be combined with resumeRunId",
    );
  }
  const stored =
    request.resumeRunId === undefined
      ? undefined
      : await readRun(runRoot, request.resumeRunId).then((run) => {
          if (!run) {
            throw new TextureProjectionError(
              "TEXTURE_PROJECT_RUN_NOT_FOUND",
              `no stored run ${request.resumeRunId} in ${runRoot}`,
            );
          }
          return run;
        });
  const levelPath = request.levelPath ?? stored?.levelPath;
  if (levelPath === undefined) {
    throw new TextureProjectionError("TEXTURE_PROJECT_LEVEL_NOT_FOUND", "levelPath is required unless resuming a run");
  }
  const level = await prepareLevel(levelPath, cwd);
  if (stored === undefined) requireApiKey(env);
  const firstModel = request.firstModel ?? DEFAULT_MODEL;
  if (resolveModel(firstModel) === undefined) {
    throw new TextureProjectionError("TEXTURE_PROJECT_FAILED", `unknown model alias: ${firstModel}`);
  }
  if (request.fillModel !== undefined && resolveModel(request.fillModel) === undefined) {
    throw new TextureProjectionError("TEXTURE_PROJECT_FAILED", `unknown model alias: ${request.fillModel}`);
  }
  const lighting = stored?.lighting ?? request.lighting ?? "overcast";
  const atlas = stored?.atlas ?? request.atlas ?? 4096;
  const viewSize = stored?.viewSize ?? request.viewSize ?? 1024;
  const runId = request.runId ?? stored?.runId ?? `${level.name}-${Date.now().toString(36)}`;
  const now = new Date().toISOString();
  const run: StoredRun = stored ?? {
    version: 1,
    runId,
    level: level.name,
    levelPath: level.absolute,
    lighting,
    atlas,
    viewSize,
    options: pipelineOptions(request),
    plan: { points: [], views: [], waves: [], predicted: [], grid: 1, reachableCells: 0 },
    views: [],
    cost: 0,
    seconds: 0,
    complete: false,
    createdAt: now,
    updatedAt: now,
  };

  let failure: unknown;
  let interrupt: (error: unknown) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    interrupt = reject;
  });
  interrupted.catch(() => undefined); // awaited through Promise.race below

  let pending: Promise<void> = Promise.resolve();
  const server = await startUiServer({
    runRoot,
    levelPath: level.absolute,
    ...(request.env === undefined ? {} : { env: request.env }),
    ...(request.styleImagePath === undefined ? {} : { styleImagePath: request.styleImagePath }),
  });
  const app = await openAppSession({
    url: server.url,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.onLog === undefined ? {} : { onLog: request.onLog }),
    onEvent: (event) => {
      request.onEvent?.(event);
      pending = pending.then(async () => {
        try {
          await handleEvent(event);
        } catch (error) {
          if (failure === undefined) {
            failure = error;
            interrupt(error);
          }
        }
      });
    },
  });

  async function handleEvent(event: AppEvent): Promise<void> {
    if (event.type === "planned") {
      const plan = (event as { plan?: StoredPlan }).plan;
      if (plan) run.plan = plan;
      return;
    }
    if (event.type !== "view-done") return;
    const view = event as unknown as {
      index: number;
      wave: number;
      spec: StoredView["spec"];
      model: string;
      first: boolean;
      unknown: number;
      left?: number;
      prompt?: string;
      seconds: number;
      price: number;
      coverage: number;
      predicted: number;
      cost: number;
      elapsed: number;
    };
    const storedView: StoredView = {
      index: view.index,
      wave: view.wave,
      spec: view.spec,
      model: view.model,
      first: view.first,
      unknownFraction: view.unknown,
      seconds: view.seconds,
      price: view.price,
      coverage: view.coverage,
      predicted: view.predicted,
      ...(view.prompt === undefined ? {} : { prompt: view.prompt }),
      ...(view.left === undefined ? {} : { left: view.left }),
    };
    run.views = [...run.views.filter((v) => v.index !== storedView.index), storedView].sort(
      (a, b) => a.index - b.index,
    );
    run.cost = view.cost;
    run.seconds = (stored?.seconds ?? 0) + view.elapsed;
    run.updatedAt = new Date().toISOString();
    await writeRun(runRoot, run);
    await request.hooks?.onViewDone?.(storedView, run);
  }

  try {
    await app.call("load", "/api/level", { lighting, atlasSize: atlas, viewSize, name: level.name });

    let summary: BrowserRun;
    if (request.promptTestView !== undefined) {
      const plan = await app.call<BrowserPlan>("plan", planInput(request));
      run.plan = plan.plan;
      run.updatedAt = new Date().toISOString();
      await writeRun(runRoot, run);
      const painted = await Promise.race([
        app.call<BrowserPromptTest>("promptTest", {
          runId,
          viewIndex: request.promptTestView,
          options: run.options,
        }),
        interrupted,
      ]);
      summary = {
        runId,
        views: run.views.length,
        painted: 1,
        cost: run.cost,
        seconds: run.seconds,
        coverage: painted.coverage,
      };
    } else if (stored !== undefined) {
      summary = await Promise.race([app.call<BrowserRun>("resume", runId), interrupted]);
    } else {
      summary = await Promise.race([app.call<BrowserRun>("run", { runId, options: run.options }), interrupted]);
    }
    await pending;
    if (failure !== undefined) throw failure;

    const base64 = await app.call<string>("glb");
    const outputPath = request.outputPath ?? join(runRoot, runId, "level_textured.glb");
    await atomicWrite(outputPath, Buffer.from(base64, "base64"));
    // A prompt test buys one view; it does not make the level's run complete.
    run.complete = request.promptTestView === undefined;
    run.cost = summary.cost;
    run.seconds = summary.seconds;
    run.updatedAt = new Date().toISOString();
    await writeRun(runRoot, run);
    return {
      runId,
      level: level.name,
      outputPath,
      views: summary.views,
      viewsPainted: summary.painted,
      coveragePercent: Math.round(summary.coverage * 100),
      estimatedUsd: summary.cost,
      seconds: summary.seconds,
      complete: run.complete,
    };
  } finally {
    // Closing the browser is what interrupts a run whose hook threw: its page stops mid-view.
    await app.close();
    await server.close();
  }
}
