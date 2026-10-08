/**
 * Material metadata replay: records every `.mat` and `.props.txt` text a material resolution read,
 * together with what `resolveMaterial` returned for them, so the resolution can be re-run later
 * without the source pack. A dump that replays with mismatches means the resolver changed its
 * answer for the same inputs.
 *
 * Dumps hold licensed pack material names and texture names. They are local-only: never commit one.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  type MaterialTextureBinding,
  type ResolveMaterialRequest,
  resolveMaterial,
} from "./materials.js";

export const MATERIAL_METADATA_VERSION = 1;

export interface MaterialMetadataEntry {
  readonly name: string;
  /** Material name -> `.mat` text, for every name read through the Parent chain that had one. */
  readonly mat: Record<string, string>;
  /** Material name -> `.props.txt` text, for every name read through the Parent chain that had one. */
  readonly props: Record<string, string>;
  readonly availableTextures: string[];
  readonly sharedGraphMaterialNames?: string[];
  /** What `resolveMaterial` returned for the recorded inputs when the dump was captured. */
  readonly expected: {
    readonly bindings: MaterialTextureBinding[];
    readonly limitations: string[];
  };
}

export interface MaterialMetadataDump {
  readonly version: 1;
  readonly source: string;
  readonly materials: MaterialMetadataEntry[];
}

/** JSON round trip, so captured and replayed values compare the way they are stored on disk. */
function normalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Runs `resolveMaterial` on the request while recording every text it reads. The returned entry
 * replays the same resolution because it holds exactly the texts that were read.
 */
export function captureMaterialMetadata(request: ResolveMaterialRequest): MaterialMetadataEntry {
  const mat: Record<string, string> = {};
  const props: Record<string, string> = {};
  const recording: ResolveMaterialRequest = {
    ...request,
    readMat: (materialName) => {
      const text = request.readMat(materialName);
      if (text !== undefined) mat[materialName] = text;
      return text;
    },
    readProps: (materialName) => {
      const text = request.readProps(materialName);
      if (text !== undefined) props[materialName] = text;
      return text;
    },
  };
  const resolved = resolveMaterial(recording);
  return normalize({
    name: request.name,
    mat,
    props,
    availableTextures: [...request.availableTextures].sort(),
    ...(request.sharedGraphMaterialNames
      ? { sharedGraphMaterialNames: [...request.sharedGraphMaterialNames].sort() }
      : {}),
    expected: { bindings: [...resolved.bindings], limitations: [...resolved.limitations] },
  });
}

const describeBinding = (binding: MaterialTextureBinding): string =>
  `${binding.slot}=${binding.texture}${binding.secondaryTexture ? `+${binding.secondaryTexture}` : ""} [${binding.source}/${binding.confidence}/${binding.transform}]`;

/**
 * Re-runs `resolveMaterial` for every entry from its recorded texts. Returns one human-readable
 * line per difference from `expected`; an empty list means the replay agrees with the capture.
 */
export function replayMaterialMetadata(dump: MaterialMetadataDump): string[] {
  if (dump.version !== MATERIAL_METADATA_VERSION) {
    return [`unsupported dump version ${String(dump.version)}; expected ${MATERIAL_METADATA_VERSION}`];
  }
  const mismatches: string[] = [];
  for (const entry of dump.materials) {
    const request: ResolveMaterialRequest = {
      name: entry.name,
      readMat: (materialName) => (Object.hasOwn(entry.mat, materialName) ? entry.mat[materialName] : undefined),
      readProps: (materialName) => (Object.hasOwn(entry.props, materialName) ? entry.props[materialName] : undefined),
      availableTextures: new Set(entry.availableTextures),
      ...(entry.sharedGraphMaterialNames ? { sharedGraphMaterialNames: new Set(entry.sharedGraphMaterialNames) } : {}),
    };
    const resolved = normalize(resolveMaterial(request));
    const expectedBindings = entry.expected.bindings.map(describeBinding);
    const actualBindings = resolved.bindings.map(describeBinding);
    if (JSON.stringify(entry.expected.bindings) !== JSON.stringify(resolved.bindings)) {
      if (expectedBindings.join("\n") !== actualBindings.join("\n")) {
        mismatches.push(`${entry.name}: bindings expected [${expectedBindings.join(", ")}] but replay gave [${actualBindings.join(", ")}]`);
      } else {
        mismatches.push(`${entry.name}: binding details differ from the capture`);
      }
    }
    const expectedLimitations = new Set(entry.expected.limitations);
    const actualLimitations = new Set(resolved.limitations);
    const before = mismatches.length;
    for (const limitation of entry.expected.limitations) {
      if (!actualLimitations.has(limitation)) mismatches.push(`${entry.name}: limitation no longer reported: ${limitation}`);
    }
    for (const limitation of resolved.limitations) {
      if (!expectedLimitations.has(limitation)) mismatches.push(`${entry.name}: new limitation: ${limitation}`);
    }
    if (mismatches.length === before && JSON.stringify(entry.expected.limitations) !== JSON.stringify(resolved.limitations)) {
      mismatches.push(`${entry.name}: limitations are in a different order from the capture`);
    }
  }
  return mismatches;
}

/** Writes a dump as pretty JSON into `dir` (created if missing) and returns the file path. */
export function writeMaterialMetadataDump(dir: string, fileName: string, dump: MaterialMetadataDump): string {
  if (fileName !== basename(fileName) || !fileName.endsWith(".json")) {
    throw new Error(`Metadata dump file name must be a bare *.json name: "${fileName}".`);
  }
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, `${JSON.stringify(dump, null, 2)}\n`);
  return path;
}

/** Reads every `*.json` dump in `dir`, sorted by file name. Throws on a dump of another version. */
export function readMaterialMetadataDumps(dir: string): Array<{ fileName: string; dump: MaterialMetadataDump }> {
  return readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => {
      const dump = JSON.parse(readFileSync(join(dir, fileName), "utf8")) as MaterialMetadataDump;
      if (dump.version !== MATERIAL_METADATA_VERSION) {
        throw new Error(`${fileName}: unsupported metadata dump version ${String(dump.version)}.`);
      }
      return { fileName, dump };
    });
}
