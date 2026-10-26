import { describe, expect, it } from "vitest";
import { rankPlayers } from "../src/sessions/ranking.js";

describe("rankPlayers", () => {
  it("orders by score then faster time, and shares ranks on full ties", () => {
    const ranked = rankPlayers([
      { userId: "a", displayName: "A", score: 100, tiebreak: 50 },
      { userId: "b", displayName: "B", score: 200, tiebreak: 90 },
      { userId: "c", displayName: "C", score: 100, tiebreak: 30 },
      { userId: "d", displayName: "D", score: 100, tiebreak: 30 },
    ]);
    expect(ranked.map((r) => [r.userId, r.rank])).toEqual([
      ["b", 1],
      ["c", 2],
      ["d", 2],
      ["a", 4],
    ]);
  });
});
