// Regenerates src/procedural/catalog.json from a built @threenative/procedural-environment.
// Usage: npx tsx scripts/gen-procedural-catalog.ts <path to the package folder>
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Search words the package names do not carry. Add one when an agent asks by a common name.
const ALIASES: Record<string, string> = { "city:signal": "traffic light stoplight" };

const dir = resolve(process.argv[2] ?? "");
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
const mod = (await import(pathToFileURL(join(dir, "dist/index.js")).href)) as {
  environmentElements: () => Array<{
    id: string; name: string; latin?: string; kind: string; biomes: string[]; category?: string; bake: string;
  }>;
};
const elements = mod.environmentElements().map((e) => ({
  id: e.id,
  kind: e.kind,
  name: e.name,
  ...(e.latin ? { latin: e.latin } : {}),
  biomes: e.biomes,
  ...(e.category ? { category: e.category } : {}),
  ...(ALIASES[`${e.kind}:${e.id}`] ? { alias: ALIASES[`${e.kind}:${e.id}`] } : {}),
  bake: e.bake,
}));
writeFileSync(
  new URL("../src/procedural/catalog.json", import.meta.url),
  `${JSON.stringify({ package: "@threenative/procedural-environment", version: pkg.version, elements }, null, 1)}\n`,
);
console.log(`${elements.length} elements from ${pkg.version}`);
