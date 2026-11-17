// LOCAL DEVELOPMENT SERVER — not used in production.
// Serves the website and pretends to be Supabase (sign-in links, the editor functions,
// photo storage) on top of a local Postgres (PGlite) that has the real migrations applied.
// It lets the editor and the public site be tried end to end on a laptop with no accounts.
//   npm run dev          → http://localhost:8787  (site)   http://localhost:8787/admin/ (editor)
import http from 'node:http';
import { createHmac, randomUUID, randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { createDb, asRole } from './db.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'dev-only-jwt-secret';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.md': 'text/plain' };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (payload) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64(payload);
  return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
function verify(token) {
  const [h, p, s] = String(token || '').split('.');
  if (!s || createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url') !== s) return null;
  const pl = JSON.parse(Buffer.from(p, 'base64url').toString());
  return pl.exp && pl.exp < Date.now() / 1000 ? null : pl;
}
export const ANON_KEY = sign({ role: 'anon', iss: 'dev' });

const pgLiteral = (v) => v === null || v === undefined ? 'null'
  : typeof v === 'number' || typeof v === 'boolean' ? String(v)
  : `'${(typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/'/g, "''")}'`;

function httpStatusFor(e, role) {
  const c = String(e.code || '');
  if (/^PT\d{3}$/.test(c)) return Number(c.slice(2));
  if (c === '42501') return role === 'anon' ? 401 : 403;
  if (c === '42883') return 404;
  if (c.startsWith('23')) return 409;
  return 400;
}

export async function startDevServer({ port = 8787, db, storageDir: dir } = {}) {
  db ||= await createDb();
  const storageDir = dir || join(root, 'dev', '.storage');
  await mkdir(storageDir, { recursive: true });
  const users = new Map();       // email -> {id,email}
  const codes = new Map();       // one-time token / code -> {email}
  const refresh = new Map();     // refresh token -> user
  const outbox = [];
  const faults = { rpc: [], upload: [], otp: [] };   // queued failures, consumed one per request
  const stats = { rpcCalls: 0, uploads: 0 };
  let delayRpcMs = 0;
  let configMode = 'ok';   // ok | unconfigured | down   (tests use this to check the site's fallback)

  const origin = () => `http://localhost:${port}`;
  const session = (u) => {
    const now = Math.floor(Date.now() / 1000);
    const access = sign({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', exp: now + 3600 });
    const rt = randomBytes(12).toString('hex'); refresh.set(rt, u);
    return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: rt, user: { id: u.id, email: u.email } };
  };
  async function addEditor(email) {
    let u = users.get(email);
    if (!u) {
      const r = await db.query(`insert into auth.users (email) values ($1) on conflict (email) do update set email = excluded.email returning id`, [email]);
      u = { id: r.rows[0].id, email }; users.set(email, u);
    }
    await db.query(`insert into public.editors (user_id, email) values ($1, $2) on conflict do nothing`, [u.id, email]);
    return u;
  }
  async function addUserOnly(email) {
    const r = await db.query(`insert into auth.users (email) values ($1) on conflict (email) do update set email = excluded.email returning id`, [email]);
    const u = { id: r.rows[0].id, email }; users.set(email, u); return u;
  }
  async function knownUser(email) {
    if (users.has(email)) return users.get(email);
    const r = await db.query('select id from auth.users where email = $1', [email]);
    if (r.rows[0]) { const u = { id: r.rows[0].id, email }; users.set(email, u); return u; }
    return null;
  }

  const readBody = (req) => new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); });
  const json = (res, code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(obj)); };
  const who = (req) => { const t = (req.headers.authorization || '').replace(/^Bearer /i, ''); return verify(t); };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin());
      const path = decodeURIComponent(url.pathname);

      // ── developer helpers (tests use these) ──
      if (path === '/__dev/editor' && req.method === 'POST') { const b = JSON.parse((await readBody(req)).toString()); const u = await addEditor(b.email); return json(res, 200, u); }
      if (path === '/__dev/user' && req.method === 'POST') { const b = JSON.parse((await readBody(req)).toString()); const u = await addUserOnly(b.email); return json(res, 200, u); }
      if (path === '/__dev/outbox') return json(res, 200, outbox.filter((m) => !url.searchParams.get('email') || m.email === url.searchParams.get('email')));
      if (path === '/__dev/fail' && req.method === 'POST') { const b = JSON.parse((await readBody(req)).toString()); for (let i = 0; i < (b.count || 1); i++) faults[b.target].push(b.status || 503); return json(res, 200, faults); }
      if (path === '/__dev/delay' && req.method === 'POST') { delayRpcMs = JSON.parse((await readBody(req)).toString()).ms; return json(res, 200, { ok: true }); }
      if (path === '/__dev/stats') return json(res, 200, stats);
      if (path === '/__dev/config' && req.method === 'POST') { configMode = JSON.parse((await readBody(req)).toString()).mode; return json(res, 200, { configMode }); }

      // ── config for the browser ──
      if (path === '/config.js') {
        res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
        const c = configMode === 'unconfigured' ? { supabaseUrl: '', anonKey: '' } : { supabaseUrl: configMode === 'down' ? 'http://127.0.0.1:9' : origin(), anonKey: ANON_KEY };
        return res.end(`window.SBC_CONFIG = ${JSON.stringify(c)};`);
      }

      // ── auth ──
      if (path === '/auth/v1/otp' && req.method === 'POST') {
        if (faults.otp.length) return json(res, faults.otp.shift(), { msg: 'temporarily unavailable' });
        const b = JSON.parse((await readBody(req)).toString() || '{}');
        const u = await knownUser(String(b.email || '').trim().toLowerCase());
        if (!u) return json(res, 422, { code: 422, error_code: 'otp_disabled', msg: 'Signups not allowed for otp' });
        const token = randomBytes(16).toString('hex'), code = String(Math.floor(100000 + Math.random() * 900000));
        codes.set(token, u.email); codes.set(`${u.email}:${code}`, u.email);
        const redirect = url.searchParams.get('redirect_to') || origin();
        outbox.push({ email: u.email, code, link: `${origin()}/auth/v1/verify?token=${token}&type=magiclink&redirect_to=${encodeURIComponent(redirect)}` });
        return json(res, 200, {});
      }
      if (path === '/auth/v1/verify' && req.method === 'GET') {
        const email = codes.get(url.searchParams.get('token')); const redirect = url.searchParams.get('redirect_to') || origin();
        if (!email) { res.writeHead(302, { location: `${redirect}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired` }); return res.end(); }
        codes.delete(url.searchParams.get('token'));
        const s = session(users.get(email));
        res.writeHead(302, { location: `${redirect}#access_token=${s.access_token}&expires_in=3600&refresh_token=${s.refresh_token}&token_type=bearer&type=magiclink` });
        return res.end();
      }
      if (path === '/auth/v1/verify' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString()); const email = String(b.email || '').toLowerCase();
        const key = `${email}:${String(b.token || '').trim()}`;
        if (!codes.has(key)) return json(res, 403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
        codes.delete(key); return json(res, 200, session(users.get(email)));
      }
      if (path === '/auth/v1/token' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)).toString()); const u = refresh.get(b.refresh_token);
        if (!u) return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
        refresh.delete(b.refresh_token); return json(res, 200, session(u));
      }
      if (path === '/auth/v1/user') { const c = who(req); return c?.sub ? json(res, 200, { id: c.sub, email: c.email }) : json(res, 401, { msg: 'invalid JWT' }); }
      if (path === '/auth/v1/logout') { res.writeHead(204); return res.end(); }

      // ── editor / public functions (what PostgREST does: set the role, call the function) ──
      const m = path.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
      if (m && req.method === 'POST') {
        stats.rpcCalls++;
        if (delayRpcMs) await new Promise((r) => setTimeout(r, delayRpcMs));
        if (faults.rpc.length && m[1].startsWith('editor_save')) return json(res, faults.rpc.shift(), { message: 'Service temporarily unavailable' });
        const claims = who(req);
        const role = claims?.role === 'authenticated' ? 'authenticated' : 'anon';
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const sql = `select to_jsonb(public.${m[1]}(${Object.entries(body).map(([k, v]) => `${k} => ${pgLiteral(v)}`).join(', ')})) as r`;
        try {
          const out = await asRole(db, role, role === 'authenticated' ? claims.sub : null, async (tx) => (await tx.query(sql)).rows[0].r);
          return json(res, 200, out);
        } catch (e) {
          return json(res, httpStatusFor(e, role), { code: e.code, message: e.message, details: e.detail || null, hint: null });
        }
      }

      // ── storage ──
      const up = path.match(/^\/storage\/v1\/object\/media\/(.+)$/);
      if (up && req.method === 'POST') {
        const claims = who(req); const body = await readBody(req);
        if (faults.upload.length) return json(res, faults.upload.shift(), { message: 'Upload temporarily unavailable' });
        const role = claims?.role === 'authenticated' ? 'authenticated' : 'anon';
        const ctype = (req.headers['content-type'] || '').split(';')[0];
        const bucket = (await db.query(`select file_size_limit, allowed_mime_types from storage.buckets where id = 'media'`)).rows[0];
        if (body.length > Number(bucket.file_size_limit)) return json(res, 413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
        if (!bucket.allowed_mime_types.includes(ctype)) return json(res, 415, { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${ctype} is not supported` });
        try {
          await asRole(db, role, role === 'authenticated' ? claims.sub : null, (tx) =>
            tx.query(`insert into storage.objects (bucket_id, name, metadata) values ('media', $1, $2)`, [up[1], JSON.stringify({ size: body.length, mimetype: ctype })]));
        } catch (e) {
          const code = String(e.code);
          if (code === '23505') return json(res, 409, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
          return json(res, 403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
        }
        const file = join(storageDir, normalize(up[1]).replace(/^(\.\.[/\\])+/, ''));
        await mkdir(dirname(file), { recursive: true }); await writeFile(file, body); await writeFile(`${file}.type`, ctype);
        stats.uploads++;
        return json(res, 200, { Key: `media/${up[1]}`, Id: randomUUID() });
      }
      const pub = path.match(/^\/storage\/v1\/object\/public\/media\/(.+)$/);
      if (pub) {
        const file = join(storageDir, normalize(pub[1]).replace(/^(\.\.[/\\])+/, ''));
        try { const data = await readFile(file); const type = (await readFile(`${file}.type`, 'utf8')).trim();
          res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600' }); return res.end(data); }
        catch { return json(res, 404, { statusCode: '404', error: 'not_found', message: 'Object not found' }); }
      }

      // ── static site ──
      let rel = path === '/' ? '/index.html' : path.endsWith('/') ? path + 'index.html' : path;
      if (path === '/admin') { res.writeHead(301, { location: '/admin/' }); return res.end(); }
      const file = join(root, normalize(rel));
      if (!file.startsWith(root) || /\/(supabase|dev|tests|scripts|node_modules|docs)\//.test(rel) || rel.includes('/.')) { res.writeHead(404); return res.end('Not found'); }
      try {
        const st = await stat(file); if (!st.isFile()) throw new Error('nf');
        const range = req.headers.range;
        const data = await readFile(file);
        const headers = { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'accept-ranges': 'bytes' };
        if (range) { const mm = /bytes=(\d*)-(\d*)/.exec(range); const s = +mm[1] || 0, e = mm[2] ? +mm[2] : data.length - 1;
          res.writeHead(206, { ...headers, 'content-range': `bytes ${s}-${e}/${data.length}`, 'content-length': e - s + 1 }); return res.end(data.subarray(s, e + 1)); }
        res.writeHead(200, headers); return res.end(data);
      } catch { res.writeHead(404); return res.end('Not found'); }
    } catch (e) {
      console.error(e); json(res, 500, { message: String(e.message || e) });
    }
  });
  await new Promise((r) => server.listen(port, r));
  return { server, db, port, storageDir, origin: origin(), close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }), addEditor, addUserOnly, outbox, faults, stats };
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const s = await startDevServer({ port: Number(process.env.PORT || 8787) });
  const email = process.env.DEV_EDITOR_EMAIL || 'priest@example.org';
  await s.addEditor(email);
  console.log(`\nSBC dev server (local only — a stand-in for Supabase)\n  Website: ${s.origin}/\n  Editor:  ${s.origin}/admin/\n  Test editor: ${email}  (sign-in emails are not sent: open ${s.origin}/__dev/outbox?email=${email})\n`);
}
