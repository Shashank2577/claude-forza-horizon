// Festival.js — the Horizon-style festival hub at the road start: a truss stage
// with an animated LED screen, speaker stacks, flag poles with waving flags +
// pennant strings, balloon clusters, and red/white tire-barrier lining.
// Self-contained (procedural canvas textures, no external assets).
//
// API:  new Festival({ terrain, road, seed })
//   .group                 → THREE.Group (add once)
//   .update(dt, carPos)    → animates flags, balloons, LED flicker
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

// Premium canvas text: bold sans-serif stack with outline + soft shadow.
function drawPremiumText(ctx, text, x, y, {
  fontSize = 150,
  fill = '#ffffff',
  stroke = 'rgba(0,0,0,0.65)',
  strokeWidth = 10,
  shadowColor = 'rgba(0,0,0,0.45)',
  shadowBlur = 28,
  shadowOffsetY = 8,
  letterSpacing = 6,
} = {}) {
  const stack = '"Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif';
  ctx.font = `900 ${fontSize}px ${stack}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Letter-spaced manual draw for a tighter festival marquee read.
  const chars = text.split('');
  const widths = chars.map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, w) => a + w, 0) + letterSpacing * (chars.length - 1);
  let cx = x - total / 2;

  ctx.save();
  ctx.shadowColor = shadowColor;
  ctx.shadowBlur = shadowBlur;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = shadowOffsetY;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const w = widths[i];
    const px = cx + w / 2;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth;
    ctx.strokeText(ch, px, y);
    ctx.fillStyle = fill;
    ctx.fillText(ch, px, y);
    cx += w + letterSpacing;
  }
  ctx.restore();
}

// LED screen texture: festival gradient + "HORIZON FESTIVAL" + faux LED grid.
function makeLedTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, c.width, c.height);
  g.addColorStop(0, '#ff2d8a'); g.addColorStop(0.5, '#9b1fff'); g.addColorStop(1, '#18c6ff');
  x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
  // sparkle streaks
  x.globalAlpha = 0.14; x.fillStyle = '#ffffff';
  for (let i = -10; i < 30; i++) { x.beginPath(); x.moveTo(i * 80, 0); x.lineTo(i * 80 + 160, 512); x.lineTo(i * 80 + 100, 512); x.lineTo(i * 80 - 60, 0); x.fill(); }
  x.globalAlpha = 1;
  drawPremiumText(x, 'HORIZON', c.width / 2, c.height / 2 - 70, { fontSize: 148, letterSpacing: 10 });
  drawPremiumText(x, 'FESTIVAL', c.width / 2, c.height / 2 + 95, { fontSize: 132, letterSpacing: 12 });
  // faux LED pixel grid overlay
  x.shadowBlur = 0; x.globalAlpha = 0.10; x.fillStyle = '#000000';
  for (let yy = 0; yy < c.height; yy += 8) for (let xx = 0; xx < c.width; xx += 8) x.fillRect(xx, yy, 4, 4);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

// Triangular pennant strip texture (a horizontal bunting line of colored flags).
function makePennantTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 32;
  const x = c.getContext('2d');
  x.clearRect(0, 0, 256, 32);
  const cols = ['#ff2d8a', '#18c6ff', '#ffd23d', '#9b1fff', '#3dd66a'];
  for (let i = 0; i < 8; i++) {
    x.fillStyle = cols[i % cols.length];
    x.beginPath();
    x.moveTo(i * 32, 0); x.lineTo(i * 32 + 32, 0); x.lineTo(i * 32 + 16, 30); x.closePath();
    x.fill();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
}

// ────────────────────────────────────────────────────────────────────────────
export class Festival {
  constructor({ terrain, road, seed = 1337 }) {
    this.group = new THREE.Group();
    this.group.name = 'Festival';
    this.terrain = terrain;
    this.road = road;
    this.seed = seed;
    this._rng = mulberry32((seed ^ 0xf3571a1) >>> 0);
    this._time = 0;
    this._waves = [];   // {mesh, base, amp, speed, axis} waving flags
    this._bobs = [];    // {mesh, baseY, amp, speed} floating balloons
    this._ledMat = null;

    this._ledTex = makeLedTexture();
    this._pennantTex = makePennantTexture();

    // anchor just past the start gantry, on the RIGHT of the road, set back.
    const start = road.startSample();
    this._heading = start.heading;
    this._origin = new THREE.Vector3().copy(start.position);

    this._build();
  }

  _right(h) { return new THREE.Vector3(Math.cos(h), 0, -Math.sin(h)); }
  _fwd(h) { return new THREE.Vector3(Math.sin(h), 0, Math.cos(h)); }

  // world position of a (lateral, forward) offset from the start, terrain-followed.
  _at(lat, fwd) {
    const r = this._right(this._heading), f = this._fwd(this._heading);
    const px = this._origin.x + r.x * lat + f.x * fwd;
    const pz = this._origin.z + r.z * lat + f.z * fwd;
    const py = this.terrain.getHeight(px, pz);
    return new THREE.Vector3(px, py, pz);
  }

  _build() {
    const rng = this._rng;
    this._buildStage();
    this._buildFlagPoles(rng);
    this._buildBalloons(rng);
    this._buildTireBarrier(rng);
    this._buildPylons(rng);
    this._buildCrowds(rng);
  }

  /** Simple crowd silhouettes facing the stage — festival life. */
  _buildCrowds(rng) {
    const center = this._at(34, 30);
    const h = this._heading;
    const crowd = new THREE.Group();
    crowd.position.copy(center);
    crowd.rotation.y = h + Math.PI;

    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a3040, roughness: 0.92, metalness: 0.0 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xc9a080, roughness: 0.88, metalness: 0.0 });
    const accent = [0xe63946, 0x457b9d, 0xf4a261, 0x2a9d8f, 0xffffff];

    for (let i = 0; i < 48; i++) {
      const x = (rng() - 0.5) * 16;
      const z = 5 + rng() * 12;
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 1.05, 6), bodyMat.clone());
      body.material.color.setHex(accent[Math.floor(rng() * accent.length)]);
      body.position.set(x, 0.52, z);
      body.castShadow = true;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 8, 8), headMat);
      head.position.set(x, 1.22, z);
      head.castShadow = true;
      crowd.add(body, head);
    }
    this.group.add(crowd);
  }

  // ── Stage: platform + truss arch + LED screen + speaker stacks ───────────
  _buildStage() {
    // place the stage ~30m to the right of the road start, facing the road.
    const center = this._at(34, 30);
    const h = this._heading;
    const stageGroup = new THREE.Group();
    stageGroup.position.copy(center);
    stageGroup.rotation.y = h + Math.PI; // face the road (-forward)
    this.group.add(stageGroup);

    const trussMat = new THREE.MeshStandardMaterial({ color: 0x23262b, metalness: 0.85, roughness: 0.45 });
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.8, metalness: 0.2 });

    // stage deck
    const deck = new THREE.Mesh(new THREE.BoxGeometry(16, 1.0, 8), deckMat);
    deck.position.y = 0.5; stageGroup.add(deck);

    // truss uprights + top beam (lattice look via thin boxes)
    const H = 9, span = 16;
    const trussGeo = (sx, sy, sz) => new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), trussMat);
    for (const sx of [-span / 2, span / 2]) {
      const up = trussGeo(0.35, H, 0.35); up.position.set(sx, H / 2 + 1, -3); stageGroup.add(up);
      const up2 = trussGeo(0.35, H, 0.35); up2.position.set(sx, H / 2 + 1, 3); stageGroup.add(up2);
    }
    // top cross beams
    for (const sz of [-3, 3]) {
      const beam = trussGeo(span, 0.35, 0.35); beam.position.set(0, H + 1, sz); stageGroup.add(beam);
    }
    // diagonal truss braces (a few, for lattice read)
    for (const sz of [-3, 3]) {
      for (const sx of [-span / 2, span / 2]) {
        const brace = trussGeo(0.12, 0.12, 6);
        brace.position.set(sx, H * 0.55 + 1, sz);
        stageGroup.add(brace);
      }
    }

    // LED screen mounted on the front face of the truss, facing the road.
    this._ledMat = new THREE.MeshStandardMaterial({
      map: this._ledTex, emissive: 0xffffff, emissiveMap: this._ledTex,
      emissiveIntensity: 1.1, roughness: 0.5, metalness: 0.0,
    });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(13, 6.4), this._ledMat);
    screen.position.set(0, H * 0.5 + 1.2, 3.06);
    stageGroup.add(screen);
    // screen back-frame
    const frame = new THREE.Mesh(new THREE.BoxGeometry(13.6, 7.0, 0.4), trussMat);
    frame.position.set(0, H * 0.5 + 1.2, 3.0); stageGroup.add(frame);

    // speaker stacks flanking the stage front
    const speakerMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.7 });
    const coneMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.6 });
    for (const sx of [-span / 2 - 1.2, span / 2 + 1.2]) {
      const cab = new THREE.Mesh(new THREE.BoxGeometry(1.4, 3.2, 1.6), speakerMat);
      cab.position.set(sx, 1.6 + 0.5, 3.4); stageGroup.add(cab);
      for (let i = 0; i < 3; i++) {
        const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.1, 12), coneMat);
        cone.rotation.x = Math.PI / 2;
        cone.position.set(sx, 1.0 + i * 0.7 + 0.5, 3.4 + 0.8); stageGroup.add(cone);
      }
    }

    stageGroup.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
  }

  // ── Flag poles with big waving flags + pennant strings ───────────────────
  _buildFlagPoles(rng) {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.85, roughness: 0.4 });
    const flagCols = [0xff2d8a, 0x18c6ff, 0xffd23d, 0x9b1fff, 0x3dd66a, 0xff6a00];
    const poleGeo = new THREE.CylinderGeometry(0.12, 0.16, 9, 10);

    // line of poles along the road edge near the start
    const positions = [];
    for (let i = 0; i < 7; i++) {
      const lat = HALF_WIDTH + 3;
      const fwd = -10 + i * 12;
      positions.push(this._at(lat, fwd));
    }
    positions.forEach((p, i) => {
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.copy(p); pole.position.y += 4.5;
      this.group.add(pole);
      // finial
      const finial = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0xd9a441, metalness: 0.9, roughness: 0.3 }));
      finial.position.copy(p); finial.position.y += 9; this.group.add(finial);

      // big waving flag near the top
      const col = flagCols[i % flagCols.length];
      const flagMat = new THREE.MeshStandardMaterial({
        color: col, roughness: 0.6, metalness: 0.0, side: THREE.DoubleSide,
        emissive: col, emissiveIntensity: 0.12,
      });
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.4, 12, 1), flagMat);
      // mount on pole, flag extends in +X (away from road) — orient via the heading
      flag.position.copy(p);
      flag.position.y += 7.6;
      // orient so the flag's width is tangential; we'll wave in the shader-free way via update
      flag.rotation.y = this._heading;
      this.group.add(flag);
      this._waves.push({ mesh: flag, base: flag.geometry.attributes.position.clone(), amp: 0.35 + rng() * 0.2, speed: 4 + rng() * 2, phase: rng() * TAU });
    });

    // pennant string between the first and last pole (slightly sagging)
    const a = positions[0].clone().setY(8.4);
    const b = positions[positions.length - 1].clone().setY(8.4);
    const curve = new THREE.CatmullRomCurve3([a, a.clone().add(b.clone().sub(a).multiplyScalar(0.5)).setY(7.4), b]);
    const pts = curve.getPoints(40);
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffffff }));
    this.group.add(line);
    // pennant flags along the string
    const pennantMat = new THREE.MeshBasicMaterial({ map: this._pennantTex, side: THREE.DoubleSide, transparent: true });
    for (let i = 2; i < pts.length - 2; i += 3) {
      const pen = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.5), pennantMat);
      pen.position.copy(pts[i]);
      pen.position.y -= 0.3;
      pen.rotation.y = this._heading;
      this.group.add(pen);
    }
  }

  // ── Balloon clusters bobbing above the festival ──────────────────────────
  _buildBalloons(rng) {
    const cols = [0xff2d8a, 0x18c6ff, 0xffd23d, 0x9b1fff, 0x3dd66a, 0xff6a00, 0xffffff];
    const clusterCenters = [this._at(30, 20), this._at(40, 45), this._at(20, 60)];
    for (const c of clusterCenters) {
      const n = 6 + Math.floor(rng() * 4);
      for (let i = 0; i < n; i++) {
        const col = cols[Math.floor(rng() * cols.length)];
        const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.35, metalness: 0.0,
          emissive: col, emissiveIntensity: 0.08 });
        const balloon = new THREE.Mesh(new THREE.SphereGeometry(0.9, 14, 12), mat);
        const ox = (rng() - 0.5) * 5, oz = (rng() - 0.5) * 5;
        const baseY = 12 + rng() * 5;
        balloon.position.set(c.x + ox, c.y + baseY, c.z + oz);
        balloon.scale.y = 1.25;
        this.group.add(balloon);
        this._bobs.push({ mesh: balloon, baseY: balloon.position.y, amp: 0.4 + rng() * 0.4, speed: 0.8 + rng() * 0.7, phase: rng() * TAU });
        // string
        const sGeo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(balloon.position.x, balloon.position.y - 1.0, balloon.position.z),
          new THREE.Vector3(balloon.position.x, balloon.position.y - 6, balloon.position.z),
        ]);
        this.group.add(new THREE.Line(sGeo, new THREE.LineBasicMaterial({ color: 0xdddddd })));
      }
    }
  }

  // ── Red/white tire-barrier lining the road edge by the festival ──────────
  _buildTireBarrier(rng) {
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.95 });
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xe8e8ea, roughness: 0.7 });
    const tireGeo = new THREE.TorusGeometry(0.42, 0.18, 8, 14);
    const stacks = [];
    for (let f = -14; f <= 70; f += 1.8) {
      const p = this._at(HALF_WIDTH + 2.0, f);
      const red = Math.floor((f + 14) / 1.8) % 2 === 0;
      const t = new THREE.Mesh(tireGeo, red ? tireMat : whiteMat);
      t.position.copy(p); t.position.y += 0.4;
      t.rotation.x = Math.PI / 2;
      t.rotation.z = this._heading;
      stacks.push(t);
    }
    for (const t of stacks) { t.castShadow = false; t.receiveShadow = true; this.group.add(t); }
  }

  // ── Decorative pylons / "light towers" flanking the entrance ─────────────
  _buildPylons(rng) {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x23262b, metalness: 0.8, roughness: 0.5 });
    for (const fwd of [0, 60]) {
      const p = this._at(HALF_WIDTH + 2.6, fwd);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 11, 10), poleMat);
      pole.position.copy(p); pole.position.y += 5.5; this.group.add(pole);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 10),
        new THREE.MeshStandardMaterial({ color: 0xfff0c0, emissive: 0xffd070, emissiveIntensity: 2.2, roughness: 0.4 }));
      lamp.position.copy(p); lamp.position.y += 11; this.group.add(lamp);
    }
  }

  update(dt /*, carPos */) {
    this._time += dt;
    // waving flags: displace the plane's vertices with a travelling sine.
    for (const w of this._waves) {
      const pos = w.mesh.geometry.attributes.position;
      const base = w.base;
      const k = this._time * w.speed + w.phase;
      for (let i = 0; i < pos.count; i++) {
        const x = base.getX(i); // along flag width (-1.2..1.2)
        // wave grows toward the free edge (|x| larger)
        const edge = (x + 1.2) / 2.4;
        const z = Math.sin(x * 2.5 - k * 2.0) * w.amp * edge;
        pos.setZ(i, z);
      }
      pos.needsUpdate = true;
    }
    // bobbing balloons
    for (const b of this._bobs) {
      b.mesh.position.y = b.baseY + Math.sin(this._time * b.speed + b.phase) * b.amp;
    }
    // subtle LED flicker
    if (this._ledMat) {
      this._ledMat.emissiveIntensity = 1.05 + Math.sin(this._time * 6) * 0.08 + Math.sin(this._time * 13.7) * 0.04;
    }
  }
}
