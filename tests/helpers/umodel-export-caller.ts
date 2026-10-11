/**
 * Runs one runUmodelExport and prints its outcome as one JSON line. A test starts it with the working directory it
 * needs, so a relative name resolves against that directory while the test process itself never changes directory.
 */
import { runUmodelExport } from "../../src/unreal/umodel-export.js";

const [executable, sourceDir, outputRoot, selector] = process.argv.slice(2) as [string, string, string, string];

try {
  const run = await runUmodelExport(executable, sourceDir, outputRoot, ["-png"], selector, {
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
  });
  process.stdout.write(`${JSON.stringify(run)}\n`);
} catch (error) {
  const { code, message } = error as { code?: unknown; message?: unknown };
  process.stdout.write(`${JSON.stringify({ error: { code, message } })}\n`);
}
