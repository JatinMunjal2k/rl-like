/**
 * All sounds are synthesised with WebAudio, no assets. An AudioContext can only start from a
 * user gesture, so `start()` is called when the player leaves the menu (a click or key press).
 */

export interface SoundFrame {
  /** Car speed in uu/s. */
  speedUU: number;
  /** Throttle input, -1..1. */
  throttle: number;
  boosting: boolean;
  grounded: boolean;
  jumped: boolean;
  landed: boolean;
  /** 0 = none, 1 = small pad, 2 = big pad. */
  padCollected: 0 | 1 | 2;
  /** Relative speed of a car-ball hit this frame in uu/s, 0 if none. */
  ballHitSpeedUU: number;
  /** Ball hitting the arena this frame, uu/s along the normal, 0 if none. */
  ballBounceSpeedUU: number;
  goal: boolean;
  /** Car hitting a wall this frame, uu/s, 0 if none. */
  wallHitSpeedUU: number;
}

export class SoundManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private engineOsc!: OscillatorNode;
  private engineOsc2!: OscillatorNode;
  private boostGain!: GainNode;
  private boostFilter!: BiquadFilterNode;
  private noiseBuffer!: AudioBuffer;
  private volume = 0.6;
  private lastHitAt = 0;

  get started(): boolean {
    return this.ctx !== null;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Create the graph. Must be called from a user gesture the first time. */
  start(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);

    // Engine: two detuned saws through a low-pass, pitch and brightness follow speed.
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 500;
    this.engineFilter.Q.value = 1.5;
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 55;
    this.engineOsc2 = ctx.createOscillator();
    this.engineOsc2.type = 'square';
    this.engineOsc2.frequency.value = 55 * 1.5;
    const osc2Gain = ctx.createGain();
    osc2Gain.gain.value = 0.35;
    this.engineOsc.connect(this.engineFilter);
    this.engineOsc2.connect(osc2Gain).connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain).connect(this.master);
    this.engineOsc.start();
    this.engineOsc2.start();

    // Boost: looping white noise through a band-pass, faded in and out.
    this.noiseBuffer = makeNoise(ctx, 1.0);
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;
    this.boostFilter = ctx.createBiquadFilter();
    this.boostFilter.type = 'bandpass';
    this.boostFilter.frequency.value = 900;
    this.boostFilter.Q.value = 0.7;
    this.boostGain = ctx.createGain();
    this.boostGain.gain.value = 0;
    noise.connect(this.boostFilter).connect(this.boostGain).connect(this.master);
    noise.start();
  }

  update(f: SoundFrame): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const ratio = Math.min(1, f.speedUU / 2300);

    // Engine pitch: idle 55 Hz up to ~260 Hz at max speed, with a gear-like bump from throttle.
    const targetFreq = 55 + 205 * ratio + 15 * Math.abs(f.throttle);
    this.engineOsc.frequency.setTargetAtTime(targetFreq, t, 0.08);
    this.engineOsc2.frequency.setTargetAtTime(targetFreq * 1.5, t, 0.08);
    this.engineFilter.frequency.setTargetAtTime(350 + 1800 * ratio + 400 * Math.abs(f.throttle), t, 0.1);
    const engineLevel = (0.012 + 0.03 * Math.abs(f.throttle) + 0.018 * ratio) * (f.grounded ? 1 : 0.7);
    this.engineGain.gain.setTargetAtTime(engineLevel, t, 0.08);

    // Boost roar.
    this.boostGain.gain.setTargetAtTime(f.boosting ? 0.28 : 0, t, f.boosting ? 0.04 : 0.12);
    this.boostFilter.frequency.setTargetAtTime(700 + 900 * ratio, t, 0.1);

    if (f.jumped) this.thump(90, 0.12, 0.35);
    if (f.landed) this.thump(70, 0.1, 0.25);
    if (f.padCollected === 2) this.chime([660, 880, 1320], 0.09, 0.22);
    else if (f.padCollected === 1) this.chime([880, 1175], 0.06, 0.15);
    if (f.ballHitSpeedUU > 0 && t - this.lastHitAt > 0.05) {
      this.lastHitAt = t;
      const k = Math.min(1, f.ballHitSpeedUU / 3000);
      this.ballHit(0.15 + 0.55 * k, 1 - 0.5 * k);
    }
    if (f.ballBounceSpeedUU > 200 && t - this.lastHitAt > 0.05) {
      this.lastHitAt = t;
      const k = Math.min(1, f.ballBounceSpeedUU / 3000);
      this.ballHit(0.08 + 0.35 * k, 0.8 - 0.4 * k);
    }
    if (f.wallHitSpeedUU > 300) this.noiseBurst(0.12, 400, Math.min(0.5, f.wallHitSpeedUU / 3000));
    if (f.goal) this.goalHorn();
  }

  // ---------------------------------------------------------------------------
  // One-shots
  // ---------------------------------------------------------------------------

  private thump(freq: number, dur: number, gain: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 2, t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur);
  }

  private noiseBurst(dur: number, filterFreq: number, gain: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur);
  }

  /** Ball impact: a hollow "pock" (short filtered noise + pitched sine). */
  private ballHit(gain: number, pitchScale: number): void {
    this.noiseBurst(0.06, 1800 * pitchScale, gain * 0.8);
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(220 * pitchScale, t);
    osc.frequency.exponentialRampToValueAtTime(110 * pitchScale, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.14);
  }

  private chime(freqs: number[], step: number, gain: number): void {
    const ctx = this.ctx!;
    freqs.forEach((f, i) => {
      const t = ctx.currentTime + i * step;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + step * 2.2);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + step * 2.3);
    });
  }

  private goalHorn(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    for (const [f, delay] of [
      [196, 0],
      [247, 0.0],
      [294, 0.0],
      [392, 0.25],
    ] as [number, number][]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + delay);
      g.gain.exponentialRampToValueAtTime(0.12, t + delay + 0.03);
      g.gain.setValueAtTime(0.12, t + delay + 0.6);
      g.gain.exponentialRampToValueAtTime(0.001, t + delay + 1.1);
      osc.connect(filter).connect(g).connect(this.master);
      osc.start(t + delay);
      osc.stop(t + delay + 1.15);
    }
  }
}

function makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}
