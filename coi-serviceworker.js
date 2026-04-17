/**
 * Cleanup script — previous versions registered a service worker to enable
 * cross-origin isolation (for multi-threaded FFmpeg.wasm). That broke the
 * YouTube preview iframe and blocked FFmpeg's own worker script.
 *
 * We now use single-threaded FFmpeg with blob-URL workers, so no SW is
 * needed. This file unregisters any lingering SW registrations from older
 * visits and reloads once, so returning users aren't stuck with a cached SW.
 */
(() => {
  if (typeof document === 'undefined') {
    // Running as the old service worker itself — self-unregister on activate.
    self.addEventListener('install', () => self.skipWaiting());
    self.addEventListener('activate', (e) => {
      e.waitUntil(self.registration.unregister().then(() => self.clients.claim()));
    });
    return;
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      let hadAny = false;
      for (const reg of regs) {
        reg.unregister();
        hadAny = true;
      }
      if (hadAny && !sessionStorage.getItem('coi-cleanup-reloaded')) {
        sessionStorage.setItem('coi-cleanup-reloaded', '1');
        location.reload();
      }
    });
  }
})();
