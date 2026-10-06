import { z } from "zod";

const CategorySchema = z.enum([
  "3d-model",
  "animation",
  "texture",
  "hdri",
  "vfx",
  "2d",
  "ui",
  "icon",
  "font",
  "sfx",
  "music",
  "shader",
  "directory",
]);
const AccessSchema = z.enum([
  "mcp-api",
  "mcp-curated",
  "mcp-marketplace",
  "provider-page",
  "package-manager",
  "git",
]);
const DownloadSupportSchema = z.enum([
  "mcp-managed",
  "direct-url",
  "authenticated-url",
  "provider-page",
  "package-manager",
  "git",
]);
const LicenseTagSchema = z.enum([
  "cc0",
  "cc-by",
  "mit",
  "open-source",
  "per-asset",
  "marketplace",
]);

const SourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/).max(100),
  name: z.string().max(200),
  categories: z.array(CategorySchema).min(1).max(13),
  bestFor: z.string().max(1_000),
  browseUrls: z.array(z.url().max(2_048)).min(1).max(8),
  licenseSummary: z.string().max(1_000),
  licenseTags: z.array(LicenseTagSchema).min(1).max(6),
  attribution: z.string().max(1_000),
  access: AccessSchema,
  downloadSupport: DownloadSupportSchema,
  agentReady: z.boolean().describe(
    "True only when an agent can complete the download through this MCP without browser, login, checkout, or paywall interaction.",
  ),
  searchTool: z.string().optional(),
  detailTool: z.string().max(100).optional(),
  filesTool: z.string().max(100).optional(),
  downloadTool: z.string().max(100).optional(),
  downloadArgs: z.record(z.string(), z.unknown()).optional().describe(
    "Complete machine-readable arguments for a static direct download; acceptLicense must still be explicitly acknowledged by the caller.",
  ),
  installCommand: z.string().max(500).optional(),
  caution: z.string().max(1_000).optional(),
});

export type AssetSource = z.infer<typeof SourceSchema>;
type AssetSourceInput = Omit<AssetSource, "agentReady">;

const source = (value: AssetSourceInput): AssetSource =>
  SourceSchema.parse({
    ...value,
    agentReady: Boolean(
      value.downloadTool &&
        value.downloadSupport !== "provider-page" &&
        value.downloadSupport !== "authenticated-url",
    ),
  });

export const ASSET_SOURCES: readonly AssetSource[] = [
  source({
    id: "fab",
    name: "Fab",
    categories: ["3d-model", "animation", "texture", "vfx", "2d", "ui"],
    bestFor: "Marketplace assets and limited-time-free professional packs",
    browseUrls: ["https://www.fab.com/"],
    licenseSummary: "Fab Standard License or listing-specific terms",
    licenseTags: ["marketplace", "per-asset"],
    attribution: "Listing-specific",
    access: "mcp-marketplace",
    downloadSupport: "mcp-managed",
    searchTool: "fab_search_assets",
    detailTool: "fab_get_asset",
    filesTool: "fab_list_limited_time_free",
    downloadTool: "fab_download_free_asset",
    caution: "The MCP never purchases or adds assets to a library; only directly available free files are downloadable.",
  }),
  source({
    id: "polyhaven",
    name: "Poly Haven",
    categories: ["3d-model", "texture", "hdri"],
    bestFor: "High-quality realistic models, consistent PBR textures, and HDRI lighting",
    browseUrls: ["https://polyhaven.com/models", "https://polyhaven.com/textures", "https://polyhaven.com/hdris"],
    licenseSummary: "CC0",
    licenseTags: ["cc0"],
    attribution: "Asset attribution not required; visible Poly Haven credit is required when using its API",
    access: "mcp-api",
    downloadSupport: "direct-url",
    searchTool: "polyhaven_search_assets",
    detailTool: "polyhaven_get_asset",
    filesTool: "polyhaven_list_files",
    downloadTool: "asset_download_file",
  }),
  source({
    id: "ambientcg",
    name: "ambientCG",
    categories: ["3d-model", "texture", "hdri"],
    bestFor: "Large CC0 catalog of tileable PBR materials, scans, decals, terrains, and HDRIs",
    browseUrls: ["https://ambientcg.com/"],
    licenseSummary: "CC0",
    licenseTags: ["cc0"],
    attribution: "Not required",
    access: "mcp-api",
    downloadSupport: "direct-url",
    searchTool: "ambientcg_search_assets",
    detailTool: "ambientcg_get_asset",
    filesTool: "ambientcg_list_files",
    downloadTool: "asset_download_file",
  }),
  source({
    id: "smithsonian",
    name: "Smithsonian 3D Open Access",
    categories: ["3d-model"],
    bestFor: "Museum and cultural-heritage scans with direct model variants",
    browseUrls: ["https://3d.si.edu/"],
    licenseSummary: "Smithsonian Open Access; verify item-level rights before reuse",
    licenseTags: ["per-asset"],
    attribution: "Verify the item rights statement; source credit is good practice",
    access: "mcp-api",
    downloadSupport: "direct-url",
    searchTool: "smithsonian_search_assets",
    detailTool: "smithsonian_get_asset",
    filesTool: "smithsonian_list_files",
    downloadTool: "asset_download_file",
  }),
  source({
    id: "sketchfab",
    name: "Sketchfab",
    categories: ["3d-model", "animation"],
    bestFor: "Long-tail downloadable 3D models with per-model Creative Commons metadata",
    browseUrls: ["https://sketchfab.com/3d-models"],
    licenseSummary: "Per model Creative Commons license",
    licenseTags: ["per-asset", "cc-by"],
    attribution: "Per model; many downloadable models require attribution",
    access: "mcp-api",
    downloadSupport: "authenticated-url",
    searchTool: "sketchfab_search_models",
    detailTool: "sketchfab_get_model",
    filesTool: "sketchfab_get_downloads",
    caution: "Download URLs require the user's SKETCHFAB_API_TOKEN.",
  }),
  source({
    id: "quaternius",
    name: "Quaternius",
    categories: ["3d-model", "animation"],
    bestFor: "Coherent stylized model packs and universal humanoid animation libraries",
    browseUrls: [
      "https://quaternius.com/",
      "https://quaternius.com/packs/universalanimationlibrary.html",
      "https://quaternius.com/packs/universalanimationlibrary2.html",
      "https://quaternius.itch.io/universal-animation-library",
      "https://quaternius.itch.io/universal-animation-library-2",
    ],
    licenseSummary: "CC0 on the free asset packs; verify the individual pack page",
    licenseTags: ["cc0"],
    attribution: "Not required for CC0 packs",
    access: "mcp-curated",
    downloadSupport: "mcp-managed",
    detailTool: "itch_list_downloads",
    filesTool: "asset_list_bundle_animations",
    downloadTool: "asset_download_bundle_animation",
    caution: "Universal Animation Library packs contain aggregate GLBs; the MCP range-fetches only the selected GLB and can export one named animation clip instead of downloading the full ZIP.",
  }),
  source({
    id: "kaykit",
    name: "KayKit",
    categories: ["3d-model", "animation"],
    bestFor: "Coherent low-poly characters, dungeons, cities, forests, and platformer packs",
    browseUrls: ["https://kaylousberg.itch.io/"],
    licenseSummary: "Per pack; many free packs allow commercial use and several are CC0",
    licenseTags: ["per-asset", "cc0"],
    attribution: "Per pack",
    access: "mcp-curated",
    downloadSupport: "mcp-managed",
    detailTool: "itch_list_downloads",
    filesTool: "asset_list_bundle_entries",
    downloadTool: "asset_download_bundle_entry",
    caution: "The current MCP catalog covers the CC0 KayKit Platformer pack; other packs remain excluded from agent-ready search until integrated and verified.",
  }),
  source({
    id: "kenney",
    name: "Kenney Assets",
    categories: ["3d-model", "texture", "vfx", "2d", "ui", "icon", "sfx", "music"],
    bestFor: "Universal game-development packs: prototypes, UI, 2D, 3D, particles, input glyphs, and audio",
    browseUrls: ["https://kenney.nl/assets"],
    licenseSummary: "CC0 on asset pages; verify the individual pack page",
    licenseTags: ["cc0"],
    attribution: "Not required for CC0 packs",
    access: "mcp-curated",
    downloadSupport: "mcp-managed",
    searchTool: "audio_search_assets",
    downloadTool: "audio_download_asset",
    caution: "The MCP-managed catalog covers selected audio packs; the Particle Pack has its own entry. Set ASSET_ENABLE_KENNEY=1 to use asset_search, asset_get and asset_download for bounded official 3D-pack metadata and acknowledged original archives. Other categories remain provider-page workflows.",
  }),
  source({
    id: "kenney-particle-pack",
    name: "Kenney Particle Pack",
    categories: ["vfx", "2d"],
    bestFor: "Engine-neutral particle sprites, masks, and light cookies",
    browseUrls: [
      "https://kenney.nl/assets/particle-pack",
      "https://kenney.nl/media/pages/assets/particle-pack/f8fe0f8cb8-1677578741/kenney_particle-pack.zip",
    ],
    licenseSummary: "CC0",
    licenseTags: ["cc0"],
    attribution: "Not required",
    access: "mcp-curated",
    downloadSupport: "direct-url",
    downloadTool: "asset_download_file",
    downloadArgs: {
      provider: "kenney",
      url: "https://kenney.nl/media/pages/assets/particle-pack/f8fe0f8cb8-1677578741/kenney_particle-pack.zip",
      fileName: "kenney_particle-pack.zip",
      acceptLicense: true,
    },
  }),
  source({
    id: "brackeys-vfx",
    name: "Brackeys VFX Bundle",
    categories: ["vfx", "2d"],
    bestFor: "Engine-neutral fire, smoke, flash, magic, electricity, impact, and particle textures",
    browseUrls: ["https://brackeysgames.itch.io/brackeys-vfx-bundle"],
    licenseSummary: "CC0 on the bundle page; verify before use",
    licenseTags: ["cc0"],
    attribution: "Not required for CC0 material",
    access: "mcp-curated",
    downloadSupport: "mcp-managed",
    detailTool: "itch_list_downloads",
    filesTool: "asset_list_bundle_entries",
    downloadTool: "asset_download_bundle_entry",
  }),
  source({
    id: "game-icons",
    name: "Game-icons.net",
    categories: ["icon", "ui", "2d"],
    bestFor: "Thousands of customizable SVG and PNG game icons with bulk archives",
    browseUrls: [
      "https://game-icons.net/",
      "https://game-icons.net/archives/ffffff/transparent/game-icons.net.svg.zip",
    ],
    licenseSummary: "Mostly CC BY 3.0; inspect icon-specific credits",
    licenseTags: ["cc-by"],
    attribution: "Required",
    access: "mcp-curated",
    downloadSupport: "direct-url",
    downloadTool: "asset_download_file",
    downloadArgs: {
      provider: "game-icons",
      url: "https://game-icons.net/archives/ffffff/transparent/game-icons.net.svg.zip",
      fileName: "game-icons.net.svg.zip",
      acceptLicense: true,
    },
  }),
  source({
    id: "google-fonts",
    name: "Google Fonts",
    categories: ["font"],
    bestFor: "Open-source font families, variable fonts, and broad language coverage",
    browseUrls: ["https://fonts.google.com/", "https://github.com/google/fonts"],
    licenseSummary: "Open-source family-specific licenses, commonly SIL OFL",
    licenseTags: ["open-source"],
    attribution: "License-specific; retain license files",
    access: "git",
    downloadSupport: "git",
    installCommand: "git clone --filter=blob:none --sparse https://github.com/google/fonts.git",
  }),
  source({
    id: "sonniss",
    name: "Sonniss GDC Audio",
    categories: ["sfx"],
    bestFor: "Professional Foley, ambience, impacts, vehicles, weapons, monsters, and cinematic effects",
    browseUrls: ["https://gdc.sonniss.com/"],
    licenseSummary: "Sonniss GDC bundle license; commercial projects allowed and attribution not required",
    licenseTags: ["per-asset"],
    attribution: "Not required",
    access: "mcp-curated",
    downloadSupport: "mcp-managed",
    searchTool: "audio_search_assets",
    downloadTool: "audio_download_asset",
    caution: "Raw redistribution as an asset library is not allowed.",
  }),
  source({
    id: "tallbeard",
    name: "Tallbeard Music Loop Bundle",
    categories: ["music"],
    bestFor: "Large collections of seamless chiptune, ambient, action, and casual gameplay loops",
    browseUrls: ["https://tallbeard.itch.io/music-loop-bundle"],
    licenseSummary: "CC0 on the bundle page; verify the selected download",
    licenseTags: ["cc0"],
    attribution: "Not required for CC0 material",
    access: "mcp-curated",
    downloadSupport: "mcp-managed",
    detailTool: "itch_list_downloads",
    filesTool: "asset_list_bundle_entries",
    downloadTool: "asset_download_bundle_entry",
  }),
  source({
    id: "scott-buckley",
    name: "Scott Buckley Music Library",
    categories: ["music"],
    bestFor: "Cinematic, orchestral, atmospheric, and emotional music",
    browseUrls: ["https://www.scottbuckley.com.au/library/"],
    licenseSummary: "CC BY 4.0 for library tracks unless a track says otherwise",
    licenseTags: ["cc-by"],
    attribution: "Required",
    access: "provider-page",
    downloadSupport: "provider-page",
  }),
  source({
    id: "itch-io",
    name: "itch.io Free Game Assets",
    categories: ["3d-model", "animation", "texture", "vfx", "2d", "ui", "icon", "font", "sfx", "music"],
    bestFor: "Genre-specific long-tail asset packs",
    browseUrls: ["https://itch.io/game-assets/free"],
    licenseSummary: "Per pack; no site-wide license",
    licenseTags: ["per-asset", "cc0"],
    attribution: "Per pack",
    access: "provider-page",
    downloadSupport: "provider-page",
  }),
  source({
    id: "mixkit",
    name: "Mixkit",
    categories: ["sfx", "music", "vfx"],
    bestFor: "Quick individual sounds, tracks, and stock effects",
    browseUrls: ["https://mixkit.co/free-sound-effects/", "https://mixkit.co/free-stock-music/"],
    licenseSummary: "Mixkit item license",
    licenseTags: ["per-asset"],
    attribution: "Item-specific",
    access: "provider-page",
    downloadSupport: "provider-page",
  }),
  source({
    id: "pixabay",
    name: "Pixabay",
    categories: ["sfx", "music", "2d"],
    bestFor: "Fast searchable stock music, sound effects, and images",
    browseUrls: ["https://pixabay.com/sound-effects/", "https://pixabay.com/music/"],
    licenseSummary: "Pixabay Content License; verify the selected item",
    licenseTags: ["per-asset"],
    attribution: "Generally not required",
    access: "provider-page",
    downloadSupport: "provider-page",
    caution: "Some music is Content ID registered; retain download evidence and inspect item warnings.",
  }),
  source({
    id: "freesound",
    name: "Freesound",
    categories: ["sfx", "music"],
    bestFor: "Specific recordings and niche sounds",
    browseUrls: ["https://freesound.org/search/"],
    licenseSummary: "Per asset; prefer CC0 or CC BY and avoid CC BY-NC for commercial work",
    licenseTags: ["per-asset", "cc0", "cc-by"],
    attribution: "Per asset",
    access: "provider-page",
    downloadSupport: "provider-page",
  }),
  source({
    id: "opengameart",
    name: "OpenGameArt",
    categories: ["3d-model", "texture", "vfx", "2d", "ui", "icon", "font", "sfx", "music"],
    bestFor: "Game-ready loops, chiptunes, RPG assets, sprites, and unusual effects",
    browseUrls: ["https://opengameart.org/"],
    licenseSummary: "Per asset; use the CC0 filter unless intentionally managing attribution or share-alike",
    licenseTags: ["per-asset", "cc0", "cc-by"],
    attribution: "Per asset",
    access: "provider-page",
    downloadSupport: "provider-page",
  }),
  source({
    id: "abstraction",
    name: "Abstraction Music",
    categories: ["music"],
    bestFor: "Loopable game music and game-jam tracks",
    browseUrls: ["https://abstractionmusic.com/"],
    licenseSummary: "Per release",
    licenseTags: ["per-asset"],
    attribution: "Per release",
    access: "provider-page",
    downloadSupport: "provider-page",
  }),
  source({
    id: "threejs-examples",
    name: "Three.js Shader Examples",
    categories: ["shader", "vfx"],
    bestFor: "Water, ocean, sky, lava, post-processing, and procedural material references for ThreeNative",
    browseUrls: ["https://threejs.org/examples/", "https://github.com/mrdoob/three.js"],
    licenseSummary: "Three.js MIT license; inspect individual file headers and imported implementations",
    licenseTags: ["mit", "open-source"],
    attribution: "Retain license and relevant source comments",
    access: "package-manager",
    downloadSupport: "package-manager",
    installCommand: "npm install three",
  }),
  source({
    id: "threejs-shader-materials",
    name: "threejs-shader-materials",
    categories: ["shader"],
    bestFor: "Reusable Three.js shader materials",
    browseUrls: ["https://github.com/MasatoMakino/threejs-shader-materials"],
    licenseSummary: "MIT; verify repository and individual assets",
    licenseTags: ["mit", "open-source"],
    attribution: "Retain the MIT license",
    access: "git",
    downloadSupport: "git",
    installCommand: "git clone https://github.com/MasatoMakino/threejs-shader-materials.git",
  }),
  source({
    id: "glslify",
    name: "glslify",
    categories: ["shader"],
    bestFor: "Composable GLSL modules for noise, fog, easing, lighting, and raymarching",
    browseUrls: ["https://github.com/glslify/glslify"],
    licenseSummary: "glslify is MIT; each installed GLSL module has its own license",
    licenseTags: ["mit", "open-source", "per-asset"],
    attribution: "Module-specific",
    access: "package-manager",
    downloadSupport: "package-manager",
    installCommand: "npm install glslify",
  }),
  source({
    id: "three-custom-shader-material",
    name: "Three Custom Shader Material",
    categories: ["shader"],
    bestFor: "Extending standard Three.js materials without replacing the lighting shader",
    browseUrls: ["https://github.com/FarazzShaikh/THREE-CustomShaderMaterial"],
    licenseSummary: "MIT",
    licenseTags: ["mit", "open-source"],
    attribution: "Retain the MIT license",
    access: "package-manager",
    downloadSupport: "package-manager",
    installCommand: "npm install three-custom-shader-material",
  }),
  source({
    id: "godot-shaders",
    name: "Godot Shaders",
    categories: ["shader", "vfx"],
    bestFor: "Browsable Godot shader implementations",
    browseUrls: ["https://godotshaders.com/"],
    licenseSummary: "Per shader: CC0, MIT, or GPLv3; prefer CC0/MIT for closed-source commercial games",
    licenseTags: ["per-asset", "cc0", "mit"],
    attribution: "Per shader",
    access: "provider-page",
    downloadSupport: "provider-page",
  }),
  source({
    id: "unity-shader-graph-samples",
    name: "Unity Shader Graph Samples",
    categories: ["shader", "vfx"],
    bestFor: "Editable Unity Shader Graph reference projects",
    browseUrls: ["https://github.com/UnityTechnologies/ShaderGraph_ExampleLibrary"],
    licenseSummary: "Repository-specific Unity license",
    licenseTags: ["open-source"],
    attribution: "Retain repository license",
    access: "git",
    downloadSupport: "git",
    installCommand: "git clone https://github.com/UnityTechnologies/ShaderGraph_ExampleLibrary.git",
  }),
  source({
    id: "unity-vfx-graph-samples",
    name: "Unity Visual Effect Graph Samples",
    categories: ["vfx", "shader"],
    bestFor: "Portals, fire, holograms, trails, volumetrics, and procedural effects",
    browseUrls: ["https://github.com/Unity-Technologies/VisualEffectGraph-Samples"],
    licenseSummary: "Repository-specific Unity license",
    licenseTags: ["open-source"],
    attribution: "Retain repository license",
    access: "git",
    downloadSupport: "git",
    installCommand: "git clone https://github.com/Unity-Technologies/VisualEffectGraph-Samples.git",
  }),
  source({
    id: "unreal-niagara-examples",
    name: "Unreal Niagara Examples",
    categories: ["vfx", "shader"],
    bestFor: "Editable Unreal Niagara systems for explosions, smoke, fire, trails, lightning, and buffs",
    browseUrls: ["https://www.fab.com/"],
    licenseSummary: "Fab/Unreal listing-specific license",
    licenseTags: ["marketplace", "per-asset"],
    attribution: "Listing-specific",
    access: "mcp-marketplace",
    downloadSupport: "provider-page",
    searchTool: "fab_search_assets",
    caution: "Acquisition normally requires an Epic account; this MCP does not automate sign-in or purchase/library flows.",
  }),
  source({
    id: "awesome-cc0",
    name: "Awesome CC0",
    categories: ["directory"],
    bestFor: "Long-tail discovery across public-domain asset libraries",
    browseUrls: ["https://github.com/madjin/awesome-cc0"],
    licenseSummary: "Directory entries vary; verify each linked source despite the CC0 focus",
    licenseTags: ["cc0", "per-asset"],
    attribution: "Per linked source",
    access: "git",
    downloadSupport: "git",
    installCommand: "git clone https://github.com/madjin/awesome-cc0.git",
  }),
] as const;

function successResult<T extends Record<string, unknown>>(output: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function errorResult() {
  const safe = {
    code: "ASSET_SOURCE_INVALID_INPUT",
    message: "The asset source query is invalid.",
    retryable: false,
  };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(safe) }],
  };
}

export const AssetListSourcesInputSchema = z.object({
  agentReadyOnly: z.boolean().default(true),
});
export const AssetSourceListOutputSchema = z.object({
  sources: z.array(SourceSchema).max(100),
  total: z.number().int().nonnegative(),
});

export function createAssetListSourcesHandler() {
  return async (rawInput: z.input<typeof AssetListSourcesInputSchema>) => {
    try {
      const input = AssetListSourcesInputSchema.parse(rawInput);
      const sources = input.agentReadyOnly
        ? ASSET_SOURCES.filter((source) => source.agentReady)
        : [...ASSET_SOURCES];
      return successResult(
        AssetSourceListOutputSchema.parse({
          sources,
          total: sources.length,
        }),
      );
    } catch {
      return errorResult();
    }
  };
}

export const AssetSearchSourcesInputSchema = z.object({
  query: z.string().trim().max(200).optional(),
  category: z.union([z.literal("all"), CategorySchema]).default("all"),
  access: z.union([z.literal("all"), AccessSchema]).default("all"),
  license: z.union([z.literal("all"), LicenseTagSchema]).default("all"),
  agentReadyOnly: z.boolean().default(true),
});

export function createAssetSearchSourcesHandler() {
  return async (rawInput: z.input<typeof AssetSearchSourcesInputSchema>) => {
    try {
      const input = AssetSearchSourcesInputSchema.parse(rawInput);
      const query = input.query?.toLocaleLowerCase();
      const sources = ASSET_SOURCES.filter((candidate) => {
        const haystack = [
          candidate.id,
          candidate.name,
          candidate.bestFor,
          candidate.licenseSummary,
          ...candidate.categories,
        ]
          .join(" ")
          .toLocaleLowerCase();
        return (
          (!input.agentReadyOnly || candidate.agentReady) &&
          (!query || haystack.includes(query)) &&
          (input.category === "all" || candidate.categories.includes(input.category)) &&
          (input.access === "all" || candidate.access === input.access) &&
          (input.license === "all" || candidate.licenseTags.includes(input.license))
        );
      });
      return successResult(
        AssetSourceListOutputSchema.parse({ sources, total: sources.length }),
      );
    } catch {
      return errorResult();
    }
  };
}
