import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { address, adminToken, apiVersion, devAccessPath, home, port, version } from "../server/config";
import type { CliContext, CliOptions } from "./types";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
let negotiatedVersion: string | undefined;

function versionNotice(status: { version: string; apiVersion?: number }) {
  if (status.version === version && status.apiVersion === apiVersion) return undefined;
  if (status.apiVersion === apiVersion) {
    return `pgw: CLI v${version} / server v${status.version} API-compatible.`;
  }
  return `pgw: warning: CLI v${version} (API v${apiVersion}) / server v${status.version} (API v${status.apiVersion ?? "unknown"}) may be incompatible.`;
}

function negotiateVersion(status: { version: string; apiVersion?: number }) {
  const key = `${status.version}:${status.apiVersion}`;
  if (negotiatedVersion === key) return;
  negotiatedVersion = key;
  const notice = versionNotice(status);
  if (notice) process.stderr.write(`${notice}\n`);
}

export function createContext(input: CliOptions = {}): CliContext {
  const options = {
    json: Boolean(input.json),
    quiet: Boolean(input.quiet),
    color: input.color !== false,
    raw: Boolean(input.raw),
    access: input.access,
  } as const;

  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`${address}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const contentType = response.headers.get("content-type") || "";
    const result = contentType.includes("json")
      ? (await response.json()) as { error?: { code?: string }; job?: { id: string; label: string } }
      : await response.text();
    if (typeof result === "string") {
      if (!response.ok) throw new Error(result || `HTTP ${response.status}`);
      return result as T;
    }
    if (!response.ok) throw new Error(result.error?.code || `HTTP ${response.status}`);
    if (path === "/status") negotiateVersion(result as { version: string; apiVersion?: number });
    if (response.status === 202 && result.job) {
      if (!options.quiet) process.stderr.write(`${result.job.label} · ${result.job.id}\n`);
      while (true) {
        await Bun.sleep(400);
        const job = await request<{ status: string; result?: T; error?: string }>(`/jobs/${result.job.id}`);
        if (job.status === "completed") return job.result as T;
        if (["failed", "cancelled", "uncertain"].includes(job.status)) throw new Error(job.error || job.status);
      }
    }
    return result as T;
  }

  async function ensureServer() {
    try {
      await request("/status");
      return;
    } catch (error) {
      if ((error as Error).message === "unauthorized") throw error;
    }
    const log = await open(join(home, "server.log"), "a", 0o600);
    const child = spawn(process.execPath, [join(root, "src/server/index.ts")], {
      cwd: root,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, PGW_HOME: home, PGW_PORT: String(port) },
    });
    child.unref();
    await log.close();
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await Bun.sleep(150);
      try {
        await request("/status");
        return;
      } catch {}
    }
    throw new Error(`Gateway unavailable: ${join(home, "server.log")}`);
  }

  return { options, request, ensureServer };
}

export { address, adminToken, apiVersion, devAccessPath, home, port, root, version };
