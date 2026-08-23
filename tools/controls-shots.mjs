/**
 * Mobile capture: title (glyph row), the controls screen in each scheme, the
 * in-race cluster with the drift halo lit, and the left-handed mirror.
 * shot.mjs does not emulate touch, so the pad never mounts under it.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

// Literal ROOT: tools scripts run in a sandbox with no `process` global.
const ROOT = '/Users/ryan/dev/personal/kart-game';
const OUT = join(ROOT, 'shots/controls');
const PORT = Number((() => { const i = process.argv.indexOf("--port"); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : 5451; })());
const W = 844, H = 390;

mkdirSync(OUT, { recursive: true });
const srv = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', `--window-size=${W},${H}`],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const cdp = await page.createCDPSession();
await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));

await page.goto(`http://127.0.0.1:${PORT}/?quality=medium`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__gameReady === true', { timeout: 90000 });

const frames = (n = 8) => page.evaluate((k) => new Promise((res) => {
  let i = 0; const t = () => (++i < k ? requestAnimationFrame(t) : res());
  requestAnimationFrame(t);
}), n);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: points.map((p, i) => ({ x: Math.round(p.x), y: Math.round(p.y), id: p.id ?? i, radiusX: 12, radiusY: 12, force: 1 })),
});
const shot = async (n) => { await page.screenshot({ path: join(OUT, n + '.png') }); console.log('wrote', n); };

// --- 1. title, first run: glyph row + breathing ghost stick
await frames(20);
await shot('01-title');

// --- 2. the controls screen, floating (default)
await page.evaluate(() => {
  document.querySelector('.kr-btn-controls').click();
});
await frames(20);
await shot('02-controls-floating');

// --- 3. tilt selected (shows the tilt row + live degrees)
await page.evaluate(() => {
  [...document.querySelectorAll('.kc-card')][2].click();
});
await frames(20);
await shot('03-controls-tilt');

// --- 4. buttons scheme, previewed live
await page.evaluate(() => { [...document.querySelectorAll('.kc-card')][3].click(); });
await frames(20);
await shot('04-controls-buttons');

// --- back to floating, close
await page.evaluate(() => {
  [...document.querySelectorAll('.kc-card')][0].click();
  document.querySelector('.kc-done').click();
});
await frames(10);

// --- 5. in race, thumb on the stick + DRIFT held, halo lit
await page.evaluate(() => { window.__ctx.race.start(); });
await page.waitForFunction(() => window.__ctx.race.state === 2, { timeout: 60000 });
await frames(90);
const drift = await page.evaluate(() => {
  const r = document.querySelector('.tc-drift').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await touch('touchStart', [{ x: 150, y: 250, id: 1 }]);
await frames(3);
await touch('touchStart', [{ x: 150, y: 250, id: 1 }, { ...drift, id: 2 }]);
await frames(3);
// Hold a slide and shoot WHILE IT IS ACTUALLY SLIDING.
//
// This loop used to run a fixed 40 iterations at constant lock waiting for
// driftTier >= 1, and never got one: a constant steer draws a constant radius
// on a track that is not a constant-radius corner, so the slide sustains for
// about 0.9 s, breaks, and the kart is into a wall by the time the shutter
// opens. The capture it produced was labelled "drift halo" and had
// data-drift-tier NULL — a picture of the thing not happening. Shoot on the
// frame the state is true instead of hoping it is true later.
let info = null;
for (let i = 0; i < 40; i++) {
  await touch('touchMove', [{ x: 198, y: 250, id: 1 }, { ...drift, id: 2 }]);
  await frames(3);
  const s = await page.evaluate(() => ({
    tier: window.__ctx.race.player.driftTier,
    dir: window.__ctx.race.player.driftDir,
    fill: getComputedStyle(document.documentElement).getPropertyValue('--fill'),
    attr: document.documentElement.getAttribute('data-drift-tier'),
    steer: window.__ctx.input.state.steer,
  }));
  // Shoot on the first frame the slide is live, and again if a tier banks —
  // never after, because "after" is a picture of the kart in a wall.
  if (s.dir !== 0 && (!info || s.tier > info.tier)) {
    await shot('05-race-drift-halo');
    info = s;
    if (s.tier >= 1) break;
  } else if (info && s.dir === 0) break;   // slide broke; we already have the shot
}
console.log('drift state at shutter:', JSON.stringify(info));
if (!info) console.log('  NOTE: no live slide was captured — shot 05 is a plain cluster shot.');
await touch('touchEnd', []);
await frames(30);

// --- 5b. the halo at each tier, as a CSS-STATE capture.
// Labelled separately and deliberately: these drive data-drift-tier and --fill
// directly, so they show what the halo LOOKS like at each rung and prove
// nothing about when it fires. That it fires on every tier transition is a
// gated property, in controls-evidence.mjs section F, with a negative control.
// Keeping the two apart is the point — a screenshot cannot find a gameplay bug.
await touch('touchStart', [{ x: 150, y: 250, id: 1 }]);
await frames(2);
await touch('touchMove', [{ x: 198, y: 250, id: 1 }, { ...drift, id: 2 }]);
await frames(2);
for (const [tier, fill] of [['1', '0.55'], ['2', '0.80'], ['3', '1']]) {
  await page.evaluate(([t, f]) => {
    const r = document.documentElement;
    r.setAttribute('data-drift-tier', t);
    r.style.setProperty('--fill', f);
  }, [tier, fill]);
  await frames(3);
  await shot(`05b-halo-tier${tier}-cssstate`);
}
await page.evaluate(() => {
  document.documentElement.removeAttribute('data-drift-tier');
  document.documentElement.style.removeProperty('--fill');
});
await touch('touchEnd', []);
await frames(20);

// --- 6. left-handed mirror, mid race
await page.evaluate(() => { window.__ctx.input.pad.setHand('left'); });
await frames(30);
await touch('touchStart', [{ x: 700, y: 250, id: 3 }]);
await frames(3);
await touch('touchMove', [{ x: 640, y: 250, id: 3 }]);
await frames(6);
const mirrored = await page.evaluate(() => window.__ctx.input.pad.state.steer);
console.log('left-hand leftward drag steer =', mirrored, '(must be < 0)');
await touch('touchMove', [{ x: 760, y: 250, id: 3 }]);
await frames(6);
const mirroredR = await page.evaluate(() => window.__ctx.input.pad.state.steer);
console.log('left-hand rightward drag steer =', mirroredR, '(must be > 0.5 — test 25)');
await shot('06-race-left-handed');
await touch('touchEnd', []);
await page.evaluate(() => { window.__ctx.input.pad.setHand('right'); });
await frames(10);

// --- 7. manual throttle (GAS revealed)
await page.evaluate(() => { window.__ctx.input.pad.setAuto(false); });
await frames(10);
await shot('07-race-manual-gas');
await page.evaluate(() => { window.__ctx.input.pad.setAuto(true); });

// --- 8. pause screen: controls must NOT be drawn over it
await page.evaluate(() => { window.__ctx.race.setPaused(true); });
await frames(20);
await shot('08-paused-no-controls');

await browser.close();
srv.stop();
process.exit(0);
