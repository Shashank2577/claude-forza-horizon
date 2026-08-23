/**
 * Hud.js — Premium racing HUD overlay (DOM + Canvas2D).
 *
 * A sleek, modern heads-up display in the Forza Horizon spirit: angular glass
 * panels, an accent gradient stroke, an animated arc speedometer with a needle
 * and tick marks, a gear/RPM cluster with boost state, a heading-aware minimap,
 * and a minimal title/fps plate. Everything is drawn on Canvas2D for crisp
 * vector rendering that stays sharp on high-DPI displays.
 *
 * Contract:
 *   const hud = new Hud();           // builds overlay, appends to document.body
 *   hud.update({ car, fps });        // call every frame
 *   hud.setCenterline(points);       // optional: [{x,z}, ...] road path for the minimap
 *
 *   car = { speed: m/s (signed), heading: rad, boosting: bool }
 *
 * Design notes:
 *  - No external assets; system fonts + procedural canvas drawing only.
 *  - devicePixelRatio aware: canvas backing store scales with DPR for crispness.
 *  - Eased (lerp) animations so the needle/bars glide instead of snapping.
 *  - Defensive: works when car fields are 0/undefined on the first frames.
 */

// -----------------------------------------------------------------------------
// Theme
// -----------------------------------------------------------------------------

const ACCENT_A = '#ff7a18'; // warm orange
const ACCENT_B = '#ff2d78'; // magenta
const ACCENT_C = '#22e3ff'; // cool cyan (boost)
const GLASS_BG = 'rgba(10, 12, 18, 0.55)';
const GLASS_BORDER = 'rgba(255, 255, 255, 0.12)';
const TEXT_DIM = 'rgba(220, 228, 240, 0.78)';
const TEXT_BRIGHT = '#f4f7fb';
const MAX_SPEED_KMH = 320; // arc saturates here -> ~89 m/s
const GEAR_COUNT = 6;

// Linear interpolation + angle wrap into [0, 2π).
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class Hud {
  constructor() {
    // --- Smoothed (eased) state. update() pushes targets here; draw() chases. ---
    this._speedKmh = 0; // eased display speed
    this._rpm = 0; // eased 0..1 rpm proxy
    this._fps = 60; // eased fps readout
    this._boostGlow = 0; // eased 0..1 boost intensity (for pulse/lighting)
    this._nitro = 1;
    this._upshiftFlash = 0; // decays after gear change -> flash the rpm bar
    this._lastGear = 1;

    // --- Minimap road path (optional; main.js may call setCenterline later). ---
    this._centerline = null; // [{x,z}, ...] in world meters

    // --- Build the DOM overlay tree. ---
    this._root = document.createElement('div');
    this._root.className = 'hz-hud';
    Object.assign(this._root.style, Hud._overlayStyle());

    // Top-left: title + fps plate.
    this._titleEl = this._buildTitlePlate();
    this._root.appendChild(this._titleEl);

    // Bottom-RIGHT: speedometer + gear/rpm/boost cluster, drawn on one canvas.
    // r7: was bottom-center 420×260 — the chase cam keeps the car mid-frame,
    // so the cluster sat directly over it and read as "HUD covering the car"
    // (critic kill). Forza parks it in the corner, smaller.
    this._dial = this._createCanvas();
    this._dial.style.cssText =
      'position:absolute;right:22px;bottom:16px;' +
      'width:290px;height:172px;pointer-events:none;';
    this._root.appendChild(this._dial);

    // Top-right: minimap.
    this._map = this._createCanvas();
    this._map.style.cssText =
      'position:absolute;right:20px;top:20px;' +
      'width:168px;height:168px;pointer-events:none;';
    this._root.appendChild(this._map);

    // Full-screen speed lines at high velocity (FH speed sensation).
    this._speedLines = this._createCanvas();
    this._speedLines.style.cssText =
      'position:absolute;inset:0;pointer-events:none;';
    this._root.appendChild(this._speedLines);

    // --- Race layer (only meaningful when a Race is wired in). ---
    // Car position for the car-centered minimap.
    this._carX = 0; this._carZ = 0;

    // Top-center race bar: timer + checkpoint progress.
    this._raceBar = this._buildRaceBar();
    this._root.appendChild(this._raceBar);

    // Full-viewport overlay canvas for the off-screen next-waypoint arrow.
    this._overlay = this._createCanvas();
    this._overlay.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
    this._root.appendChild(this._overlay);

    // Popup stack (DOM, CSS-animated) + finish card.
    this._popupsRoot = document.createElement('div');
    this._popupsRoot.style.cssText =
      'position:absolute;left:50%;top:24%;transform:translateX(-50%);' +
      'display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;width:0;';
    this._root.appendChild(this._popupsRoot);
    this._popupEls = []; // last-rendered popup mirror (for diffing)
    this._finishCard = this._buildFinishCard();
    this._root.appendChild(this._finishCard);

    // Race-position badge (sits under the minimap).
    this._posBadge = document.createElement('div');

    // Surface chip (asphalt / grass / water).
    this._surfaceEl = document.createElement('div');
    this._surfaceEl.style.cssText =
      'position:absolute;left:50%;bottom:288px;transform:translateX(-50%);' +
      'padding:4px 12px;border-radius:99px;font:700 11px/1 Inter,system-ui,sans-serif;' +
      'letter-spacing:1.5px;color:#e8eef8;background:rgba(10,13,18,.55);' +
      'border:1px solid rgba(255,255,255,.12);pointer-events:none;opacity:0;transition:opacity .2s';
    this._root.appendChild(this._surfaceEl);

    this._wrongWayEl = document.createElement('div');
    this._wrongWayEl.textContent = 'WRONG WAY';
    this._wrongWayEl.style.cssText =
      'position:absolute;left:50%;top:18%;transform:translateX(-50%);' +
      'padding:10px 22px;border-radius:12px;font:800 18px/1 Inter,system-ui,sans-serif;' +
      'letter-spacing:3px;color:#fff;background:rgba(180,20,40,.82);' +
      'border:1px solid rgba(255,120,120,.45);pointer-events:none;opacity:0;transition:opacity .15s';
    this._root.appendChild(this._wrongWayEl);
    this._posBadge.style.cssText =
      'position:absolute;right:20px;top:196px;width:168px;text-align:center;' +
      'padding:4px 0;border-radius:10px;font-size:15px;font-weight:800;letter-spacing:0.06em;' +
      'background:' + GLASS_BG + ';border:1px solid ' + GLASS_BORDER + ';' +
      'backdrop-filter:blur(10px) saturate(140%);-webkit-backdrop-filter:blur(10px) saturate(140%);' +
      'color:' + TEXT_BRIGHT + ';display:none;font-variant-numeric:tabular-nums;';
    this._root.appendChild(this._posBadge);

    this._race = null;
    this._rivals = null;
    this._camera = null;

    document.body.appendChild(this._root);

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
    this._onResize();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Optional road centerline for the minimap. Safe to never call. */
  setCenterline(points) {
    this._centerline = Array.isArray(points) ? points : null;
  }

  /** Per-frame update. `car` = { speed(m/s), heading(rad), boosting, position:Vector3 },
   *  `fps` = number. `race` (optional Race.state) and `camera` drive the race layer. */
  update({ car, fps, race, rivals, camera }) {
    const c = car || {};
    // Track car world position for the car-centered minimap.
    if (c.position) { this._carX = c.position.x; this._carZ = c.position.z; }
    this._race = race || null;
    this._rivals = rivals || null;
    this._camera = camera || null;
    const speedRaw = Math.abs(Number(c.speed) || 0); // gauge shows magnitude
    const speedKmh = speedRaw * 3.6; // m/s -> km/h
    const heading = Number(c.heading) || 0;
    const boosting = !!c.boosting;
    const fpsVal = Number(fps) || 60;

    // Derive a believable gear (1..GEAR_COUNT) from speed bands.
    const gear = clamp(
      Math.ceil((speedKmh / MAX_SPEED_KMH) * GEAR_COUNT) || 1,
      1,
      GEAR_COUNT,
    );

    // RPM proxy: within each gear band, ramp 0.25 -> ~1.0, then dip on upshift.
    const bandStart = ((gear - 1) / GEAR_COUNT) * MAX_SPEED_KMH;
    const bandEnd = (gear / GEAR_COUNT) * MAX_SPEED_KMH;
    let rpm = clamp((speedKmh - bandStart) / Math.max(1, bandEnd - bandStart), 0, 1);
    rpm = 0.25 + rpm * 0.75; // idle floor so the bar is never fully empty

    // Trigger a brief upshift flash when the gear number advances.
    if (gear > this._lastGear) this._upshiftFlash = 1;
    this._lastGear = gear;

    // --- Ease all displayed values toward targets (smooth motion, no snapping). ---
    const kFast = 0.25; // responsive but not instant
    this._speedKmh = lerp(this._speedKmh, speedKmh, kFast);
    this._rpm = lerp(this._rpm, rpm, kFast);
    this._fps = lerp(this._fps, fpsVal, 0.08); // fps readout damps hard
    this._boostGlow = lerp(
      this._boostGlow,
      boosting ? 1 : 0,
      boosting ? 0.3 : 0.12,
    );
    this._nitro = lerp(this._nitro ?? 1, Number(c.nitro) || 0, 0.35);
    this._upshiftFlash = Math.max(0, this._upshiftFlash - 0.06); // decay

    if (this._surfaceEl) {
      const name = c.surfaceName || 'ASPHALT';
      this._surfaceEl.textContent = name;
      this._surfaceEl.style.opacity = name === 'ASPHALT' ? '0' : '1';
      this._surfaceEl.style.color = name === 'WATER' ? '#7ad7ff'
        : name === 'GRASS' ? '#9dff9a'
        : name === 'SHOULDER' ? '#ffd27a' : '#e8eef8';
    }
    if (this._wrongWayEl) {
      this._wrongWayEl.style.opacity = c.wrongWay ? '1' : '0';
    }

    this._drawDial(gear, boosting);
    this._drawMinimap(heading);
    this._drawSpeedLines(boosting);
    this._updateTitlePlate(fpsVal);

    // --- Race layer (no-op when no Race is wired in). ---
    this._updateRace();
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  /** Shared overlay container styling (dark glass, full-viewport, above game canvas). */
  static _overlayStyle() {
    return {
      position: 'fixed',
      inset: '0',
      zIndex: '50',
      pointerEvents: 'none',
      fontFamily:
        "'Inter','Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif",
      color: TEXT_BRIGHT,
      userSelect: 'none',
      letterSpacing: '0.04em',
      textShadow: '0 1px 6px rgba(0,0,0,0.55)',
    };
  }

  /** Create a blank canvas element sized to its CSS box (DPR handled in _onResize). */
  _createCanvas() {
    const cv = document.createElement('canvas');
    cv.className = 'hz-canvas';
    return cv;
  }

  _buildTitlePlate() {
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;left:22px;top:18px;' +
      'padding:10px 16px 11px;border-radius:12px;' +
      'background:' + GLASS_BG + ';' +
      'backdrop-filter:blur(10px) saturate(140%);' +
      '-webkit-backdrop-filter:blur(10px) saturate(140%);' +
      'border:1px solid ' + GLASS_BORDER + ';' +
      'box-shadow:0 6px 24px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06);';
    el.innerHTML =
      '<div class="hz-title" style="font-size:15px;font-weight:800;letter-spacing:0.32em;' +
      'background:linear-gradient(90deg,' + ACCENT_A + ',' + ACCENT_B + ');' +
      '-webkit-background-clip:text;background-clip:text;color:transparent;">HORIZON</div>' +
      '<div class="hz-fps" style="margin-top:2px;font-size:11px;font-weight:600;color:' +
      TEXT_DIM + ';font-variant-numeric:tabular-nums;">— FPS</div>';
    return el;
  }

  _updateTitlePlate(fps) {
    const fpsNode = this._titleEl.querySelector('.hz-fps');
    if (!fpsNode) return;
    const v = Math.round(this._fps);
    // Subtle color cue: green when healthy, warm when struggling.
    const col = v >= 50 ? '#7dffa8' : v >= 30 ? '#ffd166' : '#ff5d5d';
    fpsNode.innerHTML =
      '<span style="color:' + col + '">' + v + '</span>' +
      '<span style="opacity:0.6"> FPS</span>';
    void fps; // smoothing happens via _fps in update()
  }

  // ---------------------------------------------------------------------------
  // Resize / DPR
  // ---------------------------------------------------------------------------

  _onResize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5); // cap for perf
    this._fitCanvas(this._dial, dpr);
    this._fitCanvas(this._map, dpr);
    this._fitCanvas(this._speedLines, dpr);
    // Overlay tracks the full viewport (CSS size == window).
    this._overlay.style.width = window.innerWidth + 'px';
    this._overlay.style.height = window.innerHeight + 'px';
    this._fitCanvas(this._overlay, dpr);
  }

  /** Match canvas backing store to its CSS size * dpr. */
  _fitCanvas(cv, dpr) {
    const r = cv.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
  }

  // ---------------------------------------------------------------------------
  // Speedometer + gear/RPM/boost cluster (bottom-center)
  // ---------------------------------------------------------------------------

  _drawDial(gear, boosting) {
    const cv = this._dial;
    const ctx = cv.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = cv.width / dpr;
    const h = cv.height / dpr;
    ctx.clearRect(0, 0, w, h);

    // Gauge geometry: arc spans 240deg, centered, gap at the bottom.
    const cx = w / 2;
    const cy = h * 0.62;
    const R = Math.min(w, h) * 0.42;
    const START = Math.PI * 0.75; // 135deg
    const SWEEP = Math.PI * 1.5; // 270deg
    const END = START + SWEEP;

    // --- Glass panel behind the cluster. ---
    this._drawGlassPanel(ctx, w * 0.06, h * 0.08, w * 0.88, h * 0.84, 18);

    // --- Tick marks + labels. ---
    this._drawTicks(ctx, cx, cy, R, START, END);

    // --- Speed arc fill (gradient, grows with speed). ---
    const t = clamp(this._speedKmh / MAX_SPEED_KMH, 0, 1);
    this._drawSpeedArc(ctx, cx, cy, R, START, SWEEP, t);

    // --- Needle. ---
    this._drawNeedle(ctx, cx, cy, R, START + SWEEP * t);

    // --- Center hub + big numeric readout. ---
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,24,32,0.95)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.stroke();

    // Big speed number.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '800 ' + Math.round(R * 0.62) + "px 'Inter','Segoe UI',system-ui,sans-serif";
    ctx.fillStyle = TEXT_BRIGHT;
    ctx.fillText(Math.round(this._speedKmh).toString(), cx, cy + R * 0.34);

    // "KM/H" unit tag.
    ctx.font = '700 ' + Math.round(R * 0.16) + "px 'Inter',system-ui,sans-serif";
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText('KM/H', cx, cy + R * 0.56);

    // --- Gear + RPM + boost cluster, bottom-left of the dial canvas. ---
    this._drawGearCluster(ctx, 0, h - 64, w * 0.5, gear, boosting);
  }

  _drawGlassPanel(ctx, x, y, w, h, r) {
    ctx.save();
    ctx.beginPath();
    this._roundRect(ctx, x, y, w, h, r);
    ctx.fillStyle = GLASS_BG;
    ctx.fill();
    // Subtle top highlight.
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, 'rgba(255,255,255,0.06)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = g;
    ctx.fill();
    // Accent gradient stroke.
    const sg = ctx.createLinearGradient(x, y, x + w, y);
    sg.addColorStop(0, ACCENT_A);
    sg.addColorStop(1, ACCENT_B);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = sg;
    ctx.stroke();
    ctx.restore();
  }

  _drawTicks(ctx, cx, cy, R, start, end) {
    const N = 9; // major ticks (0,40,80,...,320)
    const majors = N;
    const minorsPer = 4;
    ctx.save();
    for (let i = 0; i < majors; i++) {
      const a = start + (end - start) * (i / (majors - 1));
      // Major tick.
      this._tick(ctx, cx, cy, R, a, R * 0.16, 'rgba(255,255,255,0.85)', 2.5);
      // Label.
      const val = Math.round((MAX_SPEED_KMH * i) / (majors - 1));
      const lx = cx + Math.cos(a) * (R - R * 0.30);
      const ly = cy + Math.sin(a) * (R - R * 0.30);
      ctx.font = '700 ' + Math.round(R * 0.115) + "px 'Inter',system-ui,sans-serif";
      ctx.fillStyle = 'rgba(235,242,250,0.7)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(val.toString(), lx, ly);
      // Minor ticks between this major and the next.
      if (i < majors - 1) {
        for (let m = 1; m < minorsPer; m++) {
          const ma = a + (end - start) * (m / (minorsPer * (majors - 1)));
          this._tick(ctx, cx, cy, R, ma, R * 0.07, 'rgba(255,255,255,0.28)', 1.25);
        }
      }
    }
    ctx.restore();
  }

  _tick(ctx, cx, cy, R, angle, len, color, width) {
    const x1 = cx + Math.cos(angle) * (R - len);
    const y1 = cy + Math.sin(angle) * (R - len);
    const x2 = cx + Math.cos(angle) * R;
    const y2 = cy + Math.sin(angle) * R;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  _drawSpeedArc(ctx, cx, cy, R, start, sweep, t) {
    const arcW = R * 0.10;
    const radius = R - arcW * 0.5 - 2;

    // Track (dim base ring).
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, start + sweep);
    ctx.lineWidth = arcW;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineCap = 'round';
    ctx.stroke();

    if (t <= 0) return;

    // Active fill: orange->magenta along the arc.
    const grad = ctx.createLinearGradient(cx - R, cy, cx + R, cy);
    grad.addColorStop(0, ACCENT_A);
    grad.addColorStop(1, ACCENT_B);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, start + sweep * t);
    ctx.lineWidth = arcW;
    ctx.strokeStyle = grad;
    ctx.lineCap = 'round';
    ctx.shadowColor = ACCENT_B;
    ctx.shadowBlur = 16 * t;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  _drawNeedle(ctx, cx, cy, R, angle) {
    const len = R * 0.82;
    const tail = R * 0.16;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    // Tapered needle body.
    ctx.beginPath();
    ctx.moveTo(-tail, -3);
    ctx.lineTo(len, -1.25);
    ctx.lineTo(len + R * 0.04, 0);
    ctx.lineTo(len, 1.25);
    ctx.lineTo(-tail, 3);
    ctx.closePath();
    const ng = ctx.createLinearGradient(-tail, 0, len, 0);
    ng.addColorStop(0, 'rgba(255,255,255,0.4)');
    ng.addColorStop(0.5, '#ffffff');
    ng.addColorStop(1, ACCENT_B);
    ctx.fillStyle = ng;
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fill();
    ctx.restore();
  }

  /** Gear digit + RPM bar + boost/NITRO light, left of the speed readout. */
  _drawGearCluster(ctx, x, y, w, gear, boosting) {
    const boxW = 96;
    const boxH = 52;
    const bx = x + 18;
    const by = y;

    // Gear digit.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '800 40px "Inter",system-ui,sans-serif';
    const gg = ctx.createLinearGradient(bx, 0, bx + boxW, 0);
    gg.addColorStop(0, ACCENT_A);
    gg.addColorStop(1, ACCENT_B);
    ctx.fillStyle = gg;
    ctx.fillText(String(gear), bx + boxW * 0.5, by + 34);

    // "GEAR" caption.
    ctx.font = '700 9px "Inter",system-ui,sans-serif';
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText('GEAR', bx + boxW * 0.5, by + 47);

    // RPM bar (right of gear digit).
    const barX = bx + boxW + 14;
    const barY = by + 26;
    const barW = Math.min(150, w - boxW - 30);
    const barH = 10;
    if (barW > 20) {
      // Track.
      this._roundRect(ctx, barX, barY, barW, barH, 5);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fill();

      // Fill.
      const fw = Math.max(0, barW * clamp(this._rpm, 0, 1));
      if (fw > 0.5) {
        const fg = ctx.createLinearGradient(barX, 0, barX + barW, 0);
        fg.addColorStop(0, ACCENT_A);
        fg.addColorStop(0.7, ACCENT_B);
        fg.addColorStop(1, '#ffd166');
        this._roundRect(ctx, barX, barY, fw, barH, 5);
        ctx.fillStyle = fg;
        ctx.fill();
      }

      // Upshift flash overlay.
      if (this._upshiftFlash > 0.01) {
        ctx.save();
        ctx.globalAlpha = this._upshiftFlash;
        this._roundRect(ctx, barX, barY, barW, barH, 5);
        ctx.fillStyle = '#fff6d0';
        ctx.fill();
        ctx.restore();
      }

      // "RPM" caption.
      ctx.textAlign = 'left';
      ctx.font = '700 9px "Inter",system-ui,sans-serif';
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText('RPM', barX, barY - 5);
    }

    // Boost / NITRO meter (fill = remaining charge).
    const nx = barX;
    const ny = barY + barH + 12;
    const nitro = clamp(Number(this._nitro) || 0, 0, 1);
    const nitroW = Math.min(150, w - boxW - 30);
    if (nitroW > 20) {
      this._roundRect(ctx, nx, ny - 4, nitroW, 8, 4);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fill();
      const nw = Math.max(0, nitroW * nitro);
      if (nw > 0.5) {
        const ng = ctx.createLinearGradient(nx, 0, nx + nitroW, 0);
        ng.addColorStop(0, '#ff6a00');
        ng.addColorStop(1, '#ffd166');
        this._roundRect(ctx, nx, ny - 4, nw, 8, 4);
        ctx.fillStyle = ng;
        ctx.fill();
      }
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const glow = this._boostGlow;
    ctx.font = '800 11px "Inter",system-ui,sans-serif';
    ctx.fillStyle = glow > 0.4 ? '#ffd166' : 'rgba(255,255,255,0.35)';
    ctx.fillText('NITRO', nx, ny + 14);
    if (glow > 0.01) {
      ctx.save();
      ctx.globalAlpha = glow;
      ctx.shadowColor = ACCENT_C;
      ctx.shadowBlur = 14 * glow;
      ctx.fillStyle = '#ffd166';
      ctx.fillText('NITRO', nx, ny + 14);
      ctx.restore();
    }
  }

  /** Radial speed streaks — intensify above ~80 km/h. */
  _drawSpeedLines(boosting) {
    const cv = this._speedLines;
    const ctx = cv.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.width / dpr;
    const h = cv.height / dpr;
    ctx.clearRect(0, 0, w, h);

    const t = clamp((this._speedKmh - 75) / 200, 0, 1);
    if (t < 0.02) return;

    const cx = w * 0.5;
    const cy = h * 0.72;
    const lines = 28 + Math.floor(t * 24);
    const boost = boosting ? this._boostGlow : 0;

    ctx.save();
    ctx.globalAlpha = (0.08 + t * 0.22) * (1 + boost * 0.35);
    ctx.strokeStyle = boost > 0.3 ? ACCENT_C : '#ffffff';
    ctx.lineWidth = 1.2 + t * 2.5;

    for (let i = 0; i < lines; i++) {
      const a = (i / lines) * Math.PI * 2 + this._speedKmh * 0.002;
      const len = h * (0.15 + t * 0.45) * (0.6 + Math.random() * 0.4);
      const x0 = cx + Math.cos(a) * 40;
      const y0 = cy + Math.sin(a) * 20;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + Math.cos(a) * len, y0 + Math.sin(a) * len);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Minimap (top-right)
  // ---------------------------------------------------------------------------

  _drawMinimap(heading) {
    const cv = this._map;
    const ctx = cv.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const size = cv.width / dpr; // square
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const R = size * 0.46;

    // --- Clip to circle, draw glass + faint grid. ---
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    // Glass base.
    const bg = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R);
    bg.addColorStop(0, 'rgba(14,18,26,0.65)');
    bg.addColorStop(1, 'rgba(8,10,14,0.78)');
    ctx.fillStyle = bg;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

    // Rotate the world so the car always points up.
    ctx.translate(cx, cy);
    ctx.rotate(-heading); // cancel car heading -> north-up-relative-to-car

    // Scale: world meters -> minimap pixels. Tuned so ~320m fits.
    const scale = R / 170;
    const carX = this._carX, carZ = this._carZ;

    // --- Optional road centerline (car-centered: subtract car world pos). ---
    if (this._centerline && this._centerline.length > 1) {
      ctx.beginPath();
      for (let i = 0; i < this._centerline.length; i++) {
        const p = this._centerline[i];
        const px = ((p.x || 0) - carX) * scale;
        const py = ((p.z || 0) - carZ) * scale; // z maps to screen-y
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
      // Bright accent core.
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255,122,24,0.85)';
      ctx.stroke();
    }

    // --- Race markers (gates / finish / next), also car-centered. ---
    if (this._race && this._race.gates) {
      const nextGate = this._race.nextGate;
      this._race.gates.forEach((gg, i) => {
        const px = (gg.x - carX) * scale;
        const py = (gg.z - carZ) * scale;
        // Cull off-disc.
        if (px * px + py * py > (R * 1.05) * (R * 1.05)) return;
        ctx.beginPath();
        ctx.arc(px, py, 3.4, 0, Math.PI * 2);
        if (i === this._race.gates.length - 1) {
          ctx.fillStyle = '#ff2d78'; // finish
        } else if (i === nextGate) {
          ctx.fillStyle = '#ffd23d'; // next checkpoint (pulsing)
          const pulse = 3.4 + Math.sin(performance.now() / 180) * 1.1;
          ctx.beginPath(); ctx.arc(px, py, pulse, 0, Math.PI * 2);
          ctx.fillStyle = '#ffd23d';
        } else if (i < nextGate) {
          ctx.fillStyle = 'rgba(120,160,200,0.5)'; // passed
        } else {
          ctx.fillStyle = 'rgba(73,198,255,0.9)'; // upcoming
        }
        ctx.fill();
      });
    }

    // --- Rival cars (red dots) + Danger Sign ramp (yellow triangle). ---
    if (this._rivals && this._rivals.rivals) {
      for (const rv of this._rivals.rivals) {
        const px = (rv.x - carX) * scale;
        const py = (rv.z - carZ) * scale;
        if (px * px + py * py > (R * 1.05) * (R * 1.05)) continue;
        ctx.beginPath();
        ctx.arc(px, py, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = '#ff3b3b';
        ctx.fill();
      }
    }
    if (this._race && this._race.dangerPos) {
      const dp = this._race.dangerPos;
      const px = (dp.x - carX) * scale;
      const py = (dp.z - carZ) * scale;
      if (px * px + py * py <= (R * 1.05) * (R * 1.05)) {
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(Math.PI); // triangle apex marks the spot
        ctx.beginPath();
        ctx.moveTo(0, -5); ctx.lineTo(4.5, 4); ctx.lineTo(-4.5, 4); ctx.closePath();
        ctx.fillStyle = '#ffd23d';
        ctx.fill();
        ctx.restore();
      }
    }
    // Drift Zone (purple diamond).
    if (this._race && this._race.driftPos) {
      const dp = this._race.driftPos;
      const px = (dp.x - carX) * scale;
      const py = (dp.z - carZ) * scale;
      if (px * px + py * py <= (R * 1.05) * (R * 1.05)) {
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = '#b14dff';
        ctx.fillRect(-3.5, -3.5, 7, 7);
        ctx.restore();
      }
    }

    // Faint cardinal cross for orientation.
    ctx.beginPath();
    ctx.moveTo(0, -R); ctx.lineTo(0, R);
    ctx.moveTo(-R, 0); ctx.lineTo(R, 0);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.stroke();

    ctx.restore(); // remove rotation/clip

    // --- Ring + ticks (drawn unrotated on top). ---
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    const rg = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    rg.addColorStop(0, ACCENT_A);
    rg.addColorStop(1, ACCENT_B);
    ctx.strokeStyle = rg;
    ctx.stroke();

    // North marker at top.
    ctx.save();
    ctx.translate(cx, cy - R);
    ctx.beginPath();
    ctx.moveTo(0, -4);
    ctx.lineTo(-5, 5);
    ctx.lineTo(5, 5);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();

    ctx.font = '800 9px "Inter",system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText('N', cx, cy - R - 8);

    // --- Car arrow (always center, pointing up). ---
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6, 7);
    ctx.lineTo(0, 3);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fillStyle = TEXT_BRIGHT;
    ctx.shadowColor = ACCENT_B;
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Race layer: top-center timer/progress bar, off-screen waypoint arrow,
  // result pop-ups, and the finish card. All no-ops when no Race is wired in.
  // ---------------------------------------------------------------------------

  _buildRaceBar() {
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;left:50%;top:18px;transform:translateX(-50%);' +
      'display:none;align-items:center;gap:16px;padding:9px 20px;border-radius:14px;' +
      'background:' + GLASS_BG + ';border:1px solid ' + GLASS_BORDER + ';' +
      'backdrop-filter:blur(10px) saturate(140%);-webkit-backdrop-filter:blur(10px) saturate(140%);' +
      'box-shadow:0 6px 24px rgba(0,0,0,0.35),inset 0 1px 0 rgba(255,255,255,0.06);' +
      'font-variant-numeric:tabular-nums;';
    el.innerHTML =
      '<span class="hz-rtime" style="font-size:30px;font-weight:800;letter-spacing:0.02em;color:' +
        TEXT_BRIGHT + ';min-width:128px;text-align:center;">0:00.00</span>' +
      '<span style="width:1px;height:28px;background:rgba(255,255,255,0.14);"></span>' +
      '<span style="display:flex;flex-direction:column;line-height:1.05;align-items:flex-start;">' +
        '<span class="hz-rprog" style="font-size:13px;font-weight:800;color:' + TEXT_BRIGHT +
        ';min-width:64px;">CP 0/11</span>' +
        '<span class="hz-rlbl" style="font-size:9px;font-weight:700;letter-spacing:0.18em;color:' +
        ACCENT_A + ';margin-top:1px;">READY</span>' +
      '</span>';
    return el;
  }

  _buildFinishCard() {
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;left:50%;top:42%;transform:translate(-50%,-50%);' +
      'padding:28px 46px;border-radius:22px;text-align:center;display:none;' +
      'background:' + GLASS_BG + ';border:1px solid ' + GLASS_BORDER + ';' +
      'backdrop-filter:blur(14px) saturate(150%);-webkit-backdrop-filter:blur(14px) saturate(150%);' +
      'box-shadow:0 10px 40px rgba(0,0,0,0.5);';
    el.innerHTML =
      '<div style="font-size:32px;font-weight:900;letter-spacing:0.08em;' +
        'background:linear-gradient(90deg,' + ACCENT_A + ',' + ACCENT_B + ');' +
        '-webkit-background-clip:text;background-clip:text;color:transparent;">RACE COMPLETE</div>' +
      '<div class="hz-ftime" style="font-size:50px;font-weight:800;margin-top:6px;color:' +
        TEXT_BRIGHT + ';font-variant-numeric:tabular-nums;">0:00.00</div>' +
      '<div class="hz-frating" style="font-size:30px;margin-top:4px;letter-spacing:0.16em;color:#ffd23d;">★ ★ ★</div>' +
      '<div style="margin-top:14px;font-size:11px;font-weight:700;letter-spacing:0.2em;color:' +
        TEXT_DIM + ';"><span class="hz-fbest"></span></div>' +
      '<div style="margin-top:6px;font-size:12px;font-weight:700;letter-spacing:0.2em;color:' +
        ACCENT_C + ';">PRESS R TO RACE AGAIN</div>';
    return el;
  }

  _updateRace() {
    const r = this._race;
    const bar = this._raceBar;
    if (!r) {
      bar.style.display = 'none';
      this._finishCard.style.display = 'none';
      this._posBadge.style.display = 'none';
      this._clearOverlay();
      this._popupsRoot.replaceChildren();
      this._popupEls = [];
      return;
    }
    bar.style.display = 'flex';

    const timeEl = bar.querySelector('.hz-rtime');
    const progEl = bar.querySelector('.hz-rprog');
    const lblEl = bar.querySelector('.hz-rlbl');
    const isCircuit = r.type === 'circuit';

    if (isCircuit) {
      const totalLaps = r.totalLaps || 3;
      if (r.phase === 'idle') {
        timeEl.textContent = '0:00.00';
        progEl.textContent = 'LAP 1/' + totalLaps;
        lblEl.textContent = 'CIRCUIT';
        lblEl.style.color = ACCENT_C;
      } else if (r.phase === 'racing') {
        timeEl.textContent = this._fmtTime(r.elapsed);
        progEl.textContent = 'LAP ' + Math.min(r.laps || 1, totalLaps) + '/' + totalLaps;
        lblEl.textContent = r.lastLap ? ('LAST ' + this._fmtTime(r.lastLap)) : 'RACING';
        lblEl.style.color = ACCENT_B;
      } else {
        timeEl.textContent = this._fmtTime(r.finishTime);
        progEl.textContent = 'COMPLETE';
        lblEl.textContent = 'FINISH';
        lblEl.style.color = ACCENT_A;
      }
    } else {
      const total = r.gatesTotal;
      if (r.phase === 'idle') {
        timeEl.textContent = '0:00.00';
        progEl.textContent = 'CP 0/' + (total - 1);
        lblEl.textContent = 'GET TO THE START';
        lblEl.style.color = ACCENT_A;
      } else if (r.phase === 'racing') {
        timeEl.textContent = this._fmtTime(r.elapsed);
        progEl.textContent = 'CP ' + Math.max(0, r.gatesPassed - 1) + '/' + (total - 1);
        lblEl.textContent = 'RACING';
        lblEl.style.color = ACCENT_B;
      } else {
        timeEl.textContent = this._fmtTime(r.finishTime);
        progEl.textContent = 'COMPLETE';
        lblEl.textContent = 'FINISH';
        lblEl.style.color = ACCENT_A;
      }
    }

    // Finish card.
    const card = this._finishCard;
    if (r.phase === 'finished') {
      card.style.display = 'block';
      card.querySelector('.hz-ftime').textContent = this._fmtTime(r.finishTime);
      const stars = '★'.repeat(r.rating) + '☆'.repeat(3 - r.rating);
      card.querySelector('.hz-frating').textContent = stars;
      if (isCircuit) {
        const laps = (r.lapTimes || []).map((t, i) => 'Lap ' + (i + 1) + ' · ' + this._fmtTime(t)).join('<br>');
        card.querySelector('.hz-fbest').innerHTML =
          'Best Lap · ' + this._fmtTime(r.bestLap || 0) + (laps ? '<br>' + laps : '');
      } else {
        const trap = r.speedTrap;
        const dj = r.dangerSign;
        const dz = r.driftZone;
        card.querySelector('.hz-fbest').innerHTML =
          'Speed Trap ' + Math.round(trap.bestKmh) + ' KM/H ' +
          '★'.repeat(trap.bestStars) + '☆'.repeat(3 - trap.bestStars) +
          '<br>Biggest Air ' + Math.round(dj.bestM) + ' m ' +
          '★'.repeat(dj.bestStars) + '☆'.repeat(3 - dj.bestStars) +
          '<br>Drift Zone ' + Math.round(dz.best) + ' pts ' +
          '★'.repeat(dz.bestStars) + '☆'.repeat(3 - dz.bestStars);
      }
    } else {
      card.style.display = 'none';
    }

    // Race-position badge (P x/n) under the minimap — only with rivals.
    const rv = this._rivals;
    if (rv) {
      this._posBadge.style.display = 'block';
      this._posBadge.textContent = 'P ' + rv.playerRank + ' / ' + rv.total;
    } else {
      this._posBadge.style.display = 'none';
    }

    this._drawWaypointArrow(r);
    this._renderPopups(r.popups);
  }

  // Off-screen indicator pointing toward the next checkpoint.
  _drawWaypointArrow(r) {
    const cv = this._overlay;
    const ctx = cv.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const W = cv.width / dpr, H = cv.height / dpr;
    ctx.clearRect(0, 0, W, H);
    if (r.phase === 'finished' || !this._camera) return;
    const ngp = r.nextGatePos;
    if (!ngp) return;
    const v = ngp.clone().project(this._camera);
    let sx = (v.x * 0.5 + 0.5) * W;
    let sy = (-v.y * 0.5 + 0.5) * H;
    const behind = v.z > 1;
    if (behind) { sx = W - sx; sy = H - sy; }
    const margin = 74;
    const onScreen = !behind && sx >= margin && sx <= W - margin && sy >= margin && sy <= H - margin;
    if (onScreen) return; // the in-world beacon handles the visible case

    const ax = clamp(sx, margin, W - margin);
    const ay = clamp(sy, margin, H - margin);
    const ang = Math.atan2(sy - H / 2, sx - W / 2);
    const pulse = 0.7 + 0.3 * Math.sin(performance.now() / 160);

    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(ang);
    // Badge disc.
    ctx.beginPath();
    ctx.arc(0, 0, 20, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,12,18,0.78)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = ACCENT_B;
    ctx.shadowColor = ACCENT_B;
    ctx.shadowBlur = 14 * pulse;
    ctx.stroke();
    ctx.shadowBlur = 0;
    // Chevron arrow pointing outward (+x after rotation).
    ctx.beginPath();
    ctx.moveTo(8, -9);
    ctx.lineTo(16, 0);
    ctx.lineTo(8, 9);
    ctx.lineTo(11, 0);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();
  }

  _clearOverlay() {
    const cv = this._overlay;
    const ctx = cv.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    ctx.clearRect(0, 0, cv.width / dpr, cv.height / dpr);
  }

  _renderPopups(pops) {
    const root = this._popupsRoot;
    root.replaceChildren();
    const now = performance.now();
    for (const p of pops) {
      const t = clamp((now - p.born) / p.life, 0, 1);
      // Enter (0–0.12), hold, exit (0.82–1).
      let scale = 1, opacity = 1;
      if (t < 0.12) { const k = t / 0.12; scale = 0.7 + 0.3 * k; opacity = k; }
      else if (t > 0.82) { const k = (t - 0.82) / 0.18; opacity = 1 - k; }
      const el = document.createElement('div');
      el.style.cssText =
        'display:flex;flex-direction:column;align-items:center;white-space:nowrap;' +
        'opacity:' + opacity.toFixed(3) + ';transform:translateY(0) scale(' + scale.toFixed(3) + ');' +
        'transition:none;';
      el.innerHTML =
        '<span style="font-size:30px;font-weight:900;letter-spacing:0.04em;color:' + p.color +
        ';text-shadow:0 2px 12px rgba(0,0,0,0.6);">' + (p.text || '') + '</span>' +
        (p.sub ? '<span style="margin-top:2px;font-size:15px;font-weight:700;color:' + TEXT_BRIGHT +
          ';text-shadow:0 1px 8px rgba(0,0,0,0.6);">' + p.sub + '</span>' : '');
      root.appendChild(el);
    }
  }

  _fmtTime(s) {
    if (s == null || !isFinite(s)) return '0:00.00';
    const m = Math.floor(s / 60);
    const sec = s - m * 60;
    return m + ':' + sec.toFixed(2).padStart(5, '0');
  }

  // ---------------------------------------------------------------------------
  // Misc
  // ---------------------------------------------------------------------------

  /** Rounded-rect path helper (does not fill/stroke). */
  _roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
}
