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
