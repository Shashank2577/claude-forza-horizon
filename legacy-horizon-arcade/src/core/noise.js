// Lightweight 2D/3D value+gradient noise utilities, deterministic and seedable.
// Used by terrain heightfields, scattering, and texture jittering.

function hash(x, y, seed = 0) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1274126177;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h & 0xffffffff) / 0xffffffff;
}

function smooth(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + (b - a) * t; }

// 2D value noise in [0,1]
export function valueNoise2D(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const v00 = hash(xi, yi, seed);
  const v10 = hash(xi + 1, yi, seed);
  const v01 = hash(xi, yi + 1, seed);
  const v11 = hash(xi + 1, yi + 1, seed);
  const u = smooth(xf), v = smooth(yf);
  return lerp(lerp(v00, v10, u), lerp(v01, v11, u), v);
}

// Fractal Brownian motion — layered noise for natural terrain.
export function fbm2D(x, y, { octaves = 5, lacunarity = 2.0, gain = 0.5, frequency = 1.0, seed = 0 } = {}) {
  let amp = 0.5, freq = frequency, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2D(x * freq, y * freq, seed + i * 31);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function lerpN(a, b, t) { return a + (b - a) * t; }
export function damp(current, target, lambda, dt) {
  return lerpN(current, target, 1 - Math.exp(-lambda * dt));
}
export const TAU = Math.PI * 2;
