import { describe, expect, it } from "vitest";

import { createAssetAdapters } from "../src/discovery/adapters.js";
import { AssetFederation } from "../src/discovery/federation.js";
import { DirectAssetDownloader } from "../src/download/direct-asset-downloader.js";
import { AssetSearchOutputSchema, createAssetSearchHandler } from "../src/tools/federated-assets.js";

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

describe("close matches on a miss (PRD-063)", () => {
  const federation = (adapters = [adapter()]) =>
    new AssetFederation(adapters, new DirectAssetDownloader({} as never), {
      toolVersion: "test",
    } as never);

  it("AC-1: suggests the coupe and the siblings of its category for 'muscle car'", async () => {
    const { results, closeMatches } = await federation().search({
      query: "muscle car",
      providers: ["procedural"],
    });
    expect(results).toEqual([]);
    // "car" reaches the coupe's alias, the formula, a garage house and the saguaro (Carnegiea).
    // Vehicles wins the category, so its siblings outrank the two words-only hits.
    expect(closeMatches.map((row) => row.assetId)).toEqual([
      "procedural:city-coupe",
      "procedural:city-formula",
      "procedural:city-sedan",
      "procedural:city-van",
      "procedural:city-kart",
    ]);
    expect(closeMatches[0]).toMatchObject({
      type: "3d-model",
      matchedWords: ["car"],
      missingWords: ["muscle"],
    });
    expect(closeMatches[0]!.bakeCall).toContain('bakeCity({ module: "coupe"');
    // A sibling shares no word at all; the category is the whole reason it is suggested.
    expect(closeMatches[2]).toMatchObject({ matchedWords: [], missingWords: ["muscle", "car"] });

    // The same answer through the registered tool, which is where the output schema is enforced.
    const reply = await createAssetSearchHandler(federation())({
      query: "muscle car",
      providers: ["procedural"],
    });
    expect("structuredContent" in reply).toBe(true);
    if (!("structuredContent" in reply)) return;
    const tool = AssetSearchOutputSchema.parse(reply.structuredContent);
    expect(tool.results).toEqual([]);
    expect(tool.closeMatches[0]).toMatchObject({
      assetId: "procedural:city-coupe",
      matchedWords: ["car"],
      missingWords: ["muscle"],
    });
    expect(tool.closeMatches[0]!.bakeCall).toContain('bakeCity({ module: "coupe"');
  });

  it("AC-2: returns no suggestion when the query shares no word, and never promotes one into results", async () => {
    const miss = await federation().search({ query: "xyzzy plinth", providers: ["procedural"] });
    expect(miss.results).toEqual([]);
    expect(miss.closeMatches).toEqual([]);

    const partial = await federation().search({ query: "sports car", providers: ["procedural"] });
    expect(partial.results.map((row) => row.assetId)).toEqual(["procedural:city-coupe"]);
    for (const row of partial.closeMatches)
      expect(partial.results.map((result) => result.assetId)).not.toContain(row.assetId);
  });

  it("still finds a hyphenated slug by its exact catalog id", async () => {
    // The query splits on the same rule as the catalog, so "cul-de-sac" is three words on both
    // sides and "kaykit-platformer" is two. Splitting only the catalog made every slug unreachable.
    const slug = await federation().search({ query: "cul-de-sac", providers: ["procedural"] });
    expect(slug.results.map((row) => row.nativeId)).toEqual(["city-cul-de-sac"]);

    const pack = await federation(createAssetAdapters()).search({
      query: "kaykit-platformer",
      providers: ["kaykit"],
      freeOnly: false,
    });
    expect(pack.results.map((row) => row.assetId)).toEqual(["kaykit:kaykit-platformer"]);
  });

  it("answers a composite catalog id with that element first, not its whole family", async () => {
    // `civic` is a kind and `Decals & Works` a category, so four elements answer the query at score
    // 1. The one whose own id carries both words has to lead, or limit: 1 returns the graffiti.
    const { results } = await federation().search({
      query: "civic-decals",
      providers: ["procedural"],
      limit: 1,
    });
    expect(results.map((row) => row.nativeId)).toEqual(["city-civic-decals"]);
  });

  it("leaves ordinary full matches in catalog order", async () => {
    // Only an id that *is* the query is promoted. A prefix rule put `road-grime` above `cross`, and
    // a name rule put a "Joshua tree" above the oak; both are a reordering of `items`.
    for (const [query, expected] of [
      ["road", ["city-cross", "city-straight", "city-curve"]],
      ["tree", ["tree-oak", "tree-beech", "tree-birch"]],
    ] as const) {
      const { items } = await adapter().search(query, ["3d-model"], 3, signal());
      expect(items.map((item) => item.nativeId), query).toEqual([...expected]);
    }
  });

  it("ranks a better direct hit above a category's siblings", async () => {
    // "race", "car" and "city" all hit the formula car; the Race Kit shares "race" and "city"
    // with it. Inheriting the category's rank ties a sibling with its own best hit, so the 3-of-4
    // row stays first instead of being buried by five 2-of-4 siblings.
    const { closeMatches } = await federation().search({
      query: "race car city zzz",
      providers: ["procedural"],
    });
    expect(closeMatches[0]).toMatchObject({
      assetId: "procedural:city-formula",
      matchedWords: ["race", "car", "city"],
      missingWords: ["zzz"],
    });
    expect(closeMatches).toHaveLength(5);
  });

  it("gives a stronger itch suggestion the earlier slot", async () => {
    const { closeMatches } = await federation(createAssetAdapters()).search({
      query: "quaternius universal animation 2 zzz",
      providers: ["quaternius", "kaykit"],
      freeOnly: false,
    });
    // Library 2 shares four of five words and Library 1 three, so catalog order must not decide.
    expect(closeMatches.map((row) => row.nativeId)).toEqual([
      "quaternius-universal-animation-library-2",
      "quaternius-universal-animation-library-1",
    ]);
  });

  it("reports a sibling's own matched words instead of none", async () => {
    // The formula car matched "car"; it is suggested as a sibling of the winning Vehicles category,
    // which must not make it look like it shares nothing with the query.
    const { closeMatches } = await federation().search({
      query: "muscle sports car",
      providers: ["procedural"],
    });
    expect(closeMatches[0]).toMatchObject({
      assetId: "procedural:city-coupe",
      matchedWords: ["sports", "car"],
    });
    expect(closeMatches.find((row) => row.assetId === "procedural:city-formula")).toMatchObject({
      matchedWords: ["car"],
      missingWords: ["muscle", "sports"],
    });
    // A sibling that really shares no word still says so.
    expect(closeMatches.find((row) => row.assetId === "procedural:city-sedan")).toMatchObject({
      matchedWords: [],
      missingWords: ["muscle", "sports", "car"],
    });
  });

  it("keeps a suggestion out of results even when a provider repeats it in both", async () => {
    const repeated = { ...adapter() };
    repeated.search = async (query, types, limit, sig) => {
      const page = await adapter().search(query, types, limit, sig);
      return {
        ...page,
        closeItems: [
          ...(page.closeItems ?? []),
          { asset: page.items[0]!, matchedWords: ["sports"], missingWords: ["car"] },
          { asset: page.closeItems![0]!.asset, matchedWords: ["sports"], missingWords: ["car"] },
        ],
      };
    };
    const { results, closeMatches } = await federation([repeated]).search({
      query: "sports car",
      providers: ["procedural"],
    });
    expect(results.map((row) => row.assetId)).toEqual(["procedural:city-coupe"]);
    expect(closeMatches.map((row) => row.assetId)).not.toContain("procedural:city-coupe");
    expect(new Set(closeMatches.map((row) => row.assetId)).size).toBe(closeMatches.length);
  });

  it("accepts a suggestion whose word lists are as long as a 200-character query allows", async () => {
    // A query of one-character words fills the 200-character maximum with 100 of them, and a close
    // row carries the matched and the missing list. A round bound under that turned a valid search
    // into ASSET_INVALID_INPUT at the tool, because the schema rejects the whole reply at once.
    const { results, closeMatches } = await federation().search({
      query: "sports car",
      providers: ["procedural"],
    });
    const words = Array.from({ length: 100 }, (_, index) => `w${index}`);
    const row = { ...closeMatches[0]!, matchedWords: words, missingWords: words };
    const parsed = AssetSearchOutputSchema.safeParse({
      results,
      closeMatches: [row],
      providers: [],
      partial: false,
      searchedAt: new Date().toISOString(),
      notice: "test",
    });
    expect(parsed.success).toBe(true);
  });

  it("reports only the provider whose suggestion cannot be read", async () => {
    const broken = { ...adapter() };
    broken.search = async (query, types, limit, sig) => {
      const page = await adapter().search(query, types, limit, sig);
      return {
        ...page,
        // A provider that hands back a non-list here would have failed the whole search at the tool,
        // because the output schema rejects it for every provider at once.
        closeItems: [{ asset: page.items[0]!, matchedWords: null as never, missingWords: [] }],
      };
    };
    const steady = {
      id: "steady",
      async search() {
        const item = (await adapter().search("sports car", ["3d-model"], 1, signal())).items[0]!;
        return {
          items: [{ ...item, provider: "steady", nativeId: "coupe", assetId: "steady:coupe" }],
          truncated: false,
        };
      },
      async get() {
        throw new Error("unused");
      },
    };
    const { results, providers } = await federation([broken, steady]).search({
      query: "sports car",
      providers: ["procedural", "steady"],
    });
    expect(results.map((row) => row.assetId)).toEqual(["steady:coupe"]);
    expect(providers.find((report) => report.provider === "procedural")).toMatchObject({
      status: "error",
    });
    expect(providers.find((report) => report.provider === "steady")).toMatchObject({
      status: "ok",
    });
  });

  it("refuses a suggestion whose word list is sparse or oversized", async () => {
    // `.every()` skips a sparse array's holes, so `new Array(3)` used to pass this boundary and then
    // fail the output schema for every provider at once.
    for (const matchedWords of [new Array(3), Array.from({ length: 201 }, () => "w")] as const) {
      const broken = { ...adapter() };
      broken.search = async (query, types, limit, sig) => {
        const page = await adapter().search(query, types, limit, sig);
        return { ...page, closeItems: [{ asset: page.items[0]!, matchedWords, missingWords: [] }] };
      };
      await expect(
        federation([broken]).search({ query: "sports car", providers: ["procedural"] }),
      ).rejects.toThrow(/all selected providers failed/i);
    }
  });

  it("discards a provider's page when one suggestion is malformed", async () => {
    const broken = { ...adapter() };
    broken.search = async (query, types, limit, sig) => {
      const page = await adapter().search(query, types, limit, sig);
      const impostor = { ...page.items[0]!, provider: "polyhaven", assetId: "polyhaven:chair" };
      return {
        ...page,
        closeItems: [{ asset: impostor, matchedWords: ["sports"], missingWords: ["car"] }],
      };
    };
    // The page is refused whole: a provider reported as failed contributes nothing.
    await expect(
      federation([broken]).search({ query: "sports car", providers: ["procedural"] }),
    ).rejects.toThrow(/all selected providers failed/i);
  });
});
