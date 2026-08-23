// Environment.ts-style procedural open-world scenery.
//
// Scatters forests, rocks, roadside grass, distant mountains and a few
// roadside props across an existing Terrain/Road, all procedural (no external
// assets) and instanced for performance. Tuned for a warm golden-hour look
// under ACES tone mapping + bloom + exponential fog.
//
// Contract:
//   constructor({ terrain, road, seed = 1337 })
//   this.group                 -> THREE.Group (added to scene by caller)
//   update(dt, car)            -> LOD/streaming hook; currently a cheap no-op
//
// External deps:
//   THREE                      from 'three'
//   valueNoise2D, fbm2D, clamp from './noise.js'
//   terrain.getHeight(x,z)     -> world y (number)
//   road.centerline()          -> [{x,z,heading}, ...]

import * as THREE from 'three';
import { valueNoise2D, fbm2D, clamp } from './noise.js';

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
// Small helpers
// ---------------------------------------------------------------------------
const UP = new THREE.Vector3(0, 1, 0);
const TMP_Q = new THREE.Quaternion();
const TMP_S = new THREE.Vector3();
const TMP_P = new THREE.Vector3();
const TMP_M = new THREE.Matrix4();
const TMP_N = new THREE.Vector3();

// --- Golden-hour sun direction (TOWARD the sun) -----------------------------
// Self-contained default mirroring Sky.js (elevation 15°, azimuth 145°) so the
// canopy backlight agrees with the real cast shadow + sky glow even when the
// caller doesn't pass a sunDir. This is the SAME static direction Car.js uses
// for its contact-shadow default; main.js confirms sky.sunDir is static, so a
// single baked direction is correct. A caller can override via { sunDir } in
// the constructor (e.g. feeding sky.sunDir) without editing this file.
const SUN_ELEVATION_DEFAULT = THREE.MathUtils.degToRad(15);
const SUN_AZIMUTH_DEFAULT = THREE.MathUtils.degToRad(145);
const DEFAULT_SUN_DIR = (() => {
  const cosEl = Math.cos(SUN_ELEVATION_DEFAULT);
  return new THREE.Vector3(
    Math.sin(SUN_AZIMUTH_DEFAULT) * cosEl,
    Math.sin(SUN_ELEVATION_DEFAULT),
    Math.cos(SUN_AZIMUTH_DEFAULT) * cosEl,
  ).normalize();
})();

// Warm transmission color for backlit canopy. In LINEAR working space (the
// scene renders linear HDR -> ACES), a slightly desaturated hot amber reads as
// sunlight passing THROUGH leaves rather than a flat orange tint. Values are
// kept modest (peak additive ~0.5 linear) so ACES doesn't blow it to white.
const BACKLIGHT_COLOR = new THREE.Color('#ff7a1f'); // warm amber transmission

/** Estimate terrain normal via finite differences (used for slope/tilt tests). */
function terrainNormalAt(terrain, x, z, e = 1.0) {
  const hL = terrain.getHeight(x - e, z);
  const hR = terrain.getHeight(x + e, z);
  const hD = terrain.getHeight(x, z - e);
  const hU = terrain.getHeight(x, z + e);
  TMP_N.set(hL - hR, 2 * e, hD - hU).normalize();
  return TMP_N;
}

// ---------------------------------------------------------------------------
// Procedural canvas textures (created once, shared across instances).
// ---------------------------------------------------------------------------

/** Soft round alpha-falloff grass tuft sprite for cross-quad foliage. */
function makeGrassTexture() {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);

  // A few fibrous blades growing upward from the base, with alpha edges so the
  // billboard never reads as a hard rectangle.
  const blades = 11;
  for (let i = 0; i < blades; i++) {
    const t = i / (blades - 1);
    const bx = S * (0.15 + t * 0.7);
    const sway = Math.sin(t * 7.0) * 3.0;
    const w = 2.2 + Math.random() * 2.2;
    // Color gradient: darker wet base -> sun-warmed yellow-green tip.
    const grad = g.createLinearGradient(0, S, 0, 0);
    grad.addColorStop(0.0, '#3d5a22');
    grad.addColorStop(0.55, '#6f9e35');
    grad.addColorStop(1.0, '#b9d165');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(bx - w, S);
    g.quadraticCurveTo(bx + sway, S * 0.45, bx + sway * 0.6, 4);
    g.quadraticCurveTo(bx + sway, S * 0.45, bx + w, S);
    g.closePath();
    g.fill();
  }
  // Punch out a soft alpha at the very base corners so it sits on the ground.
  g.globalCompositeOperation = 'destination-in';
  const fade = g.createLinearGradient(0, S, 0, S * 0.2);
  fade.addColorStop(0, 'rgba(0,0,0,0.85)');
  fade.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = fade;
  g.fillRect(0, 0, S, S);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // NOTE: alphaTest is a material property; kept here only as a hint for callers.
  tex.anisotropy = 4;
  return tex;
}

/** Two-tone radial dappling texture for broadleaf canopies (vertex colors do
 *  most of the work; this adds leaf-scale breakup when viewed up close). */
function makeLeafTexture() {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#5d8a2e';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const r = 1 + Math.random() * 2.4;
    // Alternating warm/cool dapples to fake leaf clumping + sun.
    g.fillStyle = Math.random() < 0.5
      ? `rgba(120,160,55,${0.25 + Math.random() * 0.35})`
      : `rgba(58,85,28,${0.25 + Math.random() * 0.35})`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  // Soft radial alpha for billboard foliage cards.
  g.globalCompositeOperation = 'destination-in';
  const grd = g.createRadialGradient(S / 2, S / 2, S * 0.08, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(0,0,0,1)');
  grd.addColorStop(0.65, 'rgba(0,0,0,0.85)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ---------------------------------------------------------------------------
// Canopy backlight + wind shader injection (the golden-hour tree fix).
// ---------------------------------------------------------------------------
// The art-director note: trees read as opaque lollipops; there's no warm light
// bleeding THROUGH the leaves against the sun — the single most iconic golden-
// hour tree behavior. We fix it with a cheap additive translucent term in the
// foliage material's fragment shader, driven by a view-vs-sun dot product and
// a thickness proxy:
//
//   viewBack = clamp(dot(viewDir, -sunDir), 0, 1)
//     -> peaks when the camera looks TOWARD the sun (the fragment sits between
//        camera and sun). This is the master switch: the canopy mass only glows
//        as you turn sunward — the defining golden-hour tree behavior.
//   thickness = bias toward downward undersides (N.y < 0) + grazing silhouette
//     edges, so transmission concentrates on thin rim/underside rather than a
//     flat uniform glow.
//
//   backlight = pow(viewBack, 1.6) * thickness * intensity
//
// This is physically-plausible thin-leaf transmission: glow only appears while
// looking sunward and is brightest at the thin rim/underside of the mass, never
// as a flat wrap. It's added to diffuseColor.rgb BEFORE Three's lighting pass,
// so it reads as a self-lit translucent membrane (light scattered through the
// leaf) rather than a specular highlight or a tonemap-breaking flat tint. Kept
// in linear HDR range (~0..0.6 additive) so ACES tonemaps it to a believable
// amber bleed.
//
// We also add a SUBTLE canopy-top wind sway in the vertex stage (mirrors the
// roadside grass uTime pattern but far gentler — trees are rigid, so the bend
// is small and only the upper crown moves). One sin/cos per vertex; negligible.
//
// sunDir points TOWARD the sun (same convention as Sky.sunDir). windUniform is
// a shared { value } object the caller advances each frame (see update()).
function applyCanopyBacklight(material, sunDir, windUniform) {
  // Uniform object bound once; onBeforeCompile's closure captures it. The uTime
  // entry aliases the SHARED windUniform object (same one the grass material and
  // update() use), so advancing windUniform.value in update() drives all canopy
  // wind + grass in one coherent field. This closure survives material.clone()
  // in the forest builder because clone() copies the onBeforeCompile reference.
  const uniforms = {
    uSunDir: { value: sunDir.clone().normalize() },
    uTime: windUniform,
    uBacklightColor: { value: BACKLIGHT_COLOR },
    uBacklightIntensity: { value: 0.82 },
    uWindAmp: { value: 0.06 },
  };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDir = uniforms.uSunDir;
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uBacklightColor = uniforms.uBacklightColor;
    shader.uniforms.uBacklightIntensity = uniforms.uBacklightIntensity;
    shader.uniforms.uWindAmp = uniforms.uWindAmp;

    // --- Vertex stage: pass world normal + world position; add canopy wind ---
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform float uWindAmp;`,
      )
      // Declare varyings + compute world-space data alongside Three's own.
      .replace(
        '#include <worldpos_vertex>',
        // <worldpos_vertex> sets `worldPosition` when needed; we extend it. We
        // need WORLD-space normals (sunDir is world-space) and world position
        // (cameraPosition is world-space). modelMatrix transforms local->world;
        // for normals the correct transform is the inverse-transpose, but our
        // trees use uniform scale (no shear), so modelMatrix's upper-3x3 works.
        `#include <worldpos_vertex>
         #ifdef USE_INSTANCING
           mat3 im3 = mat3(instanceMatrix[0].xyz, instanceMatrix[1].xyz, instanceMatrix[2].xyz);
           mat3 mm3  = mat3(modelMatrix[0].xyz, modelMatrix[1].xyz, modelMatrix[2].xyz);
           vCanopyWorldNormal = normalize(mm3 * im3 * normal);
           vec4 wPosInst = instanceMatrix * vec4(transformed, 1.0);
           vCanopyWorldPos = (modelMatrix * wPosInst).xyz;
         #else
           mat3 mm3 = mat3(modelMatrix[0].xyz, modelMatrix[1].xyz, modelMatrix[2].xyz);
           vCanopyWorldNormal = normalize(mm3 * normal);
           vCanopyWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
         #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        // Canopy-top wind: bend the upper crown only. `transformed.y` is local
        // height; trees sit with base near y=0 and tops ~4-5 units up. We
        // normalize by an assumed canopy height so the bend is 0 at the trunk
        // and full at the tip. Phase is derived from world position so each
        // instance sways out of phase (no synchronized waving army of trees).
        `#include <begin_vertex>
         {
           float canopyTop = 4.5;                 // approx local height of crown
           float topF = clamp(transformed.y / canopyTop, 0.0, 1.0);
           float bend = topF * topF;              // quadratic: tips move most
           #ifdef USE_INSTANCING
             vec4 wPosPhase = instanceMatrix * vec4(transformed, 1.0);
             float phase = wPosPhase.x * 0.18 + wPosPhase.z * 0.14;
           #else
             float phase = transformed.x * 0.18 + transformed.z * 0.14;
           #endif
           float amp = uWindAmp;
           transformed.x += sin(uTime * 1.1 + phase) * amp * bend;
           transformed.z += cos(uTime * 0.9 + phase * 0.8) * amp * 0.7 * bend;
         }`,
      );

    // Prepend varying declarations to BOTH stages.
    shader.vertexShader =
      `varying vec3 vCanopyWorldNormal;
       varying vec3 vCanopyWorldPos;\n` + shader.vertexShader;

    // --- Fragment stage: additive warm backlight term ---
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform vec3 uSunDir;
         uniform vec3 uBacklightColor;
         uniform float uBacklightIntensity;
         varying vec3 vCanopyWorldNormal;
         varying vec3 vCanopyWorldPos;`,
      )
      .replace(
        '#include <color_fragment>',
        // <color_fragment> runs right after diffuseColor is initialized from
        // material color + vertex colors + map. Adding the backlight here means
        // it participates in the rest of the lighting pipeline as if the leaf
        // itself were emitting warm transmitted light — exactly the look of
        // sunlight scattering through a thin leaf. Additive in linear space.
        `#include <color_fragment>
         {
           vec3 N = normalize(vCanopyWorldNormal);
           vec3 V = normalize(cameraPosition - vCanopyWorldPos); // frag -> camera
           vec3 L = normalize(uSunDir);                          // toward sun
           // viewBack: 1 when the camera looks TOWARD the sun (frag is between
           // camera and sun, so V points opposite to L). This is the master
           // switch — the whole canopy mass only starts glowing as you turn
           // sunward, which is the defining golden-hour tree behavior.
           float viewBack = clamp(dot(V, -L), 0.0, 1.0);
           // Cheap thickness proxy: downward-facing undersides (N.y < 0) and
           // grazing silhouette edges read as thinner leaf, so boost them. This
           // prevents a flat uniform glow and concentrates the transmission on
           // the rim/underside where real leaves look most translucent.
           float thin = clamp(1.0 - N.y * 0.5, 0.6, 1.2);
           // Subtle grazing emphasis: faces nearly edge-on to the camera glow a
           // touch more (the silhouette rim of the canopy mass).
           float graze = 1.0 - clamp(dot(N, V), 0.0, 1.0);
           float thickness = mix(thin, thin * (0.7 + graze * 0.6), viewBack);
           float backlight = pow(viewBack, 1.6) * thickness * uBacklightIntensity;
           diffuseColor.rgb += uBacklightColor * backlight;
         }`,
      );
    // NOTE: no userData/canopyShader ref needed. The uTime uniform is bound via
    // the shared `uniforms` closure object (captured by onBeforeCompile), which
    // survives the material.clone() the forest builder performs — clones share
    // the same onBeforeCompile closure, hence the same windUniform binding, so
    // advancing this._windUniform.value in update() drives grass + all canopy
    // species in one coherent wind field.
  };

  // Mark custom as present so Three doesn't strip our varyings/uniforms.
  material.customProgramCacheKey = () => 'canopy-backlight-v1';
  return material;
}

// ---------------------------------------------------------------------------
// Geometry builders — return *non-instanced* mesh templates whose geometry is
// later fed into an InstancedMesh. Keep them low-poly but readable up close.
// ---------------------------------------------------------------------------

/** Conifer: tapered trunk + 3 stacked, downward-pointing cones (pine layers).
 *  sunDir/windUniform are forwarded to applyCanopyBacklight so the needle
 *  layers get the golden-hour translucency term + canopy-top wind. */
function buildConiferTemplate(leafTex, sunDir, windUniform) {
  const grp = new THREE.Group();

  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.22, 1.6, 6);
  trunkGeo.translate(0, 0.8, 0);
  const trunkMat = new THREE.MeshStandardMaterial({
    color: 0x5a3d22, roughness: 0.95, metalness: 0.0,
  });
  const trunk = new THREE.Mesh(trunkGeo, trunkMat);
  trunk.castShadow = true;
  grp.add(trunk);

  const cardLeafMat = new THREE.MeshStandardMaterial({
    color: 0x2f5d2a, roughness: 0.95, metalness: 0.0, map: leafTex,
    alphaMap: leafTex, alphaTest: 0.38,
    side: THREE.DoubleSide, transparent: true, depthWrite: true,
  });
  applyCanopyBacklight(cardLeafMat, sunDir, windUniform);

  const layers = [
    { r: 1.5, h: 2.0, y: 1.7 },
    { r: 1.15, h: 1.7, y: 2.9 },
    { r: 0.75, h: 1.3, y: 3.9 },
  ];
  for (const L of layers) {
    const cardH = L.h * 1.12;
    const cardW = L.r * 2.25;
    const cardGeo = new THREE.PlaneGeometry(cardW, cardH);
    cardGeo.translate(0, L.y + cardH * 0.42, 0);
    for (let a = 0; a < 3; a++) {
      const card = new THREE.Mesh(cardGeo, cardLeafMat);
      card.rotation.y = (a / 3) * Math.PI;
      grp.add(card);
    }
  }
  return grp;
}

/** Broadleaf: trunk + puffy cloud canopy (an icosphere with noise displacement
 *  baked into vertices, so it looks volumetric, not billboard-flat).
 *  sunDir/windUniform are forwarded to applyCanopyBacklight so the canopy
 *  puff-balls get the golden-hour translucency term + canopy-top wind. */
function buildBroadleafTemplate(leafTex, sunDir, windUniform) {
  const grp = new THREE.Group();

  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 2.2, 6);
  trunkGeo.translate(0, 1.1, 0);
  const trunkMat = new THREE.MeshStandardMaterial({
    color: 0x6b4a2c, roughness: 0.95, metalness: 0.0,
  });
  const trunk = new THREE.Mesh(trunkGeo, trunkMat);
  trunk.castShadow = true;
  grp.add(trunk);

  // Canopy built from a few overlapping jittered icospheres — reads as a cloud.
  // Smooth normals (no flatShading) so the displaced canopy reads as an organic
  // foliage cloud rather than a faceted low-poly prop.
  const leafMat = new THREE.MeshStandardMaterial({
    color: 0x4f7a2b, roughness: 0.85, metalness: 0.0, map: leafTex,
    vertexColors: true, // two-tone sunlit-top / shaded-bottom (see below)
  });
  // Inject the warm backlit translucency + canopy wind. Broadleaf benefits most
  // because its puffy cloud silhouette is exactly where rim-transmission reads.
  applyCanopyBacklight(leafMat, sunDir, windUniform);
  // Two-tone palette: warm sunlit crown vs cool shaded interior. Widened the
  // gap (sunTop brighter + warmer, shade deeper) so the cloud mass reads as a
  // 3D volume; the backlight then glows on the shaded silhouette rim.
  const sunTop = new THREE.Color(0xa3c856);     // brighter, warmer sun-warmed crown
  const shadeBottom = new THREE.Color(0x2a4517); // deeper cool shaded interior
  const puffs = [
    { p: [0, 3.0, 0], r: 1.7 },
    { p: [0.9, 2.7, 0.3], r: 1.1 },
    { p: [-0.8, 2.8, -0.4], r: 1.05 },
    { p: [0.2, 3.7, -0.5], r: 1.0 },
    { p: [-0.3, 3.4, 0.8], r: 0.95 },
  ];
  for (const pf of puffs) {
    const geo = new THREE.IcosahedronGeometry(pf.r, 1);
    // Displace vertices with value noise for an organic, non-spherical silhouette.
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const n = valueNoise2D(x * 1.7 + 50, z * 1.7 + 50) - 0.5;
      const k = 1 + n * 0.28;
      pos.setXYZ(i, x * k, y * k, z * k);
    }
    geo.computeVertexNormals();
    geo.translate(pf.p[0], pf.p[1], pf.p[2]);

    // Bake two-tone vertex colors weighted by world-space normal.y so the
    // upper crown catches warm light and the underside stays in cool shade.
    // Recompute normals after translate, then read in local space.
    const nrm = geo.attributes.normal;
    const vcount = pos.count;
    const colors = new Float32Array(vcount * 3);
    const tmp = new THREE.Color();
    for (let i = 0; i < vcount; i++) {
      // normal.y in [-1,1]; remap to [0,1] then bias so tops dominate.
      const up = clamp(nrm.getY(i) * 0.5 + 0.5, 0, 1);
      const w = Math.pow(up, 1.6); // sharpened (was 1.3): tighter sun cap, more shaded body
      tmp.copy(shadeBottom).lerp(sunTop, w);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    const m = new THREE.Mesh(geo, leafMat);
    m.castShadow = true;
    grp.add(m);
  }
  return grp;
}

/** Slim poplar/cypress: single tall narrow cone — silhouettes variety at
 *  distance. sunDir/windUniform are forwarded to applyCanopyBacklight so the
 *  tall cone gets the golden-hour translucency term + canopy-top wind. */
function buildPoplarTemplate(leafTex, sunDir, windUniform) {
  const grp = new THREE.Group();
  const trunkGeo = new THREE.CylinderGeometry(0.08, 0.14, 1.0, 5);
  trunkGeo.translate(0, 0.5, 0);
  const trunkMat = new THREE.MeshStandardMaterial({
    color: 0x4a3320, roughness: 0.95, metalness: 0.0,
  });
  const trunk = new THREE.Mesh(trunkGeo, trunkMat);
  trunk.castShadow = true;
  grp.add(trunk);

  const leafMat = new THREE.MeshStandardMaterial({
    color: 0x3c6b30, roughness: 0.9, metalness: 0.0, map: leafTex,
    vertexColors: true, // two-tone sunlit-top / shaded-bottom
  });
  // Inject the warm backlit translucency + canopy wind. The poplar's tall,
  // thin cone is the species that most obviously "lollipops" at distance; the
  // backlight term is what saves its silhouette against the sun.
  applyCanopyBacklight(leafMat, sunDir, windUniform);
  const sunTop = new THREE.Color(0x8ab855);     // brighter tip
  const shadeBottom = new THREE.Color(0x1f3a18); // deeper shade
  const cone = new THREE.ConeGeometry(0.7, 4.2, 7);
  cone.translate(0, 3.0, 0);
  cone.computeVertexNormals();
  {
    // Two-tone vertex colors (same approach as the conifer).
    const pos = cone.attributes.position;
    const nrm = cone.attributes.normal;
    const vcount = pos.count;
    const colors = new Float32Array(vcount * 3);
    const tmp = new THREE.Color();
    const yBase = 3.0, h = 4.2;
    for (let i = 0; i < vcount; i++) {
      const ny = nrm.getY(i);
      const yRel = (pos.getY(i) - yBase) / h;
      const up = clamp(ny * 0.5 + 0.5, 0, 1) * 0.6 + clamp(yRel, 0, 1) * 0.4;
      // Sharpened from 1.2 -> 1.5 so the sunlit cap is tighter and brighter,
      // leaving more deep-shaded body for the backlight to glow against.
      const w = Math.pow(up, 1.5);
      tmp.copy(shadeBottom).lerp(sunTop, w);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    cone.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  }
  const m = new THREE.Mesh(cone, leafMat);
  m.castShadow = true;
  grp.add(m);
  return grp;
}

// ===========================================================================
// ENVIRONMENT
// ===========================================================================
export class Environment {
  constructor({ terrain, road, seed = 1337, sunDir } = {}) {
    this.terrain = terrain;
    this.road = road;
    this.seed = seed;

    this.group = new THREE.Group();
    this.group.name = 'Environment';
    this._forestLOD = [];
    this.colliderGrid = new Map();

    // World extent — match the 4000m terrain (half-extent 2000).
    this.worldHalf = 2000;

    // Road corridor exclusion width (skip props/trees within this of the road).
    this.roadClearance = 14;

    // --- Sun direction (TOWARD the sun) for canopy backlight + wind. --------
    // Optional caller override (e.g. sky.sunDir). Defaults to the SAME static
    // golden-hour direction Sky.js uses (elevation 15°, azimuth 145°), matching
    // the self-contained pattern Car.js follows for its contact shadow. main.js
    // confirms sky.sunDir is static, so one baked direction is always correct.
    this._sunDir = sunDir ? sunDir.clone().normalize() : DEFAULT_SUN_DIR.clone();

    // --- Deterministic RNG stream per subsystem (stable, independent order). ---
    const rng = mulberry32(seed);
    this._rng = rng;

    // --- Cached, spatially-bucketed centerline for fast nearest-distance. ---
    this._centerline = this._buildCenterlineIndex(road.centerline());

    // --- Shared procedural textures (built once). ---
    this._grassTex = makeGrassTexture();
    this._leafTex = makeLeafTexture();

    // Shared wind time uniform, advanced in update() from dt. Reused by both
    // roadside grass and (subtly) by the canopy-top sway so all foliage moves
    // in the same wind field.
    this._windUniform = { value: 0.0 };

    // Build each layer. Order: far -> near so logs read top-down.
    this._buildMountains();
    this._buildForests();
    this._buildRocks();
    this._buildRoadsideGrass();
    // Crude box guardrails/signs/lamps disabled — superseded by RoadFurniture
    // (proper guardrails, gantry, chevrons) and Props (utility poles + wires).
    // this._buildRoadsideProps();

    // Mutable scratch for update().
    this._carXZ = new THREE.Vector2();
  }

  // -------------------------------------------------------------------------
  // Centerline spatial index: buckets centerline samples into a coarse grid so
  // "nearest centerline point" is O(1)-ish instead of O(N) per candidate.
  // -------------------------------------------------------------------------
  _buildCenterlineIndex(centerline) {
    const cell = 32;                       // meters per bucket
    const buckets = new Map();
    const key = (ix, iz) => ix * 100000 + iz;
    const points = [];
    for (const s of centerline || []) {
      const p = { x: s.x, z: s.z, heading: s.heading || 0 };
      points.push(p);
      const ix = Math.floor(p.x / cell), iz = Math.floor(p.z / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const k = key(ix + dx, iz + dz);
          let arr = buckets.get(k);
          if (!arr) { arr = []; buckets.set(k, arr); }
          arr.push(p);
        }
      }
    }
    return { cell, buckets, points, key };
  }

  _addTreeCollider(x, z, r) {
    const CELL = 24;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const k = `${cx},${cz}`;
    let arr = this.colliderGrid.get(k);
    if (!arr) { arr = []; this.colliderGrid.set(k, arr); }
    arr.push({ x, z, r });
  }

  /** Squared distance from (x,z) to the nearest centerline sample, plus that sample. */
  _nearestRoad(x, z) {
    const { cell, buckets, key } = this._centerline;
    const ix = Math.floor(x / cell), iz = Math.floor(z / cell);
    const arr = buckets.get(key(ix, iz));
    if (!arr || arr.length === 0) return { d2: Infinity, p: null };
    let best = Infinity, bestP = null;
    for (const p of arr) {
      const dx = p.x - x, dz = p.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; bestP = p; }
    }
    return { d2: best, p: bestP };
  }

  // -------------------------------------------------------------------------
  // 1. DISTANT MOUNTAINS — a fog-faded low-poly ridge line beyond the terrain
  //    edge. Two concentric rings (outer + inner) for parallax depth, with a
  //    baked vertical snow gradient (peaks lighten toward snow) and a WARM
  //    fog tint so the ridge seats into golden-hour haze instead of cold gray.
  // -------------------------------------------------------------------------
  _buildMountains() {
    const OUTER_RADIUS = 3000;     // outer ring: just outside the 4000m terrain
    const OUTER_COUNT = 34;        // was 26 -> denser ridge line
    const INNER_RADIUS = 2200;     // inner ring: closer, smaller, parallax depth
    const INNER_COUNT = 18;        // smaller, sits in front of the outer ring
    const COUNT = OUTER_COUNT + INNER_COUNT;

    // One shared geometry: a JAGGED MULTI-SEGMENT "ridge segment" rotated/scaled
    // per instance. A single base→peak→base triangle reads as a giant faceted
    // wedge against the sky at this distance (critic kill-list item), so the
    // profile is now a strip of COLS columns whose heights follow layered sine
    // ridges — many small sub-peaks per instance instead of one apex.
    const geo = new THREE.BufferGeometry();
    const positions = [];
    const indices = [];
    const W = 1;
    const COLS = 10;                       // profile resolution across the width
    const depth = -1;                      // strip thickness on z
    // Deterministic pseudo-random for the profile (no Math.random needed).
    let seed = 7;
    const prand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const colH = [];
    for (let c = 0; c <= COLS; c++) {
      const u = c / COLS;                  // 0..1 across the width
      // Layered sines = believable massif profile; edges taper to 0 so adjacent
      // instances blend into continuous ranges rather than sawtooth triangles.
      const edge = Math.sin(u * Math.PI);  // 0 at ends, 1 mid
      const h =
        0.55 * Math.abs(Math.sin(u * Math.PI * 2.0 + 0.7)) +
        0.30 * Math.abs(Math.sin(u * Math.PI * 5.0 + 2.1)) +
        0.15 * prand();
      colH.push(Math.max(h * (0.35 + 0.65 * edge), 0.06));
    }
    // Two rows of vertices (front z=0, back z=depth) -> extruded ribbon.
    for (const z of [0, depth]) {
      for (let c = 0; c <= COLS; c++) {
        positions.push(-W + (2 * W * c) / COLS, colH[c], z);
      }
    }
    for (let c = 0; c < COLS; c++) {
      const f0 = c, f1 = c + 1, b0 = COLS + 1 + c, b1 = COLS + 2 + c;
      indices.push(f0, b0, b1,  b1, f1, f0);
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    // Bake a VERTICAL snow gradient into vertex colors: higher columns lighten
    // toward snow; base vertices stay warm rock. Heights are no longer 0..1
    // (multi-segment profile), so normalize by the tallest column.
    const rockLow = new THREE.Color(0x6b5840);  // warm earthy base
    const snowHigh = new THREE.Color(0xf2ece0); // warm snow (not blue-white)
    let maxY = 0;
    for (let c = 0; c <= COLS; c++) maxY = Math.max(maxY, colH[c]);
    const vColors = new Float32Array(positions.length / 3 * 3);
    {
      const tmp = new THREE.Color();
      for (let v = 0; v < positions.length / 3; v++) {
        const t = clamp(positions[v * 3 + 1] / (maxY || 1), 0, 1);
        // Snow collects only on the upper portion of each ridge.
        const w = Math.pow(t, 2.6) * 0.8;      // softened: never pure white
        tmp.copy(rockLow).lerp(snowHigh, w);
        vColors[v * 3] = tmp.r;
        vColors[v * 3 + 1] = tmp.g;
        vColors[v * 3 + 2] = tmp.b;
      }
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(vColors, 3));

    // WARM base tone matching the scene fog (0xd9c4a0) so the ridge seats into
    // golden-hour haze — was cold 0x6f86a3. Unlit (MeshBasicMaterial) reads as
    // far atmosphere; exponential fog handles the horizon fade. Opaque (not
    // transparent) so depth-sorting is robust across both rings.
    const mat = new THREE.MeshBasicMaterial({
      color: 0xd9c4a0,            // warm haze tone, matches scene fog
      vertexColors: true,         // vertical snow gradient (baked above)
      fog: true,                  // critical: seats into the warm haze
    });

    const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    mesh.name = 'Mountains';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;  // ring should always render as backdrop

    const rng = this._rng;
    // Helper: lay out one ring of ridge segments.
    const layRing = (count, radius, isOuter, startIdx) => {
      for (let i = 0; i < count; i++) {
        const idx = startIdx + i;
        const ang = (i / count) * Math.PI * 2 + (rng() - 0.5) * 0.06;
        // Vary peak height & width so the ridge isn't a perfect crown.
        // Inner ring is deliberately smaller for parallax depth against the
        // outer ring when the camera moves.
        const hScale = isOuter ? 1.0 : 0.6;
        const wScale = isOuter ? 1.0 : 0.7;
        const h = (320 + rng() * 520) * hScale;
        const w = (600 + rng() * 700) * wScale;
        const x = Math.cos(ang) * radius;
        const z = Math.sin(ang) * radius;
        // Sit base around y=0 (terrain edge is low); peaks rise into the haze.
        const y = -40 + rng() * 30;
        // Face the ring inward (rotate triangle so its base faces center).
        const rotY = -ang + Math.PI / 2 + (rng() - 0.5) * 0.1;

        TMP_Q.setFromAxisAngle(UP, rotY);
        TMP_S.set(w, h, 1);        // z-scale = 1 (strip thickness, never zero)
        TMP_P.set(x, y, z);
        TMP_M.compose(TMP_P, TMP_Q, TMP_S);
        mesh.setMatrixAt(idx, TMP_M);

        // Per-instance warm atmospheric tint. Kept CLOSE to the fog color and
        // low-saturation: high-contrast tints made each instance silhouette as
        // a hard faceted wedge against the sky (critic kill-list). The ridges
        // should read as haze-layered masses, not lit geometry.
        const hNorm = clamp(h / 840, 0, 1);          // 0..1 normalized height
        const inner = isOuter ? 0.0 : 1.0;
        const lum = 0.84 + hNorm * 0.08 + inner * 0.04;
        const sat = 0.10 + rng() * 0.03;
        const tint = new THREE.Color().setHSL(
          0.09 + (rng() - 0.5) * 0.02,   // warm amber hue band
          sat,
          clamp(lum, 0, 1),
        );
        mesh.setColorAt(idx, tint);
      }
    };

    layRing(OUTER_COUNT, OUTER_RADIUS, true, 0);
    layRing(INNER_COUNT, INNER_RADIUS, false, OUTER_COUNT);

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    this.group.add(mesh);
    this._mountains = mesh;
  }

  // -------------------------------------------------------------------------
  // 2. FORESTS — 3 instanced tree species scattered across the terrain,
  //    excluding the road corridor and steep slopes.
  // -------------------------------------------------------------------------
  _buildForests() {
    const HALF = this.worldHalf;
    const leafTex = this._leafTex;
    const rng = this._rng;
    const sunDir = this._sunDir;
    const windUniform = this._windUniform;

    // Template groups -> we pull each child mesh's geometry+material into its
    // own InstancedMesh. Collect (geo, material, per-instance transforms).
    // sunDir + windUniform are passed so the leaf material gets the golden-hour
    // backlight injection + canopy-top wind (see applyCanopyBacklight).
    const species = [
      buildConiferTemplate(leafTex, sunDir, windUniform),
      buildBroadleafTemplate(leafTex, sunDir, windUniform),
      buildPoplarTemplate(leafTex, sunDir, windUniform),
    ];

    // For each species, an ordered list of "parts": {geo, mat, nearTransforms:[], farTransforms:[]}
    const partsBySpecies = species.map((tpl) => {
      const parts = [];
      tpl.traverse((obj) => {
        if (obj.isMesh) {
          parts.push({
            geo: obj.geometry,
            // Clone material so per-species instanceColor doesn't bleed across.
            mat: obj.material.clone(),
            nearTransforms: [],
            farTransforms: [],
          });
        }
      });
      return parts;
    });

    // Hero corridor: trees within 100m of the road centerline get real cast
    // shadows (capped per part so the shadow map stays cheap). Everything
    // farther out keeps castShadow=false — fog hides distant tree shadows anyway.
    const HERO_ROAD_RADIUS = 60;
    const HERO_SHADOW_CAP = 80;
    const heroRoadR2 = HERO_ROAD_RADIUS * HERO_ROAD_RADIUS;

    // Candidate scatter: grid jittered with noise so it doesn't look gridded.
    // Performance: STEP was 7 with density 0.55, which produced ~25K-37K
    // instances PER tree part (~330K total) — all rendered every frame because
    // InstancedMesh frustum culling uses the unit geometry's bounding sphere,
    // not instance positions. Combined with exponential fog hiding trees past
    // ~500m, that is enormous wasted vertex work. STEP 11 / density 0.4 cuts
    // the counts by ~3.5x while keeping the visible roadside + hero vista full
    // (the origin meadow + roadside grass are scattered separately and are
    // untouched). Measured: ~60 FPS sustained with the shadow-cast change below.
    const STEP = 11;                 // ~11m grid (was 7) -> fewer candidates
    const treeDensity = 0.40;        // was 0.55
    const slopeLimit = 0.62;         // skip if normal.y < this (too steep)

    for (let gx = -HALF; gx <= HALF; gx += STEP) {
      for (let gz = -HALF; gz <= HALF; gz += STEP) {
        // Jitter position with value noise for natural distribution.
        const jx = (valueNoise2D(gx * 0.13 + 10, gz * 0.13, this.seed) - 0.5) * STEP * 1.4;
        const jz = (valueNoise2D(gx * 0.13, gz * 0.13 + 90, this.seed) - 0.5) * STEP * 1.4;
        const x = gx + jx;
        const z = gz + jz;

        // Density modulated by large-scale noise -> clustered forest patches.
        const patch = fbm2D(x * 0.0016, z * 0.0016, { octaves: 3, seed: this.seed + 5 });
        const local = rng();
        if (local > treeDensity * (0.35 + patch * 1.1)) continue;

        // Exclude road surface corridor (trees too close to drive on).
        const { d2 } = this._nearestRoad(x, z);
        const clear = this.roadClearance;
        if (d2 < clear * clear) continue;

        // Hero corridor flag: within 100m of centerline (but past road clearance).
        const isHeroCorridor = d2 < heroRoadR2;

        // Height + slope.
        const y = this.terrain.getHeight(x, z);
        if (!isFinite(y)) continue;
        const n = terrainNormalAt(this.terrain, x, z, 1.5);
        if (n.y < slopeLimit) continue;

        // Pick a species (broadleaf favored in flatter lowlands, conifers on slopes).
        const slope = 1 - n.y;
        const speciesIdx = (rng() < 0.35 + slope * 0.4)
          ? 0                            // conifer on slopes
          : (rng() < 0.8 ? 1 : 2);       // else broadleaf, occasionally poplar

        // Per-instance transform.
        const scale = 0.75 + rng() * 0.9;
        const yRot = rng() * Math.PI * 2;
        const lean = (rng() - 0.5) * 0.06; // subtle tilt

        // Bolder per-instance color variance via instanceColor later: hue, sat
        // and luminance jitter all stored so the canopy reads as a living
        // meadow, not a flat painted sheet. (Critic found prior 0.4/0.5 too tame.)
        const parts = partsBySpecies[speciesIdx];
        const hueJ = (rng() - 0.5) * 0.15;     // ~±0.075 hue rotation
        const satJ = (rng() - 0.5) * 0.5;      // bold saturation spread
        const lumJ = (rng() - 0.5) * 0.55;     // noticeable luminance spread
        const scaleJitter = 0.9 + rng() * 0.25;

        this._addTreeCollider(x, z, 1.15 + scale * 0.75);

        for (let pi = 0; pi < parts.length; pi++) {
          const part = parts[pi];
          const t = { x, y, z, scale: scale * scaleJitter, yRot, lean, hueJ, satJ, lumJ };
          if (isHeroCorridor && part.nearTransforms.length < HERO_SHADOW_CAP) {
            part.nearTransforms.push(t);
          } else {
            part.farTransforms.push(t);
          }
        }
      }
    }

    // Helper: bake transforms into an InstancedMesh.
    const buildTreeInst = (part, transforms, castShadow) => {
      const n = transforms.length;
      if (n === 0) return null;
      const inst = new THREE.InstancedMesh(part.geo, part.mat, n);
      inst.castShadow = castShadow;
      inst.receiveShadow = true;
      inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);

      const useColor = part.mat.map != null;
      if (useColor) {
        const base = new THREE.Color().copy(part.mat.color);
        for (let i = 0; i < n; i++) {
          const t = transforms[i];
          const c = base.clone();
          // Hue/sat stay small absolute nudges; luminance must be RELATIVE
          // (multiplier), not an offsetHSL add — the leaf base sits at HSL
          // lightness ~0.27, and an additive −0.27 clamp-to-zero painted
          // half the forest pure black (instanceColor [0,0,0]).
          c.offsetHSL(t.hueJ, t.satJ * 0.35, 0);
          c.multiplyScalar(THREE.MathUtils.clamp(1 + t.lumJ, 0.6, 1.55));
          inst.setColorAt(i, c);

          TMP_Q.setFromAxisAngle(UP, t.yRot);
          if (t.lean !== 0) {
            TMP_Q.multiply(new THREE.Quaternion().setFromAxisAngle(
              new THREE.Vector3(1, 0, 0), t.lean));
          }
          const s = Math.max(t.scale, 0.05);
          TMP_S.set(s, s, s);
          TMP_P.set(t.x, t.y, t.z);
          TMP_M.compose(TMP_P, TMP_Q, TMP_S);
          inst.setMatrixAt(i, TMP_M);
        }
      } else {
        for (let i = 0; i < n; i++) {
          const t = transforms[i];
          TMP_Q.setFromAxisAngle(UP, t.yRot);
          const s = Math.max(t.scale, 0.05);
          TMP_S.set(s, s, s);
          TMP_P.set(t.x, t.y, t.z);
          TMP_M.compose(TMP_P, TMP_Q, TMP_S);
          inst.setMatrixAt(i, TMP_M);
        }
      }
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      let ax = 0, az = 0;
      for (let i = 0; i < n; i++) {
        ax += transforms[i].x;
        az += transforms[i].z;
      }
      this._forestLOD.push({ mesh: inst, x: ax / n, z: az / n, hero: castShadow });
      return inst;
    };

    // Flatten each part into hero (shadow) + distant (no shadow) meshes.
    for (const parts of partsBySpecies) {
      for (const part of parts) {
        const hero = buildTreeInst(part, part.nearTransforms, true);
        if (hero) {
          hero.name = 'ForestHero';
          this.group.add(hero);
        }
        const far = buildTreeInst(part, part.farTransforms, false);
        if (far) {
          far.name = 'Forest';
          this.group.add(far);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. ROCKS / BOULDERS — low-poly icosahedra, denser on slopes & roadsides.
  // -------------------------------------------------------------------------
  _buildRocks() {
    const HALF = this.worldHalf;
    const rng = this._rng;

    // Build a single noisy icosahedron geo (detail 1) — instances scale/rotate it.
    const baseGeo = new THREE.IcosahedronGeometry(1, 1);
    {
      const pos = baseGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const n = fbm2D(x * 1.5 + 200, z * 1.5 + 200, { octaves: 3, seed: this.seed + 9 });
        const k = 1 + (n - 0.5) * 0.5;
        pos.setXYZ(i, x * k, y * (0.8 + n * 0.4), z * k);
      }
      baseGeo.computeVertexNormals();
    }

    const mat = new THREE.MeshStandardMaterial({
      color: 0x8a8175,
      roughness: 0.95,
      metalness: 0.02,
      flatShading: true,
    });

    // Collect candidate transforms, then allocate exactly that many instances.
    const transforms = [];
    const STEP = 11;
    for (let gx = -HALF; gx <= HALF; gx += STEP) {
      for (let gz = -HALF; gz <= HALF; gz += STEP) {
        const jx = (valueNoise2D(gx * 0.2 + 33, gz * 0.2, this.seed + 2) - 0.5) * STEP;
        const jz = (valueNoise2D(gx * 0.2, gz * 0.2 + 44, this.seed + 3) - 0.5) * STEP;
        const x = gx + jx;
        const z = gz + jz;

        const y = this.terrain.getHeight(x, z);
        if (!isFinite(y)) continue;
        const n = terrainNormalAt(this.terrain, x, z, 1.5);

        // Density: higher on slopes; clusters near roadsides.
        const slope = 1 - n.y;
        const { d2 } = this._nearestRoad(x, z);
        const nearRoad = d2 < 60 * 60;
        let density = 0.06 + slope * 0.7;
        if (nearRoad) density += 0.25;
        if (rng() > density) continue;

        // Skip the road surface itself.
        if (d2 < (this.roadClearance - 1) * (this.roadClearance - 1)) continue;

        const scale = 0.5 + rng() * (nearRoad ? 1.6 : 3.0) + slope * 1.2;
        const yRot = rng() * Math.PI * 2;
        // Slight random axis tilt so they don't sit perfectly upright.
        const tilt = (rng() - 0.5) * 0.4;
        transforms.push({ x, y, z, scale, yRot, tilt, shade: 0.7 + rng() * 0.5 });
        this._addTreeCollider(x, z, 0.55 + scale * 0.55);
      }
    }

    const n = transforms.length;
    if (n === 0) return;
    const inst = new THREE.InstancedMesh(baseGeo, mat, n);
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    // Per-instance vertex colors won't vary per-instance on a shared geometry,
    // so we use instanceColor to tint rocks (mossy vs dry).
    const tmpC = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const t = transforms[i];
      TMP_Q.setFromAxisAngle(UP, t.yRot);
      TMP_Q.multiply(new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0.4).normalize(), t.tilt));
      const s = Math.max(t.scale, 0.05);
      TMP_S.set(s, s * (0.7 + (i % 3) * 0.12), s); // slightly squashed = boulder-like
      TMP_P.set(t.x, t.y + s * 0.2, t.z);          // sink slightly into ground
      TMP_M.compose(TMP_P, TMP_Q, TMP_S);
      inst.setMatrixAt(i, TMP_M);

      // Tint: warm earthy near roads, cooler/mossy on slopes.
      const mossy = clamp(t.shade, 0, 1);
      tmpC.setRGB(
        0.42 + (1 - mossy) * 0.18,
        0.40 + mossy * 0.10,
        0.34 + (1 - mossy) * 0.05,
      );
      inst.setColorAt(i, tmpC);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.name = 'Rocks';
    this.group.add(inst);
    this._rocks = inst;
  }

  // -------------------------------------------------------------------------
  // 4. ROADSIDE GRASS — cross-quad billboards with a procedural alpha texture,
  //    scattered in a band along the road and around the origin. AlphaTest keeps
  //    it cheap (no transparency sorting across instances).
  // -------------------------------------------------------------------------
  _buildRoadsideGrass() {
    const rng = this._rng;
    const centerline = this._centerline.points;
    if (!centerline || centerline.length === 0) return;

    // Build a cross-quad geometry (two intersecting quads) — 4 triangles.
    const W = 0.5, H = 1.0;
    const geo = new THREE.BufferGeometry();
    // Vertices: quad A (XY) + quad B (rotated 90°). Pivot at base (y=0).
    //   2---3          6---7
    //   | \ |          | \ |
    //   0---1          4---5      (quad B sits along Z axis)
    const positions = new Float32Array([
      -W, 0, 0,  W, 0, 0,  W, H, 0, -W, H, 0,   // quad A
      0, 0, -W,  0, 0, W,  0, H, W,  0, H, -W,  // quad B
    ]);
    const uvs = new Float32Array([
      0, 0,  1, 0,  1, 1,  0, 1,
      0, 0,  1, 0,  1, 1,  0, 1,
    ]);
    const indices = [
      0, 1, 2,  0, 2, 3,    // quad A (front)
      0, 2, 1,  0, 3, 2,    // quad A (back, double-sided)
      4, 5, 6,  4, 6, 7,    // quad B (front)
      4, 6, 5,  4, 7, 6,    // quad B (back)
    ];
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      map: this._grassTex,
      transparent: true,
      alphaTest: 0.15,            // softer cutout edges than 0.22 (less harsh alpha)
      roughness: 1.0,
      metalness: 0.0,
      color: 0x7fae45,            // lush green (was dry yellow-green 0xb9c97a)
      side: THREE.DoubleSide,
      depthWrite: true,
    });

    // --- Wind sway in the vertex shader ---
    // We inject a small amount of horizontal displacement on the TOP vertices
    // only (keyed by local position.y, which is 0 at the base and H at the
    // tip), driven by a uTime uniform the update() loop advances from dt. The
    // per-instance phase is derived from the instance's world position (read
    // from instanceMatrix) so each tuft sways out of phase with its neighbours.
    // No Date.now / Math.random is used for time. The wind uniform is created
    // once in the constructor and SHARED with the canopy-top sway so all
    // foliage moves in one coherent wind field.
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this._windUniform;
      // Uniforms available to both stages via the injected snippets below.
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uTime;`,
        )
        .replace(
          '#include <begin_vertex>',
          // transformed is the local vertex position Three computes here.
          // Wind factor: 0 at base (y=0), 1 at tip (y>=H). Sway in XZ.
          `#include <begin_vertex>
           {
             float hMax = ${H.toFixed(6)};
             float topF = clamp(transformed.y / hMax, 0.0, 1.0);
             float bend = topF * topF;              // quadratic: tips move most
             // Per-instance phase from world position (instanceMatrix column 3).
             vec4 wPos = instanceMatrix * vec4(transformed, 1.0);
             float phase = wPos.x * 0.35 + wPos.z * 0.27;
             float amp = 0.18;                       // max sway in world units
             float sway = sin(uTime * 1.6 + phase) * amp * bend;
             transformed.x += sway;
             transformed.z += cos(uTime * 1.25 + phase * 0.8) * amp * 0.6 * bend;
           }`,
        );
      this._grassShader = shader; // keep ref so the uniform binding stays live
    };

    // Walk the centerline and scatter tufts in a band on both sides.
    const transforms = [];
    const bandNear = this.roadClearance + 0.5;  // just off the road edge
    const bandFar = 42;                          // roadside grass band width
    const stepEvery = 2;                         // every Nth centerline sample

    for (let i = 0; i < centerline.length; i += stepEvery) {
      const c = centerline[i];
      const heading = c.heading || 0;
      // Perpendicular to road heading.
      const perpX = Math.cos(heading);
      const perpZ = -Math.sin(heading);

      // Scatter a handful of tufts at varying offsets on both sides.
      // Doubled from 7 -> 14 for a denser, lusher roadside verge.
      const tufts = 14;
      for (let k = 0; k < tufts; k++) {
        const side = rng() < 0.5 ? -1 : 1;
        const dist = bandNear + rng() * (bandFar - bandNear);
        const along = (rng() - 0.5) * stepEvery * 2.2; // spread along road between samples

        // Forward along road = (sin h, cos h); perp = (cos h, -sin h).
        const x = c.x + perpX * dist * side + Math.sin(heading) * along;
        const z = c.z + perpZ * dist * side + Math.cos(heading) * along;
        const y = this.terrain.getHeight(x, z);
        if (!isFinite(y)) continue;

        const s = 0.6 + rng() * 0.9;
        const yRot = rng() * Math.PI * 2;
        transforms.push({ x, y, z, s, yRot });
      }
    }

    // Also scatter a cluster around world origin for the starting vista.
    // Doubled from 900 -> 1800 so the hero vista reads as a full meadow,
    // not a sparse smattering of quads.
    const originCount = 1800;
    for (let i = 0; i < originCount; i++) {
      const ang = rng() * Math.PI * 2;
      const r = 6 + rng() * 70;
      const x = Math.cos(ang) * r;
      const z = Math.sin(ang) * r;
      // Keep off the road near origin.
      const { d2 } = this._nearestRoad(x, z);
      if (d2 < bandNear * bandNear) continue;
      const y = this.terrain.getHeight(x, z);
      if (!isFinite(y)) continue;
      transforms.push({ x, y, z, s: 0.6 + rng() * 0.9, yRot: rng() * Math.PI * 2 });
    }

    const n = transforms.length;
    if (n === 0) return;
    const inst = new THREE.InstancedMesh(geo, mat, n);
    inst.castShadow = false;        // grass casting shadows is noisy + costly
    inst.receiveShadow = true;
    inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    inst.name = 'Grass';

    const tmpC = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const t = transforms[i];
      TMP_Q.setFromAxisAngle(UP, t.yRot);
      const s = Math.max(t.s, 0.05);
      TMP_S.set(s, s, s);
      TMP_P.set(t.x, t.y, t.z);
      TMP_M.compose(TMP_P, TMP_Q, TMP_S);
      inst.setMatrixAt(i, TMP_M);

      // Slight per-tuft color variance for a meadow feel.
      const g = 0.62 + (rng() - 0.5) * 0.18;
      tmpC.setRGB(0.55 + g * 0.3, 0.70 + g * 0.2, 0.38 + g * 0.15);
      inst.setColorAt(i, tmpC);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    this.group.add(inst);
    this._grass = inst;
  }

  // -------------------------------------------------------------------------
  // 5. ROADSIDE PROPS — tasteful, sparse: guardrails on some segments, signs,
  //    hay bales, and occasional street lamps. Non-instanced (counts are low).
  // -------------------------------------------------------------------------
  _buildRoadsideProps() {
    const rng = this._rng;
    const centerline = this._centerline.points;
    if (!centerline || centerline.length === 0) return;

    // Shared materials.
    const railMat = new THREE.MeshStandardMaterial({
      color: 0xb5b9bf, roughness: 0.5, metalness: 0.6,
    });
    const postMat = new THREE.MeshStandardMaterial({
      color: 0x41464c, roughness: 0.7, metalness: 0.5,
    });
    const woodMat = new THREE.MeshStandardMaterial({
      color: 0xc9954a, roughness: 0.95, metalness: 0.0,
    });
    const signMat = new THREE.MeshStandardMaterial({
      color: 0xc2462f, roughness: 0.6, metalness: 0.0,
    });
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x2c2f33, roughness: 0.6, metalness: 0.7,
    });
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xfff0c8, roughness: 0.4, metalness: 0.0,
      emissive: 0xffcf7a, emissiveIntensity: 0.35, // subtle warmth (below bloom threshold)
    });

    // Reusable geometries.
    const railGeo = new THREE.BoxGeometry(4.0, 0.12, 0.08);
    const postGeo = new THREE.CylinderGeometry(0.05, 0.06, 1.0, 6);
    const hayGeo = new THREE.CylinderGeometry(0.8, 0.8, 1.4, 10);
    const signBoardGeo = new THREE.BoxGeometry(1.4, 0.9, 0.06);
    const poleGeo = new THREE.CylinderGeometry(0.07, 0.09, 4.0, 6);
    const lampHeadGeo = new THREE.SphereGeometry(0.18, 8, 6);

    const propsGroup = new THREE.Group();
    propsGroup.name = 'RoadsideProps';

    // Decide guardrail segments with noise — covers maybe ~30% of the road.
    const railSegments = new Set();
    for (let i = 0; i < centerline.length; i += 12) {
      if (valueNoise2D(i * 0.05, 0, this.seed + 11) > 0.55) {
        for (let k = 0; k < 12 && i + k < centerline.length; k++) railSegments.add(i + k);
      }
    }

    for (let i = 0; i < centerline.length; i++) {
      const c = centerline[i];
      const heading = c.heading || 0;
      const perpX = Math.cos(heading);
      const perpZ = -Math.sin(heading);
      const y = this.terrain.getHeight(c.x, c.z);
      if (!isFinite(y)) continue;

      // --- Guardrails on flagged segments, alternating side via hash. ---
      if (railSegments.has(i) && i % 3 === 0) {
        const side = (Math.floor(i / 3) % 2 === 0) ? 1 : -1;
        const off = (this.roadClearance - 1.5) * side;
        const rx = c.x + perpX * off;
        const rz = c.z + perpZ * off;
        const ry = this.terrain.getHeight(rx, rz);

        const rail = new THREE.Mesh(railGeo, railMat);
        rail.position.set(rx, ry + 0.7, rz);
        rail.rotation.y = -heading;
        rail.castShadow = true;
        propsGroup.add(rail);

        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(rx, ry + 0.5, rz);
        post.castShadow = true;
        propsGroup.add(post);
      }

      // --- Signs every ~60 samples. ---
      if (i % 60 === 12) {
        const side = rng() < 0.5 ? 1 : -1;
        const off = (this.roadClearance + 2.0) * side;
        const sx = c.x + perpX * off;
        const sz = c.z + perpZ * off;
        const sy = this.terrain.getHeight(sx, sz);

        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.set(sx, sy + 2.0, sz);
        pole.castShadow = true;
        propsGroup.add(pole);

        const board = new THREE.Mesh(signBoardGeo, signMat);
        board.position.set(sx, sy + 3.4, sz);
        board.rotation.y = -heading + Math.PI; // face oncoming traffic
        board.castShadow = true;
        propsGroup.add(board);
      }

      // --- Hay bales every ~45 samples, often clustered in 2-3. ---
      if (i % 45 === 24) {
        const side = rng() < 0.5 ? 1 : -1;
        const baseOff = (this.roadClearance + 1.5) * side;
        const cluster = 2 + Math.floor(rng() * 2);
        for (let h = 0; h < cluster; h++) {
          const off = baseOff + h * 1.7 * side;
          const hx = c.x + perpX * off;
          const hz = c.z + perpZ * off;
          const hy = this.terrain.getHeight(hx, hz);
          const hay = new THREE.Mesh(hayGeo, woodMat);
          hay.position.set(hx, hy + 0.8, hz);
          hay.rotation.set(0, rng() * Math.PI * 2, Math.PI / 2); // lying on side
          hay.castShadow = true;
          propsGroup.add(hay);
        }
      }

      // --- Street lamps every ~90 samples (sparse, dusk feel). ---
      if (i % 90 === 50) {
        const side = rng() < 0.5 ? 1 : -1;
        const off = (this.roadClearance + 2.5) * side;
        const lx = c.x + perpX * off;
        const lz = c.z + perpZ * off;
        const ly = this.terrain.getHeight(lx, lz);

        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.set(lx, ly + 2.0, lz);
        pole.castShadow = true;
        propsGroup.add(pole);

        const head = new THREE.Mesh(lampHeadGeo, lampMat);
        head.position.set(lx, ly + 4.0, lz);
        propsGroup.add(head);
      }
    }

    this.group.add(propsGroup);
    this._props = propsGroup;
  }

  // -------------------------------------------------------------------------
  // update — LOD/streaming + animation hook. Advances the grass wind uniform
  // from dt (no Date.now / Math.random). All instanced meshes are static and
  // frustum-culled per-instance by Three. The car parameter is reserved for
  // future distance-based visibility streaming.
  // -------------------------------------------------------------------------
  update(dt, car) {
    // Advance wind time purely from dt; clamp to avoid spiral-of-death jumps
    // after a long frame stall (e.g. tab refocus). dt is in seconds.
    // This single shared uniform drives BOTH the roadside grass sway AND the
    // canopy-top wind (see applyCanopyBacklight) — both onBeforeCompile
    // closures capture this same `this._windUniform` object, so one mutation
    // here updates every foliage shader in the scene.
    const step = isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
    if (this._windUniform) {
      this._windUniform.value += step;
      // Keep the grass shader's uniform binding live if onBeforeCompile captured
      // a separate ref (belt-and-suspenders; the shared object above is already
      // authoritative). Canopy does not need this — its closure binds directly.
      if (this._grassShader) this._grassShader.uniforms.uTime.value = this._windUniform.value;
    }
    if (car?.position && this._forestLOD?.length) {
      const px = car.position.x, pz = car.position.z;
      for (const e of this._forestLOD) {
        const d2 = (e.x - px) ** 2 + (e.z - pz) ** 2;
        const r = e.hero ? 340 : 520;
        e.mesh.visible = d2 < r * r;
      }
    }
  }
}
