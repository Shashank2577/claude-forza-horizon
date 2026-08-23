// SprintRace.js — point-to-point Horizon-style Road Race, re-homed from Race.js.
//
// Floating checkpoint arches along the road, a start/finish timing line, split
// + total timers, an animated next-waypoint beacon, and a finish rating. The
// three PR stunts (Speed Trap, Danger Sign, Drift Zone) are hosted as standalone
// modules and run every update — so they also score while freeroaming, matching
// the original behaviour.
//
// Arc progress comes from a shared ProgressTracker (fold-immune). Detection is
// arc-length based: a gate is "reached" when carArc >= gate.arc.
//
// API:
//   new SprintRace({ terrain, road, seed })
//   .group            → THREE.Group (add once)
//   .update(dt, car)  → every frame
//   .start(car)       → place car at the start line + begin
//   .forceStart()     → begin without moving the car (used by the start button)
//   .reset()          → restart
//   .state            → HUD snapshot

import * as THREE from 'three';
import { Event } from './Event.js';
import { ProgressTracker } from './ProgressTracker.js';
import { SpeedTrap } from './stunts/SpeedTrap.js';
import { DangerSign } from './stunts/DangerSign.js';
import { DriftZone } from './stunts/DriftZone.js';

const HALF_WIDTH = 6.5;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Procedural gate banner texture (no external assets).
function makeGateTexture(kind, number) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const x = c.getContext('2d');
  x.clearRect(0, 0, c.width, c.height);
  let baseA, baseB, label;
  if (kind === 'start') { baseA = '#19e07a'; baseB = '#0fbf6a'; label = 'START'; }
  else if (kind === 'finish') { baseA = '#ff2d78'; baseB = '#ff7a18'; label = 'FINISH'; }
  else { baseA = '#22e3ff'; baseB = '#2d8bff'; label = 'CHECKPOINT'; }

  const g = x.createLinearGradient(0, 0, c.width, 0);
  g.addColorStop(0, baseA); g.addColorStop(1, baseB);
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
  x.font = '900 78px Arial, sans-serif';
  x.textAlign = 'left'; x.textBaseline = 'middle';
  x.shadowColor = 'rgba(0,0,0,0.45)'; x.shadowBlur = 10; x.shadowOffsetY = 3;
  x.fillText(String(number).padStart(2, '0'), 40, c.height / 2 + 4);
  x.shadowBlur = 6;
  x.font = '800 34px Arial, sans-serif';
  x.textAlign = 'right';
  x.fillText(label, c.width - 32, c.height / 2 + 2);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export class SprintRace extends Event {
  constructor({ terrain, road, seed = 1337 }) {
    super();
    this.group.name = 'SprintRace';
    this.terrain = terrain;
    this.road = road;
    this.seed = seed;
    this._rng = mulberry32((seed ^ 0x9ace11) >>> 0);
    this._time = 0;
    this.type = 'sprint';
    this.hasRivals = true;

    this.tracker = new ProgressTracker(road, { lap: false });

    // Gate distances: start near the festival, finish at the far end of the road.
    const START = 120, FINISH = 8820, N = 12;
    this._gateDs = [];
    for (let i = 0; i < N; i++) this._gateDs.push(START + (FINISH - START) * (i / (N - 1)));

    this._gates = [];
    this._beacon = null;
    this._beamMat = null;
    this._ringMat = null;

    // Stunts as standalone modules (hosted here, run every update).
    this.speedTrap = new SpeedTrap({ terrain, road, arc: 4500, seed });
    this.dangerSign = new DangerSign({ terrain, road, arc: 6200, seed });
    this.driftZone = new DriftZone({ terrain, road, startArc: 2400, endArc: 2580, seed });

    this._buildGates();
    this._buildBeacon();
    this.group.add(this.speedTrap.group, this.dangerSign.group, this.driftZone.group);

    this._initState();
  }

  _initState() {
    this.state.type = 'sprint';
    this.state.title = 'ROAD RACE';
    this.state.phase = 'idle';
    this.state.elapsed = 0;
    this.state.gatesTotal = this._gateDs.length;
    this.state.gatesPassed = 0;
    this.state.nextGate = 1;
    this.state.nextGatePos = new THREE.Vector3();
    this.state.gates = this._gates.map(gg => ({ x: gg.pos.x, z: gg.pos.z, kind: gg.kind }));
    this.state.finishTime = 0;
    this.state.rating = 0;
    this.state.speedTrap = this.speedTrap.state;
    this.state.dangerSign = this.dangerSign.state;
    this.state.driftZone = this.driftZone.state;
    this.state.dangerPos = this.dangerSign.pos;
    this.state.driftPos = this.driftZone.pos;
    this.state.laps = null;          // sprint has no laps
    this.state.totalLaps = null;
  }

  // --- Build checkpoint arches ------------------------------------------------
  _buildGates() {
    const pillarGeo = new THREE.BoxGeometry(0.5, 8.4, 0.5);
    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0xeaf6ff, emissive: 0x66ccff, emissiveIntensity: 1.4,
      roughness: 0.4, metalness: 0.3,
    });
    const capGeo = new THREE.SphereGeometry(0.5, 12, 10);
    const capMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0x88e8ff, emissiveIntensity: 2.4, roughness: 0.3,
    });

    this._gateDs.forEach((d, i) => {
      const kind = i === 0 ? 'start' : i === this._gateDs.length - 1 ? 'finish' : 'checkpoint';
      const s = this.road.sampleAtDistance(d);
      const p = s.position;
      const baseY = this.terrain.getHeight(p.x, p.z);

      const g = new THREE.Group();
      g.position.set(p.x, baseY, p.z);
      g.rotation.y = s.heading;

      for (const sx of [-HALF_WIDTH - 0.3, HALF_WIDTH + 0.3]) {
        const pil = new THREE.Mesh(pillarGeo, pillarMat);
        pil.position.set(sx, 4.2, 0);
        g.add(pil);
        const cap = new THREE.Mesh(capGeo, capMat);
        cap.position.set(sx, 8.6, 0);
        g.add(cap);
      }

      const bannerMat = new THREE.MeshStandardMaterial({
        map: makeGateTexture(kind, i), transparent: true,
        emissive: 0xffffff, emissiveMap: makeGateTexture(kind, i),
        emissiveIntensity: 1.0, roughness: 0.5, side: THREE.DoubleSide,
      });
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(HALF_WIDTH * 2 + 0.6, 2.4), bannerMat);
      banner.position.set(0, 8.0, 0);
      banner.rotation.y = Math.PI;
      g.add(banner);

      const curtainMat = new THREE.MeshBasicMaterial({
        color: kind === 'finish' ? 0xff5fa0 : kind === 'start' ? 0x6effc0 : 0x49c6ff,
        transparent: true, opacity: 0.10, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const curtain = new THREE.Mesh(new THREE.PlaneGeometry(HALF_WIDTH * 2 + 0.4, 7.0), curtainMat);
      curtain.position.set(0, 3.8, 0);
      g.add(curtain);

      this.group.add(g);
      this._gates.push({
        group: g, arc: d, pos: { x: p.x, z: p.z }, kind,
        bannerMat, curtainMat, lit: false, pulse: 0,
      });
    });

    this.group.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  }

  // --- Next-waypoint beacon ---------------------------------------------------
  _buildBeacon() {
    const b = new THREE.Group();
    this._ringMat = new THREE.MeshBasicMaterial({
      color: 0xff2d78, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.28, 12, 32), this._ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 11;
    b.add(ring);
    this._beaconRing = ring;

    const chevMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const chev = new THREE.Mesh(new THREE.ConeGeometry(1.6, 1.8, 4), chevMat);
    chev.rotation.x = Math.PI;
    chev.rotation.y = Math.PI / 4;
    chev.position.y = 9.2;
    b.add(chev);
    this._beaconChev = chev;
    this._beaconChevMat = chevMat;

    this._beamMat = new THREE.MeshBasicMaterial({
      color: 0xff2d78, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.8, 44, 16, 1, true), this._beamMat);
    beam.position.y = 24;
    b.add(beam);

    b.visible = false;
    this.group.add(b);
    this._beacon = b;
  }

  // --- Lifecycle --------------------------------------------------------------
  placeCarAtStart(car) {
    const s = this.road.startSample();
    if (typeof car.placeAt === 'function') car.placeAt(s.position, s.heading);
    this.tracker.reset(0);
  }

  forceStart() {
    const st = this.state;
    if (st.phase === 'finished') return;
    st.phase = 'racing';
    st.elapsed = 0;
    st.gatesPassed = 1;
    st.nextGate = 1;
    this._lightGate(0, true);
    this.pushPopup('GO!', 'Road Race started', '#6effc0');
  }

  start(car) {
    this.placeCarAtStart(car);
    this.reset();
    this.forceStart();
  }

  reset() {
    this._initState();
    this.tracker.reset(0);
    this._gates.forEach((gg) => {
      gg.lit = false;
      gg.pulse = 0;
      gg.bannerMat.emissiveIntensity = 0.6;
    });
    this._beacon.visible = false;
    this.speedTrap.reset();
    this.dangerSign.reset();
    this.driftZone.reset();
  }

  // --- Per-frame update -------------------------------------------------------
  update(dt, car) {
    this._time += dt;
    this._agePopups();
    const st = this.state;

    const arc = this.tracker.update(car.position);
    const speedKmh = Math.abs(Number(car.speed) || 0) * 3.6;

    // Start-line crossing: begin timing on first forward pass.
    if (st.phase === 'idle' && arc >= this._gates[0].arc) {
      st.phase = 'racing';
      st.elapsed = 0;
      st.gatesPassed = 1;
      st.nextGate = 1;
      this._lightGate(0, true);
      this.pushPopup('GO!', 'Race started', '#6effc0');
    }

    // Checkpoint / finish progression while racing.
    if (st.phase === 'racing') {
      st.elapsed += dt;
      while (st.nextGate < this._gates.length && arc >= this._gates[st.nextGate].arc) {
        const gi = st.nextGate;
        this._lightGate(gi, true);
        this._pulseGate(gi);
        st.gatesPassed = gi + 1;
        const isFinish = gi === this._gates.length - 1;
        if (isFinish) {
          st.phase = 'finished';
          st.finishTime = st.elapsed;
          st.rating = this._finishRating(st.elapsed);
          st.nextGate = this._gates.length;
          this.pushPopup('FINISH!', this._fmtTime(st.elapsed), '#ffd23d');
        } else {
          this.pushPopup('CHECKPOINT ' + String(gi).padStart(2, '0'),
            'Split ' + this._fmtTime(st.elapsed), '#49c6ff');
        }
        st.nextGate++;
      }
    }

    // Beacon: follow the target gate, animate, hide when finished.
    const beaconIdx = st.phase === 'idle' ? 0 : st.nextGate;
    if (st.phase !== 'finished' && beaconIdx < this._gates.length) {
      const ng = this._gates[beaconIdx];
      const by = this.terrain.getHeight(ng.pos.x, ng.pos.z);
      this._beacon.position.set(ng.pos.x, by, ng.pos.z);
      this._beacon.visible = true;
      const pulse = 0.5 + 0.5 * Math.sin(this._time * 4.0);
      this._ringMat.opacity = 0.55 + 0.35 * pulse;
      this._beamMat.opacity = 0.12 + 0.10 * pulse;
      this._beaconChevMat.opacity = 0.7 + 0.3 * pulse;
      this._beaconRing.rotation.z += dt * 1.6;
      this._beaconRing.position.y = 11 + Math.sin(this._time * 2.2) * 0.5;
      st.nextGatePos.set(ng.pos.x, by + 2, ng.pos.z);
    } else {
      this._beacon.visible = false;
    }

    // PR stunts (run every frame — score in freeroam and during the race).
    const pp = (text, sub, color) => this.pushPopup(text, sub, color);
    this.speedTrap.update(dt, car, arc, pp);
    this.dangerSign.update(dt, car, arc, pp);
    this.driftZone.update(dt, car, arc, pp);

    for (const g of this._gates) {
      if (g.pulse <= 0) continue;
      g.pulse = Math.max(0, g.pulse - dt * 2.8);
      if (g.lit) {
        g.bannerMat.emissiveIntensity = 1.8 + g.pulse * 5.5;
        g.curtainMat.opacity = 0.22 + g.pulse * 0.5;
      }
    }
  }

  _finishRating(t) {
    const dist = this._gateDs[this._gateDs.length - 1] - this._gateDs[0];
    const par = dist / 78;
    if (t <= par) return 3;
    if (t <= par * 1.15) return 2;
    return 1;
  }

  _pulseGate(index) { const g = this._gates[index]; if (g) g.pulse = 1.0; }

  _lightGate(index, on) {
    const g = this._gates[index];
    if (!g) return;
    g.lit = on;
    g.bannerMat.emissiveIntensity = on ? 1.8 : 0.55;
    g.curtainMat.opacity = on ? 0.22 : 0.08;
  }

  _fmtTime(s) {
    if (!isFinite(s)) return '--:--.--';
    const m = Math.floor(s / 60);
    const sec = s - m * 60;
    return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
  }
}
