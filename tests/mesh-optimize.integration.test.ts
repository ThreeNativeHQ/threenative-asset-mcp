import { describe, expect, it } from "vitest";

import { comparePreviews } from "../src/optimize/mesh.js";
import { renderPreview } from "../src/rig/preview.js";
import { densePlateGlb } from "./helpers/mesh-fixture.js";

const previewOptions = {
  times: [0],
  angles: 6,
  width: 192,
  height: 192,
  fitMargin: 2.2,
  timeoutMs: 120_000,
};

describe("mesh_optimize", () => {
  it(
    "gate fails a visible change and passes an identical copy",
    async () => {
      const withDetail = await densePlateGlb({ grid: 240, detailHeight: 0.5, detailSigma: 0.3 });
      const withoutDetail = await densePlateGlb({ grid: 240 });
      const before = await renderPreview(withDetail, previewOptions);
      const changed = await renderPreview(withoutDetail, previewOptions);
      const same = await renderPreview(withDetail, previewOptions);

      const failed = await comparePreviews(before, changed);
      expect(failed.passed).toBe(false);
      expect(failed.iou).toBeLessThan(0.98);
      expect(failed.views).toHaveLength(6);

      const passed = await comparePreviews(before, same);
      expect(passed.passed).toBe(true);
      expect(passed.iou).toBe(1);
      expect(passed.grayDifference).toBe(0);
    },
    240_000,
  );
});
