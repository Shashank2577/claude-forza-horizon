# Critic Protocol — Blind Visual Judgment

Each round, a FRESH-CONTEXT critic agent (never the builder) judges the game.

## Procedure

1. Open http://localhost:5180/ in Chrome (chrome-devtools MCP).
2. Wait for load; click "PRESS ENTER — ROAD RACE".
3. Capture 6 screenshots minimum:
   - a. Start line / festival hub (car at rest)
   - b. Mid-race chase cam at speed (>100 km/h — hold throttle ~5s)
   - c. Looking toward horizon/mountains (camera cycle with C if needed)
   - d. Close-up of hero car (drive near camera or use __game.teleport)
   - e. Road surface detail (markings, curbs)
   - f. Off-track vista (terrain, trees, water/settlements if visible)
4. For each shot, compare against your knowledge of Forza Horizon 5's
   actual visual language (Mexico setting, golden hour, festival aesthetic).

## Verdict format

For EACH shot: "FH5 vs OURS" one-line blind verdict — which looks better and why.
Then overall:

- VERDICT: PASS | FAIL
- If FAIL: kill-list of the top ≤6 concrete visual defects, ordered by impact,
  each phrased as an actionable fix ("terrain reads as flat green paint — add
  splat variation + dirt shoulders", not "terrain is bad").
- Score: X/10 vs FH5.

Be harsh. A passing grade means: side by side, a player would not immediately
embarrass us. Flat colors, blob geometry, glowing lines, floating props, dead
lighting = instant FAIL.
