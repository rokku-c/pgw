import { atomic } from "./transactions";
import { ApiError, decrypt } from "./security";
import { projectContent, trajectoryText, semanticDiff, displayBlock } from "./trajectory-projection";
import type { CaptureStage } from "../shared/types";
import type { TrajectoryCoverage, TrajectoryWindow } from "../shared/trajectory";

export async function capturedStage(id: string, stage: CaptureStage, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const row = await atomic(database => database.query("SELECT state,bytes,updatedAt,expiresAt,reason,metadataCipher FROM request_captures WHERE requestId=?").get(id) as { state: TrajectoryCoverage; bytes: number; updatedAt: number; expiresAt: number; reason: string | null; metadataCipher: string } | null);
  if (!row) return { text: "", sourceStage: stage, coverage: "not_captured" as TrajectoryCoverage, reason: "not_captured", stream: false };
  if (row.state === "deleted" || row.state === "expired" || row.expiresAt <= Date.now()) return { text: "", sourceStage: stage, coverage: row.state === "deleted" ? "deleted" as const : "expired" as const, reason: row.reason, stream: false };
  const metadata = JSON.parse(decrypt(row.metadataCipher));
  const sourceStage: CaptureStage = stage === "output" && metadata.outputSource === "response" ? "response" : stage;
  const pieces: string[] = [];
  let position = -1, size = 0;
  while (true) {
    signal?.throwIfAborted();
    const parts = await atomic(database => database.query("SELECT sequence,bodyCipher,bytes FROM request_capture_parts WHERE requestId=? AND stage=? AND sequence>? ORDER BY sequence LIMIT 32").all(id, sourceStage, position) as { sequence: number; bodyCipher: string; bytes: number }[]);
    if (!parts.length) break;
    for (const part of parts) { size += part.bytes; if (size > 32 * 1024 * 1024) throw new ApiError(413, "trajectory_body_limit"); pieces.push(decrypt(part.bodyCipher)); position = part.sequence; }
    await Bun.sleep(0);
  }
  const current = await atomic(database => database.query("SELECT state,updatedAt,bytes,expiresAt FROM request_captures WHERE requestId=?").get(id) as typeof row);
  if (!current || current.state === "deleted" || current.state === "expired" || current.expiresAt <= Date.now()) throw new ApiError(410, "capture_expired");
  if (current.updatedAt !== row.updatedAt || current.bytes !== row.bytes || current.state !== row.state) throw new ApiError(409, "trajectory_changed");
  const stream = ["response", "output"].includes(stage) && (metadata.stream === true || metadata.responseHeaders?.["content-type"]?.includes("text/event-stream"));
  return { text: pieces.join(""), sourceStage, coverage: row.state, reason: !pieces.length ? "stage_unavailable" : row.reason, stream: !!stream };
}
export async function inspectTrajectory(input: { id: string; stage: CaptureStage; offset?: number; limit?: number; section?: string; block?: string; start?: number }, signal?: AbortSignal) {
  const content = await capturedStage(input.id, input.stage, signal);
  return inspectContent(input, content);
}
export function inspectContent(input: { id: string; stage: CaptureStage | "node"; offset?: number; limit?: number; section?: string; block?: string; start?: number }, content: { text: string; stream: boolean; sourceStage: CaptureStage | "node"; coverage: TrajectoryCoverage; reason: string | null }) {
  const { text, ...source } = content;
  const projection = text ? projectContent(text, source.stream) : { blocks: [], format: "text" as const, warnings: [] };
  if (input.block !== undefined) {
    const block = projection.blocks.find(block => block.id === input.block);
    if (!block) throw new ApiError(404, "trajectory_block_missing");
    const value = displayBlock(block), start = input.start || 0;
    let end = Math.min(start + 16384, value.length);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
    return { ...source, text: value.slice(start, end), next: end < value.length ? end : null, length: value.length };
  }
  const blocks = projection.blocks.filter(block => !input.section || block.section === input.section);
  const offset = input.offset || 0, limit = input.limit || 30;
  const sections = [...new Set(projection.blocks.map(block => block.section))].map(name => ({ name, count: projection.blocks.filter(block => block.section === name).length }));
  const window: TrajectoryWindow = {
    requestId: input.id, stage: input.stage, sourceStage: source.sourceStage, coverage: source.coverage, reason: source.reason,
    format: projection.format, warnings: projection.warnings, sections, total: blocks.length,
    next: offset + limit < blocks.length ? offset + limit : null,
    blocks: blocks.slice(offset, offset + limit).map(({ value, ...block }) => {
      const rendered = displayBlock({ ...block, value });
      let end = Math.min(rendered.length, 4096);
      if (end < rendered.length && /[\uD800-\uDBFF]/.test(rendered[end - 1])) end--;
      return { ...block, preview: rendered.slice(0, end), length: rendered.length, truncated: end < rendered.length };
    }),
  };
  return window;
}
export async function compareTrajectory(input: { before: string; after: string; stage?: CaptureStage; beforeStage?: CaptureStage; afterStage?: CaptureStage; offset?: number; limit?: number }, signal?: AbortSignal) {
  const before = await capturedStage(input.before, input.beforeStage || input.stage || "effective", signal), after = await capturedStage(input.after, input.afterStage || input.stage || "effective", signal);
  const complete = [before, after].every(value => value.coverage === "complete" && value.text);
  const coverage = { before: before.coverage, after: after.coverage, reason: before.reason || after.reason };
  if (!complete) return { coverage, comparable: false, changes: [], total: null, next: null };
  let a: unknown, b: unknown;
  try { a = JSON.parse(before.text); b = JSON.parse(after.text); }
  catch { return { coverage, comparable: false, changes: [], total: null, next: null, reason: "unparsed_body" }; }
  const changes = semanticDiff(normalizeContext(a), normalizeContext(b)), offset = input.offset || 0, limit = input.limit || 30;
  return { coverage, comparable: true, total: changes.length, next: offset + limit < changes.length ? offset + limit : null,
    changes: changes.slice(offset, offset + limit).map(change => ({ ...change, before: change.before === undefined ? undefined : trajectoryText(change.before).slice(0, 4096), after: change.after === undefined ? undefined : trajectoryText(change.after).slice(0, 4096), truncated: [change.before, change.after].some(value => value !== undefined && trajectoryText(value).length > 4096) })) };
}

export function normalizeContext(value: unknown) {
    const blocks = projectContent(JSON.stringify(value), false).blocks;
    const result: Record<string, unknown> = {};
    for (const section of ["system", "messages", "tools", "config", "transport", "other"] as const) {
      const selected = blocks.filter(block => block.section === section && !block.id.includes("/content/") && !block.id.includes("/tool_calls/"));
      result[section] = ["config", "system", "transport"].includes(section) ? Object.fromEntries(selected.map(block => [block.name || block.id, block.value])) : selected.map(block => block.value);
    }
    return result;
}
