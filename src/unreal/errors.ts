/** Import-time failures, in their own module so every Unreal decoder can raise one. Re-exported by
 * importer.ts, which is where callers have always imported it from. */
export type ImportErrorCode =
  | "UNREAL_SOURCE_NOT_FOUND"
  | "UNREAL_SOURCE_EMPTY"
  | "UNREAL_OUTPUT_INVALID"
  | "UNREAL_OUTPUT_COLLISION"
  | "UNREAL_DISK_SPACE"
  | "UNREAL_EXPORT_EMPTY"
  | "UNREAL_SOURCE_UNCOOKED"
  | "UNREAL_SOURCE_UNSUPPORTED"
  | "UNREAL_GLB_INVALID"
  /** A groom editor payload that is not a hair description this build can decode without guessing. */
  | "UNREAL_GROOM_INVALID"
  /** A hair description that decodes, but describes strands this build refuses to reinterpret. */
  | "UNREAL_GROOM_UNSUPPORTED";

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ImportError";
  }
}
