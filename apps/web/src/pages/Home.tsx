import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { GAME_INFO, sessionCodeSchema, type GameType, type SessionSummary } from "@spotflow-games/shared";
import { Play } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useMusic } from "../lib/music";
import { GameIcon } from "../components/GameIcon";
import { TokyoRun } from "../components/TokyoRun";

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
  clash: "Split into teams, take down drones and the Titan, and outgun the other side.",
  race: "Race up to 30 drivers through Lagos traffic and over Third Mainland Bridge. Mind the danfos.",
};

export function Home() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const [games, setGames] = useState<GameListing[]>([]);
  const [lobbies, setLobbies] = useState<SessionSummary[]>([]);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  useMusic("arcade");

  useEffect(() => {
    api<GameListing[]>("/api/games").then(setGames, () => {});
    const load = () => api<SessionSummary[]>("/api/sessions").then(setLobbies, () => {});
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  // The home page sits on the Tokyo racing backdrop.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.page = "home";
    return () => {
      delete root.dataset.page;
    };
  }, []);

  const join = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = sessionCodeSchema.safeParse(code.replace(/[\s-]/g, ""));
    if (!parsed.success) return setCodeError("Codes are 6 letters and numbers, like K7PX2M.");
    navigate(`/s/${parsed.data}`);
  };

  return (
    <>
      <TokyoRun />
      <section className="home-hero">
        <div className="sg-stack" style={{ gap: "var(--space-2)" }}>
          <span className="sg-eyebrow">It's Happy Hour</span>
          <h1 className="display-xl">Hi {me?.displayName.split(" ")[0]}, ready to play?</h1>
        </div>
        <form className="join-box" onSubmit={join} noValidate>
          <label htmlFor="join-code" className="sg-h3">
            Got a game code?
          </label>
          <div className="join-box-row">
            <input
              id="join-code"
              className={`sg-input code${codeError ? " invalid" : ""}`}
              autoComplete="off"
              placeholder="K7PX2M"
              maxLength={8}
              value={code}
              aria-invalid={Boolean(codeError)}
              aria-describedby={codeError ? "join-code-err" : undefined}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase());
                setCodeError(null);
              }}
            />
            <button className="sg-btn lg" type="submit">
              <Play aria-hidden="true" />
              Join game
            </button>
          </div>
          {codeError && (
            <span id="join-code-err" className="sg-field err">
              {codeError}
            </span>
          )}
        </form>
      </section>

      <div className="race-lane" aria-hidden="true" />

      {lobbies.length > 0 && (
        <section className="sg-stack" aria-labelledby="open-lobbies">
          <h2 id="open-lobbies" className="sg-h3 sg-row arcade-title" style={{ gap: "var(--space-2)" }}>
            <span className="live-dot" aria-hidden="true" />
            Live now
          </h2>
          <div className="live-lobbies">
            {lobbies.map((l) => (
              <Link key={l.id} to={`/s/${l.code}`} className={`live-lobby ${l.gameType}`}>
                <span className="mark" aria-hidden="true">
                  <GameIcon type={l.gameType} size={22} />
                </span>
                <span className="sg-stack" style={{ gap: 0, minWidth: 0, flex: 1 }}>
                  <b>{GAME_INFO[l.gameType].name}</b>
                  <span className="sg-muted" style={{ fontSize: 14 }}>
                    {l.hostName} · {l.playerCount} {l.playerCount === 1 ? "player" : "players"}
                  </span>
                </span>
                <span className="sg-btn sm">Join</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="sg-stack" aria-labelledby="games-heading">
        <h2 id="games-heading" className="sg-h3 arcade-title">
          Host a game
        </h2>
        <div className="games">
          {(games.length
            ? games
            : (Object.keys(GAME_INFO) as GameType[]).map((t) => ({ type: t, ...GAME_INFO[t], available: false }))
          ).map((g) => (
            <article key={g.type} className={`sg-game arcade ${g.type === "quiz" ? "" : g.type}`}>
              <div className="arcade-art" aria-hidden="true">
                <div className="mark">
                  <GameIcon type={g.type} size={40} />
                </div>
              </div>
              <div className="sg-stack arcade-body">
                <h3 className="sg-h2">{g.name}</h3>
                <p className="meta" style={{ margin: 0 }}>
                  {DESCRIPTIONS[g.type]}
                </p>
                <div className="sg-row" style={{ marginTop: "auto" }}>
                  <Link className={`sg-btn ${g.type}`} to={`/host/${g.type}`}>
                    <Play aria-hidden="true" size={18} />
                    Host {g.name}
                  </Link>
                  {!g.available && <span className="sg-badge neutral">Coming soon</span>}
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
