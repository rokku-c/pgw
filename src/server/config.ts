import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

export const home = resolve(process.env.PGW_HOME || join(homedir(), ".personal-gateway"));
mkdirSync(home, { recursive: true, mode: 0o700 });
chmodSync(home, 0o700);
export const port = Number(process.env.PGW_PORT || 7210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PGW_PORT");
export const address = `http://127.0.0.1:${port}`;
export const startedAt = Date.now();
export const version = "0.1.0";

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
