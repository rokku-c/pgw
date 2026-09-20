#!/usr/bin/env bun
/**
 * Assembles the publishable npm packages from built binaries.
 *
 * Layout produced under `dist/npm/`:
 *   pgw/                 → @rokku-c/pgw          (shim + optionalDependencies)
 *   pgw-<platform>/      → @rokku-c/pgw-<platform> (one compiled binary)
 *
 * The main package's `optionalDependencies` pin every platform at the same
 * version, and each platform package declares `os`/`cpu`, so a package manager
 * installs exactly the one that matches the host. This is why there is no
 * postinstall: nothing has to run for the right binary to be present.
 *
 * Usage:
 *   bun scripts/pack.ts                  # pack everything built in dist/bin
 *   bun scripts/pack.ts --platform linux-x64
 */
import { mkdir, rm, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const binDir = join(root, "dist/bin");
const outDir = join(root, "dist/npm");
const manifest = (await Bun.file(join(root, "package.json")).json()) as { version: string };
const version = manifest.version;

const targets: Record<string, { os: string; cpu: string }> = {
  "darwin-arm64": { os: "darwin", cpu: "arm64" },
  "darwin-x64": { os: "darwin", cpu: "x64" },
  "linux-x64": { os: "linux", cpu: "x64" },
  "linux-arm64": { os: "linux", cpu: "arm64" },
};

const argv = process.argv.slice(2);
const only = argv.includes("--platform") ? argv[argv.indexOf("--platform") + 1] : undefined;
const keys = only ? [only] : Object.keys(targets);

// The main package: static files, version-stamped to match this build.
const mainDir = join(outDir, "pgw");
await rm(mainDir, { recursive: true, force: true });
await mkdir(join(mainDir, "bin"), { recursive: true });
await copyFile(join(root, "npm/bin/pgw.js"), join(mainDir, "bin/pgw.js"));
await copyFile(join(root, "npm/README.md"), join(mainDir, "README.md"));
const main = (await Bun.file(join(root, "npm/package.json")).json()) as Record<string, unknown>;
main.version = version;
main.optionalDependencies = Object.fromEntries(Object.keys(targets).map(name => [`@rokku-c/pgw-${name}`, version]));
await writeFile(join(mainDir, "package.json"), `${JSON.stringify(main, null, 2)}\n`);
console.log("  ✓ @rokku-c/pgw");

for (const key of keys) {
  const meta = targets[key];
  if (!meta) throw new Error(`Unknown platform ${key}`);
  const source = join(binDir, `pgw-${key}`);
  if (!(await Bun.file(source).exists())) {
    throw new Error(`Missing ${source} — run \`bun scripts/build.ts --target ${key}\` first`);
  }
  const dir = join(outDir, `pgw-${key}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "bin"), { recursive: true });
  await copyFile(source, join(dir, "bin/pgw"));
  const pkg = {
    name: `@rokku-c/pgw-${key}`,
    version,
    description: `Personal Gateway binary for ${key}`,
    // No `license` field: the repo has no LICENSE file yet, and inventing one
    // here would make a legal claim on the author's behalf. Add one before
    // publishing — npm warns without it.
    os: [meta.os],
    cpu: [meta.cpu],
    files: ["bin/"],
    repository: { type: "git", url: "git+https://github.com/rokku-c/pgw.git" },
  };
  await writeFile(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`  ✓ @rokku-c/pgw-${key}  (${meta.os}/${meta.cpu})`);
}

console.log(`\n${keys.length + 1} package(s) → dist/npm`);
export {};
