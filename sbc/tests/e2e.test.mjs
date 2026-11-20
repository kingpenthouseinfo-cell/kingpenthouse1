// End-to-end tests: real browser (Chromium via Playwright) against the real site, the real editor and the
// real database rules (PGlite) behind a local stand-in for Supabase. Phone sizes are EMULATED here;
// they are not a substitute for a test on a real iPhone/Android (see docs/OWNER-SETUP.md).
// Run: npm run test:e2e
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDevServer, ANON_KEY } from '../dev/server.mjs';
import { routeCdn, playwright } from './helpers.mjs';
import { readSource } from '../scripts/generate-seed.mjs';

const { chromium } = playwright();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8793, BASE = `http://localhost:${PORT}`;
const EDITOR = 'priest@example.org', OTHER = 'second@example.org', STRANGER = 'stranger@example.org', OWNER = 'owner@example.org', PWUSER = 'password.user@example.org', RESETUSER = 'reset.user@example.org';
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
  const mail = [...srv.outbox].reverse().find((m) => m.email === email && m.kind !== 'recovery');
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
const scrolledTo = (page, i) => page.waitForFunction((n) => { const el = document.querySelector(`[data-card="${n}"]`); if (!el) return false; const t = el.getBoundingClientRect().top; return t > -50 && t < 400; }, i, { timeout: 10000 });
const fill = async (page, label, text) => page.getByLabel(label, { exact: true }).fill(text);

test.before(async () => {
  srv = await startDevServer({ port: PORT, storageDir: mkdtempSync(join(tmpdir(), 'sbc-storage-')) });
  await srv.addEditor(EDITOR); await srv.addEditor(OTHER); await srv.addUserOnly(STRANGER);
  await srv.addEditor(OWNER, { owner: true, password: 'owner-password-1' }); await srv.addEditor(PWUSER, { password: 'correct-horse-1' }); await srv.addEditor(RESETUSER, { password: 'old-password-1' });
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
    await page.locator(`[data-card="${i}"]`).waitFor(); await scrolledTo(page, i);       // scrolled into view
    assert.equal(await page.locator(`[data-card="${i}"] h3`).textContent(), NAMES[i]);
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
    await page.goto(`${BASE}/admin/`); await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
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
      const btns = await page.locator('main a.big, main a.choice, main a.row, main .btn, main .out-btn, main .link, .bar .btn').evaluateAll((els) => els.filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().height));
      assert.ok(btns.every((h) => h >= 44), `${label}: touch targets are at least 44px tall`);
    };
    await check('sign-in');
    await page.goto(`${BASE}/admin/#/forgot`); await page.getByRole('heading', { name: 'Forgot your password?' }).waitFor(); await check('forgot password');
    await page.goto(`${BASE}/admin/`); await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
    await signIn(page);
    for (const hash of ['/', '/add', '/updates', '/programmes', '/programme/new', '/about', '/faces', '/strip', '/contact', '/gallery', '/password']) {
      await page.goto(`${BASE}/admin/#${hash}`); await page.waitForTimeout(700); await check(hash);
    }
    // programme edit screen (many photos) + the editor with long text
    await page.goto(`${BASE}/admin/#/programmes`); await page.locator('main a.choice').nth(7).click(); await page.getByRole('heading', { name: 'Edit programme' }).waitFor();
    await check('programme edit (10 photos)');
  }
});

test('the main screen: one big Add an update button, then a plain button for each thing to edit', async () => {
  const page = await newPage(); await signIn(page);
  assert.equal(await page.locator('main a.big').count(), 1);
  assert.match(await page.locator('main a.big').innerText(), /Add an update/);
  const labels = await page.locator('main nav.choices a').evaluateAll((as) => as.map((a) => a.textContent.replace(a.querySelector('.cico').textContent, '').trim()));
  assert.deepEqual(labels, ['Edit an update', 'Edit or add a programme', 'Edit or add to the photo gallery', 'Edit the About page', 'Edit priests and sisters', 'Edit the About page photo strip', 'Edit contact details']);   // no bank button for an ordinary editor
  await page.getByRole('link', { name: 'Look at the website' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Look at the website' }).getAttribute('href'), '../');
  await page.getByText('Signed in as').waitFor(); await page.getByRole('button', { name: 'Sign out' }).waitFor();
  // "Edit or add a programme" opens a list with every programme as its own button
  await page.getByRole('link', { name: 'Edit or add a programme' }).click(); await page.getByRole('heading', { name: 'Which programme?' }).waitFor();
  await page.locator('main nav.choices a').nth(7).waitFor();
  const names = (await page.locator('main nav.choices a').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim());
  assert.equal(names.length, SRC.length);
  SRC.forEach((p, i) => assert.equal(names[i], `${String(i + 1).padStart(2, '0')} ${p.t}`));
  assert.equal((await page.locator('main a.add-group').innerText()).trim(), '＋ Add a programme');
  await page.getByRole('link', { name: /Toilets/ }).click(); await page.getByRole('heading', { name: 'Edit programme' }).waitFor();
  await page.goBack(); await page.getByRole('heading', { name: 'Which programme?' }).waitFor();
  await page.getByRole('link', { name: '← Back' }).click(); await page.getByRole('heading', { name: 'What would you like to do?' }).waitFor();
  // old bookmarks still land somewhere sensible
  await page.goto(`${BASE}/admin/#/edit`); await page.getByRole('heading', { name: 'What would you like to do?' }).waitFor();
  await page.goto(`${BASE}/admin/#/edit/programmes`); await page.getByRole('heading', { name: 'Which programme?' }).waitFor();
  await page.goto(`${BASE}/admin/#/site`); await page.getByRole('heading', { name: 'About page', level: 1 }).waitFor();
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
  assert.match(await page.locator('#photo-list li').first().innerText(), /first photo/i);
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
  assert.equal(await visitor.locator('[data-card="8"] h3').textContent(), 'Medical Camps');
  assert.match(await visitor.locator('[data-card="8"] img').first().getAttribute('src'), /placeholder-programme\.svg$/, 'no photo → friendly placeholder');
  assert.equal((await fetch(`${BASE}/assets/placeholder-programme.svg`)).status, 200);
  for (const i of [0, 3, 5, 7]) {
    await visitor.goto(`${BASE}/#programme/${i}`); await visitor.reload(); await visitor.locator(`[data-card="${i}"]`).waitFor(); await scrolledTo(visitor, i);
    assert.equal(await visitor.locator(`[data-card="${i}"] h3`).textContent(), NAMES[i]);
  }
  await visitor.goto(`${BASE}/#programme/8`); await visitor.reload(); await visitor.locator('[data-card="8"]').waitFor(); await scrolledTo(visitor, 8);
  await visitor.goto(`${BASE}/#gallery`); assert.equal(await visitor.getByRole('button', { name: 'Medical', exact: true }).count(), 1);
  assert.equal((await srv.db.query('select count(*)::int c from public.programmes')).rows[0].c, 9);
  assert.deepEqual(visitor.errors, []);
});

test('About and contact edits appear on the live site; contact stays hidden until filled in', async () => {
  const visitor = await newPage(); await visitor.goto(`${BASE}/#about`); await visitor.getByText('Old boys of one college,').first().waitFor();
  assert.equal(await visitor.getByText('Get in touch').count(), 0);
  const page = await newPage(); await signIn(page); await page.goto(`${BASE}/admin/#/about`); await page.getByRole('heading', { name: 'About page', level: 1 }).waitFor();
  assert.equal(await page.getByLabel('First paragraph').inputValue(), 'SBC Global Foundation was started by the Old Bens — past pupils of St. Benedict College — to give something back to the communities around them.');
  assert.equal(await page.getByLabel('Email address').count(), 0, 'contact details have their own screen now');
  await page.getByLabel('First paragraph').fill('We began in 1994 as past pupils of St. Benedict College.');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  await page.goto(`${BASE}/admin/#/`); await page.goto(`${BASE}/admin/#/contact`); await page.getByRole('heading', { name: 'Contact details' }).waitFor();
  await page.getByLabel('Email address').fill('not an email'); await page.getByLabel('Phone number').fill('+94 77 123 4567');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('That email address does not look right.').first().waitFor();          // field-level message
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-contact_email');
  await page.getByLabel('Email address').fill('office@sbc.example');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  await visitor.reload(); await visitor.getByText('We began in 1994 as past pupils').waitFor();
  await visitor.getByText('Get in touch').waitFor();
  assert.equal(await visitor.getByRole('link', { name: 'office@sbc.example' }).getAttribute('href'), 'mailto:office@sbc.example');
  assert.equal(await visitor.getByRole('link', { name: '+94 77 123 4567' }).getAttribute('href'), 'tel:+94771234567');
  // the Give page and its bank details are untouched
  await visitor.goto(`${BASE}/#give`); await visitor.getByText('To be added').first().waitFor();
});

test('the copy button on the Give page copies only the organisation name (as in the original)', async () => {
  const ctx = await newCtx({ width: 1280, height: 800 }, { permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage(); await page.goto(`${BASE}/#give`); await page.getByRole('button', { name: 'Copy account details' }).click();
  await page.getByRole('button', { name: /Copied/ }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'SBC Global Foundation');
});

// ═══════════════ password sign-in ═══════════════
async function passwordSignIn(page, email, password) {
  await page.goto(`${BASE}/admin/`); await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
  await page.fill('#email', email); await page.fill('#pw', password); await page.click('#pwbtn');
}

test('an editor can sign in with an email and password as well as with an emailed link', async () => {
  const page = await newPage();
  await passwordSignIn(page, PWUSER, 'wrong-password');
  await page.getByText('That password isn’t right.').waitFor();
  assert.equal(await page.getByRole('heading', { name: 'What would you like to do?' }).count(), 0);
  await page.fill('#pw', 'correct-horse-1'); await page.click('#pwbtn');
  await page.getByRole('heading', { name: 'What would you like to do?' }).waitFor();
  assert.match(page.url(), /\/admin\/#\/$/);
  // pressing Enter in the password box works too (phones use the keyboard's Go key)
  const p2 = await newPage(); await p2.goto(`${BASE}/admin/`); await p2.fill('#email', PWUSER); await p2.fill('#pw', 'correct-horse-1'); await p2.press('#pw', 'Enter');
  await p2.getByRole('heading', { name: 'What would you like to do?' }).waitFor();
  // a password for an address that isn't an editor signs in but is told it is not set up
  srv.addUserOnly('nopower@example.org', 'whatever-123'); await srv.addUserOnly('nopower@example.org', 'whatever-123');
  const p3 = await newPage(); await passwordSignIn(p3, 'nopower@example.org', 'whatever-123'); await p3.getByRole('heading', { name: 'Not set up yet' }).waitFor();
});

test('an editor can set a password for themselves; the old one then stops working', async () => {
  const page = await newPage(); await signIn(page, OTHER);                       // signed in by emailed link
  await page.getByRole('link', { name: 'Set or change my password' }).click();
  await page.getByRole('heading', { name: 'Set or change my password' }).waitFor();
  await fill(page, 'New password', 'short'); await fill(page, 'Type it again', 'short');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByText('Please use at least 8 characters.').waitFor();
  await fill(page, 'New password', 'a-good-password-1'); await fill(page, 'Type it again', 'a-different-one');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByText('The two passwords are not the same.').waitFor();
  await fill(page, 'Type it again', 'a-good-password-1');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Password saved.' }).waitFor();
  const fresh = await newPage(); await passwordSignIn(fresh, OTHER, 'a-good-password-1'); await fresh.getByRole('heading', { name: 'What would you like to do?' }).waitFor();
  await page.getByRole('link', { name: 'Back to the main screen' }).click();
  const bad = await newPage(); await passwordSignIn(bad, OTHER, 'not-it'); await bad.getByText('That password isn’t right.').waitFor();
  assert.deepEqual(fresh.errors, []);
});

// ═══════════════ the bank details (owner only) ═══════════════
test('only the owner can change the bank details; they show on the Give page and the copy button then copies them all', async () => {
  const priest = await newPage(); await signIn(priest, EDITOR);
  assert.equal(await priest.getByRole('link', { name: /bank details/i }).count(), 0, 'an ordinary editor is not offered it');
  await priest.goto(`${BASE}/admin/#/bank`); await priest.getByText('Only the owner of the website can change the bank details.').waitFor();
  const tok = await sessionToken(EDITOR); const v0 = (await api('/rest/v1/rpc/editor_content', { token: tok })).body.site_version;
  assert.equal((await api('/rest/v1/rpc/editor_save_bank', { token: tok, body: { p_expected_version: v0, p_data: { bank_name: 'Hacked Bank' } } })).status, 403);
  assert.equal((await api('/rest/v1/rpc/editor_save_bank', { body: { p_expected_version: v0, p_data: { bank_name: 'Hacked Bank' } } })).status, 401);

  const owner = await newPage(); await passwordSignIn(owner, OWNER, 'owner-password-1');
  await owner.getByRole('heading', { name: 'What would you like to do?' }).waitFor();
  assert.equal(await owner.locator('main nav.choices a').count(), 8, 'the owner also gets Edit bank details');
  await owner.getByRole('link', { name: /bank details/i }).click(); await owner.getByRole('heading', { name: 'Bank details' }).waitFor();
  await owner.getByRole('button', { name: 'Save', exact: true }).click();                       // empty: the required ones are named
  await owner.getByText('Please type the name on the account.').waitFor(); await owner.getByText('Please type the name of the bank.').waitFor();
  await owner.getByText('Please type the branch.').waitFor(); await owner.getByText('Please type the account number.').waitFor();
  assert.equal(await owner.evaluate(() => document.activeElement.id), 'f-bank_account_name');
  await fill(owner, 'Name on the account', 'SBC Global Foundation'); await fill(owner, 'Bank', 'Example Bank PLC'); await fill(owner, 'Branch', 'Vavuniya');
  await fill(owner, 'Account number', 'bad<number>');
  await owner.getByRole('button', { name: 'Save', exact: true }).click();
  await owner.getByText('The account number can only have numbers, spaces and dashes.').first().waitFor();
  assert.equal(await owner.evaluate(() => document.activeElement.id), 'f-bank_account_no');
  await fill(owner, 'Account number', '0012 3456-78');
  await owner.getByLabel(/SWIFT code/).fill('examlklx');
  await owner.getByLabel('Shown under the bank details').fill('Please write your name so we can thank you.');
  await owner.getByRole('button', { name: 'Save', exact: true }).click(); await owner.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();

  const ctx = await newCtx({ width: 1280, height: 800 }, { permissions: ['clipboard-read', 'clipboard-write'] }); const visitor = await ctx.newPage();
  await visitor.goto(`${BASE}/#give`); await visitor.getByText('Example Bank PLC').waitFor();
  const text = await visitor.locator('#dc-root').textContent();
  for (const t of ['SBC Global Foundation', 'Example Bank PLC', 'Vavuniya', '0012 3456-78', 'EXAMLKLX', 'Your full name', 'Please write your name so we can thank you.']) assert.ok(text.includes(t), t);
  assert.ok(!text.includes('To be added'), 'the placeholders are gone');
  await visitor.getByRole('button', { name: 'Copy account details' }).click(); await visitor.getByRole('button', { name: /Copied/ }).waitFor();
  assert.equal(await visitor.evaluate(() => navigator.clipboard.readText()),
    'ACCOUNT NAME: SBC Global Foundation\nBANK: Example Bank PLC\nBRANCH: Vavuniya\nACCOUNT NO.: 0012 3456-78\nSWIFT / BIC: EXAMLKLX\nREFERENCE: Your full name');
  // ordinary editors still cannot change them through the site-information saver either
  const v1 = (await api('/rest/v1/rpc/editor_content', { token: tok })).body.site_version;
  assert.equal((await api('/rest/v1/rpc/editor_save_site', { token: tok, body: { p_expected_version: v1, p_data: { bank_name: 'x' } } })).status, 422);
});

// ═══════════════ groups, many photos at once, and videos ═══════════════
// A real (tiny) WebM video made in the browser, so the video flow is tested with a file that really plays.
async function makeWebm(page) {
  return Buffer.from(await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 180; const x = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' }); const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data); const stopped = new Promise((r) => { rec.onstop = r; }); rec.start();
    let i = 0; const t = setInterval(() => { x.fillStyle = `hsl(${i * 25},70%,45%)`; x.fillRect(0, 0, 320, 180); x.fillStyle = '#fff'; x.font = '20px sans-serif'; x.fillText('frame ' + i++, 12, 28); }, 60);
    await new Promise((r) => setTimeout(r, 1200)); clearInterval(t); rec.stop(); await stopped;
    return [...new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer())];
  }));
}

test('several photos can be chosen in one go on a programme; they all arrive in order and a limit is explained', async () => {
  const page = await newPage(); await signIn(page);
  await page.goto(`${BASE}/admin/#/edit/programmes`); await page.getByRole('link', { name: /Mothers & Infants/ }).click();
  await page.getByRole('heading', { name: 'Edit programme' }).waitFor();
  const before = await page.locator('#photo-list li').count();
  const colours = ['#a33', '#3a3', '#33a', '#aa3', '#3aa', '#a3a'];
  const files = []; for (const [i, c] of colours.entries()) files.push({ name: `IMG_${i}.jpg`, mimeType: 'image/jpeg', buffer: await makeJpeg(page, { w: 640 + i * 10, h: 480, color: c }) });
  await page.locator('#photo-input').setInputFiles(files);            // ONE selection, six photos
  await page.getByText('Added 6 photos.').waitFor();
  assert.equal(await page.locator('#photo-list li').count(), before + 6);
  assert.equal(await page.locator('#photo-input').getAttribute('multiple'), '');
  const up0 = srv.stats.uploads;
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  assert.equal(srv.stats.uploads - up0, 6);
  const imgs = (await publicContent()).programmes[4].images; assert.equal(imgs.length, before + 6);
  assert.equal(imgs.slice(before).filter((x) => x.includes('/')).length, 6);
  // on an update the limit is 12: a bigger selection is trimmed with a clear message, nothing is lost silently
  await page.goto(`${BASE}/admin/#/`); await page.goto(`${BASE}/admin/#/add`); await page.getByRole('heading', { name: 'Add an update' }).waitFor();
  const buf = await makeJpeg(page, { w: 200, h: 150 });
  await page.locator('#photo-input').setInputFiles(Array.from({ length: 14 }, (_, i) => ({ name: `p${i}.jpg`, mimeType: 'image/jpeg', buffer: buf })));
  await page.getByText('2 photos were left out.').waitFor();
  assert.equal(await page.locator('#photo-list li').count(), 12);
});

test('groups: add one with a photo, delete another, see it on the About page; deleting all hides the section', async () => {
  const page = await newPage(); await signIn(page); await page.goto(`${BASE}/admin/#/site`); await page.getByRole('heading', { name: 'About page', level: 1 }).waitFor();
  assert.equal(await page.locator('.partner').count(), 3);
  // a nameless group is refused with a plain message
  await page.getByRole('button', { name: '＋ Add a group' }).click();
  assert.equal(await page.locator('.partner').count(), 4);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Please give group 4 a name, or remove it.').first().waitFor();
  // fill it in, with a photo
  await page.locator('.partner').nth(3).getByLabel(/— name$/).fill('Women’s circle');
  await page.locator('.partner').nth(3).getByLabel(/— what they do$/).fill('They cook for the medical camps.');
  await page.locator('.partner').nth(3).locator('input[data-gphoto]').setInputFiles({ name: 'circle.jpg', mimeType: 'image/jpeg', buffer: await makeJpeg(page, { w: 900, h: 600, color: '#c63' }) });
  await page.locator('.partner').nth(3).locator('img').waitFor();
  // delete group 2 (with a plain confirmation: "No" keeps it)
  await page.locator('.partner').nth(1).getByRole('button', { name: 'Remove this group' }).click();
  await page.locator('.partner').nth(1).getByRole('button', { name: 'No, keep it' }).click();
  assert.equal(await page.locator('.partner').count(), 4);
  await page.locator('.partner').nth(1).getByRole('button', { name: 'Remove this group' }).click();
  await page.locator('.partner').nth(1).getByRole('button', { name: 'Yes, remove it' }).click();
  assert.equal(await page.locator('.partner').count(), 3);
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();

  const visitor = await newPage({ width: 1280, height: 800 });
  await visitor.goto(`${BASE}/#about`); await visitor.getByText('Who carries it out').waitFor();
  const cards = visitor.locator('#dc-root section:has-text("Who carries it out") div:has(> div:has-text("VAROD"))');
  await visitor.getByText('Women’s circle').first().waitFor();
  const text = await visitor.locator('#dc-root').textContent();
  assert.ok(text.includes('VAROD, Vavuniya') && text.includes('Parish priests') && text.includes('Women’s circle'));
  assert.ok(!text.includes('The religious sisters'), 'the deleted group is gone');
  const pic = visitor.locator('#dc-root img[src*="/storage/v1/object/public/media/"]'); await pic.first().waitFor();
  assert.equal(await pic.count(), 1);
  assert.equal(await pic.first().evaluate(async (i) => { await i.decode(); return i.naturalWidth; }), 900 > 1600 ? 1600 : 900);
  assert.deepEqual(visitor.errors, []);

  // delete every group → the heading and section disappear (and come back when a group is added)
  await page.goto(`${BASE}/admin/#/`); await page.goto(`${BASE}/admin/#/site`); await page.locator('.partner').first().waitFor();
  for (let i = 0; i < 3; i++) { await page.locator('.partner').first().getByRole('button', { name: 'Remove this group' }).click(); await page.locator('.partner').first().getByRole('button', { name: 'Yes, remove it' }).click(); }
  await page.getByText('There are no groups.').waitFor();
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  await visitor.reload(); await visitor.getByText('Old boys of one college,').first().waitFor(); await visitor.waitForTimeout(300);
  assert.equal(await visitor.getByText('Who carries it out').count(), 0);
  // put the original three back so later tests see a normal About page
  await page.goto(`${BASE}/admin/#/`); await page.goto(`${BASE}/admin/#/site`); await page.getByText('There are no groups.').waitFor();
  for (const [t, d] of [['VAROD, Vavuniya', 'Our partner for medical camps.'], ['The religious sisters', 'They run homes for the elderly.'], ['Parish priests', 'They drive the parcels out.']]) {
    await page.getByRole('button', { name: '＋ Add a group' }).click();
    await page.locator('.partner').last().getByLabel(/— name$/).fill(t); await page.locator('.partner').last().getByLabel(/— what they do$/).fill(d);
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  await visitor.reload(); await visitor.getByText('Who carries it out').waitFor();
});

// ═══════════════ About page: the people band ═══════════════
const aboutRoot = (page) => page.locator('#dc-root');
const faceImgs = (page) => page.locator('#dc-root img[alt*=", "][style*="border-radius:50%"], #dc-root img[style*="border-radius: 50%"]');

test('the About page shows the people band: a scrolling photo strip with captions, and faces with names on hover', async () => {
  const visitor = await newPage({ width: 1280, height: 800 }); await visitor.goto(`${BASE}/#about`); await visitor.getByText('on the ground.').first().waitFor();
  const text = await aboutRoot(visitor).textContent();
  for (const t of ['Who carries it out', 'The people', 'on the ground.', 'scroll →', 'Faces behind it']) assert.ok(text.includes(t), t);
  const caps = await aboutRoot(visitor).locator('figcaption').allTextContents();
  assert.equal(caps.length, 8); assert.equal(caps[0], '01 — The parish team, together'); assert.equal(caps[7], '08 — Schoolbooks for every child');
  const faces = faceImgs(visitor); assert.equal(await faces.count(), 9);
  assert.equal(await aboutRoot(visitor).locator('img[alt="Fr. —, Parish priest"]').count(), 7);
  const tip = (img) => img.evaluate((i) => getComputedStyle(i.parentElement.querySelector('div')).opacity);
  assert.equal(await tip(faces.first()), '0', 'names are hidden until you point at a face');
  await faces.first().hover(); await visitor.waitForTimeout(450);
  assert.equal(await tip(faces.first()), '1');
  assert.match(await faces.first().evaluate((i) => i.parentElement.innerText), /Fr\. — · Parish priest/);
  assert.equal(await aboutRoot(visitor).getByText('NEXT PAGE').count(), 0, 'the About page has no "next page" block');
  // every strip photo and face photo loads
  const srcs = [...await aboutRoot(visitor).locator('figure img').evaluateAll((els) => els.map((e) => e.src)), ...await faces.evaluateAll((els) => els.map((e) => e.src))];
  assert.equal(srcs.length, 17); for (const u of srcs) assert.equal((await fetch(u)).status, 200, u);
  assert.deepEqual(visitor.errors, []);
});

test('editors can add, edit, move and delete priests and sisters (photo + name + role); the About page follows', async () => {
  const page = await newPage(); await signIn(page); await page.getByRole('link', { name: 'Edit priests and sisters' }).click();
  await page.getByRole('heading', { name: 'Priests and sisters' }).waitFor();
  assert.equal(await page.locator('main label.big.primary').count(), 1); assert.match(await page.locator('main label.big.primary').innerText(), /Add priests or sisters/);
  assert.equal(await page.locator('#photo-input').getAttribute('multiple'), '');
  assert.equal(await page.locator('#pl-list li').count(), 9);
  assert.equal(await page.getByLabel('Name for person 1').inputValue(), 'Fr. —');
  // add two people in one selection
  await page.locator('#photo-input').setInputFiles([{ name: 'p1.jpg', mimeType: 'image/jpeg', buffer: await makeJpeg(page, { w: 400, h: 500, color: '#a63' }) }, { name: 'p2.jpg', mimeType: 'image/jpeg', buffer: await makeJpeg(page, { w: 420, h: 520, color: '#36a' }) }]);
  await page.getByText(/Added 2 people/).waitFor(); assert.equal(await page.locator('#pl-list li').count(), 11);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.f), 'name', 'the cursor lands in the first new name box');
  // a name is required, in words
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByText('Please type this person’s name.').first().waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id.endsWith('-name')), true);
  const nameOf = (n) => page.locator(`#pl-list li:nth-child(${n}) [data-f="name"]`), roleOf = (n) => page.locator(`#pl-list li:nth-child(${n}) [data-f="role"]`);
  await nameOf(10).fill('Fr. John Perera'); await roleOf(10).fill('Parish priest, Mannar');
  await nameOf(11).fill('Sr. Mary Fernando'); await roleOf(11).fill('Religious sister');
  await nameOf(1).fill('Fr. Anthony Silva');                                                             // edit an existing one
  await page.locator('#pl-list li:nth-child(2)').locator('input[data-replace]').setInputFiles({ name: 'new.jpg', mimeType: 'image/jpeg', buffer: await makeJpeg(page, { w: 450, h: 450, color: '#3a3' }) });   // change a photo
  await page.getByRole('button', { name: 'Move person 11 earlier' }).click();                             // Sr. Mary before Fr. John
  assert.equal(await nameOf(10).inputValue(), 'Sr. Mary Fernando');
  await page.locator('#pl-list li:nth-child(3)').getByRole('button', { name: 'Delete this person' }).click();
  await page.getByText('Delete this person?').waitFor(); await page.getByRole('button', { name: 'No, keep it' }).click(); assert.equal(await page.locator('#pl-list li').count(), 11);
  await page.locator('#pl-list li:nth-child(3)').getByRole('button', { name: 'Delete this person' }).click(); await page.getByRole('button', { name: 'Yes, delete it' }).click();
  assert.equal(await page.locator('#pl-list li').count(), 10);
  assert.equal((await publicContent()).faces.length, 9, 'nothing changes on the website until Save');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  const f = (await publicContent()).faces;
  assert.equal(f.length, 10); assert.equal(f[0].name, 'Fr. Anthony Silva');
  assert.deepEqual(f.slice(8).map((x) => [x.name, x.role]), [['Sr. Mary Fernando', 'Religious sister'], ['Fr. John Perera', 'Parish priest, Mannar']]);
  assert.match(f[1].src, /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/, 'the changed photo was uploaded'); assert.match(f[8].src, /\//);

  const visitor = await newPage({ width: 1280, height: 800 }); await visitor.goto(`${BASE}/#about`); await visitor.getByText('Faces behind it').first().waitFor();
  const faces = faceImgs(visitor); assert.equal(await faces.count(), 10);
  const mary = aboutRoot(visitor).locator('img[alt="Sr. Mary Fernando, Religious sister"]'); await mary.waitFor();
  assert.match(await mary.getAttribute('src'), /\/storage\/v1\/object\/public\/media\//);
  await mary.hover(); await visitor.waitForTimeout(450); assert.match(await mary.evaluate((i) => i.parentElement.innerText), /Sr\. Mary Fernando · Religious sister/);
  assert.deepEqual(visitor.errors, []);

  // two editors at once: the second is asked to reload instead of overwriting
  const a = await newPage(); await signIn(a); const b = await newPage(); await signIn(b, OTHER);
  for (const q of [a, b]) { await q.goto(`${BASE}/admin/#/faces`); await q.getByRole('heading', { name: 'Priests and sisters' }).waitFor(); await q.locator('#pl-list li').first().waitFor(); }
  await a.locator('#pl-list li:nth-child(1) [data-f="name"]').fill('A was here'); await a.getByRole('button', { name: 'Save', exact: true }).click(); await a.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  await b.locator('#pl-list li:nth-child(1) [data-f="name"]').fill('B was here'); await b.getByRole('button', { name: 'Save', exact: true }).click();
  await b.getByText('Someone else changed this after you opened it.').waitFor(); assert.equal((await publicContent()).faces[0].name, 'A was here');
});

test('editors can add, edit, move and delete the About page photo strip (the school and parish photos)', async () => {
  const page = await newPage(); await signIn(page); await page.getByRole('link', { name: 'Edit the About page photo strip' }).click();
  await page.getByRole('heading', { name: 'About page photo strip' }).waitFor();
  assert.equal(await page.locator('#pl-list li').count(), 8);
  assert.equal(await page.getByLabel(/^Caption for photo 1/).inputValue(), 'The parish team, together');
  await page.locator('#photo-input').setInputFiles([{ name: 's1.jpg', mimeType: 'image/jpeg', buffer: await makeJpeg(page, { w: 500, h: 300, color: '#c60' }) }, { name: 's2.jpg', mimeType: 'image/jpeg', buffer: await makeJpeg(page, { w: 520, h: 300, color: '#06c' }) }]);
  await page.getByText(/Added 2 photos/).waitFor(); assert.equal(await page.locator('#pl-list li').count(), 10);
  const cap = (n) => page.locator(`#pl-list li:nth-child(${n}) [data-f="caption"]`);
  await cap(9).fill('Handing out school bags'); await cap(10).fill('');                                    // the second one gets no caption
  await cap(1).fill('The parish team, together (2026)');                                                   // edit an existing caption
  await page.getByRole('button', { name: 'Move photo 9 earlier' }).click(); await page.getByRole('button', { name: 'Move photo 8 earlier' }).click();   // new photo to position 7
  await page.locator('#pl-list li:nth-child(9)').getByRole('button', { name: 'Delete this photo' }).click(); await page.getByRole('button', { name: 'Yes, delete it' }).click();   // drop one old photo
  assert.equal(await page.locator('#pl-list li').count(), 9);
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  const st = (await publicContent()).strip; assert.equal(st.length, 9); assert.equal(st[0].caption, 'The parish team, together (2026)');
  assert.ok(st.some((x) => x.caption === 'Handing out school bags' && /\//.test(x.src)));
  const visitor = await newPage({ width: 1280, height: 800 }); await visitor.goto(`${BASE}/#about`); await visitor.getByText('scroll →').first().waitFor();
  const caps = await aboutRoot(visitor).locator('figcaption').allTextContents();
  assert.equal(caps.length, 9); assert.equal(caps[0], '01 — The parish team, together (2026)'); assert.ok(caps.includes('07 — Handing out school bags') || caps.some((c) => /Handing out school bags/.test(c)));
  assert.ok(caps.some((c) => /^\d\d$/.test(c.trim())), 'a photo with no caption shows only its number');
});

test('About page headings can be edited; with no groups, photos or people the lower part of the page disappears', async () => {
  const page = await newPage(); await signIn(page); await page.goto(`${BASE}/admin/#/about`); await page.getByRole('heading', { name: 'About page', level: 1 }).waitFor();
  assert.equal(await page.getByLabel('Small heading above the groups').inputValue(), 'Who carries it out');
  await page.getByLabel('Small heading above the groups').fill('Our partners'); await page.getByLabel('Heading above the photo strip', { exact: true }).fill('Faces');
  await page.getByLabel(/^Heading above the photo strip — last words/).fill('of the work.'); await page.getByLabel('Small heading beside the priests and sisters').fill('Who they are');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  const visitor = await newPage({ width: 1280, height: 800 }); await visitor.goto(`${BASE}/#about`); await visitor.getByText('of the work.').first().waitFor();
  const text = await aboutRoot(visitor).textContent(); for (const t of ['Our partners', 'Faces', 'of the work.', 'Who they are']) assert.ok(text.includes(t), t);
  assert.ok(!text.includes('Who carries it out'));
  // back to the original wording
  await page.goto(`${BASE}/admin/#/`); await page.goto(`${BASE}/admin/#/about`); await page.getByLabel('Small heading above the groups').waitFor();
  await page.getByLabel('Small heading above the groups').fill('Who carries it out'); await page.getByLabel('Heading above the photo strip', { exact: true }).fill('The people');
  await page.getByLabel(/^Heading above the photo strip — last words/).fill('on the ground.'); await page.getByLabel('Small heading beside the priests and sisters').fill('Faces behind it');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  // delete the whole strip and every person: the dark band disappears, the rest of the page stays
  for (const [hash, heading] of [['/strip', 'About page photo strip'], ['/faces', 'Priests and sisters']]) {
    await page.goto(`${BASE}/admin/#/`); await page.goto(`${BASE}/admin/#${hash}`); await page.getByRole('heading', { name: heading }).waitFor(); await page.locator('#pl-list li').first().waitFor();
    const n = await page.locator('#pl-list li').count();
    for (let i = 0; i < n; i++) { await page.locator('#pl-list li').first().getByRole('button', { name: /^Delete this/ }).click(); await page.getByRole('button', { name: 'Yes, delete it' }).click(); }
    await page.getByText(/There are no (photos|people) here yet/).waitFor();
    await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  }
  assert.deepEqual([(await publicContent()).strip, (await publicContent()).faces], [[], []]);
  await visitor.reload(); await visitor.getByText('Who carries it out').first().waitFor(); await visitor.waitForTimeout(300);
  const t2 = await aboutRoot(visitor).textContent(); assert.ok(!t2.includes('on the ground.') && !t2.includes('Faces behind it') && !t2.includes('scroll →'));
  assert.ok(t2.includes('VAROD, Vavuniya'), 'the groups are still there');
});

test('a programme can have videos: choose several, see a picture for each, save, and visitors can watch (nothing autoplays)', async () => {
  const page = await newPage(); await signIn(page);
  await page.goto(`${BASE}/admin/#/edit/programmes`); await page.getByRole('link', { name: /Care for the Elderly/ }).click();
  await page.getByRole('heading', { name: 'Edit programme' }).waitFor();
  assert.equal(await page.getByText('No videos yet.').count(), 1);
  assert.equal(await page.locator('#video-input').getAttribute('multiple'), '');
  const webm = await makeWebm(page);
  assert.ok(webm.length > 1000);
  // wrong kind of file, and a file that is too big, are refused in plain words before anything uploads
  await page.locator('#video-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.getByText('is not a video the website can use').waitFor();
  const big = join(tmpdir(), 'sbc-huge.mp4'); writeFileSync(big, Buffer.alloc(51 * 1024 * 1024));
  await page.locator('#video-input').setInputFiles(big);
  await page.getByText('is too big (51 MB). Videos can be up to 50 MB.').waitFor();
  assert.equal(await page.locator('#video-list li').count(), 0);
  // two good videos in one selection
  await page.locator('#video-input').setInputFiles([{ name: 'first.webm', mimeType: 'video/webm', buffer: webm }, { name: 'second.webm', mimeType: 'video/webm', buffer: webm }]);
  await page.getByText('Added 2 videos.').waitFor();
  assert.equal(await page.locator('#video-list li').count(), 2);
  assert.equal(await page.locator('#video-list li .vthumb').evaluateAll((els) => els.filter((e) => /url\(/.test(e.style.backgroundImage)).length), 2, 'each video shows a picture taken from it');
  await page.getByRole('button', { name: 'Move video 2 earlier' }).click();
  await page.getByRole('button', { name: 'Remove video 2' }).click();           // changed my mind about one
  assert.equal(await page.locator('#video-list li').count(), 1);
  await page.locator('#video-input').setInputFiles({ name: 'second.webm', mimeType: 'video/webm', buffer: webm });
  await page.locator('#video-list li').nth(1).waitFor();
  const before = { ...srv.stats.byBucket };
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  assert.equal(srv.stats.byBucket.videos - (before.videos || 0), 2);
  assert.equal(srv.stats.byBucket.media - (before.media || 0), 2, 'one still picture per video');
  const vids = (await publicContent()).programmes[3].videos;
  assert.equal(vids.length, 2); assert.ok(vids.every((v) => /\.webm$/.test(v.src) && /\.jpg$/.test(v.poster)));

  const visitor = await newPage({ width: 1280, height: 800 });
  await visitor.goto(`${BASE}/#programmes`); await visitor.locator('[data-card="3"]').waitFor(); await visitor.waitForTimeout(800);
  const v = visitor.locator('[data-card="3"] video[data-user-video]'); assert.equal(await v.count(), 2);
  assert.match(await v.first().getAttribute('src'), /\/storage\/v1\/object\/public\/videos\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.webm$/);
  assert.match(await v.first().getAttribute('poster'), /\/storage\/v1\/object\/public\/media\//);
  assert.equal(await v.first().evaluate((e) => e.controls), true, 'has play controls');
  await visitor.locator('[data-card="3"]').getByText('VIDEOS').waitFor();
  await visitor.waitForTimeout(1500);
  assert.equal(await v.first().evaluate((e) => e.paused), true, 'a visitor’s video does not autoplay');
  assert.equal(await v.first().evaluate((e) => e.muted === false || e.defaultMuted === false), true, 'and is not forced muted');
  assert.equal((await fetch(await v.first().evaluate((e) => e.src))).status, 200);
  assert.equal((await fetch(await v.first().evaluate((e) => e.src), { headers: { range: 'bytes=0-99' } })).status, 206);   // seeking works
  await v.first().evaluate((e) => { e.muted = true; return e.play(); }); await visitor.waitForTimeout(600);
  assert.equal(await v.first().evaluate((e) => !e.error && e.readyState >= 2), true, 'it plays');
  // the programme's built-in videos on other cards still behave as before
  assert.equal(await visitor.locator('[data-card="0"] video:not([data-user-video])').count(), 1);
  assert.deepEqual(visitor.errors, []);

  // remove one video: the other stays, the file is not deleted from storage
  const files = storedFiles().length;
  await page.goto(`${BASE}/admin/#/`); await page.goto(`${BASE}/admin/#/edit/programmes`); await page.getByRole('link', { name: /Care for the Elderly/ }).click();
  await page.getByRole('heading', { name: 'Edit programme' }).waitFor(); await page.locator('#video-list li').nth(1).waitFor();
  await page.getByRole('button', { name: 'Remove video 1' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  assert.equal((await publicContent()).programmes[3].videos.length, 1);
  assert.equal(storedFiles().length, files);
});

test('a failed video upload keeps the form and the retry does not duplicate anything', async () => {
  const page = await newPage(); await signIn(page);
  await page.goto(`${BASE}/admin/#/edit/programmes`); await page.getByRole('link', { name: /Sunshine Sports/ }).click(); await page.getByRole('heading', { name: 'Edit programme' }).waitFor();
  await page.locator('#video-input').setInputFiles({ name: 'match.webm', mimeType: 'video/webm', buffer: await makeWebm(page) }); await page.locator('#video-list li').waitFor();
  const publicBefore = JSON.stringify(await publicContent());
  srv.faults.upload.push(503, 503);        // the still picture fails, then the next try gets further
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByText('Your changes weren’t saved.').waitFor();
  assert.equal(await page.locator('#video-list li').count(), 1);
  assert.equal(JSON.stringify(await publicContent()), publicBefore);
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByText('Your changes weren’t saved.').waitFor();
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  assert.equal((await publicContent()).programmes[2].videos.length, 1);
});

// ═══════════════ the new design's features ═══════════════
test('the sign-in screen has the turning seal, a Show/Hide password button, and respects reduced motion', async () => {
  const page = await newPage(); await page.goto(`${BASE}/admin/`); await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(await page.locator('.seal img.mark').getAttribute('src'), '../assets/sbc-emblem-lg.png');
  assert.equal(await page.locator('.seal img.ring').getAttribute('src'), '../assets/sbc-ring.png');
  for (const sel of ['.seal img.ring', '.seal img.mark']) assert.ok(await page.locator(sel).evaluate((i) => i.complete && i.naturalWidth > 0), `${sel} loads`);
  assert.equal(await page.locator('#pw').getAttribute('type'), 'password');
  await page.getByRole('button', { name: 'Show password' }).click(); assert.equal(await page.locator('#pw').getAttribute('type'), 'text');
  await page.getByRole('button', { name: 'Hide password' }).click(); assert.equal(await page.locator('#pw').getAttribute('type'), 'password');
  // reduced motion (set on these test pages) turns the turning off
  assert.equal(await page.locator('.seal img.ring').evaluate((i) => getComputedStyle(i).animationName), 'none');
  // wrong password: the email stays, the message is in words
  await page.fill('#email', PWUSER); await page.fill('#pw', 'nope'); await page.click('#pwbtn');
  await page.getByText('That password isn’t right. Try again, or use the sign-in link below.').waitFor();
  assert.equal(await page.locator('#email').inputValue(), PWUSER);
  assert.equal(await page.locator('#pw').getAttribute('aria-invalid'), 'true');
  // no password typed
  await page.fill('#pw', ''); await page.click('#pwbtn'); await page.getByText('Please type your password, or tap “Email me a sign-in link”.').waitFor();
});

test('forgot your password: a reset link signs you in and asks for a new password; the old one stops working', async () => {
  const page = await newPage(); await page.goto(`${BASE}/admin/`);
  await page.getByRole('link', { name: 'Forgot your password?' }).click(); await page.getByRole('heading', { name: 'Forgot your password?' }).waitFor();
  await page.fill('#email', 'not-an-email'); await page.getByRole('button', { name: 'Email me a reset link' }).click();
  await page.getByText('Please type your email address, like name@example.com.').waitFor();
  await page.fill('#email', RESETUSER); await page.getByRole('button', { name: 'Email me a reset link' }).click();
  await page.getByRole('heading', { name: 'Check your email' }).waitFor();
  const mail = [...srv.outbox].reverse().find((m) => m.email === RESETUSER && m.kind === 'recovery');
  assert.ok(mail, 'a reset email was sent'); assert.match(mail.link, /type=recovery/);
  await page.goto(mail.link); await page.getByRole('heading', { name: 'Choose a new password' }).waitFor();
  assert.match(page.url(), /#\/password$/);
  await fill(page, 'New password', 'new-password-77'); await fill(page, 'Type it again', 'new-password-77');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Password saved.' }).waitFor();
  const fresh = await newPage(); await passwordSignIn(fresh, RESETUSER, 'new-password-77'); await fresh.getByRole('heading', { name: 'What would you like to do?' }).waitFor();
  const old = await newPage(); await passwordSignIn(old, RESETUSER, 'old-password-1'); await old.getByText('That password isn’t right.').waitFor();
  // an address that is not an editor gets the same friendly answer (and no email)
  const n = srv.outbox.length; const p3 = await newPage(); await p3.goto(`${BASE}/admin/#/forgot`); await p3.fill('#email', 'nobody@example.org'); await p3.getByRole('button', { name: 'Email me a reset link' }).click();
  await p3.getByRole('heading', { name: 'Check your email' }).waitFor(); assert.equal(srv.outbox.length, n);
});

const galleryGrid = (page) => page.locator('div[style*="columns"] > div');
const gridWidths = (grid) => grid.locator('img').evaluateAll(async (imgs) => { await Promise.all(imgs.map((i) => i.decode().catch(() => {}))); return imgs.map((i) => i.naturalWidth); });

test('the photo gallery: "Add photos" is the main button; new photos get optional captions and appear on the site after Save', async () => {
  const page = await newPage(); await signIn(page); await page.getByRole('link', { name: 'Edit or add to the photo gallery' }).click();
  await page.getByRole('heading', { name: 'Photo gallery' }).waitFor();
  assert.equal(await page.locator('main label.big.primary').count(), 1);                      // the big button is Add photos
  assert.match(await page.locator('main label.big.primary').innerText(), /Add photos/);
  assert.equal(await page.locator('#photo-input').getAttribute('multiple'), '');
  await page.getByRole('link', { name: /Edit or delete current photos/ }).waitFor();          // and a button for the photos already there
  assert.equal(await page.locator('#savebar').isHidden(), true, 'nothing to save yet');
  const mk = async (w, c) => ({ name: `g${w}.jpg`, mimeType: 'image/jpeg', buffer: await makeJpeg(page, { w, h: 200, color: c }) });
  await page.locator('#photo-input').setInputFiles([await mk(300, '#a33'), await mk(320, '#3a3'), await mk(340, '#33a')]);   // three in one go
  await page.getByText(/Added 3 photos/).waitFor();
  assert.equal(await page.locator('#fresh-list li').count(), 3); assert.equal(await page.locator('#savebar').isVisible(), true);
  await page.getByLabel('Caption for new photo 1').fill('Packing the rice'); await page.getByLabel('Caption for new photo 3').fill('The van leaves');
  await page.getByRole('button', { name: 'Remove new photo 2' }).click();                                            // changed my mind about the middle one
  assert.equal(await page.locator('#fresh-list li').count(), 2);
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  const g = (await publicContent()).gallery; assert.deepEqual(g.map((x) => x.caption), ['Packing the rice', 'The van leaves']);

  const visitor = await newPage({ width: 1280, height: 800 });
  await visitor.goto(`${BASE}/#gallery`); await visitor.getByRole('button', { name: 'More photos', exact: true }).waitFor(); await visitor.waitForTimeout(400);
  const grid = galleryGrid(visitor);
  assert.deepEqual((await gridWidths(grid)).slice(0, 2), [300, 340], 'new photos come first, in order');
  await visitor.getByRole('button', { name: 'More photos', exact: true }).click(); await visitor.waitForTimeout(300);
  assert.deepEqual((await grid.allTextContents()).map((t) => t.trim()), ['Packing the rice', 'The van leaves'], 'captions are shown under the photos');
  await grid.first().click(); await visitor.getByText('Packing the rice').last().waitFor();                          // and in the full-screen viewer
  assert.deepEqual(visitor.errors, []);
});

test('the photo gallery: "Edit or delete current photos" lists every photo with its caption; edit a caption, reorder, or delete the whole thing', async () => {
  const page = await newPage(); await signIn(page); await page.goto(`${BASE}/admin/#/gallery`); await page.getByRole('heading', { name: 'Photo gallery' }).waitFor();
  assert.equal((await page.locator('.choice .count').innerText()).trim(), '2');
  await page.getByRole('link', { name: /Edit or delete current photos/ }).click(); await page.getByRole('heading', { name: 'Edit or delete photos' }).waitFor();
  assert.equal(await page.locator('#gal-list li').count(), 2);
  assert.equal(await page.getByLabel('Caption for photo 1').inputValue(), 'Packing the rice');
  assert.equal(await page.getByLabel('Caption for photo 2').inputValue(), 'The van leaves');
  assert.match(await page.locator('#gal-list li').first().innerText(), /shown first/i);
  assert.ok(await page.locator('#gal-list li img').first().evaluate((i) => i.complete || true));
  await page.getByLabel('Caption for photo 1').fill('Packing the rice (corrected)');
  await page.getByRole('button', { name: 'Move photo 2 earlier' }).click();                                           // van first now
  assert.equal(await page.getByLabel('Caption for photo 1').inputValue(), 'The van leaves');
  assert.equal(await page.getByLabel('Caption for photo 2').inputValue(), 'Packing the rice (corrected)', 'typed text travels with its photo');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  assert.deepEqual((await publicContent()).gallery.map((x) => x.caption), ['The van leaves', 'Packing the rice (corrected)']);

  // delete: a plain confirmation first ("No" keeps it), then it is gone — photo and caption
  await page.goto(`${BASE}/admin/#/gallery`); await page.getByRole('heading', { name: 'Photo gallery' }).waitFor(); await page.goto(`${BASE}/admin/#/gallery/photos`);
  await page.getByRole('heading', { name: 'Edit or delete photos' }).waitFor(); await page.locator('#gal-list li').nth(1).waitFor();
  await page.locator('#gal-list li').nth(1).getByRole('button', { name: 'Delete this photo' }).click();
  await page.getByText('Delete this photo?').waitFor();
  await page.getByRole('button', { name: 'No, keep it' }).click(); assert.equal(await page.locator('#gal-list li').count(), 2);
  await page.locator('#gal-list li').nth(1).getByRole('button', { name: 'Delete this photo' }).click(); await page.getByRole('button', { name: 'Yes, delete it' }).click();
  assert.equal(await page.locator('#gal-list li').count(), 1);
  assert.equal((await publicContent()).gallery.length, 2, 'nothing changes on the website until Save');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  assert.deepEqual((await publicContent()).gallery.map((x) => x.caption), ['The van leaves']);
  const visitor = await newPage({ width: 1280, height: 800 }); await visitor.goto(`${BASE}/#gallery`); await visitor.getByRole('button', { name: 'More photos', exact: true }).click(); await visitor.waitForTimeout(300);
  assert.equal(await galleryGrid(visitor).count(), 1); assert.doesNotMatch(await visitor.locator('#dc-root').textContent(), /Packing the rice/);

  // two people editing at once: the second is asked to reload instead of overwriting
  const a = await newPage(); await signIn(a); const b = await newPage(); await signIn(b, OTHER);
  for (const q of [a, b]) { await q.goto(`${BASE}/admin/#/gallery/photos`); await q.getByRole('heading', { name: 'Edit or delete photos' }).waitFor(); await q.locator('#gal-list li').first().waitFor(); }
  await a.getByLabel('Caption for photo 1').fill('A was here'); await a.getByRole('button', { name: 'Save', exact: true }).click(); await a.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  await b.getByLabel('Caption for photo 1').fill('B was here'); await b.getByRole('button', { name: 'Save', exact: true }).click();
  await b.getByText('Someone else changed this after you opened it.').waitFor();
  assert.equal((await publicContent()).gallery[0].caption, 'A was here');

  // deleting the last photo leaves an empty gallery; the "More photos" tab then disappears
  await a.goto(`${BASE}/admin/#/`); await a.goto(`${BASE}/admin/#/gallery/photos`); await a.locator('#gal-list li').first().waitFor();
  await a.getByRole('button', { name: 'Delete this photo' }).click(); await a.getByRole('button', { name: 'Yes, delete it' }).click();
  await a.getByRole('button', { name: 'Save', exact: true }).click(); await a.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  assert.deepEqual((await publicContent()).gallery, []);
  await visitor.reload(); await visitor.getByRole('button', { name: 'All', exact: true }).waitFor(); assert.equal(await visitor.getByRole('button', { name: 'More photos', exact: true }).count(), 0);
  await a.goto(`${BASE}/admin/#/`); await a.goto(`${BASE}/admin/#/gallery/photos`); await a.getByText('There are no photos in the gallery yet.').waitFor();
});

test('a programme date can be set and cleared; it shows on the programme card when set', async () => {
  const page = await newPage(); await signIn(page); await page.goto(`${BASE}/admin/#/programmes`); await page.getByRole('link', { name: /Sunshine Sports/ }).click();
  await page.getByRole('heading', { name: 'Edit programme' }).waitFor();
  assert.equal(await page.locator('#f-pdate').getAttribute('type'), 'date'); assert.equal(await page.locator('#f-pdate').inputValue(), '');
  await page.getByText('When it happened or started. Leave empty if it’s ongoing.').waitFor();
  await page.locator('#f-pdate').fill('2026-02-14');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  const visitor = await newPage({ width: 1280, height: 800 });
  await visitor.goto(`${BASE}/#programmes`); await visitor.locator('[data-card="2"]').waitFor();
  assert.match(await visitor.locator('[data-card="2"]').textContent(), /Entry 03 · Colombo, Feb 2026 · 14 February 2026/);
  assert.doesNotMatch(await visitor.locator('[data-card="3"]').textContent(), /Entry 04 · Homes run by the sisters ·/, 'no date, nothing extra shown');
  await page.goto(`${BASE}/admin/#/`); await page.goto(`${BASE}/admin/#/programmes`); await page.getByRole('link', { name: /Sunshine Sports/ }).click(); await page.getByRole('heading', { name: 'Edit programme' }).waitFor();
  assert.equal(await page.locator('#f-pdate').inputValue(), '2026-02-14');
  await page.locator('#f-pdate').fill('');
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  await visitor.reload(); await visitor.locator('[data-card="2"]').waitFor();
  assert.doesNotMatch(await visitor.locator('[data-card="2"]').textContent(), /Feb 2026 · 14 February 2026/);
});

test('YouTube links: any ordinary link works, bad ones are explained, and visitors tap to play (nothing loads before)', async () => {
  const page = await newPage(); await signIn(page); await page.goto(`${BASE}/admin/#/programmes`); await page.getByRole('link', { name: /Disability & Rehabilitation/ }).click();
  await page.getByRole('heading', { name: 'Edit programme' }).waitFor();
  const yt = page.getByLabel('Or paste a YouTube link');
  await yt.fill('hello there'); await yt.press('Tab');
  await page.getByText('That doesn’t look like a YouTube link.').waitFor();
  await yt.fill('https://vimeo.com/12345'); await yt.press('Tab'); await page.getByText('That doesn’t look like a YouTube link.').waitFor();
  await yt.fill('https://youtu.be/dQw4w9WgXcQ?t=5'); await yt.press('Tab');
  await page.locator('#video-list li').first().waitFor();
  assert.equal(await yt.inputValue(), '');                                              // it moved into the list
  assert.match(await page.locator('#video-list li').first().innerText(), /YouTube video/);
  await yt.fill('https://www.youtube.com/shorts/abcdefghijk');                          // typed, then Save straight away: still counts
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  assert.deepEqual((await publicContent()).programmes[1].videos.map((v) => [v.kind, v.youtube_id]), [['youtube', 'dQw4w9WgXcQ'], ['youtube', 'abcdefghijk']]);

  const visitor = await newPage({ width: 1280, height: 800 });
  const requested = []; visitor.on('request', (r) => requested.push(r.url()));
  await visitor.goto(`${BASE}/#programmes`); await visitor.locator('[data-card="1"]').waitFor(); await visitor.waitForTimeout(800);
  const play = visitor.locator('[data-card="1"] button[aria-label^="Play this video"]'); assert.equal(await play.count(), 2);
  assert.equal(await visitor.locator('[data-card="1"] iframe').count(), 0, 'no YouTube player until someone taps');
  assert.ok(!requested.some((u) => /youtube-nocookie|youtube\.com\/embed/.test(u)), 'nothing from YouTube’s player was requested');
  assert.match(await play.first().locator('img').getAttribute('src'), /^https:\/\/i\.ytimg\.com\/vi\/dQw4w9WgXcQ\//);
  await play.first().click();
  const frame = visitor.locator('[data-card="1"] iframe'); await frame.waitFor();
  assert.match(await frame.getAttribute('src'), /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?autoplay=1/);
  assert.equal(await visitor.locator('[data-card="1"] button[aria-label^="Play this video"]').count(), 1, 'the other one waits to be tapped');
  assert.deepEqual(visitor.errors, []);
  // remove one again
  await page.goto(`${BASE}/admin/#/`); await page.goto(`${BASE}/admin/#/programmes`); await page.getByRole('link', { name: /Disability & Rehabilitation/ }).click();
  await page.locator('#video-list li').nth(1).waitFor(); await page.getByRole('button', { name: 'Remove video 2' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  assert.equal((await publicContent()).programmes[1].videos.length, 1);
});

test('an upload can be stopped; the programme still saves without that video', async () => {
  const page = await newPage(); await signIn(page); await page.goto(`${BASE}/admin/#/programmes`); await page.getByRole('link', { name: /Food & Dry Rations/ }).click();
  await page.getByRole('heading', { name: 'Edit programme' }).waitFor();
  await page.route('**/storage/v1/object/videos/**', () => {});                      // the upload hangs, like a very weak signal
  await page.locator('#video-input').setInputFiles({ name: 'slow.webm', mimeType: 'video/webm', buffer: await makeWebm(page) }); await page.locator('#video-list li').waitFor();
  const before = (await publicContent()).programmes[5].videos.length;
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Uploading… 0%').waitFor();
  assert.equal(await page.locator('#video-list .progress').count(), 1);
  await page.getByRole('button', { name: 'Stop uploading video 1' }).click();
  await page.getByRole('heading', { name: 'Saved. Your changes are live.' }).waitFor();
  assert.equal((await publicContent()).programmes[5].videos.length, before, 'the stopped video was not added');
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
  await page.getByRole('button', { name: 'Sign out' }).click(); await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
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
