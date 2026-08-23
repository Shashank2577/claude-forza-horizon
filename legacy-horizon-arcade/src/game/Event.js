// Event.js — common base for selectable festival events (Sprint, Circuit, …).
//
// Owns the THREE.Group added to the scene, the transient popup stack the HUD
// renders, and a shared `state` shape. Subclasses implement start/update/reset
// and extend `state` with event-specific fields (gates, laps, stunt scores…).
//
// Popups are wall-clock-timestamped so the HUD (one clock) ages them out.

import * as THREE from 'three';

export class Event {
  constructor() {
    this.group = new THREE.Group();
    this.state = {
      phase: 'idle',     // 'idle' | 'racing' | 'finished'
      popups: [],
      finishTime: 0,
      rating: 0,
      type: 'event',     // subclasses set a label, e.g. 'sprint' | 'circuit'
      title: 'EVENT',
    };
    this.hasRivals = false;
  }

  /** Push a transient result pop-up (HUD renders + ages it). */
  pushPopup(text, sub = '', color = '#ffffff') {
    this.state.popups.push({ text, sub, color, born: performance.now(), life: 2600 });
    if (this.state.popups.length > 4) this.state.popups.shift();
  }

  /** Age out popups (call at the top of update). */
  _agePopups() {
    if (this.state.popups.length) {
      const now = performance.now();
      this.state.popups = this.state.popups.filter(p => (now - p.born) < p.life);
    }
  }
}
