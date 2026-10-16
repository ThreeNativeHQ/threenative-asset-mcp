/**
 * PRD-621 AC-4: does `semantic: "earshot"` rank the intended description first on held-out clips?
 *
 *   AUDIO_EARSHOT_BIN=<venv>/bin/earshot npx tsx scripts/earshot-holdout.ts [--sonniss <dir>]
 *
 * Tonal cues come from Kenney interface-sounds, downloaded with the catalog client into a temp
 * directory. Sonniss serves a Cloudflare challenge to non-browser clients, so the impacts/foley,
 * mechanical and ambience families come from `--sonniss <dir>`: an unzipped Sonniss part that the
 * user downloaded in a browser. Without it only the tonal family is scored and the run exits 2.
 * Licensed clips and their names never leave the temp run: only numbers are printed.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import { AudioCatalogClient } from "../src/audio/client.js";
import { AudioInspector } from "../src/audio/inspect.js";

const FAMILIES = {
  tonal: /./,
  impact: /impact|punch|slam|thud|crash|bang|footstep|door|metal|wood/i,
  mechanical: /motor|engine|machine|gear|servo|mechanic|lever|latch|computer|thruster|laser/i,
  ambience: /ambien|wind|rain|forest|room|wave|crowd|night|cave/i,
} as const;
type Family = keyof typeof FAMILIES;
const KENNEY_EXTRA = {
  impact: "https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip",
  rpg: "https://kenney.nl/media/pages/assets/rpg-audio/8e99002d76-1677590336/kenney_rpg-audio.zip",
  scifi: "https://kenney.nl/media/pages/assets/sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip",
};
// Public-domain / CC0 field recordings from Wikimedia Commons stand in for Sonniss ambience (browser-only).
const COMMONS_AMBIENCE = [
  "Rain (1).ogg", "Rain against the window.ogg", "20090610 0 ambience.ogg", "Hemlock stream.ogg",
  "Shallow small river with stony riverbed.ogg", "1 minute at the alexa mall in berlin.ogg",
  "Indoor swimming pool hall.ogg", "Restaurant ambience.ogg", "Shopping mall less crowded.ogg",
  "Bones breaking wood fire ice crackling.ogg",
];
const AUDIO = new Set([".wav", ".ogg", ".mp3", ".flac"]);
const PER_FAMILY = { tuning: 3, holdout: 5 }; // 3 tuning clips per family, one family short is fine

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (AUDIO.has(extname(entry.name).toLowerCase())) out.push(full);
  }
  return out.sort();
}

/** The pack's own file name is the description: "Metal_Door_Slam_03.wav" -> "a metal door slam sound". */
function describe(file: string): string {
  const words = basename(file, extname(file)).replace(/[_\-.]+/g, " ").replace(/\d+/g, " ").trim().replace(/\s+/g, " ");
  return `a ${words.toLowerCase()} sound`;
}

const order = (file: string) => createHash("sha256").update(basename(file)).digest("hex");

async function main(): Promise<void> {
  if (!process.env.AUDIO_EARSHOT_BIN) throw new Error("Set AUDIO_EARSHOT_BIN to the pinned earshot executable.");
  const args = process.argv.slice(2);
  const sonniss = args[args.indexOf("--sonniss") + 1];
  const work = await mkdtemp(join(tmpdir(), "earshot-holdout-"));
  try {
    const client = new AudioCatalogClient({ downloadDir: join(work, "dl") });
    const kenney = await client.downloadAsset("kenney-interface-sounds");
    const kenneyDir = join(work, "kenney");
    execFileSync("unzip", ["-q", kenney.path, "-d", kenneyDir]);

    const pools: Record<Family, string[]> = { tonal: await walk(kenneyDir), impact: [], mechanical: [], ambience: [] };
    // CC0 Kenney packs stand in for the Sonniss families they cover (Sonniss is browser-only).
    for (const [name, url] of Object.entries(KENNEY_EXTRA)) {
      const zip = join(work, `${name}.zip`);
      await writeFile(zip, Buffer.from(await (await fetch(url)).arrayBuffer()));
      const dir = join(work, name);
      execFileSync("unzip", ["-q", zip, "-d", dir]);
      const all = await walk(dir);
      for (const family of ["impact", "mechanical"] as const) pools[family].push(...all.filter((f) => FAMILIES[family].test(f)));
    }
    const ambienceDir = join(work, "ambience");
    await mkdir(ambienceDir);
    for (const title of COMMONS_AMBIENCE) {
      const response = await fetch(`https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(title)}`, {
        headers: { "User-Agent": "threenative-asset-mcp-holdout/1 (https://github.com/ThreeNativeHQ)" },
      });
      if (response.ok) await writeFile(join(ambienceDir, title), Buffer.from(await response.arrayBuffer()));
    }
    pools.ambience = await walk(ambienceDir);
    if (sonniss !== undefined && args.includes("--sonniss")) {
      const all = await walk(sonniss);
      for (const family of ["impact", "mechanical", "ambience"] as const) {
        pools[family] = all.filter((file) => FAMILIES[family].test(file));
      }
    }
    const clips = Object.entries(pools).flatMap(([family, files]) => {
      const sorted = [...new Set(files.map((f) => f))].sort((a, b) => order(a).localeCompare(order(b)));
      const tuning = sorted.slice(0, PER_FAMILY.tuning).map((file) => ({ family, file, split: "tuning" }));
      const holdout = sorted.slice(PER_FAMILY.tuning, PER_FAMILY.tuning + PER_FAMILY.holdout).map((file) => ({ family, file, split: "holdout" }));
      return [...tuning, ...holdout];
    });

    const inspector = new AudioInspector({ audioDir: join(work, "cache"), inspectRoots: [work, ...(sonniss ? [sonniss] : [])] });
    const descriptions = clips.map((clip) => describe(clip.file));
    const rows = [];
    for (const [index, clip] of clips.entries()) {
      const others = clips.map((c, i) => ({ c, i })).filter(({ c, i }) => c.family !== clip.family && i !== index);
      const alternativePrompts = [...new Set(others.filter((_, n) => n % Math.max(1, Math.floor(others.length / 2)) === 0).map(({ i }) => descriptions[i]!))]
        .filter((d) => d !== descriptions[index])
        .slice(0, 2);
      if (alternativePrompts.length === 0) alternativePrompts.push("a dog barking");
      const result = await inspector.inspect({
        path: clip.file, loop: false, semantic: "earshot", expectedPrompt: descriptions[index]!, alternativePrompts,
      });
      const first = result.semantic.ranked[0]?.text === descriptions[index];
      rows.push({ ...clip, first, fit: result.promptFit, margin: result.semantic.margin });
      console.log(`${clip.split} ${clip.family} rankedFirst=${first} fit=${result.promptFit} margin=${result.semantic.margin?.toFixed(2)}`);
    }

    // A technically clean wrong sound must take the mismatch path.
    const probe = clips.find((c) => c.split === "holdout") ?? clips[0]!;
    const wrong = await inspector.inspect({
      path: probe.file, loop: false, semantic: "earshot", expectedPrompt: "a dog barking", alternativePrompts: [describe(probe.file)],
    });
    const hold = rows.filter((r) => r.split === "holdout");
    const hits = hold.filter((r) => r.first).length;
    const families = new Set(hold.map((r) => r.family));
    console.log(`holdout rankedFirst ${hits}/${hold.length}, families ${[...families].join(",")}, wrong sound -> ${wrong.promptFit}`);
    const complete = hold.length >= 20 && families.size === 4;
    process.exitCode = complete && hits >= 16 && wrong.promptFit === "possible_mismatch" ? 0 : 2;
    if (!complete) console.log("INCOMPLETE: need 20 holdout clips across 4 families (add clips with --sonniss <dir>).");
  } finally {
    execFileSync("chmod", ["-R", "u+w", work]); // unzip keeps read-only modes from the archive
    await rm(work, { recursive: true, force: true });
  }
}

await main();
