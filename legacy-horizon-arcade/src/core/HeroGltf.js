// HeroGltf.js — load free CC0 Khronos CarConcept onto player / rivals / parked cars.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODEL_URLS = [
  '/models/CarConcept.glb',
  'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/CarConcept/glTF-Binary/CarConcept.glb',
];

const TARGET_LENGTH = 4.6;

let _cachedScene = null;
let _loading = false;
const _queue = [];

function isPaintMaterial(name = '') {
  const n = String(name).toLowerCase();
  return n.includes('paint') || n.includes('panel sides');
}

function fitAndAttach(car, source, opts = {}) {
  if (!car?.group) return;

  const {
    length = TARGET_LENGTH,
    paintColor = null,
    castShadow = true,
    rotY = 0, // CarConcept faces +Z (our forward); do NOT flip 180°
    lightweight = false,
  } = opts;

  const model = source.clone(true);

  // AI / parked: drop interior + engine detail (huge mesh count, never seen).
  if (lightweight) {
    const remove = [];
    model.traverse((o) => {
      const n = (o.name || '').toLowerCase();
      if (
        n.startsWith('interior') ||
        n.startsWith('engine') ||
        n.includes('pedal') ||
        n.includes('steering') ||
        n.includes('seat') ||
        n.includes('floormat') ||
        n.includes('dashboard') ||
        n.includes('license')
      ) {
        remove.push(o);
      }
    });
    for (const o of remove) {
      if (o.parent) o.parent.remove(o);
    }
  }

  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  const longest = Math.max(size.x, size.z) || 1;
  model.scale.setScalar(length / longest);

  box.setFromObject(model);
  const center = new THREE.Vector3();
  box.getCenter(center);
  // Sit slightly into the contact plane so wheels kiss the asphalt.
  model.position.set(-center.x, -box.min.y - 0.04, -center.z);
  model.rotation.y = rotY;

  const paint = paintColor != null ? new THREE.Color(paintColor) : null;

  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = castShadow;
    o.receiveShadow = true;
    // Skip frustum cull issues on complex cars near camera.
    o.frustumCulled = false;

    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const next = mats.map((m) => {
      if (!m) return m;
      const mat = m.clone();
      if (car.envMap && 'envMap' in mat) {
        mat.envMap = car.envMap;
        // The PMREM env contains a full-white sun proxy; at high env intensity
        // every sun-facing panel mirrored it into a white glare blob (critic
        // kill-list). Keep IBL modest — the directional sun supplies the hot
        // highlight, the env only fills sky/ground reflection.
        mat.envMapIntensity = 0.55;
      }
      // CarConcept paints are named "Paint 1 Carmine", "Paint 2 Pearl", etc.
      if (paint && isPaintMaterial(mat.name)) {
        mat.color = paint.clone();
        if ('metalness' in mat) mat.metalness = 0.72;
        if ('roughness' in mat) mat.roughness = 0.28;
        // Cap clearcoat AND roughen it slightly: a tight 0.03-roughness coat
        // acts as a mirror for the env's sun proxy → white blob. A broader,
        // dimmer coat keeps the glossy streak without clipping.
        if ('clearcoat' in mat) mat.clearcoat = Math.min(Math.max(mat.clearcoat || 0, 0.5), 0.7);
        if ('clearcoatRoughness' in mat) mat.clearcoatRoughness = Math.max(mat.clearcoatRoughness || 0, 0.22);
      }
      const mn = String(mat.name || '').toLowerCase();
      if (mn.includes('headlight') || mn.includes('signallight')) {
        if ('emissive' in mat) {
          mat.emissive = new THREE.Color(0xfff2d0);
          mat.emissiveIntensity = Math.max(mat.emissiveIntensity || 0, 2.2);
        }
      }
      if (mn.includes('brakelight')) {
        if ('emissive' in mat) {
          mat.emissive = new THREE.Color(0xff1a1a);
          mat.emissiveIntensity = Math.max(mat.emissiveIntensity || 0, 1.6);
        }
      }
      mat.needsUpdate = true;
      return mat;
    });
    o.material = Array.isArray(o.material) ? next : next[0];
  });

  if (car._body) car._body.visible = false;
  if (car._wheels) {
    for (const w of car._wheels) {
      if (w.pivot) w.pivot.visible = false;
    }
  }

  if (car._gltfRoot) {
    car.group.remove(car._gltfRoot);
    car._gltfRoot = null;
  }
  car._gltfRoot = model;
  car.group.add(model);
}

function flushQueue() {
  while (_queue.length) {
    const { car, opts } = _queue.shift();
    fitAndAttach(car, _cachedScene, opts);
  }
}

/** Load CarConcept onto `car`. Options: length, paintColor, castShadow, rotY. */
export function loadCarGltf(car, opts = {}) {
  if (!car?.group) return;
  if (_cachedScene) {
    fitAndAttach(car, _cachedScene, opts);
    return;
  }
  _queue.push({ car, opts });
  if (_loading) return;
  _loading = true;

  const loader = new GLTFLoader();
  let idx = 0;
  const tryNext = () => {
    if (idx >= MODEL_URLS.length) {
      _loading = false;
      _queue.length = 0;
      console.warn('[HeroGltf] failed to load CarConcept');
      return;
    }
    const url = MODEL_URLS[idx++];
    loader.load(
      url,
      (gltf) => {
        _cachedScene = gltf.scene;
        _loading = false;
        flushQueue();
      },
      undefined,
      tryNext,
    );
  };
  tryNext();
}

export function loadHeroGltf(car) {
  // Hero: candy red to match the game's paint language.
  loadCarGltf(car, { length: TARGET_LENGTH, paintColor: 0x8a1018, castShadow: true });
}
