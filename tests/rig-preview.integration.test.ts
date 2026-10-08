import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { renderPreview } from "../src/rig/preview.js";
import { createAssetAutoRigHandler, createAssetPreviewAnimationHandler } from "../src/tools/rig.js";
import { unriggedBipedGlb, withArmSwing } from "./helpers/rig-fixture.js";
import { describeWithTools } from "./helpers/require-tool.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-preview-"));
  temporaryDirectories.push(directory);
  return directory;
}

interface HandlerResult {
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function call(
  handler:
    | ReturnType<typeof createAssetAutoRigHandler>
    | ReturnType<typeof createAssetPreviewAnimationHandler>,
  input: unknown,
) {
  return (await handler(input as never)) as unknown as HandlerResult;
}

describeWithTools(["chromium"], "asset_preview_animation", () => {
  it("renders a nonblank multi-angle sheet for a rigged model", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "retopo.glb");
    await writeFile(target, await unriggedBipedGlb());
    const rigged = join(directory, "rigged.glb");
    const riggedResult = await call(createAssetAutoRigHandler(), {
      target,
      output: rigged,
      projectRoot: directory,
    });
    expect(riggedResult.isError).toBeUndefined();

    const output = join(directory, "sheet.png");
    const result = await call(createAssetPreviewAnimationHandler(), {
      prepared: rigged,
      output,
      projectRoot: directory,
      times: [0],
      angles: 2,
      width: 128,
      height: 128,
      pose: { bone: "upper_arm.L", axis: "z", degrees: -45 },
    });
    expect(result.isError).toBeUndefined();

    expect(result.structuredContent.status).toBe("rendered");
    expect(result.structuredContent.backend).toContain("playwright-chromium");
    const images = result.structuredContent.images as Array<{ nonBlank: boolean }>;
    expect(images).toHaveLength(2);
    expect(images.every((image) => image.nonBlank)).toBe(true);
    expect(existsSync(output)).toBe(true);
  });
});

describeWithTools(["chromium"], "asset_preview_animation deformation is visible in every tile", () => {
  async function riggedFixture(): Promise<Uint8Array> {
    const directory = await temporaryDirectory();
    const target = join(directory, "retopo.glb");
    await writeFile(target, await unriggedBipedGlb());
    const rigged = join(directory, "rigged.glb");
    const result = await call(createAssetAutoRigHandler(), {
      target,
      output: rigged,
      projectRoot: directory,
    });
    expect(result.isError).toBeUndefined();
    return await readFile(rigged);
  }

  const size = { width: 96, height: 96, timeoutMs: 120_000 };

  it("applies the pose override to every angle, not only the first", async () => {
    const rigged = await riggedFixture();
    const base = await renderPreview(rigged, { times: [0], angles: 3, ...size });
    const posed = await renderPreview(rigged, {
      times: [0],
      angles: 3,
      pose: { bone: "upper_arm.L", axis: "z", degrees: -70 },
      ...size,
    });
    expect(posed.images).toHaveLength(3);
    for (let angle = 0; angle < 3; angle += 1) {
      expect(
        Buffer.from(posed.images[angle]!.png).equals(Buffer.from(base.images[angle]!.png)),
        `angle ${angle} ignored the pose override`,
      ).toBe(false);
    }
  }, 240_000);

  it("advances the clip in every angle, not only the first", async () => {
    const animated = await withArmSwing(await riggedFixture(), "upper_arm.L");
    const sheet = await renderPreview(animated, {
      clipName: "Swing",
      times: [0, 0.5],
      angles: 3,
      ...size,
    });
    expect(sheet.images).toHaveLength(6);
    for (let angle = 0; angle < 3; angle += 1) {
      expect(
        Buffer.from(sheet.images[3 + angle]!.png).equals(Buffer.from(sheet.images[angle]!.png)),
        `angle ${angle} rendered the same pose at t=0 and t=0.5`,
      ).toBe(false);
    }
  }, 240_000);

  it("refuses a pose naming a bone the model does not have", async () => {
    const rigged = await riggedFixture();
    await expect(
      renderPreview(rigged, {
        times: [0],
        angles: 2,
        pose: { bone: "no_such_bone", axis: "z", degrees: -70 },
        ...size,
      }),
    ).rejects.toThrow(/no_such_bone/);
  }, 240_000);
});
