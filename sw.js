/* ===== Пилюлькин День — Service Worker ===== */
const CACHE = "pillpals-v6";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

// Установка: кешируем оболочку приложения
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// Активация: чистим старый кеш
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first с fallback к сети (для офлайн-работы)
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        // кешируем новые GET-запросы того же происхождения
        if (resp.ok && new URL(req.url).origin === location.origin) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return resp;
      }).catch(() => caches.match("./index.html"));
    })
  );
});

// Клик по уведомлению: открыть/сфокусировать приложение
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "./index.html";
  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of allClients) {
        if ("focus" in client) {
          client.postMessage({ type: "notif-click" });
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })()
  );
});

// Закрытие уведомления
self.addEventListener("notificationclose", () => { /* no-op */ });

// ===== Push: приходят фоновые уведомления от сервера =====
self.addEventListener("push", (event) => {
  let data = { title: "💊 Пилюлькин напоминает!", body: "Пора принять лекарство!" };
  try {
    if (event.data) {
      const text = event.data.text();
      try { data = JSON.parse(text); } catch { data.body = text; }
    }
  } catch (e) { /* ignore */ }

  const options = {
    body: data.body,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: data.tag || "pillpals-push",
    data: { url: data.url || "./index.html" },
    vibrate: [200, 100, 200],
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(data.title, options));
});

// Периодическая фоновая синхронизация (где поддерживается)
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "pillpals-check") {
    event.waitUntil(Promise.resolve());
  }
});
