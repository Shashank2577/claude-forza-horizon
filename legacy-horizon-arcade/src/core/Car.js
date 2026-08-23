// Car.js — procedural sports-car model + arcade physics for an open-world racer.
// Three.js r0.169. PBR materials, bloom-friendly emissives, terrain-following,
// drift/handbrake, boost, and a lively suspension. Self-contained: builds its
// own mesh hierarchy under `this.group` and steps physics in `update()`.

import * as THREE from 'three';
import { clamp, lerpN, damp, TAU } from './noise.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tuning constants — arcade feel, Forza-Horizon-ish: responsive, drifty, stable.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_SPEED       = 82;    // m/s forward top speed (~295 km/h)
const REVERSE_SPEED   = 12;    // m/s reverse cap
const ENGINE_FORCE    = 26;    // base accel (m/s^2) at low speed
const BOOST_FORCE     = 20;    // extra accel while boosting
const BRAKE_FORCE     = 38;    // strong deceleration
const DRAG            = 0.0009;// quadratic aero drag (per m/s)^2
const ROLL_RESIST     = 1.6;   // linear rolling resistance
const STEER_MAX       = 0.62;  // max yaw rate (rad/s) at low speed — FH understeer curve
const STEER_SPEED_FALLOFF = 0.00030 // steering authority holds up much better at speed (was 0.00075 → terminal understeer)
const GRIP_NORMAL     = 13.0;  // lateral grip (1/s) — high so the car carves, doesn't slide (was 9.5 = icy)
const GRIP_DRIFT      = 1.5;   // lateral grip with handbrake — slideier initiation
const DRIFT_FRICTION  = 0.68;  // tangential drag reduction while drifting — carry momentum
const WHEEL_RADIUS    = 0.36;
const WHEEL_BASE      = 2.62;  // distance front<->rear axle
const TRACK_WIDTH     = 1.84;  // left<->right wheel center distance
const RIDE_HEIGHT     = 0.46;  // group.y offset above terrain at rest

// Palette — deep candy-red pearl paint with warm accent lighting. Pairs well
// with bloom and reads as premium automotive clearcoat under golden-hour IBL.
// (Replaces the flat azure: red pearl reads richer against warm sky lighting.)
const PAINT_COLOR     = 0x7a0a0a; // deep candy red pearl
const PAINT_COLOR_DK  = 0x3a0606; // darker shade for lower skirts
// Candy FLOP target hue: the deep burgundy the paint shifts toward at grazing
// angles (silhouette edges). Deliberately equals PAINT_COLOR_DK so the flop
// reads as the same dark tone already in the lower body — a coherent color
// story rather than a new mystery hue. sRGB hex; converted to linear in the
// shader via the renderer's sRGB→linear pipeline (diffuse uniform is linear).
const PAINT_FLOP_COLOR  = 0x3a0606;
// How strongly the flop pulls the diffuse toward burgundy at the very rim
// (NoV→0). ~0.55 keeps it premium/subtle: facing candy red, edges deepen
// noticeably but never look like a painted-on rim light.
const PAINT_FLOP_AMOUNT = 0.55;
const PAINT_METAL     = 0.85;
const PAINT_ROUGH     = 0.22;
const PAINT_CLEARCOAT = 0.8;     // glossy car-paint top coat
const PAINT_CC_ROUGH  = 0.03;    // tight clearcoat for sharp specular + bloom pick-up
const GLASS_COLOR     = 0x0a1018;
const HEAD_COLOR      = 0xfff4d6; // warm white
const TAIL_COLOR      = 0xff1a1a;
const BOOST_COLOR     = 0xff6a00; // taillight tint while boosting

// Default sun direction for the contact shadow — mirrors the Sky module's
// golden-hour sun (elevation 15°, azimuth 145°) so the blob's offset agrees
// with the real cast shadow even when the caller never calls setSunDirection().
// Kept here (not imported) so Car.js stays self-contained.
const SUN_ELEVATION_DEFAULT = 15 * Math.PI / 180;
const SUN_AZIMUTH_DEFAULT   = 145 * Math.PI / 180;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const _fwd   = new THREE.Vector3();
const _right = new THREE.Vector3();
const _vel   = new THREE.Vector3();
const _n     = new THREE.Vector3();
const _up    = new THREE.Vector3(0, 1, 0);
const _q     = new THREE.Quaternion();
const _m     = new THREE.Matrix4();
const _e     = new THREE.Euler();

/** Forward unit vector from heading: 0 rad → +Z. forward = (sin h, 0, cos h). */
function forwardOf(heading, out = _fwd) {
  return out.set(Math.sin(heading), 0, Math.cos(heading));
}
/** Right unit vector from heading (rotate forward -90° about +Y). */
function rightOf(heading, out = _right) {
  return out.set(Math.cos(heading), 0, -Math.sin(heading));
}

/**
 * Injects a subtle view-angle color FLOP into a MeshPhysicalMaterial's diffuse,
 * so the candy-red paint deepens toward a dark burgundy at grazing angles (the
 * silhouette) while staying true red on facing surfaces — the classic candy/
 * pearl "flop" that real car paint has and flat shaders lack.
 *
 * HOW: onBeforeCompile replaces the `#include <normal_fragment_begin>` chunk.
 * At that point both `normal` (view-space) and `vViewPosition` are available
 * and `diffuseColor` is already the final tinted base (post vertex-color), but
 * lighting has NOT yet accumulated — so darkening diffuseColor here correctly
 * feeds the whole BRDF. We compute NoV = dot(normal, viewDir); fresnel =
 * pow(1-NoV, p) gives 0 facing the camera and ~1 at the rim. We lerp
 * diffuseColor.rgb toward the linear-space flop color by `amount * fresnel`.
 *
 * Why NOT a rim-light additive term: an additive term would fight the clearcoat
 * and read as a cheap glow. Multiplying the diffuse base keeps the clearcoat's
 * sharp specular streak intact and just shifts the underlying pigment.
 *
 * Per-fragment cost is trivial (1 dot, 1 pow, 1 mix) and scoped to car paint
 * meshes only, so the 70 FPS budget is unaffected.
 */
function _applyPaintFlop(material, flopColorHex, amount) {
  // Convert the sRGB flop hex to the LINEAR working space the shader's
  // diffuseColor lives in (renderer outputColorSpace = sRGB; materials receive
  // linearized `diffuse`). Mismatching spaces would make the flop hue wrong.
  const flopLinear = new THREE.Color(flopColorHex)
    .convertSRGBToLinear();

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFlopColor = { value: flopLinear };
    shader.uniforms.uFlopAmount = { value: amount };

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <normal_fragment_begin>',
        /* glsl */ `
        #include <normal_fragment_begin>
        // --- Candy paint color FLOP (view-angle pigment shift) ---------------
        // NoV: 1 = facing camera, 0 = grazing/silhouette. viewDir points from
        // the fragment to the eye, so it's the normalized negation of the
        // view-space position.
        float flopNoV = clamp(dot(normal, normalize(-vViewPosition)), 0.0, 1.0);
        // Schlick-ish fresnel: stays near 0 for facing surfaces, rises sharply
        // only near the rim (power 2.5). Smoothstep widens the usable band so
        // the transition isn't a thin ring.
        float flopF = smoothstep(0.0, 1.0, pow(1.0 - flopNoV, 2.5));
        diffuseColor.rgb = mix(diffuseColor.rgb, uFlopColor, uFlopAmount * flopF);
        `,
      );

    // Hoist the uniforms above main() so they're visible to our injected code.
    shader.fragmentShader = 'uniform vec3 uFlopColor;\nuniform float uFlopAmount;\n' +
      shader.fragmentShader;
  };

  // Flag the material so a recompile picks up the uniforms if Three ever
  // rebuilds the program (defensive; cost is nil).
  material.customProgramCacheKey = () => 'paintFlop';
}

// ═════════════════════════════════════════════════════════════════════════════
// Car
// ═════════════════════════════════════════════════════════════════════════════
export class Car {
  /**
   * @param {{ terrain: object, envMap?: THREE.Texture }} opts
   * `terrain` must expose `getHeight(x,z)→number` and optionally `getNormal(x,z)`.
   */
  constructor({ terrain, envMap = null, paintColor = null, lights = true, bodyScale = 1 }) {
    this.terrain = terrain ?? null;
    this.road = null;
    this._colliderGrid = null;
    this._surfaceGrip = 1;
    this._surfaceSpeed = 1;
    this.surfaceName = 'ASPHALT';
    this._water = null;
    this.impact = 0; // 0..1 camera punch after wall/tree hits
    this.nitro = 1;  // 0..1 boost meter
    this._padBoost = 0; // temporary speed-zone impulse
    this.wrongWay = false;
    this.envMap  = envMap;
    this._lights = lights;
    // Optional paint override (used by AI rivals so the field reads as distinct
    // cars). Defaults to the hero candy-red. The dark skirt shade is derived
    // from whichever paint is chosen so it stays coherent.
    this._paintColor = Number.isFinite(paintColor) ? paintColor : PAINT_COLOR;
    this._bodyScale = Number.isFinite(bodyScale) ? bodyScale : 1;

    /** Root group. group.position IS the world position. Added to scene by caller. */
    this.group = new THREE.Group();
    this.group.name = 'Car';

    // ── dynamic state ────────────────────────────────────────────────────────
    this.speed     = 0;        // signed forward speed (m/s); negative = reverse
    this.slip      = 0;        // lateral slip magnitude (m/s) — for tire-squeal FX
    this.heading   = 0;        // yaw (rad), 0 = facing +Z
    this.boosting  = false;

    // velocity vector in world space; kept in sync with speed/heading for the
    // arcade model but allowed to drift sideways during handbrake slides.
    this._vx = 0;              // world-space velocity x
    this._vz = 0;              // world-space velocity z

    // wheel visuals
    this._wheelSpin   = 0;     // accumulated wheel rotation (rad)
    this._frontSteer  = 0;     // smoothed visual front-wheel yaw (rad)

    // body attitude (pitch/roll) — damped toward targets each frame
    this._bodyPitch = 0;
    this._bodyRoll  = 0;
    this._bobPhase  = Math.random() * TAU;

    // braking emissive intensity (damped)
    this._brakeGlow = 0;

    // last frame's forward speed sign, used for auto-countersteer assist
    this._lastForwardSign = 1;

    // ── jump / launch state (Danger Sign PR stunt) ───────────────────────────
    // When airborne the car ignores terrain-follow and integrates ballistically
    // (gravity), so a ramp launch actually flies. `lastJump` is stamped on land
    // for the race layer to score; it's a NEW object each landing so observers
    // can diff by reference.
    this._airborne = false;
    this._vy = 0;                 // vertical velocity (m/s)
    this._airTime = 0;            // seconds since launch
    this._airOrigin = new THREE.Vector2(); // (x, z) at launch, for jump distance
    this.lastJump = null;         // { distance, airtime } set on landing

    // ── build model ──────────────────────────────────────────────────────────
    this._build();
    if (this._bodyScale !== 1) {
      const s = this._bodyScale;
      this._body.scale.set(s, s * (0.92 + s * 0.08), s);
      // Slightly stretch wheel track/base visually for squat vs long variants.
      for (const w of this._wheels) {
        w.pivot.position.x *= s;
        w.pivot.position.z *= s;
      }
    }

    // Headlight spots — warm pools on the road ahead (FH-style golden hour).
    this._headSpots = [];
    if (this._lights) {
      for (const sx of [-0.62, 0.62]) {
        const spot = new THREE.SpotLight(0xfff0d0, 10, 42, 0.42, 0.55, 1.4);
        spot.position.set(sx, 0.58, 1.85);
        spot.target.position.set(sx * 0.4, 0.22, 12);
        this._body.add(spot);
        this._body.add(spot.target);
        this._headSpots.push(spot);
      }
    }

    // place at origin on terrain so it never spawns floating/falling.
    this.placeAt(new THREE.Vector3(0, 0, 0), 0);
  }

  setRoad(road) { this.road = road; }
  setColliderGrid(grid) { this._colliderGrid = grid; }
  setWater(water) { this._water = water; }

  /** Instant nitro refill + surge from a speed-zone pad. */
  giveNitro(amount = 0.35) {
    this.nitro = Math.min(1, this.nitro + amount);
    this._padBoost = Math.max(this._padBoost, 0.85);
  }

  /** Instant nitro refill from a speed zone pad (0..1). */
  giveNitro(amount = 0.35) {
    this.nitro = Math.min(1, this.nitro + amount);
    this._padBoost = Math.max(this._padBoost, 0.85);
  }

  /** World position of the car (alias of group.position). */
  get position() { return this.group.position; }

  /** Whether the car is currently airborne (ramp-launched). Read-only for FX/audio. */
  get airborne() { return this._airborne; }

  /** World-space velocity X (m/s) for camera / FX alignment. */
  get velocityX() { return this._vx; }

  /** World-space velocity Z (m/s) for camera / FX alignment. */
  get velocityZ() { return this._vz; }

  // ───────────────────────────────────────────────────────────────────────────
  // MODEL CONSTRUCTION
  // Builds a low, wide sports-car silhouette from shaped boxes + cylinders.
  // All meshes are parented to `this.group`; `group.rotation.y` carries heading.
  // Model local +Z is forward (matches heading convention).
  // ───────────────────────────────────────────────────────────────────────────
  _build() {
    const envMap = this.envMap;

    // Materials ──────────────────────────────────────────────────────────────
    // Body paint: MeshPhysicalMaterial with clearcoat so it gets the sharp
    // glossy highlight of real automotive paint. scene.environment (set by Sky)
    // provides the IBL; we just raise envMapIntensity so it reflects sky/sun.
    const paint = new THREE.MeshPhysicalMaterial({
      color: this._paintColor, metalness: PAINT_METAL, roughness: PAINT_ROUGH,
      envMap, envMapIntensity: 1.0,
      clearcoat: PAINT_CLEARCOAT, clearcoatRoughness: 0.22, // was 0.03 — mirrored the env sun proxy as a white blob
    });
    const paintDarkColor = new THREE.Color(this._paintColor).multiplyScalar(0.42).getHex();
    const paintDark = new THREE.MeshPhysicalMaterial({
      color: paintDarkColor, metalness: PAINT_METAL, roughness: 0.35, envMap,
      envMapIntensity: 1.0,
      clearcoat: PAINT_CLEARCOAT, clearcoatRoughness: 0.22,
    });
    // Candy FLOP injection — real candy/pearl paints shift hue toward a darker,
    // deeper tone at grazing angles (the "flop"). Without it the box-modeled
    // body reads as one flat saturated hue. We inject a fresnel term into the
    // MeshPhysicalMaterial that lerps diffuseColor toward a dark burgundy as the
    // view→normal angle grows (silhouette edges), keeping facing surfaces the
    // true candy red. SUBTLE by design: the clearcoat still carries the sharp
    // specular streak; this only modulates the diffuse base tint underneath.
    _applyPaintFlop(paint, PAINT_FLOP_COLOR, PAINT_FLOP_AMOUNT);
    _applyPaintFlop(paintDark, PAINT_FLOP_COLOR, PAINT_FLOP_AMOUNT * 0.7);
    const carbon = new THREE.MeshStandardMaterial({
      color: 0x14151a, metalness: 0.55, roughness: 0.45, envMap,
    });
    const rubber = new THREE.MeshStandardMaterial({
      color: 0x0c0c0f, metalness: 0.1, roughness: 0.85,
    });
    // Greenhouse glass: high envMapIntensity so the cabin mirrors the sky/sun
    // and reads as real automotive clearcoat glass rather than dark plastic.
    const glass = new THREE.MeshPhysicalMaterial({
      color: GLASS_COLOR, metalness: 0.0, roughness: 0.05,
      transmission: 0.0, transparent: true, opacity: 0.55,
      envMap, envMapIntensity: 2.0, clearcoat: 1.0, clearcoatRoughness: 0.05,
    });

    // Emissive lights — stored so physics can modulate intensity live.
    this._matHead = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: HEAD_COLOR, emissiveIntensity: 2.4,
    });
    this._matTail = new THREE.MeshStandardMaterial({
      color: 0x330000, emissive: TAIL_COLOR, emissiveIntensity: 1.8,
    });
    this._matBoost = new THREE.MeshStandardMaterial({
      color: 0x110000, emissive: BOOST_COLOR, emissiveIntensity: 0.0,
    });

    // A holder for all body/chassis parts so we can pitch/roll them together
    // (suspension articulation) independently of the heading on `group`.
    this._body = new THREE.Group();
    this._body.name = 'CarBody';
    this.group.add(this._body);

    // Wheels live under `group` (not `_body`) so they stay planted while the
    // body pitches/rolls — reads as independent suspension.
    this._wheels = [];

    // ── Main chassis: a single sculpted body (lofted side silhouette) — far
    //    smoother and less "boxy" than the old stacked-box _shapedChassis, and
    //    one mesh instead of several (fewer shadow passes). ───────────────────
    const chassis = this._sculptedBody(paint);
    this._body.add(chassis);

    // ── Greenhouse / cabin (narrower, set back, raked windshield) ───────────
    this._body.add(this._buildCabin(paint, glass, carbon));

    // ── Side skirts (lower, darker) widen the stance ────────────────────────
    const skirtGeo = new THREE.BoxGeometry(0.16, 0.18, 2.5);
    // round the skirt top edges slightly via bevel-like scaling
    for (const sx of [-1, 1]) {
      const skirt = new THREE.Mesh(skirtGeo, paintDark);
      skirt.position.set(sx * 0.92, 0.30, -0.05);
      skirt.castShadow = true;
      this._body.add(skirt);
    }

    // ── Front splitter (carbon lip) ─────────────────────────────────────────
    const splitter = new THREE.Mesh(
      new THREE.BoxGeometry(1.78, 0.05, 0.42), carbon);
    splitter.position.set(0, 0.27, 1.78);
    splitter.castShadow = true;
    this._body.add(splitter);

    // ── Rear diffuser ───────────────────────────────────────────────────────
    const diffuser = new THREE.Mesh(
      new THREE.BoxGeometry(1.74, 0.18, 0.40), carbon);
    diffuser.position.set(0, 0.30, -1.72);
    diffuser.castShadow = true;
    this._body.add(diffuser);

    // ── Rear spoiler / wing ─────────────────────────────────────────────────
    const wing = new THREE.Mesh(
      new THREE.BoxGeometry(1.70, 0.05, 0.34), carbon);
    wing.position.set(0, 0.92, -1.86);
    wing.castShadow = true;
    this._body.add(wing);
    // wing supports
    const supGeo = new THREE.BoxGeometry(0.06, 0.20, 0.10);
    for (const sx of [-0.55, 0.55]) {
      const sup = new THREE.Mesh(supGeo, carbon);
      sup.position.set(sx, 0.82, -1.86);
      sup.castShadow = true;
      this._body.add(sup);
    }

    // ── Mirrors ─────────────────────────────────────────────────────────────
    const mirrorGeo = new THREE.BoxGeometry(0.12, 0.10, 0.06);
    for (const sx of [-1, 1]) {
      const m = new THREE.Mesh(mirrorGeo, paint);
      m.position.set(sx * 0.82, 0.82, 0.62);
      m.castShadow = true;
      this._body.add(m);
      // mirror glass
      const mg = new THREE.Mesh(
        new THREE.BoxGeometry(0.02, 0.07, 0.04),
        new THREE.MeshStandardMaterial({ color: 0x202830, metalness: 1.0, roughness: 0.1, envMap }));
      mg.position.set(sx * 0.89, 0.82, 0.62);
      this._body.add(mg);
    }

    // ── Headlights (bright emissive, bloom-friendly) ────────────────────────
    const headGeo = new THREE.BoxGeometry(0.34, 0.10, 0.06);
    for (const sx of [-0.62, 0.62]) {
      const h = new THREE.Mesh(headGeo, this._matHead);
      h.position.set(sx, 0.60, 1.92);
      this._body.add(h);
    }

    // ── Taillight bar (full-width, emissive red; brightens under boost) ─────
    const tail = new THREE.Mesh(
      new THREE.BoxGeometry(1.55, 0.12, 0.05), this._matTail);
    tail.position.set(0, 0.62, -1.92);
    this._body.add(tail);
    // central boost strip (orange)
    const boostStrip = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.05, 0.04), this._matBoost);
    boostStrip.position.set(0, 0.50, -1.92);
    this._body.add(boostStrip);

    // ── Wheels (4): cylinder rotated so its axis is along X (left-right). ───
    // Front wheels are steered via the steerPivot's rotation.y. The spinner
    // (tire + rim + spokes) rotates about X for rolling. The brake disc and
    // caliper are parented to the NON-spinning steerPivot so they steer with
    // the front wheels but do NOT spin with the tire/rim — they stay static
    // while the wheel rotates around them (premium read up close).
    const wheelY = WHEEL_RADIUS;
    const fz =  WHEEL_BASE * 0.5;
    const rz = -WHEEL_BASE * 0.5;
    const wx = TRACK_WIDTH * 0.5;
    const wheelDefs = [
      { x: -wx, z: fz, front: true  },
      { x:  wx, z: fz, front: true  },
      { x: -wx, z: rz, front: false },
      { x:  wx, z: rz, front: false },
    ];

    // Brake materials — shared across wheels (created once).
    const brakeMat = new THREE.MeshStandardMaterial({
      color: 0x1a1c22, metalness: 1.0, roughness: 0.3, envMap, envMapIntensity: 1.2,
    });
    // Inner tire-wall material: darker rubber so the tire reads as a deep
    // barrel, not a flat ring.
    const rubberDark = new THREE.MeshStandardMaterial({
      color: 0x050507, metalness: 0.05, roughness: 0.95,
    });
    const caliperMat = new THREE.MeshStandardMaterial({
      color: 0xb81212, metalness: 0.6, roughness: 0.35, envMap, envMapIntensity: 1.0,
    });
    // Premium machined-alloy material for the open-spoke wheel face. Slightly
    // darker than the bright `rim` material and tuned (metalness ~0.9,
    // roughness ~0.25) so spokes catch light and read as cast alloy, with a
    // healthy envMap boost for reflections through the gaps.
    const alloyMat = new THREE.MeshStandardMaterial({
      color: 0x9a9aa4, metalness: 0.9, roughness: 0.25, envMap, envMapIntensity: 1.3,
    });

    for (const def of wheelDefs) {
      const steerPivot = new THREE.Group();           // yaw for steering
      steerPivot.position.set(def.x, wheelY, def.z);
      this.group.add(steerPivot);

      const spinner = new THREE.Group();              // spins about X
      steerPivot.add(spinner);

      // Outer tire (slightly wider so it wraps past the rim face).
      const tire = new THREE.Mesh(
        new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.30, 28),
        rubber);
      tire.rotation.z = Math.PI / 2;                  // axis → along X
      tire.castShadow = true;
      spinner.add(tire);

      // Inner tire barrel: slightly smaller radius, darker, recessed so the
      // tire wall has real depth (a hollow barrel, not a flat disc/ring).
      const innerTire = new THREE.Mesh(
        new THREE.CylinderGeometry(WHEEL_RADIUS * 0.92, WHEEL_RADIUS * 0.92, 0.28, 28, 1, true),
        rubberDark);
      innerTire.rotation.z = Math.PI / 2;
      innerTire.castShadow = false;
      spinner.add(innerTire);

      // ── Open-spoke wheel face. Replaces the old solid rim disc + box spokes
      //    (which occluded the brake rotor behind them). The new face is a
      //    hub + 6 THIN radial spokes with OPEN GAPS (~60° apart → ~37° gaps
      //    between spokes) so the dark brake rotor + colored caliper flash
      //    through the gaps as the spinner rotates. Spokes live on `spinner`
      //    so they spin with the tire; the brake rotor + caliper are on the
      //    NON-spinning steerPivot so they stay still while the wheel turns.
      //
      //    Wheel axis is along X (cylinders rotated z=π/2). Spokes lie in the
      //    Y-Z plane and are distributed by rotating about X. Each spoke is a
      //    slender box rooted at the hub and reaching to the tire's inner
      //    barrel, narrow enough (0.04 wide) to leave wide see-through gaps.
      const SPOKE_COUNT = 6;
      const spokeLen   = WHEEL_RADIUS * 0.92;          // hub edge → near tire barrel
      const spokeWidth = 0.05;                         // thin across its short axis
      const spokeThick = 0.06;                         // along the wheel axis (X)
      // Build the box centered on origin in the Y-Z plane: length spans Z so a
      // box of (X=thick, Y=width, Z=len) reaches from center outward along +Z.
      // We then rotate about X to distribute spokes radially.
      const spokeGeo = new THREE.BoxGeometry(spokeThick, spokeWidth, spokeLen);
      // Shift the box once so it spans from the hub outward along +Z before we
      // clone-and-rotate it per spoke. (Translating the shared geo inside the
      // loop would compound the shift; do it once here.)
      spokeGeo.translate(0, 0, spokeLen * 0.5);
      for (let i = 0; i < SPOKE_COUNT; i++) {
        const s = new THREE.Mesh(spokeGeo, alloyMat);
        s.rotation.x = (i / SPOKE_COUNT) * Math.PI;    // distribute about the wheel axis
        s.castShadow = true;
        spinner.add(s);
      }
      // Hub cylinder at the center ties the spokes together (axis along X).
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(WHEEL_RADIUS * 0.18, WHEEL_RADIUS * 0.18, 0.22, 18),
        alloyMat);
      hub.rotation.z = Math.PI / 2;
      hub.castShadow = true;
      spinner.add(hub);

      // ── Brake disc (rotor): metallic, ~0.62 * wheelRadius, dark gunmetal.
      //    Parented to steerPivot (NOT spinner) so it STEERS with front
      //    wheels but does NOT spin. Recessed ~0.05m INBOARD of the outer
      //    spoke face so it's visible THROUGH the spoke gaps but never clips
      //    them. (Spoke face sits near x = +spokeThick/2 ≈ +0.03; rotor at
      //    x = -0.05 sits clearly behind it from the chase-cam side.) ──────
      const brakeDisc = new THREE.Mesh(
        new THREE.CylinderGeometry(WHEEL_RADIUS * 0.62, WHEEL_RADIUS * 0.62, 0.04, 28),
        brakeMat);
      brakeDisc.rotation.z = Math.PI / 2;             // axis along X
      brakeDisc.position.x = -0.05;                   // inboard of the spokes
      steerPivot.add(brakeDisc);                      // non-spinning parent

      // ── Brake caliper: small colored box offset to one side of the rotor.
      //    Also non-spinning (on steerPivot) so it reads as a fixed clamp. ─
      const caliper = new THREE.Mesh(
        new THREE.BoxGeometry(0.10, 0.16, 0.14),
        caliperMat);
      // place at the rotor's outer edge, offset along the wheel's vertical
      // (local +Y of the pivot = "top" of the wheel) and pushed slightly out.
      caliper.position.set(0.02, WHEEL_RADIUS * 0.55, 0.0);
      steerPivot.add(caliper);                        // non-spinning parent

      this._wheels.push({ pivot: steerPivot, spinner, front: def.front });
    }

    // ── Soft radial contact shadow (cast-shadow read) ───────────────────────
    // A dark, soft, multiply-blended radial blob under the car. Uses a
    // radial-alpha texture (dark center → transparent edge). Offset ALONG the
    // sun's horizontal light-travel direction by a distance proportional to how
    // low the sun is (low sun → long shadow), and STRETCHED into an ellipse
    // along that same direction so it reads as a cast shadow rather than a
    // round AO puddle. Keep it soft, under the car, MultiplyBlended.
    const blobMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: this._makeShadowTexture(),
      transparent: true, opacity: 0.35,                 // lean on real shadows
      depthWrite: false, blending: THREE.MultiplyBlending,
    });
    const blob = new THREE.Mesh(new THREE.CircleGeometry(2.2, 48), blobMat);
    blob.rotation.x = -Math.PI / 2;                    // lay flat (local XY → XZ)
    blob.position.y = 0.02;                            // just above ground
    // Wrap the blob in a yaw group so we can (a) push its center along the
    // sun-travel direction and (b) stretch it into an ellipse along that same
    // direction WITHOUT fighting the flat-lay Euler rotation. The yaw group
    // carries rotation.y (shadow direction) and scale.x (stretch); the blob
    // inside stays uniformly scaled and flat.
    const shadowGroup = new THREE.Group();
    shadowGroup.name = 'CarShadow';
    shadowGroup.add(blob);
    this.group.add(shadowGroup);
    this._shadowBlob = blob;
    this._shadowGroup = shadowGroup;
    // Sun direction (normalized, pointing FROM sun TO scene). The caller can
    // override via setSunDirection(); if not wired, we default to the SAME
    // golden-hour direction the Sky module uses (elevation 15°, azimuth 145°)
    // so the contact-shadow offset lines up with the real cast shadow even
    // without an explicit per-frame feed. sky.sunDir points TOWARD the sun, so
    // our light-travel vector is its negation.
    this._sunDir = new THREE.Vector3(
      -Math.sin(SUN_AZIMUTH_DEFAULT) * Math.cos(SUN_ELEVATION_DEFAULT),
      -Math.sin(SUN_ELEVATION_DEFAULT),
      -Math.cos(SUN_AZIMUTH_DEFAULT) * Math.cos(SUN_ELEVATION_DEFAULT),
    ).normalize();
  }

  /**
   * Procedurally builds a radial gradient texture for the contact shadow. The
   * RGB channel is BLACK at the center (full darkening) fading to WHITE at the
   * edge (no effect). Used as `map` on a white, MultiplyBlended material so the
   * blob multiplies the ground toward black at its core and leaves the ground
   * untouched at the rim — a soft ambient-occlusion puddle, not a hard disc.
   */
  _makeShadowTexture() {
    const size = 128;
    const data = new Uint8Array(size * size * 4);
    const cx = size * 0.5, cy = size * 0.5;
    const rMax = size * 0.5;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d = Math.sqrt(dx * dx + dy * dy) / rMax;   // 0 center .. 1 edge
        // Darken factor: 1 at center → 0 at edge. Quadratic-ish for a soft tail.
        let darken = d >= 1 ? 0 : Math.pow(1 - d, 1.6);
        darken = Math.max(0, Math.min(1, darken));
        // MultiplyBlending does dst * src; src = color * map.rgb. We want the
        // center to multiply toward 0 (black) and the edge to multiply by 1
        // (unchanged), so store (1 - darken) in RGB. Alpha is kept opaque since
        // the texture itself encodes the soft edge.
        const v = Math.round((1 - darken) * 255);
        const idx = (y * size + x) * 4;
        data[idx] = v; data[idx + 1] = v; data[idx + 2] = v;
        data[idx + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Set the sun direction so the contact shadow can offset opposite to it,
   * implying a real cast shadow. Vector is normalized internally; the Y
   * (vertical) component controls how far the blob is pushed horizontally.
   * @param {THREE.Vector3} dir direction the light travels (from sun toward scene)
   */
  setSunDirection(dir) {
    if (!dir || typeof dir.clone !== 'function') return;
    const v = dir.clone().normalize();
    if (isFinite(v.x) && isFinite(v.y) && isFinite(v.z)) this._sunDir.copy(v);
  }

  /**
   * Launch the car upward (Danger Sign ramp). Imparts vertical velocity and
   * switches the car into ballistic flight until it lands. No-op if already
   * airborne or given a non-positive impulse. Horizontal speed is unaffected,
   * so the player can still steer in the air.
   * @param {number} vUp upward velocity (m/s)
   */
  launch(vUp) {
    if (this._airborne || !(vUp > 0)) return;
    this._airborne = true;
    this._vy = vUp;
    this._airTime = 0;
    this._airOrigin.set(this.group.position.x, this.group.position.z);
  }

  /**
   * Builds the main lower+upper body as shaped geometry for a believable
   * silhouette: low nose, rising waistline, muscular rear. Uses a rounded box
   * for the lower mass plus a tapered hood and rear haunch.
   */
  _shapedChassis(paint, paintDark) {
    const g = new THREE.Group();

    // Lower wide body (the "tub").
    const tubGeo = this._roundedBox(1.86, 0.55, 4.10, 0.12);
    const tub = new THREE.Mesh(tubGeo, paint);
    tub.position.y = 0.52;
    tub.castShadow = true;
    tub.receiveShadow = true;
    g.add(tub);

    // Upper shoulders (slightly narrower, gives the greenhouse a base).
    const shoulderGeo = this._roundedBox(1.66, 0.30, 3.90, 0.14);
    const shoulder = new THREE.Mesh(shoulderGeo, paint);
    shoulder.position.y = 0.78;
    shoulder.castShadow = true;
    g.add(shoulder);

    // Hood — sloped down toward nose. A box tilted about X.
    const hoodGeo = new THREE.BoxGeometry(1.62, 0.10, 1.30);
    const hood = new THREE.Mesh(hoodGeo, paint);
    hood.position.set(0, 0.86, 1.05);
    hood.rotation.x = -0.06;                          // nose-down rake
    hood.castShadow = true;
    g.add(hood);

    // Rear deck — higher than hood (fastback feel).
    const deckGeo = new THREE.BoxGeometry(1.62, 0.12, 1.10);
    const deck = new THREE.Mesh(deckGeo, paint);
    deck.position.set(0, 0.90, -1.05);
    deck.rotation.x = 0.05;
    deck.castShadow = true;
    g.add(deck);

    // Front bumper splitter lip accent (darker).
    const lipGeo = this._roundedBox(1.80, 0.18, 0.30, 0.06);
    const lip = new THREE.Mesh(lipGeo, paintDark);
    lip.position.set(0, 0.36, 1.95);
    g.add(lip);

    return g;
  }

  /**
   * Sculpted body: loft the car's side silhouette (low nose → hood → beltline →
   * rear deck → tail) as a 2D THREE.Shape, extrude it across the width with a
   * bevel (rounded flanks), rotate it into car space (length→Z, height→Y,
   * width→X), then TAPER the width toward both ends so the nose and tail narrow
   * and the midsection reads as muscular haunches. One smooth mesh — replaces
   * the old stacked-box _shapedChassis for a far less "toy" silhouette.
   *
   * Shape coords:  shapeX = length (front at +x),  shapeY = height.
   * Extrude depth  = width, centered then rotated: worldX=width, worldY=height,
   * worldZ=length.
   */
  _sculptedBody(paint) {
    const LEN_FRONT = 2.20, LEN_REAR = -2.20;
    // Side silhouette (front → along beltline → rear → under → front).
    const profile = [
      [ LEN_FRONT, 0.04], // nose, front bottom
      [ LEN_FRONT, 0.46], // nose, front top
      [  1.55,     0.66], // hood front lip
      [  0.55,     0.76], // hood crown
      [ -0.25,     0.98], // cowl / windshield base (beltline peak)
      [ -1.15,     0.98], // beltline rear
      [ -1.95,     0.82], // rear deck
      [ LEN_REAR,  0.62], // tail top
      [ LEN_REAR,  0.04], // tail bottom
    ];
    const shape = new THREE.Shape();
    shape.moveTo(profile[0][0], profile[0][1]);
    for (let i = 1; i < profile.length; i++) shape.lineTo(profile[i][0], profile[i][1]);
    shape.closePath();

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: 1.90,                 // car width
      bevelEnabled: true,
      bevelThickness: 0.09,
      bevelSize: 0.13,
      bevelSegments: 4,
      steps: 1,
    });
    // Center the extrude (width) on the origin, then rotate into car space.
    geo.translate(0, 0, -0.95);    // width now [-0.95, 0.95]
    geo.rotateY(Math.PI / 2);      // shapeX(length)→worldZ, extrudeZ(width)→worldX, height→Y

    // TAPER width toward both ends (narrow nose/tail, full midsection haunches).
    const pos = geo.attributes.position;
    const halfLen = (LEN_FRONT - LEN_REAR) * 0.5;
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);              // length axis
      const t = Math.min(Math.abs(z) / halfLen, 1);   // 0 center → 1 ends
      const narrow = 1 - 0.26 * (t * t);              // gentle quadratic taper
      pos.setX(i, pos.getX(i) * narrow);
    }
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, paint);
    mesh.position.y = 0.36;          // sit so the floor ~ matches ride height
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /**
   * Cabin/greenhouse: narrower than the body, raked windshield, side glass,
   * and a carbon roof. Uses shaped boxes for the greenhouse mass + thin glass
   * panes angled to catch reflections.
   */
  _buildCabin(paint, glass, carbon) {
    const g = new THREE.Group();

    // Greenhouse core (tapered trapezoid effect via scaled box + rake).
    const coreGeo = this._roundedBox(1.30, 0.46, 1.90, 0.10);
    const core = new THREE.Mesh(coreGeo, paint);
    core.position.set(0, 1.08, -0.10);
    core.castShadow = true;
    g.add(core);

    // Roof (carbon, slightly smaller on top).
    const roof = new THREE.Mesh(
      this._roundedBox(1.12, 0.10, 1.40, 0.08), carbon);
    roof.position.set(0, 1.34, -0.15);
    roof.castShadow = true;
    g.add(roof);

    // Windshield — raked pane facing forward.
    const wsGeo = new THREE.PlaneGeometry(1.10, 0.92);
    const ws = new THREE.Mesh(wsGeo, glass);
    ws.position.set(0, 1.12, 0.86);
    ws.rotation.x = -1.12;                            // leans back
    g.add(ws);

    // Rear window.
    const rw = new THREE.Mesh(new THREE.PlaneGeometry(1.10, 0.80), glass);
    rw.position.set(0, 1.16, -1.04);
    rw.rotation.x = 1.18;
    g.add(rw);

    // Side windows.
    for (const sx of [-1, 1]) {
      const sw = new THREE.Mesh(new THREE.PlaneGeometry(1.20, 0.34), glass);
      sw.position.set(sx * 0.66, 1.20, -0.10);
      sw.rotation.y = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
      g.add(sw);
    }

    return g;
  }

  /**
   * Builds a "rounded box" by chamfering a BoxGeometry: subdivides and pushes
   * corner vertices inward by `radius`. Cheaper than a true RoundedBoxGeometry
   * and reads well under PBR + bloom.
   */
  _roundedBox(w, h, d, radius) {
    const geo = new THREE.BoxGeometry(w, h, d, 4, 4, 4);
    const pos = geo.attributes.position;
    const hw = w * 0.5, hh = h * 0.5, hd = d * 0.5;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      // for each axis, pull the point toward the face center near corners
      const ex = hw - Math.abs(v.x);
      const ey = hh - Math.abs(v.y);
      const ez = hd - Math.abs(v.z);
      const minEdge = Math.min(ex, ey, ez);
      if (minEdge < radius) {
        const k = minEdge / radius;                   // 0..1 near corner
        const pull = (1 - k) * radius * 0.6;
        v.x -= Math.sign(v.x) * pull;
        v.y -= Math.sign(v.y) * pull;
        v.z -= Math.sign(v.z) * pull;
      }
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    return geo;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Teleport the car: sets position/heading, zeroes velocity, snaps to terrain.
   * @param {THREE.Vector3} position3 world x,z used (y recomputed from terrain)
   * @param {number} heading yaw in radians
   */
  placeAt(position3, heading = 0) {
    const x = position3.x, z = position3.z;
    const terrain = this.terrain;
    const y = terrain ? (terrain.getHeight(x, z) || 0) : position3.y;
    this.group.position.set(x, y, z);
    this.heading = heading;
    this.group.rotation.set(0, heading, 0);
    this.speed = 0;
    this._vx = 0; this._vz = 0;
    this._wheelSpin = 0;
    this._frontSteer = 0;
    this._bodyPitch = 0; this._bodyRoll = 0;
    this._airborne = false; this._vy = 0; this._airTime = 0; this.lastJump = null;
    this._snapToTerrain(true);
  }

  /**
   * Step the arcade physics. Caller runs this at a fixed 60 Hz (dt ≤ 1/60).
   * @param {number} dt seconds
   * @param {{throttle,brake,steer,handbrake,boost,reset,camera}} input
   * @param {object} terrain same as ctor (optional override)
   */
  update(dt, input, terrain) {
    const ter = terrain ?? this.terrain ?? null;
    dt = Math.min(Math.max(dt, 1 / 1000), 1 / 30);    // clamp: never NaN, never huge

    // ── RESET ──────────────────────────────────────────────────────────────
    if (input.reset) {
      this._doReset(ter);
    }

    // ── FORWARD DYNAMICS ───────────────────────────────────────────────────
    const throttle = clamp(input.throttle ?? 0, 0, 1);
    const brake    = clamp(input.brake ?? 0, 0, 1);
    const steer    = clamp(input.steer ?? 0, -1, 1);
    const handbrake = !!input.handbrake;
    const wantBoost = !!input.boost && throttle > 0.01 && this.nitro > 0.02;
    const boost = wantBoost;
    this.boosting = boost;

    // Engine: accel falls off as we approach top speed (classic curve).
    this._updateSurfaceGrip();
    const surfGrip = this._surfaceGrip;
    const surfSpeed = this._surfaceSpeed;
    let accel = 0;
    if (throttle > 0) {
      const topFactor = clamp(1 - Math.abs(this.speed) / (MAX_SPEED * surfSpeed), 0, 1);
      const curve = Math.pow(topFactor, 0.6);          // keeps low-end punchy
      accel += ENGINE_FORCE * throttle * curve * surfGrip;
      if (boost) {
        accel += BOOST_FORCE * curve * surfGrip;
        this.nitro = Math.max(0, this.nitro - dt * 0.28); // ~3.5s full dump
      }
    }
    // Passive recharge when not boosting; pads fill faster.
    if (!boost) this.nitro = Math.min(1, this.nitro + dt * 0.12);
    if (this._padBoost > 0) {
      accel += 38 * this._padBoost;
      this._padBoost = Math.max(0, this._padBoost - dt * 2.2);
    }

    // Braking / reverse.
    if (brake > 0) {
      if (this.speed > 0.2) {
        accel -= BRAKE_FORCE * brake;                  // strong brake
      } else {
        // reverse: accelerate backward up to REVERSE_SPEED.
        const revFactor = clamp(1 - (-this.speed) / REVERSE_SPEED, 0, 1);
        accel -= ENGINE_FORCE * 0.55 * brake * revFactor;
      }
    }
    this._brakeGlow = damp(this._brakeGlow, brake > 0 ? 1 : 0, 12, dt);

    // Drag + rolling resistance (always opposing motion).
    const s = this.speed;
    accel -= DRAG * s * Math.abs(s);
    accel -= (s > 0 ? 1 : (s < 0 ? -1 : 0)) * ROLL_RESIST * (handbrake ? 0.2 : 1) * (1 + (1 - surfGrip) * 1.8);

    // Integrate forward speed, clamp to [reverse, top] + boost headroom.
    this.speed += accel * dt;
    const topCap = (boost ? MAX_SPEED + 6 : MAX_SPEED) * surfSpeed;
    this.speed = clamp(this.speed, -REVERSE_SPEED, topCap);

    // ── STEERING ───────────────────────────────────────────────────────────
    // Effective steering reduces with speed so it's not twitchy at high speed.
    // Positive steer = turn left (per Controls spec).
    //
    // Heading sign check: forward = (sin h, 0, cos h). Increasing h sweeps the
    // nose from +Z toward +X. With the chase cam looking along +Z and up=+Y,
    // the camera's screen-right resolves to world −X — so +X is screen-LEFT.
    // Therefore increasing heading (nose → +X) IS a left turn: a LEFT press
    // (steer=+1) must INCREASE heading → yawRate = +steer. Front wheels mirror
    // this: left → steerPivot +rotation.y (nose of wheel → +X).
    const speedFactor = clamp(1 / (1 + this.speed * this.speed * STEER_SPEED_FALLOFF), 0.18, 1);
    const yawRate = steer * STEER_MAX * speedFactor;
    // When reversing, invert steering so it feels natural.
    const steerSign = this.speed >= -0.05 ? 1 : -1;
    this.heading += yawRate * steerSign * dt;

    // Visual front-wheel yaw (smoothed, clamped to ~32°). Left → wheels point +X.
    const targetSteerYaw = clamp(steer * 0.56, -0.56, 0.56) * steerSign;
    this._frontSteer = damp(this._frontSteer, targetSteerYaw, 14, dt);

    // ── VELOCITY VECTOR with lateral slip model ────────────────────────────
    // Desired velocity = forward * speed. Actual world velocity relaxes toward
    // that with a lateral grip rate; handbrake lowers grip → drift.
    forwardOf(this.heading, _fwd);
    rightOf(this.heading, _right);

    const desiredVx = _fwd.x * this.speed;
    const desiredVz = _fwd.z * this.speed;

    // Decompose current velocity into forward & lateral components.
    const curFwd  = this._vx * _fwd.x  + this._vz * _fwd.z;
    const curLat  = this._vx * _right.x + this._vz * _right.z;

    // Forward component tracks `speed` (with a little tangential slip in drift).
    const gripFwd = handbrake ? (1 - DRIFT_FRICTION * dt) : 1;
    const newFwd  = lerpN(curFwd, this.speed, handbrake ? 4 * dt : 18 * dt) * gripFwd;

    // Lateral grip softens at high speed (understeer) and shifts with load transfer.
    const gripScale = clamp(1 - Math.abs(this.speed) * 0.0038, 0.52, 1);
    const brakeLoad = clamp(input.brake ?? 0, 0, 1);
    const throttleLoad = clamp(input.throttle ?? 0, 0, 1);
    const latGripMod = 1 + brakeLoad * 0.35 - throttleLoad * 0.18;
    const grip = (handbrake ? GRIP_DRIFT : GRIP_NORMAL) * gripScale * latGripMod * surfGrip;
    const newLat = curLat * Math.exp(-grip * dt);

    this._vx = _fwd.x * newFwd + _right.x * newLat;
    this._vz = _fwd.z * newFwd + _right.z * newLat;
    // Expose lateral slip magnitude (m/s) for tire-squeal audio / FX. This is
    // the sideways component of velocity — high when drifting or sliding.
    this.slip = Math.abs(newLat);

    // Auto-countersteer assist: if drifting hard, nudge heading toward velocity
    // direction so the car recovers instead of spinning out. Gentle & optional.
    if (handbrake && Math.abs(this.speed) > 6) {
      const velAngle = Math.atan2(this._vx, this._vz);
      let diff = velAngle - this.heading;
      while (diff > Math.PI) diff -= TAU;
      while (diff < -Math.PI) diff += TAU;
      // only assist when the slip angle is moderate (prevents fighting the player)
      if (Math.abs(diff) > 0.15 && Math.abs(diff) < 0.7) {
        this.heading += diff * 0.6 * dt;
      }
    }

    // ── INTEGRATE POSITION ─────────────────────────────────────────────────
    let px = this.group.position.x + this._vx * dt;
    let pz = this.group.position.z + this._vz * dt;
    const col = this._resolveColliders(px, pz);
    px = col.x;
    pz = col.z;

    // Soft corridor: if you slip past the rails, shove back toward the asphalt.
    if (this.road && !this._airborne) {
      const dist = this.road.distanceToCenterline(px, pz);
      if (dist > 8.2) {
        const excess = dist - 8.0;
        this.speed *= Math.exp(-2.5 * excess * dt);
        const cl = this.road.centerline?.();
        if (cl?.length) {
          let best = cl[0], bd = Infinity;
          for (let i = 0; i < cl.length; i += 8) {
            const dx = px - cl[i].x, dz = pz - cl[i].z;
            const d2 = dx * dx + dz * dz;
            if (d2 < bd) { bd = d2; best = cl[i]; }
          }
          const t = Math.min(0.45, excess * 0.08);
          px += (best.x - px) * t;
          pz += (best.z - pz) * t;
        }
      }
    }

    this.group.position.x = px;
    this.group.position.z = pz;

    // Soft world collision — steep slopes and map edge (FH off-road resistance).
    if (ter && !this._airborne) {
      if (typeof ter.getNormal === 'function') {
        try {
          const n = ter.getNormal(px, pz);
          if (n && n.y < 0.52) {
            this.speed *= Math.exp(-10 * dt);
            this._vx *= 0.9;
            this._vz *= 0.9;
          }
        } catch { /* keep default up */ }
      }
      const bound = (ter.size ?? 4000) * 0.48;
      if (Math.abs(px) > bound || Math.abs(pz) > bound) {
        this.speed *= 0.82;
        this._vx *= -0.2;
        this._vz *= -0.2;
      }
    }

    // ── TERRAIN FOLLOW (or BALLISTIC FLIGHT) + ATTITUDE ─────────────────────
    if (this._airborne) {
      // Ballistic: integrate vertical under arcade gravity, keep horizontal
      // motion (already integrated above from _vx/_vz). Land when we meet ground.
      this._airTime += dt;
      this._vy -= 9.5 * dt;
      this.group.position.y += this._vy * dt;
      const gy = (ter ? (ter.getHeight(px, pz) || 0) : 0) + RIDE_HEIGHT;
      if (this.group.position.y <= gy) {
        this.group.position.y = gy;
        const jx = this.group.position.x - this._airOrigin.x;
        const jz = this.group.position.z - this._airOrigin.y; // Vector2 .y == z
        this.lastJump = { distance: Math.hypot(jx, jz), airtime: this._airTime };
        this._airborne = false; this._vy = 0; this._airTime = 0;
        this._snapToTerrain(true, ter);
      } else {
        // Heading-only orientation with a gentle pitch from vertical velocity
        // (nose up rising, dipping as it falls). Slerp so it eases in.
        const pitch = clamp(this._vy * 0.018, -0.22, 0.22);
        _e.set(pitch, this.heading, 0, 'YXZ');
        _q.setFromEuler(_e);
        this.group.quaternion.slerp(_q, 1 - Math.exp(-12 * dt));
      }
    } else {
      this._snapToTerrain(false, ter, dt);
    }

    // Body pitch/roll: dive under braking, squat under accel, roll into turns.
    const longG = clamp(accel / 30, -1, 1);           // -1 heavy brake .. +1 accel
    const latG  = clamp(yawRate * this.speed * 0.03, -1, 1);
    const targetPitch = -longG * 0.06;                // nose down under accel?
    // (note: squat = rear down = nose up under accel → positive pitch)
    const targetPitchCorrect = longG * 0.05;
    const targetRoll  = -latG * 0.10;
    this._bodyPitch = damp(this._bodyPitch, targetPitchCorrect, 8, dt);
    this._bodyRoll  = damp(this._bodyRoll,  targetRoll, 10, dt);

    // Tiny suspension bob — keeps the car feeling alive at rest and in motion.
    this._bobPhase += dt * (4 + Math.abs(this.speed) * 0.25);
    const bob = Math.sin(this._bobPhase) * 0.012 * (0.4 + clamp(Math.abs(this.speed) / 20, 0, 1));

    // Apply body attitude (pitch/roll) + bob to the _body subgroup only.
    this._body.rotation.x = this._bodyPitch;
    this._body.rotation.z = this._bodyRoll;
    this._body.position.y = bob;

    // ── WHEELS: spin + steer visuals ───────────────────────────────────────
    // Spin proportional to speed / wheel radius. Sign so wheels roll forward.
    this._wheelSpin -= (this.speed / WHEEL_RADIUS) * dt;
    for (const w of this._wheels) {
      w.spinner.rotation.x = this._wheelSpin;
      if (w.front) w.pivot.rotation.y = this._frontSteer;
    }

    // ── LIGHTS ─────────────────────────────────────────────────────────────
    // Taillights brighten when braking; boost strip glows orange when boosting.
    this._matTail.emissiveIntensity = 1.4 + this._brakeGlow * 3.0;
    this._matBoost.emissiveIntensity = boost ? 4.5 : 0.0;

    // Contact shadow: offset ALONG the sun's horizontal light-travel direction
    // by a distance scaled to the ACTUAL sun elevation, so the blob implies the
    // real cast shadow length. Low sun (small elevation) → long push; high sun
    // → centered. The blob is also STRETCHED into an ellipse along the same
    // horizontal direction so it reads as a cast shadow, not a round disc.
    if (this._shadowBlob) {
      // Sun direction is stored in world space (FROM sun TO scene, normalized).
      const sd = this._sunDir;
      const horizLen = Math.hypot(sd.x, sd.z);
      // Elevation angle FROM the horizon. The sunDir points downward (into the
      // scene), so its Y is negative when the sun is above the horizon. Use
      // atan2(|xz|, |y|): y-dominant (overhead) → ~0, xz-dominant (horizon) → π/2.
      const yAbs = Math.abs(sd.y);
      // elevation angle 0..π/2 (horizon..overhead-inverted). We want the ANGLE
      // the light makes with vertical: low sun = large angle = long shadow.
      const elevFromVertical = Math.atan2(horizLen, Math.max(yAbs, 1e-4));
      // Car body height (~1.0m up to the roofline). pushMag ∝ tan(angle).
      const carHeight = 1.0;
      const pushMag = clamp(Math.tan(elevFromVertical) * carHeight, 0, 3.5);
      // Stretch: blob elongated along the shadow direction. Mild stretch that
      // grows with how oblique the light is (low sun → more elongation).
      const stretch = 1.0 + clamp(elevFromVertical / (Math.PI / 2), 0, 1) * 1.8;
      // Rotate sun XZ into the car's local space (group carries heading on Y).
      const sinH = Math.sin(this.heading), cosH = Math.cos(this.heading);
      const lx = ( cosH * sd.x + sinH * sd.z);
      const lz = (-sinH * sd.x + cosH * sd.z);
      if (horizLen > 0.0001) {
        const nx = lx / horizLen, nz = lz / horizLen;   // unit horizontal shadow dir (local)
        // Push the blob's CENTER along the sun-travel direction (on the yaw
        // group, so the blob mesh itself keeps its centered texture origin).
        this._shadowGroup.position.x = nx * pushMag;
        this._shadowGroup.position.z = nz * pushMag;
        // Stretch into an ellipse along the shadow direction + aim the long
        // axis. The yaw group's local +X (under rotation.y=yaw) maps to
        // (cos yaw, 0, -sin yaw); equating to (nx, nz) gives yaw=atan2(-nz,nx).
        this._shadowGroup.rotation.y = Math.atan2(-nz, nx);
        this._shadowGroup.scale.set(stretch, 1.0, 1.0);
      } else {
        this._shadowGroup.position.x = 0;
        this._shadowGroup.position.z = 0;
        this._shadowGroup.rotation.y = 0;
        this._shadowGroup.scale.set(1.0, 1.0, 1.0);
      }
      this._shadowBlob.material.opacity = 0.35 - clamp(Math.abs(this.speed) / 120, 0, 0.15);
    }

    // Guard against NaN propagation.
    if (!isFinite(this.group.position.x) || !isFinite(this.group.position.z) ||
        !isFinite(this.speed) || !isFinite(this.heading)) {
      this._doReset(ter);
    }

    // Remember forward sign for next frame's steering feel.
    this._lastForwardSign = this.speed >= 0 ? 1 : -1;
  }

  _updateSurfaceGrip() {
    const x = this.group.position.x;
    const z = this.group.position.z;
    if (this._water && this._water.contains(x, z)) {
      this._surfaceGrip = 0.28;
      this._surfaceSpeed = 0.35;
      this.surfaceName = 'WATER';
      return;
    }
    const rd = this.road;
    if (!rd) {
      this._surfaceGrip = 1;
      this._surfaceSpeed = 1;
      this.surfaceName = 'DIRT';
      return;
    }
    const dist = rd.distanceToCenterline(x, z);
    if (dist < 7.5) {
      this._surfaceGrip = 1;
      this._surfaceSpeed = 1;
      this.surfaceName = 'ASPHALT';
    } else if (dist < 14) {
      this._surfaceGrip = 0.82;
      this._surfaceSpeed = 0.88;
      this.surfaceName = 'SHOULDER';
    } else if (dist < 28) {
      this._surfaceGrip = 0.65;
      this._surfaceSpeed = 0.72;
      this.surfaceName = 'GRASS';
    } else {
      this._surfaceGrip = 0.5;
      this._surfaceSpeed = 0.58;
      this.surfaceName = 'DIRT';
    }
    this._updateWrongWay();
  }

  _updateWrongWay() {
    this.wrongWay = false;
    const rd = this.road;
    if (!rd || Math.abs(this.speed) < 6) return;
    const near = rd.sampleNearest(this.group.position.x, this.group.position.z);
    if (!near || near.dist2 > 400) return;
    let diff = this.heading - near.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    // Facing opposite the road direction while moving forward.
    this.wrongWay = Math.abs(diff) > 2.0 && this.speed > 0;
  }

  _resolveColliders(px, pz) {
    const grid = this._colliderGrid;
    if (!grid) return { x: px, z: pz };
    const CELL = 24;
    const cx = Math.floor(px / CELL);
    const cz = Math.floor(pz / CELL);
    const CAR_R = 1.55;
    let hit = 0;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const list = grid.get(`${cx + ox},${cz + oz}`);
        if (!list) continue;
        for (const c of list) {
          const dx = px - c.x;
          const dz = pz - c.z;
          const minD = CAR_R + c.r;
          const d2 = dx * dx + dz * dz;
          if (d2 >= minD * minD || d2 < 1e-4) continue;
          const d = Math.sqrt(d2);
          const push = (minD - d) * 1.15;
          px += (dx / d) * push;
          pz += (dz / d) * push;
          const impact = Math.min(1, Math.abs(this.speed) / 40 + push * 0.8);
          hit = Math.max(hit, impact);
          this.speed *= 0.42;
          this._vx *= 0.3;
          this._vz *= 0.3;
        }
      }
    }
    if (hit > 0.12) this.impact = Math.max(this.impact, hit);
    return { x: px, z: pz };
  }

  /**
   * Snap car onto terrain height and softly align group orientation to the
   * terrain normal (so it pitches/rolls with the ground) combined with heading.
   * @param {boolean} snap if true, hard-set; else damp.
   * @param {object} terrain
   */
  _snapToTerrain(snap = false, terrain = this.terrain, dt = 1 / 60) {
    const ter = terrain ?? this.terrain ?? null;
    const x = this.group.position.x, z = this.group.position.z;
    const y = ter ? (ter.getHeight(x, z) || 0) : 0;
    let targetY = y + RIDE_HEIGHT;
    const rd = this.road;
    if (rd) {
      const dist = rd.distanceToCenterline(x, z);
      if (dist < 12) {
        const near = rd.sampleNearest(x, z);
        if (near) targetY = Math.max(targetY, near.y + RIDE_HEIGHT - 0.02);
      }
    }

    if (snap) {
      this.group.position.y = targetY;
    } else {
      this.group.position.y = damp(this.group.position.y, targetY, 18, dt);
    }

    let nx = 0, ny = 1, nz = 0;
    if (ter && typeof ter.getNormal === 'function') {
      try {
        // Terrain.getNormal RETURNS a Vector3 — it does not write into an out-arg.
        const n = ter.getNormal(x, z);
        if (n && isFinite(n.x) && isFinite(n.y) && isFinite(n.z)) {
          nx = n.x; ny = n.y; nz = n.z;
          const len = Math.hypot(nx, ny, nz);
          if (len > 0.0001) { nx /= len; ny /= len; nz /= len; }
          else { nx = 0; ny = 1; nz = 0; }
        }
      } catch { /* keep default up */ }
    }

    const fh = Math.sin(this.heading), fc = Math.cos(this.heading);
    const fdn = fh * nx + fc * nz;
    let TFx = fh - nx * fdn;
    let TFy = 0 - ny * fdn;
    let TFz = fc - nz * fdn;
    let tlen = Math.hypot(TFx, TFy, TFz);
    if (!(tlen > 0.0001 && isFinite(tlen))) { TFx = fh; TFy = 0; TFz = fc; tlen = 1; }
    TFx /= tlen; TFy /= tlen; TFz /= tlen;

    const Rx = ny * TFz - nz * TFy;
    const Ry = nz * TFx - nx * TFz;
    const Rz = nx * TFy - ny * TFx;

    _m.makeBasis(
      new THREE.Vector3(Rx, Ry, Rz),
      new THREE.Vector3(nx, ny, nz),
      new THREE.Vector3(TFx, TFy, TFz),
    );
    _q.setFromRotationMatrix(_m);

    if (snap) {
      this.group.quaternion.copy(_q);
    } else {
      this.group.quaternion.slerp(_q, 1 - Math.exp(-14 * dt));
    }
  }

  /** Re-spawn: rotate 180° from current heading onto flat ground, zero speed. */
  _doReset(terrain) {
    const p = this.group.position;
    // raise slightly and re-place at current spot, keep heading so player
    // isn't disoriented; just stop & realign to terrain.
    this.speed = 0;
    this._vx = 0; this._vz = 0;
    this._snapToTerrain(true, terrain);
  }
}
