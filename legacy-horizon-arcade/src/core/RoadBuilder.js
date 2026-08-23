// RoadBuilder.js — shared road geometry + texture + shader builders.
//
// Extracted from Road.js so both the open-world `Road` and the closed `Circuit`
// loop build asphalt ribbons, curbs, and shoulders from ONE implementation.
// All functions are pure (geometry/texture/material side-effects only) and take
// explicit params — no hidden state — so the two road types stay perfectly
// consistent in look and feel.
//
// Coordinate convention (shared with Road/Race/Car): heading is a yaw (rad) where
// 0 = +Z. The planar tangent is (sin h, cos h). Samples are uniform arc-length
// spaced entries: { x, z, y, heading, dist, curvature }.

import * as THREE from 'three';
import { valueNoise2D, clamp, lerpN } from './noise.js';

// Defaults mirror Road.js tunables so an un-specified call reproduces the
// original road exactly. Callers (Circuit) override what they need.
export const DEFAULTS = {
  HALF_WIDTH: 6.5,        // road half-width (2 lanes ≈ 13 m)
  VERT_OFFSET: 0.08,      // ride height above terrain to avoid z-fighting
  ASPHALT_TILE_METERS: 24.0,
  CURB_STRIPE_METERS: 1.5,
};

// ─── Ribbon geometry ────────────────────────────────────────────────────────

/**
 * Build the main asphalt ribbon geometry from uniform arc-length samples.
 * Two vertices per sample (left & right edge); UVs: U across [0..1], V along
 * length (tiles per `tileMeters`). Normals + bounding sphere computed.
 *
 * @param {Array<{x,z,y,heading,dist}>} samples
 * @param {{halfWidth?:number, vertOffset?:number, tileMeters?:number, closed?:boolean}} [opts]
 *   `closed` — when true, the ribbon wraps the last→first sample to close the
 *   loop with no seam gap (used by Circuit). The closing quad uses the shortest
 *   tangent bridge between the last and first samples.
 * @returns {THREE.BufferGeometry}
 */
export function buildRibbonGeometry(samples, opts = {}) {
  const halfWidth = opts.halfWidth ?? DEFAULTS.HALF_WIDTH;
  const vertOffset = opts.vertOffset ?? DEFAULTS.VERT_OFFSET;
  const tileMeters = opts.tileMeters ?? DEFAULTS.ASPHALT_TILE_METERS;
  const closed = !!opts.closed;

  const n = samples.length;
  const segCount = closed ? n : n - 1;
  const positions = new Float32Array(segCount * 2 * 3 + (closed ? 0 : 0));
  // Allocate for segCount segments × 2 verts, plus we re-loop below.
  // (Simpler: build vertex arrays sized to segCount*2 for closed, n*2 for open.)
  const vertCount = closed ? segCount * 2 : n * 2;
  const pos = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = [];

  const tmpTan = new THREE.Vector3();
  const tmpNorm = new THREE.Vector3();

  const sampleAt = (i) => samples[(i % n + n) % n]; // wrap index for closed loops

  for (let i = 0; i < (closed ? segCount : n); i++) {
    const p = sampleAt(i);
    // Centred finite-difference tangent (planar). For closed loops the wrap
    // gives a smooth tangent across the seam.
    const prev = closed ? sampleAt(i - 1) : samples[Math.max(0, i - 1)];
    const next = closed ? sampleAt(i + 1) : samples[Math.min(n - 1, i + 1)];
    tmpTan.set(next.x - prev.x, 0, next.z - prev.z);
    if (tmpTan.lengthSq() < 1e-9) tmpTan.set(Math.sin(p.heading), 0, Math.cos(p.heading));
    tmpTan.normalize();
    tmpNorm.set(-tmpTan.z, 0, tmpTan.x); // +90° about Y → "left" of travel

    const lx = p.x + tmpNorm.x * halfWidth;
    const lz = p.z + tmpNorm.z * halfWidth;
    const rx = p.x - tmpNorm.x * halfWidth;
    const rz = p.z - tmpNorm.z * halfWidth;
    const y = p.y + vertOffset;

    const li = i * 2, ri = i * 2 + 1;
    pos[li * 3 + 0] = lx; pos[li * 3 + 1] = y; pos[li * 3 + 2] = lz;
    pos[ri * 3 + 0] = rx; pos[ri * 3 + 1] = y; pos[ri * 3 + 2] = rz;

    const v = p.dist / tileMeters;
    uvs[li * 2 + 0] = 0; uvs[li * 2 + 1] = v;
    uvs[ri * 2 + 0] = 1; uvs[ri * 2 + 1] = v;
  }

  for (let i = 0; i < segCount; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = closed ? ((i + 1) % segCount) * 2 : (i + 1) * 2;
    const d = c + 1;
    indices.push(a, c, b);
    indices.push(b, c, d);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Build a thin edge ribbon mesh (curb or shoulder) hugging one side of the road
 * between samples [a..b]. `side`: +1 = left of travel, -1 = right. `halfW` is the
 * ribbon's half-width; `innerHalfWidth` is the road half-width it butts against.
 *
 * Ported verbatim from Road._addEdgeRibbon; only parametrised.
 */
export function buildEdgeRibbonMesh(samples, a, b, side, halfW, opts = {}) {
  const innerHalfWidth = opts.innerHalfWidth ?? DEFAULTS.HALF_WIDTH;
  const yLift = opts.yLift ?? (DEFAULTS.VERT_OFFSET + 0.03);
  const stripeMeters = opts.stripeMeters ?? DEFAULTS.CURB_STRIPE_METERS;
  const material = opts.material;
  const name = opts.name ?? 'RoadEdgeRibbon';
  const castShadow = opts.castShadow ?? true;
  const receiveShadow = opts.receiveShadow ?? true;

  const span = b - a + 1;
  const positions = new Float32Array(span * 2 * 3);
  const uvs = new Float32Array(span * 2 * 2);
  const indices = [];

  const innerOffset = innerHalfWidth + 0.02;
  const outerOffset = innerOffset + halfW * 2;

  const tmpTan = new THREE.Vector3();
  const tmpNorm = new THREE.Vector3();

  for (let i = 0; i < span; i++) {
    const idx = a + i;
    const p = samples[idx];
    const prev = samples[Math.max(0, idx - 1)];
    const next = samples[Math.min(samples.length - 1, idx + 1)];
    tmpTan.set(next.x - prev.x, 0, next.z - prev.z);
    if (tmpTan.lengthSq() < 1e-9) tmpTan.set(Math.sin(p.heading), 0, Math.cos(p.heading));
    tmpTan.normalize();
    tmpNorm.set(-tmpTan.z, 0, tmpTan.x);

    const nx = tmpNorm.x * side;
    const nz = tmpNorm.z * side;
    const y = p.y + yLift;

    const ix = p.x + nx * innerOffset, iz = p.z + nz * innerOffset;
    const ox = p.x + nx * outerOffset, oz = p.z + nz * outerOffset;

    const li = i * 2, ri = i * 2 + 1;
    positions[li * 3 + 0] = ix; positions[li * 3 + 1] = y; positions[li * 3 + 2] = iz;
    positions[ri * 3 + 0] = ox; positions[ri * 3 + 1] = y; positions[ri * 3 + 2] = oz;

    const v = (p.dist - samples[a].dist) / stripeMeters;
    uvs[li * 2 + 0] = 0; uvs[li * 2 + 1] = v;
    uvs[ri * 2 + 0] = 1; uvs[ri * 2 + 1] = v;
  }

  for (let i = 0; i < span - 1; i++) {
    const x0 = i * 2, x1 = i * 2 + 1, x2 = (i + 1) * 2, x3 = (i + 1) * 2 + 1;
    indices.push(x0, x2, x1);
    indices.push(x1, x2, x3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  return mesh;
}

// ─── Textures (procedural, no external assets) ──────────────────────────────

/** Painted asphalt: dark noisy base, crack network, rubber streaks, + painted
 *  centre dash + solid edge lines with a baked drop-shadow. Ported from Road. */
export function makeAsphaltTexture(seed) {
  const W = 512, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const grain = valueNoise2D(x * 0.6, y * 0.6, seed + 5) * 14 - 7;
      const blotch = valueNoise2D(x * 0.05, y * 0.05, seed + 23) * 10 - 5;
      const patchA = valueNoise2D(x * 0.018, y * 0.021, seed + 71) * 2 - 1;
      const patchB = valueNoise2D(x * 0.0093, y * 0.0077, seed + 113) * 2 - 1;
      const patch = (patchA * 0.6 + patchB * 0.4) * 11;
      // Sunlit dry asphalt albedo — mid-grey (~90), not charcoal. The old base of
      // 44 read near-black under the sky's exposure; aggregate detail still comes
      // from grain/blotch/patch below.
      const base = 90 + grain + blotch + patch;
      const idx = (y * W + x) * 4;
      img.data[idx + 0] = base;
      img.data[idx + 1] = base + 1;
      img.data[idx + 2] = base + 2;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const crackData = ctx.getImageData(0, 0, W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const n1 = valueNoise2D(x * 0.11, y * 0.11, seed + 201);
      const n2 = valueNoise2D(x * 0.23, y * 0.19, seed + 317);
      const crack = n1 > 0.82 && n2 > 0.55;
      const patch = valueNoise2D(x * 0.04, y * 0.035, seed + 401) > 0.78;
      if (crack || patch) {
        const idx = (y * W + x) * 4;
        const darken = crack ? 30 : 16;
        crackData.data[idx] = Math.max(0, crackData.data[idx] - darken);
        crackData.data[idx + 1] = Math.max(0, crackData.data[idx + 1] - darken);
        crackData.data[idx + 2] = Math.max(0, crackData.data[idx + 2] - darken - 2);
      }
    }
  }
  ctx.putImageData(crackData, 0, 0);

  // Rubber streaks in wheel paths.
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = 'rgba(120,115,110,0.12)';
  ctx.fillRect(W * 0.18, 0, W * 0.08, H);
  ctx.fillRect(W * 0.74, 0, W * 0.08, H);
  ctx.globalCompositeOperation = 'source-over';

  const LANE_DASH_METERS = 6.0;
  const ASPHALT_TILE_METERS = DEFAULTS.ASPHALT_TILE_METERS;
  const cx = W * 0.5;
  const periodPx = H * (LANE_DASH_METERS / ASPHALT_TILE_METERS);
  const dashPx = periodPx * 0.5;
  const lineHalfW = 2;
  const shadowOffset = 1;
  const shadowColor = 'rgba(0,0,0,0.55)';

  for (let y = -dashPx; y < H + periodPx; y += periodPx) {
    const y0 = ((y % periodPx) + periodPx) % periodPx;
    ctx.fillStyle = shadowColor;
    ctx.fillRect(cx - lineHalfW, y0 + dashPx, lineHalfW * 2, shadowOffset);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#fff8e8';
    ctx.fillRect(cx - lineHalfW, y0, lineHalfW * 2, dashPx);
    ctx.globalCompositeOperation = 'source-over';
  }

  const edgeInset = 7;
  const edgeW = 3;
  ctx.fillStyle = shadowColor;
  ctx.fillRect(edgeInset + edgeW, 0, shadowOffset, H);
  ctx.fillRect(W - edgeInset - edgeW - shadowOffset, 0, shadowOffset, H);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = '#fff8e8';
  ctx.fillRect(edgeInset, 0, edgeW, H);
  ctx.fillRect(W - edgeInset - edgeW, 0, edgeW, H);
  ctx.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Red/white striped curb texture (four bands so the averaged mip reads R/W). */
export function makeCurbTexture() {
  const W = 64, H = 64;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f5f5f5'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#c81e1e';
  ctx.fillRect(0, 0, W, H / 4);
  ctx.fillRect(0, H / 2, W, H / 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Gravel shoulder texture (darker, rougher, no lines). */
export function makeShoulderTexture(seed) {
  const W = 128, H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const g = valueNoise2D(x * 0.3, y * 0.3, seed + 51) * 28 + 8;
      const base = 58 + g;
      const idx = (y * W + x) * 4;
      img.data[idx + 0] = base;
      img.data[idx + 1] = base + 3;
      img.data[idx + 2] = base - 2;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ─── Asphalt shader injection (shared look: aggregate grain + sun streak +
//     retroreflective paint). Ported verbatim from Road._injectAsphaltShader. ──

export function injectAsphaltShader(mat, sunDir) {
  mat.uniforms = {
    uSunDir: { value: sunDir.clone() },
  };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = mat.uniforms.uSunDir;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vRoadWorldNormal;
         varying vec3 vRoadWorldPos;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         vRoadWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vRoadWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform vec3 uSunDir;
         varying vec3 vRoadWorldNormal;
         varying vec3 vRoadWorldPos;

         float roadHash(vec2 p) {
           float h = dot(p, vec2(127.1, 311.7));
           return fract(sin(h) * 43758.5453) * 2.0 - 1.0;
         }
         float roadVNoise(vec2 p) {
           vec2 i = floor(p);
           vec2 f = fract(p);
           vec2 u = f * f * (3.0 - 2.0 * f);
           float a = roadHash(i);
           float b = roadHash(i + vec2(1.0, 0.0));
           float c = roadHash(i + vec2(0.0, 1.0));
           float d = roadHash(i + vec2(1.0, 1.0));
           return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
         }
         float roadFBM(vec2 p) {
           float v = 0.0;
           float amp = 0.5;
           v += amp * roadVNoise(p); p *= 2.02; amp *= 0.5;
           v += amp * roadVNoise(p); p *= 2.03; amp *= 0.5;
           v += amp * roadVNoise(p);
           return v;
         }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         {
           vec2 nuv = vMapUv * vec2(90.0, 26.0);
           float nX = roadFBM(nuv + vec2(0.13, 0.0));
           float nY = roadFBM(nuv + vec2(0.0, 0.21));
           vec3 nrm = normalize(normal);
           vec3 ref = abs(nrm.z) < 0.99 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
           vec3 t1 = normalize(cross(nrm, ref));
           vec3 t2 = normalize(cross(nrm, t1));
           float bumpAmp = 0.025;
           normal = normalize(nrm + (t1 * nX + t2 * nY) * bumpAmp);
         }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         {
           vec3 wN = normalize(vRoadWorldNormal);
           vec3 sun = normalize(uSunDir);
           float facing = dot(wN, sun) * 0.5 + 0.5;
           facing = facing * facing;
           float grazing = pow(clamp(1.0 - wN.y, 0.0, 1.0), 1.5);
           // r5: this used to drive roughness down to 0.18 sun-facing, which
           // turned the whole tarmac into a mirror lake under bloom. Keep a
           // dry-asphalt floor (0.42) and halve the modulation so the streak
           // reads as a subtle sheen, not a specular blowout.
           float sheen = facing * (0.35 + 0.30 * grazing);
           float paintL = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
           float paintMask = smoothstep(0.55, 0.80, paintL);
           float roughFloor = mix(0.42, 0.58, paintMask);
           roughnessFactor = mix(roughFloor, roughnessFactor, 1.0 - sheen * 0.28);
         }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           float paintL = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
           float paintMask = smoothstep(0.55, 0.80, paintL);
           if (paintMask > 0.001) {
             vec3 wN = normalize(vRoadWorldNormal);
             vec3 sun = normalize(uSunDir);
             vec3 viewDir = normalize(cameraPosition - vRoadWorldPos);
             float sunFace = clamp(dot(wN, sun) * 0.5 + 0.5, 0.0, 1.0);
             float retro = pow(clamp(dot(viewDir, sun) * 0.5 + 0.5, 0.0, 1.0), 2.0);
             float dist = length(cameraPosition - vRoadWorldPos);
             float distBoost = clamp(1.0 + dist * 0.0009, 1.0, 1.35);
             vec3 paintWarm = vec3(1.0, 0.965, 0.88);
             float amount = paintMask * (0.35 + 0.55 * sunFace) * (0.75 + 0.45 * retro) * distBoost;
             totalEmissiveRadiance += paintWarm * min(amount, 0.5);
           }
         }`,
      );
  };
}
