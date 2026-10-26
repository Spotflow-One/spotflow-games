const COLORS = ["quiz", "draw", "truths", "clash", "race", "primary", "gold"] as const;
const PIECES = Array.from({ length: 40 }, (_, i) => ({
  // Spread pieces evenly with a little deterministic jitter, so renders are stable.
  left: ((i * 37) % 100) + ((i * 7) % 5) / 5,
  delay: ((i * 53) % 900) / 1000,
  duration: 2.2 + ((i * 29) % 12) / 10,
  spin: (i * 47) % 360,
  color: COLORS[i % COLORS.length],
}));

/** Decorative falling confetti. Hidden entirely when reduced motion is on, because it only exists as motion. */
export function Confetti() {
  return (
    <div className="confetti" aria-hidden="true">
      {PIECES.map((p, i) => (
        <i
          key={i}
          className={p.color}
          style={
            {
              left: `${p.left}%`,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.duration}s`,
              "--spin": `${p.spin}deg`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
