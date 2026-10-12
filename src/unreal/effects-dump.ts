import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { buildCascadeDescriptor, buildNiagaraDescriptor, type DumpPackage, type EffectDescriptor } from "./effects-schema.js";

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
 * The one mapping from a system name and source to its descriptor file name, shared by the writer and
 * the scene-omission reconciler. The Unreal object name is sanitized, so it is always one path segment
 * under `Effects/` and never escapes it (a `..` or a separator cannot shape the output path).
 */
export function effectDescriptorFileName(system: string, source: "cascade" | "niagara"): string {
  const safe = system.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/\.{2,}/g, ".").replace(/^\.+/, "").replace(/\.+$/, "");
  return `${safe.length > 0 ? safe : "Effect"}.${source}.json`;
}

/** The descriptor's path relative to the import output, built from {@link effectDescriptorFileName}. */
export function effectDescriptorRelativePath(system: string, source: "cascade" | "niagara"): string {
  return `Effects/${effectDescriptorFileName(system, source)}`;
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
 * A duplicate output path (two source packages sharing a system name) is refused, never overwritten.
 */
export async function writeUnrealEffects(dump: EffectsDump, outputDir: string): Promise<EffectsWriteResult> {
  const written: ImportedEffect[] = [];
  const failures: EffectsWriteFailure[] = [];
  const taken = new Map<string, string>();
  for (const dumpPackage of dump.packages) {
    const pkg = dumpPackage as unknown as DumpPackage;
    const packageName = pkg.path ?? pkg.package ?? pkg.key ?? "<unknown>";
    let descriptor: EffectDescriptor | null;
    try {
      descriptor = buildCascadeDescriptor(pkg) ?? buildNiagaraDescriptor(pkg);
    } catch (error) {
      failures.push({ package: packageName, system: "", error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (descriptor === null) continue;
    const descriptorPath = effectDescriptorRelativePath(descriptor.system, descriptor.source);
    const existing = taken.get(descriptorPath);
    if (existing !== undefined) {
      failures.push({ package: packageName, system: descriptor.system, error: `${descriptorPath} is already written for ${existing}; two source packages share the system name "${descriptor.system}"` });
      continue;
    }
    try {
      const file = join(outputDir, ...descriptorPath.split("/"));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(descriptor, null, 2)}\n`);
    } catch (error) {
      failures.push({ package: packageName, system: descriptor.system, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    taken.set(descriptorPath, packageName);
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
