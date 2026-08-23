// ParkedCars.js — static vehicles on road shoulders for world life (FH festival vibe).

import * as THREE from 'three';
import { Car } from '../core/Car.js';
import { valueNoise2D } from '../core/noise.js';
import { loadCarGltf } from '../core/HeroGltf.js';

const CULL_DIST = 220;
const CELL = 24;

const PAINTS = [
  0x1a3a6e, 0x2d5a27, 0x8a8a92, 0xd4a017, 0x6a1020, 0x1e4a5a, 0x3a3a48,
];

const SCALES = [0.92, 1.0, 1.08, 0.88, 1.12, 0.96, 1.04];

export class ParkedCars {
  constructor({ terrain, road, seed = 1337, envMap = null, colliderGrid = null }) {
    this.group = new THREE.Group();
    this.group.name = 'ParkedCars';
    this._cars = [];
    this.colliderGrid = colliderGrid;

    const maxD = road.totalLength();
    let placed = 0;
    for (let d = 320; d < maxD - 200 && placed < 8; d += 720 + valueNoise2D(d * 0.01, seed * 0.01, seed) * 220) {
      const s = road.sampleAtDistance(d);
      if (!s) continue;
      const side = valueNoise2D(d * 0.02, seed * 0.02 + 7, seed + 7) > 0.5 ? 1 : -1;
      // Kept well clear of the driving lane (off ~10–12 m, proper roadside) so a
      // player swinging wide never wedges against them, and the collider radius
      // matches the car's real ~1 m half-width (was 2.1 — a 4 m invisible barrier
      // that made the road unplayable).
      const lateral = side * (10.5 + valueNoise2D(d, seed * 0.01 + 11, seed + 11) * 2.0);
      const paint = PAINTS[placed % PAINTS.length];
      const scale = SCALES[placed % SCALES.length];

      const car = new Car({
        terrain, envMap, paintColor: paint, lights: false, bodyScale: scale,
      });
      const rx = Math.cos(s.heading), rz = -Math.sin(s.heading);
      const p = s.position.clone();
      p.x += rx * lateral;
      p.z += rz * lateral;
      const yaw = s.heading + side * 0.12;
      car.placeAt(p, yaw);
      this.group.add(car.group);
      this._cars.push(car);
      this._addCollider(p.x, p.z, 1.1 * scale);
      loadCarGltf(car, {
        length: 4.15 * scale,
        paintColor: paint,
        castShadow: false,
        lightweight: true,
      });
      placed++;
    }
  }

  _addCollider(x, z, r) {
    if (!this.colliderGrid) return;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const k = `${cx},${cz}`;
    let arr = this.colliderGrid.get(k);
    if (!arr) { arr = []; this.colliderGrid.set(k, arr); }
    arr.push({ x, z, r });
  }

  update(_dt, playerPos) {
    if (!playerPos) return;
    for (const car of this._cars) {
      const dx = car.position.x - playerPos.x;
      const dz = car.position.z - playerPos.z;
      car.group.visible = dx * dx + dz * dz < CULL_DIST * CULL_DIST;
    }
  }
}
