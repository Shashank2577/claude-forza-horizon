// DangerSign.js — the Danger Sign / "Big Air" PR stunt, extracted from Race.js.
// A launch ramp across the road; reaching the lip fast launches the car (arcade,
// via car.launch) and the landing distance is graded 1–3★.
//
// API:
//   const d = new DangerSign({ terrain, road, arc, seed })
//   scene.add(d.group)
//   d.update(dt, car, arc, pushPopup)
//   d.state   // { bestM, lastM, lastStars, bestStars }
//   d.pos     // {x,z} for the minimap
//   d.reset()

import * as THREE from 'three';

const HALF_WIDTH = 6.5;

export class DangerSign {
  constructor({ terrain, road, arc = 6200, seed = 1337 }) {
    this.group = new THREE.Group();
    this.group.name = 'DangerSign';
    this.terrain = terrain;
    this.road = road;
    this.arc = arc;
    this.seed = seed;
    this.state = { bestM: 0, lastM: 0, lastStars: 0, bestStars: 0 };
    this._triggered = false;
    this._scoredJump = null;
    this._pos = { x: 0, z: 0 };
    this._build();
  }

  get pos() { return this._pos; }

  _build() {
    const s = this.road.sampleAtDistance(this.arc);
    const p = s.position;
    const baseY = this.terrain.getHeight(p.x, p.z);
    this._pos = { x: p.x, z: p.z };

    const g = new THREE.Group();
    g.position.set(p.x, baseY, p.z);
    g.rotation.y = s.heading;

    const LEN = 9, H = 2.3; // ~14.4° launch face
    const shape = new THREE.Shape();
    shape.moveTo( LEN * 0.5, 0);
    shape.lineTo(-LEN * 0.5, 0);
    shape.lineTo(-LEN * 0.5, H);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: HALF_WIDTH * 2 + 0.6, bevelEnabled: false });
    geo.translate(0, 0, -(HALF_WIDTH + 0.3));
    geo.rotateY(Math.PI / 2);
    geo.computeVertexNormals();

    const rampMat = new THREE.MeshStandardMaterial({ color: 0x2a2c33, roughness: 0.9, metalness: 0.1 });
    const ramp = new THREE.Mesh(geo, rampMat);
    ramp.receiveShadow = true;
    g.add(ramp);

    const lip = new THREE.Mesh(
      new THREE.BoxGeometry(HALF_WIDTH * 2 + 0.6, 0.16, 0.3),
      new THREE.MeshStandardMaterial({ color: 0xffd23d, emissive: 0x554400, emissiveIntensity: 0.6, roughness: 0.6 }));
    lip.position.set(0, H, -LEN * 0.5);
    g.add(lip);

    const chevTex = this._chevronTexture(0x1a1a1f, 0xffd23d);
    const inclineLen = Math.hypot(LEN, H);
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(HALF_WIDTH * 2 + 0.4, inclineLen),
      new THREE.MeshStandardMaterial({ map: chevTex, roughness: 0.8 }));
    face.position.set(0, H * 0.5, 0);
    face.rotation.y = Math.PI;
    face.rotation.z = Math.atan2(H, LEN);
    face.position.z = -0.02;
    g.add(face);

    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 3.2, 8),
      new THREE.MeshStandardMaterial({ color: 0x888c92, metalness: 0.6, roughness: 0.5 }));
    post.position.set(-(HALF_WIDTH + 2.2), 1.6, 6);
    g.add(post);
    const signTex = this._dangerSignTexture();
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 1.6),
      new THREE.MeshStandardMaterial({ map: signTex, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 0.5, side: THREE.DoubleSide }));
    sign.position.set(-(HALF_WIDTH + 2.2), 3.4, 6);
    sign.rotation.y = Math.PI / 2;
    g.add(sign);

    this.group.add(g);
  }

  reset() {
    this._triggered = false;
    this._scoredJump = null;
  }

  update(dt, car, arc, pushPopup) {
    const sp = Math.abs(Number(car.speed) || 0);
    if (!this._triggered && Math.abs(arc - this.arc) < 6 && sp > 15 && typeof car.launch === 'function') {
      car.launch(sp * Math.sin(13 * Math.PI / 180));
      this._triggered = true;
      if (pushPopup) pushPopup('BIG AIR!', '', '#ffd23d');
    }
    if (Math.abs(arc - this.arc) > 40) this._triggered = false;

    if (car.lastJump && car.lastJump !== this._scoredJump) {
      this._scoredJump = car.lastJump;
      const m = car.lastJump.distance;
      const stars = this._jumpStars(m);
      this.state.lastM = m; this.state.lastStars = stars;
      if (m > this.state.bestM) {
        this.state.bestM = m; this.state.bestStars = stars;
        if (pushPopup) pushPopup('DANGER SIGN!', Math.round(m) + ' m · ' + '★'.repeat(stars) + '☆'.repeat(3 - stars), '#ff7a18');
      } else {
        if (pushPopup) pushPopup('DANGER SIGN', Math.round(m) + ' m · Best ' + Math.round(this.state.bestM) + ' m', '#9fb4c8');
      }
    }
  }

  _jumpStars(m) { if (m >= 130) return 3; if (m >= 80) return 2; return 1; }

  _chevronTexture(bg, fg) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const x = c.getContext('2d');
    x.fillStyle = '#' + bg.toString(16).padStart(6, '0'); x.fillRect(0, 0, 256, 256);
    x.fillStyle = '#' + fg.toString(16).padStart(6, '0');
    for (let i = -2; i < 6; i++) {
      x.beginPath();
      x.moveTo(i * 64, 0); x.lineTo(i * 64 + 32, 0);
      x.lineTo(i * 64 + 64 + 32, 256); x.lineTo(i * 64 + 64, 256);
      x.closePath(); x.fill();
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    t.wrapS = THREE.RepeatWrapping; t.repeat.x = 3;
    return t;
  }

  _dangerSignTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const x = c.getContext('2d');
    x.fillStyle = '#ffce1f'; x.fillRect(0, 0, 256, 256);
    x.strokeStyle = '#1a1a1f'; x.lineWidth = 16; x.strokeRect(10, 10, 236, 236);
    x.fillStyle = '#1a1a1f';
    x.font = '900 86px Arial, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('!', c.width / 2, c.height / 2 + 6);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  }
}
