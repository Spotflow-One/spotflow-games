import { useEffect, useRef, useState } from "react";
import { Clock } from "lucide-react";
import type { GameType } from "@spotflow-games/shared";

/**
 * Seconds left until a server deadline. `serverNow` is the server clock when the state was sent,
 * so a client whose clock is off still counts down correctly.
 */
export function useCountdown(endsAt: number, serverNow: number) {
  const offset = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    offset.current = serverNow - Date.now();
    setNow(Date.now());
  }, [serverNow]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, endsAt - (now + offset.current)) / 1000;
}

/** The design system's ring timer. It turns to the warning colour with a text note under 5 seconds. */
export function Timer({ seconds, total, game }: { seconds: number; total: number; game: GameType }) {
  const whole = Math.ceil(seconds);
  const urgent = whole <= 5 && whole > 0;
  // Announce at the start and at 10 and 5 seconds rather than every second.
  const announce = whole === Math.ceil(total) || whole === 10 || whole === 5 ? `${whole} seconds left` : undefined;
  return (
    <div className="sg-stack" style={{ alignItems: "center", gap: "var(--space-1)" }}>
      <div
        className={`sg-timer ${game === "quiz" ? "" : game}${urgent ? " urgent" : ""}`}
        style={{ "--p": total > 0 ? seconds / total : 0 } as React.CSSProperties}
        role="timer"
        aria-label={`${whole} seconds left`}
      >
        <span>{whole}</span>
      </div>
      {urgent && (
        <span className="sg-timer-note">
          <Clock aria-hidden="true" size={16} />
          {whole}s left
        </span>
      )}
      <span className="visually-hidden" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}
