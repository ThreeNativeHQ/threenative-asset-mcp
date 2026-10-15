/**
 * The Blender-side conversion, run as `blender -b --factory-startup --disable-autoexec --python <file> -- <args>`.
 * Written as a constant so it ships in `dist/` without a packaging change.
 *
 * Scale: Blender's FBX importer already multiplies by the file's UnitScaleFactor / 100 and by
 * `global_scale`, which is what Unity does with `useFileScale: 1` and `globalScale`. With
 * `useFileScale: 0` Unity ignores the file unit, so the script divides it out again.
 */
export const BLENDER_CONVERT_SCRIPT = String.raw`
import bpy, json, os, sys

args = sys.argv[sys.argv.index("--") + 1:]
source, target, global_scale, use_file_scale = args[0], args[1], float(args[2]), args[3] == "1"
extension = os.path.splitext(source)[1].lower()
info = {"fileUnitScale": None, "warnings": []}


def fbx_unit_scale(path):
    from io_scene_fbx import parse_fbx
    root, _version = parse_fbx.parse(path)
    for settings in root.elems:
        if settings.id != b"GlobalSettings":
            continue
        for properties in settings.elems:
            if properties.id != b"Properties70":
                continue
            for prop in properties.elems:
                if prop.props and prop.props[0] == b"UnitScaleFactor":
                    return float(prop.props[4])
    return None


if extension == ".blend":
    bpy.ops.wm.open_mainfile(filepath=source)
    factor = global_scale * bpy.context.scene.unit_settings.scale_length
    for obj in bpy.context.scene.objects:
        if obj.parent is None:
            obj.scale = (obj.scale.x * factor, obj.scale.y * factor, obj.scale.z * factor)
            obj.location = (obj.location.x * factor, obj.location.y * factor, obj.location.z * factor)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if extension == ".fbx":
        scale = global_scale
        try:
            info["fileUnitScale"] = fbx_unit_scale(source)
        except Exception as error:
            info["warnings"].append("could not read the FBX unit scale: %s" % error)
        if not use_file_scale:
            if info["fileUnitScale"]:
                scale = global_scale * 100.0 / info["fileUnitScale"]
            else:
                info["warnings"].append("useFileScale is off but the FBX unit scale is unknown; the file unit was applied")
        bpy.ops.import_scene.fbx(filepath=source, global_scale=scale)
    elif extension == ".obj":
        bpy.ops.wm.obj_import(filepath=source, global_scale=global_scale)
    else:
        raise RuntimeError("unsupported model extension " + extension)

if not any(obj.type == "MESH" for obj in bpy.context.scene.objects):
    raise RuntimeError("the model has no mesh")

bpy.ops.export_scene.gltf(
    filepath=target,
    export_format="GLB",
    export_apply=True,
    export_yup=True,
    export_materials="EXPORT",
    export_image_format="AUTO",
)
print("UNITY_INFO " + json.dumps(info))
`;
