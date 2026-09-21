import { constants } from "node:fs";
import { mkdir, lstat, realpath, chmod, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { home } from "./config";
import { atomic } from "./transactions";
import { ApiError, decrypt, encrypt, hash } from "./security";
import { capturedStage, inspectContent, normalizeContext } from "./trajectory-inspector";
import { semanticDiff, trajectoryText } from "./trajectory-projection";
import { loadTrajectoryNode, trajectorySession } from "./trajectory-sessions";
import type { WorkContext } from "./job-context";
import type { CaptureStage } from "../shared/types";
import type { ContextSnapshot, ContextSnapshotKind, ContextSnapshotPage, TrajectoryCoverage } from "../shared/trajectory";

const stages: CaptureStage[] = ["request", "effective", "upstream", "response", "output"];
const maxRawBytes = 128 * 1024 * 1024;
const maxStoredBytes = 192 * 1024 * 1024;
const storageQuota = 1024 * 1024 * 1024;
type Content = { text: string; stream: boolean; sourceStage: CaptureStage | "node"; coverage: TrajectoryCoverage; reason: string | null };
type SnapshotRow = Omit<ContextSnapshot, "stages"> & { stages: string };
interface Payload { version: 1; session: unknown; node: unknown; metadata: unknown; stages: Partial<Record<CaptureStage | "node", Content>> }
const cache = new Map<string, { content: Payload; identity: string; hash: string; weight: number }>();
let cacheBytes = 0;
function evict(id: string) {
  for (const [key, entry] of cache) if (key.startsWith(`${id}:`)) { cache.delete(key); cacheBytes -= entry.weight; }
}
const publicSnapshot = (row: SnapshotRow): ContextSnapshot => ({ ...row, stages: JSON.parse(row.stages) });
const uuid = (id: string) => { if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) throw new ApiError(400, "invalid_snapshot_id"); return id; };
async function directory() {
  const root = join(await realpath(home), "trajectory-snapshots");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new ApiError(409, "snapshot_directory_changed");
  await chmod(root, 0o700);
  return root;
}
async function snapshotRow(id: string) {
  uuid(id);
  const row = await atomic(database => database.query("SELECT * FROM trajectory_snapshots WHERE id=?").get(id) as SnapshotRow | null);
  if (!row) throw new ApiError(404, "snapshot_not_found");
  return row;
}
async function available(id: string) {
  const row = await snapshotRow(id);
  if (row.state === "deleted" || row.state === "expired" || row.expiresAt <= Date.now()) { evict(id); throw new ApiError(410, "snapshot_expired"); }
  if (row.state !== "ready") throw new ApiError(409, "snapshot_not_ready");
  return row;
}
async function captureRevision(id: string) {
  const row = await atomic(database => database.query("SELECT state,bytes,updatedAt,expiresAt,metadataCipher FROM request_captures WHERE requestId=?").get(id) as { state: string; bytes: number; updatedAt: number; expiresAt: number; metadataCipher: string } | null);
  if (!row || ["expired", "deleted"].includes(row.state) || row.expiresAt <= Date.now()) throw new ApiError(410, "capture_expired");
  if (row.state === "recording") throw new ApiError(409, "snapshot_source_active");
  return row;
}
export async function createContextSnapshot(input: { key: string; kind: ContextSnapshotKind; nodeId: string; label?: string; retentionDays: number }, id: string, context: WorkContext): Promise<ContextSnapshot> {
  uuid(id); await context.check();
  const old = await atomic(database => database.query("SELECT * FROM trajectory_snapshots WHERE id=?").get(id) as SnapshotRow | null);
  if (old?.state === "ready") return publicSnapshot(await available(id));
  if (old && ["deleted", "expired"].includes(old.state)) throw new ApiError(410, "snapshot_expired");
  const root = await directory(), temporary = join(root, `${id}.pending`), destination = join(root, `${id}.enc`);
  let published = false;
  try {
    await context.progress("snapshot.read", 0, 5);
    const session = trajectorySession(input.key), node = await loadTrajectoryNode({ key: input.key, kind: input.kind, id: input.nodeId });
    const payload: Payload = { version: 1, session, node, metadata: null, stages: {} };
    let sourceRevision: Awaited<ReturnType<typeof captureRevision>> | null = null;
    if (input.kind === "traffic") {
      sourceRevision = await captureRevision(input.nodeId);
      payload.metadata = JSON.parse(decrypt(sourceRevision.metadataCipher));
      for (const [index, stage] of stages.entries()) {
        await context.check(); payload.stages[stage] = await capturedStage(input.nodeId, stage, context.signal);
        await context.progress("snapshot.read", index + 1, stages.length);
      }
      if (!Object.values(payload.stages).some(value => value?.text)) throw new ApiError(409, "snapshot_body_missing");
      if (JSON.stringify(await captureRevision(input.nodeId)) !== JSON.stringify(sourceRevision)) throw new ApiError(409, "trajectory_changed");
    } else {
      payload.stages.node = { text: JSON.stringify(node, null, 2), stream: false, sourceStage: "node", coverage: "complete", reason: null };
    }
    await context.check();
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized) > maxRawBytes) throw new ApiError(413, "snapshot_too_large");
    await context.progress("snapshot.encrypt", 0, 1);
    const cipher = encrypt(gzipSync(serialized).toString("base64")), bytes = Buffer.byteLength(cipher);
    if (bytes > maxStoredBytes) throw new ApiError(413, "snapshot_too_large");
    const now = Date.now();
    const manifest = Object.entries(payload.stages).map(([name, content]) => ({ name: name as CaptureStage | "node", coverage: content!.coverage, bytes: Buffer.byteLength(content!.text), hash: hash(content!.text), reason: content!.reason }));
    const row: ContextSnapshot = { id, createdAt: now, expiresAt: now + input.retentionDays * 86400000, label: input.label?.trim() || `${input.kind} · ${input.nodeId.slice(0, 8)}`, sessionKey: input.key, nodeKind: input.kind, nodeId: input.nodeId, hash: hash(serialized), bytes, coverage: manifest.some(stage => stage.coverage !== "complete" || stage.reason) ? "partial" : "complete", state: "writing", stages: manifest };
    await atomic(database => {
      const total = database.query("SELECT coalesce(sum(bytes),0) bytes FROM trajectory_snapshots WHERE id<>?").get(id) as { bytes: number };
      if (total.bytes + bytes > storageQuota) throw new ApiError(413, "snapshot_storage_limit");
      database.query("INSERT INTO trajectory_snapshots(id,createdAt,expiresAt,label,sessionKey,nodeKind,nodeId,hash,bytes,coverage,state,stages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET createdAt=excluded.createdAt,expiresAt=excluded.expiresAt,hash=excluded.hash,bytes=excluded.bytes,coverage=excluded.coverage,state='writing',stages=excluded.stages").run(id, now, row.expiresAt, row.label, input.key, input.kind, input.nodeId, row.hash, bytes, row.coverage, "writing", JSON.stringify(manifest));
    });
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(cipher); await handle.sync(); } finally { await handle.close(); }
    await context.check();
    if (await directory() !== root) throw new ApiError(409, "snapshot_directory_changed");
    await rename(temporary, destination);
    const parent = await open(root, constants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); }
    await context.check();
    if (sourceRevision && JSON.stringify(await captureRevision(input.nodeId)) !== JSON.stringify(sourceRevision)) throw new ApiError(409, "trajectory_changed");
    if (input.kind !== "traffic" && JSON.stringify(await loadTrajectoryNode({ key: input.key, kind: input.kind, id: input.nodeId })) !== JSON.stringify(node)) throw new ApiError(409, "trajectory_changed");
    await atomic(database => {
      const job = database.query("SELECT cancelRequested,status FROM background_jobs WHERE id=?").get(id) as { cancelRequested: number; status: string } | null;
      if (job && (job.cancelRequested || job.status !== "running")) throw new ApiError(499, "job_cancelled");
      const changed = database.query("UPDATE trajectory_snapshots SET state='ready' WHERE id=? AND state='writing'").run(id);
      if (!changed.changes) throw new ApiError(409, "snapshot_not_ready");
    });
    published = true;
    return { ...row, state: "ready" };
  } catch (error) {
    if (!published) {
      await atomic(database => database.query("UPDATE trajectory_snapshots SET state='failed' WHERE id=? AND state='writing'").run(id));
      for (const file of [temporary, destination]) await unlink(file).catch(() => {});
    }
    throw error;
  }
}
export async function contextSnapshots(input: { key: string; offset?: number; limit?: number }): Promise<ContextSnapshotPage> {
  const limit = input.limit || 30, offset = input.offset || 0;
  const rows = await atomic(database => database.query("SELECT * FROM trajectory_snapshots WHERE sessionKey=? AND state='ready' AND expiresAt>? ORDER BY createdAt DESC,id LIMIT ? OFFSET ?").all(input.key, Date.now(), limit + 1, offset) as SnapshotRow[]);
  const more = rows.length > limit; if (more) rows.pop();
  return { items: rows.map(publicSnapshot), next: more ? offset + rows.length : null };
}
async function payload(id: string, signal?: AbortSignal, selectedStage?: CaptureStage | "node") {
  signal?.throwIfAborted(); const row = await available(id), root = await directory();
  const stage = selectedStage || (row.nodeKind === "traffic" ? "effective" : "node"), cacheKey = `${id}:${stage}`;
  const handle = await open(join(root, `${uuid(id)}.enc`), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new ApiError(409, "snapshot_file_missing"); });
  let cipher: string, identity = "";
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size !== row.bytes || info.size > maxStoredBytes || (info.mode & 0o077)) throw new ApiError(409, "snapshot_file_changed");
    identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.identity === identity && cached.hash === row.hash) {
      cache.delete(cacheKey); cache.set(cacheKey, cached);
      await available(id); signal?.throwIfAborted();
      return { row: publicSnapshot(row), content: cached.content };
    }
    if (cached) { cache.delete(cacheKey); cacheBytes -= cached.weight; }
    const buffer = Buffer.alloc(info.size);
    let position = 0;
    while (position < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, position, Math.min(262144, buffer.length - position), position);
      if (!bytesRead) throw new ApiError(409, "snapshot_file_changed");
      position += bytesRead;
    }
    const end = await handle.stat(); if (end.size !== info.size || end.mtimeMs !== info.mtimeMs) throw new ApiError(409, "snapshot_file_changed");
    cipher = buffer.toString();
  } finally { await handle.close(); }
  let serialized: string;
  try { serialized = gunzipSync(Buffer.from(decrypt(cipher), "base64"), { maxOutputLength: maxRawBytes }).toString(); }
  catch { throw new ApiError(409, "snapshot_file_changed"); }
  if (hash(serialized) !== row.hash) throw new ApiError(409, "snapshot_file_changed");
  const content = JSON.parse(serialized) as Payload;
  if (content.version !== 1) throw new ApiError(409, "snapshot_version_unsupported");
  await available(id); signal?.throwIfAborted();
  const compact: Payload = { ...content, stages: { [stage]: content.stages[stage] } };
  const weight = Buffer.byteLength(JSON.stringify(compact)) * 2;
  if (weight <= 64 * 1024 * 1024) {
    while (cache.size && (cache.size >= 8 || cacheBytes + weight > 64 * 1024 * 1024)) { const key = cache.keys().next().value!; cacheBytes -= cache.get(key)!.weight; cache.delete(key); }
    cache.set(cacheKey, { content: compact, identity, hash: row.hash, weight }); cacheBytes += weight;
  }
  return { row: publicSnapshot(row), content: compact };
}
function textWindow(text: string, start = 0) {
  let end = Math.min(start + 16384, text.length); if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return { text: text.slice(start, end), next: end < text.length ? end : null, length: text.length };
}
export async function inspectContextSnapshot(input: { id: string; stage?: CaptureStage | "node"; format?: "raw" | "structured" | "manifest"; offset?: number; limit?: number; section?: string; block?: string; start?: number }, signal?: AbortSignal) {
  const { row, content } = await payload(input.id, signal, input.stage);
  if (input.format === "manifest") return textWindow(JSON.stringify({ snapshot: row, session: content.session, node: content.node, metadata: content.metadata }, null, 2), input.start);
  const stage = input.stage || (row.nodeKind === "traffic" ? "effective" : "node");
  const source = content.stages[stage]; if (!source) throw new ApiError(404, "trajectory_block_missing");
  if (input.format === "raw") return textWindow(source.text, input.start);
  return inspectContent({ ...input, stage }, source);
}
export async function compareContextSnapshots(input: { before: string; after: string; stage?: CaptureStage | "node"; offset?: number; limit?: number; change?: number; side?: "before" | "after"; start?: number }, signal?: AbortSignal) {
  const before = await payload(input.before, signal, input.stage), after = await payload(input.after, signal, input.stage);
  if (before.row.sessionKey !== after.row.sessionKey) throw new ApiError(409, "snapshot_scope_mismatch");
  const stage = input.stage || (before.row.nodeKind === "traffic" && after.row.nodeKind === "traffic" ? "effective" : "node");
  const a = before.content.stages[stage], b = after.content.stages[stage];
  const coverage = { before: a?.coverage || "not_captured", after: b?.coverage || "not_captured", stage };
  if (!a || !b || a.coverage !== "complete" || b.coverage !== "complete" || a.reason || b.reason) return { comparable: false, coverage, changes: [], total: null, next: null };
  let left: any, right: any;
  try { left = JSON.parse(a.text); right = JSON.parse(b.text); }
  catch { return { comparable: false, coverage, reason: "unparsed_body", changes: [], total: null, next: null }; }
  const state = (saved: { row: ContextSnapshot; content: Payload }, value: any) => {
    if (stage === "node") return value;
    const node: any = saved.content.node, metadata: any = saved.content.metadata;
    return { ...normalizeContext(value), route: { routeId: node.routeId, model: node.model, providerId: node.providerId, protocol: node.protocol, upstreamProtocol: metadata?.upstreamProtocol }, runtime: metadata?.context?.runtime ?? null, preferences: node.patchIds };
  };
  signal?.throwIfAborted();
  const changes = semanticDiff(state(before, left), state(after, right));
  await available(input.before); await available(input.after);
  if (input.change !== undefined) {
    const change = changes[input.change]; if (!change || !input.side) throw new ApiError(404, "trajectory_block_missing");
    return textWindow(trajectoryText(change[input.side]), input.start);
  }
  const offset = input.offset || 0, limit = input.limit || 30;
  return { comparable: true, coverage, total: changes.length, next: offset + limit < changes.length ? offset + limit : null,
    changes: changes.slice(offset, offset + limit).map((change, index) => ({ ...change, index: offset + index, before: change.before === undefined ? undefined : trajectoryText(change.before).slice(0, 4096), after: change.after === undefined ? undefined : trajectoryText(change.after).slice(0, 4096), truncated: [change.before, change.after].some(value => value !== undefined && trajectoryText(value).length > 4096) })) };
}
export async function deleteContextSnapshot(id: string, state: "deleted" | "expired" = "deleted") {
  const row = await snapshotRow(id);
  evict(id);
  await atomic(database => database.query("UPDATE trajectory_snapshots SET state=? WHERE id=? AND state<>'deleted'").run(state, id));
  const root = await directory();
  for (const suffix of ["enc", "pending"]) await unlink(join(root, `${uuid(id)}.${suffix}`)).catch(error => { if (error.code !== "ENOENT") throw error; });
  await atomic(database => database.query("UPDATE trajectory_snapshots SET bytes=0 WHERE id=?").run(id));
  return { ok: true, id: row.id };
}
export async function sweepContextSnapshots(context: WorkContext) {
  const rows = await atomic(database => database.query("SELECT id,state FROM trajectory_snapshots WHERE (state='ready' AND expiresAt<=?) OR (state IN ('deleted','expired','failed') AND bytes>0) OR (state='writing' AND NOT EXISTS(SELECT 1 FROM background_jobs j WHERE j.id=trajectory_snapshots.id AND j.status IN ('running','queued','waiting'))) ORDER BY createdAt LIMIT 100").all(Date.now()) as { id: string; state: string }[]);
  let processed = 0;
  for (const row of rows) { await context.check(); await deleteContextSnapshot(row.id, row.state === "deleted" ? "deleted" : "expired"); await context.progress("snapshot.cleanup", ++processed, rows.length); }
  return { processed };
}
