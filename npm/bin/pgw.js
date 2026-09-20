#!/usr/bin/env node
/**
 * Launcher for @rokku-c/pgw.
 *
 * The real program is a per-platform compiled Bun binary, installed as an
 * optional dependency so the package manager picks exactly one based on
 * `os`/`cpu`. This shim only resolves it and hands over the terminal.
 *
 * Deliberately no postinstall: Bun blocks lifecycle scripts for packages it does
 * not trust, and a global install's `trustedDependencies` replaces rather than
 * extends Bun's built-in allowlist — so a download-at-install design would be
 * silently skipped on a meaningful share of machines.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chmodSync, existsSync } from "node:fs";

const SUPPORTED = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const key = `${process.platform}-${process.arch}`;

if (!SUPPORTED.includes(key)) {
  console.error(`pgw: no build for ${key}.\nSupported platforms: ${SUPPORTED.join(", ")}`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
let binary;
try {
  binary = join(dirname(require.resolve(`@rokku-c/pgw-${key}/package.json`)), "bin", "pgw");
} catch {
  console.error(
    `pgw: the ${key} binary package is not installed.\n` +
      `This usually means optional dependencies were skipped (--no-optional, --omit=optional).\n` +
      `Reinstall with:  npm install -g @rokku-c/pgw`,
  );
  process.exit(1);
}

if (!existsSync(binary)) {
  console.error(`pgw: expected binary at ${binary} but it is missing.`);
  process.exit(1);
}

// Registry round-trips do not always preserve the executable bit.
try {
  chmodSync(binary, 0o755);
} catch {
  // Best effort — spawn() below surfaces a real permission error if it matters.
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

// Hand terminal signals to the child. Ctrl+C usually reaches both processes via
// the foreground process group, but an explicit forward keeps `pgw run` and
// `pgw claude` interruptible when they are not in that group.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  });
}

child.on("error", error => {
  console.error(`pgw: failed to launch: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  // Mirror a signal-kill so `$?` looks the same as running the binary directly.
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
