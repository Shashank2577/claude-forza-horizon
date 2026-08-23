// TireSmoke.js — lightweight GPU smoke/dust particles for drifts and off-road.
// Instanced soft sprites at rear wheels; no external textures (radial alpha in shader).

import * as THREE from 'three';
import { clamp } from '../core/noise.js';

const MAX = 280;
const WHEEL_OFFSETS = [
  { x: -0.92, z: -1.31 }, // rear left
  { x: 0.92, z: -1.31 },  // rear right
];

const SmokeShader = {
  uniforms: {
    uMap: { value: null },
    uOpacity: { value: 0.55 },
    uDust: { value: 0.0 },
    uBoost: { value: 0.0 },
  },
  vertexShader: /* glsl */ `
    attribute float aLife;
    attribute float aSize;
    varying float vLife;
    void main() {
      vLife = aLife;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = aSize * (280.0 / -mv.z);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D uMap;
    uniform float uOpacity;
    uniform float uDust;
    uniform float uBoost;
    varying float vLife;
    void main() {
      vec2 uv = gl_PointCoord - 0.5;
      float d = length(uv);
      float alpha = texture2D(uMap, gl_PointCoord).a;
      alpha *= smoothstep(0.5, 0.0, d) * vLife * uOpacity;
      if (alpha < 0.02) discard;
      vec3 col = mix(vec3(0.75, 0.72, 0.68), vec3(0.45, 0.38, 0.32), vLife);
      col = mix(col, vec3(0.62, 0.48, 0.32), uDust);
      col = mix(col, vec3(1.0, 0.45, 0.12), uBoost * (1.0 - vLife));
      gl_FragColor = vec4(col, alpha);
    }
  `,
};

function makeSoftSpriteTexture() {
  const S = 64;
  const data = new Uint8Array(S * S * 4);
  const cx = S / 2, cy = S / 2, rMax = S / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / rMax;
      const a = d >= 1 ? 0 : Math.pow(1 - d, 2.2);
      const idx = (y * S + x) * 4;
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

export class TireSmoke {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'TireSmoke';
    scene.add(this.group);

    this._life = new Float32Array(MAX);
    this._size = new Float32Array(MAX);
    this._vel = Array.from({ length: MAX }, () => new THREE.Vector3());
    this._active = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    geo.setAttribute('aLife', new THREE.BufferAttribute(this._life, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this._size, 1));

    const map = makeSoftSpriteTexture();
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(SmokeShader.uniforms),
      vertexShader: SmokeShader.vertexShader,
      fragmentShader: SmokeShader.fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    mat.uniforms.uMap.value = map;

    this._points = new THREE.Points(geo, mat);
    this._points.frustumCulled = false;
    this.group.add(this._points);

    this._posAttr = geo.attributes.position;
    this._scratch = new THREE.Vector3();
    this._emitAcc = 0;
  }

  /** Emit burst at world position. */
  _emit(x, y, z, heading, lateral, intensity) {
    if (this._active >= MAX) this._active = 0;
    const i = this._active++;
    this._posAttr.setXYZ(i, x, y, z);
    const spread = 0.8 + intensity * 1.2;
    const vx = Math.sin(heading) * -2.5 + lateral * 0.4 + (Math.random() - 0.5) * spread;
    const vz = Math.cos(heading) * -2.5 + (Math.random() - 0.5) * spread;
    const vy = 0.6 + Math.random() * 1.8 * intensity;
    this._vel[i].set(vx, vy, vz);
    this._life[i] = 0.55 + intensity * 0.45;
    this._size[i] = 18 + intensity * 28;
  }

  update(dt, car, road = null, opts = {}) {
    if (!car) return;
    const boosting = !!opts.boosting;
    const slip = car.slip || 0;
    const speed = Math.abs(car.speed || 0);
    const heading = car.heading || 0;
    const h = Math.sin(heading), c = Math.cos(heading);
    const rx = c, rz = -h;

    const roadDist = road
      ? road.distanceToCenterline(car.position.x, car.position.z)
      : 0;
    const offRoad = roadDist > 9;
    this._points.material.uniforms.uDust.value = offRoad ? 1 : 0;
    this._points.material.uniforms.uBoost.value = boosting ? 1 : 0;

    const emitRate = slip > 2 ? slip * 12 + speed * 0.15 : (offRoad && speed > 6 ? speed * 0.25 : 0);
    this._emitAcc += emitRate * dt;
    while (this._emitAcc >= 1 && (slip > 1.5 || (offRoad && speed > 6))) {
      this._emitAcc -= 1;
      const intensity = clamp(slip / 14, 0.2, 1);
      for (const w of WHEEL_OFFSETS) {
        const lx = w.x, lz = w.z;
        const wx = car.position.x + h * lz + rx * lx;
        const wz = car.position.z + c * lz + rz * lx;
        const wy = car.position.y + 0.12;
        this._emit(wx, wy, wz, heading, (Math.random() - 0.5) * slip * 0.08, intensity);
      }
    }

    if (boosting && speed > 4) {
      this._emitAcc += 18 * dt;
      while (this._emitAcc >= 1) {
        this._emitAcc -= 1;
        const wx = car.position.x - h * 2.1;
        const wz = car.position.z - c * 2.1;
        const wy = car.position.y + 0.35;
        this._emit(wx, wy, wz, heading, 0, 0.85);
        const p = this._active - 1;
        if (p >= 0) {
          this._life[p] = 0.35;
          this._vel[p].set(
            (Math.random() - 0.5) * 2,
            1.5 + Math.random() * 2,
            (Math.random() - 0.5) * 2,
          );
        }
      }
    }

    const pos = this._posAttr.array;
    for (let i = 0; i < MAX; i++) {
      if (this._life[i] <= 0) {
        this._life[i] = 0;
        this._size[i] = 0;
        pos[i * 3 + 1] = -9999;
        continue;
      }
      this._life[i] -= dt * (0.55 + this._life[i] * 0.35);
      const v = this._vel[i];
      pos[i * 3] += v.x * dt;
      pos[i * 3 + 1] += v.y * dt;
      pos[i * 3 + 2] += v.z * dt;
      v.y += 1.2 * dt;
      v.x *= 1 - dt * 0.8;
      v.z *= 1 - dt * 0.8;
      this._size[i] += dt * 22;
    }
    this._posAttr.needsUpdate = true;
    this._points.geometry.attributes.aLife.needsUpdate = true;
    this._points.geometry.attributes.aSize.needsUpdate = true;
  }

  /** Lighter smoke for AI rivals (drift bursts only). */
  updateOthers(dt, cars, road = null) {
    if (!cars?.length) return;
    for (const car of cars) {
      if (!car?.group?.visible) continue;
      const slip = car.slip || 0;
      const speed = Math.abs(car.speed || 0);
      if (slip < 3 || speed < 10) continue;
      const heading = car.heading || 0;
      const h = Math.sin(heading), c = Math.cos(heading);
      const rx = c, rz = -h;
      const roadDist = road
        ? road.distanceToCenterline(car.position.x, car.position.z)
        : 0;
      const offRoad = roadDist > 9;
      this._emitAcc += (slip * 4 + speed * 0.06) * dt;
      while (this._emitAcc >= 1) {
        this._emitAcc -= 1;
        const intensity = clamp(slip / 16, 0.15, 0.7);
        for (const w of WHEEL_OFFSETS) {
          const lx = w.x, lz = w.z;
          const wx = car.position.x + h * lz + rx * lx;
          const wz = car.position.z + c * lz + rz * lx;
          const wy = car.position.y + 0.12;
          this._emit(wx, wy, wz, heading, 0, intensity * (offRoad ? 1.1 : 0.85));
        }
      }
    }
  }
}
