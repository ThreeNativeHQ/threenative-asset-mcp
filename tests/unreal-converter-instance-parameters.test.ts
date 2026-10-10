import { describe, expect, it } from "vitest";

import { CUE4PARSE_PROGRAM, CUE4PARSE_SOURCE } from "../src/unreal/cue4parse-adapter.js";
import { resolveMaterial } from "../src/unreal/materials.js";

// An editor-saved UE5.3 MaterialInstanceConstant: CUE4Parse's typed `TextureParameterValues` came back empty while the
// tagged property held every override, so the converter wrote an empty `CollectedTextureParameters` block and the
// importer bound the parent's defaults (a flat default normal map) to every Megascans prop of a 5.3 pack.
const PARENT_PROPS = `BlendMode = BLEND_Opaque
TwoSided = false
OpacityMaskClipValue = 0.333
CollectedTextureParameters[2] =
{
    CollectedTextureParameters[0] =
    {
        Texture = Texture2D'T_Default_Gray.T_Default_Gray'
        Name = RMF
        Group = None
    }
    CollectedTextureParameters[1] =
    {
        Texture = Texture2D'T_Default_N.T_Default_N'
        Name = NORMAL
        Group = None
    }
}
`;
const instanceProps = (parameters: readonly (readonly [string, string])[]): string =>
  `Parent = Material'M_Master.M_Master'
BlendMode = BLEND_Opaque
OpacityMaskClipValue = 0.3333
CollectedTextureParameters[${parameters.length}] =
{
${parameters
  .map(
    ([name, texture], index) => `    CollectedTextureParameters[${index}] =
    {
        Texture = Texture2D'${texture}.${texture}'
        Name = ${name}
        Group = None
    }`,
  )
  .join("\n")}
}
`;

function resolveInstance(parameters: readonly (readonly [string, string])[]) {
  const props: Record<string, string> = { MI_Prop: instanceProps(parameters), M_Master: PARENT_PROPS };
  const mat: Record<string, string> = {
    MI_Prop: parameters.map(([, texture], index) => `Other[${index}]=${texture}`).join("\n") + "\n",
    M_Master: "Other[0]=T_Default_Gray\nOther[1]=T_Default_N\n",
  };
  return resolveMaterial({
    name: "MI_Prop",
    readMat: (name) => mat[name],
    readProps: (name) => props[name],
    availableTextures: new Set(["T_Prop_A", "T_Prop_N", "T_Prop_R", "T_Default_Gray", "T_Default_N"]),
  });
}

describe("converter: a material instance's texture overrides", () => {
  it("reads the tagged TextureParameterValues too, not only CUE4Parse's typed array (converter 62)", () => {
    expect(CUE4PARSE_SOURCE.version).toBe("b4e95441+threenative.71");
    const exporter = CUE4PARSE_PROGRAM.slice(CUE4PARSE_PROGRAM.indexOf("async Task ExportMaterialAsync"));
    expect(exporter).toContain('instance.GetOrDefault<FStructFallback[]>("TextureParameterValues")');
  });

  it("binds the instance's own normal map once the overrides are written, and the parent's default without them", () => {
    const written = resolveInstance([["ALBEDO", "T_Prop_A"], ["NORMAL", "T_Prop_N"], ["RMF", "T_Prop_R"]]);
    expect(written.bindings.find((binding) => binding.slot === "normal")?.texture).toBe("T_Prop_N");
    const empty = resolveInstance([]);
    expect(empty.bindings.find((binding) => binding.slot === "normal")?.texture).toBe("T_Default_N");
  });
});
