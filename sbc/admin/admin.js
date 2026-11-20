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
async function uploadFile(bucket, path, blob, contentType, onProgress, onXhr) {
  const send = (token) => new Promise((ok, no) => {
    const x = new XMLHttpRequest();
    x.open('POST', `${BASE}/storage/v1/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`);
    x.setRequestHeader('apikey', KEY); x.setRequestHeader('Authorization', 'Bearer ' + token);
    x.setRequestHeader('Content-Type', contentType); x.setRequestHeader('x-upsert', 'false'); x.setRequestHeader('cache-control', 'max-age=31536000');
    if (onProgress) x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onerror = x.ontimeout = () => no(new ApiError('network', 0, 'network'));
    x.onabort = () => no(new ApiError('aborted', 0, 'aborted'));
    if (onXhr) onXhr(x);
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
  setView(`<div class="seal" aria-hidden="true"><img class="ring" src="../assets/sbc-ring.png" alt=""><img class="mark" src="../assets/sbc-emblem-lg.png" alt=""></div><h1>Sign in</h1>${note}
    <p>Enter the email address the foundation invited, and your password. No password? We’ll email you a link instead.</p>
    <form id="signin" novalidate>
      ${fld('email', 'Your email address', '<input id="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" required>')}
      <div class="field"><label for="pw"><span>Password</span></label><div class="pw"><input id="pw" type="password" autocomplete="current-password" required><button type="button" class="show" id="showpw" aria-label="Show password">Show</button></div></div>
      <button class="btn primary" type="submit" id="pwbtn">Sign in</button>
      <a class="link" href="#/forgot">Forgot your password?</a>
      <div class="or"><span>or</span></div>
      <button class="btn" type="button" id="sendbtn">Email me a sign-in link</button>
    </form>
    <p class="hint">Tip: save this page to your phone’s home screen so it’s one tap away.</p>`, { title: 'Sign in' });
  const checkEmail = () => { const email = $('#email').value.trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { clearErrors(); fieldError('email', 'Please type your email address, like name@example.com.'); return ''; } return email; };
  $('#showpw').addEventListener('click', (ev) => { const i = $('#pw'); const show = i.type === 'password'; i.type = show ? 'text' : 'password'; ev.target.textContent = show ? 'Hide' : 'Show'; ev.target.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); });
  $('#signin').addEventListener('submit', async (ev) => {
    ev.preventDefault(); const email = checkEmail(); if (!email) return;
    const pw = $('#pw').value;
    if (!pw) { clearErrors(); fieldError('pw', 'Please type your password, or tap “Email me a sign-in link”.'); return; }
    const btn = $('#pwbtn'); btn.disabled = true; btn.textContent = 'Signing in…';
    try { const j = await raw('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: pw } }); session.set(normaliseSession(j)); history.replaceState(null, '', location.pathname + '#/'); start(); }
    catch (e) {
      btn.disabled = false; btn.textContent = 'Sign in'; clearErrors();
      fieldError('pw', e.kind === 'network' ? MSG.network : e.status === 429 ? 'Too many tries. Please wait a minute and try again.' : 'That password isn’t right. Try again, or use the sign-in link below.');
    }
  });
  $('#sendbtn').addEventListener('click', () => { const email = checkEmail(); if (email) sendLink(email); });
  async function sendLink(email) {
    const btn = $('#sendbtn'); btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await raw('/auth/v1/otp?redirect_to=' + encodeURIComponent(location.origin + location.pathname), { method: 'POST', body: { email, create_user: false } });
      viewSignIn('', email);
    } catch (e) {
      if (e.kind === 'network' || e.status >= 500 || e.status === 429) { btn.disabled = false; btn.textContent = 'Email me a sign-in link'; clearErrors(); fieldError('pw', e.status === 429 ? 'Too many tries. Please wait a minute and try again.' : MSG.network); }
      else viewSignIn('', email);     // same answer whether or not the address is known
    }
  }
}

function viewForgot(sent = '') {
  if (sent) {
    setView(`<h1>Check your email</h1><p>If <b>${esc(sent)}</b> has been set up as an editor, we’ve sent a link to choose a new password. Open it on this phone.</p><a class="link" href="#/signin">Back to sign in</a>`, { title: 'Check your email' });
    return;
  }
  setView(`<a class="back" href="#/signin">← Back</a><h1>Forgot your password?</h1><div id="note"></div>
    <p>Type your email address and we’ll send you a link to choose a new password.</p>
    <form id="form" novalidate>${fld('email', 'Your email address', '<input id="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" required>')}
    <button class="btn primary" type="submit" id="resetbtn">Email me a reset link</button></form>`, { title: 'Forgot your password?' });
  $('#form').addEventListener('submit', async (ev) => {
    ev.preventDefault(); const email = $('#email').value.trim().toLowerCase(); clearErrors();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { fieldError('email', 'Please type your email address, like name@example.com.'); return; }
    const btn = $('#resetbtn'); btn.disabled = true; btn.textContent = 'Sending…';
    try { await raw('/auth/v1/recover?redirect_to=' + encodeURIComponent(location.origin + location.pathname), { method: 'POST', body: { email } }); viewForgot(email); }
    catch (e) { btn.disabled = false; btn.textContent = 'Email me a reset link'; if (e.kind === 'network' || e.status >= 500 || e.status === 429) showNote('bad', e.status === 429 ? 'Too many tries. Please wait a minute and try again.' : MSG.network); else viewForgot(email); }
  });
}

function viewNotEditor() {
  setView(`<h1>Not set up yet</h1><div class="note info">You’re signed in as <b>${esc(session.get()?.user?.email || '')}</b>, but this address hasn’t been set up as an editor of the website.</div>
    <p>Please ask the foundation to add you, then come back.</p><button class="btn" id="out">Sign out</button>`);
  $('#out').addEventListener('click', signOut);
}

function viewHome() {
  const choice = (href, ico, hue, text) => `<a class="choice" href="${href}"><span class="cico" aria-hidden="true" style="background:oklch(93% .04 ${hue[0]});color:oklch(${hue[2] || 42}% .09 ${hue[1] ?? hue[0]})">${ico}</span>${text}</a>`;
  setView(`<h1>What would you like to do?</h1>
    <a class="big primary" href="#/add"><span class="ico" aria-hidden="true">＋</span><span><b>Add an update</b><small>Tell everyone what happened. Add photos.</small></span></a>
    <nav class="choices" aria-label="Edit the website">
    ${choice('#/updates', '✎', [150], 'Edit an update')}
    ${choice('#/programmes', '❖', [85, 70, 45], 'Edit or add a programme')}
    ${choice('#/gallery', '▦', [240], 'Edit or add to the photo gallery')}
    ${choice('#/about', 'ⓘ', [20, 25, 45], 'Edit the About page')}
    ${choice('#/faces', '☺', [60, 60, 45], 'Edit priests and sisters')}
    ${choice('#/strip', '▭', [270, 270, 42], 'Edit the About page photo strip')}
    ${me?.owner ? choice('#/bank', '₨', [300], 'Edit bank details') : ''}
    ${choice('#/contact', '✆', [195, 195, 42], 'Edit contact details')}
    </nav>
    <div class="foot">
      <a class="site-btn" href="../" target="_blank" rel="noopener"><img src="../assets/sbc-emblem.png" alt="" width="40" height="40"><span class="st"><b>Look at the website</b><small>Opens in a new tab</small></span><span class="arr" aria-hidden="true">↗</span></a>
      <div class="acct"><span class="who-txt">Signed in as<br><b>${esc(me?.email || '')}</b></span><button class="out-btn" id="out" type="button">Sign out</button></div>
      <a class="link" href="#/password">Set or change my password</a>
    </div>`);
  $('#out').addEventListener('click', signOut);
}

async function viewUpdateList() {
  viewLoading();
  try { await loadContent(); } catch (e) { return viewError(e, viewUpdateList); }
  const rows = content.updates.map((u) => `<a class="row" href="#/update/${esc(u.id)}"><b>${esc(u.title)}</b><small>${esc(fmtDate(u.published_at))} · ${esc(programmeName(u.programme_id) || 'General update')}</small></a>`).join('');
  setView(`${back('#/')}<h1>Updates</h1>${rows || '<p>There are no updates yet.</p>'}<a class="big primary" href="#/add"><span class="ico" aria-hidden="true">＋</span><span><b>Add an update</b></span></a>`);
}

async function viewProgrammeList() {
  viewLoading();
  try { await loadContent(); } catch (e) { return viewError(e, viewProgrammeList); }
  const rows = content.programmes.map((p) => `<a class="choice" href="#/programme/${esc(p.id)}"><span class="num">${String(p.position + 1).padStart(2, '0')}</span>${esc(p.name)}</a>`).join('');
  setView(`${back('#/')}<h1>Which programme?</h1><nav class="choices" aria-label="Programmes">${rows}</nav><a class="btn quiet add-group" href="#/programme/new">＋ Add a programme</a>`);
}

// A labelled field. The hint is tied to the control with aria-describedby (not part of its name).
function fld(id, label, control, { opt = false, hint = '' } = {}) {
  return `<div class="field"><label for="${id}"><span>${label}</span>${opt ? ' <span class="opt">(optional)</span>' : ''}</label>${control}${hint ? `<p class="hint" id="${id}-hint">${hint}</p>` : ''}</div>`;
}
const withHint = (hint, id) => (hint ? ` aria-describedby="${id}-hint"` : '');

// ── photo picker (shared by updates and programmes) ──
function photoPicker(list, { max, mainWord, countText, arrows = ['◀', '▶'] }) {
  const root = $('#photos-block');
  function draw() {
    const items = list.map((p, i) => `<li data-id="${esc(p.id)}"><img src="${esc(p.preview || imgUrl(p.src))}" alt="Photo ${i + 1}">
      <span class="tag">${i === 0 ? mainWord : ''}</span>
      <div class="tools"><button type="button" data-act="left" aria-label="Move photo ${i + 1} earlier" ${i === 0 ? 'disabled' : ''}>${arrows[0]}</button>
      <button type="button" data-act="right" aria-label="Move photo ${i + 1} later" ${i === list.length - 1 ? 'disabled' : ''}>${arrows[1]}</button>
      <button type="button" class="rm" data-act="rm" aria-label="Remove photo ${i + 1}">✕</button></div></li>`).join('');
    $('#photo-list', root).innerHTML = items;
    $('#photo-count', root).textContent = countText ? countText(list.length) : list.length ? `${list.length} photo${list.length === 1 ? '' : 's'}${list.length > 1 ? ' — the first one is the main photo' : ''}.` : 'No photos yet.';
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
  <p class="hint" id="photo-busy" aria-live="polite"></p><p class="hint">You can pick several photos at once.</p>${hint ? `<p class="hint">${hint}</p>` : ''}</div>`;

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

// ── videos (programmes only): uploaded files, or links to YouTube ──
const MAX_VIDEO = 50 * 1024 * 1024;
const VIDEO_TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
const clock = (sec) => (sec > 0 ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}` : '');

// The 11-character video id from any ordinary YouTube link, or '' if it is not one.
function ytId(text) {
  const t = String(text || '').trim(); if (!t) return '';
  let m = '';
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : 'https://' + t); const h = u.hostname.replace(/^(www|m)\./, '');
    if (h === 'youtu.be') m = u.pathname.slice(1).split('/')[0];
    else if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') m = u.searchParams.get('v') || '';
      else { const p = u.pathname.split('/').filter(Boolean); if (['shorts', 'embed', 'live', 'v'].includes(p[0])) m = p[1] || ''; }
    }
  } catch { return ''; }
  return /^[A-Za-z0-9_-]{11}$/.test(m) ? m : '';
}

// A still picture from the video (so it shows before anyone presses play), and how long it is. The picture is
// null if the phone can't make one; this rejects only if the phone clearly cannot open the video at all.
async function makePoster(file) {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    const opened = await new Promise((ok, no) => { const t = setTimeout(() => ok(false), 10000); v.onloadeddata = () => { clearTimeout(t); ok(true); }; v.onerror = () => { clearTimeout(t); no(new Error('cannot open')); }; });
    if (!opened || !v.videoWidth) return { blob: null, duration: 0 };
    const duration = Number.isFinite(v.duration) ? v.duration : 0;
    await new Promise((ok) => { const t = setTimeout(ok, 4000); v.onseeked = () => { clearTimeout(t); ok(); }; try { v.currentTime = Math.min(1, (v.duration || 2) / 2); } catch { clearTimeout(t); ok(); } });
    const k = Math.min(1, 640 / v.videoWidth); const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return { blob: await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.75)), duration };
  } finally { URL.revokeObjectURL(url); }
}
async function prepareVideo(file) {
  const ext = ((file.name || '').split('.').pop() || '').toLowerCase();
  const type = VIDEO_TYPES[ext] || (Object.values(VIDEO_TYPES).includes(file.type) ? file.type : '');
  if (!type) throw new PhotoError(`“${file.name || 'That file'}” is not a video the website can use. Please choose an MP4, MOV or WebM video.`);
  if (file.size > MAX_VIDEO) throw new PhotoError(`“${file.name}” is too big (${mb(file.size)}). Videos can be up to 50 MB. Try a shorter clip, or record at a lower quality (iPhone: Settings → Camera → Record Video → 720p HD).`);
  let made; try { made = await makePoster(file); } catch { throw new PhotoError(`This phone couldn’t open “${file.name}”, so it can’t be added. Please choose a different video.`); }
  const finalExt = type === 'video/quicktime' ? 'mov' : type === 'video/webm' ? 'webm' : 'mp4';
  return { id: uuid(), kind: 'upload', file, name: (file.name || 'Video').replace(/\.[^.]+$/, ''), type, ext: finalExt, size: file.size, duration: made.duration, posterBlob: made.blob, preview: made.blob ? URL.createObjectURL(made.blob) : '' };
}
const videoBlock = () => `<div id="videos-block" class="field" role="group" aria-labelledby="videos-label"><span class="label" id="videos-label">Videos <span class="opt">(optional)</span></span>
  <p class="hint" id="video-count"></p><ul class="videos" id="video-list"></ul>
  <label class="btn quiet filebtn"><span>＋ Add a video</span><input id="video-input" type="file" accept="video/*" multiple aria-label="Add a video from your phone"></label>
  <p class="hint" id="video-busy" aria-live="polite"></p>
  <p class="hint">Short clips work best (under 2 minutes, up to 50 MB each). Keep this page open while it uploads.</p>
  <div class="field" style="margin:14px 0 0"><label for="f-yt"><span>Or paste a YouTube link</span> <span class="opt">(optional)</span></label><input id="f-yt" type="text" inputmode="url" autocapitalize="none" spellcheck="false" placeholder="https://youtu.be/…"></div></div>`;
const YT_PROBLEM = 'That doesn’t look like a YouTube link. Please paste the whole link from YouTube (it starts with https://youtu.be/ or https://www.youtube.com/).';
function videoPicker(list, { max }) {
  const root = $('#videos-block');
  function draw() {
    $('#video-list', root).innerHTML = list.map((v, i) => {
      const yt = v.kind === 'youtube';
      const thumb = yt ? `https://i.ytimg.com/vi/${v.youtube_id}/default.jpg` : (v.preview || (v.poster ? imgUrl(v.poster) : ''));
      const name = yt ? 'YouTube video' : (v.name || `Video ${i + 1}`);
      const status = yt ? `youtube.com · ${v.youtube_id}` : v.uploading ? `Uploading… ${Math.round(v.pct || 0)}%` : v.file ? `Ready to upload · ${mb(v.size)}` : 'Saved';
      return `<li data-id="${esc(v.id)}"><div class="vthumb" style="${thumb ? `background-image:url('${esc(thumb)}')` : ''}"><span class="play" aria-hidden="true">▶</span>${clock(v.duration) ? `<span class="dur">${clock(v.duration)}</span>` : ''}</div>
      <div class="vmeta"><b>${esc(name)}</b><small>${esc(status)}</small>
      ${v.uploading ? `<div class="progress" role="progressbar" aria-valuenow="${Math.round(v.pct || 0)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.round(v.pct || 0)}%"></span></div>` : `<div class="vmove"><button type="button" data-act="left" aria-label="Move video ${i + 1} earlier" ${i === 0 ? 'disabled' : ''}>◀</button><button type="button" data-act="right" aria-label="Move video ${i + 1} later" ${i === list.length - 1 ? 'disabled' : ''}>▶</button></div>`}</div>
      <button type="button" class="rm" data-act="rm" aria-label="${v.uploading ? 'Stop uploading' : 'Remove'} video ${i + 1}">✕</button></li>`;
    }).join('');
    $('#video-count', root).textContent = list.length ? `${list.length} video${list.length === 1 ? '' : 's'}.` : 'No videos yet.';
  }
  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-act]'); if (!b) return;
    const id = b.closest('li').dataset.id; const i = list.findIndex((v) => v.id === id); if (i < 0) return;
    if (b.dataset.act === 'rm') { if (list[i].uploading) { list[i].cancelled = true; list[i].abort?.(); return; } const [x] = list.splice(i, 1); if (x.preview) URL.revokeObjectURL(x.preview); }
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
  // a pasted YouTube link becomes a list item as soon as the box is left
  $('#f-yt', root).addEventListener('change', (ev) => {
    const t = ev.target.value.trim(); if (!t) return; clearErrors();
    const id = ytId(t); if (!id) { fieldError('f-yt', YT_PROBLEM); return; }
    if (list.length >= max) { fieldError('f-yt', `You can have up to ${max} videos here.`); return; }
    if (!list.some((v) => v.youtube_id === id)) list.push({ id: uuid(), kind: 'youtube', youtube_id: id });
    ev.target.value = ''; draw();
  });
  draw();
  return { draw };
}
// Upload videos (and their still pictures) that are not on the server yet; one at a time, with progress that can be stopped.
async function uploadVideos(list, redraw) {
  const uid = current()?.user?.id; const todo = list.filter((v) => v.kind === 'upload' && !v.src && !v.path); let n = 0;
  for (const v of todo) {
    n++; v.uploading = true; v.pct = 0; v.cancelled = false; redraw();
    try {
      if (v.posterBlob && !v.posterPath) { const pp = `${uid}/${uuid()}.jpg`; await uploadFile('media', pp, v.posterBlob, 'image/jpeg', null, (x) => { v.abort = () => x.abort(); }); v.posterPath = pp; }
      const path = `${uid}/${uuid()}.${v.ext}`;
      let tick = 0;
      await uploadFile('videos', path, v.file, v.type, (f) => { v.pct = f * 100; progress(`Uploading video ${n} of ${todo.length} — ${Math.round(f * 100)}%`); if (!tick) tick = requestAnimationFrame(() => { tick = 0; redraw(); }); }, (x) => { v.abort = () => x.abort(); });
      v.path = path;
    } catch (e) {
      v.uploading = false;
      if (e.kind === 'aborted' && v.cancelled) { list.splice(list.indexOf(v), 1); redraw(); continue; }      // the person stopped this one: carry on without it
      redraw(); throw e;
    }
    v.uploading = false; redraw();
  }
  return list.map((v) => (v.kind === 'youtube' ? { kind: 'youtube', youtube_id: v.youtube_id } : { kind: 'upload', src: v.src || v.path, poster: v.poster || v.posterPath || null }));
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
  if (id && !existing) { setView(`${back('#/updates')}<h1>Not found</h1><div class="note info">${MSG.gone}</div>`); return; }
  const photos = (existing?.images || []).map((src) => ({ id: uuid(), src }));
  const token = uuid(); let version = existing?.version;
  const opts = ['<option value="">General update</option>',
    ...content.programmes.map((p) => `<option value="${esc(p.id)}" ${existing?.programme_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`)].join('');
  setView(`${back(existing ? '#/updates' : '#/', 'Back')}<h1>${existing ? 'Edit update' : 'Add an update'}</h1><div id="note"></div>
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
      try { await rpc('editor_remove_update', { p_id: existing.id, p_expected_version: getVersion() }); viewDone({ text: 'The update is no longer on the website.', another: { href: '#/updates', label: 'Back to the list of updates' } }); }
      catch (e) { t.disabled = false; t.textContent = 'Yes, remove it'; explain(e, { onReload: () => viewUpdateForm(existing.id) }); }
    }
  });
}

// ── programme form ──
async function viewProgrammeForm(id) {
  viewLoading();
  try { await loadContent(); } catch (e) { return viewError(e, () => viewProgrammeForm(id)); }
  const existing = id !== 'new' ? content.programmes.find((p) => p.id === id) : null;
  if (id !== 'new' && !existing) { setView(`${back('#/programmes')}<h1>Not found</h1><div class="note info">This programme could not be found.</div>`); return; }
  const photos = (existing?.images || []).map((src) => ({ id: uuid(), src }));
  const videos = (existing?.videos || []).map((v) => (v.kind === 'youtube' ? { id: uuid(), kind: 'youtube', youtube_id: v.youtube_id } : { id: uuid(), kind: 'upload', src: v.src, poster: v.poster }));
  const token = uuid(); let version = existing?.version;
  setView(`${back('#/programmes')}<h1>${existing ? 'Edit programme' : 'Add a programme'}</h1><div id="note"></div>
    <form id="form" novalidate>
      ${fld('f-name', 'Programme name', `<input id="f-name" type="text" maxlength="80" value="${esc(existing?.name || '')}" required>`)}
      ${fld('f-short', 'Short name for the menu', `<input id="f-short" type="text" maxlength="24" value="${esc(existing?.short_label || '')}" required${withHint('x', 'f-short')}>`, { hint: 'One or two words, e.g. “School”.' })}
      ${fld('f-context', 'Where it happens', `<input id="f-context" type="text" maxlength="80" value="${esc(existing?.context || '')}">`, { opt: true })}
      ${fld('f-pdate', 'Date', `<input id="f-pdate" type="date" value="${esc(existing?.date || '')}"${withHint('x', 'f-pdate')}>`, { opt: true, hint: 'When it happened or started. Leave empty if it’s ongoing.' })}
      ${fld('f-caption', 'Caption under the main photo', `<input id="f-caption" type="text" maxlength="80" value="${esc(existing?.caption || '')}">`, { opt: true })}
      ${fld('f-desc', 'Description', `<textarea id="f-desc" maxlength="800">${esc(existing?.description || '')}</textarea>`, { opt: true })}
      ${photoBlock('The first photo is the main photo. Use ◀ ▶ to move a different photo to the front.')}
      ${videoBlock()}
    </form>${bar('Save')}`, { bar: true, title: existing ? 'Edit programme' : 'Add a programme' });
  photoPicker(photos, { max: 40, mainWord: 'Main photo' });
  const vp = videoPicker(videos, { max: 8 });
  wireSave({
    validate: () => {
      let ok = true;
      if (!requireText('f-short', 'Please type a short name for the menu.')) ok = false;
      if (!requireText('f-name', 'Please type the programme name.')) ok = false;
      const t = $('#f-yt').value.trim(); if (t && !ytId(t)) { fieldError('f-yt', YT_PROBLEM); ok = false; }
      return ok;
    },
    work: async () => {
      const t = $('#f-yt').value.trim();                                  // a link typed but not yet "left" still counts
      if (t) { const y = ytId(t); if (y && videos.length < 8 && !videos.some((v) => v.youtube_id === y)) videos.push({ id: uuid(), kind: 'youtube', youtube_id: y }); $('#f-yt').value = ''; vp.draw(); }
      const images = await uploadPending(photos);
      const vids = await uploadVideos(videos, vp.draw);
      progress('Saving…');
      const out = await rpc('editor_save_programme', { p_id: existing?.id ?? null, p_expected_version: version ?? null, p_name: $('#f-name').value, p_short_label: $('#f-short').value,
        p_context: $('#f-context').value, p_caption: $('#f-caption').value, p_description: $('#f-desc').value, p_images: images, p_client_token: existing ? null : token, p_videos: vids, p_date: $('#f-pdate').value || null });
      version = out.version; return out;
    },
    done: (out) => viewDone({ text: existing ? 'Your changes to the programme are on the website.' : 'The new programme is now on the website.', viewHref: `../#programme/${out.position}`, viewLabel: 'See the programme' }),
    onReload: () => viewProgrammeForm(id),
  });
  followKeyboard();
}

// ── About page, contact details, photo gallery ──
const ABOUT_FIELDS = [
  ['about_kicker', 'Small line above the heading', 'text', 60],
  ['about_heading', 'Heading', 'text', 120],
  ['about_heading_italic', 'Heading — last words (shown in green italics)', 'text', 120],
  ['about_p1', 'First paragraph', 'area', 800],
  ['about_p2', 'Second paragraph', 'area', 800],
  ['about_p2_italic', 'Last words of the second paragraph (shown in italics)', 'text', 200],
];
const HEADING_DEFAULTS = { groups_label: 'Who carries it out', strip_heading: 'The people', strip_heading_italic: 'on the ground.', faces_label: 'Faces behind it' };
const HEADING_FIELDS = [
  ['groups_label', 'Small heading above the groups', 'text', 60],
  ['strip_heading', 'Heading above the photo strip', 'text', 80],
  ['strip_heading_italic', 'Heading above the photo strip — last words (shown in green italics)', 'text', 80],
  ['faces_label', 'Small heading beside the priests and sisters', 'text', 60],
];
const CONTACT_FIELDS = [
  ['contact_email', 'Email address', 'email', 120, 'Leave empty to keep it off the website.'],
  ['contact_phone', 'Phone number', 'tel', 40, 'Leave empty to keep it off the website.'],
  ['contact_address', 'Postal address', 'area', 240, 'Leave empty to keep it off the website.'],
];
const siteRows = (fields, site) => fields.map(([k, label, type, max, hint]) => {
  const v = site[k] ?? '';
  const input = type === 'area' ? `<textarea id="f-${k}" maxlength="${max}" style="min-height:110px"${withHint(hint, 'f-' + k)}>${esc(v)}</textarea>`
    : `<input id="f-${k}" type="${type}" maxlength="${max}" value="${esc(v)}" ${type === 'email' ? 'inputmode="email" autocapitalize="none"' : ''}${withHint(hint, 'f-' + k)}>`;
  return fld('f-' + k, esc(label), input, { hint: hint ? esc(hint) : '' });
}).join('');
const readSite = (fields) => { const d = {}; fields.forEach(([k]) => { d[k] = $('#f-' + k).value; }); return d; };

function partnerCards(groups) {
  return groups.map((g, i) => {
    const n = i + 1, pic = g.preview || (g.image ? imgUrl(g.image) : '');
    const photo = pic
      ? `<div class="one-photo"><img src="${esc(pic)}" alt="Group ${n} photo"><div class="tools"><label class="filebtn-sm">Change photo<input type="file" accept="image/*" data-gphoto aria-label="Change photo for group ${n}"></label><button type="button" class="rm" data-gnophoto aria-label="Remove photo for group ${n}">✕ Remove</button></div></div>`
      : `<label class="btn quiet filebtn"><span>＋ Add a photo</span><input type="file" accept="image/*" data-gphoto aria-label="Add a photo for group ${n}"></label>`;
    return `<div class="partner" role="group" aria-labelledby="pg-${esc(g.id)}" data-gid="${esc(g.id)}"><h3 id="pg-${esc(g.id)}">Group ${n}</h3>
      <div class="field"><span class="label">Photo <span class="opt">(optional)</span></span>${photo}</div>
      ${fld(`g-${g.id}-title`, `Group ${n} — name`, `<input id="g-${g.id}-title" data-gfield="title" type="text" maxlength="80" value="${esc(g.title)}">`)}
      ${fld(`g-${g.id}-text`, `Group ${n} — what they do`, `<textarea id="g-${g.id}-text" data-gfield="text" maxlength="300" style="min-height:110px">${esc(g.text)}</textarea>`)}
      <div data-gdelbox><button type="button" class="btn danger" data-gdel>Remove this group</button></div></div>`;
  }).join('');
}

async function viewAboutForm() {
  viewLoading();
  try { await loadContent(); } catch (e) { return viewError(e, viewAboutForm); }
  let version = content.site_version; const site = content.site || {};
  const groups = (site.partners || []).map((g) => ({ id: g.id, title: g.title || '', text: g.text || '', image: g.image || '', blob: null, preview: '', path: null }));
  setView(`${back('#/')}<h1>About page</h1><div id="note"></div><form id="form" novalidate>
    <fieldset class="group"><h2>About page</h2>${siteRows(ABOUT_FIELDS, site)}</fieldset>
    <fieldset class="group"><h2>Section headings</h2>${siteRows(HEADING_FIELDS, { ...HEADING_DEFAULTS, ...Object.fromEntries(Object.entries(site).filter(([k, v]) => k in HEADING_DEFAULTS && String(v).trim())) })}<p class="hint">The photos and names below these headings are edited from the main screen: <b>Edit priests and sisters</b> and <b>Edit the About page photo strip</b>.</p></fieldset>
    <fieldset class="group" id="groups-block"><h2>Who carries the work out</h2><div id="group-list"></div>
      <button type="button" class="btn quiet add-group" id="add-group">＋ Add a group</button>
      <p class="hint">Groups are shown on the About page in this order. Nothing changes on the website until you tap Save.</p><p class="hint" id="group-busy" aria-live="polite"></p></fieldset>
    </form>${bar('Save')}`, { bar: true, title: 'About page' });

  const list = $('#group-list');
  const draw = () => { list.innerHTML = partnerCards(groups) || '<p class="hint">There are no groups. The “Who carries it out” section is hidden on the website.</p>'; };
  draw();
  const find = (el) => groups.find((g) => g.id === el.closest('.partner')?.dataset.gid);
  list.addEventListener('input', (ev) => { const g = find(ev.target), k = ev.target.dataset.gfield; if (g && k) g[k] = ev.target.value; });
  list.addEventListener('click', (ev) => {
    const t = ev.target.closest('button'); if (!t) return; const g = find(t); if (!g) return;
    const box = t.closest('.partner').querySelector('[data-gdelbox]');
    if (t.hasAttribute('data-gdel')) { box.innerHTML = `<div class="confirm" role="alertdialog"><p><b>Remove this group?</b><br>It disappears from the About page when you tap Save.</p><button type="button" class="btn danger solid" data-gyes>Yes, remove it</button><button type="button" class="btn quiet" data-gno>No, keep it</button></div>`; box.querySelector('[data-gno]').focus(); }
    else if (t.hasAttribute('data-gno')) box.innerHTML = '<button type="button" class="btn danger" data-gdel>Remove this group</button>';
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
    const last = list.querySelector('.partner:last-child input[data-gfield="title"]'); last?.scrollIntoView({ block: 'center', behavior: 'smooth' }); last?.focus({ preventScroll: true });
  });
  wireSave({
    validate: () => { for (const [i, g] of groups.entries()) if (!g.title.trim()) { fieldError(`g-${g.id}-title`, `Please give group ${i + 1} a name, or remove it.`); return false; } return true; },
    work: async () => {
      const data = { ...readSite(ABOUT_FIELDS), ...readSite(HEADING_FIELDS) };
      const uid = current()?.user?.id; const todo = groups.filter((g) => g.blob && !g.path); let n = 0;
      for (const g of todo) { const path = `${uid}/${uuid()}.jpg`; await uploadFile('media', path, g.blob, 'image/jpeg'); g.path = path; progress(`Uploading photos… ${++n} of ${todo.length}`); }
      progress('Saving…');
      data.partners = groups.map((g) => ({ id: g.id, title: g.title, text: g.text, image: g.blob ? g.path : g.image }));
      const out = await rpc('editor_save_site', { p_expected_version: version, p_data: data }); version = out.version; return out;
    },
    done: () => viewDone({ text: 'The About page is updated.', viewHref: '../#about', viewLabel: 'See the About page' }),
    onReload: viewAboutForm,
  });
  followKeyboard();
}

async function viewContactForm() {
  viewLoading();
  try { await loadContent(); } catch (e) { return viewError(e, viewContactForm); }
  let version = content.site_version; const site = content.site || {};
  setView(`${back('#/')}<h1>Contact details</h1><div id="note"></div><form id="form" novalidate><fieldset class="group">${siteRows(CONTACT_FIELDS, site)}</fieldset></form>${bar('Save')}`, { bar: true, title: 'Contact details' });
  wireSave({
    validate: () => { const em = $('#f-contact_email').value.trim(); if (em && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return !fieldError('f-contact_email', 'That email address does not look right.'); return true; },
    work: async () => { const out = await rpc('editor_save_site', { p_expected_version: version, p_data: readSite(CONTACT_FIELDS) }); version = out.version; return out; },
    done: () => viewDone({ text: 'The contact details are updated.', viewHref: '../#about', viewLabel: 'See the About page' }),
    onReload: viewContactForm,
  });
  followKeyboard();
}

// The photo gallery has two screens: one to ADD photos (with optional captions), one to EDIT or DELETE the photos already there.
const galleryItems = () => (content.gallery || []).map((g) => (typeof g === 'string' ? { src: g, caption: '' } : { src: g.src, caption: g.caption || '' }));
const GALLERY_MAX = 200;

async function viewGalleryMenu() {
  viewLoading();
  try { await loadContent(); } catch (e) { return viewError(e, viewGalleryMenu); }
  const existing = galleryItems(); let version = content.gallery_version; const fresh = [];
  setView(`${back('#/')}<h1>Photo gallery</h1><div id="note"></div>
    <form id="form" novalidate>
      <label class="big primary pick"><span class="ico" aria-hidden="true">＋</span><span><b>Add photos</b><small>Pick several at once from your phone.</small></span><input id="photo-input" type="file" accept="image/*" multiple aria-label="Add photos from your phone"></label>
      <p class="hint" id="photo-busy" aria-live="polite"></p>
      <div id="fresh" hidden><h2>New photos</h2><p class="hint">Add a caption to each if you like, then tap Save.</p><ul class="videos" id="fresh-list"></ul></div>
    </form>
    <nav class="choices" aria-label="Photos already in the gallery"><a class="choice" href="#/gallery/photos"><span class="cico" aria-hidden="true" style="background:oklch(93% .04 150);color:oklch(42% .09 150)">✎</span>Edit or delete current photos<span class="count">${existing.length}</span></a></nav>
    <div class="bar" id="savebar" hidden><div class="inner"><button class="btn primary" id="save" type="submit" form="form">Save</button></div></div>`, { title: 'Photo gallery' });

  const list = $('#fresh-list');
  const draw = () => {
    list.innerHTML = fresh.map((f, i) => `<li data-id="${esc(f.id)}"><div class="vthumb" style="background-image:url('${esc(f.preview)}')"></div>
      <div class="vmeta"><label class="sr-only" for="c-${esc(f.id)}">Caption for new photo ${i + 1}</label><input id="c-${esc(f.id)}" data-cap type="text" maxlength="160" placeholder="Caption (optional)" value="${esc(f.caption)}"></div>
      <button type="button" class="rm" data-act="rm" aria-label="Remove new photo ${i + 1}">✕</button></li>`).join('');
    $('#fresh').hidden = !fresh.length; $('#savebar').hidden = !fresh.length; app.classList.toggle('has-bar', !!fresh.length);
  };
  list.addEventListener('input', (ev) => { const f = fresh.find((x) => x.id === ev.target.closest('li')?.dataset.id); if (f && ev.target.matches('[data-cap]')) f.caption = ev.target.value; });
  list.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-act="rm"]'); if (!b) return;
    const i = fresh.findIndex((x) => x.id === b.closest('li').dataset.id); if (i < 0) return;
    const [x] = fresh.splice(i, 1); if (x.preview) URL.revokeObjectURL(x.preview); draw();
  });
  $('#photo-input').addEventListener('change', async (ev) => {
    const files = [...ev.target.files]; ev.target.value = ''; if (!files.length) return;
    clearErrors(); showNote('', '');
    const take = files.slice(0, Math.max(0, GALLERY_MAX - existing.length - fresh.length)); const left = files.length - take.length;
    const busy = $('#photo-busy'); const problems = []; let done = 0;
    if (left > 0) problems.push(`The gallery can hold up to ${GALLERY_MAX} photos, so ${left} ${left === 1 ? 'photo was' : 'photos were'} left out.`);
    busy.textContent = `Preparing ${take.length} photo${take.length === 1 ? '' : 's'}…`;
    const results = await pool(take, 3, async (f) => {
      try { const blob = await processPhoto(f); return { id: uuid(), blob, preview: URL.createObjectURL(blob), caption: '', path: null }; }
      catch (e) { problems.push(e instanceof PhotoError ? e.message : 'A photo could not be added.'); return null; }
      finally { done++; busy.textContent = `Preparing photos… ${done} of ${take.length}`; }
    });
    const added = results.filter(Boolean); added.forEach((r) => fresh.push(r));
    busy.textContent = added.length ? `Added ${added.length} photo${added.length === 1 ? '' : 's'}. Tap Save when you are ready.` : '';
    draw(); if (problems.length) showNote('bad', [...new Set(problems)].map(esc).join('<br>'));
  });
  wireSave({
    validate: () => fresh.length > 0,
    work: async () => {
      const uid = current()?.user?.id; const todo = fresh.filter((f) => !f.path); let n = 0;
      await pool(todo, 3, async (f) => { const path = `${uid}/${uuid()}.jpg`; await uploadFile('media', path, f.blob, 'image/jpeg'); f.path = path; n++; progress(`Uploading photos… ${n} of ${todo.length}`); });
      progress('Saving…');
      const items = [...existing, ...fresh.map((f) => ({ src: f.path, caption: f.caption.trim() }))];
      const out = await rpc('editor_save_gallery', { p_expected_version: version, p_images: items }); version = out.version; return out;
    },
    done: () => viewDone({ text: `${fresh.length === 1 ? 'Your photo is' : 'Your photos are'} now in the gallery.`, viewHref: '../#gallery', viewLabel: 'See the gallery', another: { href: '#/gallery/photos', label: 'Edit or delete current photos' } }),
    onReload: viewGalleryMenu,
  });
  followKeyboard();
}

async function viewGalleryEdit() {
  viewLoading();
  try { await loadContent(); } catch (e) { return viewError(e, viewGalleryEdit); }
  const items = galleryItems().map((g) => ({ id: uuid(), ...g })); let version = content.gallery_version;
  if (!items.length) { setView(`${back('#/gallery')}<h1>Edit or delete photos</h1><div class="note info">There are no photos in the gallery yet.</div><a class="btn primary" href="#/gallery">＋ Add photos</a>`, { title: 'Edit or delete photos' }); return; }
  setView(`${back('#/gallery')}<h1>Edit or delete photos</h1><div id="note"></div>
    <form id="form" novalidate><p class="hint" id="photo-count"></p><ul class="galedit" id="gal-list"></ul></form>${bar('Save')}`, { bar: true, title: 'Edit or delete photos' });
  const list = $('#gal-list');
  const draw = () => {
    list.innerHTML = items.map((g, i) => `<li data-id="${esc(g.id)}"><img src="${esc(imgUrl(g.src))}" alt="${esc(g.caption || 'Gallery photo ' + (i + 1))}" loading="lazy">
      <span class="tag">${i === 0 ? 'Shown first' : ''}</span>
      ${fld('c-' + g.id, `Caption for photo ${i + 1}`, `<input id="c-${esc(g.id)}" data-cap type="text" maxlength="160" value="${esc(g.caption)}" placeholder="Add a caption">`, { opt: true })}
      <div class="tools"><button type="button" data-act="left" aria-label="Move photo ${i + 1} earlier" ${i === 0 ? 'disabled' : ''}>←</button><button type="button" data-act="right" aria-label="Move photo ${i + 1} later" ${i === items.length - 1 ? 'disabled' : ''}>→</button></div>
      <div data-delbox><button type="button" class="btn danger" data-act="del">Delete this photo</button></div></li>`).join('') || '<li class="hint">All photos will be removed from the gallery when you tap Save.</li>';
    $('#photo-count').textContent = items.length ? `${items.length} photo${items.length === 1 ? '' : 's'}. Use the arrows to change the order.` : 'No photos left.';
  };
  draw();
  const find = (el) => items.find((g) => g.id === el.closest('li')?.dataset.id);
  list.addEventListener('input', (ev) => { const g = find(ev.target); if (g && ev.target.matches('[data-cap]')) g.caption = ev.target.value; });
  list.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return; const g = find(b); if (!g) return; const i = items.indexOf(g);
    const box = b.closest('li').querySelector('[data-delbox]');
    if (b.dataset.act === 'left' && i > 0) { [items[i - 1], items[i]] = [items[i], items[i - 1]]; draw(); }
    else if (b.dataset.act === 'right' && i < items.length - 1) { [items[i + 1], items[i]] = [items[i], items[i + 1]]; draw(); }
    else if (b.dataset.act === 'del') { box.innerHTML = `<div class="confirm" role="alertdialog"><p><b>Delete this photo?</b><br>It and its caption disappear from the gallery when you tap Save.</p><button type="button" class="btn danger solid" data-act="yes">Yes, delete it</button><button type="button" class="btn quiet" data-act="no">No, keep it</button></div>`; box.querySelector('[data-act="no"]').focus(); }
    else if (b.dataset.act === 'no') box.innerHTML = '<button type="button" class="btn danger" data-act="del">Delete this photo</button>';
    else if (b.dataset.act === 'yes') { items.splice(i, 1); draw(); }
  });
  wireSave({
    validate: () => true,
    work: async () => { const out = await rpc('editor_save_gallery', { p_expected_version: version, p_images: items.map((g) => ({ src: g.src, caption: g.caption.trim() })) }); version = out.version; return out; },
    done: () => viewDone({ text: 'The photo gallery is updated.', viewHref: '../#gallery', viewLabel: 'See the gallery', another: { href: '#/gallery', label: 'Back to the gallery screen' } }),
    onReload: viewGalleryEdit,
  });
  followKeyboard();
}

// ── About page lists: priests & sisters (photo + name + role) and the scrolling photo strip (photo + caption) ──
// Both screens work the same way: a big Add button at the top, then every item listed so it can be edited, moved or deleted.
const PEOPLE_ROLES = ['Parish priest', 'Religious sister', 'Sister & priest'];
const LIST_KINDS = {
  faces: {
    title: 'Priests and sisters', max: 30, rpc: 'editor_save_faces', versionKey: 'faces_version', round: true,
    addLabel: 'Add priests or sisters', addHint: 'Pick one or more photos, then type each name.', word: 'person', words: 'people',
    get: () => (content.faces || []).map((f) => ({ src: f.src, name: f.name || '', role: f.role || '', focus: f.focus || 'center 20%' })),
    blank: () => ({ name: '', role: '', focus: 'center 20%' }),
    fields: [
      { k: 'name', label: 'Name', max: 80, ph: 'Fr. John Perera', req: 'Please type this person’s name.' },
      { k: 'role', label: 'Role', max: 60, ph: 'Parish priest', opt: true, list: 'roles' },
    ],
    payload: (i) => ({ src: i.src, name: i.name.trim(), role: i.role.trim(), focus: i.focus }),
    done: 'The priests and sisters on the About page are updated.',
  },
  strip: {
    title: 'About page photo strip', max: 40, rpc: 'editor_save_strip', versionKey: 'strip_version', round: false,
    addLabel: 'Add photos', addHint: 'Pick several at once. They scroll sideways on the About page.', word: 'photo', words: 'photos',
    get: () => (content.strip || []).map((f) => ({ src: f.src, caption: f.caption || '' })),
    blank: () => ({ caption: '' }),
    fields: [{ k: 'caption', label: 'Caption', max: 160, ph: 'What is happening in this photo?', opt: true }],
    payload: (i) => ({ src: i.src, caption: i.caption.trim() }),
    done: 'The photo strip on the About page is updated.',
  },
};

async function viewPeopleList(kind) {
  const K = LIST_KINDS[kind];
  viewLoading();
  try { await loadContent(); } catch (e) { return viewError(e, () => viewPeopleList(kind)); }
  const items = K.get().map((x) => ({ id: uuid(), ...x, blob: null, preview: '', path: null })); let version = content[K.versionKey];
  setView(`${back('#/')}<h1>${esc(K.title)}</h1><div id="note"></div>
    <label class="big primary pick"><span class="ico" aria-hidden="true">＋</span><span><b>${esc(K.addLabel)}</b><small>${esc(K.addHint)}</small></span><input id="photo-input" type="file" accept="image/*" multiple aria-label="${esc(K.addLabel)}: choose photos from your phone"></label>
    <p class="hint" id="photo-busy" aria-live="polite"></p>
    <form id="form" novalidate><p class="hint" id="photo-count"></p><ul class="galedit${K.round ? ' people' : ''}" id="pl-list"></ul></form>${bar('Save')}
    <datalist id="roles">${PEOPLE_ROLES.map((r) => `<option value="${esc(r)}">`).join('')}</datalist>`, { bar: true, title: K.title });
  const list = $('#pl-list');
  const draw = () => {
    list.innerHTML = items.map((it, i) => {
      const n = i + 1;
      const fields = K.fields.map((f) => fld(`pl-${it.id}-${f.k}`, `${f.label} for ${K.word} ${n}`,
        `<input id="pl-${esc(it.id)}-${f.k}" data-f="${f.k}" type="text" maxlength="${f.max}" value="${esc(it[f.k])}" placeholder="${esc(f.ph || '')}" ${f.list ? `list="${f.list}"` : ''} autocomplete="off">`, { opt: !!f.opt })).join('');
      return `<li data-id="${esc(it.id)}"><img class="${K.round ? 'face' : ''}" src="${esc(it.preview || imgUrl(it.src))}" alt="${esc(K.round ? (it.name || 'Photo ' + n) : (it.caption || 'Photo ' + n))}" ${K.round ? `style="object-position:${esc(it.focus || 'center 20%')}"` : ''}>
      <span class="tag">${i === 0 ? 'Shown first' : ''}</span>${fields}
      <div class="tools"><button type="button" data-act="left" aria-label="Move ${K.word} ${n} earlier" ${i === 0 ? 'disabled' : ''}>←</button><button type="button" data-act="right" aria-label="Move ${K.word} ${n} later" ${i === items.length - 1 ? 'disabled' : ''}>→</button>
      <label class="filebtn-sm">Change photo<input type="file" accept="image/*" data-replace aria-label="Change the photo of ${K.word} ${n}"></label></div>
      <div data-delbox><button type="button" class="btn danger" data-act="del">Delete this ${K.word}</button></div></li>`;
    }).join('') || `<li class="hint">There are no ${K.words} here yet. Tap <b>${esc(K.addLabel)}</b> above.</li>`;
    $('#photo-count').textContent = items.length ? `${items.length} ${items.length === 1 ? K.word : K.words}. Use the arrows to change the order.` : '';
  };
  draw();
  const find = (el) => items.find((g) => g.id === el.closest('li')?.dataset.id);
  list.addEventListener('input', (ev) => { const g = find(ev.target), k = ev.target.dataset.f; if (g && k) g[k] = ev.target.value; });
  list.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return; const g = find(b); if (!g) return; const i = items.indexOf(g);
    const box = b.closest('li').querySelector('[data-delbox]');
    if (b.dataset.act === 'left' && i > 0) { [items[i - 1], items[i]] = [items[i], items[i - 1]]; draw(); }
    else if (b.dataset.act === 'right' && i < items.length - 1) { [items[i + 1], items[i]] = [items[i], items[i + 1]]; draw(); }
    else if (b.dataset.act === 'del') { box.innerHTML = `<div class="confirm" role="alertdialog"><p><b>Delete this ${K.word}?</b><br>${esc(K.word === 'person' ? 'Their photo and name' : 'This photo and its caption')} disappear from the About page when you tap Save.</p><button type="button" class="btn danger solid" data-act="yes">Yes, delete it</button><button type="button" class="btn quiet" data-act="no">No, keep it</button></div>`; box.querySelector('[data-act="no"]').focus(); }
    else if (b.dataset.act === 'no') box.innerHTML = `<button type="button" class="btn danger" data-act="del">Delete this ${K.word}</button>`;
    else if (b.dataset.act === 'yes') { if (g.preview) URL.revokeObjectURL(g.preview); items.splice(i, 1); draw(); }
  });
  list.addEventListener('change', async (ev) => {                                       // Change photo (one item)
    if (!ev.target.matches('input[data-replace]')) return;
    const g = find(ev.target), f = ev.target.files[0]; if (!g || !f) return; ev.target.value = '';
    clearErrors(); showNote('', ''); $('#photo-busy').textContent = 'Preparing photo…';
    try { const blob = await processPhoto(f); if (g.preview) URL.revokeObjectURL(g.preview); g.blob = blob; g.path = null; g.preview = URL.createObjectURL(blob); $('#photo-busy').textContent = ''; draw(); }
    catch (e) { $('#photo-busy').textContent = ''; showNote('bad', esc(e instanceof PhotoError ? e.message : 'That photo could not be added.')); }
  });
  $('#photo-input').addEventListener('change', async (ev) => {                          // Add (one or many)
    const files = [...ev.target.files]; ev.target.value = ''; if (!files.length) return;
    clearErrors(); showNote('', '');
    const take = files.slice(0, Math.max(0, K.max - items.length)); const left = files.length - take.length;
    const busy = $('#photo-busy'); const problems = []; let done = 0;
    if (left > 0) problems.push(`This list can hold up to ${K.max} ${K.words}, so ${left} ${left === 1 ? 'photo was' : 'photos were'} left out.`);
    busy.textContent = `Preparing ${take.length} photo${take.length === 1 ? '' : 's'}…`;
    const results = await pool(take, 3, async (f) => {
      try { const blob = await processPhoto(f); return { id: uuid(), src: '', ...K.blank(), blob, preview: URL.createObjectURL(blob), path: null }; }
      catch (e) { problems.push(e instanceof PhotoError ? e.message : 'A photo could not be added.'); return null; }
      finally { done++; busy.textContent = `Preparing photos… ${done} of ${take.length}`; }
    });
    const added = results.filter(Boolean); added.forEach((r) => items.push(r));
    busy.textContent = added.length ? `Added ${added.length} ${added.length === 1 ? K.word : K.words}. ${K.round ? 'Type each name' : 'Add a caption if you like'}, then tap Save.` : '';
    draw(); if (problems.length) showNote('bad', [...new Set(problems)].map(esc).join('<br>'));
    if (added.length) { const first = $(`#pl-${added[0].id}-${K.fields[0].k}`); first?.scrollIntoView({ block: 'center', behavior: 'smooth' }); first?.focus({ preventScroll: true }); }
  });
  wireSave({
    validate: () => {
      for (const it of items) for (const f of K.fields) if (f.req && !String(it[f.k]).trim()) { fieldError(`pl-${it.id}-${f.k}`, f.req); return false; }
      return true;
    },
    work: async () => {
      const uid = current()?.user?.id; const todo = items.filter((it) => it.blob && !it.path); let n = 0;
      await pool(todo, 3, async (it) => { const path = `${uid}/${uuid()}.jpg`; await uploadFile('media', path, it.blob, 'image/jpeg'); it.path = path; n++; progress(`Uploading photos… ${n} of ${todo.length}`); });
      progress('Saving…');
      const out = await rpc(K.rpc, { p_expected_version: version, p_items: items.map((it) => K.payload({ ...it, src: it.blob ? it.path : it.src })) });
      version = out.version; return out;
    },
    done: () => viewDone({ text: K.done, viewHref: '../#about', viewLabel: 'See the About page' }),
    onReload: () => viewPeopleList(kind),
  });
  followKeyboard();
}

// ── password ──
function viewPasswordForm() {
  const recovery = !!window.__recovery;
  setView(`${recovery ? '' : back('#/')}<h1>${recovery ? 'Choose a new password' : 'Set or change my password'}</h1><div id="note"></div>
    <p>${recovery ? 'You’re signed in. Choose a new password to use next time.' : 'With a password you can sign in without waiting for an email. The emailed sign-in link keeps working too.'}</p>
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
    done: () => { window.__recovery = false; viewDone({ heading: 'Password saved.', text: 'You can now sign in with your email address and this password.' }); },
  });
  followKeyboard();
}

// ── bank details (owner only; everyone can see them on the Give page, so be careful) ──
const BANK_FIELDS = [
  ['bank_account_name', 'Name on the account', 'text', 80, true],
  ['bank_name', 'Bank', 'text', 80, true],
  ['bank_branch', 'Branch', 'text', 80, true],
  ['bank_account_no', 'Account number', 'text', 40, true],
  ['bank_swift', 'SWIFT code <span class="opt">(for gifts from abroad)</span>', 'text', 20, false],
];
async function viewBankForm() {
  if (!me?.owner) { setView(`${back('#/')}<h1>Not available</h1><div class="note info">Only the owner of the website can change the bank details.</div>`); return; }
  viewLoading();
  try { await loadContent(); } catch (e) { return viewError(e, viewBankForm); }
  let version = content.site_version; const site = content.site || {};
  const rows = BANK_FIELDS.map(([k, label, , max]) => {
    const extra = k === 'bank_account_no' ? ' inputmode="numeric" autocomplete="off" spellcheck="false"' : k === 'bank_swift' ? ' autocapitalize="characters" spellcheck="false" autocomplete="off"' : ' autocomplete="off"';
    return fld('f-' + k, label, `<input id="f-${k}" type="text" maxlength="${max}" value="${esc(site[k] ?? '')}"${extra}>`);
  }).join('');
  setView(`${back('#/')}<h1>Bank details</h1><div id="note"></div>
    <form id="form" novalidate><fieldset class="group"><h2>Bank in Sri Lanka</h2>${rows}</fieldset>
    <fieldset class="group"><h2>Note for donors <span class="opt">(optional)</span></h2>${fld('f-bank_note', 'Shown under the bank details', `<textarea id="f-bank_note" maxlength="300" style="min-height:110px">${esc(site.bank_note ?? '')}</textarea>`)}</fieldset>
    <div class="note info">Check the account number twice — donors copy it exactly as written.</div></form>${bar('Save')}`, { bar: true, title: 'Bank details' });
  wireSave({
    validate: () => {
      const need = { bank_account_name: 'Please type the name on the account.', bank_name: 'Please type the name of the bank.', bank_branch: 'Please type the branch.', bank_account_no: 'Please type the account number.' };
      let ok = true;
      for (const k of Object.keys(need).reverse()) if (!requireText('f-' + k, need[k])) ok = false;
      const no = $('#f-bank_account_no').value.trim();
      if (no && !/^[0-9][0-9 \-]*$/.test(no)) { clearErrors(); fieldError('f-bank_account_no', 'The account number can only have numbers, spaces and dashes.'); ok = false; }
      return ok;
    },
    work: async () => {
      const data = {}; [...BANK_FIELDS.map(([k]) => k), 'bank_note'].forEach((k) => { data[k] = $('#f-' + k).value; });
      const out = await rpc('editor_save_bank', { p_expected_version: version, p_data: data }); version = out.version; return out;
    },
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
  if (q.get('access_token')) {
    session.set(normaliseSession({ access_token: q.get('access_token'), refresh_token: q.get('refresh_token'), expires_in: q.get('expires_in') }));
    if (q.get('type') === 'recovery') { window.__recovery = true; history.replaceState(null, '', location.pathname + '#/password'); }
    return 'ok';
  }
  return 'error';
}

const ALIAS = { '/edit': '/', '/edit/updates': '/updates', '/edit/programmes': '/programmes', '/site': '/about' };   // old bookmarks keep working
async function route() {
  let h = location.hash.replace(/^#/, '') || '/';
  h = ALIAS[h] || h;
  if (!current()) { if (h === '/signin' || h === '/') return viewSignIn(window.__signInProblem || ''); if (h === '/forgot') return viewForgot(); location.hash = '#/signin'; return; }
  if (!me) {
    viewLoading('Signing in…');
    try { me = await rpc('editor_me'); }
    catch (e) { if (e.kind === 'network') return viewError(e, route); if (e.kind === 'auth' && !current()) return viewSignIn(); return viewNotEditor(); }
  }
  let m;
  if (h === '/' || h === '') return viewHome();
  if (h === '/signin') return viewSignIn();
  if (h === '/add') return viewUpdateForm(null);
  if (h === '/updates') return viewUpdateList();
  if (h === '/programmes') return viewProgrammeList();
  if ((m = h.match(/^\/update\/([0-9a-f-]{36})$/))) return viewUpdateForm(m[1]);
  if (h === '/programme/new') return viewProgrammeForm('new');
  if ((m = h.match(/^\/programme\/([0-9a-f-]{36})$/))) return viewProgrammeForm(m[1]);
  if (h === '/about') return viewAboutForm();
  if (h === '/faces') return viewPeopleList('faces');
  if (h === '/strip') return viewPeopleList('strip');
  if (h === '/contact') return viewContactForm();
  if (h === '/gallery') return viewGalleryMenu();
  if (h === '/gallery/photos') return viewGalleryEdit();
  if (h === '/forgot') return viewForgot();
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
