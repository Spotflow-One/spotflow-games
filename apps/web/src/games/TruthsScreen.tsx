import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCircle2, Lightbulb, PenLine, SkipForward, Users, X, XCircle } from "lucide-react";
import { TRUTHS_PROMPTS, TRUTHS_RULES, type SessionView, type TruthsView } from "@spotflow-games/shared";
import { usePreferences } from "../lib/preferences";
import { request } from "../lib/socket";
import { playSound } from "../lib/sound";
import { Avatar } from "../components/Avatar";
import { Timer, useCountdown } from "../components/Timer";

interface Props {
  session: SessionView;
  game: TruthsView;
  meId: string;
  onError: (message: string) => void;
}

export function TruthsScreen({ session, game, meId, onError }: Props) {
  const { soundEnabled } = usePreferences();
  const seconds = useCountdown(game.phaseEndsAt, game.serverNow);
  const isHost = session.hostId === meId;
  const me = session.participants.find((p) => p.userId === meId);
  const lastPhase = useRef("");

  const send = (action: object) =>
    request("game:action", { code: session.code, action }).then(
      () => true,
      (err: Error) => {
        onError(err.message);
        return false;
      },
    );

  useEffect(() => {
    const key = `${game.phase}:${game.roundNumber}`;
    if (lastPhase.current === key) return;
    lastPhase.current = key;
    if (game.phase === "voting") playSound("countdown", soundEnabled);
    if (game.phase === "reveal" && (game.reveal?.points[meId] ?? 0) > 0) playSound("correct", soundEnabled);
  }, [game.phase, game.roundNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="sg-stack" style={{ gap: "var(--space-6)" }}>
      <div className="sg-row" style={{ justifyContent: "space-between" }}>
        <div className="sg-stack" style={{ gap: "var(--space-2)", flex: 1, minWidth: 200, maxWidth: 360 }}>
          <span className="sg-eyebrow">
            {game.phase === "writing" ? "Writing time" : `Round ${game.roundNumber} of ${game.totalRounds}`}
          </span>
          {game.phase !== "writing" && (
            <div
              className="sg-progress truths"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={game.totalRounds}
              aria-valuenow={game.roundNumber}
              aria-label="Game progress"
            >
              <i style={{ width: `${(game.roundNumber / game.totalRounds) * 100}%` }} />
            </div>
          )}
        </div>
        {game.isPlayer && me && (
          <span className="sg-score sg-num">
            {me.score.toLocaleString()}
            {game.reveal && (game.reveal.points[meId] ?? 0) > 0 && (
              <span className="plus">+{game.reveal.points[meId]}</span>
            )}
          </span>
        )}
      </div>

      {game.phase === "writing" ? (
        <Writing session={session} game={game} seconds={seconds} send={send} />
      ) : (
        <Round session={session} game={game} meId={meId} seconds={seconds} send={send} />
      )}

      {isHost && (
        <div className="sg-row" style={{ justifyContent: "flex-end" }}>
          {game.phase === "voting" && (
            <button className="sg-btn ghost" onClick={() => send({ type: "skip" })}>
              Skip this round
            </button>
          )}
          <button className="sg-btn secondary" onClick={() => send({ type: "next" })}>
            <SkipForward aria-hidden="true" />
            {game.phase === "writing"
              ? "Start voting now"
              : game.phase === "voting"
                ? "Close voting"
                : game.roundNumber < game.totalRounds
                  ? "Next round"
                  : "Show results"}
          </button>
        </div>
      )}
    </div>
  );
}

type Send = (action: object) => Promise<boolean>;

function Writing({
  session,
  game,
  seconds,
  send,
}: {
  session: SessionView;
  game: TruthsView;
  seconds: number;
  send: Send;
}) {
  const [statements, setStatements] = useState<[string, string, string]>(
    () => (game.mySubmission?.statements as [string, string, string]) ?? ["", "", ""],
  );
  const [lieIndex, setLieIndex] = useState<number | null>(game.mySubmission?.lieIndex ?? null);
  const [dirty, setDirty] = useState(false);
  const ideas = useMemo(() => [...TRUTHS_PROMPTS].sort(() => Math.random() - 0.5).slice(0, 3), []);
  const featured = game.featuredIds.map((id) => session.participants.find((p) => p.userId === id)).filter(Boolean);
  const submitted = game.mySubmission !== null;
  const ready = lieIndex !== null && statements.every((s) => s.trim().length >= TRUTHS_RULES.minStatementLength);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    if (await send({ type: "submit", statements: statements.map((s) => s.trim()), lieIndex })) setDirty(false);
  };

  return (
    <>
      <div className="sg-row" style={{ gap: "var(--space-6)", alignItems: "center", flexWrap: "nowrap" }}>
        <Timer seconds={seconds} total={game.writeSec} game="truths" />
        <div className="sg-stack" style={{ gap: "var(--space-2)", flex: 1, minWidth: 0 }}>
          <h2 className="sg-h2" style={{ margin: 0 }}>
            {game.isFeatured ? "Write two truths and a lie" : "The featured players are writing"}
          </h2>
          <p className="sg-muted" style={{ margin: 0 }}>
            {game.isFeatured
              ? "Mark which one is the lie. Everyone else will try to spot it."
              : "Get ready to spot their lies. Voting starts when they're done."}
          </p>
        </div>
      </div>

      {game.isFeatured && (
        <form className="sg-card sg-stack" onSubmit={submit} aria-label="Your statements">
          {statements.map((s, i) => (
            <div key={i} className="sg-field">
              <label htmlFor={`stmt-${i}`}>Statement {i + 1}</label>
              <div className="sg-row" style={{ flexWrap: "nowrap" }}>
                <input
                  id={`stmt-${i}`}
                  className="sg-input"
                  style={{ flex: 1, minWidth: 0 }}
                  maxLength={TRUTHS_RULES.maxStatementLength}
                  autoComplete="off"
                  value={s}
                  onChange={(e) => {
                    const next = [...statements] as [string, string, string];
                    next[i] = e.target.value;
                    setStatements(next);
                    setDirty(true);
                  }}
                />
                <button
                  type="button"
                  className={`sg-btn sm ${lieIndex === i ? "truths" : "secondary"}`}
                  aria-pressed={lieIndex === i}
                  aria-label={`Statement ${i + 1} is the lie`}
                  onClick={() => {
                    setLieIndex(i);
                    setDirty(true);
                  }}
                >
                  {lieIndex === i ? <X aria-hidden="true" size={16} /> : null}
                  {lieIndex === i ? "The lie" : "Lie?"}
                </button>
              </div>
            </div>
          ))}
          <p className="sg-row sg-muted" style={{ margin: 0, fontSize: 14, gap: "var(--space-2)" }}>
            <Lightbulb aria-hidden="true" size={16} />
            Ideas: {ideas.join(" · ")}
          </p>
          <div className="sg-row">
            <button className="sg-btn truths" type="submit" disabled={!ready || (submitted && !dirty)}>
              <PenLine aria-hidden="true" />
              {submitted ? (dirty ? "Update my statements" : "Locked in") : "Lock in"}
            </button>
            {lieIndex === null && <span className="sg-muted">Pick which statement is the lie.</span>}
            {submitted && !dirty && <span className="sg-muted">You can still edit until writing time ends.</span>}
          </div>
        </form>
      )}

      <section className="sg-card sg-stack" aria-labelledby="featured-heading">
        <h3 id="featured-heading" className="sg-h3">
          Featured this game
        </h3>
        <div className="sg-roster">
          {featured.map((p) => {
            const done = game.submittedIds.includes(p!.userId);
            return (
              <div key={p!.userId} className="sg-player">
                <Avatar avatar={p!.avatar} name={p!.displayName} userId={p!.userId} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="nm">{p!.displayName}</div>
                  <div className="sub">
                    {done ? (
                      <span className="sg-row" style={{ gap: "var(--space-1)" }}>
                        <Check aria-hidden="true" size={14} /> Ready
                      </span>
                    ) : (
                      "Writing…"
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

function Round({
  session,
  game,
  meId,
  seconds,
  send,
}: {
  session: SessionView;
  game: TruthsView;
  meId: string;
  seconds: number;
  send: Send;
}) {
  const author = session.participants.find((p) => p.userId === game.authorId);
  const isAuthor = game.authorId === meId;
  const reveal = game.reveal;
  const canVote = game.phase === "voting" && game.isPlayer && !isAuthor && game.myVote === null;
  const statements = game.statements ?? [];
  const nameOf = (id: string) => session.participants.find((p) => p.userId === id);

  // Number keys 1-3 vote.
  useEffect(() => {
    if (!canVote) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 3) void send({ type: "vote", index: n - 1 });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canVote]); // eslint-disable-line react-hooks/exhaustive-deps

  const fooled = reveal ? reveal.votes.reduce((n, v, i) => (i === reveal.lieIndex ? n : n + v.length), 0) : 0;
  const myPoints = reveal?.points[meId] ?? 0;
  const authorName = isAuthor ? "your" : `${author?.displayName ?? "their"}'s`;

  return (
    <>
      <div className="sg-row" style={{ gap: "var(--space-6)", alignItems: "center", flexWrap: "nowrap" }}>
        {game.phase === "voting" && <Timer seconds={seconds} total={game.voteSec} game="truths" />}
        {author && (
          <span className="truths-author">
            <Avatar avatar={author.avatar} name={author.displayName} userId={author.userId} size="lg" />
          </span>
        )}
        <h2 className="sg-h1" style={{ flex: 1, minWidth: 0, margin: 0 }}>
          {game.phase === "voting"
            ? isAuthor
              ? "Everyone is guessing your lie"
              : `Which is ${authorName} lie?`
            : `Here's ${authorName} lie`}
        </h2>
      </div>

      {reveal && game.isPlayer && (
        <div
          className={`sg-banner ${isAuthor ? (fooled > 0 ? "success" : "") : myPoints > 0 ? "success" : "danger"}`}
          role="status"
        >
          <span className="ic">
            {isAuthor || myPoints > 0 ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}
          </span>
          <span>
            {isAuthor ? (
              fooled > 0 ? (
                <>
                  <b>
                    You fooled {fooled} {fooled === 1 ? "person" : "people"}!
                  </b>{" "}
                  +{myPoints} points
                </>
              ) : (
                <>
                  <b>Nobody was fooled.</b> Better luck next time.
                </>
              )
            ) : myPoints > 0 ? (
              <>
                <b>You spotted it!</b> +{myPoints} points
              </>
            ) : game.myVote === null ? (
              <>
                <b>Out of time.</b> No vote this round.
              </>
            ) : (
              <>
                <b>Fooled!</b> That one was true.
              </>
            )}
          </span>
        </div>
      )}

      <div className="sg-stack" role="group" aria-label="Statements" style={{ gap: "var(--space-3)" }}>
        {statements.map((text, i) => {
          const voted = game.myVote === i;
          const isLie = reveal ? reveal.lieIndex === i : false;
          const voters = reveal?.votes[i] ?? [];
          const state = reveal ? (isLie ? "lie" : "truth") : voted ? "voted" : "";
          const label = [
            `Statement ${i + 1}: ${text}`,
            reveal ? (isLie ? "the lie" : "true") : "",
            !reveal && isAuthor && game.myLieIndex === i ? "your lie" : "",
            voted ? "your vote" : "",
            reveal ? `${voters.length} ${voters.length === 1 ? "vote" : "votes"}` : "",
          ]
            .filter(Boolean)
            .join(", ");
          return (
            <button
              key={i}
              className={`sg-statement ${state}`}
              disabled={!canVote}
              aria-pressed={voted}
              aria-label={label}
              style={{ cursor: canVote ? "pointer" : "default" }}
              onClick={() => send({ type: "vote", index: i })}
            >
              <span className="n" aria-hidden="true">
                {i + 1}
              </span>
              <span className="body">
                {text}
                {(reveal || voted || (isAuthor && game.myLieIndex === i)) && (
                  <span className="tag" aria-hidden="true">
                    {reveal ? (
                      isLie ? (
                        <>
                          <X size={16} /> <b>The lie</b>
                        </>
                      ) : (
                        <>
                          <Check size={16} /> True
                        </>
                      )
                    ) : isAuthor ? (
                      <>
                        <X size={16} /> Your lie
                      </>
                    ) : (
                      <>
                        <Check size={16} /> Your vote
                      </>
                    )}
                    {reveal && voters.length > 0 && (
                      <>
                        <span>
                          · {voters.length} {voters.length === 1 ? "vote" : "votes"}
                        </span>
                        <span className="sg-votes">
                          {voters.slice(0, 6).map((id) => {
                            const p = nameOf(id);
                            return p ? (
                              <Avatar key={id} avatar={p.avatar} name={p.displayName} userId={id} size="xs" />
                            ) : null;
                          })}
                        </span>
                      </>
                    )}
                    {reveal && voted && <span>· Your vote</span>}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <span className="sg-row sg-muted" style={{ fontSize: 14, gap: "var(--space-1)" }}>
        <Users aria-hidden="true" size={16} />
        {game.phase === "voting"
          ? `${game.votedCount} of ${game.voterCount} have voted`
          : `${game.votedCount} of ${game.voterCount} voted`}
        {game.phase === "voting" && game.myVote !== null && " · Vote locked in"}
        {game.phase === "voting" && !game.isPlayer && " · You're watching"}
      </span>
    </>
  );
}
