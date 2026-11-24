import * as THREE from "three";
import { aerialPassOnlyHidden, type PaintFill } from "../atlas-pixels.js";
import { ATLAS_GAP_CELLS, MAX_TEXELS_PER_PIXEL } from "./core/atlas.js";
import { INDOOR, OUTDOOR, OVERCAST, type Lighting } from "./core/clay.js";
import { Engine } from "./core/engine.js";
import { exportGlb } from "./core/export.js";
import { Gpu } from "./core/gpu.js";
import { toBlob, urlToRGBA } from "./core/image.js";
import {
  DEFAULT_PIPELINE,
  GRAZING_VIEW_LIMIT,
  consistencyReference,
  judgeView,
  paintPreparedView,
  prepareView,
  promptText,
  runPipeline,
  type PipelineEvent,
  type PipelineOptions,
  type RunPrior,
  type RunRecord,
  type ViewRecord,
  type VisibleCoverage,
} from "./core/pipeline.js";
import { plan as makePlan, type Plan, type PlanOptions } from "./core/planner.js";
import { loadLevel, type Level } from "./core/scene.js";
import { classifyView } from "./core/semantics.js";
import { edgeBandMask } from "./core/silhouette.js";
import {
  SWATCH_CLASSES,
  SWATCH_PROBE_PX,
  SWATCH_SIDE_METRES,
  WALL_MAX_NY,
  patchPainted,
  pickSwatch,
  rectifySwatch,
  tileSwatch,
  type SwatchCandidate,
  type ViewGeometry,
} from "./core/swatch.js";
import { makeCamera, ViewRenderer, type ViewSpec } from "./core/views.js";
import { Viewer } from "./core/viewer.js";

export const LIGHTING: Record<string, Lighting> = { outdoor: OUTDOOR, overcast: OVERCAST, indoor: INDOOR };

/**
 * One image pixel may cover at most 2x2 atlas texels along its worse axis (A.2, PRD-916 phase 2d):
 * the footprint the projection measures is that worse axis, so the guard's threshold is 2, not 4.
 */
export const BLUR_TEXELS_PER_PIXEL = MAX_TEXELS_PER_PIXEL;

/** How many of a class' ranked patch candidates are tried against the stored paint before it is given up. */
const SWATCH_ATTEMPTS = 4;

/** One material swatch a run cut, as `swatches.json` records it and the paint result carries it. */
export interface SwatchReportEntry {
  /** Run file: `swatch_wall.png` or `swatch_floor.png`. */
  readonly file: string;
  /** Patch side in metres, before the wrap crop: the largest square the view gave (see `metresX`). */
  readonly metres: number;
  /** Extent of the cut swatch along the patch's u axis, metres: the width a game repeats it at. */
  readonly metresX: number;
  /** Extent along the patch's v axis, metres: its height. A cropped axis is shorter than `metres`. */
  readonly metresY: number;
  /** Index of the accepted view it was cut from. */
  readonly view: number;
  /** Metres of surface per swatch pixel: the scale a game tiles it at. The same on both axes. */
  readonly metresPerPixel: number;
  /** Metres of surface per pixel of that view (below the above means the swatch is an upsample). */
  readonly sourceMetresPerPixel: number;
  /** Angle between the patch's normal and the direction to its view, in degrees. */
  readonly incidence: number;
  /** The patch's four world corners, in order: -u-v, +u-v, +u+v, -u+v (from its centre). */
  readonly corners: [number, number, number][];
}

/** What a run could cut: a class with no qualifying patch is absent, never faked. */
export type SwatchReport = { wall?: SwatchReportEntry; floor?: SwatchReportEntry };

/** What a plan resolves at one atlas size: the footprint of the winning view per painted texel. */
export interface ProjectionMeasurement {
  /** Atlas size the footprints were measured at. */
  readonly atlas: number;
  readonly views: number;
  readonly islandTexels: number;
  readonly paintedTexels: number;
  /** Median texels per image pixel over painted island texels; 1 = one texel per pixel. */
  readonly medianFoot: number;
  /** Share of painted texels whose best view has one pixel covering more than 2x2 texels along its worse axis, in percent. */
  readonly blurredTexelPercent: number;
  /** Share of island texels the projection's magnification guard refuses (unpainted, no detail to give). */
  readonly magnificationSkippedPercent: number;
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
  /** 128 px renderer the hole pass ranks candidate cameras with (B, phase 2d). */
  private holeProbe?: ViewRenderer;
  /** Probe renderer the swatch search reads a view's geometry back with (phase 2m). */
  private swatchProbe?: ViewRenderer;
  /** 1 per texel a player-height view sees: an aerial or roof pass must not paint those (phase 2e). */
  private playerVisible?: { plan: Plan; target: THREE.WebGLRenderTarget };

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
    this.clearPlayerVisible();
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
    this.clearPlayerVisible();
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
      this,
    );
    this.record = record;
    return record;
  }

  /**
   * Project one view into the atlas, honouring phase 2e: a pass that looks down on the level from above
   * (aerial, roof) may only paint the texels no player-height view sees, so the ground a player walks on
   * can never be an aerial camera's invention.
   */
  paintView(plan: Plan, spec: ViewSpec, comp: Uint8ClampedArray) {
    if (!this.engine) return;
    this.engine.paint(spec, comp, aerialPassOnlyHidden(spec.kind) ? this.playerVisibleMask(plan) : undefined);
  }

  /**
   * The player-height projection mask for `plan`, built once per session and reused by every aerial and
   * roof pass (it depends on the cameras and the geometry only, never on what has been painted).
   */
  private playerVisibleMask(plan: Plan): THREE.Texture | undefined {
    if (!this.engine) return undefined;
    if (this.playerVisible?.plan === plan) return this.playerVisible.target.texture;
    const player = plan.views.filter((view) => view.kind === undefined || view.kind === "ground");
    if (player.length === 0) return undefined;
    this.playerVisible?.target.dispose();
    const target = this.engine.atlas.projectionMask(player.length, (index) => {
      const camera = makeCamera(player[index]!);
      this.engine!.views.renderGeometry(camera);
      return { camera, gPos: this.engine!.views.geometryTarget.textures[0]! };
    });
    this.playerVisible = { plan, target };
    return target.texture;
  }

  /** Drop the cached player-visible mask (a new plan or a new level invalidates it). */
  private clearPlayerVisible() {
    this.playerVisible?.target.dispose();
    this.playerVisible = undefined;
  }

  /** Adopt a stored plan (inspect re-measures a finished run without repainting it). */
  usePlan(json: PlanJson) {
    this.clearPlayerVisible();
    this.plan = decodePlan(json);
    this.viewer?.showPlan(this.plan.points, this.plan.views);
    if (this.viewer) this.viewer.dirty = true;
  }

  /**
   * Load a stored run into the engine and re-judge what it already paid for. Every stored generation
   * is read back from the run directory and put through the *current* checks (judgeView): the images a
   * resume projects are the ones on disk, so a metric fix salvages a paid run without buying a single
   * image again. A view whose generation is missing (a grazing rejection, which never bought one) is
   * kept as it was and never re-requested. `rejectViews` adds the calling agent's own verdicts: those
   * views are re-judged as rejected by the caller and left out of the bake, and a rejection run.json
   * already stores stays (a later resume never re-judges it back in).
   */
  async restore(
    runId: string,
    meta: StoredRun,
    opts: Partial<PipelineOptions> = {},
    onEvent?: (event: PipelineEvent) => void,
    rejectViews: readonly number[] = [],
  ): Promise<{ plan: Plan; skip: Set<number>; prior: RunPrior }> {
    if (!this.engine || !this.viewer) throw new Error("load the level first");
    const S = this.engine.size;
    const plan = decodePlan(meta.plan);
    this.engine.atlas.reset();
    this.viewer.sky.reset();
    this.viewer.setMode("textured");
    const o: PipelineOptions = { ...DEFAULT_PIPELINE, ...opts, plan: { ...DEFAULT_PIPELINE.plan, ...opts.plan } };
    const roofsByPass = (o.plan.roofs ?? 0) > 0 || plan.views.some((view) => view.kind === "roof");
    const saved = [...meta.views].sort((a, b) => a.index - b.index);
    const rejectedByCaller = new Set(rejectViews);
    const prior: ViewRecord[] = [];
    for (const v of saved) {
      const spec: ViewSpec = plan.views[v.index] ?? { ...v.spec, id: v.index };
      const empty = {
        clay: new Uint8ClampedArray(0),
        state: new Uint8ClampedArray(0),
        edit: new Uint8Array(0),
        gen: new Uint8ClampedArray(0),
      };
      // The caller's verdict is final: its image was already bought, so nothing is re-requested and no
      // cheaper check argues with it. The texels it would have painted are filled from the images around
      // them, as for any other rejected view.
      const callerRejected = rejectedByCaller.has(v.index) || v.rejected === "caller";
      const generation = callerRejected ? undefined : await this.readRunImage(runId, `view_${v.index}_gen.png`, S);
      let view: ViewRecord = {
        ...v,
        spec,
        ...empty,
        comp: new Uint8ClampedArray(0),
        ...(callerRejected ? { rejected: "caller" as const } : {}),
      };
      if (generation !== undefined) {
        try {
          const p = prepareView(this.engine, spec, o, false, roofsByPass);
          const judged = judgeView(p, generation, S, o.feather);
          view = {
            ...view,
            left: judged.left,
            comp: judged.comp,
            structureDeviation: judged.structureDeviation,
            silhouetteMismatch: judged.silhouetteMismatch,
            edgeMisalignment: judged.edgeMisalignment,
          };
          if (judged.rejected) view.rejected = "structure";
          // A stored vision rejection is a paid image the check found invented structure in: re-judging
          // the pixels cannot clear it, so it stays rejected and stays out of the bake.
          else if (v.rejected !== "verify") delete view.rejected;
        } catch {
          // Unreadable state for this view (a changed level): keep it as stored rather than lose the run.
        }
      }
      // Project what this view now contributes. A stored composite is the fallback for a view that was
      // accepted before generations were re-judged (its image is gone but the bake still exists).
      let comp = view.rejected === undefined ? view.comp : new Uint8ClampedArray(0);
      if (view.rejected === undefined && comp.length === 0 && v.rejected === undefined) {
        comp = (await this.readRunImage(runId, `view_${v.index}_comp.png`, S)) ?? new Uint8ClampedArray(0);
      }
      if (view.rejected === undefined && comp.length > 0) {
        this.paintView(plan, spec, comp);
        await this.writeRunImage(runId, `view_${v.index}_comp.png`, comp, S);
        view = { ...view, comp };
        this.addSky(view);
      }
      prior.push({ ...view, coverage: this.engine.atlas.coverage() });
      onEvent?.({ type: "view-reused", view: { ...view, coverage: this.engine.atlas.coverage() } });
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
    const consistency = consistencyReference(p, this.engine.size);
    const r = await paintPreparedView(p, this.engine.size, o, o.seed + viewIndex, o.feather, this.abort?.signal, consistency);
    if (r.rejected === undefined) {
      this.paintView(plan, p.spec, r.comp);
      this.viewer.setMode("textured");
      this.viewer.dirty = true;
    }
    const view: ViewRecord = {
      ...base,
      left: r.left,
      seconds: r.seconds,
      price: r.price,
      prompt: r.prompt,
      gen: r.gen,
      comp: r.comp,
      coverage: this.engine.atlas.coverage(),
      structureDeviation: r.structureDeviation,
      silhouetteMismatch: r.silhouetteMismatch,
      edgeMisalignment: r.edgeMisalignment,
      ...(r.rejected === undefined ? {} : { rejected: r.rejected }),
      ...(r.verify === undefined ? {} : { verify: r.verify }),
      ...(r.attempts > 1 ? { repainted: true } : {}),
    };
    onEvent({ type: "view-done", view, cost: r.price, elapsed: r.seconds });
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
      painted[i] = paintedMask ? (paintedMask[i]! > 0 ? 1 : 0) : pixels[4 * i]! > 0 ? 1 : 0;
      // The footprint is kept for every texel a view sees, painted or not: what the magnification
      // guard left empty is exactly the unpainted texels whose best view resolves too coarsely.
      if (!island || !(pixels[4 * i]! > 0)) continue;
      foot[i] = pixels[4 * i + 1]!;
      if (painted[i]) paintedTexels += 1;
    }
    this.measurement = { atlas: size, foot, painted, islandTexels, paintedTexels };
    return {
      atlas: size,
      views: plan.views.length,
      islandTexels,
      paintedTexels,
      medianFoot: medianOfPainted(this.measurement),
      blurredTexelPercent: this.blurredPercentAt(size),
      magnificationSkippedPercent: this.magnificationSkippedPercentAt(size),
    };
  }

  /**
   * The same footprint at another atlas size: a texel footprint is a length in texels, so it scales
   * with the atlas' side, not with its area (the metric is the worse screen axis, not UV area).
   * This is what a quote reports for the atlas it just chose.
   */
  blurredPercentAt(atlasSize: number): number {
    const measurement = this.measurement;
    if (!measurement) throw new Error("measure before reading a blur percent");
    const threshold = BLUR_TEXELS_PER_PIXEL * (measurement.atlas / atlasSize);
    if (measurement.paintedTexels === 0) return 0;
    let blurred = 0;
    const foot = measurement.foot;
    for (let i = 0; i < foot.length; i++) {
      if (measurement.painted[i] && foot[i]! > threshold) blurred += 1;
    }
    return (100 * blurred) / measurement.paintedTexels;
  }

  /**
   * What a bake painted under the projection's own guard rule: a texel no view resolves within 2x2
   * atlas texels is left unpainted, so the blur share is 0 by construction and the magnified texels
   * show up as `skipped` instead. This is the honest pair for a finished run measured at a coarser
   * atlas than the one it baked: the real atlas content says which texels were painted there, and
   * that is exactly this rule.
   */
  guardedPercentAt(atlasSize: number): { blurred: number; skipped: number } {
    const measurement = this.measurement;
    if (!measurement) throw new Error("measure before reading the guard's share");
    const threshold = BLUR_TEXELS_PER_PIXEL * (measurement.atlas / atlasSize);
    let skipped = 0;
    const foot = measurement.foot;
    for (let i = 0; i < foot.length; i++) if (foot[i]! > threshold) skipped += 1;
    return {
      blurred: 0,
      skipped: measurement.islandTexels === 0 ? 0 : (100 * skipped) / measurement.islandTexels,
    };
  }

  /**
   * Texels the magnification guard leaves unpainted, as a share of the island: a view sees them but
   * one of its pixels would cover more than 2x2 atlas texels there, so projecting it would only
   * stretch one pixel over many texels. They wait for a closer view or the hole pass.
   */
  magnificationSkippedPercentAt(atlasSize: number): number {
    const measurement = this.measurement;
    if (!measurement) throw new Error("measure before reading the magnification share");
    const threshold = BLUR_TEXELS_PER_PIXEL * (measurement.atlas / atlasSize);
    if (measurement.islandTexels === 0) return 0;
    let skipped = 0;
    const foot = measurement.foot;
    for (let i = 0; i < foot.length; i++) {
      if (!measurement.painted[i] && foot[i]! > threshold) skipped += 1;
    }
    return (100 * skipped) / measurement.islandTexels;
  }

  stop() {
    this.abort?.abort();
  }

  /**
   * How much of what players actually see the bake has painted, and where the rest is (B, phase 2d).
   *
   * The denominator is not the whole atlas: texels only an aerial camera or the back of a wall ever
   * shows are not what a player walks past, and a run that paints 44% of the atlas but 100% of the
   * player-visible surface is done. So the mask is built from the plan's player-height views (ground
   * kind) with the projection's own grazing and occlusion gates, and counted against the atlas' paint.
   */
  visibleCoverage(plan: Plan): VisibleCoverage {
    if (!this.engine) throw new Error("load a level first");
    const engine = this.engine;
    const player = plan.views.filter((view) => view.kind === undefined || view.kind === "ground");
    if (player.length === 0) return { percent: 100, gapPercent: 0, gapCells: new Float32Array(ATLAS_GAP_CELLS ** 2) };
    const mask = engine.atlas.projectionMask(player.length, (index) => {
      const camera = makeCamera(player[index]!);
      engine.views.renderGeometry(camera);
      return { camera, gPos: engine.views.geometryTarget.textures[0]! };
    });
    try {
      const stats = engine.atlas.visibleStats(mask.texture, ATLAS_GAP_CELLS);
      return { percent: 100 - stats.gapPercent, gapPercent: stats.gapPercent, gapCells: stats.gapCells };
    } finally {
      mask.dispose();
    }
  }

  /**
   * Score one hole-pass candidate by the unpainted texels players can see that its camera would paint,
   * each weighted by its cluster's size, so the budget goes to the largest holes first (B, phase 2d).
   * The probe renders at 128 px: enough to rank cameras, far cheaper than a real view.
   */
  gapScore(spec: ViewSpec, gapCells: Float32Array): { score: number; pixels: number } {
    if (!this.engine || !this.level) throw new Error("load a level first");
    this.holeProbe ??= new ViewRenderer(this.gpu, this.level, 128);
    const probe = this.holeProbe;
    probe.renderGeometry(makeCamera(spec));
    const uvq = this.gpu.readF32(probe.geometryTarget, 2, false);
    const { mask } = probe.renderState(this.engine.atlas.texture, this.engine.atlas.texture, this.engine.options.qualityRatio);
    let score = 0;
    let pixels = 0;
    for (let i = 0; i < mask.length / 4; i++) {
      if (mask[4 * i]! < 128 || mask[4 * i + 2]! > 127) continue; // sky, or already painted
      pixels += 1;
      const cx = Math.min(ATLAS_GAP_CELLS - 1, Math.max(0, Math.floor(uvq[4 * i]! * ATLAS_GAP_CELLS)));
      const cy = Math.min(ATLAS_GAP_CELLS - 1, Math.max(0, Math.floor(uvq[4 * i + 1]! * ATLAS_GAP_CELLS)));
      // One point for the pixel, plus the size of the hole it falls in: the biggest cluster wins.
      score += 1 + (gapCells[cy * ATLAS_GAP_CELLS + cx] ?? 0);
    }
    return { score, pixels };
  }

  private addSky(v: Pick<ViewRecord, "spec" | "model" | "comp">) {
    // only views whose model painted the whole frame: masked fills leave the clay sky as it was
    if (v.spec.kind === "roof") return;
    this.viewer!.sky.addView(v.spec, v.comp, this.engine!.geometryMask(v.spec), this.engine!.size);
  }

  /** Textured GLB of the level (unlit or lit material, depending on the lighting it was painted in). */
  async exportGlb(fill: PaintFill = "detail"): Promise<ArrayBuffer> {
    if (!this.engine) throw new Error("nothing to export");
    return exportGlb(this.engine, fill);
  }

  /** One PNG of a run file, or undefined when the run directory does not hold it. */
  private async readRunImage(runId: string, file: string, size: number): Promise<Uint8ClampedArray | undefined> {
    try {
      return await urlToRGBA(`/api/runs/${encodeURIComponent(runId)}/${file}`, size, size);
    } catch {
      return undefined;
    }
  }

  /** Write one run file through the local server (a view's image, a swatch, swatches.json). */
  private async writeRunFile(
    runId: string,
    file: string,
    body: string | Blob,
    contentType: "application/json" | "application/octet-stream",
  ) {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/${file}`, {
      method: "POST",
      headers: postHeaders(contentType),
      body,
    });
    if (!res.ok) throw new Error(`saving ${file} failed: ${res.status}`);
  }

  /** Write one RGBA image as a run file through the local server (a view's image, a swatch). */
  private async writeRunImage(runId: string, file: string, pixels: Uint8ClampedArray, width: number, height = width) {
    await this.writeRunFile(runId, file, await toBlob(pixels, width, height, "image/png"), "application/octet-stream");
  }

  /** Write one finished view's images to the run directory through the local server, then drop them. */
  async saveView(runId: string, view: ViewRecord) {
    const S = this.engine!.size;
    await this.writeRunImage(runId, `view_${view.index}_clay.png`, view.clay, S);
    await this.writeRunImage(runId, `view_${view.index}_gen.png`, view.gen, S);
    await this.writeRunImage(runId, `view_${view.index}_comp.png`, view.comp, S);
    view.clay = new Uint8ClampedArray(0);
    view.state = new Uint8ClampedArray(0);
    view.edit = new Uint8Array(0);
    view.gen = new Uint8ClampedArray(0);
  }

  /** One view's geometry at the probe size the swatch search reads back (not the view's own image). */
  private swatchGeometry(spec: ViewSpec, size: number): ViewGeometry {
    if (!this.level) throw new Error("load a level first");
    const probe = (this.swatchProbe ??= new ViewRenderer(this.gpu, this.level, size));
    probe.renderGeometry(makeCamera(spec));
    return {
      spec,
      size,
      position: this.gpu.readF32(probe.geometryTarget, 0),
      normal: this.gpu.readF32(probe.geometryTarget, 1),
    };
  }

  /**
   * Cut the true-scale material swatches (PRD-916 phase 2m) from the paint this run already holds: for
   * each of the wall and floor classes, the accepted view that sees a planar patch of it best, the
   * patch rectified onto its own plane and made tileable, written into the run directory as
   * `swatch_<class>.png` with `swatches.json` beside them. A class no accepted view can give a patch
   * for is left out (the runner reports it), never faked from a stretched or lower-resolution crop.
   */
  async swatches(runId: string): Promise<SwatchReport> {
    const engine = this.engine;
    const level = this.level;
    const views = this.record?.views ?? [];
    const report: SwatchReport = {};
    if (!engine || !level || views.length === 0) return report;
    const size = SWATCH_PROBE_PX;
    const pixels = size * size;
    const candidates: SwatchCandidate[] = [];
    for (const view of views) {
      if (view.rejected !== undefined) continue;
      const geometry = this.swatchGeometry(view.spec, size);
      const classes = classifyView(geometry.normal, geometry.position, level.labels, level.bounds.min.y);
      const wall = new Uint8Array(pixels);
      const floor = new Uint8Array(pixels);
      for (let i = 0; i < pixels; i++) {
        if (geometry.normal[4 * i + 3]! < 0.5) continue;
        if (classes.floor[i]) floor[i] = 1;
        else if (!classes.roof[i] && Math.abs(geometry.normal[4 * i + 1]!) <= WALL_MAX_NY) wall[i] = 1;
      }
      // The strip along the clay's own edges is projected nowhere (a coping, a plinth is invented there),
      // so no swatch may straddle it: its paint only exists in the image, not in the atlas.
      const avoid = edgeBandMask(geometry.position, geometry.normal, size, size);
      for (const klass of SWATCH_CLASSES) {
        const candidate = pickSwatch(geometry, {
          klass,
          side: SWATCH_SIDE_METRES[klass],
          view: view.index,
          viewSize: engine.size,
          area: klass === "wall" ? wall : floor,
          avoid,
        });
        if (candidate) candidates.push(candidate);
      }
    }
    for (const klass of SWATCH_CLASSES) {
      // The view's own pixels, worst axis first (a floor at 60 degrees covers 2x as much surface along
      // depth as across): the swatch can be no finer than the paint it is cut from.
      const ranked = candidates
        .filter((candidate) => candidate.klass === klass)
        .sort((a, b) => a.sourceMetresPerPixel - b.sourceMetresPerPixel);
      for (const candidate of ranked.slice(0, SWATCH_ATTEMPTS)) {
        const view = views.find((entry) => entry.index === candidate.view);
        if (!view) continue;
        const generation = await this.readRunImage(runId, `view_${candidate.view}_gen.png`, engine.size);
        const composite = await this.readRunImage(runId, `view_${candidate.view}_comp.png`, engine.size);
        if (generation === undefined || composite === undefined) continue;
        // Alpha is where this very view projected its own paint: not the clay it was handed, not the
        // strip along its edges, not a texel it left unpainted. Nothing else proves the swatch is paint.
        const painted = new Uint8Array(composite.length / 4);
        for (let i = 0; i < painted.length; i++) painted[i] = composite[4 * i + 3]! > 127 ? 1 : 0;
        if (!patchPainted(candidate.patch, view.spec, painted, engine.size)) continue;
        // The rectified patch is cut to whole courses where the paint repeats (phase 2n), so it wraps
        // on a joint instead of in a blend band: that is what sets the swatch's own extent per axis.
        const tile = tileSwatch(rectifySwatch(candidate.patch, view.spec, generation, engine.size), candidate.patch.side);
        const file = `swatch_${klass}.png`;
        await this.writeRunImage(runId, file, tile.pixels, tile.width, tile.height);
        report[klass] = {
          file,
          metres: tile.metresX,
          metresX: tile.metresX,
          metresY: tile.metresY,
          view: candidate.view,
          metresPerPixel: candidate.metresPerPixel,
          sourceMetresPerPixel: candidate.sourceMetresPerPixel,
          incidence: candidate.incidence,
          corners: candidate.patch.corners.map((corner) => [corner[0], corner[1], corner[2]]),
        };
        break;
      }
    }
    await this.writeRunFile(runId, "swatches.json", `${JSON.stringify(report, null, 1)}\n`, "application/json");
    return report;
  }
}

/** Median of the painted texels' footprints, from a log2 histogram (no 1M-element sort). */
function medianOfPainted(measurement: { foot: Float32Array; painted: Uint8Array; paintedTexels: number }): number {
  if (measurement.paintedTexels === 0) return 0;
  const buckets = new Float64Array(128);
  for (let i = 0; i < measurement.foot.length; i++) {
    const value = measurement.foot[i]!;
    if (!(value > 0) || !measurement.painted[i]) continue;
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
