/** Independent bounded UE4.19 tagged metadata reader. Schema references are pinned in README.
 * No native export trailer, class default or shader implementation is interpreted here. */
export interface SourceReference { readonly index: number; readonly path: string | null; readonly name?: string }
export interface SourceImport extends SourceReference { readonly className: string }
export interface SourceProperty { readonly name: string; readonly type: string; readonly arrayIndex: number; readonly value?: unknown; readonly unsupported?: string }
export interface SourceExport { readonly index: number; readonly name: string; readonly path: string; readonly className: string; readonly properties: readonly SourceProperty[] }
export type SourcePackage = { readonly status: "decoded"; readonly path: string; readonly imports: readonly SourceImport[]; readonly exports: readonly SourceExport[] } |
  { readonly status: "unsupported"; readonly path: string; readonly reason: string };

class Cursor {
  constructor(readonly bytes: Buffer, public at = 0, readonly end = bytes.length) {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(end) || at < 0 || end < at || end > bytes.length) throw new Error("Invalid source bounds");
  }
  take(size: number): Buffer {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.end - this.at) throw new Error(`Truncated material source at ${this.at}`);
    const result = this.bytes.subarray(this.at, this.at + size); this.at += size; return result;
  }
  i32(): number { return this.take(4).readInt32LE(); }
  u32(): number { return this.take(4).readUInt32LE(); }
  i64(): number { const n = Number(this.take(8).readBigInt64LE()); if (!Number.isSafeInteger(n)) throw new Error("Unsafe source integer"); return n; }
  flag(width = 1): boolean { const n = width === 1 ? this.take(1)[0] : this.i32(); if (n !== 0 && n !== 1) throw new Error("Invalid source flag"); return n === 1; }
  count(max = 100_000): number { const n = this.i32(); if (n < 0 || n > max) throw new Error("Invalid source count"); return n; }
  float(width = 4): number { const b = this.take(width); const n = width === 4 ? b.readFloatLE() : b.readDoubleLE(); if (!Number.isFinite(n)) throw new Error("Nonfinite source number"); return n; }
  string(): string {
    const n = this.i32(); if (Math.abs(n) > 1_000_000) throw new Error("Invalid source string size"); if (n === 0) return "";
    const raw = this.take(Math.abs(n) * (n < 0 ? 2 : 1)); const terminator = n < 0 ? 2 : 1;
    if (raw.subarray(raw.length - terminator).some((b) => b !== 0)) throw new Error("Unterminated source string");
    return new TextDecoder(n < 0 ? "utf-16le" : "utf-8", { fatal: true }).decode(raw.subarray(0, raw.length - terminator));
  }
}

const TAGGED_STRUCTS = new Set(["MaterialParameterInfo", "ScalarParameterValue", "VectorParameterValue", "TextureParameterValue", "MaterialInstanceBasePropertyOverrides", "StaticParameterSet", "StaticSwitchParameter", "StaticComponentMaskParameter", "StaticTerrainLayerWeightParameter", "MaterialFunctionInfo", "FunctionExpressionInput", "FunctionExpressionOutput", "ExpressionOutput", "TextureSource", "MaterialTextureInfo", "MaterialUsage", "MaterialParameterCollectionInfo", "TextureStreamingData"]);
const INPUT_STRUCTS = new Set(["ExpressionInput", "MaterialAttributesInput", "ScalarMaterialInput", "ColorMaterialInput", "VectorMaterialInput", "Vector2MaterialInput"]);
const PROPERTY_TYPES = new Set(["BoolProperty", "IntProperty", "UInt32Property", "FloatProperty", "Int64Property", "UInt64Property", "DoubleProperty", "NameProperty", "EnumProperty", "ByteProperty", "StrProperty", "ObjectProperty", "InterfaceProperty", "StructProperty", "ArrayProperty", "SetProperty", "MapProperty", "TextProperty", "SoftObjectProperty", "WeakObjectProperty", "LazyObjectProperty", "DelegateProperty", "MulticastDelegateProperty", "Int8Property", "Int16Property", "UInt16Property", "AssetObjectProperty", "AssetClassProperty"]);
class UnsupportedValue extends Error {}
interface Tag { name: string; type: string; size: number; arrayIndex: number; struct?: string; inner?: string; enum?: string; flag?: boolean }
interface ObjectRecord { name: string; outer: number; className?: string; classIndex?: number; offset?: number; size?: number }

export function decodeMaterialPackage(bytes: Buffer, path: string): SourcePackage {
  const unsupported = (reason: string): SourcePackage => ({ status: "unsupported", path, reason });
  if (bytes.length < 20 || bytes.readUInt32LE() !== 0x9e2a83c1) return unsupported("No supported Unreal material package header");
  if (bytes.readInt32LE(4) !== -7 || bytes.readInt32LE(8) !== 864 || bytes.readInt32LE(12) !== 516 || bytes.readInt32LE(16) !== 0) return unsupported("Authored material reader supports legacy -7 / UE3 864 / UE4 516 / licensee 0 only");
  if (bytes.length > 32 * 1024 * 1024) throw new Error("Supported material source exceeds 32 MiB bound");
  if (!/^\/Game\/(?:[^/.]+\/)*[^/.]+$/.test(path)) throw new Error("Invalid canonical source package path");
  const c = new Cursor(bytes, 20); const custom = new Map<string, number>();
  for (let i = c.count(1000); i > 0; i--) { const id = c.take(16).toString("hex"); if (custom.has(id)) throw new Error("Duplicate source custom version"); custom.set(id, c.i32()); }
  const nativeInputs = custom.get("3cc15e37fb48e406f08400b57e712a26") === 2 && custom.get("3f74fccf8044b043df14919373201d17") === 33;
  let unsupportedNativeInput = false;
  const headerSize = c.i32(); c.string(); const flags = c.u32();
  if (flags & (0x80000000 | 0x2000 | 0x200)) return unsupported("Filtered, cooked or unversioned source material profile unsupported");
  const nameCount = c.count(); const nameOffset = c.i32(); c.string(); c.count(); c.i32();
  const exportCount = c.count(); const exportOffset = c.i32(); const importCount = c.count(); const importOffset = c.i32(); const dependsOffset = c.i32();
  c.count(); c.take(12); c.take(16);
  for (let i = c.count(1000); i > 0; i--) { c.count(); c.count(); }
  for (let i = 0; i < 2; i++) { c.take(10); c.string(); }
  if (c.u32() !== 0 || c.count() !== 0) return unsupported("Compressed material source unsupported");
  c.u32(); for (let i = c.count(1000); i > 0; i--) c.string();
  c.i32(); c.i64(); c.i32(); for (let i = c.count(1000); i > 0; i--) c.i32(); c.take(8);
  if (c.at !== nameOffset || !(nameOffset <= importOffset && importOffset <= exportOffset && exportOffset <= dependsOffset && dependsOffset <= headerSize && headerSize <= bytes.length)) throw new Error("Invalid source summary/table boundary");
  const names: string[] = []; const n = new Cursor(bytes, nameOffset, importOffset);
  for (let i = 0; i < nameCount; i++) { names.push(n.string()); n.take(4); }
  if (n.at !== importOffset) throw new Error("Invalid source name table boundary");
  const fname = (cursor: Cursor): string => {
    const index = cursor.i32(); const number = cursor.i32(); const name = names[index];
    if (name === undefined || number < 0 || number > 1_000_000) throw new Error("Invalid source FName index");
    return name + (number ? `_${number - 1}` : "");
  };
  const imports: ObjectRecord[] = []; const exports: ObjectRecord[] = [];
  const im = new Cursor(bytes, importOffset, exportOffset);
  for (let i = 0; i < importCount; i++) { fname(im); const className = fname(im); const outer = im.i32(); imports.push({ outer, name: fname(im), className }); }
  if (im.at !== exportOffset) throw new Error("Invalid source import table boundary");
  const ex = new Cursor(bytes, exportOffset, dependsOffset); const otherIndices: number[] = [];
  for (let i = 0; i < exportCount; i++) {
    const classIndex = ex.i32(); otherIndices.push(ex.i32(), ex.i32()); const outer = ex.i32(); const name = fname(ex); ex.u32(); const size = ex.i64(); const offset = ex.i64();
    for (let j = 0; j < 3; j++) ex.flag(4); ex.take(16); ex.u32(); ex.flag(4); ex.flag(4); ex.take(20);
    if (size < 8 || offset < headerSize || size > bytes.length - offset) throw new Error("Invalid source export body range");
    exports.push({ classIndex, outer, name, size, offset });
  }
  if (ex.at !== dependsOffset) throw new Error("Invalid source export table boundary");
  const ranges = [...exports].sort((a, b) => a.offset! - b.offset!);
  for (let i = 1; i < ranges.length; i++) if (ranges[i - 1]!.offset! + ranges[i - 1]!.size! > ranges[i]!.offset!) throw new Error("Overlapping source export bodies");
  const reference = (index: number, seen = new Set<number>()): SourceReference => {
    if (index === 0) return { index, path: null };
    if (seen.has(index) || seen.size > 64) throw new Error("Source outer index cycle/depth"); seen.add(index);
    const item = index > 0 ? exports[index - 1] : imports[-index - 1]; if (!item) throw new Error(`Invalid signed source index ${index}`);
    const parent = reference(item.outer, seen).path;
    return { index, name: item.name, path: parent ? `${parent}.${item.name}` : index > 0 ? `${path}.${item.name}` : item.name };
  };
  for (const item of [...imports, ...exports]) reference(item.outer);
  for (const index of otherIndices) reference(index);
  let propertyCount = 0;
  const tag = (cursor: Cursor): Tag | undefined => {
    const name = fname(cursor); if (name === "None") return undefined;
    if (++propertyCount > 100_000) throw new Error("Source property count exceeded");
    const type = fname(cursor); const size = cursor.i32(); const arrayIndex = cursor.i32();
    if (!PROPERTY_TYPES.has(type) || size < 0 || arrayIndex < 0) throw new Error("Invalid source property tag");
    const result: Tag = { name, type, size, arrayIndex };
    if (type === "StructProperty") { result.struct = fname(cursor); cursor.take(16); }
    if (type === "BoolProperty") result.flag = cursor.flag();
    if (type === "ByteProperty" || type === "EnumProperty") result.enum = fname(cursor);
    if (type === "ArrayProperty" || type === "SetProperty" || type === "MapProperty") result.inner = fname(cursor);
    if (type === "MapProperty") fname(cursor);
    if (cursor.flag()) cursor.take(16);
    return result;
  };
  const value = (cursor: Cursor, meta: Tag, depth: number): unknown => {
    if (depth > 30) throw new Error("Source property nesting depth exceeded");
    switch (meta.type) {
      case "BoolProperty": return meta.flag ?? cursor.flag();
      case "IntProperty": return cursor.i32();
      case "UInt32Property": return cursor.u32();
      case "FloatProperty": return cursor.float();
      case "DoubleProperty": return cursor.float(8);
      case "Int64Property": return cursor.i64();
      case "UInt64Property": { const n = Number(cursor.take(8).readBigUInt64LE()); if (!Number.isSafeInteger(n)) throw new Error("Unsafe source integer"); return n; }
      case "NameProperty": case "EnumProperty": return fname(cursor);
      case "ByteProperty": return meta.enum && meta.enum !== "None" ? fname(cursor) : cursor.take(1)[0];
      case "StrProperty": return cursor.string();
      case "ObjectProperty": case "InterfaceProperty": return reference(cursor.i32());
      case "StructProperty": {
        const struct = meta.struct!;
        if (struct === "Guid") return cursor.take(16).toString("hex");
        const dimensions: Record<string, number> = { LinearColor: 4, Vector: 3, Vector2D: 2, Vector4: 4, Rotator: 3 };
        if (dimensions[struct]) return Array.from({ length: dimensions[struct]! }, () => cursor.float());
        if (struct === "Color") { const b = cursor.take(4); return { r: b[2], g: b[1], b: b[0], a: b[3] }; }
        if (struct === "IntPoint") return { x: cursor.i32(), y: cursor.i32() };
        if (INPUT_STRUCTS.has(struct)) {
          if (!nativeInputs) { unsupportedNativeInput = true; throw new UnsupportedValue("Native inputs require verified Core=2 and Framework=33 custom versions"); }
          const result: Record<string, unknown> = { Expression: reference(cursor.i32()), OutputIndex: cursor.i32(), InputName: fname(cursor) };
          if ((result.OutputIndex as number) < 0) throw new Error("Invalid source expression output index");
          for (const key of ["Mask", "MaskR", "MaskG", "MaskB", "MaskA"]) result[key] = cursor.flag(4) ? 1 : 0;
          if (struct !== "ExpressionInput" && struct !== "MaterialAttributesInput") {
            result.UseConstant = cursor.flag(4);
            const constantStruct = { ScalarMaterialInput: "", ColorMaterialInput: "Color", VectorMaterialInput: "Vector", Vector2MaterialInput: "Vector2D" }[struct]!;
            result.Constant = constantStruct ? value(cursor, { ...meta, struct: constantStruct }, depth + 1) : cursor.float();
          }
          return result;
        }
        if (TAGGED_STRUCTS.has(struct)) return properties(cursor, depth + 1);
        throw new UnsupportedValue(`Uninterpreted native struct ${struct}`);
      }
      case "ArrayProperty": {
        const count = cursor.count(); let inner: Tag = { ...meta, type: meta.inner!, size: 0 };
        if (meta.inner === "StructProperty") { const row = tag(cursor); if (!row || row.type !== "StructProperty") throw new Error("Invalid source array struct tag"); inner = row; }
        return Array.from({ length: count }, () => value(cursor, inner, depth + 1));
      }
      default: throw new UnsupportedValue(`Uninterpreted source property ${meta.type}`);
    }
  };
  const properties = (cursor: Cursor, depth = 0): SourceProperty[] => {
    if (depth > 30) throw new Error("Source property nesting depth exceeded"); const result: SourceProperty[] = []; const seen = new Set<string>();
    for (;;) {
      const meta = tag(cursor); if (!meta) return result;
      const key = `${meta.name}:${meta.arrayIndex}`; if (seen.has(key)) throw new Error(`Duplicate source property ${key}`); seen.add(key);
      if (meta.size > cursor.end - cursor.at) throw new Error("Truncated source property body");
      const body = new Cursor(bytes, cursor.at, cursor.at + meta.size); const row = { name: meta.name, type: meta.type, arrayIndex: meta.arrayIndex };
      try { const v = value(body, meta, depth + 1); if (body.at !== body.end) throw new Error("Unconsumed supported source property bytes"); result.push({ ...row, value: v }); }
      catch (error) { if (!(error instanceof UnsupportedValue)) throw error; result.push({ ...row, unsupported: error.message }); }
      cursor.take(meta.size);
    }
  };
  const decoded = exports.map((item, i): SourceExport => {
    const className = reference(item.classIndex!).name ?? ""; const object = reference(i + 1);
    const admitted = className === "Material" || className === "MaterialInstanceConstant" || className === "Texture2D" || className.startsWith("MaterialExpression");
    return { index: i + 1, name: item.name, path: object.path!, className, properties: admitted ? properties(new Cursor(bytes, item.offset!, item.offset! + item.size!)) : [] };
  });
  if (new Set(decoded.map((e) => e.path)).size !== decoded.length) throw new Error("Duplicate source object path");
  if (unsupportedNativeInput) return unsupported("Native inputs require verified Core=2 and Framework=33 custom versions");
  return { status: "decoded", path, imports: imports.map((item, i) => ({ ...reference(-i - 1), className: item.className! })), exports: decoded };
}
