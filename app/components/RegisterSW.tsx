"use client";

import { useEffect } from "react";

/**
 * Registers the service worker so the app meets PWA installability criteria on
 * Android/Chrome. Without a registered service worker, "Add to Home screen"
 * produces a plain bookmark shortcut with a generic white fallback icon instead
 * of a WebAPK that uses the manifest's maskable icons. Registration failure is
 * non-fatal — the app still works, it just isn't installable.
 */
export default function RegisterSW() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Ignore: installability is a progressive enhancement, not a hard dependency.
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
