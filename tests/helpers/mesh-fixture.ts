import { Document, NodeIO, type Material } from "@gltf-transform/core";
import sharp from "sharp";

/**
 * A dense plate: a flat top face with `grid × grid` quads, four sides and a bottom, so a
 * preview camera has real vertical extent to frame on. An optional smooth bump on the top
 * face supplies the one fine detail the simplifier and the visual gate are asked to keep.
 */
export interface PlateOptions {
  /** Subdivisions per top-face axis. 320 gives 204,800 top triangles. */
  grid?: number;
  /** Height of a centred Gaussian bump on the top face. 0 leaves the top flat. */
  detailHeight?: number;
  /** Width of that bump, in plate units. */
  detailSigma?: number;
  /** Adds a square base-colour texture of this pixel size. */
  textureSize?: number;
}

function gaussian(x: number, z: number, height: number, sigma: number): number {
  if (height === 0) return 0;
  return height * Math.exp(-(x * x + z * z) / (2 * sigma * sigma));
}

function unit(values: [number, number, number]): [number, number, number] {
  const length = Math.hypot(...values) || 1;
  return [values[0] / length, values[1] / length, values[2] / length];
}

async function texturePng(size: number): Promise<Buffer> {
  // A gradient, not a solid colour: `prune()` legitimately folds a solid texture into a material
  // factor, and AC-5 needs a real texture to resize.
  const pixels = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 3;
      pixels[offset] = 150 + Math.floor((80 * x) / size);
      pixels[offset + 1] = 100 + Math.floor((90 * y) / size);
      pixels[offset + 2] = 60 + Math.floor((40 * x) / size);
    }
  }
  return sharp(pixels, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

export async function densePlateGlb(options: PlateOptions = {}): Promise<Uint8Array> {
  const grid = options.grid ?? 320;
  const detailHeight = options.detailHeight ?? 0;
  const detailSigma = options.detailSigma ?? 0.2;

  const sideCount = 4 * grid * 4;
  const vertexCount = (grid + 1) * (grid + 1) + sideCount + 4;
  const triangleCount = grid * grid * 2 + 4 * grid * 2 + 2;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(triangleCount * 3);

  let vertex = 0;
  let index = 0;
  const push = (
    position: [number, number, number],
    normal: [number, number, number],
    uv: [number, number],
  ): number => {
    positions.set(position, vertex * 3);
    normals.set(normal, vertex * 3);
    uvs.set(uv, vertex * 2);
    return vertex++;
  };
  const triangle = (a: number, b: number, c: number): void => {
    indices.set([a, b, c], index);
    index += 3;
  };

  const heightAt = (x: number, z: number): number => 1 + gaussian(x, z, detailHeight, detailSigma);
  const normalAt = (x: number, z: number): [number, number, number] => {
    const height = gaussian(x, z, detailHeight, detailSigma);
    if (height === 0) return [0, 1, 0];
    return unit([height * (x / (detailSigma * detailSigma)), 1, height * (z / (detailSigma * detailSigma))]);
  };

  const top: number[][] = [];
  for (let j = 0; j <= grid; j += 1) {
    const row: number[] = [];
    const z = -1 + (2 * j) / grid;
    for (let i = 0; i <= grid; i += 1) {
      const x = -1 + (2 * i) / grid;
      row.push(push([x, heightAt(x, z), z], normalAt(x, z), [i / grid, j / grid]));
    }
    top.push(row);
  }
  for (let j = 0; j < grid; j += 1) {
    for (let i = 0; i < grid; i += 1) {
      const v00 = top[j]![i]!;
      const v10 = top[j]![i + 1]!;
      const v01 = top[j + 1]![i]!;
      const v11 = top[j + 1]![i + 1]!;
      triangle(v00, v01, v11);
      triangle(v00, v11, v10);
    }
  }

  const sides: Array<{
    fixed: number;
    axis: "x" | "z";
    normal: [number, number, number];
  }> = [
    { fixed: 1, axis: "z", normal: [0, 0, 1] },
    { fixed: -1, axis: "z", normal: [0, 0, -1] },
    { fixed: 1, axis: "x", normal: [1, 0, 0] },
    { fixed: -1, axis: "x", normal: [-1, 0, 0] },
  ];
  for (const side of sides) {
    for (let i = 0; i < grid; i += 1) {
      const a = -1 + (2 * i) / grid;
      const b = -1 + (2 * (i + 1)) / grid;
      const point = (along: number, y: number): [number, number, number] =>
        side.axis === "z" ? [along, y, side.fixed] : [side.fixed, y, along];
      const topA = side.axis === "z"
        ? heightAt(a, side.fixed)
        : heightAt(side.fixed, a);
      const topB = side.axis === "z"
        ? heightAt(b, side.fixed)
        : heightAt(side.fixed, b);
      const base = vertex;
      push(point(a, 0), side.normal, [i / grid, 0]);
      push(point(b, 0), side.normal, [(i + 1) / grid, 0]);
      push(point(b, topB), side.normal, [(i + 1) / grid, 1]);
      push(point(a, topA), side.normal, [i / grid, 1]);
      triangle(base, base + 1, base + 2);
      triangle(base, base + 2, base + 3);
    }
  }

  const bottom = vertex;
  push([-1, 0, -1], [0, -1, 0], [0, 0]);
  push([1, 0, -1], [0, -1, 0], [1, 0]);
  push([1, 0, 1], [0, -1, 0], [1, 1]);
  push([-1, 0, 1], [0, -1, 0], [0, 1]);
  triangle(bottom, bottom + 1, bottom + 2);
  triangle(bottom, bottom + 2, bottom + 3);

  const document = new Document();
  const buffer = document.createBuffer();
  const primitive = document
    .createPrimitive()
    .setAttribute(
      "POSITION",
      document.createAccessor("positions").setType("VEC3").setArray(positions).setBuffer(buffer),
    )
    .setAttribute(
      "NORMAL",
      document.createAccessor("normals").setType("VEC3").setArray(normals).setBuffer(buffer),
    )
    .setAttribute(
      "TEXCOORD_0",
      document.createAccessor("uvs").setType("VEC2").setArray(uvs).setBuffer(buffer),
    )
    .setIndices(document.createAccessor("indices").setType("SCALAR").setArray(indices).setBuffer(buffer));
  const material = document
    .createMaterial("Plate")
    .setBaseColorFactor([0.85, 0.85, 0.85, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.7)
    .setDoubleSided(true);
  primitive.setMaterial(material);
  if (options.textureSize) {
    const texture = document
      .createTexture("PlateTexture")
      .setImage(new Uint8Array(await texturePng(options.textureSize)))
      .setMimeType("image/png");
    material.setBaseColorTexture(texture);
  }
  const mesh = document.createMesh("Plate").addPrimitive(primitive);
  document.createScene("Scene").addChild(document.createNode("Plate").setMesh(mesh));
  return await new NodeIO().writeBinary(document);
}

function smallBox(
  document: Document,
  buffer: ReturnType<Document["createBuffer"]>,
  material: Material,
): { positions: number[]; primitive: ReturnType<Document["createPrimitive"]> } {
  const positions = [
    -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0,
  ];
  const indices = [0, 1, 2, 0, 2, 3];
  const primitive = document
    .createPrimitive()
    .setAttribute(
      "POSITION",
      document.createAccessor("positions").setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer),
    )
    .setIndices(
      document
        .createAccessor("indices")
        .setType("SCALAR")
        .setArray(new Uint16Array(indices))
        .setBuffer(buffer),
    )
    .setMaterial(material);
  document.createMesh("Box").addPrimitive(primitive);
  return { positions, primitive };
}

function baseDocument(): { document: Document; buffer: ReturnType<Document["createBuffer"]>; material: Material } {
  const document = new Document();
  const buffer = document.createBuffer();
  const material = document.createMaterial("Box").setBaseColorFactor([0.8, 0.8, 0.8, 1]);
  return { document, buffer, material };
}

/** A one-joint skinned GLB; enough for the unsupported check, no animation. */
export async function skinnedGlb(): Promise<Uint8Array> {
  const { document, buffer, material } = baseDocument();
  const { positions, primitive } = smallBox(document, buffer, material);
  const count = positions.length / 3;
  const joints = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) weights[i * 4] = 1;
  primitive
    .setAttribute(
      "JOINTS_0",
      document.createAccessor("joints").setType("VEC4").setArray(joints).setBuffer(buffer),
    )
    .setAttribute(
      "WEIGHTS_0",
      document.createAccessor("weights").setType("VEC4").setArray(weights).setBuffer(buffer),
    );

  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const joint = document.createNode("Hips");
  const skin = document
    .createSkin("Armature")
    .addJoint(joint)
    .setSkeleton(joint)
    .setInverseBindMatrices(
      document
        .createAccessor("inverseBindMatrices")
        .setType("MAT4")
        .setArray(identity)
        .setBuffer(buffer),
    );
  const body = document.createNode("Body").setMesh(document.getRoot().listMeshes()[0]!).setSkin(skin);
  document.createScene("Scene").addChild(joint).addChild(body);
  return await new NodeIO().writeBinary(document);
}

/** A tiny GLB whose primitive carries one morph target. */
export async function morphTargetGlb(): Promise<Uint8Array> {
  const { document, buffer, material } = baseDocument();
  const { positions, primitive } = smallBox(document, buffer, material);
  const displacement = new Float32Array(positions.length);
  for (let i = 1; i < displacement.length; i += 3) displacement[i] = 0.25;
  primitive.addTarget(
    document
      .createPrimitiveTarget("Bump")
      .setAttribute(
        "POSITION",
        document.createAccessor("bump").setType("VEC3").setArray(displacement).setBuffer(buffer),
      ),
  );
  document
    .createScene("Scene")
    .addChild(document.createNode("Body").setMesh(document.getRoot().listMeshes()[0]!));
  return await new NodeIO().writeBinary(document);
}
