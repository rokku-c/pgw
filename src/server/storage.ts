import { Database } from "bun:sqlite";
import { stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { home } from "./config";
import { acquireOwnership } from "./ownership";
import { openSessionFile } from "./session-files";
import type { CollectionSource, Session } from "../shared/types";
import { audit, db } from "./store";
import { ApiError } from "./security";
import type { StorageCategory, StorageUsage } from "../shared/types";

export async function storageStatus() {
  const filename = join(home, "gateway.sqlite");
  const database = new Database(filename, { readonly: true, strict: true });
  try {
    const pageSize = (database.query("PRAGMA page_size").get() as { page_size: number }).page_size;
    const pages = (database.query("PRAGMA page_count").get() as { page_count: number }).page_count;
    const free = (database.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
    return { path: filename, bytes: pages * pageSize, freeBytes: free * pageSize, walBytes: await stat(`${filename}-wal`).then(info => info.size).catch(() => 0) };
  } finally { database.close(); }
}
export async function compactStorage(progress: (value: Record<string, unknown>) => void = console.log) {
  const database = new Database(join(home, "gateway.sqlite"), { strict: true });
  let release: (() => void) | undefined;
  try {
    release = acquireOwnership(database);
    const before = await storageStatus(), space = await statfs(home);
    if (space.bavail * space.bsize < before.bytes * 1.2) throw new Error("Insufficient temporary space for safe SQLite compaction");
    database.run("PRAGMA busy_timeout = 1000");
    const version = (database.query("SELECT max(version) version FROM schema_versions").get() as { version: number }).version;
    if (version < 12 || version > 21) throw new Error("Start the updated gateway once before compacting");
    database.run("PRAGMA wal_checkpoint(TRUNCATE)");
    database.run("PRAGMA journal_mode = DELETE");
    database.run("PRAGMA locking_mode = EXCLUSIVE");
    database.run("BEGIN EXCLUSIVE");
    database.run("COMMIT");
    progress({ phase: "remove_fulltext_index", beforeBytes: before.bytes });
    database.transaction(() => {
      for (const trigger of ["session_search_insert", "session_search_delete", "session_search_update"]) database.run(`DROP TRIGGER IF EXISTS ${trigger}`);
      database.run("DROP TABLE IF EXISTS session_search");
      database.query("INSERT OR IGNORE INTO schema_versions(version,appliedAt) VALUES(13,?)").run(Date.now());
    })();
    const sources = new Map((database.query("SELECT * FROM collection_sources").all() as CollectionSource[]).map(source => [source.id, source]));
    const sessions = database.query("SELECT * FROM sessions WHERE captured=1").all() as Session[];
    let cleared = 0, preserved = 0;
    for (const [index, session] of sessions.entries()) {
      const source = session.sourceId ? sources.get(session.sourceId) : undefined;
      if (!source?.enabled || !source.captureBodies || !session.prefixHash) { preserved++; continue; }
      let file: Awaited<ReturnType<typeof openSessionFile>> | undefined;
      try {
        try { file = await openSessionFile({ ...session, fileMtime: -1 }, source); await file.validate(); }
        catch { preserved++; progress({ phase: "preserve_unavailable", session: session.id }); continue; }
        cleared += database.query("UPDATE session_events SET text=NULL WHERE sessionId=? AND endOffset<=? AND text IS NOT NULL").run(session.id, session.cursor).changes;
      } finally { await file?.handle.close(); }
      progress({ phase: "remove_duplicate_bodies", processed: index + 1, total: sessions.length, clearedEvents: cleared, preservedSessions: preserved });
    }
    progress({ phase: "compact", clearedEvents: cleared, preservedSessions: preserved });
    database.run("VACUUM");
    const integrity = database.query("PRAGMA quick_check").get() as { quick_check: string };
    if (integrity.quick_check !== "ok") throw new Error(`SQLite integrity: ${integrity.quick_check}`);
    const after = { path: before.path, bytes: (await stat(before.path)).size, freeBytes: 0, walBytes: 0 };
    progress({ phase: "completed", beforeBytes: before.bytes, afterBytes: after.bytes, reclaimedBytes: before.bytes - after.bytes, preservedSessions: preserved });
    return { before, after, clearedEvents: cleared, preservedSessions: preserved };
  } finally { try { release?.(); } finally { database.close(); } }
}

/** 可清理的数据分类。**配置类表不在此列**，用户无法选中它们。 */
const STORAGE_CATEGORIES:{id:string;tables:string[]}[]=[
  {id:"sessions",tables:["sessions","session_events","session_tombstones"]},
  {id:"captures",tables:["request_capture_parts","request_captures"]},
  {id:"snapshots",tables:["observability_snapshots","trajectory_snapshots","trajectory_call_context"]},
  {id:"jobs",tables:["background_jobs","debug_attempts","jobs_dedup","jobs_queue"]},
  {id:"runs",tables:["runs","run_events","run_approvals"]},
  {id:"assets",tables:["assets","asset_snapshots","asset_deployments"]},
  {id:"mcp",tables:["mcp_calls","mcp_revisions"]},
  {id:"traffic",tables:["traffic","budget_reservations"]},
  {id:"audit",tables:["audit"]},
  {id:"transient",tables:["route_sessions","response_bindings","provider_circuits","route_counters","adaptive_context_limits"]},
];
const CONFIG_TABLES=["settings","providers","routes","clients","mcp_connections","preferences","preference_revisions","preference_evidence","preference_tombstones","asset_roots","collection_sources","schema_versions","runtime_owner"];
const DATA_TABLES=STORAGE_CATEGORIES.flatMap(category=>category.tables);
/** dbstat 的 name 既可能是表名，也可能是索引名（自动索引 `sqlite_autoindex_<表>_N` 或以表名开头的显式索引）。 */
function ownerTable(name:string,known:string[]){
  if(known.includes(name))return name;
  const stripped=name.startsWith("sqlite_autoindex_")?name.slice("sqlite_autoindex_".length).replace(/_\d+$/,""):name;
  if(known.includes(stripped))return stripped;
  return known.filter(table=>name.startsWith(`${table}_`)).sort((a,b)=>b.length-a.length)[0]??null;
}
/**
 * 按分类统计**已分配**的磁盘占用（含索引页）。
 * 注意 SQLite 删除行后页进入 freelist，文件要 `pgw storage compact` 才真正收缩，
 * 因此清理后这里的数字不会立刻下降。
 */
export async function storageUsage():Promise<StorageUsage>{
  const database=new Database(join(home,"gateway.sqlite"),{readonly:true,strict:true});
  try{
    const rows=database.query("SELECT name,SUM(pgsize) bytes FROM dbstat GROUP BY name").all() as {name:string;bytes:number}[];
    const known=[...DATA_TABLES,...CONFIG_TABLES];
    const categories=STORAGE_CATEGORIES.map(category=>({id:category.id as StorageCategory,bytes:0}));
    const byId=new Map(categories.map(category=>[category.id,category]));
    let configBytes=0,otherBytes=0,totalBytes=0;
    for(const row of rows){
      totalBytes+=row.bytes;
      const table=ownerTable(row.name,known);
      const category=table?STORAGE_CATEGORIES.find(item=>item.tables.includes(table)):undefined;
      if(category)byId.get(category.id as StorageCategory)!.bytes+=row.bytes;
      else if(table&&CONFIG_TABLES.includes(table))configBytes+=row.bytes;
      else otherBytes+=row.bytes;
    }
    return {totalBytes,configBytes,otherBytes,categories:categories.filter(category=>category.bytes>0).sort((a,b)=>b.bytes-a.bytes)};
  }finally{database.close();}
}
/**
 * 清理选中的数据分类。配置类不可清理，未选中的分类保持原样。
 * 只动**实际存在**的表（部分表由运行时或历史迁移创建，新库可能没有）。
 * `freedBytes` 是归还到 freelist 的页字节，所以磁盘占用不会立刻下降。
 */
export async function purgeStorage(ids:string[]){
  const selected=STORAGE_CATEGORIES.filter(category=>ids.includes(category.id));
  if(!selected.length)throw new ApiError(400,"nothing_selected");
  const before=await storageStatus();
  const existing=new Set((await db.query("SELECT name FROM sqlite_master WHERE type='table'")).map((row:any)=>row.name as string));
  await db.transaction(async manager=>{for(const table of selected.flatMap(category=>category.tables))if(existing.has(table))await manager.query(`DELETE FROM ${table}`);});
  await audit("storage.purged","local",{categories:selected.map(category=>category.id)});
  const after=await storageStatus();
  return {freedBytes:Math.max(0,after.freeBytes-before.freeBytes),bytes:after.bytes,categories:selected.map(category=>category.id)};
}
