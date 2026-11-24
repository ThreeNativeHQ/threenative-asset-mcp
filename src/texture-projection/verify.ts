/**
 * The vision check every painted view goes through: the reliable test that an image model kept the
 * clay's geometry (B.2, PRD-916 phase 2c). The pixel structure check is only a free pre-filter — it
 * catches dark compact blobs, while a real invention is often the same tone as the wall (a stone
 * buttress, a run of roof tiles along a wall top). A vision model sees those.
 *
 * The model is chosen from OpenRouter's public models list (`GET /api/v1/models`, no key): image
 * input, text out, and cheap enough that a check is a fraction of the image it judges. Prices are
 * the list's per-token numbers on 2026-11-23, USD per million tokens.
 *
 * This module is shared by the browser app and the node side (a quote prices it), so it stays free
 * of node and DOM APIs.
 */

export interface VerifyModel {
  /** OpenRouter model id, as listed publicly. */
  readonly id: string;
  /** USD per million prompt (and image) tokens. */
  readonly promptPerMillion: number;
  /** USD per million completion tokens. */
  readonly completionPerMillion: number;
}

/**
 * Gemini 2.5 Flash: image + text in, text out, $0.30/M prompt and $2.50/M out. One check sends two
 * view-sized images plus a short prompt, and the live courtyard run measured $0.00017 per check at
 * 2048 px (`scripts/verify-calibration.ts`), so a whole run's checks cost cents. Flash-Lite is three
 * times cheaper and reads the same prompt with worse eyes: on the courtyard's 60 stored pairs it
 * missed the roof tiles in 5 of 12 hand-checked views that Flash finds (and invented fewer).
 */
export const DEFAULT_VERIFY_MODEL: VerifyModel = {
  id: "google/gemini-2.5-flash",
  promptPerMillion: 0.3,
  completionPerMillion: 2.5,
};

/** Tokens Gemini spends on one square image: 258 per 768 px tile, one tile below 384 px. */
export function imageTokens(size: number): number {
  const tiles = size <= 384 ? 1 : Math.max(1, Math.ceil(size / 768)) ** 2;
  return 258 * tiles;
}

/** The model a caller named, priced like the default when its price is unknown (an estimate only). */
export function verifyModelFor(id: string): VerifyModel {
  return id === DEFAULT_VERIFY_MODEL.id
    ? DEFAULT_VERIFY_MODEL
    : {
        id,
        promptPerMillion: DEFAULT_VERIFY_MODEL.promptPerMillion,
        completionPerMillion: DEFAULT_VERIFY_MODEL.completionPerMillion,
      };
}

/** Rough token counts of one check, for the quote: two images, the prompt, and the JSON answer. */
export function verifyCostUsd(model: VerifyModel, viewSize: number, attempts = 1): number {
  const perCheck =
    (2 * imageTokens(viewSize) + 420) * model.promptPerMillion + 180 * model.completionPerMillion;
  return (perCheck / 1_000_000) * attempts;
}

/** What the check spent, from the completion's `usage` (falls back to the estimate without it). */
export function verifyUsageUsd(
  model: VerifyModel,
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  viewSize: number,
): number {
  if (usage === undefined || typeof usage.prompt_tokens !== "number" || typeof usage.completion_tokens !== "number") {
    return verifyCostUsd(model, viewSize);
  }
  return (
    (usage.prompt_tokens * model.promptPerMillion + usage.completion_tokens * model.completionPerMillion) / 1_000_000
  );
}

/** What the check says: nothing invented and plausible detail, an invention, or an answer it cannot read. */
export type VerifyVerdict = "ok" | "rejected" | "unparsed";

export interface ViewVerify {
  /** OpenRouter model id that judged the view. */
  readonly model: string;
  /** Structures the painted image shows and the clay does not ("ruined stone pillar on the wall"). */
  readonly added: readonly string[];
  /** Surface detail is at a plausible real-world size for the stated camera distance. */
  readonly scaleOk: boolean;
  readonly verdict: VerifyVerdict;
}

/** What one check reports besides its verdict. */
export interface VerifyAnswer {
  readonly added: readonly string[];
  readonly scaleOk: boolean;
  readonly verdict: VerifyVerdict;
  /** The model's own words when the answer could not be parsed (never the request). */
  readonly reason?: string;
}

export interface VerifyPromptContext {
  /** Camera height above the ground under it, in metres. */
  readonly cameraHeightM: number;
  /** Depth of the surface in the middle of the frame, in metres. */
  readonly centreDistanceM: number;
  /** Where the camera stands: a player's view, the aerial ring, over the roofs, or a fill pass. */
  readonly kind?: "ground" | "aerial" | "roof" | "fill";
}

const metres = (value: number): string => (value >= 10 ? value.toFixed(0) : value.toFixed(1));

/**
 * The two images and the question. Strict JSON out, so the verdict is parsed rather than read: an
 * answer it cannot parse is a rejection (fail closed), never a pass.
 *
 * The wording is calibrated on the live courtyard run: a first version asked "what is added?" and the
 * model answered with materials ("stone blocks on the wall", "cobblestone paving"), rejecting every
 * good view. It now decides *shape* first and names the evidence it saw.
 */
export function verifyPrompt(c: VerifyPromptContext): string {
  const camera =
    c.kind === "aerial"
      ? `This is an aerial view from ${metres(c.cameraHeightM)} m above the ground;`
      : c.kind === "fill"
        ? `This looks down from ${metres(c.cameraHeightM)} m above the ground;`
        : `The camera stands ${metres(c.cameraHeightM)} m above the ground;`;
  return (
    "Compare these two images of the same camera view. The first is an untextured gray render of a level's " +
    "geometry (the clay). The second is an image model's painted version of it, which is only allowed to change " +
    `materials. ${camera} the surface in the middle of the frame is about ${metres(c.centreDistanceM)} m away.\n\n` +
    "The question is about SHAPE, never about paint. Painted material on a shape the clay already has is never " +
    '"added": stone blocks, cobbles, paving, plaster, brickwork, mortar, tiles used as flat material, moss, ' +
    "lichen, stains, cracks, weathering, shadows, colour.\n\n" +
    '"added": three-dimensional structures or objects in the painted image that the clay does not show. An item ' +
    "belongs here only if it stands out of a surface or breaks a flat surface in the clay: it has an outline or an " +
    "edge across the flat clay, its own side face, or a shadow side. Ask of each candidate: could this be flat " +
    "material painted on the flat clay shape? Then leave it out. When unsure, leave it out.\n" +
    "Examples of added structure: a ruined stone pillar standing against a wall; a buttress on a wall; a doorway, " +
    "window or arch painted into a flat wall; a passage or hole; an awning, balcony, railing, bench, cart, crate, " +
    "lamp, person or plant.\n" +
    "Wall tops: the clay shows each wall top as one thin flat edge. A row, band or slab of roof tiles or red " +
    "terracotta laid along or above it is added, and so is a whole pitched roof or a chimney. A course of the same " +
    "stone as the wall, against that edge, is material and is not added.\n" +
    "The clay already contains objects (blocks, cylinders, steps): an object at the same place with the same " +
    "silhouette as in the clay is not added.\n" +
    'For each candidate give its name in three to eight words with where it is, and answer outOfSurface: true ' +
    "only if you can point at where it leaves the clay's surface (an outline across the flat clay, a side face, a " +
    "shadow side). If it is paint lying on a shape the clay has, outOfSurface is false and you leave the " +
    "candidate out. List each distinct structure once, at most six, and list nothing when the painting " +
    "changes materials only, which is the normal, correct result.\n\n" +
    '"scaleOk": true when the material detail (stones, bricks, tiles, planks, mortar joints) is a plausible real ' +
    "size for that camera distance, false when it is far too large or far too small: cobbles the size of a car, " +
    "bricks a metre long, one paving stone filling the bottom of the frame, joints wider than a brick, stones " +
    "finer than sand. Judge the size like a person standing where the camera is, not by the pixels.\n\n" +
    "Answer with one JSON object and nothing else, for example:\n" +
    '{"added": [{"what": "a ruined stone pillar standing against the wall, right of centre", "outOfSurface": ' +
    'true}], "scaleOk": true, "reason": "compared the outlines in both images"}\n' +
    "With nothing added the answer is {\"added\": [], \"scaleOk\": true, \"reason\": \"...\"}.\n" +
    '"reason": one short sentence: what you compared, not a summary of the materials.'
  );
}

/**
 * The first complete JSON object in `text`, braces matched outside string literals. Chat models wrap
 * the object in prose or repeat a fragment of it after the closing brace ("…}\nimage"}"), so taking
 * the first `{` to the last `}` swallows their debris; a scan that stops at the matching brace does not.
 */
function firstObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

const MAX_ADDED = 12;

/**
 * Read the model's answer. Only a well-formed object with a boolean `scaleOk` and a `added` array of
 * strings counts; anything else is `unparsed`, which the pipeline treats as a rejection.
 */
export function parseVerifyAnswer(content: string): VerifyAnswer {
  const json = firstObject(content);
  if (json === undefined) return { added: [], scaleOk: false, verdict: "unparsed", reason: "no JSON object" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { added: [], scaleOk: false, verdict: "unparsed", reason: "unreadable JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { added: [], scaleOk: false, verdict: "unparsed", reason: "answer is not an object" };
  }
  const record = parsed as Record<string, unknown>;
  const rawAdded = record["added"];
  if (typeof record["scaleOk"] !== "boolean" || !Array.isArray(rawAdded)) {
    return { added: [], scaleOk: false, verdict: "unparsed", reason: "answer misses added or scaleOk" };
  }
  const added: string[] = [];
  for (const item of rawAdded) {
    // Each candidate carries the model's own answer to "does it stand out of the clay's surface?"; a
    // candidate it calls flat paint is dropped, so a painted material never rejects a good view. An
    // entry in any other shape is not a verdict this check trusts (fail closed).
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { added: [], scaleOk: false, verdict: "unparsed", reason: "added entry is not an object" };
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry["what"] !== "string" || typeof entry["outOfSurface"] !== "boolean") {
      return { added: [], scaleOk: false, verdict: "unparsed", reason: "added entry misses what or outOfSurface" };
    }
    if (!entry["outOfSurface"]) continue;
    const name = entry["what"].trim().replace(/\s+/gu, " ").slice(0, 120);
    if (name.length > 1 && !added.some((seen) => seen.toLowerCase() === name.toLowerCase())) added.push(name);
    if (added.length === MAX_ADDED) break;
  }
  const scaleOk = record["scaleOk"];
  const reason = typeof record["reason"] === "string" ? record["reason"].slice(0, 300) : undefined;
  const verdict: VerifyVerdict = added.length === 0 && scaleOk ? "ok" : "rejected";
  return { added, scaleOk, verdict, ...(reason === undefined ? {} : { reason }) };
}
