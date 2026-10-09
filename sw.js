// Rodina – service worker: iba upozornenia (žiadne ukladanie stránok do vyrovnávacej pamäte)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Rodina", {
    body: d.body || "", icon: "ikona-192.png", badge: "ikona-192.png", lang: "sk",
    tag: d.tag || undefined, data: { url: d.url || "/#/prehlad" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.location.origin)) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
