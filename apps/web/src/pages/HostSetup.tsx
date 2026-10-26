import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import {
  GAME_INFO,
  GAME_TYPES,
  QUIZ_RULES,
  type GameType,
  type QuizSummary,
  type SessionSummary,
} from "@spotflow-games/shared";
import { api } from "../lib/api";
import { GameIcon } from "../components/GameIcon";

const TIME_LIMITS = [10, 20, 30, 45, 60];

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" className="sg-switch" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>
      <span className="track" aria-hidden="true" />
      {label}
    </button>
  );
}

/** Settings a host picks before opening the lobby. */
export function HostSetup() {
  const gameType = useParams().gameType as GameType;
  const navigate = useNavigate();
  const [quizzes, setQuizzes] = useState<QuizSummary[] | null>(null);
  const [quizId, setQuizId] = useState<string | null>(null);
  const [timeLimitSec, setTimeLimitSec] = useState<number>(QUIZ_RULES.defaultTimeLimitSec);
  const [shuffleQuestions, setShuffleQuestions] = useState(false);
  const [shuffleOptions, setShuffleOptions] = useState(true);
  const [hostPlays, setHostPlays] = useState(true);
  const [allowLateJoin, setAllowLateJoin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (gameType !== "quiz") return;
    api<QuizSummary[]>("/api/quizzes").then(
      (list) => {
        setQuizzes(list);
        setQuizId((id) => id ?? list[0]?.id ?? null);
      },
      (err: Error) => setError(err.message),
    );
  }, [gameType]);

  if (!GAME_TYPES.includes(gameType)) return <Navigate to="/" replace />;
  const info = GAME_INFO[gameType];

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const config = gameType === "quiz" ? { quizId, timeLimitSec, shuffleQuestions, shuffleOptions } : {};
    try {
      const s = await api<SessionSummary>("/api/sessions", {
        method: "POST",
        body: { gameType, hostPlays, allowLateJoin, config },
      });
      navigate(`/s/${s.code}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="sg-stack" style={{ gap: "var(--space-6)" }} onSubmit={create}>
      <div className="sg-stack" style={{ gap: "var(--space-2)" }}>
        <span className={`sg-badge ${gameType}`}>
          <GameIcon type={gameType} size={16} />
          {info.name}
        </span>
        <h1 className="sg-h1">Set up your game</h1>
      </div>

      {error && (
        <div className="sg-banner danger" role="alert">
          {error}
        </div>
      )}

      {gameType === "quiz" && (
        <section className="sg-card sg-stack" aria-labelledby="quiz-pick">
          <h2 id="quiz-pick" className="sg-h3">
            Pick a quiz
          </h2>
          {!quizzes && <p className="sg-muted">Loading quizzes…</p>}
          <div className="quiz-picker" role="radiogroup" aria-labelledby="quiz-pick">
            {quizzes?.map((q) => (
              <button
                type="button"
                key={q.id}
                role="radio"
                aria-checked={quizId === q.id}
                className="quiz-option"
                onClick={() => setQuizId(q.id)}
              >
                <b>{q.title}</b>
                <span className="sg-muted">{q.description}</span>
                <span className="sg-muted">
                  {q.questionCount} questions{q.curated ? " · Curated" : ""}
                </span>
              </button>
            ))}
          </div>
          <div className="sg-field">
            <label id="time-limit">Time per question</label>
            <div className="sg-seg" role="radiogroup" aria-labelledby="time-limit">
              {TIME_LIMITS.map((t) => (
                <button
                  type="button"
                  key={t}
                  role="radio"
                  aria-checked={timeLimitSec === t}
                  onClick={() => setTimeLimitSec(t)}
                >
                  {t}s
                </button>
              ))}
            </div>
          </div>
          <div className="sg-row">
            <Switch checked={shuffleQuestions} onChange={setShuffleQuestions} label="Shuffle questions" />
            <Switch checked={shuffleOptions} onChange={setShuffleOptions} label="Shuffle answers" />
          </div>
        </section>
      )}

      <section className="sg-card sg-stack" aria-labelledby="session-settings">
        <h2 id="session-settings" className="sg-h3">
          Session
        </h2>
        <Switch checked={hostPlays} onChange={setHostPlays} label="I'm playing too" />
        <Switch checked={allowLateJoin} onChange={setAllowLateJoin} label="Let people join after the game starts" />
      </section>

      <div className="sg-row">
        <button className={`sg-btn lg ${gameType}`} type="submit" disabled={busy || (gameType === "quiz" && !quizId)}>
          {busy ? "Opening lobby…" : "Open lobby"}
        </button>
        <Link className="sg-btn ghost" to="/">
          Back
        </Link>
      </div>
    </form>
  );
}
