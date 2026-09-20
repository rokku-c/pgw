import { readdir, stat, realpath } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { db, AssetSchema, record, audit } from "./store";
import { scanSessions } from "./sessions";
import type { WorkContext } from "./job-context";
import type { Asset } from "../shared/types";

const roots = [
  { id: "claude", name: "Claude Code", command: "claude", home: join(homedir(), ".claude"), sessions: "projects" },
  { id: "codex", name: "Codex", command: "codex", home: process.env.CODEX_HOME || join(homedir(), ".codex"), sessions: "sessions" },
  { id: "pi", name: "Pi", command: "pi", home: join(homedir(), ".pi/agent"), sessions: "sessions" },
] as const;
const limits = { skill: 500, session: 3000 };
let scanning = false;
let work: WorkContext | undefined;

async function files(root: string, accept: (path: string) => boolean, limit: number) {
  const found: string[] = [];
  const queue = [root];
  let visited = 0;
  while (queue.length && found.length < limit && visited++ < 20000) {
    await work?.check();
    const dir = queue.shift()!;
    await work?.progress("discover",found.length,null,basename(dir));
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (["node_modules", ".git"].includes(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && accept(path)) { found.push(path); if (found.length >= limit) break; }
    }
  }
  return { found, limited: !!queue.length || found.length >= limit };
}
async function upsertAsset(value: Omit<Asset, "id" | "createdAt" | "updatedAt">) {
  const repo = db.getRepository(AssetSchema);
  const previous = await repo.findOneBy({ path: value.path });
  await repo.save({ ...record(), ...previous, ...value, updatedAt: Date.now() });
}
async function scanSource(root: typeof roots[number], result: { skills: number; sessions: number; parsedEvents: number; mcp: number; limited: boolean; errors: string[] }) {
  const skillFiles = await files(join(root.home, "skills"), p => basename(p) === "SKILL.md", limits.skill);
  result.limited ||= skillFiles.limited;
  for (const path of skillFiles.found) {
    try {
      const text = await Bun.file(path).slice(0, 262144).text();
      const name = text.match(/^name:\s*["']?([^\n"']+)/m)?.[1].trim() || basename(resolve(path, ".."));
      const description = text.match(/^description:\s*["']?([^\n"']+)/m)?.[1].trim() || null;
      await upsertAsset({ kind: "skill", name, source: root.id, path, version: null, hash: createHash("sha256").update(text).digest("hex"), description, status: "discovered", metadata: {} });
      result.skills++;
    } catch { result.errors.push(path); }
  }
  const configPaths = root.id === "claude" ? [join(homedir(), ".claude.json"), join(root.home, "settings.json")] : root.id === "codex" ? [join(root.home, "config.toml")] : [join(root.home, "settings.json")];
  for (const path of configPaths) {
    try {
      if (!await Bun.file(path).exists()) continue;
      const raw = await Bun.file(path).text();
      const config = path.endsWith(".toml") ? Bun.TOML.parse(raw) : JSON.parse(raw);
      const servers = config.mcpServers ?? config.mcp_servers ?? {};
      for (const [name, item] of Object.entries(servers)) {
        const server = item as Record<string, unknown>;
        await upsertAsset({ kind: "mcp", name, source: root.id, path: `${path}#${name}`, version: null, hash: null, description: null, status: "discovered", metadata: { transport: server.url ? "http" : "stdio", configPath: path, command: typeof server.command === "string" ? basename(server.command) : null } });
        result.mcp++;
      }
    } catch { result.errors.push(path); }
  }
}
export async function scanRegistry(context?: WorkContext) {
  if (scanning) return { busy: true };
  scanning = true; work=context;
  const result = { busy: false, agents: 0, skills: 0, sessions: 0, parsedEvents: 0, mcp: 0, limited: false, errors: [] as string[] };
  try {
    for (const root of roots) {
      const executable = Bun.which(root.command);
      if (executable) {
        let version: string | null = null;
        try {
          const child = Bun.spawn([executable, "--version"], { cwd: homedir(), stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" } });
          const timeout = setTimeout(() => child.kill(), 3000);
          try { const [output] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); version = output.trim().slice(0, 120) || null; }
          finally { clearTimeout(timeout); }
        } catch {}
        await upsertAsset({ kind: "agent", name: root.name, source: root.id, path: executable, version, hash: null, description: null, status: "available", metadata: { configHome: root.home } }); result.agents++;
      }
      await scanSource(root, result);
    }
    const sessions = await scanSessions(undefined,context);
    result.sessions = sessions.files; result.parsedEvents = sessions.events; result.limited ||= sessions.limited;
    await audit("registry.scanned", "local", { ...result, errors: result.errors.length + sessions.errors });
    return result;
  } finally { scanning = false; work=undefined; }
}
