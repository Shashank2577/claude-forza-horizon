// Settlements.js — farmstead clusters set back from the road: gabled cottages,
// big red barns, ONE spinning windmill per cluster (the visual anchor), a water
// tower, and grain silos. Self-contained (procedural canvas textures, no assets).
//
// API:  new Settlements({ terrain, road, seed })
//   .group                 → THREE.Group (add once)
//   .update(dt, carPos)    → spins animated rotors (windmill); safe to call each frame
// terrain.getHeight(x,z) → world y;  road.sampleAtDistance(d) → { position, heading }
// Conventions: forward=(sin h,0,cos h), right=(cos h,0,-sin h).

import * as THREE from 'three';
import { TAU } from '../core/noise.js';

const HALF_WIDTH = 6.5;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── textures (cached per instance) ───────────────────────────────────────────
function makeWallTexture(base, streak) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = base; x.fillRect(0, 0, 128, 128);
  // weatherboard horizontal lines
  x.strokeStyle = streak; x.lineWidth = 1.5; x.globalAlpha = 0.5;
  for (let y = 8; y < 128; y += 11) { x.beginPath(); x.moveTo(0, y); x.lineTo(128, y); x.stroke(); }
  x.globalAlpha = 0.18;
  for (let i = 0; i < 60; i++) {
    x.fillStyle = Math.random() > 0.5 ? '#000000' : '#ffffff';
    x.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
}
function makeRoofTexture(color) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = color; x.fillRect(0, 0, 128, 128);
  x.strokeStyle = 'rgba(0,0,0,0.35)'; x.lineWidth = 1;
  for (let row = 0; row < 10; row++) {
    const y = row * 13 + 6;
    const off = (row % 2) * 6;
    for (let col = -1; col < 11; col++) { x.strokeRect(col * 13 + off, y - 6, 13, 13); }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
}
function makeBarnTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#7a1a14'; x.fillRect(0, 0, 128, 128); // weathered barn red
  x.strokeStyle = 'rgba(0,0,0,0.4)'; x.lineWidth = 2;
  for (let bx = 0; bx < 128; bx += 16) { x.beginPath(); x.moveTo(bx, 0); x.lineTo(bx, 128); x.stroke(); }
  // vertical plank seams darker
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
}
function makeStoneTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#8d8479'; x.fillRect(0, 0, 128, 128);
  x.strokeStyle = 'rgba(40,36,30,0.6)'; x.lineWidth = 2;
  // irregular stone courses
  const rows = 6;
  for (let r = 0; r < rows; r++) {
    const y0 = (r / rows) * 128, y1 = ((r + 1) / rows) * 128;
    x.beginPath(); x.moveTo(0, y0); x.lineTo(128, y0); x.stroke();
    let px = 0;
    while (px < 128) {
      const w = 14 + Math.random() * 22;
      x.strokeRect(px, y0, w, y1 - y0);
      px += w;
    }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
}

// ────────────────────────────────────────────────────────────────────────────
export class Settlements {
  constructor({ terrain, road, seed = 1337 }) {
    this.group = new THREE.Group();
    this.group.name = 'Settlements';
    this.terrain = terrain;
    this.road = road;
    this.seed = seed;
    this._rng = mulberry32((seed ^ 0x5e7e55) >>> 0);
    this._rotors = []; // {mesh, speed} animated windmill blades

    // shared textures
    this._tex = {
      cottageWall: makeWallTexture('#cdbb96', '#b09a73'),
      cottageRoof: makeRoofTexture('#5a3a22'),
      barnWall: makeBarnTexture(),
      barnRoof: makeRoofTexture('#3a2418'),
      stone: makeStoneTexture(),
      silo: makeWallTexture('#c9c2b4', '#a59c88'),
    };

    this._buildClusters();
  }

  _right(h) { return new THREE.Vector3(Math.cos(h), 0, -Math.sin(h)); }

  // place clusters at chosen arc distances, alternating sides
  _buildClusters() {
    const sites = [
      { d: 1800, side: 1 },
      { d: 4200, side: -1 },
      { d: 6800, side: 1 },
    ];
    const rng = this._rng;
    for (const site of sites) {
      const s = this.road.sampleAtDistance(site.d);
      if (!s) continue;
      const right = this._right(s.heading);
      const cx = s.position.x + right.x * (HALF_WIDTH + 38) * site.side;
      const cz = s.position.z + right.z * (HALF_WIDTH + 38) * site.side;
      this._buildCluster(cx, cz, s.heading, rng);
    }
  }

  _buildCluster(cx, cz, heading, rng) {
    const baseY = this.terrain.getHeight(cx, cz);
    const rot = heading; // face buildings roughly toward the road

    // anchor: ONE windmill near the road-side edge of the cluster
    this._addWindmill(
      cx - Math.cos(rot) * 14, cz + Math.sin(rot) * 14, baseY, rot, rng
    );

    // a couple of cottages
    const cottageN = 1 + Math.floor(rng() * 2 + 0.5);
    for (let i = 0; i < cottageN; i++) {
      const ox = (rng() - 0.5) * 26;
      const oz = 12 + rng() * 14;
      const px = cx + Math.cos(rot) * ox - Math.sin(rot) * oz;
      const pz = cz + Math.sin(rot) * ox + Math.cos(rot) * oz;
      this._addCottage(px, pz, this.terrain.getHeight(px, pz), rot + (rng() - 0.5) * 0.5, rng);
    }

    // one big barn
    {
      const ox = (rng() - 0.5) * 16;
      const oz = -14 - rng() * 12;
      const px = cx + Math.cos(rot) * ox - Math.sin(rot) * oz;
      const pz = cz + Math.sin(rot) * ox + Math.cos(rot) * oz;
      this._addBarn(px, pz, this.terrain.getHeight(px, pz), rot, rng);
    }

    // grain silos (2-3) near the barn
    const siloN = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < siloN; i++) {
      const ox = -10 + i * 4.2 + (rng() - 0.5);
      const oz = -16 - rng() * 6;
      const px = cx + Math.cos(rot) * ox - Math.sin(rot) * oz;
      const pz = cz + Math.sin(rot) * ox + Math.cos(rot) * oz;
      this._addSilo(px, pz, this.terrain.getHeight(px, pz), rng);
    }

    // water tower off to one side
    {
      const ox = 18 + rng() * 8;
      const oz = -4 + (rng() - 0.5) * 10;
      const px = cx + Math.cos(rot) * ox - Math.sin(rot) * oz;
      const pz = cz + Math.sin(rot) * ox + Math.cos(rot) * oz;
      this._addWaterTower(px, pz, this.terrain.getHeight(px, pz), rng);
    }
  }

  _mat(map, color, rough = 0.85, metal = 0.0, repeat = 1) {
    const m = new THREE.MeshStandardMaterial({ map, color, roughness: rough, metalness: metal });
    if (map && repeat !== 1) { map = map.clone(); map.repeat.set(repeat, repeat); map.needsUpdate = true; m.map = map; }
    return m;
  }

  _addCottage(x, z, y, rot, rng) {
    const g = new THREE.Group();
    const w = 5.5 + rng() * 2, d = 4.5 + rng() * 1.5, h = 3.0;
    const wall = this._mat(this._tex.cottageWall, 0xffffff, 0.9, 0);
    wall.map.repeat.set(w / 3, h / 3);
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wall);
    body.position.y = h / 2; g.add(body);

    // gabled roof: a prism via a rotated box (simple pitched roof)
    const roofMat = this._mat(this._tex.cottageRoof, 0xffffff, 0.85, 0);
    roofMat.map.repeat.set(d / 3, 1);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.78, 2.2, 4), roofMat);
    roof.rotation.y = Math.PI / 4;
    roof.position.y = h + 1.1;
    roof.scale.set(1, 1, d / Math.max(w, d));
    g.add(roof);

    // door + windows via small emissive planes (dark glass)
    const glass = new THREE.MeshStandardMaterial({ color: 0x223036, roughness: 0.3, metalness: 0.4, emissive: 0x111a1f, emissiveIntensity: 0.4 });
    const door = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.8), new THREE.MeshStandardMaterial({ color: 0x4a2f1a, roughness: 0.8 }));
    door.position.set(0, 0.9, d / 2 + 0.01); g.add(door);
    for (const wx of [-w / 4, w / 4]) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), glass);
      win.position.set(wx, 1.7, d / 2 + 0.01); g.add(win);
    }

    // chimney
    const chim = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.4, 0.4), this._mat(this._tex.stone, 0xffffff, 0.95, 0));
    chim.position.set(w / 4, h + 0.7, 0); g.add(chim);

    g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
    g.position.set(x, y, z);
    g.rotation.y = rot;
    this.group.add(g);
  }

  _addBarn(x, z, y, rot, rng) {
    const g = new THREE.Group();
    const w = 11, d = 8, h = 5.5;
    const wall = this._mat(this._tex.barnWall, 0xffffff, 0.9, 0);
    wall.map.repeat.set(w / 3, h / 3);
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wall);
    body.position.y = h / 2; g.add(body);

    // gambrel-ish roof: two pitched slabs (approx with a tall cone→box). Use a box ridge.
    const roofMat = this._mat(this._tex.barnRoof, 0xffffff, 0.85, 0);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.82, 3.0, 4), roofMat);
    roof.rotation.y = Math.PI / 4;
    roof.position.y = h + 1.5;
    roof.scale.set(1, 1, d / Math.max(w, d));
    g.add(roof);

    // big central door (white cross-barn door)
    const door = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 4.0), new THREE.MeshStandardMaterial({ color: 0x3a1408, roughness: 0.85 }));
    door.position.set(0, 2.0, d / 2 + 0.01); g.add(door);

    g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
    g.position.set(x, y, z);
    g.rotation.y = rot;
    this.group.add(g);
  }

  _addSilo(x, z, y, rng) {
    const g = new THREE.Group();
    const h = 7 + rng() * 3, r = 1.6;
    const wall = this._mat(this._tex.silo, 0xffffff, 0.7, 0.3);
    wall.map.repeat.set(2, h / 3);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 16), wall);
    body.position.y = h / 2; g.add(body);
    // domed cap
    const cap = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 8, 0, TAU, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x6a6256, roughness: 0.6, metalness: 0.4 }));
    cap.position.y = h; g.add(cap);

    g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
    g.position.set(x, y, z);
    this.group.add(g);
  }

  _addWaterTower(x, z, y, rng) {
    const g = new THREE.Group();
    // four legs
    const legMat = new THREE.MeshStandardMaterial({ color: 0x4a4a52, metalness: 0.7, roughness: 0.5 });
    const legH = 7;
    const sp = 2.0;
    const legGeo = new THREE.BoxGeometry(0.22, legH, 0.22);
    for (const sx of [-sp, sp]) for (const sz of [-sp, sp]) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(sx, legH / 2, sz); g.add(leg);
    }
    // tank
    const tankMat = new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.6, roughness: 0.5 });
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.0, 3.5, 16), tankMat);
    tank.position.y = legH + 1.75; g.add(tank);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(3.0, 1.6, 16), tankMat);
    cap.position.y = legH + 3.5 + 0.8; g.add(cap);

    g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
    g.position.set(x, y, z);
    this.group.add(g);
  }

  _addWindmill(x, z, y, rot, rng) {
    const g = new THREE.Group();
    // stone base
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 2.2, 1.2, 14), this._mat(this._tex.stone, 0xffffff, 0.95, 0));
    base.position.y = 0.6; g.add(base);
    // tapered tower
    const towerMat = this._mat(this._tex.cottageWall, 0xffffff, 0.9, 0);
    towerMat.map.repeat.set(2, 3);
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.6, 9.0, 14), towerMat);
    tower.position.y = 1.2 + 4.5; g.add(tower);
    // cap
    const cap = new THREE.Mesh(new THREE.ConeGeometry(1.3, 1.4, 14),
      new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.8 }));
    cap.position.y = 1.2 + 9.0 + 0.7; g.add(cap);

    // rotor hub + blades (animated)
    const rotor = new THREE.Group();
    rotor.position.set(0, 1.2 + 7.2, 1.3); // mounted on the front face, up high
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.5, 10),
      new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.7 }));
    hub.rotation.x = Math.PI / 2; rotor.add(hub);
    // 4 sails — long lattice blades
    const sailMat = new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.8, side: THREE.DoubleSide });
    for (let i = 0; i < 4; i++) {
      const sail = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.12, 4.4, 0.08), new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.8 }));
      frame.position.y = 2.4; sail.add(frame);
      const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 4.2), sailMat);
      cloth.position.set(0.45, 2.4, 0.02); sail.add(cloth);
      sail.rotation.z = i * (Math.PI / 2);
      rotor.add(sail);
    }
    g.add(rotor);

    g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
    g.position.set(x, y, z);
    g.rotation.y = rot;
    this.group.add(g);

    this._rotors.push({ mesh: rotor, speed: 0.5 + rng() * 0.4, phase: rng() * TAU });
  }

  update(dt /*, carPos */) {
    for (const r of this._rotors) {
      r.phase += dt * r.speed;
      r.mesh.rotation.z = r.phase;
    }
  }
}
