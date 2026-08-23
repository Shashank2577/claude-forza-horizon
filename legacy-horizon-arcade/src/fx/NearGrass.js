// NearGrass.js — dense instanced grass blades in a halo around the car (FH ground cover).

import * as THREE from 'three';
import { valueNoise2D } from '../core/noise.js';

const COUNT = 1200;
const RADIUS = 28;

export class NearGrass {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.group.name = 'NearGrass';
    scene.add(this.group);

    const geo = new THREE.PlaneGeometry(0.35, 0.9);
    geo.translate(0, 0.45, 0);

    const tex = this._makeAlpha();
    const mat = new THREE.MeshStandardMaterial({
      map: tex, alphaMap: tex, alphaTest: 0.35,
      color: 0x6faa48, roughness: 1, metalness: 0,
      side: THREE.DoubleSide, transparent: true, depthWrite: true,
    });

    this._mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    this._mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._mesh.frustumCulled = false;
    this.group.add(this._mesh);

    this._dummy = new THREE.Object3D();
    this._seed = 1337;
    this._cx = 0;
    this._cz = 0;
    this._scatter(0, 0);
  }

  _makeAlpha() {
    const S = 32;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, S, 0, 0);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.9)');
    grd.addColorStop(1, 'rgba(255,255,255,1)');
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _scatter(cx, cz) {
    this._cx = cx; this._cz = cz;
    for (let i = 0; i < COUNT; i++) {
      const a = (i / COUNT) * Math.PI * 2 + valueNoise2D(i, this._seed, { seed: this._seed }) * 0.5;
      const r = Math.sqrt(Math.random()) * RADIUS;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      const y = (this.terrain?.getHeight(x, z) || 0) + 0.02;
      this._dummy.position.set(x, y, z);
      this._dummy.rotation.y = a + Math.random() * 0.8;
      this._dummy.rotation.z = (Math.random() - 0.5) * 0.08;
      this._dummy.scale.setScalar(0.7 + Math.random() * 0.6);
      this._dummy.updateMatrix();
      this._mesh.setMatrixAt(i, this._dummy.matrix);
    }
    this._mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt, car) {
    if (!car?.position) return;
    const dx = car.position.x - this._cx;
    const dz = car.position.z - this._cz;
    if (dx * dx + dz * dz > 36) this._scatter(car.position.x, car.position.z);
  }
}
