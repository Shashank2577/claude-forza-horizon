/**
 * Texture inventory probe — deterministic, load-independent.
 *
 * Walks the scene (plus the kart livery/material caches, which hang off no
 * mesh) and tallies every unique texture by dimensions, format and owner, so a
 * change to one subsystem's maps can be reported as MB rather than as a guess.
 *
 *   node tools/tex-probe.mjs --port 5512 --label before
 *
 * Deliberately reports no milliseconds. Counting bytes is safe under load;
 * timing is not.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const root = new URL('..', import.meta.url).pathname;
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const PORT = parseInt(arg('port', '5173'), 10);
const LABEL = arg('label', 'run');
const OUT = join(root, arg('out', 'shots/perf'));

const INSTALL = () => {
  const ctx = window.__ctx;
  const seen = new Map();

  const bytesOf = (t) => {
    const img = t.image || {};
    const w = img.width || t.source?.data?.width || 0;
    const h = img.height || t.source?.data?.height || 0;
    if (!w || !h) return { w: 0, h: 0, bytes: 0 };
    // Every map in this game is 8-bit RGBA unless it says otherwise, and three
    // uploads a full mip chain whenever the filter asks for one (+1/3).
    const half = t.type === 1016 /* HalfFloatType */ ? 2 : 1;
    const mip = (t.minFilter === 1003 || t.minFilter === 1006) ? 1 : 4 / 3;
    const faces = t.isCubeTexture ? 6 : 1;
    return { w, h, bytes: w * h * 4 * half * mip * faces };
  };

  const note = (t, owner) => {
    if (!t || !t.isTexture) return;
    if (seen.has(t.uuid)) { seen.get(t.uuid).owners.add(owner); return; }
    const b = bytesOf(t);
    seen.set(t.uuid, { ...b, owners: new Set([owner]), name: t.name || '', type: t.constructor.name });
  };

  const SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
    'alphaMap', 'bumpMap', 'displacementMap', 'clearcoatMap', 'clearcoatNormalMap',
    'clearcoatRoughnessMap', 'sheenColorMap', 'specularMap', 'lightMap', 'envMap',
    'transmissionMap', 'thicknessMap', 'iridescenceMap', 'anisotropyMap'];

  const eatMaterial = (m, owner) => {
    if (!m) return;
    for (const mm of Array.isArray(m) ? m : [m]) {
      for (const s of SLOTS) note(mm[s], owner);
      if (mm.uniforms) for (const k in mm.uniforms) note(mm.uniforms[k]?.value, owner + ':' + k);
    }
  };

  // Which top-level scene child a mesh hangs under — the same bucketing
  // tools/perf.mjs uses, so the two reports can be read side by side.
  const topOf = (o) => {
    let n = o, top = o;
    while (n && n.parent) { if (n.parent === ctx.scene) top = n; n = n.parent; }
    return top.name || top.type;
  };

  ctx.scene.traverse((o) => {
    if (o.material) eatMaterial(o.material, topOf(o));
    if (o.customDepthMaterial) eatMaterial(o.customDepthMaterial, topOf(o) + '/depth');
    // The two impostor poses live in userData and hang off no mesh.
    for (const k of ['impostorMat', 'shadowOnlyMat']) {
      if (o.userData?.[k]) eatMaterial(o.userData[k], topOf(o) + '/' + k);
    }
    if (o.userData?.livery?.decal) note(o.userData.livery.decal, topOf(o) + '/liveryDecal');
    if (o.userData?.livery?.decalMat) eatMaterial(o.userData.livery.decalMat, topOf(o) + '/liveryDecalMat');
  });
  note(ctx.scene.environment, 'scene.environment');
  note(ctx.scene.background, 'scene.background');

  let total = 0;
  const rows = [];
  for (const [uuid, e] of seen) {
    total += e.bytes;
    rows.push({ uuid, w: e.w, h: e.h, mb: e.bytes / 1048576, owners: [...e.owners], type: e.type });
  }
  rows.sort((a, b) => b.mb - a.mb);

  const kartish = (r) => r.owners.some((o) => /kart_|livery|Impostor|impostorMat|shadowOnlyMat/i.test(o));


/**
 * Re-clusters the first kart's impostor at a range of cell sizes, so the
 * reduction-vs-coarseness curve can be read in one page load instead of one
 * browser launch per point. Mirrors KartModel.clusterDecimate exactly, colour
 * bucket included; run against an already-clustered mesh it reports the curve
 * relative to whatever cell that mesh was built at, which is what choosing the
 * next value needs.
 */
function sweep() {
  let geo = null;
  ctx.scene.traverse((o) => { if (!geo && o.name === 'kartImpostor') geo = o.geometry; });
  if (!geo) return [];
  const pos = geo.getAttribute('position').array;
  const col = geo.getAttribute('color').array;
  const idx = geo.getIndex().array;
  const n = pos.length / 3;
  const out = [];
  const bucketOn = [true, false];
  for (const useTint of bucketOn) {
    for (const cell of [0.03, 0.04, 0.05, 0.06, 0.08, 0.10]) {
      let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -1e9, mxy = -1e9, mxz = -1e9;
      for (let i = 0; i < n; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
        if (z < mnz) mnz = z; if (z > mxz) mxz = z;
      }
      const inv = 1 / cell;
      const nx = Math.max(1, Math.floor((mxx - mnx) * inv) + 1);
      const ny = Math.max(1, Math.floor((mxy - mny) * inv) + 1);
      const b = (c) => { const q = Math.sqrt(Math.min(1, Math.max(0, c))) * 3.999; return q | 0; };
      const map = new Int32Array(n);
      const keys = new Map();
      let m = 0;
      for (let i = 0; i < n; i++) {
        const cx = Math.floor((pos[i * 3] - mnx) * inv);
        const cy = Math.floor((pos[i * 3 + 1] - mny) * inv);
        const cz = Math.floor((pos[i * 3 + 2] - mnz) * inv);
        const tint = useTint
          ? (b(col[i * 3]) << 4) | (b(col[i * 3 + 1]) << 2) | b(col[i * 3 + 2]) : 0;
        const key = ((cz * ny + cy) * nx + cx) * 64 + tint;
        let c = keys.get(key);
        if (c === undefined) { c = m++; keys.set(key, c); }
        map[i] = c;
      }
      let tris = 0;
      for (let i = 0; i + 2 < idx.length; i += 3) {
        const a = map[idx[i]], bb = map[idx[i + 1]], d = map[idx[i + 2]];
        if (a === bb || bb === d || a === d) continue;
        tris++;
      }
      out.push({ cell, tint: useTint, verts: m, tris });
    }
  }
  return { from: { verts: n, tris: idx.length / 3 }, points: out };
  }

  return {
    count: rows.length,
    totalMB: total / 1048576,
    kartMB: rows.filter(kartish).reduce((s, r) => s + r.mb, 0),
    kartCount: rows.filter(kartish).length,
    glTextures: ctx.renderer.info.memory.textures,
    glGeometries: ctx.renderer.info.memory.geometries,
    programs: ctx.renderer.info.programs?.length ?? 0,
    rows: rows.slice(0, 60),
    karts: (window.__kartShadow?.report?.() ?? []),
    cellSweep: sweep(),
  };
};

const main = async () => {
  const server = await startVite(PORT);
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--enable-webgl',
      '--ignore-gpu-blocklist', '--window-size=1280,720', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${PORT}/?quality=ultra`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__gameReady === true', { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 2500));
  const res = await page.evaluate(INSTALL);

  console.log(`\n${LABEL}: ${res.count} unique textures, ${res.totalMB.toFixed(1)} MB`);
  console.log(`  kart-side: ${res.kartCount} textures, ${res.kartMB.toFixed(2)} MB`);
  console.log(`  gl objects: textures=${res.glTextures} geometries=${res.glGeometries} programs=${res.programs}`);
  console.log('  largest:');
  for (const r of res.rows.slice(0, 22)) {
    console.log(`    ${r.mb.toFixed(2).padStart(6)} MB  ${String(r.w).padStart(4)}x${String(r.h).padEnd(4)}  ${r.owners.slice(0, 3).join(', ').slice(0, 90)}`);
  }
  if (res.karts.length) {
    console.log(`  impostor tris: ${res.karts.map((k) => k.impostorTris).join(', ')}`);
  }
  writeFileSync(join(OUT, `tex-${LABEL}.json`), JSON.stringify(res, null, 2));
  await browser.close();
  await server.stop();
};

main().catch((e) => { console.error(e); process.exit(1); });
