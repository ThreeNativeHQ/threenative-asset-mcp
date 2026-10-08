import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

// Throwaway: deliberately leaks a temp dir so the leak-gate leg must go red (PRD-539 AC-7).
it("leaks a temp dir on purpose", async () => {
  const dir = await mkdtemp(join(tmpdir(), "leak-proof-"));
  expect(dir).toContain("leak-proof-");
});
