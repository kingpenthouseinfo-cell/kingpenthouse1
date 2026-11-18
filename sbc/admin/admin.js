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
const videoUrl = (path) => BASE + '/storage/v1/object/public/videos/' + path.split('/').map(encodeURIComponent).join('/');

// Upload one file to storage, with progress. Used for photos and videos.
async function uploadFile(bucket, path, blob, contentType, onProgress) {
  const send = (token) => new Promise((ok, no) => {
    const x = new XMLHttpRequest();
    x.open('POST', `${BASE}/storage/v1/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`);
    x.setRequestHeader('apikey', KEY); x.setRequestHeader('Authorization', 'Bearer ' + token);
    x.setRequestHeader('Content-Type', contentType); x.setRequestHeader('x-upsert', 'false'); x.setRequestHeader('cache-control', 'max-age=31536000');
    if (onProgress) x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onerror = x.ontimeout = () => no(new ApiError('network', 0, 'network'));
    x.timeout = 15 * 60 * 1000;
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return ok();
      let m = ''; try { m = JSON.parse(x.responseText).message; } catch { /* not JSON */ }
      no(new ApiError(x.status === 401 ? 'auth' : 'http', x.status, m || ('HTTP ' + x.status)));
    };
    x.send(blob);
  });
  try { await send(await freshToken()); }
  catch (e) { if (e.kind !== 'auth') throw e; await send(await freshToken(true)); }
}

// Run fn over items a few at a time (keeps order of results). Stops starting new work after a failure.
async function pool(items, limit, fn) {
  const out = new Array(items.length); let next = 0, failed = false;
  const worker = async () => { while (!failed && next < items.length) { const i = next++; try { out[i] = await fn(items[i], i); } catch (e) { failed = true; throw e; } } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
const progress = (text) => { const b = $('#save'); if (b && b.disabled) b.textContent = text; };

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
  caption: 'f-caption', description: 'f-desc', contact_email: 'f-contact_email', videos: 'videos-block' };

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
    const id = FIELD_ID[e.field] || (e.field && document.getElementById('f-' + e.field) ? 'f-' + e.field : null);
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
    <p>Enter the email address the foundation invited. We’ll email you a link — no password needed. Or, if you have set a password, use that.</p>
    <form id="signin" novalidate>${fld('email', 'Your email address', '<input id="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" required>')}
      <button class="btn primary" type="button" id="sendbtn">Email me a sign-in link</button>
      <div class="group"><h2>Or sign in with a password</h2>
        ${fld('password', 'Password', '<input id="password" type="password" autocomplete="current-password">')}
        <button class="btn" type="submit" id="pwbtn">Sign in with password</button></div></form>
    <p class="hint">Tip: save this page to your phone’s home screen so it’s one tap away.</p>`, { title: 'Sign in' });
  const checkEmail = () => { const email = $('#email').value.trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { clearErrors(); fieldError('email', 'Please type your email address, like name@example.com.'); return ''; } return email; };
  $('#signin').addEventListener('submit', async (ev) => {
    ev.preventDefault(); const email = checkEmail(); if (!email) return;
    const pw = $('#password').value;
    if (!pw) { if (ev.submitter?.id === 'pwbtn') { clearErrors(); fieldError('password', 'Please type your password.'); } else sendLink(email); return; }
    const btn = $('#pwbtn'); btn.disabled = true; btn.textContent = 'Signing in…';
    try { const j = await raw('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: pw } }); session.set(normaliseSession(j)); history.replaceState(null, '', location.pathname + '#/'); start(); }
    catch (e) {
      btn.disabled = false; btn.textContent = 'Sign in with password'; clearErrors();
      fieldError('password', e.kind === 'network' ? MSG.network : e.status === 429 ? 'Too many tries. Please wait a minute and try again.' : 'That email or password isn’t right. Try again, or tap “Email me a sign-in link”.');
    }
  });
  $('#sendbtn').addEventListener('click', () => { const email = checkEmail(); if (email) sendLink(email); });
  async function sendLink(email) {
    const btn = $('#sendbtn'); btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await raw('/auth/v1/otp?redirect_to=' + encodeURIComponent(location.origin + location.pathname), { method: 'POST', body: { email, create_user: false } });
      viewSignIn('', email);
    } catch (e) {
      if (e.kind === 'network' || e.status >= 500 || e.status === 429) { btn.disabled = false; btn.textContent = 'Email me a sign-in link'; viewSignIn(e.status === 429 ? 'Too many tries. Please wait a minute and try again.' : MSG.network); }
      else viewSignIn('', email);     // same answer whether or not the address is known
    }
  }
}

function viewNotEditor() {
  setView(`<h1>Not set up yet</h1><div class="note info">You’re signed in as <b>${esc(session.get()?.user?.email || '')}</b>, but this address hasn’t been set up as an editor of the website.</div>
    <p>Please ask the foundation to add you, then come back.</p><button class="btn" id="out">Sign out</button>`);
  $('#out').addEventListener('click', signOut);
}

function viewHome() {
  setView(`<h1>What would you like to do?</h1>
    <a class="big primary" href="#/add"><span class="ico" aria-hidden="true">＋</span><b>Add an update</b></a>
    <a class="big" href="#/edit/updates"><span class="ico" aria-hidden="true">✎</span><b>Edit an update</b></a>
    <a class="big" href="#/edit/programmes"><span class="ico" aria-hidden="true">✎</span><b>Edit a programme</b></a>
    <a class="big" href="#/site"><span class="ico" aria-hidden="true">✎</span><b>Edit the About page</b></a>
    ${me?.owner ? '<a class="big" href="#/bank"><span class="ico" aria-hidden="true">✎</span><b>Edit bank details</b></a>' : ''}
    <p class="who">Signed in as ${esc(me?.email || '')} · <button class="link" id="out" type="button">Sign out</button></p>
    <p><a href="#/password">Set or change my password</a></p>
    <p><a href="../" target="_blank" rel="noopener">Look at the website ↗</a></p>`);
  $('#out').addEventListener('click', signOut);
}

async function viewUpdateList() {
  viewLoading();
  try { await loadContent(); } catch (e) { return viewError(e, viewUpdateList); }
  const rows = content.updates.map((u) => `<a class="row" href="#/update/${esc(u.id)}"><b>${esc(u.title)}</b><small>${esc(fmtDate(u.published_at))} · ${esc(programmeName(u.programme_id) || 'General update')}</small></a>`).join('');
  setView(`${back('#/')}<h1>Edit an update</h1>${rows ? '<p>Choose the update you want to change.</p>' + rows : '<p>There are no updates yet.</p>'}<a class="big primary" href="#/add"><span class="ico" aria-hidden="true">＋</span><span><b>Add an update</b></span></a>`);
}

async function viewProgrammeList() {
  viewLoading();
  try { await loadContent(); } catch (e) { return viewError(e, viewProgrammeList); }
  const rows = content.programmes.map((p) => `<a class="big" href="#/programme/${esc(p.id)}"><span class="num">${String(p.position + 1).padStart(2, '0')}</span><b>${esc(p.name)}</b></a>`).join('');
  setView(`${back('#/')}<h1>Edit a programme</h1><p>Choose a programme.</p>${rows}<a class="big primary" href="#/programme/new"><span class="ico" aria-hidden="true">＋</span><span><b>Add a programme</b></span></a>`);
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
    if (!files.length) return;
    clearErrors(); showNote('', '');
    const take = files.slice(0, Math.max(0, max - list.length)); const left = files.length - take.length;
    const busy = $('#photo-busy', root); const problems = []; let done = 0;
    if (left > 0) problems.push(`You can have up to ${max} photos here, so ${left} ${left === 1 ? 'photo was' : 'photos were'} left out.`);
    busy.textContent = `Preparing ${take.length} photo${take.length === 1 ? '' : 's'}…`;
    const results = await pool(take, 3, async (f) => {
      try { const blob = await processPhoto(f); return { id: uuid(), blob, preview: URL.createObjectURL(blob) }; }
      catch (e) { problems.push(e instanceof PhotoError ? e.message : 'A photo could not be added.'); return null; }
      finally { done++; busy.textContent = `Preparing photos… ${done} of ${take.length}`; }
    });
    const added = results.filter(Boolean); added.forEach((r) => list.push(r));
    busy.textContent = added.length ? `Added ${added.length} photo${added.length === 1 ? '' : 's'}.` : '';
    draw(); if (problems.length) showNote('bad', [...new Set(problems)].map(esc).join('<br>'));
  });
  draw();
}
const photoBlock = (hint) => `<div id="photos-block" class="field" role="group" aria-labelledby="photos-label"><span class="label" id="photos-label">Photos <span class="opt">(optional)</span></span>
  <p class="hint" id="photo-count"></p><ul class="photos" id="photo-list"></ul>
  <label class="btn quiet filebtn"><span>＋ Add photos</span><input id="photo-input" type="file" accept="image/*" multiple aria-label="Add photos from your camera or photo library"></label>
  <p class="hint" id="photo-busy" aria-live="polite"></p><p class="hint">You can choose many photos at once.</p>${hint ? `<p class="hint">${hint}</p>` : ''}</div>`;

// Upload any photos that are not on the server yet, a few at a time. Safe to repeat: finished uploads are remembered.
async function uploadPending(list) {
  const uid = current()?.user?.id; const todo = list.filter((p) => !p.src && !p.path); let n = 0;
  await pool(todo, 3, async (p) => {
    const path = `${uid}/${uuid()}.jpg`;
    await uploadFile('media', path, p.blob, 'image/jpeg');
    p.path = path; n++; progress(`Uploading photos… ${n} of ${todo.length}`);
  });
  return list.map((p) => p.src || p.path);
}

// ── videos (programmes only) ──
const MAX_VIDEO = 50 * 1024 * 1024;
const VIDEO_TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';

// A still picture from the video (so it shows before anyone presses play). Resolves to null if the phone
// can't make one; rejects only if the phone clearly cannot open the video at all.
async function makePoster(file) {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    const opened = await new Promise((ok, no) => { const t = setTimeout(() => ok(false), 10000); v.onloadeddata = () => { clearTimeout(t); ok(true); }; v.onerror = () => { clearTimeout(t); no(new Error('cannot open')); }; });
    if (!opened || !v.videoWidth) return null;
    await new Promise((ok) => { const t = setTimeout(ok, 4000); v.onseeked = () => { clearTimeout(t); ok(); }; try { v.currentTime = Math.min(1, (v.duration || 2) / 2); } catch { clearTimeout(t); ok(); } });
    const k = Math.min(1, 640 / v.videoWidth); const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.75));
  } finally { URL.revokeObjectURL(url); }
}
async function prepareVideo(file) {
  const ext = ((file.name || '').split('.').pop() || '').toLowerCase();
  const type = VIDEO_TYPES[ext] || (Object.values(VIDEO_TYPES).includes(file.type) ? file.type : '');
  if (!type) throw new PhotoError(`“${file.name || 'That file'}” is not a video the website can use. Please choose an MP4, MOV or WebM video.`);
  if (file.size > MAX_VIDEO) throw new PhotoError(`“${file.name}” is too big (${mb(file.size)}). Videos can be up to 50 MB. Try a shorter clip, or record at a lower quality (iPhone: Settings → Camera → Record Video → 720p HD).`);
  let poster = null;
  try { poster = await makePoster(file); } catch { throw new PhotoError(`This phone couldn’t open “${file.name}”, so it can’t be added. Please choose a different video.`); }
  const finalExt = type === 'video/quicktime' ? 'mov' : type === 'video/webm' ? 'webm' : 'mp4';
  return { id: uuid(), file, type, ext: finalExt, size: file.size, posterBlob: poster, preview: poster ? URL.createObjectURL(poster) : '' };
}
const videoBlock = () => `<div id="videos-block" class="field" role="group" aria-labelledby="videos-label"><span class="label" id="videos-label">Videos <span class="opt">(optional)</span></span>
  <p class="hint" id="video-count"></p><ul class="photos" id="video-list"></ul>
  <label class="btn quiet filebtn"><span>＋ Add videos</span><input id="video-input" type="file" accept="video/mp4,video/quicktime,video/webm,video/*" multiple aria-label="Add videos from your camera or library"></label>
  <p class="hint" id="video-busy" aria-live="polite"></p>
  <p class="hint">Short clips work best. Each video can be up to 50 MB. You can choose several at once.</p></div>`;
function videoPicker(list, { max }) {
  const root = $('#videos-block');
  function draw() {
    $('#video-list', root).innerHTML = list.map((v, i) => {
      const thumb = v.preview || (v.poster ? imgUrl(v.poster) : '');
      return `<li data-id="${esc(v.id)}">${thumb ? `<img src="${esc(thumb)}" alt="Video ${i + 1}">` : `<div class="vph" role="img" aria-label="Video ${i + 1}">▶</div>`}
      <span class="tag">${esc(v.size ? 'Video ' + (i + 1) + ' · ' + mb(v.size) : 'Video ' + (i + 1))}</span>
      <div class="tools"><button type="button" data-act="left" aria-label="Move video ${i + 1} earlier" ${i === 0 ? 'disabled' : ''}>◀</button>
      <button type="button" data-act="right" aria-label="Move video ${i + 1} later" ${i === list.length - 1 ? 'disabled' : ''}>▶</button>
      <button type="button" class="rm" data-act="rm" aria-label="Remove video ${i + 1}">✕</button></div></li>`;
    }).join('');
    $('#video-count', root).textContent = list.length ? `${list.length} video${list.length === 1 ? '' : 's'}.` : 'No videos yet.';
  }
  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-act]'); if (!b) return;
    const id = b.closest('li').dataset.id; const i = list.findIndex((v) => v.id === id); if (i < 0) return;
    if (b.dataset.act === 'rm') { const [x] = list.splice(i, 1); if (x.preview) URL.revokeObjectURL(x.preview); }
    if (b.dataset.act === 'left' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    if (b.dataset.act === 'right' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    draw();
  });
  $('#video-input', root).addEventListener('change', async (ev) => {
    const files = [...ev.target.files]; ev.target.value = ''; if (!files.length) return;
    clearErrors(); showNote('', '');
    const busy = $('#video-busy', root); const problems = []; const added = [];
    for (const [i, f] of files.entries()) {
      if (list.length + added.length >= max) { problems.push(`You can have up to ${max} videos here.`); break; }
      busy.textContent = `Preparing video ${i + 1} of ${files.length}…`;
      try { added.push(await prepareVideo(f)); } catch (e) { problems.push(e instanceof PhotoError ? e.message : 'A video could not be added.'); }
    }
    added.forEach((a) => list.push(a)); busy.textContent = added.length ? `Added ${added.length} video${added.length === 1 ? '' : 's'}.` : '';
    draw(); if (problems.length) showNote('bad', problems.map(esc).join('<br>'));
  });
  draw();
}
// Upload videos (and their still pictures) that are not on the server yet; one at a time, with progress.
async function uploadVideos(list) {
  const uid = current()?.user?.id; const todo = list.filter((v) => !v.src && !v.path); let n = 0;
  for (const v of todo) {
    n++;
    if (v.posterBlob && !v.posterPath) { const pp = `${uid}/${uuid()}.jpg`; await uploadFile('media', pp, v.posterBlob, 'image/jpeg'); v.posterPath = pp; }
    const path = `${uid}/${uuid()}.${v.ext}`;
    await uploadFile('videos', path, v.file, v.type, (f) => progress(`Uploading video ${n} of ${todo.length} — ${Math.round(f * 100)}%`));
    v.path = path;
  }
  return list.map((v) => ({ src: v.src || v.path, poster: v.poster || v.posterPath || null }));
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
function viewDone({ heading = 'Saved. Your changes are live.', text, viewHref, viewLabel = 'See it on the website', another }) {
  setView(`<div class="done"><div class="tick" aria-hidden="true">✓</div><h1>${esc(heading)}</h1><p>${esc(text)}</p></div>
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
  const videos = (existing?.videos || []).map((v) => ({ id: uuid(), src: v.src, poster: v.poster }));
  const token = uuid(); let version = existing?.version;
  setView(`${back('#/edit/programmes')}<h1>${existing ? 'Edit programme' : 'Add a programme'}</h1><div id="note"></div>
    <form id="form" novalidate>
      ${fld('f-name', 'Programme name', `<input id="f-name" type="text" maxlength="80" value="${esc(existing?.name || '')}" required>`)}
      ${fld('f-short', 'Short name for the menu', `<input id="f-short" type="text" maxlength="24" value="${esc(existing?.short_label || '')}" required${withHint('x', 'f-short')}>`, { hint: 'One or two words, e.g. “School”.' })}
      ${fld('f-context', 'Where it happens', `<input id="f-context" type="text" maxlength="80" value="${esc(existing?.context || '')}">`, { opt: true })}
      ${fld('f-caption', 'Caption under the main photo', `<input id="f-caption" type="text" maxlength="80" value="${esc(existing?.caption || '')}">`, { opt: true })}
      ${fld('f-desc', 'Description', `<textarea id="f-desc" maxlength="800">${esc(existing?.description || '')}</textarea>`, { opt: true })}
      ${photoBlock('The first photo is the main photo. Use ◀ ▶ to move a different photo to the front.')}
      ${videoBlock()}
    </form>${bar('Save')}`, { bar: true, title: existing ? 'Edit programme' : 'Add a programme' });
  photoPicker(photos, { max: 40, mainWord: 'Main photo' });
  videoPicker(videos, { max: 8 });
  wireSave({
    validate: () => { let ok = true; if (!requireText('f-short', 'Please type a short name for the menu.')) ok = false; if (!requireText('f-name', 'Please type the programme name.')) ok = false; return ok; },
    work: async () => {
      const images = await uploadPending(photos);
      const vids = await uploadVideos(videos);
      progress('Saving…');
      const out = await rpc('editor_save_programme', { p_id: existing?.id ?? null, p_expected_version: version ?? null, p_name: $('#f-name').value, p_short_label: $('#f-short').value,
        p_context: $('#f-context').value, p_caption: $('#f-caption').value, p_description: $('#f-desc').value, p_images: images, p_client_token: existing ? null : token, p_videos: vids });
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
  ['Contact details (optional)', [
    ['contact_email', 'Email address', 'email', 120, 'Leave empty to keep it off the website.'],
    ['contact_phone', 'Phone number', 'tel', 40, 'Leave empty to keep it off the website.'],
    ['contact_address', 'Postal address', 'area', 240, 'Leave empty to keep it off the website.']]],
];
function groupCards(groups) {
  return groups.map((g, i) => {
    const pic = g.preview || (g.image ? imgUrl(g.image) : '');
    return `<div class="gcard" data-gid="${esc(g.id)}"><h3>Group ${i + 1}</h3>
      ${pic ? `<img src="${esc(pic)}" alt="Photo for group ${i + 1}">` : `<div class="vph small" aria-hidden="true">No photo</div>`}
      <div class="row2"><label class="btn quiet filebtn"><span>${pic ? 'Change photo' : 'Add photo'}</span><input type="file" accept="image/*" data-gphoto aria-label="${pic ? 'Change' : 'Add'} photo for group ${i + 1}"></label>
      ${pic ? `<button type="button" class="btn quiet" data-gnophoto>Remove photo</button>` : ''}</div>
      ${fld(`g-${g.id}-title`, 'Name of the group', `<input id="g-${g.id}-title" data-gfield="title" type="text" maxlength="80" value="${esc(g.title)}">`)}
      ${fld(`g-${g.id}-text`, 'What they do', `<textarea id="g-${g.id}-text" data-gfield="text" maxlength="300" style="min-height:100px">${esc(g.text)}</textarea>`, { opt: true })}
      <div data-gdelbox><button type="button" class="btn danger" data-gdel>Delete this group</button></div></div>`;
  }).join('');
}

async function viewSiteForm() {
  viewLoading();
  try { await loadContent(); } catch (e) { return viewError(e, viewSiteForm); }
  let version = content.site_version; const site = content.site || {};
  const groups = (site.partners || []).map((g) => ({ id: g.id, title: g.title || '', text: g.text || '', image: g.image || '', blob: null, preview: '', path: null }));
  const fieldsets = SITE_FIELDS.map(([title, fields]) => `<fieldset class="group"><h2>${esc(title)}</h2>${fields.map(([k, label, type, max, hint]) => {
    const v = site[k] ?? '';
    const input = type === 'area' ? `<textarea id="f-${k}" maxlength="${max}" style="min-height:110px"${withHint(hint, 'f-' + k)}>${esc(v)}</textarea>`
      : `<input id="f-${k}" type="${type}" maxlength="${max}" value="${esc(v)}" ${type === 'email' ? 'inputmode="email" autocapitalize="none"' : ''}${withHint(hint, 'f-' + k)}>`;
    return fld('f-' + k, esc(label), input, { hint: hint ? esc(hint) : '' });
  }).join('')}</fieldset>`);
  const groupBlock = `<fieldset class="group" id="groups-block"><h2>Who carries the work out</h2>
    <p class="hint">Each group appears as a card on the About page. Nothing changes on the website until you tap Save.</p>
    <div id="group-list"></div><button type="button" class="btn quiet" id="add-group">＋ Add a group</button><p class="hint" id="group-busy" aria-live="polite"></p></fieldset>`;
  setView(`${back('#/')}<h1>About page</h1><div id="note"></div><form id="form" novalidate>${fieldsets[0]}${groupBlock}${fieldsets[1]}</form>${bar('Save')}`, { bar: true, title: 'About page' });

  const list = $('#group-list');
  const draw = () => { list.innerHTML = groupCards(groups) || '<p class="hint">There are no groups. The “Who carries it out” section is hidden on the website.</p>'; };
  draw();
  const find = (el) => groups.find((g) => g.id === el.closest('.gcard')?.dataset.gid);
  list.addEventListener('input', (ev) => { const g = find(ev.target), k = ev.target.dataset.gfield; if (g && k) g[k] = ev.target.value; });
  list.addEventListener('click', (ev) => {
    const t = ev.target.closest('button'); if (!t) return; const g = find(t); if (!g) return;
    const box = t.closest('.gcard').querySelector('[data-gdelbox]');
    if (t.hasAttribute('data-gdel')) { box.innerHTML = `<div class="confirm" role="alertdialog"><p><b>Delete this group?</b><br>It disappears from the About page when you tap Save.</p><button type="button" class="btn danger solid" data-gyes>Yes, delete it</button><button type="button" class="btn quiet" data-gno>No, keep it</button></div>`; box.querySelector('[data-gno]').focus(); }
    else if (t.hasAttribute('data-gno')) box.innerHTML = '<button type="button" class="btn danger" data-gdel>Delete this group</button>';
    else if (t.hasAttribute('data-gyes')) { groups.splice(groups.indexOf(g), 1); draw(); }
    else if (t.hasAttribute('data-gnophoto')) { if (g.preview) URL.revokeObjectURL(g.preview); g.image = ''; g.blob = null; g.preview = ''; g.path = null; draw(); }
  });
  list.addEventListener('change', async (ev) => {
    if (!ev.target.matches('input[data-gphoto]')) return;
    const g = find(ev.target), f = ev.target.files[0]; if (!g || !f) return; ev.target.value = '';
    clearErrors(); showNote('', ''); $('#group-busy').textContent = 'Preparing photo…';
    try { const blob = await processPhoto(f); if (g.preview) URL.revokeObjectURL(g.preview); g.blob = blob; g.path = null; g.preview = URL.createObjectURL(blob); draw(); $('#group-busy').textContent = ''; }
    catch (e) { $('#group-busy').textContent = ''; showNote('bad', esc(e instanceof PhotoError ? e.message : 'That photo could not be added.')); }
  });
  $('#add-group').addEventListener('click', () => {
    if (groups.length >= 12) { showNote('bad', 'There can be up to 12 groups.'); return; }
    groups.push({ id: uuid(), title: '', text: '', image: '', blob: null, preview: '', path: null }); draw();
    const last = list.querySelector('.gcard:last-child input[data-gfield="title"]'); last?.scrollIntoView({ block: 'center', behavior: 'smooth' }); last?.focus({ preventScroll: true });
  });

  wireSave({
    validate: () => {
      const em = $('#f-contact_email').value.trim(); let ok = true;
      for (const [i, g] of groups.entries()) if (!g.title.trim()) { ok = false; fieldError(`g-${g.id}-title`, `Please give group ${i + 1} a name, or delete it.`); break; }
      if (em && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { if (ok) clearErrors(); ok = false; fieldError('f-contact_email', 'That email address does not look right.'); }
      return ok;
    },
    work: async () => {
      const data = {}; SITE_FIELDS.forEach(([, fs]) => fs.forEach(([k]) => { data[k] = $('#f-' + k).value; }));
      const uid = current()?.user?.id; const todo = groups.filter((g) => g.blob && !g.path); let n = 0;
      for (const g of todo) { const path = `${uid}/${uuid()}.jpg`; await uploadFile('media', path, g.blob, 'image/jpeg'); g.path = path; progress(`Uploading photos… ${++n} of ${todo.length}`); }
      progress('Saving…');
      data.partners = groups.map((g) => ({ id: g.id, title: g.title, text: g.text, image: g.blob ? g.path : g.image }));
      const out = await rpc('editor_save_site', { p_expected_version: version, p_data: data }); version = out.version; return out;
    },
    done: () => viewDone({ text: 'The About page and contact details are updated.', viewHref: '../#about', viewLabel: 'See the About page' }),
    onReload: viewSiteForm,
  });
  followKeyboard();
}

// ── password ──
function viewPasswordForm() {
  setView(`${back('#/')}<h1>Set or change my password</h1><div id="note"></div>
    <p>With a password you can sign in without waiting for an email. The emailed sign-in link keeps working too.</p>
    <form id="form" novalidate>
      ${fld('f-pw1', 'New password', '<input id="f-pw1" type="password" autocomplete="new-password" minlength="8" aria-describedby="f-pw1-hint">', { hint: 'At least 8 characters. Something only you would know.' })}
      ${fld('f-pw2', 'Type it again', '<input id="f-pw2" type="password" autocomplete="new-password">')}
    </form>${bar('Save')}`, { bar: true, title: 'Password' });
  wireSave({
    validate: () => {
      const a = $('#f-pw1').value, b = $('#f-pw2').value;
      if (a.length < 8) return !fieldError('f-pw1', 'Please use at least 8 characters.');
      if (a !== b) return !fieldError('f-pw2', 'The two passwords are not the same.');
      return true;
    },
    work: () => authed('/auth/v1/user', { method: 'PUT', body: { password: $('#f-pw1').value } }),
    done: () => viewDone({ heading: 'Password saved.', text: 'You can now sign in with your email address and this password.' }),
  });
  followKeyboard();
}

// ── bank details (owner only; everyone can see them on the Give page, so be careful) ──
const BANK_FIELDS = [
  ['bank_account_name', 'Account name', 'text', 80, '', 'SBC Global Foundation'],
  ['bank_name', 'Bank', 'text', 80, '', ''],
  ['bank_branch', 'Branch', 'text', 80, 'optional', ''],
  ['bank_account_no', 'Account number', 'text', 40, '', ''],
  ['bank_swift', 'SWIFT / BIC code', 'text', 20, 'optional', ''],
  ['bank_reference', 'What donors should write as the reference', 'text', 80, '', 'Your full name'],
];
async function viewBankForm() {
  if (!me?.owner) { setView(`${back('#/')}<h1>Not available</h1><div class="note info">Only the owner of the website can change the bank details.</div>`); return; }
  viewLoading();
  try { await loadContent(); } catch (e) { return viewError(e, viewBankForm); }
  let version = content.site_version; const site = content.site || {};
  const rows = BANK_FIELDS.map(([k, label, , max, opt, fallback]) => fld('f-' + k, esc(label), `<input id="f-${k}" type="text" maxlength="${max}" value="${esc(site[k] ?? '')}" placeholder="${esc(fallback)}" autocomplete="off">`, { opt: !!opt })).join('');
  setView(`${back('#/')}<h1>Bank details</h1><div id="note"></div>
    <div class="note info">These appear on the <b>Give</b> page for everyone to see. Please check every number carefully before you tap Save.</div>
    <form id="form" novalidate>${rows}</form>${bar('Save')}`, { bar: true, title: 'Bank details' });
  wireSave({
    validate: () => true,
    work: async () => { const data = {}; BANK_FIELDS.forEach(([k]) => { data[k] = $('#f-' + k).value; }); const out = await rpc('editor_save_bank', { p_expected_version: version, p_data: data }); version = out.version; return out; },
    done: () => viewDone({ text: 'The bank details on the Give page are updated.', viewHref: '../#give', viewLabel: 'See the Give page' }),
    onReload: viewBankForm,
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
  if (h === '/edit') { history.replaceState(null, '', location.pathname + '#/'); return viewHome(); }
  if (h === '/edit/updates') return viewUpdateList();
  if (h === '/edit/programmes') return viewProgrammeList();
  if ((m = h.match(/^\/update\/([0-9a-f-]{36})$/))) return viewUpdateForm(m[1]);
  if (h === '/programme/new') return viewProgrammeForm('new');
  if ((m = h.match(/^\/programme\/([0-9a-f-]{36})$/))) return viewProgrammeForm(m[1]);
  if (h === '/site') return viewSiteForm();
  if (h === '/password') return viewPasswordForm();
  if (h === '/bank') return viewBankForm();
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
