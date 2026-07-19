// Verify the matcher against the real legacy .txt rankings. Reports match rate
// and prints unmatched/ambiguous samples so we can see quality before wiring UI.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogFromFs } from '../src/catalog-fs.ts';
import { Matcher } from '../src/matcher.ts';
import { parseRankings } from '../src/parse.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cat = loadCatalogFromFs(join(root, 'data'));
const matcher = new Matcher(cat);

const dir = join(root, 'data', 'rankings');
const files = readdirSync(dir).filter((f) => f.endsWith('.txt'));

let total = 0,
  matched = 0,
  ambiguous = 0,
  unmatched = 0;
const misses: string[] = [];
const ambs: string[] = [];

for (const file of files) {
  const text = readFileSync(join(dir, file), 'utf8');
  for (const ranking of parseRankings(text)) {
    for (const item of ranking.items) {
      const r = matcher.match(item);
      total++;
      if (r.state === 'matched') matched++;
      else if (r.state === 'ambiguous') {
        ambiguous++;
        if (ambs.length < 15)
          ambs.push(`  [${file}] "${item.songText}" — top: ${r.candidates.slice(0, 3).map((c) => `${c.name}(${c.score})`).join(', ')}`);
      } else {
        unmatched++;
        if (misses.length < 25) misses.push(`  [${file}] "${item.songText}"${item.artistText ? ` - ${item.artistText}` : ''}`);
      }
    }
  }
}

const pct = (n: number) => ((100 * n) / total).toFixed(1) + '%';
console.log(`\nMatched over ${files.length} file(s), ${total} items:`);
console.log(`  matched:   ${matched} (${pct(matched)})`);
console.log(`  ambiguous: ${ambiguous} (${pct(ambiguous)})`);
console.log(`  unmatched: ${unmatched} (${pct(unmatched)})`);
if (ambs.length) console.log(`\nAmbiguous samples:\n${ambs.join('\n')}`);
if (misses.length) console.log(`\nUnmatched samples:\n${misses.join('\n')}`);
