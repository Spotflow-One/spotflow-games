import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { GAME_INFO, type GameType, type PublicProfile } from "@spotflow-games/shared";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Avatar } from "../components/Avatar";
import { GameIcon } from "../components/GameIcon";

interface ProfileResponse {
  profile: PublicProfile & { deactivated: boolean };
  stats: Array<{ gameType: GameType; played: number; wins: number; points: number }>;
  recent: Array<{
    sessionId: string;
    gameType: GameType;
    endedAt: string | null;
    score: number | null;
    rank: number | null;
  }>;
}

export function Profile() {
  const { id } = useParams();
  const { me } = useAuth();
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    api<ProfileResponse>(`/api/profiles/${id}`).then(setData, (e: Error) => setError(e.message));
  }, [id]);

  if (error) return <p>That profile doesn't exist.</p>;
  if (!data) return <p className="sg-muted">Loading profile…</p>;
  const { profile, stats, recent } = data;
  const isMe = me?.id === profile.id;

  return (
    <>
      <div className="sg-row" style={{ gap: "var(--space-6)" }}>
        <Avatar avatar={profile.avatar} name={profile.displayName} userId={profile.id} size="xl" />
        <div className="sg-stack" style={{ gap: "var(--space-1)" }}>
          <h1 className="sg-h1">
            {profile.displayName}
            {isMe && " (you)"}
          </h1>
          <span className="sg-muted">
            Playing since{" "}
            {new Date(profile.createdAt).toLocaleDateString(undefined, { month: "long", year: "numeric" })}
            {profile.deactivated && " · No longer at Spotflow"}
          </span>
          {isMe && (
            <div>
              <Link className="sg-btn secondary sm" to="/me">
                Edit profile and avatar
              </Link>
            </div>
          )}
        </div>
      </div>

      <section className="stats" aria-label="Stats by game">
        {stats.map((s) => (
          <div key={s.gameType} className={`sg-card sg-stack`}>
            <span className={`sg-badge ${s.gameType}`}>
              <GameIcon type={s.gameType} size={16} />
              {GAME_INFO[s.gameType].name}
            </span>
            <div className="sg-num" style={{ fontSize: 28, fontWeight: 700 }}>
              {s.points.toLocaleString()}{" "}
              <span className="sg-muted" style={{ fontSize: 14 }}>
                pts
              </span>
            </div>
            <span className="sg-muted">
              {s.played} played · {s.wins} {s.wins === 1 ? "win" : "wins"}
            </span>
          </div>
        ))}
      </section>

      <section className="sg-card sg-stack" aria-labelledby="history-heading">
        <h2 id="history-heading" className="sg-h3">
          Recent games
        </h2>
        {recent.length === 0 && <p className="sg-muted">No completed games yet.</p>}
        <ol className="sg-board" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {recent.map((r) => (
            <li key={r.sessionId} className="sg-lrow">
              <span className={`sg-rank${r.rank && r.rank <= 3 ? ` r${r.rank}` : ""}`}>{r.rank ?? "–"}</span>
              <span className={`sg-badge ${r.gameType}`}>{GAME_INFO[r.gameType].name}</span>
              <span className="who sg-muted">{r.endedAt ? new Date(r.endedAt).toLocaleString() : ""}</span>
              <span className="pts">{(r.score ?? 0).toLocaleString()} pts</span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
