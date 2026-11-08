import type { Asset } from "../discovery/types.js";

const POLYFORK_LICENSE_NAME = "CC BY 4.0 or Polyfork licence";
const POLYFORK_LICENSE_URL = "https://polyfork.dev/licensing";

const POLYFORK_LICENSE_EVIDENCE =
  "Free Polyfork low-poly mesh files come under two licences, the user's choice: CC BY 4.0 " +
  "(credit the asset's credit line, link its model page, state changes; redistribution and " +
  "resale allowed) or the Polyfork licence (no attribution, no standalone redistribution of the " +
  "files, and no building or training a commercial 3D asset generator from them; CC BY 4.0 sets " +
  "no such limit on the mesh files). Call polyfork_get_model for the per-asset licence text and " +
  "credit line.";

export const POLYFORK_TERMS =
  "Free Polyfork low-poly mesh files; this plan is the GLB only. Licence choice: (1) CC BY 4.0 — " +
  "credit the asset's credit line, link its model page and state changes; redistribution and sale " +
  "of the mesh are allowed, commercially included, and CC BY 4.0 sets no limit on building or " +
  "training a 3D asset generator from those mesh files. (2) Polyfork licence — no attribution in " +
  "what you build, but no standalone redistribution of the files; shipping them inside a game or " +
  "product is fine, and under this licence do not use the files to build or train a commercial 3D " +
  "asset generator. The .mjs source modules, HD editions, renders/thumbnails and the text and data " +
  "beside the models are Polyfork-licence only, not CC BY, are not part of this download, and must " +
  "not be used to build or train a commercial 3D asset generator. HD editions need Polyfork Pro. " +
  "If your product lets users pick these models, credit Polyfork as their source there and fetch " +
  "each model on use, not the catalogue in bulk.";

export function polyforkLicense(credit?: string, licenseText?: string): Asset["license"] {
  const evidence = [
    licenseText ?? POLYFORK_LICENSE_EVIDENCE,
    credit ? `CC BY 4.0 credit line: ${credit}` : "",
    credit
      ? "The Polyfork licence is the other choice: no attribution, but no standalone redistribution of the files."
      : "",
    "The .mjs source, HD editions and thumbnails stay under the Polyfork licence only.",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    name: POLYFORK_LICENSE_NAME,
    url: POLYFORK_LICENSE_URL,
    evidence: evidence.slice(0, 2000),
    commercialUse: "yes",
    attributionRequired: "yes",
  };
}
