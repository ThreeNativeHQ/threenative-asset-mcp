import type * as Three from "three";

/** Caller-supplied source metadata, not an attestation of file identity or an asset redistribution permission. */
export interface ThumbnailEnvironmentSource {
  readonly reference: string;
  readonly engine: string;
  readonly bytesSha256: string;
  readonly layout: "ue-source-longlat-rgb-f32";
  readonly radianceDecode: "ue4.19-rgbe" | "ue5.8-rgbe";
}

export interface PreparedThumbnailSourceEnvironment {
  readonly texture: Three.DataTexture;
  readonly source: ThumbnailEnvironmentSource;
  readonly rotationY: number;
  readonly intensity: number;
  readonly limitations: readonly string[];
}

/**
 * Prepare already decoded linear source radiance, never PNG/sRGB. Caller owns/disposes the texture.
 * Decode provenance is explicit: UE4.19 FromRGBE uses c/255*2^(A-128), as Three RGBELoader does;
 * UE5.8 uses (c+0.5)/256*2^(A-128). This helper preserves supplied floats without converting between those conventions.
 * Official UE 5.8 TextureCompressorModule.cpp:2169–2220 maps the source longlat to hardware cube axes;
 * with UModel (X,Z,Y), Three's inverse environment rotation must sample (-z,y,x), with source top rows flipped.
 * Set flipY before Three's automatic equirectangular PMREM conversion. Orientation is source-derived;
 * PMREM convolution and UE skylight radiometry are still approximations. No environment background is changed.
 * Self-contained for the same browser execution mechanism as the reference lighting helper.
 */
export function prepareThumbnailSourceEnvironment(
  THREE: typeof Three,
  input: { readonly width: number; readonly height: number; readonly rgb: Float32Array; readonly source: ThumbnailEnvironmentSource },
): PreparedThumbnailSourceEnvironment {
  const { width, height, rgb, source } = input;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || rgb.length !== width * height * 3) {
    throw new Error("source environment needs positive whole dimensions and exactly width*height*3 float values");
  }
  if (source.layout !== "ue-source-longlat-rgb-f32" || !["ue4.19-rgbe", "ue5.8-rgbe"].includes(source.radianceDecode) || !source.reference || !source.engine || !/^[a-f0-9]{64}$/i.test(source.bytesSha256)) {
    throw new Error("source environment needs explicit UE source longlat layout, radiance decode, reference, engine and SHA-256 provenance");
  }
  const rgba = new Float32Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const value = rgb[pixel * 3 + channel]!;
      if (!Number.isFinite(value) || value < 0) throw new Error("source environment radiance must be finite and nonnegative");
      rgba[pixel * 4 + channel] = value;
    }
    rgba[pixel * 4 + 3] = 1;
  }
  const texture = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.flipY = true;
  texture.needsUpdate = true;
  return {
    texture,
    source: { ...source },
    rotationY: Math.PI / 2,
    intensity: 1.69,
    limitations: [
      `actual ${source.engine} source cubemap on a UE 4.19.2 reference rig; asset versions may differ`,
      `radiance decoded with ${source.radianceDecode}; input floats retained without re-encoding`,
      "sky intensity 1.69 is a UE reference parameter; UE versus Three radiometric equivalence unproved",
      "Three PMREM convolution approximates UE skylight filtering; not cooked convolution parity",
    ],
  };
}

/**
 * UE 4.19.2-release b243bb66ce6eef74caac71282b566f1b39661e87, ThumbnailHelpers.cpp:33–64.
 * LightComponent/GetDirection and DirectionalLightComponent give shader L=-component forward;
 * UModel's glTF axes are (UE X, UE Z, UE Y). These directions are world-space, independent of the viewing camera.
 * The saved asset's generating editor/config and orbit are unknown. This is reference lighting, not thumbnail parity.
 *
 * Self-contained so the contact-sheet browser can execute this same function, with its own Three namespace.
 * An optional environment must already be decoded from an actual asset; its orientation and UE radiometric mapping
 * still need proof. No generated sky substitutes for that asset. Without it, retain the old hemisphere as an explicit hybrid control.
 */
export function applyThumbnailReferenceLighting(
  THREE: typeof Three,
  scene: Three.Scene,
  options: { readonly shadows?: boolean; readonly environment?: Three.Texture; readonly sourceEnvironment?: PreparedThumbnailSourceEnvironment } = {},
): {
  lights: Three.DirectionalLight[];
  primary: Three.DirectionalLight;
  place: (center: Three.Vector3, radius: number) => void;
  limitations: string[];
} {
  const source = [
    { pitch: 304.736, yaw: 39.84, intensity: 0.2 },
    { pitch: -40, yaw: -144.678, intensity: 5 },
    { pitch: 299.235, yaw: 144.993, intensity: 1 },
  ];
  const directions = source.map(({ pitch, yaw }) => {
    const p = pitch * Math.PI / 180;
    const y = yaw * Math.PI / 180;
    return new THREE.Vector3(-Math.cos(p) * Math.cos(y), -Math.sin(p), -Math.cos(p) * Math.sin(y));
  });
  const lights = source.map(({ intensity }) => {
    const light = new THREE.DirectionalLight(0xffffff, intensity);
    scene.add(light, light.target);
    return light;
  });
  const primary = lights[1]!;
  // Preserve the existing Three PCF policy on the primary only; UE shadow/transmission equivalence is unproved.
  primary.castShadow = options.shadows !== false;
  primary.shadow.mapSize.set(1024, 1024);
  primary.shadow.bias = -0.0005;
  const limitations = [
    "UE 4.19.2 reference lighting on the current camera; saved editor version/config and orbit unknown",
    "only the intensity-5 primary casts Three PCF shadows; UE shadow/transmission equivalence unproved",
  ];
  if (options.environment !== undefined && options.sourceEnvironment !== undefined) throw new Error("choose a generic or a prepared source environment");
  if (options.sourceEnvironment !== undefined) {
    scene.environment = options.sourceEnvironment.texture;
    scene.environmentRotation.y = options.sourceEnvironment.rotationY;
    scene.environmentIntensity = options.sourceEnvironment.intensity;
    limitations.push(...options.sourceEnvironment.limitations);
  } else if (options.environment !== undefined) {
    scene.environment = options.environment;
    limitations.push("supplied asset environment: orientation and UE sky intensity/response mapping unverified");
  } else {
    scene.add(new THREE.HemisphereLight(0xc2d4ea, 0x3c3c3c, 0.9));
    limitations.push("hybrid approximate hemisphere fill; authored DaylightAmbientCubemap absent, not a matching cubemap");
  }
  return {
    lights,
    primary,
    limitations,
    place(center, radius) {
      lights.forEach((light, index) => {
        light.position.copy(center).addScaledVector(directions[index]!, radius * 8);
        light.target.position.copy(center);
        light.target.updateMatrixWorld();
      });
    },
  };
}
