// BoostPads.js — glowing speed-zone chevrons on asphalt straights (FH vibe).

import * as THREE from 'three';

export class BoostPads {
  constructor({ terrain, road }) {
    this.group = new THREE.Group();
    this.group.name = 'BoostPads';
    this._pads = [];
    this._cooldown = new Map();

    const maxD = road.totalLength();
    // Place pads on longer straight-ish stretches.
    for (let d = 400; d < maxD - 400; d += 900) {
      const s0 = road.sampleAtDistance(d);
      const s1 = road.sampleAtDistance(d + 40);
      if (!s0 || !s1) continue;
      let dh = s1.heading - s0.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      if (Math.abs(dh) > 0.08) continue; // skip corners

      const mat = new THREE.MeshStandardMaterial({
        color: 0x1a3a55,
        emissive: 0x18c6ff,
        emissiveIntensity: 1.6,
        metalness: 0.2,
        roughness: 0.4,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 9.5), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = -s0.heading;
      const y = (terrain.getHeight(s0.position.x, s0.position.z) || s0.position.y) + 0.05;
      mesh.position.set(s0.position.x, y, s0.position.z);
      mesh.receiveShadow = false;
      mesh.castShadow = false;
      this.group.add(mesh);
      this._pads.push({ mesh, mat, x: s0.position.x, z: s0.position.z, heading: s0.heading, d });
    }
  }

  update(dt, car) {
    if (!car?.position) return;
    const t = performance.now() * 0.004;
    for (const pad of this._pads) {
      pad.mat.emissiveIntensity = 1.2 + Math.sin(t + pad.d * 0.01) * 0.55;
      const dx = car.position.x - pad.x;
      const dz = car.position.z - pad.z;
      if (dx * dx + dz * dz > 25) continue;
      const key = pad.d;
      const last = this._cooldown.get(key) || 0;
      if (performance.now() - last < 2500) continue;
      // Must be roughly aligned with pad travel direction.
      let diff = car.heading - pad.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      if (Math.abs(diff) > 0.7) continue;
      if (Math.abs(car.speed) < 8) continue;
      if (typeof car.giveNitro === 'function') car.giveNitro(0.45);
      this._cooldown.set(key, performance.now());
    }
  }
}
