import { describe, expect, it } from "vitest";

import { parseUmodelList } from "../src/unreal/importer.js";

describe("UE Viewer -list rows", () => {
  it("keeps each row's class and object name, so a level's World can be told from its Texture2D auxiliaries", () => {
    const stdout = [
      "Found 1 game files (0 skipped) in 1 folders",
      "   0    1000       10 World DemoMap",
      "   1    2000       20 Texture2D Texture2D_0",
      "   2    3000       30 Level PersistentLevel",
      "",
    ].join("\r\n");
    const parsed = parseUmodelList(stdout);
    expect(parsed.classes).toEqual(["World", "Texture2D", "Level"]);
    expect(parsed.entries).toEqual([
      { className: "World", objectName: "DemoMap" },
      { className: "Texture2D", objectName: "Texture2D_0" },
      { className: "Level", objectName: "PersistentLevel" },
    ]);
  });

  it("ignores the header and any line that is not a complete export row", () => {
    expect(parseUmodelList("Found 0 game files (0 skipped) in 0 folders\nTexture2D\n   0    1000       10 Texture2D\n").entries).toEqual([]);
  });
});
