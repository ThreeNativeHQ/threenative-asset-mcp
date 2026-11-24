/**
 * The marker a projected GLB carries: glTF `extras.threenative.textureProjection = { atlas, runId,
 * paintedMask }` on the painted atlas' texture and image (C.3). The engine cook reads it to keep the
 * authored atlas size and encode UASTC instead of the default 2048 cap; it is written here, on the bytes,
 * because three's exporter writes `extras` for nodes and materials but not for textures/images.
 * `paintedMask` (phase 2t) is the file name, relative to the GLB, of the painted-coverage mask written
 * beside it: an 8-bit grayscale PNG, one texel per 4 x 4 atlas texels, 255 where an accepted view
 * painted and 0 where the fill made the colour up. The atlas image itself stays opaque RGB with the
 * fill's own colour, so it keeps its UASTC cook. Absent for an older GLB.
 */
export interface ProjectedAtlasMarker {
  readonly atlas: number;
  readonly runId: string;
  readonly paintedMask?: string;
}

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

interface GlbChunks {
  readonly json: Record<string, unknown>;
  readonly binary: Uint8Array | undefined;
}

function readChunks(glb: Uint8Array): GlbChunks {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (glb.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) {
    throw new Error("not a glTF 2.0 binary");
  }
  const length = view.getUint32(8, true);
  if (length > glb.byteLength) throw new Error("truncated glTF binary");
  let json: Record<string, unknown> | undefined;
  let binary: Uint8Array | undefined;
  let offset = 12;
  while (offset + 8 <= length) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + chunkLength > length) throw new Error("truncated glTF chunk");
    if (chunkType === JSON_CHUNK) {
      json = JSON.parse(new TextDecoder().decode(glb.subarray(start, start + chunkLength))) as Record<string, unknown>;
    } else if (chunkType === BIN_CHUNK) {
      binary = glb.subarray(start, start + chunkLength);
    }
    offset = start + chunkLength; // chunk lengths are already padded to 4 bytes
  }
  if (!json) throw new Error("glTF binary has no JSON chunk");
  return { json, binary };
}

interface JsonArray {
  readonly textures?: { source?: number; extras?: Record<string, unknown> }[];
  readonly images?: { extras?: Record<string, unknown> }[];
  readonly materials?: {
    pbrMetallicRoughness?: { baseColorTexture?: { index?: number } };
    extensions?: Record<string, unknown>;
  }[];
}

/** The image behind the first material's base colour texture; undefined when no material has one. */
function baseColorImageIndex(json: JsonArray): number | undefined {
  for (const material of json.materials ?? []) {
    const textureIndex = material.pbrMetallicRoughness?.baseColorTexture?.index;
    if (textureIndex === undefined) continue;
    const source = json.textures?.[textureIndex]?.source;
    if (source !== undefined) return source;
  }
  return undefined;
}

function writeChunks(json: Record<string, unknown>, binary: Uint8Array | undefined): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(encoded.length / 4) * 4;
  const binaryLength = binary === undefined ? 0 : Math.ceil(binary.byteLength / 4) * 4;
  const total = 12 + 8 + jsonLength + (binary === undefined ? 0 : 8 + binaryLength);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, JSON_CHUNK, true);
  out.set(encoded, 20);
  out.fill(0x20, 20 + encoded.length, 20 + jsonLength); // JSON chunk pads with spaces
  if (binary !== undefined) {
    const start = 20 + jsonLength;
    view.setUint32(start, binaryLength, true);
    view.setUint32(start + 4, BIN_CHUNK, true);
    out.set(binary, start + 8);
  }
  return out;
}

const MARKER_KEY = "threenative";

export function markProjectedAtlas(glb: Uint8Array, marker: ProjectedAtlasMarker): Uint8Array {
  const { json, binary } = readChunks(glb);
  const document = json as JsonArray;
  const imageIndex = baseColorImageIndex(document);
  const projection = {
    atlas: marker.atlas,
    runId: marker.runId,
    ...(marker.paintedMask === undefined ? {} : { paintedMask: marker.paintedMask }),
  };
  const merge = (target: { extras?: Record<string, unknown> }): void => {
    target.extras = { ...(target.extras ?? {}), [MARKER_KEY]: { textureProjection: projection } };
  };
  if (imageIndex !== undefined) merge(document.images![imageIndex]!);
  for (const texture of document.textures ?? []) {
    if (texture.source === imageIndex) merge(texture);
  }
  return writeChunks(json, binary);
}

/** The marker a projected GLB carries, if any (`texture_project_inspect` resolves its run from it). */
export function readProjectedAtlasMarker(glb: Uint8Array): ProjectedAtlasMarker | undefined {
  const { json } = readChunks(glb);
  const document = json as JsonArray & { textures?: { extras?: { threenative?: { textureProjection?: unknown } } }[] };
  const candidate =
    document.images?.find((image) => image.extras?.[MARKER_KEY] !== undefined)?.extras?.[MARKER_KEY] ??
    document.textures?.find((texture) => texture.extras?.[MARKER_KEY] !== undefined)?.extras?.[MARKER_KEY];
  const marker = (candidate as { textureProjection?: { atlas?: unknown; runId?: unknown; paintedMask?: unknown } } |
    undefined)?.textureProjection;
  if (!marker || typeof marker.atlas !== "number" || typeof marker.runId !== "string") return undefined;
  // An older GLB (phase 2s) carried `paintedAlpha` instead, which is not a mask file: read as absent.
  return {
    atlas: marker.atlas,
    runId: marker.runId,
    ...(typeof marker.paintedMask === "string" ? { paintedMask: marker.paintedMask } : {}),
  };
}
