import { PICTURE_CONTRACT_REVISION, type PictureLighting, type SourceEnvironmentReport, type SourceGridReport } from "./contact-sheet.js";
import type { ThumbnailSourceGrid } from "./thumbnail-floor.js";
import type { ThumbnailSourceRadiance } from "./thumbnail-lighting.js";
import { loadThumbnailReferenceProfile, type ThumbnailReferenceProfile } from "./thumbnail-reference-profile.js";

/**
 * The local reference the unreal-like picture can be lit and floored with, and the identity every picture records.
 *
 * `THREENATIVE_UNREAL_PREVIEW_REFERENCE` names a version-1 profile on this machine (`thumbnail-reference-profile.ts`). The
 * comparison commands read it here, once, before anything is downloaded, listed or thumbnailed. Unset means the approximate
 * fallback, and the picture records that. Set but invalid throws, so a configured reference never falls back quietly.
 * Nothing is fetched, bundled or searched for, and the raw loader never reads the environment.
 */
export const PREVIEW_REFERENCE_ENV = "THREENATIVE_UNREAL_PREVIEW_REFERENCE";

/** The contract every unreal-like picture records. The renderer owns the revision (`PICTURE_CONTRACT_REVISION`). */
export const PICTURE_CONTRACT = `unreal-like/${PICTURE_CONTRACT_REVISION}`;

/**
 * What lit a picture. Digests cover the bytes read, never pixels or paths. A `neutral` picture draws no reference light, so
 * the reference is not part of its identity.
 */
export type PictureIdentity =
  | { readonly kind: "neutral" }
  | { readonly kind: "fallback"; readonly contract: string }
  | {
      readonly kind: "local-reference";
      readonly contract: string;
      readonly profileSha256: string;
      readonly environmentRadianceSha256: string;
      readonly gridRgbaSha256: string;
    };

/** The verified inputs of one run, and the identity they give the pictures it draws. */
export interface PreviewPicture {
  readonly identity: PictureIdentity;
  /** Passed to `renderContactSheet` as they are. Empty unless a local reference lights an unreal-like picture. */
  readonly inputs: {
    readonly sourceEnvironment?: ThumbnailSourceRadiance;
    readonly sourceGrid?: ThumbnailSourceGrid;
  };
}

/** The reports of the inputs the renderer says it applied (`ContactSheetResult`). */
export interface AppliedPictureInputs {
  readonly sourceEnvironment?: SourceEnvironmentReport;
  readonly sourceGrid?: SourceGridReport;
}

/** What a sheet or picture file stores: the identity and the reports of the inputs the renderer applied. */
export interface PictureRecord extends AppliedPictureInputs {
  readonly identity: PictureIdentity;
}

/**
 * Reads the configured reference, once per command, and works out the picture it gives. Call it before any download, listing,
 * thumbnail read or output directory. A configured reference that is invalid rejects, and the caller exits.
 */
export async function preparePreviewPicture(env: NodeJS.ProcessEnv, lighting: PictureLighting): Promise<PreviewPicture> {
  const configured = env[PREVIEW_REFERENCE_ENV];
  const profile = configured === undefined ? undefined : await loadConfigured(configured.trim());
  if (lighting === "neutral") return { identity: { kind: "neutral" }, inputs: {} };
  if (profile === undefined) return { identity: { kind: "fallback", contract: PICTURE_CONTRACT }, inputs: {} };
  const { profileSha256, environmentRadianceSha256, gridRgbaSha256 } = profile.report;
  return {
    identity: { kind: "local-reference", contract: PICTURE_CONTRACT, profileSha256, environmentRadianceSha256, gridRgbaSha256 },
    inputs: { sourceEnvironment: profile.sourceEnvironment, sourceGrid: profile.sourceGrid },
  };
}

async function loadConfigured(path: string): Promise<ThumbnailReferenceProfile> {
  try {
    return await loadThumbnailReferenceProfile(path);
  } catch (error) {
    throw new Error(`${PREVIEW_REFERENCE_ENV} does not name a valid version-1 reference profile: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The record a sheet or picture file stores. The renderer's applied inputs are checked against the verified ones: a local
 * reference must have been applied with its own digests, and a fallback or neutral picture must have applied nothing. A
 * disagreement throws, so no picture is stored under an identity it was not drawn with.
 */
export function pictureRecord(picture: PreviewPicture, applied: AppliedPictureInputs): PictureRecord {
  const { identity } = picture;
  if (identity.kind === "local-reference") {
    if (applied.sourceEnvironment?.radianceSha256 !== identity.environmentRadianceSha256 || applied.sourceGrid?.rgbaSha256 !== identity.gridRgbaSha256) {
      throw new Error("the renderer did not apply the verified reference environment and Grid");
    }
  } else if (applied.sourceEnvironment !== undefined || applied.sourceGrid !== undefined) {
    throw new Error(`the renderer applied a reference input to a ${identity.kind} picture`);
  }
  return {
    identity,
    ...(applied.sourceEnvironment === undefined ? {} : { sourceEnvironment: applied.sourceEnvironment }),
    ...(applied.sourceGrid === undefined ? {} : { sourceGrid: applied.sourceGrid }),
  };
}

/** A scorecard entry as far as the resume check reads it. `error` is set on a sheet that could not be made. */
export interface StoredSheetEntry {
  readonly sheet?: { readonly picture?: unknown; readonly error?: unknown } | null;
}

/**
 * How many stored sheets were not drawn as `identity`: a sheet that failed (whatever picture it carries), a sheet with no picture
 * record (written before records existed) or a different one. `--resume --sheets` keeps stored sheets and re-renders none of them,
 * so it refuses while any exist.
 */
export function sheetsNotDrawnAs(entries: readonly StoredSheetEntry[], identity: PictureIdentity): number {
  let count = 0;
  for (const entry of entries) if (entry.sheet && (entry.sheet.error !== undefined || !sameIdentity(entry.sheet.picture, identity))) count++;
  return count;
}

/** Whether a stored picture is exactly `identity`. Every field of the identity is compared, so another revision never matches. */
function sameIdentity(stored: unknown, identity: PictureIdentity): boolean {
  if (typeof stored !== "object" || stored === null) return false;
  const record = stored as Record<string, unknown>;
  if (record.kind !== identity.kind) return false;
  if (identity.kind === "neutral") return true;
  if (record.contract !== identity.contract) return false;
  if (identity.kind === "fallback") return true;
  return (
    record.profileSha256 === identity.profileSha256 &&
    record.environmentRadianceSha256 === identity.environmentRadianceSha256 &&
    record.gridRgbaSha256 === identity.gridRgbaSha256
  );
}

/** The picture in plain words, for the console and for the refusal. */
export function describePicture(identity: PictureIdentity): string {
  if (identity.kind === "neutral") return "neutral (flat light; no reference applied)";
  if (identity.kind === "fallback") {
    return `approximate fallback (hemisphere fill and procedural checker, not the reference environment; set ${PREVIEW_REFERENCE_ENV} to use a local profile)`;
  }
  return `local reference ${identity.profileSha256.slice(0, 12)} (${identity.contract})`;
}

/** The refusal `--resume --sheets` prints: the count, the picture this run would draw, and the ways forward. */
export function resumeRefusal(count: number, identity: PictureIdentity): string {
  return [
    `--resume --sheets refused: ${count} sheet(s) in scorecard.json could not be made, were not drawn as ${describePicture(identity)}, or carry no picture record.`,
    "Resuming would keep them unchanged beside sheets drawn now, and kept sheets are not re-rendered (their downloads may already be deleted).",
    "Write to a new --out for this picture, or add --no-sheets to resume without drawing sheets.",
  ].join("\n");
}
