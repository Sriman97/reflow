// Reflow service worker.
// App code (page, reader.js): network first, so updates arrive on the next online launch.
// Big static files (PDF.js, icons, fonts): cache first. Everything works offline after one visit.
const CACHE = 'reflow-20261109-2043';
const SHELL = ['./','index.html','reader.js','register-sw.js','pdf.min.js','pdf.worker.min.js','manifest.webmanifest',
  'icons/32.png','icons/192.png','icons/512.png','icons/maskable-512.png','icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, {cache:'reload'})))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
const networkFirst = req => fetch(req, {cache:'no-store'}).then(r => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); } return r; })
  .catch(() => caches.match(req, {ignoreSearch:true}).then(hit => hit || caches.match('index.html')));
const cacheFirst = req => caches.match(req, {ignoreSearch:true}).then(hit => hit || fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); } return r; }));
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    const appCode = req.mode === 'navigate' || /\/(index\.html|reader\.js|register-sw\.js)?$/.test(url.pathname) || /\.(html|webmanifest)$/.test(url.pathname) || url.pathname.endsWith('reader.js');
    e.respondWith(appCode ? networkFirst(req) : cacheFirst(req));
  } else if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(cacheFirst(req));
  }
});
