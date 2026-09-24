import { Database, type SQLQueryBindings } from "bun:sqlite";
import { configDatabasePath } from "./config";

export class BunSqlite {
  private database: Database;
  constructor(
    filename: string,
    options: {
      readonly?: boolean;
      fileMustExist?: boolean;
      timeout?: number;
    } = {},
  ) {
    this.database = new Database(filename, {
      readonly: options.readonly,
      create: !options.fileMustExist,
      strict: true,
    });
    this.database.run(
      `PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.timeout ?? 5000))}`,
    );
  }
  run(sql: string, ...parameters: SQLQueryBindings[]) {
    return this.database.prepare(sql).run(...parameters);
  }
  prepare(sql: string) {
    const statement = this.database.prepare(sql);
    return {
      reader: statement.columnNames.length > 0,
      all: (...parameters: SQLQueryBindings[]) => statement.all(...parameters),
      run: (...parameters: SQLQueryBindings[]) => statement.run(...parameters),
    };
  }
  pragma(sql: string) {
    return this.database.prepare(`PRAGMA ${sql}`).all();
  }
  close() {
    this.database.close();
  }
}

export function attachConfig(database: Database) {
  database.run("ATTACH DATABASE ? AS config", [configDatabasePath]);
}
