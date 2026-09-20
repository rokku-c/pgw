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

/**
 * Run `onLost` when the process named by `PGW_PARENT_PID` disappears.
 *
 * A GUI shell cannot be relied on to reap what it spawned: Tauri's
 * `RunEvent::Exit` does not fire when the app is force-quit, SIGKILLed, or
 * crashes. Without this, the gateway outlives the window that owns it — holding
 * the port and the `PGW_HOME` ownership lock, so the next launch finds a gateway
 * it did not start and can never clean up.
 *
 * Only used where a parent explicitly claims ownership (the desktop shell sets
 * the variable). A server started by `pgw open` is *meant* to outlive its CLI
 * process, so it must not be given a parent to watch.
 */
export function exitWithParent(onLost: () => void, parentPid = Number(process.env.PGW_PARENT_PID)) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return;
  const timer = setInterval(() => {
    try {
      // Signal 0 only tests for existence.
      process.kill(parentPid, 0);
    } catch (error) {
      // EPERM means it exists but belongs to someone else — still alive.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
      clearInterval(timer);
      onLost();
    }
  }, 2000);
  timer.unref?.();
}
