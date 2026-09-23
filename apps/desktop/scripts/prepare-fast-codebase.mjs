import { chmodSync, cpSync, existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
/** Override when cross-packaging (e.g. x64 Electron on an arm64 Mac runner). */
const platform = process.env.MODUS_CODEGRAPH_PLATFORM || process.platform;
const arch = process.env.MODUS_CODEGRAPH_ARCH || process.arch;
const packageName = `@colbymchenry/codegraph-${platform}-${arch}`;
const source = dirname(require.resolve(`${packageName}/package.json`));
const dest = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "bin", "codegraph");

if (!existsSync(join(source, platform === "win32" ? "node.exe" : "node"))) {
  throw new Error(`CodeGraph bundle is missing its Node runtime: ${source} (${packageName})`);
}

rmSync(dest, { force: true, recursive: true });
cpSync(source, dest, { recursive: true });
if (platform !== "win32") {
  chmodSync(join(dest, "node"), 0o755);
}
console.log(`Fast Codebase CodeGraph bundle ready: ${dest} (${packageName})`);
