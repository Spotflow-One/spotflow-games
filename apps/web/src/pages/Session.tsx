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
  type ParticipantView,
  type QuizView,
  type SessionView,
} from "@spotflow-games/shared";
import { useAuth } from "../lib/auth";
import { usePreferences } from "../lib/preferences";
import { getSocket, request } from "../lib/socket";
import { playSound } from "../lib/sound";
import { Avatar } from "../components/Avatar";
import { GameIcon } from "../components/GameIcon";
import { QuizScreen } from "../games/QuizScreen";

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
      if (view.status === "in_progress") playSound("countdown", soundEnabled);
      if (view.status === "results") {
        const top = Math.max(...view.participants.map((p) => p.score));
        const mine = view.participants.find((p) => p.userId === me?.id)?.score;
        playSound(top > 0 && mine === top ? "winner" : "complete", soundEnabled);
      }
    }
    prevStatus.current = view.status;
  }, [view?.status]); // eslint-disable-line react-hooks/exhaustive-deps

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

      <div className="sg-row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <div className="sg-stack" style={{ gap: "var(--space-2)" }}>
          <span className={`sg-badge ${view.gameType}`}>
            <GameIcon type={view.gameType} size={16} />
            {info.name}
          </span>
          <h1 className="sg-h1">{statusTitle(view.status)}</h1>
          <span className="sg-muted">
            Hosted by {host?.displayName ?? "the host"}
            {isHost && " (you)"} · {view.allowLateJoin ? "Late joining on" : "No late joining"}
          </span>
        </div>
        {(view.status === "lobby" || view.status === "ready") && (
          <div className="sg-stack" style={{ gap: "var(--space-2)", alignItems: "flex-end" }}>
            <div className="sg-code">
              <b aria-label={`Join code ${view.code.split("").join(" ")}`}>{view.code}</b>
              <button className="sg-btn secondary icon" aria-label="Copy join code" onClick={() => copy("code")}>
                {copied === "code" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              </button>
            </div>
            <button className="sg-btn ghost sm" onClick={() => copy("link")}>
              <LinkIcon aria-hidden="true" size={16} />
              {copied === "link" ? "Invite link copied" : "Copy invite link"}
            </button>
          </div>
        )}
      </div>

      {notice && (
        <div className="sg-banner danger" role="alert">
          {notice}
        </div>
      )}

      {view.status === "in_progress" && view.game !== null && view.gameType === "quiz" && (
        <QuizScreen session={view} game={view.game as QuizView} meId={me.id} onError={setNotice} />
      )}
      {view.status === "in_progress" && view.gameType !== "quiz" && (
        <div className="sg-card sg-stack">
          <h2 className="sg-h3">Game in progress</h2>
          <p className="sg-muted" style={{ margin: 0 }}>
            The {info.name} screen is coming soon.
          </p>
        </div>
      )}

      {(view.status === "results" || view.status === "completed") && <Results view={view} meId={me.id} />}

      <section className="sg-card sg-stack" aria-labelledby="players-heading">
        <div className="sg-row">
          <h2 id="players-heading" className="sg-h3">
            Players
          </h2>
          <span className="sg-badge neutral">
            <Users aria-hidden="true" size={16} />
            {view.participants.length} of {MAX_PLAYERS_PER_SESSION}
          </span>
          <span style={{ flex: 1 }} />
          <span className="sg-muted">{waitingText(view, isHost)}</span>
        </div>
        <div className="sg-roster">
          {view.participants.map((p) => (
            <Player
              key={p.userId}
              p={p}
              you={p.userId === me.id}
              canKick={isHost && !p.isHost && view.status !== "completed"}
              onKick={() => act("session:kick", { userId: p.userId })}
            />
          ))}
        </div>
      </section>

      {isHost && <HostControls view={view} act={act} />}
      {!isHost && view.status !== "completed" && (
        <div className="sg-row">
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
      {view.status === "completed" && (
        <div className="sg-row">
          <Link className="sg-btn" to="/">
            Back to games
          </Link>
        </div>
      )}
    </>
  );
}

function statusTitle(status: SessionView["status"]) {
  switch (status) {
    case "lobby":
      return "Lobby";
    case "ready":
      return "Ready to start";
    case "in_progress":
      return "Playing";
    case "results":
      return "Final results";
    case "completed":
      return "Final results";
    default:
      return "Session ended";
  }
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
    <div className={`sg-player${you ? " you" : ""}`}>
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
  if (view.status === "completed" || view.status === "results") return null;
  return (
    <div className="sg-row">
      {(view.status === "lobby" || view.status === "ready") && (
        <button className={`sg-btn lg ${view.gameType}`} onClick={() => act("session:start")}>
          <Play aria-hidden="true" />
          Start game
        </button>
      )}
      {view.status === "lobby" && (
        <button className="sg-btn secondary" onClick={() => act("session:ready")}>
          <Lock aria-hidden="true" />
          Lock lobby settings
        </button>
      )}
      {view.status === "ready" && (
        <button className="sg-btn secondary" onClick={() => act("session:reopen")}>
          <LockOpen aria-hidden="true" />
          Unlock settings
        </button>
      )}
      <button className="sg-btn secondary" onClick={() => act("session:end")}>
        <Square aria-hidden="true" />
        {view.status === "in_progress" ? "End game" : "Cancel session"}
      </button>
    </div>
  );
}

function Results({ view, meId }: { view: SessionView; meId: string }) {
  const players = view.participants
    .filter((p) => view.hostPlays || !p.isHost)
    .sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName));
  let rank = 0;
  return (
    <section className="sg-card sg-stack" aria-labelledby="results-heading">
      <div className="sg-row">
        <Trophy aria-hidden="true" />
        <h2 id="results-heading" className="sg-h3">
          Standings
        </h2>
        {view.status === "results" && <span className="sg-muted">Saving results…</span>}
        {view.status === "completed" && <span className="sg-badge success">Saved</span>}
      </div>
      <ol className="sg-board" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {players.map((p, i) => {
          if (i === 0 || players[i - 1]!.score !== p.score) rank = i + 1;
          return (
            <li key={p.userId} className={`sg-lrow${p.userId === meId ? " you" : ""}`}>
              <span className={`sg-rank${rank <= 3 ? ` r${rank}` : ""}`}>{rank}</span>
              <Avatar avatar={p.avatar} name={p.displayName} userId={p.userId} size="sm" />
              <span className="who">
                <b>
                  {p.displayName}
                  {p.userId === meId && " (you)"}
                </b>
              </span>
              <span className="pts">{p.score.toLocaleString()} pts</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
