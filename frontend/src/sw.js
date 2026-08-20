import { precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { NetworkFirst } from "workbox-strategies";

// App shell precaching — same as the previous auto-generated config, just
// written explicitly now that this is a custom service worker.
precacheAndRoute(self.__WB_MANIFEST);

// Data mutations made offline are queued (see src/lib/offlineQueue.js) and
// flushed automatically once connectivity returns; this just lets recently-
// seen orders still render immediately while offline.
registerRoute(
  ({ url }) => url.pathname.includes("/api/orders"),
  new NetworkFirst({ cacheName: "orders-cache", networkTimeoutSeconds: 3 })
);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Push notifications — see /docs in README for which actions trigger these.
// Payload shape sent from the backend: { title, body, url }, plus optionally
// { action: { path, method }, actionText } (round 96, item 9) when this
// notification supports a one-tap "confirm this stage" action button
// directly from the notification tray, without opening the app first.
self.addEventListener("push", (event) => {
  let data = { title: "Our Own Ready Mix", body: "You have an update." };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // Non-JSON payload — fall back to the default text above rather than failing silently.
  }
  const options = {
    body: data.body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/", action: data.action || null },
  };
  if (data.action && data.actionText) {
    options.actions = [{ action: "confirm", title: data.actionText }];
  }
  event.waitUntil(self.registration.showNotification(data.title, options));
});

// Same env var api.js builds BASE_URL from — safe to read here too since
// this file goes through Vite's build (injectManifest strategy, see
// vite.config.js), not a raw-copied static file.
const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:4000/api";

function getStoredToken() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open("oorm-auth", 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("kv")) req.result.createObjectStore("kv");
      };
      req.onsuccess = () => {
        try {
          const tx = req.result.transaction("kv", "readonly");
          const getReq = tx.objectStore("kv").get("token");
          getReq.onsuccess = () => resolve(getReq.result || null);
          getReq.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// Tapping the notification body focuses an already-open tab if there is
// one, otherwise opens a new one at the relevant screen — unchanged.
//
// Tapping the "confirm" action button (round 96, item 9 — the business
// chose instant-log over a confirm screen) instead calls the API directly
// using the token saved to IndexedDB at login (see src/lib/authDb.js),
// without opening the app at all. If that fails for any reason — no stored
// token, offline, the stage already moved on server-side — it falls back to
// opening the app at the relevant screen so the driver/supervisor can still
// act on it manually. Either way a fresh copy of the trip list is only a
// tab-focus away, so there's no risk of the action silently vanishing.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  const action = event.notification.data?.action;

  if (event.action === "confirm" && action?.path) {
    event.waitUntil(
      getStoredToken().then((token) => {
        if (!token) return openOrFocus(targetUrl);
        return fetch(`${API_BASE}${action.path}`, {
          method: action.method || "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({}),
        })
          .then((res) => { if (!res.ok) return openOrFocus(targetUrl); })
          .catch(() => openOrFocus(targetUrl));
      })
    );
    return;
  }

  event.waitUntil(openOrFocus(targetUrl));
});

function openOrFocus(targetUrl) {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
    for (const client of clientList) {
      if ("focus" in client) {
        client.navigate(targetUrl);
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
  });
}
