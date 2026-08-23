// ImpactSparks.js — short orange spark bursts when the car hits barriers/trees.

import * as THREE from 'three';

const MAX = 64;

export class ImpactSparks {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'ImpactSparks';
    scene.add(this.group);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    geo.setAttribute('aLife', new THREE.BufferAttribute(new Float32Array(MAX), 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float aLife;
        varying float vLife;
        void main() {
          vLife = aLife;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (6.0 + aLife * 10.0) * (180.0 / -mv.z);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vLife;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          float a = (1.0 - d * 2.0) * vLife;
          vec3 col = mix(vec3(1.0, 0.85, 0.35), vec3(1.0, 0.35, 0.05), 1.0 - vLife);
          gl_FragColor = vec4(col, a);
        }
      `,
    });

    this._points = new THREE.Points(geo, mat);
    this._points.frustumCulled = false;
    this.group.add(this._points);
    this._life = geo.attributes.aLife.array;
    this._pos = geo.attributes.position;
    this._vel = Array.from({ length: MAX }, () => new THREE.Vector3());
    this._idx = 0;
    this._prevImpact = 0;
  }

  burst(x, y, z, intensity = 0.6) {
    const n = 8 + Math.floor(intensity * 10);
    for (let k = 0; k < n; k++) {
      const i = this._idx;
      this._idx = (this._idx + 1) % MAX;
      this._pos.setXYZ(i, x, y + 0.4, z);
      this._vel[i].set(
        (Math.random() - 0.5) * 12 * intensity,
        2 + Math.random() * 8 * intensity,
        (Math.random() - 0.5) * 12 * intensity,
      );
      this._life[i] = 0.55 + Math.random() * 0.4;
    }
    this._pos.needsUpdate = true;
    this._points.geometry.attributes.aLife.needsUpdate = true;
  }

  update(dt, car) {
    const impact = Number(car?.impact) || 0;
    if (impact > 0.35 && this._prevImpact < 0.2 && car?.position) {
      this.burst(car.position.x, car.position.y, car.position.z, impact);
    }
    this._prevImpact = impact;

    const arr = this._pos.array;
    for (let i = 0; i < MAX; i++) {
      if (this._life[i] <= 0) {
        arr[i * 3 + 1] = -999;
        continue;
      }
      this._life[i] -= dt * 2.8;
      const v = this._vel[i];
      arr[i * 3] += v.x * dt;
      arr[i * 3 + 1] += v.y * dt;
      arr[i * 3 + 2] += v.z * dt;
      v.y -= 18 * dt;
    }
    this._pos.needsUpdate = true;
    this._points.geometry.attributes.aLife.needsUpdate = true;
  }
}
