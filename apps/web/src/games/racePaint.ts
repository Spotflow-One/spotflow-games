/** Team colours. Past ten racers, cars get a white and then a yellow accent livery. */
export const PAINT = [
  "#e10600",
  "#1e5bc6",
  "#00a19c",
  "#ff8000",
  "#6c2bd9",
  "#ff5fa2",
  "#00d2be",
  "#ffd23f",
  "#52e252",
  "#f4f4f4",
];
const ACCENT = ["#15151e", "#ffffff", "#ffd23f"];

export const carPaint = (n: number) => PAINT[n % PAINT.length]!;
export const carAccent = (n: number) => ACCENT[Math.floor(n / PAINT.length) % ACCENT.length]!;
/** Cars that look alike share a model. */
export const liveryKey = (n: number) => `${n % PAINT.length}:${Math.floor(n / PAINT.length) % ACCENT.length}`;
