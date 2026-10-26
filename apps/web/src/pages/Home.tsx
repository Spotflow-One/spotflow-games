import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { GAME_INFO, sessionCodeSchema, type GameType, type SessionSummary } from "@spotflow-games/shared";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { GameIcon } from "../components/GameIcon";

interface GameListing {
  type: GameType;
  name: string;
  tagline: string;
  available: boolean;
}

const DESCRIPTIONS: Record<GameType, string> = {
  quiz: "Timed multiple-choice rounds. Fastest right answer scores most.",
  draw: "One player draws, everyone else races to guess the word.",
  truths: "Featured players share three statements. Spot the lie.",
};

export function Home() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const [games, setGames] = useState<GameListing[]>([]);
  const [lobbies, setLobbies] = useState<SessionSummary[]>([]);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [hosting, setHosting] = useState<GameType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<GameListing[]>("/api/games").then(setGames, () => {});
    const load = () => api<SessionSummary[]>("/api/sessions").then(setLobbies, () => {});
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  const host = async (gameType: GameType) => {
    setHosting(gameType);
    setError(null);
    try {
      const s = await api<SessionSummary>("/api/sessions", { method: "POST", body: { gameType } });
      navigate(`/s/${s.code}`);
    } catch (err) {
      setError((err as Error).message);
      setHosting(null);
    }
  };

  const join = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = sessionCodeSchema.safeParse(code.replace(/[\s-]/g, ""));
    if (!parsed.success) return setCodeError("Codes are 6 letters and numbers, like K7PX2M.");
    navigate(`/s/${parsed.data}`);
  };

  return (
    <>
      <div className="sg-stack" style={{ gap: "var(--space-2)" }}>
        <span className="sg-eyebrow">Welcome back</span>
        <h1 className="sg-h1">Hi {me?.displayName.split(" ")[0]}, what are we playing?</h1>
      </div>

      {error && (
        <div className="sg-banner danger" role="alert">
          {error}
        </div>
      )}

      <section className="games" aria-label="Games">
        {(games.length
          ? games
          : (Object.keys(GAME_INFO) as GameType[]).map((t) => ({ type: t, ...GAME_INFO[t], available: false }))
        ).map((g) => (
          <article key={g.type} className={`sg-game ${g.type === "quiz" ? "" : g.type}`}>
            <div className="mark">
              <GameIcon type={g.type} />
            </div>
            <h2 className="sg-h3">{g.name}</h2>
            <p className="meta" style={{ margin: 0 }}>
              {DESCRIPTIONS[g.type]}
            </p>
            <div className="sg-row">
              <button className={`sg-btn ${g.type} sm`} disabled={hosting !== null} onClick={() => host(g.type)}>
                {hosting === g.type ? "Creating…" : "Host a game"}
              </button>
              {!g.available && <span className="sg-badge neutral">Gameplay coming soon</span>}
            </div>
          </article>
        ))}
      </section>

      <div className="grid-2">
        <form className="sg-card sg-stack" onSubmit={join}>
          <h2 className="sg-h3">Join with a code</h2>
          <div className="sg-field">
            <label htmlFor="join-code">Session code</label>
            <input
              id="join-code"
              className={`sg-input code${codeError ? " invalid" : ""}`}
              autoComplete="off"
              maxLength={8}
              value={code}
              aria-invalid={Boolean(codeError)}
              aria-describedby={codeError ? "join-code-err" : undefined}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase());
                setCodeError(null);
              }}
            />
            {codeError && (
              <span id="join-code-err" className="err">
                {codeError}
              </span>
            )}
          </div>
          <div>
            <button className="sg-btn" type="submit">
              Join game
            </button>
          </div>
        </form>

        <section className="sg-card sg-stack" aria-labelledby="open-lobbies">
          <h2 id="open-lobbies" className="sg-h3">
            Open lobbies
          </h2>
          {lobbies.length === 0 && <p className="sg-muted">No open lobbies right now. Host one above.</p>}
          {lobbies.map((l) => (
            <Link
              key={l.id}
              to={`/s/${l.code}`}
              className="sg-row"
              style={{ color: "inherit", textDecoration: "none" }}
            >
              <span className={`sg-badge ${l.gameType}`}>{GAME_INFO[l.gameType].name}</span>
              <span style={{ flex: 1 }}>Hosted by {l.hostName}</span>
              <span className="sg-muted">
                {l.playerCount} {l.playerCount === 1 ? "player" : "players"}
              </span>
              <span className="sg-num">{l.code}</span>
            </Link>
          ))}
        </section>
      </div>
    </>
  );
}
