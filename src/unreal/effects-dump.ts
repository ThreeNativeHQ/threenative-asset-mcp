import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { buildCascadeDescriptor, buildNiagaraDescriptor, type DumpPackage, type EffectDescriptor } from "./effects-schema.js";
import { gamePackageKey } from "./game-path.js";

/**
 * PRD-584: the Node builder for Cascade and Niagara descriptors. The pinned CUE4Parse adapter's
 * `--dump-effects` mode emits raw tagged properties (it has no typed Cascade classes, and reads
 * Niagara through the same generic transport); this module maps them with
 * {@link buildCascadeDescriptor} or {@link buildNiagaraDescriptor}, validates the descriptor,
 * and writes `Effects/<system>.cascade.json` or `Effects/<system>.niagara.json`.
 */

export const effectsDumpSchema = z.object({
  format: z.literal(1),
  game: z.string(),
  /** Effect packages the compiled adapter failed to load. They stay skipped; this names why. */
  errors: z.array(z.object({ path: z.string(), error: z.string() })).optional(),
  packages: z.array(
    z.object({
      path: z.string(),
      exports: z.array(
        z.object({
          index: z.number(),
          class: z.string(),
          name: z.string(),
          properties: z.array(z.unknown()).optional(),
        }),
      ),
    }),
  ),
});

export type EffectsDump = z.infer<typeof effectsDumpSchema>;

export interface ImportedEffect {
  /** Path of the descriptor, relative to the import output. */
  readonly descriptor: string;
  /** Canonical game path of the effect package the descriptor came from (`/Game/.../P_effect`). */
  readonly package: string;
  readonly system: string;
  readonly emitters: number;
  readonly limitations: readonly string[];
}

/**
 * The canonical identity of one exported descriptor. The package is required: two packages that share
 * a system basename are different descriptors, and an absent package is invalid data, never a fallback.
 */
export interface EffectDescriptorIdentity {
  /** Canonical game path of the source package (`/Game/.../P_effect`), never the raw dump key. */
  readonly package: string;
  /** Unreal object name of the `ParticleSystem`/`NiagaraSystem` the descriptor describes. */
  readonly system: string;
}

/**
 * The one canonical identity a descriptor file name is derived from, normalized exactly like
 * {@link gamePackageKey} (`/Game/A/P_effect.P_effect` -> `a/p_effect.p_effect`). Case and mount
 * differences collapse, so a package case variant is the same descriptor, never a second file.
 */
export function effectDescriptorIdentityKey(identity: EffectDescriptorIdentity): string {
  return gamePackageKey(`${identity.package}.${identity.system}`);
}

/**
 * The one mapping from a descriptor identity and source to its file name, shared by the writer, the
 * compiled adapter's level pointer and the scene-omission reconciler. The system name is sanitized to
 * one display label and the canonical full object path hashes to a stable suffix, so two systems with
 * the same basename in different folders, and two names that only collide after sanitization, both get
 * a distinct file. The label never escapes `Effects/` (a `..` or a separator cannot shape the path).
 */
export function effectDescriptorFileName(identity: EffectDescriptorIdentity, source: "cascade" | "niagara"): string {
  const safe = identity.system.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/\.{2,}/g, ".").replace(/^\.+/, "").replace(/\.+$/, "");
  const hash = createHash("sha256").update(effectDescriptorIdentityKey(identity), "utf8").digest("hex").slice(0, 16);
  return `${safe.length > 0 ? safe : "Effect"}-${hash}.${source}.json`;
}

/** The descriptor's path relative to the import output, built from {@link effectDescriptorFileName}. */
export function effectDescriptorRelativePath(identity: EffectDescriptorIdentity, source: "cascade" | "niagara"): string {
  return `Effects/${effectDescriptorFileName(identity, source)}`;
}

/** A package whose descriptor could not be written. It stays skipped; this names why. */
export interface EffectsWriteFailure {
  /** Canonical game path of the source package, when the dump named one. */
  readonly package: string;
  readonly system: string;
  readonly error: string;
}

export interface EffectsWriteResult {
  readonly written: readonly ImportedEffect[];
  readonly failures: readonly EffectsWriteFailure[];
}

/**
 * Maps every `ParticleSystem`/`NiagaraSystem`/`NiagaraEmitter` package and writes its descriptor under
 * `Effects/`. Each package is isolated: a descriptor that fails to build or write is reported in
 * `failures` and the other packages are still exported, so one bad package never aborts the import.
 * Two systems that share a basename in different folders both export, each to its own identity-keyed
 * file. Only the same canonical identity written twice is refused, never overwritten.
 */
export async function writeUnrealEffects(dump: EffectsDump, outputDir: string): Promise<EffectsWriteResult> {
  const written: ImportedEffect[] = [];
  const failures: EffectsWriteFailure[] = [];
  // Keyed by canonical identity, so only two descriptors of the SAME package and system are refused,
  // never two systems that merely share a basename or sanitize to the same label.
  const taken = new Map<string, string>();
  for (const dumpPackage of dump.packages) {
    const pkg = dumpPackage as unknown as DumpPackage;
    // A canonical package path is required: without it the descriptor identity is undefined, so this
    // is invalid data and the package is reported, never given an ambiguous fallback name.
    const packageName = pkg.path ?? pkg.package ?? pkg.key;
    if (packageName === undefined || packageName.length === 0) {
      failures.push({ package: "<unknown>", system: "", error: "package has no canonical game path; the descriptor identity is undefined" });
      continue;
    }
    let descriptor: EffectDescriptor | null;
    try {
      descriptor = buildCascadeDescriptor(pkg) ?? buildNiagaraDescriptor(pkg);
    } catch (error) {
      failures.push({ package: packageName, system: "", error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (descriptor === null) continue;
    const identity = { package: packageName, system: descriptor.system };
    const identityKey = `${descriptor.source}|${effectDescriptorIdentityKey(identity)}`;
    const existing = taken.get(identityKey);
    if (existing !== undefined) {
      failures.push({ package: packageName, system: descriptor.system, error: `${identityKey} is already written for ${existing}; two source packages share the same canonical identity` });
      continue;
    }
    const descriptorPath = effectDescriptorRelativePath(identity, descriptor.source);
    try {
      const file = join(outputDir, ...descriptorPath.split("/"));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(descriptor, null, 2)}\n`);
    } catch (error) {
      failures.push({ package: packageName, system: descriptor.system, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    taken.set(identityKey, packageName);
    written.push({
      descriptor: descriptorPath,
      package: packageName,
      system: descriptor.system,
      emitters: descriptor.emitters.length,
      limitations: descriptor.emitters.flatMap((emitter) => emitter.limitations),
    });
  }
  return { written, failures };
}
