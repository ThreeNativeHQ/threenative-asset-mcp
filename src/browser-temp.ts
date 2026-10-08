import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type BrowserTempEnvironment = {
  readonly TMPDIR: string;
  readonly TMP: string;
  readonly TEMP: string;
};

export interface BrowserTempDir {
  readonly path: string;
  readonly env: BrowserTempEnvironment;
  remove(): Promise<void>;
}

export function browserTempEnvironment(path: string): BrowserTempEnvironment {
  return { TMPDIR: path, TMP: path, TEMP: path };
}

// Headless Chromium can leave a 0-byte `.org.chromium.Chromium.*` shared-memory
// file in its temp dir. A private dir that we delete keeps it out of the caller's TMPDIR.
export async function createBrowserTempDir(): Promise<BrowserTempDir> {
  const path = await mkdtemp(join(tmpdir(), "threenative-browser-"));
  return {
    path,
    env: browserTempEnvironment(path),
    remove: () => rm(path, { recursive: true, force: true }),
  };
}
