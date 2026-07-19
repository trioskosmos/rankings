// Cloudflare D1 adapter for the DB interface (used by functions/ in prod).
import type { DB } from './db.ts';

export function d1Adapter(binding: D1Database): DB {
  return {
    async all(sql, ...params) {
      const r = await binding.prepare(sql).bind(...params).all();
      return (r.results ?? []) as never;
    },
    async first(sql, ...params) {
      return (await binding.prepare(sql).bind(...params).first()) as never;
    },
    async run(sql, ...params) {
      const r = await binding.prepare(sql).bind(...params).run();
      return { lastRowId: (r.meta?.last_row_id as number) ?? null };
    },
  };
}
