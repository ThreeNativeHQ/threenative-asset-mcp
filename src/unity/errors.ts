export type UnityImportErrorCode =
  | "UNITY_IMPORT_INVALID_INPUT"
  | "UNITY_IMPORT_EULA_REQUIRED"
  | "UNITY_BLENDER_NOT_FOUND"
  | "UNITY_BLENDER_UNUSABLE"
  | "UNITY_BLENDER_FAILED"
  | "UNITY_OUTPUT_EXISTS";

/** A failure the caller can act on. Its message is safe to show: it never carries file contents. */
export class UnityImportError extends Error {
  constructor(
    readonly code: UnityImportErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "UnityImportError";
  }
}
