// CircuitRace.js — a multi-lap wheel-to-wheel race on the closed Circuit loop.
//
// Lap progress comes from a lap-wrapping ProgressTracker; each forward crossing
// of the start/finish seam completes a lap (recorded with a split time). The
// race finishes after `laps` completions. No PR stunts — this is a pure circuit
// race (the Forza Circuit feel). The Circuit carries its own start/finish gantry.
//
// API mirrors SprintRace so the HUD + Overworld treat them uniformly.

import * as THREE from 'three';
import { Event } from './Event.js';
import { ProgressTracker } from './ProgressTracker.js';

export class CircuitRace extends Event {
  constructor({ terrain, road, seed = 1337, laps = 3 }) {
    super();
    this.group.name = 'CircuitRace';
    this.terrain = terrain;
    this.circuit = road;          // the closed Circuit
    this.road = road;
    this.seed = seed;
    this.laps = Math.max(1, laps | 0);
    this.hasRivals = true;
    this._time = 0;
    this._lastCompleted = 0;
    this._lapStart = 0;

    this.tracker = new ProgressTracker(road, { lap: true });
    this._finishPos = (() => {
      const s = road.startSample();
      return { x: s.position.x, z: s.position.z };
    })();

    this._initState();
  }

  _initState() {
    this.state.type = 'circuit';
    this.state.title = `CIRCUIT · ${this.laps} LAPS`;
    this.state.phase = 'idle';
    this.state.elapsed = 0;
    this.state.finishTime = 0;
    this.state.rating = 0;
    this.state.laps = 1;            // current lap (1-based)
    this.state.totalLaps = this.laps;
    this.state.lapTimes = [];
    this.state.lastLap = 0;
    this.state.bestLap = 0;
    this.state.nextGatePos = new THREE.Vector3(this._finishPos.x, 0, this._finishPos.z);
    this.state.gates = [{ x: this._finishPos.x, z: this._finishPos.z, kind: 'finish' }];
    // Stunt placeholders (the HUD reads them; circuit has none).
    this.state.speedTrap = { bestKmh: 0, lastKmh: 0, lastStars: 0, bestStars: 0 };
    this.state.dangerSign = { bestM: 0, lastM: 0, lastStars: 0, bestStars: 0 };
    this.state.driftZone = { best: 0, last: 0, lastStars: 0, bestStars: 0, active: false, score: 0 };
    this.state.dangerPos = null;
    this.state.driftPos = null;
  }

  placeCarAtStart(car) {
    const s = this.circuit.startSample();
    if (typeof car.placeAt === 'function') car.placeAt(s.position, s.heading);
    this.tracker.reset(0, 0);
    this._lastCompleted = 0;
    this._lapStart = 0;
  }

  forceStart() {
    const st = this.state;
    if (st.phase === 'finished') return;
    st.phase = 'racing';
    st.elapsed = 0;
    st.laps = 1;
    this._lapStart = 0;
    this._lastCompleted = 0;
    this.pushPopup('GO!', 'Circuit race started', '#6effc0');
  }

  start(car) {
    this.placeCarAtStart(car);
    this.reset();
    this.forceStart();
  }

  reset() {
    this._initState();
    this.tracker.reset(0, 0);
    this._lastCompleted = 0;
    this._lapStart = 0;
  }

  update(dt, car) {
    this._time += dt;
    this._agePopups();
    const st = this.state;
    const arc = this.tracker.update(car.position);

    if (st.phase === 'racing') {
      st.elapsed += dt;
      const completed = this.tracker.lapsCompleted;
      if (completed > this._lastCompleted) {
        // Crossed the start/finish line forward — a lap is done.
        const lapTime = st.elapsed - this._lapStart;
        st.lastLap = lapTime;
        st.lapTimes.push(lapTime);
        if (st.bestLap === 0 || lapTime < st.bestLap) st.bestLap = lapTime;
        this._lapStart = st.elapsed;
        this._lastCompleted = completed;

        if (completed >= this.laps) {
          st.phase = 'finished';
          st.finishTime = st.elapsed;
          st.rating = this._finishRating(st.elapsed);
          this.pushPopup('FINISH!', this._fmt(st.elapsed), '#ffd23d');
        } else {
          st.laps = completed + 1;
          this.pushPopup('LAP ' + st.laps + '/' + st.totalLaps,
            'Lap ' + completed + ' · ' + this._fmt(lapTime), '#49c6ff');
        }
      }
    }

    // Waypoint: the start/finish line (the objective each lap).
    const by = this.terrain.getHeight(this._finishPos.x, this._finishPos.z);
    st.nextGatePos.set(this._finishPos.x, by + 2, this._finishPos.z);
  }

  _finishRating(t) {
    const par = (this.laps * this.circuit.totalLength()) / 52; // ~52 m/s target avg
    if (t <= par) return 3;
    if (t <= par * 1.12) return 2;
    return 1;
  }

  _fmt(s) {
    if (!isFinite(s)) return '--:--.--';
    const m = Math.floor(s / 60);
    const sec = s - m * 60;
    return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
  }
}
