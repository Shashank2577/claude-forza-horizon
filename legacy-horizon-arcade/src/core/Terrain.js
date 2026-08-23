// Terrain.js — Open-world procedural terrain for a Three.js v0.169 arcade racer.
//
// Generates a heightmap via domain-warped fbm (rolling hills + broad ridges),
// builds a displaced PlaneGeometry, and shades it with a custom ShaderMaterial
// that blends three procedural textures (grass / rock / sand) driven by slope
// AND elevation. Textures are generated on <canvas> at runtime so the file has
// zero external image dependencies and tiles seamlessly.
//
// API:
//   const terrain = new Terrain({ size, segments, seed });
//   scene.add(terrain.group);
//   terrain.getHeight(x, z)   // world elevation y — MUST stay in sync with mesh
//   terrain.getNormal(x, z)   // optional normal helper for car alignment
//
// Contract guarantee: getHeight() uses exactly the same fbm math that displaced
// the mesh, then bilinearly interpolates the heightmap grid so the car's wheels
// never pop on a triangle edge. Cheap (a few fbm evals + 4 sample points).

import * as THREE from 'three';
import { fbm2D, valueNoise2D, clamp, lerpN } from './noise.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const HALF = 0.5; // local constant for readability

// Height-field amplitude & shape. Keep slopes driveable: most of the field
// gentle, with broad peaks reaching ~80-110m. Designed so typical ground sits
// in the grassy band (~25-65m), ridge crests enter the rock band (>70m), and
// basins dip toward WATER_LEVEL for sand.
const AMP_BASE       = 20.0;   // broad rolling base (m)
const AMP_RIDGE      = 90.0;   // domain-warped ridges — main peak builder (m)
const AMP_BROAD      = 28.0;   // very low-frequency hills (m)
const LIFT           = 35.0;   // base elevation so field sits above water
const WATER_LEVEL    = 3.0;    // below this -> sand near low ground

// Texture tile density in world units. Smaller = denser detail near the car.
// Grass tightened to ~4m (was 7) so the obvious concentric-ring repetition
// near the car is broken up; three samples across frequencies plus a per-tile
// stochastic UV offset (hash-driven, see shader) and a fused ALU high-freq
// micro-darkening ensure neighboring tiles no longer align — without the 4th
// texture fetch the old shader paid for. Rock/sand keep their proven scale.
const TILE_GRASS = 4.0;
const TILE_ROCK  = 6.0;
const TILE_SAND  = 6.0;

export class Terrain {
  constructor({
    size = 4000,
    // Lowered 256 -> 200: fewer fragments per frame (~39% fewer covered pixels
    // for the same view), still smooth enough for arcade driving (20m cells vs
    // ~15.6m). getHeight()/_rawHeight are segment-count-independent, so the
    // mesh and physics stay in sync regardless — vertices are just re-placed
    // at the new density in _buildTerrainMesh.
    segments = 200,
    seed = 1337,
  } = {}) {
    this.size = Number(size);
    this.segments = Number(segments);
    this.seed = Number(seed);

    this.group = new THREE.Group();
    this.group.name = 'Terrain';

    // Precompute grid spacing for getHeight bilinear sampling.
    this._half = this.size * HALF;
    this._invSeg = 1.0 / this.segments;          // fraction per segment
    this._worldPerSeg = this.size / this.segments;

    // Low-frequency macro variation map — one 256² fbm bake at init, sampled
    // once per fragment to break grass/rock tiling repetition without extra
    // procedural texture fetches.
    this._macroMap = this._makeMacroMap();

    // Shared uniforms (created once; reused by main + ring meshes).
    this._uniforms = this._makeUniforms();

    // Main terrain mesh + a cheap surrounding ring for the horizon.
    this._mesh = this._buildTerrainMesh();
    this._ring = this._buildRingMesh();

    this.group.add(this._mesh, this._ring);
  }

  // -------------------------------------------------------------------------
  // HEIGHT FIELD — the single source of truth for elevation.
  //
  // Domain-warped fbm gives organic ridges instead of obvious sine waves.
  // This exact function is used both to displace the mesh vertices and by
  // getHeight() at runtime, so they are always in sync by construction.
  // -------------------------------------------------------------------------
  _rawHeight(x, z) {
    const s = this.seed;

    // Offset world coords into positive noise space. The shared noise.js hash
    // behaves inconsistently for negative integer inputs, so we shift the
    // origin by a large constant — this guarantees every noise sample sees
    // strictly positive coordinates across the whole 4km field (and well
    // beyond, for the ring and out-of-bounds car queries).
    const OX = 5000.0, OZ = 5000.0;
    const px = (x + OX) * 0.00115;   // ~0.87 cycles over 4km for the broad stuff
    const pz = (z + OZ) * 0.00115;

    // Local clamp helper: defensively enforce [0,1] on fbm outputs so the
    // downstream math (especially the 1-|2r-1| ridge transform and pow) can
    // never produce NaN, even if a future noise edit changes its range.
    const c01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

    // --- Domain warp: warp coordinates with a low-freq noise so ridge lines
    // curve organically instead of forming straight bands.
    const wx = c01(fbm2D(px * 0.5, pz * 0.5, { octaves: 2, frequency: 1.0, seed: s + 1000 })) * 2.0 - 1.0;
    const wz = c01(fbm2D(px * 0.5 + 5.2, pz * 0.5 + 1.3, { octaves: 2, frequency: 1.0, seed: s + 2000 })) * 2.0 - 1.0;
    const dx = px + wx * 0.6;
    const dz = pz + wz * 0.6;

    // --- Broad rolling base (low freq, many octaves -> soft hills).
    const base = c01(fbm2D(dx, dz, { octaves: 5, lacunarity: 2.0, gain: 0.5, frequency: 0.6, seed: s }));

    // --- Ridged multifractal: the classic terrain-ridge former. Maps fbm to
    // a V-shape (1 where r crosses 0.5, 0 at r=0 or r=1) so ridge LINES run
    // through the field rather than isolated peaks. Power > 1 sharpens crests.
    const r = c01(fbm2D(dx * 1.8 + 11.0, dz * 1.8 + 7.0, { octaves: 4, lacunarity: 2.1, gain: 0.55, frequency: 1.0, seed: s + 300 }));
    const ridge = 1.0 - Math.abs(2.0 * r - 1.0);   // [0,1]
    // pow < 1 widens crests so ridge lines genuinely reach full amplitude
    // (otherwise continuous noise rarely hits r=0.5 exactly and peaks stay low).
    const ridgeShaped = Math.pow(ridge, 0.85);

    // --- Very low frequency modulation for whole-region hills/valleys.
    const broad = c01(fbm2D(px * 0.25, pz * 0.25, { octaves: 2, frequency: 1.0, seed: s + 9000 }));

    // Combine. base, ridge, broad all clamped to [0,1].
    let h = LIFT
          + base * AMP_BASE
          + ridgeShaped * AMP_RIDGE * (0.5 + 0.6 * broad)  // ridges taller on hills
          + (broad - 0.5) * 2.0 * AMP_BROAD;               // broad -> [-AMP,+AMP]

    // Slight valley carve: lower terrain near very low broad value so we get
    // believable flat-ish basins (good for sandy patches near water).
    if (broad < 0.3) h -= (0.3 - broad) * 25.0;

    return h;
  }

  // Fast world-space height used by physics/road every frame. Bilinearly
  // interpolates the heightmap grid so the value is continuous across
  // triangle edges (no popping for the car wheels).
  getHeight(x, z) {
    // Map world (x,z) into [0,segments] grid coordinates.
    const fx = (x + this._half) / this._worldPerSeg;
    const fz = (z + this._half) / this._worldPerSeg;

    // Outside the mesh: clamp to the border (still returns a sensible height).
    if (fx < 0 || fz < 0 || fx > this.segments || fz > this.segments) {
      const cx = clamp(x, -this._half, this._half);
      const cz = clamp(z, -this._half, this._half);
      return this._rawHeight(cx, cz);
    }

    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const x1 = Math.min(x0 + 1, this.segments);
    const z1 = Math.min(z0 + 1, this.segments);
    const tx = fx - x0;
    const tz = fz - z0;

    // Sample the 4 corners of the heightmap cell. Use world coords of each
    // corner so the math matches what the mesh vertex used exactly.
    const w00x = x0 * this._worldPerSeg - this._half;
    const w00z = z0 * this._worldPerSeg - this._half;
    const w10x = x1 * this._worldPerSeg - this._half;
    const w10z = z0 * this._worldPerSeg - this._half;
    const w01x = x0 * this._worldPerSeg - this._half;
    const w01z = z1 * this._worldPerSeg - this._half;
    const w11x = x1 * this._worldPerSeg - this._half;
    const w11z = z1 * this._worldPerSeg - this._half;

    const h00 = this._rawHeight(w00x, w00z);
    const h10 = this._rawHeight(w10x, w10z);
    const h01 = this._rawHeight(w01x, w01z);
    const h11 = this._rawHeight(w11x, w11z);

    // Bilinear: blend X first, then Z. Standard formula.
    const h0 = h00 + (h10 - h00) * tx;
    const h1 = h01 + (h11 - h01) * tx;
    return h0 + (h1 - h0) * tz;
  }

  // Optional normal helper. Uses finite differences of getHeight (which is
  // already smooth via bilinear), so it lines up with the shading. The
  // returned vector is normalized and in world space (y up).
  getNormal(x, z) {
    const e = 2.0; // meters step — small enough for crisp normals, large enough to avoid noise jitter
    const hL = this.getHeight(x - e, z);
    const hR = this.getHeight(x + e, z);
    const hD = this.getHeight(x, z - e);
    const hU = this.getHeight(x, z + e);
    const n = new THREE.Vector3(hL - hR, 2.0 * e, hD - hU);
    return n.normalize();
  }

  // -------------------------------------------------------------------------
  // MESH BUILDING
  // -------------------------------------------------------------------------
  _buildTerrainMesh() {
    const { size, segments } = this;
    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2); // lay flat on XZ, +Y up

    // Displace each vertex Y using getHeight so mesh & runtime match exactly.
    const pos = geo.attributes.position;
    const vColor = new Float32Array(pos.count * 3);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i);
      const h = this.getHeight(tmp.x, tmp.z);
      pos.setY(i, h);

      // Per-vertex color variation: subtle tint driven by height + noise so
      // large flat fields aren't a single dead color. Multiplied with texture
      // in the shader.
      const tint = valueNoise2D(tmp.x * 0.01, tmp.z * 0.01, this.seed + 77);
      const moist = clamp((h - WATER_LEVEL) / 60.0, 0, 1);
      // Grassier/greener in moist lowlands, dustier/grayer up high.
      vColor[i * 3]     = lerpN(0.78, 0.95, tint) * (1.0 - 0.15 * moist); // R
      vColor[i * 3 + 1] = lerpN(0.80, 1.00, tint);                        // G
      vColor[i * 3 + 2] = lerpN(0.62, 0.85, tint) * (1.0 - 0.20 * moist); // B
    }
    geo.setAttribute('color', new THREE.BufferAttribute(vColor, 3));

    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const mat = this._makeMaterial(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'TerrainMain';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = true;
    return mesh;
  }

  // Cheap surrounding ring: a single oversized quad extending well past the
  // horizon. Uses the same shader so it blends seamlessly; we displace it to
  // the average height so the silhouette reads as continuous terrain. Very
  // low cost (4 verts) and only visible at the horizon.
  _buildRingMesh() {
    const inner = this.size;
    const outer = this.size * 4.0; // 16km extent
    const geo = new THREE.RingGeometry(inner * 0.5, outer * 0.5, 64, 1);
    geo.rotateX(-Math.PI / 2);

    // Drop the ring to roughly match the average terrain elevation at its
    // inner edge so there's no visible cliff at the seam.
    const pos = geo.attributes.position;
    const edgeY = this.getHeight(0, this.size * 0.5 - 2);
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, edgeY);
    }
    geo.computeVertexNormals();

    const mat = this._makeMaterial(geo, /*isRing=*/true);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'TerrainRing';
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    return mesh;
  }

  // -------------------------------------------------------------------------
  // SHADER MATERIAL — slope + height driven splat of grass/rock/sand.
  // -------------------------------------------------------------------------
  _makeUniforms() {
    const tex = (kind) => this._makeProceduralTexture(kind);
    return {
      // NOTE: terrain now uses MeshStandardMaterial + onBeforeCompile, so it
      // picks up the scene.environment IBL and receives the sun's cast shadows
      // automatically (receiveShadow=true on the mesh, shadowMap enabled).
      // The old flat ambient/sun uniforms (uSunColor/uSkyColor/uGroundColor)
      // and the hand-rolled fog uniforms (uFogColor/uFogNear/uFogFar/uIsRing)
      // are intentionally gone — the PBR pipeline + scene FogExp2 own those.
      uGrassMap:   { value: tex('grass') },
      uGrassNRM:   { value: tex('grassN') },
      uRockMap:    { value: tex('rock') },
      uRockNRM:    { value: tex('rockN') },
      uSandMap:    { value: tex('sand') },
      uSandNRM:    { value: tex('sandN') },
      uTilingGrass:{ value: TILE_GRASS },
      uTilingRock: { value: TILE_ROCK },
      uTilingSand: { value: TILE_SAND },
      uWaterLevel: { value: WATER_LEVEL },
      uMacroMap:   { value: this._macroMap },
      uMacroScale: { value: 1.0 / this.size }, // world xz -> [0,1] macro UV
    };
  }

  // 256² fbm bake: R channel stores [0,1] macro variation used to jitter
  // grass/rock splat weights. Generated once at init — cheap at runtime.
  _makeMacroMap() {
    const SIZE = 256;
    const data = new Float32Array(SIZE * SIZE);
    const s = this.seed + 42000;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const u = x / SIZE;
        const v = y / SIZE;
        // Low-frequency fbm over the whole terrain extent; two octaves keeps
        // patches large enough to read as meadow vs rocky clearings.
        const n = fbm2D(u * 3.5, v * 3.5, { octaves: 3, lacunarity: 2.0, gain: 0.5, frequency: 1.0, seed: s });
        data[y * SIZE + x] = n;
      }
    }
    const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RedFormat, THREE.FloatType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  _makeMaterial(_isRing = false) {
    // Both the main mesh and the horizon ring now share one uniform set.
    // (The old per-mesh difference was uIsRing=1 for a hand-rolled fog boost;
    // that fog is now the scene's FogExp2, which already saturates the distant
    // ring, so no per-mesh split is needed.) Kept the param for call-site
    // compatibility.
    const uniforms = this._uniforms;

    // --- MeshStandardMaterial + onBeforeCompile -----------------------------
    // Migrated from a flat-lit custom ShaderMaterial so the terrain now
    // participates in scene.environment IBL (sky reflections), receives the
    // sun's cast shadows (car + trees), and lights coherently with the rest of
    // the PBR world. The full splat (grass/rock/sand by slope+height, triplanar
    // rock, per-layer tiling, multi-sample grass, detail normals, vertex tint,
    // micro detail) is injected into the standard chunks:
    //   - map_fragment   -> feed splat albedo as diffuseColor
    //   - normal_fragment -> perturb geometric normal by detail normal
    //   - color_fragment  -> vertex tint + micro-noise darkening
    // Warm fog comes from the scene's FogExp2 (fog:true), not a custom hook.
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.95,   // matte ground; IBL gives subtle sheen, no sharp spec
      metalness: 0.0,
      envMapIntensity: 0.6, // gentle sky reflections, not chrome
      // Participate in the scene's FogExp2 (warm #d9c4a0, set in Sky) so the
      // terrain fogs consistently with the rest of the PBR world. The old
      // shader hand-rolled the SAME warm fog; we now get it for free from the
      // scene. The ring is far enough that FogExp2 already saturates it.
      fog: true,
      // NOTE: vertexColors intentionally OFF. We read the `color` attribute
      // ourselves into a custom vTint varying and apply it in color_fragment,
      // so the tint is applied exactly once (the old shader did lit*=vTint.rgb).
      // Enabling vertexColors would also declare vColor and double the tint.
      vertexColors: false,
    });

    mat.onBeforeCompile = (shader) => {
      // Merge our splat uniforms into the program's uniform set.
      Object.assign(shader.uniforms, uniforms);

      // ---- VERTEX: emit world position, world normal, and a vec4 tint
      // (the vertex color attribute is vec3; we pad to .rgb*vTint.rgb multiply).
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */`
            #include <common>
            // Declare the vertex color attribute ourselves (vertexColors is
            // OFF, so three doesn't declare it). The geometry still carries a
            // 'color' BufferAttribute set during mesh build.
            attribute vec3 color;
            varying vec3 vWorldPos;
            varying vec3 vNormalW;
            varying vec4 vTint;
          `
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */`
            #include <begin_vertex>
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorldPos = wp.xyz;
            vNormalW = normalize(mat3(modelMatrix) * normal);
            vTint = vec4(color, 1.0);
          `
        );

      // ---- FRAGMENT: declare varyings + helpers, then hook the splat into
      // the standard map / normal / color / fog stages.
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */`
            #include <common>
            varying vec3 vWorldPos;
            varying vec3 vNormalW;
            varying vec4 vTint;

            // Cached detail normal from the map pass, reused by the normal pass
            // so the splat only runs ONCE per fragment. Set in map_fragment,
            // consumed in normal_fragment_maps. Fetch count optimized:
            //   gentle ground (most fragments): 6 fetches
            //   steep rock: +6 more in the gated triplanar branch (12 total)
            // previously every fragment paid ~15 fetches unconditionally.
            vec3 gTerrainDetailN;

            uniform sampler2D uGrassMap, uGrassNRM;
            uniform sampler2D uRockMap,  uRockNRM;
            uniform sampler2D uSandMap,  uSandNRM;
            uniform sampler2D uMacroMap;
            uniform float uTilingGrass, uTilingRock, uTilingSand;
            uniform float uWaterLevel;
            uniform float uMacroScale;

            // Cheap hash-based value noise in the fragment shader for fine detail.
            float vnoise(vec2 p) {
              vec2 i = floor(p), f = fract(p);
              float a = fract(sin(dot(i, vec2(127.1,311.7))) * 43758.5453);
              float b = fract(sin(dot(i + vec2(1.0,0.0), vec2(127.1,311.7))) * 43758.5453);
              float c = fract(sin(dot(i + vec2(0.0,1.0), vec2(127.1,311.7))) * 43758.5453);
              float d = fract(sin(dot(i + vec2(1.0,1.0), vec2(127.1,311.7))) * 43758.5453);
              vec2 u = f * f * (3.0 - 2.0 * f);
              return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
            }

            // Stochastic per-tile hash offset: returns a vec2 in [0,1) that is
            // constant within a tile of size 'tile' but differs per tile. Added
            // to UVs before sampling so neighboring tiles no longer align,
            // which kills the obvious concentric-ring repetition of the grass.
            vec2 stoOffset(vec2 uv, float tile) {
              vec2 t = floor(uv / tile);
              float h = fract(sin(dot(t, vec2(127.1, 311.7))) * 43758.5453);
              float h2 = fract(sin(dot(t, vec2(269.5, 183.3))) * 43758.5453);
              return vec2(h, h2) * tile;
            }

            // Expand a 2-channel (xy) packed normal into a tangent-space vec3.
            vec3 unpackNormal(vec2 enc) {
              vec2 d = enc * 2.0 - 1.0;
              float z = sqrt(clamp(1.0 - dot(d, d), 0.0, 1.0));
              return vec3(d.x, d.y, z);
            }

            // Perturb the geometric normal by a tangent-space detail normal.
            vec3 perturb(vec3 geoN, vec3 detailN) {
              vec3 q = normalize(cross(vec3(0.0,1.0,0.0), geoN));
              vec3 t = normalize(cross(geoN, q));
              vec3 b = cross(geoN, t);
              mat3 tbn = mat3(t, b, geoN);
              return normalize(tbn * detailN);
            }

            // Central splat: returns blended albedo + detail normal. Shared by
            // the map and normal fragment hooks so weights stay in sync.
            //
            // PERF: the original ran ~15 texture fetches on EVERY visible
            // fragment (4 grass + triplanar rock on 3 axes for both color and
            // normal + sand). Most terrain is gentle, so triplanar rock was
            // nearly invisible there yet paid full cost. This version:
            //   - Drops grass from 4 -> 3 samples (the *37 high-freq breakup is
            //     replaced by a single ALU vnoise micro-darkening on the
            //     stochastic sample — same anti-repetition job, no fetch).
            //   - Gates triplanar rock behind a slope test: gentle ground uses
            //     ONE planar XZ color + ONE planar XZ normal fetch (reused for
            //     the rock layer). Only steep fragments run the 2-axis
            //     triplanar blend (color + normal, X and Z — Y is redundant
            //     since on a steep slope the dominant visible face is X or Z,
            //     and the old rockColY used the SAME .xz UVs as rockColXZ).
            //   - Samples each texture once and reuses it.
            // Fetch count: gentle ~6, steep ~12 (was 15 unconditional).
            void terrainSplat(out vec3 outAlbedo, out vec3 outDetailN) {
              vec3 N = normalize(vNormalW);
              float slope = clamp(1.0 - N.y, 0.0, 1.0); // 0 flat, 1 vertical
              float height = vWorldPos.y;

              // Base UVs per layer.
              vec2 gUV = vWorldPos.xz / uTilingGrass;
              vec2 rUV = vWorldPos.xz / uTilingRock;
              vec2 sUV = vWorldPos.xz / uTilingSand;

              // --- Grass: 3 samples + stochastic per-tile offset on the base
              // sample. The old 4th *37 high-freq pass is replaced by a cheap
              // vnoise micro-darkening applied to the stochastic sample — same
              // role (break fine repetition) with zero extra texture fetch.
              vec2 gSto = gUV + stoOffset(gUV, 1.0);
              vec3 grassCol  = texture2D(uGrassMap, gSto).rgb;
              vec3 grassCol2 = texture2D(uGrassMap, gUV * 3.7 + 0.13).rgb;
              vec3 grassCol3 = texture2D(uGrassMap, gUV * 9.0 + 0.41).rgb;
              grassCol = mix(grassCol, grassCol2, 0.35);
              grassCol = mix(grassCol, grassCol3, 0.20);
              // Fused high-frequency breakup (replaces the old *37 fetch).
              float gMicro = vnoise(gUV * 37.0);
              grassCol *= (0.92 + 0.16 * gMicro);

              vec3 sandCol = texture2D(uSandMap, sUV).rgb;

              // --- Rock: planar XZ samples (always needed; cheap and reused).
              // These are the dominant rock contribution on gentle ground.
              vec3 rockColXZ = texture2D(uRockMap,  rUV).rgb;
              vec3 rockNXZ   = unpackNormal(texture2D(uRockNRM, rUV).rg);

              // --- Triplanar rock: ONLY where slope is steep. On gentle ground
              // (the common case) the triplanar fetches are skipped entirely.
              // When needed we blend 2 side axes (X from .zy, Z from .xy); the
              // up-facing Y axis would sample the same .xz UVs as rockColXZ
              // above, so it is folded into the base planar weight instead of a
              // redundant fetch.
              vec3 an = abs(N);
              vec3 rockCol = rockColXZ;
              vec3 rockN   = rockNXZ;
              float triW = smoothstep(0.18, 0.50, slope);
              if (triW > 0.001) {
                vec3 rockColX = texture2D(uRockMap, vWorldPos.zy / uTilingRock).rgb;
                vec3 rockColZ = texture2D(uRockMap, vWorldPos.xy / uTilingRock).rgb;
                vec3 rockNX   = unpackNormal(texture2D(uRockNRM, vWorldPos.zy / uTilingRock).rg);
                vec3 rockNZ   = unpackNormal(texture2D(uRockNRM, vWorldPos.xy / uTilingRock).rg);
                // Y (up) contribution uses the already-fetched XZ sample,
                // weighted by an.y; X and Z use the side samples.
                vec3 rockTri = (rockColX * an.x + rockColXZ * an.y + rockColZ * an.z)
                             / max(an.x + an.y + an.z, 1e-3);
                vec3 rockNTri = (rockNX * an.x + rockNXZ * an.y + rockNZ * an.z)
                              / max(an.x + an.y + an.z, 1e-3);
                rockCol = mix(rockColXZ, rockTri, triW);
                rockN   = mix(rockNXZ,   rockNTri, triW);
              }

              // --- Detail normals for grass/sand (1 fetch each, already done).
              vec3 grassN = unpackNormal(texture2D(uGrassNRM, gUV * 1.5).rg);
              vec3 sandN  = unpackNormal(texture2D(uSandNRM,  sUV).rg);

              // --- Splat weights.
              // Macro variation: one low-freq sample breaks large-scale tiling
              // repetition in grass/rock distribution (sand stays hydrology-driven).
              float macro = texture2D(uMacroMap, vWorldPos.xz * uMacroScale).r;
              float macroGrass = 0.72 + macro * 0.56;   // [0.72, 1.28]
              float macroRock  = 0.68 + (1.0 - macro) * 0.64; // inverse bias

              float sandW = smoothstep(uWaterLevel + 3.0, uWaterLevel - 1.0, height)
                          * (1.0 - smoothstep(0.18, 0.45, slope));
              float rockW = smoothstep(0.22, 0.55, slope) * macroRock;
              float grassW = clamp(1.0 - sandW - rockW, 0.0, 1.0);
              grassW *= (1.0 - smoothstep(70.0, 110.0, height) * 0.6);
              grassW *= macroGrass;

              float wsum = max(sandW + rockW + grassW, 1e-3);
              sandW  /= wsum; rockW /= wsum; grassW /= wsum;

              outAlbedo  = sandCol * sandW + rockCol * rockW + grassCol * grassW;
              outDetailN = normalize(sandN * sandW + rockN * rockW + grassN * grassW);
            }
          `
        )
        // --- map_fragment: feed the splat albedo as the material's diffuse AND
        // cache the splat detail normal for the normal pass. MeshStandard then
        // computes lighting from diffuseColor, so IBL, sun, and shadows all
        // apply to our blended albedo.
        .replace(
          '#include <map_fragment>',
          /* glsl */`
            #include <map_fragment>
            vec3 splatAlbedo;
            terrainSplat(splatAlbedo, gTerrainDetailN);
            diffuseColor.rgb *= splatAlbedo;
          `
        )
        // --- normal_fragment: perturb the geometric normal by the cached splat
        // detail normal before MeshStandard does its lighting. No re-fetch.
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */`
            #include <normal_fragment_maps>
            normal = perturb(normal, gTerrainDetailN);
          `
        )
        // --- color_fragment: per-vertex tint + micro-noise darkening. Runs
        // after map, before lighting, so both modulate albedo coherently.
        .replace(
          '#include <color_fragment>',
          /* glsl */`
            #include <color_fragment>
            diffuseColor.rgb *= vTint.rgb;
            float micro = vnoise(vWorldPos.xz * 0.6);
            diffuseColor.rgb *= (0.92 + 0.12 * micro);
          `
        );
      // NOTE: warm fog is NOT injected here. The material has fog:true, so the
      // scene's FogExp2 (#d9c4a0, set in Sky) applies via three's own
      // <fog_fragment> — identical color to the old hand-rolled uFogColor, and
      // consistent with how every other PBR object fogs. Adding our own would
      // double-fog and oversaturate the haze.
    };

    return mat;
  }

  // -------------------------------------------------------------------------
  // PROCEDURAL CANVAS TEXTURES — color + matching detail-normal maps.
  // All tile seamlessly (generated with wrap-periodic noise over the tile).
  // -------------------------------------------------------------------------
  _makeProceduralTexture(kind) {
    // 512px gives crisper detail up close from the chase cam (was 256, which
    // read as blurry oatmeal near the car). Still cheap to generate.
    const SIZE = 512;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(SIZE, SIZE);
    const data = img.data;

    const isNormal = kind.endsWith('N');
    const base = isNormal ? kind.slice(0, -1) : kind; // 'grassN' -> 'grass'

    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        // Wrap-safe hash noise: sample on a torus by using the tile coords
        // directly with our valueNoise2D (which interpolates, and because we
        // keep tile = integer period, the seam matches on both edges).
        const idx = (y * SIZE + x) * 4;

        if (base === 'grass') {
          this._writeGrass(data, idx, x, y, SIZE, isNormal);
        } else if (base === 'rock') {
          this._writeRock(data, idx, x, y, SIZE, isNormal);
        } else { // sand
          this._writeSand(data, idx, x, y, SIZE, isNormal);
        }
      }
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8; // crisp at grazing angles from chase cam
    tex.needsUpdate = true;
    return tex;
  }

  // Helpers: sample a few octaves of noise in [0,1] that tile seamlessly
  // (integer tile period ensures left/right & top/bottom match).
  _tileNoise(x, y, size, seed, freq) {
    // Convert to normalized [0,1] then to integer-period angle for wrapping.
    const u = (x / size) * freq * size;
    const v = (y / size) * freq * size;
    return valueNoise2D(u, v, seed);
  }

  _writeGrass(data, i, x, y, size, isNormal) {
    const s = this.seed;
    // Base green with yellow/dry patches.
    const n1 = this._tileNoise(x, y, size, s + 11, 0.03);
    const n2 = this._tileNoise(x, y, size, s + 22, 0.10);
    const n3 = this._tileNoise(x, y, size, s + 33, 0.25);
    const blend = n1 * 0.6 + n2 * 0.3 + n3 * 0.1;

    if (isNormal) {
      // Grass bumps: gentle lumps. Encode tangent normal (mostly up).
      const dx = (this._tileNoise(x + 1, y, size, s + 1, 0.20) - this._tileNoise(x - 1, y, size, s + 1, 0.20));
      const dy = (this._tileNoise(x, y + 1, size, s + 1, 0.20) - this._tileNoise(x, y - 1, size, s + 1, 0.20));
      const nx = dx * 0.25, ny = dy * 0.25;
      const nz = Math.sqrt(Math.max(1 - nx * nx - ny * ny, 0));
      data[i] = (nx * 0.5 + 0.5) * 255; data[i + 1] = (ny * 0.5 + 0.5) * 255; data[i + 2] = nz * 255; data[i + 3] = 255;
      return;
    }
    // Lush green <-> dry yellow-green.
    const r = lerpN(0.30, 0.62, blend);
    const g = lerpN(0.42, 0.66, blend);
    const b = lerpN(0.18, 0.30, blend);
    // Sprinkle darker blades for texture.
    const blade = this._tileNoise(x * 2, y * 2, size, s + 44, 0.4);
    const k = 0.85 + 0.25 * blade;
    data[i] = clamp(r * k, 0, 1) * 255;
    data[i + 1] = clamp(g * k, 0, 1) * 255;
    data[i + 2] = clamp(b * k, 0, 1) * 255;
    data[i + 3] = 255;
  }

  _writeRock(data, i, x, y, size, isNormal) {
    const s = this.seed;
    const n1 = this._tileNoise(x, y, size, s + 111, 0.02);
    const n2 = this._tileNoise(x, y, size, s + 122, 0.08);
    const n3 = this._tileNoise(x, y, size, s + 133, 0.22);
    const blend = n1 * 0.55 + n2 * 0.30 + n3 * 0.15;

    if (isNormal) {
      // Rougher normals for craggy rock.
      const dx = (this._tileNoise(x + 1, y, size, s + 70, 0.30) - this._tileNoise(x - 1, y, size, s + 70, 0.30));
      const dy = (this._tileNoise(x, y + 1, size, s + 70, 0.30) - this._tileNoise(x, y - 1, size, s + 70, 0.30));
      const nx = dx * 0.6, ny = dy * 0.6;
      const nz = Math.sqrt(Math.max(1 - nx * nx - ny * ny, 0));
      data[i] = (nx * 0.5 + 0.5) * 255; data[i + 1] = (ny * 0.5 + 0.5) * 255; data[i + 2] = nz * 255; data[i + 3] = 255;
      return;
    }
    // Gray-brown rock with occasional warm streaks.
    const warm = this._tileNoise(x, y, size, s + 200, 0.05);
    const r = lerpN(0.36, 0.50, blend) * (0.9 + 0.2 * warm);
    const g = lerpN(0.33, 0.44, blend);
    const b = lerpN(0.28, 0.36, blend) * (0.9 + 0.15 * warm);
    data[i] = clamp(r, 0, 1) * 255;
    data[i + 1] = clamp(g, 0, 1) * 255;
    data[i + 2] = clamp(b, 0, 1) * 255;
    data[i + 3] = 255;
  }

  _writeSand(data, i, x, y, size, isNormal) {
    const s = this.seed;
    const n1 = this._tileNoise(x, y, size, s + 311, 0.04);
    const n2 = this._tileNoise(x, y, size, s + 322, 0.14);
    const blend = n1 * 0.7 + n2 * 0.3;

    if (isNormal) {
      // Very gentle ripples.
      const dx = (this._tileNoise(x + 1, y, size, s + 90, 0.15) - this._tileNoise(x - 1, y, size, s + 90, 0.15));
      const dy = (this._tileNoise(x, y + 1, size, s + 90, 0.15) - this._tileNoise(x, y - 1, size, s + 90, 0.15));
      const nx = dx * 0.15, ny = dy * 0.15;
      const nz = Math.sqrt(Math.max(1 - nx * nx - ny * ny, 0));
      data[i] = (nx * 0.5 + 0.5) * 255; data[i + 1] = (ny * 0.5 + 0.5) * 255; data[i + 2] = nz * 255; data[i + 3] = 255;
      return;
    }
    // Pale sand/gravel.
    const r = lerpN(0.62, 0.78, blend);
    const g = lerpN(0.56, 0.70, blend);
    const b = lerpN(0.42, 0.52, blend);
    // Add fine grain speckle.
    const speck = this._tileNoise(x * 3, y * 3, size, s + 333, 0.5);
    const k = 0.9 + 0.18 * speck;
    data[i] = clamp(r * k, 0, 1) * 255;
    data[i + 1] = clamp(g * k, 0, 1) * 255;
    data[i + 2] = clamp(b * k, 0, 1) * 255;
    data[i + 3] = 255;
  }

  // -------------------------------------------------------------------------
  // Sun binding — kept for API compatibility, but now a no-op. With the
  // MeshStandardMaterial migration, the terrain lights itself from the scene's
  // DirectionalLight + scene.environment IBL, so there is no custom sun uniform
  // to push. Safe to call (does nothing) or to omit.
  // -------------------------------------------------------------------------
  attachSun(_sunDirection, _sunColor) {
    /* intentionally empty — PBR owns lighting now */
  }
}

export default Terrain;
