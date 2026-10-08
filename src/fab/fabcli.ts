import { z } from "zod";

import { ROUTE_PREFERENCE, compareEngines, decoderRoute, oldestEngine } from "./routes.js";
import { ensureFabcli } from "../unreal/provision.js";
import { type ExternalTool, ToolchainError, runBounded } from "../unreal/toolchain.js";

/**
 * The only FabCLI subcommands this server is allowed to run. `claim`, `claim-batch`, `auth login`,
 * `auth logout`, `update` and anything else that spends money, alters the account, or replaces the
 * binary are absent by construction rather than by a check that could be bypassed.
 */
const ALLOWED_SUBCOMMANDS = Object.freeze([
  "--version",
  "auth status",
  "formats",
  "library",
  "download",
]);

export type FabCliErrorCode =
  | "FABCLI_UNAVAILABLE"
  | "FABCLI_INCOMPATIBLE"
  | "FABCLI_UNAUTHENTICATED"
  | "FABCLI_KEYSTORE_UNREACHABLE"
  | "FABCLI_SESSION_EXPIRED"
  | "FABCLI_NOT_OWNED"
  | "FABCLI_ENGINE_AMBIGUOUS"
  | "FABCLI_LICENSE_NOT_PERMITTED"
  | "FABCLI_LICENSE_UNVERIFIED"
  | "FABCLI_NO_UNREAL_FORMAT"
  | "FABCLI_DOWNLOAD_FAILED";

export class FabCliError extends Error {
  constructor(
    readonly code: FabCliErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "FabCliError";
  }
}

/** FabCLI keeps its session in the OS keystore, which on Linux is the Secret Service over DBus. An
 * MCP host started without a session bus cannot give it one, so re-authenticating cannot help: every
 * subcommand that reports this needs the same answer. */
function keystoreUnreachable(detail: string): FabCliError {
  return new FabCliError(
    "FABCLI_KEYSTORE_UNREACHABLE",
    `FabCLI could not read its session from the OS keystore (${detail}). The MCP host started this server without a session bus, so DBUS_SESSION_BUS_ADDRESS is missing or wrong for FabCLI; logging in again will not help. Restart the MCP host from a desktop session, or export DBUS_SESSION_BUS_ADDRESS yourself.`,
  );
}

const AuthStatusSchema = z.object({
  authenticated: z.boolean(),
  expires_at: z.string().optional(),
});

const VersionSchema = z.object({
  artifactId: z.string(),
  engineVersions: z.array(z.string()).default([]),
  targetPlatforms: z.array(z.string()).default([]),
  fileType: z.string().optional(),
});

const LibraryEntrySchema = z.object({
  // Epic catalog coordinates. Older payloads may omit them, and `download` then falls back to the
  // engine filter.
  assetId: z.string().optional(),
  assetNamespace: z.string().optional(),
  title: z.string().default(""),
  description: z.string().default(""),
  url: z.string().default(""),
  distributionMethod: z.string().default(""),
  customAttributes: z
    .array(z.object({ ListingIdentifier: z.string().optional() }).loose())
    .default([]),
  projectVersions: z.array(VersionSchema.loose()).default([]),
  categories: z.array(z.object({ name: z.string().optional() }).loose()).default([]),
});

const LibrarySchema = z.object({
  results: z.array(LibraryEntrySchema.loose()).default([]),
});

const FormatSchema = z.object({
  assetFormatType: z.object({ code: z.string() }).loose(),
  // `.default([])` fires on `undefined` and not on `null`, and fabcli returns `versions: null`
  // on a Unity entry. One unrelated null poisoned the whole parse, so every listing published
  // for both Unreal and Unity failed with FABCLI_INCOMPATIBLE — a message blaming the CLI
  // version — and the well-formed `unreal-engine` entry beside it was never reached.
  versions: z
    .array(VersionSchema)
    .nullish()
    .transform((versions) => versions ?? []),
});

export interface FabAuthStatus {
  readonly authenticated: boolean;
  /** ISO 8601, or undefined when FabCLI did not report one. Never a token. */
  readonly expiresAt: string | undefined;
}

export interface FabOwnedListing {
  readonly listingId: string | undefined;
  /** Epic catalog asset id; with `assetNamespace` and an artifact id it names one artifact exactly. */
  readonly assetId?: string | undefined;
  readonly assetNamespace?: string | undefined;
  readonly title: string;
  readonly url: string;
  readonly categories: readonly string[];
  readonly distributionMethod: string;
  readonly unrealArtifacts: readonly FabUnrealVersion[];
}

export interface FabUnrealVersion {
  readonly artifactId: string;
  readonly engineVersions: readonly string[];
  readonly targetPlatforms: readonly string[];
}

export interface FabDownloadRequest {
  readonly listingId: string;
  readonly outputDir: string;
  readonly engine: string | undefined;
  readonly platform?: string | undefined;
  readonly timeoutMs?: number;
  /**
   * When all three are present the download names one artifact exactly (`--artifact-id
   * --namespace --asset-id`) and `engine` is not sent: FabCLI's engine filter cannot tell apart
   * artifacts whose engine lists overlap.
   */
  readonly artifactId?: string | undefined;
  readonly assetId?: string | undefined;
  readonly assetNamespace?: string | undefined;
}

/** Listing UIDs are the only free-form value that ever reaches an argv slot. */
const LISTING_UID = /^[0-9a-fA-F-]{8,64}$/;
const ENGINE_VERSION = /^UE_\d+\.\d+$/;
const PLATFORM_NAME = /^[A-Za-z0-9_]{1,32}$/;
/** Epic catalog ids (artifact, namespace, asset) are short opaque tokens. */
const CATALOG_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export function assertCatalogId(value: string, label: string): string {
  if (!CATALOG_ID.test(value)) {
    throw new FabCliError("FABCLI_DOWNLOAD_FAILED", `"${value}" is not a valid Fab ${label}.`);
  }
  return value;
}

/** Preference order when a listing's artifact is published for several platforms. An asset pack's
 * source .uasset files are the same whichever one is chosen; the first that exists wins. */
export const PLATFORM_PREFERENCE = Object.freeze([
  "Windows",
  "Win64",
  "Linux",
  "Mac",
  "Android",
  "IOS",
]);

export function preferredPlatform(available: readonly string[]): string | undefined {
  for (const candidate of PLATFORM_PREFERENCE) {
    const match = available.find((entry) => entry.toLowerCase() === candidate.toLowerCase());
    if (match) return match;
  }
  return available[0];
}

export function assertPlatform(value: string): string {
  if (!PLATFORM_NAME.test(value)) {
    throw new FabCliError("FABCLI_ENGINE_AMBIGUOUS", `"${value}" is not a platform name.`);
  }
  return value;
}

export function assertListingId(value: string): string {
  if (!LISTING_UID.test(value)) {
    throw new FabCliError(
      "FABCLI_DOWNLOAD_FAILED",
      "A Fab listing id must be the listing UID from the listing URL.",
    );
  }
  return value;
}

export function assertEngineVersion(value: string): string {
  if (!ENGINE_VERSION.test(value)) {
    throw new FabCliError(
      "FABCLI_ENGINE_AMBIGUOUS",
      `"${value}" is not an Unreal engine selector; use the UE_<major>.<minor> form, for example UE_4.21.`,
    );
  }
  return value;
}

export interface FabCliOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
  /** Injected in tests; production always resolves a real executable. */
  readonly tool?: ExternalTool;
}

export class FabCli {
  #tool: ExternalTool | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #log: (message: string) => void;

  constructor(options: FabCliOptions = {}) {
    this.#tool = options.tool;
    this.#environment = options.environment ?? process.env;
    this.#log = options.log ?? (() => {});
  }

  static get allowedSubcommands(): readonly string[] {
    return ALLOWED_SUBCOMMANDS;
  }

  async tool(): Promise<ExternalTool> {
    if (this.#tool) return this.#tool;
    try {
      this.#tool = await ensureFabcli(this.#environment, this.#log);
    } catch (error) {
      throw new FabCliError(
        "FABCLI_UNAVAILABLE",
        error instanceof ToolchainError
          ? error.message
          : "FabCLI could not be resolved or installed.",
      );
    }
    const major = /(\d+)\.(\d+)\.(\d+)/.exec(this.#tool.version);
    if (major && Number(major[1]) !== 0) {
      throw new FabCliError(
        "FABCLI_INCOMPATIBLE",
        `This server drives FabCLI 0.x; the resolved binary reports "${this.#tool.version}". Pin a 0.x FabCLI with THREENATIVE_FABCLI_PATH.`,
      );
    }
    return this.#tool;
  }

  async #json(args: readonly string[], timeoutMs: number): Promise<unknown> {
    const tool = await this.tool();
    const run = await runBounded(tool.path, args, { timeoutMs });
    // FabCLI writes its results to stdout and some structured failures to stderr, so a diagnosis
    // that reads only stdout turns every real error into "produced no output". The stdout payload
    // is never truncated — `library` alone is tens of kilobytes, and clipping it to a diagnostic
    // length turns a valid answer into "did not return JSON".
    const payload = run.stdout.trim();
    const text = payload || run.stderr.trim().slice(0, 4_096);
    if (!text) {
      throw new FabCliError(
        "FABCLI_DOWNLOAD_FAILED",
        `fabcli ${args.join(" ")} produced no output (exit ${run.code}).`,
        run.code !== 0,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new FabCliError(
        "FABCLI_INCOMPATIBLE",
        `fabcli ${args[0]} did not return JSON; this server expects FabCLI 0.1.x output.`,
      );
    }
    const failure = (parsed as { error?: { kind?: string; message?: string } })?.error;
    if (failure) {
      const kind = failure.kind ?? "unknown";
      const detail = failure.message ?? "no detail";
      if (/keystore|secure storage|DBus/i.test(detail)) throw keystoreUnreachable(detail);
      throw new FabCliError(
        kind === "auth_required" ? "FABCLI_UNAUTHENTICATED" : "FABCLI_DOWNLOAD_FAILED",
        `fabcli reported ${kind}: ${detail}`,
      );
    }
    return parsed;
  }

  /**
   * FabCLI reports two independent things under `auth status`: an Epic OAuth session, and a Fab
   * *web* session used only by `claim` and `ownership`. The download path this server uses needs
   * the first and not the second, so `fab.session_present: false` is not an authentication
   * failure here and must not be reported as one.
   */
  async authStatus(): Promise<FabAuthStatus> {
    const parsed = AuthStatusSchema.loose().safeParse(
      await this.#json(["auth", "status"], 120_000),
    );
    if (!parsed.success) {
      throw new FabCliError(
        "FABCLI_INCOMPATIBLE",
        "fabcli auth status did not match the expected 0.1.x shape.",
      );
    }
    return {
      authenticated: parsed.data.authenticated,
      expiresAt: parsed.data.expires_at,
    };
  }

  /** Throws a caller-actionable error and performs no download when the session cannot be used. */
  async requireAuthenticatedSession(now: Date = new Date()): Promise<FabAuthStatus> {
    const status = await this.authStatus();
    if (!status.authenticated) {
      throw new FabCliError(
        "FABCLI_UNAUTHENTICATED",
        "No FabCLI session. Run `fabcli auth login` in your own terminal, then retry. This server never logs in for you.",
      );
    }
    if (status.expiresAt) {
      const expiry = Date.parse(status.expiresAt);
      if (Number.isFinite(expiry) && expiry <= now.getTime()) {
        throw new FabCliError(
          "FABCLI_SESSION_EXPIRED",
          `The FabCLI session expired at ${status.expiresAt}. Run \`fabcli auth login\` and retry.`,
        );
      }
    }
    return status;
  }

  /**
   * Everything the signed-in account owns. Read-only: this is the "what do I already have"
   * question, and answering it never touches an acquisition endpoint.
   */
  async ownedListings(): Promise<readonly FabOwnedListing[]> {
    const parsed = LibrarySchema.loose().safeParse(await this.#json(["library"], 300_000));
    if (!parsed.success) {
      throw new FabCliError(
        "FABCLI_INCOMPATIBLE",
        "fabcli library did not match the expected 0.1.x shape.",
      );
    }
    return parsed.data.results.map((entry) => ({
      listingId: entry.customAttributes.find((attribute) => attribute.ListingIdentifier)
        ?.ListingIdentifier,
      assetId: entry.assetId,
      assetNamespace: entry.assetNamespace,
      title: entry.title || entry.description,
      url: entry.url,
      categories: entry.categories.flatMap((category) =>
        category.name === undefined ? [] : [category.name],
      ),
      distributionMethod: entry.distributionMethod,
      unrealArtifacts: entry.projectVersions.map((version) => ({
        artifactId: version.artifactId,
        engineVersions: version.engineVersions,
        targetPlatforms: version.targetPlatforms,
      })),
    }));
  }

  /** The Unreal artifact versions this account can download for a listing. */
  async unrealVersions(listingId: string): Promise<readonly FabUnrealVersion[]> {
    const parsed = z
      .array(FormatSchema.loose())
      .safeParse(await this.#json(["formats", assertListingId(listingId)], 180_000));
    if (!parsed.success) {
      throw new FabCliError(
        "FABCLI_INCOMPATIBLE",
        "fabcli formats did not match the expected 0.1.x shape.",
      );
    }
    const unreal = parsed.data.find(
      (format) => format.assetFormatType.code === "unreal-engine",
    );
    if (!unreal || unreal.versions.length === 0) {
      throw new FabCliError(
        "FABCLI_NO_UNREAL_FORMAT",
        `Listing ${listingId} publishes no Unreal Engine artifact, so there is nothing for the Unreal importer to convert.`,
      );
    }
    return unreal.versions.map((version) => ({
      artifactId: version.artifactId,
      engineVersions: version.engineVersions,
      targetPlatforms: version.targetPlatforms,
    }));
  }

  /**
   * Picks the artifact for an artifact id or engine selector; either one wins outright. With
   * neither and more than one artifact, the best decoder route wins (`ROUTE_PREFERENCE`), the
   * artifact with the newest source format breaks a tie, and `reason` says what was chosen over
   * what so the caller can override it. Artifacts that list no engine are never auto-picked.
   */
  static selectVersion(
    versions: readonly FabUnrealVersion[],
    engine: string | undefined,
    artifactId?: string,
  ): { readonly version: FabUnrealVersion; readonly reason?: string } {
    // An artifact id names exactly one artifact, so it settles the choice even when several
    // artifacts list overlapping engines and an engine selector could not tell them apart.
    if (artifactId) {
      const exact = versions.find((version) => version.artifactId === artifactId);
      if (!exact) {
        throw new FabCliError(
          "FABCLI_ENGINE_AMBIGUOUS",
          `No artifact "${artifactId}". Available: ${versions
            .map((version) => `${version.artifactId} (${version.engineVersions.join(", ")})`)
            .join("; ")}.`,
        );
      }
      return { version: exact };
    }
    if (engine) {
      const wanted = assertEngineVersion(engine);
      const match = versions.find((version) => version.engineVersions.includes(wanted));
      if (!match) {
        throw new FabCliError(
          "FABCLI_ENGINE_AMBIGUOUS",
          `No artifact for ${wanted}. Available: ${versions
            .map((version) => `${version.artifactId} (${version.engineVersions.join(", ")})`)
            .join("; ")}.`,
        );
      }
      return { version: match };
    }
    const only = versions[0];
    if (versions.length === 1 && only) return { version: only };
    const chosen = FabCli.#chooseByRoute(versions);
    if (chosen) return chosen;
    throw new FabCliError(
      "FABCLI_ENGINE_AMBIGUOUS",
      `This listing publishes ${versions.length} Unreal artifacts. Pass engine to choose one (or artifactId, which also separates artifacts whose engines overlap): ${versions
        .map((version) => `${version.artifactId} (${version.engineVersions.join(", ")})`)
        .join("; ")}.`,
    );
  }

  static #chooseByRoute(
    versions: readonly FabUnrealVersion[],
  ): { readonly version: FabUnrealVersion; readonly reason: string } | undefined {
    const ranked = versions.flatMap((version) => {
      const engine = oldestEngine(version.engineVersions);
      return engine === undefined ? [] : [{ version, engine, route: decoderRoute(engine) }];
    });
    ranked.sort(
      (a, b) =>
        ROUTE_PREFERENCE.indexOf(a.route) - ROUTE_PREFERENCE.indexOf(b.route) ||
        compareEngines(b.engine, a.engine),
    );
    const best = ranked[0];
    if (!best) return undefined;
    // Two artifacts can tie on route and oldest engine and differ only by platform. Nothing then
    // prefers one, so the sort's stable order (the listing's own) decides, and the reason says so.
    const tied = ranked.some(
      (entry) =>
        entry !== best &&
        entry.route === best.route &&
        compareEngines(entry.engine, best.engine) === 0,
    );
    const others = versions
      .filter((version) => version !== best.version)
      .map((version) => {
        const engine = oldestEngine(version.engineVersions);
        return `${version.artifactId} (${engine === undefined ? "no engine" : decoderRoute(engine)})`;
      });
    const shown = others.slice(0, 5);
    const more = others.length > shown.length ? `, and ${others.length - shown.length} more` : "";
    return {
      version: best.version,
      reason: `Chose artifact ${best.version.artifactId} (${best.engine}, ${best.route}) over ${shown.join(", ")}${more} by route preference${tied ? ", then listing order" : ""}; pass artifactId or engine to override.`,
    };
  }

  /** Downloads an entitled artifact into an MCP-owned staging directory. Never claims or buys. */
  async download(request: FabDownloadRequest): Promise<void> {
    const tool = await this.tool();
    const explicit =
      request.artifactId !== undefined &&
      request.assetId !== undefined &&
      request.assetNamespace !== undefined;
    const args = explicit
      ? [
          "download",
          "--artifact-id",
          assertCatalogId(request.artifactId, "artifact id"),
          "--namespace",
          assertCatalogId(request.assetNamespace, "asset namespace"),
          "--asset-id",
          assertCatalogId(request.assetId, "asset id"),
          "--output",
          request.outputDir,
        ]
      : ["download", assertListingId(request.listingId), "--output", request.outputDir];
    if (!explicit && request.engine) args.push("--engine", assertEngineVersion(request.engine));
    if (request.platform) args.push("--platform", assertPlatform(request.platform));
    const run = await runBounded(tool.path, args, {
      timeoutMs: request.timeoutMs ?? 10_800_000,
      maxOutputBytes: 32 * 1024 * 1024,
    });
    if (run.code !== 0) {
      // FabCLI reports most failures as JSON but writes a few as plain text. Falling back to the
      // raw first line keeps the reason in the error instead of a bare exit code.
      const output = `${run.stdout}\n${run.stderr}`;
      const detail =
        /"message"\s*:\s*"([^"]{0,300})"/.exec(output)?.[1] ??
        output
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0)
          ?.slice(0, 300);
      const kind = /"kind"\s*:\s*"([a-z_]{0,60})"/.exec(output)?.[1];
      // A download fails the same way every other subcommand does when the session bus is gone.
      if (kind === "auth_required" && detail && /keystore|secure storage|DBus/i.test(detail)) {
        throw keystoreUnreachable(detail);
      }
      throw new FabCliError(
        kind === "auth_required"
          ? "FABCLI_UNAUTHENTICATED"
          : kind === "not_owned"
            ? "FABCLI_NOT_OWNED"
            : "FABCLI_DOWNLOAD_FAILED",
        `fabcli download exited ${run.code}${detail ? `: ${detail}` : "."}`,
        run.code !== 2,
      );
    }
  }
}
