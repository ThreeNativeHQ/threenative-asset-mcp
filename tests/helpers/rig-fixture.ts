import { Document, NodeIO } from "@gltf-transform/core";

export function bipedPositions(armAxis: "x" | "z" = "x"): number[] {
  const points: number[] = [];
  const put = (arm: number, y: number, other: number): void => {
    if (armAxis === "x") points.push(arm, y, other);
    else points.push(other, y, arm);
  };
  for (let y = -0.1; y <= 0.45; y += 0.05) put(0.01 * Math.sin(y * 10), y, 0.01 * Math.cos(y * 10));
  put(0, 0.5, 0);
  for (let arm = 0.05; arm <= 0.5; arm += 0.05) {
    put(arm, 0.3, 0);
    put(-arm, 0.3, 0);
  }
  for (let y = -0.1; y >= -0.5; y -= 0.05) {
    put(0.1, y, 0);
    put(-0.1, y, 0);
  }
  return points;
}

export async function unriggedBipedGlb(armAxis: "x" | "z" = "x"): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document
    .createAccessor("positions")
    .setType("VEC3")
    .setArray(new Float32Array(bipedPositions(armAxis)))
    .setBuffer(buffer);
  const vertexCount = positions.getCount();
  const indices = new Uint16Array(Math.floor(vertexCount / 3) * 3);
  for (let index = 0; index < indices.length; index += 1) indices[index] = index;
  const mesh = document.createMesh("Body").addPrimitive(
    document
      .createPrimitive()
      .setAttribute("POSITION", positions)
      .setIndices(document.createAccessor("indices").setType("SCALAR").setArray(indices).setBuffer(buffer)),
  );
  document.createScene("Scene").addChild(document.createNode("Body").setMesh(mesh));
  return await new NodeIO().writeBinary(document);
}

/** Append a one-second rotation of `bone` about Z to an existing rigged GLB. */
export async function withArmSwing(glb: Uint8Array, bone: string): Promise<Uint8Array> {
  const io = new NodeIO();
  const document = await io.readBinary(glb);
  const node = document
    .getRoot()
    .listNodes()
    .find((candidate) => candidate.getName() === bone);
  if (!node) throw new Error(`fixture: the rigged model has no bone named ${bone}`);
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer();
  const half = Math.sin(Math.PI / 4);
  const input = document
    .createAccessor("swing-input")
    .setType("SCALAR")
    .setArray(new Float32Array([0, 1]))
    .setBuffer(buffer);
  const output = document
    .createAccessor("swing-output")
    .setType("VEC4")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, half, half]))
    .setBuffer(buffer);
  const sampler = document.createAnimationSampler().setInput(input).setOutput(output).setInterpolation("LINEAR");
  const channel = document.createAnimationChannel().setTargetNode(node).setTargetPath("rotation").setSampler(sampler);
  document.createAnimation("Swing").addSampler(sampler).addChannel(channel);
  return await io.writeBinary(document);
}

/**
 * A small quad skinned to one joint, with a one-second nonconstant rotation of that joint. At t=0 the
 * pose is the rest pose; at t=0.5 the quad is a 45° diamond. Used to prove the tile renderer samples a
 * clip rather than returning the bind pose.
 */
export async function skinnedSwingGlb(): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene("Scene");
  const hips = document.createNode("Hips");
  scene.addChild(hips);
  const skin = document.createSkin("Rig").addJoint(hips);
  const inverseBind = new Float32Array(16);
  inverseBind[0] = 1;
  inverseBind[5] = 1;
  inverseBind[10] = 1;
  inverseBind[15] = 1;
  skin.setInverseBindMatrices(document.createAccessor("ibm").setType("MAT4").setArray(inverseBind).setBuffer(buffer));
  const positions = document
    .createAccessor("pos")
    .setType("VEC3")
    .setArray(new Float32Array([-0.3, -0.3, 0, 0.3, -0.3, 0, 0.3, 0.3, 0, -0.3, 0.3, 0]))
    .setBuffer(buffer);
  const normals = document
    .createAccessor("nrm")
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]))
    .setBuffer(buffer);
  const joints = document
    .createAccessor("joints")
    .setType("VEC4")
    .setArray(new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
    .setBuffer(buffer);
  const weights = document
    .createAccessor("weights")
    .setType("VEC4")
    .setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]))
    .setBuffer(buffer);
  const indices = document
    .createAccessor("indices")
    .setType("SCALAR")
    .setArray(new Uint16Array([0, 1, 2, 0, 2, 3]))
    .setBuffer(buffer);
  const material = document.createMaterial("Body").setBaseColorFactor([0.45, 0.6, 0.35, 1]);
  const mesh = document.createMesh("Body").addPrimitive(
    document
      .createPrimitive()
      .setAttribute("POSITION", positions)
      .setAttribute("NORMAL", normals)
      .setAttribute("JOINTS_0", joints)
      .setAttribute("WEIGHTS_0", weights)
      .setIndices(indices)
      .setMaterial(material),
  );
  scene.addChild(document.createNode("Body").setMesh(mesh).setSkin(skin));
  const half = Math.sin(Math.PI / 4);
  const input = document.createAccessor("swing-input").setType("SCALAR").setArray(new Float32Array([0, 1])).setBuffer(buffer);
  const output = document
    .createAccessor("swing-output")
    .setType("VEC4")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, half, half]))
    .setBuffer(buffer);
  const sampler = document.createAnimationSampler().setInput(input).setOutput(output).setInterpolation("LINEAR");
  const channel = document.createAnimationChannel().setTargetNode(hips).setTargetPath("rotation").setSampler(sampler);
  document.createAnimation("Swing").addSampler(sampler).addChannel(channel);
  return await new NodeIO().writeBinary(document);
}
