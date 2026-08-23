// Props.ts-style procedural roadside/field dressing.
//
// Fills the open world with the small human-scale detail that reads as
// "countryside" in a chase-cam frame: utility poles with sagging wires,
// wooden field fences, hay bales, shrubs and fallen logs.
// All procedural (zero external assets), instanced, deterministic from seed.
//
// Contract:
//   constructor({ terrain, road, seed = 1337 })
//   this.group   -> THREE.Group (added to scene by caller)
//   (fully static — no per-frame update)
//
// External deps:
//   THREE                  from 'three'
//   clamp                  from './noise.js' (via ../core/)
//   terrain.getHeight(x,z) -> world y (number)
//   road.sampleAtDistance(d) -> { position: Vector3, heading: number }
//   road.centerline()      -> [{x,z,heading}, ...] (decimated ~12m)

import * as THREE from 'three';
import { clamp } from '../core/noise.js';

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — same seed => identical world every run.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Scratch (never allocate per placement in tight loops beyond one-time build)
// ---------------------------------------------------------------------------
const TMP_M = new THREE.Matrix4();
const TMP_P = new THREE.Vector3();
const TMP_Q = new THREE.Quaternion();
const TMP_S = new THREE.Vector3();
const TMP_E = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Procedural canvas textures
// ---------------------------------------------------------------------------
function makeWoodTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#6b5a48';
  g.fillRect(0, 0, 64, 128);
  // Vertical weathered streaks.
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * 64;
    const w = 1 + Math.random() * 2.5;
    const l = 20 + Math.random() * 108;
    const y = Math.random() * 128 - 10;
    const shade = 62 + Math.random() * 60;
    g.fillStyle = `rgba(${shade}, ${shade * 0.86 | 0}, ${shade * 0.68 | 0}, 0.55)`;
    g.fillRect(x, y, w, l);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeStrawSideTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#c9a54e';
  g.fillRect(0, 0, 128, 64);
  // Horizontal straw bands (cylinder axis = vertical UV).
  for (let i = 0; i < 160; i++) {
    const y = Math.random() * 64;
    const l = 12 + Math.random() * 60;
    const x = Math.random() * 128;
    const gold = 150 + Math.random() * 90;
    g.strokeStyle = `rgba(${gold | 0}, ${gold * 0.78 | 0}, ${gold * 0.38 | 0}, 0.5)`;
    g.lineWidth = 0.8 + Math.random() * 1.4;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + l, y + (Math.random() - 0.5) * 3);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeStrawCapTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#b8933f';
  g.fillRect(0, 0, 128, 128);
  // Concentric roll spiral.
  g.strokeStyle = 'rgba(80, 58, 20, 0.55)';
  g.lineWidth = 2.2;
  g.beginPath();
  let r = 3;
  let a = 0;
  const cx = 64, cy = 64;
  g.moveTo(cx + r, cy);
  while (r < 64) {
    a += 0.25;
    r = 3 + a * 1.55;
    g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  g.stroke();
  // Straw flecks.
  for (let i = 0; i < 120; i++) {
    const x = Math.random() * 128, y = Math.random() * 128;
    const gold = 170 + Math.random() * 70;
    g.strokeStyle = `rgba(${gold | 0}, ${gold * 0.78 | 0}, ${gold * 0.4 | 0}, 0.4)`;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (Math.random() - 0.5) * 8, y + (Math.random() - 0.5) * 8);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Placement helpers
// ---------------------------------------------------------------------------

/** Right-of-travel unit vector from heading (matches Road convention). */
function rightOf(heading, out) {
  return out.set(Math.cos(heading), 0, -Math.sin(heading));
}

// Bands (arc-length) that must stay clear of fences/bales: start gantry zone
// and the three farmstead setback bands another module builds on.
const CLEAR_BANDS = [
  [0, 150],
  [1800 - 160, 1800 + 160],
  [4200 - 160, 4200 + 160],
  [6800 - 160, 6800 + 160],
];
function inClearBand(d) {
  for (const [a, b] of CLEAR_BANDS) if (d >= a && d <= b) return true;
  return false;
}

export class Props {
  constructor({ terrain, road, seed = 1337 }) {
    this.terrain = terrain;
    this.road = road;
    this.seed = seed;
    this._rng = mulberry32(seed ^ 0x9e3779b9);

    this.group = new THREE.Group();
    this.group.name = 'Props';

    // Decimated centerline for distance-to-road checks (~12m spacing).
    this._centerline = road.centerline() || [];
    // Total arc length (approx from decimated centerline — plenty for spacing).
    this._roadLength = 0;
    for (let i = 1; i < this._centerline.length; i++) {
      const a = this._centerline[i - 1], b = this._centerline[i];
      this._roadLength += Math.hypot(b.x - a.x, b.z - a.z);
    }

    this._buildUtilityPoles();
    this._buildFields();      // fences + hay bales share the same field sites
    this._buildShrubs();
    this._buildFallenLogs();
  }

  // --- Distance² from point to road centerline (coarse, build-time only). ---
  _dist2ToRoad(x, z) {
    let best = Infinity;
    const pts = this._centerline;
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i].x - x, dz = pts[i].z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) best = d2;
    }
    return best;
  }

  // =========================================================================
  // 1. UTILITY POLES + SAGGING WIRES along one side of the road.
  // =========================================================================
  _buildUtilityPoles() {
    const rng = this._rng;
    const SPACING = 45;
    const OFFSET = 9.0;      // lateral metres from centerline (right side)
    const POLE_H = 7.0;

    // Pole geometry: trunk + crossarm, merged, origin at base.
    const trunk = new THREE.CylinderGeometry(0.11, 0.16, POLE_H, 7);
    trunk.translate(0, POLE_H / 2, 0);
    const arm = new THREE.BoxGeometry(1.9, 0.14, 0.14);
    arm.translate(0, POLE_H - 0.7, 0);
    const braceL = new THREE.BoxGeometry(0.08, 0.9, 0.08);
    braceL.rotateZ(0.6); braceL.translate(-0.55, POLE_H - 1.25, 0);
    const braceR = new THREE.BoxGeometry(0.08, 0.9, 0.08);
    braceR.rotateZ(-0.6); braceR.translate(0.55, POLE_H - 1.25, 0);

    const poleGeo = mergeGeoms([trunk, arm, braceL, braceR]);
    const poleMat = new THREE.MeshStandardMaterial({
      map: makeWoodTexture(), roughness: 0.9, metalness: 0.0,
    });

    // Gather pole placements (skip gantry zone; follow terrain).
    const placements = [];
    for (let d = 160; d < this._roadLength - 30; d += SPACING) {
      const s = this.road.sampleAtDistance(d + (rng() - 0.5) * 6);
      if (!s) continue;
      const right = rightOf(s.heading, new THREE.Vector3());
      const x = s.position.x + right.x * OFFSET;
      const z = s.position.z + right.z * OFFSET;
      const y = this.terrain.getHeight(x, z);
      if (!isFinite(y)) continue;
      placements.push({
        x, y, z,
        yaw: s.heading + (rng() - 0.5) * 0.35,
        lean: (rng() - 0.5) * 0.05,
        leanAxis: rng() * Math.PI * 2,
      });
    }
    if (placements.length < 2) return;

    const poles = new THREE.InstancedMesh(poleGeo, poleMat, placements.length);
    poles.name = 'UtilityPoles';
    const crossTipA = [], crossTipB = [];
    const localTipA = new THREE.Vector3(-0.95, POLE_H - 0.7, 0);
    const localTipB = new THREE.Vector3(0.95, POLE_H - 0.7, 0);

    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      TMP_E.set(0, p.yaw, 0);
      TMP_Q.setFromEuler(TMP_E);
      // Small lean around a horizontal axis.
      const leanQ = new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(Math.cos(p.leanAxis), 0, Math.sin(p.leanAxis)), p.lean);
      TMP_Q.premultiply(leanQ);
      TMP_P.set(p.x, p.y - 0.1, p.z);
      TMP_S.set(1, 1, 1);
      TMP_M.compose(TMP_P, TMP_Q, TMP_S);
      poles.setMatrixAt(i, TMP_M);
      // Crossarm tip world positions for the wire spans.
      crossTipA.push(localTipA.clone().applyQuaternion(TMP_Q).add(TMP_P));
      crossTipB.push(localTipB.clone().applyQuaternion(TMP_Q).add(TMP_P));
    }
    poles.castShadow = false;
    poles.receiveShadow = true;
    poles.frustumCulled = false; // instanced-culling pitfall
    this.group.add(poles);

    // Wires: 2 per span, parabolic sag, one LineSegments draw call.
    const SAG = 0.9;
    const SEGS = 8;
    const positions = new Float32Array((placements.length - 1) * 2 * SEGS * 2 * 3);
    let o = 0;
    for (let i = 0; i < placements.length - 1; i++) {
      for (const tips of [[crossTipA[i], crossTipA[i + 1]], [crossTipB[i], crossTipB[i + 1]]]) {
        const [a, b] = tips;
        let px = a.x, py = a.y, pz = a.z;
        for (let s = 1; s <= SEGS; s++) {
          const t = s / SEGS;
          const sag = SAG * 4 * t * (1 - t); // parabola, max at midspan
          const x = a.x + (b.x - a.x) * t;
          const y = a.y + (b.y - a.y) * t - sag;
          const z = a.z + (b.z - a.z) * t;
          positions[o++] = px; positions[o++] = py; positions[o++] = pz;
          positions[o++] = x; positions[o++] = y; positions[o++] = z;
          px = x; py = y; pz = z;
        }
      }
    }
    const wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const wireMat = new THREE.LineBasicMaterial({ color: 0x1a1c1e });
    const wires = new THREE.LineSegments(wireGeo, wireMat);
    wires.name = 'UtilityWires';
    wires.frustumCulled = false;
    this.group.add(wires);
  }

  // =========================================================================
  // 2. FIELDS — fenced rectangles with hay-bale clusters inside.
  // =========================================================================
  _buildFields() {
    const rng = this._rng;
    const FIELDS = [
      { d: 1500 + rng() * 800, side: 1, back: 22 },
      { d: 2500 + rng() * 600, side: -1, back: 30 },
      { d: 4000 + rng() * 700, side: 1, back: 26 },
      { d: 5300 + rng() * 500, side: -1, back: 20 },
      { d: 6500 + rng() * 700, side: 1, back: 34 },
      { d: 7600 + rng() * 500, side: -1, back: 24 },
    ];

    const postGeo = new THREE.BoxGeometry(0.14, 1.15, 0.14);
    const railGeo = new THREE.BoxGeometry(1, 0.09, 0.05); // unit length, scaled per instance
    const woodMat = new THREE.MeshStandardMaterial({
      map: makeWoodTexture(), roughness: 0.95, metalness: 0.0,
      color: 0xbdb2a4, // weathered gray tint over the wood grain
    });

    const postXforms = [];
    const railXforms = []; // {mid, quat, length, y}
    const baleXforms = []; // {x,y,z,yaw,scale}

    for (const f of FIELDS) {
      if (inClearBand(f.d)) continue;
      const s = this.road.sampleAtDistance(f.d);
      if (!s) continue;
      const right = rightOf(s.heading, new THREE.Vector3());
      const fwd = new THREE.Vector3(Math.sin(s.heading), 0, Math.cos(s.heading));
      const w = 55 + rng() * 30;   // along road
      const h = 40 + rng() * 25;   // away from road
      const cx = s.position.x + right.x * f.side * (f.back + h / 2);
      const cz = s.position.z + right.z * f.side * (f.back + h / 2);

      // Rectangle corners in road-aligned frame.
      const corners = [];
      for (const [sx, sz] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]) {
        corners.push({
          x: cx + fwd.x * sx + right.x * sz,
          z: cz + fwd.z * sx + right.z * sz,
        });
      }

      // Posts + rails around the perimeter.
      const POST_GAP = 3.2;
      for (let e = 0; e < 4; e++) {
        const a = corners[e], b = corners[(e + 1) % 4];
        const edgeLen = Math.hypot(b.x - a.x, b.z - a.z);
        const n = Math.max(2, Math.round(edgeLen / POST_GAP));
        let prevTop = null;
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const x = a.x + (b.x - a.x) * t;
          const z = a.z + (b.z - a.z) * t;
          const y = this.terrain.getHeight(x, z);
          if (!isFinite(y)) { prevTop = null; continue; }
          postXforms.push({ x, y: y + 0.55 - 0.06, z, yaw: rng() * 0.2 });
          const top = { x, y, z };
          if (prevTop) {
            // Two rails between consecutive posts.
            for (const railH of [0.45, 0.85]) {
              const mx = (prevTop.x + x) / 2, mz = (prevTop.z + z) / 2;
              const my = (prevTop.y + y) / 2 + railH;
              const len = Math.hypot(x - prevTop.x, y - prevTop.y, z - prevTop.z);
              const dir = new THREE.Vector3(x - prevTop.x, y - prevTop.y, z - prevTop.z).normalize();
              const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
              railXforms.push({ mx, my, mz, q, len });
            }
          }
          prevTop = top;
        }
      }

      // Hay bales inside.
      const bales = 5 + Math.floor(rng() * 10);
      for (let i = 0; i < bales; i++) {
        const bx = cx + (rng() - 0.5) * (w - 8);
        const bz = cz + (rng() - 0.5) * (h - 8);
        const px = cx + fwd.x * (bx - cx) + right.x * (bz - cz);
        const pz = cz + fwd.z * (bx - cx) + right.z * (bz - cz);
        if (this._dist2ToRoad(px, pz) < 14 * 14) continue;
        const y = this.terrain.getHeight(px, pz);
        if (!isFinite(y)) continue;
        baleXforms.push({ x: px, y: y + 0.7 - 0.06, z: pz, yaw: rng() * Math.PI * 2, scale: 0.85 + rng() * 0.35 });
      }
    }

    // Fence posts (instanced).
    if (postXforms.length) {
      const posts = new THREE.InstancedMesh(postGeo, woodMat, postXforms.length);
      posts.name = 'FencePosts';
      for (let i = 0; i < postXforms.length; i++) {
        const p = postXforms[i];
        TMP_Q.setFromEuler(TMP_E.set(0, p.yaw, 0));
        TMP_M.compose(TMP_P.set(p.x, p.y, p.z), TMP_Q, TMP_S.set(1, 1, 1));
        posts.setMatrixAt(i, TMP_M);
      }
      posts.castShadow = false; posts.receiveShadow = true;
      posts.frustumCulled = false;
      this.group.add(posts);
    }

    // Fence rails (instanced, per-instance length).
    if (railXforms.length) {
      const rails = new THREE.InstancedMesh(railGeo, woodMat, railXforms.length);
      rails.name = 'FenceRails';
      for (let i = 0; i < railXforms.length; i++) {
        const r = railXforms[i];
        TMP_M.compose(TMP_P.set(r.mx, r.my, r.mz), r.q, TMP_S.set(r.len + 0.12, 1, 1));
        rails.setMatrixAt(i, TMP_M);
      }
      rails.castShadow = false; rails.receiveShadow = true;
      rails.frustumCulled = false;
      this.group.add(rails);
    }

    // Hay bales (instanced; side + spiral-cap materials).
    if (baleXforms.length) {
      const baleGeo = new THREE.CylinderGeometry(0.7, 0.7, 1.5, 14);
      baleGeo.rotateZ(Math.PI / 2); // lie on side
      const sideMat = new THREE.MeshStandardMaterial({ map: makeStrawSideTexture(), roughness: 0.95 });
      const capMat = new THREE.MeshStandardMaterial({ map: makeStrawCapTexture(), roughness: 0.95 });
      const bales = new THREE.InstancedMesh(baleGeo, [sideMat, capMat, capMat], baleXforms.length);
      bales.name = 'HayBales';
      for (let i = 0; i < baleXforms.length; i++) {
        const b = baleXforms[i];
        TMP_Q.setFromEuler(TMP_E.set(0, b.yaw, 0));
        TMP_M.compose(TMP_P.set(b.x, b.y, b.z), TMP_Q, TMP_S.set(b.scale, b.scale, b.scale));
        bales.setMatrixAt(i, TMP_M);
      }
      bales.castShadow = false; bales.receiveShadow = true;
      bales.frustumCulled = false;
      this.group.add(bales);
    }
  }

  // =========================================================================
  // 3. SHRUBS — low blobby bushes near fences/rocks/road edges.
  // =========================================================================
  _buildShrubs() {
    const rng = this._rng;
    const geo = new THREE.IcosahedronGeometry(1, 1);
    {
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const k = 0.75 + rng() * 0.5;
        pos.setXYZ(i, x * k, Math.max(y * 0.55 * k, -0.1), z * k);
      }
      geo.computeVertexNormals();
    }
    const mat = new THREE.MeshStandardMaterial({
      color: 0x4a5a2e, roughness: 0.95, metalness: 0.0, flatShading: true,
    });

    const COUNT = 150;
    const shrubs = new THREE.InstancedMesh(geo, mat, COUNT);
    shrubs.name = 'Shrubs';
    const color = new THREE.Color();
    let placed = 0;
    let guard = 0;
    while (placed < COUNT && guard++ < COUNT * 40) {
      const x = (rng() * 2 - 1) * 1500;
      const z = (rng() * 2 - 1) * 1500;
      const d2 = this._dist2ToRoad(x, z);
      if (d2 < 8 * 8 || d2 > 90 * 90) continue; // roadside band only
      const y = this.terrain.getHeight(x, z);
      if (!isFinite(y)) continue;
      const s = 0.4 + rng() * 0.6;
      TMP_Q.setFromEuler(TMP_E.set(0, rng() * Math.PI * 2, 0));
      TMP_M.compose(TMP_P.set(x, y + s * 0.25, z), TMP_Q, TMP_S.set(s, s, s));
      shrubs.setMatrixAt(placed, TMP_M);
      color.setHSL(0.22 + rng() * 0.06, 0.35 + rng() * 0.2, 0.22 + rng() * 0.1);
      shrubs.setColorAt(placed, color);
      placed++;
    }
    shrubs.count = placed;
    shrubs.castShadow = false; shrubs.receiveShadow = true;
    shrubs.frustumCulled = false;
    this.group.add(shrubs);
  }

  // =========================================================================
  // 4. FALLEN LOGS — a few weathered trunks off in the fields.
  // =========================================================================
  _buildFallenLogs() {
    const rng = this._rng;
    const geo = new THREE.CylinderGeometry(0.22, 0.28, 5, 8);
    geo.rotateZ(Math.PI / 2); // lie on side
    const mat = new THREE.MeshStandardMaterial({
      map: makeWoodTexture(), roughness: 1.0, metalness: 0.0, color: 0x9a8d7c,
    });
    const COUNT = 14;
    const logs = new THREE.InstancedMesh(geo, mat, COUNT);
    logs.name = 'FallenLogs';
    let placed = 0, guard = 0;
    while (placed < COUNT && guard++ < COUNT * 60) {
      const x = (rng() * 2 - 1) * 1400;
      const z = (rng() * 2 - 1) * 1400;
      const d2 = this._dist2ToRoad(x, z);
      if (d2 < 25 * 25 || d2 > 200 * 200) continue;
      const y = this.terrain.getHeight(x, z);
      if (!isFinite(y)) continue;
      TMP_Q.setFromEuler(TMP_E.set((rng() - 0.5) * 0.08, rng() * Math.PI * 2, (rng() - 0.5) * 0.08));
      const s = 0.7 + rng() * 0.7;
      TMP_M.compose(TMP_P.set(x, y + 0.2 * s, z), TMP_Q, TMP_S.set(s, s, s));
      logs.setMatrixAt(placed, TMP_M);
      placed++;
    }
    logs.count = placed;
    logs.castShadow = false; logs.receiveShadow = true;
    logs.frustumCulled = false;
    this.group.add(logs);
  }
}

// ---------------------------------------------------------------------------
// Minimal geometry merge (positions/normals/uvs, non-indexed) — avoids pulling
// in BufferGeometryUtils for four small parts.
// ---------------------------------------------------------------------------
function mergeGeoms(geoms) {
  const nonIndexed = geoms.map((g) => g.index ? g.toNonIndexed() : g);
  let vertCount = 0;
  for (const g of nonIndexed) vertCount += g.attributes.position.count;
  const pos = new Float32Array(vertCount * 3);
  const nor = new Float32Array(vertCount * 3);
  const uv = new Float32Array(vertCount * 2);
  let pO = 0, uO = 0;
  for (const g of nonIndexed) {
    pos.set(g.attributes.position.array, pO);
    nor.set(g.attributes.normal.array, pO);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, uO);
    pO += g.attributes.position.count * 3;
    uO += g.attributes.position.count * 2;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}
