/**
 * Small synthesized sound effects, so there are no audio files to load.
 * Browsers only allow audio after a user gesture, so the context is created lazily.
 */
type Effect = "countdown" | "correct" | "complete" | "winner";

const NOTES: Record<Effect, Array<[freq: number, start: number, dur: number]>> = {
  countdown: [[660, 0, 0.12]],
  correct: [
    [660, 0, 0.1],
    [880, 0.1, 0.16],
  ],
  complete: [
    [523, 0, 0.12],
    [659, 0.12, 0.12],
    [784, 0.24, 0.2],
  ],
  winner: [
    [523, 0, 0.12],
    [659, 0.12, 0.12],
    [784, 0.24, 0.12],
    [1047, 0.36, 0.35],
  ],
};

let ctx: AudioContext | null = null;

export function playSound(effect: Effect, enabled: boolean) {
  if (!enabled || typeof window === "undefined" || !("AudioContext" in window)) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    for (const [freq, start, dur] of NOTES[effect]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.15, now + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.05);
    }
  } catch {
    /* audio is optional */
  }
}
