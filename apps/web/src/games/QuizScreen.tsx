import { useEffect, useRef } from "react";
import { Check, CheckCircle2, SkipForward, Users, X, XCircle } from "lucide-react";
import type { QuizView, SessionView } from "@spotflow-games/shared";
import { usePreferences } from "../lib/preferences";
import { request } from "../lib/socket";
import { playSound } from "../lib/sound";
import { Standings } from "../components/Standings";
import { Timer, useCountdown } from "../components/Timer";

/** Fixed shape, colour and number per position, so answers never depend on colour alone. */
const SHAPES = [
  <path key="1" d="M12 3l10 18H2z" />,
  <path key="2" d="M12 2l10 10-10 10L2 12z" />,
  <circle key="3" cx="12" cy="12" r="10" />,
  <rect key="4" x="3" y="3" width="18" height="18" rx="3" />,
];
const SHAPE_NAMES = ["Triangle", "Diamond", "Circle", "Square"];

interface Props {
  session: SessionView;
  game: QuizView;
  meId: string;
  onError: (message: string) => void;
}

export function QuizScreen({ session, game, meId, onError }: Props) {
  const { soundEnabled } = usePreferences();
  const seconds = useCountdown(game.phaseEndsAt, game.serverNow);
  const isHost = session.hostId === meId;
  const me = session.participants.find((p) => p.userId === meId);
  const canAnswer = game.phase === "question" && game.isPlayer && game.myAnswer === null;
  const lastPhase = useRef<string>("");

  const send = (action: object) =>
    request("game:action", { code: session.code, action }).catch((err: Error) => onError(err.message));

  useEffect(() => {
    const key = `${game.phase}:${game.questionNumber}`;
    if (lastPhase.current === key) return;
    lastPhase.current = key;
    if (game.phase === "countdown") playSound("countdown", soundEnabled);
    if (game.phase === "reveal" && game.reveal && game.reveal.myPoints > 0) playSound("correct", soundEnabled);
  }, [game.phase, game.questionNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  // Number keys 1-4 pick an answer.
  useEffect(() => {
    if (!canAnswer || !game.question) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= game.question!.options.length) void send({ type: "answer", index: n - 1 });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canAnswer, game.question]); // eslint-disable-line react-hooks/exhaustive-deps

  if (game.phase === "countdown") {
    const n = Math.max(1, Math.ceil(seconds));
    return (
      <div className="get-ready quiz">
        <span className="sg-eyebrow">{game.title}</span>
        <h2 className="display-xl">Get ready!</h2>
        <p key={n} className="get-ready-count" aria-live="assertive">
          {n}
        </p>
        <p className="sg-muted" style={{ margin: 0 }}>
          {game.totalQuestions} questions. Answer fast: quicker right answers score more.
        </p>
      </div>
    );
  }

  const question = game.question!;
  const reveal = game.reveal;
  const correctText = reveal ? question.options[reveal.correctIndex] : "";
  const right = reveal ? reveal.myPoints > 0 : false;

  return (
    <div className="sg-stack" style={{ gap: "var(--space-5)" }}>
      <div className="sg-row" style={{ justifyContent: "space-between" }}>
        <div className="sg-stack" style={{ gap: "var(--space-2)", flex: 1, minWidth: 200, maxWidth: 360 }}>
          <span className="sg-eyebrow">
            Question {game.questionNumber} of {game.totalQuestions}
          </span>
          <div
            className="sg-progress quiz"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={game.totalQuestions}
            aria-valuenow={game.questionNumber}
            aria-label="Quiz progress"
          >
            <i style={{ width: `${(game.questionNumber / game.totalQuestions) * 100}%` }} />
          </div>
        </div>
        {game.isPlayer && me && (
          <span className="sg-score sg-num big-score">
            {me.score.toLocaleString()}
            {reveal && reveal.myPoints > 0 && (
              <span key={game.questionNumber} className="plus float-up">
                +{reveal.myPoints}
              </span>
            )}
          </span>
        )}
      </div>

      <div className="question-card">
        {game.phase === "question" && <Timer seconds={seconds} total={game.timeLimitSec} game="quiz" />}
        <h2 className="quiz-prompt">{question.prompt}</h2>
      </div>

      {reveal && game.isPlayer && (
        <div className={`reveal-burst ${right ? "right" : "miss"}`} role="status">
          {right ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}
          <div>
            <b>{right ? "Correct!" : game.myAnswer === null ? "Out of time" : "Not quite"}</b>
            <span>
              {right
                ? `+${reveal.myPoints} points${reveal.myAnswerMs !== null ? ` · ${(reveal.myAnswerMs / 1000).toFixed(1)} seconds` : ""}`
                : `The answer was ${correctText}.`}
            </span>
          </div>
        </div>
      )}

      {game.phase === "question" && game.isPlayer && game.myAnswer !== null && (
        <div className="locked-in" role="status">
          <Check aria-hidden="true" size={18} />
          Answer locked in. Waiting for everyone else
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      )}

      <div
        className={`sg-answers buzzers${reveal ? " revealed" : ""}${game.myAnswer !== null ? " answered" : ""}`}
        role="group"
        aria-label="Answers"
      >
        {question.options.map((option, i) => {
          const selected = game.myAnswer === i;
          let state = "";
          if (reveal) state = i === reveal.correctIndex ? "correct" : selected ? "wrong" : "locked";
          else if (selected) state = "selected";
          else if (!canAnswer) state = "locked";
          return (
            <button
              key={i}
              className={`sg-answer buzzer${i ? ` a${i + 1}` : ""} ${state}`}
              disabled={!canAnswer}
              aria-pressed={selected}
              aria-label={`${SHAPE_NAMES[i]} ${i + 1}: ${option}${state === "correct" ? ", correct answer" : ""}${selected ? ", your answer" : ""}`}
              onClick={() => send({ type: "answer", index: i })}
            >
              <span className="shape">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  {SHAPES[i]}
                </svg>
              </span>
              <span>{option}</span>
              {reveal && state === "correct" && (
                <span className="verdict">
                  <Check aria-hidden="true" size={18} />
                  Correct
                  {reveal.counts[i] ? ` · ${reveal.counts[i]}` : ""}
                </span>
              )}
              {reveal && state === "wrong" && (
                <span className="verdict">
                  <X aria-hidden="true" size={18} />
                  Your answer
                </span>
              )}
              {reveal && state === "locked" && reveal.counts[i]! > 0 && (
                <span className="key" aria-label={`${reveal.counts[i]} picked this`}>
                  {reveal.counts[i]}
                </span>
              )}
              {!reveal && canAnswer && (
                <span className="key" aria-hidden="true">
                  {i + 1}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="sg-row" style={{ justifyContent: "space-between" }}>
        <span className="sg-row sg-muted" style={{ fontSize: 14, gap: "var(--space-1)" }}>
          <Users aria-hidden="true" size={16} />
          {game.phase === "question"
            ? `${game.answeredCount} of ${game.playerCount} have answered`
            : `${game.answeredCount} of ${game.playerCount} answered`}
        </span>
        {isHost && (
          <button className="sg-btn secondary" onClick={() => send({ type: "next" })}>
            <SkipForward aria-hidden="true" />
            {game.phase === "question"
              ? "Close answers"
              : game.questionNumber < game.totalQuestions
                ? "Next question"
                : "Show results"}
          </button>
        )}
      </div>

      {reveal && <Standings view={session} meId={meId} gained={{ [meId]: reveal.myPoints }} />}
    </div>
  );
}
