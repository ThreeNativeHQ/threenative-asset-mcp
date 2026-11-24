import * as THREE from "three";
import { INDOOR, OUTDOOR, OVERCAST, type Lighting } from "./core/clay.js";
import { Engine } from "./core/engine.js";
import { exportGlb } from "./core/export.js";
import { Gpu } from "./core/gpu.js";
import { toBlob, urlToRGBA } from "./core/image.js";
import {
  DEFAULT_PIPELINE,
  GRAZING_VIEW_LIMIT,
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
import { makeCamera, type ViewSpec } from "./core/views.js";
import { Viewer } from "./core/viewer.js";

export const LIGHTING: Record<string, Lighting> = { outdoor: OUTDOOR, overcast: OVERCAST, indoor: INDOOR };

/**
 * An image pixel that covers more than ~2x2 atlas texels is magnification blur (A.2): the atlas is
 * oversampled where the views cannot resolve more detail. Four texels per pixel is that 2x2.
 */
export const BLUR_TEXELS_PER_PIXEL = 4;

/** What a plan resolves at one atlas size: the footprint of the winning view per painted texel. */
export interface ProjectionMeasurement {
  /** Atlas size the footprints were measured at. */
  readonly atlas: number;
  readonly views: number;
  readonly islandTexels: number;
  readonly paintedTexels: number;
  /** Median texels per image pixel over painted island texels; 1 = one texel per pixel. */
  readonly medianFoot: number;
  /** Share of painted texels whose best view has one pixel covering more than 2x2 texels, in percent. */
  readonly blurredTexelPercent: number;
}

import { postHeaders } from "./token.js";

/** One loaded level with its engine and viewer: the object both the UI and the headless API drive. */
export class Session {
  readonly gpu: Gpu;
  level?: Level;
  engine?: Engine;
  viewer?: Viewer;
  plan?: Plan;
  record?: RunRecord;
  private abort?: AbortController;
  private measurement?: { atlas: number; foot: Float32Array; painted: Uint8Array; islandTexels: number; paintedTexels: number };

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

  /** Adopt a stored plan (inspect re-measures a finished run without repainting it). */
  usePlan(json: PlanJson) {
    this.plan = decodePlan(json);
    this.viewer?.showPlan(this.plan.points, this.plan.views);
    if (this.viewer) this.viewer.dirty = true;
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
    // A rejected view was never projected and has no images on disk; it is skipped, not re-bought.
    for (const v of saved.filter((view) => view.rejected === undefined)) {
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
    const base: ViewRecord = {
      index: viewIndex,
      wave: 0,
      spec: p.spec,
      model: p.model.key,
      first: p.isFirst,
      unknownFraction: p.unknownFraction,
      prompt: promptText(p),
      seconds: 0,
      price: 0,
      clay: p.clay,
      state: p.state,
      edit: p.edit,
      gen: new Uint8ClampedArray(0),
      comp: new Uint8ClampedArray(0),
      coverage: this.engine.atlas.coverage(),
      predicted: plan.predicted[viewIndex] ?? 0,
      grazingFraction: p.grazingFraction,
    };
    if (p.grazingFraction > GRAZING_VIEW_LIMIT) {
      // A prompt test on a view that is almost all grazing surface buys nothing: no request is made.
      const view: ViewRecord = { ...base, rejected: "grazing" };
      onEvent({ type: "view-done", view, cost: 0, elapsed: 0 });
      return view;
    }
    onEvent({ type: "view-start", index: viewIndex, wave: 0, model: p.model.key, state: p.state });
    const r = await generateView(p, this.engine.size, o.seed + viewIndex, o.feather, this.abort?.signal);
    if (!r.rejected) {
      this.engine.paint(p.spec, r.comp);
      this.viewer.setMode("textured");
      this.viewer.dirty = true;
    }
    const view: ViewRecord = {
      ...base,
      left: r.left,
      seconds: r.seconds,
      price: p.model.price,
      gen: r.gen,
      comp: r.comp,
      coverage: this.engine.atlas.coverage(),
      structureDeviation: r.structureDeviation,
      ...(r.rejected ? { rejected: "structure" as const } : {}),
    };
    onEvent({ type: "view-done", view, cost: p.model.price, elapsed: r.seconds });
    return view;
  }

  /**
   * Measure what the current plan resolves, texel by texel, without buying an image: the winning
   * view's footprint per atlas texel. Run it at the measurement atlas (<= 1024 px): the readback and
   * the transient sim targets are sized by the loaded atlas. `paintedOnly` masks to what this run
   * actually painted, so the number describes the bake, not only the plan.
   */
  async measure(opts: Partial<PlanOptions> = {}, paintedOnly = false): Promise<ProjectionMeasurement> {
    if (!this.engine) throw new Error("load a level first");
    const plan = this.plan ?? this.makePlan(opts);
    const engine = this.engine;
    const size = engine.options.atlasSize;
    const pixels = engine.atlas.measureProjection(
      plan.views.length,
      (index) => {
        const camera = makeCamera(plan.views[index]!);
        engine.views.renderGeometry(camera);
        return {
          camera,
          gPos: engine.views.geometryTarget.textures[0]!,
          foot: engine.views.geometryTarget.textures[3]!,
        };
      },
      engine.options.qualityRatio,
    );
    const islands = this.gpu.readU8(engine.atlas.islands, 0, false);
    const paintedMask = paintedOnly ? engine.atlas.paintedMask() : undefined;
    const foot = new Float32Array(size * size);
    const painted = new Uint8Array(size * size);
    let islandTexels = 0;
    let paintedTexels = 0;
    for (let i = 0; i < foot.length; i++) {
      const island = islands[4 * i]! > 127;
      if (island) islandTexels += 1;
      painted[i] = paintedMask ? paintedMask[i]! : pixels[4 * i]! > 0 ? 1 : 0;
      if (!island || !painted[i] || !(pixels[4 * i]! > 0)) continue;
      paintedTexels += 1;
      foot[i] = pixels[4 * i + 1]!;
    }
    this.measurement = { atlas: size, foot, painted, islandTexels, paintedTexels };
    return {
      atlas: size,
      views: plan.views.length,
      islandTexels,
      paintedTexels,
      medianFoot: medianOfPainted(this.measurement),
      blurredTexelPercent: this.blurredPercentAt(size),
    };
  }

  /**
   * The same footprint at another atlas size: an atlas twice as large puts four times as many texels
   * under one image pixel, so the blur threshold scales with the square of the size ratio. This is
   * what a quote reports for the atlas it just chose.
   */
  blurredPercentAt(atlasSize: number): number {
    const measurement = this.measurement;
    if (!measurement) throw new Error("measure before reading a blur percent");
    const threshold = BLUR_TEXELS_PER_PIXEL * (measurement.atlas / atlasSize) ** 2;
    if (measurement.paintedTexels === 0) return 0;
    let blurred = 0;
    const foot = measurement.foot;
    for (let i = 0; i < foot.length; i++) if (foot[i]! > 0 && foot[i]! > threshold) blurred += 1;
    return (100 * blurred) / measurement.paintedTexels;
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
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/${file}`, {
        method: "POST",
        headers: postHeaders("application/octet-stream"),
        body,
      });
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

/** Median of the painted texels' footprints, from a log2 histogram (no 1M-element sort). */
function medianOfPainted(measurement: { foot: Float32Array; painted: Uint8Array; paintedTexels: number }): number {
  if (measurement.paintedTexels === 0) return 0;
  const buckets = new Float64Array(128);
  for (let i = 0; i < measurement.foot.length; i++) {
    const value = measurement.foot[i]!;
    if (!(value > 0)) continue;
    const bucket = Math.min(127, Math.max(0, Math.floor((Math.log2(value) + 24) * 4)));
    buckets[bucket] = buckets[bucket]! + 1;
  }
  const half = measurement.paintedTexels / 2;
  let seen = 0;
  for (let b = 0; b < buckets.length; b++) {
    seen += buckets[b]!;
    if (seen >= half) return 2 ** ((b + 0.5) / 4 - 24);
  }
  return 0;
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
