// ProgressTracker.js — road arc-length progress for events.
//
// Tracks a car's progress along a road as a cumulative arc length, used by every
// event to detect gate/checkpoint crossings, lap completions, and stunt windows.
//
// The tracker is INCREMENTAL and fold-immune: each frame it projects the car's
// per-frame displacement onto the road direction at the current arc, rather than
// searching for the globally-nearest centerline point. This is immune to the
// world road folding back across itself (which defeats any nearest-point search)
// and works equally on the closed Circuit loop. A large per-frame delta (>300 m)
// is treated as a teleport and triggers a one-off nearest-search resync.
//
// LAP MODE (closed circuits): progress wraps modulo the lap length, and each
// forward wrap increments the lap counter. The Circuit's `sampleAtDistance`
// already wraps its input modulo the lap length, so a wrapped progress maps to
// the correct world position.
//
// Ported from Race._trackProgress + Race._fullArc, generalised to any road and
// extended with lap wrap.
//
// Road contract: { sampleAtDistance(d)→{position,heading}, centerline()→[{x,z}] }.

export class ProgressTracker {
  /**
   * @param {object} road anything with sampleAtDistance + centerline
   * @param {{lap?:boolean}} [opts] lap=true for closed circuits
   */
  constructor(road, opts = {}) {
    this.road = road;
    this.lapMode = !!opts.lap;
    this._buildArcTable();
    this._progress = 0;
    this._lap = 0; // completed laps (lap mode only); 0 in open mode
  }

  // Cumulative arc-length table from the centerline, for the teleport resync.
  _buildArcTable() {
    const cl = this.road.centerline();
    this._cl = cl;
    this._arc = new Float32Array(cl.length);
    let acc = 0;
    for (let i = 0; i < cl.length; i++) {
      if (i > 0) acc += Math.hypot(cl[i].x - cl[i - 1].x, cl[i].z - cl[i - 1].z);
      this._arc[i] = acc;
    }
    this._total = acc; // total arc length (open) or lap length (lap mode)
  }

  /** Current arc progress. In lap mode this is the within-lap arc [0..lapLen). */
  get progress() { return this._progress; }

  /** Total arc length (open) or lap length (lap mode). */
  get total() { return this._total; }

  /** Completed laps (lap mode); always 0 in open mode. */
  get lapsCompleted() { return this._lap; }

  /** Hard-set progress + lap (e.g., on event start / reset). */
  reset(startArc = 0, lap = 0) {
    this._progress = startArc;
    this._lap = lap;
  }

  /** Snap progress to the nearest centerline arc to (x,z) — explicit teleport. */
  resyncNearest(x, z) {
    this._progress = this._nearestArc(x, z);
  }

  // Global nearest-centerline arc (only used to resync after a big teleport).
  _nearestArc(x, z) {
    const cl = this._cl, arc = this._arc;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < cl.length; i++) {
      const dx = cl[i].x - x, dz = cl[i].z - z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    return arc[bi];
  }

  /**
   * Advance progress from the car's per-frame world displacement.
   * @param {{x:number,z:number}} pos car world position
   * @returns {number} the new arc progress
   */
  update(pos) {
    const s = this.road.sampleAtDistance(this._progress);
    const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
    const delta = (pos.x - s.position.x) * fx + (pos.z - s.position.z) * fz;
    let np = this._progress + delta;
    if (Math.abs(delta) > 300) np = this._nearestArc(pos.x, pos.z);

    if (this.lapMode) {
      // Wrap modulo lap length; each forward wrap completes a lap.
      while (np >= this._total) { np -= this._total; this._lap++; }
      while (np < 0) { np += this._total; this._lap = Math.max(0, this._lap - 1); }
      this._progress = np;
    } else {
      this._progress = np < 0 ? 0 : (np > this._total ? this._total : np);
    }
    return this._progress;
  }
}
