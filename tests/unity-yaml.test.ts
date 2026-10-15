import { describe, expect, it } from "vitest";

import type { UnityAssetEntry } from "../src/unity/package.js";
import {
  asUnityRef,
  parseMeta,
  parseUnityDocuments,
  resolveRef,
  UnityYamlError,
} from "../src/unity/yaml.js";

const TEXTURE_GUID = "01234567890123456789012345678901"; // all digits: would be a number without guid quoting
const PREFAB_GUID = "abcdefabcdefabcdefabcdefabcdefab";

const MATERIAL = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!21 &2100000
Material:
  serializedVersion: 8
  m_ObjectHideFlags: 0
  m_Name: crate
  m_Shader: {fileID: 46, guid: 0000000000000000f000000000000000, type: 0}
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs:
    - _MainTex:
        m_Texture: {fileID: 2800000, guid: ${TEXTURE_GUID}, type: 3}
        m_Scale: {x: 1, y: 1}
    m_Floats:
    - _Metallic: 0.5
    m_Colors:
    - _Color: {r: 1, g: 0.5, b: 0, a: 1}
`;

const PREFAB = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &1000000000000000001
GameObject:
  m_Name: Crate
  m_Component:
  - component: {fileID: -8679921383154817045}
--- !u!4 &-8679921383154817045
Transform:
  m_GameObject: {fileID: 1000000000000000001}
  m_Father: {fileID: 0}
--- !u!1001 &77 stripped
GameObject:
  m_CorrespondingSourceObject: {fileID: 5, guid: ${PREFAB_GUID}, type: 3}
--- !u!9999 &88
SomeFutureThing:
  anything: [1, 2]
`;

function entry(guid: string, path: string): UnityAssetEntry {
  return { guid, path, metaYaml: "" };
}

const database = {
  entries: new Map([
    [TEXTURE_GUID, entry(TEXTURE_GUID, "Assets/Textures/crate_albedo.png")],
    [PREFAB_GUID, entry(PREFAB_GUID, "Assets/Prefabs/other.prefab")],
  ]),
};

describe("unity yaml reader", () => {
  it("returns classId, fileID, stripped and parsed fields for a multi-document prefab", () => {
    const documents = parseUnityDocuments(PREFAB);
    expect(documents.map((d) => [d.classId, d.fileId, d.stripped, d.typeName])).toEqual([
      [1, "1000000000000000001", false, "GameObject"],
      [4, "-8679921383154817045", false, "Transform"],
      [1001, "77", true, "GameObject"],
      [9999, "88", false, "SomeFutureThing"],
    ]);
    expect(documents[0]?.fields).toMatchObject({ m_Name: "Crate" });
    // 64-bit ids survive as exact decimal strings; small ids stay numbers.
    expect(documents[0]?.fields.m_Component).toEqual([{ component: { fileID: "-8679921383154817045" } }]);
    expect(documents[1]?.fields).toMatchObject({ m_GameObject: { fileID: "1000000000000000001" }, m_Father: { fileID: 0 } });
    expect(documents[3]?.fields).toEqual({ anything: [1, 2] });
  });

  it("parses a material and keeps guids as strings, including digit-only and exponent-looking ones", () => {
    const [material] = parseUnityDocuments(MATERIAL);
    const fields = material?.fields as {
      m_Shader: { guid: string };
      m_SavedProperties: { m_TexEnvs: Array<{ _MainTex: { m_Texture: { guid: unknown } } }>; m_Floats: Array<Record<string, number>> };
    };
    expect(material).toMatchObject({ classId: 21, fileId: "2100000", typeName: "Material", stripped: false });
    expect(fields.m_Shader.guid).toBe("0000000000000000f000000000000000");
    expect(fields.m_SavedProperties.m_TexEnvs[0]?._MainTex.m_Texture.guid).toBe(TEXTURE_GUID);
    expect(fields.m_SavedProperties.m_Floats[0]).toEqual({ _Metallic: 0.5 });
    expect(parseMeta("fileFormatVersion: 2\nguid: 0000000000000000e000000000000000\n")).toEqual({
      fileFormatVersion: 2,
      guid: "0000000000000000e000000000000000",
    });
  });

  it("reports malformed and binary input as UnityYamlError naming the document", () => {
    expect(() => parseUnityDocuments("--- !u!1 &5\nGameObject:\n  a: [unclosed\n")).toThrow(/!u!1 &5/);
    expect(() => parseUnityDocuments("\u0000binary")).toThrow(UnityYamlError);
  });

  it("resolves a material's texture ref to its asset path and marks the Standard shader builtin", () => {
    const [material] = parseUnityDocuments(MATERIAL);
    const fields = material?.fields as {
      m_Shader: unknown;
      m_SavedProperties: { m_TexEnvs: Array<{ _MainTex: { m_Texture: unknown } }> };
    };
    const texture = asUnityRef(fields.m_SavedProperties.m_TexEnvs[0]?._MainTex.m_Texture);
    expect(resolveRef(texture!, { database })).toMatchObject({
      kind: "asset",
      path: "Assets/Textures/crate_albedo.png",
      fileId: "2800000",
      guid: TEXTURE_GUID,
    });
    expect(resolveRef(asUnityRef(fields.m_Shader)!, { database })).toEqual({
      kind: "builtin",
      guid: "0000000000000000f000000000000000",
      fileId: "46",
      source: "extra-resources",
      name: "Standard",
    });
  });

  it("resolves default resources, null, local, object-in-asset and missing refs", () => {
    const documents = parseUnityDocuments(PREFAB);
    const ref = (text: string) => asUnityRef(parseMeta(`r: ${text}`).r)!;
    expect(resolveRef(ref("{fileID: 10202, guid: 0000000000000000e000000000000000, type: 0}"), { database })).toMatchObject({
      kind: "builtin",
      source: "default-resources",
    });
    expect(resolveRef(ref("{fileID: 0}"), { database })).toEqual({ kind: "null" });
    const local = resolveRef(ref("{fileID: -8679921383154817045}"), { database, documents });
    expect(local).toMatchObject({ kind: "local", object: { classId: 4 } });
    const inAsset = resolveRef(ref(`{fileID: 88, guid: ${PREFAB_GUID}, type: 3}`), {
      database,
      documentsOf: (found) => (found.guid === PREFAB_GUID ? documents : undefined),
    });
    expect(inAsset).toMatchObject({ kind: "asset", path: "Assets/Prefabs/other.prefab", object: { classId: 9999 } });
    expect(resolveRef(ref("{fileID: 1, guid: 22222222222222222222222222222222, type: 3}"), { database })).toEqual({
      kind: "missing",
      guid: "22222222222222222222222222222222",
      fileId: "1",
    });
    expect(asUnityRef("nope")).toBeUndefined();
  });
});
