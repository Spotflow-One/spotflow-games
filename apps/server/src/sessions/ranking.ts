export interface RankInput {
  userId: string;
  score: number;
  /** Lower wins ties, e.g. total answer time in ms. */
  tiebreak: number;
  displayName: string;
}

/**
 * Deterministic ranking: higher score first; equal scores share a rank unless the
 * tiebreak differs; display name then user id fix the display order.
 */
export function rankPlayers(players: RankInput[]): Array<RankInput & { rank: number }> {
  const sorted = [...players].sort(
    (a, b) =>
      b.score - a.score ||
      a.tiebreak - b.tiebreak ||
      a.displayName.localeCompare(b.displayName) ||
      a.userId.localeCompare(b.userId),
  );
  let rank = 0;
  return sorted.map((p, i) => {
    const prev = sorted[i - 1];
    if (!prev || prev.score !== p.score || prev.tiebreak !== p.tiebreak) rank = i + 1;
    return { ...p, rank };
  });
}
