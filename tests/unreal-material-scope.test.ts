import { describe, expect, it } from "vitest";
import { scopeMaterialFiles } from "../src/unreal/importer.js";

type Assets = Parameters<typeof scopeMaterialFiles>[0];

const assetsOf = (matAll: Record<string, string[]>, propsAll: Record<string, string[]> = {}): Assets => {
  const last = (all: Record<string, string[]>): Map<string, string> => new Map(Object.entries(all).map(([name, paths]) => [name, paths[paths.length - 1]!]));
  return {
    gltf: new Map(),
    psa: new Map(),
    mat: last(matAll),
    props: last(propsAll),
    matAll: new Map(Object.entries(matAll)),
    propsAll: new Map(Object.entries(propsAll)),
    png: new Map(),
    audio: new Map(),
    dna: new Map(),
  };
};

describe("scopeMaterialFiles", () => {
  const cliff = "/raw/Rocks/Cliff";
  const large = "/raw/Rocks/Large";
  const inst = { MI_Rock_Inst: [`${cliff}/MI_Rock_Inst.mat`, `${large}/MI_Rock_Inst.mat`] };
  const props = { MI_Rock_Inst: [`${cliff}/MI_Rock_Inst.props.txt`, `${large}/MI_Rock_Inst.props.txt`] };

  it("picks the same-named material that sits beside the mesh, not the last one indexed", () => {
    const assets = assetsOf(inst, props);
    expect(assets.mat.get("MI_Rock_Inst")).toBe(`${large}/MI_Rock_Inst.mat`);
    const scoped = scopeMaterialFiles(assets, cliff);
    expect(scoped.mat.get("MI_Rock_Inst")).toBe(`${cliff}/MI_Rock_Inst.mat`);
    expect(scoped.props.get("MI_Rock_Inst")).toBe(`${cliff}/MI_Rock_Inst.props.txt`);
    // The shared index is untouched, and the other folder still gets its own copy.
    expect(assets.mat.get("MI_Rock_Inst")).toBe(`${large}/MI_Rock_Inst.mat`);
    expect(scopeMaterialFiles(assets, large).mat.get("MI_Rock_Inst")).toBe(`${large}/MI_Rock_Inst.mat`);
  });

  it("returns the very same object when nothing needs choosing, so per-assets caches keep hitting", () => {
    const unique = assetsOf({ MI_Only: [`${cliff}/MI_Only.mat`] }, { MI_Only: [`${cliff}/MI_Only.props.txt`] });
    expect(scopeMaterialFiles(unique, large)).toBe(unique);
    const ambiguousNoneBeside = assetsOf(inst, props);
    expect(scopeMaterialFiles(ambiguousNoneBeside, "/raw/Elsewhere")).toBe(ambiguousNoneBeside);
    const scoped = scopeMaterialFiles(ambiguousNoneBeside, cliff);
    expect(scopeMaterialFiles(ambiguousNoneBeside, cliff)).toBe(scoped);
  });

  it("copes with an index that carries no candidate lists", () => {
    const legacy = { ...assetsOf({}), matAll: undefined, propsAll: undefined } as Assets;
    expect(scopeMaterialFiles(legacy, cliff)).toBe(legacy);
  });
});
