import { Renderer } from './core/Renderer.js';
import { Controls } from './core/Controls.js';
import { ChaseCamera } from './core/ChaseCamera.js';
import { Sky } from './core/Sky.js';
import { Terrain } from './core/Terrain.js';
import { Road } from './core/Road.js';
import { Circuit } from './core/Circuit.js';
import { Car } from './core/Car.js';
import { Environment } from './core/Environment.js';
import { Props } from './world/Props.js';
import { RoadFurniture } from './world/RoadFurniture.js';
import { Settlements } from './world/Settlements.js';
import { Festival } from './world/Festival.js';
import { ParkedCars } from './world/ParkedCars.js';
import { WaterBodies } from './world/WaterBodies.js';
import { SprintRace } from './game/SprintRace.js';
import { CircuitRace } from './game/CircuitRace.js';
import { Rivals } from './game/Rivals.js';
import { Hud } from './hud/Hud.js';
import { EngineAudio } from './audio/EngineAudio.js';
import { TireSmoke } from './fx/TireSmoke.js';
import { SkidMarks } from './fx/SkidMarks.js';
import { ImpactSparks } from './fx/ImpactSparks.js';
import { RoadObstacles } from './world/RoadObstacles.js';
import { RoadBarriers } from './world/RoadBarriers.js';
import { RoadCurbs } from './world/RoadCurbs.js';
import { BoostPads } from './world/BoostPads.js';
import { loadHeroGltf } from './core/HeroGltf.js';

const canvas = document.createElement('canvas');
document.getElementById('app').appendChild(canvas);

const engine = new Renderer(canvas);
const { scene, camera } = engine;

// World systems — order matters: terrain before road (road follows terrain).
const sky = new Sky(scene, engine.renderer);
const terrain = new Terrain({ size: 4000, segments: 256, seed: 1337 });
scene.add(terrain.group);

const road = new Road({ terrain, seed: 1337, length: 9000, sunDir: sky.sunDir });
scene.add(road.group);

// Closed festival circuit loop beside the road start (for Circuit / lap races).
const circuit = new Circuit({ terrain, road, sunDir: sky.sunDir, seed: 7 });
scene.add(circuit.group);

const environment = new Environment({ terrain, road, seed: 1337 });
scene.add(environment.group);

// World dressing: utility poles + wires, field fences, hay bales, shrubs, logs.
const props = new Props({ terrain, road, seed: 1337 });
scene.add(props.group);

// Road furniture: start gantry, reflector delineators, guardrails on curves, chevrons.
const roadFurniture = new RoadFurniture({ terrain, road, seed: 1337 });
scene.add(roadFurniture.group);

// Settlements: farmstead clusters with houses, barns, a windmill, silos, water tower.
const settlements = new Settlements({ terrain, road, seed: 1337 });
scene.add(settlements.group);

// The Horizon-style festival hub at the road start (stage, LED screen, flags, balloons, tire barrier).
const festival = new Festival({ terrain, road, seed: 1337 });
scene.add(festival.group);

const parkedCars = new ParkedCars({
  terrain, road, seed: 1337, envMap: sky.envTexture ?? null,
  colliderGrid: environment.colliderGrid,
});
scene.add(parkedCars.group);

const roadObstacles = new RoadObstacles({
  terrain, road, seed: 1337, colliderGrid: environment.colliderGrid,
});
scene.add(roadObstacles.group);

const roadBarriers = new RoadBarriers({
  terrain, road, colliderGrid: environment.colliderGrid,
});
scene.add(roadBarriers.group);

const roadCurbs = new RoadCurbs({
  terrain, road, colliderGrid: environment.colliderGrid,
});
scene.add(roadCurbs.group);

const boostPads = new BoostPads({ terrain, road });
scene.add(boostPads.group);

const water = new WaterBodies({ terrain, seed: 1337, sunDir: sky.sunDir, envMap: sky.envTexture });
scene.add(water.group);

// The festival circuit was laid over terrain that already has Environment
// trees/rocks scattered on it — clear any collider that falls on/near the loop
// so it's as drivable as the world road. (Road keeps its own clear corridor.)
{
  const grid = environment.colliderGrid;
  let cleared = 0;
  for (const list of grid.values()) {
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (circuit.distanceToCenterline(c.x, c.z) < 9) { list.splice(i, 1); cleared++; }
    }
  }
  // eslint-disable-next-line no-console
  console.log('[circuit] cleared', cleared, 'overlapping colliders');
}

// The gameplay layer: checkpoint Road Race + Speed Trap PR stunt, with timers,
// a next-waypoint beacon, and result pop-ups surfaced through the HUD.
const race = new SprintRace({ terrain, road, seed: 1337 });
scene.add(race.group);

// Closed-circuit lap race on the festival loop (3 laps, solo time trial for v1).
const circuitRace = new CircuitRace({ terrain, road: circuit, seed: 7, laps: 3 });
scene.add(circuitRace.group);

// AI rival cars that race the player along the road (pure-pursuit on full Car physics).
const rivals = new Rivals({ terrain, road, seed: 1337 });
scene.add(rivals.group);
rivals.setColliderGrid(environment.colliderGrid);

const car = new Car({ terrain, envMap: sky.envTexture ?? null });
car.setRoad(road);
car.setColliderGrid(environment.colliderGrid);
car.setWater(water);
scene.add(car.group);
loadHeroGltf(car);

// Tell the car's contact-shadow the sun's light-travel direction (sky.sunDir points
// toward the sun; the blob wants the opposite). sunDir is static, so one call is enough.
if (typeof car.setSunDirection === 'function' && sky.sunDir) {
  car.setSunDirection(sky.sunDir.clone().negate());
}

// Wire sky sun direction into the post-process volumetric fog pass.
if (sky.sunDir) engine.setSunDir(sky.sunDir);

// Place the car at the road's start, oriented along the road heading.
{
  const s = road.startSample();
  car.placeAt(s.position, s.heading);
}

const controls = new Controls();
const chase = new ChaseCamera(camera);
const hud = new Hud();
const audio = new EngineAudio();
const tireSmoke = new TireSmoke(scene);
const skidMarks = new SkidMarks(scene, terrain);
const impactSparks = new ImpactSparks(scene);

// Dev/verification handle: lets automated captures teleport the car along the
// road (e.g. `__game.teleport(1500)`) and inspect state. Not used by gameplay.
window.__game = {
  car, road, terrain, scene, camera, chase, race, rivals, hud, audio, tireSmoke, skidMarks,
  circuit, circuitRace, engine,
  teleport(d, lateral = 0) {
    const s = road.sampleAtDistance(d);
    const rx = Math.cos(s.heading), rz = -Math.sin(s.heading);
    const p = s.position.clone();
    p.x += rx * lateral; p.z += rz * lateral;
    car.placeAt(p, s.heading);
  },
  teleportCircuit(d, lateral = 0) {
    const s = circuit.sampleAtDistance(d);
    const rx = Math.cos(s.heading), rz = -Math.sin(s.heading);
    const p = s.position.clone();
    p.x += rx * lateral; p.z += rz * lateral;
    car.setRoad(circuit);
    car.placeAt(p, s.heading);
  },
  setRoadWorld() { car.setRoad(road); },
};
if (typeof hud.setCenterline === 'function') {
  hud.setCenterline(road.centerline());
}

// First-frame camera placement.
chase.update(0.016, car);

// Browsers block autoplay until a user gesture. Resume the audio graph on the
// first key / click / touch, then stop listening (the gesture is one-shot).
const resumeAudio = () => { audio.resume(); arm(); };
const arm = () => {
  window.removeEventListener('keydown', resumeAudio);
  window.removeEventListener('pointerdown', resumeAudio);
  window.removeEventListener('touchstart', resumeAudio);
};
window.addEventListener('keydown', resumeAudio);
window.addEventListener('pointerdown', resumeAudio);
window.addEventListener('touchstart', resumeAudio);

const FIXED = 1 / 60;
let acc = 0, last = performance.now(), fpsAcc = 0, fpsFrames = 0, fps = 60;

function hideLoading() {
  const el = document.getElementById('loading');
  if (el) el.classList.add('hidden');
  const hint = document.getElementById('hint');
  if (hint) hint.style.opacity = '1';
  setTimeout(() => { if (hint) hint.style.opacity = '0'; }, 6500);
}
hideLoading();

let gameStarted = false;
let mode = 'sprint'; // 'sprint' | 'circuit' | 'freeroam'
const startOverlay = document.getElementById('startOverlay');
const startBtn = document.getElementById('startBtn');
const freeroamBtn = document.getElementById('freeroamBtn');
const circuitBtn = document.getElementById('circuitBtn');

function beginGame({ m = 'sprint' } = {}) {
  if (gameStarted) return;
  gameStarted = true;
  mode = m;
  if (startOverlay) startOverlay.classList.add('hidden');
  if (mode === 'circuit') {
    car.setRoad(circuit);
    const s = circuit.startSample();
    car.placeAt(s.position, s.heading);
    circuitRace.reset();
    circuitRace.forceStart();
    rivals.group.visible = false;        // solo circuit time trial (v1)
    if (typeof hud.setCenterline === 'function') hud.setCenterline(circuit.centerline());
  } else if (mode === 'sprint') {
    race.forceStart();
    if (typeof hud.setCenterline === 'function') hud.setCenterline(road.centerline());
  }
  audio.resume();
}

if (startBtn) startBtn.addEventListener('click', () => beginGame({ m: 'sprint' }));
if (freeroamBtn) freeroamBtn.addEventListener('click', () => beginGame({ m: 'freeroam' }));
if (circuitBtn) circuitBtn.addEventListener('click', () => beginGame({ m: 'circuit' }));

let qualityTick = 0;
let impactLatch = false;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1; // clamp after tab switch

  // fps meter
  fpsAcc += dt; fpsFrames++;
  if (fpsAcc >= 0.5) { fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }

  const input = controls.poll();
  if (input.start) beginGame({ m: 'sprint' });
  if (input.camera) chase.cycleMode();
  if (input.mute) audio.toggleMute();
  if (input.reset) {
    if (mode === 'circuit') {
      const s = circuit.startSample();
      car.placeAt(s.position, s.heading);
      circuitRace.reset();
      circuitRace.forceStart();
    } else {
      const s = road.startSample();
      car.placeAt(s.position, s.heading);
      car.setRoad(road);
      race.reset();        // start the Road Race over
      rivals.reset();      // re-grid the AI field
      rivals.group.visible = true;
      if (typeof hud.setCenterline === 'function') hud.setCenterline(road.centerline());
    }
  }

  acc += dt;
  let steps = 0;
  const driveInput = gameStarted
    ? input
    : { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, reset: false, camera: input.camera };
  while (acc >= FIXED && steps < 4) {
    car.update(FIXED, driveInput, terrain);
    acc -= FIXED; steps++;
  }

  sky.update(dt, car);
  chase.update(dt, car);
  environment.update(dt, car);
  settlements.update(dt, car.position);
  festival.update(dt, car.position);
  const activeRoad = (mode === 'circuit') ? circuit : road;
  if (mode === 'circuit') {
    circuitRace.update(dt, car);
  } else {
    race.update(dt, car);
    rivals.update(dt, car);
  }
  parkedCars.update(dt, car.position);
  tireSmoke.update(dt, car, activeRoad, { boosting: gameStarted && input.boost });
  if (mode !== 'circuit') tireSmoke.updateOthers(dt, rivals.cars, activeRoad);
  skidMarks.update(dt, car, activeRoad);
  impactSparks.update(dt, car);
  boostPads.update(dt, car);
  water.update(dt, sky.sunDir);
  hud.update({ car, fps, race: (mode === 'circuit' ? circuitRace.state : race.state), rivals: (mode === 'circuit' ? null : rivals.state), camera });

  // Drive the synthetic engine sound from vehicle state. `slip` feeds the
  // tyre-squeal layer; handbrake + boost add their own character.
  audio.update(dt, {
    speed: car.speed,
    throttle: input.throttle,
    slip: car.slip,
    boosting: input.boost,
    airborne: car.airborne,
  });
  if (car.impact > 0.35 && !impactLatch) {
    audio.resume();
    audio.playImpact(car.impact);
    impactLatch = true;
  }
  if (car.impact < 0.1) impactLatch = false;

  engine.setSpeedStretch(0); // disabled — was flickering

  // Quality tier — update twice per second (avoids per-frame flicker).
  qualityTick += dt;
  if (qualityTick >= 0.5) {
    engine.setAdaptiveQuality(fps);
    qualityTick = 0;
  }

  engine.render();
}
requestAnimationFrame(frame);
