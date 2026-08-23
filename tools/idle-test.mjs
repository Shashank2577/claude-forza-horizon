/**
 * Start a race on a phone, touch NOTHING, and check the kart drives forward.
 *
 *   node tools/idle-test.mjs [port]
 *
 * This exists because of a bug that made the game unplayable on a phone and
 * that no other harness in this repo could see.
 *
 * Auto-accelerate is on by default on touch — one thumb steers, the other
 * drifts, and nobody has a spare thumb for a throttle. Separately, the grid has
 * a rocket start: `Race.armCountdown` reads how long the throttle was held
 * through the countdown and either boosts you off the line or, past
 * BURNOUT_WINDOW, punishes the over-rev with `spinOut(0.75)`.
 *
 * Both are good features. Together they meant the assist held the throttle for
 * the entire ~3 s countdown, sailed past the 1.75 s burnout window, and EVERY
 * race on a phone opened with a guaranteed spin-out. With no steering input the
 * spin direction is constant, so the kart came out of it facing backwards and
 * auto-accelerate then drove it up the circuit the wrong way — while the player
 * had not touched the screen once.
 *
 * Why the existing gates all stayed green: touch-test.mjs asserts that a drag
 * steers, drift-bench.mjs drives with a script that holds a real throttle, and
 * every screenshot of the grid looks perfect because the spin happens after the
 * lights go out. The bug lives in the interaction between two features that are
 * each individually correct, and only shows up if nobody touches anything.
 *
 * The assertion is deliberately about HEADING, not lap progress: a kart that is
 * pointing the wrong way is broken even if it later finds its way round.
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const PORT = parseInt(process.argv[2] || '5547', 10);
const W = 844, H = 390;
const SAMPLES = 8;

const srv = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', `--window-size=${W},${H}`],
});

const fails = [];
let rows = [];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });

  const tap = async (x, y) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1, radiusX: 12, radiusY: 12, force: 1 }] });
    await new Promise((r) => setTimeout(r, 60));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await new Promise((r) => setTimeout(r, 500));
  };

  await page.goto(`http://127.0.0.1:${PORT}/?quality=medium`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__gameReady === true', { timeout: 90000 });

  // Through the menus the way a player does — two taps, nothing else.
  await tap(W / 2, H / 2);
  const btn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.kr-btn')].find((e) => /start/i.test(e.textContent || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!btn) throw new Error('no Start Race button found on the select screen');
  await tap(btn.x, btn.y);

  // ---- from here on, no input at all -------------------------------------
  for (let i = 0; i < SAMPLES; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    rows.push(await page.evaluate(() => {
      const ctx = window.__ctx;
      const race = ctx.race, k = race.player, s = ctx.input.state;
      const probe = ctx.track.probe(k.object.position, -1);
      const tan = ctx.track.sample(probe.t).tangent;
      const f = { x: Math.sin(k.object.rotation.y), z: Math.cos(k.object.rotation.y) };
      return {
        t: +race.raceTime.toFixed(1),
        state: race.state,
        steer: +s.steer.toFixed(2),
        accel: +(s.accel ?? 0).toFixed(2),
        accelAuto: !!s.accelAuto,
        stun: +(k.stunTime ?? 0).toFixed(2),
        // +1 = facing the way the circuit goes, -1 = pointing backwards
        alongTrack: +(f.x * tan.x + f.z * tan.z).toFixed(2),
        speed: +(((k.velocity?.length?.() ?? 0)) * 3.6).toFixed(0),
      };
    }));
  }

  const w = 8;
  console.log(['t', 'state', 'steer', 'accel', 'auto', 'stun', 'along', 'km/h'].map((h) => h.padStart(w)).join(''));
  for (const r of rows) {
    console.log([r.t, r.state, r.steer, r.accel, r.accelAuto, r.stun, r.alongTrack, r.speed]
      .map((v) => String(v).padStart(w)).join(''));
  }

  const racing = rows.filter((r) => r.state === 2);
  if (!racing.length) fails.push('the race never reached the Racing state');

  // The player asked for nothing, so nothing may be steering.
  const steered = racing.filter((r) => Math.abs(r.steer) > 0.01);
  if (steered.length) fails.push(`steer was non-zero on ${steered.length} sample(s) with no touch input`);

  // Nothing may stun the player on a clean, untouched start.
  const stunned = racing.filter((r) => r.stun > 0.01);
  if (stunned.length) {
    fails.push(`player was stunned on an untouched start (max ${Math.max(...stunned.map((r) => r.stun))}s) ` +
      '— check the rocket-start burnout in Race.armCountdown against auto-accelerate');
  }

  // And it must be pointing forwards throughout.
  const backwards = racing.filter((r) => r.alongTrack < 0.35);
  if (backwards.length) {
    fails.push(`kart pointed away from the circuit on ${backwards.length}/${racing.length} sample(s) ` +
      `(worst ${Math.min(...racing.map((r) => r.alongTrack))}) — it drove the wrong way untouched`);
  }
} finally {
  await browser.close();
  await srv.stop();
}

console.log();
if (fails.length) {
  console.log('FAIL — an untouched start does not drive forward:');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log(`PASS — untouched on a phone, the kart drives forward for all ${rows.length} samples`);
