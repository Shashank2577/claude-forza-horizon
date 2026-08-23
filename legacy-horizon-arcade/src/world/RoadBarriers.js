// RoadBarriers.js — continuous steel rails on both shoulders for most of the
// route so the race corridor keeps you on asphalt (FH barrier feel).

import * as THREE from 'three';

const HALF_WIDTH = 6.5;
const LATERAL = HALF_WIDTH + 1.25;
const CELL = 24;
const STEP = 2.8;

export class RoadBarriers {
  constructor({ terrain, road, colliderGrid = null }) {
    this.group = new THREE.Group();
    this.group.name = 'RoadBarriers';
    this.colliderGrid = colliderGrid;

    const maxD = road.totalLength();
    // Cover most of the route; rare gaps only (~4%).
    const startD = 70;
    const endD = maxD - 100;

    const postGeoms = [];
    const railGeoms = [];
    const prev = { L: null, R: null };

    for (let d = startD; d <= endD; d += STEP) {
      const gap = ((d / 90) | 0) % 18 === 0;
      if (gap) {
        prev.L = prev.R = null;
        continue;
      }

      const s = road.sampleAtDistance(d);
      if (!s) continue;
      const rx = Math.cos(s.heading), rz = -Math.sin(s.heading);

      for (const side of [-1, 1]) {
        const key = side < 0 ? 'L' : 'R';
        const x = s.position.x + rx * LATERAL * side;
        const z = s.position.z + rz * LATERAL * side;
        const y = terrain.getHeight(x, z) || s.position.y;

        postGeoms.push(boxAt(x, y + 0.65, z, 0.14, 1.3, 0.14));

        const p = prev[key];
        if (p) {
          const mx = (p.x + x) / 2;
          const mz = (p.z + z) / 2;
          const my = (p.y + y) / 2 + 0.72;
          const dx = x - p.x, dz = z - p.z;
          const len = Math.hypot(dx, dz) || STEP;
          const qr = new THREE.Quaternion();
          qr.setFromUnitVectors(
            new THREE.Vector3(0, 0, 1),
            new THREE.Vector3(dx, 0, dz).normalize(),
          );
          // Dual rail beams for a clearer race-barrier silhouette.
          railGeoms.push(boxAt(mx, my, mz, 0.1, 0.22, len, qr));
          railGeoms.push(boxAt(mx, my - 0.38, mz, 0.08, 0.16, len, qr));
        }
        prev[key] = { x, y, z };
        // Guardrails are visual edge dressing only — not colliders. Hard barrier
        // colliders this close to a 13 m road dead-stop any drift and make the
        // road unplayable; grass + the car's soft corridor handle runoff instead.
      }
    }

    const postMat = new THREE.MeshStandardMaterial({
      color: 0x3a3e44, metalness: 0.8, roughness: 0.45,
    });
    const railMat = new THREE.MeshStandardMaterial({
      color: 0xe8ecf0, metalness: 0.92, roughness: 0.22,
      emissive: 0x222428, emissiveIntensity: 0.15,
    });

    if (postGeoms.length) {
      const m = new THREE.Mesh(mergeGeoms(postGeoms), postMat);
      m.castShadow = false; m.receiveShadow = true; m.frustumCulled = false;
      this.group.add(m);
    }
    if (railGeoms.length) {
      const m = new THREE.Mesh(mergeGeoms(railGeoms), railMat);
      m.castShadow = false; m.receiveShadow = true; m.frustumCulled = false;
      this.group.add(m);
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
}

function boxAt(cx, cy, cz, sx, sy, sz, quat = null) {
  const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
  if (quat) g.applyQuaternion(quat);
  g.translate(cx, cy, cz);
  return g;
}

function mergeGeoms(geoms) {
  let pv = 0;
  for (const g of geoms) pv += g.attributes.position.count;
  const pos = new Float32Array(pv * 3);
  const nor = new Float32Array(pv * 3);
  let po = 0, no = 0;
  for (const g of geoms) {
    pos.set(g.attributes.position.array, po);
    po += g.attributes.position.array.length;
    if (g.attributes.normal) {
      nor.set(g.attributes.normal.array, no);
      no += g.attributes.normal.array.length;
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}
