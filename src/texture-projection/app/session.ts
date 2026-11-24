import * as THREE from "three";
import { INDOOR, OUTDOOR, OVERCAST, type Lighting } from "./core/clay.js";
import { Engine } from "./core/engine.js";
import { exportGlb } from "./core/export.js";
import { Gpu } from "./core/gpu.js";
import { toBlob, urlToRGBA } from "./core/image.js";
import {
  DEFAULT_PIPELINE,
  generateView,
  prepareView,
  promptText,
  runPipeline,
  type PipelineEvent,
  type PipelineOptions,
  type RunPrior,
  type RunRecord,
  type ViewRecord,
} from "./core/pipeline.js";
import { plan as makePlan, type Plan, type PlanOptions } from "./core/planner.js";
import { loadLevel, type Level } from "./core/scene.js";
import type { ViewSpec } from "./core/views.js";
import { Viewer } from "./core/viewer.js";

export const LIGHTING: Record<string, Lighting> = { outdoor: OUTDOOR, overcast: OVERCAST, indoor: INDOOR };

/** One loaded level with its engine and viewer: the object both the UI and the headless API drive. */
export class Session {
  readonly gpu: Gpu;
  level?: Level;
  engine?: Engine;
  viewer?: Viewer;
  plan?: Plan;
  record?: RunRecord;
  private abort?: AbortController;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.gpu = new Gpu(canvas);
  }

  async load(
    source: string | ArrayBuffer,
    name: string,
    lighting: Lighting = OUTDOOR,
    atlasSize = 4096,
    viewSize = 1024,
  ) {
    this.viewer?.controls.dispose();
    this.engine?.atlas.dispose();
    this.level = await loadLevel(source, name);
    this.engine = new Engine(this.gpu, this.level, { lighting, atlasSize, viewSize });
    this.viewer = new Viewer(this.engine, this.canvas);
    this.plan = undefined;
    this.record = undefined;
    return { triangles: this.level.triangles, area: Math.round(this.level.surfaceArea) };
  }

  setLighting(l: Lighting) {
    if (!this.engine || !this.viewer) return;
    this.engine.clay.setLighting(l);
    this.viewer.syncLighting();
  }

  makePlan(opts: Partial<PlanOptions> = {}) {
    if (!this.engine) throw new Error("load a level first");
    this.plan = makePlan(this.gpu, this.engine.level, this.engine.views, opts);
    this.viewer!.showPlan(this.plan.points, this.plan.views);
    return this.plan;
  }

  /** Paint `plan` (a stored plan on resume), skipping views `skip` already has; `prior` keeps its replay. */
  async run(
    opts: Partial<PipelineOptions>,
    onEvent: (e: PipelineEvent) => void,
    plan?: Plan,
    skip?: ReadonlySet<number>,
    prior?: RunPrior,
  ) {
    if (!this.engine || !this.viewer) throw new Error("load a level first");
    this.abort = new AbortController();
    if (!prior) this.engine.atlas.reset();
    this.viewer.setMode("textured");
    const record = await runPipeline(
      this.engine,
      opts,
      (e) => {
        if (e.type === "planned") {
          this.plan = e.plan;
          this.viewer!.showPlan(e.plan.points, e.plan.views);
        }
        if (e.type === "view-done") this.addSky(e.view);
        if (e.type === "done") this.viewer!.sky.finish();
        this.viewer!.dirty = true;
        onEvent(e);
      },
      this.abort.signal,
      plan,
      skip,
      prior,
    );
    this.record = record;
    return record;
  }

  /** Load a stored run's plan and composites into the engine; returns what still has to be painted. */
  async restore(runId: string, meta: StoredRun): Promise<{ plan: Plan; skip: Set<number>; prior: RunPrior }> {
    if (!this.engine || !this.viewer) throw new Error("load the level first");
    const S = this.engine.size;
    const plan = decodePlan(meta.plan);
    this.engine.atlas.reset();
    this.viewer.sky.reset();
    this.viewer.setMode("textured");
    const saved = [...meta.views].sort((a, b) => a.index - b.index);
    const prior: ViewRecord[] = [];
    for (const v of saved) {
      const comp = await urlToRGBA(`/api/runs/${encodeURIComponent(runId)}/view_${v.index}_comp.png`, S, S);
      const spec: ViewSpec = plan.views[v.index] ?? { ...v.spec, id: v.index };
      this.engine.paint(spec, comp);
      const view: ViewRecord = {
        ...v,
        spec,
        clay: new Uint8ClampedArray(0),
        state: new Uint8ClampedArray(0),
        edit: new Uint8Array(0),
        gen: new Uint8ClampedArray(0),
        comp,
        coverage: v.coverage,
        predicted: v.predicted,
      };
      prior.push(view);
      this.addSky(view);
    }
    this.viewer.sky.finish();
    this.plan = plan;
    this.viewer.showPlan(plan.points, plan.views);
    this.viewer.dirty = true;
    return { plan, skip: new Set(saved.map((v) => v.index)), prior: { views: prior, cost: meta.cost, seconds: meta.seconds } };
  }

  /** Paint one planned view only, against the texture built so far (a cheap prompt test). */
  async promptTest(
    viewIndex: number,
    opts: Partial<PipelineOptions>,
    onEvent: (e: PipelineEvent) => void,
  ) {
    if (!this.engine || !this.viewer) throw new Error("load a level first");
    const plan = this.plan ?? this.makePlan(opts.plan);
    const spec = plan.views[viewIndex];
    if (!spec) throw new Error(`no planned view ${viewIndex}`);
    const o: PipelineOptions = { ...DEFAULT_PIPELINE, ...opts };
    const p = prepareView(this.engine, spec, o, true);
    onEvent({ type: "view-start", index: viewIndex, wave: 0, model: p.model.key, state: p.state });
    const r = await generateView(p, this.engine.size, o.seed + viewIndex, o.feather, this.abort?.signal);
    this.engine.paint(p.spec, r.comp);
    this.viewer.setMode("textured");
    this.viewer.dirty = true;
    const view: ViewRecord = {
      index: viewIndex,
      wave: 0,
      spec: p.spec,
      model: p.model.key,
      first: p.isFirst,
      unknownFraction: p.unknownFraction,
      prompt: promptText(p),
      left: r.left,
      seconds: r.seconds,
      price: p.model.price,
      clay: p.clay,
      state: p.state,
      edit: p.edit,
      gen: r.gen,
      comp: r.comp,
      coverage: this.engine.atlas.coverage(),
      predicted: plan.predicted[viewIndex] ?? 0,
    };
    onEvent({ type: "view-done", view, cost: p.model.price, elapsed: r.seconds });
    return view;
  }

  stop() {
    this.abort?.abort();
  }

  private addSky(v: Pick<ViewRecord, "spec" | "model" | "comp">) {
    // only views whose model painted the whole frame: masked fills leave the clay sky as it was
    if (v.spec.kind === "roof") return;
    this.viewer!.sky.addView(v.spec, v.comp, this.engine!.geometryMask(v.spec), this.engine!.size);
  }

  /** Textured GLB of the level (unlit or lit material, depending on the lighting it was painted in). */
  async exportGlb(): Promise<ArrayBuffer> {
    if (!this.engine) throw new Error("nothing to export");
    return exportGlb(this.engine);
  }

  /** Write one finished view's images to the run directory through the local server, then drop them. */
  async saveView(runId: string, view: ViewRecord) {
    const S = this.engine!.size;
    const put = async (file: string, body: Blob) => {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/${file}`, { method: "POST", body });
      if (!res.ok) throw new Error(`saving ${file} failed: ${res.status}`);
    };
    await put(`view_${view.index}_clay.png`, await toBlob(view.clay, S, S, "image/png"));
    await put(`view_${view.index}_gen.png`, await toBlob(view.gen, S, S, "image/png"));
    await put(`view_${view.index}_comp.png`, await toBlob(view.comp, S, S, "image/png"));
    view.clay = new Uint8ClampedArray(0);
    view.state = new Uint8ClampedArray(0);
    view.edit = new Uint8Array(0);
    view.gen = new Uint8ClampedArray(0);
  }
}

/** What `/api/runs/<id>/run.json` holds, as far as the app reads it back. */
export interface StoredRun {
  level: string;
  levelPath?: string;
  options: PipelineOptions;
  plan: PlanJson;
  views: (Omit<ViewRecord, "clay" | "state" | "edit" | "gen" | "comp"> & { spec: ViewSpec })[];
  cost: number;
  seconds: number;
}

export interface PlanJson {
  points: [number, number, number][];
  views: ViewSpec[];
  waves: number[][];
  predicted: number[];
  grid: number;
  reachableCells: number;
}

export function encodePlan(plan: Plan): PlanJson {
  return {
    points: plan.points.map((p) => [p.x, p.y, p.z] as [number, number, number]),
    views: plan.views,
    waves: plan.waves,
    predicted: plan.predicted,
    grid: plan.grid,
    reachableCells: plan.reachableCells,
  };
}

export function decodePlan(json: PlanJson): Plan {
  const grid = json.grid;
  return {
    points: json.points.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    views: json.views,
    waves: json.waves,
    viewCells: json.views.map(() => ({ cells: new Int32Array(0), q: new Float32Array(0) })),
    qBest: new Float32Array(grid * grid),
    grid,
    reachableCells: json.reachableCells,
    predicted: json.predicted,
  };
}

export { INDOOR, OUTDOOR };
