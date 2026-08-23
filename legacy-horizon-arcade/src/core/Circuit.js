// Circuit.js — a closed racing loop beside the festival, for Circuit / lap races.
//
// Builds a smooth CLOSED centerline (a noise-perturbed, kidney-ish loop) draped
// over terrain, then extrudes an asphalt ribbon via the shared RoadBuilder
// (closed mode — the ribbon wraps the seam with no gap). Mirrors the Road API so
// ProgressTracker, Rivals, gates, and the car's road physics all work on it
// unchanged. `sampleAtDistance` wraps modulo lap length.
//
// Coordinate convention (shared): heading yaw where 0 = +Z; tangent (sin h, cos h).
// Samples: { x, z, y, heading, dist, curvature }, uniform arc-length spaced.

import * as THREE from 'three';
import { fbm2D, clamp, lerpN } from './noise.js';
import {
  buildRibbonGeometry, makeAsphaltTexture, injectAsphaltShader,
} from './RoadBuilder.js';

const HALF_WIDTH = 6.5;
const VERT_OFFSET = 0.08;
const TARGET_SPACING = 4.0;
const HEIGHT_SMOOTH_KERNEL = 7;

export class Circuit {
  /**
   * @param {Object} opts
   * @param {{getHeight:()=>number}} opts.terrain
   * @param {object} opts.road the world Road — used only to place the loop beside
   *   the festival (off the world road, near the start).
   * @param {THREE.Vector3} [opts.sunDir] toward the sun (for the asphalt shader).
   * @param {number} [opts.seed]
   * @param {number} [opts.radius] base loop radius (m)
   */
  constructor({ terrain, road, sunDir, seed = 1337, radius = 330 }) {
    this.terrain = terrain;
    this.road = road;
    this.seed = seed;
    this.radius = radius;
    this.sunDir = sunDir
      ? sunDir.clone().normalize()
      : new THREE.Vector3(Math.sin(2.53), Math.sin(0.26), Math.cos(2.53)).normalize();

    this.group = new THREE.Group();
    this.group.name = 'Circuit';

    this._samples = [];
    this._placeCenter();
    this._buildCenterline();
    this._buildMesh();
    this._buildStartLine();

    this._startSample = this._samples[0];
  }

  // Centre the loop off the right side of the world-road start, clear of the
  // festival and the outbound world road.
  _placeCenter() {
    const start = this.road.startSample();
    const h = start.heading;
    const rx = Math.cos(h), rz = -Math.sin(h); // right of travel
    const fx = Math.sin(h), fz = Math.cos(h);   // forward
    const offRight = this.radius + 230;
    const offFwd = 60;
    this._center = {
      x: start.position.x + rx * offRight + fx * offFwd,
      z: start.position.z + rz * offRight + fz * offFwd,
    };
    this._orient = (valueNoise01(this.seed + 31)) * Math.PI * 2;
  }

  _buildCenterline() {
    const seed = this.seed;
    const C = this._center;
    const orient = this._orient;
    const baseR = this.radius;
    const N = 360;
    const raw = [];

    for (let i = 0; i < N; i++) {
      const ang = (i / N) * Math.PI * 2;
      // Kidney / oval modulation + seeded organic variation → a couple of
      // overtaking zones and a couple of technical bends (not a perfect circle).
      const r = baseR
        + Math.sin(ang + 0.3) * baseR * 0.20
        + Math.cos(ang * 2 + 1.1) * baseR * 0.07
        + (fbm2D(Math.cos(ang) * 1.3 + 5.2, Math.sin(ang) * 1.3 + 5.2, { octaves: 3, frequency: 1.0, seed }) - 0.5) * baseR * 0.10;
      const a = ang + orient;
      raw.push({
        x: C.x + Math.cos(a) * r,
        z: C.z + Math.sin(a) * r,
      });
    }

    // Headings from the planar tangent (closed loop).
    for (let i = 0; i < N; i++) {
      const prev = raw[(i - 1 + N) % N];
      const next = raw[(i + 1) % N];
      raw[i].heading = Math.atan2(next.x - prev.x, next.z - prev.z);
    }

    this._samples = this._resampleClosed(raw, TARGET_SPACING);
    this._drape();
    this._computeCurvature();

    // Defensive NaN guard.
    for (const s of this._samples) {
      if (!Number.isFinite(s.x)) s.x = C.x;
      if (!Number.isFinite(s.z)) s.z = C.z;
      if (!Number.isFinite(s.y)) s.y = this.terrain.getHeight(s.x, s.z);
      if (!Number.isFinite(s.heading)) s.heading = 0;
    }

    // Perimeter (lap length) = last sample's dist + the closing segment back to
    // sample 0.
    const s = this._samples, n = s.length;
    const closing = Math.hypot(s[0].x - s[n - 1].x, s[0].z - s[n - 1].z);
    this._totalLength = s[n - 1].dist + closing;
  }

  // Uniform arc-length resample of a closed loop. `dist` stored in [0, total).
  _resampleClosed(raw, spacing) {
    const N = raw.length;
    const seg = new Array(N);
    let total = 0;
    for (let i = 0; i < N; i++) {
      const a = raw[i], b = raw[(i + 1) % N];
      const l = Math.hypot(b.x - a.x, b.z - a.z);
      seg[i] = l; total += l;
    }
    const cum = new Array(N + 1);
    cum[0] = 0;
    for (let i = 0; i < N; i++) cum[i + 1] = cum[i] + seg[i];

    const count = Math.max(24, Math.floor(total / spacing));
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      const d = (i / count) * total;
      let lo = 0, hi = N;
      while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] < d) lo = mid; else hi = mid; }
      const a = raw[lo], b = raw[(lo + 1) % N];
      const segLen = seg[lo] || 1;
      const t = clamp((d - cum[lo]) / segLen, 0, 1);
      let dh = b.heading - a.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      out[i] = {
        x: lerpN(a.x, b.x, t), z: lerpN(a.z, b.z, t), y: 0,
        heading: a.heading + dh * t, dist: d, curvature: 0,
      };
    }
    return out;
  }

  // Drape onto terrain + triangle-weighted low-pass (closed: wrap the window).
  _drape() {
    const s = this._samples, n = s.length;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) raw[i] = this.terrain.getHeight(s[i].x, s[i].z);
    const K = HEIGHT_SMOOTH_KERNEL;
    for (let i = 0; i < n; i++) {
      let sum = 0, count = 0;
      for (let off = -K; off <= K; off++) {
        const idx = ((i + off) % n + n) % n;
        const w = 1 - Math.abs(off) / (K + 1);
        sum += raw[idx] * w; count += w;
      }
      s[i].y = count > 0 ? sum / count : raw[i];
    }
  }

  // Finite-difference curvature over uniform spacing (wrap-safe; uses the known
  // uniform step, not dist, so the seam doesn't blow up).
  _computeCurvature() {
    const s = this._samples, n = s.length;
    const raw = new Float32Array(n);
    const step = 2 * TARGET_SPACING;
    for (let i = 0; i < n; i++) {
      const prev = s[(i - 1 + n) % n], next = s[(i + 1) % n];
      let dh = next.heading - prev.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      raw[i] = dh / step;
    }
    for (let i = 0; i < n; i++) {
      const a = raw[(i - 1 + n) % n], b = raw[i], c = raw[(i + 1) % n];
      s[i].curvature = (a + b + c) / 3;
    }
  }

  _buildMesh() {
    const geo = buildRibbonGeometry(this._samples, {
      halfWidth: HALF_WIDTH, vertOffset: VERT_OFFSET, tileMeters: 24.0, closed: true,
    });
    const tex = makeAsphaltTexture(this.seed);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    const mat = new THREE.MeshPhysicalMaterial({
      map: tex, roughness: 0.62, metalness: 0.0, clearcoat: 0.12, clearcoatRoughness: 0.85,
      emissive: new THREE.Color('#000000'), emissiveIntensity: 1.0,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    injectAsphaltShader(mat, this.sunDir);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'CircuitAsphalt';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  // Start/finish gantry + painted line at sample 0.
  _buildStartLine() {
    const s = this._samples[0];
    const baseY = this.terrain.getHeight(s.x, s.z);
    const g = new THREE.Group();
    g.position.set(s.x, baseY, s.z);
    g.rotation.y = s.heading;

    const steel = new THREE.MeshStandardMaterial({ color: 0x2a2e36, metalness: 0.8, roughness: 0.5 });
    for (const sx of [-HALF_WIDTH - 1.0, HALF_WIDTH + 1.0]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7.5, 0.5), steel);
      leg.position.set(sx, 3.75, 0); g.add(leg);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(HALF_WIDTH * 2 + 2.6, 0.6, 0.6), steel);
    beam.position.set(0, 7.5, 0); g.add(beam);

    // "START / FINISH" banner.
    const tex = this._startBannerTexture();
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(HALF_WIDTH * 2 + 0.6, 2.0),
      new THREE.MeshStandardMaterial({ map: tex, transparent: true, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1.0, roughness: 0.5, side: THREE.DoubleSide }));
    banner.position.set(0, 7.9, 0); banner.rotation.y = Math.PI;
    g.add(banner);

    // Checkered start line painted across the asphalt.
    const checkTex = this._checkerTexture();
    const line = new THREE.Mesh(new THREE.PlaneGeometry(HALF_WIDTH * 2, 3.0),
      new THREE.MeshBasicMaterial({ map: checkTex, transparent: true, opacity: 0.95, depthWrite: false }));
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.06, 0);
    g.add(line);

    this.group.add(g);
    this.group.traverse(o => { if (o.isMesh && o.name !== 'CircuitAsphalt') { o.castShadow = false; o.receiveShadow = false; } });
  }

  _startBannerTexture() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, c.width, 0);
    g.addColorStop(0, '#19e07a'); g.addColorStop(1, '#ff7a18');
    x.fillStyle = g;
    const r = 16;
    x.beginPath();
    x.moveTo(r, 0); x.arcTo(c.width, 0, c.width, c.height, r);
    x.arcTo(c.width, c.height, 0, c.height, r);
    x.arcTo(0, c.height, 0, 0, r); x.arcTo(0, 0, c.width, 0, r);
    x.closePath(); x.fill();
    x.fillStyle = '#ffffff';
    x.font = '900 56px Arial, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.shadowColor = 'rgba(0,0,0,0.5)'; x.shadowBlur = 10;
    x.fillText('START / FINISH', c.width / 2, c.height / 2 + 2);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  }

  _checkerTexture() {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const x = c.getContext('2d');
    const cells = 8, sz = c.width / cells;
    for (let i = 0; i < cells; i++)
      for (let j = 0; j < cells; j++) {
        x.fillStyle = (i + j) % 2 === 0 ? '#f5f5f5' : '#111317';
        x.fillRect(i * sz, j * sz, sz, sz);
      }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  }

  // ── Public API (mirrors Road) ──────────────────────────────────────────────

  startSample() {
    const s = this._startSample;
    return { position: new THREE.Vector3(s.x, s.y + VERT_OFFSET, s.z), heading: s.heading };
  }

  centerline() {
    const out = [];
    const step = 3;
    for (let i = 0; i < this._samples.length; i += step) {
      const s = this._samples[i];
      out.push({ x: s.x, z: s.z, heading: s.heading });
    }
    return out;
  }

  /** Lap length (m). */
  totalLength() { return this._totalLength; }

  distanceToCenterline(x, z) {
    let minD2 = Infinity;
    const step = 4;
    for (let i = 0; i < this._samples.length; i += step) {
      const s = this._samples[i];
      const dx = x - s.x, dz = z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < minD2) minD2 = d2;
    }
    return Math.sqrt(minD2);
  }

  sampleNearest(x, z) {
    let minD2 = Infinity, best = null;
    const step = 2;
    for (let i = 0; i < this._samples.length; i += step) {
      const s = this._samples[i];
      const dx = x - s.x, dz = z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < minD2) { minD2 = d2; best = s; }
    }
    if (!best) return null;
    return { y: best.y + VERT_OFFSET, heading: best.heading, dist2: minD2 };
  }

  /** Sample { position, heading } at arc d, WRAPPED modulo lap length. */
  sampleAtDistance(d) {
    const s = this._samples, n = s.length;
    if (n === 0) return null;
    const total = this._totalLength;
    let dd = ((d % total) + total) % total;
    const lastDist = s[n - 1].dist;

    // Bridge the seam (last sample → sample 0) explicitly.
    if (dd > lastDist) {
      const a = s[n - 1], b = s[0];
      const span = total - a.dist || 1;
      const t = clamp((dd - a.dist) / span, 0, 1);
      let dh = b.heading - a.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      return {
        position: new THREE.Vector3(lerpN(a.x, b.x, t), lerpN(a.y, b.y, t) + VERT_OFFSET, lerpN(a.z, b.z, t)),
        heading: a.heading + dh * t,
      };
    }

    let lo = 0, hi = n - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (s[mid].dist < dd) lo = mid; else hi = mid; }
    const a = s[lo], b = s[hi];
    const span = (b.dist - a.dist) || 1;
    const t = clamp((dd - a.dist) / span, 0, 1);
    let dh = b.heading - a.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    return {
      position: new THREE.Vector3(lerpN(a.x, b.x, t), lerpN(a.y, b.y, t) + VERT_OFFSET, lerpN(a.z, b.z, t)),
      heading: a.heading + dh * t,
    };
  }
}

// Tiny seeded 0..1 noise for placement randomisation (avoids importing more).
function valueNoise01(seed) {
  const x = Math.sin(seed * 127.1) * 43758.5453;
  return x - Math.floor(x);
}
