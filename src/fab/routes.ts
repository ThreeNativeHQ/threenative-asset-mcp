/**
 * Which decoder reads a Fab Unreal artifact. An artifact's format is its oldest listed engine: a
 * listing that advertises UE 4.18 through 5.8 is still a 4.18 package.
 */

export type DecoderRoute = "umodel" | "mesh-description" | "cue4parse";

const ENGINE = /^UE_(\d+)\.(\d+)$/;

interface EngineVersion {
  readonly major: number;
  readonly minor: number;
}

function parseEngine(engine: string): EngineVersion | undefined {
  const match = ENGINE.exec(engine.trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function compare(a: EngineVersion, b: EngineVersion): number {
  return a.major - b.major || a.minor - b.minor;
}

/** The numerically oldest `UE_x.y` selector; entries that are not selectors are ignored. */
export function oldestEngine(engines: readonly string[]): string | undefined {
  let best: { readonly engine: string; readonly version: EngineVersion } | undefined;
  for (const engine of engines) {
    const version = parseEngine(engine);
    if (!version) continue;
    if (!best || compare(version, best.version) < 0) best = { engine: engine.trim(), version };
  }
  return best?.engine;
}

/** UE Viewer up to 4.20, the MeshDescription converter for 4.21-4.27, CUE4Parse from 5.0. */
export function decoderRoute(engine: string): DecoderRoute {
  const version = parseEngine(engine);
  if (!version) return "cue4parse";
  if (version.major < 4 || (version.major === 4 && version.minor <= 20)) return "umodel";
  if (version.major === 4) return "mesh-description";
  return "cue4parse";
}

/**
 * The `--engine` value the property dump's ParseGame accepts (`4.18`), or undefined for a version
 * it does not know (4.0-4.27 and 5.0-5.7 are accepted).
 */
export function dumpEngineArg(engine: string): string | undefined {
  const version = parseEngine(engine);
  if (!version) return undefined;
  const known =
    (version.major === 4 && version.minor <= 27) || (version.major === 5 && version.minor <= 7);
  return known ? `${version.major}.${version.minor}` : undefined;
}
