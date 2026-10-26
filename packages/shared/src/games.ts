export const GAME_TYPES = ["quiz", "draw", "truths"] as const;
export type GameType = (typeof GAME_TYPES)[number];

export const GAME_INFO: Record<GameType, { name: string; tagline: string; minPlayers: number }> = {
  quiz: { name: "Quiz Arena", tagline: "Timed multiplayer quiz", minPlayers: 1 },
  draw: { name: "Draw & Guess", tagline: "One draws, everyone guesses", minPlayers: 2 },
  truths: { name: "Two Truths and a Lie", tagline: "Spot the lie", minPlayers: 2 },
};
