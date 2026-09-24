import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import { adminToken, encryptionKey, port } from "./config";

export class ApiError extends Error {
  requestId?: string;
  constructor(
    public status: number,
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function secureEqual(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function encryptBytes(value: Uint8Array) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  return Buffer.concat([
    iv,
    cipher.update(value),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}
export function decryptBytes(value: Uint8Array) {
  const data = Buffer.from(value);
  if (data.length < 28) throw new Error("Invalid encrypted payload");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey,
    data.subarray(0, 12),
  );
  decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([
    decipher.update(data.subarray(12, -16)),
    decipher.final(),
  ]);
}
export function encrypt(secret: string) {
  return encryptBytes(Buffer.from(secret, "utf8")).toString("base64url");
}
export function decrypt(value: string) {
  return decryptBytes(Buffer.from(value, "base64url")).toString("utf8");
}
export function bearer(request: Request) {
  return (
    request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ||
    request.headers.get("x-api-key") ||
    ""
  );
}
export function checkLocalRequest(request: Request) {
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  const host = request.headers.get("host");
  if (!host || !allowed.includes(host)) throw new ApiError(403, "host_denied");
  const origin = request.headers.get("origin");
  if (origin && !allowed.some((host) => origin === `http://${host}`))
    throw new ApiError(403, "origin_denied");
}
const cookieSignature = (value: string) =>
  createHmac("sha256", encryptionKey).update(value).digest("base64url");
export function sessionCookie() {
  const value = `${Date.now() + 86_400_000}.${randomBytes(16).toString("base64url")}`;
  return `pgw_session=${value}.${cookieSignature(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`;
}
export function isAdmin(request: Request) {
  if (secureEqual(bearer(request), adminToken)) return true;
  const raw = request.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("pgw_session="))
    ?.slice(12);
  if (!raw) return false;
  const [expires, nonce, signature] = raw.split(".");
  return (
    Number(expires) > Date.now() &&
    !!nonce &&
    !!signature &&
    secureEqual(signature, cookieSignature(`${expires}.${nonce}`))
  );
}
export function requireAdmin(request: Request) {
  if (!isAdmin(request)) throw new ApiError(401, "unauthorized");
  if (
    !["GET", "HEAD"].includes(request.method) &&
    !bearer(request) &&
    !request.headers.get("origin")
  )
    throw new ApiError(403, "origin_required");
}
const bodySizes = new WeakMap<Request, number>();
const rawBodies = new WeakMap<Request, Uint8Array>();
export const requestBodyBytes = (request: Request) => rawBodies.get(request);
export const requestBodySize = (request: Request) =>
  bodySizes.get(request) || 0;
export async function readJson(
  request: Request,
  maxBytes = 1_048_576,
  retainRaw = false,
) {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new ApiError(415, "json_required");
  if (Number(request.headers.get("content-length")) > maxBytes)
    throw new ApiError(413, "body_too_large");
  if (!request.body) throw new ApiError(400, "body_required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "body_too_large");
      }
      chunks.push(value);
    }
    bodySizes.set(request, size);
    const bytes = Buffer.concat(chunks);
    if (retainRaw) rawBodies.set(request, bytes);
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_json");
  } finally {
    reader.releaseLock();
  }
}
export function newClientKey() {
  return `pgw_${randomBytes(32).toString("base64url")}`;
}
export function validProviderUrl(raw: string) {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid provider URL");
  return url.toString().replace(/\/$/, "");
}
