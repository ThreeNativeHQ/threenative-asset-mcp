// ReferenceRender.cs - the R1 reference renderer of PRD-617 (threenative-asset-mcp). Our own code, MIT with the repo.
//
// What it does: walks every prefab under Assets/, frames each one with a fixed orthographic three-quarter camera and a
// single directional light on a neutral grey background in a linear-colour-space project, and writes
//   <out>/<path under Assets without extension>.png   512 px, sRGB-encoded
//   <out>/bounds.json                                  world bounds in metres plus the model files each prefab uses
// `src/unity/fidelity.ts` (scripts/fidelity-sheet.ts --unity-reference <out>) reads both: the PNGs are the reference
// column, and the bounds check the import's sizeMeters (more than 1 % off is flagged).
//
// STATUS: UNVERIFIED. It has never been compiled or run: the machine this was written on has no Unity Editor and no
// licence. Expect to fix small compile or API drift on the first run, and record that in PRD-617. The HDRP light
// intensity in particular is a guess (see LightIntensity). The fidelity score only uses hue, saturation and silhouette
// fill, so exposure need not match, but the same constants must be used for every prefab of every pack.
//
// How to run (project of the pack's pipeline, Linear colour space in Project Settings, no -nographics):
//   1. Copy this file to <project>/Assets/Editor/ReferenceRender.cs and import the pack into the project.
//   2. xvfb-run -a Unity -batchmode -projectPath <project> -executeMethod ThreeNative.ReferenceRender.RunBatch \
//        -referenceOut <out> [-referenceMax <n>] -logFile -
//      or, in the Editor, Tools > ThreeNative > Render Reference Images (writes to <project>/ThreeNativeReference).
//   3. Copy <out> to ~/.cache/threenative-asset-mcp/unity-corpus/<id>/reference/ and keep it local: it shows licensed assets.
#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace ThreeNative
{
    public static class ReferenceRender
    {
        // ---- the fixed picture contract: change none of these per pack or per prefab ----
        const int Size = 512;
        // Camera position direction from the prefab's bounds centre. The mirror (z flipped) of the glTF tile renderer's
        // [1, 0.75, 1.2], because Unity is left-handed.
        static readonly Vector3 ViewDirection = new Vector3(1f, 0.75f, -1.2f).normalized;
        // Direction the light travels. Fixed in the world, so every prefab is lit the same way.
        static readonly Quaternion LightRotation = Quaternion.Euler(50f, 30f, 0f);
        // Built-in and URP: 1 is the default sun. HDRP uses physical units (a sun is about 3.14 lux at exposure 0); the
        // value is a guess until a first HDRP run shows the exposure, then freeze it for the whole corpus.
        const float LightIntensity = 1f;
        static readonly Color Background = new Color(0.5f, 0.5f, 0.5f, 1f); // picked (sRGB) value: 128 in the PNG
        static readonly Color Ambient = new Color(0.4f, 0.4f, 0.4f, 1f);
        const float Fit = 1.05f; // margin around the bounds' bounding sphere, as in the tile renderer

        [Serializable] class Vec { public float x, y, z; public Vec() { } public Vec(Vector3 v) { x = v.x; y = v.y; z = v.z; } }
        [Serializable] class BoundsInfo { public Vec size; public Vec center; }
        [Serializable] class Item { public string asset; public string png; public string[] models; public BoundsInfo boundsMeters; }
        [Serializable] class Output { public int version = 1; public string unit = "meter"; public List<Item> items = new List<Item>(); public List<string> skipped = new List<string>(); }

        [MenuItem("Tools/ThreeNative/Render Reference Images")]
        public static void RunFromMenu()
        {
            var output = Path.Combine(Directory.GetParent(Application.dataPath).FullName, "ThreeNativeReference");
            var count = Run(output, int.MaxValue);
            EditorUtility.DisplayDialog("ThreeNative", "Rendered " + count + " prefab(s) to " + output, "OK");
        }

        /// <summary>-executeMethod entry. Exits the Editor with 0 on success, 1 on failure, 2 on a project that is not Linear.</summary>
        public static void RunBatch()
        {
            var args = Environment.GetCommandLineArgs();
            string Arg(string name) { var at = Array.IndexOf(args, name); return at >= 0 && at + 1 < args.Length ? args[at + 1] : null; }
            var output = Arg("-referenceOut");
            if (string.IsNullOrEmpty(output)) { Debug.LogError("ReferenceRender: pass -referenceOut <dir>"); EditorApplication.Exit(1); return; }
            var max = int.TryParse(Arg("-referenceMax"), out var parsed) ? parsed : int.MaxValue;
            try
            {
                var count = Run(Path.GetFullPath(output), max);
                Debug.Log("ReferenceRender: rendered " + count + " prefab(s) to " + output);
                EditorApplication.Exit(0);
            }
            catch (InvalidOperationException error) { Debug.LogError("ReferenceRender: " + error.Message); EditorApplication.Exit(2); }
            catch (Exception error) { Debug.LogException(error); EditorApplication.Exit(1); }
        }

        static int Run(string output, int max)
        {
            if (PlayerSettings.colorSpace != ColorSpace.Linear)
                throw new InvalidOperationException("the project must use the Linear colour space (Project Settings > Player > Other Settings); a gamma project shades differently.");
            Directory.CreateDirectory(output);
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var camera = new GameObject("ReferenceCamera").AddComponent<Camera>();
            camera.orthographic = true;
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = Background;
            camera.allowHDR = false;
            camera.allowMSAA = true;
            var light = new GameObject("ReferenceLight").AddComponent<Light>();
            light.type = LightType.Directional;
            light.intensity = LightIntensity;
            light.color = Color.white;
            light.shadows = LightShadows.None;
            light.transform.rotation = LightRotation;
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
            RenderSettings.ambientLight = Ambient;
            RenderSettings.skybox = null;
            RenderSettings.fog = false;

            var result = new Output();
            var guids = AssetDatabase.FindAssets("t:Prefab", new[] { "Assets" }).OrderBy(AssetDatabase.GUIDToAssetPath, StringComparer.Ordinal).ToList();
            var rendered = 0;
            // Default read/write in a Linear project is an sRGB target: the PNG is gamma-encoded like a screenshot.
            var target = new RenderTexture(Size, Size, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.Default) { antiAliasing = 4 };
            var readback = new Texture2D(Size, Size, TextureFormat.RGB24, false);
            camera.targetTexture = target;
            try
            {
                foreach (var guid in guids)
                {
                    if (rendered >= max) break;
                    var path = AssetDatabase.GUIDToAssetPath(guid);
                    var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                    if (prefab == null) { result.skipped.Add(path + ": not loadable"); continue; }
                    var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
                    try
                    {
                        var renderers = instance.GetComponentsInChildren<Renderer>()
                            .Where(r => r is MeshRenderer || r is SkinnedMeshRenderer).ToArray();
                        if (renderers.Length == 0) { result.skipped.Add(path + ": no mesh renderer"); continue; }
                        var bounds = renderers[0].bounds;
                        foreach (var r in renderers) bounds.Encapsulate(r.bounds);
                        var radius = Mathf.Max(bounds.extents.magnitude, 0.001f);
                        camera.orthographicSize = radius * Fit;
                        camera.transform.position = bounds.center + ViewDirection * radius * 4f;
                        camera.transform.rotation = Quaternion.LookRotation(bounds.center - camera.transform.position, Vector3.up);
                        camera.nearClipPlane = radius * 0.5f;
                        camera.farClipPlane = radius * 8f;
                        camera.Render();
                        RenderTexture.active = target;
                        readback.ReadPixels(new Rect(0, 0, Size, Size), 0, 0);
                        readback.Apply(false);
                        RenderTexture.active = null;

                        var relative = path.StartsWith("Assets/", StringComparison.Ordinal) ? path.Substring("Assets/".Length) : path;
                        var png = Path.ChangeExtension(relative, ".png");
                        var file = Path.Combine(output, png);
                        Directory.CreateDirectory(Path.GetDirectoryName(file));
                        File.WriteAllBytes(file, readback.EncodeToPNG());

                        var models = renderers
                            .Select(r => r is SkinnedMeshRenderer s ? s.sharedMesh : r.GetComponent<MeshFilter>()?.sharedMesh)
                            .Where(m => m != null)
                            .Select(m => AssetDatabase.GetAssetPath(m))
                            .Where(p => !string.IsNullOrEmpty(p))
                            .Distinct().OrderBy(p => p, StringComparer.Ordinal).ToArray();
                        result.items.Add(new Item
                        {
                            asset = path,
                            png = png.Replace('\\', '/'),
                            models = models,
                            boundsMeters = new BoundsInfo { size = new Vec(bounds.size), center = new Vec(bounds.center) },
                        });
                        rendered++;
                    }
                    finally { UnityEngine.Object.DestroyImmediate(instance); }
                }
            }
            finally
            {
                camera.targetTexture = null;
                RenderTexture.active = null;
                UnityEngine.Object.DestroyImmediate(target);
                UnityEngine.Object.DestroyImmediate(readback);
            }
            File.WriteAllText(Path.Combine(output, "bounds.json"), JsonUtility.ToJson(result, true));
            return rendered;
        }
    }
}
#endif
