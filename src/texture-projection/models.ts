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
  /** The area to paint is mostly ground. */
  floor: boolean;
  /** Painting under overcast light (no cast shadows wanted) rather than keeping the render's sun and shadows. */
  overcast?: boolean;
}

export interface EditInput {
  /** Data URL of the view to edit (the clay render with the texture painted so far). */
  imageUrl: string;
  prompt: PromptContext;
  seed: number;
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
/** How the light should look: the render's own sun and shadows, or soft overcast light with no cast shadows. */
const light = (c: PromptContext) => (c.overcast
  ? "soft, even overcast daylight with no cast shadows and no sunlit patches"
  : "the same light direction and shadows");
const surfaces = (c: PromptContext) =>
  "Walls may show flat details such as windows, doors, shutters and stonework, but nothing sticks out of them and " +
  `nothing new is added: no ${forbidden(c.parts)}.` + (c.floor ? " The ground stays clear: bare paving." : "");

/**
 * Caption-style prompts: the model is told what the result looks like, which is what maskless
 * image-reference edits (FLUX 3 Klein and every OpenRouter image model here) follow best.
 */
export const prompts = {
  view(c: PromptContext): string {
    if (c.mode === "roof") {
      return `A photo identical to the first image, except that its plain gray roofs are now ${c.roofLook}, following each ` +
        `roof's exact outline and slope, with ${light(c)}; nothing is added on the roofs.`;
    }
    if (c.mode === "first") {
      return `A photorealistic photo of ${c.look}, with exactly the camera, perspective and composition of the first ` +
        `image and ${light(c)}. Every gray shape of the first image keeps its exact outline and is now the real ` +
        `surface it is${shapes(c)}. ${surfaces(c)}`;
    }
    return `A photorealistic photo of ${c.look}, with ${light(c)}, identical to the first image in camera, perspective, ` +
      "composition and in every area that already has texture; the plain gray untextured surfaces of the first image now " +
      `continue those textures seamlessly and keep their exact outlines${shapes(c)}. ${surfaces(c)}`;
  },
};

/** Added to the prompt when a style image rides along; it is a material reference, never a composition. */
export const STYLE_INSTRUCTION =
  " Take the materials, colours and wear from the second image only; the camera, shapes and layout come from the first image.";

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
