// EngineAudio.js — fully synthetic vehicle sound, no asset files.
//
// A racing game with no engine note feels dead; this synthesises the whole
// sound bed from the WebAudio graph:
//   • Engine  — two detuned sawtooth oscillators (the "comb" gives a real
//     multi-cylinder growl) + a sine sub for body, through a low-pass whose
//     cutoff tracks a simulated RPM. Pitch rises through each "gear" then
//     drops on upshift — the classic rising-and-falling race-engine contour.
//   • Tyre squeal — a band-passed noise burst whose level follows lateral
//     slip (drifting / hard cornering).
//   • Wind / road roar — filtered noise that swells with speed.
//
// Browsers require a user gesture to start AudioContext, so the graph is built
// lazily on the first input and suspended until then.
//
// API:
//   const a = new EngineAudio();
//   a.resume();                       // call on first user gesture (key/click)
//   a.update(dt, { speed, throttle, slip, boosting, airborne });
//   a.setMuted(bool) / a.toggleMute()

const MAX_SPEED = 82;     // must match Car.js MAX_SPEED — RPM maps off this
const IDLE_RPM = 950;
const REDLINE = 7600;
const GEARS = [0, 13, 27, 45, 64, 82]; // speed (m/s) at which each gear shifts

export class EngineAudio {
  constructor() {
    this.ctx = null;
    this._muted = false;
    this._started = false;
    this._gear = 1;
    this._rpm = IDLE_RPM;
    this._windGain = 0;
    this._squealGain = 0;
  }

  // Lazily build the graph. Safe to call repeatedly.
  _build() {
    if (this._started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = this._muted ? 0 : 0.9;
    this._master = master;
    master.connect(ctx.destination);

    // ── Engine tone ──────────────────────────────────────────────────────
    // Two detuned saws → low-pass (cutoff = RPM) → a touch of overdrive → out.
    const eg = ctx.createGain(); eg.gain.value = 0.0; eg.connect(master);
    this._engineGain = eg;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 400; lp.Q.value = 6;
    lp.connect(eg);
    this._engineLP = lp;
    // waveshaper for subtle grit
    const shaper = ctx.createWaveShaper();
    shaper.curve = this._softClipCurve(1.6);
    shaper.connect(lp);

    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 60;
    const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 60;
    const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = 30;
    const o1g = ctx.createGain(); o1g.gain.value = 0.5;
    const o2g = ctx.createGain(); o2g.gain.value = 0.5;
    const subg = ctx.createGain(); subg.gain.value = 0.6;
    o1.connect(o1g); o2.connect(o2g); sub.connect(subg);
    o1g.connect(shaper); o2g.connect(shaper); subg.connect(eg);
    o1.start(); o2.start(); sub.start();
    this._o1 = o1; this._o2 = o2; this._sub = sub;

    // ── Noise source (shared by wind + squeal) ───────────────────────────
    const noise = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noise.buffer = buf; noise.loop = true; noise.start();

    // Wind / road roar: low-passed noise, gain follows speed.
    const windBP = ctx.createBiquadFilter();
    windBP.type = 'lowpass'; windBP.frequency.value = 900;
    const windG = ctx.createGain(); windG.gain.value = 0;
    noise.connect(windBP); windBP.connect(windG); windG.connect(master);
    this._windGainNode = windG; this._windFilter = windBP;

    // Tyre squeal: band-passed noise around 1.2kHz, gain follows slip.
    const sqBP = ctx.createBiquadFilter();
    sqBP.type = 'bandpass'; sqBP.frequency.value = 1200; sqBP.Q.value = 4;
    const sqG = ctx.createGain(); sqG.gain.value = 0;
    noise.connect(sqBP); sqBP.connect(sqG); sqG.connect(master);
    this._squealNode = sqG; this._squealFilter = sqBP;

    this._started = true;
  }

  /** One-shot metallic thud for barrier / tree hits. */
  playImpact(amount = 0.5) {
    if (!this._started || !this.ctx || this._muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const a = Math.min(1, Math.max(0.15, amount));

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(90 + a * 40, now);
    osc.frequency.exponentialRampToValueAtTime(45, now + 0.12);

    const noise = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.15, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (data.length * 0.25));
    noise.buffer = buf;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 280; bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.35 * a, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

    osc.connect(g); noise.connect(bp); bp.connect(g); g.connect(this._master);
    osc.start(now); osc.stop(now + 0.2);
    noise.start(now); noise.stop(now + 0.15);
  }

  _softClipCurve(amount) {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * amount) / Math.tanh(amount);
    }
    return c;
  }

  // Call on the first user gesture (keydown / pointerdown) so the browser
  // unlocks audio. Idempotent.
  resume() {
    if (!this._started) this._build();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m) {
    this._muted = m;
    if (this._master && this.ctx) {
      this._master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
    }
  }
  toggleMute() { this.setMuted(!this._muted); return this._muted; }

  // Simulate a 5-speed gearbox: pick the gear for the current speed, then map
  // RPM to rise across that gear's band. Each gear spans 55%→100% of the rev
  // band, so an upshift drops the note ~45% — the classic "rise, drop, rise"
  // race-engine contour instead of a monotone whine that pegs at redline.
  _rpmFor(speed) {
    const s = Math.abs(speed);
    // Find the current gear: passing GEARS[i] (gear i's upshift speed) means
    // we're now in gear i+1. (An off-by-one here saturates every gear and pegs
    // the note at redline — the original bug.)
    let g = 1;
    for (let i = 1; i < GEARS.length; i++) { if (s >= GEARS[i]) g = i + 1; }
    if (g > GEARS.length - 1) g = GEARS.length - 1; // cap at top gear
    const lo = GEARS[g - 1];
    const hi = GEARS[g];
    const t = Math.min(1, Math.max(0, (s - lo) / (hi - lo)));
    const top = (g >= GEARS.length - 1);
    // top gear has no further shifts — climb straight to redline with speed
    const frac = top ? Math.min(1, s / MAX_SPEED) : 0.55 + 0.45 * t;
    let rpm = IDLE_RPM + (REDLINE - IDLE_RPM) * frac;
    // At a near-standstill ease down to a true idle murmur, so the engine
    // doesn't hold 3000+ rpm at the lights.
    if (s < 3) rpm = IDLE_RPM + (rpm - IDLE_RPM) * (s / 3);
    this._gear = g;
    return rpm;
  }

  update(dt, { speed = 0, throttle = 0, slip = 0, boosting = false, airborne = false } = {}) {
    if (!this._started || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const target = this._rpmFor(speed);
    // smooth RPM so it doesn't zip; faster on the way up (lively) than down
    const rate = target > this._rpm ? 7 : 3.5;
    this._rpm += (target - this._rpm) * Math.min(1, rate * dt);

    // Engine fundamental from RPM (4-stroke fires twice per rev for a 4-cyl;
    // we use ~RPM/30 for a meaty ~30Hz idle tone that rises to ~250Hz).
    const f = Math.max(28, this._rpm / 30);
    this._o1.frequency.setTargetAtTime(f, now, 0.02);
    this._o2.frequency.setTargetAtTime(f * 1.01, now, 0.02); // slight detune comb
    this._sub.frequency.setTargetAtTime(f * 0.5, now, 0.02);
    // filter opens with RPM + throttle for the "waa" on acceleration
    const cutoff = 320 + (this._rpm / REDLINE) * 2600 + throttle * 1200 + (boosting ? 1500 : 0);
    this._engineLP.frequency.setTargetAtTime(cutoff, now, 0.03);
    // engine loudness: idle hum always present, swells with load/throttle
    const load = 0.06 + 0.10 * Math.abs(speed) / MAX_SPEED + 0.12 * throttle + (boosting ? 0.12 : 0);
    this._engineGain.gain.setTargetAtTime(load, now, 0.05);

    // Wind/road roar follows speed; lighter when airborne (no tyre contact).
    const spd = Math.abs(speed);
    const windTarget = airborne ? 0.12 * Math.min(1, spd / MAX_SPEED)
                                : 0.05 + 0.42 * Math.min(1, spd / MAX_SPEED);
    this._windGainNode.gain.setTargetAtTime(windTarget, now, 0.08);
    this._windFilter.frequency.setTargetAtTime(500 + spd * 22, now, 0.1);

    // Tyre squeal follows lateral slip (only with ground contact + some speed).
    const sqTarget = (airborne || spd < 8) ? 0 : Math.min(0.5, slip / 14);
    this._squealNode.gain.setTargetAtTime(sqTarget, now, 0.04);
    this._squealFilter.frequency.setTargetAtTime(900 + slip * 40, now, 0.05);
  }
}
