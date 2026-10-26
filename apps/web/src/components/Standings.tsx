import type { ParticipantView, SessionView } from "@spotflow-games/shared";
import { Avatar } from "./Avatar";

/** Players ranked by score, using the server's final rank when there is one. */
export function rankedPlayers(view: SessionView) {
  const players = view.participants
    .filter((p) => view.hostPlays || !p.isHost)
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || b.score - a.score);
  return players.map((p, i) => ({ ...p, place: p.rank ?? i + 1 }));
}

/**
 * The live scoreboard shown between rounds: the top few, plus your own row if you're further down.
 * `gained` is the points each player just earned, shown next to their total.
 */
export function Standings({
  view,
  meId,
  gained = {},
  limit = 5,
  title = "Leaderboard",
}: {
  view: SessionView;
  meId: string;
  gained?: Record<string, number>;
  limit?: number;
  title?: string;
}) {
  const players = rankedPlayers(view);
  const top = players.slice(0, limit);
  const mine = players.find((p) => p.userId === meId);
  const rows: Array<ParticipantView & { place: number }> = mine && !top.includes(mine) ? [...top, mine] : top;
  if (rows.length === 0) return null;
  return (
    <section className="standings" aria-label={title}>
      <h2 className="sg-eyebrow">{title}</h2>
      <ol className="sg-board">
        {rows.map((p, i) => (
          <li
            key={p.userId}
            className={`sg-lrow pop-in${p.userId === meId ? " you" : ""}`}
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <span className={`sg-rank${p.place <= 3 ? ` r${p.place}` : ""}`}>{p.place}</span>
            <Avatar avatar={p.avatar} name={p.displayName} userId={p.userId} size="sm" />
            <span className="who">
              <b>
                {p.displayName}
                {p.userId === meId && " (you)"}
              </b>
            </span>
            <span className="pts">
              {(gained[p.userId] ?? 0) > 0 && <span className="gain">+{gained[p.userId]}</span>}
              {p.score.toLocaleString()}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
