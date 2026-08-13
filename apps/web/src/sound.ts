/**
 * Tiny synthesized sound effects — WebAudio oscillators only, no assets, no deps.
 * Enabled by default; the toggle lives in the settings panel (persisted).
 */
export type SfxName = "play" | "clash" | "destroy" | "rankUp" | "select";

const KEY = "solforge-sfx-enabled";

let enabled = true;
try {
  const v = localStorage.getItem(KEY);
  if (v !== null) enabled = v === "1";
} catch { /* no storage */ }

export function isSfxEnabled(): boolean {
  return enabled;
}

export function setSfxEnabled(v: boolean): void {
  enabled = v;
  try {
    localStorage.setItem(KEY, v ? "1" : "0");
  } catch { /* no storage */ }
}

let ctx: AudioContext | null = null;

/** Lazily create the context (must happen after a user gesture on some browsers). */
function ac(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

interface Tone {
  type: OscillatorType;
  f0: number;
  /** glide target (exponential ramp); omit for a steady tone */
  f1?: number;
  /** start time (audio clock) */
  t: number;
  dur: number;
  vol: number;
}

function tone(c: AudioContext, { type, f0, f1, t, dur, vol }: Tone): void {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  if (f1 !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** Play a named effect; silently no-ops when disabled or audio is unavailable. */
export function playSfx(name: SfxName): void {
  if (!enabled) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  switch (name) {
    case "play": // card slap "啪"
      tone(c, { type: "square", f0: 240, f1: 70, t, dur: 0.09, vol: 0.16 });
      break;
    case "clash": // battle impact
      tone(c, { type: "sawtooth", f0: 320, f1: 60, t, dur: 0.14, vol: 0.15 });
      tone(c, { type: "square", f0: 90, f1: 45, t, dur: 0.12, vol: 0.11 });
      break;
    case "destroy": // low thud
      tone(c, { type: "sine", f0: 150, f1: 38, t, dur: 0.28, vol: 0.18 });
      break;
    case "rankUp": // little ascending arpeggio
      [440, 554, 659].forEach((f, i) =>
        tone(c, { type: "sine", f0: f, t: t + i * 0.07, dur: 0.1, vol: 0.13 }));
      break;
    case "select": // soft "pick a target" blip
      tone(c, { type: "sine", f0: 660, f1: 880, t, dur: 0.07, vol: 0.09 });
      break;
  }
}
