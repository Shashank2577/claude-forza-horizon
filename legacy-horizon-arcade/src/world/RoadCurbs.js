// RoadCurbs.js — painted concrete curb strips at the asphalt edge (visual only).
// Curbs are flat and drivable in real racing (and Forza lets you ride them), so
// they are NOT colliders — hard curb colliders at the lane edge dead-stop a
// drifting car and make the road unplayable. Grass/shoulder + the soft corridor
// handle edge-of-road slowdown instead.

import * as THREE from 'three';

const HALF = 6.55;
const CELL = 24;
const STEP = 4.0;

export class RoadCurbs {
  constructor({ terrain, road, colliderGrid = null }) {
    this.group = new THREE.Group();
    this.group.name = 'RoadCurbs';
    this.colliderGrid = colliderGrid;

    const maxD = road.totalLength();
    const geos = [];
    const prev = { L: null, R: null };

    for (let d = 40; d < maxD - 40; d += STEP) {
      const s = road.sampleAtDistance(d);
      if (!s) continue;
      const rx = Math.cos(s.heading), rz = -Math.sin(s.heading);

      for (const side of [-1, 1]) {
        const key = side < 0 ? 'L' : 'R';
        const x = s.position.x + rx * HALF * side;
        const z = s.position.z + rz * HALF * side;
        const y = (terrain.getHeight(x, z) || s.position.y) + 0.06;

        const p = prev[key];
        if (p) {
          const mx = (p.x + x) / 2;
          const mz = (p.z + z) / 2;
          const my = (p.y + y) / 2;
          const dx = x - p.x, dz = z - p.z;
          const len = Math.hypot(dx, dz) || STEP;
          const qr = new THREE.Quaternion();
          qr.setFromUnitVectors(
            new THREE.Vector3(0, 0, 1),
            new THREE.Vector3(dx, 0, dz).normalize(),
          );
          const g = new THREE.BoxGeometry(0.42, 0.14, len).toNonIndexed();
          g.applyQuaternion(qr);
          g.translate(mx, my, mz);
          geos.push(g);
        }
        prev[key] = { x, y, z };
      }
    }

    if (!geos.length) return;

    let count = 0;
    for (const g of geos) count += g.attributes.position.count;
    const pos = new Float32Array(count * 3);
    const nor = new Float32Array(count * 3);
    let po = 0, no = 0;
    for (const g of geos) {
      pos.set(g.attributes.position.array, po);
      po += g.attributes.position.array.length;
      if (g.attributes.normal) {
        nor.set(g.attributes.normal.array, no);
        no += g.attributes.normal.array.length;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));

    const mat = new THREE.MeshStandardMaterial({
      color: 0xd8d2c4,
      roughness: 0.85,
      metalness: 0.05,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  _addCollider(x, z, r) {
    if (!this.colliderGrid) return;
    const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    let arr = this.colliderGrid.get(k);
    if (!arr) { arr = []; this.colliderGrid.set(k, arr); }
    arr.push({ x, z, r });
  }
}
