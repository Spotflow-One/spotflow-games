import { randomInt } from "node:crypto";
import {
  TRUTHS_RULES,
  truthsSessionConfigSchema,
  truthsSubmissionSchema,
  type TruthsAction,
  type TruthsSubmission,
  type TruthsView,
} from "@spotflow-games/shared";
import { GameError, type GameContext, type GameEngine } from "../contract.js";

export interface TruthsConfig {
  featuredCount: number;
  voteSec: number;
  writeSec: number;
}

interface TruthsRound {
  authorId: string;
  /** Shuffled, so the lie isn't always where the author typed it. */
  statements: string[];
  lieIndex: number;
}

interface TruthsState {
  config: TruthsConfig;
  featuredIds: string[];
  submissions: Map<string, TruthsSubmission>;
  rounds: TruthsRound[];
  roundIndex: number;
  phase: TruthsView["phase"];
  phaseStartedAt: number;
  phaseEndsAt: number;
  /** Votes this round: statement index and how long the voter took. */
  votes: Map<string, { index: number; ms: number }>;
  roundPoints: Map<string, number>;
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function createTruthsEngine(timing: { revealMs: number } = { revealMs: TRUTHS_RULES.revealMs }) {
  const setPhase = (
    ctx: GameContext,
    state: TruthsState,
    phase: TruthsState["phase"],
    ms: number,
    next: () => void,
  ) => {
    state.phase = phase;
    state.phaseStartedAt = ctx.now();
    state.phaseEndsAt = state.phaseStartedAt + ms;
    ctx.setTimer("phase", ms, next);
    ctx.broadcastState();
  };

  const round = (state: TruthsState) => state.rounds[state.roundIndex];
  const voters = (ctx: GameContext, state: TruthsState) => ctx.players().filter((id) => id !== round(state)?.authorId);

  /** Writing is over: everyone who submitted gets a round, in the featured order. */
  const startRounds = (ctx: GameContext, state: TruthsState) => {
    if (state.phase !== "writing") return;
    const players = ctx.players();
    state.rounds = state.featuredIds
      .filter((id) => state.submissions.has(id) && players.includes(id))
      .map((authorId) => {
        const sub = state.submissions.get(authorId)!;
        const order = shuffle([0, 1, 2]);
        return {
          authorId,
          statements: order.map((i) => sub.statements[i]!),
          lieIndex: order.indexOf(sub.lieIndex),
        };
      });
    beginRound(ctx, state, 0);
  };

  const beginRound = (ctx: GameContext, state: TruthsState, index: number) => {
    // Skip authors who have left or been removed.
    while (index < state.rounds.length && !ctx.players().includes(state.rounds[index]!.authorId)) index++;
    if (index >= state.rounds.length || ctx.players().length < 2) {
      ctx.finish();
      return;
    }
    state.roundIndex = index;
    state.votes.clear();
    state.roundPoints.clear();
    setPhase(ctx, state, "voting", state.config.voteSec * 1000, () => closeVoting(ctx, state));
  };

  const closeVoting = (ctx: GameContext, state: TruthsState) => {
    if (state.phase !== "voting") return;
    const r = round(state)!;
    const key = `round${state.roundIndex}`;
    for (const id of voters(ctx, state)) {
      const vote = state.votes.get(id);
      if (vote?.index === r.lieIndex) {
        ctx.award(id, TRUTHS_RULES.correctVotePoints, "Spotted the lie", `${key}:vote`);
        ctx.addTiebreakTime(id, vote.ms);
        state.roundPoints.set(id, TRUTHS_RULES.correctVotePoints);
      } else {
        // Ties go to whoever spotted lies faster; a miss counts as the whole timer.
        ctx.addTiebreakTime(id, state.config.voteSec * 1000);
        if (vote) {
          ctx.award(r.authorId, TRUTHS_RULES.fooledPoints, "Fooled someone", `${key}:fooled:${id}`);
          state.roundPoints.set(r.authorId, (state.roundPoints.get(r.authorId) ?? 0) + TRUTHS_RULES.fooledPoints);
        }
      }
    }
    setPhase(ctx, state, "reveal", timing.revealMs, () => beginRound(ctx, state, state.roundIndex + 1));
  };

  const engine: GameEngine<TruthsConfig, TruthsState> = {
    type: "truths",
    rulesVersion: 1,
    minPlayers: 2,

    parseConfig(raw) {
      const parsed = truthsSessionConfigSchema.safeParse(raw ?? {});
      if (!parsed.success) throw new GameError("Those game settings aren't valid");
      return { ...parsed.data };
    },

    start(ctx, config) {
      const state: TruthsState = {
        config,
        featuredIds: shuffle(ctx.players()).slice(0, config.featuredCount),
        submissions: new Map(),
        rounds: [],
        roundIndex: 0,
        phase: "writing",
        phaseStartedAt: 0,
        phaseEndsAt: 0,
        votes: new Map(),
        roundPoints: new Map(),
      };
      setPhase(ctx, state, "writing", config.writeSec * 1000, () => startRounds(ctx, state));
      return state;
    },

    handleAction(ctx, state, userId, raw) {
      const action = raw as TruthsAction;
      switch (action?.type) {
        case "submit": {
          if (state.phase !== "writing") throw new GameError("Writing time is over");
          if (!state.featuredIds.includes(userId)) throw new GameError("You're not featured this game");
          const parsed = truthsSubmissionSchema.safeParse({ statements: action.statements, lieIndex: action.lieIndex });
          if (!parsed.success) {
            const issue = parsed.error.issues.find((i) => i.code === "custom");
            throw new GameError(
              issue?.message ??
                `Each statement needs ${TRUTHS_RULES.minStatementLength} to ${TRUTHS_RULES.maxStatementLength} characters`,
            );
          }
          state.submissions.set(userId, parsed.data);
          const players = ctx.players();
          if (state.featuredIds.filter((id) => players.includes(id)).every((id) => state.submissions.has(id)))
            startRounds(ctx, state);
          else ctx.broadcastState();
          return;
        }
        case "vote": {
          if (state.phase !== "voting") throw new GameError("Voting isn't open");
          if (userId === round(state)!.authorId) throw new GameError("You can't vote on your own statements");
          if (!ctx.players().includes(userId)) throw new GameError("Only players can vote");
          if (state.votes.has(userId)) throw new GameError("You already voted");
          if (!Number.isInteger(action.index) || action.index < 0 || action.index > 2)
            throw new GameError("Pick one of the statements");
          state.votes.set(userId, { index: action.index, ms: ctx.now() - state.phaseStartedAt });
          if (voters(ctx, state).every((id) => state.votes.has(id))) closeVoting(ctx, state);
          else ctx.broadcastState();
          return;
        }
        case "next": {
          if (!ctx.isHost(userId)) throw new GameError("Only the host can move on");
          if (state.phase === "writing") startRounds(ctx, state);
          else if (state.phase === "voting") closeVoting(ctx, state);
          else beginRound(ctx, state, state.roundIndex + 1);
          return;
        }
        case "skip": {
          if (!ctx.isHost(userId)) throw new GameError("Only the host can skip");
          if (state.phase !== "voting") throw new GameError("Only a round being voted on can be skipped");
          // Nobody scores on a skipped round.
          beginRound(ctx, state, state.roundIndex + 1);
          return;
        }
        default:
          throw new GameError("Unknown action");
      }
    },

    onPlayerRemoved(ctx, state, userId) {
      if (state.phase === "writing") {
        const players = ctx.players();
        const waiting = state.featuredIds.filter((id) => players.includes(id) && !state.submissions.has(id));
        if (waiting.length === 0) startRounds(ctx, state);
        return;
      }
      if (state.phase !== "voting") return;
      if (userId === round(state)?.authorId) beginRound(ctx, state, state.roundIndex + 1);
      else if (voters(ctx, state).every((id) => state.votes.has(id))) closeVoting(ctx, state);
    },

    viewFor(state, viewer): TruthsView {
      const r = state.phase === "writing" ? undefined : round(state);
      const isAuthor = r?.authorId === viewer.userId;
      const voterCount = r ? Math.max(0, viewer.playerCount - 1) : 0;
      let reveal: TruthsView["reveal"] = null;
      if (r && state.phase === "reveal") {
        const votes: string[][] = [[], [], []];
        for (const [id, v] of state.votes) votes[v.index]!.push(id);
        reveal = { lieIndex: r.lieIndex, votes, points: Object.fromEntries(state.roundPoints) };
      }
      return {
        phase: state.phase,
        phaseEndsAt: state.phaseEndsAt,
        serverNow: viewer.now,
        voteSec: state.config.voteSec,
        writeSec: state.config.writeSec,
        featuredIds: state.featuredIds,
        submittedIds: state.featuredIds.filter((id) => state.submissions.has(id)),
        isFeatured: state.featuredIds.includes(viewer.userId),
        isPlayer: viewer.isPlayer,
        mySubmission: state.phase === "writing" ? (state.submissions.get(viewer.userId) ?? null) : null,
        roundNumber: state.phase === "writing" ? 0 : state.roundIndex + 1,
        totalRounds: state.phase === "writing" ? state.featuredIds.length : state.rounds.length,
        authorId: r?.authorId ?? null,
        statements: r ? r.statements : null,
        myLieIndex: isAuthor ? r!.lieIndex : null,
        myVote: state.votes.get(viewer.userId)?.index ?? null,
        votedCount: state.votes.size,
        voterCount,
        reveal,
      };
    },
  };
  return engine;
}
