import { DEFAULT_MODEL, prompts, resolveModel, type EditModel, type PromptContext } from "../../models.js";
import { DEFAULT_VERIFY_MODEL, verifyPrompt, type ViewVerify } from "../../verify.js";
import { runEdit, runVerify } from "../openrouter.js";
import {
  colorCorrect,
  dilate,
  editMask,
  featherComposite,
  fraction,
  grazingShare,
  keepOnly,
  masksFromState,
  paintedFromState,
  untouched,
  type ViewMasks,
} from "./composite.js";
import type { Engine } from "./engine.js";
import { bitmapToRGBA, toDataUrl } from "./image.js";
import { DEFAULT_PLAN, holeViews, plan as makePlan, type Plan, type PlanOptions } from "./planner.js";
import { classifyView, describeView } from "./semantics.js";
import { rejectsStructure, structureDeviation } from "./structure.js";
import { makeCamera, ViewRenderer, type ViewSpec } from "./views.js";
import { measureScaleAnchor, type ScaleAnchor } from "./scale.js";

export interface PipelineOptions {
  /** The look, as materials only: anything named here (a fountain, a stall) gets painted onto walls. */
  style: string;
  /** Roof material for the roof passes. */
  roofStyle: string;
  firstModel: string;
  fillModel: string;
  /** Views with more than this share of unpainted geometry use the first-view model. */
  mostlyNew: number;
  feather: number;
  seed: number;
  plan: Partial<PlanOptions>;
  /** Check every painted view with a vision model (phase 2c); a rejected view is repainted once. */
  verify: boolean;
  /** OpenRouter chat model id the vision check calls (`verify.ts` picks the default). */
  verifyModel: string;
}

export const DEFAULT_PIPELINE: PipelineOptions = {
  style:
    "a Mediterranean hill village: weathered limestone and ochre plaster walls, wooden doors and shutters, worn cobblestone paving",
  roofStyle:
    "old terracotta clay roof tiles: curved Mediterranean tiles in neat rows running down the slope, weathered and slightly uneven, with patches of lichen",
  firstModel: DEFAULT_MODEL,
  fillModel: DEFAULT_MODEL,
  mostlyNew: 0.75,
  feather: 10,
  seed: 7,
  plan: {},
  verify: true,
  verifyModel: DEFAULT_VERIFY_MODEL.id,
};

/** Why a view's image was not projected: it shows almost only grazing surfaces, invents geometry, or fails the vision check. */
export type ViewRejection = "grazing" | "structure" | "verify";

export interface ViewRecord {
  index: number;
  wave: number;
  spec: ViewSpec;
  model: string;
  first: boolean;
  unknownFraction: number;
  /** Set when nothing was projected: the image was not bought (grazing) or not trusted (structure). */
  rejected?: ViewRejection;
  /** Compact closed blob the model added over the image it was given; rejected above 0.20 (structure.ts). */
  structureDeviation?: number;
  /** What the vision check said about the image that was kept for projection (phase 2c). */
  verify?: ViewVerify;
  /** The check rejected the first attempt, so the view was painted once more with a new seed. */
  repainted?: boolean;
  /** Share of this view's geometry the 0.35 grazing gate rejects. */
  grazingFraction?: number;
  /** The prompt text sent with this view. */
  prompt?: string;
  /** Share of the area to paint that the model handed back unpainted (left out of the projection). */
  left?: number;
  seconds: number;
  price: number;
  /** top-down RGBA at view size */
  clay: Uint8ClampedArray;
  state: Uint8ClampedArray;
  edit: Uint8Array;
  gen: Uint8ClampedArray;
  comp: Uint8ClampedArray;
  coverage: number; // painted share of the texture after this view
  predicted: number; // planner's share of reachable surface captured after this view
}

export interface RunRecord {
  level: string;
  options: PipelineOptions;
  plan: Plan;
  views: ViewRecord[];
  cost: number;
  seconds: number;
  /** Set when the run stopped itself instead of painting on: the B.2 check rejected its first views. */
  stopped?: "structure";
}

export type PipelineEvent =
  | { type: "planned"; plan: Plan }
  | { type: "view-start"; index: number; wave: number; model: string; state: Uint8ClampedArray }
  | { type: "view-done"; view: ViewRecord; cost: number; elapsed: number }
  /** A stored view re-judged on resume: run.json takes the new record, nothing was bought. */
  | { type: "view-reused"; view: ViewRecord }
  /** The run's first painted views were all rejected as invented geometry; no more money is spent. */
  | { type: "structure-stop"; views: number; runViews: number }
  | { type: "error"; index: number; message: string }
  | { type: "done"; record: RunRecord };

async function withRetry<T>(fn: (attempt: number) => Promise<T>, tries = 2): Promise<T> {
  let last: unknown;
  for (let a = 0; a < tries; a++) {
    try {
      return await fn(a);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** One view rendered against the current texture, with what to ask the model for. */
export interface PreparedView {
  spec: ViewSpec;
  clay: Uint8ClampedArray;
  state: Uint8ClampedArray;
  /** Masks the model's answer is composited with (roof passes leave unpainted non-roof pixels out of them). */
  masks: ViewMasks;
  /** 1 wherever the view shows the level, whatever the pass. */
  geometry: Uint8Array;
  edit: Uint8Array;
  /** Only these pixels are projected (roof and hole passes); everything when undefined. */
  keep?: Uint8Array;
  unknownFraction: number;
  isFirst: boolean;
  skip: boolean;
  model: EditModel;
  prompt: PromptContext;
  /** Camera height and centre depth the prompt's material sizes and the vision check are stated against. */
  scale: ScaleAnchor;
  /** Share of the view's geometry below the shader's 0.35 grazing gate. */
  grazingFraction: number;
}

/**
 * @param roofsByPass the run has roof passes: other views leave unpainted roofs alone (from the street the models
 *   see them at a graze and paint them as walls or sky, and a roof pass rarely sees them enough better to replace it)
 */
export function prepareView(
  engine: Engine,
  spec: ViewSpec,
  o: PipelineOptions,
  startOfRun: boolean,
  roofsByPass = false,
): PreparedView {
  const first = resolveModel(o.firstModel);
  const fill = resolveModel(o.fillModel);
  if (!first || !fill) throw new Error(`unknown model ${!first ? o.firstModel : o.fillModel}`);
  const S = engine.size;
  // hole views keep everything painted, however poor, so the model sees it as it is
  const { camera, state, mask, clay } = engine.renderView(spec, spec.kind === "fill" ? 0 : undefined);
  const { pos, nrm } = engine.readGeometry();
  const grazingFraction = grazingShare(pos, nrm, camera.position);
  const labels = engine.level.labels;
  const cls = classifyView(nrm, pos, labels, engine.level.bounds.min.y);
  let masks = masksFromState(mask);
  const geometry = masks.geometry;
  const roofPass = spec.kind === "roof";
  const fillPass = spec.kind === "fill";
  let keep: Uint8Array | undefined;
  if (roofPass) {
    // Paint roofs only. Unpainted walls and ground in view are left out entirely (not targets, not references).
    keep = cls.roof;
    masks = { geometry: masks.geometry.map((g, i) => g & (masks.known[i] | cls.roof[i])), known: masks.known };
  } else if (fillPass) {
    // Paint only what nothing has painted yet; everything else in view is reference, however poor.
    const painted = paintedFromState(mask);
    masks = { geometry: masks.geometry, known: masks.geometry.map((g, i) => g & painted[i]) };
    keep = dilate(
      masks.geometry.map((g, i) => g & (1 - painted[i])),
      S,
      S,
      2,
    );
  } else if (roofsByPass) {
    // Roofs wait for their own passes: unpainted roofs are neither targets nor references here.
    masks = { geometry: masks.geometry.map((g, i) => g & (masks.known[i] | (1 - cls.roof[i]))), known: masks.known };
    keep = geometry.map((g, i) => g & (1 - cls.roof[i]));
  }
  const unknown = masks.geometry.map((g, i) => (g && !masks.known[i] ? 1 : 0));
  const unknownFraction = fraction(unknown, roofPass ? cls.roof : masks.geometry); // over what this pass may paint
  const isFirst = !roofPass && !fillPass && (startOfRun || unknownFraction > 0.97);
  // nearly everything in view is already good: no model call (the hole pass picks its views by what's missing)
  const skip = fillPass ? unknownFraction === 0 : !isFirst && unknownFraction < 0.03;
  const model = roofPass || fillPass ? fill : isFirst || unknownFraction > o.mostlyNew ? first : fill;
  const edit = editMask(masks, S, S, Math.round((3 * S) / 1024));
  const desc = describeView(cls, labels, S, isFirst ? undefined : edit);
  const scale = measureScaleAnchor(engine.level, spec);
  const prompt: PromptContext = {
    look: o.style,
    roofLook: o.roofStyle,
    parts: desc.parts,
    mode: roofPass ? "roof" : isFirst ? "first" : "fill",
    floor: desc.floorShare > 0.5,
    overcast: !!engine.clay.lighting.overcast,
    scale: { cameraHeight: scale.cameraHeight, centreDistance: scale.centreDistance },
  };
  return {
    spec, clay, state, masks, geometry, edit, keep, unknownFraction, isFirst, skip, model, prompt, scale,
    grazingFraction,
  };
}

/**
 * A view whose geometry is almost entirely below the grazing gate puts no texel worth having: buying
 * its image would project nothing (A.1 leaves those texels for the hole pass). Measured on the
 * sample courtyard, street views stay under 0.6 while a wall seen edge-on is over 0.9.
 */
export const GRAZING_VIEW_LIMIT = 0.85;

export const promptText = (p: Pick<PreparedView, "prompt">) => prompts.view(p.prompt);

/** One generated view, judged: what to project, and whether it invented geometry. */
export interface JudgedView {
  /** The composite to project, or the untouched state when the view was rejected. */
  readonly comp: Uint8ClampedArray;
  readonly rejected: boolean;
  readonly structureDeviation: number;
  /** Share of the area to paint the model handed back unpainted. */
  readonly left: number;
}

/**
 * Composite one image onto the state it was generated from and run the B.2 structure check. No model
 * call: a resume re-judges the images it already paid for through this same function.
 */
export function judgeView(p: PreparedView, gen: Uint8ClampedArray, size: number, feather: number): JudgedView {
  const k = size / 1024; // pixel radii below are tuned at 1024 px views
  const corrected = colorCorrect(p.state, gen, p.masks, size, size, {
    band: 6 * k,
    blur: Math.round(8 * k),
    falloff: 120 * k,
  });
  let comp = featherComposite(p.state, corrected, p.masks, size, size, feather * k);
  // Whatever the model left as gray clay stays unpainted, so a later view (or the hole pass) gets another go at it.
  const unknown = p.masks.geometry.map((g, i) => (g && !p.masks.known[i] ? 1 : 0));
  const leftOver = untouched(p.state, gen, unknown, size, size);
  let nLeft = 0;
  let nUnknown = 0;
  for (let i = 0; i < unknown.length; i++) {
    nLeft += leftOver[i];
    nUnknown += unknown[i];
  }
  const keep = nLeft ? (p.keep ?? p.geometry).map((v, i) => v & (1 - leftOver[i])) : p.keep;
  if (keep) comp = keepOnly(comp, keep, p.geometry);
  // B.2: the model must keep the image it was given. A painted arch, doorway or new volume is a
  // compact, closed, much darker region inside one clay surface, so that view is logged and not
  // projected (structure.ts has the method and its calibration).
  // Judge only what the model was asked to paint: level geometry it has not painted yet. The sky is
  // background nothing projects, and already-painted texels are the previous views' work.
  const paintable = p.masks.geometry.map((geometry, i) => geometry & (1 - p.masks.known[i]!));
  const deviation = structureDeviation(corrected, p.state, size, size, undefined, paintable);
  const rejected = rejectsStructure(deviation);
  return {
    // A rejected view paints nothing: its composite stays the state the model was handed.
    comp: rejected ? p.state : comp,
    rejected,
    structureDeviation: deviation,
    left: nUnknown ? nLeft / nUnknown : 0,
  };
}

/** One paid image, judged by the pixel check and then by the vision check, with what it cost. */
export interface PaintedAttempt {
  readonly gen: Uint8ClampedArray;
  readonly comp: Uint8ClampedArray;
  readonly left: number;
  readonly structureDeviation: number;
  readonly rejected?: ViewRejection;
  readonly verify?: ViewVerify;
  readonly seconds: number;
  /** Image plus vision check, USD. */
  readonly price: number;
  /** The prompt of the request that produced this image (a repaint says what to leave out). */
  readonly prompt: string;
}

/** A view's final image after the pixel check and the one repaint a vision rejection is allowed. */
export interface PaintedView extends PaintedAttempt {
  readonly attempts: number;
}

/**
 * Buy one view's image, judge it with the free pixel check, then have a vision model compare it with the
 * clay (phase 2c). The pixel check stays as the cheap pre-filter; the vision check is the reliable one,
 * because a real invention (a stone buttress, roof tiles along a wall top) is the same tone as the
 * surface it stands on. A rejected view is repainted once with a new seed and the invented structure
 * named as forbidden; a second rejection leaves its texels to the fill and hole passes.
 */
async function attemptView(
  p: PreparedView,
  size: number,
  o: PipelineOptions,
  seed: number,
  feather: number,
  signal?: AbortSignal,
): Promise<PaintedAttempt> {
  const image = toDataUrl(p.state, size, size, "image/jpeg", 0.95);
  const prompt = promptText(p);
  const r = await runEdit(p.model, { imageUrl: image, prompt: p.prompt, seed }, signal);
  const gen = bitmapToRGBA(r.image, size, size);
  const judged = judgeView(p, gen, size, feather);
  let price = p.model.price;
  let verify: ViewVerify | undefined;
  if (o.verify && !judged.rejected) {
    const answer = await runVerify(
      o.verifyModel,
      verifyPrompt({
        cameraHeightM: p.scale.cameraHeight,
        centreDistanceM: p.scale.centreDistance,
        ...(p.spec.kind === undefined ? {} : { kind: p.spec.kind }),
      }),
      [image, toDataUrl(gen, size, size, "image/jpeg", 0.9)],
      size,
      signal,
    );
    price += answer.cost;
    verify = { model: o.verifyModel, added: answer.added, scaleOk: answer.scaleOk, verdict: answer.verdict };
  }
  return {
    gen,
    comp: judged.comp,
    left: judged.left,
    structureDeviation: judged.structureDeviation,
    ...(judged.rejected ? { rejected: "structure" as const } : {}),
    ...(verify === undefined ? {} : { verify }),
    seconds: r.seconds,
    price,
    prompt,
  };
}

export async function paintPreparedView(
  p: PreparedView,
  size: number,
  o: PipelineOptions,
  seed: number,
  feather: number,
  signal?: AbortSignal,
): Promise<PaintedView> {
  const first = await attemptView(p, size, o, seed, feather, signal);
  const failed = first.rejected !== undefined || (first.verify !== undefined && first.verify.verdict !== "ok");
  if (!failed) return { ...first, attempts: 1 };
  // A pixel-check rejection bought nothing usable and is left to the fill pass: only the vision check
  // earns a repaint (one, with a new seed), because it is the one that can be argued with by a prompt.
  if (first.rejected !== undefined) return { ...first, attempts: 1 };
  const retry: PreparedView = {
    ...p,
    prompt: { ...p.prompt, repaint: true, avoid: first.verify?.added ?? [] },
  };
  const second = await attemptView(retry, size, o, seed + 5000, feather, signal);
  const rejected: ViewRejection | undefined =
    second.rejected ??
    (second.verify !== undefined && second.verify.verdict !== "ok" ? "verify" : undefined);
  return {
    ...second,
    ...(rejected === undefined ? {} : { rejected }),
    verify: second.verify ?? first.verify,
    attempts: 2,
    seconds: first.seconds + second.seconds,
    price: first.price + second.price,
  };
}

/** Views a resumed run already has on disk: their pixels are replayed from the saved composites. */
export interface RunPrior {
  readonly views: readonly ViewRecord[];
  readonly cost: number;
  readonly seconds: number;
}

/**
 * Paint every planned view, in waves. `skip` holds plan indices a resumed run already has images for;
 * `prior` carries their records (re-judged and re-projected by the caller) so the returned run counts
 * them without re-requesting them.
 */
export async function runPipeline(
  engine: Engine,
  opts: Partial<PipelineOptions>,
  onEvent: (e: PipelineEvent) => void,
  signal?: AbortSignal,
  existingPlan?: Plan,
  skip?: ReadonlySet<number>,
  prior?: RunPrior,
): Promise<RunRecord> {
  const o: PipelineOptions = { ...DEFAULT_PIPELINE, ...opts, plan: { ...DEFAULT_PIPELINE.plan, ...opts.plan } };
  const t0 = performance.now();
  const plan = existingPlan ?? makePlan(engine.gpu, engine.level, engine.views, o.plan);
  onEvent({ type: "planned", plan });
  const S = engine.size;
  const views: ViewRecord[] = [...(prior?.views ?? [])];
  let cost = prior?.cost ?? 0;
  const done = new Set<number>(skip ?? []);
  const roofsByPass = (o.plan.roofs ?? 0) > 0 || plan.views.some((v) => v.kind === "roof");
  const startOfRun = (prior?.views.length ?? 0) === 0;

  const empty = (): { clay: Uint8ClampedArray; state: Uint8ClampedArray; edit: Uint8Array; gen: Uint8ClampedArray; comp: Uint8ClampedArray } => ({
    clay: new Uint8ClampedArray(0),
    state: new Uint8ClampedArray(0),
    edit: new Uint8Array(0),
    gen: new Uint8ClampedArray(0),
    comp: new Uint8ClampedArray(0),
  });

  const runView = async (spec: ViewSpec, vi: number, wave: number): Promise<ViewRecord | undefined> => {
    const p = prepareView(engine, { ...spec, id: vi }, o, startOfRun && vi === 0, roofsByPass);
    if (p.skip) return undefined;
    if (p.grazingFraction > GRAZING_VIEW_LIMIT) {
      // Almost everything in view is below the grazing gate: no image is bought for it.
      const view: ViewRecord = {
        index: vi, wave, spec: p.spec, model: p.model.key, first: p.isFirst,
        unknownFraction: p.unknownFraction, prompt: promptText(p), seconds: 0, price: 0,
        coverage: engine.atlas.coverage(), predicted: plan.predicted[vi] ?? 0,
        rejected: "grazing", grazingFraction: p.grazingFraction, ...empty(),
      };
      views.push(view);
      done.add(vi);
      onEvent({ type: "view-done", view, cost, elapsed: (performance.now() - t0) / 1000 });
      return view;
    }
    onEvent({ type: "view-start", index: vi, wave, model: p.model.key, state: p.state });
    try {
      const r = await withRetry((attempt) =>
        paintPreparedView(p, S, o, o.seed + 1000 * attempt + vi, o.feather, signal),
      );
      if (r.rejected === undefined) engine.paint(p.spec, r.comp);
      cost += r.price;
      const view: ViewRecord = {
        index: vi,
        wave,
        spec: p.spec,
        model: p.model.key,
        first: p.isFirst,
        unknownFraction: p.unknownFraction,
        prompt: r.prompt,
        left: r.left,
        seconds: r.seconds,
        price: r.price,
        clay: p.clay,
        state: p.state,
        edit: p.edit,
        gen: r.gen,
        comp: r.comp,
        coverage: engine.atlas.coverage(),
        predicted: plan.predicted[vi] ?? 0,
        structureDeviation: r.structureDeviation,
        grazingFraction: p.grazingFraction,
        ...(r.rejected === undefined ? {} : { rejected: r.rejected }),
        ...(r.verify === undefined ? {} : { verify: r.verify }),
        ...(r.attempts > 1 ? { repainted: true } : {}),
      };
      views.push(view);
      done.add(vi);
      onEvent({ type: "view-done", view, cost, elapsed: (performance.now() - t0) / 1000 });
      return view;
    } catch (e) {
      onEvent({ type: "error", index: vi, message: String((e as Error)?.message ?? e) });
      return undefined;
    }
  };

  /**
   * B.2 is only worth believing while the money is still unspent: when the first three *painted*
   * views of the run all invented geometry, the check is either right (the level's paintings are
   * unusable, stop paying) or wrong (stop paying and look at the pairs). Either way the run stops
   * with the cause in run.json; every bought image is kept for a resume.
   */
  const rejectedFirstViews: ViewRecord[] = [];
  const stopOnStructureFailure = (view: ViewRecord | undefined): boolean => {
    if (!view || view.price <= 0) return false; // not bought (a grazing view or a skip): says nothing
    rejectedFirstViews.push(view);
    if (rejectedFirstViews.length < 3) return false;
    if (rejectedFirstViews.some((seen) => seen.rejected !== "structure")) return false;
    onEvent({ type: "structure-stop", views: 3, runViews: views.length });
    return true;
  };

  // Views are painted one at a time, so each one renders against everything painted before it.
  let stopped = false;
  for (let w = 0; w < plan.waves.length && !stopped; w++) {
    if (signal?.aborted) break;
    for (const vi of plan.waves[w] ?? []) {
      if (signal?.aborted) break;
      const spec = plan.views[vi];
      if (!spec || done.has(vi)) continue;
      if (stopOnStructureFailure(await runView(spec, vi, w))) {
        stopped = true;
        break;
      }
    }
  }

  // Hole pass: texels nothing painted (ground behind props, tops of props) from views that actually see them.
  // A resume never runs it: the stored plan's hole views (bought, rejected or not) were already
  // decided, and a resume must not buy a camera the caller never approved.
  const holeBudget = o.plan.holes ?? DEFAULT_PLAN.holes;
  if (holeBudget > 0 && !signal?.aborted && !stopped && prior === undefined) {
    const cands = holeViews(engine.level, { ...DEFAULT_PLAN, ...o.plan }, plan.points);
    const probe = new ViewRenderer(engine.gpu, engine.level, 128);
    const used = new Set<number>();
    for (let n = 0; n < holeBudget && !signal?.aborted; n++) {
      let best = -1;
      let bestPx = 0;
      cands.forEach((c, k) => {
        if (used.has(k)) return;
        probe.renderGeometry(makeCamera(c));
        const { mask } = probe.renderState(engine.atlas.texture, engine.atlas.texture, engine.options.qualityRatio);
        let px = 0;
        for (let i = 0; i < mask.length; i += 4) if (mask[i]! > 127 && mask[i + 2]! < 128) px++;
        if (px > bestPx) {
          bestPx = px;
          best = k;
        }
      });
      if (best < 0 || bestPx < 0.004 * 128 * 128) break; // under ~65 of 16k probe pixels: not worth a call
      used.add(best);
      const vi = plan.views.length;
      const spec = { ...cands[best]!, id: vi };
      plan.views.push(spec);
      plan.waves.push([vi]);
      plan.predicted.push(plan.predicted[plan.predicted.length - 1] ?? 0);
      if (done.has(vi)) continue;
      await runView(spec, vi, plan.waves.length - 1);
    }
    probe.geometryTarget.dispose();
    probe.stateTarget.dispose();
  }

  const seconds = (prior?.seconds ?? 0) + (performance.now() - t0) / 1000;
  const record: RunRecord = {
    level: engine.level.name,
    options: o,
    plan,
    views,
    cost,
    seconds,
    ...(stopped ? { stopped: "structure" as const } : {}),
  };
  onEvent({ type: "done", record });
  return record;
}
