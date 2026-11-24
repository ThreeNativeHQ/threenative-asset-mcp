/**
 * The cook-settings audit `texture_project_inspect` reports (C.3, A.4). A painted atlas is a
 * 4-8K albedo image with real detail, while the engine cook's model-texture pass defaults to a 2048
 * cap and a measured ETC1S/UASTC ladder: either silently blurs the bake unless the project names
 * the override. `threenative.config.ts` is TypeScript, so this reads it leniently (comments stripped,
 * balanced brace blocks found) instead of compiling it: anything it cannot read is reported as
 * unreadable, never assumed good.
 */

export interface CookConfigAudit {
  /** Project-relative config path, or null when the project has none. */
  readonly path: string | null;
  /** Effective longest edge for `baseColorTexture` (default 2048 when the config does not set it). */
  readonly baseColorMaxSize: number;
  /** Explicit codec override for `baseColorTexture`, when the config names one. */
  readonly baseColorCodec: string | undefined;
  readonly flagged: boolean;
  readonly findings: readonly string[];
}

/** The cook's default longest edge when neither `assets.models.textures.maxSize` nor an override says. */
export const DEFAULT_MODEL_TEXTURE_MAX_SIZE = 2048;

function stripComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const pair = text.slice(i, i + 2);
    if (pair === "//") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (pair === "/*") {
      i += 2;
      while (i < text.length && text.slice(i, i + 2) !== "*/") i++;
      i += 1;
      continue;
    }
    out += text[i];
  }
  return out;
}

/** The `{...}` object that follows `key:` in `text`, braces balanced; undefined when absent. */
export function objectAfter(text: string, key: string): string | undefined {
  const match = new RegExp(`(^|[^\\w.])${key}\\s*:`, "u").exec(text);
  if (!match) return undefined;
  const start = text.indexOf("{", match.index + match[0].length);
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return undefined;
}

function numberOf(text: string, key: string): number | undefined {
  const match = new RegExp(`(^|[^\\w.])${key}\\s*:\\s*(\\d+)`, "u").exec(text);
  return match ? Number(match[2]) : undefined;
}

/** Codec an `overrides: [{ slot: "baseColorTexture", codec: "uastc" }]` entry names, if any. */
function codecForSlot(text: string, slot: string): string | undefined {
  const array = /overrides\s*:\s*\[([\s\S]*?)\]/u.exec(text)?.[1];
  if (array === undefined) return undefined;
  for (const entry of array.match(/\{[^{}]*\}/gu) ?? []) {
    if (!new RegExp(`slot\\s*:\\s*["']${slot}["']`, "u").test(entry)) continue;
    return /codec\s*:\s*["']?([a-z0-9]+)["']?/u.exec(entry)?.[1];
  }
  return undefined;
}

export function auditCookConfig(configText: string | undefined, atlas: number, path: string | null): CookConfigAudit {
  const findings: string[] = [];
  if (configText === undefined) {
    findings.push(
      `no threenative.config.ts: the cook defaults to maxSize ${DEFAULT_MODEL_TEXTURE_MAX_SIZE} with a measured ETC1S/UASTC ladder, so a ${atlas} atlas is downscaled and may be ETC1S-coded`,
    );
    return {
      path,
      baseColorMaxSize: DEFAULT_MODEL_TEXTURE_MAX_SIZE,
      baseColorCodec: undefined,
      flagged: true,
      findings,
    };
  }
  const text = stripComments(configText);
  const models = objectAfter(text, "models");
  const textures = models === undefined ? undefined : objectAfter(models, "textures");
  let baseColorMaxSize = DEFAULT_MODEL_TEXTURE_MAX_SIZE;
  if (textures === undefined) {
    findings.push(
      `assets.models.textures is not configured: the cook defaults to maxSize ${DEFAULT_MODEL_TEXTURE_MAX_SIZE} and a measured ETC1S/UASTC ladder`,
    );
  } else {
    const slotMax = objectAfter(textures, "maxSize");
    const flat = numberOf(textures, "maxSize");
    const bySlot = slotMax === undefined ? undefined : numberOf(slotMax, "baseColorTexture");
    baseColorMaxSize = bySlot ?? flat ?? DEFAULT_MODEL_TEXTURE_MAX_SIZE;
  }
  const baseColorCodec = textures === undefined ? undefined : codecForSlot(textures, "baseColorTexture");
  if (baseColorMaxSize < atlas) {
    findings.push(
      `assets.models.textures.maxSize for baseColorTexture is ${baseColorMaxSize} < the ${atlas} atlas: the cook box-downscales the painted atlas`,
    );
  }
  if (baseColorCodec === "etc1s") {
    findings.push("assets.models.textures.overrides sets baseColorTexture to ETC1S, which blurs a painted atlas");
  } else if (baseColorCodec === "none") {
    findings.push("assets.models.textures.overrides keeps baseColorTexture uncompressed: sharp, but large files and VRAM");
  } else if (baseColorCodec === undefined) {
    findings.push(
      "no UASTC override for baseColorTexture: the cook's measured ladder may choose ETC1S for the painted atlas",
    );
  }
  return { path, baseColorMaxSize, baseColorCodec, flagged: findings.length > 0, findings };
}
