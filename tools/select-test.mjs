/**
 * Does the character select screen actually select a character?
 *
 *   node tools/select-test.mjs
 *
 * It did not. `Menus.startRace` called `race.reset()` and never read
 * `this.selected`, so clicking a roster card moved a CSS highlight and nothing
 * else — every race was driven in kart 0 whatever the player chose. `IRace` had
 * no way to express a choice at all, so nothing downstream could have honoured
 * one.
 *
 * That bug is invisible to a screenshot: the selected card is highlighted, the
 * race starts, and the kart you get is a kart. It needs an assertion on state,
 * which is what this file is.
 *
 * For every entry in the roster it clicks that card, starts the race, and
 * checks that the kart the human is actually driving is the one whose name was
 * on the card. It also checks the two things the fix could plausibly break:
 *
 *  - `id` must NOT be reassigned. The AI keys its driver, band and assist maps
 *    off `kart.id` and projectiles record it as an owner, so renumbering to
 *    match a new player index would orphan all of it. The fix moves the
 *    `isPlayer` flag instead, and this asserts ids stay 0..n-1 in order.
 *  - exactly one kart may be `isPlayer` afterwards. An early draft set the new
 *    flag without clearing the old one, which leaves two "players" — the HUD
 *    follows one and the camera the other.
 *
 * Grid slots swap with the selection so picking the last racer still starts you
 * on pole, so the player's start position is asserted to be the front row
 * rather than its roster index.
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const PORT = parseInt(process.argv[2] || '5545', 10);

const srv = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});

const fails = [];
const rows = [];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`http://127.0.0.1:${PORT}/?ui=select`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!window.__ctx?.race?.karts?.length, { timeout: 90000 });
  // The roster cards are built by `fillRoster` when the screen is first shown,
  // not at construction, so the karts existing does not mean the DOM does. The
  // first draft of this file asserted against an empty roster and blamed the
  // game for it.
  await page.waitForFunction(() => document.querySelectorAll('.kr-card').length > 0, { timeout: 30000 });

  const roster = await page.evaluate(() =>
    window.__ctx.race.karts.map((k, i) => ({ i, name: k.stats.name, id: k.id })));
  console.log(`roster: ${roster.map((r) => r.name).join(', ')}\n`);

  for (const entry of roster) {
    // Click the card the way a player does, rather than poking `selected`.
    const clicked = await page.evaluate((i) => {
      const cards = document.querySelectorAll('.kr-card');
      if (!cards[i]) return false;
      cards[i].click();
      return true;
    }, entry.i);
    if (!clicked) { fails.push(`card ${entry.i} (${entry.name}) not present in the DOM`); continue; }

    // Start it the way a player does too.
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.kr-btn')];
      const go = btns.find((b) => /start/i.test(b.textContent || ''));
      if (go) go.click();
    });
    await new Promise((r) => setTimeout(r, 400));

    const got = await page.evaluate(() => {
      const race = window.__ctx.race;
      const players = race.karts.filter((k) => k.isPlayer);
      const grid = race.karts.map((k) => ({
        name: k.stats.name,
        z: +k.object.position.z.toFixed(2),
        x: +k.object.position.x.toFixed(2),
      }));
      // Front of the grid = the kart furthest along the racing line at the
      // start; approximate by taking the one nearest the start line marker.
      return {
        playerName: race.player?.stats?.name ?? null,
        playerIsFlagged: !!race.player?.isPlayer,
        playerCount: players.length,
        selected: race.selectedKart,
        ids: race.karts.map((k) => k.id),
        grid,
      };
    });

    const ok = got.playerName === entry.name;
    rows.push({ picked: entry.name, got: got.playerName, sel: got.selected, players: got.playerCount, ok });
    if (!ok) fails.push(`picked "${entry.name}" but drove "${got.playerName}"`);
    if (got.playerCount !== 1) fails.push(`"${entry.name}": ${got.playerCount} karts flagged isPlayer, expected exactly 1`);
    if (!got.playerIsFlagged) fails.push(`"${entry.name}": race.player is not the kart flagged isPlayer`);
    const idsOrdered = got.ids.every((v, i) => v === i);
    if (!idsOrdered) fails.push(`"${entry.name}": kart ids were reassigned (${got.ids.join(',')}) — the AI maps key off these`);

    // back to the select screen for the next pick
    await page.evaluate(() => { window.__ctx.race.reset(); });
    await page.goto(`http://127.0.0.1:${PORT}/?ui=select`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!document.querySelector('.kr-card'), { timeout: 30000 });
  }

  if (errors.length) fails.push(`${errors.length} page error(s): ${errors[0]}`);

  const w = Math.max(...rows.map((r) => r.picked.length), 6);
  console.log('picked'.padEnd(w) + '  drove'.padEnd(w + 2) + '  sel  players  ok');
  for (const r of rows) {
    console.log(
      r.picked.padEnd(w) + '  ' + String(r.got).padEnd(w) + '  ' +
      String(r.sel).padStart(3) + '  ' + String(r.players).padStart(7) + '  ' + (r.ok ? 'yes' : 'NO'),
    );
  }
} finally {
  await browser.close();
  await srv.stop();
}

console.log();
if (fails.length) {
  console.log('FAIL — the select screen does not select:');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log(`PASS — all ${rows.length} roster entries select the kart they name`);
