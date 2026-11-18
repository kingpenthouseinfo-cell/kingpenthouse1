// Database tests: migrations, seed fidelity, and who-can-do-what (row level security).
// Run: npm run test:db
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb, asRole, runMigrationsAgain } from '../dev/db.mjs';
import { readSource } from '../scripts/generate-seed.mjs';

const EDITOR = randomUUID(), OTHER_EDITOR = randomUUID(), STRANGER = randomUUID();
let db;

async function rpc(role, uid, fn, args = {}) {
  const names = Object.keys(args);
  const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
  const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n]));
  return asRole(db, role, uid, async (tx) => (await tx.query(sql, vals)).rows[0].r);
}
const asEditor = (fn, args) => rpc('authenticated', EDITOR, fn, args);
const anon = (fn, args) => rpc('anon', null, fn, args);
async function denied(p, codes = ['42501']) {
  await assert.rejects(p, (e) => { assert.ok(codes.includes(e.code), `expected ${codes}, got ${e.code}: ${e.message}`); return true; });
}
async function failsWith(p, code, detail) {
  await assert.rejects(p, (e) => { assert.equal(e.code, code, e.message); if (detail) assert.equal(e.detail, detail); return true; });
}
const publicContent = () => anon('public_content');
const newUpdate = (o = {}) => ({ p_id: null, p_expected_version: null, p_title: 'Rice for Easter', p_body: 'We delivered rice.\n\nThank you.',
  p_programme_id: null, p_images: [], p_client_token: randomUUID(), ...o });

test.before(async () => {
  db = await createDb();
  for (const [id, email] of [[EDITOR, 'priest@example.org'], [OTHER_EDITOR, 'second@example.org'], [STRANGER, 'stranger@example.org']])
    await db.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
  await db.query(`insert into public.editors (user_id, email) values ($1, 'priest@example.org'), ($2, 'second@example.org')`, [EDITOR, OTHER_EDITOR]);
});

// ───────────── migration fidelity ─────────────
test('the eight original programmes are imported in their original order with the right photo counts', async () => {
  const c = await publicContent();
  assert.equal(c.programmes.length, 8);
  assert.deepEqual(c.programmes.map((p) => p.name), ['School Supplies', 'Disability & Rehabilitation', 'Sunshine Sports',
    'Care for the Elderly', 'Mothers & Infants', 'Food & Dry Rations', 'Water & Building', 'Toilets & Sanitation']);
  assert.deepEqual(c.programmes.map((p) => p.short_label), ['School', 'Rehabilitation', 'Sport', 'Elderly', 'Mothers', 'Food', 'Water', 'Toilets']);
  assert.deepEqual(c.programmes.map((p) => p.images.length), [4, 4, 4, 4, 4, 4, 5, 10]);
  assert.deepEqual(c.programmes.map((p) => p.position), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('every imported field matches PROGS in index.html exactly', async () => {
  const src = readSource();
  const got = (await publicContent()).programmes;
  src.forEach((p, i) => {
    const g = got[i];
    assert.equal(g.name, p.t); assert.equal(g.short_label, p.s); assert.equal(g.context, p.m);
    assert.equal(g.caption, p.cap); assert.equal(g.description, p.d);
    assert.deepEqual(g.images, p.imgs, `images of ${p.t}`);
    for (const k of ['video', 'obj', 'ba']) assert.deepEqual(g.extras[k], p[k], `${k} of ${p.t}`);
  });
  assert.equal(got[0].extras.video, 'school-backpacks.mp4');
  assert.equal(got[0].extras.obj, 'obj-backpack.png');
  assert.equal(got[7].extras.ba.length, 6);
  assert.match(got[2].description, /14 February 2026/);
});

test('re-running the import neither duplicates programmes nor reverts later edits', async () => {
  const before = await publicContent();
  const p0 = before.programmes[0];
  await asEditor('editor_save_programme', { p_id: p0.id, p_expected_version: 1, p_name: 'School Supplies', p_short_label: 'School',
    p_context: 'Village schools', p_caption: 'every bag, a name', p_description: 'Edited description.', p_images: ['school-books-1.jpg'], p_client_token: null });
  await runMigrationsAgain(db); await runMigrationsAgain(db);
  const after = await publicContent();
  assert.equal(after.programmes.length, 8);
  assert.equal(after.programmes[0].description, 'Edited description.');
  assert.deepEqual(after.programmes[0].images, ['school-books-1.jpg']);   // not restored to the original four
  const n = (await db.query('select count(*)::int c from public.programme_images where programme_id = $1', [p0.id])).rows[0].c;
  assert.equal(n, 1);
});

// ───────────── anonymous visitors ─────────────
test('anonymous visitors can read public content', async () => {
  const c = await publicContent();
  assert.ok(c.site.about_p1.startsWith('SBC Global Foundation was started'));
  assert.equal(c.site.contact_email, '');
  assert.equal(c.updates.length, 0);
});

test('anonymous visitors cannot write to any table', async () => {
  for (const sql of [
    `insert into public.programmes (slug, position, name, short_label) values ('x', 99, 'X', 'X')`,
    `update public.programmes set name = 'Hacked'`,
    `delete from public.programmes`,
    `insert into public.updates (title, body) values ('t', 'b')`,
    `update public.site_info set data = '{}'`,
    `insert into public.programme_images (programme_id, position, src) select id, 50, 'x.jpg' from public.programmes limit 1`,
    `insert into public.editors (user_id, email) values (gen_random_uuid(), 'x@y.z')`,
  ]) await denied(asRole(db, 'anon', null, (tx) => tx.query(sql)));
});

test('anonymous visitors cannot call editor functions or upload photos', async () => {
  await denied(anon('editor_content'));
  await denied(anon('editor_save_update', newUpdate()));
  await denied(anon('editor_save_site', { p_expected_version: 1, p_data: { about_p1: 'x' } }));
  await denied(asRole(db, 'anon', null, (tx) => tx.query(
    `insert into storage.objects (bucket_id, name) values ('media', '${EDITOR}/${randomUUID()}.jpg')`)));
});

test('anonymous visitors cannot see the editors list', async () => {
  await denied(asRole(db, 'anon', null, (tx) => tx.query('select * from public.editors')));
});

// ───────────── signed-in people who are NOT editors ─────────────
test('a signed-in account without the editor role cannot write, edit or upload', async () => {
  const s = (fn, a) => rpc('authenticated', STRANGER, fn, a);
  await denied(s('editor_content'));
  await denied(s('editor_save_update', newUpdate()));
  await denied(s('editor_save_programme', { p_id: null, p_expected_version: null, p_name: 'N', p_short_label: 'N', p_context: '', p_caption: '', p_description: '', p_images: [], p_client_token: null }));
  await denied(s('editor_save_site', { p_expected_version: 1, p_data: { about_p1: 'x' } }));
  await denied(asRole(db, 'authenticated', STRANGER, (tx) => tx.query(`update public.programmes set name = 'Hacked'`)));
  await denied(asRole(db, 'authenticated', STRANGER, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('media', '${STRANGER}/${randomUUID()}.jpg')`)));
  const rows = await asRole(db, 'authenticated', STRANGER, (tx) => tx.query('select * from public.editors'));
  assert.equal(rows.rows.length, 0);
});

// ───────────── editors ─────────────
test('an editor can read only their own row and cannot add or remove editors', async () => {
  const mine = await asRole(db, 'authenticated', EDITOR, (tx) => tx.query('select email from public.editors'));
  assert.deepEqual(mine.rows, [{ email: 'priest@example.org' }]);
  await denied(asRole(db, 'authenticated', EDITOR, (tx) => tx.query(`insert into public.editors (user_id, email) values ('${STRANGER}', 'x@y.z')`)));
  await denied(asRole(db, 'authenticated', EDITOR, (tx) => tx.query(`delete from public.editors`)));
  await denied(asRole(db, 'authenticated', EDITOR, (tx) => tx.query(`update public.editors set email = 'a@b.c'`)));
});

test('editors cannot write tables directly, only through the editor functions', async () => {
  await denied(asRole(db, 'authenticated', EDITOR, (tx) => tx.query(`update public.programmes set name = 'x'`)));
  await denied(asRole(db, 'authenticated', EDITOR, (tx) => tx.query(`insert into public.updates (title, body) values ('t', 'b')`)));
});

test('an update can be added, appears publicly, keeps its original date when corrected, and can be removed', async () => {
  const progs = (await publicContent()).programmes;
  const tok = randomUUID();
  const made = await asEditor('editor_save_update', newUpdate({ p_title: 'Rice delivered', p_programme_id: progs[5].id, p_client_token: tok }));
  let c = await publicContent();
  assert.equal(c.updates.length, 1);
  assert.equal(c.updates[0].title, 'Rice delivered');
  assert.equal(c.updates[0].programme_id, progs[5].id);
  assert.equal(c.updates[0].body, 'We delivered rice.\n\nThank you.');

  // retrying the same save does not create a duplicate
  const again = await asEditor('editor_save_update', newUpdate({ p_title: 'Rice delivered', p_programme_id: progs[5].id, p_client_token: tok }));
  assert.equal(again.id, made.id);
  assert.equal((await publicContent()).updates.length, 1);

  // a newer update comes first; correcting the OLD one does not move it to the top
  await asEditor('editor_save_update', newUpdate({ p_title: 'Newer news' }));
  await asEditor('editor_save_update', { p_id: made.id, p_expected_version: made.version, p_title: 'Rice delivered (corrected)',
    p_body: 'We delivered 400 bags of rice.', p_programme_id: progs[5].id, p_images: [], p_client_token: null });
  c = await publicContent();
  assert.deepEqual(c.updates.map((u) => u.title), ['Newer news', 'Rice delivered (corrected)']);
  assert.equal(c.updates[1].published_at, made.published_at);

  // removal hides it from the public, keeps the record
  const cur = (await asEditor('editor_content')).updates.find((u) => u.id === made.id);
  await asEditor('editor_remove_update', { p_id: made.id, p_expected_version: cur.version });
  assert.deepEqual((await publicContent()).updates.map((u) => u.title), ['Newer news']);
  assert.equal((await db.query('select count(*)::int c from public.updates')).rows[0].c, 2);
});

test('two people editing the same update cannot silently overwrite each other', async () => {
  const made = await asEditor('editor_save_update', newUpdate({ p_title: 'Shared' }));
  const args = (title) => ({ p_id: made.id, p_expected_version: made.version, p_title: title, p_body: 'b', p_programme_id: null, p_images: [], p_client_token: null });
  await asEditor('editor_save_update', args('First editor wins'));
  await failsWith(rpc('authenticated', OTHER_EDITOR, 'editor_save_update', args('Second editor')), 'PT409');
  assert.ok((await publicContent()).updates.some((u) => u.title === 'First editor wins'));
  // retrying the SAME save (lost response) is a success, not a conflict
  const retry = await asEditor('editor_save_update', args('First editor wins'));
  assert.equal(retry.id, made.id);
});

test('validation errors name the field in plain language', async () => {
  await failsWith(asEditor('editor_save_update', newUpdate({ p_title: '   ' })), 'PT422', 'title');
  await failsWith(asEditor('editor_save_update', newUpdate({ p_body: '' })), 'PT422', 'body');
  await failsWith(asEditor('editor_save_update', newUpdate({ p_title: 'x'.repeat(121) })), 'PT422', 'title');
  await failsWith(asEditor('editor_save_update', newUpdate({ p_programme_id: randomUUID() })), 'PT422', 'programme');
  await assert.rejects(asEditor('editor_save_update', newUpdate({ p_title: '' })), /Please fill in "Title"/);
});

test('photos must exist in storage and live under an allowed path', async () => {
  const path = `${EDITOR}/${randomUUID()}.jpg`;
  await failsWith(asEditor('editor_save_update', newUpdate({ p_images: [path] })), 'PT422', 'photos'); // not uploaded yet
  await failsWith(asEditor('editor_save_update', newUpdate({ p_images: ['../../etc/passwd'] })), 'PT422', 'photos');
  await failsWith(asEditor('editor_save_update', newUpdate({ p_images: ['https://evil.example/x.jpg'] })), 'PT422', 'photos');
  await asRole(db, 'authenticated', EDITOR, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('media', $1)`, [path]));
  const made = await asEditor('editor_save_update', newUpdate({ p_title: 'With photo', p_images: [path, 'food-van.jpg'] }));
  assert.deepEqual((await publicContent()).updates.find((u) => u.id === made.id).images, [path, 'food-van.jpg']);
});

test('editors can upload only into their own folder', async () => {
  await asRole(db, 'authenticated', EDITOR, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('media', '${EDITOR}/${randomUUID()}.png')`));
  await denied(asRole(db, 'authenticated', EDITOR, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('media', '${OTHER_EDITOR}/${randomUUID()}.png')`)));
  await denied(asRole(db, 'authenticated', EDITOR, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('other-bucket', '${EDITOR}/x.png')`)), ['42501', '23503']);
  const b = (await db.query(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'media'`)).rows[0];
  assert.equal(b.public, true); assert.equal(Number(b.file_size_limit), 5242880);
  assert.deepEqual(b.allowed_mime_types, ['image/jpeg', 'image/png', 'image/webp']);
});

test('adding a ninth programme leaves the first eight where they were', async () => {
  const before = (await publicContent()).programmes;
  const made = await asEditor('editor_save_programme', { p_id: null, p_expected_version: null, p_name: 'Medical Camps', p_short_label: 'Medical',
    p_context: 'Jaffna', p_caption: '', p_description: 'Free eye clinics.', p_images: [], p_client_token: randomUUID() });
  const after = (await publicContent()).programmes;
  assert.equal(after.length, 9);
  assert.equal(made.position, 8);
  assert.deepEqual(after.slice(0, 8).map((p) => p.id), before.slice(0, 8).map((p) => p.id));
  assert.equal(after[8].name, 'Medical Camps');
  assert.deepEqual(after[8].images, []);                  // no photo is fine
  // a second programme with the same name gets its own place
  const dup = await asEditor('editor_save_programme', { p_id: null, p_expected_version: null, p_name: 'Medical Camps', p_short_label: 'Medical 2',
    p_context: '', p_caption: '', p_description: '', p_images: ['food-van.jpg', 'water-tanker.png', 'build-road.jpg'], p_client_token: randomUUID() });
  assert.equal(dup.position, 9);
  assert.equal((await publicContent()).programmes[9].images.length, 3);
});

test('a programme position can never change', async () => {
  await assert.rejects(db.query(`update public.programmes set position = 50 where position = 0`), /position cannot change/);
});

test('site information can be edited, but only the allowed fields', async () => {
  const v = (await asEditor('editor_content')).site_version;
  await asEditor('editor_save_site', { p_expected_version: v, p_data: { contact_email: 'office@sbc.example', contact_phone: '+94 77 000 0000', about_p1: 'New first paragraph.' } });
  const s = (await publicContent()).site;
  assert.equal(s.contact_email, 'office@sbc.example');
  assert.equal(s.about_p1, 'New first paragraph.');
  assert.ok(s.about_p2.startsWith('We are a small foundation'));      // other fields untouched
  // bank details and anything else are not editable
  for (const key of ['bank_name', 'account_number', 'bank', 'editors']) {
    const cur = (await asEditor('editor_content')).site_version;
    await failsWith(asEditor('editor_save_site', { p_expected_version: cur, p_data: { [key]: '123' } }), 'PT422', key);
  }
  const cur = (await asEditor('editor_content')).site_version;
  await failsWith(asEditor('editor_save_site', { p_expected_version: cur, p_data: { contact_email: 'not an email' } }), 'PT422', 'contact_email');
  await failsWith(asEditor('editor_save_site', { p_expected_version: 1, p_data: { about_p1: 'stale' } }), 'PT409');
});

// ───────────── owner tools ─────────────
test('only the database owner can add or remove editors', async () => {
  const email = 'new.priest@example.org';
  await db.query('insert into auth.users (email) values ($1)', [email]);
  await denied(rpc('authenticated', EDITOR, 'add_editor', { p_email: email }));          // even an editor cannot
  await denied(rpc('authenticated', STRANGER, 'add_editor', { p_email: email }));
  await denied(rpc('anon', null, 'add_editor', { p_email: email }));
  await denied(rpc('authenticated', EDITOR, 'remove_editor', { p_email: 'priest@example.org' }));
  assert.equal((await db.query('select count(*)::int c from public.editors')).rows[0].c, 2);
  // the owner (superuser in the SQL editor) can
  assert.match((await db.query(`select public.add_editor('New.Priest@example.org') as r`)).rows[0].r, /can now edit/);
  assert.equal((await db.query('select count(*)::int c from public.editors')).rows[0].c, 3);
  await assert.rejects(db.query(`select public.add_editor('nobody@example.org')`), /No user with that email/);
  const id = (await db.query('select id from auth.users where email = $1', [email])).rows[0].id;
  await asRole(db, 'authenticated', id, (tx) => tx.query(`select public.editor_me()`));   // and the new editor works at once
  await db.query(`select public.remove_editor('new.priest@example.org')`);
  await denied(asRole(db, 'authenticated', id, (tx) => tx.query(`select public.editor_me()`)));
});

// ───────────── groups ("Who carries the work out") ─────────────
const siteVersion = async () => (await asEditor('editor_content')).site_version;
const saveSite = async (data, v) => asEditor('editor_save_site', { p_expected_version: v ?? await siteVersion(), p_data: data });

test('the three original groups are a list, each with an id', async () => {
  const s = (await publicContent()).site;
  assert.equal(s.partners.length, 3);
  assert.deepEqual(s.partners.map((g) => g.title), ['VAROD, Vavuniya', 'The religious sisters', 'Parish priests']);
  assert.ok(s.partners.every((g) => g.id && g.image === ''));
  assert.equal(s.partner1_title, undefined);
});

test('groups can be added with a photo, changed and deleted; every change is public at once', async () => {
  const path = `${EDITOR}/${randomUUID()}.jpg`;
  await asRole(db, 'authenticated', EDITOR, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('media', $1)`, [path]));
  const cur = (await publicContent()).site.partners;
  await saveSite({ partners: [...cur, { id: randomUUID(), title: '  Women’s circle ', text: 'They cook for the camps.', image: path }] });
  let p = (await publicContent()).site.partners;
  assert.equal(p.length, 4);
  assert.deepEqual(p[3], { id: p[3].id, title: 'Women’s circle', text: 'They cook for the camps.', image: path });
  // delete the middle one, keep the others (and their ids)
  await saveSite({ partners: [p[0], p[2], p[3]] });
  const after = (await publicContent()).site.partners;
  assert.deepEqual(after.map((g) => g.id), [p[0].id, p[2].id, p[3].id]);
  // deleting every group is allowed; the page then simply hides the section
  await saveSite({ partners: [] });
  assert.deepEqual((await publicContent()).site.partners, []);
  await saveSite({ partners: after });
  assert.equal((await publicContent()).site.partners.length, 3);
});

test('group rules: a name is required, a photo must exist, at most 12, and saving groups leaves other text alone', async () => {
  const keep = (await publicContent()).site.partners;
  const before = (await publicContent()).site.about_p1;
  await failsWith(saveSite({ partners: [{ title: '', text: 'x' }] }), 'PT422', 'partners');
  await assert.rejects(saveSite({ partners: [{ title: '', text: 'x' }] }), /Name of group 1/);
  await failsWith(saveSite({ partners: [{ title: 'A', text: '', image: `${EDITOR}/${randomUUID()}.jpg` }] }), 'PT422', 'photos');   // never uploaded
  await failsWith(saveSite({ partners: [{ title: 'A', text: '', image: '../x.jpg' }] }), 'PT422', 'photos');
  await failsWith(saveSite({ partners: Array.from({ length: 13 }, (_, i) => ({ title: 'G' + i, text: '' })) }), 'PT422', 'partners');
  await failsWith(saveSite({ partners: [{ title: 'x'.repeat(81), text: '' }] }), 'PT422', 'partners');
  await failsWith(saveSite({ partner1_title: 'old style key' }), 'PT422', 'partner1_title');
  assert.deepEqual((await publicContent()).site.partners, keep);                 // every failure left the live data alone
  await saveSite({ about_p1: before + '!' });
  assert.deepEqual((await publicContent()).site.partners, keep);                 // saving other text keeps the groups
  await saveSite({ about_p1: before });
});

test('groups: a stale save is refused, an identical retry succeeds, and a stale delete is not mistaken for a retry', async () => {
  const g = (await publicContent()).site.partners; const v = await siteVersion();
  await saveSite({ partners: g.slice(0, 2) }, v);
  await failsWith(saveSite({ partners: g }, v), 'PT409');                                   // someone else deleted a group meanwhile
  const ok = await saveSite({ partners: g.slice(0, 2) }, v);                                  // the same save again = a retry
  assert.ok(ok.version);
  const v2 = await siteVersion();
  await saveSite({ partners: g }, v2);                                                        // someone adds one back
  await failsWith(saveSite({ partners: g.slice(0, 2) }, v2), 'PT409');                      // a stale "delete" must NOT silently succeed
  assert.equal((await publicContent()).site.partners.length, 3);
});

test('anonymous and non-editor accounts cannot change groups or videos', async () => {
  await denied(anon('editor_save_site', { p_expected_version: 1, p_data: { partners: [] } }));
  await denied(rpc('authenticated', STRANGER, 'editor_save_site', { p_expected_version: 1, p_data: { partners: [] } }));
  const progArgs = { p_id: null, p_expected_version: null, p_name: 'N', p_short_label: 'N', p_context: '', p_caption: '', p_description: '', p_images: [], p_client_token: null, p_videos: [] };
  await denied(anon('editor_save_programme', progArgs)); await denied(rpc('authenticated', STRANGER, 'editor_save_programme', progArgs));
  for (const who of [['anon', null], ['authenticated', EDITOR]])
    await denied(asRole(db, who[0], who[1], (tx) => tx.query(`insert into public.programme_videos (programme_id, position, src) select id, 9, '${EDITOR}/${randomUUID()}.mp4' from public.programmes limit 1`)));
});

// ───────────── videos ─────────────
const uploadVideo = async (name, uid = EDITOR) => asRole(db, 'authenticated', uid, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('videos', $1)`, [name]));
const progBase = (id, version, extra = {}) => ({ p_id: id, p_expected_version: version, p_name: 'Food & Dry Rations', p_short_label: 'Food', p_context: 'Village deliveries', p_caption: 'loading the van',
  p_description: 'Rice.', p_images: ['food-van.jpg'], p_client_token: null, ...extra });
const food = async () => (await asEditor('editor_content')).programmes[5];

test('video bucket: 50 MB, mp4/mov/webm only, editors upload into their own folder only', async () => {
  const b = (await db.query(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'videos'`)).rows[0];
  assert.equal(b.public, true); assert.equal(Number(b.file_size_limit), 52428800);
  assert.deepEqual(b.allowed_mime_types, ['video/mp4', 'video/quicktime', 'video/webm']);
  await uploadVideo(`${EDITOR}/${randomUUID()}.mp4`);
  await denied(uploadVideo(`${OTHER_EDITOR}/${randomUUID()}.mp4`));
  await denied(uploadVideo(`${STRANGER}/${randomUUID()}.mp4`, STRANGER));
  await denied(asRole(db, 'anon', null, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('videos', '${EDITOR}/${randomUUID()}.mp4')`)));
});

test('a programme can have videos: they must exist in storage, keep their order, and can be removed', async () => {
  const f = await food();
  assert.deepEqual(f.videos, []);
  const v1 = `${EDITOR}/${randomUUID()}.mp4`, v2 = `${EDITOR}/${randomUUID()}.webm`, poster = `${EDITOR}/${randomUUID()}.jpg`;
  await failsWith(asEditor('editor_save_programme', progBase(f.id, f.version, { p_videos: [{ src: v1, poster: null }] })), 'PT422', 'videos');   // not uploaded yet
  await failsWith(asEditor('editor_save_programme', progBase(f.id, f.version, { p_videos: [{ src: 'https://evil.example/a.mp4' }] })), 'PT422', 'videos');
  await failsWith(asEditor('editor_save_programme', progBase(f.id, f.version, { p_videos: [{ src: `${EDITOR}/${randomUUID()}.exe` }] })), 'PT422', 'videos');
  assert.deepEqual((await food()).videos, []);
  await uploadVideo(v1); await uploadVideo(v2);
  await asRole(db, 'authenticated', EDITOR, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('media', $1)`, [poster]));
  await asEditor('editor_save_programme', progBase(f.id, f.version, { p_videos: [{ src: v1, poster }, { src: v2, poster: null }] }));
  let now = await food();
  assert.deepEqual(now.videos, [{ src: v1, poster }, { src: v2, poster: null }]);
  assert.deepEqual((await publicContent()).programmes[5].videos, now.videos);     // visitors see them too
  // saving without mentioning videos leaves them alone; reordering and removing work
  await asEditor('editor_save_programme', progBase(now.id, now.version, { p_description: 'Rice and flour.' }));
  now = await food(); assert.equal(now.videos.length, 2);
  await asEditor('editor_save_programme', progBase(now.id, now.version, { p_videos: [{ src: v2 }, { src: v1, poster }] }));
  now = await food(); assert.deepEqual(now.videos.map((v) => v.src), [v2, v1]);
  await asEditor('editor_save_programme', progBase(now.id, now.version, { p_videos: [] }));
  assert.deepEqual((await food()).videos, []);
  assert.equal((await db.query(`select count(*)::int c from storage.objects where bucket_id = 'videos'`)).rows[0].c >= 3, true, 'removing a video never deletes the file');
});

test('a programme can hold many more photos now (up to 40) and at most 8 videos', async () => {
  const f = await food();
  const many = Array.from({ length: 40 }, () => 'food-van.jpg');
  await asEditor('editor_save_programme', progBase(f.id, f.version, { p_images: many }));
  assert.equal((await food()).images.length, 40);
  const g = await food();
  await failsWith(asEditor('editor_save_programme', progBase(g.id, g.version, { p_images: [...many, 'a.jpg'] })), 'PT422', 'photos');
  await failsWith(asEditor('editor_save_programme', progBase(g.id, g.version, { p_videos: Array.from({ length: 9 }, () => ({ src: `${EDITOR}/${randomUUID()}.mp4` })) })), 'PT422', 'videos');
  await asEditor('editor_save_programme', progBase(g.id, g.version, { p_images: ['food-van.jpg'] }));
});

test('a database that still has the old fixed three groups is upgraded without losing them', async () => {
  const { createDb } = await import('../dev/db.mjs');
  const { readFileSync } = await import('node:fs');
  const old = await createDb();      // already new; rebuild the OLD shape by hand, then run 0005's first statement again
  await old.query(`update public.site_info set data = (data - 'partners') || '{"partner1_title":"One","partner1_text":"first","partner2_title":"Two","partner2_text":"second","partner3_title":"","partner3_text":"","about_p1":"keep me"}'::jsonb where id = 1`);
  const sql = readFileSync(new URL('../supabase/migrations/0005_groups_and_videos.sql', import.meta.url), 'utf8');
  await old.exec(sql.slice(0, sql.indexOf('-- ───────── Videos')));
  const d = (await old.query('select data from public.site_info where id = 1')).rows[0].data;
  assert.deepEqual(d.partners.map((g) => [g.title, g.text, g.image]), [['One', 'first', ''], ['Two', 'second', '']]);
  assert.equal(d.partner1_title, undefined); assert.equal(d.about_p1, 'keep me');
  await old.exec(sql.slice(0, sql.indexOf('-- ───────── Videos')));       // running it twice changes nothing
  assert.equal((await old.query('select data from public.site_info where id = 1')).rows[0].data.partners.length, 2);
});

// ───────────── owners and the bank details ─────────────
const OWNER = randomUUID();
const saveBank = (uid, data, v) => rpc('authenticated', uid, 'editor_save_bank', { p_expected_version: v, p_data: data });

test('only an owner can change the bank details; ordinary editors, strangers and visitors cannot', async () => {
  await db.query(`insert into auth.users (id, email) values ($1, 'owner@example.org')`, [OWNER]);
  await db.query(`select public.add_editor('owner@example.org', true)`);
  assert.deepEqual(await rpc('authenticated', OWNER, 'editor_me'), { email: 'owner@example.org', owner: true });
  assert.deepEqual(await asEditor('editor_me'), { email: 'priest@example.org', owner: false });
  const v = await siteVersion();
  const data = { bank_account_name: 'SBC Global Foundation', bank_name: 'Example Bank', bank_account_no: '0012 3456-78', bank_swift: 'exampl2x', bank_reference: 'Your full name' };
  await denied(saveBank(EDITOR, data, v));              // an ordinary editor, even a trusted one
  await denied(saveBank(STRANGER, data, v));
  await denied(anon('editor_save_bank', { p_expected_version: v, p_data: data }));
  assert.equal((await publicContent()).site.bank_name, undefined);
  await saveBank(OWNER, data, v);
  const s = (await publicContent()).site;
  assert.equal(s.bank_name, 'Example Bank'); assert.equal(s.bank_swift, 'EXAMPL2X'); assert.equal(s.bank_account_no, '0012 3456-78');
  assert.ok(s.about_p1);                                 // other site text untouched
});

test('bank detail rules: allowed fields only, sensible formats, conflicts and retries', async () => {
  let v = await siteVersion();
  await failsWith(saveBank(OWNER, { bank_account_no: '12<script>' }, v), 'PT422', 'bank_account_no');
  await failsWith(saveBank(OWNER, { bank_swift: 'TOOSHORTX1' }, v), 'PT422', 'bank_swift');
  await failsWith(saveBank(OWNER, { about_p1: 'sneaky' }, v), 'PT422', 'about_p1');            // not a bank field
  await failsWith(saveBank(OWNER, { bank_name: 'x'.repeat(81) }, v), 'PT422', 'bank_name');
  const keep = (await publicContent()).site.bank_name;
  await saveBank(OWNER, { bank_name: 'Second Bank' }, v);
  await failsWith(saveBank(OWNER, { bank_name: 'Third Bank' }, v), 'PT409');                    // stale
  assert.ok(await saveBank(OWNER, { bank_name: 'Second Bank' }, v));                            // same save again = retry
  assert.notEqual(keep, 'Second Bank');
  // editors still cannot reach the bank fields through the ordinary site saver
  v = await siteVersion();
  for (const key of ['bank_name', 'bank_account_no']) await failsWith(saveSite({ [key]: '1' }, v), 'PT422', key);
});

test('owner tools: only the database owner can add or promote editors', async () => {
  for (const [role, uid] of [['anon', null], ['authenticated', EDITOR], ['authenticated', OWNER]]) {
    await denied(rpc(role, uid, 'add_editor', { p_email: 'x@example.org', p_owner: true }));
    await denied(rpc(role, uid, 'set_owner', { p_email: 'priest@example.org', p_owner: true }));
  }
  assert.match((await db.query(`select public.set_owner('priest@example.org', true) as r`)).rows[0].r, /now an owner/);
  assert.equal((await asEditor('editor_me')).owner, true);
  await db.query(`select public.set_owner('priest@example.org', false)`);
  assert.equal((await asEditor('editor_me')).owner, false);
  await assert.rejects(db.query(`select public.set_owner('nobody@example.org', true)`), /not an editor yet/);
});
