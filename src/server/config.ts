import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import manifest from "../../package.json";

export const home = resolve(process.env.PGW_HOME || join(homedir(), ".personal-gateway"));
mkdirSync(home, { recursive: true, mode: 0o700 });
chmodSync(home, 0o700);
export const port = Number(process.env.PGW_PORT || 7210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PGW_PORT");
export const address = `http://127.0.0.1:${port}`;
export const startedAt = Date.now();
// Baked in at build time from package.json. A compiled binary ships no
// package.json, so this must be an import rather than a runtime file read —
// otherwise /status and the MCP client identity drift from the release.
export const version: string = manifest.version;

function persistentSecret(name: string, length: number): Buffer {
  const path = join(home, name);
  if (!existsSync(path)) {
    try { writeFileSync(path, randomBytes(length), { mode: 0o600, flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  chmodSync(path, 0o600);
  const secret = readFileSync(path);
  if (secret.length !== length) throw new Error(`Invalid ${name}`);
  return secret;
}
export const encryptionKey = persistentSecret("encryption.key", 32);
export const adminToken = persistentSecret("admin.key", 32).toString("base64url");
