/** Deterministic UE4.19 tagged packages, containing no licensed source data. */
export interface SourceProperty {
  name: string;
  type: string;
  value: unknown;
  struct?: string;
  inner?: string;
  enum?: string;
}
export interface SourceExport { name: string; className: string; properties: SourceProperty[]; outer?: number }
export const prop = (name: string, type: string, value: unknown, meta: Partial<SourceProperty> = {}): SourceProperty => ({ name, type, value, ...meta });
export const float = (name: string, value: number) => prop(name, "FloatProperty", value);
export const bool = (name: string, value: boolean) => prop(name, "BoolProperty", value);
export const input = (name: string, expression: number, channel?: number, outputIndex = 0) => prop(name, "StructProperty", { expression, channel, outputIndex }, { struct: "ExpressionInput" });
export const fields = (name: string, struct: string, value: SourceProperty[]) => prop(name, "StructProperty", value, { struct });
export const parameter = (name: string, value: number | boolean, override = true): SourceProperty[] => [
  fields("ParameterInfo", "MaterialParameterInfo", [prop("Name", "NameProperty", name), prop("Association", "ByteProperty", "GlobalParameter", { enum: "EMaterialParameterAssociation" }), prop("Index", "IntProperty", -1)]),
  typeof value === "boolean" ? bool("Value", value) : float("ParameterValue", value),
  ...(typeof value === "boolean" ? [bool("bOverride", override)] : []),
];

export function materialPackage(exports: SourceExport[], external: string[] = [], options: { version?: number; core?: number; framework?: number; externalClasses?: Readonly<Record<string, string>> } = {}): Buffer {
  const names: string[] = [];
  const imports: { name: string; outer: number; className: string }[] = [];
  const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const i64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
  const f32 = (n: number) => { const b = Buffer.alloc(4); b.writeFloatLE(n); return b; };
  const string = (s: string) => Buffer.concat([i32(Buffer.byteLength(s) + 1), Buffer.from(s + "\0")]);
  const fname = (s: string) => { let i = names.indexOf(s); if (i < 0) { i = names.length; names.push(s); } return Buffer.concat([i32(i), i32(0)]); };
  const ref = (path: string) => {
    let index = imports.findIndex((r) => r.name === path && r.outer === 0);
    if (index < 0) { index = imports.length; imports.push({ name: path, outer: 0, className: "Package" }); }
    const packageIndex = -index - 1;
    const object = path.slice(path.lastIndexOf("/") + 1);
    imports.push({ name: object, outer: packageIndex, className: options.externalClasses?.[path] ?? "Texture2D" });
    return -imports.length;
  };
  const externalRefs = external.map(ref);
  const classIndices = exports.map((e) => { imports.push({ name: e.className, outer: 0, className: "Class" }); return -imports.length; });
  const encodeValue = (p: SourceProperty): Buffer => {
    switch (p.type) {
      case "BoolProperty": return Buffer.alloc(0);
      case "FloatProperty": return f32(p.value as number);
      case "IntProperty": return i32(p.value as number);
      case "NameProperty": case "ByteProperty": return fname(p.value as string);
      case "ObjectProperty": return i32(typeof p.value === "string" ? externalRefs[external.indexOf(p.value)]! : p.value as number);
      case "StructProperty": {
        if (p.struct === "ExpressionInput") {
          const v = p.value as { expression: number; channel?: number; outputIndex: number };
          return Buffer.concat([i32(v.expression), i32(v.outputIndex), fname("None"), i32(v.channel === undefined ? 0 : 1), ...[0, 1, 2, 3].map((c) => i32(c === v.channel ? 1 : 0))]);
        }
        if (["Vector", "Vector2D", "Vector4", "LinearColor"].includes(p.struct!)) return Buffer.concat((p.value as number[]).map(f32));
        return encodeProperties(p.value as SourceProperty[]);
      }
      case "ArrayProperty": {
        const rows = p.value as unknown[];
        const header = p.inner === "StructProperty" ? encodeTag({ ...p, type: "StructProperty", value: [] }, Buffer.alloc(0)) : Buffer.alloc(0);
        return Buffer.concat([i32(rows.length), header, ...rows.map((value) => encodeValue({ ...p, type: p.inner!, value }))]);
      }
      default: throw new Error(`unsupported fixture type ${p.type}`);
    }
  };
  const encodeTag = (p: SourceProperty, body: Buffer) => Buffer.concat([
    fname(p.name), fname(p.type), i32(body.length), i32(0),
    ...(p.type === "StructProperty" ? [fname(p.struct!), Buffer.alloc(16)] : []),
    ...(p.type === "BoolProperty" ? [Buffer.from([p.value ? 1 : 0])] : []),
    ...(p.type === "ByteProperty" ? [fname(p.enum ?? "None")] : []),
    ...(p.type === "ArrayProperty" ? [fname(p.inner!)] : []), Buffer.from([0]), body,
  ]);
  const encodeProperties = (properties: SourceProperty[]) => Buffer.concat([...properties.map((p) => encodeTag(p, encodeValue(p))), fname("None")]);
  const bodies = exports.map((e) => encodeProperties(e.properties));
  const importTable = Buffer.concat(imports.map((r) => Buffer.concat([fname("/Script/Engine"), fname(r.className), i32(r.outer), fname(r.name)])));
  exports.forEach((e) => fname(e.name));
  const summary = (nameOffset: number, importOffset: number, exportOffset: number, headerSize: number) => Buffer.concat([
    u32(0x9e2a83c1), i32(-7), i32(864), i32(options.version ?? 516), i32(0), i32(2),
    ...[0x375ec13c, 0x06e448fb, 0xb50084f0, 0x262a717e].map(u32), i32(options.core ?? 2),
    ...[0xcffc743f, 0x43b04480, 0x939114df, 0x171d2073].map(u32), i32(options.framework ?? 33),
    i32(headerSize), string(""), u32(0), i32(names.length), i32(nameOffset), string(""), i32(0), i32(0),
    i32(exports.length), i32(exportOffset), i32(imports.length), i32(importOffset), i32(headerSize),
    i32(0), i32(0), i32(0), i32(0), Buffer.alloc(16), i32(0),
    ...[0, 1].map(() => Buffer.concat([Buffer.alloc(6), u32(0), string("")])),
    u32(0), i32(0), u32(0), i32(0), i32(0), i64(0), i32(0), i32(0), i32(0), i32(0),
  ]);
  const nameOffset = summary(0, 0, 0, 0).length;
  const nameTable = Buffer.concat(names.map((n) => Buffer.concat([string(n), Buffer.alloc(4)])));
  const importOffset = nameOffset + nameTable.length;
  const exportOffset = importOffset + importTable.length;
  const headerSize = exportOffset + exports.length * 104;
  let bodyOffset = headerSize;
  const exportTable = Buffer.concat(exports.map((e, index) => {
    const b = bodies[index]!;
    const record = Buffer.concat([i32(classIndices[index]!), i32(0), i32(0), i32(e.outer ?? (index === 0 ? 0 : 1)), fname(e.name), u32(0), i64(b.length), i64(bodyOffset), Buffer.alloc(12), Buffer.alloc(16), u32(0), i32(0), i32(1), Buffer.alloc(20)]);
    bodyOffset += b.length;
    return record;
  }));
  return Buffer.concat([summary(nameOffset, importOffset, exportOffset, headerSize), nameTable, importTable, exportTable, ...bodies]);
}

export function subsetMaster(aoFactor = 1): Buffer {
  return materialPackage([
    { name: "Master", className: "Material", properties: [input("BaseColor", 2), input("Roughness", 2, 0, 3), input("AmbientOcclusion", 2, 0, 14), input("Specular", 2, 0, 2), input("Normal", 2, undefined, 7), prop("ShadingModel", "ByteProperty", "MSM_TwoSidedFoliage", { enum: "EMaterialShadingModel" })] },
    { name: "Break", className: "MaterialExpressionBreakMaterialAttributes", properties: [input("MaterialAttributes", 3)] },
    { name: "First", className: "MaterialExpressionStaticSwitchParameter", properties: [prop("ParameterName", "NameProperty", "First"), bool("DefaultValue", true), input("A", 4), input("B", 5)] },
    { name: "Second", className: "MaterialExpressionStaticSwitchParameter", properties: [prop("ParameterName", "NameProperty", "Second"), bool("DefaultValue", true), input("A", 6), input("B", 5)] },
    { name: "Unselected", className: "MaterialExpressionMaterialFunctionCall", properties: [] },
    { name: "Surface", className: "MaterialExpressionMakeMaterialAttributes", properties: [input("BaseColor", 7), input("AmbientOcclusion", 10), input("Roughness", 13), input("Specular", 8, 1, 2), input("Normal", 15)] },
    { name: "Albedo", className: "MaterialExpressionTextureSample", properties: [prop("Texture", "ObjectProperty", "/Game/Kit/Albedo")] },
    { name: "Packed", className: "MaterialExpressionTextureSample", properties: [prop("Texture", "ObjectProperty", "/Game/Kit/Packed"), prop("SamplerType", "ByteProperty", "SAMPLERTYPE_LinearColor", { enum: "EMaterialSamplerType" })] },
    { name: "AOReroute", className: "MaterialExpressionReroute", properties: [input("Input", 8, 0, 1)] },
    { name: "AO", className: "MaterialExpressionMultiply", properties: [input("A", 9), input("B", 11)] },
    { name: "AOFactor", className: "MaterialExpressionConstant", properties: [float("R", aoFactor)] },
    { name: "RoughnessBase", className: "MaterialExpressionConstant", properties: [float("R", 1)] },
    { name: "Roughness", className: "MaterialExpressionMultiply", properties: [input("A", 12), input("B", 14)] },
    { name: "RoughnessScale", className: "MaterialExpressionScalarParameter", properties: [prop("ParameterName", "NameProperty", "RoughnessScale"), float("DefaultValue", 0.3)] },
    { name: "OpaqueNormal", className: "MaterialExpressionMaterialFunctionCall", properties: [prop("MaterialFunction", "ObjectProperty", "/Game/Kit/NormalFlatten")] },
  ], ["/Game/Kit/Albedo", "/Game/Kit/Packed", "/Game/Kit/NormalFlatten"]);
}

export function subsetInstance(name = "Instance", roughness = 5, parent = "/Game/Kit/Master", switches?: SourceProperty[][]): Buffer {
  return materialPackage([{ name, className: "MaterialInstanceConstant", properties: [
    prop("Parent", "ObjectProperty", parent),
    prop("ScalarParameterValues", "ArrayProperty", [parameter("RoughnessScale", roughness)], { inner: "StructProperty", struct: "ScalarParameterValue" }),
    fields("StaticParameters", "StaticParameterSet", [prop("StaticSwitchParameters", "ArrayProperty", switches ?? [parameter("First", false, false), parameter("Second", true)], { inner: "StructProperty", struct: "StaticSwitchParameter" })]),
  ] }], [parent]);
}
