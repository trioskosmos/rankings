// Eligibility-aware aggregation across rankings that cover different subsets.
//
// Core principle: "not ranked" ≠ "ranked last". A song absent because it was
// out of a list's universe must not be penalized. We therefore:
//  - average normalized rank only over lists that actually ranked the song
//    (absence never drags a song down), then
//  - shrink toward a neutral prior by appearance count (so a #1 on a single
//    niche list can't outrank a song consistently high across many lists), and
//  - offer a Borda consensus that DOES penalize "eligible but you left it out"
//    (0 points) while skipping "out of scope" entirely.

export interface AggRanking {
  scopeType: 'all' | 'series' | 'performance' | 'custom';
  scopeRef: string | null;
  songIds: string[]; // resolved, in rank order (index 0 = rank 1)
}

export interface AggStat {
  songId: string;
  avgNorm: number; // mean normalized rank over lists that ranked it (0=top, 1=bottom)
  score: number; // shrunk, higher = better (for default sort)
  borda: number; // consensus in [0,1], higher = better
  median: number; // median normalized rank
  stddev: number;
  nLists: number; // lists that ranked it
  nEligible: number; // lists where it was in-universe
}

const PRIOR = 0.5; // neutral normalized rank
const K = 4; // shrinkage strength (pseudo-counts)

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stddev(xs: number[], mean: number): number {
  if (xs.length < 2) return 0;
  return Math.sqrt(xs.reduce((a, v) => a + (v - mean) ** 2, 0) / xs.length);
}

/**
 * @param rankings approved rankings with resolved song ids in order
 * @param songSeries songId → series ids (for series-scope eligibility)
 * @param allSongIds every catalog song id (for 'all'-scope eligibility)
 */
export function computeAggregate(
  rankings: AggRanking[],
  songSeries: Map<string, number[]>,
  allSongIds: string[],
): AggStat[] {
  const norms = new Map<string, number[]>(); // songId → normalized ranks (where ranked)
  const bordaSum = new Map<string, number>(); // songId → summed borda points over eligible lists
  const eligibleCount = new Map<string, number>(); // songId → # eligible lists

  const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

  const isEligible = (songId: string, r: AggRanking, rankedSet: Set<string>): boolean => {
    switch (r.scopeType) {
      case 'all':
        return true;
      case 'series':
        return (songSeries.get(songId) ?? []).map(String).includes(String(r.scopeRef));
      // performance/custom: can't infer a universe → only the ranked songs count.
      default:
        return rankedSet.has(songId);
    }
  };

  for (const r of rankings) {
    const n = r.songIds.length;
    if (!n) continue;
    const rankedSet = new Set(r.songIds);
    const rankOf = new Map(r.songIds.map((id, i) => [id, i + 1]));

    // Universe of songs this list had an opinion about.
    const universe = r.scopeType === 'all' ? allSongIds : r.scopeType === 'series' ? allSongIds : r.songIds;

    for (const songId of universe) {
      if (!isEligible(songId, r, rankedSet)) continue;
      bump(eligibleCount, songId, 1);
      const rank = rankOf.get(songId);
      if (rank) {
        const normalized = rank / n; // (0,1]
        if (!norms.has(songId)) norms.set(songId, []);
        norms.get(songId)!.push(normalized);
        // Borda: rank 1 → ~1.0, rank n → ~1/n.
        bump(bordaSum, songId, (n - rank + 1) / n);
      }
      // eligible-but-unranked → contributes 0 to bordaSum (penalized), but not to norms.
    }
  }

  const stats: AggStat[] = [];
  for (const [songId, ns] of norms) {
    const nLists = ns.length;
    const avgNorm = ns.reduce((a, b) => a + b, 0) / nLists;
    const shrunkNorm = (nLists * avgNorm + K * PRIOR) / (nLists + K);
    const nEligible = eligibleCount.get(songId) ?? nLists;
    stats.push({
      songId,
      avgNorm,
      score: 1 - shrunkNorm, // higher = better
      borda: (bordaSum.get(songId) ?? 0) / nEligible,
      median: median(ns),
      stddev: stddev(ns, avgNorm),
      nLists,
      nEligible,
    });
  }
  stats.sort((a, b) => b.score - a.score);
  return stats;
}
