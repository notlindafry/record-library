/**
 * Minimal service worker for vibe-shelf.
 *
 * Its ONLY job is to make the app installable as a PWA (a WebAPK on
 * Android/Chrome). Chrome's installability check requires a registered service
 * worker with a fetch handler; only then does "Add to Home screen" generate a
 * real app icon from the manifest's maskable icons instead of a generic white
 * bookmark shortcut (the white-padded fallback tile).
 *
 * It deliberately does NOT cache responses: this is a login-gated app, and
 * caching authenticated pages or API responses could leak or stale gated
 * content. The fetch handler below is intentionally inert — its mere presence
 * satisfies the installability requirement while leaving all network behaviour
 * to the browser.
 */

self.addEventListener("install", () => {
  // Activate a new worker immediately rather than waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Present but intentionally a no-op: required for installability, changes
// nothing about how requests are fetched or cached.
self.addEventListener("fetch", () => {});
