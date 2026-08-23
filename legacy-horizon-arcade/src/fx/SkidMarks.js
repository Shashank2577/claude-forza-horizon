// SkidMarks.js — persistent dark rubber streaks on asphalt during drifts.

import * as THREE from 'three';
import { clamp } from '../core/noise.js';

const MAX = 160;
const WHEEL_OFFSETS = [
  { x: -0.92, z: -1.31 },
  { x: 0.92, z: -1.31 },
];

export class SkidMarks {
  constructor(scene, terrain) {
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.group.name = 'SkidMarks';
    scene.add(this.group);

    const tex = this._makeMarkTexture();
    this._mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      blending: THREE.MultiplyBlending,
    });

    this._pool = [];
    for (let i = 0; i < MAX; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 1.1), this._mat);
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.group.add(m);
      this._pool.push({ mesh: m, life: 0 });
    }
    this._idx = 0;
    this._acc = 0;
  }

  _makeMarkTexture() {
    const S = 64;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.55, 'rgba(255,255,255,0.5)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _place(x, z, heading, road = null) {
    const slot = this._pool[this._idx];
    this._idx = (this._idx + 1) % MAX;
    const m = slot.mesh;
    let y = (this.terrain?.getHeight(x, z) || 0) + 0.04;
    let hdg = heading;
    if (road) {
      const near = road.sampleNearest(x, z);
      if (near && near.dist2 < 144) {
        y = near.y + 0.035;
        hdg = near.heading;
      }
    }
    m.position.set(x, y, z);
    m.rotation.set(-Math.PI / 2, 0, -hdg);
    m.visible = true;
    slot.life = 1.0;
    m.material.opacity = 0.72;
  }

  update(dt, car, road) {
    if (!car) return;
    const slip = car.slip || 0;
    const speed = Math.abs(car.speed || 0);
    const onRoad = road ? road.distanceToCenterline(car.position.x, car.position.z) < 8.5 : true;

    if (onRoad && slip > 4 && speed > 8) {
      this._acc += (slip * 0.35 + speed * 0.08) * dt;
      while (this._acc >= 1) {
        this._acc -= 1;
        const h = Math.sin(car.heading), c = Math.cos(car.heading);
        const rx = c, rz = -h;
        for (const w of WHEEL_OFFSETS) {
          const wx = car.position.x + h * w.z + rx * w.x;
          const wz = car.position.z + c * w.z + rz * w.x;
          this._place(wx, wz, car.heading, road);
        }
      }
    }

    for (const slot of this._pool) {
      if (slot.life <= 0) continue;
      slot.life -= dt * 0.045;
      if (slot.life <= 0) {
        slot.mesh.visible = false;
      } else {
        slot.mesh.material.opacity = slot.life * 0.65;
      }
    }
  }
}
