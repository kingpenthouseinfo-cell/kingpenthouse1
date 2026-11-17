/* SBC Global Foundation — website editor.
 * One phone-friendly page. Open, edit, tap Save: saving is publishing (no drafts, no approval).
 * All writes go to the backend functions editor_*; the backend checks the person's sign-in itself,
 * so nothing in this file is a security boundary. */

const cfg = window.SBC_CONFIG || {};
const BASE = String(cfg.supabaseUrl || '').replace(/\/+$/, '');
const KEY = cfg.anonKey || '';
const SESSION_KEY = 'sbc-admin-session';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return ''; } };
const announce = (t) => { $('#status').textContent = ''; setTimeout(() => { $('#status').textContent = t; }, 30); };

// ───────────────────────────── API ─────────────────────────────
class ApiError extends Error {
  constructor(kind, status, message, field) { super(message); this.kind = kind; this.status = status; this.field = field; }
}
const session = {
  get() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } },
  set(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* private mode */ } memory = s; },
  clear() { try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } memory = null; },
};
let memory = null;
const current = () => session.get() || memory;

function normaliseSession(j) {
  const now = Math.floor(Date.now() / 1000);
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || now + (Number(j.expires_in) || 3600),
    user: j.user || (() => { try { const p = JSON.parse(atob(j.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return { id: p.sub, email: p.email }; } catch { return {}; } })() };
}

async function raw(path, { method = 'GET', body, token, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, { method, cache: 'no-store',
      headers: { apikey: KEY, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body !== undefined && !(body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body) });
  } catch { throw new ApiError('network', 0, 'network'); }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!res.ok) {
    const msg = (data && (data.message || data.msg || data.error_description || data.error)) || ('HTTP ' + res.status);
    throw new ApiError(res.status === 401 || /jwt/i.test(msg) ? 'auth' : 'http', res.status, msg, data && data.details);
  }
  return data;
}

let refreshing = null;
async function freshToken(force = false) {
  const s = current();
  if (!s) throw new ApiError('auth', 401, 'not signed in');
  if (!force && s.expires_at - 60 > Date.now() / 1000) return s.access_token;
  refreshing ||= (async () => {
    try {
      const j = await raw('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s.refresh_token } });
      const ns = normaliseSession(j); session.set(ns); return ns.access_token;
    } catch (e) {
      if (e.kind === 'network') throw e;
      session.clear(); throw new ApiError('auth', 401, 'signed out');
    } finally { refreshing = null; }
  })();
  return refreshing;
}

async function authed(path, opts = {}) {
  let token = await freshToken();
  try { return await raw(path, { ...opts, token }); }
  catch (e) {
    if (e.kind !== 'auth') throw e;
    token = await freshToken(true);            // one retry with a new token
    return raw(path, { ...opts, token });
  }
}
const rpc = (fn, args = {}) => authed(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args });
const publicUrl = (path) => BASE + '/storage/v1/object/public/media/' + path.split('/').map(encodeURIComponent).join('/');
const imgUrl = (src) => (src.includes('/') ? publicUrl(src) : '../assets/' + src);

// ───────────────────────────── Photos ─────────────────────────────
const MAX_EDGE = 1600;
class PhotoError extends Error {}

// Decode, shrink and re-encode a photo. Re-encoding also removes location and camera details (EXIF),
// and "from-image" orientation makes sure phone photos are not turned sideways.
async function processPhoto(file) {
  const looksImage = /^image\//.test(file.type) || /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(file.name || '');
  if (!looksImage) throw new PhotoError('That file is not a photo. Please choose a picture from your phone.');
  let src, w, h;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
    w = src.width; h = src.height;
  } catch {
    try {
      const url = URL.createObjectURL(file);
      src = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
      w = src.naturalWidth; h = src.naturalHeight; URL.revokeObjectURL(url);
    } catch {
      throw new PhotoError('This phone or browser cannot read that kind of photo. Please choose a JPG, PNG or WebP photo (on iPhone: Settings → Camera → Formats → Most Compatible).');
    }
  }
  if (!w || !h) throw new PhotoError('That photo could not be read. Please try another one.');
  const k = Math.min(1, MAX_EDGE / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
  const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch); ctx.drawImage(src, 0, 0, cw, ch);
  if (src.close) src.close();
  const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.82));
  if (!blob || !blob.size) throw new PhotoError('That photo could not be prepared. Please try another one.');
  if (blob.size > 5 * 1024 * 1024) throw new PhotoError('That photo is too big. Please choose a smaller one.');
  return blob;
}

// ───────────────────────────── Messages ─────────────────────────────
const MSG = {
  network: 'Your changes weren’t saved. Check your connection and try again.',
  generic: 'Your changes weren’t saved. Please try again in a moment.',
  denied: 'Your account isn’t allowed to make changes. Please ask the foundation to check your access.',
  signedOut: 'You’ve been signed out. Open the sign-in link we email you (in a new tab is fine), then come back here and tap Save again — what you typed is still here.',
  conflict: 'Someone else changed this after you opened it. Tap “Reload” to see their version, then make your change again.',
  gone: 'This update is no longer on the website.',
};
const FIELD_ID = { title: 'f-title', body: 'f-body', programme: 'f-programme', photos: 'photos-block', name: 'f-name', short_label: 'f-short', context: 'f-context',
  caption: 'f-caption', description: 'f-desc', contact_email: 'f-contact_email' };

function showNote(kind, html, where = 'note') {
  const el = $('#' + where); if (!el) return;
  el.innerHTML = html ? `<div class="note ${kind}" role="${kind === 'bad' ? 'alert' : 'status'}">${html}</div>` : '';
  if (html) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); announce(el.textContent); }
}
function fieldError(id, message) {
  const el = document.getElementById(id); if (!el) return false;
  const wrap = el.closest('.field') || el.closest('#photos-block') || el.parentElement;
  wrap.classList.add('invalid');
  let e = wrap.querySelector('.err'); if (!e) { e = document.createElement('p'); e.className = 'err'; e.id = id + '-err'; wrap.appendChild(e); }
  e.textContent = message; el.setAttribute('aria-describedby', e.id); el.setAttribute('aria-invalid', 'true');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (el.focus) el.focus({ preventScroll: true });
  return true;
}
function clearErrors() {
  app.querySelectorAll('.invalid').forEach((n) => n.classList.remove('invalid'));
  app.querySelectorAll('.err').forEach((n) => n.remove());
  app.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
}

// Turn any failure into something a person can act on. Returns true when it showed a message.
function explain(e, { onReload } = {}) {
  if (e instanceof PhotoError) { showNote('bad', esc(e.message)); return; }
  if (e.kind === 'network') return showNote('bad', MSG.network);
  if (e.kind === 'auth') return showNote('bad', `${MSG.signedOut}<a class="btn" href="#/signin">Email me a sign-in link</a>`);
  if (e.status === 409) { showNote('bad', `${MSG.conflict}<button class="btn" type="button" id="reload">Reload</button>`); $('#reload')?.addEventListener('click', onReload || (() => location.reload())); return; }
  if (e.status === 422) {
    clearErrors();
    const id = FIELD_ID[e.field];
    if (id && fieldError(id, e.message)) { showNote('bad', esc(e.message)); return; }
    return showNote('bad', esc(e.message));
  }
  if (e.status === 404) return showNote('bad', MSG.gone);
  if (e.status === 403 || e.status === 401) return showNote('bad', MSG.denied);
  if (e.status === 413 || e.status === 415) return showNote('bad', 'A photo was too large or in a format the website cannot use. Remove it and choose a different photo.');
  return showNote('bad', MSG.generic);
}

// ───────────────────────────── Views ─────────────────────────────
let content = null;     // latest editor_content()
let me = null;
const programmeName = (id) => (content?.programmes.find((p) => p.id === id) || {}).name || '';

function setView(html, { bar = false, title = '' } = {}) {
  app.innerHTML = html; app.classList.toggle('has-bar', bar);
  document.title = (title ? title + ' · ' : '') + 'SBC Website Editor';
  window.scrollTo(0, 0); app.focus({ preventScroll: true });
  const h = $('h1', app); if (h) announce(h.textContent);
}
const back = (href, text = 'Back') => `<a class="back" href="${href}">← ${esc(text)}</a>`;
function bar(label = 'Save') {
  return `<div class="bar"><div class="inner"><button class="btn primary" id="save" type="submit" form="form">${label}</button></div></div>`;
}

async function loadContent() { content = await rpc('editor_content'); return content; }

function viewLoading(msg = 'Loading…') { setView(`<p class="loading" role="status">${esc(msg)}</p>`); }
function viewError(e, retry) {
  const text = e.kind === 'network' ? 'We couldn’t reach the website. Check your connection and try again.' : e.status === 403 ? MSG.denied : 'Something went wrong. Please try again.';
  setView(`${back('#/')}<h1>Couldn’t load</h1><div class="note bad">${text}</div><button class="btn primary" id="retry">Try again</button>`);
  $('#retry').addEventListener('click', retry);
}

function viewSignIn(msg = '', sent = '') {
  const note = msg ? `<div class="note bad" role="alert">${msg}</div>` : '';
  if (sent) {
    setView(`<h1>Check your email</h1>${note}
      <p>If <b>${esc(sent)}</b> has been set up as an editor, we’ve sent a sign-in link. Open it on this phone.</p>
      <form id="codeform" class="group" autocomplete="off"><h2>Link opens somewhere else?</h2>
        ${fld('code', 'Type the 6-digit code from the email', '<input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" pattern="[0-9]*">')}
        <button class="btn primary" type="submit" id="codebtn">Sign in with the code</button></form>
      <a class="link" href="#/signin">Use a different email address</a>`, { title: 'Check your email' });
    $('#codeform').addEventListener('submit', async (ev) => {
      ev.preventDefault(); const btn = $('#codebtn'); const code = $('#code').value.trim(); if (!code) return;
      btn.disabled = true; btn.textContent = 'Signing in…';
      try { const j = await raw('/auth/v1/verify', { method: 'POST', body: { type: 'email', email: sent, token: code } }); session.set(normaliseSession(j)); history.replaceState(null, '', location.pathname + '#/'); start(); }
      catch (e) { btn.disabled = false; btn.textContent = 'Sign in with the code'; viewSignIn(e.kind === 'network' ? MSG.network : 'That code didn’t work. Check it and try again, or ask for a new link.', sent); }
    });
    return;
  }
  setView(`<h1>Sign in</h1>${note}
    <p>Enter the email address the foundation invited. We’ll email you a link — no password needed.</p>
    <form id="signin" novalidate>${fld('email', 'Your email address', '<input id="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" required>')}
      <button class="btn primary" type="submit" id="sendbtn">Email me a sign-in link</button></form>
    <p class="hint">Tip: save this page to your phone’s home screen so it’s one tap away.</p>`, { title: 'Sign in' });
  $('#signin').addEventListener('submit', async (ev) => {
    ev.preventDefault(); const email = $('#email').value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { clearErrors(); fieldError('email', 'Please type your email address, like name@example.com.'); return; }
    const btn = $('#sendbtn'); btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await raw('/auth/v1/otp?redirect_to=' + encodeURIComponent(location.origin + location.pathname), { method: 'POST', body: { email, create_user: false } });
      viewSignIn('', email);
    } catch (e) {
      if (e.kind === 'network' || e.status >= 500 || e.status === 429) { btn.disabled = false; btn.textContent = 'Email me a sign-in link'; viewSignIn(e.status === 429 ? 'Too many tries. Please wait a minute and try again.' : MSG.network); }
      else viewSignIn('', email);     // same answer whether or not the address is known
    }
  });
}

function viewNotEditor() {
  setView(`<h1>Not set up yet</h1><div class="note info">You’re signed in as <b>${esc(session.get()?.user?.email || '')}</b>, but this address hasn’t been set up as an editor of the website.</div>
    <p>Please ask the foundation to add you, then come back.</p><button class="btn" id="out">Sign out</button>`);
  $('#out').addEventListener('click', signOut);
}

function viewHome() {
  setView(`<h1>What would you like to do?</h1>
    <a class="big primary" href="#/add"><span class="ico" aria-hidden="true">＋</span><span><b>Add an update</b><small>Tell everyone what happened. Add photos.</small></span></a>
    <a class="big" href="#/edit"><span class="ico" aria-hidden="true">✎</span><span><b>Edit an update or programme</b><small>Fix a mistake or change a description.</small></span></a>
    <a class="big" href="#/site"><span class="ico" aria-hidden="true">ⓘ</span><span><b>Edit site information</b><small>The About page and contact details.</small></span></a>
    <p class="who">Signed in as ${esc(me?.email || '')} · <button class="link" id="out" type="button">Sign out</button></p>
    <p><a href="../" target="_blank" rel="noopener">Look at the website ↗</a></p>`);
  $('#out').addEventListener('click', signOut);
}

function viewEditChoice() {
  setView(`${back('#/')}<h1>Edit an update or programme</h1>
    <a class="big" href="#/edit/updates"><span><b>Updates</b><small>News you’ve posted</small></span></a>
    <a class="big" href="#/edit/programmes"><span><b>Programmes</b><small>School Supplies, Water &amp; Building, and the others</small></span></a>`);
}

async function viewUpdateList() {
  viewLoading();
  try { await loadContent(); } catch (e) { return viewError(e, viewUpdateList); }
  const rows = content.updates.map((u) => `<a class="row" href="#/update/${esc(u.id)}"><b>${esc(u.title)}</b><small>${esc(fmtDate(u.published_at))} · ${esc(programmeName(u.programme_id) || 'General update')}</small></a>`).join('');
  setView(`${back('#/edit')}<h1>Updates</h1>${rows || '<p>There are no updates yet.</p>'}<a class="big primary" href="#/add"><span class="ico" aria-hidden="true">＋</span><span><b>Add an update</b></span></a>`);
}

async function viewProgrammeList() {
  viewLoading();
  try { await loadContent(); } catch (e) { return viewError(e, viewProgrammeList); }
  const rows = content.programmes.map((p) => `<a class="row" href="#/programme/${esc(p.id)}"><b>${String(p.position + 1).padStart(2, '0')} · ${esc(p.name)}</b><small>${esc(p.context || '')}</small></a>`).join('');
  setView(`${back('#/edit')}<h1>Programmes</h1>${rows}<a class="big" href="#/programme/new"><span class="ico" aria-hidden="true">＋</span><span><b>Add a programme</b></span></a>`);
}

// A labelled field. The hint is tied to the control with aria-describedby (not part of its name).
function fld(id, label, control, { opt = false, hint = '' } = {}) {
  return `<div class="field"><label for="${id}"><span>${label}</span>${opt ? ' <span class="opt">(optional)</span>' : ''}</label>${control}${hint ? `<p class="hint" id="${id}-hint">${hint}</p>` : ''}</div>`;
}
const withHint = (hint, id) => (hint ? ` aria-describedby="${id}-hint"` : '');

// ── photo picker (shared by updates and programmes) ──
function photoPicker(list, { max, mainWord }) {
  const root = $('#photos-block');
  function draw() {
    const items = list.map((p, i) => `<li data-id="${esc(p.id)}"><img src="${esc(p.preview || imgUrl(p.src))}" alt="Photo ${i + 1}">
      <span class="tag">${i === 0 ? mainWord : ''}</span>
      <div class="tools"><button type="button" data-act="left" aria-label="Move photo ${i + 1} earlier" ${i === 0 ? 'disabled' : ''}>◀</button>
      <button type="button" data-act="right" aria-label="Move photo ${i + 1} later" ${i === list.length - 1 ? 'disabled' : ''}>▶</button>
      <button type="button" class="rm" data-act="rm" aria-label="Remove photo ${i + 1}">✕</button></div></li>`).join('');
    $('#photo-list', root).innerHTML = items;
    $('#photo-count', root).textContent = list.length ? `${list.length} photo${list.length === 1 ? '' : 's'}${list.length > 1 ? ' — the first one is the main photo' : ''}.` : 'No photos yet.';
  }
  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-act]'); if (!b) return;
    const id = b.closest('li').dataset.id; const i = list.findIndex((p) => p.id === id); if (i < 0) return;
    if (b.dataset.act === 'rm') { const [x] = list.splice(i, 1); if (x.preview) URL.revokeObjectURL(x.preview); }
    if (b.dataset.act === 'left' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    if (b.dataset.act === 'right' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    draw();
  });
  $('#photo-input', root).addEventListener('change', async (ev) => {
    const files = [...ev.target.files]; ev.target.value = '';
    clearErrors(); showNote('', '');
    const busy = $('#photo-busy', root); let failed = '';
    for (const f of files) {
      if (list.length >= max) { failed = `You can add up to ${max} photos here.`; break; }
      busy.textContent = 'Preparing photo…';
      try { const blob = await processPhoto(f); list.push({ id: uuid(), blob, preview: URL.createObjectURL(blob) }); }
      catch (e) { failed = e instanceof PhotoError ? e.message : 'That photo could not be added.'; }
    }
    busy.textContent = ''; draw(); if (failed) showNote('bad', esc(failed));
  });
  draw();
}
const photoBlock = (hint) => `<div id="photos-block" class="field" role="group" aria-labelledby="photos-label"><span class="label" id="photos-label">Photos <span class="opt">(optional)</span></span>
  <p class="hint" id="photo-count"></p><ul class="photos" id="photo-list"></ul>
  <label class="btn quiet filebtn"><span>＋ Add photos</span><input id="photo-input" type="file" accept="image/*" multiple aria-label="Add photos from your camera or photo library"></label>
  <p class="hint" id="photo-busy" aria-live="polite"></p>${hint ? `<p class="hint">${hint}</p>` : ''}</div>`;

// Upload any photos that are not on the server yet. Safe to repeat: finished uploads are remembered.
async function uploadPending(list) {
  const uid = current()?.user?.id;
  for (const p of list) {
    if (p.src || p.path) continue;
    const path = `${uid}/${uuid()}.jpg`;
    await authed('/storage/v1/object/media/' + path.split('/').map(encodeURIComponent).join('/'),
      { method: 'POST', body: p.blob, headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'false', 'cache-control': 'max-age=31536000' } });
    p.path = path;
  }
  return list.map((p) => p.src || p.path);
}

// One save button, one behaviour: no double taps, clear messages, nothing lost on failure.
function wireSave({ validate, work, done, onReload }) {
  const form = $('#form'); let saving = false;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault(); if (saving) return;
    clearErrors(); showNote('', '');
    if (!validate()) return;
    saving = true; const btn = $('#save'); btn.disabled = true; btn.textContent = 'Saving…'; announce('Saving…');
    try { const out = await work(); announce('Saved. Your changes are live.'); done(out); }
    catch (e) { saving = false; btn.disabled = false; btn.textContent = 'Save'; explain(e, { onReload }); }
  });
}
function requireText(id, message) {
  const el = document.getElementById(id); if (el.value.trim()) return true;
  fieldError(id, message); return false;
}
function viewDone({ heading, text, viewHref, viewLabel = 'See it on the website', another }) {
  setView(`<div class="done"><div class="tick" aria-hidden="true">✓</div><h1>Saved. Your changes are live.</h1><p>${esc(text)}</p></div>
    ${viewHref ? `<a class="btn primary" href="${esc(viewHref)}" target="_blank" rel="noopener">${esc(viewLabel)} ↗</a>` : ''}
    ${another ? `<a class="btn" href="${esc(another.href)}">${esc(another.label)}</a>` : ''}
    <a class="btn quiet" href="#/">Back to the main screen</a>`, { title: 'Saved' });
}

// ── update form (add + edit) ──
async function viewUpdateForm(id) {
  viewLoading();
  try { await loadContent(); } catch (e) { return viewError(e, () => viewUpdateForm(id)); }
  const existing = id ? content.updates.find((u) => u.id === id) : null;
  if (id && !existing) { setView(`${back('#/edit/updates')}<h1>Not found</h1><div class="note info">${MSG.gone}</div>`); return; }
  const photos = (existing?.images || []).map((src) => ({ id: uuid(), src }));
  const token = uuid(); let version = existing?.version;
  const opts = ['<option value="">General update</option>',
    ...content.programmes.map((p) => `<option value="${esc(p.id)}" ${existing?.programme_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`)].join('');
  setView(`${back(existing ? '#/edit/updates' : '#/', 'Back')}<h1>${existing ? 'Edit update' : 'Add an update'}</h1><div id="note"></div>
    <form id="form" novalidate>
      ${fld('f-title', 'Title', `<input id="f-title" type="text" maxlength="120" autocomplete="off" value="${esc(existing?.title || '')}" required>`)}
      ${fld('f-body', 'What happened?', `<textarea id="f-body" maxlength="5000" required${withHint('x', 'f-body')}>${esc(existing?.body || '')}</textarea>`, { hint: 'Leave a blank line between paragraphs.' })}
      ${fld('f-programme', 'Programme', `<select id="f-programme">${opts}</select>`)}
      ${photoBlock('The first photo is shown first. Use ◀ ▶ to change the order.')}
    </form>
    ${existing ? `<h2>Made a mistake?</h2><div id="rmbox"><button class="btn danger" type="button" id="rm">Remove from website</button></div>` : ''}
    ${bar('Save')}`, { bar: true, title: existing ? 'Edit update' : 'Add an update' });
  photoPicker(photos, { max: 12, mainWord: 'First photo' });

  wireSave({
    validate: () => { let ok = true; if (!requireText('f-body', 'Please write what happened.')) ok = false; if (!requireText('f-title', 'Please give the update a title.')) ok = false; return ok; },
    work: async () => {
      const images = await uploadPending(photos);
      const out = await rpc('editor_save_update', { p_id: existing?.id ?? null, p_expected_version: version ?? null, p_title: $('#f-title').value, p_body: $('#f-body').value,
        p_programme_id: $('#f-programme').value || null, p_images: images, p_client_token: existing ? null : token });
      version = out.version; return out;
    },
    done: (out) => viewDone({ text: existing ? 'Your correction is on the website.' : 'Your update is now on the website.', viewHref: `../#update/${out.id}`,
      another: existing ? null : { href: '#/add', label: 'Add another update' } }),
    onReload: () => viewUpdateForm(id),
  });
  // keep each save from ever creating a second copy: new updates reuse one token, even if the page re-renders
  if (existing) wireRemove(existing, () => version);
  followKeyboard();
}

function wireRemove(existing, getVersion) {
  const box = $('#rmbox');
  box.addEventListener('click', async (ev) => {
    const t = ev.target.closest('button'); if (!t) return;
    if (t.id === 'rm') {
      box.innerHTML = `<div class="confirm" role="alertdialog" aria-labelledby="cq"><p id="cq"><b>Remove this update from the website?</b><br>Visitors will no longer see it.</p>
        <button class="btn danger solid" type="button" id="yes">Yes, remove it</button><button class="btn quiet" type="button" id="no">No, keep it</button></div>`;
      $('#no').focus(); box.scrollIntoView({ block: 'center' });
    } else if (t.id === 'no') {
      box.innerHTML = '<button class="btn danger" type="button" id="rm">Remove from website</button>';
    } else if (t.id === 'yes') {
      t.disabled = true; t.textContent = 'Removing…';
      try { await rpc('editor_remove_update', { p_id: existing.id, p_expected_version: getVersion() }); viewDone({ text: 'The update is no longer on the website.', another: { href: '#/edit/updates', label: 'Back to the list of updates' } }); }
      catch (e) { t.disabled = false; t.textContent = 'Yes, remove it'; explain(e, { onReload: () => viewUpdateForm(existing.id) }); }
    }
  });
}

// ── programme form ──
async function viewProgrammeForm(id) {
  viewLoading();
  try { await loadContent(); } catch (e) { return viewError(e, () => viewProgrammeForm(id)); }
  const existing = id !== 'new' ? content.programmes.find((p) => p.id === id) : null;
  if (id !== 'new' && !existing) { setView(`${back('#/edit/programmes')}<h1>Not found</h1><div class="note info">This programme could not be found.</div>`); return; }
  const photos = (existing?.images || []).map((src) => ({ id: uuid(), src }));
  const token = uuid(); let version = existing?.version;
  setView(`${back('#/edit/programmes')}<h1>${existing ? 'Edit programme' : 'Add a programme'}</h1><div id="note"></div>
    <form id="form" novalidate>
      ${fld('f-name', 'Programme name', `<input id="f-name" type="text" maxlength="80" value="${esc(existing?.name || '')}" required>`)}
      ${fld('f-short', 'Short name for the menu', `<input id="f-short" type="text" maxlength="24" value="${esc(existing?.short_label || '')}" required${withHint('x', 'f-short')}>`, { hint: 'One or two words, e.g. “School”.' })}
      ${fld('f-context', 'Where it happens', `<input id="f-context" type="text" maxlength="80" value="${esc(existing?.context || '')}">`, { opt: true })}
      ${fld('f-caption', 'Caption under the main photo', `<input id="f-caption" type="text" maxlength="80" value="${esc(existing?.caption || '')}">`, { opt: true })}
      ${fld('f-desc', 'Description', `<textarea id="f-desc" maxlength="800">${esc(existing?.description || '')}</textarea>`, { opt: true })}
      ${photoBlock('The first photo is the main photo. Use ◀ ▶ to move a different photo to the front.')}
    </form>${bar('Save')}`, { bar: true, title: existing ? 'Edit programme' : 'Add a programme' });
  photoPicker(photos, { max: 24, mainWord: 'Main photo' });
  wireSave({
    validate: () => { let ok = true; if (!requireText('f-short', 'Please type a short name for the menu.')) ok = false; if (!requireText('f-name', 'Please type the programme name.')) ok = false; return ok; },
    work: async () => {
      const images = await uploadPending(photos);
      const out = await rpc('editor_save_programme', { p_id: existing?.id ?? null, p_expected_version: version ?? null, p_name: $('#f-name').value, p_short_label: $('#f-short').value,
        p_context: $('#f-context').value, p_caption: $('#f-caption').value, p_description: $('#f-desc').value, p_images: images, p_client_token: existing ? null : token });
      version = out.version; return out;
    },
    done: (out) => viewDone({ text: existing ? 'Your changes to the programme are on the website.' : 'The new programme is now on the website.', viewHref: `../#programme/${out.position}`, viewLabel: 'See the programme' }),
    onReload: () => viewProgrammeForm(id),
  });
  followKeyboard();
}

// ── site information ──
const SITE_FIELDS = [
  ['About page', [
    ['about_kicker', 'Small line above the heading', 'text', 60],
    ['about_heading', 'Heading', 'text', 120],
    ['about_heading_italic', 'Heading — last words (shown in green italics)', 'text', 120],
    ['about_p1', 'First paragraph', 'area', 800],
    ['about_p2', 'Second paragraph', 'area', 800],
    ['about_p2_italic', 'Last words of the second paragraph (shown in italics)', 'text', 200]]],
  ['Who carries the work out', [1, 2, 3].flatMap((n) => [[`partner${n}_title`, `Group ${n} — name`, 'text', 80], [`partner${n}_text`, `Group ${n} — what they do`, 'area', 300]])],
  ['Contact details (optional)', [
    ['contact_email', 'Email address', 'email', 120, 'Leave empty to keep it off the website.'],
    ['contact_phone', 'Phone number', 'tel', 40, 'Leave empty to keep it off the website.'],
    ['contact_address', 'Postal address', 'area', 240, 'Leave empty to keep it off the website.']]],
];
async function viewSiteForm() {
  viewLoading();
  try { await loadContent(); } catch (e) { return viewError(e, viewSiteForm); }
  let version = content.site_version; const site = content.site || {};
  const groups = SITE_FIELDS.map(([title, fields]) => `<fieldset class="group"><h2>${esc(title)}</h2>${fields.map(([k, label, type, max, hint]) => {
    const v = site[k] ?? '';
    const input = type === 'area' ? `<textarea id="f-${k}" maxlength="${max}" style="min-height:110px"${withHint(hint, 'f-' + k)}>${esc(v)}</textarea>`
      : `<input id="f-${k}" type="${type}" maxlength="${max}" value="${esc(v)}" ${type === 'email' ? 'inputmode="email" autocapitalize="none"' : ''}${withHint(hint, 'f-' + k)}>`;
    return fld('f-' + k, esc(label), input, { hint: hint ? esc(hint) : '' });
  }).join('')}</fieldset>`).join('');
  setView(`${back('#/')}<h1>Site information</h1><div id="note"></div><form id="form" novalidate>${groups}</form>${bar('Save')}`, { bar: true, title: 'Site information' });
  wireSave({
    validate: () => { const em = $('#f-contact_email').value.trim(); if (em && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return !fieldError('f-contact_email', 'That email address does not look right.'); return true; },
    work: async () => {
      const data = {}; SITE_FIELDS.forEach(([, fs]) => fs.forEach(([k]) => { data[k] = $('#f-' + k).value; }));
      const out = await rpc('editor_save_site', { p_expected_version: version, p_data: data }); version = out.version; return out;
    },
    done: () => viewDone({ text: 'The About page and contact details are updated.', viewHref: '../#about', viewLabel: 'See the About page' }),
    onReload: viewSiteForm,
  });
  followKeyboard();
}

// Keep the Save bar above the on-screen keyboard and the field being typed in visible.
let kbWired = false;
function followKeyboard() {
  const vv = window.visualViewport; if (!vv) return;
  const set = () => document.documentElement.style.setProperty('--kb', Math.max(0, window.innerHeight - vv.height - vv.offsetTop) + 'px');
  if (!kbWired) { vv.addEventListener('resize', set); vv.addEventListener('scroll', set); kbWired = true; }
  set();
  app.addEventListener('focusin', (ev) => { if (/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) setTimeout(() => ev.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300); });
}

// ───────────────────────────── Start / routing ─────────────────────────────
async function signOut() {
  const s = session.get();
  session.clear(); content = null; me = null;
  if (s) raw('/auth/v1/logout', { method: 'POST', token: s.access_token }).catch(() => {});
  history.replaceState(null, '', location.pathname + '#/signin'); route();
}

function takeSignInFromUrl() {
  if (!location.hash.includes('access_token=') && !location.hash.includes('error=')) return null;
  const q = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + '#/');
  if (q.get('access_token')) { session.set(normaliseSession({ access_token: q.get('access_token'), refresh_token: q.get('refresh_token'), expires_in: q.get('expires_in') })); return 'ok'; }
  return 'error';
}

async function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  if (!current()) { if (h === '/signin' || h === '/') return viewSignIn(window.__signInProblem || ''); location.hash = '#/signin'; return; }
  if (!me) {
    viewLoading('Signing in…');
    try { me = await rpc('editor_me'); }
    catch (e) { if (e.kind === 'network') return viewError(e, route); if (e.kind === 'auth' && !current()) return viewSignIn(); return viewNotEditor(); }
  }
  let m;
  if (h === '/' || h === '') return viewHome();
  if (h === '/signin') return viewSignIn();
  if (h === '/add') return viewUpdateForm(null);
  if (h === '/edit') return viewEditChoice();
  if (h === '/edit/updates') return viewUpdateList();
  if (h === '/edit/programmes') return viewProgrammeList();
  if ((m = h.match(/^\/update\/([0-9a-f-]{36})$/))) return viewUpdateForm(m[1]);
  if (h === '/programme/new') return viewProgrammeForm('new');
  if ((m = h.match(/^\/programme\/([0-9a-f-]{36})$/))) return viewProgrammeForm(m[1]);
  if (h === '/site') return viewSiteForm();
  location.hash = '#/';
}

function start() {
  if (!BASE || !KEY) { setView('<h1>Not set up yet</h1><div class="note info">The website editor has not been connected to its storage yet. The person who set up the website needs to finish the setup (see the Owner setup guide).</div>'); return; }
  const r = takeSignInFromUrl();
  window.__signInProblem = r === 'error' ? 'That sign-in link has expired or was already used. Please ask for a new one below.' : '';
  route();
}
window.addEventListener('hashchange', route);
start();
