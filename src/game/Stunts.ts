/**
 * Stunts — Forza Horizon PR stunts (Speed Trap, Speed Zone, Drift Zone).
 *
 * A stunt is a trigger placed at a station on the circuit. In free roam the
 * player drives through one and is scored immediately with a star rating 0–3
 * plus a score; the bus event carries it to the HUD as a toast.
 *
 * Design decisions worth recording:
 *
 * - Triggers live at fixed arc-length stations, so they sit in world space via
 *   `track.sample()` and never move. Nothing is placed ON the road: gates and
 *   gantries hang at the roadside where scenery already knows how to live.
 * - The player's speed / drift charge is sampled every frame while INSIDE a
 *   zone and finalised on exit. A kart that spawns inside a zone (roam start)
 *   is ignored until it has left once — a trigger firing at spawn scores zero
 *   stars and reads as broken rather than generous.
 * - Stars are deliberately generous thresholds so exploration pays in roam:
 *   three stars means "you were going properly fast", not a leaderboard cut.
 */

import * as THREE from 'three';
import { RaceState } from '../types';
import type { Ctx, System, IKart } from '../types';

/** One placed stunt trigger. */
interface Stunt {
  kind: 'speed' | 'drift' | 'danger';
  /** arc-length station along the centerline, metres */
  d: number;
  /** half-length of the zone along the road, metres */
  span: number;
  /** world-space centre (solved once from `d`) */
  pos: THREE.Vector3;
}

/** Star thresholds per kind — [1★, 2★, 3★] in kind-native units. */
const THRESHOLDS: Record<Stunt['kind'], [number, number, number]> = {
  // m/s through the gate
  speed: [16, 22, 27],
  // drift charge accumulated across the zone (tier-seconds)
  drift: [0.5, 1.2, 2.2],
  // seconds of air time inside the zone
  danger: [0.35, 0.6, 0.9],
};

const LABEL: Record<Stunt['kind'], string> = {
  speed: 'SPEED TRAP',
  drift: 'DRIFT ZONE',
  danger: 'DANGER SIGN',
};

const a1 = (st: Stunt) => THRESHOLDS[st.kind][0];

export class Stunts implements System {
  private ctx!: Ctx;
  private stunts: Stunt[] = [];
  /** index into `stunts` the player is currently inside, or -1 */
  private inside = -1;
  private armed = false;
  private accum = 0;
  private peak = 0;
  private air = 0;

  init(ctx: Ctx) {
    this.ctx = ctx;

    // Placement: spread over the circuit's scenic stretches. Stations chosen
    // by fraction of lap length so they survive any retune of the spline.
    const L = ctx.track.length;
    const spec: Array<[Stunt['kind'], number, number]> = [
      // long harbour straight — a natural speed trap
      ['speed', 0.06, 4],
      ['drift', 0.19, 26],
      ['speed', 0.34, 4],
      ['danger', 0.47, 30],
      ['drift', 0.62, 26],
      ['speed', 0.78, 4],
      ['drift', 0.88, 24],
    ];
    for (const [kind, frac, span] of spec) {
      const s = ctx.track.sample(frac);
      this.stunts.push({ kind, d: frac * L, span, pos: s.pos.clone() });
    }
  }

  update(ctx: Ctx, dt: number) {
    // Roam only: during a race these are inert roadside dressing.
    if (ctx.race.state !== RaceState.FreeRoam) {
      if (this.inside >= 0) this.reset();
      return;
    }

    const player: IKart = ctx.race.player;
    if (!player || player.finished) return;

    const track = ctx.track;
    const L = track.length;
    const dNow = player.t * L;

    let hit = -1;
    for (let i = 0; i < this.stunts.length; i++) {
      const st = this.stunts[i];
      let dd = dNow - st.d;
      dd -= Math.round(dd / L) * L;   // signed wrap-around distance
      if (Math.abs(dd) <= st.span) { hit = i; break; }
    }

    if (hit !== this.inside) {
      if (this.inside >= 0 && this.armed) this.score(this.stunts[this.inside]);
      this.inside = hit;
      this.armed = false;           // arms only after leaving once
      this.accum = 0;
      this.peak = 0;
      this.air = 0;
      return;
    }

    if (this.inside < 0) return;
    this.armed = true;              // we have genuinely driven in from outside

    const st = this.stunts[this.inside];
    switch (st.kind) {
      case 'speed':
        // peak speed across the zone, so braking late still counts what you had
        this.peak = Math.max(this.peak, Math.abs(player.forwardSpeed));
        break;
      case 'drift':
        // charge accrues only while actually sliding; tier-3 charges fastest
        if (player.driftTier > 0) this.accum += dt * player.driftTier;
        break;
      case 'danger':
        if (player.airborne) this.air += dt;
        break;
    }
  }

  private score(st: Stunt) {
    const [, b, c] = THRESHOLDS[st.kind];
    const v = st.kind === 'speed' ? this.peak : st.kind === 'drift' ? this.accum : this.air;
    const stars = v >= c ? 3 : v >= b ? 2 : v >= a1(st) ? 1 : 0;
    // Score scales with the reading itself, capped so a single zone can't
    // dominate a session total.
    const score = Math.min(9999, Math.round(v * 100) + stars * 250);
    const unit = st.kind === 'speed'
      ? `${Math.round(v * 2.237)} MPH`
      : st.kind === 'drift' ? `${v.toFixed(1)} CHARGE` : `${v.toFixed(2)}s AIR`;
    this.ctx.bus.emit({
      type: 'stunt', kind: st.kind, stars, score,
      label: `${LABEL[st.kind]} · ${unit}`,
    });
  }

  private reset() {
    this.inside = -1;
    this.armed = false;
    this.accum = 0;
    this.peak = 0;
    this.air = 0;
  }

  dispose() {}
}
