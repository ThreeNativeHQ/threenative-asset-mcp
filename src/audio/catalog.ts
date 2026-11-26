export type AudioSourceId =
  | "sonniss"
  | "kenney"
  | "tallbeard"
  | "scott-buckley"
  | "itch-io"
  | "mixkit"
  | "pixabay"
  | "freesound"
  | "opengameart"
  | "abstraction"
  /** PRD-120: ThreeNative's own sounds, public seeds and the Studio cache. */
  | "threenative";

export type AudioKind = "sfx" | "music" | "mixed";
export type ProgrammaticDownload = "curated-direct" | "provider-page";

export interface AudioSource {
  id: AudioSourceId;
  name: string;
  bestFor: string;
  kinds: AudioKind[];
  browseUrls: string[];
  licenseSummary: string;
  commercialUse: string;
  attribution: string;
  programmaticDownload: ProgrammaticDownload;
  caution?: string;
}

export interface AudioCatalogAsset {
  id: string;
  sourceId: AudioSourceId;
  name: string;
  description: string;
  kind: AudioKind;
  tags: string[];
  license: string;
  commercialUse: boolean;
  attributionRequired: boolean;
  attributionText?: string;
  sourcePageUrl: string;
  downloadUrl: string;
  fileName: string;
  sizeBytes?: number;
  directDownload: true;
  redistributionAllowed: false;
}

export const AUDIO_SOURCES: readonly AudioSource[] = [
  {
    id: "sonniss",
    name: "Sonniss GDC Game Audio Bundles",
    bestFor: "Professional weapons, impacts, explosions, ambience, vehicles, Foley, and cinematic effects",
    kinds: ["sfx"],
    browseUrls: ["https://gdc.sonniss.com/", "https://gdc.sonniss.com/gdc-game-audio-bundle/"],
    licenseSummary: "Sonniss GDC bundle license; commercial projects allowed, no attribution required",
    commercialUse: "Allowed in projects; review the current bundle license before use",
    attribution: "Not required",
    programmaticDownload: "curated-direct",
    caution: "Raw files and bundles must not be redistributed as a competing asset library.",
  },
  {
    id: "kenney",
    name: "Kenney Audio",
    bestFor: "UI, pickups, impacts, arcade/gameplay sounds, and jingles",
    kinds: ["sfx", "music"],
    browseUrls: ["https://kenney.nl/assets/category:Audio"],
    licenseSummary: "CC0 (verify the individual pack page)",
    commercialUse: "Allowed for CC0 packs",
    attribution: "Not required for CC0 packs",
    programmaticDownload: "curated-direct",
  },
  {
    id: "tallbeard",
    name: "Tallbeard Studios",
    bestFor: "Large collections of seamless gameplay music loops",
    kinds: ["music"],
    browseUrls: ["https://tallbeard.itch.io/music-loop-bundle"],
    licenseSummary: "CC0 on the Music Loop Bundle page; verify the selected download",
    commercialUse: "Allowed for the CC0 bundle",
    attribution: "Not required for CC0 material",
    programmaticDownload: "provider-page",
  },
  {
    id: "scott-buckley",
    name: "Scott Buckley Music Library",
    bestFor: "Cinematic, orchestral, atmospheric, and emotional music",
    kinds: ["music"],
    browseUrls: ["https://www.scottbuckley.com.au/library/"],
    licenseSummary: "CC BY 4.0 for library tracks unless an individual track says otherwise",
    commercialUse: "Allowed with license compliance",
    attribution: "Required; retain track-specific credit details",
    programmaticDownload: "provider-page",
  },
  {
    id: "itch-io",
    name: "itch.io Free Audio Assets",
    bestFor: "Genre-specific FPS, RPG, horror, retro, UI, voice, and music packs",
    kinds: ["sfx", "music", "mixed"],
    browseUrls: ["https://itch.io/game-assets/free/tag-music", "https://itch.io/game-assets/free/tag-sound-effects"],
    licenseSummary: "Per pack; no site-wide license",
    commercialUse: "Varies per pack",
    attribution: "Varies per pack",
    programmaticDownload: "provider-page",
    caution: "Read and retain the individual pack license before downloading or using it.",
  },
  {
    id: "mixkit",
    name: "Mixkit",
    bestFor: "Quick individual sound effects and background tracks",
    kinds: ["sfx", "music"],
    browseUrls: ["https://mixkit.co/free-sound-effects/", "https://mixkit.co/free-stock-music/"],
    licenseSummary: "Mixkit item license; verify the selected item and media type",
    commercialUse: "Generally allowed under the applicable Mixkit license",
    attribution: "Generally not required for SFX; verify the item",
    programmaticDownload: "provider-page",
  },
  {
    id: "pixabay",
    name: "Pixabay Audio",
    bestFor: "Fast searchable music and sound effects",
    kinds: ["sfx", "music"],
    browseUrls: ["https://pixabay.com/sound-effects/", "https://pixabay.com/music/"],
    licenseSummary: "Pixabay Content License; verify the selected item",
    commercialUse: "Allowed as part of a larger creative work, subject to the Content License",
    attribution: "Generally not required",
    programmaticDownload: "provider-page",
    caution: "Some music is Content ID registered; retain download evidence and inspect track warnings.",
  },
  {
    id: "freesound",
    name: "Freesound",
    bestFor: "Specific recordings and niche sounds missing from broad libraries",
    kinds: ["sfx", "music"],
    browseUrls: ["https://freesound.org/search/"],
    licenseSummary: "Per asset; prefer CC0 or CC BY and avoid CC BY-NC for commercial use",
    commercialUse: "Depends on the selected Creative Commons license",
    attribution: "Required for CC BY; not required for CC0",
    programmaticDownload: "provider-page",
  },
  {
    id: "opengameart",
    name: "OpenGameArt",
    bestFor: "Game-ready loops, chiptunes, RPG music, and unusual effects",
    kinds: ["sfx", "music", "mixed"],
    browseUrls: ["https://opengameart.org/art-search?keys=music", "https://opengameart.org/art-search?keys=sound+effects"],
    licenseSummary: "Per asset; prefer CC0 for the simplest reuse",
    commercialUse: "Depends on the selected asset license",
    attribution: "Depends on the selected asset license",
    programmaticDownload: "provider-page",
  },
  {
    id: "abstraction",
    name: "Abstraction Music",
    bestFor: "Loopable game music and free game-jam tracks",
    kinds: ["music"],
    browseUrls: ["https://abstractionmusic.com/"],
    licenseSummary: "Per release; verify the selected track or collection",
    commercialUse: "Depends on the selected release",
    attribution: "Depends on the selected release",
    programmaticDownload: "provider-page",
  },
] as const;

const sonniss2026 = (part: number): AudioCatalogAsset => ({
  id: `sonniss-gdc-2026-${part}-of-5`,
  sourceId: "sonniss",
  name: `Sonniss GDC 2026 Game Audio Bundle ${part} of 5`,
  description: "One official archive from the five-part professional GDC 2026 sound-effects bundle.",
  kind: "sfx",
  tags: ["professional", "foley", "ambience", "weapons", "impacts", "cinematic", "gdc-2026"],
  license: "Sonniss GDC Game Audio Bundle License",
  commercialUse: true,
  attributionRequired: false,
  sourcePageUrl: "https://gdc.sonniss.com/",
  downloadUrl: `https://downloads.sonniss.com/Sonniss.com-GDC2026-GameAudioBundle${part}of5.zip`,
  fileName: `Sonniss.com-GDC2026-GameAudioBundle${part}of5.zip`,
  directDownload: true,
  redistributionAllowed: false,
});

export const AUDIO_ASSETS: readonly AudioCatalogAsset[] = [
  {
    id: "kenney-interface-sounds",
    sourceId: "kenney",
    name: "Kenney Interface Sounds",
    description: "100 game interface sounds in a directly downloadable CC0 ZIP archive.",
    kind: "sfx",
    tags: ["ui", "interface", "click", "menu", "gameplay", "cc0"],
    license: "CC0",
    commercialUse: true,
    attributionRequired: false,
    sourcePageUrl: "https://kenney.nl/assets/interface-sounds",
    downloadUrl: "https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip",
    fileName: "kenney_interface-sounds.zip",
    sizeBytes: 834_536,
    directDownload: true,
    redistributionAllowed: false,
  },
  {
    id: "kenney-music-jingles",
    sourceId: "kenney",
    name: "Kenney Music Jingles",
    description: "85 short game music jingles in a directly downloadable CC0 ZIP archive.",
    kind: "music",
    tags: ["jingle", "ui", "success", "failure", "gameplay", "cc0"],
    license: "CC0",
    commercialUse: true,
    attributionRequired: false,
    sourcePageUrl: "https://kenney.nl/assets/music-jingles",
    downloadUrl: "https://kenney.nl/media/pages/assets/music-jingles/f37e530b9e-1677590399/kenney_music-jingles.zip",
    fileName: "kenney_music-jingles.zip",
    sizeBytes: 1_239_525,
    directDownload: true,
    redistributionAllowed: false,
  },
  ...[1, 2, 3, 4, 5].map(sonniss2026),
] as const;
