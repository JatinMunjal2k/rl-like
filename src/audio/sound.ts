/**
 * All sounds are synthesised with WebAudio, no assets. An AudioContext can only start from a
 * user gesture, so `start()` is called when the player leaves the menu (a click or key press).
 *
 * Continuous layers: engine (saw + square through a low-pass), tyre roll (low noise), boost roar
 * (band-passed noise), tyre skid (band-passed noise while sliding), supersonic wind (low noise).
 * One-shots: jump / double jump / dodge whooshes, landing thud scaled by impact, boost ignition,
 * pad chimes (big vs small), ball hit "pock" with a low thud layer, arena bounce, wall bump,
 * kickoff beeps and "go", goal horn with an explosion.
 */

export interface SoundFrame {
  /** Car speed in uu/s. */
  speedUU: number;
  /** Throttle input, -1..1. */
  throttle: number;
  boosting: boolean;
  /** True on the frame boost starts. */
  boostStarted: boolean;
  grounded: boolean;
  supersonic: boolean;
  jumped: boolean;
  doubleJumped: boolean;
  dodged: boolean;
  /** Vertical impact speed in uu/s on the frame the car lands, 0 otherwise. */
  landedSpeedUU: number;
  /** 0..1 tyre slip intensity (powerslide or sideways sliding). */
  skid: number;
  /** 0 = none, 1 = small pad, 2 = big pad. */
  padCollected: 0 | 1 | 2;
  /** Relative speed of a car-ball hit this frame in uu/s, 0 if none. */
  ballHitSpeedUU: number;
  /** Ball hitting the arena this frame, uu/s along the normal, 0 if none. */
  ballBounceSpeedUU: number;
  goal: boolean;
  /** Car hitting a wall this frame, uu/s, 0 if none. */
  wallHitSpeedUU: number;
  /** Kickoff countdown: 1 = a number ticked, 2 = "go", 0 = nothing. */
  countdown: 0 | 1 | 2;
}

interface NoiseLayer {
  filter: BiquadFilterNode;
  gain: GainNode;
}

export class SoundManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private engineOsc!: OscillatorNode;
  private engineOsc2!: OscillatorNode;
  private boost!: NoiseLayer;
  private roll!: NoiseLayer;
  private skid!: NoiseLayer;
  private wind!: NoiseLayer;
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

    // Continuous noise layers share one looping noise source each.
    this.noiseBuffer = makeNoise(ctx, 1.0);
    this.boost = this.noiseLayer('bandpass', 900, 0.7);
    this.roll = this.noiseLayer('lowpass', 220, 0.5);
    this.skid = this.noiseLayer('bandpass', 1400, 1.2);
    this.wind = this.noiseLayer('lowpass', 500, 0.4);
  }

  private noiseLayer(type: BiquadFilterType, freq: number, q: number): NoiseLayer {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    return { filter, gain };
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

    // Tyres rolling on the floor: quiet low rumble that grows with speed, gone in the air.
    this.roll.gain.gain.setTargetAtTime(f.grounded ? 0.05 * Math.pow(ratio, 0.7) : 0, t, 0.08);
    this.roll.filter.frequency.setTargetAtTime(180 + 300 * ratio, t, 0.1);

    // Boost roar.
    this.boost.gain.gain.setTargetAtTime(f.boosting ? 0.28 : 0, t, f.boosting ? 0.04 : 0.12);
    this.boost.filter.frequency.setTargetAtTime(700 + 900 * ratio, t, 0.1);
    if (f.boostStarted) this.noiseBurst(0.12, 2500, 0.18, 'bandpass');

    // Skid while powersliding or sliding sideways.
    this.skid.gain.gain.setTargetAtTime(0.22 * f.skid, t, 0.05);
    this.skid.filter.frequency.setTargetAtTime(1100 + 700 * ratio, t, 0.1);

    // Supersonic wind.
    this.wind.gain.gain.setTargetAtTime(f.supersonic ? 0.12 : ratio > 0.8 ? 0.04 * (ratio - 0.8) * 5 : 0, t, 0.15);

    if (f.jumped) this.whoosh(500, 1400, 0.16, 0.22);
    if (f.doubleJumped) this.whoosh(800, 2000, 0.14, 0.2);
    if (f.dodged) {
      this.whoosh(300, 1800, 0.32, 0.26);
      this.thump(140, 0.08, 0.12);
    }
    if (f.landedSpeedUU > 0) {
      const k = Math.min(1, f.landedSpeedUU / 1200);
      this.thump(70, 0.1 + 0.05 * k, 0.12 + 0.3 * k);
      if (k > 0.3) this.noiseBurst(0.08, 600, 0.2 * k);
    }
    if (f.padCollected === 2) this.chime([523, 659, 784, 1047], 0.07, 0.22);
    else if (f.padCollected === 1) this.chime([988, 1319], 0.05, 0.12);
    if (f.ballHitSpeedUU > 0 && t - this.lastHitAt > 0.05) {
      this.lastHitAt = t;
      const k = Math.min(1, f.ballHitSpeedUU / 3000);
      this.ballHit(0.15 + 0.55 * k, 1 - 0.5 * k);
      if (k > 0.25) this.thump(60, 0.14, 0.35 * k); // body of a hard hit
    }
    if (f.ballBounceSpeedUU > 200 && t - this.lastHitAt > 0.05) {
      this.lastHitAt = t;
      const k = Math.min(1, f.ballBounceSpeedUU / 3000);
      this.ballHit(0.08 + 0.35 * k, 0.8 - 0.4 * k);
    }
    if (f.wallHitSpeedUU > 300) {
      const k = Math.min(1, f.wallHitSpeedUU / 2300);
      this.noiseBurst(0.12, 400, 0.5 * k);
      this.thump(90, 0.1, 0.25 * k);
    }
    if (f.countdown === 1) this.beep(880, 0.09, 0.18);
    else if (f.countdown === 2) {
      this.beep(1320, 0.28, 0.2);
      this.chime([660, 880], 0.03, 0.12);
    }
    if (f.goal) {
      this.goalHorn();
      this.explosion();
    }
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

  private beep(freq: number, dur: number, gain: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = freq * 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.setValueAtTime(gain, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(filter).connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur);
  }

  private noiseBurst(dur: number, filterFreq: number, gain: number, type: BiquadFilterType = 'lowpass'): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur);
  }

  /** Air whoosh: band-passed noise whose centre sweeps up then fades, like RL's jump and dodge. */
  private whoosh(fromHz: number, toHz: number, dur: number, gain: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.4;
    filter.frequency.setValueAtTime(fromHz, t);
    filter.frequency.exponentialRampToValueAtTime(toHz, t + dur * 0.55);
    filter.frequency.exponentialRampToValueAtTime(fromHz * 0.8, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.25);
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

  private explosion(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    // Low boom: noise through a closing low-pass plus a falling sub sine.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(900, t);
    filter.frequency.exponentialRampToValueAtTime(80, t + 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.8);
    this.thump(45, 0.5, 0.4);
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
