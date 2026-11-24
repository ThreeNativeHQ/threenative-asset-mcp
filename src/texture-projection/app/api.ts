import { MODEL_ALIASES } from "../models.js";
import { blobDataUrl } from "./core/image.js";
import { getStyleImage, setStyleImage } from "./openrouter.js";
import type { PlanOptions } from "./core/planner.js";
import type { PipelineEvent, PipelineOptions, RunPrior, ViewRecord } from "./core/pipeline.js";
import {
  LIGHTING,
  decodePlan,
  encodePlan,
  type PlanJson,
  type Session,
  type StoredRun,
} from "./session.js";

/** How many views of each kind a plan holds, without the geometry. */
export interface PlanSummary {
  views: number;
  points: number;
  waves: number;
  aerial: number;
  roofs: number;
  holes: number;
  predicted: number;
  plan: PlanJson;
}

export interface RunSummary {
  runId: string;
  views: number;
  painted: number;
  cost: number;
  seconds: number;
  coverage: number;
}

/**
 * `window.textureProjection`: the operations the headless runner and the UI both drive.
 * Progress is printed as `TROMPE {json}` console lines so the node side can follow a run.
 */
export function makeApi(session: Session) {
  const emit = (o: unknown) => console.log(`TROMPE ${JSON.stringify(o)}`);
  const forward = (e: PipelineEvent) => {
    if (e.type === "planned") emit({ type: e.type, plan: encodePlan(e.plan) });
    else if (e.type === "view-start") emit({ type: e.type, index: e.index, wave: e.wave, model: e.model });
    else if (e.type === "view-done") emit(viewDone(e.view, e.cost, e.elapsed));
    else if (e.type === "error") emit({ type: e.type, index: e.index, message: e.message });
    else if (e.type === "done")
      emit({ type: e.type, views: e.record.views.length, cost: e.record.cost, seconds: e.record.seconds });
  };

  /** Every finished view is written to disk before it is announced, then dropped from memory. */
  async function paint(
    runId: string,
    options: Partial<PipelineOptions>,
    plan?: PlanJson,
    skip?: number[],
    prior?: RunPrior,
    onEvent?: (e: PipelineEvent) => void,
  ): Promise<RunSummary> {
    let saving = Promise.resolve();
    let painted = 0;
    const record = await session.run(
      options,
      (e) => {
        onEvent?.(e);
        if (e.type !== "view-done") {
          forward(e);
          return;
        }
        const { view, cost, elapsed } = e;
        saving = saving.then(async () => {
          // A view rejected for grazing never called the model, so it has no images to store.
          if (view.rejected !== "grazing") await session.saveView(runId, view);
          // "Painted" counts bought images; a rejected view painted nothing.
          if (view.rejected === undefined) painted += 1;
          emit(viewDone(view, cost, elapsed));
        });
      },
      plan ? decodePlan(plan) : undefined,
      new Set(skip ?? []),
      prior,
    );
    await saving;
    return {
      runId,
      views: record.views.length,
      painted,
      cost: record.cost,
      seconds: record.seconds,
      coverage: session.engine!.atlas.coverage(),
    };
  }

  return {
    session,
    setStyleImage,
    getStyleImage,
    async load(
      url: string,
      opts: { lighting?: string; atlasSize?: number; viewSize?: number; name?: string } = {},
    ) {
      const name = opts.name ?? url.split("/").pop()!.replace(/\.\w+$/, "");
      const info = await session.load(
        url,
        name,
        LIGHTING[opts.lighting ?? "overcast"]!,
        opts.atlasSize ?? 4096,
        opts.viewSize ?? 1024,
      );
      // The server may hold the style image (a styleImagePath from the runner or the UI's own dropzone).
      if (!getStyleImage()) {
        const state = await fetch("/api/state")
          .then((response) => (response.ok ? (response.json() as Promise<{ styleImage?: boolean }>) : undefined))
          .catch(() => undefined);
        if (state?.styleImage) {
          const res = await fetch("/api/style-image");
          if (res.ok) setStyleImage(await blobDataUrl(await res.blob()));
        }
      }
      return info;
    },
    /** Measure a stored plan without repainting it (inspect). */
    usePlan(plan: PlanJson) {
      session.usePlan(plan);
    },
    /** Footprint the plan resolves, texel by texel: no model calls, no cost (A.2, C.1). */
    async measure(opts: Partial<PlanOptions> = {}, paintedOnly = false) {
      return session.measure(opts, paintedOnly);
    },
    /** The measured footprint at another atlas size (a quote reports it for the atlas it chose). */
    blurredPercentAt(atlasSize: number) {
      return session.blurredPercentAt(atlasSize);
    },
    /** Camera planning only: no model calls, so no key and no cost. */
    plan(opts: Partial<PlanOptions> = {}): PlanSummary {
      const p = session.makePlan(opts);
      return {
        views: p.views.length,
        points: p.points.length,
        waves: p.waves.length,
        aerial: p.views.filter((v) => v.kind === "aerial").length,
        roofs: p.views.filter((v) => v.kind === "roof").length,
        holes: opts.holes ?? 0,
        predicted: p.predicted[p.predicted.length - 1] ?? 0,
        plan: encodePlan(p),
      };
    },
    /** Full paint: plan (or reuse a stored plan) and paint every missing view. */
    async run(
      input: { runId: string; options: Partial<PipelineOptions>; plan?: PlanJson; skip?: number[] },
      onEvent?: (e: PipelineEvent) => void,
    ) {
      return paint(input.runId, input.options, input.plan, input.skip, undefined, onEvent);
    },
    /** Continue a stored run: replay its saved views, then paint the ones it is missing. */
    async resume(runId: string, onEvent?: (e: PipelineEvent) => void): Promise<RunSummary> {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/run.json`);
      if (!res.ok) throw new Error(`no stored run ${runId}: ${res.status}`);
      const meta = (await res.json()) as StoredRun;
      const { plan, skip, prior } = await session.restore(runId, meta);
      return paint(runId, meta.options, encodePlan(plan), [...skip], prior, onEvent);
    },
    /** Paint a single planned view: a prompt test for the price of one image. */
    async promptTest(input: { runId: string; viewIndex: number; options: Partial<PipelineOptions> }) {
      const view = await session.promptTest(input.viewIndex, input.options, forward);
      if (view.rejected !== "grazing") await session.saveView(input.runId, view);
      return {
        index: view.index,
        model: view.model,
        seconds: view.seconds,
        price: view.price,
        coverage: view.coverage,
        rejected: view.rejected,
        structureDeviation: view.structureDeviation,
      };
    },
    /** Base64 GLB of the level with the painted texture. */
    async glb(): Promise<string> {
      const buffer = new Uint8Array(await session.exportGlb());
      let binary = "";
      for (let i = 0; i < buffer.length; i += 0x8000) {
        binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    },
    models() {
      return MODEL_ALIASES.map((model) => ({ key: model.key, label: model.label, price: model.price }));
    },
  };
}

function viewDone(view: ViewRecord, cost: number, elapsed: number) {
  return {
    type: "view-done",
    index: view.index,
    wave: view.wave,
    model: view.model,
    first: view.first,
    unknown: +view.unknownFraction.toFixed(3),
    left: +(view.left ?? 0).toFixed(3),
    seconds: +view.seconds.toFixed(1),
    coverage: +view.coverage.toFixed(3),
    predicted: +view.predicted.toFixed(3),
    price: view.price,
    prompt: view.prompt,
    spec: view.spec,
    rejected: view.rejected,
    structureDeviation: view.structureDeviation === undefined ? undefined : +view.structureDeviation.toFixed(3),
    grazingFraction: view.grazingFraction === undefined ? undefined : +view.grazingFraction.toFixed(3),
    cost: +cost.toFixed(4),
    elapsed: +elapsed.toFixed(1),
  };
}
