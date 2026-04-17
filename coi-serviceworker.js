/* coi-serviceworker v0.1.7 — gzuidhof/coi-serviceworker (MIT)
 * Injects Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers
 * so SharedArrayBuffer (needed by multi-threaded FFmpeg.wasm) is available.
 */
(() => {
  if (typeof document === 'undefined') {
    // Running as the service worker itself
    self.addEventListener('install', () => self.skipWaiting());
    self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', function (event) {
      if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;
      event.respondWith(
        fetch(event.request).then(function (response) {
          if (response.status === 0) return response;
          const headers = new Headers(response.headers);
          headers.set('Cross-Origin-Opener-Policy', 'same-origin');
          headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
          headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        })
      );
    });
    return;
  }

  // Running in the page — register the SW if needed
  if (!window.crossOriginIsolated && 'serviceWorker' in navigator) {
    // Guard against infinite reload loops: only reload once per session.
    const reloaded = sessionStorage.getItem('coi-reloaded');
    navigator.serviceWorker.register(document.currentScript.src).then(reg => {
      const sw = reg.installing || reg.waiting;
      if (sw && !reloaded) {
        // Wait for the SW to activate before reloading so it can intercept the navigation.
        sw.addEventListener('statechange', function () {
          if (this.state === 'activated') {
            sessionStorage.setItem('coi-reloaded', '1');
            location.reload();
          }
        });
      }
    });
  }
})();
