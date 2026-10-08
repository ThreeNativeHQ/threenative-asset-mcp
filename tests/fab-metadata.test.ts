import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type MaterialMetadataDump,
  readMaterialMetadataDumps,
  replayMaterialMetadata,
} from "../src/unreal/material-metadata.js";

const SYNTHETIC_FIXTURE = fileURLToPath(new URL("./fixtures/material-metadata/synthetic.json", import.meta.url));

describe("committed synthetic material metadata", () => {
  const dump = JSON.parse(readFileSync(SYNTHETIC_FIXTURE, "utf8")) as MaterialMetadataDump;

  it("replays with zero mismatches", () => {
    expect(replayMaterialMetadata(dump)).toEqual([]);
  });

  it("keeps the instance override over the parent default", () => {
    const panel = dump.materials.find((material) => material.name === "MI_Synth_Panel");
    expect(panel?.expected.bindings).toEqual([expect.objectContaining({ texture: "T_Instance_D", source: "props" })]);
  });
});

// Licensed pack dumps are local-only. Set FAB_METADATA_DIR to a directory written by
// `npm run parity:fab -- --export-metadata <dir>` to replay them; unset, this block is skipped.
const localDumpDir = process.env.FAB_METADATA_DIR;
const localDumps = localDumpDir ? readMaterialMetadataDumps(localDumpDir) : [];
const localDescribe = localDumpDir ? describe : describe.skip;

localDescribe("licensed pack metadata dumps (FAB_METADATA_DIR, local-only)", () => {
  it("finds at least one dump", () => {
    expect(localDumps.length).toBeGreaterThan(0);
  });

  for (const { fileName, dump } of localDumps) {
    it(`${fileName} replays with zero mismatches`, () => {
      expect(replayMaterialMetadata(dump)).toEqual([]);
    });
  }
});
