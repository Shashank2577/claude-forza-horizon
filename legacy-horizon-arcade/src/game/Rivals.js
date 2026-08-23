// Rivals.js — AI opponent cars that race the player along the road.
//
// Each rival is a full Car (same sculpted body, PBR paint, wheels, lights,
// contact shadow, arcade physics) driven by a pure-pursuit controller: it aims
// at a look-ahead point on the road centerline offset by a per-car lane, eases
// throttle toward a target speed, and lifts off the gas in sharp curves. This
// reuses the player's entire vehicle stack, so rivals look and move like real
// cars — not capsules.
//
// The manager also owns a centerline arc-length table so it can rank everyone
// (player's race position P x/n) for the HUD.
//
// API:
//   new Rivals({ terrain, road, seed })
//   .group              → THREE.Group (add once)
//   .update(dt, car)    → drive rivals + recompute ranking (car = player Car)
//   .reset()            → re-grid rivals at the start line
//   .state              → { count, total, playerRank, rivals:[{progress}] }

import * as THREE from 'three';
import { Car } from '../core/Car.js';
import { loadCarGltf } from '../core/HeroGltf.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class Rivals {
  constructor({ terrain, road, seed = 1337 }) {
    this.group = new THREE.Group();
    this.group.name = 'Rivals';
    this.terrain = terrain;
    this.road = road;
    this.seed = seed;
    this._cars = [];
    this.state = { count: 0, total: 1, playerRank: 1, rivals: [] };
    this._playerProgress = 0;
    this._buildArcTable();
    this._spawn();
  }

  get cars() { return this._cars; }

  setColliderGrid(grid) {
    for (const car of this._cars) {
      if (typeof car.setColliderGrid === 'function') car.setColliderGrid(grid);
    }
  }

  _buildArcTable() {
    const cl = this.road.centerline();
    this._cl = cl;
    this._arc = new Float32Array(cl.length);
    let acc = 0;
    for (let i = 0; i < cl.length; i++) {
      if (i > 0) acc += Math.hypot(cl[i].x - cl[i - 1].x, cl[i].z - cl[i - 1].z);
      this._arc[i] = acc;
    }
    this._totalArc = acc;
  }

  // Branch-aware road-progress tracker for the human player. Among centerline
  // points that are physically near the car (within `R` metres), pick the one
  // whose ARC is closest to the last-known progress. Restricting to physically
  // near points keeps us immune to the road folding back across itself, and
  // breaking ties by arc-distance-to-last means a fold that passes within R of
  // the car never snaps us onto the wrong branch. If nothing is within R (car
  // off-road or teleported), widen to a branch-aware global fallback.
  _arcAt(x, z, lastArc) {
    const cl = this._cl, arc = this._arc;
    const R2 = 80 * 80;
    let best = -1, bestArcDiff = Infinity, bestD2 = Infinity;
    for (let i = 0; i < cl.length; i++) {
      const dx = cl[i].x - x, dz = cl[i].z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > R2) continue;
      const ad = Math.abs(arc[i] - lastArc);
      if (ad < bestArcDiff || (ad === bestArcDiff && d2 < bestD2)) {
        bestArcDiff = ad; best = i; bestD2 = d2;
      }
    }
    if (best < 0) return this._fullArc(x, z, lastArc);
    return arc[best];
  }

  // Branch-aware global fallback: among ALL centerline points, prefer ones close
  // in arc to lastArc (same branch) when several are near the position; only
  // return a far-in-arc point when nothing near-last exists (a true teleport).
  _fullArc(x, z, lastArc) {
    const cl = this._cl, arc = this._arc;
    let near = -1, nearArcDiff = Infinity;
    const R2 = 120 * 120;
    for (let i = 0; i < cl.length; i++) {
      const dx = cl[i].x - x, dz = cl[i].z - z;
      if (dx * dx + dz * dz > R2) continue;
      const ad = Math.abs(arc[i] - lastArc);
      if (ad < nearArcDiff) { nearArcDiff = ad; near = i; }
    }
    if (near >= 0) return arc[near];
    // True far teleport: return the single globally-nearest point.
    let bi = 0, bd = Infinity;
    for (let i = 0; i < cl.length; i++) {
      const dx = cl[i].x - x, dz = cl[i].z - z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    return arc[bi];
  }

  _spawn() {
    // Distinct colors/lanes/speeds so the field spreads out and feels alive.
    // All grid PAST the start line (ahead > 0): a negative grid puts a car where
    // the road ribbon doesn't yet exist, which confuses the controller.
    const defs = [
      { color: 0x1f6fd6, lane: -3.0, ahead: 26, speed: 46, scale: 1.00 }, // coupe
      { color: 0x23a45a, lane:  3.1, ahead: 14, speed: 44, scale: 0.90 }, // compact
      { color: 0xe0a530, lane: -0.4, ahead:  4, speed: 42, scale: 1.08 }, // wide GT
      { color: 0x8b2fc9, lane:  2.2, ahead: 38, speed: 48, scale: 0.95 }, // hatch
      { color: 0xc41e3a, lane: -2.5, ahead: 18, speed: 45, scale: 1.12 }, // muscle
    ];
    const start = this.road.startSample();
    const fwd = { x: Math.sin(start.heading), z: Math.cos(start.heading) };
    const rx = Math.cos(start.heading), rz = -Math.sin(start.heading);
    defs.forEach((d, i) => {
      const car = new Car({ terrain: this.terrain, paintColor: d.color, bodyScale: d.scale });
      const px = start.position.x + rx * d.lane + fwd.x * d.ahead;
      const pz = start.position.z + rz * d.lane + fwd.z * d.ahead;
      car.placeAt(new THREE.Vector3(px, start.position.y, pz), start.heading);
      car._aiTargetSpeed = d.speed;
      car._aiLane = d.lane;
      car._aiProgress = this._arcAt(px, pz, Math.max(0, d.ahead)); // seed from true world position
      // Rivals skip real shadow-casting (their contact blob is enough) to hold
      // the frame budget — the hero car stays the lone shadow caster.
      car.group.traverse(o => { if (o.isMesh) o.castShadow = false; });
      if (typeof car.setRoad === 'function') car.setRoad(this.road);
      loadCarGltf(car, {
        length: 4.2 * d.scale,
        paintColor: d.color,
        castShadow: false,
        lightweight: true,
      });
      this._cars.push(car);
      this.group.add(car.group);
    });
    this.state.count = this._cars.length;
    this.state.total = this._cars.length + 1;
  }

  reset() {
    const start = this.road.startSample();
    const fwd = { x: Math.sin(start.heading), z: Math.cos(start.heading) };
    const rx = Math.cos(start.heading), rz = -Math.sin(start.heading);
    this._playerProgress = 0;
    this._cars.forEach((car, i) => {
      const ahead = Math.max(0, (i - 2) * 12);
      const px = start.position.x + rx * car._aiLane + fwd.x * ahead;
      const pz = start.position.z + rz * car._aiLane + fwd.z * ahead;
      car.placeAt(new THREE.Vector3(px, start.position.y, pz), start.heading);
      car._aiProgress = this._arcAt(px, pz, Math.max(0, ahead));
    });
  }

  update(dt, playerCar) {
    const road = this.road;
    const maxD = this._totalArc;
    // Previous-frame player arc drives rubber-banding this tick.
    const playerArc = this._playerProgress || 0;

    for (const car of this._cars) {
      const speed = car.speed;
      car._aiProgress = Math.min(car._aiProgress + Math.max(0, speed) * dt, maxD);

      const lookAhead = 7 + Math.abs(speed) * 0.30;
      const tp = Math.min(car._aiProgress + lookAhead, maxD);
      const s = road.sampleAtDistance(tp);
      const rx = Math.cos(s.heading), rz = -Math.sin(s.heading);
      const tx = s.position.x + rx * car._aiLane;
      const tz = s.position.z + rz * car._aiLane;

      const dx = tx - car.position.x, dz = tz - car.position.z;
      const desired = Math.atan2(dx, dz);
      let diff = desired - car.heading;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      const steer = clamp(diff * 2.2, -1, 1);

      // Rubber band: if far behind the player, raise target speed; if far ahead, ease off.
      const gap = playerArc - car._aiProgress; // >0 = rival behind player
      let target = car._aiTargetSpeed;
      if (gap > 80) target += clamp(gap * 0.04, 0, 18);      // catch up
      else if (gap < -120) target -= clamp(-gap * 0.025, 0, 12); // wait up

      const turn = Math.abs(diff);
      let throttle = clamp((target - speed) / 5, 0, 1);
      let brake = 0;
      if (speed > target + 3) { throttle = 0; brake = clamp((speed - target) / 9, 0, 0.7); }
      if (turn > 0.25 && speed > 8) { throttle = 0; brake = Math.max(brake, clamp((turn - 0.25) * 1.5, 0, 0.7)); }
      throttle *= clamp(1 - turn * 1.4, 0.2, 1);

      const off = road.distanceToCenterline(car.position.x, car.position.z);
      if (off > 5.5) {
        car._aiLane *= 0.92;
        throttle *= 0.55;
        brake = Math.max(brake, 0.25);
      }

      car.update(dt, { throttle, brake, steer, handbrake: false, boost: gap > 150, reset: false },
        this.terrain);
      // Catch-up boost shouldn't be limited by the player's nitro meter rules.
      if (gap > 150) car.nitro = Math.max(car.nitro, 0.4);
    }

    // Soft car-to-car bumps (player ↔ rivals).
    if (playerCar) {
      const MIN = 2.6;
      const MIN2 = MIN * MIN;
      const CULL2 = 320 * 320;
      for (const car of this._cars) {
        const dx = playerCar.position.x - car.position.x;
        const dz = playerCar.position.z - car.position.z;
        const d2 = dx * dx + dz * dz;
        car.group.visible = d2 < CULL2;
        if (d2 >= MIN2 || d2 < 1e-4) continue;
        const d = Math.sqrt(d2);
        const push = (MIN - d) * 0.5;
        const nx = dx / d, nz = dz / d;
        playerCar.position.x += nx * push;
        playerCar.position.z += nz * push;
        car.position.x -= nx * push;
        car.position.z -= nz * push;
        playerCar.speed *= 0.92;
        car.speed *= 0.88;
        if (playerCar._vx !== undefined) {
          playerCar._vx *= 0.9;
          playerCar._vz *= 0.9;
        }
      }
    }

    // Rank the human player against the field. The player is hand-driven, so we
    // can't use an odometer — find their true road arc via the fold-immune
    // arc-window search.
    this._playerProgress = this._arcAt(playerCar.position.x, playerCar.position.z, this._playerProgress);
    const rankArc = this._playerProgress;
    let ahead = 0;
    const rivals = [];
    for (const car of this._cars) {
      if (car._aiProgress > rankArc) ahead++;
      rivals.push({ progress: car._aiProgress, x: car.position.x, z: car.position.z });
    }
    this.state.playerRank = ahead + 1;
    this.state.rivals = rivals;
  }
}
