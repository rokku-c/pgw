import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

/**
 * Whether this code is running inside a `bun build --compile` executable.
 *
 * Bun rewrites the entry to a virtual path: `/$bunfs/root/<name>` on POSIX and
 * `B:/~BUN/root/<name>` on Windows. `Bun.embeddedFiles` is a second signal — a
 * compiled binary that embedded any asset reports a non-empty list.
 */
const entry = process.argv[1] ?? "";
export const isCompiled = entry.includes("$bunfs") || entry.includes("~BUN") || (Bun.embeddedFiles?.length ?? 0) > 0;

/** The repo-root `src/cli.ts`, used only when running from source. */
const sourceCli = resolve(dirname(fileURLToPath(import.meta.url)), "../cli.ts");

/**
 * argv for re-running *this* program, without the runtime prefix.
 *
 * From source this is `bun <src/cli.ts> <verb>`, from a compiled binary it is
 * just `<verb>` — the binary is its own interpreter. Spawn with
 * `[process.execPath, ...selfArgv(verb)]` and both modes behave the same.
 */
export function selfArgv(verb: string, ...rest: string[]): string[] {
  return isCompiled ? [verb, ...rest] : [sourceCli, verb, ...rest];
}

/** Spawn a detached copy of this program, e.g. the background server. */
export function spawnDetached(verb: string, options: { log?: number; env?: Record<string, string> } = {}) {
  const stdio = options.log === undefined ? "ignore" : ["ignore", options.log, options.log];
  const child = Bun.spawn([process.execPath, ...selfArgv(verb)], {
    cwd: isCompiled ? dirname(process.execPath) : dirname(dirname(sourceCli)),
    detached: true,
    stdio: stdio as never,
    env: { ...process.env, ...options.env },
  });
  child.unref();
  return child;
}

/**
 * Sanity check used by `doctor`: from a compiled binary the source tree is gone,
 * so callers must not try to resolve `src/**` paths.
 */
export function sourceTreeAvailable() {
  return !isCompiled && existsSync(sourceCli);
}
