import type { GameEngine } from "../src/games/contract.js";
import { GameError } from "../src/games/contract.js";

/** A tiny engine for exercising the session lifecycle: each "point" action awards once per round. */
export const testEngine: GameEngine<{ rounds: number }, { round: number; secret: string }> = {
  type: "quiz",
  rulesVersion: 1,
  minPlayers: 1,
  parseConfig: (raw) => ({ rounds: Number((raw as { rounds?: number })?.rounds ?? 2) }),
  start: () => ({ round: 1, secret: "hidden" }),
  handleAction(ctx, state, userId, action) {
    const a = action as { type?: string };
    if (a?.type === "point") {
      ctx.award(userId, 100, "test point", `round:${state.round}`);
      ctx.addTiebreakTime(userId, 10);
      ctx.broadcastState();
    } else if (a?.type === "next") {
      state.round++;
      ctx.broadcastState();
    } else if (a?.type === "finish") {
      ctx.finish();
    } else {
      throw new GameError("Unknown action");
    }
  },
  viewFor: (state) => ({ round: state.round }),
};
