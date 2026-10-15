import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { type FabCli, FabCliError, type FabUnityFormat } from "../fab/fabcli.js";
import type { LicenseDecision } from "../fab/license.js";
import { type importUnityPackage } from "../unity/importer.js";
import { summarizeUnity } from "./import-unity.js";

/** The Unity artifact id `fab_list_owned` reports when FabCLI lists none (`versions: null`). */
export const UNITY_ARTIFACT_FALLBACK_ID = "unity";

export function unityArtifactId(unity: FabUnityFormat): string {
  return unity.artifactId ?? UNITY_ARTIFACT_FALLBACK_ID;
}

/**
 * FabCLI reports no Epic catalog coordinates for a listing's Unity artifact (`versions: null`), and
 * `fabcli download <listing>` resolves the Unreal pack from the library. So there is nothing the
 * Unity route may download until FabCLI names the artifact. This is the error for that state; it
 * never guesses an endpoint and never signs in.
 */
function unityDownloadUnavailable(listingId: string): FabCliError {
  return new FabCliError(
    "FABCLI_UNITY_DOWNLOAD_UNAVAILABLE",
    `Listing ${listingId} publishes a Unity artifact, but FabCLI does not report its Epic catalog coordinates, and \`fabcli download ${listingId}\` would fetch the Unreal pack instead, so nothing was downloaded. Two ways forward: (1) download the .unitypackage from fab.com in your own browser, then run asset_import_unity with that file as source; or (2) sign in to a Fab web session yourself with \`fabcli auth login\` (this server never signs in) and retry, in case FabCLI then lists the Unity artifact.`,
  );
}

async function findUnityPackages(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await findUnityPackages(path)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".unitypackage")) found.push(path);
  }
  return found.sort();
}

export interface FabUnityImportRequest {
  readonly fabCli: FabCli;
  readonly listingId: string;
  readonly unity: FabUnityFormat;
  readonly requestedArtifactId: string | undefined;
  readonly platform: string | undefined;
  readonly outputDir: string;
  readonly assets: readonly string[] | undefined;
  readonly maxTextureSize: number | undefined;
  readonly downloadRoot: string;
  readonly license: LicenseDecision;
  readonly runImport: typeof importUnityPackage;
  readonly environment: NodeJS.ProcessEnv;
  readonly log: (message: string) => void;
}

/**
 * The Unity side of `fab_import_asset`: download the listing's Unity artifact into the same
 * `fab-downloads/<listing>/<artifact>` cache the Unreal route uses, then hand the `.unitypackage`
 * to the PRD-616 importer. The Fab licence gate has already run; no Unity Asset Store terms apply.
 */
export async function importFabUnity(request: FabUnityImportRequest) {
  const { fabCli, listingId, unity, log } = request;
  const artifactId = unityArtifactId(unity);
  if (request.requestedArtifactId !== undefined && request.requestedArtifactId !== artifactId) {
    throw new FabCliError(
      "FABCLI_ENGINE_AMBIGUOUS",
      `No Unity artifact "${request.requestedArtifactId}". Available: ${artifactId}.`,
    );
  }
  // Exactly one artifact is named, always by all three catalog ids: the listing-only form of
  // `fabcli download` resolves the Unreal pack, which would be the wrong bytes.
  const entry = (await fabCli.ownedListings()).find(
    (owned) => owned.listingId?.toLowerCase() === listingId.toLowerCase(),
  );
  if (unity.artifactId === undefined || entry?.assetId === undefined || entry.assetNamespace === undefined) {
    throw unityDownloadUnavailable(listingId);
  }

  const stagingDir = join(request.downloadRoot, listingId, artifactId);
  await mkdir(stagingDir, { recursive: true });
  const cached = await readFile(join(stagingDir, ".fabcli-asset.json"), "utf8").catch(() => undefined);
  if (cached === undefined || (await readdir(stagingDir)).length <= 1) {
    log(`Downloading Unity artifact ${artifactId} from the Fab library…`);
    await fabCli.download({
      listingId,
      outputDir: stagingDir,
      engine: undefined,
      platform: request.platform,
      artifactId,
      assetId: entry.assetId,
      assetNamespace: entry.assetNamespace,
    });
  } else {
    log(`Reusing the already-downloaded Unity artifact ${artifactId}.`);
  }

  const packages = await findUnityPackages(stagingDir);
  const [source] = packages;
  if (source === undefined || packages.length > 1) {
    throw new FabCliError(
      "FABCLI_DOWNLOAD_FAILED",
      source === undefined
        ? `The Unity artifact ${artifactId} downloaded, but it holds no .unitypackage file.`
        : `The Unity artifact ${artifactId} holds ${packages.length} .unitypackage files (${packages.map((p) => p.slice(stagingDir.length + 1)).join(", ")}). Run asset_import_unity on the one you want.`,
    );
  }

  const outputDir = resolve(request.outputDir);
  const report = await request.runImport({
    source,
    outputDir,
    ...(request.assets ? { assets: request.assets } : {}),
    ...(request.maxTextureSize !== undefined ? { maxTextureSize: request.maxTextureSize } : {}),
    environment: request.environment,
    log,
  });
  const output = summarizeUnity(report, outputDir);
  return {
    ...output,
    warnings: [`Fab listing ${listingId} (Unity artifact ${artifactId}). Licence check: ${request.license.reason}`.slice(0, 480), ...output.warnings].slice(0, 400),
  };
}
