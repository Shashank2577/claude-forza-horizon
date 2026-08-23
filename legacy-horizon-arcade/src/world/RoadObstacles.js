// RoadObstacles.js — barrels, cones, and hay bales on/near the asphalt for
// open-world collision and visual landmarks (FH-style roadside clutter).

import * as THREE from 'three';
import { valueNoise2D } from '../core/noise.js';

const CELL = 24;

export class RoadObstacles {
  constructor({ terrain, road, seed = 1337, colliderGrid = null }) {
    this.group = new THREE.Group();
    this.group.name = 'RoadObstacles';
    this.colliderGrid = colliderGrid;

    const maxD = road.totalLength();
    const barrelGeo = new THREE.CylinderGeometry(0.42, 0.48, 0.95, 12);
    const coneGeo = new THREE.ConeGeometry(0.28, 0.72, 10);
    const baleGeo = new THREE.CylinderGeometry(0.55, 0.55, 1.2, 12);
    baleGeo.rotateZ(Math.PI / 2);

    const barrelMat = new THREE.MeshStandardMaterial({
      color: 0xc45a12, roughness: 0.55, metalness: 0.35,
    });
    const coneMat = new THREE.MeshStandardMaterial({
      color: 0xff6a00, roughness: 0.5, metalness: 0.1, emissive: 0x331100, emissiveIntensity: 0.15,
    });
    const baleMat = new THREE.MeshStandardMaterial({
      color: 0xc9a54e, roughness: 0.9, metalness: 0.0,
    });

    // Roadside flavor only — every obstacle sits on the shoulder (off the
    // driving line) so the lane stays clear and the road is playable. Nothing
    // is placed in the driving lane (that made the road unpassable).
    let placed = 0;
    for (let d = 260; d < maxD - 250 && placed < 24; d += 360 + valueNoise2D(d * 0.01, seed * 0.01, seed) * 160) {
      const s = road.sampleAtDistance(d);
      if (!s) continue;
      const kindRoll = valueNoise2D(d * 0.03, seed * 0.02 + 3, seed + 3);
      const side = valueNoise2D(d * 0.02, seed * 0.02 + 9, seed + 9) > 0.5 ? 1 : -1;
      const lateral = side * (8.2 + valueNoise2D(d, seed * 0.01 + 5, seed + 5) * 1.4);

      const rx = Math.cos(s.heading), rz = -Math.sin(s.heading);
      const x = s.position.x + rx * lateral;
      const z = s.position.z + rz * lateral;
      const y = (terrain.getHeight(x, z) || s.position.y);

      let mesh;
      let radius;
      if (kindRoll < 0.38) {
        mesh = new THREE.Mesh(barrelGeo, barrelMat);
        mesh.position.set(x, y + 0.48, z);
        radius = 0.7;
      } else if (kindRoll < 0.72) {
        mesh = new THREE.Mesh(coneGeo, coneMat);
        mesh.position.set(x, y + 0.36, z);
        radius = 0.45;
      } else {
        mesh = new THREE.Mesh(baleGeo, baleMat);
        mesh.position.set(x, y + 0.55, z);
        mesh.rotation.y = s.heading + side * 0.4;
        radius = 0.95;
      }
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this._addCollider(x, z, radius);
      placed++;
    }
  }

  _addCollider(x, z, r) {
    if (!this.colliderGrid) return;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const k = `${cx},${cz}`;
    let arr = this.colliderGrid.get(k);
    if (!arr) { arr = []; this.colliderGrid.set(k, arr); }
    arr.push({ x, z, r });
  }
}
