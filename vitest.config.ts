import { configDefaults, defineConfig } from "vitest/config";

// Agent worktrees are full checkouts nested in the repo; without this their tests run too.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".worktrees/**", ".claude/**"],
    // Many tests spawn real ffmpeg, the pinned inspector, or the packed MCP over stdio. Vitest's 5s
    // default failed them on a loaded host, and a timed-out test's work kept writing into temp dirs
    // its cleanup had already removed. A hang still fails, just not a slow machine.
    testTimeout: 30_000,
  },
});
