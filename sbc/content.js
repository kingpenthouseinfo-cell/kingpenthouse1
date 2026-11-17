/* SBC Global Foundation — content layer.
 * Loads the live website content (programmes, updates, About text) from the backend and hands it to
 * the page. The page keeps its built-in content as a fallback, so the site still works if the
 * backend is not set up yet or is briefly unreachable. Nothing here can write anything.
 *
 *   SBCContent.img(name)   → the right address for a photo: bundled ("assets/…") or uploaded (storage)
 *   SBCContent.ready       → promise: first usable result, within ~1.5 s
 *   SBCContent.settled     → promise: the live result (or the fallback if the backend failed)
 */
(function () {
  'use strict';
  var cfg = window.SBC_CONFIG || {};
  var base = String(cfg.supabaseUrl || '').replace(/\/+$/, '');
  var KEY = 'sbc-content-v1';
  var configured = !!(base && cfg.anonKey);

  // A photo is either a bundled file name ("food-van.jpg") or an uploaded one ("<editor>/<id>.jpg").
  function img(src) {
    src = String(src == null ? '' : src);
    if (!src) return '';
    if (/^(https?:)?\/\//i.test(src) || /^data:image\//i.test(src) || src.charAt(0) === '/') return src;
    if (src.indexOf('/') > -1) return base + '/storage/v1/object/public/media/' + src.split('/').map(encodeURIComponent).join('/');
    return 'assets/' + src;
  }

  // Only accept something that clearly looks like the full site content. A half-empty or odd answer
  // must never replace the real site (it would look like everything had been deleted).
  function valid(c) {
    if (!c || typeof c !== 'object' || !Array.isArray(c.programmes) || !c.programmes.length) return false;
    if (!Array.isArray(c.updates) || !c.site || typeof c.site !== 'object') return false;
    for (var i = 0; i < c.programmes.length; i++) {
      var p = c.programmes[i];
      if (!p || typeof p.name !== 'string' || !p.name || typeof p.short_label !== 'string' ||
          !Array.isArray(p.images) || p.position !== i) return false;
    }
    for (var j = 0; j < c.updates.length; j++) {
      var u = c.updates[j];
      if (!u || typeof u.id !== 'string' || typeof u.title !== 'string' || typeof u.body !== 'string' || !Array.isArray(u.images)) return false;
    }
    return true;
  }
  function readCache() { try { var c = JSON.parse(localStorage.getItem(KEY)); return valid(c) ? c : null; } catch (e) { return null; } }
  function writeCache(c) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) {} }

  function fetchLive() {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 8000);
    return fetch(base + '/rest/v1/rpc/public_content', {
      method: 'POST', cache: 'no-store', signal: ctl ? ctl.signal : undefined,
      headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
      body: '{}'
    }).then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (c) { if (!valid(c)) throw new Error('unexpected content'); writeCache(c); return { source: 'live', content: c }; });
  }

  var cached = configured ? readCache() : null;
  var fallback = { source: cached ? 'cache' : 'bundled', content: cached };
  var settled = configured
    ? fetchLive().catch(function (e) { try { console.warn('[sbc] live content unavailable, using', fallback.source, e && e.message); } catch (_) {} return fallback; })
    : Promise.resolve({ source: 'bundled', content: null });
  var ready = Promise.race([settled, new Promise(function (res) { setTimeout(function () { res(fallback); }, 1500); })]);

  window.SBCContent = { img: img, ready: ready, settled: settled, configured: configured, valid: valid };
})();
