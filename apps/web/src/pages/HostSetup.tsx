import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import {
  GAME_INFO,
  GAME_TYPES,
  DRAW_RULES,
  QUIZ_RULES,
  TRUTHS_RULES,
  type GameType,
  type WordListSummary,
  type QuizSummary,
  type SessionSummary,
} from "@spotflow-games/shared";
import { api } from "../lib/api";
import { GameIcon } from "../components/GameIcon";

const TIME_LIMITS = [10, 20, 30, 45, 60];
const TURN_LENGTHS = [45, 60, 80, 100, 120];
const VOTE_LENGTHS = [15, 30, 45, 60];
const WRITE_LENGTHS = [60, 120, 180, 300];

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
  const [wordLists, setWordLists] = useState<WordListSummary[] | null>(null);
  const [wordListId, setWordListId] = useState<string | null>(null);
  const [turnSec, setTurnSec] = useState<number>(DRAW_RULES.defaultTurnSec);
  const [rounds, setRounds] = useState(1);
  const [featuredCount, setFeaturedCount] = useState<number>(TRUTHS_RULES.defaultFeatured);
  const [voteSec, setVoteSec] = useState<number>(TRUTHS_RULES.defaultVoteSec);
  const [writeSec, setWriteSec] = useState<number>(TRUTHS_RULES.defaultWriteSec);
  const [hostPlays, setHostPlays] = useState(true);
  const [allowLateJoin, setAllowLateJoin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (gameType !== "draw") return;
    api<WordListSummary[]>("/api/word-lists").then(
      (list) => {
        setWordLists(list);
        setWordListId((id) => id ?? list[0]?.id ?? null);
      },
      (err: Error) => setError(err.message),
    );
  }, [gameType]);

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
    const config =
      gameType === "quiz"
        ? { quizId, timeLimitSec, shuffleQuestions, shuffleOptions }
        : gameType === "draw"
          ? { wordListId, turnSec, rounds }
          : { featuredCount, voteSec, writeSec };
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

      {gameType === "draw" && (
        <section className="sg-card sg-stack" aria-labelledby="words-pick">
          <h2 id="words-pick" className="sg-h3">
            Pick a word list
          </h2>
          {!wordLists && <p className="sg-muted">Loading word lists…</p>}
          <div className="quiz-picker" role="radiogroup" aria-labelledby="words-pick">
            {wordLists?.map((l) => (
              <button
                type="button"
                key={l.id}
                role="radio"
                aria-checked={wordListId === l.id}
                className="quiz-option"
                onClick={() => setWordListId(l.id)}
              >
                <b>{l.title}</b>
                <span className="sg-muted">
                  {l.wordCount} words{l.curated ? " · Curated" : ""}
                </span>
              </button>
            ))}
          </div>
          <div className="sg-field">
            <label id="turn-length">Time to draw</label>
            <div className="sg-seg" role="radiogroup" aria-labelledby="turn-length">
              {TURN_LENGTHS.map((t) => (
                <button type="button" key={t} role="radio" aria-checked={turnSec === t} onClick={() => setTurnSec(t)}>
                  {t}s
                </button>
              ))}
            </div>
          </div>
          <div className="sg-field">
            <label id="rounds">Times everyone draws</label>
            <div className="sg-seg" role="radiogroup" aria-labelledby="rounds">
              {[1, 2, 3].map((r) => (
                <button type="button" key={r} role="radio" aria-checked={rounds === r} onClick={() => setRounds(r)}>
                  {r}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      {gameType === "truths" && (
        <section className="sg-card sg-stack" aria-labelledby="truths-settings">
          <h2 id="truths-settings" className="sg-h3">
            How it plays
          </h2>
          <p className="sg-muted" style={{ margin: 0 }}>
            Some players are picked at random to write two truths and a lie. Everyone else votes on which one is the
            lie.
          </p>
          <div className="sg-field">
            <label id="featured-count">Featured players</label>
            <div className="sg-seg" role="radiogroup" aria-labelledby="featured-count">
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <button
                  type="button"
                  key={n}
                  role="radio"
                  aria-checked={featuredCount === n}
                  onClick={() => setFeaturedCount(n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <span className="sg-muted" style={{ fontSize: 14 }}>
              If fewer people join, everyone is featured.
            </span>
          </div>
          <div className="sg-field">
            <label id="write-length">Time to write</label>
            <div className="sg-seg" role="radiogroup" aria-labelledby="write-length">
              {WRITE_LENGTHS.map((t) => (
                <button type="button" key={t} role="radio" aria-checked={writeSec === t} onClick={() => setWriteSec(t)}>
                  {t / 60} min
                </button>
              ))}
            </div>
          </div>
          <div className="sg-field">
            <label id="vote-length">Time to vote</label>
            <div className="sg-seg" role="radiogroup" aria-labelledby="vote-length">
              {VOTE_LENGTHS.map((t) => (
                <button type="button" key={t} role="radio" aria-checked={voteSec === t} onClick={() => setVoteSec(t)}>
                  {t}s
                </button>
              ))}
            </div>
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
        <button
          className={`sg-btn lg ${gameType}`}
          type="submit"
          disabled={busy || (gameType === "quiz" && !quizId) || (gameType === "draw" && !wordListId)}
        >
          {busy ? "Opening lobby…" : "Open lobby"}
        </button>
        <Link className="sg-btn ghost" to="/">
          Back
        </Link>
      </div>
    </form>
  );
}
