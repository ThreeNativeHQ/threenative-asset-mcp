import { describe, expect, it } from "vitest";

import { decoderRoute, dumpEngineArg, oldestEngine } from "../src/fab/routes.js";

describe("oldestEngine", () => {
  it("compares numerically, not lexically", () => {
    expect(oldestEngine(["UE_5.4", "UE_4.9", "UE_4.18"])).toBe("UE_4.9");
    expect(oldestEngine(["UE_5.10", "UE_5.9"])).toBe("UE_5.9");
  });

  it("ignores entries that are not engine selectors and returns undefined for none", () => {
    expect(oldestEngine(["Preview", "UE_5.0"])).toBe("UE_5.0");
    expect(oldestEngine([])).toBeUndefined();
    expect(oldestEngine(["nonsense"])).toBeUndefined();
  });
});

describe("decoderRoute", () => {
  it.each([
    ["UE_4.18", "umodel"],
    ["UE_4.20", "umodel"],
    ["UE_4.21", "mesh-description"],
    ["UE_4.27", "mesh-description"],
    ["UE_5.0", "cue4parse"],
    ["UE_5.8", "cue4parse"],
  ] as const)("%s uses %s", (engine, route) => {
    expect(decoderRoute(engine)).toBe(route);
  });
});

describe("dumpEngineArg", () => {
  it("strips the UE_ prefix for versions ParseGame accepts", () => {
    expect(dumpEngineArg("UE_4.18")).toBe("4.18");
    expect(dumpEngineArg("UE_4.27")).toBe("4.27");
    expect(dumpEngineArg("UE_5.0")).toBe("5.0");
    expect(dumpEngineArg("UE_5.7")).toBe("5.7");
    expect(dumpEngineArg("UE_5.8")).toBe("5.8");
  });

  it("returns undefined for versions it does not accept", () => {
    expect(dumpEngineArg("UE_4.28")).toBeUndefined();
    expect(dumpEngineArg("UE_5.9")).toBeUndefined();
    expect(dumpEngineArg("UE_6.0")).toBeUndefined();
    expect(dumpEngineArg("junk")).toBeUndefined();
  });
});
