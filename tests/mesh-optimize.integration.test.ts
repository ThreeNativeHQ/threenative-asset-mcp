import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ImageUtils, NodeIO } from "@gltf-transform/core";
import { afterEach, describe, expect, it } from "vitest";

import { sizeMeters } from "../src/gltf-size.js";
import { comparePreviews, MESH_OPTIMIZE_GATE } from "../src/optimize/mesh.js";
import { renderPreview } from "../src/rig/preview.js";
import { createMeshOptimizeHandler } from "../src/tools/mesh-optimize.js";
import { densePlateGlb, morphTargetGlb, skinnedGlb } from "./helpers/mesh-fixture.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-optimize-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function glbJson(bytes: Uint8Array): Record<string, unknown> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(buffer.readUInt32LE(0)).toBe(0x46546c67);
  const jsonLength = buffer.readUInt32LE(12);
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString("utf8")) as Record<string, unknown>;
}

interface HandlerResult {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: Array<{ text: string }>;
}

async function call(input: unknown): Promise<HandlerResult> {
  return (await createMeshOptimizeHandler()(input as never)) as unknown as HandlerResult;
}

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
      expect(failed.iou).toBeLessThan(MESH_OPTIMIZE_GATE.iouThreshold);
      expect(failed.grayDifference).toBeGreaterThan(MESH_OPTIMIZE_GATE.grayThreshold);
      expect(failed.views).toHaveLength(6);

      const passed = await comparePreviews(before, same);
      expect(passed.passed).toBe(true);
      expect(passed.iou).toBe(1);
      expect(passed.grayDifference).toBe(0);
    },
    240_000,
  );

  it(
    "renders a mesh scaled in the hundreds instead of clipping it",
    async () => {
      const io = new NodeIO();
      const document = await io.readBinary(await densePlateGlb({ grid: 8 }));
      document.getRoot().listNodes()[0]!.setScale([500, 500, 500]);
      const scaled = await io.writeBinary(document);
      const preview = await renderPreview(scaled, {
        times: [0],
        angles: 2,
        width: 128,
        height: 128,
        fitMargin: 2.2,
        timeoutMs: 120_000,
      });
      expect(preview.bounds?.max[0]).toBeCloseTo(500, 3);
      expect(preview.images).toHaveLength(2);
      expect(preview.images.every((image) => image.nonBlank)).toBe(true);
    },
    120_000,
  );

  it(
    "optimizes a dense static fixture to under 10% of its triangles",
    async () => {
      const directory = await temporaryDirectory();
      const inputPath = join(directory, "dense.glb");
      await writeFile(inputPath, await densePlateGlb({ detailHeight: 0.05, detailSigma: 0.08 }));

      const result = await call({ path: inputPath });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.kept).toBe("optimized");

      const input = result.structuredContent?.input as { triangles: number; bytes: number };
      const output = result.structuredContent?.output as {
        path: string;
        triangles: number;
        bytes: number;
      };
      const gate = result.structuredContent?.gate as { passed: boolean };
      expect(input.triangles).toBeGreaterThanOrEqual(200_000);
      expect(output.triangles).toBeLessThanOrEqual(input.triangles * 0.1);
      expect(output.bytes).toBeLessThan(input.bytes);
      expect(gate.passed).toBe(true);
      expect(output.path).toBe(join(directory, "dense.optimized.glb"));
      expect(existsSync(output.path)).toBe(true);
      expect(existsSync(join(directory, "dense.optimized.before.png"))).toBe(true);
      expect(existsSync(join(directory, "dense.optimized.after.png"))).toBe(true);
    },
    300_000,
  );

  it(
    "output leaves the input byte-identical and readable without compression",
    async () => {
      const directory = await temporaryDirectory();
      const inputPath = join(directory, "dense.glb");
      const inputBytes = await densePlateGlb({ grid: 64, detailHeight: 0.05, detailSigma: 0.08 });
      await writeFile(inputPath, inputBytes);
      const inputDigest = sha256(inputBytes);

      const result = await call({ path: inputPath, maxTextureSize: 1_024 });
      expect(result.isError).toBeUndefined();
      const output = result.structuredContent?.output as { path: string };
      expect(output.path).not.toBe(inputPath);
      expect(sha256(await readFile(inputPath))).toBe(inputDigest);

      const written = new Uint8Array(await readFile(output.path));
      const json = glbJson(written);
      const extensions = [
        ...((json.extensionsUsed as string[] | undefined) ?? []),
        ...((json.extensionsRequired as string[] | undefined) ?? []),
      ];
      expect(extensions).not.toContain("KHR_draco_mesh_compression");
      expect(extensions).not.toContain("EXT_meshopt_compression");
      const size = await sizeMeters(output.path);
      expect(size).toBeDefined();
      expect(size!.x).toBeGreaterThan(0);
    },
    300_000,
  );

  it("unsupported refuses a skinned GLB and a morph-target GLB without writing anything", async () => {
    const directory = await temporaryDirectory();
    for (const [name, bytes] of [
      ["skinned", await skinnedGlb()],
      ["morph", await morphTargetGlb()],
    ] as const) {
      const inputPath = join(directory, `${name}.glb`);
      await writeFile(inputPath, bytes);
      const outputPath = join(directory, `${name}.optimized.glb`);
      const result = await call({ path: inputPath, outputPath });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({
        code: "MESH_OPTIMIZE_UNSUPPORTED",
      });
      expect(existsSync(outputPath)).toBe(false);
      expect(existsSync(join(directory, `${name}.optimized.before.png`))).toBe(false);
      expect(existsSync(join(directory, `${name}.optimized.after.png`))).toBe(false);
    }
  }, 60_000);

  it(
    "resizes a 4096 px texture to maxTextureSize and still succeeds",
    async () => {
      const directory = await temporaryDirectory();
      const inputPath = join(directory, "textured.glb");
      await writeFile(inputPath, await densePlateGlb({ grid: 40, textureSize: 4_096 }));

      const result = await call({ path: inputPath, maxTextureSize: 2_048 });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.kept).toBe("optimized");
      expect((result.structuredContent?.gate as { passed: boolean }).passed).toBe(true);

      const output = result.structuredContent?.output as { path: string };
      const document = await new NodeIO().read(output.path);
      const textures = document.getRoot().listTextures();
      expect(textures).toHaveLength(1);
      const texture = textures[0]!;
      expect(texture.getMimeType()).toBe("image/png");
      const size = ImageUtils.getSize(texture.getImage()!, texture.getMimeType());
      expect(size).toBeDefined();
      expect(Math.max(size![0], size![1])).toBe(2_048);
      expect(Math.min(size![0], size![1])).toBe(2_048);
    },
    300_000,
  );
});
