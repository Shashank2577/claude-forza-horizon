// Unified input: keyboard + gamepad, smoothed into a vehicle-friendly state.
// Produces { throttle, brake, steer, handbrake, boost, reset, camera }.
export class Controls {
  constructor() {
    this.keys = new Set();
    this.state = {
      throttle: 0, brake: 0, steer: 0,
      handbrake: false, boost: false, reset: false, camera: false, mute: false, start: false,
    };
    this._pendingCam = false;
    this._camConsumed = true;
    this._sm = {}; // smoothed-axis store (e.g. steer)

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyC') this._pendingCam = true;
      if (e.code === 'KeyR') this._pendingReset = true;
      if (e.code === 'KeyM') this._pendingMute = true;
      if (e.code === 'Enter') this._pendingStart = true;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  poll() {
    const k = this.keys;
    let throttle = 0, brake = 0, steer = 0;
    this.state.handbrake = false;
    if (k.has('KeyW') || k.has('ArrowUp')) throttle += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) brake += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) steer += 1;
    if (k.has('KeyD') || k.has('ArrowRight')) steer -= 1;

    // Gamepad (left stick steer, right trigger accelerate, left trigger brake).
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad) continue;
      const lx = pad.axes[0] || 0;
      if (Math.abs(lx) > 0.12) steer = -lx;
      const rt = pad.buttons[7] ? pad.buttons[7].value : 0;
      const lt = pad.buttons[6] ? pad.buttons[6].value : 0;
      if (rt > 0.05) throttle = Math.max(throttle, rt);
      if (lt > 0.05) brake = Math.max(brake, lt);
      if (pad.buttons[0] && pad.buttons[0].pressed) this.state.handbrake = true;
    }

    this.state.throttle = throttle;
    this.state.brake = brake;
    this.state.steer = this._smooth(steer, 'steer', 9);
    this.state.handbrake = k.has('Space') || this.state.handbrake;
    this.state.boost = k.has('ShiftLeft') || k.has('ShiftRight');

    if (this._pendingCam) { this.state.camera = true; this._pendingCam = false; }
    else this.state.camera = false;

    if (this._pendingReset) { this.state.reset = true; this._pendingReset = false; }
    else this.state.reset = false;

    if (this._pendingMute) { this.state.mute = true; this._pendingMute = false; }
    else this.state.mute = false;

    if (this._pendingStart) { this.state.start = true; this._pendingStart = false; }
    else this.state.start = false;

    // handbrake auto-resets next frame unless held
    return this.state;
  }

  _smooth(target, key, lambda) {
    const dt = 1 / 60;
    const cur = this._sm[key] ?? 0;
    const next = cur + (target - cur) * (1 - Math.exp(-lambda * dt));
    this._sm[key] = next;
    return next;
  }
}
