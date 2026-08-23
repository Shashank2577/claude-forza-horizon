// RoadFurniture.js — road-side dressing: start gantry, reflector delineators,
// guardrails on the outside of curves, and chevron warning signs at sharp apexes.
// Self-contained (no external assets): all textures are procedural canvas2D.
// Static after construction; safe to add its group to the scene once.
//
// API:  new RoadFurniture({ terrain, road, seed }).group  → THREE.Group
//   terrain.getHeight(x,z) → world y
//   road.centerline()      → [{x,z,heading}]  (decimated, monotonic in arc len)
//   road.sampleAtDistance(d) → { position: Vector3 (y includes road vert offset),
//                                heading }
// Conventions (match ChaseCamera/Road): forward=(sin h,0,cos h), right=(cos h,0,-sin h).
// A right turn (heading increasing) bulges to the right → outside is the LEFT.

import * as THREE from 'three';
import { TAU } from '../core/noise.js';

const HALF_WIDTH = 6.5;        // matches Road.HALF_WIDTH
const SHOULDER = 1.2;          // how far past the asphalt edge furniture sits

// ── seeded RNG ──────────────────────────────────────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── geometry helpers ─────────────────────────────────────────────────────────
function boxAt(cx, cy, cz, sx, sy, sz, quat) {
  const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
  if (quat) g.applyQuaternion(quat);
  g.translate(cx, cy, cz);
  return g;
}

function mergeGeoms(geoms) {
  let pv = 0, nv = 0, uv = 0;
  for (const g of geoms) {
    pv += g.attributes.position.count;
    nv += g.attributes.normal.count;
    uv += g.attributes.uv.count;
  }
  const pos = new Float32Array(pv * 3);
  const nor = new Float32Array(nv * 3);
  const uvs = new Float32Array(uv * 2);
  let po = 0, no = 0, uo = 0;
  for (const g of geoms) {
    pos.set(g.attributes.position.array, po); po += g.attributes.position.array.length;
    if (g.attributes.normal) { nor.set(g.attributes.normal.array, no); no += g.attributes.normal.array.length; }
    if (g.attributes.uv) { uvs.set(g.attributes.uv.array, uo); uo += g.attributes.uv.array.length; }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return out;
}

// Quaternion that maps +Y to a given direction (for orienting flat rails/posts
// along a segment). Falls back to identity for near-vertical directions.
const _y = new THREE.Vector3(0, 1, 0);
function alignY(dir) {
  const q = new THREE.Quaternion();
  if (dir.lengthSq() > 1e-8) q.setFromUnitVectors(_y, dir.clone().normalize());
  return q;
}

// ── procedural textures ─────────────────────────────────────────────────────
function makeBannerTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const x = c.getContext('2d');
  // festival gradient: magenta→purple→cyan, evokes Horizon branding
  const g = x.createLinearGradient(0, 0, c.width, 0);
  g.addColorStop(0, '#ff2d8a'); g.addColorStop(0.5, '#9b1fff'); g.addColorStop(1, '#18c6ff');
  x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
  // diagonal sparkle streaks
  x.globalAlpha = 0.12; x.fillStyle = '#ffffff';
  for (let i = -20; i < 40; i++) { x.beginPath(); x.moveTo(i * 60, 0); x.lineTo(i * 60 + 120, 256); x.lineTo(i * 60 + 70, 256); x.lineTo(i * 60 - 50, 0); x.fill(); }
  x.globalAlpha = 1;
  x.fillStyle = '#ffffff';
  x.font = 'bold 116px Arial, sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.shadowColor = 'rgba(0,0,0,0.45)'; x.shadowBlur = 18; x.shadowOffsetY = 4;
  x.fillText('HORIZON FESTIVAL', c.width / 2, c.height / 2 + 6);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function makeChevronTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#0a2d6b'; x.fillRect(0, 0, 256, 256); // warning blue (alt red below)
  x.fillStyle = '#ffffff';
  for (let i = 0; i < 3; i++) {
    const cx = 40 + i * 80;
    x.beginPath();
    x.moveTo(cx, 70); x.lineTo(cx + 50, 128); x.lineTo(cx, 186); x.lineTo(cx + 22, 128); x.closePath();
    x.fill();
  }
  // border
  x.strokeStyle = '#ffffff'; x.lineWidth = 10; x.strokeRect(8, 8, 240, 240);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

function makeRedChevronTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#c20f1c'; x.fillRect(0, 0, 256, 256);
  x.fillStyle = '#ffffff';
  for (let i = 0; i < 3; i++) {
    const cx = 40 + i * 80;
    x.beginPath();
    x.moveTo(cx, 70); x.lineTo(cx + 50, 128); x.lineTo(cx, 186); x.lineTo(cx + 22, 128); x.closePath();
    x.fill();
  }
  x.strokeStyle = '#ffffff'; x.lineWidth = 10; x.strokeRect(8, 8, 240, 240);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

// ────────────────────────────────────────────────────────────────────────────
export class RoadFurniture {
  constructor({ terrain, road, seed = 1337 }) {
    this.group = new THREE.Group();
    this.group.name = 'RoadFurniture';
    this.terrain = terrain;
    this.road = road;
    this.seed = seed;
    this._center = road.centerline(); // [{x,z,heading}]
    this._total = this._arcLength();
    this._rng = mulberry32((seed ^ 0x7F3A91) >>> 0);

    this._bannerTex = makeBannerTexture();
    this._blueChev = makeChevronTexture();
    this._redChev = makeRedChevronTexture();

    this._buildGantry();
    this._buildDelineators();
    this._buildGuardrails();
    this._buildChevrons();
  }

  _arcLength() {
    const c = this._center;
    let L = 0;
    for (let i = 1; i < c.length; i++) {
      L += Math.hypot(c[i].x - c[i - 1].x, c[i].z - c[i - 1].z);
    }
    return L;
  }

  // right-of-travel unit vector at heading h: (cos h, 0, -sin h)
  _right(h) { return new THREE.Vector3(Math.cos(h), 0, -Math.sin(h)); }

  // ── Start gantry: two steel posts + crossbeam + festival banner ──────────
  _buildGantry() {
    const s = this.road.sampleAtDistance(8);
    const h = s.heading;
    const right = this._right(h);
    const postH = 7.0;
    const halfSpan = 9.5;
    const steelMat = new THREE.MeshStandardMaterial({ color: 0x2a2e33, metalness: 0.85, roughness: 0.4 });

    const geoms = [];
    for (const side of [-1, 1]) {
      const px = s.position.x + right.x * halfSpan * side;
      const pz = s.position.z + right.z * halfSpan * side;
      const py = this.terrain.getHeight(px, pz);
      // post
      geoms.push(boxAt(px, py + postH / 2, pz, 0.45, postH, 0.45, null));
      // foot base
      geoms.push(boxAt(px, py + 0.15, pz, 0.9, 0.3, 0.9, null));
    }
    // crossbeam at top
    const bx = s.position.x, bz = s.position.z, by = this.terrain.getHeight(bx, bz) + postH - 0.4;
    const beamLen = halfSpan * 2 + 0.5;
    // orient beam along the right vector (across the road)
    const beamDir = right.clone();
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), beamDir); // box local +Z → beam dir
    geoms.push(boxAt(bx, by, bz, 0.5, 0.7, beamLen, q));

    const gantry = new THREE.Mesh(mergeGeoms(geoms), steelMat);
    gantry.castShadow = false; gantry.receiveShadow = true; gantry.frustumCulled = false;
    this.group.add(gantry);

    // banner stretched between the posts, just under the beam
    const bannerMat = new THREE.MeshStandardMaterial({
      map: this._bannerTex, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.0,
      emissive: 0x331044, emissiveMap: this._bannerTex, emissiveIntensity: 0.35,
    });
    const bannerGeo = new THREE.PlaneGeometry(halfSpan * 2 + 0.2, 2.2);
    const banner = new THREE.Mesh(bannerGeo, bannerMat);
    banner.position.set(bx, by - 1.5, bz);
    banner.quaternion.copy(q);
    banner.rotateX(Math.PI / 2); // plane is XY-facing; tip up then align
    // re-apply across-road orientation cleanly: build from right + up
    const across = right.clone();
    const up = new THREE.Vector3(0, 1, 0);
    const m = new THREE.Matrix4().makeBasis(across, up, new THREE.Vector3().crossVectors(up, across));
    banner.quaternion.setFromRotationMatrix(m);
    banner.castShadow = false; banner.receiveShadow = false;
    this.group.add(banner);
  }

  // ── Reflector delineators both sides every ~35m ──────────────────────────
  _buildDelineators() {
    const spacing = 35;
    const N = Math.floor(this._total / spacing) - 1;
    const count = Math.max(0, N) * 2;
    if (count <= 0) return;

    const postGeo = new THREE.BoxGeometry(0.07, 1.0, 0.07).toNonIndexed();
    postGeo.translate(0, 0.5, 0); // base at origin
    const posts = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({
      color: 0xe8e8ea, roughness: 0.7, metalness: 0.0,
    }), count);
    posts.castShadow = false; posts.receiveShadow = true; posts.frustumCulled = false;

    const refGeo = new THREE.BoxGeometry(0.13, 0.22, 0.04).toNonIndexed();
    refGeo.translate(0, 0.95, 0); // near top of post
    const reflectors = new THREE.InstancedMesh(refGeo, new THREE.MeshStandardMaterial({
      vertexColors: false, roughness: 0.3, metalness: 0.1,
      emissive: 0xffffff, emissiveIntensity: 0.0,
    }), count);
    reflectors.castShadow = false; reflectors.receiveShadow = true; reflectors.frustumCulled = false;
    // per-instance reflector color: red on the right, white on the left
    reflectors.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const redLin = new THREE.Color(0xff3030);
    const whtLin = new THREE.Color(0xfff0e0);
    let idx = 0;
    for (let i = 1; i <= N; i++) {
      const d = i * spacing;
      const s = this.road.sampleAtDistance(d);
      const right = this._right(s.heading);
      for (const side of [1, -1]) {
        const px = s.position.x + right.x * (HALF_WIDTH + SHOULDER) * side;
        const pz = s.position.z + right.z * (HALF_WIDTH + SHOULDER) * side;
        const py = this.terrain.getHeight(px, pz);
        m4.makeTranslation(px, py, pz);
        posts.setMatrixAt(idx, m4);
        reflectors.setMatrixAt(idx, m4);
        reflectors.setColorAt(idx, side === 1 ? redLin : whtLin);
        idx++;
      }
    }
    posts.count = idx; reflectors.count = idx;
    posts.instanceMatrix.needsUpdate = true;
    reflectors.instanceMatrix.needsUpdate = true;
    if (reflectors.instanceColor) reflectors.instanceColor.needsUpdate = true;
    this.group.add(posts, reflectors);
  }

  // ── Guardrails on the outside of curves ──────────────────────────────────
  _buildGuardrails() {
    // Curvature per centerline sample from heading delta.
    const c = this._center;
    if (c.length < 3) return;
    const curv = new Array(c.length).fill(0);
    for (let i = 1; i < c.length - 1; i++) {
      let dh = c[i + 1].heading - c[i - 1].heading;
      while (dh > Math.PI) dh -= TAU;
      while (dh < -Math.PI) dh += TAU;
      const seg = Math.hypot(c[i + 1].x - c[i - 1].x, c[i + 1].z - c[i - 1].z) || 1;
      curv[i] = dh / seg; // rad/m
    }
    // Arc length of each centerline sample (cumulative) for sampleAtDistance mapping.
    const arc = new Array(c.length).fill(0);
    for (let i = 1; i < c.length; i++) arc[i] = arc[i - 1] + Math.hypot(c[i].x - c[i - 1].x, c[i].z - c[i - 1].z);

    const THRESH = 0.0065; // rad/m — only bendy sections get rails
    const PAD = 24;        // metres of lead-in/lead-out padding
    const postGeoms = [];
    const railGeoms = [];

    let i = 1;
    while (i < c.length - 1) {
      if (Math.abs(curv[i]) < THRESH) { i++; continue; }
      // start of a bend run; collect contiguous bendy samples (same sign)
      const sign = Math.sign(curv[i]);
      let j = i;
      while (j < c.length - 1 && Math.sign(curv[j]) === sign && Math.abs(curv[j]) > THRESH * 0.4) j++;
      // run spans arc [arc[i]-PAD .. arc[j]+PAD], clamped
      let d0 = Math.max(0, arc[i] - PAD);
      let d1 = Math.min(this._total, arc[j] + PAD);
      // outside side multiplier: right turn (sign>0) → outside = LEFT (-1)
      const side = -sign;

      // walk the run at fine spacing
      const step = 2.6;
      let prev = null;
      for (let d = d0; d <= d1; d += step) {
        const s = this.road.sampleAtDistance(d);
        const right = this._right(s.heading);
        const ox = s.position.x + right.x * (HALF_WIDTH + SHOULDER + 0.2) * side;
        const oz = s.position.z + right.z * (HALF_WIDTH + SHOULDER + 0.2) * side;
        const oy = this.terrain.getHeight(ox, oz);
        // post
        postGeoms.push(boxAt(ox, oy + 0.55, oz, 0.12, 1.1, 0.12, null));
        // rail segment between prev and here (placed at ~0.62m, slightly above terrain)
        if (prev) {
          const mx = (prev.x + ox) / 2, mz = (prev.z + oz) / 2;
          const my = (prev.y + oy) / 2 + 0.62;
          const dir = new THREE.Vector3(ox - prev.x, 0, oz - prev.z);
          const len = dir.length();
          const qr = new THREE.Quaternion();
          qr.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
          railGeoms.push(boxAt(mx, my, mz, 0.07, 0.18, len, qr));
        }
        prev = { x: ox, y: oy, z: oz };
      }
      i = j + 1;
    }

    if (postGeoms.length) {
      const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.8, roughness: 0.45 });
      // posts darker (galvanized) — give them their own tone via a second mesh
      const postMat = new THREE.MeshStandardMaterial({ color: 0x6b7075, metalness: 0.7, roughness: 0.55 });
      const postMesh = new THREE.Mesh(mergeGeoms(postGeoms), postMat);
      postMesh.castShadow = false; postMesh.receiveShadow = true; postMesh.frustumCulled = false;
      this.group.add(postMesh);
    }
    if (railGeoms.length) {
      const railMat = new THREE.MeshStandardMaterial({ color: 0xc4c9ce, metalness: 0.9, roughness: 0.3 });
      const railMesh = new THREE.Mesh(mergeGeoms(railGeoms), railMat);
      railMesh.castShadow = false; railMesh.receiveShadow = true; railMesh.frustumCulled = false;
      this.group.add(railMesh);
    }
  }

  // ── Chevron warning signs at sharp apexes ────────────────────────────────
  _buildChevrons() {
    const c = this._center;
    if (c.length < 5) return;
    const arc = new Array(c.length).fill(0);
    for (let i = 1; i < c.length; i++) arc[i] = arc[i - 1] + Math.hypot(c[i].x - c[i - 1].x, c[i].z - c[i - 1].z);

    const placed = []; // track placed arc positions to avoid clustering
    const CHEV_TH = 0.011;
    const postMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.7, roughness: 0.5 });
    const texs = [this._redChev, this._blueChev];

    for (let i = 2; i < c.length - 2; i++) {
      let dh = c[i + 2].heading - c[i - 2].heading;
      while (dh > Math.PI) dh -= TAU;
      while (dh < -Math.PI) dh += TAU;
      const seg = Math.hypot(c[i + 2].x - c[i - 2].x, c[i + 2].z - c[i - 2].z) || 1;
      const k = Math.abs(dh / seg);
      if (k < CHEV_TH) continue;
      // cluster suppression: need ≥220m from last chevron
      if (placed.some(p => Math.abs(p - arc[i]) < 220)) continue;
      placed.push(arc[i]);

      const sign = Math.sign(dh);
      const side = -sign; // outside
      const s = this.road.sampleAtDistance(arc[i]);
      const right = this._right(s.heading);
      const px = s.position.x + right.x * (HALF_WIDTH + SHOULDER + 0.6) * side;
      const pz = s.position.z + right.z * (HALF_WIDTH + SHOULDER + 0.6) * side;
      const py = this.terrain.getHeight(px, pz);

      // post (2.2m)
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.2, 0.1), postMat);
      post.position.set(px, py + 1.1, pz);
      post.castShadow = false; post.receiveShadow = true;
      this.group.add(post);

      // sign board, facing back along travel (toward oncoming driver)
      const tex = texs[placed.length % texs.length];
      const boardMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.0, side: THREE.DoubleSide });
      const board = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), boardMat);
      board.position.set(px, py + 2.0, pz);
      // face the driver: plane normal should point opposite the travel forward
      const fwd = new THREE.Vector3(Math.sin(s.heading), 0, Math.cos(s.heading));
      const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), fwd.negate(), new THREE.Vector3(0, 1, 0));
      board.quaternion.setFromRotationMatrix(m);
      board.castShadow = false; board.receiveShadow = false;
      this.group.add(board);
    }
  }
}
