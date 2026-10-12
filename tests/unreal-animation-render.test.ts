import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderTiles } from "../src/unreal/contact-sheet.js";
import { compareImages } from "../src/unreal/image-diff.js";
import { judgeRender } from "../src/unreal/visual-judge.js";
import { describeWithTools } from "./helpers/require-tool.js";
import { skinnedSwingGlb, unriggedBipedGlb, withArmSwing } from "./helpers/rig-fixture.js";

// Exercises the production tile renderer's optional per-tile clip sampling. A synthetic skinned quad
// rotates 90° over one second; the render at 50% must differ from the rest pose, a missing clip must
// fail instead of silently returning the bind pose, and the static render must stay the rest pose.

describeWithTools(["chromium"], "renderTiles animation sampling", () => {
  it("samples an authored clip, fails a missing clip or unskinned model, and keeps the rest pose", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tn-anim-render-"));
    try {
      const swing = join(dir, "swing.glb");
      await writeFile(swing, Buffer.from(await skinnedSwingGlb()));
      const TILE = 120;

      const rest = (await renderTiles({ glbPaths: [swing], tile: TILE })).tiles[0]!;
      const mid = await renderTiles({ glbPaths: [swing], tile: TILE, sampling: [{ clip: "Swing", timeSeconds: 0.5 }] });
      const started = await renderTiles({ glbPaths: [swing], tile: TILE, sampling: [{ clip: "Swing", timeSeconds: 0 }] });

      expect(mid.rendered[0]).toBe(true);
      expect(judgeRender(mid.tiles[0]!).stats.objectPixels).toBeGreaterThan(200);
      // The 50% frame is a rotated diamond; the rest pose is a square. The t=0 frame is the rest pose, so
      // adding the option does not move the default static render.
      expect((await compareImages(rest, mid.tiles[0]!)).ssim).toBeLessThan(0.98);
      expect((await compareImages(rest, started.tiles[0]!)).ssim).toBeGreaterThan(0.99);

      const missing = await renderTiles({ glbPaths: [swing], tile: TILE, sampling: [{ clip: "Nope", timeSeconds: 0.5 }] });
      expect(missing.rendered[0]).toBe(false);
      expect(missing.failures?.[0]).toContain("clip not found");
      // A missing-clip failure is a grey background, not the animated bind pose.
      expect(judgeRender(missing.tiles[0]!).verdict).toBe("fail");

      const unskinned = join(dir, "unskinned.glb");
      await writeFile(unskinned, Buffer.from(await withArmSwing(await unriggedBipedGlb(), "Body")));
      const noSkin = await renderTiles({ glbPaths: [unskinned], tile: TILE, sampling: [{ clip: "Swing", timeSeconds: 0.5 }] });
      expect(noSkin.rendered[0]).toBe(false);
      expect(noSkin.failures?.[0]).toContain("skinned");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
