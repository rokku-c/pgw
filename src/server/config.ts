import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync, lstatSync, renameSync, unlinkSync } from "node:fs";
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

export const devAccessPath = resolve(import.meta.dir, "../../.gateway", port === 7210 ? "dev-access.json" : `dev-access-${port}.json`);
export function writeDevAccessFile() {
  if (process.env.NODE_ENV !== "development") return null;
  const directory = resolve(devAccessPath, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid development access directory");
  chmodSync(directory, 0o700);
  const temporary = `${devAccessPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ url: `${address}/#token=${adminToken}`, token: adminToken }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, devAccessPath);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return devAccessPath;
}
