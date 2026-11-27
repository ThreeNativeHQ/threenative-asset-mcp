/** PRD-540 AC-3. Download every public `threenative:*` model and run the acquisition validator on it.
 * Usage: npx tsx scripts/audit-threenative-catalog.ts   (exit 1 on any failure; paced for the gateway rate limit) */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateGltf } from "../src/discovery/acquisition.js";
import { PUBLIC_ASSETS_ORIGIN } from "../src/threenative/client.js";

const get = async (url: string): Promise<Response> => {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url);
    if (response.status !== 429 || attempt > 20) return response;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
};

const catalog = (await (await get(`${PUBLIC_ASSETS_ORIGIN}/api/assets/public/catalog.json`)).json()) as {
  items: { id: string; slug: string; type: string }[];
};
const models = catalog.items.filter((item) => item.type === "model");
const dir = await mkdtemp(join(tmpdir(), "threenative-audit-"));
let failed = 0;
try {
  for (const model of models) {
    const response = await get(`${PUBLIC_ASSETS_ORIGIN}/api/assets/public/${model.id}`);
    const file = `${model.id}.glb`;
    try {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await writeFile(join(dir, file), Buffer.from(await response.arrayBuffer()));
      await validateGltf(dir, [{ path: file } as never]);
    } catch (error) {
      failed++;
      console.log(`FAIL ${model.id} ${model.slug}: ${(error as Error).message}`);
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log(`${models.length - failed}/${models.length} public threenative models pass`);
process.exit(failed ? 1 : 0);
