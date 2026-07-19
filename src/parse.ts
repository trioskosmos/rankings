// Parse pasted / uploaded ranking text into structured rankings.
//
// Format (same as the legacy .txt files):
//   <ranker name>            <- header line (no leading number, no " - ")
//   1. 曲名 - アーティスト     <- ranked item
//   2. ...
// A file may contain multiple rankings back to back (each with its own header).

import type { ParsedItem, ParsedRanking } from './types.ts';

const NUM_PREFIX = /^\s*\d+\s*[.)、．]\s*/;

/** A header line = the ranker name (non-numbered, no " - " artist separator). */
export function isHeader(line: string): boolean {
  const t = line.trim();
  return !!t && !/^\s*\d+\s*[.)、．]/.test(t) && !t.includes(' - ');
}

/** Split "12. 眩耀夜行 - スリーズブーケ" → {position, songText, artistText}. */
export function parseItem(line: string, position: number): ParsedItem | null {
  const raw = line.trim();
  if (!raw) return null;
  let rest = raw.replace(NUM_PREFIX, '').trim();
  if (!rest) return null;

  let songText = rest;
  let artistText: string | null = null;
  // Artist is the segment after the LAST " - " (song titles rarely contain " - ").
  const idx = rest.lastIndexOf(' - ');
  if (idx > 0) {
    songText = rest.slice(0, idx).trim();
    artistText = rest.slice(idx + 3).trim() || null;
  }
  songText = songText.replace(/^[「『"']|[」』"']$/g, '').trim();
  if (!songText) return null;
  return { position, songText, artistText, rawLine: raw };
}

/** Parse a whole blob into one or more rankings. */
export function parseRankings(text: string): ParsedRanking[] {
  const out: ParsedRanking[] = [];
  let current: ParsedRanking | null = null;
  let pos = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (isHeader(line)) {
      if (current && current.items.length) out.push(current);
      current = { rankerName: line.trim(), items: [] };
      pos = 0;
    } else {
      if (!current) current = { rankerName: 'unknown', items: [] };
      const item = parseItem(line, pos + 1);
      if (item) {
        pos++;
        item.position = pos;
        current.items.push(item);
      }
    }
  }
  if (current && current.items.length) out.push(current);
  return out;
}
