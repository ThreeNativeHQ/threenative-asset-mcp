import type { Document, Node } from "@gltf-transform/core";

/**
 * Unreal gameplay data the CUE4Parse adapter extracts per package (PRD-582): sockets, static-mesh
 * simple collision, PhysicsAsset bodies and constraints, and SoundCue graphs. The adapter writes the
 * raw Unreal-space values to `Gameplay/<package>.json` and `Audio/<cue>.cue.json`; this module turns
 * them into glTF nodes, `extras`, and metre-scale sidecars.
 *
 * Every value the adapter writes is in Unreal's native frame: centimetres, left-handed Z-up, and
 * `FRotator` degrees. The conversion to glTF matches the converter's own bone writer
 * (`CUE4Parse-Conversion/Writers/Gltf/Gltf.cs`): `SwapYZ` a position to `(x, z, y)` and multiply by
 * `UnitScale` 0.01, and swap a quaternion to `(x, z, y, -w)`. `FRotator::Quaternion` is the scalar
 * formula from `UnrealMath.cpp` (`Engine/Source/Runtime/Core/Private/Math/UnrealMath.cpp`).
 */

export type Vec3 = readonly [number, number, number];
/** Unreal `FRotator` in degrees: `[pitch, yaw, roll]` (pitch about Y, yaw about Z, roll about X). */
export type Rotator = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export interface RawSocket {
  readonly name: string;
  readonly bone?: string;
  readonly source?: "skeleton" | "mesh";
  readonly location: Vec3;
  readonly rotation: Rotator;
  readonly scale: Vec3;
  readonly tag?: string;
}

export type RawCollisionShape =
  | { readonly type: "sphere"; readonly name?: string; readonly center: Vec3; readonly radius: number }
  | { readonly type: "box"; readonly name?: string; readonly center: Vec3; readonly rotation: Rotator; readonly x: number; readonly y: number; readonly z: number }
  | { readonly type: "capsule"; readonly name?: string; readonly center: Vec3; readonly rotation: Rotator; readonly radius: number; readonly length: number; readonly radius0?: number; readonly radius1?: number }
  | { readonly type: "convex"; readonly name?: string; readonly center: Vec3; readonly rotation: Rotator; readonly vertices: readonly Vec3[]; readonly indices: readonly number[]; readonly scale?: Vec3 };

export interface RawCollision {
  readonly traceFlag?: string;
  readonly profile?: string;
  readonly shapes: readonly RawCollisionShape[];
}

export interface RawBody {
  readonly bone: string;
  readonly physicsType?: string;
  readonly traceFlag?: string;
  readonly profile?: string;
  readonly damping?: { readonly linear?: number; readonly angular?: number };
  readonly shapes: readonly RawCollisionShape[];
}

/** One `FConstraintDrive`: spring/force parameters and the two enable bits. */
export interface RawConstraintDrive {
  readonly stiffness?: number;
  readonly damping?: number;
  readonly maxForce?: number;
  readonly positionDrive?: boolean;
  readonly velocityDrive?: boolean;
}

/**
 * A constraint's decoded drives in glTF space. The linear targets are lengths, so both become metres
 * and glTF axes; the angular orientation target converts like a bone rotation, and the angular
 * velocity target is in revolutions per second (a rate, not a length) so only its basis changes. The
 * scalar `FConstraintDrive` parameters (stiffness, damping, maxForce) keep Unreal's own force or
 * acceleration units and are not converted.
 */
export interface ConvertedConstraintDrives {
  readonly linear?: {
    /** Target position in metres, glTF axes. */
    readonly positionTarget?: Vec3;
    /** Target velocity in metres per second, glTF axes. */
    readonly velocityTarget?: Vec3;
    readonly x?: RawConstraintDrive;
    readonly y?: RawConstraintDrive;
    readonly z?: RawConstraintDrive;
    readonly accelerationMode?: boolean;
  };
  readonly angular?: {
    /** Target orientation relative to the body reference frame, as a glTF quaternion. */
    readonly orientationTarget?: Quat;
    /** Target angular velocity in revolutions per second, glTF axes. */
    readonly angularVelocityTarget?: Vec3;
    readonly swing?: RawConstraintDrive;
    readonly twist?: RawConstraintDrive;
    readonly slerp?: RawConstraintDrive;
    readonly mode?: string;
    readonly accelerationMode?: boolean;
  };
}

/** The decoded `FLinearDriveConstraint` and `FAngularDriveConstraint` of one constraint, in Unreal's frame. */
export interface RawConstraintDrives {
  readonly linear?: {
    readonly positionTarget?: Vec3;
    readonly velocityTarget?: Vec3;
    readonly x?: RawConstraintDrive;
    readonly y?: RawConstraintDrive;
    readonly z?: RawConstraintDrive;
    readonly accelerationMode?: boolean;
  };
  readonly angular?: {
    readonly orientationTarget?: Rotator;
    readonly angularVelocityTarget?: Vec3;
    readonly swing?: RawConstraintDrive;
    readonly twist?: RawConstraintDrive;
    readonly slerp?: RawConstraintDrive;
    readonly mode?: string;
    readonly accelerationMode?: boolean;
  };
}

export interface RawConstraint {
  readonly child: string;
  readonly parent: string;
  readonly childFrame: { readonly location: Vec3; readonly primaryAxis: Vec3; readonly secondaryAxis: Vec3 };
  readonly parentFrame: { readonly location: Vec3; readonly primaryAxis: Vec3; readonly secondaryAxis: Vec3 };
  readonly swing1Deg?: number;
  readonly swing2Deg?: number;
  readonly twistDeg?: number;
  readonly linearLimit?: number;
  readonly motions?: { readonly linear?: readonly string[]; readonly swing1?: string; readonly swing2?: string; readonly twist?: string };
  readonly drives?: RawConstraintDrives;
  readonly disableCollision?: boolean;
}

export interface RawPhysics {
  readonly asset: string;
  readonly bodies: readonly RawBody[];
  readonly constraints: readonly RawConstraint[];
  readonly collisionDisabledPairs: readonly (readonly [number, number])[];
  /** Sub-exports the adapter could not load; reported rather than silently dropped. */
  readonly missingBodies?: number;
  readonly missingConstraints?: number;
}

export interface RawCueNode {
  readonly type: string;
  readonly params?: Readonly<Record<string, string | number | boolean>>;
  readonly children?: readonly RawCueNode[];
}

export interface RawCue {
  readonly name: string;
  readonly volume?: number;
  readonly pitch?: number;
  readonly attenuation?: { readonly asset?: string; readonly overridden?: boolean };
  readonly root: RawCueNode | null;
}

export interface RawGameplaySidecar {
  readonly version: number;
  readonly package?: string;
  readonly skeletalSockets?: readonly RawSocket[];
  readonly staticSockets?: readonly RawSocket[];
  readonly collision?: RawCollision;
  readonly physicsAssetRef?: string;
  /** The skeletal mesh's skeleton as a canonical package path (`/Game/A/SK_Hero`), for clip provenance. */
  readonly skeletonRef?: string;
  readonly physics?: RawPhysics;
}

/** A socket already in glTF space, ready to become a node. */
export interface ConvertedSocket {
  readonly name: string;
  readonly bone?: string;
  readonly source?: "skeleton" | "mesh";
  readonly tag?: string;
  readonly translation: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

export interface ConvertedShape {
  readonly type: RawCollisionShape["type"];
  readonly name?: string;
  readonly center: Vec3;
  readonly rotation: Quat;
  readonly radius?: number;
  /** A tapered capsule keeps its two end radii rather than one averaged radius. */
  readonly radius0?: number;
  readonly radius1?: number;
  readonly halfHeight?: number;
  readonly size?: Vec3;
  readonly vertices?: readonly Vec3[];
  readonly indices?: readonly number[];
  /** Anything this conversion could not reproduce exactly, so a consumer never reads a wrong shape silently. */
  readonly limitations?: readonly string[];
}

export interface ConvertedCollision {
  readonly traceFlag?: string;
  readonly profile?: string;
  readonly shapes: readonly ConvertedShape[];
}

/** A physics asset body with its shapes in metres and glTF space. */
export interface ConvertedPhysicsBody {
  readonly bone: string;
  readonly physicsType?: string;
  readonly traceFlag?: string;
  readonly profile?: string;
  readonly damping?: { readonly linear?: number; readonly angular?: number };
  readonly shapes: readonly ConvertedShape[];
}

/** A constraint frame: position plus the orthogonal primary/secondary axes, in glTF space and metres. */
export interface ConvertedConstraintFrame {
  readonly location: Vec3;
  readonly primaryAxis: Vec3;
  readonly secondaryAxis: Vec3;
}

export interface ConvertedConstraint {
  readonly child: string;
  readonly parent: string;
  readonly childFrame: ConvertedConstraintFrame;
  readonly parentFrame: ConvertedConstraintFrame;
  readonly swing1Deg?: number;
  readonly swing2Deg?: number;
  readonly twistDeg?: number;
  readonly linearLimit?: number;
  readonly motions?: RawConstraint["motions"];
  readonly drives?: ConvertedConstraintDrives;
  readonly disableCollision?: boolean;
}

export interface ConvertedPhysics {
  readonly asset: string;
  readonly bodies: readonly ConvertedPhysicsBody[];
  readonly constraints: readonly ConvertedConstraint[];
  readonly collisionDisabledPairs: readonly (readonly [number, number])[];
  readonly missingBodies?: number;
  readonly missingConstraints?: number;
}

/** The result of attaching one package's gameplay data to its glTF document. */
export interface AttachedGameplay {
  readonly sockets: readonly string[];
  readonly missingBones: readonly string[];
  readonly collision?: ConvertedCollision;
  /** Physics-asset bodies whose bone no joint in the GLB matched, when a physics asset was attached. */
  readonly physicsMissingBones: readonly string[];
  /** The physics asset name written to the mesh node's extras, when one was attached. */
  readonly physicsAsset?: string;
}

function assertVec3(value: unknown, what: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => typeof component !== "number" || !Number.isFinite(component))) {
    throw new Error(`Unreal gameplay data ${what} is not three finite numbers.`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

/** Parses the adapter's `Gameplay/<package>.json`. Refuses a shape or value this build cannot convert. */
export function parseGameplaySidecar(text: string): RawGameplaySidecar {
  const parsed = JSON.parse(text) as RawGameplaySidecar;
  if (typeof parsed !== "object" || parsed === null) throw new Error("Unreal gameplay data is not an object.");
  if (parsed.version !== 1) throw new Error(`Unreal gameplay data has unsupported version ${String(parsed.version)}.`);
  for (const [key, list] of [
    ["skeletalSockets", parsed.skeletalSockets],
    ["staticSockets", parsed.staticSockets],
  ] as const) {
    for (const socket of list ?? []) {
      if (typeof socket.name !== "string" || socket.name.length === 0) throw new Error(`Unreal gameplay data ${key} holds a socket with no name.`);
      assertVec3(socket.location, `${key} ${socket.name} location`);
      assertVec3(socket.rotation, `${key} ${socket.name} rotation`);
      assertVec3(socket.scale, `${key} ${socket.name} scale`);
    }
  }
  if (parsed.collision) for (const shape of parsed.collision.shapes) assertShape(shape);
  if (parsed.physics) for (const body of parsed.physics.bodies) for (const shape of body.shapes) assertShape(shape);
  return parsed;
}

function assertShape(shape: RawCollisionShape): void {
  if (shape.type === "sphere") {
    assertVec3(shape.center, "sphere center");
    if (!Number.isFinite(shape.radius)) throw new Error("Unreal gameplay data sphere has a non-finite radius.");
    return;
  }
  if (shape.type === "box") {
    assertVec3(shape.center, "box center");
    assertVec3(shape.rotation, "box rotation");
    if (![shape.x, shape.y, shape.z].every(Number.isFinite)) throw new Error("Unreal gameplay data box has a non-finite extent.");
    return;
  }
  if (shape.type === "capsule") {
    assertVec3(shape.center, "capsule center");
    assertVec3(shape.rotation, "capsule rotation");
    if (!Number.isFinite(shape.radius) || !Number.isFinite(shape.length)) throw new Error("Unreal gameplay data capsule has a non-finite radius or length.");
    if (shape.radius0 !== undefined && !Number.isFinite(shape.radius0)) throw new Error("Unreal gameplay data capsule has a non-finite start radius.");
    if (shape.radius1 !== undefined && !Number.isFinite(shape.radius1)) throw new Error("Unreal gameplay data capsule has a non-finite end radius.");
    return;
  }
  if (shape.type === "convex") {
    assertVec3(shape.center, "convex center");
    assertVec3(shape.rotation, "convex rotation");
    if (shape.scale !== undefined) assertVec3(shape.scale, "convex local scale");
    for (const vertex of shape.vertices) assertVec3(vertex, "convex vertex");
    for (const index of shape.indices) if (!Number.isInteger(index) || index < 0) throw new Error("Unreal gameplay data convex has an invalid index.");
    return;
  }
  throw new Error(`Unreal gameplay data holds an unknown collision shape ${(shape as { type?: unknown }).type as string}.`);
}

/** `FRotator::Quaternion` from `UnrealMath.cpp`, in Unreal's own frame. */
export function rotatorToUeQuaternion([pitch, yaw, roll]: Rotator): Quat {
  const half = (degrees: number): number => (degrees * Math.PI) / 360;
  const sp = Math.sin(half(pitch));
  const cp = Math.cos(half(pitch));
  const sy = Math.sin(half(yaw));
  const cy = Math.cos(half(yaw));
  const sr = Math.sin(half(roll));
  const cr = Math.cos(half(roll));
  return [
    cr * sp * sy - sr * cp * cy,
    -cr * sp * cy - sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
    cr * cp * cy + sr * sp * sy,
  ];
}

/** The converter's `SwapYZ(FQuat)`: `(x, z, y, -w)`. */
export function ueQuaternionToGltf(quaternion: Quat): Quat {
  const [x, y, z, w] = quaternion;
  return [x, z, y, -w];
}

/** The converter's `SwapYZ(FVector)`: `(x, z, y)`. */
export function ueVectorToGltf(vector: Vec3): Vec3 {
  const [x, y, z] = vector;
  return [x, z, y];
}

function scaleVector(vector: Vec3, scale: number | Vec3): Vec3 {
  if (typeof scale === "number") return [vector[0] * scale, vector[1] * scale, vector[2] * scale];
  return [vector[0] * scale[0], vector[1] * scale[1], vector[2] * scale[2]];
}

/**
 * The geometry scale is the same value `packageGlb` multiplies mesh positions by: a scalar, or a
 * per-glTF-axis triple. The triple is already in glTF axes, so it is never swapped again here; the
 * raw socket and shape values are Unreal axes and are swapped with `ueVectorToGltf` before scaling.
 */
function scaleFactors(scale: number | Vec3): Vec3 {
  return typeof scale === "number" ? [scale, scale, scale] : scale;
}

/** The smallest absolute component, matching Unreal's `MinScaleAbs` (`SetupNonUniformHelper`). */
function minAbs(factors: Vec3): number {
  return Math.min(Math.abs(factors[0]), Math.abs(factors[1]), Math.abs(factors[2]));
}

/**
 * A single representative factor for a scalar Unreal length under a non-uniform scale. Unreal has no
 * one answer for a scalar limit on a stretched mesh, so the smallest absolute component is used (the
 * same rule the sphere radius follows) and the caller records that the choice was made.
 */
function unitScale(factors: Vec3): number {
  return minAbs(factors);
}

/** Converts one socket's TRS to glTF space and metres. `scale` is the mesh's geometry scale (0.01 for CUE4Parse). */
export function convertSocket(socket: RawSocket, scale: number | Vec3): ConvertedSocket {
  return {
    name: socket.name,
    ...(socket.bone === undefined ? {} : { bone: socket.bone }),
    ...(socket.source === undefined ? {} : { source: socket.source }),
    ...(socket.tag === undefined ? {} : { tag: socket.tag }),
    translation: scaleVector(ueVectorToGltf(socket.location), scale),
    rotation: ueQuaternionToGltf(rotatorToUeQuaternion(socket.rotation)),
    // A relative scale is a basis change only: it is not a length, so the geometry scale never touches it.
    scale: ueVectorToGltf(socket.scale),
  };
}

/**
 * Merges the skeleton and mesh socket lists. The mesh wins on a name clash, matching
 * `USkeletalMesh::GetActiveSocketList` (skeleton sockets first, then the mesh's own).
 */
export function mergeSockets(skeleton: readonly RawSocket[], mesh: readonly RawSocket[]): RawSocket[] {
  const byName = new Map<string, RawSocket>();
  for (const socket of skeleton) byName.set(socket.name.toLowerCase(), { ...socket, source: "skeleton" });
  for (const socket of mesh) byName.set(socket.name.toLowerCase(), { ...socket, source: "mesh" });
  return [...byName.values()];
}

/**
 * Converts one simple collision element to glTF space and metres. Radii and extents follow the
 * engine's own scaling (`FKSphereElem::GetFinalScaled`, `FKBoxElem::GetFinalScaled`,
 * `FKSphylElem::GetScaledRadius` in `Engine/Private/PhysicsEngine/BodySetup.cpp`): a sphere uses the
 * smallest absolute component, a box uses each absolute component, and a capsule uses the largest of
 * its two cross-section components for the radius and its axis component for the half-length. A
 * tapered capsule keeps both radii. Absolute values are used throughout, so a negative source scale
 * never yields a negative radius or extent.
 */
export function convertShape(shape: RawCollisionShape, scale: number | Vec3): ConvertedShape {
  const factors = scaleFactors(scale);
  const center = scaleVector(ueVectorToGltf(shape.center), scale);
  const base = { type: shape.type, ...(shape.name === undefined ? {} : { name: shape.name }), center };
  if (shape.type === "sphere") {
    return { ...base, radius: Math.abs(shape.radius) * minAbs(factors), rotation: [0, 0, 0, 1] };
  }
  const rotation = ueQuaternionToGltf(rotatorToUeQuaternion(shape.rotation));
  if (shape.type === "box") {
    const size = scaleVector(ueVectorToGltf([shape.x, shape.y, shape.z]), [Math.abs(factors[0]), Math.abs(factors[1]), Math.abs(factors[2])]);
    return { ...base, rotation, size };
  }
  if (shape.type === "capsule") {
    // Under the `(x, z, y)` basis glTF x is Unreal X, glTF y is Unreal Z and glTF z is Unreal Y.
    const radiusScale = Math.max(Math.abs(factors[0]), Math.abs(factors[2]));
    const axisScale = Math.abs(factors[1]);
    const halfHeight = ((shape.length + 2 * Math.abs(shape.radius)) * axisScale) / 2;
    if (shape.radius0 !== undefined && shape.radius1 !== undefined) {
      const radius0 = Math.abs(shape.radius0) * radiusScale;
      const radius1 = Math.abs(shape.radius1) * radiusScale;
      const taperedHalfHeight = ((shape.length + Math.abs(shape.radius0) + Math.abs(shape.radius1)) * axisScale) / 2;
      return { ...base, rotation, radius: Math.max(radius0, radius1), radius0, radius1, halfHeight: taperedHalfHeight };
    }
    return { ...base, rotation, radius: Math.abs(shape.radius) * radiusScale, halfHeight };
  }
  // A convex hull's local `Transform.Scale3D` is applied to the raw vertices; the hull's rotation and
  // centre are carried separately. A non-uniform local scale combined with a non-identity hull rotation
  // is an approximation, so it is named as one.
  const localScale = shape.scale ?? [1, 1, 1];
  const nonUniformLocal = localScale[0] !== localScale[1] || localScale[1] !== localScale[2];
  // The identity quaternion may come back as (0, 0, 0, -1) after the basis swap; only the vector part decides rotation.
  const rotated = Math.abs(rotation[0]) > 1e-9 || Math.abs(rotation[1]) > 1e-9 || Math.abs(rotation[2]) > 1e-9;
  const vertices = shape.vertices.map((vertex) =>
    scaleVector(ueVectorToGltf([vertex[0] * localScale[0], vertex[1] * localScale[1], vertex[2] * localScale[2]]), factors),
  );
  return {
    ...base,
    rotation,
    vertices,
    indices: [...shape.indices],
    ...(nonUniformLocal && rotated
      ? { limitations: ["convex hull: a non-uniform local Transform.Scale3D combined with a non-identity rotation is applied axis-by-axis, not in the hull's rotated frame"] }
      : {}),
  };
}

/** Converts a simple collision block, applying `CTF_UseComplexAsSimple` (which yields no simple shapes). */
export function convertCollision(collision: RawCollision | undefined, scale: number | Vec3): ConvertedCollision | undefined {
  if (!collision) return undefined;
  if (collision.traceFlag === "CTF_UseComplexAsSimple") {
    return { ...(collision.traceFlag === undefined ? {} : { traceFlag: collision.traceFlag }), ...(collision.profile === undefined ? {} : { profile: collision.profile }), shapes: [] };
  }
  return {
    ...(collision.traceFlag === undefined ? {} : { traceFlag: collision.traceFlag }),
    ...(collision.profile === undefined ? {} : { profile: collision.profile }),
    shapes: collision.shapes.map((shape) => convertShape(shape, scale)),
  };
}

/**
 * Rebuilds a constraint frame from its position and two axes, as `FConstraintInstance::GetRefFrame`
 * does: normalize both, then orthogonalize the secondary axis against the cross product so the frame
 * is right-handed. Output is glTF space and metres.
 */
export function convertConstraintFrame(frame: RawConstraint["childFrame"], scale: number | Vec3): ConvertedConstraintFrame {
  const primary = ueVectorToGltf(normalize(frame.primaryAxis));
  const secondaryRaw = ueVectorToGltf(normalize(frame.secondaryAxis));
  const normal = normalize(cross(primary, secondaryRaw));
  const secondary = normalize(cross(normal, primary));
  return {
    location: scaleVector(ueVectorToGltf(frame.location), scale),
    primaryAxis: primary,
    secondaryAxis: secondary,
  };
}

/** Converts one constraint's drives from Unreal's frame to glTF space and metres. */
function convertDrives(drives: RawConstraintDrives | undefined, scale: number | Vec3): ConvertedConstraintDrives | undefined {
  if (!drives) return undefined;
  const linear = drives.linear;
  const angular = drives.angular;
  return {
    ...(linear === undefined
      ? {}
      : {
          linear: {
            // Position and velocity are both lengths (metres and metres per second), so each is
            // swapped into glTF axes and scaled by the geometry scale.
            ...(linear.positionTarget === undefined ? {} : { positionTarget: scaleVector(ueVectorToGltf(linear.positionTarget), scale) }),
            ...(linear.velocityTarget === undefined ? {} : { velocityTarget: scaleVector(ueVectorToGltf(linear.velocityTarget), scale) }),
            ...(linear.x === undefined ? {} : { x: linear.x }),
            ...(linear.y === undefined ? {} : { y: linear.y }),
            ...(linear.z === undefined ? {} : { z: linear.z }),
            ...(linear.accelerationMode === undefined ? {} : { accelerationMode: linear.accelerationMode }),
          },
        }),
    ...(angular === undefined
      ? {}
      : {
          angular: {
            // The orientation target is an FRotator, so it converts exactly like a bone rotation;
            // the angular velocity target is a rate in revolutions per second, so it is only swapped
            // into glTF axes and is never scaled by the geometry scale.
            ...(angular.orientationTarget === undefined ? {} : { orientationTarget: ueQuaternionToGltf(rotatorToUeQuaternion(angular.orientationTarget)) }),
            ...(angular.angularVelocityTarget === undefined ? {} : { angularVelocityTarget: ueVectorToGltf(angular.angularVelocityTarget) }),
            ...(angular.swing === undefined ? {} : { swing: angular.swing }),
            ...(angular.twist === undefined ? {} : { twist: angular.twist }),
            ...(angular.slerp === undefined ? {} : { slerp: angular.slerp }),
            ...(angular.mode === undefined ? {} : { mode: angular.mode }),
            ...(angular.accelerationMode === undefined ? {} : { accelerationMode: angular.accelerationMode }),
          },
        }),
  };
}

/** Converts a PhysicsAsset to metre-scale bodies, constraints and collision-disabled pairs. */
export function convertPhysics(physics: RawPhysics | undefined, scale: number | Vec3): ConvertedPhysics | undefined {
  if (!physics) return undefined;
  const limitFactor = unitScale(scaleFactors(scale));
  return {
    asset: physics.asset,
    bodies: physics.bodies.map((body) => ({
      bone: body.bone,
      ...(body.physicsType === undefined ? {} : { physicsType: body.physicsType }),
      ...(body.traceFlag === undefined ? {} : { traceFlag: body.traceFlag }),
      ...(body.profile === undefined ? {} : { profile: body.profile }),
      ...(body.damping === undefined ? {} : { damping: body.damping }),
      shapes: body.shapes.map((shape) => convertShape(shape, scale)),
    })),
    constraints: physics.constraints.map((constraint) => {
      const drives = convertDrives(constraint.drives, scale);
      return {
        child: constraint.child,
        parent: constraint.parent,
        childFrame: convertConstraintFrame(constraint.childFrame, scale),
        parentFrame: convertConstraintFrame(constraint.parentFrame, scale),
        ...(constraint.swing1Deg === undefined ? {} : { swing1Deg: constraint.swing1Deg }),
        ...(constraint.swing2Deg === undefined ? {} : { swing2Deg: constraint.swing2Deg }),
        ...(constraint.twistDeg === undefined ? {} : { twistDeg: constraint.twistDeg }),
        // `LinearLimit` is a centimetre length; the scalar is scaled by the smallest absolute component.
        ...(constraint.linearLimit === undefined ? {} : { linearLimit: constraint.linearLimit * limitFactor }),
        ...(constraint.motions === undefined ? {} : { motions: constraint.motions }),
        ...(drives === undefined ? {} : { drives }),
        ...(constraint.disableCollision === undefined ? {} : { disableCollision: constraint.disableCollision }),
      };
    }),
    collisionDisabledPairs: physics.collisionDisabledPairs.map((pair) => [pair[0], pair[1]] as const),
    ...(physics.missingBodies === undefined ? {} : { missingBodies: physics.missingBodies }),
    ...(physics.missingConstraints === undefined ? {} : { missingConstraints: physics.missingConstraints }),
  };
}

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(length) || length === 0) return [0, 0, 0];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** The glTF node a socket hangs under: the named joint, or the mesh node for a static socket. */
function findNode(root: ReturnType<Document["getRoot"]>, name: string): Node | undefined {
  const lower = name.toLowerCase();
  return root.listNodes().find((node) => node.getName().toLowerCase() === lower);
}

/** The node that carries the render mesh, so static sockets and collision extras land on it. */
export function findMeshNode(document: Document, meshName: string): Node | undefined {
  const root = document.getRoot();
  const named = findNode(root, meshName);
  if (named?.getMesh()) return named;
  return root.listNodes().find((node) => node.getMesh() !== null);
}

/**
 * Attaches one package's gameplay data to its glTF document: a `socket:<name>` node under each
 * socket's bone (or the mesh node for a static socket), and `extras.unrealCollision` on the mesh
 * node. Returns the socket names, the bones no joint matched, and the converted collision for the
 * caller to write as a sidecar.
 */
export function attachGameplayData(
  document: Document,
  data: RawGameplaySidecar,
  options: {
    readonly meshName: string;
    readonly geometryScale: number | Vec3;
    /** A physics asset decoded from its own package, attached to the skinned mesh node by name. */
    readonly physics?: { readonly asset: string; readonly physics: ConvertedPhysics } | undefined;
  },
): AttachedGameplay {
  const root = document.getRoot();
  const meshNode = findMeshNode(document, options.meshName);
  // The adapter tags every skeletal socket with the source it came from and may write either list
  // first. Split by source before the merge, so a mesh socket wins a name clash whichever order the
  // two sources arrive in, and no socket is relabelled by the merge.
  const skeletal = data.skeletalSockets ?? [];
  const skeletonSockets = skeletal.filter((socket) => socket.source !== "mesh");
  const meshSockets = skeletal.filter((socket) => socket.source === "mesh");
  const sockets = mergeSockets(skeletonSockets, meshSockets);
  const attached: string[] = [];
  const missingBones: string[] = [];
  for (const socket of sockets) {
    const converted = convertSocket(socket, options.geometryScale);
    const parent = socket.bone === undefined ? meshNode : findNode(root, socket.bone);
    if (!parent) {
      missingBones.push(socket.bone ?? "");
      continue;
    }
    const node = document
      .createNode(`socket:${converted.name}`)
      .setTranslation([converted.translation[0], converted.translation[1], converted.translation[2]])
      .setRotation([converted.rotation[0], converted.rotation[1], converted.rotation[2], converted.rotation[3]])
      .setScale([converted.scale[0], converted.scale[1], converted.scale[2]])
      .setExtras({
        unrealSocket: {
          name: converted.name,
          ...(converted.bone === undefined ? {} : { bone: converted.bone }),
          ...(converted.source === undefined ? {} : { source: converted.source }),
        },
      });
    parent.addChild(node);
    attached.push(converted.name);
  }
  for (const socket of data.staticSockets ?? []) {
    if (!meshNode) break;
    const converted = convertSocket(socket, options.geometryScale);
    const node = document
      .createNode(`socket:${converted.name}`)
      .setTranslation([converted.translation[0], converted.translation[1], converted.translation[2]])
      .setRotation([converted.rotation[0], converted.rotation[1], converted.rotation[2], converted.rotation[3]])
      .setScale([converted.scale[0], converted.scale[1], converted.scale[2]])
      .setExtras({ unrealSocket: { name: converted.name, ...(converted.tag === undefined ? {} : { tag: converted.tag }) } });
    meshNode.addChild(node);
    attached.push(converted.name);
  }
  const collision = convertCollision(data.collision, options.geometryScale);
  if (collision && meshNode) meshNode.setExtras({ ...(meshNode.getExtras() ?? {}), unrealCollision: collision });
  // A physics asset links to the mesh only by bone name, so every body whose bone no joint names is
  // reported rather than dropped. Descriptor-only imports keep working: an unmatched bone is data, not
  // a failure, and the asset is still referenced from the mesh node.
  const physicsMissingBones: string[] = [];
  const physics = options.physics;
  if (physics && meshNode) {
    const seen = new Set<string>();
    for (const body of physics.physics.bodies) {
      if (body.bone.length === 0 || seen.has(body.bone.toLowerCase())) continue;
      seen.add(body.bone.toLowerCase());
      if (!findNode(root, body.bone)) physicsMissingBones.push(body.bone);
    }
    meshNode.setExtras({ ...(meshNode.getExtras() ?? {}), unrealPhysicsAsset: physics.asset });
  }
  return {
    sockets: attached,
    missingBones,
    physicsMissingBones,
    ...(physics === undefined ? {} : { physicsAsset: physics.asset }),
    ...(collision === undefined ? {} : { collision }),
  };
}

/** Validates a cue graph the adapter wrote, so a malformed sidecar is reported rather than copied. */
export function parseCueSidecar(text: string): RawCue {
  const parsed = JSON.parse(text) as RawCue;
  if (typeof parsed !== "object" || parsed === null || typeof parsed.name !== "string") throw new Error("Unreal SoundCue data has no name.");
  const walk = (node: RawCueNode, depth: number): void => {
    if (depth > 256) throw new Error("Unreal SoundCue data nests deeper than 256 nodes.");
    if (typeof node.type !== "string" || node.type.length === 0) throw new Error("Unreal SoundCue data holds a node with no type.");
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  if (parsed.root) walk(parsed.root, 0);
  return parsed;
}

/** The exported audio file name a WavePlayer leaf names, from an object path like `/Game/A/SW_A.SW_A`. */
export function cueWaveObjectName(assetPath: string | undefined): string | undefined {
  if (!assetPath) return undefined;
  const last = assetPath.split("/").pop();
  if (!last) return undefined;
  const name = last.includes(".") ? last.slice(0, last.lastIndexOf(".")) : last;
  return name.length > 0 ? name : undefined;
}

/**
 * The full source package selector a WavePlayer leaf or an exported SoundWave names, for a
 * collision-free lookup: an object path like `/Game/Audio/SW_A.SW_A` and an imported package like
 * `Content/Audio/SW_A` both normalize to `audio/sw_a`. Two same-named waves in different folders
 * keep distinct selectors, so a leaf can never silently bind the wrong one.
 */
export function wavePackageSelector(assetPath: string | undefined): string | undefined {
  if (!assetPath) return undefined;
  let path = assetPath.replace(/\\/g, "/").toLowerCase();
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot > slash) path = path.slice(0, dot);
  const content = path.indexOf("/content/");
  if (path.startsWith("/game/")) path = path.slice("/game/".length);
  else if (path.startsWith("game/")) path = path.slice("game/".length);
  else if (content >= 0) path = path.slice(content + "/content/".length);
  else if (path.startsWith("/content/")) path = path.slice("/content/".length);
  else if (path.startsWith("content/")) path = path.slice("content/".length);
  else if (path.startsWith("/")) path = path.slice(1);
  return path.length > 0 ? path : undefined;
}

/** Every wave object name a cue's graph references, in walk order. */
export function cueWaveLeaves(cue: RawCue): string[] {
  const names: string[] = [];
  const walk = (node: RawCueNode): void => {
    const wave = node.params?.wave;
    if (typeof wave === "string") {
      const name = cueWaveObjectName(wave);
      if (name) names.push(name);
    }
    for (const child of node.children ?? []) walk(child);
  };
  if (cue.root) walk(cue.root);
  return names;
}

/** Every wave leaf a cue's graph resolved to an exported file, in walk order. */
export function resolvedCueWaveLeaves(cue: RawCue): string[] {
  const names: string[] = [];
  const walk = (node: RawCueNode): void => {
    if (typeof node.params?.waveExport === "string") {
      const wave = node.params.wave;
      const name = cueWaveObjectName(typeof wave === "string" ? wave : undefined);
      if (name) names.push(name);
    }
    for (const child of node.children ?? []) walk(child);
  };
  if (cue.root) walk(cue.root);
  return names;
}

/**
 * Resolves qualified wave paths only through the canonical source-package index. Missing exact
 * paths stay missing. Unqualified legacy names use a separate, lowercase unique-name index;
 * aliases never share the canonical namespace and cannot impersonate a root-level package.
 * The original soft path is retained beside any resolved `waveExport`.
 */
export function resolveCueWaves(
  cue: RawCue,
  audioByPackage: ReadonlyMap<string, string>,
  uniqueLegacyNames: ReadonlyMap<string, string> = new Map(),
): { readonly cue: RawCue; readonly missing: readonly string[] } {
  const missing: string[] = [];
  const seen = new Set<string>();
  const rewrite = (node: RawCueNode): RawCueNode => {
    const wave = node.params?.wave;
    let params = node.params;
    if (typeof wave === "string") {
      const name = cueWaveObjectName(wave);
      const selector = wavePackageSelector(wave);
      const qualified = /[/\\]/.test(wave);
      const exported = qualified
        ? selector === undefined ? undefined : audioByPackage.get(selector)
        : name === undefined ? undefined : uniqueLegacyNames.get(name.toLowerCase());
      if (name !== undefined && exported !== undefined) {
        params = { ...node.params, waveExport: exported };
      } else if (name !== undefined && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        missing.push(name);
      }
    }
    return {
      ...node,
      ...(params === undefined ? {} : { params }),
      ...(node.children === undefined ? {} : { children: node.children.map(rewrite) }),
    };
  };
  return { cue: cue.root === null ? cue : { ...cue, root: rewrite(cue.root) }, missing };
}
