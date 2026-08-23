// Road.js — procedural winding road mesh draped over terrain.
//
// Builds a smooth 2D centerline (noise-driven heading integration), resamples it
// to a uniform arc-length spacing, drrape-fits it to terrain.getHeight() with a
// low-pass vertical filter (no jitter on noisy terrain), and extrudes a two-lane
// asphalt ribbon with painted lane/edge lines, red/white curbs on tight corners,
// and low shoulder geometry. Casts and receives shadows.
//
// Coordinate convention: heading is a yaw (radians) where 0 = +Z. The road's
// planar tangent is (sin(h), cos(h)). startSample().heading is the tangent yaw
// at the road's first point, so a car placed with heading h faces along the road.

import * as THREE from 'three';
import { valueNoise2D, fbm2D, clamp, lerpN } from './noise.js';
import {
  buildRibbonGeometry, buildEdgeRibbonMesh,
  makeAsphaltTexture, makeCurbTexture, makeShoulderTexture,
  injectAsphaltShader,
} from './RoadBuilder.js';

// ─── Tunables ────────────────────────────────────────────────────────────────
const HALF_WIDTH = 6.5;          // road half-width (2 lanes ≈ 13m total)
const SHOULDER_WIDTH = 1.6;      // gravel shoulder each side
const CURB_HALF_WIDTH = 0.28;    // half-width of curb ribbon
const TARGET_SPACING = 4.0;      // arc-length spacing between ribbon samples (m)
const HEIGHT_SMOOTH_KERNEL = 7;  // samples each side for vertical low-pass (odd-ish)
const VERT_OFFSET = 0.08;        // ride height above terrain to avoid z-fighting
const CURB_CURVATURE_THRESHOLD = 0.0105; // rad/m — tighter than this gets curbs (~0.6°/m)
const WORLD_BOUNDS = 1900;       // keep centerline within terrain (size 4000 → ±2000, pad edges)

// Texture tiling: how many meters of road one tile of the asphalt texture spans.
const ASPHALT_TILE_METERS = 24.0;

// ─── Road ────────────────────────────────────────────────────────────────────
export class Road {
  /**
   * @param {Object} opts
   * @param {{ getHeight: (x:number,z:number)=>number }} opts.terrain
   * @param {number} [opts.seed=1337]
   * @param {number} [opts.length=9000]  target arc length in metres
   * @param {THREE.Vector3} [opts.sunDir]  world-space direction TOWARD the sun
   *   (normalized). Used by the asphalt shader to align the dry specular streak
   *   with the golden-hour key light and to drive the painted-line retroshift.
   *   When omitted, falls back to the same elevation/azimuth Sky uses so the
   *   road still reads consistently without a hard dependency on the Sky module.
   */
  constructor({ terrain, seed = 1337, length = 9000, sunDir } = {}) {
    this.terrain = terrain;
    this.seed = seed;
    this.targetLength = length;

    // Sun direction toward the light source (normalized). Single source of truth
    // for the asphalt shader's specular streak + line retroreflection. Mirrors
    // Sky.js's SUN_ELEVATION/SUN_AZIMUTH so an un-wired Road still faces the
    // same warm key light the rest of the scene uses.
    this.sunDir = sunDir
      ? sunDir.clone().normalize()
      : this._defaultSunDir();

    /** @type {THREE.Group} */
    this.group = new THREE.Group();
    this.group.name = 'Road';

    // The authoritative centerline, uniform arc-length spaced.
    // Each entry: { x, z, y, heading, dist, curvature }
    this._samples = [];

    this._buildCenterline();
    this._buildRoadMesh();
    this._buildCurbs();
    this._buildShoulders();
    this._buildEmbankments();

    // Pre-compute start sample for cheap lookups.
    this._startSample = this._samples[0];
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Start of the road: world position + tangent heading (0 = +Z). */
  startSample() {
    const s = this._startSample;
    return {
      position: new THREE.Vector3(s.x, s.y + VERT_OFFSET, s.z),
      heading: s.heading,
    };
  }

  centerline() {
    // Decimate a touch for minimap use (every 3rd sample ≈ 12m) to keep it cheap,
    // but always include the exact endpoints.
    const out = [];
    const step = 3;
    for (let i = 0; i < this._samples.length; i += step) {
      const s = this._samples[i];
      out.push({ x: s.x, z: s.z, heading: s.heading });
    }
    const last = this._samples[this._samples.length - 1];
    out.push({ x: last.x, z: last.z, heading: last.heading });
    return out;
  }

  /** Total arc length of the road centerline (m). */
  totalLength() {
    const n = this._samples.length;
    return n ? this._samples[n - 1].dist : 0;
  }

  /** Approximate distance (m) from world xz to the road centerline. */
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

  /** Nearest centerline sample at world (x,z) for road-aligned decals. */
  sampleNearest(x, z) {
    let minD2 = Infinity;
    let best = null;
    const step = 2;
    for (let i = 0; i < this._samples.length; i += step) {
      const s = this._samples[i];
      const dx = x - s.x, dz = z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < minD2) {
        minD2 = d2;
        best = s;
      }
    }
    if (!best) return null;
    return {
      y: best.y + VERT_OFFSET,
      heading: best.heading,
      dist2: minD2,
    };
  }

  /** Optional: sample { position, heading } at arc-length d (clamped to ends). */
  sampleAtDistance(d) {
    const n = this._samples.length;
    if (n === 0) return null;
    const total = this._samples[n - 1].dist;
    const t = clamp(d, 0, total);
    // Binary search for the bracketing sample.
    let lo = 0, hi = n - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this._samples[mid].dist < t) lo = mid; else hi = mid;
    }
    const a = this._samples[lo], b = this._samples[hi];
    const span = b.dist - a.dist || 1;
    const k = clamp((t - a.dist) / span, 0, 1);
    // Use angle-aware heading interp across the shortest arc.
    let dh = b.heading - a.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    const heading = a.heading + dh * k;
    return {
      position: new THREE.Vector3(
        lerpN(a.x, b.x, k),
        lerpN(a.y, b.y, k) + VERT_OFFSET,
        lerpN(a.z, b.z, k),
      ),
      heading,
    };
  }

  // ── Centerline generation ─────────────────────────────────────────────────

  /**
   * Integrate a 2D heading field driven by smooth fbm noise, then resample to a
   * uniform arc length. Deterministic from seed. Curvature is bounded because
   * the heading derivative of low-frequency noise is small.
   */
  _buildCenterline() {
    const seed = this.seed;
    const target = this.targetLength;

    // Step the integrator in small planar strides so curvature stays smooth.
    const rawStep = 2.0;

    const raw = []; // {x, z, heading}
    // Spawn near the south edge, facing straight up the map (+Z), so the car
    // starts aimed along the road. A tiny seeded offset keeps seeds distinct.
    let x = 0, z = -WORLD_BOUNDS * 0.8;
    let heading = (valueNoise2D(0.5, 0.5, seed + 7) - 0.5) * 0.10;

    raw.push({ x, z, heading });

    let traveled = 0;
    let guard = 0;
    const maxIters = Math.ceil(target / rawStep) + 4000;

    // Confinement model: a smooth spring that pulls the road's heading toward
    // "point at world centre" with a strength that grows as it nears the boundary.
    // This replaces brittle edge-kicks and lets the road meander to full length.
    const confineStart = WORLD_BOUNDS * 0.82;  // let the road spread wide before pulling back
    const confineMaxK = 0.020;                 // max added turn rate (rad/m) at the rim

    while (traveled < target && guard < maxIters) {
      guard++;

      // ── Noise-driven turn rate ──────────────────────────────────────────
      // Two octaves: a LOW-frequency "sweep" for long, flowing countryside
      // sweepers (Forza-Horizon style), plus a tiny high-frequency "wander"
      // for organic variation. The low frequency is what gives long reads and
      // fast high-speed bends instead of constant medium wriggle.
      const nx = x * 0.00028;
      const nz = z * 0.00028;
      const sweep = (fbm2D(nx, nz, { octaves: 3, frequency: 1.0, seed }) - 0.5) * 2.0; // [-1,1]
      const wander = (valueNoise2D(nx * 3.1 + 11.3, nz * 3.1 - 4.7, seed + 91) - 0.5) * 2.0;
      // Suppress wander where the road is already going straight, opening up
      // readable long straights.
      const straightness = 1.0 - Math.exp(-((sweep * 6) ** 2));
      let turnRate = sweep * 0.0032 + wander * 0.0005 * straightness;

      // ── Deterministic long straights at fixed arc fractions ─────────────
      // Three committed straights spread across the lap for overtaking.
      const phase = traveled / target;
      const inStraight =
        (phase > 0.12 && phase < 0.21) ||
        (phase > 0.44 && phase < 0.53) ||
        (phase > 0.77 && phase < 0.86);
      if (inStraight) turnRate *= 0.05;

      // ── Soft boundary confinement (spring toward centre) ────────────────
      // Strength ramps from 0 inside confineStart to confineMaxK at the rim.
      const distFromCentre = Math.hypot(x, z);
      if (distFromCentre > confineStart) {
        const t = clamp((distFromCentre - confineStart) / (WORLD_BOUNDS - confineStart), 0, 1);
        const k = confineMaxK * (t * t); // quadratic ramp — gentle until close
        // Desired heading points from current pos back toward world centre.
        const desired = Math.atan2(-x, -z);
        let diff = desired - heading;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        turnRate += clamp(diff, -k, k);
      }

      heading += turnRate * rawStep;

      // Advance along the tangent. heading 0 → +Z.
      const dx = Math.sin(heading) * rawStep;
      const dz = Math.cos(heading) * rawStep;
      x += dx;
      z += dz;
      traveled += rawStep;

      raw.push({ x, z, heading });
    }

    // Resample `raw` to uniform arc length using chord-length parameterisation.
    // This guarantees monotonic arc length and a stable spacing for the ribbon.
    this._samples = this._resampleUniform(raw, TARGET_SPACING);

    // Compute curvature (rad per metre) via finite differences on heading, with
    // a mild low-pass so curvature-driven curb placement doesn't flicker.
    this._computeCurvature();

    // Drape onto terrain and low-pass the vertical profile so the road doesn't
    // jitter over noisy ground.
    this._drapeAndSmooth();

    // Final guard: drop any NaNs (defensive — terrain contract should be clean).
    for (const s of this._samples) {
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z)) {
        s.x = Number.isFinite(s.x) ? s.x : 0;
        s.z = Number.isFinite(s.z) ? s.z : 0;
        s.y = Number.isFinite(s.y) ? s.y : this.terrain.getHeight(s.x, s.z);
        s.heading = Number.isFinite(s.heading) ? s.heading : 0;
      }
    }
  }

  /** Resample a polyline (with per-vertex heading) to uniform arc-length spacing. */
  _resampleUniform(raw, spacing) {
    // Cumulative chord length.
    const cum = new Float32Array(raw.length);
    cum[0] = 0;
    for (let i = 1; i < raw.length; i++) {
      const dx = raw[i].x - raw[i - 1].x;
      const dz = raw[i].z - raw[i - 1].z;
      cum[i] = cum[i - 1] + Math.hypot(dx, dz);
    }
    const total = cum[cum.length - 1];
    const count = Math.max(2, Math.floor(total / spacing) + 1);

    const out = new Array(count);
    let j = 0;
    for (let i = 0; i < count; i++) {
      const d = (i / (count - 1)) * total;
      // Advance j to the segment containing arc length d.
      while (j < cum.length - 2 && cum[j + 1] < d) j++;
      const segLen = cum[j + 1] - cum[j] || 1;
      const t = clamp((d - cum[j]) / segLen, 0, 1);
      const a = raw[j], b = raw[j + 1];
      const x = lerpN(a.x, b.x, t);
      const z = lerpN(a.z, b.z, t);
      // Shortest-arc heading interpolation.
      let dh = b.heading - a.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      const heading = a.heading + dh * t;
      out[i] = { x, z, y: 0, heading, dist: d, curvature: 0 };
    }
    return out;
  }

  /** Finite-difference curvature (dHeading/dArc) with a small low-pass. */
  _computeCurvature() {
    const s = this._samples;
    const n = s.length;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const prev = s[Math.max(0, i - 1)];
      const next = s[Math.min(n - 1, i + 1)];
      let dh = next.heading - prev.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      const dd = next.dist - prev.dist || 1;
      raw[i] = dh / dd;
    }
    // Box low-pass (3-tap) — just enough to keep curb regions coherent.
    for (let i = 0; i < n; i++) {
      const a = raw[Math.max(0, i - 1)];
      const b = raw[i];
      const c = raw[Math.min(n - 1, i + 1)];
      s[i].curvature = (a + b + c) / 3;
    }
  }

  /**
   * Sample terrain heights, then low-pass filter in arc length so the road rides
   * smoothly over bumpy ground. This is the key anti-jitter step.
   */
  _drapeAndSmooth() {
    const s = this._samples;
    const n = s.length;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      raw[i] = this.terrain.getHeight(s[i].x, s[i].z);
    }
    const k = HEIGHT_SMOOTH_KERNEL;
    for (let i = 0; i < n; i++) {
      let sum = 0, count = 0;
      for (let off = -k; off <= k; off++) {
        const idx = i + off;
        if (idx < 0 || idx >= n) continue;
        // Triangle-weighted window for a smooth result with no ringing.
        const w = 1 - Math.abs(off) / (k + 1);
        sum += raw[idx] * w;
        count += w;
      }
      s[i].y = count > 0 ? sum / count : raw[i];
    }
  }

  // ── Mesh builders ─────────────────────────────────────────────────────────

  /** Build the main asphalt ribbon with a canvas-painted texture (lines + dashes). */
  _buildRoadMesh() {
    const s = this._samples;
    const n = s.length;
    if (n < 2) return;

    const geo = buildRibbonGeometry(s, {
      halfWidth: HALF_WIDTH, vertOffset: VERT_OFFSET, tileMeters: ASPHALT_TILE_METERS,
    });

    const tex = makeAsphaltTexture(this.seed);
    // V (length) wraps; U (across) clamps so edge lines stay crisp at the very rim.
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;

    // MeshPhysicalMaterial so the asphalt has a real clearcoat that catches a sun
    // glint streak and reflects the scene.environment IBL now provided by Sky.
    // Dry asphalt: nearly Lambertian with a faint broad sheen from aggregate.
    // Keep clearcoat very low so it doesn't read as damp/wet seal-coat.
    //
    // emissive* is enabled (base colour near-black, intensity 1.0) ONLY so the
    // PBR fragment compiles the <emissivemap_fragment> chunk our shader injection
    // writes into — we add the retroreflective line pop there, not here. The base
    // asphalt stays at ~zero emissive radiance so the tarmac itself doesn't glow.
    const mat = new THREE.MeshPhysicalMaterial({
      map: tex,
      roughness: 0.62,
      metalness: 0.0,
      clearcoat: 0.12,
      clearcoatRoughness: 0.85,
      emissive: new THREE.Color('#000000'),
      emissiveIntensity: 1.0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    // Inject procedural asphalt believability directly into the PBR fragment:
    //   • aggregate micro-bumps (procedural normal, no texture on disk)
    //   • a dry sun-aligned specular streak (roughness modulated DOWN where the
    //     surface faces the key light, so a soft anisotropic-ish flare runs
    //     along the sun azimuth — tarmac, not wet seal-coat)
    //   • retroreflective painted lines that brighten toward the sun/view so
    //     the markings catch the light instead of reading as flat matte paint.
    // The injection runs once at compile; nothing here executes per-frame on JS.
    injectAsphaltShader(mat, this.sunDir);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'RoadAsphalt';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this._roadMesh = mesh;
  }

  // ---------------------------------------------------------------------------
  // Default sun direction mirroring Sky.js's golden-hour elevation/azimuth, used
  // when no sunDir is wired in. Kept here (not imported) so Road has zero hard
  // dependency on the Sky module — if Sky is removed, the road still faces the
  // same warm key direction the rest of the scene was authored against.
  // ---------------------------------------------------------------------------
  _defaultSunDir() {
    const elev = THREE.MathUtils.degToRad(26);   // matches Sky.SUN_ELEVATION (raised from 15 in r5)
    const azim = THREE.MathUtils.degToRad(145);  // matches Sky.SUN_AZIMUTH
    const cosEl = Math.cos(elev);
    return new THREE.Vector3(
      Math.sin(azim) * cosEl,
      Math.sin(elev),
      Math.cos(azim) * cosEl,
    ).normalize();
  }



  /**
   * Curbs: thin red/white ribbons placed along the outer edge of the road where
   * curvature exceeds the threshold. Built as a single indexed ribbon whose
   * vertex alpha (via a vertex-colour-like mask in the texture) toggles the
   * stripe pattern along length.
   *
   * Implementation note: we add curb geometry only on contiguous "corner"
   * runs to keep triangle count sane and to avoid curbing every micro-wiggle.
   */
  _buildCurbs() {
    const s = this._samples;
    const n = s.length;
    if (n < 4) return;

    // Find contiguous runs where |curvature| exceeds the threshold.
    const runs = [];
    let cur = null;
    for (let i = 0; i < n; i++) {
      const tight = Math.abs(s[i].curvature) > CURB_CURVATURE_THRESHOLD;
      if (tight && !cur) cur = { start: i };
      else if (!tight && cur) { cur.end = i - 1; runs.push(cur); cur = null; }
    }
    if (cur) { cur.end = n - 1; runs.push(cur); }

    // Merge runs that are very close (avoid curb stutter between near-adjacent bends).
    const merged = [];
    for (const r of runs) {
      if (merged.length && r.start - merged[merged.length - 1].end < 6) {
        merged[merged.length - 1].end = r.end;
      } else {
        merged.push({ start: r.start, end: r.end });
      }
    }

    const tex = makeCurbTexture();
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.85,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    for (const r of merged) {
      // Pad each run by a couple of samples so curbs blend into the shoulder.
      const a = Math.max(0, r.start - 2);
      const b = Math.min(n - 1, r.end + 2);
      this.group.add(buildEdgeRibbonMesh(s, a, b, +1, CURB_HALF_WIDTH,
        { material: mat, name: 'RoadCurbR', innerHalfWidth: HALF_WIDTH, yLift: VERT_OFFSET + 0.03 }));
      this.group.add(buildEdgeRibbonMesh(s, a, b, -1, CURB_HALF_WIDTH,
        { material: mat, name: 'RoadCurbL', innerHalfWidth: HALF_WIDTH, yLift: VERT_OFFSET + 0.03 }));
    }
  }


  /**
   * Low shoulder/gravel ribbon running the full length on both sides, blending
   * the road edge into the terrain. Slightly darker, rougher, no lines.
   */
  _buildShoulders() {
    const tex = makeShoulderTexture(this.seed);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.95,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
    });
    const n = this._samples.length;
    if (n < 2) return;
    this.group.add(buildEdgeRibbonMesh(this._samples, 0, n - 1, +1, SHOULDER_WIDTH,
      { material: mat, name: 'RoadShoulderR', innerHalfWidth: HALF_WIDTH, yLift: VERT_OFFSET + 0.03 }));
    this.group.add(buildEdgeRibbonMesh(this._samples, 0, n - 1, -1, SHOULDER_WIDTH,
      { material: mat, name: 'RoadShoulderL', innerHalfWidth: HALF_WIDTH, yLift: VERT_OFFSET + 0.03 }));
  }

  /**
   * Cut/fill skirts from shoulder outer edge down to terrain — road reads graded
   * into the landscape instead of floating on a ribbon.
   */
  _buildEmbankments() {
    const s = this._samples;
    const n = s.length;
    if (n < 2 || !this.terrain) return;

    const mat = new THREE.MeshStandardMaterial({
      color: 0x5a4838, roughness: 0.96, metalness: 0.0,
    });
    const outer = HALF_WIDTH + SHOULDER_WIDTH;
    const reach = 4.2;
    const step = 2;
    const positions = [];
    const indices = [];
    const tmpTan = new THREE.Vector3();
    const tmpNorm = new THREE.Vector3();

    const addSkirtSide = (sign) => {
      const verts = [];
      for (let i = 0; i < n; i += step) {
        const p = s[i];
        const prev = s[Math.max(0, i - 1)];
        const next = s[Math.min(n - 1, i + 1)];
        tmpTan.set(next.x - prev.x, 0, next.z - prev.z);
        if (tmpTan.lengthSq() < 1e-9) tmpTan.set(Math.sin(p.heading), 0, Math.cos(p.heading));
        tmpTan.normalize();
        tmpNorm.set(-tmpTan.z, 0, tmpTan.x);

        const ex = p.x + tmpNorm.x * outer * sign;
        const ez = p.z + tmpNorm.z * outer * sign;
        const ey = p.y + VERT_OFFSET;
        const ox = ex + tmpNorm.x * reach * sign;
        const oz = ez + tmpNorm.z * reach * sign;
        const oy = (this.terrain.getHeight(ox, oz) || 0) + 0.04;
        verts.push({ x: ex, y: ey, z: ez, x2: ox, y2: oy, z2: oz });
      }
      for (let j = 0; j < verts.length - 1; j++) {
        const a = verts[j], b = verts[j + 1];
        const base = positions.length / 3;
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z, a.x2, a.y2, a.z2, b.x2, b.y2, b.z2);
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    };

    addSkirtSide(1);
    addSkirtSide(-1);

    if (indices.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'RoadEmbankments';
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  // _makeShoulderTexture / _makeAsphaltTexture / _makeCurbTexture / _addEdgeRibbon /
  // _injectAsphaltShader → moved to RoadBuilder.js (shared with Circuit).
}
