import { Database } from "bun:sqlite";
import { Effect, Schedule } from "effect";
import { join } from "node:path";
import { home } from "./config";

let connection: Database | undefined;
function database() {
  if (!connection) {
    connection = new Database(join(home, "gateway.sqlite"), { strict: true });
    connection.run("PRAGMA busy_timeout = 5000");
    connection.run("PRAGMA foreign_keys = ON");
  }
  return connection;
}
export async function atomic<T>(fn: (db: Database) => T): Promise<T> {
  const result = await Effect.runPromise(Effect.either(Effect.retry(Effect.try({ try: () => database().transaction(() => fn(database())).immediate(), catch: error => error }), {
    schedule: Schedule.intersect(Schedule.spaced("10 millis"), Schedule.recurs(100)),
    while: error => !!error && typeof error === "object" && "code" in error && ["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String(error.code)),
  })));
  if (result._tag === "Left") throw result.left;
  return result.right;
}
export function closeLocalStore() { connection?.close(); connection = undefined; }
