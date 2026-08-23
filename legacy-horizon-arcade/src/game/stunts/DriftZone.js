// DriftZone.js — the Drift Zone PR stunt, extracted from Race.js. A painted
// cyan road segment; driving through it sideways (lateral slip above threshold)
// banks drift points, graded 1–3★ on exit.
//
// API:
//   const d = new DriftZone({ terrain, road, startArc, endArc, seed })
//   scene.add(d.group)
//   d.update(dt, car, arc, pushPopup)
//   d.state   // { best, last, lastStars, bestStars, active, score }
//   d.pos     // {x,z} for the minimap
//   d.reset()

import * as THREE from 'three';

const HALF_WIDTH = 6.5;
const DRIFT_SLIP_THRESH = 1.6;  // m/s lateral slip before it counts as drifting
const DRIFT_MIN_SPEED = 10;     // m/s; ignore slow rolls / parked donuts
const DRIFT_TIERS = [600, 1600, 3000]; // 1★ / 2★ / 3★ score thresholds

export class DriftZone {
  constructor({ terrain, road, startArc = 2400, endArc = 2580, seed = 1337 }) {
    this.group = new THREE.Group();
    this.group.name = 'DriftZone';
    this.terrain = terrain;
    this.road = road;
    this.startArc = startArc;
    this.endArc = endArc;
    this.seed = seed;
    this.state = { best: 0, last: 0, lastStars: 0, bestStars: 0, active: false, score: 0 };
    this._prevIn = false;
    this._time = 0;
    this._ribbonMat = null;
    this._pos = { x: 0, z: 0 };
    this._build();
  }

  get pos() { return this._pos; }

  _build() {
    const g = new THREE.Group();
    const ribbon = this._roadRibbon(this.startArc, this.endArc, 0.06);
    this._ribbonMat = new THREE.MeshBasicMaterial({
      color: 0x1fbfff, transparent: true, opacity: 0.26,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    g.add(new THREE.Mesh(ribbon, this._ribbonMat));

    const tex = this._banner();
    for (const d of [this.startArc, this.endArc]) {
      const s = this.road.sampleAtDistance(d);
      const p = s.position;
      const baseY = this.terrain.getHeight(p.x, p.z);
      const gate = new THREE.Group();
      gate.position.set(p.x, baseY, p.z);
      gate.rotation.y = s.heading;
      const postMat = new THREE.MeshStandardMaterial({ color: 0x9b6bff, emissive: 0x3a1a6b, emissiveIntensity: 0.8, roughness: 0.5 });
      for (const sx of [-HALF_WIDTH - 0.3, HALF_WIDTH + 0.3]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.32, 5.2, 0.32), postMat);
        post.position.set(sx, 2.6, 0); gate.add(post);
      }
      const mat = new THREE.MeshStandardMaterial({
        map: tex, transparent: true, emissive: 0xffffff, emissiveMap: tex,
        emissiveIntensity: 1.0, roughness: 0.5, side: THREE.DoubleSide,
      });
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(HALF_WIDTH * 2 + 0.6, 1.6), mat);
      banner.position.set(0, 4.8, 0);
      banner.rotation.y = Math.PI;
      gate.add(banner);
      g.add(gate);
    }

    this.group.add(g);
    const mid = this.road.sampleAtDistance((this.startArc + this.endArc) * 0.5);
    this._pos = { x: mid.position.x, z: mid.position.z };
  }

  // Flat ribbon mesh between two road arcs, spanning the full road width.
  _roadRibbon(startD, endD, yOffset) {
    const pts = [];
    for (let d = startD; d <= endD; d += 4) {
      const s = this.road.sampleAtDistance(d);
      const y = this.terrain.getHeight(s.position.x, s.position.z) + yOffset;
      const rx = Math.cos(s.heading), rz = -Math.sin(s.heading);
      pts.push(
        s.position.x + rx * HALF_WIDTH, y, s.position.z + rz * HALF_WIDTH,
        s.position.x - rx * HALF_WIDTH, y, s.position.z - rz * HALF_WIDTH,
      );
    }
    const verts = new Float32Array(pts);
    const idx = [];
    const rows = pts.length / 6;
    for (let i = 0; i < rows - 1; i++) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, dd = (i + 1) * 2 + 1;
      idx.push(a, b, c, b, dd, c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  _banner() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, c.width, 0);
    g.addColorStop(0, '#b14dff'); g.addColorStop(1, '#22e3ff');
    x.fillStyle = g;
    const r = 16;
    x.beginPath();
    x.moveTo(r, 0); x.arcTo(c.width, 0, c.width, c.height, r);
    x.arcTo(c.width, c.height, 0, c.height, r);
    x.arcTo(0, c.height, 0, 0, r); x.arcTo(0, 0, c.width, 0, r);
    x.closePath(); x.fill();
    const sg = x.createLinearGradient(0, 0, 0, c.height);
    sg.addColorStop(0, 'rgba(255,255,255,0.28)'); sg.addColorStop(0.5, 'rgba(255,255,255,0)');
    x.fillStyle = sg; x.fill();
    x.fillStyle = '#ffffff';
    x.font = '900 46px Arial, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.shadowColor = 'rgba(0,0,0,0.5)'; x.shadowBlur = 10; x.shadowOffsetY = 3;
    x.fillText('DRIFT ZONE', c.width / 2, c.height / 2 + 2);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  }

  reset() {
    this._prevIn = false;
    this.state.active = false;
    this.state.score = 0;
  }

  update(dt, car, arc, pushPopup) {
    this._time += dt;
    const st = this.state;
    const inZone = arc >= this.startArc && arc <= this.endArc;
    const slip = Math.abs(Number(car.slip) || 0);

    if (inZone) {
      if (!this._prevIn) { st.active = true; st.score = 0; }
      if (slip >= DRIFT_SLIP_THRESH && Math.abs(Number(car.speed) || 0) >= DRIFT_MIN_SPEED) {
        const speedKmh = Math.abs(Number(car.speed) || 0) * 3.6;
        st.score += speedKmh * slip * 0.6 * dt;
      }
    } else if (this._prevIn) {
      st.active = false;
      const score = st.score;
      const stars = this._stars(score);
      st.last = score;
      st.lastStars = stars;
      if (score >= DRIFT_TIERS[0]) {
        const isNew = score > st.best;
        if (isNew) {
          st.best = score;
          st.bestStars = stars;
          if (pushPopup) pushPopup('DRIFT ZONE!',
            Math.round(score) + ' pts · ' + '★'.repeat(stars) + '☆'.repeat(3 - stars), '#b14dff');
        } else {
          if (pushPopup) pushPopup('DRIFT ZONE', Math.round(score) + ' pts · Best ' + Math.round(st.best), '#9fb4c8');
        }
      } else {
        st.score = 0;
      }
    }
    this._prevIn = inZone;

    if (this._ribbonMat) {
      const target = st.active ? (0.30 + 0.18 * Math.sin(this._time * 6)) : 0.26;
      this._ribbonMat.opacity += (target - this._ribbonMat.opacity) * Math.min(1, 8 * dt);
    }
  }

  _stars(score) {
    let s = 1;
    for (let i = 0; i < DRIFT_TIERS.length; i++) if (score >= DRIFT_TIERS[i]) s = i + 1;
    return s;
  }
}
