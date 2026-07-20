// bun:sqlite adapter for the DB interface (local dev + tests).
import { Database } from 'bun:sqlite';
import type { DB } from '../src/db.ts';

export function bunAdapter(sqlite: Database): DB {
  return {
    async all(sql, ...params) {
      return sqlite.query(sql).all(...(params as never[])) as never;
    },
    async first(sql, ...params) {
      return (sqlite.query(sql).get(...(params as never[])) ?? null) as never;
    },
    async run(sql, ...params) {
      const r = sqlite.query(sql).run(...(params as never[]));
      return { lastRowId: Number(r.lastInsertRowid) || null };
    },
    async batch(statements) {
      const run = sqlite.transaction((stmts: { sql: string; params: unknown[] }[]) => {
        for (const s of stmts) sqlite.query(s.sql).run(...(s.params as never[]));
      });
      run(statements);
    },
  };
}
