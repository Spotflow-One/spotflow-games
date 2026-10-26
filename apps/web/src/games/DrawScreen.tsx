import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Eraser, Pencil, SkipForward, Trash2 } from "lucide-react";
import {
  BRUSH_COLORS,
  BRUSH_SIZES,
  type DrawEvent,
  type DrawView,
  type ParticipantView,
  type SessionView,
  type Stroke,
} from "@spotflow-games/shared";
import { usePreferences } from "../lib/preferences";
import { getSocket, request } from "../lib/socket";
import { playSound } from "../lib/sound";
import { Avatar } from "../components/Avatar";
import { Timer, useCountdown } from "../components/Timer";
import { DrawCanvas, type Brush } from "./DrawCanvas";

interface Props {
  session: SessionView;
  game: DrawView;
  meId: string;
  onError: (message: string) => void;
}

const firstName = (p?: ParticipantView) => p?.displayName.split(" ")[0] ?? "Someone";

export function DrawScreen({ session, game, meId, onError }: Props) {
  const { soundEnabled } = usePreferences();
  const seconds = useCountdown(game.phaseEndsAt, game.serverNow);
  const strokes = useRef<Stroke[]>([]);
  const turnRef = useRef(game.turnNumber - 1);
  const [version, setVersion] = useState(0);
  const [tick, setTick] = useState(0);
  const [brush, setBrush] = useState<Brush>({ tool: "pen", color: 0, size: 1 });
  const [guess, setGuess] = useState("");
  const [guessNote, setGuessNote] = useState<string | null>(null);
  const lastSound = useRef("");

  const people = new Map(session.participants.map((p) => [p.userId, p]));
  const drawer = people.get(game.drawerId);
  const isDrawer = game.drawerId === meId;
  const isHost = session.hostId === meId;
  const iGuessed = game.guessedIds.includes(meId);
  const canGuess = game.phase === "drawing" && game.isPlayer && !isDrawer && !iGuessed;

  const send = useCallback((action: object) => request("game:action", { code: session.code, action }), [session.code]);
  const sync = useCallback(() => send({ type: "sync" }).catch(() => {}), [send]);

  // Strokes arrive as events outside state pushes.
  useEffect(() => {
    const socket = getSocket();
    const onEvent = ({ code, event }: { code: string; event: unknown }) => {
      if (code !== session.code) return;
      const e = event as DrawEvent;
      if (e.turn !== turnRef.current) return;
      if (e.type === "stroke") {
        strokes.current.push(e.stroke);
        setTick((t) => t + 1);
      } else if (e.type === "clear") {
        strokes.current = [];
        setVersion((v) => v + 1);
      } else if (e.type === "sync") {
        strokes.current = [...e.strokes];
        setVersion((v) => v + 1);
      }
    };
    socket.on("game:event", onEvent);
    socket.on("connect", sync);
    return () => {
      socket.off("game:event", onEvent);
      socket.off("connect", sync);
    };
  }, [session.code, sync]);

  // A new turn starts with a blank canvas; otherwise catch up if we missed strokes.
  useEffect(() => {
    const turn = game.turnNumber - 1;
    if (turnRef.current !== turn) {
      turnRef.current = turn;
      strokes.current = [];
      setVersion((v) => v + 1);
      setGuessNote(null);
    } else if (!isDrawer && game.strokeCount > strokes.current.length) {
      void sync();
    }
  }, [game.turnNumber, game.strokeCount, isDrawer, sync]);

  useEffect(() => {
    void sync();
  }, [sync]);

  useEffect(() => {
    const key = `${game.turnNumber}:${game.phase}:${iGuessed}`;
    if (lastSound.current === key) return;
    lastSound.current = key;
    if (iGuessed && game.phase === "drawing") playSound("correct", soundEnabled);
    else if (game.phase === "drawing") playSound("countdown", soundEnabled);
  }, [game.turnNumber, game.phase, iGuessed, soundEnabled]);

  const onStroke = useCallback(
    (stroke: Stroke) => {
      send({ type: "stroke", stroke }).catch((err: Error) => onError(err.message));
    },
    [send, onError],
  );

  const submitGuess = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!guess.trim()) return;
    try {
      await send({ type: "guess", text: guess });
      setGuess("");
      setGuessNote(null);
    } catch (err) {
      setGuessNote((err as Error).message);
    }
  };

  const status =
    game.phase === "choosing"
      ? isDrawer
        ? "Pick a word to draw"
        : `${firstName(drawer)} is choosing a word`
      : game.phase === "drawing"
        ? isDrawer
          ? "You're drawing"
          : `${firstName(drawer)} is drawing`
        : "Turn over";

  return (
    <div className="draw-layout">
      <section className="sg-stack" style={{ minWidth: 0 }}>
        <div className="sg-row" style={{ justifyContent: "space-between" }}>
          <div className="sg-row">
            {drawer && <Avatar avatar={drawer.avatar} name={drawer.displayName} userId={drawer.userId} />}
            <span>
              <b>{status}</b>
              <br />
              <span className="sg-muted" style={{ fontSize: 14 }}>
                Turn {game.turnNumber} of {game.totalTurns}
              </span>
            </span>
          </div>
          {game.phase !== "choosing" && game.hint.length > 0 && (
            <div
              className="sg-hint"
              aria-label={
                game.word
                  ? `The word is ${game.word}`
                  : `Word hint: ${game.wordLength} letters${game.hint.some((c) => c && c !== " ") ? `, showing ${game.hint.map((c) => c ?? "blank").join(" ")}` : ""}`
              }
            >
              {game.hint.map((c, i) => (c === " " ? <i key={i} className="gap" /> : <span key={i}>{c ?? " "}</span>))}
            </div>
          )}
          {game.phase !== "turnEnd" && (
            <Timer seconds={seconds} total={game.phase === "choosing" ? 15 : game.turnSec} game="draw" />
          )}
        </div>

        {game.phase === "choosing" && isDrawer && game.wordChoices && (
          <div className="sg-card sg-stack" style={{ alignItems: "center" }}>
            <h2 className="sg-h3">Choose what to draw</h2>
            <div className="sg-row" style={{ justifyContent: "center" }}>
              {game.wordChoices.map((w, i) => (
                <button
                  key={w}
                  className="sg-btn draw lg"
                  onClick={() => send({ type: "choose", index: i }).catch((err: Error) => onError(err.message))}
                >
                  {w}
                </button>
              ))}
            </div>
            <p className="sg-muted" style={{ margin: 0 }}>
              If you don't pick, one is chosen for you.
            </p>
          </div>
        )}

        {game.phase === "turnEnd" && (
          <div className="sg-card sg-stack">
            <div className="sg-banner" role="status">
              <span>
                The word was <b>{game.word}</b>.
              </span>
            </div>
            <ul className="sg-board" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {Object.entries(game.turnPoints ?? {})
                .sort((a, b) => b[1] - a[1])
                .map(([id, pts]) => {
                  const p = people.get(id);
                  return (
                    <li key={id} className={`sg-lrow${id === meId ? " you" : ""}`}>
                      <span />
                      {p && <Avatar avatar={p.avatar} name={p.displayName} userId={id} size="sm" />}
                      <span className="who">
                        <b>
                          {p?.displayName ?? "Player"}
                          {id === meId && " (you)"}
                        </b>
                        {id === game.drawerId && <small>Drawer</small>}
                      </span>
                      <span className="pts">+{pts}</span>
                    </li>
                  );
                })}
              {Object.keys(game.turnPoints ?? {}).length === 0 && (
                <li className="sg-muted">Nobody guessed it this time.</li>
              )}
            </ul>
          </div>
        )}

        <DrawCanvas
          strokes={strokes}
          version={version}
          tick={tick}
          canDraw={isDrawer && game.phase === "drawing"}
          brush={brush}
          onStroke={onStroke}
          label={isDrawer ? "Your drawing canvas" : `${firstName(drawer)}'s drawing`}
        />

        {isDrawer && game.phase === "drawing" && (
          <Toolbar
            brush={brush}
            setBrush={setBrush}
            onClear={() => {
              if (!window.confirm("Clear the whole drawing?")) return;
              strokes.current = [];
              setVersion((v) => v + 1);
              send({ type: "clear" }).catch((err: Error) => onError(err.message));
            }}
          />
        )}

        {(isHost || isDrawer) && game.phase !== "turnEnd" && (
          <div className="sg-row">
            <button
              className="sg-btn secondary sm"
              onClick={() => send({ type: "skip" }).catch((err: Error) => onError(err.message))}
            >
              <SkipForward aria-hidden="true" size={16} />
              Skip this turn
            </button>
          </div>
        )}
        {isHost && game.phase === "turnEnd" && (
          <div className="sg-row">
            <button
              className="sg-btn secondary sm"
              onClick={() => send({ type: "skip" }).catch((err: Error) => onError(err.message))}
            >
              <SkipForward aria-hidden="true" size={16} />
              {game.turnNumber < game.totalTurns ? "Next turn" : "Show results"}
            </button>
          </div>
        )}
      </section>

      <aside className="sg-card sg-stack draw-feed-card">
        <h2 className="sg-h3">Guesses</h2>
        <div className="sg-feed draw-feed" aria-live="polite">
          {game.feed.map((e) => {
            const p = e.userId ? people.get(e.userId) : undefined;
            const you = e.userId === meId;
            const name = you ? "You" : firstName(p);
            if (e.kind === "system") {
              return (
                <div key={e.id} className="msg sg-muted">
                  {p ? `${name} ${you ? e.text.replace(/^is /, "are ") : e.text}` : e.text}
                </div>
              );
            }
            const avatar = p && <Avatar avatar={p.avatar} name={p.displayName} userId={p.userId} size="xs" />;
            if (e.kind === "correct") {
              return (
                <div key={e.id} className="msg hit">
                  <Check aria-hidden="true" size={16} />
                  {avatar}
                  {name} {e.text}
                </div>
              );
            }
            return (
              <div key={e.id} className={`msg${e.kind === "close" ? " close" : ""}`}>
                {avatar}
                <b>{name}</b> {e.kind === "close" ? e.text.replace(/ is close!$/, "").replace(/^"|"$/g, "") : e.text}
                {e.kind === "close" && <span className="sg-badge warning">So close</span>}
              </div>
            );
          })}
        </div>
        {game.isPlayer && !isDrawer && (
          <form className="sg-stack" style={{ gap: "var(--space-1)" }} onSubmit={submitGuess}>
            <div className="sg-row" style={{ flexWrap: "nowrap" }}>
              <input
                className="sg-input"
                style={{ flex: 1, minWidth: 0 }}
                aria-label="Your guess"
                placeholder={iGuessed ? "You got it!" : "Type your guess"}
                maxLength={60}
                value={guess}
                disabled={!canGuess}
                autoComplete="off"
                onChange={(e) => setGuess(e.target.value)}
              />
              <button className="sg-btn draw" type="submit" disabled={!canGuess}>
                Guess
              </button>
            </div>
            {guessNote && (
              <span className="sg-muted" style={{ fontSize: 14 }}>
                {guessNote}
              </span>
            )}
          </form>
        )}
      </aside>
    </div>
  );
}

const COLOR_NAMES = ["Black", "Grey", "Red", "Orange", "Yellow", "Green", "Blue", "Purple", "Brown"];

function Toolbar({ brush, setBrush, onClear }: { brush: Brush; setBrush: (b: Brush) => void; onClear: () => void }) {
  return (
    <div className="sg-toolbar" role="toolbar" aria-label="Drawing tools">
      <div className="sg-swatches">
        {BRUSH_COLORS.map((c, i) => (
          <button
            key={c}
            className="sg-swatch"
            style={{ background: `var(--brush-${c})` }}
            aria-label={COLOR_NAMES[i]}
            title={COLOR_NAMES[i]}
            aria-pressed={brush.tool === "pen" && brush.color === i}
            onClick={() => setBrush({ ...brush, tool: "pen", color: i })}
          />
        ))}
      </div>
      <span className="sg-sep" />
      <div className="sg-sizes">
        {BRUSH_SIZES.map((s, i) => (
          <button
            key={s}
            className="sg-tool"
            aria-label={["Small brush", "Medium brush", "Large brush"][i]}
            aria-pressed={brush.size === i}
            onClick={() => setBrush({ ...brush, size: i })}
          >
            <i style={{ width: Math.max(6, s * 0.9), height: Math.max(6, s * 0.9) }} />
          </button>
        ))}
      </div>
      <span className="sg-sep" />
      <button
        className="sg-tool"
        aria-label="Pencil"
        title="Pencil"
        aria-pressed={brush.tool === "pen"}
        onClick={() => setBrush({ ...brush, tool: "pen" })}
      >
        <Pencil aria-hidden="true" size={20} />
      </button>
      <button
        className="sg-tool"
        aria-label="Eraser"
        title="Eraser"
        aria-pressed={brush.tool === "eraser"}
        onClick={() => setBrush({ ...brush, tool: "eraser" })}
      >
        <Eraser aria-hidden="true" size={20} />
      </button>
      <button className="sg-tool" aria-label="Clear the drawing" title="Clear" onClick={onClear}>
        <Trash2 aria-hidden="true" size={20} />
      </button>
    </div>
  );
}
