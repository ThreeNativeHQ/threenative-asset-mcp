import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BlendkitClient } from "../src/blendkit/client.js";
import { BlendkitProvider, importBlendkitAsset } from "../src/blendkit/provider.js";

/**
 * Opt-in proof against the real official Blendkit-Client binary and a real Blender. The provider
 * API is a local stand-in, so nothing reaches Blendkit, and the .blend is authored here.
 *   BLENDKIT_CLIENT_BIN=<bk_client-linux-x86_64> BLENDKIT_BLENDER_PATH=<blender> npx vitest run tests/blendkit-live-client.test.ts
 */
const BIN = process.env.BLENDKIT_CLIENT_BIN;
const BLENDER = process.env.BLENDKIT_BLENDER_PATH;
const FAST = "11111111-2222-4333-8444-555555555555";
const SLOW = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const FIXTURE_SCRIPT = `
import bpy, sys
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1)
cube = bpy.context.active_object
image = bpy.data.images.new("albedo", 4, 4)
image.pixels = [0.8, 0.2, 0.1, 1.0] * 16
image.pack()
material = bpy.data.materials.new("Painted")
material.use_nodes = True
texture = material.node_tree.nodes.new("ShaderNodeTexImage")
texture.image = image
material.node_tree.links.new(texture.outputs["Color"], material.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
cube.data.materials.append(material)
bpy.ops.wm.save_as_mainfile(filepath=sys.argv[-1])
`;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

describe.skipIf(!BIN || !BLENDER)(
  "official Blendkit-Client v1.13 with real Blender (local provider stand-in)",
  () => {
    let root: string;
    let upstream: Server;
    let upstreamOrigin: string;
    let client: ChildProcess;
    let clientUrl: string;
    let blend: Buffer;
    const seen: string[] = [];
    let slowClosed = false;

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "blendkit-live-"));
      const fixture = join(root, "fixture.blend");
      const made = spawnSync(
        BLENDER!,
        ["--background", "--factory-startup", "--python-expr", FIXTURE_SCRIPT, "--", fixture],
        {
          env: { ...process.env, TMPDIR: root },
          encoding: "utf8",
          timeout: 120_000,
        },
      );
      expect(made.status, made.stderr).toBe(0);
      blend = await readFile(fixture);

      upstream = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://stand-in");
        seen.push(url.pathname);
        const json = (value: unknown) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        };
        if (url.pathname === "/api/v1/search/") {
          const query = url.searchParams.get("query") ?? "";
          const id = query.includes(SLOW) ? SLOW : FAST;
          return json({
            count: 1,
            results: [
              {
                id,
                assetBaseId: id,
                name: "Self Authored Cube",
                assetType: "model",
                isFree: true,
                canDownload: true,
                license: "cc_zero",
                author: { fullName: "ThreeNative test" },
                files: [
                  {
                    fileType: "blend",
                    downloadUrl: `${upstreamOrigin}/api/v1/download/${id}`,
                    fileUploadSize: blend.length,
                  },
                ],
              },
            ],
          });
        }
        if (url.pathname.startsWith("/api/v1/download/"))
          return json({
            filePath: `${upstreamOrigin}/files/${url.pathname.endsWith(SLOW) ? "slow" : "cube"}.blend`,
          });
        if (url.pathname === "/files/cube.blend") {
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": blend.length,
          });
          return void res.end(blend);
        }
        if (url.pathname === "/files/slow.blend") {
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": 50_000_000,
          });
          const timer = setInterval(() => res.write(Buffer.alloc(4096)), 50);
          res.on("close", () => {
            clearInterval(timer);
            slowClosed = true;
          });
          return;
        }
        res.writeHead(404, { "content-type": "application/json" }).end("{}");
      });
      await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
      upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

      // The Client writes its settings beside its binary and scratch files under TMPDIR: keep both here.
      // Not $TMPDIR/bk_client: the Client extracts its bundled recipes to that directory.
      await mkdir(join(root, "bin"));
      const bin = join(root, "bin", "bk_client");
      await copyFile(BIN!, bin);
      const port = await freePort();
      clientUrl = `http://127.0.0.1:${port}`;
      client = spawn(
        bin,
        [
          "--port",
          String(port),
          "--server",
          upstreamOrigin,
          "--proxy_which",
          "NONE",
          "--global_dir",
          join(root, "global"),
          "--version",
          "0.0.0-test",
          "--software",
          "ThreeNative",
        ],
        { env: { ...process.env, HOME: root, TMPDIR: root }, stdio: "ignore" },
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          await fetch(`${clientUrl}/addons/list`).then(
            (r) => r.ok,
            () => false,
          )
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Blendkit-Client did not start.");
    }, 180_000);

    afterAll(async () => {
      if (client && client.exitCode === null) {
        const exited = new Promise((resolve) => client.once("exit", resolve));
        await fetch(`${clientUrl}/shutdown`).catch(() => undefined);
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
        client.kill("SIGKILL");
      }
      await new Promise((resolve) => (upstream ? upstream.close(resolve) : resolve(undefined)));
      if (root) await rm(root, { recursive: true, force: true });
    });

    const provider = () =>
      new BlendkitProvider({
        client: new BlendkitClient({ baseUrl: clientUrl, pollIntervalMs: 200 }),
        clientUrl,
        blenderPath: BLENDER!,
        permissionEvidence: "test: local provider stand-in, no Blendkit contact",
        server: upstreamOrigin,
      });

    it("reports the real Client's version and bundled GLB recipe", async () => {
      const status = await provider().options.client.status(AbortSignal.timeout(5000));
      expect(status.clientVersion).toMatch(/^1\.1[3-9]\.\d+$/u);
      expect(status.tools).toContain("export_glb");
    });

    it("searches through the Client's task and /report protocol", async () => {
      const { items } = await provider().search(
        "cube",
        ["3d-model"],
        5,
        AbortSignal.timeout(30_000),
      );
      expect(items.map((asset) => asset.assetId)).toEqual([`blendkit:${FAST}`]);
      expect(seen).toContain("/api/v1/search/");
    }, 60_000);

    it("downloads, converts with export_glb under Blender and inspects the GLB", async () => {
      const out = join(root, "assets");
      const progress: number[] = [];
      const result = await importBlendkitAsset(
        provider(),
        {
          assetId: `blendkit:${FAST}`,
          outputDir: out,
          purpose: "project-use",
          acceptLicense: true,
          projectUseConsent: true,
          resolution: "ORIGINAL",
        },
        AbortSignal.timeout(170_000),
        { toolVersion: "test", onProgress: (update) => progress.push(update.progress) },
      );
      expect(result.inspection).toMatchObject({
        meshes: 1,
        triangles: 12,
        textures: 1,
        warnings: [],
      });
      expect(result.inspection.materials).toEqual([
        {
          name: "Painted",
          baseColorTexture: true,
          normalTexture: false,
          metallicRoughnessTexture: false,
        },
      ]);
      for (const axis of ["x", "y", "z"] as const)
        expect(result.inspection.sizeMeters?.[axis]).toBeCloseTo(1, 5);
      expect(result.source.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.parse(await readFile(result.provenancePath, "utf8"))).toMatchObject({
        conversion: { recipe: "export_glb" },
        license: { name: "CC0 1.0" },
        redistribution: { redistributionAllowed: false },
      });
      expect(seen).toContain("/files/cube.blend");
    }, 180_000);

    it("cancels a running download in the real Client", async () => {
      const controller = new AbortController();
      const work = importBlendkitAsset(
        provider(),
        {
          assetId: `blendkit:${SLOW}`,
          outputDir: join(root, "cancelled"),
          purpose: "project-use",
          acceptLicense: true,
          projectUseConsent: true,
          resolution: "ORIGINAL",
        },
        controller.signal,
        { toolVersion: "test" },
      );
      for (let attempt = 0; attempt < 100 && !seen.includes("/files/slow.blend"); attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort(new Error("caller cancelled"));
      await expect(work).rejects.toThrow("caller cancelled");
      for (let attempt = 0; attempt < 100 && !slowClosed; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 100));
      expect(slowClosed).toBe(true);
    }, 60_000);
  },
);
