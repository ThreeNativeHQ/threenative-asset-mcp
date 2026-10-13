# Using imported Unreal assets in Three.js

[← Back to the README](../README.md)

Every output type loads with a stock Three.js loader. No Unreal runtime or custom `.uasset` loader is involved.

## Loading examples

Load a reconstructed level with the normal Three.js loader — no Unreal runtime
or custom `.uasset` loader is involved:

```js
new GLTFLoader().load("assets/fab/<listing>/Scenes/DemoMap.glb", ({ scene }) => {
  threeScene.add(scene);
});
```

Standalone materials use that same loader. Find a swatch by the report's
`materialAssets[].libraryName`, then assign its standard Three.js material:

```js
new GLTFLoader().load("assets/fab/<listing>/Materials/UnrealMaterialLibrary.glb", ({ scene }) => {
  const swatch = scene.getObjectByName(materialAsset.libraryName);
  targetMesh.material = swatch.material;
});
```

Sound waves use Three.js directly as well:

```js
const buffer = await new THREE.AudioLoader().loadAsync(audioAsset.file);
sound.setBuffer(buffer);
```

Structured data is ordinary runtime JSON — no Unreal object loader is needed:

```js
const table = await fetch(dataAsset.json).then((response) => response.json());
const defaultAmmo = table.Rows.Default;
```

Fonts can back Three.js canvas textures or text libraries that accept web fonts:

```js
const face = new FontFace(font.family, `url(${font.file})`, {
  style: font.fontStyle,
  weight: String(font.weight),
});
await face.load();
document.fonts.add(face);
// Draw with this family on a canvas, then pass the canvas to THREE.CanvasTexture.
```

Paper2D flipbooks reference ordinary GLBs. Select a frame using the manifest's
`frameRun` and `framesPerSecond`, then show its loaded scene:

```js
const flipbook = await fetch(report.flipbooks[0].manifest).then((response) => response.json());
const frames = await Promise.all(flipbook.frames.map((frame) => loader.loadAsync(frame.glb)));
const tick = Math.floor(elapsedSeconds * flipbook.framesPerSecond) % flipbook.frameCount;
let end = 0;
frames.forEach(({ scene }, index) => {
  end += flipbook.frames[index].frameRun;
  scene.visible = tick < end && tick >= end - flipbook.frames[index].frameRun;
});
```

Cubemaps use the standard Three.js equirectangular environment path:

```js
const loader = cubemapAsset.dynamicRange === "hdr" ? new RGBELoader() : new THREE.TextureLoader();
const environment = await loader.loadAsync(cubemapAsset.file);
environment.mapping = THREE.EquirectangularReflectionMapping;
threeScene.environment = environment;
```

Multidimensional textures use the report's explicit Three.js type:

```js
const metadata = await fetch(textureStack.manifest).then((response) => response.json());
const bytes = new Uint8Array(await fetch(textureStack.data).then((response) => response.arrayBuffer()));
const texture = metadata.threeTexture === "Data3DTexture"
  ? new THREE.Data3DTexture(bytes, metadata.width, metadata.height, metadata.depth)
  : new THREE.DataArrayTexture(bytes, metadata.width, metadata.height, metadata.depth);
texture.format = THREE.RGBAFormat;
texture.type = THREE.UnsignedByteType;
texture.needsUpdate = true;
```

Raw `RGBA16F` textures load through the package's `./data-texture` subpath. The loader
checks the manifest against the binary (exact length, SHA-256, finite samples) and refuses the
load, rather than skipping a check, when one cannot run. The source package cannot be fetched
or re-hashed in a browser, so pin the value the report gives for the texture's source package:

```js
import { loadRgba16fDataTexture } from "threenative-asset-mcp/data-texture";

const { texture, manifest } = await loadRgba16fDataTexture(
  new URL(dataTexture.manifest, reportBaseUrl),
  { expectedSourceSha256: dataTexture.sourceSha256 },
);
// texture: THREE.DataTexture, RGBAFormat, HalfFloatType, NoColorSpace, no mipmaps.
// The stored values are unchanged: negative, HDR, subnormal and alpha bits reach the shader as stored.
```

`loadRgba16fDataTexture` needs an absolute URL and `crypto.subtle`, so serve the page over
https or from localhost. Its limit is the import's: the texture holds linear half-float
samples with no decoding, so a material must decide what they mean.
