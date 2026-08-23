// SpeedTrap.js — the Speed Trap PR stunt, extracted from Race.js into a
// standalone, hostable module. A gantry over the road with a digital readout;
// driving through fast records peak speed and grades it 1–3★.
//
// API:
//   const t = new SpeedTrap({ terrain, road, arc, seed })
//   scene.add(t.group)
//   t.update(dt, car, arc, pushPopup)   // arc = player's road progress
//   t.state                              // { bestKmh, lastKmh, lastStars, bestStars }
//   t.pos                                // {x,z} world pos for the minimap
//   t.reset()

import * as THREE from 'three';

const HALF_WIDTH = 6.5;
const SPEED_TRAP_TIERS = [160, 210, 260]; // 1★ / 2★ / 3★ @ km/h

// Checkerboard speed-trap readout board texture (static; the number is dynamic).
function makeTrapBoardTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#0c0f14'; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = '#ffd23d';
  for (let i = -1; i < 9; i++) { x.beginPath(); x.moveTo(i * 64, 0); x.lineTo(i * 64 + 32, 0); x.lineTo(i * 64 + 64 - 32, 34); x.lineTo(i * 64 + 64 - 64, 34); x.closePath(); x.fill(); }
  for (let i = -1; i < 9; i++) { x.beginPath(); x.moveTo(i * 64, c.height); x.lineTo(i * 64 + 32, c.height); x.lineTo(i * 64 + 64 - 32, c.height - 34); x.lineTo(i * 64 + 64 - 64, c.height - 34); x.closePath(); x.fill(); }
  x.fillStyle = '#ffffff'; x.font = '800 52px Arial, sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('SPEED TRAP', c.width / 2, c.height / 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export class SpeedTrap {
  constructor({ terrain, road, arc = 4500, seed = 1337 }) {
    this.group = new THREE.Group();
    this.group.name = 'SpeedTrap';
    this.terrain = terrain;
    this.road = road;
    this.arc = arc;
    this.seed = seed;
    this.state = { bestKmh: 0, lastKmh: 0, lastStars: 0, bestStars: 0 };
    this._armed = false;
    this._peak = 0;
    this._lastArmed = false;
    this._time = 0;
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

    const steel = new THREE.MeshStandardMaterial({ color: 0x2a2e36, metalness: 0.8, roughness: 0.5 });
    for (const sx of [-HALF_WIDTH - 1.0, HALF_WIDTH + 1.0]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7.5, 0.5), steel);
      leg.position.set(sx, 3.75, 0); g.add(leg);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(HALF_WIDTH * 2 + 2.6, 0.6, 0.6), steel);
    beam.position.set(0, 7.5, 0); g.add(beam);

    const boardMat = new THREE.MeshStandardMaterial({
      map: makeTrapBoardTexture(), emissive: 0xffffff, emissiveMap: makeTrapBoardTexture(),
      emissiveIntensity: 0.9, roughness: 0.6, side: THREE.DoubleSide,
    });
    const board = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.1), boardMat);
    board.position.set(0, 5.6, 0.32);
    board.rotation.y = Math.PI;
    g.add(board);

    const rc = document.createElement('canvas');
    rc.width = 256; rc.height = 96;
    this._readoutTex = new THREE.CanvasTexture(rc);
    this._readoutTex.colorSpace = THREE.SRGBColorSpace;
    const readout = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.2),
      new THREE.MeshStandardMaterial({ map: this._readoutTex, emissive: 0xffffff, emissiveMap: this._readoutTex, emissiveIntensity: 1.2, transparent: true }));
    readout.position.set(0, 5.4, 0.36);
    readout.rotation.y = Math.PI;
    g.add(readout);

    this.group.add(g);
    this.group.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    this._drawReadout(0, false);
  }

  _drawReadout(kmh, armed) {
    const tex = this._readoutTex;
    const c = tex.image;
    const x = c.getContext('2d');
    x.clearRect(0, 0, c.width, c.height);
    x.fillStyle = '#06080c'; x.fillRect(0, 0, c.width, c.height);
    const col = armed ? '#ff4d6d' : (kmh > 0 ? '#ff2d78' : '#1de0ff');
    x.shadowColor = col; x.shadowBlur = 16;
    x.fillStyle = col;
    x.font = '900 64px "Consolas","Menlo",monospace';
    x.textAlign = 'right'; x.textBaseline = 'middle';
    x.fillText(Math.round(kmh).toString().padStart(3, ' '), c.width - 14, c.height / 2 + 3);
    x.shadowBlur = 0;
    x.fillStyle = '#9fb4c8'; x.font = '800 22px Arial, sans-serif';
    x.textAlign = 'left';
    x.fillText('KM/H', 12, c.height / 2 + 3);
    tex.needsUpdate = true;
  }

  reset() {
    this._armed = false;
    this._peak = 0;
    this._lastArmed = false;
    this._drawReadout(0, false);
  }

  update(dt, car, arc, pushPopup) {
    this._time += dt;
    const speedKmh = Math.abs(Number(car.speed) || 0) * 3.6;
    const span = 45;
    const inWindow = Math.abs(arc - this.arc) < span;
    if (inWindow) {
      if (!this._lastArmed) { this._armed = true; this._peak = 0; }
      this._peak = Math.max(this._peak, speedKmh);
      this._drawReadout(this._peak, true);
    } else if (this._lastArmed) {
      this._armed = false;
      const kmh = this._peak;
      const stars = this._stars(kmh);
      this.state.lastKmh = kmh;
      this.state.lastStars = stars;
      if (kmh > this.state.bestKmh) {
        this.state.bestKmh = kmh;
        this.state.bestStars = stars;
        if (pushPopup) pushPopup('SPEED TRAP!', `${Math.round(kmh)} KM/H · ${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}`, '#ffd23d');
      } else {
        if (pushPopup) pushPopup('SPEED TRAP', `${Math.round(kmh)} KM/H · Best ${Math.round(this.state.bestKmh)}`, '#9fb4c8');
      }
      this._drawReadout(kmh, false);
    }
    this._lastArmed = inWindow;
  }

  _stars(kmh) {
    let s = 1;
    for (let i = 0; i < SPEED_TRAP_TIERS.length; i++) if (kmh >= SPEED_TRAP_TIERS[i]) s = i + 1;
    return s;
  }
}
