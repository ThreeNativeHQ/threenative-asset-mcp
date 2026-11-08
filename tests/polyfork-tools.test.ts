import { describe, expect, it } from "vitest";

import { PolyforkClient } from "../src/polyfork/client.js";
import {
  createPolyforkGetModelHandler,
  createPolyforkListFilesHandler,
  createPolyforkSearchHandler,
} from "../src/tools/polyfork.js";
import {
  POLYFORK_FIXTURE_ID,
  polyforkDetailPayload,
  polyforkRow,
  polyforkSearchPage,
} from "./helpers/polyfork-fixtures.js";

const client = (payload: unknown) =>
  new PolyforkClient(async () => Response.json(payload));
const hdPayload = () =>
  polyforkDetailPayload({
    hd: {
      plan: "pro",
      page: `https://polyfork.dev/asset/${POLYFORK_FIXTURE_ID}?edition=hd`,
      kind: "its own high poly program with pbr materials",
      triangles: 608,
      preview_glb: `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}-hd-preview.glb`,
      files: `https://polyfork.dev/dl/${POLYFORK_FIXTURE_ID}-hd.zip (Pro, with a key)`,
    },
  });
type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
};
const structured = <T>(result: ToolResult): T => {
  if (result.isError) throw new Error(String(result.content[0]?.text));
  return result.structuredContent as T;
};

describe("Polyfork MCP tools", () => {
  it("searches the catalogue with the character filter and a bounded page", async () => {
    const result = await createPolyforkSearchHandler(
      client(polyforkSearchPage([polyforkRow()], { total: 198, per_page: 1 })),
    )({ query: "musician", class: "character", limit: 1 });
    const output = structured<{
      items: Array<Record<string, unknown>>;
      total: number;
      nextCursor?: string;
      provider: string;
      license: Record<string, unknown>;
      notice: string;
    }>(result);
    expect(output).toMatchObject({ total: 198, nextCursor: "2", provider: "Polyfork" });
    expect(output.items[0]).toMatchObject({
      id: POLYFORK_FIXTURE_ID,
      url: `https://polyfork.dev/asset/${POLYFORK_FIXTURE_ID}`,
      class: "character",
      triangles: 4055,
      free: true,
      hasRig: true,
      hasSkeleton: true,
      downloadStatus: "direct",
      canDownloadNow: true,
      license: {
        name: "CC BY 4.0 or Polyfork licence",
        url: "https://polyfork.dev/licensing",
        commercialUse: "yes",
        attributionRequired: "yes",
      },
    });
    expect(output.license.evidence).toContain("CC BY 4.0");
    expect(output.notice).toContain("not a full census");
  });

  it("says plainly when the catalogue has no word match", async () => {
    const result = await createPolyforkSearchHandler(
      client({ total: 0, page: 1, per_page: 24, assets: [], coverage: "none", strong_matches: 0 }),
    )({ query: "zzzznotathing" });
    const output = structured<{ items: unknown[]; notice: string; coverage?: string }>(result);
    expect(output.items).toEqual([]);
    expect(output.coverage).toBe("none");
    expect(output.notice).toContain("no word match");
  });

  it("rejects invalid search input with a deterministic code", async () => {
    const result = await createPolyforkSearchHandler(client(polyforkSearchPage([])))({
      class: "monster",
    } as never);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.parse(String(result.content[0]?.text))).toMatchObject({
      code: "POLYFORK_INVALID_INPUT",
    });
  });

  it("returns the full low-poly detail, dual licence and credit", async () => {
    const result = await createPolyforkGetModelHandler(client(polyforkDetailPayload()))({
      idOrUrl: `https://polyfork.dev/asset/${POLYFORK_FIXTURE_ID}`,
    });
    const output = structured<{
      license: { evidence: string; name: string };
      credit: string;
      clips: Array<{ name: string }>;
      skeleton: { bones?: number } | null;
      download: Record<string, Record<string, unknown> | null>;
      hd: unknown;
      providerDetails: Record<string, unknown>;
    }>(result);
    expect(output.credit).toContain("Cueca Musician by Polyfork");
    expect(output.license.evidence).toContain("Polyfork licence");
    expect(output.license.evidence).toContain("standalone redistribution");
    expect(output.clips).toEqual([{ name: "Walk", seconds: 0.97 }]);
    expect(output.skeleton).toMatchObject({ bones: 31 });
    expect(output.hd).toBeNull();
    expect(output.download.lowPolyGlb).toMatchObject({
      url: `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}.glb`,
      variant: "low-poly/full",
      requiresAuth: "none",
    });
    expect(output.download.previewGlb).toMatchObject({
      url: `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}-preview.glb`,
      preview: true,
    });
    expect(output.download.sourceModule).toMatchObject({ requiresAuth: "account" });
    expect(String(output.download.sourceModule?.note)).toContain("never fetched or executed");
    expect(output.providerDetails).toMatchObject({ materials: 1, drawCalls: 8 });
  });

  it("reports the Pro HD edition as authenticated", async () => {
    const output = structured<{ hd: Record<string, unknown> | null }>(
      await createPolyforkGetModelHandler(client(hdPayload()))({ idOrUrl: POLYFORK_FIXTURE_ID }),
    );
    expect(output.hd).toMatchObject({
      plan: "pro",
      requiresPlan: "pro",
      requiresAuth: "required",
      triangles: 608,
    });
  });

  it("lists the full low-poly GLB first and never the source module as a file", async () => {
    const output = structured<{
      files: Array<Record<string, unknown>>;
      alternatives: string[];
      termsText: string;
    }>(
      await createPolyforkListFilesHandler(client(polyforkDetailPayload()))({
        idOrUrl: POLYFORK_FIXTURE_ID,
      }),
    );
    expect(output.files.map((file) => [file.role, file.format])).toEqual([
      ["source", "glb"],
      ["preview", "glb"],
    ]);
    expect(output.files[0]).toMatchObject({
      url: `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}.glb`,
      requiresAuth: "none",
      requiresPlan: "free",
      variant: "low-poly/full",
    });
    expect(output.files[1]).toMatchObject({ preview: true, role: "preview" });
    expect(output.files.every((file) => !String(file.url).endsWith(".mjs"))).toBe(true);
    expect(output.alternatives).toContain("glb/low-poly/full");
    expect(output.termsText).toContain("CC BY 4.0");
    expect(output.termsText).toContain("no standalone redistribution");
    expect(output.termsText).toContain("commercial 3D asset generator");
  });

  it("adds an authenticated HD entry without an anonymous URL", async () => {
    const output = structured<{ files: Array<Record<string, unknown>> }>(
      await createPolyforkListFilesHandler(client(hdPayload()))({ idOrUrl: POLYFORK_FIXTURE_ID }),
    );
    const hd = output.files.find((file) => file.role === "hd");
    expect(hd).toMatchObject({ requiresAuth: "required", requiresPlan: "pro" });
    expect(hd?.url).toBeUndefined();
  });

  it("returns a structured requirement when upstream gates the GLB", async () => {
    const gated = polyforkDetailPayload({
      download: {
        glb: `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}.glb`,
        mjs: `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}.mjs`,
        auth: "account",
      },
    });
    const output = structured<{
      files: Array<Record<string, unknown>>;
      requirement?: string;
    }>(
      await createPolyforkListFilesHandler(client(gated))({ idOrUrl: POLYFORK_FIXTURE_ID }),
    );
    expect(output.requirement).toContain("account");
    expect(output.files[0]).toMatchObject({ role: "source", requiresAuth: "required" });
    expect(output.files[0]?.url).toBeUndefined();
  });

  it("names a contract mismatch instead of blaming an upstream gate", async () => {
    const forged = polyforkDetailPayload({
      download: {
        glb: `https://polyfork.dev/dl/${POLYFORK_FIXTURE_ID}.glb`,
        auth: "none",
      },
    });
    const output = structured<{
      files: Array<Record<string, unknown>>;
      requirement?: string;
    }>(
      await createPolyforkListFilesHandler(client(forged))({ idOrUrl: POLYFORK_FIXTURE_ID }),
    );
    expect(output.requirement).toContain("/cdn/<id>.glb");
    expect(output.requirement).not.toContain("account or Pro");
    expect(output.files[0]).toMatchObject({ role: "source", requiresAuth: "required" });
    expect(output.files[0]?.url).toBeUndefined();
  });

  it("maps unknown assets and invalid identifiers to honest errors", async () => {
    const missing = await createPolyforkGetModelHandler(
      new PolyforkClient(async () => Response.json({ error: "no such asset" }, { status: 404 })),
    )({ idOrUrl: "missing-asset" });
    expect(JSON.parse(String(missing.content[0]?.text))).toMatchObject({
      code: "POLYFORK_NOT_FOUND",
    });
    const invalid = await createPolyforkGetModelHandler(client(polyforkDetailPayload()))({
      idOrUrl: "https://evil.example/asset/x",
    });
    expect(JSON.parse(String(invalid.content[0]?.text))).toMatchObject({
      code: "POLYFORK_INVALID_INPUT",
    });
  });
});
