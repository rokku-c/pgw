#!/usr/bin/env bun
/**
 * Builds the standalone `pgw` executable.
 *
 * Entry is `src/cli.ts`, not `src/server/index.ts`: the shipped artifact is a
 * single binary that is both the CLI and the server it re-executes itself as
 * (`__serve` / `__job`). The web console needs no separate asset step — Bun
 * embeds `src/web/index.html` and its whole graph (CSS/JS chunks, inlined
 * woff2 fonts) because `src/server/index.ts` imports the HTML.
 *
 * Usage:
 *   bun scripts/build.ts                  # host platform only
 *   bun scripts/build.ts --all            # every release target
 *   bun scripts/build.ts --target linux-x64
 *   bun scripts/build.ts --all --musl     # add musl (Alpine) variants
 */
import { mkdir, rm, copyFile, stat } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const entry = join(root, "src/cli.ts");
const outdir = join(root, "dist/bin");

/** Release targets. Keys are our names; values are Bun's `--target` values. */
const targets: Record<string, string> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
};
const muslTargets: Record<string, string> = {
  "linux-x64-musl": "bun-linux-x64-musl",
  "linux-arm64-musl": "bun-linux-arm64-musl",
};

const argv = process.argv.slice(2);
const all = argv.includes("--all");
const withMusl = argv.includes("--musl");
const explicit = argv[argv.indexOf("--target") + 1];
const host = `${process.platform}-${process.arch}`;

if (!all && !argv.includes("--target") && !(host in targets)) {
  throw new Error(`Unsupported host ${host}; pass --target explicitly`);
}

const selected: [string, string][] = all
  ? [...Object.entries(targets), ...(withMusl ? Object.entries(muslTargets) : [])]
  : argv.includes("--target")
    ? [[explicit, targets[explicit] ?? muslTargets[explicit] ?? `bun-${explicit}`]]
    : [[host, targets[host]]];

await mkdir(outdir, { recursive: true });

for (const [name, target] of selected) {
  const outfile = join(outdir, `pgw-${name}`);
  await rm(outfile, { force: true });
  const build = Bun.spawn(
    ["bun", "build", "--compile", `--target=${target}`, `--outfile=${outfile}`, entry],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if ((await build.exited) !== 0) throw new Error(`Build failed for ${name}`);
  const { size } = await stat(outfile);
  // A silently-empty binary is what a sandboxed/blocked write looks like; treat
  // it as failure rather than shipping a 0-byte artifact.
  if (size === 0) throw new Error(`Empty artifact for ${name} — check write permissions on ${outdir}`);
  console.log(`  ✓ pgw-${name}  ${(size / 1024 / 1024).toFixed(1)} MB`);
  // Convenience copy for the host so `./dist/bin/pgw` just works locally.
  if (name === host) await copyFile(outfile, join(outdir, "pgw"));
}

// Which targets exist is what CI and the npm packer key off.
console.log(`\n${selected.length} target(s) → dist/bin`);
export {};
