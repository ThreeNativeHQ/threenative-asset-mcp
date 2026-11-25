import { DEFAULT_PIPELINE, type PipelineEvent, type PipelineOptions } from "../core/pipeline.js";
import { type PlanOptions } from "../core/planner.js";
import { setStyleImage } from "../openrouter.js";
import { LIGHTING, type Session } from "../session.js";
import type { makeApi } from "../api.js";

interface ServerState {
  level?: { name: string };
  styleImage: boolean;
  runs: { runId: string; level: string; views: number; complete: boolean; cost: number; updatedAt: string }[];
}

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...kids: (Node | string)[]
) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
};

function drawThumb(canvas: HTMLCanvasElement, data: Uint8ClampedArray, size: number) {
  const tmp = h("canvas");
  tmp.width = tmp.height = size;
  tmp.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(data), size, size), 0, 0);
  canvas.width = canvas.height = 256;
  canvas.getContext("2d")!.drawImage(tmp, 0, 0, 256, 256);
}

const readDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("could not read the file"));
    reader.readAsDataURL(file);
  });

export function mountUi(session: Session, panel: HTMLElement, api: ReturnType<typeof makeApi>) {
  const drop = h("div", { class: "drop", id: "level-drop" }, "Drop a .glb blockout here (needs UVs)");
  const file = h("input", { type: "file", accept: ".glb,.gltf" });
  file.style.display = "none";
  const style = h("textarea", { id: "style", placeholder: "Materials, not objects: anything named here gets painted onto walls" });
  style.value = DEFAULT_PIPELINE.style;
  const roofStyle = h("input", { type: "text", id: "roof-style", placeholder: "Roof material" });
  roofStyle.value = DEFAULT_PIPELINE.roofStyle;
  const styleDrop = h("div", { class: "drop", id: "style-drop" }, "Drop a style image here (materials only)");
  const styleLabel = h("div", { class: "note", id: "style-note" }, "No style image: the look comes from the text above.");
  const segLight = h("div", { class: "seg" });
  const lightBtns = Object.keys(LIGHTING).map((k) => {
    const b = h("button", {}, k[0]!.toUpperCase() + k.slice(1));
    b.onclick = () => setLighting(k);
    segLight.append(b);
    return [k, b] as const;
  });
  const az = h("input", { type: "range", min: "0", max: "360", value: "140" });
  const el = h("input", { type: "range", min: "5", max: "85", value: "48" });
  const firstSel = h("select", { id: "first-model" });
  const fillSel = h("select", { id: "fill-model" });
  for (const m of api.models()) {
    for (const sel of [firstSel, fillSel]) sel.append(h("option", { value: m.key }, `${m.label} · $${m.price}`));
  }
  firstSel.value = DEFAULT_PIPELINE.firstModel;
  fillSel.value = DEFAULT_PIPELINE.fillModel;
  const budget = h("input", { type: "range", min: "2", max: "80", value: "24" });
  const budgetLab = h("span", { class: "lab" }, "Max views · 24");
  budget.oninput = () => (budgetLab.textContent = `Max views · ${budget.value}`);
  const aerialBox = h("input", { type: "checkbox", checked: "" });
  const atlasSel = h("select", { id: "atlas" });
  for (const [v, l] of [
    ["2048", "2K texture"],
    ["4096", "4K texture"],
    ["8192", "8K texture"],
  ])
    atlasSel.append(h("option", { value: v! }, l!));
  atlasSel.value = "4096";
  const quote = h("div", { class: "quote", id: "quote" }, "Load a level to quote a run.");
  const planBtn = h("button", {}, "Plan cameras");
  const runBtn = h("button", { class: "primary" }, "Texture level");
  const stopBtn = h("button", {}, "Stop");
  const stat = (label: string) => {
    const b = h("b", {}, "–");
    return [h("div", { class: "stat" }, b, h("i", {}, label)), b] as const;
  };
  const [sViews, vViews] = stat("views");
  const [sCov, vCov] = stat("surface");
  const [sCost, vCost] = stat("cost");
  const [sTime, vTime] = stat("time");
  const thumbSees = h("canvas");
  const thumbPaints = h("canvas");
  const segMode = h("div", { class: "seg" });
  const clayBtn = h("button", { class: "on" }, "Clay");
  const texBtn = h("button", {}, "Textured");
  const litBtn = h("button", {}, "Lit");
  segMode.append(clayBtn, texBtn, litBtn);
  const camsBox = h("input", { type: "checkbox", checked: "" });
  const glbBtn = h("button", {}, "Download .glb");
  const texDl = h("button", {}, "Download texture");
  const runSel = h("select", { id: "resume-run" });
  const resumeBtn = h("button", { id: "resume" }, "Resume");
  const resumeRow = h("div", { class: "row", hidden: "" }, runSel, resumeBtn);
  const log = h("div", { class: "log" });
  const say = (msg: string) => {
    log.textContent = `${msg}\n${log.textContent}`.slice(0, 6000);
  };

  panel.append(
    h("div", {}, h("h1", {}, "Texture projection", h("span", {}, ".")), h("div", { class: "sub" }, "Paint a gray blockout level from camera views.")),
    h("section", {}, h("label", {}, "Level"), drop, file, h("div", { class: "note", id: "level-note" }, "")),
    h("section", {}, h("label", {}, "Look"), style, h("div", { class: "lab" }, "Roofs"), roofStyle, styleDrop, styleLabel),
    h("section", {}, h("label", {}, "Light"), segLight, h("div", { class: "row" }, h("span", { class: "lab" }, "Sun"), az, el)),
    h("section", {}, h("label", {}, "Models"), h("div", { class: "lab" }, "First view"), firstSel, h("div", { class: "lab" }, "Fills"), fillSel),
    h(
      "section",
      {},
      budgetLab,
      budget,
      h("label", { class: "row note" }, aerialBox, "Also paint roofs and outer walls (roof and aerial cameras)"),
      atlasSel,
      quote,
      h("div", { class: "row" }, planBtn, stopBtn),
      runBtn,
    ),
    h("section", {}, h("label", {}, "Resume"), resumeRow),
    h(
      "section",
      {},
      h("div", { class: "stats" }, sViews, sCov, sCost, sTime),
      h("div", { class: "thumbs" }, thumbSees, thumbPaints),
      h("div", { class: "row note" }, h("span", {}, "Model sees"), h("span", {}, "Model paints")),
    ),
    h("section", {}, h("label", {}, "Display"), segMode, h("label", { class: "row note" }, camsBox, "Show cameras")),
    h("section", {}, h("label", {}, "Export"), h("div", { class: "row" }, glbBtn, texDl)),
    log,
  );

  const lightingKey = () => lightBtns.find(([, b]) => b.classList.contains("on"))?.[0] ?? "overcast";
  function setLighting(k: string) {
    for (const [name, b] of lightBtns) b.classList.toggle("on", name === k);
    const base = LIGHTING[k]!;
    az.value = String(base.sunAzimuth);
    el.value = String(base.sunElevation);
    session.setLighting(base);
  }
  // In the lit display the sliders move the display sun (shadows follow live); otherwise the light the models paint in.
  const applySun = () => {
    const v = session.viewer;
    if (v?.mode === "lit") {
      v.displayLighting = { ...LIGHTING.outdoor!, sunAzimuth: +az.value, sunElevation: +el.value };
      v.syncLighting();
    } else session.setLighting({ ...LIGHTING[lightingKey()]!, sunAzimuth: +az.value, sunElevation: +el.value });
  };
  az.oninput = applySun;
  el.oninput = applySun;

  const setMode = (m: "clay" | "textured" | "lit") => {
    session.viewer?.setMode(m);
    clayBtn.classList.toggle("on", m === "clay");
    texBtn.classList.toggle("on", m === "textured");
    litBtn.classList.toggle("on", m === "lit");
  };
  clayBtn.onclick = () => setMode("clay");
  texBtn.onclick = () => setMode("textured");
  litBtn.onclick = () => setMode("lit");
  camsBox.onchange = () => {
    if (session.viewer) {
      session.viewer.overlay.visible = camsBox.checked;
      session.viewer.dirty = true;
    }
  };

  const planOpts = (): Partial<PlanOptions> => ({
    maxViews: +budget.value,
    aerial: aerialBox.checked ? 8 : 0,
    roofs: aerialBox.checked ? 24 : 0,
    holes: 12,
  });

  /** Views a run will buy, plus the hole-pass budget: the honest before-run estimate. */
  function showQuote() {
    if (!session.engine) return;
    try {
      const p = api.plan(planOpts());
      const first = api.models().find((m) => m.key === firstSel.value)?.price ?? 0;
      const fill = api.models().find((m) => m.key === fillSel.value)?.price ?? 0;
      // Every view uses one of the two models; the count for each is only known while painting.
      const estimate = (p.views + p.holes) * Math.max(first, fill);
      quote.textContent = `${p.views} views (${p.roofs} roofs, ${p.aerial} aerial) + up to ${p.holes} hole fills · ~$${estimate.toFixed(2)}`;
    } catch (e) {
      say(String(e));
    }
  }

  async function refreshRuns(levelName: string | undefined) {
    const state = (await (await fetch("/api/state")).json()) as ServerState;
    const runs = levelName ? state.runs.filter((r) => r.level === levelName) : state.runs;
    runSel.replaceChildren(
      ...runs.map((r) => h("option", { value: r.runId }, `${r.runId} · ${r.views} views${r.complete ? "" : " (partial)"}`)),
    );
    resumeRow.hidden = runs.length === 0;
  }

  async function load(src: string | ArrayBuffer, name: string, lighting: string) {
    say(`loading ${name}…`);
    const info =
      typeof src === "string"
        ? await api.load(src, { lighting, atlasSize: +atlasSel.value, name })
        : await session.load(src, name, LIGHTING[lighting]!, +atlasSel.value);
    setLighting(lighting);
    setMode("clay");
    document.getElementById("level-note")!.textContent = `${name}: ${info.triangles.toLocaleString()} triangles, ${info.area.toLocaleString()} m² of surface`;
    if (api.getStyleImage()) {
      styleLabel.textContent = "Style image loaded from the server: its materials are transferred to every view.";
    }
    showQuote();
    await refreshRuns(name);
    say(`${name}: ${info.triangles.toLocaleString()} triangles, ${info.area.toLocaleString()} m² of surface`);
    session.viewer?.render();
  }

  async function loadServerLevel() {
    const state = (await (await fetch("/api/state")).json()) as ServerState;
    if (state.level) await load("/api/level", state.level.name, "overcast");
    else {
      document.getElementById("level-note")!.textContent = "No level loaded: drop a .glb blockout.";
      await refreshRuns(undefined);
    }
  }

  drop.onclick = () => file.click();
  const loadFile = async (f: File) => load(await f.arrayBuffer(), f.name.replace(/\.\w+$/, ""), lightingKey());
  file.onchange = () => {
    if (file.files?.[0]) void loadFile(file.files[0]).catch((e) => say(String(e)));
  };
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add("over");
  };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const f = e.dataTransfer?.files?.[0];
    if (f) void loadFile(f).catch((err) => say(String(err)));
  };

  const setStyleFile = async (f: File | Blob, label: string) => {
    setStyleImage(await readDataUrl(f));
    styleLabel.textContent = `${label}: its materials are transferred to every view.`;
  };
  styleDrop.onclick = () => {
    const input = h("input", { type: "file", accept: "image/png,image/jpeg" });
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) void setStyleFile(f, f.name).catch((e) => say(String(e)));
    };
    input.click();
  };
  styleDrop.ondragover = (e) => {
    e.preventDefault();
    styleDrop.classList.add("over");
  };
  styleDrop.ondragleave = () => styleDrop.classList.remove("over");
  styleDrop.ondrop = (e) => {
    e.preventDefault();
    styleDrop.classList.remove("over");
    const f = e.dataTransfer?.files?.[0];
    if (f) void setStyleFile(f, f.name).catch((err) => say(String(err)));
  };
  styleDrop.ondblclick = () => {
    setStyleImage(undefined);
    styleLabel.textContent = "No style image: the look comes from the text above.";
  };

  const pipelineOptions = (): Partial<PipelineOptions> => ({
    style: style.value,
    roofStyle: roofStyle.value,
    firstModel: firstSel.value,
    fillModel: fillSel.value,
    plan: planOpts(),
  });
  const newRunId = () => `${session.level?.name ?? "level"}-${Date.now().toString(36)}`;

  planBtn.onclick = () => {
    try {
      const p = api.plan(planOpts());
      vViews.textContent = String(p.views);
      say(
        `planned ${p.views} views from ${p.points} spots, ${p.waves} waves, ` +
          `${Math.round(100 * p.predicted)}% of reachable surface`,
      );
      showQuote();
    } catch (e) {
      say(String(e));
    }
  };

  const track = (e: PipelineEvent) => {
    const S = session.engine?.size ?? 1024;
    if (e.type === "planned") {
      vViews.textContent = `0/${e.plan.views.length}`;
      say(`painting ${e.plan.views.length} views in ${e.plan.waves.length} waves`);
    }
    if (e.type === "view-start") drawThumb(thumbSees, e.state, S);
    if (e.type === "view-done") {
      drawThumb(thumbPaints, e.view.gen, S);
      vViews.textContent = `${e.view.index + 1}`;
      vCov.textContent = `${Math.round(100 * e.view.predicted)}%`;
      vCost.textContent = `$${e.cost.toFixed(2)}`;
      vTime.textContent = `${Math.round(e.elapsed)}s`;
      say(`view ${e.view.index} · ${e.view.model} · ${e.view.seconds.toFixed(1)}s`);
    }
    if (e.type === "error") say(`view ${e.index} failed: ${e.message}`);
    if (e.type === "done")
      say(`done: ${e.record.views.length} views, $${e.record.cost.toFixed(2)}, ${Math.round(e.record.seconds)}s`);
  };

  runBtn.onclick = async () => {
    runBtn.disabled = planBtn.disabled = true;
    try {
      const summary = await api.run({ runId: newRunId(), options: pipelineOptions() }, track);
      vCost.textContent = `$${summary.cost.toFixed(2)}`;
      setMode("textured");
      await refreshRuns(session.level?.name);
    } catch (e) {
      say(String(e));
    } finally {
      runBtn.disabled = planBtn.disabled = false;
    }
  };
  resumeBtn.onclick = async () => {
    const runId = runSel.value;
    if (!runId) return;
    resumeBtn.disabled = runBtn.disabled = planBtn.disabled = true;
    try {
      if (!session.engine) await load("/api/level", session.level?.name ?? "level", "overcast");
      const summary = await api.resume(runId, undefined, track);
      vCost.textContent = `$${summary.cost.toFixed(2)}`;
      setMode("textured");
      await refreshRuns(session.level?.name);
    } catch (e) {
      say(String(e));
    } finally {
      resumeBtn.disabled = runBtn.disabled = planBtn.disabled = false;
    }
  };
  stopBtn.onclick = () => session.stop();

  const download = (blob: Blob, name: string) => {
    const a = h("a", { href: URL.createObjectURL(blob), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  glbBtn.onclick = async () => {
    if (!session.engine) return;
    const { glb } = await session.exportGlb();
    download(new Blob([glb], { type: "model/gltf-binary" }), `${session.level!.name}_textured.glb`);
  };
  texDl.onclick = async () => {
    if (!session.engine) return;
    const { data, size } = session.engine.atlas.readBytes();
    const c = h("canvas");
    c.width = c.height = size;
    c.getContext("2d")!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, size, size), 0, 0);
    c.toBlob((b) => b && download(b, `${session.level!.name}_texture.png`), "image/png");
  };

  setLighting("overcast");
  void loadServerLevel().catch((e) => say(String(e)));
}
