import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  Check,
  Copy,
  Link as LinkIcon,
  Lock,
  LockOpen,
  Play,
  RefreshCw,
  Square,
  Trophy,
  UserMinus,
  Users,
} from "lucide-react";
import {
  GAME_INFO,
  MAX_PLAYERS_PER_SESSION,
  type ClashView,
  type DrawView,
  type ParticipantView,
  type QuizView,
  type SessionView,
  type TruthsView,
} from "@spotflow-games/shared";
import { useAuth } from "../lib/auth";
import { useMusic } from "../lib/music";
import { usePreferences } from "../lib/preferences";
import { getSocket, request } from "../lib/socket";
import { playSound } from "../lib/sound";
import { Avatar } from "../components/Avatar";
import { HowYouAppear } from "../components/HowYouAppear";
import { TokyoRun } from "../components/TokyoRun";
import { GameIcon } from "../components/GameIcon";
import { Confetti } from "../components/Confetti";
import { rankedPlayers } from "../components/Standings";
import { ClashOutcome, ClashScreen } from "../games/ClashScreen";
import { DrawScreen } from "../games/DrawScreen";
import { QuizScreen } from "../games/QuizScreen";
import { TruthsScreen } from "../games/TruthsScreen";

type Conn = "connecting" | "connected" | "reconnecting";

export function Session() {
  const code = (useParams().code ?? "").toUpperCase();
  const { me } = useAuth();
  const { soundEnabled } = usePreferences();
  const navigate = useNavigate();
  const [view, setView] = useState<SessionView | null>(null);
  const [conn, setConn] = useState<Conn>("connecting");
  const [fatal, setFatal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const prevStatus = useRef<string | null>(null);
  useMusic(view?.status === "results" || view?.status === "completed" ? "victory" : null);

  useEffect(() => {
    const socket = getSocket();
    const join = () =>
      request<SessionView>("session:join", { code }).then(
        (v) => {
          setView(v);
          setConn("connected");
        },
        (err: Error) => setFatal(err.message),
      );
    const onState = (v: SessionView) => v.code === code && setView(v);
    const onClosed = (p: { code: string; reason: string }) => p.code === code && setFatal(p.reason);
    const onDisconnect = () => setConn("reconnecting");
    const onConnectError = (err: Error) => {
      if (err.message === "unauthorized") navigate(`/signin?returnTo=${encodeURIComponent(`/s/${code}`)}`);
      else setConn("reconnecting");
    };

    socket.on("connect", join);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("session:state", onState);
    socket.on("session:closed", onClosed);
    if (socket.connected) void join();
    return () => {
      socket.off("connect", join);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("session:state", onState);
      socket.off("session:closed", onClosed);
    };
  }, [code, navigate]);

  useEffect(() => {
    if (!view) return;
    if (prevStatus.current && prevStatus.current !== view.status) {
      // Each stage of the game starts at the top of the page, not wherever the lobby was scrolled to.
      window.scrollTo({ top: 0 });
      if (view.status === "in_progress") playSound("countdown", soundEnabled);
      if (view.status === "results") {
        const top = Math.max(...view.participants.map((p) => p.score));
        const mine = view.participants.find((p) => p.userId === me?.id)?.score;
        playSound(top > 0 && mine === top ? "winner" : "complete", soundEnabled);
      }
    }
    prevStatus.current = view.status;
  }, [view?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // The whole screen takes on the game's look while you're in a session.
  useEffect(() => {
    if (!view) return;
    const root = document.documentElement;
    root.dataset.arena = view.gameType;
    root.dataset.arenaStatus = view.status;
    return () => {
      delete root.dataset.arena;
      delete root.dataset.arenaStatus;
    };
  }, [view?.gameType, view?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (fatal) {
    return (
      <div className="sg-card sg-stack" style={{ maxWidth: 520 }}>
        <h1 className="sg-h2">You're not in this game</h1>
        <p style={{ margin: 0 }}>{fatal}</p>
        <div>
          <Link className="sg-btn" to="/">
            Back to games
          </Link>
        </div>
      </div>
    );
  }
  if (!view || !me) return <p className="sg-muted">Joining {code}…</p>;

  const info = GAME_INFO[view.gameType];
  const isHost = view.hostId === me.id;
  const host = view.participants.find((p) => p.isHost);
  const inviteUrl = `${window.location.origin}/join/${view.code}`;
  const act: Act = (event, payload = {}) =>
    request(event, { code, ...payload }).then(
      () => setNotice(null),
      (err: Error) => setNotice(err.message),
    );
  const copy = async (what: "code" | "link") => {
    try {
      await navigator.clipboard.writeText(what === "code" ? view.code : inviteUrl);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setNotice("Couldn't copy. Select the text and copy it instead.");
    }
  };

  const inLobby = view.status === "lobby" || view.status === "ready";
  const playing = view.status === "in_progress";
  const finished = view.status === "results" || view.status === "completed";

  return (
    <>
      {conn === "reconnecting" && (
        <div className="sg-banner warning" role="status">
          <span className="ic">
            <RefreshCw aria-hidden="true" />
          </span>
          <span>
            <b>Reconnecting…</b> Your place in the game is kept.
          </span>
        </div>
      )}

      {inLobby ? (
        <section className={`lobby-hero ${view.gameType}`} aria-labelledby="lobby-title">
          <span className={`sg-badge ${view.gameType}`}>
            <GameIcon type={view.gameType} size={16} />
            {info.name}
          </span>
          <h1 id="lobby-title" className="sg-h2">
            {view.status === "ready" ? "Get ready to play" : "Join the game"}
          </h1>
          <p className="sg-muted" style={{ margin: 0 }}>
            Go to <b className="sg-num">{window.location.host}</b> and enter this code
          </p>
          <div className="lobby-code" aria-label={`Join code ${view.code.split("").join(" ")}`} role="img">
            {view.code.split("").map((c, i) => (
              <span key={i} aria-hidden="true">
                {c}
              </span>
            ))}
          </div>
          <div className="sg-row" style={{ justifyContent: "center" }}>
            <button className="sg-btn secondary sm" onClick={() => copy("code")}>
              {copied === "code" ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}
              {copied === "code" ? "Code copied" : "Copy code"}
            </button>
            <button className="sg-btn secondary sm" onClick={() => copy("link")}>
              <LinkIcon aria-hidden="true" size={16} />
              {copied === "link" ? "Invite link copied" : "Copy invite link"}
            </button>
          </div>
          <span className="sg-muted" style={{ fontSize: 14 }}>
            Hosted by {host?.displayName ?? "the host"}
            {isHost && " (you)"} · {view.allowLateJoin ? "Late joining on" : "No late joining"}
          </span>
        </section>
      ) : (
        <div className="game-bar">
          <span className={`sg-badge ${view.gameType}`}>
            <GameIcon type={view.gameType} size={16} />
            {info.name}
          </span>
          <span className="sg-muted game-bar-meta">
            <span className="sg-num">{view.code}</span>
            <span className="game-bar-count">
              {" "}
              · {view.participants.length} {view.participants.length === 1 ? "player" : "players"}
            </span>
          </span>
          <span style={{ flex: 1 }} />
          {isHost && playing && (
            <button className="sg-btn ghost sm" onClick={() => act("session:end")}>
              <Square aria-hidden="true" size={16} />
              End game
            </button>
          )}
          {!isHost && playing && (
            <button
              className="sg-btn ghost sm"
              onClick={async () => {
                await act("session:leave");
                navigate("/");
              }}
            >
              Leave
            </button>
          )}
        </div>
      )}
      {inLobby && (
        <>
          <TokyoRun />
          <div className="race-lane" aria-hidden="true" />
        </>
      )}

      {notice && (
        <div className="sg-banner danger" role="alert">
          {notice}
        </div>
      )}

      {playing && view.game !== null && view.gameType === "quiz" && (
        <QuizScreen session={view} game={view.game as QuizView} meId={me.id} onError={setNotice} />
      )}
      {playing && view.game !== null && view.gameType === "draw" && (
        <DrawScreen session={view} game={view.game as DrawView} meId={me.id} onError={setNotice} />
      )}
      {playing && view.game !== null && view.gameType === "truths" && (
        <TruthsScreen session={view} game={view.game as TruthsView} meId={me.id} onError={setNotice} />
      )}
      {playing && view.game !== null && view.gameType === "clash" && (
        <ClashScreen session={view} game={view.game as ClashView} meId={me.id} />
      )}

      {finished && view.game !== null && view.gameType === "clash" && (
        <ClashOutcome session={view} game={view.game as ClashView} meId={me.id} />
      )}
      {finished && <Results view={view} meId={me.id} />}

      {inLobby && (
        <HowYouAppear
          code={code}
          you={view.participants.find((p) => p.userId === me.id)}
          onJoined={setView}
          onError={setNotice}
        />
      )}

      {!finished &&
        view.status !== "cancelled" &&
        (playing ? (
          <details className="sg-card play-roster">
            <summary className="sg-row">
              <Users aria-hidden="true" size={18} />
              <b>Players</b>
              <span className="sg-badge neutral">{view.participants.length}</span>
            </summary>
            <Roster view={view} meId={me.id} isHost={isHost} act={act} />
          </details>
        ) : (
          <section className="sg-card sg-stack lobby-panel" aria-labelledby="players-heading">
            <div className="sg-row">
              <h2 id="players-heading" className="sg-h3">
                Players
              </h2>
              <span className="sg-badge neutral">
                <Users aria-hidden="true" size={16} />
                {view.participants.length} of {MAX_PLAYERS_PER_SESSION}
              </span>
              <span style={{ flex: 1 }} />
              <span className={`sg-muted${inLobby ? " waiting" : ""}`}>
                {waitingText(view, isHost)}
                {inLobby && (
                  <span className="dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </span>
            </div>
            <Roster view={view} meId={me.id} isHost={isHost} act={act} />
            {isHost && inLobby && <HostControls view={view} act={act} />}
            {!isHost && inLobby && (
              <div className="sg-row" style={{ justifyContent: "center" }}>
                <button
                  className="sg-btn ghost"
                  onClick={async () => {
                    await act("session:leave");
                    navigate("/");
                  }}
                >
                  Leave session
                </button>
              </div>
            )}
          </section>
        ))}

      {(finished || view.status === "cancelled") && (
        <div className="sg-row" style={{ justifyContent: "center" }}>
          <Link className="sg-btn lg" to="/">
            Back to games
          </Link>
        </div>
      )}
    </>
  );
}

function Roster({ view, meId, isHost, act }: { view: SessionView; meId: string; isHost: boolean; act: Act }) {
  return (
    <div className="sg-roster">
      {view.participants.map((p) => (
        <Player
          key={p.userId}
          p={p}
          you={p.userId === meId}
          canKick={isHost && !p.isHost && view.status !== "completed"}
          onKick={() => act("session:kick", { userId: p.userId })}
        />
      ))}
    </div>
  );
}

function waitingText(view: SessionView, isHost: boolean) {
  if (view.status === "lobby")
    return isHost ? "Share the code, then start when everyone's in" : "Waiting for the host to start";
  if (view.status === "ready")
    return isHost ? "Settings locked. Start when you're ready" : "The host is about to start";
  if (view.status === "in_progress") return "Game in progress";
  return "Game over";
}

function Player({
  p,
  you,
  canKick,
  onKick,
}: {
  p: ParticipantView;
  you: boolean;
  canKick: boolean;
  onKick: () => void;
}) {
  return (
    <div className={`sg-player pop-in${you ? " you" : ""}`}>
      <Avatar avatar={p.avatar} name={p.displayName} userId={p.userId} host={p.isHost} connected={p.connected} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="nm">
          <Link to={`/profile/${p.userId}`} style={{ color: "inherit", textDecoration: "none" }}>
            {p.displayName}
            {you && " (you)"}
          </Link>
        </div>
        <div className="sub">{p.isHost ? "Host" : p.connected ? "Ready" : "Reconnecting…"}</div>
      </div>
      {canKick && (
        <button
          className="sg-btn ghost icon sm"
          aria-label={`Remove ${p.displayName}`}
          title="Remove player"
          onClick={onKick}
        >
          <UserMinus aria-hidden="true" size={16} />
        </button>
      )}
    </div>
  );
}

type Act = (event: Parameters<typeof request>[0], payload?: object) => Promise<void>;

function HostControls({ view, act }: { view: SessionView; act: Act }) {
  const others = view.participants.filter((p) => !p.isHost).length;
  return (
    <div className="sg-stack host-controls">
      <button className={`sg-btn lg start-btn ${view.gameType}`} onClick={() => act("session:start")}>
        <Play aria-hidden="true" />
        Start game
      </button>
      {others === 0 && <span className="sg-muted">Nobody else has joined yet. Share the code above.</span>}
      <div className="sg-row" style={{ justifyContent: "center" }}>
        {view.status === "lobby" ? (
          <button className="sg-btn ghost sm" onClick={() => act("session:ready")}>
            <Lock aria-hidden="true" size={16} />
            Lock lobby settings
          </button>
        ) : (
          <button className="sg-btn ghost sm" onClick={() => act("session:reopen")}>
            <LockOpen aria-hidden="true" size={16} />
            Unlock settings
          </button>
        )}
        <button className="sg-btn ghost sm" onClick={() => act("session:end")}>
          <Square aria-hidden="true" size={16} />
          Cancel session
        </button>
      </div>
    </div>
  );
}

function Results({ view, meId }: { view: SessionView; meId: string }) {
  const players = rankedPlayers(view);
  const winners = players.filter((p) => p.place === 1 && p.score > 0);
  const podium = [players[1], players[0], players[2]].filter((p) => p !== undefined);
  const rest = players.slice(3);
  const iWon = winners.some((p) => p.userId === meId);
  // In a team game the team result comes first, so the podium crowns the top scorer.
  const team = view.gameType === "clash";
  const headline =
    winners.length === 0
      ? "Game over"
      : winners.length > 1
        ? "It's a tie!"
        : iWon
          ? team
            ? "You're the MVP!"
            : "You win!"
          : `${winners[0]!.displayName} ${team ? "is the MVP!" : "wins!"}`;
  const mine = players.find((p) => p.userId === meId);
  return (
    <>
      <section className={`results-hero ${view.gameType}`} aria-labelledby="results-heading">
        {winners.length > 0 && <Confetti />}
        <span className="sg-eyebrow">{team ? "Top scorers" : "Final results"}</span>
        <h1 id="results-heading" className="display-xl">
          <Trophy aria-hidden="true" className="results-trophy" />
          {headline}
        </h1>
        {mine && !iWon && (
          <p className="sg-muted" style={{ margin: 0 }}>
            You placed {ordinal(mine.place)} with {mine.score.toLocaleString()} points.
          </p>
        )}
        {view.status === "results" && <span className="sg-muted">Saving results…</span>}
        {view.status === "completed" && <span className="sg-badge success">Saved to everyone's profile</span>}
        <ol className="sg-podium podium-anim" aria-label="Top three">
          {podium.map((p) => (
            <li key={p.userId} className={`col p${p.place <= 3 ? p.place : 3}`}>
              <Avatar avatar={p.avatar} name={p.displayName} userId={p.userId} size="lg" />
              <b className="podium-name">
                {p.displayName}
                {p.userId === meId && " (you)"}
              </b>
              <span className="sg-num">{p.score.toLocaleString()} pts</span>
              <div className="block" aria-label={`${ordinal(p.place)} place`}>
                {p.place}
              </div>
            </li>
          ))}
        </ol>
      </section>
      {rest.length > 0 && (
        <ol className="sg-board" start={4} style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {rest.map((p) => (
            <li key={p.userId} className={`sg-lrow${p.userId === meId ? " you" : ""}`}>
              <span className="sg-rank">{p.place}</span>
              <Avatar avatar={p.avatar} name={p.displayName} userId={p.userId} size="sm" />
              <span className="who">
                <b>
                  {p.displayName}
                  {p.userId === meId && " (you)"}
                </b>
              </span>
              <span className="pts">{p.score.toLocaleString()} pts</span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function ordinal(n: number) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}
