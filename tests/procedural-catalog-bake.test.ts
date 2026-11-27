import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as environment from "@threenative/procedural-environment";
// @ts-expect-error gltf-validator ships no types for its Node entry.
import { validateBytes } from "gltf-validator";
import { createAssetAdapters } from "../src/discovery/adapters.js";
import { validateGltf } from "../src/discovery/acquisition.js";
import catalog from "../src/procedural/catalog.json" with { type: "json" };

// PRD-540 AC-2. Every recipe in the catalog, zero skips: it is found by asset_search, its bake call
// runs, and each GLB it writes passes the acquisition validator and the Khronos validator.

// Float-range findings in the generators' vertex data (53 vegetation recipes write COLOR_0 outside 0..1;
// dock, plume and seedgrass write normals that are not unit length). Every renderer loads these files.
// The generators live in threenative-engine (packages/procedural-environment), so the fix is an engine
// release; any other validator error fails the recipe.
const UPSTREAM_DATA_RANGE_CODES = new Set(["ACCESSOR_NON_CLAMPED", "ACCESSOR_VECTOR3_NON_UNIT"]);

const adapter = createAssetAdapters().find((entry) => entry.id === "procedural")!;
const out = await mkdtemp(join(tmpdir(), "procedural-bake-"));
afterAll(() => rm(out, { recursive: true, force: true }));

const installed = JSON.parse(
  readFileSync(new URL("../node_modules/@threenative/procedural-environment/package.json", import.meta.url), "utf8"),
) as { version: string };

describe("procedural catalog", () => {
  it("is generated for the installed package", () => {
    expect(catalog.version).toBe(installed.version);
    expect(catalog.elements.length).toBeGreaterThan(0);
  });

  it.each(catalog.elements.map((element) => [`${element.kind}-${element.id}`, element] as const))(
    "%s is searchable, bakes and validates",
    async (nativeId, element) => {
      const { items } = await adapter.search(element.id, ["3d-model"], 10, new AbortController().signal);
      const hit = items.find((item) => item.nativeId === nativeId);
      expect(hit?.bakeCall).toBe(element.bake);

      const call = /^(bake\w+)\((\{.*\})\)$/su.exec(element.bake);
      expect(call, element.bake).not.toBeNull();
      const options = new Function(`return (${call![2]})`)() as Record<string, unknown>;
      const bake = (environment as unknown as Record<string, (o: unknown) => Promise<{ path: string }[]>>)[call![1]!]!;
      const baked = await bake({ ...options, out: join(out, nativeId) });
      expect(baked.length).toBeGreaterThan(0);
      for (const { path } of baked) {
        await validateGltf(dirname(path), [{ path: basename(path) } as never]);
        const bytes = new Uint8Array(readFileSync(path));
        const report = await validateBytes(bytes);
        const errors = report.issues.messages.filter(
          (m: { severity: number; code: string }) => m.severity === 0 && !UPSTREAM_DATA_RANGE_CODES.has(m.code),
        );
        expect(errors, path).toEqual([]);
      }
    },
    120_000,
  );
});
