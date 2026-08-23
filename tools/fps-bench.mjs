/**
 * Sustained frame rate — the number nobody in this repo was actually measuring.
 *
 *   node tools/fps-bench.mjs --profile desktop
 *   node tools/fps-bench.mjs --profile mobile
 *
 * `hitch-check.mjs` finds compile stalls, `perf.mjs` counts draw calls and
 * `mobile-soak.mjs` watches memory. All three can be green on a build that
 * runs at 41 fps, because none of them ever asks how long a frame takes for the
 * whole of a race. This does, and it reports the distribution rather than a
 * mean: a median of 16.7 ms with 8% of frames at 33 ms is not 60 fps, it is
 * 60 fps with a visible judder every dozen frames, and the mean hides it.
 *
 * Why the tricky parts are the way they are
 * -----------------------------------------
 *
 * **It refuses to run on a software rasteriser.** This is the single most
 * important line in the file. Every other harness here passes
 * `--enable-unsafe-swiftshader`, which is right for them — they are asking
 * correctness questions and a slow answer is still an answer. For a timing
 * harness that flag is poison: headless Chrome silently falls back to
 * SwiftShader, every frame becomes CPU rasterisation, and the script produces
 * confident, precise, entirely fictional milliseconds. So the flag is
 * deliberately absent, `UNMASKED_RENDERER_WEBGL` is read off the context the
 * game actually rendered with, and the run hard-exits non-zero if it looks like
 * a software device. The renderer string is printed on every run so a number
 * from this harness is always attributable to a device.
 *
 * **Frames are counted at the rAF batch, not by a probe callback.** All
 * callbacks in one browser frame receive the same rAF timestamp, so grouping by
 * that timestamp gives exactly the browser's frame boundaries with no extra
 * callback of our own perturbing the queue. `window.requestAnimationFrame` is
 * wrapped after boot; `main.ts` re-registers its loop with a bare global call
 * every frame, so the wrap takes effect on the next frame and stays.
 *
 * **JS work and total frame delta are reported separately.** The wrapper times
 * each callback, which for the game's loop is `update + lateUpdate +
 * pipeline.render()` — i.e. everything the CPU does, including submitting GL
 * commands, but NOT the GPU executing them. `composer.render()` returns when
 * the commands are queued. So:
 *   js ≈ budget            -> the CPU is the bottleneck
 *   js << budget, delta >  -> the time is going to the GPU or the compositor
 * That split is the whole point of measuring both, and it is the only honest
 * one available without `EXT_disjoint_timer_query_webgl2`, whose availability
 * is reported but which Chrome withholds on most configurations.
 *
 * **Presented frames are counted, not rAF ticks.** The watchdog in `main.ts` is
 * allowed to skip a present to let a backlogged GPU drain. A harness that
 * counted rAF ticks would score a loop that presents every other frame as a
 * flawless 60 fps while the player watches 30. `renderer.info.render.frame`
 * moves only when something actually rendered, so it is sampled across each
 * callback and a frame with no movement is recorded as not presented.
 *
 * **`?debug=frames` is deliberately NOT set.** It would let `Diagnostics` prove
 * the picture is not black, but it sets `preserveDrawingBuffer`, which changes
 * the cost of every present. A frame-rate harness must not pay for its own
 * black-frame check. Use `tear-hunt.mjs` for that question; this one reports
 * the present count, the pipeline rung and the adaptive render scale, which is
 * enough to notice that the frames are cheap for the wrong reason.
 *
 * **Adaptive render scale is reported loudly.** `main.ts` drops internal
 * resolution when frames run long. That is a QUALITY LOSS bought with frame
 * time, and a 60 fps result at scale 0.6 is not the same result as 60 fps at
 * scale 1. The summary says which one it got.
 *
 * **The gate is on the MEAN frame time, not the median — this is not an
 * oversight.** A vsync-paced loop cannot produce a frame delta of 20 ms: it
 * produces 16.7 or 33.4. So on a build running at 48 fps, where 43% of frames
 * are on time and 57% take two vsyncs, the MEDIAN is exactly 16.70 ms and reads
 * as a flawless pass. Observed on the first run of this harness, on a build
 * that was visibly missing every other frame. The mean is 1000/fps by
 * construction and cannot be fooled that way, so it is what the gate uses; the
 * median and the percentiles are reported because they say something the mean
 * does not — whether the cost is uniform or spiky. Do not "tidy" the gate onto
 * the median.
 *
 * Exits non-zero when the profile misses its target, so it can gate a workflow.
 *
 * ===========================================================================
 *  WHAT AN ADVERSARIAL PASS OVER THIS FILE FOUND — read before trusting a
 *  number out of it. Every item below was measured, not reasoned about.
 * ===========================================================================
 *
 * VERIFIED SOUND (these do what the comments above claim):
 *   - `--use-gl=angle` really does get the GPU: `ANGLE (Apple, ANGLE Metal
 *     Renderer: Apple M5)`. On this Mac headless-shell gets it with or without
 *     the flag, but the flag costs nothing and other machines differ.
 *   - The software refusal fires. `--force-software` reports the SwiftShader
 *     string and exits 2. (`--use-gl=swiftshader` is appended AFTER
 *     `--use-gl=angle` and wins, as Chrome's last-switch-wins parsing implies.)
 *   - `--cpu` is wired to something real. 1x -> 6x moved the measured spin
 *     factor to 5.2x and the game's own JS from 2.37 ms to 11.22 ms per frame.
 *     It is not the "knob wired to nothing" this repo has shipped before.
 *   - `--profile mobile` really does change the DRAWING BUFFER, not just CSS:
 *     desktop 1920x1080 = 2.07 Mpx, mobile 273x590 = 0.16 Mpx. Note the size of
 *     that gap — the mobile pass is at ONE THIRTEENTH the pixels, because the
 *     tier auto-detects to Low (maxPixelRatio 1) and the adaptive path lands at
 *     ratio 0.7. That is what a phone gets, but "60 fps on mobile" and "60 fps
 *     on desktop" are not the same sentence and must never be quoted as if
 *     they were.
 *   - `presented` really does distinguish a rendered frame from a skipped one.
 *     Suppressing `renderer.render()` on alternate FRAMES gave 148 presented
 *     out of 296 rAF ticks — exact. (It takes ~36 `renderer.render()` calls to
 *     make one of this game's frames, so a test that skips alternate CALLS
 *     proves nothing; that was the first, wrong, version of this check.)
 *   - rAF pacing here IS back-pressured by GPU work, so the harness is not
 *     blind to the GPU-bound case its verdict claims to diagnose: halving the
 *     rendering took the same build from 54.8 fps to 60.0.
 *
 * THE NOISE FLOOR — THE MOST IMPORTANT NUMBER IN THIS FILE.
 *   RE-MEASURED 2026-07-31 on a genuinely quiet box. The previous figures here
 *   (42.0-49.8 fps, "spread 7.8 fps") were taken while twelve other agents were
 *   hammering the same ten cores, and they were wrong in BOTH directions: far
 *   too pessimistic about the absolute frame rate, and far too optimistic about
 *   the spread.
 *
 *   Ten pinned runs and six unpinned, desktop, 20 s, nothing else running:
 *
 *       unpinned   39.4-59.9 fps   16.71-25.36 ms   spread 8.65 ms   n=6
 *       PINNED     53.4-59.4 fps   16.67-18.71 ms   spread 2.04 ms   n=10
 *
 *   PINNING THE LADDER IS WHAT SHRINKS THE SPREAD, and the reason is worth
 *   stating plainly because it is the opposite of what the ladder is for: the
 *   two SLOWEST unpinned runs are the two that walked all the way to rung 0.5.
 *   A quarter of the pixels, and 8.65 ms SLOWER than the run that held 0.85.
 *   The ladder is not merely noisy here, it is anti-correlated with frame time,
 *   so an unpinned A/B is measuring the controller and not the change.
 *
 *   Always pass `--scaler off` for a comparison. Treat a difference as real
 *   only above ~2 ms pinned, or ~9 ms unpinned. `noiseFloorMs` in the JSON
 *   carries whichever applies so a workflow cannot forget which one it earned.
 *
 *   Two further protocol notes, both measured:
 *   - BACK-TO-BACK RUNS DEGRADE. Four consecutive runs went 59.9, 58.4, 53.4,
 *     39.4 fps, and a 120 s idle restored the next one to 57.6. The game's own
 *     JS doubled (2.0 -> 4.2 ms) across such a sequence with no code change, so
 *     this is the machine, not the build. Idle ~180 s between measured runs.
 *   - The absolute numbers here belong to an Apple M5 via ANGLE/Metal. The
 *     `mobile` profile throttles the CPU and NOT the GPU, so its fill-rate
 *     results are an M5's, not a phone's. See the mobile note further down.
 *
 *   Most of that spread is not random — it is DRIFT. Frame cost climbs
 *   monotonically through a race while JS stays flat:
 *
 *       t+0-8 s   ~53 fps      JS 2.5-3.2 ms
 *       t+16 s    ~47 fps      JS 2.4 ms
 *       t+24 s    ~40 fps      JS 2.8 ms
 *       t+42 s    ~43 fps      JS 2.4 ms
 *
 *   So the answer depends on WHERE the window lands, and boot time varies by
 *   seconds between runs. `drift` is therefore reported on every run (mean of
 *   the first third of the window vs the last third): if it is large, the
 *   single headline number is a point sample off a moving curve and the
 *   comparison you are about to make is not valid. Extending `--seconds` makes
 *   the number more stable and LOWER, not higher.
 *
 * THE COUNTDOWN IS NOT THE GAME. `race.start()` enters `RaceState.Countdown`,
 * which lasts `COUNTDOWN = 4.4 s` in Race.ts, and during it the kart sits on
 * the grid at zero speed while an intro camera sweeps the scene — a materially
 * CHEAPER frame (~53 fps) than racing (~42). The old code slept a fixed
 * `--settle 6 s` and started measuring, leaving well under a second of margin
 * against a boot time that varies by seconds. The window now opens only after
 * `RaceState.Racing` AND a kart genuinely under way, and the settle is counted
 * from there.
 *
 * A BUILD THAT DRAWS NOTHING RUNS VERY FAST. This harness deliberately declines
 * `?debug=frames`, so it cannot check the picture is not black — and "60 fps"
 * is exactly what deleting the world buys you, which is the failure mode a
 * performance round invites. It cannot prove paint without paying for
 * `preserveDrawingBuffer`, but it can prove WORK: draw calls and triangles are
 * sampled every frame and a collapse fails the run. That is a tripwire, not a
 * quality metric — use `tear-hunt.mjs` for the picture.
 *
 * `deviceScaleFactor` IS THE WHOLE BALLGAME AND THE DESKTOP PROFILE PINS IT
 * TO 1. 1920x1080 at dsf 1 is 2.07 Mpx. The retina Mac this game is developed
 * on reports `devicePixelRatio` 2, and `High`/`Ultra` ship `maxPixelRatio: 2`,
 * so a real desktop player is rendering 3840x2160 — FOUR TIMES the fill this
 * profile measures. The default stays at 1 because ART_DIRECTION §8's budget is
 * written against 1080p, but the report now prints both, and `--dsf 2` measures
 * what the developer's own machine actually draws. A desktop PASS at dsf 1 is
 * not a claim about a retina display.
 *
 *   `--profile desktop`            2.07 Mpx    55.1 fps
 *   `--profile desktop --dsf 2`    8.29 Mpx    15.3 fps
 *
 * ONE THING THIS HARNESS FOUND THAT IS NOT ITS OWN BUG, recorded here because
 * it is the reason that second line is so bad. In the `--dsf 2` run the game
 * spent 61.7 ms on a frame while `main.ts`'s own `renderCostEma` read 4.19 ms
 * and the adaptive scaler never moved off rung 0. That EMA is measured around
 * `pipeline.render()`, which returns when the GL commands are QUEUED — so the
 * scaler that exists to trade resolution for frame time is structurally blind
 * to a GPU-bound frame, which is the only kind of frame it was built for. The
 * fix belongs in `main.ts`, not here; this file's job was to notice.
 */
import puppeteer from 'puppeteer';
import { writeFileSync } from 'node:fs';
import { startVite } from './vite-server.mjs';

// ---------------------------------------------------------------------------
//  Arguments
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const num = (name, dflt) => {
  const v = parseFloat(opt(name, ''));
  return Number.isFinite(v) ? v : dflt;
};

/**
 * The two profiles.
 *
 * `mobile` is 390x844 at deviceScaleFactor 3 — an iPhone 14's CSS layout and
 * its real pixel density — with a touch-capable UA so `Settings.profileDevice`
 * classifies it as a handheld and the touch control path mounts. It does NOT
 * force a quality tier: the point is to measure what a phone actually gets.
 *
 * The pass thresholds are looser on mobile only in how much stutter is
 * tolerated, not in the frame budget. 60 fps is 60 fps on both.
 */
const PROFILES = {
  desktop: {
    width: 1920, height: 1080, dsf: 1, mobile: false, cpu: 1,
    ua: null,
    budgetMs: 16.7, maxOverPct: 5, maxRun: 4,
  },
  mobile: {
    width: 390, height: 844, dsf: 3, mobile: true, cpu: 4,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
        '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    budgetMs: 16.7, maxOverPct: 15, maxRun: 8,
  },
};

const PROFILE = opt('--profile', 'desktop');
if (!PROFILES[PROFILE]) {
  console.error(`unknown --profile ${PROFILE}; expected one of: ${Object.keys(PROFILES).join(', ')}`);
  process.exit(2);
}
const P = { ...PROFILES[PROFILE] };

// Overrides. `--cpu` exists so the throttle can be swept (1, 2, 4, 6...) rather
// than only tested at the profile's default. Verified to bite: 1x -> 6x moved
// the game's JS from 2.37ms to 11.22ms per frame.
P.cpu = num('--cpu', P.cpu);
P.budgetMs = num('--budget', P.budgetMs);
P.maxOverPct = num('--max-over', P.maxOverPct);
P.maxRun = num('--max-run', P.maxRun);
/**
 * Device pixel ratio. This is the single largest lever on the result and the
 * desktop profile's default of 1 is a claim about a 1080p monitor, NOT about
 * the retina Mac this game is written on — see the header. `--dsf 2` measures
 * the 3840x2160 buffer a developer machine actually renders.
 */
P.dsf = num('--dsf', P.dsf);

const SECONDS = num('--seconds', 20);
/**
 * Settle before measuring, counted from the moment the race is ACTUALLY under
 * way — not from `race.start()`. Long enough for the first-lap material uploads
 * to be done and for the adaptive scaler's EMA to have left its seeded 16.7,
 * which takes ~30 frames of real cost plus the WATCHDOG_FROM_FRAME hold in
 * main.ts.
 *
 * It used to be 6 s measured from `start()`, which is only ~1.6 s clear of the
 * 4.4 s countdown — and the countdown is a stationary kart under an intro
 * camera, which measures ~53 fps against ~42 for real racing. Any run where
 * boot ran a second slow measured the menu instead. See `waitForRacing` below.
 */
const SETTLE = num('--settle', 6);
const PORT = Math.round(num('--port', 5361));
const QUALITY = opt('--quality', '');
/**
 * Pin the adaptive resolution ladder. `--scaler off` holds full resolution for
 * the whole run; `--scaler 0.72` holds that rung. See `?scaler=` in main.ts.
 *
 * THIS IS THE FLAG THAT MAKES A DESKTOP NUMBER MEAN ANYTHING. The default
 * (unpinned) answers "what frame rate does a player get", and the ladder is
 * free to buy it with resolution. `--scaler off` answers "what does the frame
 * actually cost at full quality", which is the only question an optimisation
 * can be measured against — an unpinned A/B hides a real saving by spending it
 * on pixels and reporting the same fps.
 */
const SCALER = opt('--scaler', '');
/** The tier's own `renderScale`. Sweeps resolution below the ladder's 0.5 floor. */
const RSCALE = opt('--scale', '');
/**
 * Overrides the per-tier drawing-buffer megapixel ceiling in Settings.ts.
 * Named `MPX_BUDGET`, not `MPX` — that one is already the measured megapixel
 * count of the drawing buffer, further down.
 */
const MPX_BUDGET = opt('--mpx', '');
const JSON_OUT = opt('--json', '');
/**
 * Self-test for the guard that matters most: forces the software rasteriser so
 * the refusal path can be exercised on demand. The whole value of this harness
 * rests on that check firing, and a check nobody has ever seen fire is a check
 * nobody should trust. `node tools/fps-bench.mjs --force-software` must abort
 * with exit code 2.
 */
const FORCE_SOFTWARE = argv.includes('--force-software');
/**
 * Escape hatch for the masked-renderer refusal below. Without
 * `WEBGL_debug_renderer_info` the only string available is the masked one —
 * Chrome reports `WebKit WebGL` — which sails through the software regex no
 * matter what is underneath. That turns the most important check in the file
 * into a no-op that still prints a reassuring `renderer:` line, which is the
 * precise shape of every fictional number this repo has believed. So it aborts
 * unless you say, in writing, that you accept an unattributable number.
 */
const ALLOW_MASKED = argv.includes('--allow-masked-gpu');

// ---------------------------------------------------------------------------
//  Statistics
// ---------------------------------------------------------------------------
const pct = (sorted, p) => {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
};
/** Longest run of consecutive frames over `budget`. A median cannot see this. */
const longestRun = (series, budget) => {
  let best = 0, run = 0, at = 0, bestAt = 0;
  for (let i = 0; i < series.length; i++) {
    if (series[i] > budget) { if (run === 0) at = i; run++; if (run > best) { best = run; bestAt = at; } }
    else run = 0;
  }
  return { frames: best, startIndex: bestAt };
};
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '  n/a');
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '  n/a');

// ---------------------------------------------------------------------------
//  Boot
// ---------------------------------------------------------------------------
const srv = await startVite(PORT);

const browser = await puppeteer.launch({
  headless: 'shell',
  args: [
    '--no-sandbox',
    // Required: without it headless Chrome takes the software path and every
    // number below is fiction. Note the DELIBERATE absence of
    // `--enable-unsafe-swiftshader` — see the header.
    '--use-gl=angle',
    '--enable-gpu',
    `--window-size=${P.width},${P.height}`,
    // Only ever added by --force-software, to prove the refusal below works.
    ...(FORCE_SOFTWARE ? ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] : []),
  ],
  // Launch and protocol timeouts are generous because several agents run
  // harnesses on this machine at once; a loaded box takes a while to spawn.
  timeout: 120000,
  protocolTimeout: 240000,
});

const page = await browser.newPage();
await page.setViewport({
  width: P.width, height: P.height, deviceScaleFactor: P.dsf,
  isMobile: P.mobile, hasTouch: P.mobile,
});
if (P.ua) await page.setUserAgent(P.ua);

// Vite's HMR client is answered with a stub. Agents work this tree in parallel
// and somebody else's save triggers a full reload, which drops the race back to
// the menu in the middle of the measured window. Same guard as drift-bench.mjs
// and autoplay.mjs, where it cost a debugging session to find.
const HMR_STUB =
  'const noop = () => {};\n' +
  'export const createHotContext = () => ({ accept: noop, acceptExports: noop, dispose: noop, ' +
  'prune: noop, decline: noop, invalidate: noop, on: noop, off: noop, send: noop, data: {} });\n' +
  'export const updateStyle = noop;\nexport const removeStyle = noop;\n' +
  'export const injectQuery = (url) => url;\nexport const ErrorOverlay = class {};\n';
await page.setRequestInterception(true);
page.on('request', (r) => {
  if (r.url().includes('/@vite/client')) {
    r.respond({ status: 200, contentType: 'application/javascript', body: HMR_STUB }).catch(() => {});
  } else r.continue().catch(() => {});
});

let navigations = 0;
const pageErrors = [];
/**
 * A failed subresource fetch is not a rendering fault and must not fail a
 * frame-rate gate. The analytics beacon this project loads from `/_vercel/` has
 * no dev-server route and 404s on every single run; gating on it would mean the
 * harness reported FAIL for a reason that has nothing to do with frame time.
 */
const NOISE = /Failed to load resource|_vercel|favicon/i;
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });
page.on('pageerror', (e) => pageErrors.push('pageerror: ' + String(e.message || e)));
page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) pageErrors.push(m.text()); });

/**
 * Query parameters, assembled rather than concatenated so more than one can be
 * set at a time. `--scaler off` is the important one: it pins the adaptive
 * ladder (see `?scaler=` in main.ts), which is the only way to get a number
 * that describes THE FRAME rather than describing the ladder's reaction to it.
 * Without it, two runs of one build reported 59.9 and 39.4 fps purely because
 * one settled on rung 0.85 and the other on 0.5.
 *
 * `--scale` is the tier's own `renderScale` and is how the resolution sweep is
 * driven, since the ladder's own floor is 0.5.
 */
const qs = new URLSearchParams();
if (QUALITY) qs.set('quality', QUALITY);
if (SCALER) qs.set('scaler', SCALER);
if (RSCALE) qs.set('scale', RSCALE);
if (MPX_BUDGET) qs.set('mpx', MPX_BUDGET);
const url = `http://127.0.0.1:${PORT}/${qs.toString() ? `?${qs}` : ''}`;
const bootT0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__gameReady === true', { timeout: 180000 });
const navAtBoot = navigations;
console.log(`booted in ${((Date.now() - bootT0) / 1000).toFixed(1)}s  ` +
  `(profile=${PROFILE}, ${P.width}x${P.height}@${P.dsf}x, port=${PORT}` +
  `${QUALITY ? `, quality=${QUALITY}` : ', quality=auto'})`);

// ---------------------------------------------------------------------------
//  1. Refuse to run on a software rasteriser
// ---------------------------------------------------------------------------
/**
 * Read off the context the GAME made, not a throwaway canvas. They can differ:
 * a fresh canvas may get a different backend than the one the pipeline
 * negotiated, and it is the pipeline's device whose speed we are about to
 * report.
 */
const gpu = await page.evaluate(() => {
  const gl = window.__ctx?.renderer?.getContext?.() ?? null;
  if (!gl) return { ok: false, why: 'the game has no WebGL context' };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    ok: true,
    renderer: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
    vendor: String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
    version: String(gl.getParameter(gl.VERSION)),
    maskedByPolicy: !dbg,
    // Reported, not used: Chrome withholds this on most configurations, and
    // when it is present a future revision of this harness can time the GPU
    // side directly instead of inferring it.
    timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
  };
});

console.log(`renderer         : ${gpu.ok ? gpu.renderer : '(none)'}`);
if (gpu.ok) console.log(`vendor           : ${gpu.vendor}   ${gpu.version}`);

const SOFTWARE = /swiftshader|llvmpipe|software|softwarerasterizer|basic render/i;
if (!gpu.ok || SOFTWARE.test(gpu.renderer)) {
  console.error(
    `\nABORT: this is not a real GPU.\n` +
    `  renderer: ${gpu.ok ? gpu.renderer : gpu.why}\n` +
    `Frame times measured on a software rasteriser are fiction, and a fictional\n` +
    `number in a perf round is worse than no number. Fix the GPU path (this\n` +
    `harness passes --use-gl=angle and deliberately does NOT pass\n` +
    `--enable-unsafe-swiftshader) and run again.`,
  );
  await browser.close(); srv.stop(); process.exit(2);
}
if (gpu.maskedByPolicy && !ALLOW_MASKED) {
  // Not a warning. A masked string is `WebKit WebGL` whatever the backend is,
  // so the refusal above cannot fire and the harness would go on to print
  // milliseconds it cannot attribute to any device — see the header. Warning
  // and continuing is how a check becomes decorative.
  console.error(
    `\nABORT: WEBGL_debug_renderer_info is unavailable, so the renderer string is the masked\n` +
    `one (${gpu.renderer}) and the software-rasteriser check above could not have fired.\n` +
    `This harness cannot attribute a frame time to a device it is not allowed to name.\n` +
    `Re-run with --allow-masked-gpu if you accept an unattributable number.`,
  );
  await browser.close(); srv.stop(); process.exit(2);
}
if (gpu.maskedByPolicy) {
  console.warn('[fps-bench] WEBGL_debug_renderer_info is unavailable and --allow-masked-gpu was ' +
    'passed: the software check DID NOT RUN. This number is not attributable to a device.');
}

// ---------------------------------------------------------------------------
//  2. CPU throttle, then a real race
// ---------------------------------------------------------------------------
const cdp = await page.createCDPSession();

/**
 * A fixed amount of arithmetic, timed. Not a fixed duration — the point is to
 * see the SAME work take longer once the throttle is on.
 *
 * This exists because "a frame-rate knob wired to nothing at all" has already
 * happened in this repo once, and it manufactured a 17x effect that did not
 * exist. `Emulation.setCPUThrottlingRate` is a request to the browser, not a
 * guarantee, and a mobile profile that silently ran unthrottled would report a
 * phone-class result from desktop-class hardware. So the throttle is measured,
 * not assumed, and the measured factor is printed next to the requested one.
 */
const spinMs = () => page.evaluate(() => {
  const t0 = performance.now();
  let x = 0;
  for (let i = 1; i < 2e7; i++) x += Math.sqrt(i);
  return { ms: performance.now() - t0, sink: x };
});

const spinBefore = (await spinMs()).ms;
if (P.cpu > 1) {
  // Applied AFTER boot on purpose. Booting this game under a 4x throttle takes
  // minutes — shader pre-warm and the PMREM bake are both one-off costs the
  // player pays on a loading screen — and none of it is what we are measuring.
  // It goes on before the settle, so the adaptive scaler and every cache warm
  // up under the same throttle the measured window runs at.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: P.cpu });
}
const spinAfter = (await spinMs()).ms;
const cpuMeasured = spinAfter / Math.max(0.001, spinBefore);
console.log(`cpu throttle     : ${P.cpu}x requested, ${cpuMeasured.toFixed(2)}x measured ` +
  `(${spinBefore.toFixed(1)}ms -> ${spinAfter.toFixed(1)}ms on a fixed workload)`);
/**
 * A throttle that did not take is not a warning, it is a wrong answer, and it
 * is collected into `fails` at the bottom rather than printed and forgotten.
 * The mobile profile's entire claim is "this is what a phone gets"; if the
 * throttle silently no-ops, the run reports desktop silicon under a phone's
 * name and every conclusion drawn from it is backwards. Measured on this box:
 * 4x requested -> 3.35x, 6x requested -> 5.2x. The 0.6 floor has real room.
 */
const throttleFailed = P.cpu > 1 && cpuMeasured < P.cpu * 0.6;
if (throttleFailed) {
  console.error(`[fps-bench] the CPU throttle did not take. The numbers below are ` +
    `closer to ${cpuMeasured.toFixed(1)}x than to ${P.cpu}x and must not be reported as a phone.`);
}

// Drive. Same approach as autoplay.mjs / drift-bench.mjs: hand the player kart
// to the AI and start the race for real. Measuring the title screen would
// measure a menu, not the game.
await page.evaluate(() => {
  const ctx = window.__ctx;
  ctx.race.autoDrive = true;
  ctx.race.start();
});

/**
 * ...but `start()` does not start racing. It enters `RaceState.Countdown`,
 * which Race.ts holds for `COUNTDOWN = 4.4` seconds with every kart stationary
 * on the grid under an intro camera. Measured, that is a ~53 fps stretch on a
 * build that races at ~42 — so any window that overlaps it is quoting a number
 * from the wrong scene, and the old fixed 6 s sleep left barely a second of
 * margin against a boot time that ranged 2.6-4.9 s across runs here.
 *
 * So: wait for the state machine to reach `Racing` AND for a kart to actually
 * be moving (the state can flip a frame before anything has velocity), and only
 * then start counting the settle. Polled rather than hooked so this harness
 * still works if the race ever gains another pre-roll state.
 */
const RACING = 2; // RaceState.Racing — const enum, not readable from the page.
const raceT0 = Date.now();
try {
  await page.waitForFunction((RACING) => {
    const ctx = window.__ctx;
    const r = ctx?.race;
    if (!r || r.state !== RACING) return false;
    const k = r.player ?? r.karts?.[0];
    return !!k && Math.hypot(k.velocity.x, k.velocity.z) > 4;
  }, { timeout: 60000, polling: 100 }, RACING);
} catch {
  const st = await page.evaluate(() => {
    const r = window.__ctx?.race;
    const k = r?.player ?? r?.karts?.[0];
    return { state: r?.state, autoDrive: r?.autoDrive, karts: r?.karts?.length ?? 0,
      speed: k ? +Math.hypot(k.velocity.x, k.velocity.z).toFixed(2) : null };
  });
  console.error(`\nABORT: the race never got under way — nothing to measure but a menu.\n` +
    `  race state: ${JSON.stringify(st)}\n` +
    `A frame rate measured on the title screen or a stalled grid is not a frame rate.`);
  await browser.close(); srv.stop(); process.exit(2);
}
console.log(`race under way   : ${((Date.now() - raceT0) / 1000).toFixed(1)}s after start() ` +
  `(the ${(4.4).toFixed(1)}s countdown is excluded from the window on purpose)`);

/**
 * The environment, sampled the same way at both ends of the run.
 *
 * Sampling it ONCE, before the window, was a real defect: `main.ts` can drop a
 * resolution rung at any point during the measured window, and the summary line
 * would then advertise a megapixel count the run did not hold. It is read again
 * after the window and the two are compared.
 */
const readEnv = () => page.evaluate(() => {
  const ctx = window.__ctx;
  return {
    quality: ctx?.settings?.quality,
    pixelRatio: ctx?.renderer?.getPixelRatio?.() ?? 0,
    canvas: [ctx?.renderer?.domElement?.width ?? 0, ctx?.renderer?.domElement?.height ?? 0],
    css: [ctx?.renderer?.domElement?.clientWidth ?? 0, ctx?.renderer?.domElement?.clientHeight ?? 0],
    dpr: window.devicePixelRatio,
    touchMounted: !!document.querySelector('.tc-root'),
    maxTouchPoints: navigator.maxTouchPoints,
    // `__gl()` is Diagnostics' report. Guarded because it queries the live
    // context and a harness must not die of its own instrumentation.
    gl: (() => {
      try {
        const r = window.__gl?.();
        return r ? { rung: r.rung, composer: r.composer, programs: r.programs } : null;
      } catch { return null; }
    })(),
  };
});
const env = await readEnv();
const QNAME = ['Low', 'Medium', 'High', 'Ultra'][env.quality] ?? `?${env.quality}`;
// Megapixels, spelled out. A profile can only be compared against another
// profile that is drawing a comparable number of them, and "60 fps" bought by
// rendering a quarter of the pixels is a trade, not a win. Measured: the mobile
// profile draws 0.16 Mpx against desktop's 2.07 — a 13x gap, so the two PASS
// lines are not comparable sentences and must never be quoted as if they were.
const MPX = (env.canvas[0] * env.canvas[1]) / 1e6;
console.log(`quality tier     : ${QNAME}   pixelRatio ${env.pixelRatio}   ` +
  `drawing buffer ${env.canvas[0]}x${env.canvas[1]} = ${MPX.toFixed(2)} Mpx`);
// dsf is the largest single lever on this result, so it is stated outright
// rather than left to be inferred from the buffer size. See the header: the
// desktop default of 1 is a 1080p claim, not a retina one.
console.log(`viewport         : ${env.css[0]}x${env.css[1]} CSS px at devicePixelRatio ` +
  `${env.dpr}${P.dsf === 1 && !P.mobile
    ? '   <- NOT a retina desktop; a dpr-2 Mac renders 4x these pixels (--dsf 2)'
    : ''}`);
console.log(`pipeline rung    : ${env.gl?.rung ?? '?'}   composer=${env.gl?.composer}   ` +
  `programs=${env.gl?.programs ?? '?'}`);
if (P.mobile) {
  console.log(`touch controls   : ${env.touchMounted ? 'mounted' : 'NOT MOUNTED'} ` +
    `(navigator.maxTouchPoints=${env.maxTouchPoints})`);
}

// ---------------------------------------------------------------------------
//  3. Instrument the rAF batch
// ---------------------------------------------------------------------------
await page.evaluate(() => {
  const w = window;
  if (w.__fpsBench) return;

  const native = w.requestAnimationFrame.bind(w);
  const B = (w.__fpsBench = { on: false, frames: [], cur: null, ts: null });

  /**
   * One record per BROWSER frame, not per callback. Every callback scheduled
   * for the same frame is handed the same timestamp by the spec, so a change in
   * that timestamp is exactly a frame boundary — no probe callback of our own
   * is needed, and therefore none is added to the queue to perturb what it is
   * measuring.
   *
   * `presented` comes from `renderer.info.render.frame`, which three increments
   * inside `WebGLRenderer.render()`. It moves only if something actually
   * rendered, so a frame the watchdog chose to skip is recorded as a rAF tick
   * with no present — which is the difference between 60 fps and a loop that
   * merely ticks 60 times.
   *
   * VERIFIED, because this is the sort of claim that turns out to be decorative:
   * suppressing `renderer.render()` on alternate FRAMES gave 148 presented out
   * of 296 ticks — exact. Note it has to be alternate frames, not alternate
   * CALLS: one of this game's frames takes ~36 `renderer.render()` calls
   * (composer passes, reflections, shadow work), so skipping every other call
   * still leaves ~18 and `info.frame` moves regardless. That was the first,
   * useless, version of the check.
   *
   * `calls`/`tris` are the tripwire for the cheapest way to win a performance
   * round: stop drawing the world. This harness cannot see the picture (it
   * declines `preserveDrawingBuffer` on purpose — see the header), but a scene
   * that has been deleted still shows up here as the draw count falling off a
   * cliff. Read AFTER the callback, because `Renderer.ts` holds
   * `info.autoReset = false` across `composer.render()` and restores it
   * afterwards, so at this point the counters hold the whole frame's totals.
   */
  w.requestAnimationFrame = (cb) => native((now) => {
    if (!B.on) return cb(now);
    if (B.ts !== now) {
      if (B.cur) B.frames.push(B.cur);
      B.ts = now;
      B.cur = { t: now, js: 0, n: 0, presented: 0, calls: 0, tris: 0 };
    }
    const rec = B.cur;
    const info = w.__ctx?.renderer?.info?.render;
    const before = info ? info.frame : 0;
    const a = performance.now();
    try {
      cb(now);
    } finally {
      rec.js += performance.now() - a;
      rec.n++;
      if (info && info.frame !== before) {
        rec.presented++;
        rec.calls = Math.max(rec.calls, info.calls);
        rec.tris = Math.max(rec.tris, info.triangles);
      }
    }
  });

  w.__fpsStart = () => {
    B.frames.length = 0; B.cur = null; B.ts = null; B.on = true;
    return true;
  };
  w.__fpsStop = () => {
    B.on = false;
    if (B.cur) { B.frames.push(B.cur); B.cur = null; }
    // Round on the way out: 1200 objects of full-precision floats is a lot of
    // CDP payload for numbers whose last four digits are noise.
    return B.frames.map((f) => ({
      t: +f.t.toFixed(3), js: +f.js.toFixed(3), n: f.n, presented: f.presented,
      calls: f.calls, tris: f.tris,
    }));
  };
});

const before = await page.evaluate(() => window.__loopHealth?.() ?? null);

// Settle: let the first-lap uploads and the scaler EMA get where they are going
// before the window opens.
await new Promise((r) => setTimeout(r, SETTLE * 1000));

console.log(`\nmeasuring ${SECONDS}s after a ${SETTLE}s settle...`);
await page.evaluate(() => window.__fpsStart());
await new Promise((r) => setTimeout(r, SECONDS * 1000));
const raw = await page.evaluate(() => window.__fpsStop());
const after = await page.evaluate(() => window.__loopHealth?.() ?? null);
// Sampled again, because the adaptive scaler can move the drawing buffer at any
// point in the window and the summary must not advertise a resolution the run
// did not hold. See `readEnv`.
const envEnd = await readEnv();
const MPX_END = (envEnd.canvas[0] * envEnd.canvas[1]) / 1e6;
const bufferChanged = envEnd.canvas[0] !== env.canvas[0] || envEnd.canvas[1] !== env.canvas[1];

if (navigations > navAtBoot) {
  console.error(`\nABORT: the page navigated ${navigations - navAtBoot} time(s) during the run — ` +
    `something reloaded the tab and the samples span two different states.`);
  await browser.close(); srv.stop(); process.exit(2);
}
if (raw.length < 30) {
  console.error(`\nABORT: only ${raw.length} frames in ${SECONDS}s. The loop is not running.`);
  for (const e of pageErrors.slice(0, 8)) console.error('   - ' + e.slice(0, 200));
  await browser.close(); srv.stop(); process.exit(2);
}

// ---------------------------------------------------------------------------
//  4. Reduce
// ---------------------------------------------------------------------------
// The first record is a partial frame — the window opened part-way through it —
// so it is dropped rather than counted as an impossibly fast one.
const rec = raw.slice(1);
const deltas = [];
for (let i = 1; i < rec.length; i++) deltas.push(rec[i].t - rec[i - 1].t);
const jsMs = rec.slice(1).map((f) => f.js);

const dSorted = [...deltas].sort((a, b) => a - b);
const jSorted = [...jsMs].sort((a, b) => a - b);

const span = (rec[rec.length - 1].t - rec[0].t) / 1000;
/**
 * Counted over `rec.slice(1)`, NOT over `rec`.
 *
 * `span` covers `rec.length - 1` intervals, so dividing a count of `rec.length`
 * frames by it produced a presented frame rate very slightly HIGHER than the
 * ticked one — 59.37 against 59.25 on a run where every single frame rendered,
 * which is arithmetically impossible and was visible in the report. Small, but
 * a harness whose numbers disagree with each other has no business gating
 * anything, and the same denominator now serves both.
 */
const shown = rec.slice(1);
const presentedFrames = shown.reduce((a, f) => a + (f.presented > 0 ? 1 : 0), 0);
const skipped = shown.length - presentedFrames;

/**
 * Draw work, as a tripwire against the cheapest possible "optimisation".
 *
 * Deleting scenery, disabling the post chain or losing the track entirely all
 * make this harness very happy — a build that renders an empty sky holds 60 fps
 * effortlessly and passes every gate above. This is NOT a quality check; it
 * cannot see the picture at all, and `tear-hunt.mjs` is what answers that. It
 * is a tripwire for the scene having stopped existing.
 *
 * The floors are set from measurement, not taste. With `scene.visible = false`
 * — the world gone, the post chain still running — a frame costs 35 draw calls
 * and 35 triangles. Real frames:
 *
 *     desktop / Ultra   195 calls   3,537,000 triangles
 *     mobile  / Low     114 calls   1,205,000 triangles
 *
 * So TRIANGLES is the check that actually bites: three orders of magnitude of
 * margin either side. The draw-call floor sits at 60 — comfortably under the
 * lowest tier observed and comfortably over the post chain's own 35, which is
 * the sneaky version of this failure, where the fullscreen quads keep the
 * counter looking alive while nothing in the world is drawn.
 */
const MIN_CALLS = 60;
const MIN_TRIS = 5000;
const callSeries = shown.filter((f) => f.presented > 0).map((f) => f.calls);
const triSeries = shown.filter((f) => f.presented > 0).map((f) => f.tris);
const p50calls = pct([...callSeries].sort((a, b) => a - b), 0.5);
const p50tris = pct([...triSeries].sort((a, b) => a - b), 0.5);

/**
 * Two different questions, and conflating them is a trap this harness fell into
 * on its second run.
 *
 * `over` is the literal "frames longer than the budget". It is reported because
 * it is the number people ask for, but it is NOT gated on, because a vsync
 * delta jitters either side of 16.667 ms and a budget written as 16.7 catches
 * roughly half of the jitter. Measured: a run at a true, flawless 60.0 fps
 * reported 45.8% of frames "over 16.7 ms". Gating on that would fail every
 * build forever.
 *
 * `dropped` is the honest one: a frame that took at least one and a half vsync
 * intervals took two, because at 60 Hz there is nothing in between. That is a
 * frame the player did not see, and it is what the gate uses.
 */
const DROP_MS = P.budgetMs * 1.5;
const over = deltas.filter((d) => d > P.budgetMs);
const overPct = (over.length / deltas.length) * 100;
const dropped = deltas.filter((d) => d > DROP_MS);
const dropPct = (dropped.length / deltas.length) * 100;
const run = longestRun(deltas, DROP_MS);

const p50d = pct(dSorted, 0.5), p95d = pct(dSorted, 0.95), p99d = pct(dSorted, 0.99);
const p50j = pct(jSorted, 0.5), p95j = pct(jSorted, 0.95), p99j = pct(jSorted, 0.99);
// Median JS cost of the frames that BLEW the budget, versus all frames. If the
// bad frames are also the JS-heavy frames, the spikes are CPU spikes.
const overJs = [];
for (let i = 1; i < rec.length; i++) if (rec[i].t - rec[i - 1].t > DROP_MS) overJs.push(rec[i].js);
const p50jOver = pct([...overJs].sort((a, b) => a - b), 0.5);

/**
 * The headline number. Mean frame time is 1000/fps by construction, so unlike
 * the median it cannot be flattered by vsync quantisation — see the header.
 */
const meanD = deltas.reduce((a, b) => a + b, 0) / deltas.length;
const meanJ = jsMs.reduce((a, b) => a + b, 0) / jsMs.length;
const fpsMean = (deltas.length / span);
const fpsPresented = presentedFrames / span;

/**
 * DRIFT — is this number even stationary?
 *
 * It is not. Measured over a 46 s race with JS flat at ~2.5 ms throughout, the
 * frame rate fell from ~53 fps in the first seconds to ~40-43 fps by t+24 s and
 * stayed there. So the headline is a point sample off a moving curve, and where
 * the window lands decides the answer: four identical default runs came back
 * 49.8 / 47.4 / 42.0 / 46.8 fps, a 7.8 fps spread, against a gate trying to
 * resolve the difference between 59 and 60.
 *
 * Comparing the mean of the first third of the window with the last third makes
 * that visible on every run instead of leaving it to be discovered again. When
 * the drift is large, a single run cannot support an A/B claim — lengthen
 * `--seconds` (which converges the number DOWNWARD) or repeat the run.
 */
const third = Math.floor(deltas.length / 3);
const meanOf = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const driftEarly = meanOf(deltas.slice(0, third));
const driftLate = meanOf(deltas.slice(-third));
const driftMs = driftLate - driftEarly;

// ---------------------------------------------------------------------------
//  5. Report
// ---------------------------------------------------------------------------
console.log(`\n--- fps-bench: ${PROFILE} ---`);
console.log(`window           : ${span.toFixed(1)}s, ${shown.length} rAF frames, ` +
  `${presentedFrames} presented${skipped ? `  (${skipped} SKIPPED by the watchdog)` : ''}`);
console.log(`frame rate       : ${fpsMean.toFixed(1)} fps ticked, ${fpsPresented.toFixed(1)} fps presented   ` +
  `(target ${(1000 / P.budgetMs).toFixed(0)})`);
console.log('');
console.log(`                       mean   median      p95      p99`);
console.log(`total frame delta : ${f2(meanD).padStart(7)}  ${f2(p50d).padStart(7)}  ${f2(p95d).padStart(7)}  ${f2(p99d).padStart(7)}  ms   <- the mean is the gate`);
console.log(`  of which JS     : ${f2(meanJ).padStart(7)}  ${f2(p50j).padStart(7)}  ${f2(p95j).padStart(7)}  ${f2(p99j).padStart(7)}  ms   (update + lateUpdate + render submit)`);
console.log(`  non-JS residue  : ${f2(meanD - meanJ).padStart(7)}  ${f2(p50d - p50j).padStart(7)}${' '.repeat(18)}  ms   (GPU execution, compositing, vsync wait)`);
console.log('');
console.log(`note             : a vsync-paced loop only ever produces ~16.7 or ~33.4ms deltas, so the`);
console.log(`                   median rounds to one of those. Read the mean for frame rate, the`);
console.log(`                   percentiles for whether the cost is uniform or spiky.`);
console.log('');
console.log(`frames > ${P.budgetMs}ms  : ${over.length}/${deltas.length}  = ${overPct.toFixed(1)}%   ` +
  `(reported, NOT gated — vsync jitter alone puts ~45% of a perfect 60fps run here)`);
console.log(`DROPPED frames   : ${dropped.length}/${deltas.length}  = ${dropPct.toFixed(1)}%   ` +
  `(> ${DROP_MS.toFixed(1)}ms = took two vsyncs; budget ${P.maxOverPct}%)   <- gated`);
console.log(`longest bad run  : ${run.frames} consecutive dropped frames   (budget ${P.maxRun})` +
  (run.frames ? `  starting ${((rec[run.startIndex + 1]?.t - rec[0].t) / 1000 || 0).toFixed(1)}s in` : ''));
console.log(`worst frame      : ${f1(dSorted[dSorted.length - 1])} ms`);
console.log(`median JS on DROPPED frames     : ${f2(p50jOver)} ms  (vs ${f2(p50j)} ms overall) — ` +
  `if these are equal the drops are not JS spikes`);
console.log(`GPU timer query  : ${gpu.timerQuery ? 'available' : 'not exposed by this browser'}`);

// ---- is this number even stationary? ---------------------------------------
console.log('');
console.log(`drift            : ${f2(driftEarly)} -> ${f2(driftLate)} ms  ` +
  `(first third vs last third of the window; ${driftMs >= 0 ? '+' : ''}${f2(driftMs)} ms)`);
console.log(`                   MEASURED NOISE FLOOR (quiet box, desktop, 20s, 2026-07-31):`);
console.log(`                     unpinned  39.4-59.9 fps  (16.71-25.36 ms)  spread 8.65 ms  n=6`);
console.log(`                     PINNED    53.4-59.4 fps  (16.67-18.71 ms)  spread 2.04 ms  n=10`);
console.log(`                   MOST OF THE UNPINNED SPREAD IS THE LADDER, NOT THE MACHINE: the two`);
console.log(`                   slowest runs are the ones that walked to rung 0.5, i.e. a QUARTER of`);
console.log(`                   the pixels ran SLOWER than full resolution. Always pass --scaler off`);
console.log(`                   for an A/B. Do not read a change under ~2 ms pinned, ~9 ms unpinned.`);

// Quality actually delivered, so a fast result cannot be mistaken for a free one.
console.log('');
console.log(`draw work        : ${f1(p50calls)} calls, ${(p50tris / 1000).toFixed(0)}k triangles per presented frame ` +
  `(median)   <- gated, floors ${MIN_CALLS}/${(MIN_TRIS / 1000).toFixed(0)}k`);
console.log(`                   a tripwire only: this catches "60 fps because we stopped drawing the`);
console.log(`                   world", not a quality regression. tear-hunt.mjs judges the picture.`);
/**
 * VERIFY THE PIN TOOK. `--scaler` is a flag whose entire value is that it
 * changed the run's behaviour, and this repo has already shipped a frame-rate
 * knob wired to nothing at all. `__loopHealth` reports `scalerPinned` and the
 * live `dynamicScale` straight out of the loop, so the claim is checked
 * against the page rather than assumed from the command line.
 */
if (SCALER) {
  const pinned = after?.scalerPinned === true;
  const held = after?.dynamicScale;
  const wantHeld = SCALER === 'off' ? 1 : parseFloat(SCALER);
  if (!pinned || !(Math.abs((held ?? -1) - wantHeld) < 0.01)) {
    console.error(
      `\n--scaler ${SCALER} DID NOT TAKE: the page reports scalerPinned=${after?.scalerPinned} ` +
      `dynamicScale=${held} (wanted ${wantHeld}). Refusing to report a number that claims to be ` +
      `pinned and is not.`);
    await browser.close(); await srv.stop();
    process.exit(2);
  }
  console.log(`scaler           : PINNED at dynamic scale ${held} — the ladder did not move all run`);
}
console.log(`render scale     : ${before?.renderScale ?? '?'} -> ${after?.renderScale ?? '?'}` +
  (after && after.renderScale < 1 && !SCALER
    ? `   *** the adaptive scaler traded RESOLUTION for frame time — this result is NOT at full quality ***`
    : '   (full internal resolution held)'));
// The buffer at the END of the window, not the one sampled before it. The
// scaler can move mid-run, and the summary used to advertise a resolution the
// run had not held since second three.
console.log(`drawing buffer   : ${envEnd.canvas[0]}x${envEnd.canvas[1]} = ${MPX_END.toFixed(2)} Mpx at the END of the window` +
  (bufferChanged
    ? `   *** CHANGED mid-run from ${env.canvas[0]}x${env.canvas[1]} = ${MPX.toFixed(2)} Mpx — the headline Mpx is not what was measured throughout ***`
    : '   (unchanged)'));
console.log(`watchdog stalls  : ${(after?.stalls ?? 0) - (before?.stalls ?? 0)} frames over 220ms during the run`);
console.log(`renderCostEma    : ${after?.renderCostEma ?? '?'} ms  (the loop's own view)`);
if (pageErrors.length) {
  console.log(`page errors      : ${pageErrors.length}`);
  for (const e of pageErrors.slice(0, 5)) console.log('   - ' + e.slice(0, 180));
}

// ---- which side is the budget going to? ------------------------------------
/**
 * The verdict the header promises. `js` is honest CPU time; the residue is
 * everything the CPU waited on. Under a vsync-paced loop a healthy frame's
 * residue is mostly the wait for the next vsync, which is why the residue alone
 * proves nothing — it is only meaningful once the delta is over budget.
 */
let bottleneck;
if (meanD <= P.budgetMs * 1.02) {
  bottleneck = meanJ > P.budgetMs * 0.6
    ? `WITHIN BUDGET, but only just on the CPU side: JS alone is ${f1(meanJ)}ms of the ${P.budgetMs}ms frame. ` +
      `There is little headroom left for a slower machine.`
    : `WITHIN BUDGET. JS costs ${f1(meanJ)}ms of the ${P.budgetMs}ms frame; the rest is vsync wait.`;
} else if (meanJ > P.budgetMs * 0.8) {
  bottleneck = `CPU-BOUND. The game's own JS is ${f1(meanJ)}ms per frame against a ${P.budgetMs}ms budget — ` +
    `the frame is lost before the GPU is asked to do anything. Optimise update/lateUpdate and draw submission.`;
} else if (meanJ < P.budgetMs * 0.5) {
  bottleneck = `GPU-BOUND. JS is only ${f1(meanJ)}ms but frames take ${f1(meanD)}ms, so ${f1(meanD - meanJ)}ms ` +
    `per frame is spent outside JS: rasterisation, the post chain, or fill rate. Optimise PIXELS, not logic — ` +
    `resolution, the post chain, overdraw and shader cost, in that order.`;
} else {
  bottleneck = `MIXED. JS is ${f1(meanJ)}ms of a ${f1(meanD)}ms frame — neither side alone explains the miss. ` +
    `Cut both, or cut resolution.`;
}
console.log(`\nbottleneck       : ${bottleneck}`);

// ---------------------------------------------------------------------------
//  6. Gate
// ---------------------------------------------------------------------------
const fails = [];
// Mean, not median — see the header. 2% slack absorbs the fact that a 60Hz
// vsync is 16.667ms and the budget is written as 16.7.
if (meanD > P.budgetMs * 1.02) {
  fails.push(`mean frame ${f2(meanD)}ms > ${P.budgetMs}ms budget  ` +
    `(${fpsMean.toFixed(1)} fps, target ${(1000 / P.budgetMs).toFixed(0)})`);
}
if (dropPct > P.maxOverPct) fails.push(`${dropPct.toFixed(1)}% of frames dropped > ${P.maxOverPct}%`);
if (run.frames > P.maxRun) fails.push(`${run.frames} consecutive dropped frames > ${P.maxRun}`);
if (skipped > shown.length * 0.02) fails.push(`${skipped} presents skipped by the watchdog (${((skipped / shown.length) * 100).toFixed(1)}%)`);
if (pageErrors.length) fails.push(`${pageErrors.length} page errors`);
/**
 * A run under a throttle that did not engage is not a slow pass or a fast pass,
 * it is an answer to a different question — and the mobile profile exists
 * entirely to answer this one. It used to warn and carry on, which is how a
 * desktop number gets quoted as a phone's. See the throttle measurement above.
 */
if (throttleFailed) {
  fails.push(`CPU throttle did not engage: ${cpuMeasured.toFixed(2)}x measured against ` +
    `${P.cpu}x requested — this is not a ${PROFILE}-class result`);
}
/**
 * The frame rate is only interesting if the world is still being drawn. Floors
 * far below any legitimate quality tier — see MIN_CALLS/MIN_TRIS above.
 */
if (Number.isFinite(p50calls) && p50calls < MIN_CALLS) {
  fails.push(`median ${p50calls} draw calls per frame < ${MIN_CALLS} — the scene is not being drawn`);
}
if (Number.isFinite(p50tris) && p50tris < MIN_TRIS) {
  fails.push(`median ${p50tris} triangles per frame < ${MIN_TRIS} — the scene is not being drawn`);
}
if (!presentedFrames) fails.push('nothing was rendered during the window');

const result = {
  profile: PROFILE, renderer: gpu.renderer, vendor: gpu.vendor,
  viewport: { width: P.width, height: P.height, deviceScaleFactor: P.dsf, devicePixelRatio: env.dpr },
  cpuThrottle: { requested: P.cpu, measured: +cpuMeasured.toFixed(2), engaged: !throttleFailed },
  quality: QNAME, pixelRatio: env.pixelRatio,
  // Both ends, because the scaler moves. `megapixels` stays the start value for
  // compatibility with anything already parsing it; `megapixelsEnd` is the one
  // to trust when `drawingBufferChanged` is true.
  drawingBuffer: env.canvas, megapixels: +MPX.toFixed(3),
  drawingBufferEnd: envEnd.canvas, megapixelsEnd: +MPX_END.toFixed(3), drawingBufferChanged: bufferChanged,
  rung: env.gl?.rung ?? null,
  seconds: +span.toFixed(2), frames: shown.length, presented: presentedFrames, skipped,
  fpsTicked: +fpsMean.toFixed(2), fpsPresented: +fpsPresented.toFixed(2),
  delta: { mean: +meanD.toFixed(2), p50: +p50d.toFixed(2), p95: +p95d.toFixed(2), p99: +p99d.toFixed(2), max: +dSorted[dSorted.length - 1].toFixed(2) },
  // `p50OnDropped` is null rather than NaN when nothing was dropped — a clean
  // run must not put `NaN` into a JSON file a workflow is going to parse.
  js: {
    mean: +meanJ.toFixed(2), p50: +p50j.toFixed(2), p95: +p95j.toFixed(2), p99: +p99j.toFixed(2),
    p50OnDropped: Number.isFinite(p50jOver) ? +p50jOver.toFixed(2) : null,
  },
  // Non-stationarity, so a workflow comparing two runs can tell whether the
  // difference it found is larger than the drift inside either one.
  drift: { earlyMs: +driftEarly.toFixed(2), lateMs: +driftLate.toFixed(2), deltaMs: +driftMs.toFixed(2) },
  drawWork: {
    p50Calls: Number.isFinite(p50calls) ? p50calls : null,
    p50Triangles: Number.isFinite(p50tris) ? p50tris : null,
    floors: { calls: MIN_CALLS, triangles: MIN_TRIS },
  },
  overBudget: { count: over.length, pct: +overPct.toFixed(2) },
  dropped: { thresholdMs: +DROP_MS.toFixed(2), count: dropped.length, pct: +dropPct.toFixed(2), longestRun: run.frames },
  renderScale: { start: before?.renderScale ?? null, end: after?.renderScale ?? null },
  bottleneck, budgets: { budgetMs: P.budgetMs, maxOverPct: P.maxOverPct, maxRun: P.maxRun },
  /**
   * Stated in the artefact, not just in the header, because the JSON is what a
   * workflow reads and a workflow will happily "detect" a 0.3 ms regression
   * that is pure noise. Four identical default desktop runs spanned 3.73 ms of
   * mean frame time.
   */
  // Smallest change in mean frame time this harness can resolve in ONE run.
  // Two numbers, because pinning the adaptive ladder is what decides it: the
  // ladder's own rung choice dominates the unpinned spread. Re-measured on a
  // quiet box 2026-07-31 (n=10 pinned, n=6 unpinned) — see the banner above.
  noiseFloorMs: SCALER ? 2 : 9,
  scalerPinned: SCALER ? (after?.scalerPinned === true) : false,
  pass: fails.length === 0, fails,
};
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}

// The PASS line quotes the END-of-window megapixels, and says the dsf out loud.
// "60 fps at 2.07 Mpx" and "60 fps at 0.16 Mpx" are both true sentences about
// this game and they mean completely different things.
console.log(fails.length
  ? `\nFAIL (${PROFILE}):\n  ` + fails.join('\n  ')
  : `\nPASS (${PROFILE}) — sustained ${fpsPresented.toFixed(0)} fps at quality ${QNAME}, ` +
    `${MPX_END.toFixed(2)} Mpx (dsf ${P.dsf}), render scale ${after?.renderScale ?? '?'}` +
    `${Math.abs(driftMs) > 2 ? `\n  NOTE: frame cost drifted ${f2(driftMs)}ms across the window; this pass is a point sample.` : ''}`);

await browser.close();
srv.stop();
process.exit(fails.length ? 1 : 0);
