// WaterBodies.js — reflective lake planes in terrain basins (FH coastal/oasis vibe).

import * as THREE from 'three';
import { valueNoise2D } from '../core/noise.js';

const WATER_Y = 3.0;

const WaterShader = {
  uniforms: {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2) },
    uColorDeep: { value: new THREE.Color(0x1a4a6e) },
    uColorShallow: { value: new THREE.Color(0x3a8ab8) },
  },
  vertexShader: /* glsl */ `
    uniform float uTime;
    varying vec2 vUv;
    varying vec3 vWorldPos;
    void main() {
      vUv = uv;
      vec3 p = position;
      float wave = sin(p.x * 0.15 + uTime * 1.2) * 0.08 + sin(p.z * 0.12 - uTime * 0.9) * 0.06;
      p.y += wave;
      vec4 wp = modelMatrix * vec4(p, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uSunDir;
    uniform vec3 uColorDeep;
    uniform vec3 uColorShallow;
    varying vec2 vUv;
    varying vec3 vWorldPos;
    void main() {
      float depth = smoothstep(0.0, 1.0, length(vUv - 0.5) * 2.0);
      vec3 col = mix(uColorShallow, uColorDeep, depth * 0.65);
      vec3 n = normalize(vec3(0.02, 1.0, 0.01));
      vec3 sun = normalize(uSunDir);
      float spec = pow(max(dot(n, sun), 0.0), 48.0) * 0.85;
      col += vec3(1.0, 0.95, 0.85) * spec;
      float fresnel = pow(1.0 - max(dot(n, vec3(0,1,0)), 0.0), 3.0) * 0.15;
      col += vec3(0.7, 0.85, 1.0) * fresnel;
      gl_FragColor = vec4(col, 0.82);
    }
  `,
};

export class WaterBodies {
  constructor({ terrain, seed = 1337, sunDir, envMap = null }) {
    this.group = new THREE.Group();
    this.group.name = 'WaterBodies';
    this._mats = [];
    this._meshBases = [];
    this._lakes = [];
    this._time = 0;

    if (sunDir) WaterShader.uniforms.uSunDir.value.copy(sunDir);

    const half = terrain.size * 0.5;
    let placed = 0;
    for (let i = 0; i < 48 && placed < 10; i++) {
      const nx = valueNoise2D(i * 3.7, seed + 50, { seed });
      const nz = valueNoise2D(i * 2.1, seed + 90, { seed });
      const x = (nx * 0.75 + 0.125) * terrain.size - half;
      const z = (nz * 0.75 + 0.125) * terrain.size - half;
      const h = terrain.getHeight(x, z);
      if (h > WATER_Y + 12 || h < WATER_Y - 4) continue;

      const radius = 35 + valueNoise2D(x, z, { seed: seed + 200 }) * 55;
      const geo = new THREE.CircleGeometry(radius, 32);
      geo.rotateX(-Math.PI / 2);

      let mesh;
      if (envMap) {
        const pmat = new THREE.MeshPhysicalMaterial({
          color: 0x3a8ab8,
          metalness: 0.92,
          roughness: 0.06,
          transparent: true,
          opacity: 0.86,
          envMap,
          envMapIntensity: 1.6,
          clearcoat: 1.0,
          clearcoatRoughness: 0.04,
        });
        mesh = new THREE.Mesh(geo, pmat);
        this._meshBases.push({ mesh, baseY: WATER_Y });
      } else {
        const mat = new THREE.ShaderMaterial({
          uniforms: THREE.UniformsUtils.clone(WaterShader.uniforms),
          transparent: true,
          depthWrite: false,
        });
        mesh = new THREE.Mesh(geo, mat);
        this._mats.push(mat);
      }
      mesh.position.set(x, WATER_Y, z);
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this._lakes.push({ x, z, r: radius });
      placed++;
    }
  }

  /** True if world (x,z) is over a lake disk. */
  contains(x, z) {
    for (const L of this._lakes) {
      const dx = x - L.x, dz = z - L.z;
      if (dx * dx + dz * dz < L.r * L.r) return true;
    }
    return false;
  }

  update(dt, sunDir) {
    this._time += dt;
    for (const mat of this._mats) {
      mat.uniforms.uTime.value = this._time;
      if (sunDir) mat.uniforms.uSunDir.value.copy(sunDir);
    }
    for (const { mesh, baseY } of this._meshBases) {
      mesh.position.y = baseY + Math.sin(this._time * 1.2 + mesh.position.x * 0.02) * 0.05;
    }
  }
}
