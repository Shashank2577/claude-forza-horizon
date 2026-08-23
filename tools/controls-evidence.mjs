/**
 * Evidence run for the properties touch-feel.mjs does not cover:
 * D1 handover, the release-ramp integrator at 30/60/120, the steering assist's
 * bound and its drift kill, the auto-drift floor, menu shadowing, and
 * preference persistence including a throwing setItem.
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

// Port is a flag, not a constant: several harnesses run concurrently in this
// repo and a hardcoded port makes two of them fight over one server — which
// vite-server.mjs refuses (it will not adopt a server serving another tree),
// so the collision shows up as a dead run rather than a bad number, but it is
// still a dead run.
const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const PORT = Number(argOf('--port', 5451));
const THROTTLE = Number(argOf('--throttle', 1));
const W = 844, H = 390;
const srv = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', `--window-size=${W},${H}`],
});
const results = [];
const gate = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`); };

const newPage = async (init) => {
  const p = await browser.newPage();
  await p.setViewport({ width: W, height: H, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  if (init) await p.evaluateOnNewDocument(init);
  const c = await p.createCDPSession();
  await c.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
  // `--throttle 4` slows the renderer to a quarter speed. This exists to prove
  // the timing gates measure the GAME and not the host: every gate here must
  // return the same verdict throttled as unthrottled. The two D1 gates used to
  // flip under a slow host, which is how this file came to report 16/16 for
  // its author and 14/16 for a reviewer on identical code.
  if (THROTTLE > 1) await c.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  await p.goto(`http://127.0.0.1:${PORT}/?quality=low`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction('window.__gameReady === true', { timeout: 90000 });
  return { p, c };
};
const mk = (p, c) => ({
  frames: (n = 4) => p.evaluate((k) => new Promise((res) => {
    let i = 0; const t = () => (++i < k ? requestAnimationFrame(t) : res());
    requestAnimationFrame(t);
  }), n),
  touch: (type, points) => c.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map((q, i) => ({ x: Math.round(q.x), y: Math.round(q.y), id: q.id ?? i, radiusX: 12, radiusY: 12, force: 1 })),
  }),
});

// ===========================================================================
console.log('\n=== A. menu shadowing (test 21) — BEFORE the race starts ===');
{
  const { p, c } = await newPage();
  const { frames } = mk(p, c);
  await frames(10);
  const r = await p.evaluate(() => {
    const live = [...document.querySelectorAll('.tc-root, .tc-root *')]
      .filter((e) => getComputedStyle(e).pointerEvents === 'auto' &&
        getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0);
    // sample the bottom-right quadrant, which is where the cluster lives
    const pts = []; let bad = 0;
    for (let x = innerWidth * 0.5; x < innerWidth; x += 12) {
      for (let y = innerHeight * 0.5; y < innerHeight; y += 12) {
        const el = document.elementFromPoint(x, y);
        pts.push(1);
        if (el && el.closest && el.closest('.tc-root')) bad++;
      }
    }
    return { menu: document.documentElement.dataset.menu, liveTc: live.length, sampled: pts.length, swallowed: bad };
  });
  gate('menus: 0 .tc-* elements are pointer-active while a menu is blocking',
    r.liveTc === 0, `menu=${r.menu}, ${r.liveTc} live .tc-* elements`);
  gate('menus: 0% of the bottom-right quadrant is swallowed by the pad',
    r.swallowed === 0, `${r.swallowed}/${r.sampled} sample points hit .tc-root`);
  await p.close();
}

// ===========================================================================
console.log('\n=== B. D1 — steering survives a thumb roll (test 1) ===');
{
  const { p, c } = await newPage();
  const { frames, touch } = mk(p, c);
  await p.evaluate(() => window.__ctx.race.start());
  await p.waitForFunction(() => window.__ctx.race.state === 2, { timeout: 60000 });
  await frames(20);
  const read = () => p.evaluate(() => {
    const s = window.__ctx.input.pad.state;
    return { steer: +s.steer.toFixed(4), steering: s.steering };
  });

  // A goes to lock, B lands in the spawn region, A lifts, B drags.
  await touch('touchStart', [{ x: 150, y: 250, id: 1 }]);
  await frames(3);
  await touch('touchMove', [{ x: 150 + 120, y: 250, id: 1 }]);
  await frames(4);
  const preLift = await read();
  await touch('touchStart', [{ x: 270, y: 250, id: 1 }, { x: 200, y: 300, id: 2 }]);
  await frames(3);
  // SAMPLED ON THE FIRST FRAME AFTER THE LIFT, NOT AFTER TWO WALL-CLOCK FRAMES.
  // This gate used to read the command after `frames(2)`. HANDOVER_SETTLE is
  // 100 ms, so on a host rendering ~60 ms frames those two frames land at
  // ~120 ms — past the settle, into the palm-safety decay — and the heir has
  // legitimately begun giving the command up by the time the gate looks. The
  // gate then failed a build whose handover is perfect. That is the second of
  // the two flakes that made this file report 16/16 for its author and 14/16
  // for a reviewer on identical code.
  //
  // The property is "the command does not JUMP when the thumb rolls", which is
  // a statement about the handover frame, not about 32 ms later. So the page
  // stamps it itself on the next rAF after pointerup.
  await p.evaluate(() => {
    const w = window;
    w.__roll = null;
    window.addEventListener('pointerup', () => {
      if (w.__roll !== null) return;
      requestAnimationFrame(() => {
        const s = w.__ctx.input.pad.state;
        w.__roll = { steer: +s.steer.toFixed(4), steering: s.steering };
      });
    }, true);
  });
  // CDP touchEnd semantics here are "the listed points are the ones released"
  // (probed by touch-feel.mjs, not assumed), so listing A releases A.
  await touch('touchEnd', [{ x: 270, y: 250, id: 1 }]);   // A lifts, B remains
  await p.waitForFunction(() => window.__roll !== null, { timeout: 5000 });
  const afterRoll = await p.evaluate(() => window.__roll);
  gate('D1: after the first thumb lifts, the heir holds the same command',
    Math.abs(afterRoll.steer - preLift.steer) <= 0.05 && afterRoll.steering === true,
    `pre-lift ${preLift.steer}, on the first frame after the roll ${afterRoll.steer} ` +
    `(steering ${afterRoll.steering}) — sampled in-page, so a slow host cannot walk ` +
    `this into the palm-safety decay`);

  // The heir inherits FULL LOCK, so the property to check is that its drag
  // moves the command from there — not that 80 px lands past -0.5, which would
  // only be true for an heir starting at zero. (The spec's baseline repro has
  // the broken build stuck at 0; the fixed build starts the heir at +1.)
  await touch('touchMove', [{ x: 200 - 80, y: 300, id: 2 }]);
  await frames(6);
  const dragged = await read();
  await touch('touchMove', [{ x: 200 - 175, y: 300, id: 2 }]);
  await frames(6);
  const dragged2 = await read();
  gate('D1: the heir then steers — its drag moves the command, both ways',
    (preLift.steer - dragged.steer) > 0.5 && dragged2.steer < -0.5,
    `heir inherited ${preLift.steer}; 80 px left -> ${dragged.steer} ` +
    `(delta ${(dragged.steer - preLift.steer).toFixed(3)}); 175 px left -> ${dragged2.steer}`);
  await touch('touchEnd', []);
  await frames(10);

  // No heir at all: back to exactly 0.
  await touch('touchStart', [{ x: 150, y: 250, id: 5 }]);
  await frames(3);
  await touch('touchMove', [{ x: 250, y: 250, id: 5 }]);
  await frames(4);
  await touch('touchEnd', []);
  await frames(10);
  const noHeir = await read();
  gate('D1: with no heir the command returns to exactly 0',
    noHeir.steer === 0 && noHeir.steering === false, JSON.stringify(noHeir));

  // Palm safety: an heir that never moves must lose its phantom lock.
  //
  // TIMED PAGE-SIDE, AND THAT IS THE WHOLE GATE. This used to stamp
  // `Date.now()` in NODE before dispatching the lift and poll with a
  // `p.evaluate` per frame, so the reading was:
  //     true decay + CDP delivery + one poll round-trip
  // touch-feel.mjs measures that delivery leg directly and reports 42 ms
  // median / 50 ms p95 under headless injection, and each poll iteration adds
  // another round-trip. The nominal decay is SETTLE 100 + DECAY 100 = 200 ms,
  // so the old gate was asking a 200 ms property to land inside a 260 ms
  // ceiling while carrying ~50-90 ms of transport it did not cause. It passed
  // on a fast machine and failed on a slow one — reported as 16/16 by its
  // author and 14/16 by a reviewer, twice, on identical code. An instrument
  // whose verdict depends on the host's frame rate measures the host.
  //
  // Both stamps now come from `performance.now()` INSIDE the page: one from a
  // capture-phase pointerup (which precedes the pad's own handler by
  // microseconds) and one from a rAF sampler watching the published command.
  // The transport leg is excluded by construction rather than budgeted for.
  await touch('touchStart', [{ x: 150, y: 250, id: 7 }]);
  await frames(3);
  await touch('touchMove', [{ x: 270, y: 250, id: 7 }]);
  await frames(4);
  await touch('touchStart', [{ x: 270, y: 250, id: 7 }, { x: 190, y: 300, id: 8 }]);
  await frames(3);
  await p.evaluate(() => {
    const w = window;
    w.__d1 = { up: -1, zero: -1, steerAtUp: null };
    window.addEventListener('pointerup', () => {
      if (w.__d1.up < 0) {
        w.__d1.up = performance.now();
        w.__d1.steerAtUp = w.__ctx.input.pad.state.steer;
      }
    }, true);
    const tick = () => {
      if (w.__d1.up >= 0 && w.__d1.zero < 0 && w.__ctx.input.pad.state.steer === 0) {
        w.__d1.zero = performance.now();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const tNode0 = Date.now();
  await touch('touchEnd', [{ x: 270, y: 250, id: 7 }]);   // the first thumb lifts
  await frames(40);
  const d1 = await p.evaluate(() => window.__d1);
  const wallMs = Date.now() - tNode0;
  await touch('touchEnd', []);
  const decayed = d1.zero >= 0 && d1.up >= 0 ? +(d1.zero - d1.up).toFixed(1) : -1;
  // The heir must actually HAVE a phantom lock to lose, or "it decayed" is
  // vacuously true and this gate would pass on a build that never handed over.
  gate('D1: a palm that never moves loses its phantom lock in 150-260 ms (page-side)',
    decayed >= 150 && decayed <= 260 && Math.abs(d1.steerAtUp ?? 0) > 0.5,
    `decayed to 0 in ${decayed} ms page-side, from a phantom lock of ${d1.steerAtUp} ` +
    `(SETTLE 100 + DECAY 100 + rAF quantisation). Node-side wall clock for the same ` +
    `lift was ${wallMs} ms — REPORTED, NOT GATED: that figure carries the CDP ` +
    `delivery leg and is the number the old gate was flaking on.`);
  await p.close();
}

// ===========================================================================
console.log('\n=== C. release ramp — frame-rate independence (test 8/10) ===');
{
  const { p, c } = await newPage();
  const { frames } = mk(p, c);
  await p.evaluate(() => window.__ctx.race.start());
  await p.waitForFunction(() => window.__ctx.race.state === 2, { timeout: 60000 });
  await frames(10);
  const r = await p.evaluate(() => {
    const pad = window.__ctx.input.pad;
    const run = (dt) => {
      pad.state.steer = 1;
      pad.state.steering = true;
      pad.releasing = true;
      let t = 0;
      for (let i = 0; i < 10000 && pad.state.steer !== 0; i++) { pad.update(null, dt); t += dt; }
      pad.releasing = false;
      pad.state.steering = false;
      pad.state.steer = 0;
      return +(t * 1000).toFixed(2);
    };
    return { f30: run(1 / 30), f60: run(1 / 60), f120: run(1 / 120) };
  });
  const spread = Math.max(r.f30, r.f60, r.f120) - Math.min(r.f30, r.f60, r.f120);
  gate('release: full lock -> 0 in 62.5 +/- 10 ms',
    [r.f30, r.f60, r.f120].every((v) => Math.abs(v - 62.5) <= 10),
    `30fps ${r.f30} ms, 60fps ${r.f60} ms, 120fps ${r.f120} ms`);
  gate('release: the integrator is frame-rate independent (spread <= 8 ms)',
    spread <= 8, `spread ${spread.toFixed(2)} ms across 30/60/120 fps`);
  await p.close();
}

// ===========================================================================
console.log('\n=== D. assists (tests 18/19) ===');
{
  const { p, c } = await newPage();
  const { frames, touch } = mk(p, c);
  await p.evaluate(() => window.__ctx.race.start());
  await p.waitForFunction(() => window.__ctx.race.state === 2, { timeout: 60000 });
  await frames(20);

  // A = 0: the assist must be EXACTLY inert.
  const inert = await p.evaluate(async () => {
    const i = window.__ctx.input; i.pad.setSteerAssist(0);
    const out = [];
    for (let k = 0; k < 20; k++) {
      await new Promise((r) => requestAnimationFrame(r));
      out.push(Math.abs(i.assistLast));
    }
    return Math.max(...out);
  });
  gate('assist: at A = 0 the correction is exactly 0 on every frame',
    inert === 0, `max |correction| over 20 frames = ${inert}`);

  // A = 0.60: bounded, and exactly 0 whenever driftDir != 0.
  await p.evaluate(() => window.__ctx.input.pad.setSteerAssist(0.6));
  await touch('touchStart', [{ x: 150, y: 250, id: 1 }]);
  await frames(2);
  const drift = await p.evaluate(() => {
    const r = document.querySelector('.tc-drift').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await touch('touchStart', [{ x: 150, y: 250, id: 1 }, { ...drift, id: 2 }]);
  const samples = [];
  for (let i = 0; i < 120; i++) {
    await touch('touchMove', [{ x: 150 + (i % 40 < 20 ? 90 : -90), y: 250, id: 1 }, { ...drift, id: 2 }]);
    await frames(2);
    samples.push(await p.evaluate(() => ({
      c: window.__ctx.input.assistLast,
      d: window.__ctx.race.player.driftDir,
      t: window.__ctx.race.player.driftTier,
    })));
  }
  await touch('touchEnd', []);
  const maxC = Math.max(...samples.map((s) => Math.abs(s.c)));
  const drifting = samples.filter((s) => s.d !== 0);
  const chargePhase = drifting.filter((s) => s.t === 0);
  const leak = drifting.filter((s) => s.c !== 0);
  gate('assist: |correction| never exceeds the 0.22 clamp at A = 0.60',
    maxC <= 0.2200001, `max |correction| = ${maxC.toFixed(4)} over ${samples.length} frames`);
  gate('assist: correction is exactly 0 on every frame with driftDir != 0',
    drifting.length > 0 && leak.length === 0,
    `${drifting.length} drifting frames (${chargePhase.length} of them still at tier 0 — the window a tier gate would MISS), ${leak.length} with a non-zero correction`);

  // Auto-drift steer floor.
  // Force a large line error so the +/-0.22 clamp is actually exercised rather
  // than passing because the kart happened to be on the racing line.
  const bound = await p.evaluate(() => {
    const i = window.__ctx.input, ctx = window.__ctx;
    const k = ctx.race.player, s = ctx.track.sample(k.t);
    i.pad.setSteerAssist(0.6);
    i.pad.state.steer = 0; i.pad.state.steering = true; i.pad.state.drift = false;
    const out = [];
    for (const push of [-40, -12, -4, 4, 12, 40]) {
      k.position.set(s.pos.x + s.binormal.x * push, s.pos.y + s.binormal.y * push, s.pos.z + s.binormal.z * push);
      i.update(ctx, 1 / 60);
      out.push({ push, c: +i.assistLast.toFixed(4) });
    }
    i.pad.state.steering = false; i.pad.state.steer = 0;
    return out;
  });
  const maxB = Math.max(...bound.map((b) => Math.abs(b.c)));
  gate('assist: the clamp BINDS at +/-0.22 under a large line error, and no further',
    Math.abs(maxB - 0.22) < 1e-6 && bound.every((b) => Math.abs(b.c) <= 0.2200001),
    bound.map((b) => `${b.push}m -> ${b.c}`).join('  '));

  // The floor has to be exercised through a REAL button hold: pad.update()
  // recomputes state.drift from the button's pointer every frame, so poking
  // pad.state.drift from the outside measures nothing at all (it did, once).
  await p.evaluate(() => window.__ctx.input.pad.setSteerAssist(0));
  const floor = {};
  for (const [name, a, dx] of [['off', 0, 12], ['half', 0.5, 12], ['full', 1, 12],
                               ['halfUnderArm', 0.5, 11], ['halfOverArm', 0.5, 16]]) {
    await touch('touchEnd', []).catch(() => {});
    await frames(8);
    await p.evaluate((v) => window.__ctx.input.pad.setDriftAssist(v), a);
    await touch('touchStart', [{ x: 150, y: 250, id: 1 }]);
    await frames(2);
    // +12 px of travel is a steer command of ~0.05 at this geometry: enough to
    // have asked for a direction, nowhere near Kart's 0.13 engage threshold.
    await touch('touchMove', [{ x: 150 + dx, y: 250, id: 1 }]);
    await frames(3);
    const before = await p.evaluate(() => +window.__ctx.input.state.steer.toFixed(4));
    await touch('touchStart', [{ x: 150 + dx, y: 250, id: 1 }, { ...drift, id: 2 }]);
    await frames(2);
    floor[name] = await p.evaluate(() => +window.__ctx.input.state.steer.toFixed(4));
    floor[name + 'Before'] = before;
    await touch('touchEnd', []).catch(() => {});
    await frames(6);
  }
  await p.evaluate(() => window.__ctx.input.pad.setDriftAssist(0.5));
  gate('auto-drift: the floor is 0 / 0.08 / 0.16 at A = 0 / 0.5 / 1',
    Math.abs(floor.off - floor.offBefore) < 0.002 &&
    Math.abs(floor.full - 0.16) < 0.006 &&
    Math.abs(floor.halfUnderArm - floor.halfUnderArmBefore) < 0.002 &&
    Math.abs(floor.halfOverArm - 0.16) < 0.006,
    `12 px of travel (${floor.offBefore}) with DRIFT held publishes off ${floor.off} / half ${floor.half} / full ${floor.full}; ` +
    `at A=0.5 the arm sits between 11 px (${floor.halfUnderArm}, untouched) and 16 px (${floor.halfOverArm}, floored). ` +
    'Kart commits a slide at 0.13.');
  await p.close();
}

// ===========================================================================
console.log('\n=== E. persistence (test 23) ===');
{
  const { p, c } = await newPage();
  const { frames } = mk(p, c);
  await frames(6);
  await p.evaluate(() => {
    const pad = window.__ctx.input.pad;
    pad.setScheme('fixed'); pad.setHand('left'); pad.setAuto(false);
    pad.setHaptics(false); pad.setSteerAssist(0.6); pad.setDriftAssist(1); pad.setTiltRange(34);
  });
  await frames(4);
  const stored = await p.evaluate(() => localStorage.getItem('kr.controls.v1'));
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForFunction('window.__gameReady === true', { timeout: 90000 });
  await frames(6);
  const after = await p.evaluate(() => {
    const pr = window.__ctx.input.pad.prefs;
    return { scheme: pr.scheme, hand: pr.hand, autoAccel: pr.autoAccel, haptics: pr.haptics,
      steerAssist: pr.steerAssist, driftAssist: pr.driftAssist, tiltRange: pr.tiltRange,
      liveAuto: window.__ctx.input.pad.auto,
      handAttr: document.documentElement.getAttribute('data-touch-hand'),
      schemeAttr: document.documentElement.getAttribute('data-touch-scheme') };
  });
  gate('prefs: every field survives a reload',
    after.scheme === 'fixed' && after.hand === 'left' && after.autoAccel === false &&
    after.haptics === false && after.steerAssist === 0.6 && after.driftAssist === 1 &&
    after.tiltRange === 34 && after.liveAuto === false &&
    after.handAttr === 'left' && after.schemeAttr === 'fixed',
    JSON.stringify(after));
  gate('prefs: one versioned key', /"v":1/.test(stored || ''), `kr.controls.v1 = ${stored}`);
  await p.close();
}

// --- a throwing setItem and a corrupt record must not take the game down ---
{
  const { p } = await newPage(() => {
    localStorage.setItem('kr.controls.v1', '{not json at all');
    const proto = Object.getPrototypeOf(localStorage);
    Object.defineProperty(proto, 'setItem', {
      value() { throw new DOMException('QuotaExceededError'); }, configurable: true,
    });
  });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  const r = await p.evaluate(() => {
    const pad = window.__ctx.input.pad;
    let threw = null;
    try { pad.setHand('left'); pad.setScheme('tilt'); pad.setAuto(false); } catch (e) { threw = String(e); }
    return { ready: window.__gameReady === true, scheme: pad.prefs.scheme, threw,
      mounted: !!document.querySelector('.tc-root') };
  });
  gate('prefs: a throwing setItem and a corrupt record do not take the game down',
    r.ready === true && r.threw === null && errs.length === 0 && r.mounted,
    `__gameReady ${r.ready}, pad mounted ${r.mounted}, throw ${r.threw}, page errors ${errs.length}`);
  await p.close();
}

// ===========================================================================
// The drift ladder is the reason this whole round exists, and it shipped with
// no reading of any kind — the halo and the reclaimed charge rails were argued
// in prose. That is the failure mode CLAUDE.md names outright: "a spec section
// implemented thoroughly but never measured is worth less than a smaller
// change with a harness behind it". These are the missing gates.
console.log('\n=== F. the drift ladder under a thumb (tests 15/16) ===');
{
  const { p, c } = await newPage();
  const { frames, touch } = mk(p, c);
  await p.evaluate(() => window.__ctx.race.start());
  await p.waitForFunction(() => window.__ctx.race.state === 2, { timeout: 60000 });
  // A real touch is what mounts the pad; without it there is no .tc-halo.
  await touch('touchStart', [{ x: 150, y: 250, id: 1 }]);
  await frames(2);
  await touch('touchEnd', []);
  await frames(6);

  // Walk 1 -> 2 -> 3, letting each flare FINISH before the next tier — which is
  // what a real ladder does, seconds apart, and is the case the shared
  // animation-name bug hid in. A finished CSS animation is dropped from
  // getAnimations(), so "did the cue fire at this tier" is exactly "is there a
  // running animation on the halo one frame after the attribute changed".
  const sweep = () => p.evaluate(async () => {
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const el = document.querySelector('.tc-halo');
    if (!el) return { error: 'no .tc-halo element' };
    const root = document.documentElement;
    root.removeAttribute('data-drift-tier');
    await sleep(560);
    const seen = [];
    for (const tier of ['1', '2', '3']) {
      root.setAttribute('data-drift-tier', tier);
      await raf();
      const anims = el.getAnimations();
      seen.push({
        tier,
        running: anims.length,
        names: anims.map((a) => a.animationName),
        // near 0 proves it RESTARTED rather than being a survivor of the last tier
        t: anims.length ? Math.round(Number(anims[0].currentTime) || 0) : -1,
      });
      await sleep(560);   // let it finish, as a real ladder would
    }
    root.removeAttribute('data-drift-tier');
    return { seen };
  });

  const r = await sweep();
  const ok = !r.error && r.seen.every((s) => s.running >= 1 && s.t <= 120);
  const names = (r.seen || []).map((s) => s.names[0]);
  gate('drift: the tier-up flare fires at EVERY tier, not just the first',
    ok && new Set(names).size === 3,
    r.error || r.seen.map((s) => `t${s.tier}: ${s.running} running ${JSON.stringify(s.names)} at ${s.t}ms`).join('; ') +
    ' — distinct animation-names are what makes it restart');

  // NEGATIVE CONTROL. A gate that reports "all three fired" is only worth
  // something if it can report "only the first fired" on the build that was
  // actually broken. So reintroduce the defect in the page — one shared
  // animation-name across all three tiers, which is precisely what shipped —
  // and require the SAME probe to catch it. Without this, a probe that simply
  // never returns [] would pass forever.
  await p.evaluate(() => {
    const s = document.createElement('style');
    s.id = 'nc';
    s.textContent =
      'html[data-drift-tier="1"] .tc-halo,' +
      'html[data-drift-tier="2"] .tc-halo,' +
      'html[data-drift-tier="3"] .tc-halo{animation:tc-flareNC .44s ease-out !important}' +
      '@keyframes tc-flareNC{0%{filter:brightness(2.4)}100%{filter:brightness(1)}}';
    document.head.appendChild(s);
  });
  const nc = await sweep();
  const ncSilent = !nc.error && nc.seen[0].running >= 1 &&
    nc.seen[1].running === 0 && nc.seen[2].running === 0;
  gate('drift: NEGATIVE CONTROL — the shared-name build is caught (t2/t3 silent)',
    ncSilent,
    nc.error || nc.seen.map((s) => `t${s.tier}: ${s.running} running`).join('; ') +
    ' — this is the defect that shipped; the probe must fail it, or the gate above proves nothing');
  await p.evaluate(() => document.getElementById('nc')?.remove());

  // Test 16: the charge rails were 100% behind the notch on three shipping
  // iPhones because their inset had no env() term. Chrome reports every
  // env(safe-area-inset-*) as 0 however the viewport is emulated (touch-feel
  // documents this), so the computed value cannot distinguish a correct rule
  // from a missing one. The honest check is on the RULE, not the pixel.
  const rails = await p.evaluate(() => {
    const out = { l: null, r: null };
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      // A STYLE RULE ALSO HAS `cssRules` NOW. Chrome supports CSS nesting, so
      // every CSSStyleRule exposes an EMPTY CSSRuleList — which is an object,
      // which is truthy. The obvious walk ("if it has cssRules, recurse and
      // move on") therefore skips every single style rule in the document and
      // reports that nothing matches, from a sheet where the rule is plainly
      // present. This probe did exactly that and confidently called a correct
      // stylesheet broken. Test the selector first; recurse only on a list
      // that actually has entries.
      const walk = (list) => {
        for (const rule of list) {
          if (rule.selectorText) {
            if (/\.kr-charge-e\.l\b/.test(rule.selectorText) && /env\(/.test(rule.cssText)) out.l = rule.cssText.slice(0, 90);
            if (/\.kr-charge-e\.r\b/.test(rule.selectorText) && /env\(/.test(rule.cssText)) out.r = rule.cssText.slice(0, 90);
          }
          if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules);
        }
      };
      walk(rules);
    }
    return out;
  });
  gate('drift: both charge rails carry an env(safe-area-inset) term (source text)',
    !!rails.l && !!rails.r,
    `left ${rails.l ? 'has env()' : 'MISSING'}, right ${rails.r ? 'has env()' : 'MISSING'} ` +
    '— read from the CSSOM rule text, because Chrome resolves env() to 0 under every ' +
    'emulated viewport and the computed value cannot tell a correct rule from an absent one');
  await p.close();
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} evidence gates pass`);
await browser.close();
srv.stop();
process.exit(results.every((r) => r.ok) ? 0 : 1);
