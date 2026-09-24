import page from "../web/index.html";
import { z } from "zod";
import { initializeStore, audit, db } from "./store";
import { api } from "./api";
import { proxy } from "./proxy";
import { handleMcp, stopMcpCalls } from "./mcp";
import { stopOwnedRuns } from "./runtime";
import { startScheduler, stopScheduler } from "./jobs";
import { closeBudgetStore } from "./budget";
import { acquireOwnership } from "./ownership";
import { checkLocalRequest, ApiError } from "./security";
import { address, port, adminToken, writeDevAccessFile } from "./config";
import { closeCaptures, startCaptureMaintenance } from "./observability";

let ready = false;
const pwaDirectory = `${import.meta.dir}/../web/pwa`;

async function handle(
  request: Request,
  handler: (request: Request) => Promise<Response>,
) {
  try {
    checkLocalRequest(request);
    if (!ready) throw new ApiError(503, "gateway_starting");
    const response = await handler(request);
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-content-type-options", "nosniff");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  } catch (error) {
    const status =
      error instanceof ApiError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : 500;
    const code =
      error instanceof ApiError
        ? error.code
        : error instanceof z.ZodError
          ? "invalid_input"
          : "internal_error";
    if (status === 500) console.error(error);
    return Response.json(
      {
        error: {
          code,
          message: code,
          ...(error instanceof z.ZodError
            ? { fields: error.issues.map((i) => i.path.join(".")) }
            : {}),
        },
      },
      {
        status,
        headers: {
          "cache-control": "no-store",
          ...(error instanceof ApiError && error.requestId
            ? { "x-pgw-request-id": error.requestId }
            : {}),
        },
      },
    );
  }
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 255,
  development:
    process.env.NODE_ENV === "development"
      ? { hmr: true, console: true }
      : false,
  routes: {
    "/": page,
    "/app": page,
    "/app/*": page,
    "/pwa/icon-192.png": new Response(Bun.file(`${pwaDirectory}/icon-192.png`)),
    "/pwa/icon-512.png": new Response(Bun.file(`${pwaDirectory}/icon-512.png`)),
    "/api/*": (request) => handle(request, api),
    "/providers/*": (request) => handle(request, proxy),
    "/v1/*": (request) => handle(request, proxy),
    "/v1beta/*": (request) => handle(request, proxy),
    "/mcp": (request) => handle(request, handleMcp),
  },
  fetch() {
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  },
});
let releaseOwnership: (() => void) | undefined;
try {
  releaseOwnership = acquireOwnership();
  await initializeStore();
  const accessFile = writeDevAccessFile();
  if (accessFile) console.log(`  Development access: ${accessFile}`);
  await audit("gateway.started", "local");
  startScheduler();
  startCaptureMaintenance();
  ready = true;
} catch (error) {
  await server.stop(true);
  releaseOwnership?.();
  throw error;
}
console.log(`\n  Personal Gateway\n  ${address}/#token=${adminToken}\n`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  ready = false;
  await server.stop(true);
  await stopScheduler();
  await stopMcpCalls();
  await stopOwnedRuns();
  await audit("gateway.stopped", "local");
  closeBudgetStore();
  await closeCaptures();
  await db.destroy();
  releaseOwnership?.();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
