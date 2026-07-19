// Text normalization primitives, ported/adapted from the-sorter
// (src/utils/setlist-prediction/import.ts, src/utils/search.ts) and
// llernote (scripts/internal/lib/string-match.ts). One canonical set of
// normalizers so the catalog index and the import matcher agree.

import { toHiragana, toRomaji } from 'wanakana';

/** Fold full-width katakana → hiragana so kana variants compare equal. */
export function foldKana(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    // Katakana block 0x30A1–0x30F6 → hiragana by subtracting 0x60.
    if (code >= 0x30a1 && code <= 0x30f6) out += String.fromCharCode(code - 0x60);
    else out += ch;
  }
  return out;
}

/**
 * Loose normalization: NFKC, lowercase, drop everything outside letters/digits,
 * collapse whitespace. Mirrors the-sorter's import normalizer (strip non
 * \p{L}\p{N}, remove spaces) — spaces are removed entirely so "Go!! Restart"
 * and "Go Restart" collapse to the same key.
 */
export function normalizeKey(input: string): string {
  return foldKana(input.normalize('NFKC'))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

/** Strict alnum-only key (romaji/english collisions). */
export function normalizeStrict(input: string): string {
  return input.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Convert a phonetic (hiragana) or mixed string to a normalized romaji key. */
export function phoneticToRomajiKey(input: string): string {
  try {
    return normalizeStrict(toRomaji(toHiragana(input)));
  } catch {
    return normalizeStrict(input);
  }
}

/** Classic Levenshtein distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Similarity in [0,1] from Levenshtein over the longer string. */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

/** Length-tiered max edit distance budget (from the-sorter search.ts). */
export function maxDistanceForLength(len: number): number {
  if (len <= 3) return 0;
  if (len <= 5) return 1;
  if (len <= 8) return 2;
  return 3;
}
