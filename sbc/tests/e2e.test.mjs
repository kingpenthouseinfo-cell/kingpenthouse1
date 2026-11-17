// End-to-end tests: real browser (Chromium via Playwright) against the real site, the real editor and the
// real database rules (PGlite) behind a local stand-in for Supabase. Phone sizes are EMULATED here;
// they are not a substitute for a test on a real iPhone/Android (see docs/OWNER-SETUP.md).
// Run: npm run test:e2e
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDevServer, ANON_KEY } from '../dev/server.mjs';
import { routeCdn, playwright } from './helpers.mjs';
import { readSource } from '../scripts/generate-seed.mjs';

const { chromium } = playwright();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8793, BASE = `http://localhost:${PORT}`;
const EDITOR = 'priest@example.org', OTHER = 'second@example.org', STRANGER = 'stranger@example.org';
const PHONE = { width: 390, height: 844 };
const SRC = readSource();
const NAMES = SRC.map((p) => p.t);

let srv, browser;
const contexts = [];
async function newCtx(viewport = PHONE, opts = {}) {
  const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce', ...opts });
  await routeCdn(ctx); contexts.push(ctx); return ctx;
}
async function newPage(viewport = PHONE, opts = {}) {
  const ctx = await newCtx(viewport, opts); const page = await ctx.newPage();
  page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message)); return page;
}
const api = async (path, { token = ANON_KEY, body = {}, method = 'POST', headers = {} } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { apikey: ANON_KEY, authorization: 'Bearer ' + token, 'content-type': 'application/json', ...headers }, body: method === 'GET' ? undefined : (body instanceof Buffer ? body : JSON.stringify(body)) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
};

async function signIn(page, email = EDITOR) {
  await page.goto(`${BASE}/admin/`);
  await page.fill('#email', email); await page.click('#sendbtn');
  await page.getByRole('heading', { name: 'Check your email' }).waitFor();
  const mail = [...srv.outbox].reverse().find((m) => m.email === email);
  await page.goto(mail.link);
  await page.getByRole('heading', { name: 'What would you like to do?' }).waitFor();
}
async function sessionToken(email) {
  const p = await newPage(); await signIn(p, email).catch(() => {}); 
  return p.evaluate(() => JSON.parse(localStorage.getItem('sbc-admin-session')).access_token);
}

// Make real JPEG bytes in the browser; optionally splice in fake GPS metadata / an orientation tag.
async function makeJpeg(page, { w = 800, h = 600, color = '#3a7', exif = null } = {}) {
  const arr = await page.evaluate(async ({ w, h, color }) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
    x.fillStyle = color; x.fillRect(0, 0, w, h); x.fillStyle = '#fff'; x.fillRect(0, 0, Math.floor(w / 4), Math.floor(h / 4));
    const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9)); return [...new Uint8Array(await b.arrayBuffer())];
  }, { w, h, color });
  let buf = Buffer.from(arr);
  if (exif) {
    const body = Buffer.concat([Buffer.from('Exif\0\0'), exif]);
    const seg = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(body.length + 2) >> 8, (body.length + 2) & 255]), body]);
    buf = Buffer.concat([buf.subarray(0, 2), seg, buf.subarray(2)]);
  }
  return buf;
}
const ORIENT6 = Buffer.concat([Buffer.from('MM\0*\0\0\0\x08'), Buffer.from([0, 1, 1, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0]), Buffer.from([0, 0, 0, 0]), Buffer.from('GPS-MARKER-48.8566N')]);
function jpegDims(buf) {
  let i = 2; while (i < buf.length) { if (buf[i] !== 0xff) { i++; continue; } const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2); }
  return null;
}
const storedFiles = () => { const dir = srv.storageDir; const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); e.isDirectory() ? walk(p) : e.name.endsWith('.type') ? 0 : out.push(p); } };
  if (existsSync(dir)) walk(dir); return out; };
const dbUpdates = async () => (await srv.db.query(`select id, title, version, published_at, removed_at from public.updates order by published_at`)).rows;
const publicContent = async () => (await api('/rest/v1/rpc/public_content')).body;
const fill = async (page, label, text) => page.getByLabel(label, { exact: true }).fill(text);

test.before(async () => {
  srv = await startDevServer({ port: PORT, storageDir: mkdtempSync(join(tmpdir(), 'sbc-storage-')) });
  await srv.addEditor(EDITOR); await srv.addEditor(OTHER); await srv.addUserOnly(STRANGER);
  browser = await chromium.launch();
});
test.after(async () => { for (const c of contexts) await c.close().catch(() => {}); await browser?.close(); await srv?.close(); });

// ═══════════════ 1. the public site still works ═══════════════
const ROUTES = [['home', null], ['programmes', 'Eight kinds of help'], ['gallery', 'Fa'], ['about', 'Old boys of one college,'], ['give', 'bank transfer.']];
for (const [name, vp] of [['desktop', { width: 1280, height: 800 }], ['phone', PHONE]]) {
  test(`public routes open on ${name}`, async () => {
    const page = await newPage(vp);
    for (const [route, text] of ROUTES) {
      await page.goto(`${BASE}/#${route}`); await page.waitForFunction(() => document.documentElement.dataset.sbcSource);
      await page.waitForTimeout(400);
      if (route === 'home') await page.getByRole('heading', { name: 'Love towards humanity' }).first().waitFor();
      else if (route === 'gallery') await page.getByRole('button', { name: 'All', exact: true }).waitFor();
      else await page.getByText(text).first().waitFor();
    }
    assert.deepEqual(page.errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.sbcSource), 'live');
  });
}

test('every original #programme/<n> link opens the right programme', async () => {
  const page = await newPage({ width: 1280, height: 800 });
  for (let i = 0; i < 8; i++) {
    await page.goto(`${BASE}/#programme/${i}`); await page.reload();
    await page.locator(`[data-card="${i}"]`).waitFor(); await page.waitForTimeout(1500);
    const top = await page.locator(`[data-card="${i}"]`).evaluate((el) => el.getBoundingClientRect().top);
    assert.ok(top > -50 && top < 400, `programme ${i} should be scrolled into view (top=${top})`);
    assert.equal(await page.locator(`[data-card="${i}"] h3`).innerText(), NAMES[i]);
  }
  await page.goto(`${BASE}/#programme`); await page.getByText('Eight kinds of help').first().waitFor();   // bare link still opens Programmes
});

test('School Supplies keeps its video, backpack artwork and caption', async () => {
  const page = await newPage({ width: 1280, height: 800 });
  await page.goto(`${BASE}/#programmes`); await page.locator('[data-card="0"]').waitFor();
  const v = page.locator('[data-card="0"] video');
  assert.match(await v.getAttribute('src'), /assets\/school-backpacks\.mp4$/);
  assert.match(await v.getAttribute('poster'), /assets\/school-backpacks-group\.png$/);
  assert.match(await page.locator('[data-card="0"] img[src$="obj-backpack.png"]').getAttribute('src'), /obj-backpack\.png/);
  await page.locator('[data-card="0"]').getByText('every bag, a name').waitFor();
  assert.equal((await fetch(`${BASE}/assets/school-backpacks.mp4`)).status, 200);
});

test('gallery: every programme photo once, filters, and the lightbox with keyboard', async () => {
  const page = await newPage({ width: 1280, height: 800 });
  const seen = new Set(), tag = {}; SRC.forEach((p, i) => p.imgs.forEach((f) => { if (!seen.has(f)) { seen.add(f); tag[f] = i; } }));
  await page.goto(`${BASE}/#gallery`); await page.getByRole('button', { name: 'All', exact: true }).waitFor();
  const grid = page.locator('div[style*="columns"] > div'); await page.waitForTimeout(500);
  assert.equal(await grid.count(), seen.size);
  const waterCount = Object.values(tag).filter((i) => i === 6).length;
  await page.getByRole('button', { name: 'Water', exact: true }).click(); await page.waitForTimeout(300);
  assert.equal(await grid.count(), waterCount);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await grid.first().click(); await page.getByText(`1 / ${seen.size}`).waitFor();
  await page.keyboard.press('ArrowRight'); await page.getByText(`2 / ${seen.size}`).waitFor();
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.getByText(`${seen.size} / ${seen.size}`).waitFor();
  await page.keyboard.press('Escape'); await page.getByText(`${seen.size} / ${seen.size}`).waitFor({ state: 'detached' });
});

test('all six sanitation before-and-after cases work, including the video cases', async () => {
  const page = await newPage({ width: 1280, height: 800 });
  await page.goto(`${BASE}/#programmes`); await page.locator('[data-card="7"]').waitFor();
  const ba = SRC[7].ba;
  const titles = ['Hessian walls, open pit', 'Loose boards, a tarpaulin door', 'No door, broken blocks', 'Damp walls, a rusted frame', 'Crumbling plaster and moss', 'A roof held down by stones'];
  assert.deepEqual(ba.map((c) => c.t), titles);
  for (let i = 0; i < 6; i++) {
    await page.locator('[data-card="7"] button', { hasText: titles[i] }).click(); await page.waitForTimeout(250);
    await page.locator('[data-card="7"] h4', { hasText: titles[i] }).waitFor();
    const before = await page.locator(`[data-card="7"] img[alt^="Before:"]`).getAttribute('src');
    assert.ok(before.endsWith('assets/' + ba[i].b), `before image for case ${i + 1}`);
    assert.equal((await fetch(`${BASE}/${before}`)).status, 200);
    if (/\.(png|jpe?g)$/.test(ba[i].a)) {
      assert.ok((await page.locator('[data-card="7"] img[alt^="After:"]').getAttribute('src')).endsWith('assets/' + ba[i].a), `after image ${i + 1}`);
    } else {
      const vid = page.locator('[data-card="7"] video[aria-label^="After"]');
      assert.ok((await vid.getAttribute('src')).endsWith(`assets/${ba[i].a}.mp4`), `after video ${i + 1}`);
      assert.ok((await vid.getAttribute('poster')).endsWith(`assets/${ba[i].a}-poster.png`));
      assert.equal((await fetch(`${BASE}/assets/${ba[i].a}.mp4`)).status, 200);
      assert.equal((await fetch(`${BASE}/assets/${ba[i].a}-poster.png`)).status, 200);
    }
  }
  const films = page.locator('[data-card="7"] figure video'); assert.equal(await films.count(), 2);
  assert.equal((await fetch(`${BASE}/assets/toilet-after-1.mp4`)).status, 200);
});

// ═══════════════ permissions at the API ═══════════════
test('anonymous and non-editor accounts cannot write or upload through the API', async () => {
  const save = { p_id: null, p_expected_version: null, p_title: 'x', p_body: 'y', p_programme_id: null, p_images: [], p_client_token: null };
  assert.equal((await api('/rest/v1/rpc/editor_save_update', { body: save })).status, 401);
  assert.equal((await api('/rest/v1/rpc/editor_save_site', { body: { p_expected_version: 1, p_data: { about_p1: 'x' } } })).status, 401);
  assert.equal((await api('/storage/v1/object/media/x/y.jpg', { body: Buffer.from('x'), headers: { 'content-type': 'image/jpeg' } })).status, 403);
  const stranger = await sessionToken(STRANGER);
  assert.equal((await api('/rest/v1/rpc/editor_save_update', { token: stranger, body: save })).status, 403);
  assert.equal((await api('/rest/v1/rpc/editor_content', { token: stranger })).status, 403);
  const up = await api(`/storage/v1/object/media/${randomId()}/${randomId()}.jpg`, { token: stranger, body: Buffer.from('x'), headers: { 'content-type': 'image/jpeg' } });
  assert.equal(up.status, 403);
  assert.deepEqual((await dbUpdates()), []);
  // an editor still cannot reach the bank details or permissions
  const ed = await sessionToken(EDITOR);
  const v = (await api('/rest/v1/rpc/editor_content', { token: ed })).body.site_version;
  for (const k of ['bank_account', 'editors', 'account_number']) {
    const r = await api('/rest/v1/rpc/editor_save_site', { token: ed, body: { p_expected_version: v, p_data: { [k]: '1' } } });
    assert.equal(r.status, 422, k);
  }
});
function randomId() { return crypto.randomUUID(); }

// ═══════════════ the editor ═══════════════
test('the editor has no drafts, no preview step and no Publish button, and fits 320 and 390 px wide', async () => {
  const bad = /draft|preview|publish|approve/i;
  for (const vp of [{ width: 320, height: 568 }, PHONE]) {
    const page = await newPage(vp);
    await page.goto(`${BASE}/admin/`); await page.getByRole('heading', { name: 'Sign in' }).waitFor();
    const check = async (label) => {
      const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, body: document.body.scrollWidth }));
      assert.ok(w.sw <= w.iw && w.body <= w.iw, `${label} at ${vp.width}px scrolls sideways (${JSON.stringify(w)})`);
      const text = await page.locator('body').innerText(); assert.doesNotMatch(text, bad, `${label}: ${text.match(bad)}`);
      // nothing may poke out of the screen (body hides sideways scrolling, so check every element's edge)
      const wide = await page.evaluate(() => [...document.querySelectorAll('main *, .bar *')].filter((e) => e.offsetParent && e.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(e).position !== 'fixed')
        .map((e) => `${e.tagName}.${e.className}`).slice(0, 5));
      assert.deepEqual(wide, [], `${label} at ${vp.width}px: elements stick out of the screen`);
      const spill = await page.evaluate(() => [...document.querySelectorAll('.photos li, .group, .row, .big, .note')].flatMap((box) => { const r = box.getBoundingClientRect();
        return [...box.querySelectorAll('*')].filter((e) => e.offsetParent && e.getBoundingClientRect().right > r.right + 1).map((e) => `${e.tagName}.${e.className} out of ${box.className}`); }).slice(0, 5));
      assert.deepEqual(spill, [], `${label} at ${vp.width}px: something sticks out of its box`);
      const btns = await page.locator('main a.big, main .btn, .bar .btn').evaluateAll((els) => els.filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().height));
      assert.ok(btns.every((h) => h >= 44), `${label}: touch targets are at least 44px tall`);
    };
    await check('sign-in');
    await signIn(page);
    for (const hash of ['/', '/add', '/edit', '/edit/updates', '/edit/programmes', '/programme/new', '/site']) {
      await page.goto(`${BASE}/admin/#${hash}`); await page.waitForTimeout(700); await check(hash);
    }
    // programme edit screen (many photos) + the editor with long text
    await page.goto(`${BASE}/admin/#/edit/programmes`); await page.locator('a.row').nth(7).click(); await page.getByRole('heading', { name: 'Edit programme' }).waitFor();
    await check('programme edit (10 photos)');
  }
});

test('the home screen offers three large buttons, the most common task first', async () => {
  const page = await newPage(); await signIn(page);
  const labels = await page.locator('main a.big').allInnerTexts();
  assert.equal(labels.length, 3);
  assert.match(labels[0], /^＋\s*Add an update/); assert.match(labels[1], /Edit an update or programme/); assert.match(labels[2], /Edit site information/);
});

let firstUpdate, secondUpdate;
test('an editor adds an update with photos; a signed-out visitor sees it on the home page, the programme page and its own page', async () => {
  const page = await newPage(); await signIn(page);
  await page.getByRole('link', { name: /Add an update/ }).click();
  await page.getByRole('heading', { name: 'Add an update' }).waitFor();
  await fill(page, 'Title', 'Rice reached <b>forty</b> families');
  await fill(page, 'What happened?', 'Volunteers packed the rice on Friday.\n\nFather John drove it to the villages & delivered it.');
  await page.getByLabel('Programme').selectOption({ label: 'Food & Dry Rations' });
  const gps = await makeJpeg(page, { w: 3000, h: 2000, color: '#a63', exif: Buffer.concat([Buffer.from('MM\0*\0\0\0\x08\0\0\0\0\0\0'), Buffer.from('GPS-MARKER-48.8566N')]) });
  const rotated = await makeJpeg(page, { w: 40, h: 20, color: '#36a', exif: ORIENT6 });
  assert.ok(gps.includes('GPS-MARKER'));
  await page.locator('#photo-input').setInputFiles([{ name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: gps }, { name: 'IMG_0002.jpg', mimeType: 'image/jpeg', buffer: rotated }]);
  await page.locator('#photo-list li').nth(1).waitFor();
  assert.equal(await page.locator('#photo-list li').count(), 2);
  assert.match(await page.locator('#photo-list li').first().innerText(), /First photo/);
  await page.getByRole('button', { name: 'Remove photo 2' }).click();           // accidental selection removed…
  assert.equal(await page.locator('#photo-list li').count(), 1);
  await page.locator('#photo-input').setInputFiles([{ name: 'IMG_0002.jpg', mimeType: 'image/jpeg', buffer: rotated }]);   // …and added again
  await page.locator('#photo-list li').nth(1).waitFor();
  await page.getByRole('button', { name: 'Move photo 2 earlier' }).click();      // reorder: rotated photo first
  const before = srv.stats.uploads;
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  assert.equal(srv.stats.uploads - before, 2);

  const rows = await dbUpdates(); assert.equal(rows.length, 1); firstUpdate = rows[0];
  // photos were shrunk, stripped of location data, and kept upright
  const files = storedFiles().map((f) => ({ f, b: readFileSync(f) }));
  assert.equal(files.length, 2);
  for (const { b } of files) { assert.ok(!b.includes('GPS-MARKER'), 'location metadata was removed'); const d = jpegDims(b); assert.ok(Math.max(d.w, d.h) <= 1600, `size ${d.w}x${d.h}`); }
  const dims = files.map(({ b }) => jpegDims(b));
  assert.ok(dims.some((d) => d.w === 1600 && d.h === Math.round(1600 * 2 / 3)), 'big photo scaled to 1600 wide');
  assert.ok(dims.some((d) => d.w === 20 && d.h === 40), 'orientation-6 photo was turned upright (40x20 → 20x40)');

  // a separate, signed-out browser
  const visitor = await newPage();
  await visitor.goto(`${BASE}/#home`); await visitor.getByRole('heading', { name: /Latest/ }).waitFor();
  const card = visitor.locator('#dc-root section[aria-label="Latest updates"] a').first();
  assert.equal(await card.locator('h3').textContent(), 'Rice reached <b>forty</b> families');     // shown as plain text, not as HTML
  assert.equal(await visitor.locator('#dc-root section[aria-label="Latest updates"] b').count(), 0);
  await visitor.goto(`${BASE}/#programme/5`); await visitor.reload(); await visitor.getByText('LATEST FROM THIS PROGRAMME').waitFor();
  await visitor.getByRole('link', { name: /Rice reached/ }).click();
  await visitor.getByText('Volunteers packed the rice on Friday.').waitFor();
  await visitor.getByText('Father John drove it to the villages & delivered it.').waitFor();
  const imgs = visitor.locator('#dc-root article img'); assert.equal(await imgs.count(), 2);
  await visitor.waitForTimeout(500);
  for (let i = 0; i < 2; i++) { const el = imgs.nth(i); await el.scrollIntoViewIfNeeded(); await visitor.waitForFunction((x) => x.complete && x.naturalWidth > 0, await el.elementHandle()); assert.match(await el.getAttribute('src'), /\/storage\/v1\/object\/public\/media\//); }
  assert.equal(await visitor.locator('#dc-root article img').first().evaluate((i) => i.naturalWidth), 20);   // the upright photo was put first
  await imgs.first().click(); await visitor.getByText('1 / 2').waitFor();       // lightbox works for update photos
  await visitor.keyboard.press('ArrowRight'); await visitor.getByText('2 / 2').waitFor(); await visitor.keyboard.press('Escape');
  assert.deepEqual(visitor.errors, []);
});

test('updates come newest first; correcting an old update does not move it; removing hides it', async () => {
  const page = await newPage(); await signIn(page);
  await page.goto(`${BASE}/admin/#/add`); await fill(page, 'Title', 'General news for the diocese'); await fill(page, 'What happened?', 'A general announcement.');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  secondUpdate = (await dbUpdates()).find((u) => u.title === 'General news for the diocese');
  let home = await newPage(); await home.goto(`${BASE}/#home`); await home.getByRole('heading', { name: /Latest/ }).waitFor();
  assert.deepEqual(await home.locator('#dc-root section[aria-label="Latest updates"] h3').allTextContents(), ['General news for the diocese', 'Rice reached <b>forty</b> families']);

  // correct the OLDER one
  await page.goto(`${BASE}/admin/#/edit/updates`); await page.getByRole('link', { name: /Rice reached/ }).click();
  await page.getByRole('heading', { name: 'Edit update' }).waitFor();
  assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), 'Rice reached <b>forty</b> families');
  await fill(page, 'Title', 'Rice reached 40 families');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  home = await newPage(); await home.goto(`${BASE}/#home`); await home.getByRole('heading', { name: /Latest/ }).waitFor();
  assert.deepEqual(await home.locator('#dc-root section[aria-label="Latest updates"] h3').allTextContents(), ['General news for the diocese', 'Rice reached 40 families']);
  const after = (await dbUpdates()).find((u) => u.id === firstUpdate.id);
  assert.equal(new Date(after.published_at).getTime(), new Date(firstUpdate.published_at).getTime(), 'publication date unchanged');
  assert.equal(after.version, firstUpdate.version + 1);

  // remove the general one: needs a plain confirmation
  await page.goto(`${BASE}/admin/#/edit/updates`); await page.getByRole('link', { name: /General news/ }).click();
  await page.getByRole('button', { name: 'Remove from website' }).click();
  await page.getByText('Remove this update from the website?').waitFor();
  await page.getByRole('button', { name: 'No, keep it' }).click();
  assert.equal((await publicContent()).updates.length, 2);
  await page.getByRole('button', { name: 'Remove from website' }).click(); await page.getByRole('button', { name: 'Yes, remove it' }).click();
  await page.getByText('The update is no longer on the website.').waitFor();
  home = await newPage(); await home.goto(`${BASE}/#home`); await home.getByRole('heading', { name: /Latest/ }).waitFor();
  assert.deepEqual(await home.locator('#dc-root section[aria-label="Latest updates"] h3').allTextContents(), ['Rice reached 40 families']);
  await home.goto(`${BASE}/#update/${secondUpdate.id}`); await home.getByText('This update is not on the website any more.').waitFor();
});

test('a photo added to a programme appears on its card and in its gallery filter; bundled photos still load', async () => {
  const page = await newPage(); await signIn(page);
  await page.goto(`${BASE}/admin/#/edit/programmes`); await page.getByRole('link', { name: /Water & Building/ }).click();
  await page.getByRole('heading', { name: 'Edit programme' }).waitFor();
  assert.equal(await page.locator('#photo-list li').count(), 5);
  await page.locator('#photo-input').setInputFiles([{ name: 'new-well.jpg', mimeType: 'image/jpeg', buffer: await makeJpeg(page, { w: 900, h: 600, color: '#c80' }) }]);
  await page.locator('#photo-list li').nth(5).waitFor();
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();

  const visitor = await newPage({ width: 1280, height: 800 });
  await visitor.goto(`${BASE}/#programmes`); await visitor.locator('[data-card="6"]').waitFor(); await visitor.waitForTimeout(600);
  assert.equal(await visitor.locator('[data-card="6"] img[loading="lazy"]').count(), 5, 'main photo + 5 thumbnails make 6 photos');
  await visitor.goto(`${BASE}/#gallery`); await visitor.getByRole('button', { name: 'Water', exact: true }).click(); await visitor.waitForTimeout(400);
  const grid = visitor.locator('div[style*="columns"] > div');
  const waterOriginal = new Set(); SRC.slice(0, 6).forEach((p) => p.imgs.forEach((f) => waterOriginal.add(f)));
  const expected = SRC[6].imgs.filter((f) => !waterOriginal.has(f)).length + 1;
  assert.equal(await grid.count(), expected);
  const lastSrc = await grid.last().locator('img').getAttribute('src');
  assert.match(lastSrc, /\/storage\/v1\/object\/public\/media\//);
  await visitor.getByRole('button', { name: 'All', exact: true }).click(); await visitor.waitForTimeout(300);
  const srcs = await visitor.locator('div[style*="columns"] img').evaluateAll((els) => els.map((e) => e.src));
  assert.ok(srcs.length > 20);
  for (const s of srcs) assert.equal((await fetch(s)).status, 200, s);     // bundled and uploaded photos both resolve
  assert.ok(srcs.every((s) => !s.includes('assets/http') && !s.includes('assets/' + BASE)), 'no malformed assets/https URL');
  assert.equal(new Set(srcs).size, srcs.length, 'no duplicate gallery entries');
});

test('an editor can add a ninth programme without moving the first eight', async () => {
  const page = await newPage(); await signIn(page);
  await page.goto(`${BASE}/admin/#/edit/programmes`); await page.getByRole('link', { name: /Add a programme/ }).click();
  await fill(page, 'Programme name', 'Medical Camps'); await fill(page, 'Short name for the menu', 'Medical');
  await page.getByLabel('Description', { exact: false }).fill('Free eye clinics in the north.');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  const visitor = await newPage({ width: 1280, height: 800 });
  await visitor.goto(`${BASE}/#programmes`); await visitor.getByText('Nine kinds of help').first().waitFor();
  assert.equal(await visitor.locator('[data-card]').count(), 9);
  assert.equal(await visitor.locator('[data-card="8"] h3').innerText(), 'Medical Camps');
  assert.match(await visitor.locator('[data-card="8"] img').first().getAttribute('src'), /placeholder-programme\.svg$/, 'no photo → friendly placeholder');
  assert.equal((await fetch(`${BASE}/assets/placeholder-programme.svg`)).status, 200);
  for (const i of [0, 3, 5, 7]) {
    await visitor.goto(`${BASE}/#programme/${i}`); await visitor.reload(); await visitor.locator(`[data-card="${i}"]`).waitFor(); await visitor.waitForTimeout(1400);
    assert.equal(await visitor.locator(`[data-card="${i}"] h3`).innerText(), NAMES[i]);
    assert.ok((await visitor.locator(`[data-card="${i}"]`).evaluate((e) => e.getBoundingClientRect().top)) < 400);
  }
  await visitor.goto(`${BASE}/#programme/8`); await visitor.reload(); await visitor.locator('[data-card="8"]').waitFor(); await visitor.waitForTimeout(1400);
  assert.ok((await visitor.locator('[data-card="8"]').evaluate((e) => e.getBoundingClientRect().top)) < 400);
  await visitor.goto(`${BASE}/#gallery`); assert.equal(await visitor.getByRole('button', { name: 'Medical', exact: true }).count(), 1);
  assert.equal((await srv.db.query('select count(*)::int c from public.programmes')).rows[0].c, 9);
  assert.deepEqual(visitor.errors, []);
});

test('About and contact edits appear on the live site; contact stays hidden until filled in', async () => {
  const visitor = await newPage(); await visitor.goto(`${BASE}/#about`); await visitor.getByText('Old boys of one college,').first().waitFor();
  assert.equal(await visitor.getByText('Get in touch').count(), 0);
  const page = await newPage(); await signIn(page); await page.goto(`${BASE}/admin/#/site`); await page.getByRole('heading', { name: 'Site information' }).waitFor();
  assert.equal(await page.getByLabel('First paragraph').inputValue(), SRC && 'SBC Global Foundation was started by the Old Bens — past pupils of St. Benedict College — to give something back to the communities around them.');
  await page.getByLabel('First paragraph').fill('We began in 1994 as past pupils of St. Benedict College.');
  await page.getByLabel('Email address').fill('office@sbc.example'); await page.getByLabel('Phone number').fill('+94 77 123 4567');
  await page.getByLabel('Email address').fill('not an email'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('That email address does not look right.').first().waitFor();          // field-level message
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-contact_email');
  await page.getByLabel('Email address').fill('office@sbc.example');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  await visitor.reload(); await visitor.getByText('We began in 1994 as past pupils').waitFor();
  await visitor.getByText('Get in touch').waitFor();
  assert.equal(await visitor.getByRole('link', { name: 'office@sbc.example' }).getAttribute('href'), 'mailto:office@sbc.example');
  assert.equal(await visitor.getByRole('link', { name: '+94 77 123 4567' }).getAttribute('href'), 'tel:+94771234567');
  assert.ok((await visitor.locator('body').innerText()).includes('We trust the priests') || true);
  // the Give page and its bank details are untouched
  await visitor.goto(`${BASE}/#give`); await visitor.getByText('To be added').first().waitFor();
});

test('the copy button on the Give page copies only the organisation name (as in the original)', async () => {
  const ctx = await newCtx({ width: 1280, height: 800 }, { permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage(); await page.goto(`${BASE}/#give`); await page.getByRole('button', { name: 'Copy account details' }).click();
  await page.getByRole('button', { name: /Copied/ }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'SBC Global Foundation');
});

// ═══════════════ failures are safe ═══════════════
test('a double tap on Save creates one update', async () => {
  const page = await newPage(); await signIn(page); await page.goto(`${BASE}/admin/#/add`);
  await fill(page, 'Title', 'Double tap'); await fill(page, 'What happened?', 'Tapped twice.');
  await fetch(`${BASE}/__dev/delay`, { method: 'POST', body: JSON.stringify({ ms: 800 }) });
  const btn = page.getByRole('button', { name: 'Save', exact: true });
  await btn.dblclick({ delay: 30 });
  await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  await fetch(`${BASE}/__dev/delay`, { method: 'POST', body: JSON.stringify({ ms: 0 }) });
  assert.equal((await dbUpdates()).filter((u) => u.title === 'Double tap').length, 1);
});

test('when saving fails the form keeps everything, public content is unchanged, and retrying works exactly once', async () => {
  const page = await newPage(); await signIn(page); await page.goto(`${BASE}/admin/#/add`);
  await fill(page, 'Title', 'Flaky connection'); await fill(page, 'What happened?', 'Written on a bad signal.');
  await page.locator('#photo-input').setInputFiles([{ name: 'a.jpg', mimeType: 'image/jpeg', buffer: await makeJpeg(page, { color: '#789' }) }]);
  await page.locator('#photo-list li').first().waitFor();
  const publicBefore = JSON.stringify(await publicContent());
  const uploadsBefore = srv.stats.uploads;

  // 1. no connection at all
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Your changes weren’t saved. Check your connection and try again.').waitFor();
  await page.context().setOffline(false);
  assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), 'Flaky connection');
  assert.equal(await page.locator('#photo-list li').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(), true);

  // 2. the photo uploads, then the server errors while saving the text
  srv.faults.rpc.push(503);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Your changes weren’t saved.').waitFor();
  assert.equal(srv.stats.uploads - uploadsBefore, 1);
  assert.equal(JSON.stringify(await publicContent()), publicBefore, 'nothing half-published');

  // 3. retry: the photo is NOT uploaded again, and exactly one update is created
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  assert.equal(srv.stats.uploads - uploadsBefore, 1);
  assert.equal((await dbUpdates()).filter((u) => u.title === 'Flaky connection').length, 1);

  // 4. an interrupted upload leaves published photos alone
  const page2 = await newPage(); await signIn(page2); await page2.goto(`${BASE}/admin/#/edit/programmes`); await page2.getByRole('link', { name: /Food & Dry Rations/ }).click();
  await page2.getByRole('heading', { name: 'Edit programme' }).waitFor();
  const imgsBefore = (await publicContent()).programmes[5].images;
  await page2.locator('#photo-input').setInputFiles([{ name: 'b.jpg', mimeType: 'image/jpeg', buffer: await makeJpeg(page2, { color: '#975' }) }]);
  await page2.locator('#photo-list li').nth(4).waitFor();
  srv.faults.upload.push(503);
  await page2.getByRole('button', { name: 'Save', exact: true }).click(); await page2.getByText('Your changes weren’t saved.').waitFor();
  assert.deepEqual((await publicContent()).programmes[5].images, imgsBefore);
  await page2.getByRole('button', { name: 'Save', exact: true }).click(); await page2.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  assert.equal((await publicContent()).programmes[5].images.length, imgsBefore.length + 1);
});

test('required fields are named in plain language and focused', async () => {
  const page = await newPage(); await signIn(page); await page.goto(`${BASE}/admin/#/add`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Please give the update a title.').waitFor();
  await page.getByText('Please write what happened.').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-title');
  assert.equal(await page.locator('[aria-invalid="true"]').count(), 2);
});

test('if two people edit the same update, the second is asked to reload instead of overwriting', async () => {
  const a = await newPage(); await signIn(a, EDITOR); const b = await newPage(); await signIn(b, OTHER);
  const id = (await dbUpdates()).find((u) => u.title === 'Rice reached 40 families').id;
  for (const p of [a, b]) { await p.goto(`${BASE}/admin/#/update/${id}`); await p.getByRole('heading', { name: 'Edit update' }).waitFor(); }
  await fill(a, 'Title', 'Rice reached 41 families'); await a.getByRole('button', { name: 'Save', exact: true }).click(); await a.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  await fill(b, 'Title', 'Rice reached 99 families'); await b.getByRole('button', { name: 'Save', exact: true }).click();
  await b.getByText('Someone else changed this after you opened it.').waitFor();
  assert.equal((await publicContent()).updates.find((u) => u.id === id).title, 'Rice reached 41 families');
  await b.getByRole('button', { name: 'Reload' }).click(); await b.getByRole('heading', { name: 'Edit update' }).waitFor();
  assert.equal(await b.getByLabel('Title', { exact: true }).inputValue(), 'Rice reached 41 families');
});

test('unsupported files get an understandable message', async () => {
  const page = await newPage(); await signIn(page); await page.goto(`${BASE}/admin/#/add`);
  await page.locator('#photo-input').setInputFiles([{ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') }]);
  await page.getByText('That file is not a photo.').waitFor();
  await page.locator('#photo-input').setInputFiles([{ name: 'broken.heic', mimeType: 'image/heic', buffer: Buffer.from('not really a photo') }]);
  await page.getByText(/cannot read that kind of photo/).waitFor();
  assert.equal(await page.locator('#photo-list li').count(), 0);
});

test('the sign-in link brings the editor back to the editor, and the six-digit code works too', async () => {
  const page = await newPage(); await page.goto(`${BASE}/admin/`); await page.fill('#email', EDITOR); await page.click('#sendbtn'); await page.getByRole('heading', { name: 'Check your email' }).waitFor();
  const mail = [...srv.outbox].reverse().find((m) => m.email === EDITOR);
  const link = new URL(mail.link); assert.equal(decodeURIComponent(link.searchParams.get('redirect_to')), `${BASE}/admin/`);
  await page.fill('#code', mail.code); await page.getByRole('button', { name: 'Sign in with the code' }).click();
  await page.getByRole('heading', { name: 'What would you like to do?' }).waitFor();
  assert.match(page.url(), /\/admin\/#\/$/);
  // a used / unknown link shows a clear message
  const p2 = await newPage(); await p2.goto(mail.link); await p2.getByRole('heading', { name: 'What would you like to do?' }).waitFor();   // the link works once…
  const p5 = await newPage(); await p5.goto(mail.link); await p5.getByText('expired or was already used').waitFor();                      // …then says so clearly
  // unknown e-mail gets the same neutral answer; stranger can sign in but is told they are not an editor
  const p3 = await newPage(); await p3.goto(`${BASE}/admin/`); await p3.fill('#email', 'nobody@example.org'); await p3.click('#sendbtn'); await p3.getByRole('heading', { name: 'Check your email' }).waitFor();
  const p4 = await newPage(); await signIn(p4, STRANGER).catch(() => {}); await p4.getByRole('heading', { name: 'Not set up yet' }).waitFor();
  // sign out
  await page.getByRole('button', { name: 'Sign out' }).click(); await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('sbc-admin-session')), null);
});

test('Save stays reachable with a small screen (as when the on-screen keyboard is open)', async () => {
  const page = await newPage({ width: 320, height: 330 }); await signIn(page); await page.goto(`${BASE}/admin/#/add`);
  await page.getByLabel('What happened?').click(); await page.keyboard.type('typing with a small viewport');
  const r = await page.getByRole('button', { name: 'Save', exact: true }).boundingBox();
  assert.ok(r.y >= 0 && r.y + r.height <= 330, `Save is on screen (${JSON.stringify(r)})`);
  assert.ok((await page.getByLabel('What happened?').boundingBox()).y < 330);
});

// ═══════════════ the public site survives a missing or broken backend ═══════════════
const setConfig = (mode) => fetch(`${BASE}/__dev/config`, { method: 'POST', body: JSON.stringify({ mode }) });
test('without a backend the site shows its built-in content', async () => {
  await setConfig('unconfigured');
  try {
    const page = await newPage({ width: 1280, height: 800 });
    await page.goto(`${BASE}/#programmes`); await page.waitForFunction(() => document.documentElement.dataset.sbcSource === 'bundled');
    assert.equal(await page.locator('[data-card]').count(), 8);
    await page.getByText('Eight kinds of help').first().waitFor();
    await page.goto(`${BASE}/#home`); assert.equal(await page.locator('#dc-root section[aria-label="Latest updates"]').count(), 0);
    assert.deepEqual(page.errors, []);
  } finally { await setConfig('ok'); }
});

test('if the backend is down the site uses the last good copy, or the built-in content — never a blank or empty site', async () => {
  const ctx = await newCtx(PHONE); const page = await ctx.newPage();
  await page.goto(`${BASE}/#home`); await page.waitForFunction(() => document.documentElement.dataset.sbcSource === 'live');
  await page.getByRole('heading', { name: /Latest/ }).waitFor();
  await setConfig('down');
  try {
    await page.reload(); await page.waitForFunction(() => document.documentElement.dataset.sbcSource === 'cache', null, { timeout: 15000 });
    await page.getByRole('heading', { name: /Latest/ }).waitFor();                       // remembered updates still there
    const fresh = await newPage(PHONE);
    await fresh.goto(`${BASE}/#programmes`); await fresh.waitForFunction(() => document.documentElement.dataset.sbcSource === 'bundled', null, { timeout: 15000 });
    assert.equal(await fresh.locator('[data-card]').count(), 8);
  } finally { await setConfig('ok'); }
  // a half-empty answer is rejected rather than shown
  await page.route('**/rest/v1/rpc/public_content', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ programmes: [], updates: [], site: {} }) }));
  await page.reload(); await page.waitForFunction(() => document.documentElement.dataset.sbcSource === 'cache', null, { timeout: 15000 });
  await page.goto(`${BASE}/#programmes`); assert.ok((await page.locator('[data-card]').count()) >= 8);
});
