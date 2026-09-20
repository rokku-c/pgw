import { readdir, realpath, open, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join, resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { createHash, type Hash } from "node:crypto";
import { db, SourceSchema, SessionSchema, SessionEventSchema, record, audit } from "./store";
import { atomic } from "./transactions";
import { ApiError, hash } from "./security";
import { home } from "./config";
import type { WorkContext } from "./job-context";
import { parserVersion, parseSessionLine } from "./session-parser";
import { purgeSessionEvidence, learnFromEvent } from "./preferences";
import type { CollectionSource, Session, SessionEvent, SessionList, SessionTimeline } from "../shared/types";

let scanning: Promise<ScanResult> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let stopping = false;
let work: WorkContext | undefined;
interface ScanResult { files: number; events: number; errors: number; limited: boolean; busy?: boolean }
const chunkSize = 262144;
const maxLine = 4 * 1024 * 1024;
const inside = (root: string, path: string) => { const value = relative(root, path); return !isAbsolute(value) && value !== ".." && !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`); };
function safeId(text: string) { return hash(text).slice(0, 40); }
export async function listSources() {
  const definitions = [
    { name: "Claude Code", agent: "claude", path: join(homedir(), ".claude/projects") },
    { name: "Codex", agent: "codex", path: join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions") },
    { name: "Pi", agent: "pi", path: join(homedir(), ".pi/agent/sessions") },
    { name: "Gateway", agent: "auto", path: join(home, "runs") },
    { name: "Wrapper", agent: "auto", path: join(home, "agents") },
  ];
  const repo = db.getRepository(SourceSchema);
  await atomic(database => {
    for (const definition of definitions) {
      const entry = record();
      database.query("INSERT OR IGNORE INTO collection_sources(id,createdAt,updatedAt,name,agent,path,enabled,captureBodies,learn,revision,lastScanAt,lastError,fileCount,state) VALUES(?,?,?,?,?,?,0,0,0,1,NULL,NULL,0,'idle')").run(entry.id, entry.createdAt, entry.updatedAt, definition.name, definition.agent, definition.path);
    }
  });
  return repo.find({ order: { createdAt: "ASC" } });
}
export async function saveSource(input: Pick<CollectionSource, "name" | "agent" | "path" | "enabled" | "captureBodies" | "learn">, id?: string, expectedRevision?: number) {
  if (input.learn && !input.captureBodies) throw new ApiError(400, "capture_required");
  if (!isAbsolute(input.path) || input.path.includes("\0")) throw new ApiError(400, "absolute_path_required");
  let path = resolve(input.path);
  if (input.enabled) {
    path = await realpath(path).catch(() => { throw new ApiError(400, "source_missing"); });
    if (!(await stat(path)).isDirectory()) throw new ApiError(400, "source_not_directory");
    if (path === "/" || path === homedir()) throw new ApiError(400, "source_too_broad");
  }
  const source = await atomic(database => {
    const previous = id ? database.query('SELECT * FROM collection_sources WHERE id=?').get(id) as CollectionSource | null : null;
    if (id && !previous) throw new ApiError(404, "source_not_found");
    if (previous && expectedRevision !== previous.revision) throw new ApiError(409, "source_changed");
    if (previous && resolve(previous.path) !== path && previous.enabled) throw new ApiError(409, "pause_source_before_moving");
    if (database.query('SELECT id FROM collection_sources WHERE path=? AND id != ?').get(path, id || "")) throw new ApiError(409, "source_exists");
    if (input.enabled) {
      const others = database.query('SELECT id,path FROM collection_sources WHERE enabled=1 AND id != ?').all(id || "") as { id: string; path: string }[];
      if (others.some(other => inside(other.path, path) || inside(path, other.path))) throw new ApiError(409, "source_overlap");
    }
    const source: CollectionSource = { ...record(), lastScanAt: null, lastError: null, fileCount: 0, state: "idle", ...previous, ...input, path, revision: (previous?.revision || 0) + 1, updatedAt: Date.now() };
    const reset = previous && (!!previous.captureBodies !== input.captureBodies || previous.path !== path || previous.agent !== input.agent);
    if (previous && ((!input.learn && previous.learn) || reset)) {
      const sessions = database.query('SELECT id FROM sessions WHERE sourceId=?').all(id!) as { id: string }[];
      for (const session of sessions) {
        purgeSessionEvidence(database, session.id);
        if (reset) {
          database.query('DELETE FROM session_events WHERE sessionId=?').run(session.id);
          database.query("UPDATE sessions SET cursor=0,prefixHash=NULL,parserVersion=0,generation=generation+1,eventCount=0,messageCount=0,parseErrors=0,captured=?,title=nativeId,status='partial' WHERE id=?").run(input.captureBodies ? 1 : 0, session.id);
        }
      }
    }
    if (previous && input.learn && !previous.learn && !reset) {
      const events = database.query("SELECT e.*,s.project FROM session_events e JOIN sessions s ON s.id=e.sessionId WHERE s.sourceId=? AND e.origin='user' AND e.kind='message' AND e.text IS NOT NULL").iterate(id!);
      for (const row of events) { const event = row as SessionEvent & { project: string | null }; learnFromEvent(database, event, id!, event.project); }
    }
    database.query(`INSERT INTO collection_sources(id,createdAt,updatedAt,name,agent,path,enabled,captureBodies,learn,revision,lastScanAt,lastError,fileCount,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updatedAt=excluded.updatedAt,name=excluded.name,agent=excluded.agent,path=excluded.path,enabled=excluded.enabled,captureBodies=excluded.captureBodies,learn=excluded.learn,revision=excluded.revision,lastError=NULL,state='idle'`)
      .run(source.id, source.createdAt, source.updatedAt, source.name, source.agent, source.path, source.enabled ? 1 : 0, source.captureBodies ? 1 : 0, source.learn ? 1 : 0, source.revision, source.lastScanAt, null, source.fileCount, "idle");
    return source;
  });
  await audit("collection.authorized", source.id, { enabled: source.enabled, captureBodies: source.captureBodies, learn: source.learn, revision: source.revision });
  return source;
}
async function sourceValid(source: CollectionSource) {
  await work?.check();
  const value = await db.getRepository(SourceSchema).findOneBy({ id: source.id });
  if (stopping || !value?.enabled || value.revision !== source.revision) throw new ApiError(409, "collection_cancelled");
}
function putSession(database: import("bun:sqlite").Database, session: Session) {
  const values = { ...session, captured: session.captured ? 1 : 0, starred: session.starred ? 1 : 0, archived: session.archived ? 1 : 0, tags: JSON.stringify(session.tags) };
  const columns = Object.keys(values);
  database.query(`INSERT INTO sessions(${columns.map(c => `"${c}"`).join(",")}) VALUES(${columns.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${columns.filter(c => !["id", "createdAt", "starred", "archived", "tags"].includes(c)).map(c => `"${c}"=excluded."${c}"`).join(",")}`).run(...Object.values(values));
}
async function indexFile(path: string, source: CollectionSource): Promise<number> {
  await sourceValid(source);
  const canonical = await realpath(path);
  if (!inside(source.path, canonical)) throw new ApiError(403, "source_path_escape");
  if ((await db.query('SELECT path FROM session_tombstones WHERE sourceId=? AND path=?', [source.id, canonical])).length) return 0;
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = await handle.stat();
    if (!initial.isFile()) return 0;
    const identity = `${initial.dev}:${initial.ino}`;
    let previous = await db.getRepository(SessionSchema).findOneBy({ path: canonical });
    if (!previous) {
      const sameFile = await db.getRepository(SessionSchema).findOneBy({ sourceId: source.id, fileIdentity: identity });
      if (sameFile && !await Bun.file(sameFile.path).exists()) previous = sameFile;
    }
    if (previous?.sourceId && previous.sourceId !== source.id) {
      const previousSource = await db.getRepository(SourceSchema).findOneBy({ id: previous.sourceId });
      if (previousSource?.enabled) throw new ApiError(409, "source_overlap");
    }
    if (previous && previous.path === canonical && previous.sourceId === source.id && previous.fileIdentity === identity && previous.fileMtime === initial.mtimeMs && previous.size === initial.size && previous.cursor === initial.size && previous.parserVersion === parserVersion && previous.captured === source.captureBodies) return 0;
    let cursor = previous?.cursor || 0;
    let digest = createHash("sha256");
    let same = !!previous && previous.sourceId === source.id && previous.fileIdentity === identity && initial.size >= cursor && previous.parserVersion === parserVersion && previous.captured === source.captureBodies;
    const buffer = Buffer.allocUnsafe(chunkSize);
    if (same && cursor) {
      let position = 0;
      while (position < cursor) {
        await sourceValid(source);
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, cursor - position), position);
        if (!bytesRead) { same = false; break; }
        digest.update(buffer.subarray(0, bytesRead)); position += bytesRead;
        await work?.progress("verify", position, cursor, basename(path));
      }
      if (digest.copy().digest("hex") !== previous!.prefixHash) same = false;
    }
    if (!same) { cursor = 0; digest = createHash("sha256"); }
    const session: Session = { ...record(), ...previous, path: canonical, sourceId: source.id, captured: source.captureBodies,
      agent: same ? previous!.agent : source.agent, nativeId: same ? previous!.nativeId : basename(canonical, ".jsonl"),
      title: same ? previous!.title : basename(canonical, ".jsonl").slice(0, 160), project: same ? previous!.project : null, model: same ? previous!.model : null,
      generation: same ? previous!.generation : (previous?.generation ?? -1) + 1, fileIdentity: identity, prefixHash: digest.copy().digest("hex"),
      fileMtime: initial.mtimeMs, parserVersion, size: initial.size, cursor, status: "partial", lastError: null,
      messageCount: same ? previous!.messageCount : 0, eventCount: same ? previous!.eventCount : 0, parseErrors: same ? previous!.parseErrors : 0,
      parentSessionId: same ? previous!.parentSessionId : null, lastActiveAt: Math.trunc(initial.mtimeMs), archived: previous?.archived || false, starred: previous?.starred || false, tags: previous?.tags || [], updatedAt: Date.now() };
    if (!same && previous) await atomic(database => {
      const current = database.query('SELECT enabled,revision FROM collection_sources WHERE id=?').get(source.id) as CollectionSource | null;
      if (!current?.enabled || current.revision !== source.revision) throw new ApiError(409, "collection_cancelled");
      purgeSessionEvidence(database, previous!.id); database.query('DELETE FROM session_events WHERE sessionId=?').run(previous!.id); putSession(database, session);
    });
    let queued: SessionEvent[] = [];
    let parsed = 0;
    async function commit() {
      session.prefixHash = digest.copy().digest("hex"); session.updatedAt = Date.now();
      await atomic(database => {
        const current = database.query('SELECT enabled,revision FROM collection_sources WHERE id=?').get(source.id) as CollectionSource | null;
        if (!current?.enabled || current.revision !== source.revision) throw new ApiError(409, "collection_cancelled");
        if (database.query('SELECT path FROM session_tombstones WHERE sourceId=? AND path=?').get(source.id, canonical)) throw new ApiError(409, "collection_cancelled");
        const insert = database.query('INSERT OR IGNORE INTO session_events(id,createdAt,updatedAt,sessionId,generation,sourceKey,nativeId,parentId,kind,role,origin,text,metadata,offset,endOffset,timestamp) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        for (const event of queued) {
          const value = insert.run(event.id,event.createdAt,event.updatedAt,event.sessionId,event.generation,event.sourceKey,event.nativeId,event.parentId,event.kind,event.role,event.origin,event.text,JSON.stringify(event.metadata),event.offset,event.endOffset,event.timestamp);
          if (!value.changes) continue;
          session.eventCount++; parsed++;
          if (event.kind === "message" && ["user", "assistant"].includes(event.role)) session.messageCount++;
          if (event.kind === "parse_error") session.parseErrors++;
          if (source.learn) learnFromEvent(database, event, source.id, session.project);
        }
        putSession(database, session);
      });
      queued = [];
      await work?.progress("index",session.cursor,initial.size,basename(path));
    }
    let pending = Buffer.alloc(0), position = cursor, skipping = false, lineStart = cursor;
    while (position < initial.size) {
      await sourceValid(source);
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, initial.size - position), position);
      if (!bytesRead) break;
      position += bytesRead;
      pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      let boundary: number;
      while ((boundary = pending.indexOf(10)) >= 0) {
        const bytes = pending.subarray(0, boundary + 1);
        const offset = session.cursor;
        digest.update(bytes); session.cursor += bytes.length;
        const line = bytes.subarray(0, -1).toString("utf8").replace(/\r$/, "");
        pending = pending.subarray(boundary + 1);
        if (!line.trim() && !skipping) { lineStart = session.cursor; continue; }
        const meta = record();
        try {
          if (skipping || bytes.length > maxLine) throw new Error("line_too_large");
          const parsedLine = parseSessionLine(line, session.agent, offset);
          const value = parsedLine.session;
          session.agent = value.agent || session.agent; session.nativeId = value.nativeId || session.nativeId;
          session.project = value.project || session.project; session.model = value.model || session.model;
          session.parentSessionId = value.parentSessionId || session.parentSessionId;
          if (!source.captureBodies) session.title = session.nativeId.slice(0, 160);
          else if (value.title && !session.messageCount && !queued.some(e => e.kind === "message" && e.role === "user")) session.title = value.title;
          const event: SessionEvent = { ...meta, id: safeId(`${session.id}:${session.generation}:${parsedLine.event.sourceKey}`), ...parsedLine.event, sessionId: session.id, generation: session.generation, offset, endOffset: session.cursor, text: source.captureBodies ? parsedLine.event.text : null };
          queued.push(event);
        } catch {
          queued.push({ ...meta, id: safeId(`${session.id}:${session.generation}:error:${lineStart}`), sessionId: session.id, generation: session.generation, sourceKey: `error:${lineStart}`, nativeId: null, parentId: null, role: "unknown", origin: "unknown", kind: "parse_error", text: null, metadata: { reason: skipping || bytes.length > maxLine ? "line_too_large" : "invalid_json" }, offset: lineStart, endOffset: session.cursor, timestamp: null });
        }
        skipping = false; lineStart = session.cursor;
        if (queued.length >= 250) await commit();
      }
      if (pending.length > maxLine || skipping) {
        skipping = true; digest.update(pending); session.cursor += pending.length; pending = Buffer.alloc(0);
      }
    }
    if (skipping) {
      session.lastError = "oversized_incomplete_line";
      session.cursor = lineStart;
      session.parserVersion = 0;
    }
    const after = await handle.stat();
    session.status = session.cursor < initial.size || session.parseErrors || queued.some(e => e.kind === "parse_error") ? "partial" : "indexed";
    if (after.size < initial.size || after.ino !== initial.ino || after.size === initial.size && after.mtimeMs !== initial.mtimeMs) { session.parserVersion = 0; session.status = "partial"; session.lastError = "changed_during_read"; }
    await commit();
    return parsed;
  } finally { await handle.close(); }
}
async function traverse(source: CollectionSource, result: ScanResult) {
  await sourceValid(source);
  const root = await realpath(source.path);
  if (root !== source.path) throw new ApiError(403, "source_root_changed");
  const queue = [root]; const seen = new Set<string>();
  let directories = 0, limited = false, errors = 0;
  while (queue.length) {
    await sourceValid(source);
    if (++directories > 20000 || seen.size >= 10000) { limited = true; break; }
    const dir = queue.shift()!;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { errors++; continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ["node_modules", ".git"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      await work?.progress("discover",seen.size,null,basename(path));
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        seen.add(path); result.files++;
        try { result.events += await indexFile(path, source); }
        catch (error) {
          if (error instanceof ApiError && error.code === "collection_cancelled") throw error;
          errors++; await db.getRepository(SessionSchema).update({ path, sourceId: source.id }, { status: "error", lastError: "read_failed", updatedAt: Date.now() });
        }
      }
    }
  }
  if (!limited && !errors) {
    const sessions = await db.getRepository(SessionSchema).findBy({ sourceId: source.id });
    for (const session of sessions) if (!seen.has(session.path)) await db.getRepository(SessionSchema).update(session.id, { status: "missing", lastError: "file_missing", updatedAt: Date.now() });
  }
  result.errors += errors; result.limited ||= limited;
  await db.getRepository(SourceSchema).update({ id: source.id, revision: source.revision }, { state: errors ? "error" : "idle", lastScanAt: Date.now(), fileCount: seen.size, lastError: errors ? `${errors} files unreadable` : limited ? "scan_limit" : null });
}
export function scanSessions(sourceId?: string, context?: WorkContext): Promise<ScanResult> {
  if (scanning) return Promise.resolve({ busy: true, files: 0, events: 0, errors: 0, limited: false });
  work=context;
  scanning = (async () => {
    const result: ScanResult = { files: 0, events: 0, errors: 0, limited: false };
    const sources = await db.getRepository(SourceSchema).find({ where: { enabled: true, ...(sourceId ? { id: sourceId } : {}) } });
    for (const source of sources) {
      if (stopping) break;
      await db.getRepository(SourceSchema).update(source.id, { state: "scanning" });
      try { await traverse(source, result); }
      catch (error) {
        if (!(error instanceof ApiError && error.code === "collection_cancelled")) result.errors++;
        await db.getRepository(SourceSchema).update({ id: source.id, revision: source.revision }, { state: "error", lastError: error instanceof ApiError ? error.code : "source_unavailable", lastScanAt: Date.now() });
      }
    }
    return result;
  })().finally(() => { scanning = undefined; work=undefined; });
  return scanning;
}
export function startCollection() {
  stopping = false;
  timer = setInterval(() => { if (!scanning) void scanSessions().catch(error => console.error("Collection error", error)); }, 15000);
  timer.unref();
}
export async function stopCollection() { stopping = true; clearInterval(timer); await scanning; }
export async function listSessions(input: { query?: string; agent?: string; project?: string; sourceId?: string; archived?: boolean; starred?: boolean; offset?: number; limit?: number }): Promise<SessionList> {
  const offset = input.offset || 0, limit = Math.min(input.limit || 50, 200);
  const query = db.getRepository(SessionSchema).createQueryBuilder("s");
  if (input.archived !== undefined) query.andWhere('s.archived = :archived', { archived: input.archived });
  if (input.starred) query.andWhere('s.starred = 1');
  if (input.agent) query.andWhere('s.agent = :agent', { agent: input.agent });
  if (input.project) query.andWhere('s.project = :project', { project: input.project });
  if (input.sourceId) query.andWhere('s.sourceId = :sourceId', { sourceId: input.sourceId });
  if (input.query) {
    const text = input.query;
    const search = [...text].length >= 3 ? 'SELECT sessionId FROM session_search WHERE session_search MATCH :match' : 'SELECT sessionId FROM session_events WHERE instr(lower(text),lower(:text)) > 0';
    query.andWhere(`(instr(lower(s.title),lower(:text)) > 0 OR instr(lower(coalesce(s.project,'')),lower(:text)) > 0 OR s.id IN (${search}))`, { text, match: `"${text.replaceAll('"', '""')}"` });
  }
  const [items, total] = await query.orderBy('s.starred', 'DESC').addOrderBy('s.lastActiveAt', 'DESC').skip(offset).take(limit).getManyAndCount();
  return { items, total, next: offset + items.length < total ? offset + items.length : null };
}
export async function timeline(id: string, options: { after?: number; limit?: number; query?: string; leaf?: string } = {}): Promise<SessionTimeline> {
  const session = await db.getRepository(SessionSchema).findOneBy({ id });
  if (!session) throw new ApiError(404, "session_not_found");
  const source = session.sourceId ? await db.getRepository(SourceSchema).findOneBy({ id: session.sourceId }) : null;
  const query = db.getRepository(SessionEventSchema).createQueryBuilder('e').where('e.sessionId=:id', { id });
  if (options.query) query.andWhere('instr(lower(e.text),lower(:text)) > 0', { text: options.query });
  if (options.leaf) {
    const lineage = await db.query(`WITH RECURSIVE ancestors(nativeId,parentId) AS (SELECT nativeId,parentId FROM session_events WHERE sessionId=? AND nativeId=? UNION SELECT e.nativeId,e.parentId FROM session_events e JOIN ancestors a ON e.nativeId=a.parentId WHERE e.sessionId=?) SELECT DISTINCT nativeId FROM ancestors LIMIT 10001`, [id, options.leaf, id]);
    const ids = lineage.map((e: { nativeId: string }) => e.nativeId);
    if (!ids.length) throw new ApiError(404, "branch_not_found");
    if (ids.length > 10000) throw new ApiError(413, "branch_too_large");
    query.andWhere('e.nativeId IN (:...ids)', { ids });
  }
  const total = await query.getCount();
  if (options.after !== undefined) query.andWhere('e.offset > :after', { after: options.after });
  const limit = options.limit || 100;
  const events = await query.orderBy('e.offset', 'ASC').take(limit + 1).getMany();
  const more = events.length > limit; if (more) events.pop();
  if (!source?.captureBodies) for (const event of events) event.text = null;
  const branches = await db.query(`SELECT e.nativeId id,count(*) count FROM session_events e WHERE e.sessionId=? AND e.nativeId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM session_events c WHERE c.sessionId=e.sessionId AND c.parentId=e.nativeId) GROUP BY e.nativeId LIMIT 200`, [id]);
  return { session, events, total, next: more ? events.at(-1)!.offset : null, branches };
}
export async function forgetSession(id: string) {
  await atomic(database => {
    const session = database.query('SELECT id,sourceId,path FROM sessions WHERE id=?').get(id) as Session | null;
    if (!session) throw new ApiError(404, "session_not_found");
    if (session.sourceId) database.query('INSERT OR REPLACE INTO session_tombstones(sourceId,path,deletedAt) VALUES(?,?,?)').run(session.sourceId, session.path, Date.now());
    purgeSessionEvidence(database, id); database.query('DELETE FROM session_events WHERE sessionId=?').run(id); database.query('DELETE FROM sessions WHERE id=?').run(id);
  });
  await audit("session.forgotten", id); return { ok: true };
}
export async function resetSource(id: string) {
  await atomic(database => { database.query('DELETE FROM session_tombstones WHERE sourceId=?').run(id); });
  return { ok: true };
}
export async function removeSource(id: string) {
  await atomic(database => {
    if (!database.query('SELECT id FROM collection_sources WHERE id=?').get(id)) throw new ApiError(404, "source_not_found");
    const sessions = database.query('SELECT id FROM sessions WHERE sourceId=?').all(id) as { id: string }[];
    for (const session of sessions) { purgeSessionEvidence(database, session.id); database.query('DELETE FROM session_events WHERE sessionId=?').run(session.id); }
    database.query('DELETE FROM sessions WHERE sourceId=?').run(id);
    database.query('DELETE FROM session_tombstones WHERE sourceId=?').run(id);
    database.query('DELETE FROM collection_sources WHERE id=?').run(id);
  });
  await audit("collection.removed", id); return { ok: true };
}
