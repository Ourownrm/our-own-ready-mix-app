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
// Payload shape sent from the backend: { title, body, url }.
self.addEventListener("push", (event) => {
  let data = { title: "Our Own Ready Mix", body: "You have an update." };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // Non-JSON payload — fall back to the default text above rather than failing silently.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/" },
    })
  );
});

// Tapping the notification focuses an already-open tab if there is one,
// otherwise opens a new one at the relevant screen.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
