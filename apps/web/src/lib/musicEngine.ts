/**
 * Looping cyberpunk background music: punchy backbeat drums, a gritty distorted bass, fast
 * 16th-note arpeggios, dark supersaw pads, a lead with echo, and snare-roll builds. Synthesized
 * with Web Audio, so there are no audio files to load or license, and the tunes are original.
 * Each bar is sixteen 16th-note steps: a note name plays, "-" holds the previous lead note,
 * "." is a rest. Flats are written as sharps (D#, not Eb).
 */
interface Bar {
  /** Chord notes for the supersaw pad, held for the whole bar. */
  chord: string[];
  /** The bass note, played in a galloping 16th pattern. */
  root: string;
  /** 16 lead steps. */
  lead?: string;
  /** "build" is a snare roll and riser with no kick or bass. Defaults to the full kit. */
  drums?: "full" | "build";
}
export interface Track {
  bpm: number;
  /** Played once before the loop. */
  intro?: Bar[];
  loop: Bar[];
  /** Lowest and highest cutoff (Hz) of the pad filter, swept across the loop. */
  sweep: [number, number];
}

export type TrackName = "arcade" | "victory";

export const TRACKS: Record<TrackName, Track> = {
  // Home page "Insert Coin": C minor night drive. A build, four bars of arps, then the hook.
  arcade: {
    bpm: 118,
    sweep: [600, 3800],
    intro: [
      { chord: ["C4", "D#4", "G4"], root: "C2", drums: "build" },
      { chord: ["G3", "B3", "D4"], root: "G1", drums: "build" },
    ],
    loop: [
      { chord: ["C4", "D#4", "G4"], root: "C2" },
      { chord: ["G#3", "C4", "D#4"], root: "G#1" },
      { chord: ["F3", "G#3", "C4"], root: "F1" },
      { chord: ["G3", "B3", "D4"], root: "G1" },
      { chord: ["C4", "D#4", "G4"], root: "C2", lead: "G5 - . G5 . D#6 - . D6 - . C6 . D6 - ." },
      { chord: ["G#3", "C4", "D#4"], root: "G#1", lead: "C6 - . C6 . D#6 - . G6 - - . F6 . D#6 ." },
      { chord: ["F3", "G#3", "C4"], root: "F1", lead: "F6 - . D#6 . C6 - . G#5 - . C6 . D#6 - ." },
      { chord: ["G3", "B3", "D4"], root: "G1", lead: "D6 - - - B5 - - . G5 . B5 . D6 - F6 ." },
    ],
  },
  // Winner screen "High Score": a heroic A minor drop after a short build.
  victory: {
    bpm: 124,
    sweep: [1000, 5500],
    intro: [
      { chord: ["A3", "C4", "E4"], root: "A1", drums: "build" },
      { chord: ["G#3", "B3", "E4"], root: "E1", drums: "build" },
    ],
    loop: [
      { chord: ["A3", "C4", "E4"], root: "A1", lead: "E6 - . A5 . C6 . E6 - . A6 - G6 . E6 ." },
      { chord: ["A3", "C4", "F4"], root: "F1", lead: "F6 - . C6 . A5 . C6 - . F6 - E6 . C6 ." },
      { chord: ["G3", "C4", "E4"], root: "C2", lead: "G6 - . E6 . C6 . E6 - . G6 - A6 . G6 ." },
      { chord: ["G#3", "B3", "E4"], root: "E1", lead: "G#6 - - - B6 - - - E6 - - . G#6 - B6 ." },
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

interface CompiledBar {
  chord: number[];
  root: number;
  lead: Array<number | "hold" | null>;
  drums: "full" | "build";
}

function compile(bar: Bar): CompiledBar {
  const lead = (bar.lead ?? "").trim().split(/\s+/);
  return {
    chord: bar.chord.map(freq).filter((f): f is number => f !== null),
    root: freq(bar.root) ?? 65.4,
    drums: bar.drums ?? "full",
    lead: Array.from({ length: 16 }, (_, i) => (lead[i] === "-" ? "hold" : freq(lead[i] ?? "."))),
  };
}

const LOOKAHEAD_S = 0.15;
/** Kick pattern: a driving backbeat with a push before beat four. */
const KICKS = "x.......x.x.....";
/** Arpeggio order through the chord, up an octave and back: indexes past the chord jump an octave. */
const ARP = [0, 1, 2, 3, 4, 5, 4, 3, 0, 1, 2, 3, 4, 5, 4, 3];

/** The arpeggio note for a step, an octave above the chord, or two for the upper half. */
function arpNote(chord: number[], step: number) {
  const k = ARP[step]!;
  return chord[k % chord.length]! * (k >= chord.length ? 4 : 2);
}

/** Hard clipping curve that makes the bass growl. */
const DRIVE = (() => {
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) curve[i] = Math.tanh(5 * ((i / 255) * 2 - 1));
  return curve;
})();
/** Detune (cents) of the stacked saws that make a "supersaw". */
const SUPERSAW = [-14, 0, 14];

export class MusicPlayer {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private mix: DynamicsCompressorNode | null = null;
  private pump: GainNode | null = null;
  private leadBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: TrackName | null = null;
  private track: Track | null = null;
  private bars: CompiledBar[] = [];
  private loopStart = 0;
  private step = 0;
  private nextTime = 0;
  private stepS = 0;
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
      this.mix = ctx.createDynamicsCompressor();
      this.mix.threshold.value = -16;
      this.mix.ratio.value = 4;
      this.mix.connect(this.out).connect(ctx.destination);
      // Pads and bass duck hard after every kick: the EDM "pump".
      this.pump = ctx.createGain();
      this.pump.connect(this.mix);
      // The lead gets a dotted-eighth echo.
      this.leadBus = ctx.createGain();
      this.leadBus.connect(this.mix);
      const delay = ctx.createDelay(1);
      delay.delayTime.value = this.stepS * 3;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.35;
      const wet = ctx.createGain();
      wet.gain.value = 0.35;
      this.leadBus.connect(delay).connect(feedback).connect(delay);
      delay.connect(wet).connect(this.mix);

      if (ctx.state === "suspended" && !document.hidden) void ctx.resume();
      this.timer = setInterval(() => this.schedule(), 25);
    } catch {
      /* music is optional */
    }
  }

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
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
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

      if (i === 0) this.pad(bar.chord, t, this.cutoff(barIndex), this.cutoff(barIndex + 1));
      this.arp(arpNote(bar.chord, i), t);
      if (bar.drums === "full") {
        if (KICKS[i] === "x") this.kick(t);
        if (i === 4 || i === 12) this.snare(t);
        if (i % 2 === 0) this.hat(t, i % 4 === 2 ? 0.1 : 0.03, i % 4 === 2 ? 0.35 : 0.2);
        // Galloping bass: three 16ths in every beat.
        if (i % 4 !== 1) this.bass(bar.root, t);
      } else {
        this.buildStep(barIndex, i, t);
      }
      const lead = bar.lead[i];
      if (typeof lead === "number") this.saw(lead, t, this.leadLength(bar, i));

      const n = this.step;
      if (this.onStep)
        setTimeout(() => this.onStep?.(Math.floor(n / 16), n % 16), Math.max(0, (t - ctx.currentTime) * 1000));
      this.nextTime += this.stepS;
      this.step++;
      if (this.step >= this.bars.length * 16) this.step = this.loopStart * 16;
    }
  }

  /** The pad filter rises through the intro, then opens and closes once across the loop. */
  private cutoff(barIndex: number) {
    const [lo, hi] = this.track!.sweep;
    const intro = this.loopStart;
    if (barIndex <= intro) return intro ? lo + ((hi - lo) * barIndex) / intro : lo;
    const loopBars = this.bars.length - intro;
    const pos = ((barIndex - intro) % loopBars) / loopBars;
    return lo + (hi - lo) * (0.5 - 0.5 * Math.cos(2 * Math.PI * pos));
  }

  /** How long a lead note lasts: its own step plus any "-" holds after it. */
  private leadLength(bar: CompiledBar, i: number) {
    let n = 1;
    while (i + n < 16 && bar.lead[i + n] === "hold") n++;
    return n * this.stepS;
  }

  /** Snare roll that speeds up and gets louder, over a rising noise sweep. */
  private buildStep(barIndex: number, i: number, t: number) {
    const intro = Math.max(1, this.loopStart);
    const progress = (barIndex * 16 + i) / (intro * 16);
    const every = progress < 0.5 ? 4 : progress < 0.75 ? 2 : 1;
    if (i % every === 0) this.clap(t, 0.25 + 0.6 * progress);
    if (barIndex === 0 && i === 0) this.riser(t, intro * 16 * this.stepS);
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
    osc.frequency.setValueAtTime(170, t);
    osc.frequency.exponentialRampToValueAtTime(48, t + 0.07);
    this.env(gain, t, 1.8, 0.24);
    osc.connect(gain).connect(this.mix!);
    osc.start(t);
    osc.stop(t + 0.26);
    // Duck the pads and bass, then let them swell back up before the next beat.
    const pump = this.pump!.gain;
    pump.setValueAtTime(0.4, t);
    pump.linearRampToValueAtTime(1, t + this.stepS * 3);
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
    src.connect(filter).connect(gain).connect(this.mix!);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.02);
  }

  private clap(t: number, level = 0.9) {
    // Three quick bursts read as hands clapping together.
    for (const d of [0, 0.01, 0.02]) this.noiseHit(t + d, "bandpass", 1500, 0.09 + d * 4, level);
  }

  /** A big snare: a tonal body under a noise crack and a clap. */
  private snare(t: number) {
    const ctx = this.ctx!;
    const body = ctx.createOscillator();
    const gain = ctx.createGain();
    body.type = "triangle";
    body.frequency.setValueAtTime(220, t);
    body.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    this.env(gain, t, 0.8, 0.12);
    body.connect(gain).connect(this.mix!);
    body.start(t);
    body.stop(t + 0.14);
    this.noiseHit(t, "highpass", 1800, 0.25, 1);
    this.clap(t, 0.7);
  }

  /** A short, resonant square pluck for the 16th-note arpeggio. */
  private arp(hz: number, t: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = hz;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 8;
    filter.frequency.setValueAtTime(3200, t);
    filter.frequency.exponentialRampToValueAtTime(600, t + this.stepS);
    const gain = ctx.createGain();
    this.env(gain, t, 0.13, this.stepS * 0.95);
    osc.connect(filter).connect(gain).connect(this.leadBus!);
    osc.start(t);
    osc.stop(t + this.stepS);
  }

  private hat(t: number, dur: number, level: number) {
    this.noiseHit(t, "highpass", 8500, dur, level);
  }

  /** White noise swept up through a filter across the build. */
  private riser(t: number, dur: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 2;
    filter.frequency.setValueAtTime(400, t);
    filter.frequency.exponentialRampToValueAtTime(9000, t + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.5, t + dur);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
    src.connect(filter).connect(gain).connect(this.mix!);
    src.start(t);
    src.stop(t + dur + 0.1);
  }

  /** A supersaw chord held for the bar, through a lowpass that moves to the next bar's cutoff. */
  private pad(chord: number[], t: number, from: number, to: number) {
    const ctx = this.ctx!;
    const dur = this.stepS * 16;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 3;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.linearRampToValueAtTime(to, t + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.07, t + 0.02);
    gain.gain.setValueAtTime(0.07, t + dur - 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    filter.connect(gain).connect(this.pump!);
    for (const hz of chord)
      for (const detune of SUPERSAW) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = hz;
        osc.detune.value = detune;
        osc.connect(filter);
        osc.start(t);
        osc.stop(t + dur);
      }
  }

  /** Gritty bass: detuned saws through hard clipping and a closing filter. */
  private bass(hz: number, t: number) {
    const ctx = this.ctx!;
    const drive = ctx.createWaveShaper();
    drive.curve = DRIVE;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 5;
    filter.frequency.setValueAtTime(1800, t);
    filter.frequency.exponentialRampToValueAtTime(300, t + this.stepS * 0.9);
    const gain = ctx.createGain();
    this.env(gain, t, 0.35, this.stepS * 0.95);
    drive.connect(filter).connect(gain).connect(this.pump!);
    for (const detune of [-12, 12]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = hz;
      osc.detune.value = detune;
      osc.connect(drive);
      osc.start(t);
      osc.stop(t + this.stepS);
    }
  }

  /** Supersaw lead with a plucky filter, into the echo bus. */
  private saw(hz: number, t: number, dur: number) {
    const ctx = this.ctx!;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 2;
    filter.frequency.setValueAtTime(7000, t);
    filter.frequency.exponentialRampToValueAtTime(1800, t + Math.min(dur, 0.25));
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.28, t + 0.008);
    gain.gain.setValueAtTime(0.28, t + dur * 0.85);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    filter.connect(gain).connect(this.leadBus!);
    for (const detune of SUPERSAW) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = hz;
      osc.detune.value = detune;
      osc.connect(filter);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }
  }
}
