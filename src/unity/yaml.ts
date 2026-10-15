/**
 * Unity YAML: multi-document text with `--- !u!<classId> &<fileID> [stripped]` headers. The headers
 * are split here (the `!u!` tag is not valid YAML 1.2 for a generic parser to resolve), each body is
 * parsed with the `yaml` package, and unknown class ids stay raw objects.
 */
import { parse } from "yaml";

import type { UnityAssetDatabase, UnityAssetEntry } from "./package.js";

export const BUILTIN_EXTRA_RESOURCES_GUID = "0000000000000000f000000000000000";
export const BUILTIN_DEFAULT_RESOURCES_GUID = "0000000000000000e000000000000000";
/** `fileID` of the Standard shader inside the built-in extra resources. */
const STANDARD_SHADER_FILE_ID = "46";

export class UnityYamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnityYamlError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface UnityDocument {
  readonly classId: number;
  /** Decimal string: fileIDs are 64-bit and do not fit a JS number. */
  readonly fileId: string;
  readonly stripped: boolean;
  /** The single top-level key, such as `Material` or `GameObject`. */
  readonly typeName: string;
  readonly fields: Record<string, unknown>;
}

const HEADER = /^--- !u!(\d+) &(-?\d+)( stripped)?[ \t]*$/gm;
// A guid made only of digits, or with one `e` between digits, would otherwise resolve as a number.
const GUID_VALUE = /(\bguid: )([0-9a-fA-F]{32})(?=[\s,}]|$)/g;

function plain(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]));
  }
  return value;
}

/** Parses one YAML body (a `.meta` file, or the text under one document header). */
export function parseYamlBody(text: string): unknown {
  try {
    return plain(parse(text.replace(GUID_VALUE, '$1"$2"'), { intAsBigInt: true, uniqueKeys: false }));
  } catch (error) {
    throw new UnityYamlError(error instanceof Error ? error.message.split("\n")[0] ?? "parse error" : "parse error");
  }
}

/** Parses a `.meta` file into its fields (`guid`, `fileFormatVersion`, importer settings). */
export function parseMeta(text: string): Record<string, unknown> {
  const value = parseYamlBody(text);
  return isRecord(value) ? value : {};
}

/** Splits and parses every document of a Unity YAML asset. Text before the first header is the preamble. */
export function parseUnityDocuments(text: string): UnityDocument[] {
  if (!/^%YAML/.test(text) && !/^--- !u!/m.test(text)) {
    throw new UnityYamlError("Not Unity text YAML (no %YAML directive or document header; binary serialization?).");
  }
  const headers = [...text.matchAll(HEADER)];
  return headers.map((header, index) => {
    const classId = Number(header[1]);
    const fileId = header[2] ?? "0";
    const start = (header.index ?? 0) + header[0].length;
    const end = headers[index + 1]?.index ?? text.length;
    let value: unknown;
    try {
      value = parseYamlBody(text.slice(start, end));
    } catch (error) {
      throw new UnityYamlError(`Document !u!${classId} &${fileId}: ${(error as Error).message}`);
    }
    const object = isRecord(value) ? value : {};
    const [name, ...more] = Object.keys(object);
    const inner = name === undefined ? undefined : object[name];
    const wrapped = name !== undefined && more.length === 0 && (inner === null || isRecord(inner));
    return {
      classId,
      fileId,
      stripped: header[3] !== undefined,
      typeName: wrapped ? name : "",
      fields: wrapped ? (inner ?? {}) as Record<string, unknown> : object,
    };
  });
}

export interface UnityRef {
  readonly fileID: string;
  readonly guid?: string;
  readonly type?: number;
}

/** Reads a `{fileID, guid, type}` mapping, or returns undefined when `value` is not one. */
export function asUnityRef(value: unknown): UnityRef | undefined {
  if (!isRecord(value)) return undefined;
  const { fileID, guid, type } = value;
  if (typeof fileID !== "number" && typeof fileID !== "string") return undefined;
  return {
    fileID: String(fileID),
    ...(typeof guid === "string" ? { guid: guid.toLowerCase() } : {}),
    ...(typeof type === "number" ? { type } : {}),
  };
}

export type ResolvedRef =
  | { readonly kind: "null" }
  | { readonly kind: "builtin"; readonly guid: string; readonly fileId: string; readonly source: "extra-resources" | "default-resources"; readonly name?: "Standard" }
  | { readonly kind: "local"; readonly fileId: string; readonly object?: UnityDocument }
  | { readonly kind: "asset"; readonly guid: string; readonly fileId: string; readonly path: string; readonly entry: UnityAssetEntry; readonly object?: UnityDocument }
  | { readonly kind: "missing"; readonly guid: string; readonly fileId: string };

export interface ResolveContext {
  readonly database: Pick<UnityAssetDatabase, "entries">;
  /** Documents of the file that holds the reference, for a ref without a guid. */
  readonly documents?: readonly UnityDocument[];
  /** Loads the documents of a target asset so the ref's object can be returned (YAML assets only). */
  readonly documentsOf?: (entry: UnityAssetEntry) => readonly UnityDocument[] | undefined;
}

/**
 * Resolves a reference to its target. A built-in guid points outside the package and is marked, not
 * looked up. `fileID: 0` with no guid is a null reference. A missing guid is reported, never thrown.
 */
export function resolveRef(ref: UnityRef, context: ResolveContext): ResolvedRef {
  const fileId = ref.fileID;
  if (ref.guid === BUILTIN_EXTRA_RESOURCES_GUID || ref.guid === BUILTIN_DEFAULT_RESOURCES_GUID) {
    const extra = ref.guid === BUILTIN_EXTRA_RESOURCES_GUID;
    return {
      kind: "builtin",
      guid: ref.guid,
      fileId,
      source: extra ? "extra-resources" : "default-resources",
      ...(extra && fileId === STANDARD_SHADER_FILE_ID ? { name: "Standard" as const } : {}),
    };
  }
  if (ref.guid === undefined || /^0+$/.test(ref.guid)) {
    if (fileId === "0") return { kind: "null" };
    const object = context.documents?.find((document) => document.fileId === fileId);
    return { kind: "local", fileId, ...(object ? { object } : {}) };
  }
  const entry = context.database.entries.get(ref.guid);
  if (!entry) return { kind: "missing", guid: ref.guid, fileId };
  const object = context.documentsOf?.(entry)?.find((document) => document.fileId === fileId);
  return { kind: "asset", guid: ref.guid, fileId, path: entry.path, entry, ...(object ? { object } : {}) };
}
