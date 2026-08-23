/**
 * FILL PROBE — how many milliseconds of the frame are PIXELS, and how many are not.
 *
 *   node tools/fill-probe.mjs --port 5501 --quality ultra
 *
 * ---------------------------------------------------------------------------
 *  THE QUESTION, AND WHY fps-bench CANNOT ANSWER IT
 * ---------------------------------------------------------------------------
 *  `fps-bench.mjs` reads the interval between presented frames. That is exactly
 *  right for "does the player get 60" and structurally useless for "what does
 *  the frame cost", because vsync CLAMPS it: a loop with 9 ms of headroom and a
 *  loop with 0.2 ms of headroom both report 16.67 ms.
 *
 *  Sweeping resolution DOWNWARD through that harness therefore reads:
 *
 *      2.07 Mpx  16.87 ms      0.52 Mpx  16.66 ms
 *      1.04 Mpx  16.67 ms      0.26 Mpx  16.67 ms
 *
 *  Four numbers that look like proof the frame is not fill-bound, and are in
 *  fact three measurements of the display's refresh rate plus one real one. An
 *  eightfold cut in pixels appears to buy 0.2 ms. It does not; the cost went
 *  down and the clamp did not move. YOU CANNOT SUBTRACT TWO CLAMPED NUMBERS.
 *
 * ---------------------------------------------------------------------------
 *  SO THIS SWEEPS UPWARD INSTEAD
 * ---------------------------------------------------------------------------
 *  Above the clamp the signal is free again: at 2.5-4.0 Mpx every frame misses
 *  vsync and the mean delta tracks the real cost. Fit frame time against
 *  megapixels THERE, where the measurement is honest, and read off:
 *
 *      slope     = ms per megapixel — fill: post chain, shading, overdraw
 *      intercept = everything that does not scale with drawing-buffer pixels —
 *                  JS, draw submission, vertex work, and SHADOW MAPS, which are
 *                  fixed-size targets and so live entirely in this term
 *
 *  The fit is then checked against the 1080p point it was NOT fitted on. On
 *  this build that check passes closely (predicted 17.24 ms, measured 16.7-17.2
 *  rested), which is the only reason to believe the extrapolation.
 *
 *  AN EARLIER VERSION OF THIS FILE TRIED TO REMOVE THE CLAMP DIRECTLY with
 *  `--disable-gpu-vsync --disable-frame-rate-limit`. Do not put those back.
 *  On this machine's ANGLE/Metal stack they make WebGL 2 context creation fail
 *  outright — the game boots to "WebGL 2 is unavailable, so the renderer cannot
 *  be created", or, worse, intermittently succeeds on the `direct` rung with no
 *  post chain at all, which would have produced a confident fill measurement of
 *  a pipeline that is not the one that ships.
 *
 * ---------------------------------------------------------------------------
 *  WHAT WOULD INVALIDATE THIS
 * ---------------------------------------------------------------------------
 *  `Renderer.effectivePixelRatio` applies a hard 4.0 Mpx backstop, so requests
 *  above it silently return the SAME buffer — `--scale 1.5` and `--scale 2.0`
 *  both give 2666x1500. Points are therefore keyed on the MEASURED buffer, not
 *  the requested scale, and duplicates are reported rather than fitted twice
 *  under different labels. If that backstop ever moves, this sweep's usable
 *  range moves with it.
 *
 *  Vsync also quantises the mean above the clamp (frames land on multiples of
 *  16.67), so the fit is lumpy. Treat the slope as good to ~15%, not to three
 *  figures, and re-run rather than believe a small change in it.
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const num = (n, d) => { const v = parseFloat(opt(n, '')); return Number.isFinite(v) ? v : d; };

const PORT = Math.round(num('--port', 5501));
const QUALITY = opt('--quality', 'ultra');
const SECONDS = num('--seconds', 12);
const SETTLE = num('--settle', 5);
const W = Math.round(num('--w', 1920));
const H = Math.round(num('--h', 1080));
const DSF = num('--dsf', 1);
const CPU = num('--cpu', 1);
const MOBILE = argv.includes('--mobile');
/**
 * Render scales to sweep. The defaults straddle the vsync clamp on purpose:
 * 1.0 is the reference point (usually clamped, and EXCLUDED from the fit), the
 * rest are above it where the signal is free.
 */
const SCALES = (opt('--scales', '1.0,1.1,1.2,1.3,1.4') || '').split(',').map(Number);
/** Idle between points, ms. See the relaunch note below — this machine needs it. */
const IDLE_MS = num('--idle', 45) * 1000;
/** Frames slower than this are unclamped enough to fit against. */
const UNCLAMPED_MS = 17.5;

const SOFTWARE = /swiftshader|llvmpipe|software|softwarerasterizer|basic render/i;
const RACING = 2; // RaceState.Racing — a const enum, not readable from the page.

const srv = await startVite(PORT);

/**
 * ONE FRESH BROWSER PER POINT. This is not tidiness, it is the difference
 * between a fit and noise.
 *
 * The first version of this loop reused a single browser and opened a new page
 * per scale. Each page holds a live WebGL context and this game's ~344 MB of
 * procedural textures, and Chrome does not reclaim either promptly, so by the
 * third point the GPU process was thrashing. The sweep came back
 * 29.7 / 40.8 / 50.7 / 34.8 / 33.4 ms — NON-MONOTONIC in resolution, with the
 * 2.07 Mpx point reading 29.72 ms against the 16.67 ms `fps-bench` measures for
 * the same buffer. The fit off that data had a NEGATIVE slope, which is the
 * measurement announcing it is meaningless.
 *
 * `fps-bench.mjs` gets away with one browser because it takes exactly one
 * measurement per process. Anything that sweeps must relaunch.
 */
const launch = () => puppeteer.launch({
  headless: 'shell',
  args: [
    '--no-sandbox',
    // A real GPU or nothing, exactly as fps-bench insists. Note the deliberate
    // absence of --enable-unsafe-swiftshader, and of the vsync flags (header).
    '--use-gl=angle',
    '--enable-gpu',
    `--window-size=${W},${H}`,
  ],
  timeout: 120000,
  protocolTimeout: 240000,
});

const rows = [];
let renderer = '';
let browser = null;

for (const scale of SCALES) {
  browser = await launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [pageerror]', String(e.message || e).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|_vercel|favicon/i.test(m.text())) {
      console.error('  [console]', m.text().slice(0, 300));
    }
  });
  await page.setViewport({ width: W, height: H, deviceScaleFactor: DSF, hasTouch: MOBILE, isMobile: MOBILE });
  if (CPU > 1) {
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  }
  // `scaler=off` pins the adaptive ladder. Without it the ladder reacts to the
  // deliberately-overloaded frame and walks the resolution down mid-run, which
  // would make the independent variable of this experiment a dependent one.
  await page.goto(`http://127.0.0.1:${PORT}/?quality=${QUALITY}&scaler=off&scale=${scale}`,
    { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__gameReady === true', { timeout: 180000 });

  if (renderer === '') {
    renderer = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      const e = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : '(masked)';
    });
    if (SOFTWARE.test(renderer)) {
      console.error(`software rasteriser (${renderer}); every number here would be fiction. Aborting.`);
      if (browser) await browser.close(); await srv.stop(); process.exit(2);
    }
  }

  // Drive into a real race. `autoDrive` is not optional: without it `start()`
  // runs the countdown and leaves the kart on the grid, and the wait below
  // never satisfies. Waiting for `Racing` alone is also not enough — the state
  // flips a frame before anything moves, and the countdown is a stationary kart
  // under an intro camera, a materially cheaper scene than the race.
  await page.evaluate(() => {
    const ctx = window.__ctx;
    ctx.race.autoDrive = true;
    ctx.race.start();
  });
  await page.waitForFunction((R) => {
    const r = window.__ctx?.race;
    if (!r || r.state !== R) return false;
    const k = r.player ?? r.karts?.[0];
    return !!k && Math.hypot(k.velocity.x, k.velocity.z) > 4;
  }, { timeout: 60000, polling: 100 }, RACING);
  await new Promise((r) => setTimeout(r, SETTLE * 1000));

  const s = await page.evaluate((secs) => new Promise((resolve) => {
    const deltas = [];
    let prev = performance.now();
    const t0 = prev;
    const tick = () => {
      const now = performance.now();
      deltas.push(now - prev);
      prev = now;
      if (now - t0 < secs * 1000) requestAnimationFrame(tick);
      else resolve({ deltas, health: window.__loopHealth?.() ?? null });
    };
    requestAnimationFrame(tick);
  }), SECONDS);

  const env = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return { w: c?.width ?? 0, h: c?.height ?? 0 };
  });

  if (s.health && s.health.scalerPinned !== true) {
    console.error(`\n?scaler=off did not take (scalerPinned=${s.health.scalerPinned}). ` +
      `The ladder was free to move the resolution mid-run, so this sweep is invalid. Aborting.`);
    if (browser) await browser.close(); await srv.stop(); process.exit(2);
  }

  // Mean, to match what fps-bench gates on: above the clamp the distribution is
  // a mix of vsync multiples and the mean is the only statistic that tracks the
  // underlying cost. The first few frames after the settle still carry the
  // transition, so they go.
  const d = s.deltas.slice(5);
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  const mpx = (env.w * env.h) / 1e6;
  rows.push({ scale, mpx, mean, buffer: `${env.w}x${env.h}` });
  await browser.close();
  browser = null;
  // Back-to-back runs measurably degrade this machine: four consecutive
  // fps-bench runs fell 59.9 -> 39.4 fps with no code change, and a two-minute
  // idle restored it. A sweep is exactly that pattern, so pay the idle.
  await new Promise((r) => setTimeout(r, IDLE_MS));
}

console.log(`\n--- fill-probe: ${W}x${H} dsf ${DSF}${CPU > 1 ? ` cpu/${CPU}` : ''} quality ${QUALITY} ---`);
console.log(`renderer: ${renderer}\n`);
console.log('  scale    buffer          Mpx    frame ms     fps   used in fit');
for (const r of rows) {
  const used = r.mean > UNCLAMPED_MS;
  console.log(`  ${String(r.scale).padEnd(7)} ${r.buffer.padEnd(12)} ${r.mpx.toFixed(3).padStart(6)} ` +
    `${r.mean.toFixed(2).padStart(9)} ${(1000 / r.mean).toFixed(1).padStart(7)}   ${used ? 'yes' : 'NO (vsync-clamped)'}`);
}

// Duplicate buffers mean the 4 Mpx backstop swallowed the request; say so
// rather than fitting the same point twice under two different scale labels.
const byBuffer = new Map();
for (const r of rows) byBuffer.set(r.buffer, (byBuffer.get(r.buffer) ?? 0) + 1);
for (const [b, n] of byBuffer) {
  if (n > 1) console.log(`\n  note: ${n} requested scales all produced ${b} — Renderer's 4.0 Mpx backstop clamped them.`);
}

const fit = rows.filter((r) => r.mean > UNCLAMPED_MS);
if (fit.length < 3) {
  console.error(`\nONLY ${fit.length} UNCLAMPED POINTS: every other row sat on the vsync ceiling, so there is ` +
    `nothing to fit. Raise --scales until the frame misses vsync. Refusing to report a slope.`);
  if (browser) await browser.close(); await srv.stop(); process.exit(2);
}
const n = fit.length;
const sx = fit.reduce((a, r) => a + r.mpx, 0);
const sy = fit.reduce((a, r) => a + r.mean, 0);
const sxx = fit.reduce((a, r) => a + r.mpx * r.mpx, 0);
const sxy = fit.reduce((a, r) => a + r.mpx * r.mean, 0);
const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
const intercept = (sy - slope * sx) / n;

const refMpx = (W * H * DSF * DSF) / 1e6;
const fillRef = slope * refMpx;
console.log(`\nfit over ${n} unclamped points: frame_ms = ${intercept.toFixed(2)} + ${slope.toFixed(2)} * Mpx`);
console.log(`  fill (scales with pixels)     : ${fillRef.toFixed(2)} ms at ${refMpx.toFixed(2)} Mpx`);
console.log(`  fixed  (does NOT scale)       : ${intercept.toFixed(2)} ms  <- JS, submission, vertex work, SHADOW MAPS`);
console.log(`  predicted total at ${refMpx.toFixed(2)} Mpx    : ${(intercept + fillRef).toFixed(2)} ms`);

// The validation that makes the extrapolation believable: compare against the
// reference row, which was deliberately kept out of the fit.
const ref = rows.find((r) => Math.abs(r.mpx - refMpx) < 0.05);
if (ref) {
  const err = intercept + fillRef - ref.mean;
  console.log(`  measured at ${refMpx.toFixed(2)} Mpx        : ${ref.mean.toFixed(2)} ms` +
    (ref.mean <= UNCLAMPED_MS ? '  (vsync-clamped — a floor, so the prediction should sit AT or ABOVE it)' : ''));
  console.log(`  fit error on the held-out point: ${err >= 0 ? '+' : ''}${err.toFixed(2)} ms`);
}
console.log(`\n  Driving resolution to zero cannot buy more than ${fillRef.toFixed(2)} ms.`);
console.log(`  If the gap to 16.7 ms is larger than that, PIXELS ARE NOT THE ANSWER on this profile.`);

await srv.stop();
