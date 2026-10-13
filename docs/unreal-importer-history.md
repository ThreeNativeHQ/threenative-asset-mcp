# Unreal importer version notes

[← Back to the README](../README.md)

What each importer version changed in material and texture handling.

## Version notes

Importer version 49 also respects material-instance override flags and modern
parameter names. Contradictory texture samples duplicated across distinct mesh
section families are repaired only when referenced texture families are
unambiguous in the same export namespace. These bindings remain heuristic.
Separate same-resolution opacity maps can supply base-colour alpha without
altering RGB; different source dimensions are currently unsupported. Existing
cached conversions are invalidated. A textured result does not certify the
appearance of the original Unreal shader.

Importer version 51 uses adaptive PNG row filtering for composed opacity maps,
preserving the previous encoder's decoded RGBA and PNG metadata. Untouched textures
retain their original bytes; their profiles, bit depth, and metadata are not
re-encoded for storage savings.

Importer version 56 stops a colour parameter's zero alpha from becoming the base
colour factor's opacity (a `Tint` of `A=0` clipped every pixel of a masked grass
card, so the GLB drew nothing), binds a masked or translucent material's separate
opacity map (`Opacity=` or an `Other` named `*_Opacity*`) as the base colour's alpha
heuristically, and composes an opacity map of another resolution when the aspect
ratio matches. A sweep sheet tile that renders nothing although Unreal has a
thumbnail for it is recorded under the entry's `sheet.warnings`.

Importer version 58 stops a texture-parameter default from inventing a glTF slot from a
texture UE Viewer already named as another output. A parameter can exist without being
wired to its own output, so when its default texture is already the resolved `.mat`'s
Diffuse (or Normal, and so on) it is a shared placeholder, not a second live slot (Old
West - VOL 5 Town Props declared an unused `Emissive` default equal to the Fill albedo,
which painted every dark-wood model with a flat grey emissive wash). Real parameter
overrides and `.mat`-named Emissive slots still bind, a default whose texture the `.mat`
left in `Other[]` still recovers its slot by parameter name, and a `.mat` that names no
slot (the modern converter's `Other[n]` references only) still falls back to the
collected defaults.

Importer version 60 recovers the cut-out of a masked foliage card whose UE Viewer `.mat`
resolves `Opacity=` to the albedo itself, which has no alpha. When the material references a
packed `<stem>_AORO` map (AO / roughness / opacity in R / G / B) beside that albedo, the map's
blue channel becomes the base colour's alpha. Temperate Vegetation: conifer Bushes & Saplings
had every needle card render as a solid rectangle (Pine_GroundTwig_01 as a full quad with the
needle atlas painted inside it) because the mask was never applied. The binding is heuristic
and named in the section's limitations; an opaque material, an unrelated texture stem, or a
map the pack did not export is left alone.

Importer version 59 applies a material instance's base-colour tint vector even when its
parameter name carries extra words. Old West - VOL 5 Town Props overrides both
`Albedo Color Tint (Base)` (a bright global multiplier) and `Base Color Tint (Mask)` (the
dark cloth colour) on a master that tints its albedo through a mask; the exact names missed
both, so every curtain kept `baseColorFactor` [1,1,1] and rendered the untinted light-grey
albedo. When both a global base multiplier and a mask colour are overridden, the mask tint is
the surface colour that shows through. Only an instance's own override is matched broadly, so
a master's placeholder default (the master's red `Base Color Tint (Mask)`) never paints an
un-tinted instance; a lone mask tint with no global multiplier (the 03a curtain, whose editor
mesh thumbnail is the untinted albedo) is left alone, and a `RockTint`-style name with no
colour token beside `Tint` is left to the graph baker.

Importer version 57 gives a mesh the `.mat` / `.props.txt` that sit beside it when two
packages share an object name (a pack with `MI_Rock_Inst` in two folders bound one
folder's normal map to the other's meshes); with none beside the mesh the pick is named
in the section's limitations. The graph bake now evaluates `ObjectScale` (1),
`PerInstanceRandom` (0.5) and `ObjectPositionWS` (origin) as named heuristic
approximations and `SplitComponents` exactly, which lets layered cliff-rock masters bake
their colour texture instead of falling back to neutral grey. The parity S4 check no
longer lets a 90% colour share hide sections whose graph is known to carry colour.

Legacy instance sidecars without override flags retain inherited settings for
ambiguous opaque, false, and zero defaults. Their non-default values retain the
previous behavior; missing flags are reported as a material limitation.

Importer version 50 reads a bounded authored-material subset from tagged UE4
object-version 516 packages (legacy -7, UE3 864, licensee 0). Exact source paths
and closest flagged static overrides select the active branches before reduction.
Mesh-only package selection still loads needed material parents from the source
file inventory without exporting unrelated packages; lookups stay within the same
Content namespace. Mesh import-table material references resolve duplicate source
basenames by exact object path. Multiple matching references refuse source routing;
a unique basename fallback reports its unresolved mesh routing.
Reroutes, scalar constants/parameters and representable multiplication recover
scalar roughness; glTF normalization retains the raw authored value in the report.
An authored scalar replaces any earlier roughness texture contribution while
retaining its packed metallic channel. Source functions, Specular conversion,
foliage shading and unsupported sampling remain explicit limitations.

AO.R is attached only with explicit `Texture2D.SRGB=false`, a serialized linear
sampler mode (`LinearColor`, `LinearGrayscale` or `Masks`), and source coordinates
matching the sampler of the currently bound albedo. Its existing glTF coordinate
mapping is reused only after the selected albedo attaches; an incoming unrelated
base texture cannot establish that reference. Omitted Unreal defaults remain
unresolved. Unknown color
interpretation, ambiguous source paths or exported PNG basenames, nonidentity AO
multipliers and unproved UV transforms withhold AO, including earlier filename
guesses. Texture metadata is
read lazily for the selected AO candidate; unrelated large images are untouched
by the material reader. Other package profiles keep prior reconstruction with a
named source-reader limitation. Cached conversions are invalidated.

The Buffer reader is independently implemented from the tagged package, property
and native-input schemas at [CUE4Parse commit b4e9544](https://github.com/FabianFG/CUE4Parse/tree/b4e95441bcf0c975eb3adb68c0fb44c740c2cf62/CUE4Parse/UE4).
Native expression inputs require verified Core=2 and Framework=33 custom versions;
tagged instances without native inputs do not require these versions. Native
trailers and omitted class defaults are outside its scope. This subset does not
certify original Unreal appearance.
