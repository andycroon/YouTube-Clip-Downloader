/**
 * Cleanup script — older versions of this app registered a service worker to
 * enable cross-origin isolation. That broke the YouTube preview iframe and
 * FFmpeg's worker loading, so the SW has been removed. This file now only
 * unregisters any lingering SW, clears its caches, and forces one reload so
 * returning visitors aren't stuck being served through the stale SW.
 */
(async () => {
  if (typeof document === 'undefined') {
    // If this file is ever fetched *as* a service worker (old registrations),
    // make it immediately self-destruct.
    self.addEventListener('install', () => self.skipWaiting());
    self.addEventListener('activate', (e) => {
      e.waitUntil((async () => {
        await self.registration.unregister();
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
        const clients = await self.clients.matchAll();
        clients.forEach((c) => c.navigate(c.url));
      })());
    });
    return;
  }

  if (!('serviceWorker' in navigator)) return;

  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    if (regs.length === 0) return;

    await Promise.all(regs.map((r) => r.unregister()));

    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }

    if (!sessionStorage.getItem('coi-cleanup-reloaded')) {
      sessionStorage.setItem('coi-cleanup-reloaded', '1');
      location.reload();
    }
  } catch (e) {
    console.warn('[coi-cleanup]', e);
  }
})();
