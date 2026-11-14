// Reflow debug log.
// Keeps the last 80 errors and app steps on this device (localStorage), so a problem can be looked at after it happens,
// even after a reload or a crash. Nothing leaves the device unless you tap "Report a problem" and choose to share it.
// Loaded first, before PDF.js and reader.js, so it also catches errors while the app starts.
const APP_VERSION = '20261114-1700';   // must match CACHE in sw.js (tests/debuglog_smoke.js checks this)

const RLOG = (() => {
  const KEY = 'reflow.log', MAX = 80, started = Date.now();
  let list = [];
  try { list = JSON.parse(localStorage.getItem(KEY) || '[]'); if (!Array.isArray(list)) list = []; } catch (e) { list = []; }
  const listeners = [];
  const cut = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };
  const describe = err => {
    if (err == null) return String(err);
    if (typeof err !== 'object') return String(err);
    return (err.name ? err.name + ': ' : '') + (err.message != null ? err.message : (() => { try { return JSON.stringify(err); } catch (_) { return String(err); } })());
  };
  const stackOf = err => {   // Chrome repeats the message on the first line; Safari doesn't
    if (!err || !err.stack) return '';
    let ls = String(err.stack).split('\n').map(l => l.trim()).filter(Boolean);
    if (ls[0] && err.message && ls[0].includes(err.message)) ls = ls.slice(1);
    return ls.slice(0, 6).join(' / ');
  };
  // Written straight away (not batched): the next thing after an error may be a crash or reload.
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {} };
  function add(kind, msg, extra, opts) {
    const e = { t: Date.now(), v: APP_VERSION, k: kind, m: cut(msg, 600) };
    if (extra) e.x = cut(extra, 900);
    list.push(e); if (list.length > MAX) list.splice(0, list.length - MAX);
    persist();
    for (const f of listeners) { try { f(e, opts || {}); } catch (_) {} }
    return e;
  }
  // Short, stable, non-reversible tag for a book, so the log never holds book titles.
  function tag(s) { let h = 2166136261; s = String(s || ''); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return 'book#' + (h >>> 0).toString(16).padStart(8, '0').slice(0, 6); }
  const time = t => { const d = new Date(t), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  return {
    APP_VERSION, started, tag,
    // notify:true shows a small "Something went wrong" notice (see reader.js); use it for problems the reader would notice.
    error(where, err, opts) { return add('error', where + ': ' + describe(err), stackOf(err), opts); },
    warn(where, err) { return add('warn', where + ': ' + describe(err), stackOf(err)); },
    step(msg) { return add('step', msg); },
    entries() { return list.slice(); },
    errors(since) { return list.filter(e => e.k === 'error' && e.t > (since || 0)); },
    clear() { list = []; persist(); },
    onAdd(f) { listeners.push(f); },
    line(e) { return `${time(e.t)} ${e.k.toUpperCase().padEnd(5)} ${e.m}${e.x ? '\n      at ' + e.x : ''}${e.v !== APP_VERSION ? '  [v' + e.v + ']' : ''}`; },
    text() { return list.map(e => this.line(e)).join('\n'); },
  };
})();

window.addEventListener('error', e => {
  const el = e.target;
  if (el && el !== window && el.tagName) { RLOG.warn('could not load', (el.src || el.href || el.tagName)); return; }   // a script, image or font failed to load
  RLOG.error('uncaught', e.error || ((e.message || 'error') + ' @ ' + (e.filename || '?') + ':' + e.lineno + ':' + e.colno), { notify: true });
}, true);
window.addEventListener('unhandledrejection', e => { RLOG.error('unhandled promise', e.reason, { notify: true }); });
window.addEventListener('online', () => RLOG.step('online'));
window.addEventListener('offline', () => RLOG.step('offline'));

// Debug mode: mirrors console warnings and errors (PDF.js reports book problems there) into the log, and shows the log on screen.
// Turn it on with ?debug=1 once, or from Report a problem → "Show live log". ?debug=0 turns it off.
const RDEBUG = (() => {
  let on = false;
  try {
    const q = new URLSearchParams(location.search).get('debug');
    if (q === '1') localStorage.setItem('reflow.debug', '1'); else if (q === '0') localStorage.removeItem('reflow.debug');
    on = localStorage.getItem('reflow.debug') === '1';
  } catch (e) {}
  if (on) for (const lvl of ['warn', 'error']) {
    const orig = console[lvl];
    console[lvl] = function (...a) { try { RLOG.warn('console.' + lvl, a.map(x => x && x.stack ? x.stack : (typeof x === 'object' ? (() => { try { return JSON.stringify(x); } catch (_) { return String(x); } })() : String(x))).join(' ')); } catch (_) {} return orig.apply(console, a); };
  }
  return { on, set(v) { try { v ? localStorage.setItem('reflow.debug', '1') : localStorage.removeItem('reflow.debug'); } catch (e) {} } };
})();

RLOG.step(`app start v${APP_VERSION}` + (matchMedia && matchMedia('(display-mode: standalone)').matches || navigator.standalone ? ' (home screen)' : ' (browser)') + (navigator.onLine === false ? ' offline' : '') + (RDEBUG.on ? ' debug' : ''));
