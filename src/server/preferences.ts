import type { Database } from "bun:sqlite";
import {
  db,
  PreferenceSchema,
  PreferenceRevisionSchema,
  EvidenceSchema,
  SessionSchema,
  SessionEventSchema,
  SourceSchema,
  record,
  audit,
} from "./store";
import { atomic } from "./transactions";
import { ApiError, hash } from "./security";
import { readSessionEvents } from "./session-files";
import { redact } from "./session-parser";
import type {
  Preference,
  PreferenceEvidence,
  SessionEvent,
} from "../shared/types";

export function revisionRow(
  database: Database,
  preference: Preference,
  reason: string,
) {
  const meta = record();
  database
    .query(
      "INSERT INTO preference_revisions(id,createdAt,updatedAt,preferenceId,revision,title,content,scope,project,status,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      meta.id,
      meta.createdAt,
      meta.updatedAt,
      preference.id,
      preference.revision,
      preference.title,
      preference.content,
      preference.scope,
      preference.project,
      preference.status,
      reason,
    );
}
function writePreference(database: Database, preference: Preference) {
  database
    .query(
      `INSERT INTO preferences(id,createdAt,updatedAt,title,content,scope,project,status,source,evidence,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updatedAt=excluded.updatedAt,title=excluded.title,content=excluded.content,scope=excluded.scope,project=excluded.project,status=excluded.status,revision=excluded.revision`,
    )
    .run(
      preference.id,
      preference.createdAt,
      preference.updatedAt,
      preference.title,
      preference.content,
      preference.scope,
      preference.project,
      preference.status,
      preference.source,
      preference.evidence,
      preference.revision,
    );
}
export function deletePreferenceData(database: Database, id: string) {
  if (
    database
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='route_sessions'",
      )
      .get()
  )
    database
      .query(
        "UPDATE route_sessions SET preferencesCipher=NULL,patchIds='[]' WHERE id IN (SELECT r.id FROM route_sessions r,json_each(r.patchIds) p WHERE substr(p.value,1,length(?)+1)=? || ':')",
      )
      .run(id, id);
  database
    .query("DELETE FROM preference_evidence WHERE preferenceId=?")
    .run(id);
  database
    .query("DELETE FROM preference_revisions WHERE preferenceId=?")
    .run(id);
  database.query("DELETE FROM preferences WHERE id=?").run(id);
}
export function purgeSessionEvidence(database: Database, sessionId: string) {
  const preferences = database
    .query(
      "SELECT DISTINCT preferenceId FROM preference_evidence WHERE sessionId=?",
    )
    .all(sessionId) as { preferenceId: string }[];
  database
    .query("DELETE FROM preference_evidence WHERE sessionId=?")
    .run(sessionId);
  for (const { preferenceId } of preferences) {
    const remaining = database
      .query("SELECT count(*) n FROM preference_evidence WHERE preferenceId=?")
      .get(preferenceId) as { n: number };
    if (!remaining.n) deletePreferenceData(database, preferenceId);
  }
}
export async function savePreference(
  input: Pick<Preference, "title" | "content" | "scope" | "project" | "status">,
  id?: string,
  reason = "user_edit",
) {
  const { title, content, scope, project, status } = input;
  const values = { title, content, scope, project, status };
  const value = await atomic((database) => {
    const previous = id
      ? (database
          .query("SELECT * FROM preferences WHERE id=?")
          .get(id) as Preference | null)
      : null;
    if (id && !previous) throw new ApiError(404, "preference_not_found");
    const preference: Preference = {
      ...record(),
      source: "user",
      evidence: null,
      ...previous,
      ...values,
      project: input.scope === "global" ? null : input.project,
      revision: (previous?.revision || 0) + 1,
      updatedAt: Date.now(),
    };
    writePreference(database, preference);
    revisionRow(database, preference, reason);
    if (!previous) {
      const evidence = record();
      database
        .query(
          "INSERT INTO preference_evidence(id,createdAt,updatedAt,preferenceId,eventId,sourceId,sessionId,excerpt,kind,confidence) VALUES(?,?,?,?,NULL,NULL,NULL,?,?,?)",
        )
        .run(
          evidence.id,
          evidence.createdAt,
          evidence.updatedAt,
          preference.id,
          redact(input.content),
          "explicit",
          1,
        );
    }
    return preference;
  });
  await audit(id ? "preference.updated" : "preference.created", value.id, {
    revision: value.revision,
    status: value.status,
  });
  return value;
}
export async function removePreference(id: string) {
  await atomic((database) => {
    const row = database.query("SELECT id FROM preferences WHERE id=?").get(id);
    if (!row) throw new ApiError(404, "preference_not_found");
    database
      .query(
        "INSERT OR REPLACE INTO preference_tombstones(id,deletedAt) VALUES(?,?)",
      )
      .run(id, Date.now());
    deletePreferenceData(database, id);
  });
  await audit("preference.deleted", id);
  return { ok: true };
}
export async function preferenceHistory(id: string) {
  const preference = await db.getRepository(PreferenceSchema).findOneBy({ id });
  if (!preference) throw new ApiError(404, "preference_not_found");
  const [revisions, evidence] = await Promise.all([
    db.getRepository(PreferenceRevisionSchema).find({
      where: { preferenceId: id },
      order: { revision: "DESC" },
      take: 200,
    }),
    db.getRepository(EvidenceSchema).find({
      where: { preferenceId: id },
      order: { createdAt: "DESC" },
      take: 300,
    }),
  ]);
  return {
    preference,
    revisions,
    evidence,
    sessions: new Set(
      evidence.filter((e) => e.sessionId).map((e) => e.sessionId),
    ).size,
  };
}
export async function restorePreference(id: string, revision: number) {
  const old = await db
    .getRepository(PreferenceRevisionSchema)
    .findOneBy({ preferenceId: id, revision });
  if (!old) throw new ApiError(404, "revision_not_found");
  return savePreference(old, id, `restore:${revision}`);
}
function candidateText(text: string): string | null {
  if (text.length > 6000 || /<[^>]+>|```|\[redacted\]/.test(text)) return null;
  const lines = text
    .split(/[\n。！？]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    lines.find(
      (line) =>
        line.length >= 5 &&
        line.length <= 500 &&
        /^(?:以后|今后|我(?:希望|习惯|喜欢|偏好)|请(?:始终|总是|默认)|默认(?:请|用|使用)|不要再|always\b|never\b|i (?:prefer|want you to always)\b)/i.test(
          line,
        ),
    ) || null
  );
}
export function learnFromEvent(
  database: Database,
  event: SessionEvent,
  sourceId: string,
  project: string | null,
) {
  if (event.origin !== "user" || event.kind !== "message" || !event.text)
    return;
  const content = candidateText(event.text);
  if (!content) return;
  const id = `learned-${hash(`${project || "global"}:${content.toLowerCase()}`).slice(0, 40)}`;
  if (database.query("SELECT id FROM preference_tombstones WHERE id=?").get(id))
    return;
  const existing = database
    .query("SELECT * FROM preferences WHERE id=?")
    .get(id) as Preference | null;
  if (!existing) {
    const preference: Preference = {
      ...record(),
      id,
      title: content.slice(0, 60),
      content,
      scope: project ? "project" : "global",
      project,
      source: "session",
      evidence: event.id,
      status: "candidate",
      revision: 1,
    };
    writePreference(database, preference);
    revisionRow(database, preference, "candidate_from_explicit_text");
  }
  if (
    database
      .query(
        "SELECT id FROM preference_evidence WHERE preferenceId=? AND eventId=?",
      )
      .get(id, event.id)
  )
    return;
  const evidence = record();
  database
    .query(
      "INSERT INTO preference_evidence(id,createdAt,updatedAt,preferenceId,eventId,sourceId,sessionId,excerpt,kind,confidence) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      evidence.id,
      evidence.createdAt,
      evidence.updatedAt,
      id,
      event.id,
      sourceId,
      event.sessionId,
      content,
      "inferred",
      0.65,
    );
}
async function readEvidence(eventId: string) {
  const event = await db
    .getRepository(SessionEventSchema)
    .findOneBy({ id: eventId });
  const session = event
    ? await db.getRepository(SessionSchema).findOneBy({ id: event.sessionId })
    : null;
  const source = session?.sourceId
    ? await db.getRepository(SourceSchema).findOneBy({ id: session.sourceId })
    : null;
  if (
    !event ||
    !session ||
    !source?.enabled ||
    !source.captureBodies ||
    !source.learn ||
    event.origin !== "user" ||
    event.kind !== "message"
  )
    throw new ApiError(403, "evidence_not_authorized");
  const [loaded] = await readSessionEvents(session, source, [event]);
  if (!loaded.text) throw new ApiError(403, "evidence_not_authorized");
  return {
    ...loaded,
    text: loaded.text,
    sourceId: source.id,
    project: session.project,
    sourceRevision: source.revision,
  };
}
function authorizeEvidence(
  database: Database,
  event: Awaited<ReturnType<typeof readEvidence>>,
) {
  if (
    !database
      .query(
        "SELECT e.id FROM session_events e JOIN sessions s ON s.id=e.sessionId JOIN collection_sources c ON c.id=s.sourceId WHERE e.id=? AND e.generation=? AND c.id=? AND c.revision=? AND c.enabled=1 AND c.captureBodies=1 AND c.learn=1",
      )
      .get(event.id, event.generation, event.sourceId, event.sourceRevision)
  )
    throw new ApiError(403, "evidence_not_authorized");
}
export async function addEventEvidence(
  id: string,
  eventId: string,
  kind: PreferenceEvidence["kind"],
) {
  const event = await readEvidence(eventId);
  return atomic((database) => {
    const preference = database
      .query("SELECT * FROM preferences WHERE id=?")
      .get(id) as Preference | null;
    if (!preference) throw new ApiError(404, "preference_not_found");
    authorizeEvidence(database, event);
    const entry = {
      ...record(),
      preferenceId: id,
      eventId,
      sourceId: event.sourceId,
      sessionId: event.sessionId,
      excerpt: event.text.slice(0, 3000),
      kind,
      confidence: kind === "inferred" ? 0.65 : 1,
    };
    database
      .query(
        "INSERT INTO preference_evidence(id,createdAt,updatedAt,preferenceId,eventId,sourceId,sessionId,excerpt,kind,confidence) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        entry.id,
        entry.createdAt,
        entry.updatedAt,
        id,
        eventId,
        entry.sourceId,
        entry.sessionId,
        entry.excerpt,
        kind,
        entry.confidence,
      );
    if (kind === "counterexample" && preference.status === "active") {
      preference.status = "candidate";
      preference.revision++;
      preference.updatedAt = Date.now();
      writePreference(database, preference);
      revisionRow(database, preference, "counterexample_review");
    }
    return entry;
  });
}
export async function habitTimeline() {
  const revisions = await db
    .getRepository(PreferenceRevisionSchema)
    .find({ order: { createdAt: "DESC", revision: "DESC" }, take: 200 });
  const counts = await db.query(
    "SELECT preferenceId,count(*) evidenceCount,count(DISTINCT sessionId) sessionCount,max(createdAt) lastObserved,sum(CASE WHEN kind='counterexample' THEN 1 ELSE 0 END) counterexamples FROM preference_evidence GROUP BY preferenceId",
  );
  return { revisions, counts };
}
export async function sourcePreference(input: {
  eventId: string;
  title?: string;
  scope: "global" | "project";
}) {
  const event = await readEvidence(input.eventId);
  return atomic((database) => {
    authorizeEvidence(database, event);
    if (input.scope === "project" && !event.project)
      throw new ApiError(400, "project_required");
    const preference: Preference = {
      ...record(),
      title: input.title || event.text.replace(/\s+/g, " ").slice(0, 60),
      content: event.text.slice(0, 3000),
      scope: input.scope,
      project: input.scope === "global" ? null : event.project,
      source: "session",
      evidence: event.id,
      revision: 1,
      status: "candidate",
    };
    writePreference(database, preference);
    revisionRow(database, preference, "user_selected_evidence");
    const entry = record();
    database
      .query(
        "INSERT INTO preference_evidence(id,createdAt,updatedAt,preferenceId,eventId,sourceId,sessionId,excerpt,kind,confidence) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        entry.id,
        entry.createdAt,
        entry.updatedAt,
        preference.id,
        event.id,
        event.sourceId,
        event.sessionId,
        event.text.slice(0, 3000),
        "explicit",
        1,
      );
    return preference;
  });
}
