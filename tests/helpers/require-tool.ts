import { describe, it } from "vitest";

import { prerequisiteById, type TestToolId } from "../../scripts/prerequisites.js";

export type { TestToolId } from "../../scripts/prerequisites.js";

const checked = new Map<TestToolId, string | undefined>();

/** Why a tool is missing, in the form `ffmpeg not found; install it with: <command>`. */
function missingReason(tool: TestToolId): string | undefined {
  if (!checked.has(tool)) {
    const prerequisite = prerequisiteById(tool);
    checked.set(
      tool,
      prerequisite.check(process.env).ok
        ? undefined
        : `${tool} not found; install it with: ${prerequisite.fix}`,
    );
  }
  return checked.get(tool);
}

/**
 * Declares the external tools a suite needs. Present: the suite runs. Missing locally: it is
 * skipped and the title says how to install the tool. Missing under CI=true: one test fails with
 * the same reason, so a missing tool can never turn a CI run green by skipping.
 */
export function describeWithTools(
  tools: readonly TestToolId[],
  name: string,
  body: () => void,
): void {
  const reasons = tools.flatMap((tool) => missingReason(tool) ?? []);
  if (reasons.length === 0) {
    describe(name, body);
    return;
  }
  const reason = reasons.join("; ");
  if (process.env.CI === "true") {
    describe(name, () => {
      it("has its required tools", () => {
        throw new Error(reason);
      });
    });
    return;
  }
  describe.skip(`${name} [skipped: ${reason}]`, body);
}
