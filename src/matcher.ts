// Free-text "song - artist" → canonical song id matcher.
//
// Two tiers, following the-sorter/llernote:
//  1. Deterministic: normalized multi-key lookup with NULL-on-collision
//     (an ambiguous name resolves to nothing rather than the wrong song).
//  2. Fuzzy: graded getSearchScore candidates, disambiguated by the artist half.

import {
  normalizeKey,
  normalizeStrict,
  phoneticToRomajiKey,
  similarity,
  maxDistanceForLength,
  levenshtein,
} from './normalize.ts';
import type { Catalog, CatalogSong, Candidate, MatchResult, ParsedItem } from './types.ts';

const COLLISION = Symbol('collision');

export interface Alias {
  normKey: string;
  songId: string;
}

interface IndexedSong {
  song: CatalogSong;
  nameKey: string;
  enKey: string;
  romajiKey: string;
  artistKeys: string[];
}

export class Matcher {
  private keyMap = new Map<string, string | typeof COLLISION>();
  private aliasKeys = new Set<string>();
  private songs: IndexedSong[] = [];
  private seriesName = new Map<string, string>();
  private artistName = new Map<string, string>();

  constructor(catalog: Catalog, aliases: Alias[] = []) {
    for (const s of catalog.series) this.seriesName.set(s.id, s.name);
    for (const a of catalog.artists) this.artistName.set(a.id, a.name);

    // artist-name → normalized key lookup, for the artist-half disambiguation.
    const artistKeyById = new Map<string, string[]>();
    for (const a of catalog.artists) {
      const keys = [normalizeKey(a.name)];
      if (a.englishName) keys.push(normalizeKey(a.englishName));
      artistKeyById.set(a.id, keys.filter(Boolean));
    }

    for (const song of catalog.songs) {
      const nameKey = normalizeKey(song.name);
      const enKey = song.englishName ? normalizeStrict(song.englishName) : '';
      const romajiKey = song.phoneticName ? phoneticToRomajiKey(song.phoneticName) : '';
      const artistKeys = song.artistIds.flatMap((id) => artistKeyById.get(id) ?? []);

      this.songs.push({ song, nameKey, enKey, romajiKey, artistKeys });

      // Register every match key; collision → NULL so we never guess wrong.
      for (const k of [nameKey, enKey, romajiKey]) this.addKey(k, song.id);
      if (song.englishName) this.addKey(phoneticToRomajiKey(song.englishName), song.id);
    }

    // Approved aliases are explicit human decisions, so they WIN — even over a
    // collision (resolving the ambiguity a bare title couldn't).
    for (const alias of aliases) {
      this.keyMap.set(alias.normKey, alias.songId);
      this.aliasKeys.add(alias.normKey);
    }
  }

  private addKey(key: string, songId: string) {
    if (!key) return;
    const existing = this.keyMap.get(key);
    if (existing === undefined) this.keyMap.set(key, songId);
    else if (existing !== songId) this.keyMap.set(key, COLLISION); // ambiguous
  }

  /** Exact deterministic resolve. Returns id, null (no key), or 'collision'. */
  private resolveExact(songText: string): { songId: string; via: 'name' | 'romaji' | 'alias' } | null | 'collision' {
    const nameKey = normalizeKey(songText);
    const romajiKey = phoneticToRomajiKey(songText);
    let sawCollision = false;
    for (const [key, via] of [
      [nameKey, 'name'] as const,
      [normalizeStrict(songText), 'name'] as const,
      [romajiKey, 'romaji'] as const,
    ]) {
      const hit = this.keyMap.get(key);
      if (hit === COLLISION) sawCollision = true;
      else if (typeof hit === 'string') return { songId: hit, via: this.aliasKeys.has(key) ? 'alias' : via };
    }
    return sawCollision ? 'collision' : null;
  }

  /** Graded 0..100 score of a query against one indexed song (search.ts model). */
  private scoreSong(q: { nameKey: string; strictKey: string; romajiKey: string }, is: IndexedSong): number {
    if (q.nameKey && q.nameKey === is.nameKey) return 100;
    if (q.strictKey && is.enKey && q.strictKey === is.enKey) return 95;
    if (q.romajiKey && is.romajiKey && q.romajiKey === is.romajiKey) return 92;

    if (q.nameKey && is.nameKey) {
      if (is.nameKey.startsWith(q.nameKey) || q.nameKey.startsWith(is.nameKey)) return 88;
      if (is.nameKey.includes(q.nameKey) || q.nameKey.includes(is.nameKey)) return 78;
    }
    if (q.strictKey && is.enKey && (is.enKey.includes(q.strictKey) || q.strictKey.includes(is.enKey))) return 74;
    if (q.romajiKey && is.romajiKey && (is.romajiKey.includes(q.romajiKey) || q.romajiKey.includes(is.romajiKey)))
      return 66;

    // Fuzzy: best similarity across name / english / romaji, gated by edit budget.
    let best = 0;
    for (const [qk, ik] of [
      [q.nameKey, is.nameKey],
      [q.strictKey, is.enKey],
      [q.romajiKey, is.romajiKey],
    ]) {
      if (!qk || !ik) continue;
      const budget = maxDistanceForLength(Math.max(qk.length, ik.length));
      if (levenshtein(qk, ik) <= budget) best = Math.max(best, similarity(qk, ik));
    }
    return best > 0 ? Math.round(50 + best * 15) : 0; // 50..65 fuzzy band
  }

  /** Boost candidates whose artist matches the free-text artist half. */
  private artistBoost(artistText: string | null, is: IndexedSong): number {
    if (!artistText) return 0;
    const aKey = normalizeKey(artistText);
    if (!aKey) return 0;
    for (const k of is.artistKeys) {
      if (!k) continue;
      if (k === aKey) return 12;
      if (k.includes(aKey) || aKey.includes(k)) return 6;
    }
    return 0;
  }

  private seriesLabel(song: CatalogSong): string {
    return song.seriesIds.map((id) => this.seriesName.get(String(id))).filter(Boolean).join(', ') || 'Unknown';
  }

  private artistLabel(song: CatalogSong): string {
    return song.artistIds.map((id) => this.artistName.get(id)).filter(Boolean).join(', ') || 'Unknown';
  }

  private toCandidate(is: IndexedSong, score: number): Candidate {
    return {
      songId: is.song.id,
      name: is.song.name,
      englishName: is.song.englishName,
      artist: this.artistLabel(is.song),
      series: this.seriesLabel(is.song),
      score,
    };
  }

  /** Score every song for a query; returns them sorted by RAW (uncapped) score.
   *  Raw scores keep the artist boost distinct even when the base score is 100,
   *  which is what lets the artist half break a same-title collision. */
  private scoreAll(songText: string, artistText: string | null): Array<{ is: IndexedSong; raw: number }> {
    const q = {
      nameKey: normalizeKey(songText),
      strictKey: normalizeStrict(songText),
      romajiKey: phoneticToRomajiKey(songText),
    };
    const scored: Array<{ is: IndexedSong; raw: number }> = [];
    for (const is of this.songs) {
      const base = this.scoreSong(q, is);
      if (base > 0) scored.push({ is, raw: base + this.artistBoost(artistText, is) });
    }
    scored.sort((a, b) => b.raw - a.raw);
    return scored;
  }

  /** Rank all songs for a query; returns top-N scored candidates (score capped at 100 for display). */
  candidates(songText: string, artistText: string | null, limit = 6): Candidate[] {
    return this.scoreAll(songText, artistText)
      .slice(0, limit)
      .map(({ is, raw }) => this.toCandidate(is, Math.min(100, raw)));
  }

  /** Full match for one parsed line. */
  match(item: ParsedItem): MatchResult {
    const base = {
      position: item.position,
      rawLine: item.rawLine,
      songText: item.songText,
      artistText: item.artistText,
    };

    const exact = this.resolveExact(item.songText);
    if (exact && exact !== 'collision') {
      return { ...base, state: 'matched', songId: exact.songId, via: exact.via, score: 100, candidates: [] };
    }

    // Collision or no exact key → fuzzy + artist disambiguation. Decide confidence
    // on RAW scores so an artist match can break a same-title (100/100) collision.
    const scored = this.scoreAll(item.songText, item.artistText);
    if (scored.length === 0) {
      return { ...base, state: 'unmatched', songId: null, via: 'none', score: 0, candidates: [] };
    }
    const cands = scored.slice(0, 6).map(({ is, raw }) => this.toCandidate(is, Math.min(100, raw)));
    const top = scored[0];
    const second = scored[1];
    const confident = top.raw >= 90 && (!second || top.raw - second.raw >= 8);
    if (confident) {
      return {
        ...base,
        state: 'matched',
        songId: top.is.song.id,
        via: top.raw >= 100 ? 'name' : 'fuzzy',
        score: Math.min(100, top.raw),
        candidates: cands.slice(1),
      };
    }
    return { ...base, state: 'ambiguous', songId: null, via: 'none', score: Math.min(100, top.raw), candidates: cands };
  }
}
