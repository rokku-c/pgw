import { Database } from "bun:sqlite";
import { join } from "node:path";
import { home } from "./config";

export function acquireOwnership(database?: Database) {
  const connection = database || new Database(join(home, "gateway.sqlite"), { strict: true });
  const owner = crypto.randomUUID();
  try {
    connection.run("PRAGMA busy_timeout = 5000");
    connection.run("CREATE TABLE IF NOT EXISTS runtime_owner (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, owner TEXT NOT NULL)");
    connection.transaction(() => {
      const previous = connection.query("SELECT pid, owner FROM runtime_owner WHERE id = 1").get() as { pid: number; owner: string } | null;
      if (previous && previous.pid !== process.pid) {
        let alive = true;
        try { process.kill(previous.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
        if (alive) throw new Error(`Gateway data is owned by process ${previous.pid}`);
      }
      connection.query("INSERT INTO runtime_owner(id,pid,owner) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,owner=excluded.owner").run(process.pid, owner);
    }).immediate();
    return () => { connection.query("DELETE FROM runtime_owner WHERE id = 1 AND owner = ?").run(owner); if (!database) connection.close(); };
  } catch (error) { if (!database) connection.close(); throw error; }
}
