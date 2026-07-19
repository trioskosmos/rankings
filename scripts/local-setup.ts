// Build local.db from schema + generated seed SQL (local dev, no wrangler).
import { Database } from 'bun:sqlite';
import { readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const suffix of ['', '-wal', '-shm']) {
  try {
    rmSync(join(root, 'local.db' + suffix));
  } catch {}
}
const db = new Database(join(root, 'local.db'), { create: true });
db.exec('PRAGMA journal_mode = WAL;');
for (const f of ['schema/schema.sql', 'schema/seed-catalog.sql', 'schema/seed-events.sql', 'schema/seed-rankings.sql']) {
  db.exec(readFileSync(join(root, f), 'utf8'));
  console.log('applied', f);
}
const n = (q: string) => (db.query(q).get() as { n: number }).n;
console.log(
  `local.db ready: ${n('SELECT COUNT(*) n FROM song')} songs, ${n('SELECT COUNT(*) n FROM ranking')} rankings, ` +
    `${n('SELECT COUNT(*) n FROM ranking_item')} items`,
);
