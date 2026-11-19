import { describe, expect, it } from "vitest";

import { createAssetAdapters } from "../src/discovery/adapters.js";
import { AssetFederation } from "../src/discovery/federation.js";
import { DirectAssetDownloader } from "../src/download/direct-asset-downloader.js";

const adapter = () => createAssetAdapters().find((entry) => entry.id === "procedural")!;
const signal = () => new AbortController().signal;

describe("procedural adapter", () => {
  it.each([
    ["oak tree", "tree-oak", 'bakeVegetation({ preset: "oak"'],
    ["mossy boulder", "debris-rock", 'bakeVegetation({ preset: "rock"'],
    ["traffic light", "city-signal", 'bakeCity({ module: "signal"'],
    ["sports car", "city-coupe", 'bakeCity({ module: "coupe"'],
  ])("finds %s first with its bake call", async (query, nativeId, bake) => {
    const { items } = await adapter().search(query, ["3d-model"], 10, signal());
    expect(items[0]).toMatchObject({
      assetId: `procedural:${nativeId}`,
      type: "3d-model",
      free: "yes",
      canDownloadNow: false,
      license: { commercialUse: "yes", attributionRequired: "no" },
    });
    expect(items[0]!.bakeCall).toContain(bake);
    expect(items[0]!.downloadReason).toContain("npm i -D @threenative/procedural-environment");
    expect(items[0]!.downloadReason).toContain(items[0]!.bakeCall!);
  });

  it("returns nothing for other asset types", async () => {
    expect((await adapter().search("oak", ["texture"], 10, signal())).items).toEqual([]);
  });

  it("is listed by asset_search through the federation", async () => {
    const federation = new AssetFederation([adapter()], new DirectAssetDownloader({} as never), {
      toolVersion: "test",
    } as never);
    const { results } = await federation.search({ query: "traffic light", providers: ["procedural"] });
    expect(results[0]).toMatchObject({ provider: "procedural", nativeId: "city-signal" });
    expect(results[0]!.bakeCall).toContain("bakeCity");
  });
});
