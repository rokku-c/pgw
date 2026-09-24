import { atomic } from "./transactions";
import { db, ProviderSchema, audit } from "./store";
import { ApiError, hash, encrypt, decrypt } from "./security";
import type { ClientKey, ModelRoute, Provider, Target } from "../shared/types";

export interface FrozenPreference {
  id: string;
  revision: number;
  content: string;
}
export interface RouteSession {
  id: string;
  ownerKey: string;
  routeId: string;
  sessionKey: string;
  providerId: string | null;
  providerFingerprint: string | null;
  model: string | null;
  preferencesCipher: string | null;
  patchIds: string;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  uncertain: number;
  createdAt: number;
  updatedAt: number;
}
export const ownerKey = (client: ClientKey) =>
  client.runId ? `run:${client.runId}` : `client:${client.id}`;
export const providerFingerprint = (provider: Provider) =>
  hash(
    JSON.stringify([
      provider.protocol,
      provider.baseUrl,
      provider.secretCipher,
    ]),
  );
export async function beginRouteSession(
  client: ClientKey,
  route: ModelRoute,
  key: string | null,
  previousId: string | undefined,
  lease: string,
): Promise<RouteSession | null> {
  if (!key && !previousId && route.protocol !== "responses") return null;
  if (key && (key.length > 200 || !key.trim()))
    throw new ApiError(400, "invalid_session_key");
  return atomic((database) => {
    const owner = ownerKey(client);
    let existing: RouteSession | null = null;
    if (previousId) {
      const binding = database
        .query(
          "SELECT affinityId,routeId,status FROM response_bindings WHERE ownerKey=? AND responseId=?",
        )
        .get(owner, previousId) as {
        affinityId: string;
        routeId: string;
        status: string;
      } | null;
      if (
        !binding ||
        binding.routeId !== route.id ||
        !["completed", "incomplete"].includes(binding.status)
      )
        throw new ApiError(409, "response_state_unavailable");
      existing = database
        .query("SELECT * FROM route_sessions WHERE id=? AND ownerKey=?")
        .get(binding.affinityId, owner) as RouteSession | null;
      if (!existing) throw new ApiError(409, "response_state_unavailable");
      if (key && existing.sessionKey !== hash(key))
        throw new ApiError(409, "session_key_mismatch");
    } else if (key)
      existing = database
        .query(
          "SELECT * FROM route_sessions WHERE ownerKey=? AND routeId=? AND sessionKey=?",
        )
        .get(owner, route.id, hash(key)) as RouteSession | null;
    if (existing?.leaseId && (existing.leaseExpiresAt || 0) > Date.now())
      throw new ApiError(409, "session_busy");
    if (existing?.uncertain || existing?.leaseId)
      throw new ApiError(409, "session_outcome_unknown");
    if (!existing) {
      const now = Date.now();
      existing = {
        id: crypto.randomUUID(),
        ownerKey: owner,
        routeId: route.id,
        sessionKey: key ? hash(key) : crypto.randomUUID(),
        providerId: null,
        providerFingerprint: null,
        model: null,
        preferencesCipher: null,
        patchIds: "[]",
        leaseId: lease,
        leaseExpiresAt: now + 330000,
        uncertain: 0,
        createdAt: now,
        updatedAt: now,
      };
      database
        .query(
          "INSERT INTO route_sessions(id,ownerKey,routeId,sessionKey,patchIds,leaseId,leaseExpiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          existing.id,
          owner,
          route.id,
          existing.sessionKey,
          "[]",
          lease,
          existing.leaseExpiresAt,
          now,
          now,
        );
    } else
      database
        .query(
          "UPDATE route_sessions SET leaseId=?,leaseExpiresAt=?,updatedAt=? WHERE id=?",
        )
        .run(lease, Date.now() + 330000, Date.now(), existing.id);
    return { ...existing, leaseId: lease };
  });
}
export function frozenPreferences(
  session: RouteSession | null,
): FrozenPreference[] | null {
  return session?.preferencesCipher
    ? JSON.parse(decrypt(session.preferencesCipher))
    : null;
}
export async function pinRoute(
  session: RouteSession | null,
  target: Target,
  provider: Provider,
  prefs: FrozenPreference[],
  lease: string,
) {
  if (!session) return;
  const fingerprint = providerFingerprint(provider);
  await atomic((database) => {
    const row = database
      .query("SELECT * FROM route_sessions WHERE id=? AND leaseId=?")
      .get(session.id, lease) as RouteSession | null;
    if (!row) throw new ApiError(409, "session_lease_lost");
    if (
      row.providerId &&
      (row.providerId !== provider.id ||
        row.model !== target.model ||
        row.providerFingerprint !== fingerprint)
    )
      throw new ApiError(409, "pinned_provider_changed");
    const preferencesCipher =
      row.preferencesCipher || encrypt(JSON.stringify(prefs));
    database
      .query(
        "UPDATE route_sessions SET providerId=?,providerFingerprint=?,model=?,preferencesCipher=?,patchIds=?,updatedAt=? WHERE id=? AND leaseId=?",
      )
      .run(
        provider.id,
        fingerprint,
        target.model,
        preferencesCipher,
        JSON.stringify(prefs.map((p) => `${p.id}:${p.revision}`)),
        Date.now(),
        session.id,
        lease,
      );
  });
}
export async function recordResponse(
  session: RouteSession | null,
  responseId: string | null,
  target: Target,
  provider: Provider,
  status: string,
  lease: string,
) {
  if (!session || !responseId) return;
  if (responseId.length > 300 || !/^[a-zA-Z0-9_-]+$/.test(responseId))
    throw new ApiError(502, "invalid_response_id");
  await atomic((database) => {
    const current = database
      .query("SELECT leaseId FROM route_sessions WHERE id=?")
      .get(session.id) as { leaseId: string | null } | null;
    if (current?.leaseId !== lease)
      throw new ApiError(409, "session_lease_lost");
    const old = database
      .query(
        "SELECT affinityId FROM response_bindings WHERE ownerKey=? AND responseId=?",
      )
      .get(session.ownerKey, responseId) as { affinityId: string } | null;
    if (old && old.affinityId !== session.id)
      throw new ApiError(409, "response_id_collision");
    database
      .query(
        "INSERT INTO response_bindings(ownerKey,responseId,routeId,affinityId,providerId,providerFingerprint,model,status,createdAt) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(ownerKey,responseId) DO UPDATE SET status=excluded.status",
      )
      .run(
        session.ownerKey,
        responseId,
        session.routeId,
        session.id,
        provider.id,
        providerFingerprint(provider),
        target.model,
        status,
        Date.now(),
      );
  });
}
export async function unpinRejectedRoute(
  session: RouteSession | null,
  lease: string,
) {
  if (!session || session.providerId) return;
  await atomic((database) => {
    database
      .query(
        "UPDATE route_sessions SET providerId=NULL,providerFingerprint=NULL,model=NULL WHERE id=? AND leaseId=?",
      )
      .run(session.id, lease);
  });
}
export async function releaseRouteSession(
  session: RouteSession | null,
  lease: string,
  uncertain: boolean,
) {
  if (!session) return;
  await atomic((database) => {
    database
      .query(
        "UPDATE route_sessions SET leaseId=NULL,leaseExpiresAt=NULL,uncertain=?,updatedAt=? WHERE id=? AND leaseId=?",
      )
      .run(uncertain ? 1 : 0, Date.now(), session.id, lease);
  });
}
export async function listRouteSessions() {
  return db.query(
    "SELECT id,ownerKey,routeId,providerId,model,patchIds,leaseId IS NOT NULL active,uncertain,createdAt,updatedAt FROM route_sessions ORDER BY updatedAt DESC LIMIT 200",
  );
}
export async function deleteRouteSession(id: string) {
  await atomic((database) => {
    const row = database
      .query("SELECT leaseId,leaseExpiresAt FROM route_sessions WHERE id=?")
      .get(id) as RouteSession | null;
    if (!row) throw new ApiError(404, "session_not_found");
    if (row.leaseId && (row.leaseExpiresAt || 0) > Date.now())
      throw new ApiError(409, "session_busy");
    database.query("DELETE FROM response_bindings WHERE affinityId=?").run(id);
    database.query("DELETE FROM route_sessions WHERE id=?").run(id);
  });
  await audit("routing.session_closed", id);
  return { ok: true };
}
export async function responseBinding(client: ClientKey, responseId: string) {
  const rows = await db.query(
    "SELECT b.*,r.alias FROM response_bindings b JOIN routes r ON r.id=b.routeId WHERE b.ownerKey=? AND b.responseId=? AND r.enabled=1",
    [ownerKey(client), responseId],
  );
  const binding = rows[0] as
    | {
        providerId: string;
        providerFingerprint: string;
        routeId: string;
        alias: string;
        affinityId: string;
        model: string;
      }
    | undefined;
  if (
    !binding ||
    (client.routeIds.length && !client.routeIds.includes(binding.routeId))
  )
    throw new ApiError(404, "response_not_found");
  const provider = await db
    .getRepository(ProviderSchema)
    .findOneBy({ id: binding.providerId, enabled: true });
  if (
    !provider ||
    providerFingerprint(provider) !== binding.providerFingerprint
  )
    throw new ApiError(409, "pinned_provider_changed");
  return { binding, provider };
}
export async function circuitPermit(provider: Provider, model: string) {
  const id = hash(`${provider.id}:${model}`),
    fingerprint = providerFingerprint(provider);
  return atomic((database) => {
    const state = database
      .query("SELECT * FROM provider_circuits WHERE id=?")
      .get(id) as {
      fingerprint: string;
      openUntil: number;
      probeUntil: number;
      failures: number;
    } | null;
    if (!state || state.fingerprint !== fingerprint) {
      database
        .query(
          "INSERT OR REPLACE INTO provider_circuits(id,providerId,model,fingerprint,failures,openUntil,probeUntil,updatedAt) VALUES(?,?,?,?,0,0,0,?)",
        )
        .run(id, provider.id, model, fingerprint, Date.now());
      return { allowed: true, id, reason: "closed", retryAt: null };
    }
    if (state.openUntil > Date.now())
      return {
        allowed: false,
        id,
        reason: "circuit_open",
        retryAt: state.openUntil,
      };
    if (state.failures >= 3) {
      if (state.probeUntil > Date.now())
        return {
          allowed: false,
          id,
          reason: "half_open_busy",
          retryAt: state.probeUntil,
        };
      database
        .query(
          "UPDATE provider_circuits SET probeUntil=?,updatedAt=? WHERE id=?",
        )
        .run(Date.now() + 330000, Date.now(), id);
      return {
        allowed: true,
        id,
        reason: "half_open_probe",
        retryAt: null,
      };
    }
    return { allowed: true, id, reason: "closed", retryAt: null };
  });
}
export async function circuitResult(
  id: string,
  success: boolean,
  failure: string | null,
  retryAfter: number | null = null,
) {
  await atomic((database) => {
    const state = database
      .query("SELECT failures FROM provider_circuits WHERE id=?")
      .get(id) as { failures: number } | null;
    if (!state) return;
    if (success)
      database
        .query(
          "UPDATE provider_circuits SET failures=0,openUntil=0,probeUntil=0,lastError=NULL,updatedAt=? WHERE id=?",
        )
        .run(Date.now(), id);
    else if (failure) {
      const failures = state.failures + 1;
      const delay =
        retryAfter ??
        (failures >= 3
          ? Math.min(300000, 15000 * 2 ** Math.min(5, failures - 3))
          : 0);
      database
        .query(
          "UPDATE provider_circuits SET failures=?,openUntil=?,probeUntil=0,lastError=?,updatedAt=? WHERE id=?",
        )
        .run(failures, delay ? Date.now() + delay : 0, failure, Date.now(), id);
    } else
      database
        .query("UPDATE provider_circuits SET probeUntil=0 WHERE id=?")
        .run(id);
  });
}
export function retryAfter(header: string | null) {
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms >= 0
    ? Math.min(300000, Math.max(1000, ms))
    : null;
}
export async function resetCircuit(id: string) {
  await db.query(
    "UPDATE provider_circuits SET failures=0,openUntil=0,probeUntil=0,lastError=NULL,updatedAt=? WHERE id=?",
    [Date.now(), id],
  );
  await audit("routing.circuit_reset", id);
  return { ok: true };
}
export async function balancedTargets(route: ModelRoute) {
  if (route.strategy === "priority")
    return [...route.targets].sort(
      (a, b) => (a.priority || 0) - (b.priority || 0),
    );
  return atomic((database) => {
    const groups = new Map<number, Target[]>();
    for (const target of route.targets) {
      const priority = target.priority || 0;
      groups.set(priority, [...(groups.get(priority) || []), target]);
    }
    const counter = database
      .query("SELECT value FROM route_counters WHERE routeId=?")
      .get(route.id) as { value: number } | null;
    const value = (counter?.value || 0) + 1;
    database
      .query(
        "INSERT INTO route_counters(routeId,value) VALUES(?,?) ON CONFLICT(routeId) DO UPDATE SET value=excluded.value",
      )
      .run(route.id, value);
    const ordered: Target[] = [];
    for (const [, targets] of [...groups].sort((a, b) => a[0] - b[0])) {
      if (route.strategy === "least_active")
        targets.sort((a, b) => {
          const count = (t: Target) =>
            (
              database
                .query(
                  "SELECT count(*) n FROM budget_reservations WHERE targetKey=? AND status='held'",
                )
                .get(`${route.id}:${t.providerId}:${t.model}`) as { n: number }
            ).n / (t.weight || 1);
          return count(a) - count(b);
        });
      else {
        const total = targets.reduce((n, t) => n + (t.weight || 1), 0);
        let position = (value - 1) % total;
        let selected = 0;
        for (let i = 0; i < targets.length; i++) {
          position -= targets[i].weight || 1;
          if (position < 0) {
            selected = i;
            break;
          }
        }
        targets.unshift(...targets.splice(selected, 1));
      }
      ordered.push(...targets);
    }
    return ordered;
  });
}
