// Register the service worker, check for updates on every return to the app, and reload once when a new version takes over.
if ('serviceWorker' in navigator) {
  let reloading = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    RLOG.step('new version installed, reloading');
    try { if (typeof saveNow === 'function') saveNow(); } catch (e) {}
    setTimeout(() => location.reload(), 150);
  });
  navigator.serviceWorker.register('sw.js', {updateViaCache:'none'}).then(reg => {
    const check = () => reg.update().catch(e => { if (navigator.onLine) RLOG.warn('update check', e); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    setInterval(check, 30 * 60 * 1000);
  }).catch(e => RLOG.error('service worker setup (offline use may not work)', e));
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
