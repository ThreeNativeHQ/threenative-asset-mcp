/**
 * Browser loader for raw RGBA16F data textures written by the Unreal importer.
 *
 *   import { loadRgba16fDataTexture } from "threenative-asset-mcp/data-texture";
 *   const { texture, manifest } = await loadRgba16fDataTexture(new URL("data-textures/a/t_x.rgba16f.json", base), {
 *     expectedSourceSha256: report.dataTextures[0].sourceSha256,
 *   });
 *
 * The texture is a `THREE.DataTexture` in `RGBAFormat` with `HalfFloatType`: the GPU samples the stored binary16 values
 * directly. Nothing is clamped, converted or dropped: negative, HDR, subnormal and alpha bits reach the shader as stored.
 * The loader is refused, not skipped, when a check cannot run: no `expectedSourceSha256`, no `crypto.subtle`
 * (a page served over plain http from a non-local host), or a manifest that does not match its binary.
 *
 * The browser cannot fetch or re-hash the source package, so source identity is checked against the caller's
 * `expectedSourceSha256` (from the import report), not against the pack itself.
 */
import * as THREE from "three";

import {
  DataTextureError,
  decodeRgba16fLittleEndian,
  parseDataTextureManifest,
  verifyRgba16fData,
  type DataTextureManifest,
  type Sha256Hex,
} from "./unreal/data-texture.js";

export type { DataTextureManifest } from "./unreal/data-texture.js";
export { DataTextureError } from "./unreal/data-texture.js";

export interface LoadedRgba16fDataTexture {
  readonly texture: THREE.DataTexture;
  readonly manifest: DataTextureManifest;
}

export interface Rgba16fLoadOptions {
  /** The `sourceSha256` the import report gives for this texture. Required: a source that is not checked is not loaded. */
  readonly expectedSourceSha256: string;
  /** Replaces `fetch`, for tests and for hosts that serve the artifacts from memory. */
  readonly fetch?: (input: string) => Promise<Response>;
  /** Replaces the SHA-256 implementation. The default is `crypto.subtle`, and its absence is an error. */
  readonly sha256?: Sha256Hex;
}

/** Fetches `<name>.rgba16f.json` and the binary it names beside it, then builds the texture. */
export async function loadRgba16fDataTexture(manifestUrl: string | URL, options: Rgba16fLoadOptions): Promise<LoadedRgba16fDataTexture> {
  const fetchResource = options.fetch ?? ((input: string) => fetch(input));
  const manifestHref = new URL(manifestUrl.toString()).href;
  const manifestResponse = await fetchResource(manifestHref);
  if (!manifestResponse.ok) throw new DataTextureError(`the manifest at ${manifestHref} returned HTTP ${manifestResponse.status}`);
  const manifest = parseDataTextureManifest(await manifestResponse.json());
  const dataHref = new URL(manifest.data.file, manifestHref).href;
  const dataResponse = await fetchResource(dataHref);
  if (!dataResponse.ok) throw new DataTextureError(`the data file at ${dataHref} returned HTTP ${dataResponse.status}`);
  const bytes = new Uint8Array(await dataResponse.arrayBuffer());
  return createRgba16fDataTexture({ manifest, bytes }, options);
}

/**
 * Builds the texture from a manifest and its binary. The checks run first and in this order: manifest shape, source
 * identity, exact length, SHA-256, finite samples. Only then are the little-endian samples handed to the texture.
 */
export async function createRgba16fDataTexture(
  input: { readonly manifest: unknown; readonly bytes: Uint8Array },
  options: Rgba16fLoadOptions,
): Promise<LoadedRgba16fDataTexture> {
  const expected = options.expectedSourceSha256;
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new DataTextureError("expectedSourceSha256 is required: pass the sourceSha256 from the import report, because the browser cannot check the source package");
  }
  const manifest = parseDataTextureManifest(input.manifest);
  if (manifest.source.sha256 !== expected) {
    throw new DataTextureError("the manifest names a different source package than expectedSourceSha256; the texture was not loaded");
  }
  await verifyRgba16fData(manifest, input.bytes, options.sha256 ?? subtleSha256);
  const samples = decodeRgba16fLittleEndian(input.bytes);

  const texture = new THREE.DataTexture(samples, manifest.data.width, manifest.data.height, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.flipY = false;
  texture.needsUpdate = true;
  return { texture, manifest };
}

async function subtleSha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new DataTextureError(
      "SHA-256 needs crypto.subtle, which this page does not have: serve it over https or from localhost. The texture was not loaded.",
    );
  }
  const digest = await subtle.digest("SHA-256", bytes.slice());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
