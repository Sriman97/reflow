if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
// Ask the browser to keep the library (books, positions) instead of clearing it under storage pressure.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(()=>{});
