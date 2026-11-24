import { makeApi } from "./api.js";
import { Session } from "./session.js";
import { mountUi } from "./ui/app.js";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const panel = document.getElementById("panel")!;
const headless = new URLSearchParams(location.search).has("headless");
const session = new Session(canvas);
const api = makeApi(session);

if (headless) {
  panel.remove();
  canvas.style.inset = "0";
  canvas.style.width = "100%";
} else {
  mountUi(session, panel, api);
}

function fit() {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  session.viewer?.resize(w, h);
}
window.addEventListener("resize", fit);

let lastViewer: unknown = null;
function frame() {
  if (session.viewer && session.viewer !== lastViewer) {
    lastViewer = session.viewer;
    fit();
  }
  if (!headless && session.viewer?.dirty) session.viewer.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

(window as unknown as { textureProjection: ReturnType<typeof makeApi> }).textureProjection = api;
