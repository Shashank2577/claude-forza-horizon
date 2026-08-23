# Mobile controls — the specification and the bar

This is to touch controls what `ART_DIRECTION.md` is to the frame: the thing to
build against, and the thing to score against. §7 is the rubric and it is the
bar.

Three design lenses surveyed the touch layer independently — one on input
correctness and control schemes, one on steering feel and latency, one on
ergonomics, feedback and onboarding. They agreed on more than they disagreed on,
but where they disagreed the disagreements were real and load-bearing. §2 says
which way each was resolved and why. **Do not re-litigate a resolution by
re-reading one lens; the resolutions are where the actual work happened.**

Scope: `src/core/TouchControls.ts`, `src/core/Input.ts`, `src/ui/**`, and one new
`src/core/ControlPrefs.ts`. Out of scope and owned by the concurrent performance
workflow: `src/render/`, `src/world/`, `src/fx/`, `src/kart/`,
`src/core/Settings.ts`, `Diagnostics.ts`, `Prewarm.ts`, `main.ts`.
`src/types.ts` is not touched by any of this — §3.9 shows why it does not need
to be.

---

## 1. Two invariants that outrank everything below

**I1 — The negation stays exactly once, in `Kart.ts`.** The touch layer emits
the input contract: `steer > 0` means the player wants to go RIGHT.
`Kart.updateSteerInput` negates once at the boundary; `Race.ts` negates the AI's
command at its call site because the AI solves in the chassis frame. The
left-handed mirror in §3.6 mirrors **geometry only**. Adding a second negation
anywhere is the documented failure that has already cost a round, and
`tools/steer-test.mjs` must pass unmodified.

**I2 — Analogue sources are not filtered in `Input.ts`.** The chassis already
contains two rate limits in series (`STEER_RATE_LOW/HIGH/FREE`, then
`smooth(26, h)`). Anything added in the touch layer is a third, which is exactly
the "mushy" failure the latency-budget header in `Input.ts` documents. Haptics,
halos and tutorial state are presentation and must never enter the steering
path. The one exception is the **release ramp** in §3.4, which replaces a decay
that already exists in `Input`'s digital branch and is measured to produce the
same number.

---

## 2. Where the lenses disagreed, and how it was resolved

### 2.1 Stick radius — **enlarge it.** (Lens 2 wins over Lenses 1 and 3.)

Lens 1 measured the current stick and found 60 distinct steer values over a
100 px sweep, 41 of 100 sample pixels in the usable 0.15–0.85 midband, first
non-zero at 4 px. Its conclusion — "precision is already good, do not fix it" —
and Lens 3's "feel is unchanged, do not re-derive" both rest on that reading.

They are measuring the wrong instrument. 60 distinct values is the resolution of
the **digitizer**. The resolution that matters is the resolution of the
**thumb**. Lens 2 inverted the curve and found that on an iPhone 14 the travel
separating "drive the corner" (`steer` 0.06, the figure `Kart.ts` itself gives
for steady-state cornering on this circuit at 26 m/s) from "commit to a drift"
(`DRIFT_ENGAGE_STEER` = 0.13) is **5.2 CSS px**. Thumb placement repeatability
on glass is 1–2 mm. The player physically cannot separate the two intents that
the repo's own memory calls the top priority. That is a defect, and no amount of
digitizer resolution fixes it.

**A density discrepancy, resolved, because it moves the gate.** Lens 2 converted
that 5.2 px to **0.95 mm** using 0.183 mm/px; Lens 3's device table gives the
iPhone 14 **6.04 px/mm**, i.e. 0.166 mm/px, which makes it **0.86 mm**. Lens 3's
figure is the derivable one — 844 CSS px across a 139.8 mm landscape display is
6.04 — and Lens 2's is about 10% low. Use Lens 3's table throughout; every mm
figure in this document is in those units, and the §5 gates are set from them
rather than from Lens 2's slightly generous conversion. This is small and it is
exactly the kind of thing that turns into a threshold nobody can hit: two lenses
reported the same measurement in the same unit and disagreed by 10%, and only
one of them can be checked against a published dimension.

Lens 2's proposal also survives the obvious objection. Widening the radius
normally costs the mid-range, which is why `CURVE = 1.35` was rejected in an
earlier round ("half a thumb-sweep produced a third of the lock"). Pairing the
wider radius with an absolute-pixel dead zone and `CURVE = 1.26` preserves the
half-travel output to three decimals — **0.397 vs today's 0.399** — so the
travel is what is being bought, not the mid-range. That is the check that makes
this a measured change rather than a taste change, and it must appear in the
harness.

**Resolved value**, trimming Lens 2's tablet ceiling because the existing
`sizeStick` comment is right that a tablet should not demand a whole hand:

```
STICK_RADIUS = clamp(84, min(innerWidth, innerHeight) * 0.24, 116)   // CSS px
```

Verified across the device table (`STICK_RADIUS`, then the corner→drift band,
then half-travel output, then what `touch-test.mjs`'s 70 px drag returns):

| device | rGrab | travel | band | half-travel | 70 px |
|---|---|---|---|---|---|
| iPhone SE (375) | 90.0 px | 14.0 mm | 7.86 px / **1.23 mm** | 0.3964 | 0.718 |
| iPhone 14 (390) | 93.6 px | 15.5 mm | 8.18 px / **1.35 mm** | 0.3972 | 0.682 |
| Pixel 8 (412) | 98.9 px | 16.8 mm | 8.66 px / **1.47 mm** | 0.3983 | 0.635 |
| 15 Pro Max (430) | 103.2 px | 17.1 mm | 9.06 px / **1.50 mm** | 0.3992 | 0.600 |
| iPad mini (744) | 116.0 px | 18.4 mm | 10.22 px / **1.62 mm** | 0.4012 | 0.516 |

Today's band, for comparison, is 5.20 px / 0.86 mm and today's half-travel is
0.3990. Half-travel moves by at most 0.0026 on a phone — the mid-range is
genuinely not being sold to buy the band, which is the whole justification for
the change and must be re-checked by the harness rather than taken on trust
here.

Full-lock travel cannot be made constant in millimetres at runtime (CSS px per
mm is not derivable in the page, and §3.6 forbids pretending otherwise), so the
honest claim is the 14–18 mm band, not constancy.

**Two honest limits, stated rather than hidden.** On a 375 px-short-edge
iPhone SE the band is 1.23 mm, inside the upper end of thumb repeatability; the
SE cannot reach 1.45 mm without a stick that runs off the screen, so the §5 gate
is split by screen size rather than set to a number the smallest device cannot
meet. And on an iPad the 70 px drag returns 0.516 against `touch-test.mjs`'s
`> 0.5` assertion — it passes, and the harness runs at 844×390 where it returns
0.682, but anyone extending that harness to a tablet viewport must revisit the
threshold rather than assume it still has margin.

### 2.2 Four control schemes, or two — **two.** (Lens 3 wins over Lens 1.)

Lens 1 surveyed shipped mobile racers well (Mario Kart Tour, Asphalt 9, Real
Racing 3, GRID) and correctly identified the industry pattern: 3–4 schemes,
graded assists, exposed sensitivity. It proposed floating stick, fixed stick,
tilt, and lean zones.

Ship **floating (default) and fixed** only. Reasons, in order:

1. Four schemes is four times the surface area for exactly the class of bug the
   lenses just found. D1 (a rolled thumb kills steering), D2 (3.9% of the
   visible action cluster fires the wrong button) and D3 (a sub-44 px control)
   all shipped in the *one* scheme that exists. Adding three more untested state
   machines on top of three unfixed defects is how this round produces a worse
   game than it started with.
2. Tilt and lean-zones cannot be validated by a harness alone. Tilt's failure
   mode is a sign flip that depends on `screen.orientation.angle`, and lean
   zones' failure mode is "it feels like a d-pad" — both need a hand. This
   repo's rule that a screenshot cannot find a gameplay bug generalises: a
   scheme nobody has held is not a shipped scheme.
3. The fixed stick is nearly free — same code path, `originX/originY` frozen,
   trailing disabled — and it answers the floating stick's one real weakness,
   which is that a player watching the track has no proprioceptive reference for
   how far from centre they are on a long constant-radius corner.

Lens 1's per-scheme constants for the fixed stick are adopted: `DEADZONE_PX`
rises to 6 px (a fixed stick has landing error to reject; the floating stick's
3.5 px is tuned for an origin where zero really is zero) and `rGrab` is not
room-clamped because the rosette position is chosen, not landed on.

**Nothing here forecloses tilt or lean.** They hang off the same
`ControlPrefs.scheme` value and the same `setScheme()` teardown in §3.10, and
Lens 1's finding that tilt must resolve roll against `screen.orientation.angle`
(90 vs 270 flip the sign of `gamma`) is recorded here as a pre-registered trap
for whoever builds it. That is the same class of bug as the documented steering
handedness trap, and it will be found by reading this line rather than by
shipping inverted steering to a phone.

Lens 1's rejection of an Asphalt-style TouchDrive lane picker stands and is
adopted verbatim: it needs an authored racing line with discrete lanes this
track does not have, and it takes the drift ladder out of the player's hands.

### 2.3 Where steering assist lives — **inside `Input.update()`.** (Lens 1 wins over Lens 2, on evidence.)

Lens 2 asserted that a line assist "needs the racing line, which lives in
`src/game/`", and that plumbing a strength through would widen `src/types.ts`
and therefore need its own commit.

That is checkable and it is wrong. `Input.update(ctx: Ctx, dt: number)` already
receives the full `Ctx` and stores it on `this.ctx` (it is used for the item
lookup at `Input.ts:521`). `ITrack.sample(t)` exposes `tangent`, `binormal` and
`halfWidth`; `IKart` exposes `position`, `forward`, `t`, `driftDir` and
`driftTier`. Everything the assist needs is on the existing contract, reachable
from the existing signature, and the correction can be folded into `state.steer`
before publication. No `types.ts` change, no new commit boundary.

**But Lens 2's *shape* is better than Lens 1's** and is adopted. Lens 1 proposed
a hard clamp on the correction; Lens 2 proposed a `(1 - |steerPlayer|)²` gain
envelope, which is C¹, retains 25% of the assist's authority at half player
input, and reaches exactly zero at full lock. That is the "never takes the wheel
away" property expressed as a curve rather than as a clamp, so there is no step
the thumb can feel as the player leans on it. Keep the clamp too, as a bound of
last resort.

**Kill condition:** Lens 1 said zero the assist when `driftTier >= 1`; Lens 2
said zero it when `driftDir !== 0`. Lens 2 is stricter and correct —
`driftTier` is still 0 during the initial charge phase of a slide, which is
precisely when an assist pulling toward the centreline would fight
`DRIFT_TURN_ASSIST` and cost the mini-turbo. Use `driftDir !== 0`.

### 2.4 Auto-drift — **a steer floor, not a state machine.** (Lens 2 wins over Lens 1.)

Lens 1 proposed auto-drift as a state machine in `Input.ts` that enters a drift
when steer exceeds `DRIFT_ENGAGE_STEER` for 3 frames above a speed floor and
auto-releases at tier 3 or on a steer dip, emitting `state.drift`.

Reject. That design contains a release-on-steer-dip window, which is a second
carry window competing with `DRIFT_CARRY_TIME` in `Kart.ts` — the exact trap
CLAUDE.md warns about, discovered independently for at least the third time.
Lens 1 even names the trap and then proposes the thing it warns against.

Lens 2's version does the same job with none of the risk: while DRIFT is
**already held by the player**, raise the floor on `|steer|`.

```
DRIFT_FLOOR = 0.16   // > DRIFT_ENGAGE_STEER (0.13)
DRIFT_FLOOR_ARM = 0.04   // never invents a direction from nothing
DRIFT_FLOOR_TIME = 0.9 s // ~DRIFT_ARM_TIME; commits the slide, does not pin the stick
```

It never invents a drift, never releases one, never touches `state.drift`, and
at `A = 0` the code path must be byte-identical to the assist being absent. On
an iPhone 14 under §3.1's geometry it means a **1.74 mm** deflection commits the
slide (the arm threshold, 10.5 px) where **4.06 mm** would otherwise be needed
(24.5 px for a bare 0.16) — which is the whole of what Lens 1 wanted, obtained
without a state machine that could grow a second carry window.

### 2.5 The drift-hold curve blend — **rejected.** (Neither lens; a resolution.)

Lens 2 proposed blending the response exponent from `CURVE` 1.26 to
`CURVE_DRIFT` 0.95 over 120 ms whenever DRIFT is held, on the reasoning that a
drifting kart uses the whole stick range while a gripping one uses only
`|steer| ≤ 0.25`.

The reasoning is sound and the mechanism is not. It makes the same thumb
position mean two different things depending on when you look at it, in a game
whose top priority is a *sustained hold with continuous modulation*. A player
countersteering through a slide would be feeding corrections into a transfer
function that is itself moving. The steer floor in §2.4 solves the commitment
half of the problem with a bounded, frame-local, instantly reversible term, and
the wider radius in §2.1 solves the resolution half. Two mechanisms are enough;
a third that is time-varying is where the bodies get buried.

If a future round wants it, it needs an A/B with a human, not a harness.

### 2.6 Haptics — **Lens 3's structure, trimmed table, and no iOS trick.**

All three lenses independently found the same bug and it is the highest-
confidence finding in the whole review: `Input.haptic()` gates the
`navigator.vibrate` fallback behind `strong > 0.55`, a threshold written for
gamepad dual-rumble *magnitudes* and applied to a phone LRA that takes a pulse
*length*. `boost` passes 0.28 and `drift-spark` passes 0.16, so **the two events
the entire drift loop is built on produce no phone vibration at all**, while
being shelled does.

Adopt Lens 3's structural fix: split the channels. `haptic(strong, weak, ms)`
stays for the gamepad; a new `pulse(event)` drives `navigator.vibrate` off a
table. Adopt Lens 2/3's 45 ms minimum gap over Lens 1's 60 ms, and Lens 3's
12%-duty-cycle-over-2 s budget, which is the constraint that actually stops a
phone reading as broken.

Trim the table from Lens 3's thirteen rows to eight. Countdown beats on 3/2/1
are four pulses before every single race and will be the first thing a player
turns off; keep only GO, which still supplies the user-activation Chrome
requires before the first vibrate and is still the right place to discover the
API is unavailable.

**Do not ship the iOS `<input type="checkbox" switch>` haptic trick.** Lens 1
proposed it behind a probe; Lens 3 could not verify it and refused to make it a
pass condition. Both cite that Apple patched it in iOS 26.5. Shipping an
unverifiable path against an API the vendor is actively closing is a maintenance
liability, and it is unnecessary given the rule below. State plainly in the
comment that `navigator.vibrate` is unimplemented in Safari and this lands on
Android only, so the next round does not "fix" a no-op that is not broken.

**No feedback in this game may be communicated haptically only.** Every pulse in
the table has a visual and an audible counterpart.

### 2.7 Charge readout — **Lens 3's halo, and Lens 3's safe-area fix, which Lens 1 missed.**

Both Lens 1 and Lens 3 independently found that the drift charge rail sits under
the drifting thumb and proposed a charge indicator on the DRIFT button itself,
fed by properties `HUD.ts` already computes. Take Lens 3's version: the arc is
drawn **outside** the button (r+8 to r+18) and sweeps the **upper semicircle
only**, from 9 o'clock through 12 to 3, because a thumb contact pad is 10–14 mm
across — wider than the 64–104 px button — so the centre and lower arc are under
flesh at press time and the upper arc is not. Lens 1's on-button conic ring
would be under the thumb it is trying to escape.

Lens 3 also found something Lens 1 missed entirely and it is the single
highest-value fix in this section: **`.kr-charge-e` never consults `env()` at
all.** It is `left: 0` / `right: 0`, 30 px wide on every phone, against reported
landscape insets of 47–59 px on notched iPhones. The rails are 100% inside the
inset on the 13 mini, 14/15 and 15 Pro Max — and the mask makes it worse, since
the brightest part of the rail is the part furthest under the sensor housing. On
those devices the mini-turbo ladder is currently drawn where it cannot be seen.

Take both: move the rails inside the safe area, cap their vertical extent so the
leading cap clears the grip band, and add the halo. Lens 1 and Lens 3 also
independently insist that **tier must remain a COUNT of rung marks passed, not a
hue**, so it survives a blown-out sky and a red-green deficiency. That property
must not be lost in the move; reproduce the two ticks on the halo.

### 2.8 Two proposals that were individually fine and jointly contradictory

Lens 2's per-grab room clamp (`rGrab = max(70, min(STICK_RADIUS, x - safeLeft - 6))`)
and Lens 3's spawn rectangle (`x ∈ [24 px, 0.46 W]`) cannot both hold. A thumb
landing at x = 24 has 24 px of leftward room; the trailing base only engages
once `|dx| > rGrab`, which never happens, so **full lock to the left is
unreachable from that spawn** — and Lens 2's own test #8 gates exactly that and
would fail against Lens 2's own rule.

Resolved by arithmetic rather than by picking a lens: the spawn region's left
edge must itself be at least `R_GRAB_MIN` from the safe-area edge.

```
spawn x ∈ [safeLeft + 60, 0.46 * innerWidth]
spawn y ∈ [0.22 * innerHeight, innerHeight - 24]
rGrab   = clamp(56, min(STICK_RADIUS, x - safeLeft - 4), STICK_RADIUS)
R_GRAB_MIN = 56
```

At the leftmost legal spawn, `rGrab = 56` and full lock is reached at
`safeLeft + 4` — inside the viewport, reachable, and the 60 px left margin also
satisfies the 24 px OS edge-gesture band. On a 667 px-wide SE the spawn band is
still 247 px wide.

### 2.9 One primitive serves three problems

Lens 1's D1 fix (adopt an heir pointer when the steering thumb lifts, placing
the new origin so the outgoing steer value is reproduced), Lens 2's re-grab
continuity (place the origin so the value the release ramp had reached is
preserved), and both lenses' resize-mid-gesture fix (re-derive the origin from
the retained output and the new radius) are **the same operation**. Build it
once:

```ts
/** Place the stick origin so that a thumb at `clientX` reproduces `steer`
 *  exactly under the current curve and rGrab. The inverse of the response
 *  curve — used by handover, re-grab and resize, which are the same problem
 *  wearing three hats: "the output must not jump". */
private transplantOrigin(clientX: number, steer: number) {
  const n   = Math.pow(Math.abs(steer), 1 / CURVE);
  const raw = dz + n * (1 - dz);
  this.originX = clientX - Math.sign(steer) * raw * this.rGrab;
}
```

Three call sites, one inverse, one test that the inverse round-trips.

### 2.10 Smaller resolutions, decided without ceremony

| question | lenses | resolved |
|---|---|---|
| hit-test pad | L1: `visR + clamp(10, .38·visR, 22)`; L3: `min(16, gap/2 + 2)` | **L3's** — derived from the drawn gap, so it is *provably* non-overlapping at the visible edge rather than merely smaller |
| hit-test resolution | L1: visible disc wins, then min normalised distance; L3: min normalised distance | **both, L1's staged form** — "what you see is what you press" is an unconditional guarantee and subsumes the tie-break |
| edge guard | L1 12 px, L2 14/10 px, L3 24 px | **24 px** (L3 — it is the OS gesture band, not a taste), with L1's refinement: only reject `pointerdown`, never a move from a pointer already down |
| palm rejection | L1 area > 2025; L2 `w>42‖h>42`; L3 `>45` + feature-detect | **45 px + L3's feature detect** — Safari reports `width === 1` always, so the rule must arm only once the session has seen a pointer report something else, and must degrade silently to today's behaviour |
| touch-target floor | L1 44 px (Apple); L3 46 px | **46 px** — 44 px is 6.9 mm at the table's tightest 6.41 px/mm, under the 7 mm physical floor; 46 clears it |
| min haptic gap | L1 60 ms; L2/L3 45 ms | **45 ms** |
| AUTO chip | L1 keep + persist; L3 remove to a pause menu | **neither** — keep the chip but show it on pre-race screens only, hide it during racing, and persist it. Fixes "resets on every reload" and "a settings toggle 20 px tall that no racing thumb can reach", without inventing a settings menu this round |

---

## 3. The specification

### 3.1 Stick geometry

```ts
STICK_RADIUS = clamp(84, min(innerWidth, innerHeight) * 0.24, 116)  // CSS px
R_GRAB_MIN   = 56
rGrab        = clamp(56, min(STICK_RADIUS, x - safeLeft - 4), STICK_RADIUS)  // fixed for the grab
DEADZONE_PX  = 3.5   // floating scheme; 6.0 for the fixed scheme
dz           = DEADZONE_PX / rGrab
CURVE        = 1.26
steer        = sign(dx) * min(1, ((|dx|/rGrab - dz) / (1 - dz)) ^ CURVE)
```

The dead zone is **absolute pixels, not a fraction of the radius**. Thumb settle
is a physical quantity and does not scale with screen size; as a fraction it was
3.3 px on a phone and 4.8 px on an iPad, which is 30% more of nothing on the
device with the steadier grip. Rescale past the edge exactly as today so there
is no step at the boundary. One-dimensional on the steering axis only — no
radial dead zone; vertical thumb motion is not a steering input and must not
consume travel.

**Visual decoupling is required.** `2 × rGrab` would be a 187 px ring on a
390 px-tall frame. The ring is an indicator, not the hit area:

```
ringRadius = 0.62 * rGrab          // 58 px on iPhone 14 → drawn d = 116 px
knobRadius = 0.42 * ringRadius
knob offset = clamp(thumbOffset, ±ringRadius)   // 1:1 until the rim
```

Past the rim, encode remaining travel as rim alpha 0.35 → 1.0 proportional to
`|steer|`, so the outer 38% of travel stays legible. `sizeStick()` must size
from `ringRadius`, not `rGrab`. Note the drawn stick gets *smaller* than today's
125 px, which independently helps §3.7's occlusion problem.

**Trailing base stays.** Once `|dx| > rGrab` the origin follows in X, so the
stick never saturates and then feels dead on the way back. The `sizeStick`
comment explaining that lock radius and trail radius must be the same number is
load-bearing — do not separate them.

**Hard-over shelf.** `SATURATE_IN = 0.94`, `SATURATE_OUT = 0.91` — 2.9 px of
hysteresis at the one place where pushing further is physically impossible
anyway. This is not the dead-band bug: it is 6% of travel, at the rim, and
pulling back responds within 3 px.

**Origin clamp.** `originX ∈ [safeLeft + 8, 0.5·innerWidth - 8]`, so the base
cannot migrate out of its own zone over a lap.

**Thumb-arc alignment.** Once cumulative travel from the origin first exceeds
`ARC_LATCH_PX = 10`, latch the drag axis for the life of the grab:
`theta = clamp(atan2(dy,dx) folded into (-90°,90°], ±32°)`,
`dxEff = dx·cosθ + dy·sinθ`. Cache `cos`/`sin` at latch — two trig calls per
grab, not per move. Recovers the 7–13% of travel a natural thumb arc currently
throws away.

### 3.2 Smoothing budget: zero

**The touch layer may add no more than 8 ms of group delay to a rising input,
and in practice that means no filter at all on engage or hold.** A 1-pole at
even an 8 ms time constant would remove roughly 1 px of jitter — a quarter of
what the radius increase already removes — for a quarter frame of lag.

Do not drain `getCoalescedEvents()` and average it for position. A
`pointermove`'s own `clientX` is already the freshest sample; averaging the
coalesced list is a low-pass filter wearing a correctness-fix costume. Say this
in a comment or someone will add it.

### 3.3 Steering handover (defect D1 — deterministic, and it kills steering)

Reproduced: finger A at full lock; finger B lands in the steering region and
goes to `free`; A lifts → `steer 0, steering false`; B drags 80 px → **still 0**.
`onDown` claims the stick only when `stickPointer < 0`, and `onMove` promotes a
`free` pointer to a *button* only, never to the stick. Rolling your thumb, or
resting a second finger, loses steering for the rest of that touch.

- On `pointerup` of the stick pointer: if any `free` pointer is inside the spawn
  region, adopt the **most recently added** one and `transplantOrigin(heir.x,
  outgoingSteer)`. Steering is continuous across the roll — no snap, no jump.
- **Palm safety.** Start a decay clock on adoption: if the heir produces no
  `pointermove` within `HANDOVER_SETTLE = 100 ms`, ramp `steer` linearly to 0
  over `HANDOVER_DECAY = 100 ms`. Any move cancels the decay. A resting palm
  holds a phantom lock for at most 200 ms (≈6 m at 30 m/s); a rolled thumb for
  0 ms.
- On `pointermove` of a `free` pointer while `stickPointer < 0` and it is inside
  the spawn region: adopt it, origin at its current position, steer 0.

### 3.4 Release and re-grab

Today's 66.7 ms lock-to-centre is an accident: `steering` goes false, `Input`
falls into its digital branch, and `STEER_RETURN = 16` decays `s.steer`. The
number is good; nothing states it, no test covers it, and it is one "tidy the
fallthrough" commit away from becoming an instant snap.

Own it without changing it. `RELEASE_RATE = 16 units/s`, linear in `dt` (step-
invariant at 30/60/120 fps, per the frame-rate rule in `Input.ts`). On
`pointerup`/`pointercancel` of the stick pointer: `stickPointer = -1`, `active`
drops immediately, **`steering` stays true while `steer !== 0`**, and `update()`
decays toward 0. `Input` needs no change — it keeps taking the analogue path and
the digital return branch stops being load-bearing for touch.

**Re-grab continuity:** a stick `pointerdown` arriving while the ramp is still
running calls `transplantOrigin(e.clientX, state.steer)` instead of zeroing. The
window is self-limiting — exactly as long as the ramp, ≤ 62.5 ms from full
lock — so a thumb repositioned mid-corner continues and a thumb genuinely lifted
and re-landed starts from zero.

### 3.5 Buttons: the drawn button is the button that fires (defect D2)

`hitButton()` returns the **first** padded circle in declaration order
(drift, item, brake, look, gas) containing the point, not the nearest, and the
pad is a flat `+16 px` on radii of 21–43 px, so every padded pair overlaps.
Measured: 496 / 12,637 visible-button pixels wrong on an iPhone 14 (3.9%) and
511 / 11,690 on an SE (4.4%) — 198 px of the visible ITEM disc fire DRIFT, 175 px
of BRAKE fire DRIFT, 123 px of LOOK fire ITEM. Zero on an iPad, because the
buttons scale with vmin and the +16 pad does not. The stealing crescents sit on
the **drift-facing edge** of ITEM and BRAKE, exactly where a right thumb
travelling from DRIFT arrives.

One nuance neither lens stated, and it sharpens the failure: `hitButton` skips
buttons with `pointer >= 0`, so while DRIFT is *held* the crescent correctly
resolves to ITEM. The misfire happens when DRIFT is **not** held — i.e. on a
straight. Reaching to fire a shell on a straight puts you into a drift. That is
the worst possible distribution of this bug.

Two-stage fix:

1. **If any button's *visible* disc contains the point, that button wins**,
   unconditionally. What you see is what you press.
2. Only if no visible disc contains it, search the padded circles and take the
   **smallest normalised distance** `(dist - visR) / visR`. Ties break to the
   smaller `visR` (the more specific target).

And derive the pad from the drawn gap so it cannot reach a neighbour's face even
before rule 2 applies: `pad = min(16, gap/2 + 2)` per control, where `gap` is
the measured drawn gap to the nearest neighbour.

Slide-onto-button (header note 5) is unaffected — it still runs through
`hitButton`, now with correct resolution.

### 3.6 Sizing, reach and safe areas

**Sizing.** Every control sized by an explicit three-term clamp, never bare
vmin — pure vmin gives a 2× physical spread (DRIFT is 12.9 mm on an SE and
25.9 mm on an iPad mini):

```
DRIFT  clamp(64px, 21vmin, 104px)     ITEM  clamp(56px, 16vmin, 88px)
BRAKE  clamp(48px, 14vmin,  76px)     GAS   clamp(48px, 14vmin, 76px)
LOOK   clamp(46px, 11vmin,  62px)     PAUSE clamp(46px, 10vmin, 56px), circular
```

Floor 46 × 46 CSS px on every interactive element (≥ 7.2 mm at the table's
tightest density); ceiling 18 mm so a tablet does not get a saucer. Spacing is
centre-to-centre = `rA + rB + gap`, `gap = clamp(10px, 2.4vmin, 20px)` — the
cluster stops being five independent absolute vmin offsets inside a 46×40 vmin
box, because with the clamps those offsets no longer track the sizes.

Today LOOK is 42.9 px / 6.4 mm and PAUSE is 30×20 px (4.7 × 3.1 mm) with no
padded hit circle at all — under WCAG 2.5.8's 24×24 px minimum, never mind
Apple's 44 pt.

**SAFE-RECT** = viewport inset on each side by the max of `env(safe-area-inset-*)`,
24 px (the OS edge-gesture band, which `touch-action: none` does **not**
suppress in a browser tab, only in a standalone web app), and — for the bottom
edge — 24 px unconditionally, since Chrome on Android reports 0 with gesture
nav active. **CORNER-EXCLUSION** = a quarter-disc of radius
`max(48px, env inset on the two adjacent sides)` at each corner, because the
physical display corner radius is 45–55 px and is not reported to the page.

- **C1** No interactive element's padded hit circle may leave SAFE-RECT or enter
  CORNER-EXCLUSION. Today the cluster's 3 vmin offset gives DRIFT 11.3–11.7 px
  of bottom clearance on zero-inset devices — inside both bands.
- **C2** No element carrying gameplay state may have a lit pixel outside
  SAFE-RECT. This is the rule `.kr-charge-e` breaks totally (§2.7).
- **C3** A floating stick may not take its *origin* inside the 24 px edge band
  (see §2.8's numbers). Once claimed, the base may trail outside it.

**Reach.** Model the right thumb's pivot at `(W + 8, H + 10)` CSS px and the
left at `(-8, H + 10)` — deliberately favourable, so every reach number is a
lower bound. COMFORT ≤ 45 mm, ACCEPTABLE ≤ 58 mm, REGRIP > 58 mm. On phones the
cluster is already well placed (DRIFT 13.6–25.9 mm); LOOK at 48 mm on a 6.7"
phone is marginal and at 66.2 mm on an iPad mini is unreachable, so on viewports
with a min edge ≥ 700 px the cluster anchors to a maximum 58 mm-equivalent from
the pivot rather than to the frame corner — a max-inset on the cluster box, not
a second layout.

**Millimetres are never emitted from page JS.** CSS px per mm is 5.9–6.4 on the
device table, not the nominal 3.8, and is not derivable at runtime. The runtime
expresses the budgets as px clamps; the harness enforces the mm budgets against
a tabulated device list. Before the mm numbers are trusted at all, the grip band
in §3.7 must be calibrated once against reality — three people, three device
sizes, hand traced on the glass, photographed. A thumb-reach model is an
instrument, and this repo's rule is that an instrument is validated before its
reading is believed.

**Handedness.** One attribute, `html[data-touch-hand="left"|"right"]`, mirroring
the spawn rectangle, the cluster's horizontal anchor, the PAUSE corner and the
`html[data-touch]` HUD reflow. One mirrored block driven by a custom property,
not a second hand-written layout. Per I1, geometry only.

**Spawn region and robustness.** Spawn rectangle per §2.8 (the upper 22% is
excluded so a thumb reaching for PAUSE and missing cannot spawn a steering stick
at head height). Palm rejection at 45 px contact, feature-detected, scoped to
the stick spawn only — a large contact landing on DRIFT must still claim DRIFT,
because rejection must not make the action cluster harder to hit. Bind
`visualViewport` `resize` and `scroll` in addition to `resize`/`orientationchange`,
and re-`measure()` on the next **two** rAFs after `orientationchange` (iOS fires
it before layout settles). On any transition into portrait, force-release every
pointer. On any resize with a live stick, `transplantOrigin()` from the retained
output and the new `rGrab`.

### 3.7 The loop, made visible under a thumb

**Grip band** (subject to the calibration above): per side, x from the screen
edge inward to `min(0.16·W, 22 mm-equivalent)`, y from `0.55·H` to the bottom,
plus a 20 mm-equivalent disc around that side's pivot.

- **Rails inside the safe area.** `.kr-charge-e` left/right become
  `calc(env(safe-area-inset-<side>, 0px) + 8px)`, keeping the
  `clamp(30px, 5.4vmin, 90px)` width. Non-negotiable; this is C2.
- **Rail shortened, not inverted.** On `html[data-touch]`, the rail box becomes
  `top: calc(env(safe-area-inset-top,0px) + 4%); bottom: 46%`. At tier-1 fill
  0.333 the leading cap lands at ≈0.37·H and at fill 0.15 at ≈0.47·H, both above
  the 0.55·H grip band. Keeps bottom-up growth — the direction of travel the
  player already learned on desktop — and the rungs stay meaningful because they
  are fixed to the rail box, not to the frame. Inverting growth top-down was the
  alternative and is rejected: it teaches two opposite metaphors for one number.
- **The halo.** An arc outside the DRIFT button, r+8 to r+18, sweeping the upper
  semicircle only (9 o'clock → 12 → 3), driven by exactly the properties
  `HUD.ts` already computes. `HUD.ts` writes `--fill`, `--cc`, `--cn` and
  `data-drift-tier` to `document.documentElement` in addition to `.kr-charge`;
  the touch CSS consumes them. Zero new per-frame work, one conic-gradient, no
  layout, no allocation, no cross-module API, no `types.ts` change.
- **Rungs, not hue.** Two 3 px radial ticks at 1/3 and 2/3 of the sweep, cream
  between two ink edges — the same recipe as the rail's. A tier is a COUNT of
  marks passed. This survives a blown-out sky and a red-green deficiency and it
  must not be lost in the move.
- On tier-up the halo flares (brightness + 2 px radial expansion, 0.44 s),
  starting **at peak on frame zero** — the round-11 lesson that a cue must land
  on the trigger frame, not two frames later.
- On release the halo snaps to full in boost gold and drains, mirroring the
  rail. `--fill` is never eased; only opacity is. A tier boundary is a step and
  the reset to zero is what the player feels as "banked".
- Rail and halo carry the **same fact** and must never disagree by more than one
  frame.

**Item state.** Move `.kr-item` into the touch top rail
(PAUSE · LAP · ITEM · gap · MINIMAP · gap · TIME). Measured space between the
lap plate's right edge (x 105) and the minimap's left edge (x 353) on an
iPhone 14 is 248 px, which fits a 56–72 px plate with room. This is what fixes
the measured **100% occlusion** of the item box at the modal thumb landing
(25 mm / 35° from the left pivot, on both the iPhone 14 and the 15 Pro Max). The
existing comment calls the item box "a read-only display the floating stick can
safely overlap for the moment a thumb is actually down there" — with
auto-accelerate on and drift held, the thumb is down for the whole lap, and the
physical thumb is opaque where the base disc is only translucent. No z-index
fixes flesh.

Additionally, drop the stick base's rest opacity from .85 to .55 while any HUD
plate is under it. That helps the translucent-overlap case and does not pretend
to solve the opaque-thumb one.

### 3.8 Haptics

Delete `strong > 0.55` from the vibrate path. Keep `haptic(strong, weak, ms)`
for the gamepad; add `pulse(event)`:

| event | pattern (ms) |
|---|---|
| countdown GO | `[26]` — also supplies Chrome's first user activation |
| mini-turbo tier 1 / 2 | `[12]` / `[16]` |
| mini-turbo tier 3 | `[10, 40, 22]` — a double-tap: "this is the big one" |
| boost ignite (release, pad or item) | `[28]` |
| item fired | `[14]` |
| collide, `k = clamp01(impulse/14)` | `[round(10 + 18k)]` |
| hard landing, `k = clamp01(impact/22)` | `[round(8 + 14k)]`, suppressed below k = 0.35 |
| hit by a shell | `[24, 50, 24]` — the only other three-part pattern, so it is unmistakable |

Drift **entry** (tier 0) stays silent, exactly as today: it fires on every
corner. Minimum 45 ms between pulse starts; a pending pulse is dropped unless it
is strictly stronger by total pattern energy, in which case it pre-empts. Total
duty cycle < 12% over any rolling 2 s window. Everything wrapped — `vibrate` is
absent on iOS Safari and can throw, and a rejection must never reach the player.
A `haptics` setting, default on, persisted.

### 3.9 Assists — graded, and computable on the existing contract

**Steering assist.** Computed inside `Input.update()` and folded into
`state.steer` before publication, so it stays in the input frame and `Kart.ts`
still does the one negation.

```
lateral    = (player.position - sample.pos) · sample.binormal      // + = right of line
heading    = signed angle from sample.tangent to player.forward    // + = pointing right
target     = -(0.65 * lateral / sample.halfWidth + 0.35 * heading / 0.45)
correction = A * (1 - |steerPlayer|)^2 * target,  clamped to ±0.22
steerOut   = clamp(steerPlayer + correction, -1, 1)
```

`A ∈ {0, 0.35, 0.60}`, default **0.35 on touch, 0 on keyboard/pad**. The
`(1 - |s|)²` envelope is the "never takes the wheel away" property as a C¹
curve: 25% of authority at half input, exactly zero at full lock, no step as the
player leans on it. The ±0.22 clamp is a bound of last resort. Correction may
only be *added* — it may never reduce the magnitude of a deliberate player
command in the same direction.

**`correction = 0` whenever `player.driftDir !== 0`.** This is the single most
important line in the assist: an assist that fights a held slide destroys the
mini-turbo ladder, and `driftTier` is still 0 during the charge phase, so gating
on tier is not sufficient.

**Auto-drift** is the steer floor from §2.4, and nothing else. It never enters,
never releases, never touches `state.drift`, and never adds a second carry
window. `driftAssist ∈ {0, 0.5, 1}`, default 0.5.

**Sensitivity** is deliberately *not* exposed this round. `CURVE` is now doing
two jobs (§2.1's half-travel-preservation proof depends on 1.26 pairing with
`DEADZONE_PX = 3.5` and `STICK_RADIUS`), and a slider that moves one of three
coupled constants is a slider that lets a player break their own controls. Ship
the measured pairing; expose a slider only after a round where the pairing has
been held by a harness.

### 3.10 Schemes, persistence, and race-state integration

`TouchControls.setScheme(name)` tears down and rebuilds the *steering source*
without unmounting the button cluster, and is safe mid-race: release every live
pointer, zero `steer`, clear `steering`. Switching schemes must never end or
reset a race.

**Persistence.** New file `src/core/ControlPrefs.ts` — **not `Settings.ts`**,
which the concurrent performance workflow owns, and which is device/GL
capability profiling rather than player preference. One versioned key
`kr.controls.v1`: `{ v, scheme, hand, autoAccel, haptics, steerAssist,
driftAssist, fixedStickPos, tutorialSeen }`. `grep -rn localStorage src/`
currently returns nothing, so this is the first player preference the game has
ever kept.

Every access wrapped in try/catch: `setItem` throws in Safari private mode and
must not take the game down. Absent or unparseable → defaults, silently. Nothing
in the boot path may await or depend on it. `tutorialSeen` is a **version
stamp**, not a boolean, so a materially changed control scheme can re-teach
itself once — and a storage failure must never re-show the tutorial in a loop.

**The pad must not shadow the menus.** `.tc-root` is `z-index: 20`; `#ui` is
`z-index: 10`; nothing ever hides or disables `.tc-root`, and there is no
race-state awareness in `TouchControls` at all. `.tc-btn` keeps
`pointer-events: auto` on the title, select, pause and results screens, and
`onDown` calls `preventDefault` on a hit. Menus' tap-anywhere-confirm listener
is on `.kr` — a subtree the event never enters, because `.tc-root` is a sibling
on `document.body`. Roughly 29% of the bottom-right quadrant of every blocking
screen silently swallows "TAP TO START", and the rightmost roster card on the
select screen sits under DRIFT.

While `Menus.blocking` is true, every `.tc-*` element gets
`pointer-events: none` and `visibility: hidden`. This is the same class as the
pause menu that permanently ended your race, and it is scored as a hard gate.

### 3.11 Onboarding — under ten seconds, no wall of text

The only touch onboarding today is one line in `.kr-hint` at
`clamp(9px, 1.4vmin, 18px)` — 1.4 vmin is 5.5 px on a 390-tall phone so it
clamps to 9 px — at 44% opacity. 1.5 mm of glyph, naming controls without
showing where they are, while the floating stick is invisible at rest. A
first-run player has no visual evidence a steering control exists.

- **Title screen:** replace the hint line on touch with a glyph row — three
  miniature renderings of the *actual* controls at their actual colours (stick
  ring, DRIFT disc, ITEM disc), each with one word beneath at ≥ 14 px and
  ≥ 0.75 opacity. Same information, nothing to read.
- **First run only:** a ghost stick base and knob breathe at the canonical
  left-thumb rest point (25 mm / 35° from the left pivot) with a small
  left-right sweep. Vanishes permanently on the first touch anywhere. No words.
- **In-race, three beats**, each attached to the control itself, each gated on
  the player actually doing it, each with a hard timeout so it can never block a
  race. No overlay, no dimming, no modal, nothing to dismiss.
  1. **STEER** — during the existing countdown (~3.5 s of dead time). Advances
     on `|steer| > 0.35` held 3 frames, or after 2.5 s.
  2. **DRIFT** — armed on the first corner whose racing-line curvature exceeds
     the drift threshold, or 6 s after GO. The halo pulses. Advances on drift
     held 0.4 s, or after 6 s.
  3. **RELEASE** — the first time tier 1 is banked. The halo goes solid `--cc`
     and the word "LET GO" replaces DRIFT on the button. Advances on a release
     with a tier banked, or on the tier being lost.
- At most **two words on screen at any instant**, all of it printed on the
  control it refers to. Budget: launch → first steering input ≤ 10 s; GO →
  tutorial complete ≤ 12 s of race time. Nothing runs twice.
- The touch/desktop copy switch in `Menus.buildTitle()` must read
  `ctx.input.touch`, not its own `matchMedia` probe, so the documented iPadOS
  "Request Desktop Website" case gets touch copy the moment `Input`'s lazy
  capture-phase mount fires. `tools/touch-lazy-test.mjs` already guards this in
  `TouchControls`; the menu copy was never brought along.

---

## 4. Verification

`npm run build` must pass. `tools/touch-test.mjs`, `tools/touch-lazy-test.mjs`
and `tools/steer-test.mjs` must pass **unmodified** — the 70 px drag in
`touch-test` yields **0.682** under the new geometry, comfortably over its 0.5
assertion, and `released.steer === 0` still holds because the release ramp
completes in ~4 frames of its 20-frame window. `tools/drift-bench.mjs` must stay
within its own stated noise band.

New harnesses: `tools/touch-feel.mjs` (geometry, latency, curve, release,
re-grab, frame-rate independence), `tools/touch-ergo.mjs` (sizing, reach,
SAFE-RECT, occlusion — the pure-CSS render technique, since Chrome cannot
emulate `env(safe-area-inset-*)` and the insets must be textually substituted),
`tools/haptic-bench.mjs`.

Two measurement rules carry over from CLAUDE.md and one is new:

- **Puppeteer must be launched with `--use-gl=angle` for any timing
  measurement**, or headless Chrome silently falls back to a software
  rasteriser and returns a confident, fictional number.
- **Validate the instrument before trusting the reading.** The reach model is an
  instrument (§3.6). So is the occlusion model.
- **New, and it invalidates one of the numbers above.** Lens 1's excellent
  latency probe ran with the race in `RaceState.Menu`, so `Kart.step` never ran
  and `player.steerInput` read 0 throughout. Its 1.7 ms / 1-frame figure is
  **input-path only**; event → *visible kart* latency, through Kart's own rack
  (8.5 → 4.2 units/s, then `smooth(26)`), is unmeasured. Any latency claim in
  this round must be made with the race in `RaceState.Racing` and must read
  `player.steerInput`, not just `input.state.steer`. Reporting the input-path
  number as if it were the response number is exactly the class of error this
  repo has been burned by twice.

---

## 5. Test properties, with baselines

Each row is a pass/fail gate. Baselines are what the code does **today**, so a
regression is visible as a regression rather than as a number nobody can place.

| # | property | pass threshold | today |
|---|---|---|---|
| 1 | Steering survives a thumb roll | After A lifts with heir B down, `\|steer\|` within 0.05 of pre-lift and `steering === true`; B drags 80 px → `\|steer\| > 0.5`, correct sign. No heir → exactly 0 within 2 frames. Heir that never moves → 0 between 100 and 220 ms, not before | steer 0, steering false, and B's 80 px drag still produces 0 |
| 2 | The drawn button fires | 0 mispredicted pixels over a 1 px grid of every visible disc, at 844×390 / 667×375 / 812×375 / 926×428 / 1180×820 / 1024×768, both hands, AUTO on and off | 496/12,637 (3.9%) iPhone 14; 511/11,690 (4.4%) SE |
| 3 | Touch-target floor | `min(w,h) ≥ 46` CSS px and ≥ 7.0 mm for every visible control at every viewport; DRIFT ≥ 10.0 mm; nothing > 18.0 mm | LOOK 42.9 px / 6.4 mm; PAUSE 30×20 px / 4.7×3.1 mm; DRIFT 25.9 mm on iPad mini |
| 4 | Corner→drift separation | ≥ 8.0 CSS px and ≥ 1.30 mm on a ≥ 390 px short edge; ≥ 7.5 px and ≥ 1.20 mm on a 375 px short edge. Analytic curve inverse and a measured 1 px sweep agree within 0.5 px at every sampled output, so the shipped code is what was inverted | 5.20 px / 0.86 mm |
| 5 | Mid-range not paid for | Half-travel output within 0.005 of 0.3990 at every profile | 0.3990 |
| 6 | Analogue precision | ≥ 40 distinct values across the sweep; first non-zero ≤ 6 px; full lock ≤ rGrab + 6 px; ≥ 30% of samples in the 0.15–0.85 band | 60 distinct, 4 px, 64 px, 41/100 |
| 7 | Zero added latency | `state.steer` reflects the event on the first rAF after it in ≥ 39/40 randomised-phase trials; first observed value ≥ 99% of the analytic curve (no first-order tail); **`player.steerInput` non-zero within 2 rAFs, measured in `RaceState.Racing`** | 1.7 ms, 1 frame to `state.steer`; response path unmeasured |
| 8 | Frame-rate independence | Time-to-0.9-of-peak spread ≤ 8 ms across 30/60/120 fps; steer integral within 2% | untested; the digital branch is already linear |
| 9 | Held-value stability | σ ≤ 0.013 and drift ≤ 0.005 over a 3 s hold at 0.5r with ±1 px jitter | ±1 px = ±0.0176 of steer at mid-travel |
| 10 | Release and re-grab | Full lock → 0 in 62.5 ± 10 ms at every frame rate; 20 ms re-grab preserves the ramp value within 0.03 with no inter-frame step > 0.03; 200 ms re-grab starts at exactly 0 | 66.7 ms by accident, untested; re-grab zeroes the command |
| 11 | Full lock reachable everywhere | `max\|steer\| === 1.0` in both directions from every legal spawn (x ∈ {safeLeft+60, 100, 160, 240, 0.46W}, y ∈ {0.35H, 0.65H, H−24}); `rGrab ≥ 56` always; no stick spawns inside the edge guard | reachable, but the guard and the room clamp do not exist |
| 12 | Multi-touch integrity + fuzz | 4 concurrent points all register, steer tracks within 0.01 of the solo value, stray 5th pointer changes steer by 0. After a 200-event fuzz and full release: steer 0, steering/drift/item/active false, brake 0, no `.down` class left | 3 points correct; fuzz untested; D1 is a fuzz failure |
| 13 | ITEM never steals the steering pointer | `\|Δsteer\| ≤ 0.001` for a pointerdown at every pixel of the visible ITEM/BRAKE discs while the stick is live; no pixel produces drift | holds today, must not regress |
| 14 | Every scheme obeys the contract sign | Right-hand input → `steer > 0` **and** a rightward world-heading change, both schemes, both handedness modes. `steer-test.mjs` unmodified | holds; the mirror is the risk |
| 15 | Charge visible under a thumb | ≥ 60% of the halo's lit arc unoccluded by a 14 mm-equivalent thumb disc at every fill ≥ 0.10; the rail's leading cap outside SAFE-RECT-violation, grip band and every `.tc-*` rect at all 20 sampled fills; tier distinguishable by rung count, not hue | rails 100% inside the notch inset on three iPhones; DRIFT covers 18.3 of the right rail's 30 px |
| 16 | Item state survives the modal thumb | ≤ 20% occluded at every sampled landing (25/35/45 mm × 20/35/50/65/80°) | 100% at 25 mm / 35° on iPhone 14 and 15 Pro Max |
| 17 | Nothing gameplay-bearing outside SAFE-RECT | 0% outside for every listed element on every profile; the rails' CSS must *contain* an `env()` term (the failure is an absent number, not a wrong one) | `.kr-charge-e` has no `env()` at all |
| 18 | Assist bounded, never fights a slide | `\|correction\| ≤ 0.22` every frame at A = 0.60; exactly 0 on every frame with `driftDir !== 0`; the player command alone still reaches ±1.0 at least once per lap | no assist exists |
| 19 | Auto-drift is inert at A = 0 | `state.steer` matches a no-assist build **exactly** at 20 sampled deflections; at A = 1 the floor is 0.16 within one frame; at A = 0.5 it is 0.08 ± 0.005 | n/a |
| 20 | Haptics fire on the loop, only on the loop | ≥ 1 pulse within 50 ms of every tier-up and every boost ignite; ≥ 1 for item fire; **0** during a 3 s clean straight; no two starts closer than 45 ms; duty < 12% per rolling 2 s | 0 for tier-up, 0 for boost |
| 21 | Pad never shadows a menu | `elementFromPoint` returns the intended menu control at 100% of sampled points on title/select/results; 0 `.tc-*` with `pointer-events: auto` while blocking; a real tap at DRIFT's position starts the race | ~29% of the bottom-right quadrant is a dead zone |
| 22 | Rotation and viewport churn strand nothing | After entering portrait: steer 0, drift false, every `btn.pointer === -1`. After a 60 px height change mid-drag, all five buttons resolve on the first tap | a pointer keeps driving an invisible stick; `visualViewport` unbound |
| 23 | Preferences persist, and never take the game down | All fields survive a reload. With `setItem` stubbed to throw and with malformed JSON: `__gameReady` still true, no uncaught exception, defaults apply | no persistence of any kind exists |
| 24 | Onboarding once, dismissed by use | Ghost present run 1, absent run 2 (0 tutorial nodes added); each beat dismissed within 0.5 s of its own control's first use; all gone by the first drift release or 12 s; ≤ 2 words on screen at any instant | one 9 px line at 44% opacity |
| 25 | The mirror is geometry only | Every `.tc-*` rect mirrors within 1 px, y unchanged; a rightward drag yields `steer > 0.5` in **both** modes | no mirror exists |

---

## 6. Hard gates

A build that fails any of these is **capped at 45 regardless of everything
else**. These are not weighted; they are pass/fail, and they are here because
each one is the shape of a bug that has already shipped in this repo or that the
lenses reproduced deterministically.

- **G1** `npm run build` passes; `touch-test.mjs`, `touch-lazy-test.mjs` and
  `steer-test.mjs` pass **unmodified**.
- **G2** Exactly one steering negation exists in the codebase, in `Kart.ts`
  (plus `Race.ts`'s AI-side negation at its call site). Test 14 and test 25.
- **G3** No `src/types.ts` diff. No diff in any file owned by the concurrent
  performance workflow.
- **G4** The on-screen pad cannot swallow a menu tap (test 21). A blocking
  screen that cannot be dismissed on a phone is an unstartable game.
- **G5** No second drift carry window. `grep` for a new carry/grace timer near
  drift release and confirm `DRIFT_CARRY_TIME` in `Kart.ts` is still the only
  one.
- **G6** After a 200-event multi-touch fuzz with everything released, no input
  is stuck (test 12). A stuck full-lock steer is a race that cannot be finished.

---

## 7. The bar — scoring out of 100

### Weights

| # | category | weight | what it covers |
|---|---|---|---|
| 1 | **Input state-machine correctness** | 22 | Tests 1, 2, 12, 13, 22. Handover, hit resolution, multi-touch, fuzz, rotation. |
| 2 | **Steering feel and response** | 20 | Tests 4, 5, 6, 7, 8, 9, 10, 11. The corner→drift band, no added latency, no smoothing, monotone curve, owned release, frame-rate independence. |
| 3 | **Reach, sizing and safe areas** | 15 | Tests 3, 11, 17 (interactive half), palm/edge rejection, handedness (25). |
| 4 | **The drift loop, legible under a thumb** | 14 | Tests 15, 16, 17 (gameplay-state half). The halo, the reclaimed rails, rung-count-not-hue, the item plate. |
| 5 | **Assists** | 8 | Tests 18, 19. Bounded, graded, inert at zero, never fights a slide. |
| 6 | **Haptics** | 8 | Test 20. |
| 7 | **Onboarding and first run** | 7 | Test 24. |
| 8 | **Persistence and integration** | 6 | Tests 21, 23. |

Every category is scored against **measurements**, not against the diff. "The
code looks like it does this" is worth zero. If the harness for a category was
not run, that category scores **0**, not "assume it's fine" — a category with no
reading is a category with no evidence, and this project has already lost a full
round to confident numbers from an instrument nobody validated.

### Calibration bands

**40 — the defects are fixed and nothing else is.** D1, D2 and D3 are gone; the
build and the three existing harnesses pass. The stick is untouched, so the
corner→drift band is still 0.95 mm and committing to a slide is still a coin
flip made by skin. The charge rails are still under the notch. No haptics on the
loop. No persistence, no onboarding, no left hand. This is a real improvement
over today and it is a **failing grade**, because the game's stated top priority
— the drift→boost loop — is exactly as hard to execute and exactly as invisible
as it was before.

**60 — competent.** Everything at 40, plus the steering geometry landed with the
half-travel proof intact (tests 4, 5, 6 pass together — one without the others
means the mid-range was quietly sold to buy the band, and that scores below 60,
not above it). Release and re-grab are owned and tested. Haptics fire on tier-up
and boost within their duty budget. The rails carry an `env()` term. The pad no
longer shadows the menus. What is missing at 60: the halo, the item plate move,
onboarding, persistence, assists. A player who already knows this game will find
it clearly better. A player meeting it for the first time on a phone will still
not discover that a steering control exists.

**75 — good, and shippable.** Everything at 60, plus the halo and the reclaimed
rails pass tests 15 and 16 on every profile in the matrix, so a player can read
their own mini-turbo while their thumb is on the button that earned it. Assists
exist, are graded, and are provably inert at zero. Preferences persist through a
reload and through a `setItem` that throws. Onboarding gets a first-time player
steering within ten seconds without a wall of text. Every hard gate green. This
is the honest target for one round of work and **most good submissions should
land here.**

**90 — the bar.** Everything at 75, at every viewport in the matrix, in both
handedness modes, with AUTO on and off — no profile-specific exceptions, no "it
fails only on the SE". The response-path latency is measured in
`RaceState.Racing` against `player.steerInput`, not just the input path, and the
number is honest about what it includes. The reach and occlusion models were
calibrated against real hands before their readings were used. Frame-rate
independence is demonstrated at 30, 60 and 120 fps rather than asserted. The
fuzz runs clean. Every new constant carries a comment saying what it was
measured against and what it would break if changed. Someone reading the diff a
year from now can tell which lines are guards.

**Above 90** requires a finding the three lenses missed and a harness that
proves it — not more polish on what they found.

### A warning to the scorer

**Generous scoring produces worse controls.** That is not a figure of speech in
this repo. Inverted steering, unusable mobile controls and a pause menu that
permanently ended your race all survived *three full rounds of six reviewers*,
every one of whom was looking at a beautiful screenshot and feeling positive
about it. The reviewers were not lazy. They were generous, and generosity is
indistinguishable from blindness at the point where it matters.

Concretely:

- **If you are inclined to give 85, look harder.** 85 means "everything at 75
  plus most of 90", and the gap between 75 and 90 is almost entirely made of
  things that are invisible unless you go and check: every viewport rather than
  the one in the screenshot, both handedness modes, the *response* path rather
  than the input path, the calibration of the instrument rather than its output.
  Find the one that was not checked. There is almost always one, and if you
  cannot name which of those you verified, the score is 75.
- **A screenshot cannot find any defect in this document.** Not one. D1 is a
  two-finger sequence, D2 is a 1 px grid scan, the haptic bug is a stubbed
  `navigator.vibrate`, the menu-shadowing bug is `elementFromPoint`. If your
  evidence for a category is that a PNG looks right, that category scores 0.
- **A category with no harness reading scores 0, not the benefit of the doubt.**
  "The implementation looks correct" is the sentence that precedes every
  regression in this repo's history.
- **A number from a software rasteriser is fiction.** Any timing claim must come
  from a run launched with `--use-gl=angle`, and the scorer should ask to see
  that it was.
- **Partial credit within a category is fine; partial credit across a paired
  test is not.** Tests 4, 5 and 6 are one claim in three parts — the band was
  widened *without* selling the mid-range. Passing 4 alone is not two-thirds of
  the point; it is evidence of the failure the earlier `CURVE = 1.35` round
  already made.
- **Score the reading, not the intent.** A spec section implemented thoroughly
  but never measured is worth less than a smaller change with a harness behind
  it. The harnesses are more the point of this repo than the game is.

---

## 8. Build order

Most important first. Ordered by (damage done today) × (confidence it is real),
then by what unblocks what. Items 1–5 are defects reproduced deterministically;
6–10 are the loop; 11–15 are the polish that makes it a product.

1. **D1 — steering handover.** Build `transplantOrigin()` first (§2.9); it is
   the primitive that items 1, 4 and 12 all consume. A rolled thumb currently
   kills steering until you lift, and it is deterministic.
2. **G4 — hide `.tc-*` while `Menus.blocking`.** One-line class toggle, removes
   a ~29% dead zone from every blocking screen, and is the same class as the
   pause menu that permanently ended your race. Cheapest high-severity fix in
   the list.
3. **D2 — visible-disc-wins hit resolution + gap-derived pad.** 3.9–4.4% of the
   drawn cluster fires the wrong button today, worst on the smallest phone, and
   it is worst *on a straight* where DRIFT is not held.
4. **Stick geometry.** `STICK_RADIUS`, absolute `DEADZONE_PX`, `CURVE = 1.26`,
   `rGrab` room clamp, spawn rectangle (§2.8's arithmetic), ring/knob visual
   decoupling, origin clamp, saturation shelf, arc latch. Land the half-travel
   proof and tests 4/5/6 in the same commit — they are one claim.
5. **D3 + safe areas + `env()` on the rails.** The 46 px floor, the clamp-based
   sizing, SAFE-RECT and CORNER-EXCLUSION, edge and palm rejection,
   `visualViewport` binding, portrait force-release. The rails' missing `env()`
   goes here rather than in item 7 because it is a one-line CSS fix that
   currently hides the ladder completely on three shipping iPhones.
6. **Haptics.** Split `pulse()` from `haptic()`, delete the `strong > 0.55`
   gate, the eight-row table, the 45 ms gap and the 12% duty budget. Small,
   isolated, and it restores feedback on the two events the whole game is built
   around.
7. **The halo + the shortened rails + the item plate move.** `HUD.ts` publishes
   `--fill`/`--cc`/`--cn` on `documentElement`; the touch CSS consumes them.
   Rung count, not hue. This is what makes the drift ladder legible with a thumb
   on the button that earns it.
8. **Release ramp and re-grab.** Behaviour-neutral by design (the measured
   66.7 ms is preserved exactly) — its value is that the number becomes stated,
   tested and re-grabbable instead of an accident of a fallthrough. Ranked here
   rather than higher precisely because it changes nothing a player can feel
   today; it changes what a future commit can break.
9. **`ControlPrefs.ts` + persistence.** Unblocks 10, 11 and 13. Fail-safe,
   version-stamped, try/catch on every access.
10. **Assists.** Steering assist in `Input.update()` (§3.9) and the drift steer
    floor. Both default-on at their middle setting on touch, both provably inert
    at zero.
11. **Left-handed mirror.** One attribute, one mirrored CSS block, geometry
    only. Test 25 is the guard against someone "completing" the mirror with a
    second negation.
12. **Fixed-stick scheme + `setScheme()`.** Same code path, frozen origin, no
    trailing, `DEADZONE_PX = 6`. Teardown must be safe mid-race.
13. **Onboarding.** Glyph row, first-run ghost stick, three in-race beats gated
    on use with hard timeouts, and the `ctx.input.touch` fix in
    `Menus.buildTitle()`.
14. **AUTO chip → pre-race only, persisted.** PAUSE → a 46 px circle in the top
    corner inside SAFE-RECT.
15. **iPad cluster max-inset.** Anchor to 58 mm-equivalent from the pivot rather
    than to the frame corner, so LOOK stops sitting at 66 mm.

Explicitly **not** this round: tilt and lean-zone schemes, a sensitivity slider,
TouchDrive-style lane picking, and the iOS checkbox haptic trick. Reasons in
§2.2, §3.9, §2.2 and §2.6 respectively. Each is a decision, not an omission, and
none of them is foreclosed by anything above.
