/**
 * Animation logic descriptors for the Unreal importer (PRD-583).
 *
 * The CUE4Parse adapter writes one raw JSON document per logic asset (blend space, aim offset,
 * montage, composite) and one sidecar per clip. This module turns those raw documents into the
 * consumer contract: axis defaults restored, section starts resolved per `LinkMethod`, section and
 * slot clip names resolved to exported glTF animation names, and every clip that does not resolve
 * reported with its reason. It performs no I/O and no Unreal version branching, so it is testable
 * on synthetic inputs.
 */

/** The three axes a blend space always carries, as `UBlendSpaceBase.BlendParameters[3]`. */
export const BLEND_AXIS_COUNT = 3;

/** `FBlendParameter`'s defaults, which a serialized package omits when a field keeps its default. */
export const BLEND_AXIS_DEFAULTS = Object.freeze({ min: 0, max: 100, gridNum: 4, snap: false, wrap: false });

export interface RawBlendAxis {
  readonly displayName?: string;
  readonly min?: number;
  readonly max?: number;
  readonly gridNum?: number;
  readonly snapToGrid?: boolean;
  readonly wrapInput?: boolean;
}

export interface RawBlendSample {
  readonly animation?: string;
  readonly sampleValue?: readonly [number, number, number];
  readonly rateScale?: number;
  /** `FBlendSample::bMirror`: the sample plays mirrored by the blend space's `MirrorDataTable`. */
  readonly mirror?: boolean;
}

export interface RawBlendWindow {
  readonly time?: number;
  readonly value?: number;
  readonly mode?: string;
}

export interface RawMontageSegment {
  readonly animation?: string;
  readonly startPos?: number;
  readonly clipStart?: number;
  readonly clipEnd?: number;
  readonly playRate?: number;
  readonly loopCount?: number;
}

export interface RawMontageSlot {
  readonly name?: string;
  readonly segments?: readonly RawMontageSegment[];
}

export interface RawMontageSection {
  readonly name?: string;
  readonly next?: string;
  readonly linkMethod?: string;
  readonly segmentBeginTime?: number;
  readonly segmentLength?: number;
  readonly linkValue?: number;
}

export interface RawNotify {
  readonly name?: string;
  readonly time?: number;
  readonly duration?: number;
  readonly track?: number;
  readonly kind?: string;
  readonly className?: string;
}

export interface RawCurveKey {
  readonly time?: number;
  readonly value?: number;
  readonly arrive?: number;
  readonly leave?: number;
  readonly interp?: string;
}

export interface RawCurve {
  readonly name?: string;
  readonly keys?: readonly RawCurveKey[];
}

export interface RawAnimationAsset {
  readonly format?: string;
  readonly version?: number;
  readonly name?: string;
  readonly package?: string;
  readonly className?: string;
  readonly skeleton?: string | null;
  readonly kind?: "blendSpace" | "montage" | "composite" | "clip";
  readonly blendSpaceType?: "1D" | "2D" | "aimOffset";
  readonly animLength?: number;
  readonly loop?: boolean;
  readonly additive?: boolean;
  /** `UBlendSpaceBase::MirrorDataTable`, needed to realise any sample with `bMirror`. */
  readonly mirrorDataTable?: string | null;
  /** `UBlendSpace::PreviewBasePose`, the base pose an additive space blends against. */
  readonly previewBasePose?: string | null;
  readonly axes?: readonly RawBlendAxis[];
  readonly samples?: readonly RawBlendSample[];
  readonly interpolation?: readonly { readonly time?: number; readonly type?: string }[];
  readonly length?: number;
  readonly rateScale?: number;
  readonly blendIn?: RawBlendWindow;
  readonly blendOut?: RawBlendWindow;
  readonly slots?: readonly RawMontageSlot[];
  readonly sections?: readonly RawMontageSection[];
  readonly notifies?: readonly RawNotify[];
  readonly curves?: readonly RawCurve[];
  readonly syncMarkers?: readonly { readonly name?: string; readonly time?: number }[];
  readonly unsupportedReason?: string;
}

export interface NormalizedBlendAxis {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly gridNum: number;
  readonly wrap: boolean;
  readonly snap: boolean;
}

export interface NormalizedBlendSample {
  readonly clip: string;
  readonly pos: readonly [number, number, number];
  readonly rateScale: number;
  readonly mirror: boolean;
  /** Set when `clip` could not be resolved to exactly one exported animation. */
  readonly unresolved?: string;
}

export interface NormalizedBlendSpace {
  readonly kind: "blendSpace";
  readonly type: "1D" | "2D" | "aimOffset";
  readonly axes: readonly NormalizedBlendAxis[];
  readonly samples: readonly NormalizedBlendSample[];
  readonly smoothing: readonly { readonly time: number; readonly type: string }[];
  readonly loop: boolean;
  readonly additive: boolean;
}

export interface NormalizedMontageSegment {
  readonly clip: string;
  readonly startPos: number;
  readonly clipStart: number;
  readonly clipEnd: number;
  readonly playRate: number;
  readonly loops: number;
  readonly unresolved?: string;
}

export interface NormalizedMontageSlot {
  readonly name: string;
  readonly segments: readonly NormalizedMontageSegment[];
}

export interface NormalizedMontageSection {
  readonly name: string;
  readonly start: number;
  readonly next: string;
}

export interface NormalizedNotify {
  readonly name: string;
  readonly time: number;
  readonly duration: number;
  readonly track: number;
  readonly kind: string;
  readonly class: string;
}

export interface NormalizedMontage {
  readonly kind: "montage" | "composite";
  readonly length: number;
  readonly rateScale: number;
  readonly blendIn: NormalizedBlendWindow;
  readonly blendOut: NormalizedBlendWindow;
  readonly slots: readonly NormalizedMontageSlot[];
  readonly sections: readonly NormalizedMontageSection[];
  readonly notifies: readonly NormalizedNotify[];
}

export interface NormalizedBlendWindow {
  readonly time: number;
  readonly value: number;
  readonly mode: string;
}

export interface NormalizedClipKey {
  readonly time: number;
  readonly value: number;
  readonly arrive: number;
  readonly leave: number;
  readonly interp: string;
}

export interface NormalizedClipCurve {
  readonly name: string;
  readonly keys: readonly NormalizedClipKey[];
}

export interface NormalizedClipSidecar {
  readonly kind: "clip";
  readonly notifies: readonly NormalizedNotify[];
  readonly curves: readonly NormalizedClipCurve[];
  readonly syncMarkers: readonly { readonly name: string; readonly time: number }[];
  /** Set when the clip's bone tracks could not be exported, so the sidecar is metadata only. */
  readonly unsupportedReason?: string;
}

export type NormalizedAnimationAsset = NormalizedBlendSpace | NormalizedMontage;

export interface AnimationLogicAsset {
  readonly name: string;
  readonly package: string;
  readonly skeleton: string | undefined;
  readonly value: NormalizedAnimationAsset;
}

export interface AnimationLogicIssue {
  readonly package: string;
  readonly asset: string;
  readonly kind: string;
  readonly clip: string;
  readonly reason: string;
}

export interface AnimationLogicResult {
  readonly assets: readonly AnimationLogicAsset[];
  readonly sidecars: readonly { readonly name: string; readonly package: string; readonly value: NormalizedClipSidecar }[];
  readonly unresolved: readonly AnimationLogicIssue[];
  readonly unsupported: readonly { readonly package: string; readonly asset: string; readonly reason: string }[];
}

/** The descriptor envelope every adapter animation JSON carries. */
export const ANIMATION_DESCRIPTOR_FORMAT = "threenative-unreal-animation";
export const ANIMATION_DESCRIPTOR_VERSION = 1;
const ANIMATION_DESCRIPTOR_KINDS = new Set(["blendSpace", "montage", "composite", "clip"]);

export interface ParsedAnimationDescriptor {
  readonly descriptor?: RawAnimationAsset;
  /** A precise reason the document is not a usable descriptor, for the package report. */
  readonly reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the minimal envelope of an adapter animation descriptor before the importer accepts it as
 * produced. A converter that writes valid JSON of the wrong shape (or a truncated file) must be
 * reported for its package, never silently pushed into `buildAnimationLogic` where an unknown `kind`
 * is dropped without a trace.
 */
export function parseAnimationDescriptor(value: unknown): ParsedAnimationDescriptor {
  if (!isRecord(value)) return { reason: "the document is not a JSON object" };
  if (value.format !== ANIMATION_DESCRIPTOR_FORMAT) return { reason: `format is not "${ANIMATION_DESCRIPTOR_FORMAT}"` };
  if (value.version !== ANIMATION_DESCRIPTOR_VERSION) return { reason: `version is not ${ANIMATION_DESCRIPTOR_VERSION}` };
  if (typeof value.kind !== "string" || !ANIMATION_DESCRIPTOR_KINDS.has(value.kind)) {
    return { reason: `kind is not one of ${[...ANIMATION_DESCRIPTOR_KINDS].join(", ")}` };
  }
  if (typeof value.name !== "string" || value.name.length === 0) return { reason: "name is missing or empty" };
  if (typeof value.package !== "string" || value.package.length === 0) return { reason: "package is missing or empty" };
  return { descriptor: value as unknown as RawAnimationAsset };
}


/**
 * One exported glTF animation and the canonical package it came from, for clip-name resolution.
 * `package` is the Unreal package path (`/Game/Dir/Asset`, no extension, no object suffix). The
 * canonical object identity is `${package}.${name}`.
 */
export interface ExportedClip {
  /** The actual exported glTF animation name; this is what a resolver returns. */
  readonly name: string;
  /** The canonical package path (`/Game/Dir/Asset`, no extension) the clip was imported from. */
  readonly package: string;
  /**
   * The Unreal object (sequence) name a reference matches on, when it differs from the actual glTF name
   * (a same-basename clip whose glTF name was disambiguated). Defaults to `name` when omitted.
   */
  readonly object?: string;
}

function clipObject(clip: ExportedClip): string {
  return clip.object ?? clip.name;
}

/**
 * A stable, package-distinct relative path for an animation artifact in the import output. The
 * package path becomes directories, so `/Game/A/Walk` and `/Game/B/Walk` write different files and
 * never overwrite each other. Segments that could escape the directory are dropped, and the caller
 * still validates the result against the output root.
 */
export function animationArtifactPath(packagePath: string, name: string, extension: string): string {
  const canonical = canonicalAnimationPath(packagePath);
  const relative = canonical.startsWith("/Game/") ? canonical.slice("/Game/".length) : canonical.replace(/^\/+/, "");
  const directory = relative
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");
  return directory.length > 0 ? `Animation/${directory}/${name}${extension}` : `Animation/${name}${extension}`;
}

/**
 * The canonical package a nested animation artifact names, from its path relative to the `Animation`
 * root (`A/Walk/Walk.psa` -> `/Game/A/Walk`). A flat legacy artifact has no directory and returns
 * undefined, so the caller falls back to its package table.
 */
export function animationArtifactPackage(relativePath: string): string | undefined {
  const posix = relativePath.split("\\").join("/");
  const slash = posix.lastIndexOf("/");
  if (slash <= 0) return undefined;
  const directory = posix
    .slice(0, slash)
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");
  return directory.length > 0 ? `/Game/${directory}` : undefined;
}

/** A parsed Unreal animation reference: a bare object name, or a canonical package-qualified path. */
export interface ParsedAnimationReference {
  readonly name: string;
  /** The package path when the reference is canonical (`/Game/Dir/Asset`), else undefined. */
  readonly package?: string;
  readonly canonical: boolean;
}

/**
 * Normalizes a Unreal path the way the converter does: forward slashes, one separator, and no
 * `.uasset`/`.umap` extension. A mounted `<root>/Content/...` path becomes `/Game/...`, so a
 * filesystem mount and its Unreal name compare equal. Never mutates a bare object name.
 */
export function canonicalAnimationPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").trim();
  const withoutExtension = normalized.replace(/\.(?:uasset|umap)$/i, "");
  const contentAt = withoutExtension.toLowerCase().indexOf("/content/");
  return contentAt >= 0 ? `/Game/${withoutExtension.slice(contentAt + "/content/".length)}` : withoutExtension;
}

/**
 * Parses an animation reference. A canonical reference is `<package>.<object>` (`/Game/A/Walk.Walk`)
 * or a package path with no object (`/Game/A/Walk`, whose object is the last segment). A reference
 * without a leading slash is a bare legacy name and carries no package. The object split is at the
 * first dot after the last slash, so a dot inside a folder name never splits a package path.
 */
export function parseAnimationReference(value: string): ParsedAnimationReference {
  const normalized = canonicalAnimationPath(value);
  if (!normalized.startsWith("/")) return { name: normalized, canonical: false };
  const slash = normalized.lastIndexOf("/");
  const dot = normalized.indexOf(".", slash + 1);
  if (dot >= 0) return { name: normalized.slice(dot + 1), package: normalized.slice(0, dot), canonical: true };
  return { name: normalized.slice(slash + 1), package: normalized, canonical: true };
}

function finite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function text(value: string | undefined, fallback = ""): string {
  return value !== undefined && value.length > 0 ? value : fallback;
}

/**
 * Resolves a section start for its `LinkMethod`. Absolute is the raw time, Relative offsets from the
 * segment start, and Proportional scales the segment length — the same rule as Unreal's
 * `FAnimLinkableElement::GetTime`.
 */
export function sectionStart(section: RawMontageSection): number {
  const link = text(section.linkMethod, "Absolute");
  const begin = finite(section.segmentBeginTime, 0);
  const length = finite(section.segmentLength, 0);
  const value = finite(section.linkValue, 0);
  if (link === "Relative") return begin + value;
  if (link === "Proportional") return begin + value * length;
  return value;
}

/** Exactly three axes, every omitted field restored to `FBlendParameter`'s default. */
export function blendAxes(axes: readonly RawBlendAxis[] | undefined): readonly NormalizedBlendAxis[] {
  const normalized: NormalizedBlendAxis[] = [];
  for (let index = 0; index < BLEND_AXIS_COUNT; index += 1) {
    const axis = axes?.[index];
    normalized.push({
      name: text(axis?.displayName, ""),
      min: finite(axis?.min, BLEND_AXIS_DEFAULTS.min),
      max: finite(axis?.max, BLEND_AXIS_DEFAULTS.max),
      gridNum: finite(axis?.gridNum, BLEND_AXIS_DEFAULTS.gridNum),
      wrap: axis?.wrapInput ?? BLEND_AXIS_DEFAULTS.wrap,
      snap: axis?.snapToGrid ?? BLEND_AXIS_DEFAULTS.snap,
    });
  }
  return normalized;
}

export interface ClipResolution {
  /** The exported animation name, or the raw name when unresolved. */
  readonly clip: string;
  readonly unresolved?: string;
}

/**
 * Resolves a Unreal sequence reference to exactly one exported glTF animation. A canonical reference
 * (`/Game/A/Walk.Walk`) matches only the clip whose canonical package equals the reference's package;
 * it never falls back to a bare basename, so an explicit wrong package is reported instead of silently
 * binding another package's clip. A bare reference resolves only when exactly one exported clip carries
 * that name; a name two packages both export is ambiguous and reported. The resolved `clip` is always
 * the actual exported animation name.
 */
export function resolveClip(name: string | undefined, clips: readonly ExportedClip[]): ClipResolution {
  const wanted = text(name);
  if (wanted.length === 0) return { clip: "", unresolved: "the reference names no animation" };
  const reference = parseAnimationReference(wanted);
  if (reference.package !== undefined) {
    const packageKey = reference.package.toLowerCase();
    const exact = clips.filter(
      (clip) => canonicalAnimationPath(clip.package).toLowerCase() === packageKey && clipObject(clip).toLowerCase() === reference.name.toLowerCase(),
    );
    if (exact.length === 1) return { clip: exact[0]!.name };
    if (exact.length === 0) return { clip: reference.name, unresolved: `no exported animation matches ${wanted}` };
    return { clip: reference.name, unresolved: `the reference ${wanted} matches ${exact.length} exported animations` };
  }
  const matches = clips.filter((clip) => clipObject(clip).toLowerCase() === wanted.toLowerCase());
  const packages = new Set(matches.map((match) => canonicalAnimationPath(match.package).toLowerCase()));
  if (matches.length === 0) return { clip: wanted, unresolved: "no exported animation has this name" };
  if (packages.size > 1) return { clip: wanted, unresolved: `the name is ambiguous across ${packages.size} packages` };
  return { clip: matches[0]!.name };
}

function normalizeNotifies(notifies: readonly RawNotify[] | undefined): readonly NormalizedNotify[] {
  return (notifies ?? []).map((notify) => ({
    name: text(notify.name, notify.className ?? "AnimNotify"),
    time: finite(notify.time, 0),
    duration: finite(notify.duration, 0),
    track: finite(notify.track, 0),
    kind: text(notify.kind, "queued"),
    class: text(notify.className, "AnimNotify"),
  }));
}

function normalizeBlendSpace(raw: RawAnimationAsset, clips: readonly ExportedClip[], closed: Set<string>): NormalizedBlendSpace {
  const type = raw.blendSpaceType ?? "2D";
  const additive = raw.additive ?? type === "aimOffset";
  const mirrorDataTable = text(raw.mirrorDataTable ?? "");
  const samples = (raw.samples ?? []).map((sample): NormalizedBlendSample => {
    const resolved = resolveClip(sample.animation, clips);
    if (resolved.unresolved) closed.add(`${resolved.clip}\0${resolved.unresolved}`);
    const value = sample.sampleValue ?? [0, 0, 0];
    const mirror = sample.mirror ?? false;
    // A mirrored sample is produced by reflecting through a `MirrorDataTable`. Without one, the sample
    // cannot be realised, so say so instead of dropping the flag on the floor.
    if (mirror && mirrorDataTable.length === 0) {
      closed.add(`${resolved.clip}\0a mirrored sample needs a MirrorDataTable the import does not carry`);
    }
    return {
      clip: resolved.clip,
      pos: [finite(value[0], 0), finite(value[1], 0), finite(value[2], 0)],
      rateScale: finite(sample.rateScale, 1),
      mirror,
      ...(resolved.unresolved ? { unresolved: resolved.unresolved } : {}),
    };
  });
  // An additive space that is not an aim offset blends each sample onto a base pose. Aim-offset
  // mesh-space samples carry their own offset and need none.
  if (additive && type !== "aimOffset" && text(raw.previewBasePose ?? "").length === 0) {
    closed.add(`\0an additive blend space names no base pose the import can apply`);
  }
  return {
    kind: "blendSpace",
    type,
    axes: blendAxes(raw.axes),
    samples,
    smoothing: (raw.interpolation ?? []).map((entry) => ({ time: finite(entry.time, 0), type: text(entry.type, "Average") })),
    loop: raw.loop ?? true,
    additive,
  };
}

function normalizeMontage(raw: RawAnimationAsset, clips: readonly ExportedClip[], closed: Set<string>): NormalizedMontage {
  const slots = (raw.slots ?? []).map((slot): NormalizedMontageSlot => ({
    name: text(slot.name, "DefaultSlot"),
    segments: (slot.segments ?? []).map((segment): NormalizedMontageSegment => {
      const resolved = resolveClip(segment.animation, clips);
      if (resolved.unresolved) closed.add(`${resolved.clip}\0${resolved.unresolved}`);
      return {
        clip: resolved.clip,
        startPos: finite(segment.startPos, 0),
        clipStart: finite(segment.clipStart, 0),
        clipEnd: finite(segment.clipEnd, 0),
        playRate: finite(segment.playRate, 1),
        loops: finite(segment.loopCount, 1),
        ...(resolved.unresolved ? { unresolved: resolved.unresolved } : {}),
      };
    }),
  }));
  const sections = (raw.sections ?? []).map((section): NormalizedMontageSection => ({
    name: text(section.name, "Default"),
    start: sectionStart(section),
    next: text(section.next, "None"),
  }));
  return {
    kind: raw.kind === "composite" ? "composite" : "montage",
    length: finite(raw.length, 0),
    rateScale: finite(raw.rateScale, 1),
    blendIn: { time: finite(raw.blendIn?.time, 0), value: finite(raw.blendIn?.value, 0), mode: text(raw.blendIn?.mode, "Linear") },
    blendOut: { time: finite(raw.blendOut?.time, 0), value: finite(raw.blendOut?.value, 0), mode: text(raw.blendOut?.mode, "Linear") },
    slots,
    sections,
    notifies: normalizeNotifies(raw.notifies),
  };
}

/** A clip sidecar: notifies and float curves from either curve layout, with every key preserved. */
export function normalizeClipSidecar(raw: RawAnimationAsset): NormalizedClipSidecar {
  return {
    kind: "clip",
    notifies: normalizeNotifies(raw.notifies),
    curves: (raw.curves ?? []).map((curve): NormalizedClipCurve => ({
      name: text(curve.name),
      keys: (curve.keys ?? []).map((key): NormalizedClipKey => ({
        time: finite(key.time, 0),
        value: finite(key.value, 0),
        arrive: finite(key.arrive, 0),
        leave: finite(key.leave, 0),
        interp: text(key.interp, "Linear"),
      })),
    })),
    syncMarkers: (raw.syncMarkers ?? []).map((marker) => ({ name: text(marker.name), time: finite(marker.time, 0) })),
    ...(raw.unsupportedReason ? { unsupportedReason: raw.unsupportedReason } : {}),
  };
}

/**
 * Resolves every clip reference in the raw descriptors against the exported animations. A blend space
 * or montage whose skeleton is absent from the import is reported, not bound to an unrelated rig.
 */
export function buildAnimationLogic(
  rawAssets: readonly RawAnimationAsset[],
  clips: readonly ExportedClip[],
  skeletons: readonly string[] | undefined,
): AnimationLogicResult {
  const skeletonCounts = new Map<string, number>();
  for (const skeleton of skeletons ?? []) {
    const key = skeleton.toLowerCase();
    skeletonCounts.set(key, (skeletonCounts.get(key) ?? 0) + 1);
  }
  const assets: AnimationLogicAsset[] = [];
  const sidecars: AnimationLogicResult["sidecars"][number][] = [];
  const unresolved: AnimationLogicIssue[] = [];
  const unsupported: AnimationLogicResult["unsupported"][number][] = [];

  for (const raw of [...rawAssets].sort((left, right) => (left.package ?? "").localeCompare(right.package ?? "") || (left.name ?? "").localeCompare(right.name ?? ""))) {
    const name = text(raw.name);
    const packagePath = text(raw.package);
    const className = text(raw.className);
    if (raw.unsupportedReason) unsupported.push({ package: packagePath, asset: name, reason: raw.unsupportedReason });
    if (raw.kind === "clip") {
      // A clip whose bone tracks could not be exported still keeps its notifies, curves and sync
      // markers as a sidecar; the unsupported reason above records that no glTF animation was written.
      sidecars.push({ name, package: packagePath, value: normalizeClipSidecar(raw) });
      continue;
    }
    if (raw.unsupportedReason) continue;
    if (raw.kind !== "blendSpace" && raw.kind !== "montage" && raw.kind !== "composite") continue;
    const closed = new Set<string>();
    const skeletonName = text(raw.skeleton ?? "");
    let skeleton: string | undefined = skeletonName.length > 0 ? skeletonName : undefined;
    if (skeletons === undefined) {
      // The importer cannot map a skeleton object name to an imported mesh, so it does not guess.
    } else if (skeleton === undefined) {
      unresolved.push({ package: packagePath, asset: name, kind: text(raw.kind), clip: "", reason: "the asset names no skeleton" });
    } else {
      const count = skeletonCounts.get(skeleton.toLowerCase()) ?? 0;
      if (count === 0) {
        unresolved.push({ package: packagePath, asset: name, kind: text(raw.kind), clip: skeleton, reason: "the skeleton was not imported" });
        skeleton = undefined;
      } else if (count > 1) {
        unresolved.push({ package: packagePath, asset: name, kind: text(raw.kind), clip: skeleton, reason: "the skeleton is ambiguous across several imported meshes" });
        skeleton = undefined;
      }
    }
    const value = raw.kind === "blendSpace"
      ? normalizeBlendSpace(raw, clips, closed)
      : normalizeMontage(raw, clips, closed);
    for (const entry of closed) {
      const [clip, reason] = entry.split("\0");
      unresolved.push({ package: packagePath, asset: name, kind: text(raw.kind), clip: clip ?? "", reason: reason ?? "" });
    }
    assets.push({ name, package: packagePath, skeleton, value });
  }
  return { assets, sidecars, unresolved, unsupported };
}
