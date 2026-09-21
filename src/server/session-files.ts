import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { ApiError, hash } from "./security";
import { parseSessionLine } from "./session-parser";
import type { CollectionSource, Session, SessionEvent } from "../shared/types";
import type { WorkContext } from "./job-context";

export function withinSource(root: string, path: string) {
  const value = relative(root, path);
  return !isAbsolute(value) && value !== ".." && !value.startsWith(process.platform === "win32" ? "..\\" : "../");
}
export async function openSessionFile(session: Session, source: CollectionSource, context?: WorkContext) {
  if (!source.enabled || !source.captureBodies || source.id !== session.sourceId) throw new ApiError(403, "evidence_not_authorized");
  const root = await realpath(source.path).catch(() => { throw new ApiError(409, "session_file_missing"); });
  const path = await realpath(session.path).catch(() => { throw new ApiError(409, "session_file_missing"); });
  if (root !== source.path || path !== session.path || !withinSource(root, path)) throw new ApiError(403, "source_path_escape");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || `${initial.dev}:${initial.ino}` !== session.fileIdentity || initial.size < session.cursor) throw new ApiError(409, "session_file_changed");
    if (initial.mtimeMs !== session.fileMtime || initial.size !== session.size) {
      const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(262144);
      let position = 0;
      while (position < session.cursor) {
        await context?.check();
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, session.cursor - position), position);
        if (!bytesRead) throw new ApiError(409, "session_file_changed");
        digest.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      if (digest.digest("hex") !== session.prefixHash) throw new ApiError(409, "session_file_changed");
    }
    return { handle, async validate() {
      const current = await handle.stat();
      if (current.size !== initial.size || current.mtimeMs !== initial.mtimeMs || await realpath(session.path) !== path || await realpath(source.path) !== root) throw new ApiError(409, "session_file_changed");
    } };
  } catch (error) { await handle.close(); throw error; }
}
export async function readSessionEvents(session: Session, source: CollectionSource | null, events: SessionEvent[], context?: WorkContext) {
  const result = events.map(event => ({ ...event, text: null as string | null }));
  if (!source?.enabled || !source.captureBodies || !events.length) return result;
  const file = await openSessionFile(session, source, context);
  try {
    for (const event of result) {
      await context?.check();
      if (event.kind === "parse_error") continue;
      const length = event.endOffset - event.offset;
      if (length <= 0 || length > 4 * 1024 * 1024 || event.endOffset > session.cursor) throw new ApiError(409, "session_file_changed");
      const bytes = Buffer.allocUnsafe(length);
      let position = 0;
      while (position < length) {
        const { bytesRead } = await file.handle.read(bytes, position, length - position, event.offset + position);
        if (!bytesRead) throw new ApiError(409, "session_file_changed");
        position += bytesRead;
      }
      const parsed = parseSessionLine(bytes.toString("utf8").replace(/\r?\n$/, ""), session.agent, event.offset).event;
      if (hash(`${session.id}:${session.generation}:${parsed.sourceKey}`).slice(0, 40) !== event.id) throw new ApiError(409, "session_file_changed");
      event.text = parsed.text;
    }
    await file.validate();
    return result;
  } finally { await file.handle.close(); }
}
export async function matchingOffsets(session: Session, source: CollectionSource, query: string, context?: WorkContext, firstOnly = false) {
  const file = await openSessionFile(session, source, context);
  const matches: number[] = [], needle = query.toLowerCase(), buffer = Buffer.allocUnsafe(262144);
  let position = 0, pending = Buffer.alloc(0), lineStart = 0, skipping = false, found = false;
  try {
    while (position < session.cursor && !found) {
      await context?.check();
      const { bytesRead } = await file.handle.read(buffer, 0, Math.min(buffer.length, session.cursor - position), position);
      if (!bytesRead) throw new ApiError(409, "session_file_changed");
      position += bytesRead; pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      let boundary: number;
      while ((boundary = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, boundary), end = position - pending.length + boundary + 1;
        if (!skipping && line.length < 4 * 1024 * 1024) {
          try {
            if (parseSessionLine(line.toString("utf8").replace(/\r$/, ""), session.agent, lineStart).event.text?.toLowerCase().includes(needle)) {
              matches.push(lineStart);
              if (firstOnly) { found = true; break; }
            }
          } catch {}
        }
        lineStart = end; pending = pending.subarray(boundary + 1); skipping = false;
      }
      if (pending.length > 4 * 1024 * 1024 || skipping) { skipping = true; pending = Buffer.alloc(0); }
      await context?.progress("search", position, session.cursor, session.path);
    }
    await file.validate();
    return matches;
  } finally { await file.handle.close(); }
}

export async function readSessionRecord(session: Session, source: CollectionSource, event: SessionEvent) {
  const length = event.endOffset - event.offset;
  if (event.sessionId !== session.id || event.generation !== session.generation || event.offset < 0 || length <= 0 || length > 4 * 1024 * 1024 || event.endOffset > session.cursor) throw new ApiError(409, "session_file_changed");
  const file = await openSessionFile(session, source);
  try {
    const buffer = Buffer.allocUnsafe(length);
    let position = 0;
    while (position < length) {
      const { bytesRead } = await file.handle.read(buffer, position, length - position, event.offset + position);
      if (!bytesRead) throw new ApiError(409, "session_file_changed");
      position += bytesRead;
    }
    await file.validate();
    const text = buffer.toString("utf8").replace(/\r?\n$/, "");
    const parsed = parseSessionLine(text, session.agent, event.offset).event;
    if (hash(`${session.id}:${session.generation}:${parsed.sourceKey}`).slice(0, 40) !== event.id) throw new ApiError(409, "session_file_changed");
    return text;
  } finally { await file.handle.close(); }
}
