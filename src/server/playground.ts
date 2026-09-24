import { z } from "zod";
import { db, ClientSchema, RouteSchema, JobSchema, record } from "./store";
import { encrypt, decrypt, hash, newClientKey, ApiError } from "./security";
import { protocolBase, protocolPath } from "../shared/endpoints";
import { address } from "./config";
import { RetryScheduled, type WorkContext } from "./job-context";
import { EventStreamParser } from "./event-stream";
import { retryAfter } from "./routing";

export const debugInput = z.object({
  routeId: z.string().uuid(),
  protocol: z.enum(["responses", "chat", "messages", "gemini", "systemone"]),
  body: z.record(z.string(), z.unknown()),
  project: z.string().max(4096).nullable().default(null),
  personalize: z.boolean().default(false),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).max(10000).nullable().default(1),
      baseDelayMs: z.number().int().min(250).max(60000).default(1000),
      maxDelayMs: z.number().int().min(1000).max(300000).default(30000),
      retryUnknownOutcome: z.boolean().default(false),
    })
    .default({
      maxAttempts: 1,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      retryUnknownOutcome: false,
    }),
});
export async function debugAttempts(jobId: string) {
  return db.query(
    "SELECT id,number,status,httpStatus,requestId,error,bytes,startedAt,endedAt FROM debug_attempts WHERE jobId=? ORDER BY number DESC LIMIT 1000",
    [jobId],
  );
}
export async function debugAttemptDetail(jobId: string, id: string) {
  const [value] = await db.query(
    "SELECT * FROM debug_attempts WHERE jobId=? AND id=?",
    [jobId, id],
  );
  if (!value) throw new ApiError(404, "attempt_not_found");
  const { bodyCipher, ...metadata } = value;
  return {
    ...metadata,
    response: bodyCipher ? JSON.parse(decrypt(bodyCipher)) : null,
  };
}
export async function executeModelDebug(
  jobId: string,
  raw: unknown,
  context: WorkContext,
) {
  const input = debugInput.parse(raw);
  const route = await db
    .getRepository(RouteSchema)
    .findOneBy({ id: input.routeId, enabled: true });
  if (!route) throw new ApiError(404, "route_not_found");
  const key = newClientKey();
  const client = await db.getRepository(ClientSchema).save({
    ...record(),
    name: `Debug ${jobId.slice(0, 8)}`,
    kind: "temporary",
    keyHash: hash(key),
    keyPreview: `${key.slice(0, 8)}…${key.slice(-4)}`,
    enabled: true,
    project: input.project,
    personalize: input.personalize,
    routeIds: [route.id],
    lastUsedAt: null,
    budgetMicros: null,
    tokenLimit: null,
    maxConcurrent: 1,
    runId: null,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    mcpGrants: [],
    memoryAccess: false,
  });
  const [previous] = await db.query(
    "SELECT coalesce(max(number),0) number FROM debug_attempts WHERE jobId=?",
    [jobId],
  );
  try {
    for (
      let attempt = Number(previous.number) + 1;
      input.retry.maxAttempts === null || attempt <= input.retry.maxAttempts;
      attempt++
    ) {
      await context.check();
      await db.getRepository(JobSchema).update(jobId, {
        status: "running",
        phase: "request",
        attempts: attempt,
        nextRunAt: Date.now(),
        error: null,
        updatedAt: Date.now(),
      });
      const attemptId = crypto.randomUUID();
      await db.query(
        "INSERT INTO debug_attempts(id,jobId,number,status,bytes,startedAt) VALUES(?,?,?,'running',0,?)",
        [attemptId, jobId, attempt, Date.now()],
      );
      const body: Record<string, any> = { ...input.body, model: route.alias },
        stream = body.stream === true;
      const url =
        protocolBase(address, input.protocol) +
        protocolPath(input.protocol, route.alias, stream);
      let eventCount = 0;
      let response: Response | undefined,
        reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
        text = "",
        bytes = 0,
        lastFlush = 0,
        streamError: string | null = null,
        terminal = false,
        requestId: string | null = null;
      const events: { event: string; data: unknown }[] = [];
      const parser = new EventStreamParser((event) => {
        eventCount++;
        let data: any = event.data;
        try {
          data = JSON.parse(event.data);
        } catch {}
        if (events.length < 2000) events.push({ event: event.event, data });
        if (event.data === "[DONE]" && input.protocol === "chat")
          terminal = true;
        if (
          data?.error ||
          data?.type === "error" ||
          data?.type === "response.failed"
        )
          streamError =
            typeof data.error?.code === "string"
              ? data.error.code
              : "upstream_stream_error";
        if (
          (input.protocol === "responses" &&
            ["response.completed", "response.incomplete"].includes(
              data?.type,
            )) ||
          (input.protocol === "messages" && data?.type === "message_stop") ||
          (input.protocol === "gemini" &&
            data?.candidates?.length &&
            data.candidates.every((c: any) => c.finishReason))
        )
          terminal = true;
      });
      const result = () => ({
        status: response?.status || 0,
        requestId,
        text,
        body: (() => {
          try {
            return JSON.parse(text);
          } catch {
            return null;
          }
        })(),
        events,
        eventCount,
        eventsTruncated: eventCount > events.length,
        attempts: attempt,
        partial: !terminal && stream,
      });
      async function persist(status: string, error: string | null) {
        const snapshot = result();
        await db.query(
          "UPDATE debug_attempts SET status=?,httpStatus=?,requestId=?,bodyCipher=?,error=?,bytes=?,endedAt=? WHERE id=?",
          [
            status,
            response?.status || null,
            requestId,
            encrypt(JSON.stringify(snapshot)),
            error,
            bytes,
            status === "running" ? null : Date.now(),
            attemptId,
          ],
        );
        await db.getRepository(JobSchema).update(jobId, {
          resultCipher: encrypt(JSON.stringify(snapshot)),
          updatedAt: Date.now(),
        });
      }
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(
            input.protocol === "gemini"
              ? Object.fromEntries(
                  Object.entries(body).filter(
                    ([key]) => !["model", "stream"].includes(key),
                  ),
                )
              : body,
          ),
          signal: context.signal,
        });
        requestId = response.headers.get("x-pgw-request-id");
        reader = response.body?.getReader();
        const decoder = new TextDecoder();
        if (reader)
          while (true) {
            await context.check();
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.length;
            if (bytes > 8 * 1024 * 1024)
              throw new ApiError(413, "debug_output_limit");
            text += decoder.decode(part.value, { stream: true });
            if (stream && response.ok) parser.push(part.value);
            await context.progress("stream", bytes, null, route.alias);
            if (Date.now() - lastFlush > 300) {
              lastFlush = Date.now();
              await persist("running", null);
            }
          }
        text += decoder.decode();
        if (stream && response.ok) {
          if (parser.finish()) streamError = "truncated_upstream_event";
          if (!terminal && !streamError) streamError = "stream_incomplete";
        } else terminal = response.ok;
        const parsed = result().body;
        const error = response.ok
          ? streamError
          : parsed?.error?.code || `http_${response.status}`;
        await persist(error ? "failed" : "completed", error);
        if (!error) return { ...result(), partial: false };
        const safe = [
          "upstream_429",
          "circuit_open",
          "route_unavailable",
          "gateway_starting",
          "gateway_concurrency_limit",
          "concurrency_limit",
          "target_concurrency_limit",
        ].includes(error);
        const unknown =
          input.retry.retryUnknownOutcome &&
          [429, 500, 502, 503, 504].includes(response.status) &&
          !input.body.previous_response_id;
        if (
          (stream && response.ok && bytes > 0) ||
          (!safe && !unknown) ||
          (input.retry.maxAttempts !== null &&
            attempt >= input.retry.maxAttempts)
        )
          throw new ApiError(response.ok ? 502 : response.status, error);
        const backoff = Math.min(
          input.retry.maxDelayMs,
          input.retry.baseDelayMs * 2 ** Math.min(12, attempt - 1),
        );
        const delay = Math.max(
          retryAfter(response.headers.get("retry-after")) || 0,
          Math.round(backoff * (0.8 + Math.random() * 0.4)),
        );
        const next = Date.now() + delay;
        await db.getRepository(JobSchema).update(jobId, {
          status: "waiting",
          phase: "retry",
          nextRunAt: next,
          error,
          updatedAt: Date.now(),
        });
        throw new RetryScheduled();
      } catch (error) {
        if (error instanceof RetryScheduled) throw error;
        await reader?.cancel().catch(() => {});
        const code = context.signal.aborted
          ? "job_cancelled"
          : error instanceof ApiError
            ? error.code
            : "gateway_unreachable";
        await persist(
          context.signal.aborted
            ? response?.ok
              ? "uncertain"
              : "cancelled"
            : "failed",
          code,
        );
        throw error instanceof ApiError
          ? error
          : new ApiError(context.signal.aborted ? 499 : 502, code);
      }
    }
    throw new ApiError(502, "retry_exhausted");
  } finally {
    await db
      .getRepository(ClientSchema)
      .update(client.id, { enabled: false, updatedAt: Date.now() });
  }
}
