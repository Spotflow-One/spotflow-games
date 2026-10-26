/**
 * Looping hip-hop background music in the spirit of mid-2000s robot-voice anthems: booming
 * 808 kicks, hard snares, chopped synth stabs and a talk-box lead. Synthesized with Web Audio,
 * so there are no audio files to load or license, and the tunes are original. Each bar is
 * sixteen 16th-note steps: a note name plays, "-" holds the previous lead note, "." is a rest.
 */
interface Bar {
  /** Chord notes for the filtered synth stabs. */
  chord: string[];
  /** The 808 note, played on every kick. */
  root: string;
  /** 16 lead steps for the talk-box voice. */
  lead?: string;
  /** "kick" is kick only, for build-ups. Defaults to the full kit. */
  drums?: "full" | "kick" | "none";
}
export interface Track {
  bpm: number;
  /** Played once before the loop. */
  intro?: Bar[];
  loop: Bar[];
  /** Lowest and highest cutoff (Hz) of the chord filter, swept across the loop. */
  sweep: [number, number];
}

export type TrackName = "arcade" | "victory";

/** Where the kick (and 808) and the chopped chord stabs land in each bar. */
const KICKS = "x..x....x.x.....";
const STABS = "x..x..x.x.....x.";

export const TRACKS: Record<TrackName, Track> = {
  // Home page "Insert Coin": a minor groove, then the robot comes in.
  arcade: {
    bpm: 104,
    sweep: [700, 3600],
    loop: [
      { chord: ["E4", "G4", "B4", "D5"], root: "E1" },
      { chord: ["C4", "E4", "G4", "B4"], root: "C2" },
      { chord: ["D4", "G4", "B4"], root: "G1" },
      { chord: ["D4", "F#4", "A4"], root: "D2" },
      { chord: ["E4", "G4", "B4", "D5"], root: "E1", lead: "E5 - . G5 . A5 - . B5 - . A5 G5 - . ." },
      { chord: ["C4", "E4", "G4", "B4"], root: "C2", lead: "G5 - . E5 . G5 - . A5 - - . G5 E5 . ." },
      { chord: ["D4", "G4", "B4"], root: "G1", lead: "D5 - . G5 . B5 - . D6 - . B5 A5 - . ." },
      { chord: ["D4", "F#4", "A4"], root: "D2", lead: "A5 - - - F#5 - . E5 . D5 - . E5 - . ." },
    ],
  },
  // Winner screen "High Score": a filter build, then a bright major loop.
  victory: {
    bpm: 108,
    sweep: [1000, 5000],
    intro: [
      { chord: ["C4", "E4", "G4"], root: "C2", drums: "kick" },
      { chord: ["B3", "D4", "G4"], root: "G1", drums: "kick" },
    ],
    loop: [
      { chord: ["C4", "E4", "G4"], root: "C2", lead: "C6 - . G5 . C6 - . E6 - . D6 C6 - . ." },
      { chord: ["B3", "D4", "G4"], root: "G1", lead: "B5 - . G5 . B5 - . D6 - - . B5 G5 . ." },
      { chord: ["C4", "E4", "A4"], root: "A1", lead: "A5 - . C6 . E6 - . A6 - . G6 E6 - . ." },
      { chord: ["C4", "F4", "A4"], root: "F1", lead: "F6 - - - E6 - . D6 . C6 - . D6 - . ." },
    ],
  },
};

const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "F#4" to Hz, or null for anything else. */
function freq(note: string): number | null {
  const m = /^([A-G])(#?)(\d)$/.exec(note);
  if (!m) return null;
  const midi = 12 * (Number(m[3]) + 1) + SEMITONES[m[1]!]! + (m[2] ? 1 : 0);
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Vowel formants (Hz) the talk-box voice cycles through, one per note. */
const VOWELS: Array<[number, number]> = [
  [730, 1090], // "ah"
  [570, 840], // "oh"
  [530, 1840], // "eh"
  [300, 870], // "oo"
];

interface Step {
  lead: number | "hold" | null;
}
interface CompiledBar {
  chord: number[];
  root: number;
  steps: Step[];
  drums: "full" | "kick" | "none";
}

function compile(bar: Bar): CompiledBar {
  const lead = (bar.lead ?? "").trim().split(/\s+/);
  return {
    chord: bar.chord.map(freq).filter((f): f is number => f !== null),
    root: freq(bar.root) ?? 55,
    drums: bar.drums ?? "full",
    steps: Array.from({ length: 16 }, (_, i) => ({
      lead: lead[i] === "-" ? "hold" : freq(lead[i] ?? "."),
    })),
  };
}

const LOOKAHEAD_S = 0.15;

/** Soft clipping that gives the 808 some grit on small speakers. */
const DRIVE = (() => {
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * 2 - 1;
    curve[i] = Math.tanh(2.5 * x);
  }
  return curve;
})();

export class MusicPlayer {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private pump: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: TrackName | null = null;
  private track: Track | null = null;
  private bars: CompiledBar[] = [];
  private loopStart = 0;
  private step = 0;
  private nextTime = 0;
  private stepS = 0;
  private vowel = 0;
  /** Called with (bar, step) as each step sounds, for visualizers. */
  onStep: ((bar: number, step: number) => void) | null = null;

  constructor(private volume: number) {}

  get playing() {
    return this.current;
  }

  play(name: TrackName) {
    if (this.current === name) return;
    this.stop();
    if (typeof window === "undefined" || !("AudioContext" in window)) return;
    try {
      this.ctx ??= this.createContext();
      const ctx = this.ctx;
      const track = TRACKS[name];
      this.current = name;
      this.track = track;
      this.bars = [...(track.intro ?? []), ...track.loop].map(compile);
      this.loopStart = track.intro?.length ?? 0;
      this.stepS = 60 / track.bpm / 4;
      this.step = 0;
      this.nextTime = ctx.currentTime + 0.05;

      // Everything runs through a compressor for punch, then a fade-in.
      this.out = ctx.createGain();
      this.out.gain.setValueAtTime(0.0001, ctx.currentTime);
      this.out.gain.exponentialRampToValueAtTime(this.volume, ctx.currentTime + 0.5);
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      comp.connect(this.out).connect(ctx.destination);
      // Chords and bass duck after every kick, the classic house "pump".
      this.pump = ctx.createGain();
      this.pump.connect(comp);
      this.compIn = comp;

      if (ctx.state === "suspended" && !document.hidden) void ctx.resume();
      this.timer = setInterval(() => this.schedule(), 25);
    } catch {
      /* music is optional */
    }
  }

  private compIn: DynamicsCompressorNode | null = null;

  /** Stops the music, or only the given track if it is the one playing. */
  stop(name?: TrackName) {
    if (name && name !== this.current) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.current = null;
    const out = this.out;
    this.out = null;
    if (out && this.ctx) {
      const t = this.ctx.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(out.gain.value, t);
      out.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      setTimeout(() => out.disconnect(), 400);
    }
  }

  private createContext() {
    const ctx = new AudioContext();
    // Browsers keep audio suspended until the first click or key press on the page.
    const unlock = () => {
      if (this.current && !document.hidden) void ctx.resume();
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    // Don't play to a hidden tab.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) void ctx.suspend();
      else if (this.current) void ctx.resume();
    });
    const noise = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = noise;
    return ctx;
  }

  private schedule() {
    const ctx = this.ctx;
    if (!ctx || !this.out || !this.track) return;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD_S) {
      const barIndex = Math.floor(this.step / 16);
      const bar = this.bars[barIndex]!;
      const i = this.step % 16;
      const t = this.nextTime;
      const s = bar.steps[i]!;

      if (bar.drums !== "none" && KICKS[i] === "x") {
        this.kick(t);
        this.bass(bar.root, t);
      }
      if (bar.drums === "full") {
        if (i === 4 || i === 12) this.snare(t);
        // Eighth-note hats, with a quick roll into the next bar.
        if (i % 2 === 0 || i >= 13) this.hat(t, 0.04, i % 4 === 2 ? 0.35 : 0.2);
      }
      if (STABS[i] === "x") this.stab(bar.chord, t, this.cutoff(barIndex, i));
      if (typeof s.lead === "number") this.talk(s.lead, t, this.leadLength(bar, i));

      const n = this.step;
      if (this.onStep)
        setTimeout(() => this.onStep?.(Math.floor(n / 16), n % 16), Math.max(0, (t - ctx.currentTime) * 1000));
      this.nextTime += this.stepS;
      this.step++;
      if (this.step >= this.bars.length * 16) this.step = this.loopStart * 16;
    }
  }

  /** The chord filter opens and closes once across the loop; intros open steadily. */
  private cutoff(barIndex: number, i: number) {
    const [lo, hi] = this.track!.sweep;
    const introBars = this.loopStart;
    if (barIndex < introBars) return lo + ((hi - lo) * (barIndex * 16 + i)) / (introBars * 16);
    const loopSteps = (this.bars.length - introBars) * 16;
    const pos = ((barIndex - introBars) * 16 + i) / loopSteps;
    return lo + (hi - lo) * (0.5 - 0.5 * Math.cos(2 * Math.PI * pos));
  }

  /** How long a lead note lasts: its own step plus any "-" holds after it. */
  private leadLength(bar: CompiledBar, i: number) {
    let n = 1;
    while (i + n < 16 && bar.steps[i + n]!.lead === "hold") n++;
    return n * this.stepS;
  }

  private env(gain: GainNode, t: number, peak: number, dur: number) {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  private kick(t: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.08);
    this.env(gain, t, 1.8, 0.25);
    osc.connect(gain).connect(this.compIn!);
    osc.start(t);
    osc.stop(t + 0.3);
    // Duck the stabs a little so the kick cuts through.
    const pump = this.pump!.gain;
    pump.setValueAtTime(0.45, t);
    pump.linearRampToValueAtTime(1, t + this.stepS * 2);
  }

  private noiseHit(t: number, type: BiquadFilterType, hz: number, dur: number, level: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = hz;
    const gain = ctx.createGain();
    this.env(gain, t, level, dur);
    src.connect(filter).connect(gain).connect(this.compIn!);
    src.start(t, Math.random() * 0.2);
    src.stop(t + dur + 0.02);
  }

  /** A big layered snare: a tonal body, a noise crack and a clap. */
  private snare(t: number) {
    const ctx = this.ctx!;
    const body = ctx.createOscillator();
    const gain = ctx.createGain();
    body.type = "triangle";
    body.frequency.setValueAtTime(240, t);
    body.frequency.exponentialRampToValueAtTime(160, t + 0.08);
    this.env(gain, t, 0.9, 0.12);
    body.connect(gain).connect(this.compIn!);
    body.start(t);
    body.stop(t + 0.14);
    this.noiseHit(t, "highpass", 1800, 0.22, 1.1);
    // Three quick bursts read as hands clapping together.
    for (const d of [0, 0.011, 0.022]) this.noiseHit(t + d, "bandpass", 1300, 0.1 + d * 4, 0.8);
  }

  private hat(t: number, dur: number, level: number) {
    this.noiseHit(t, "highpass", 8000, dur, level);
  }

  /** Detuned saw chord through a lowpass filter: the filtered house stab. */
  private stab(chord: number[], t: number, cutoff: number) {
    const ctx = this.ctx!;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = cutoff;
    filter.Q.value = 6;
    const gain = ctx.createGain();
    this.env(gain, t, 0.22, this.stepS * 1.8);
    filter.connect(gain).connect(this.pump!);
    for (const hz of chord)
      for (const detune of [-8, 8]) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = hz;
        osc.detune.value = detune;
        osc.connect(filter);
        osc.start(t);
        osc.stop(t + this.stepS * 2);
      }
  }

  /** A booming 808: a sine that drops into the note and rings out, slightly overdriven. */
  private bass(hz: number, t: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(hz * 2, t);
    osc.frequency.exponentialRampToValueAtTime(hz, t + 0.05);
    const drive = ctx.createWaveShaper();
    drive.curve = DRIVE;
    const gain = ctx.createGain();
    const dur = this.stepS * 3.5;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.9, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(drive).connect(gain).connect(this.compIn!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** A robot "talk-box" voice: a buzzy source shaped by two vowel formant filters. */
  private talk(hz: number, t: number, dur: number) {
    const ctx = this.ctx!;
    const [f1, f2] = VOWELS[this.vowel++ % VOWELS.length]!;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(1, t + 0.01);
    gain.gain.setValueAtTime(1, t + dur * 0.8);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    gain.connect(this.compIn!);
    const formants = [f1, f2].map((f, k) => {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = 7;
      bp.frequency.setValueAtTime(f * 0.8, t);
      // The vowel opens as the note starts, like a mouth on a tube.
      bp.frequency.exponentialRampToValueAtTime(f, t + 0.06);
      const level = ctx.createGain();
      level.gain.value = k === 0 ? 1.4 : 0.9;
      bp.connect(level).connect(gain);
      return bp;
    });
    for (const [type, detune] of [
      ["sawtooth", -6],
      ["square", 6],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(hz * 0.97, t);
      osc.frequency.exponentialRampToValueAtTime(hz, t + 0.04);
      osc.detune.value = detune;
      for (const f of formants) osc.connect(f);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }
  }
}
