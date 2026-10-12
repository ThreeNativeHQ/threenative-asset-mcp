/**
 * PRD-584: the one canonical game-path key. `/Game/A/MI_X`, `Content/A/MI_X.uasset` and
 * `Pack/Content/A/MI_X.uasset` all become `a/mi_x`, so two packages that differ only by mount,
 * `Content` prefix or letter case resolve to the same identity.
 */
export function gamePackageKey(path: string): string {
  const segments = path.replace(/\\/g, "/").replace(/\.(uasset|umap)$/i, "").split("/").filter((segment) => segment.length > 0);
  const content = segments.map((segment) => segment.toLowerCase()).lastIndexOf("content");
  // After the last `Content` folder; a `/Game/...` (or other mount) path drops its mount name.
  return segments.slice(content >= 0 ? content + 1 : 1).join("/").toLowerCase();
}
