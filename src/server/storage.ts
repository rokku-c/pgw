import { Database } from "bun:sqlite";
import { stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { home } from "./config";
import { acquireOwnership } from "./ownership";
import { openSessionFile } from "./session-files";
import type { CollectionSource, Session } from "../shared/types";

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
