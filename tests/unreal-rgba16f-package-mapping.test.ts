import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { packageSetSha256 } from "../src/unreal/data-texture-promotion.js";
import { describeWithTools } from "./helpers/require-tool.js";
import { Rgba16fProducer } from "./helpers/rgba16f-producer.js";

// The --data-texture selector mapping, run by the compiled production resolver (ResolveRgba16fPackage) on a real DefaultFileProvider
// that the test initializes over loose files it writes. The files hold fake bodies: the provider registers them by path and the
// resolver never parses them, so no case here reads a texture. The provider names a loose root after its own folder and folds keys
// case-insensitively. Each case below is one way a selector meets that.

// The refusal the resolver gives when the provider would load a namesake of a sidecar the exact stem lacks (on a host that tells case apart).
const namesakeReason = (extension: string) =>
  `the provider would load Pack/Content/probe/T${extension} as the ${extension} of Content/Probe/T, but no ${extension} exists at exactly Content/Probe/T${extension}`;

describeWithTools(["modern-converter"], "RGBA16F --data-texture package mapping over a real DefaultFileProvider", () => {
  const producer = new Rgba16fProducer();
  let caseSensitive = false;
  beforeAll(async () => {
    await producer.setup();
    caseSensitive = await producer.caseSensitive();
  }, 300_000);
  afterAll(async () => {
    await producer.teardown();
  });

  describe("a root-relative selector names one exact package at any depth", () => {
    it("maps a root that holds Content directly, keys it under the root's folder name, and hashes the exact physical files", async () => {
      const tree = await producer.looseTree(["Pack/Content/Probe/T.uasset", "Pack/Content/Probe/T.uexp"]);
      const root = join(tree, "Pack");
      const outcome = await producer.resolveDataTexture({ root, selector: "Content/Probe/T" });
      expect(outcome).toEqual({
        ok: true,
        key: "Pack/Content/Probe/T.uasset",
        packageKey: "Content/Probe/T.uasset",
        sidecars: { ".uexp": "Pack/Content/Probe/T.uexp" },
        packageSha: await packageSetSha256(root, "Content/Probe/T"),
        files: [".uasset", ".uexp"],
      });
    });

    it("maps a root above Pack/Content, whose provider key begins with that root's own folder name", async () => {
      const tree = await producer.looseTree(["Pack/Content/Probe/T.uasset"]);
      const outcome = await producer.resolveDataTexture({ root: tree, selector: "Pack/Content/Probe/T" });
      expect(outcome).toEqual({
        ok: true,
        key: `${basename(tree)}/Pack/Content/Probe/T.uasset`,
        packageKey: "Pack/Content/Probe/T.uasset",
        sidecars: {},
        packageSha: await packageSetSha256(tree, "Pack/Content/Probe/T"),
        files: [".uasset"],
      });
    });

    it("maps a root that is the Content folder itself, whose provider keys begin with Content/", async () => {
      const tree = await producer.looseTree(["Content/Probe/T.uasset"]);
      const outcome = await producer.resolveDataTexture({ root: join(tree, "Content"), selector: "Probe/T" });
      expect(outcome).toMatchObject({ ok: true, key: "Content/Probe/T.uasset", packageKey: "Probe/T.uasset" });
    });

    it("takes the exact package among folders that share a basename", async () => {
      const tree = await producer.looseTree(["Pack/Content/A/T.uasset", "Pack/Content/B/T.uasset"]);
      const outcome = await producer.resolveDataTexture({ root: join(tree, "Pack"), selector: "Content/B/T" });
      expect(outcome).toMatchObject({ ok: true, key: "Pack/Content/B/T.uasset", packageKey: "Content/B/T.uasset", sidecars: {} });
    });
  });

  describe("a selector that names no exact package in the root is refused", () => {
    it("refuses a provider key: the root's folder name is not part of a root-relative selector", async () => {
      const tree = await producer.looseTree(["Pack/Content/Probe/T.uasset"]);
      const selector = `${basename(tree)}/Pack/Content/Probe/T`;
      const outcome = await producer.resolveDataTexture({ root: join(tree, "Pack"), selector });
      expect(outcome).toEqual({ ok: false, reason: `no package has exactly the key ${selector}.uasset under the source root` });
    });

    it("refuses a suffix of a provider key, since no suffix or basename stands for a package", async () => {
      const tree = await producer.looseTree(["Pack/Content/Probe/T.uasset"]);
      const outcome = await producer.resolveDataTexture({ root: tree, selector: "Content/Probe/T" });
      expect(outcome).toEqual({ ok: false, reason: "no package has exactly the key Content/Probe/T.uasset under the source root" });
    });

    it("refuses a bare basename", async () => {
      const tree = await producer.looseTree(["Pack/Content/Probe/T.uasset"]);
      const outcome = await producer.resolveDataTexture({ root: join(tree, "Pack"), selector: "T" });
      expect(outcome).toEqual({ ok: false, reason: "no package has exactly the key T.uasset under the source root" });
    });

    it("refuses a package the root does not hold", async () => {
      const tree = await producer.looseTree(["Pack/Content/Probe/T.uasset"]);
      const outcome = await producer.resolveDataTexture({ root: join(tree, "Pack"), selector: "Content/Probe/Missing" });
      expect(outcome).toEqual({
        ok: false,
        reason: "no package has exactly the key Content/Probe/Missing.uasset under the source root",
      });
    });

    it("refuses a package the provider registers twice, rather than choosing one of its keys", async () => {
      const tree = await producer.looseTree(["Pack/Content/Probe/T.uasset"]);
      const root = join(tree, "Pack");
      const outcome = await producer.resolveDataTexture({ root, selector: "Content/Probe/T", extraDirectories: [join(root, "Content")] });
      expect(outcome).toMatchObject({ ok: false, reason: expect.stringMatching(/Content\/Probe\/T\.uasset is registered 2 times/) });
    });

    it("keeps the one spelling the provider registered when two folders differ only in case, and refuses the other", async () => {
      const tree = await producer.looseTree(["Pack/Content/Textures/T.uasset", "Pack/Content/textures/T.uasset"]);
      const root = join(tree, "Pack");
      const outcomes = [
        await producer.resolveDataTexture({ root, selector: "Content/Textures/T" }),
        await producer.resolveDataTexture({ root, selector: "Content/textures/T" }),
      ];
      const accepted = outcomes.filter((outcome) => outcome.ok);
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({ ok: true, packageKey: expect.stringMatching(/^Content\/[Tt]extures\/T\.uasset$/) });
      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
        { ok: false, reason: expect.stringMatching(/the provider registered no loose file at exactly Content\/[Tt]extures\/T\.uasset/) },
      ]);
    });
  });

  describe("sidecars and the export boundary", () => {
    // The provider folds keys case-insensitively and FindPayloads hands the load a sidecar by the package's key, so a namesake the exact
    // stem lacks is still what the load reads. Where the host folds case, the namesake is the same file and so the exact sidecar.
    it.each([".uexp", ".ubulk", ".uptnl"])("refuses a case-folded namesake of the %s that the provider would still load", async (extension) => {
      const tree = await producer.looseTree(["Pack/Content/Probe/T.uasset", `Pack/Content/probe/T${extension}`]);
      const root = join(tree, "Pack");
      const outcome = await producer.resolveDataTexture({ root, selector: "Content/Probe/T" });
      expect(outcome).toEqual(
        caseSensitive
          ? { ok: false, reason: namesakeReason(extension) }
          : {
              ok: true,
              key: "Pack/Content/Probe/T.uasset",
              packageKey: "Content/Probe/T.uasset",
              sidecars: { [extension]: expect.any(String) },
              packageSha: await packageSetSha256(root, "Content/Probe/T"),
              files: [".uasset", extension],
            },
      );
    });

    it("accepts the exact .uexp, .ubulk and .uptnl, and hashes all four files the load consumes", async () => {
      const tree = await producer.looseTree([
        "Pack/Content/Probe/T.uasset",
        "Pack/Content/Probe/T.uexp",
        "Pack/Content/Probe/T.ubulk",
        "Pack/Content/Probe/T.uptnl",
      ]);
      const root = join(tree, "Pack");
      const outcome = await producer.resolveDataTexture({ root, selector: "Content/Probe/T" });
      expect(outcome).toEqual({
        ok: true,
        key: "Pack/Content/Probe/T.uasset",
        packageKey: "Content/Probe/T.uasset",
        sidecars: { ".uexp": "Pack/Content/Probe/T.uexp", ".ubulk": "Pack/Content/Probe/T.ubulk", ".uptnl": "Pack/Content/Probe/T.uptnl" },
        packageSha: await packageSetSha256(root, "Content/Probe/T"),
        files: [".uasset", ".uexp", ".ubulk", ".uptnl"],
      });
    });

    it("refuses the same namesake at the export boundary before any export, and writes nothing", async () => {
      const tree = await producer.looseTree(["Pack/Content/Probe/T.uasset", "Pack/Content/probe/T.uexp"]);
      const outcome = await producer.exportDataTexture({ root: join(tree, "Pack"), selector: "Content/Probe/T" });
      expect(outcome).toEqual({
        ok: false,
        reason: caseSensitive ? namesakeReason(".uexp") : "0 Texture2D exports are named T in Pack/Content/Probe/T.uasset; exactly one is needed",
        directory: outcome.directory,
      });
      await expect(readdir(join(outcome.directory, "DataTextures"))).rejects.toThrow();
    });

    it("runs the production export boundary on the mapped package, which refuses it and writes nothing", async () => {
      const tree = await producer.looseTree(["Pack/Content/Probe/T.uasset"]);
      const outcome = await producer.exportDataTexture({ root: join(tree, "Pack"), selector: "Content/Probe/T" });
      expect(outcome).toEqual({
        ok: false,
        reason: "0 Texture2D exports are named T in Pack/Content/Probe/T.uasset; exactly one is needed",
        directory: outcome.directory,
      });
      await expect(readdir(join(outcome.directory, "DataTextures"))).rejects.toThrow();
    });
  });
});
