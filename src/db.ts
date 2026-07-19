// Minimal async DB interface shared by the Cloudflare D1 adapter (prod) and the
// bun:sqlite adapter (local dev / tests). Handlers depend only on this.

export interface DB {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null>;
  run(sql: string, ...params: unknown[]): Promise<{ lastRowId: number | null }>;
}
