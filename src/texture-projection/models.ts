/**
 * The image models the projection pipeline can call, and the prompt each view gets.
 *
 * OpenRouter's `/api/v1/images` drops unknown fields silently, so the image being edited goes in
 * `input_references` (never `images`); the server-side proxy adds the key from OPENROUTER_API_KEY.
 * This module is shared by the browser app and the headless runner, so it must stay free of node
 * and DOM APIs.
 */

export interface PromptContext {
  /** Materials only, never objects: whatever a prompt names, the models paint somewhere. */
  look: string;
  /** Roof material for roof passes. */
  roofLook: string;
  /** Parts of the level in the area to paint with rough positions; '' when the level has no part names. */
  parts: string;
  /** first: nothing painted in view yet; fill: continue the texture around the gaps; roof: paint roofs only. */
  mode: "first" | "fill" | "roof";
  /** The view shows ground a player could stand on: the paving clause goes in (phase 2e). */
  floor: boolean;
  /** Painting under overcast light (no cast shadows wanted) rather than keeping the render's sun and shadows. */
  overcast?: boolean;
  /** Real-world distance anchors, from the level's geometry (`app/core/scale.ts`). */
  scale?: PromptScale;
  /** Structures the vision check found the last attempt invented: this repaint must not paint them. */
  avoid?: readonly string[];
  /** This request is the one repaint a rejected view gets: say so and keep the named structure out. */
  repaint?: boolean;
}

/** Camera height and centre-of-frame depth, in metres, that the prompt's material sizes are stated against. */
export interface PromptScale {
  readonly cameraHeight: number;
  readonly centreDistance: number;
}

export interface EditInput {
  /** Data URL of the view to edit (the clay render with the texture painted so far). */
  imageUrl: string;
  prompt: PromptContext;
  seed: number;
  /** Data URL of already-accepted texture of the same surface: its materials must be kept (C, phase 2d). */
  consistency?: string;
}

export interface ImageReference {
  type: "image_url";
  image_url: { url: string };
}

/** One request for `/api/v1/images`, as the browser sends it to the local proxy. */
export interface ImageRequest {
  model: string;
  prompt: string;
  aspect_ratio: string;
  seed: number;
  input_references: ImageReference[];
  /** Optional style image (data URL); the proxy appends it as a second reference. Never sent as-is. */
  style_image?: string;
  /** Optional consistency crop (data URL); the proxy appends it with a keep-these-materials instruction. */
  consistency_image?: string;
}

export interface EditModel {
  /** Alias used in options and the UI (`or-klein`, `muse-image`, `or:<model id>`). */
  readonly key: string;
  readonly label: string;
  /** OpenRouter model id. */
  readonly id: string;
  /** USD per generated image, as listed by OpenRouter on 2026-11-23. */
  readonly price: number;
  input(i: EditInput): ImageRequest;
}

/** Things the models like to add to a street scene; listed as forbidden unless the level models them. */
const ADDITIONS = ['awnings', 'market stalls', 'shop fronts', 'signs', 'lamps', 'plants', 'crates', 'barrels',
  'benches', 'furniture', 'people', 'cars'];

function forbidden(parts: string) {
  const have = new Set(parts.toLowerCase().split(/[^a-z]+/).map((w) => w.replace(/s$/, "")));
  return ADDITIONS.filter((a) => !a.split(" ").some((w) => have.has(w.replace(/s$/, "")))).join(", ");
}

const shapes = (c: PromptContext) => (c.parts ? `: ${c.parts}` : "");

const metres = (value: number) => (value >= 10 ? value.toFixed(0) : value.toFixed(1));

/**
 * The real-world size anchor (phase 2c): the model paints material detail at whatever scale fits the
 * frame unless it is told how far away the camera is. Naming true sizes for the common materials is
 * what keeps paving stones the same size across views, so their seams do not show.
 */
function trueSize(c: PromptContext): string {
  if (c.scale === undefined) return "";
  return (
    ` Paint every material at its true real-world size as seen from this camera: the camera is ${metres(c.scale.cameraHeight)} m` +
    ` above the ground and the surface in the middle of the frame is about ${metres(c.scale.centreDistance)} m away, so` +
    " paving stones are 15-25 cm across, bricks 20-25 cm long, roof tiles 20 cm wide, mortar joints 1-2 cm and wooden" +
    ` planks 12-15 cm wide, in perspective for that distance.`
  );
}

/** A repaint after the vision check named structure the clay does not have: keep it out of the image. */
function avoid(c: PromptContext): string {
  if (c.repaint !== true) return "";
  const named = c.avoid === undefined || c.avoid.length === 0 ? [] : c.avoid.slice(0, 8);
  const forbidden = named.length === 0 ? "" : `, and do not paint: ${named.join("; ")}`;
  return (
    ` This is a repaint of the same view: paint only the flat surfaces of the clay image with material${forbidden}.` +
    " The clay has no such structure anywhere, and every material stays at its true real-world size for the distance above."
  );
}

/**
 * Every prompt ends with this, after the caller's style text, so no style can talk the model into
 * inventing architecture (B.1): a painted arch, doorway, passage, staircase or extra building is
 * geometry the level does not have, and it will not line up with the blockout from any other angle.
 *
 * The roof clause is the live courtyard's lesson (PRD-916 phase 2c): a style that names "terracotta
 * roof tiles" makes the model lay tiles along every wall top, so the level grew roofs it has not. A
 * flat clay wall top is the shape; naming the defect in the fixed constraint (and again in a
 * repaint) removes it, where the general "add no ... objects" clause did not.
 */
export const SURFACE_ONLY_CONSTRAINT =
  " Paint surface materials only. Keep every edge, opening and silhouette of the clay image exactly;" +
  " add no doors, windows, arches, passages, openings, stairs, people, plants or objects that are not in the clay image," +
  " and no roof, roof tiles, tile band, coping or chimney above a wall top: every wall top stays the flat edge it is in the clay." +
  // Phase 2d: the 2c run's paintings gave almost every wall a grey coping slab along its top (and many a
  // plinth at the base), which the vision check then had to reject. A negative list alone did not stop it
  // (a repaint that said "do not paint a coping strip along the top of the wall" painted one anyway), so
  // the wall top is named as the shape it is: the wall's own top face, painted with the wall's own stone.
  " The thin strip along the top of a wall is that wall's own top face: paint it with the same stone, the" +
  " same coursing and the same tone as the wall below it, so the wall continues to its edge. Do not add a" +
  " capstone, coping, cornice, moulding, ledge, plinth, base course, quoin or pilaster on, along or beside" +
  " any edge, and no band of a different tone along a wall top or a wall base.";

/** A roof pass is the one prompt that may paint a roof: it gets the constraint without the roof clause. */
export const ROOF_PASS_CONSTRAINT =
  " Paint surface materials only. Keep every edge and silhouette of the clay image exactly;" +
  " add no doors, windows, arches, passages, openings, stairs, people, plants or objects that are not in the clay image.";
/** How the light should look: the render's own sun and shadows, or soft overcast light with no cast shadows. */
const light = (c: PromptContext) => (c.overcast
  ? "soft, even overcast daylight with no cast shadows and no sunlit patches"
  : "the same light direction and shadows");
/**
 * The ground clause (PRD-916 phase 2e). The courtyard's aerial views see the floor as one big blank
 * plane, and the model fills a blank plane with a *design*: a leaf mosaic of dark cobbles on white
 * plaster that a consistency crop then carried into every later view. Paving is one material laid in
 * rows; a pattern is a drawing on the ground, and nothing in the clay draws one.
 */
const GROUND_CLAUSE =
  " The ground is one uniform paving material over the whole floor: no pattern, mosaic, motif, inlay, medallion," +
  " rosette or decorative layout, no change of paving material across the floor, and no plaster or concrete patch.";

const surfaces = (c: PromptContext) =>
  "Every detail you paint follows a shape that is already in the first image; nothing sticks out of the walls and " +
  `nothing new is added: no ${forbidden(c.parts)}.` + (c.floor ? GROUND_CLAUSE : "");

/**
 * Caption-style prompts: the model is told what the result looks like, which is what maskless
 * image-reference edits (FLUX 3 Klein and every OpenRouter image model here) follow best.
 */
export const prompts = {
  view(c: PromptContext): string {
    if (c.mode === "roof") {
      return `A photo identical to the first image, except that its plain gray roofs are now ${c.roofLook}, following each ` +
        `roof's exact outline and slope, with ${light(c)}; nothing is added on the roofs.` + trueSize(c) +
        ROOF_PASS_CONSTRAINT + avoid(c);
    }
    if (c.mode === "first") {
      return `A photorealistic photo of ${c.look}, with exactly the camera, perspective and composition of the first ` +
        `image and ${light(c)}. Every gray shape of the first image keeps its exact outline and is now the real ` +
        `surface it is${shapes(c)}. ${surfaces(c)}` + trueSize(c) + SURFACE_ONLY_CONSTRAINT + avoid(c);
    }
    return `A photorealistic photo of ${c.look}, with ${light(c)}, identical to the first image in camera, perspective, ` +
      "composition and in every area that already has texture; the plain gray untextured surfaces of the first image now " +
      `continue those textures seamlessly and keep their exact outlines${shapes(c)}. ${surfaces(c)}` + trueSize(c) +
      SURFACE_ONLY_CONSTRAINT + avoid(c);
  },
};

/** Added to the prompt when a style image rides along; it is a material reference, never a composition. */
export const STYLE_INSTRUCTION =
  " Take the materials, colours and wear from the second image only; the camera, shapes and layout come from the first image.";

/**
 * Added to the prompt when already-accepted texture of the same surface rides along (C, PRD-916 phase 2d).
 *
 * Different views of one flat wall used to pick different materials (an ashlar wall became smooth stucco
 * at a vertical seam, and block courses missed each other across it), because each request saw only the
 * clay plus whatever a previous view had painted in *its* pixels. A crop of the accepted paint makes the
 * surface's material explicit. The wording never indexes the reference (a style image may ride along
 * too), and it names the three things that visibly broke the seam: material, block size, coursing.
 */
export const CONSISTENCY_INSTRUCTION =
  " The already-accepted texture of this same surface rides along as a material reference: keep exactly its materials," +
  " its block and stone sizes and its coursing, continuing the same courses across this view; do not change the material" +
  " or the scale of the blocks anywhere this surface appears.";

function openRouterModel(key: string, label: string, id: string, price: number): EditModel {
  return {
    key,
    label,
    id,
    price,
    input: (i) => ({
      model: id,
      prompt: prompts.view(i.prompt),
      aspect_ratio: "1:1",
      seed: i.seed,
      input_references: [{ type: "image_url", image_url: { url: i.imageUrl } }],
      ...(i.consistency === undefined ? {} : { consistency_image: i.consistency }),
    }),
  };
}

export const DEFAULT_MODEL = "or-klein";

/** Selectable aliases, in the order the UI lists them. */
export const MODEL_ALIASES: readonly EditModel[] = [
  openRouterModel("or-klein", "FLUX 3 Klein", "black-forest-labs/flux-3-image-klein", 0.009),
  openRouterModel("muse-image", "Muse Image", "meta/muse-image", 0.01),
  openRouterModel("or-seedream-lite", "Seedream 5 Lite", "bytedance-seed/seedream-5-0-lite", 0.035),
];

/**
 * A known alias, or any `or:<model id>` on demand. The price of a passthrough model is a guess for
 * the cost tally, never a quote.
 */
export function resolveModel(key: string): EditModel | undefined {
  const alias = MODEL_ALIASES.find((model) => model.key === key);
  if (alias) return alias;
  if (!key.startsWith("or:") || key.length <= 3) return undefined;
  const id = key.slice(3);
  return openRouterModel(key, id, id, 0.01);
}
