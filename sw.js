// Rodina – service worker: upozornenia a číslo na ikone (žiadne ukladanie stránok do vyrovnávacej pamäte)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  // Chat: kto má práve otvorenú tú istú konverzáciu, nedostane zvonenie (správu už vidí); upozornenie sa hneď zavrie
  if (d.tag && d.tag.startsWith("chat-") && d.url) {
    const target = new URL(d.url, self.location.origin).href;
    e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (list) => {
      if (list.some((c) => c.focused && c.visibilityState === "visible" && c.url === target)) {
        await self.registration.showNotification(d.title || "Rodina", { body: d.body || "", tag: d.tag, silent: true, icon: "ikona-192.png" });
        (await self.registration.getNotifications({ tag: d.tag })).forEach((n) => n.close());
        return;
      }
      return showPush(d);
    }));
    return;
  }
  e.waitUntil(showPush(d));
});

function showPush(d) {
  const show = self.registration.showNotification(d.title || "Rodina", {
    body: d.body || "", icon: "ikona-192.png", badge: "ikona-192.png", lang: "sk",
    tag: d.tag || undefined, renotify: !!d.tag && !d.quiet, // aktualizácia zazvoní; „quiet“ = ďalšia položka nákupu potichu
    silent: !!d.quiet,
    requireInteraction: !!d.important,                   // dôležité (nová rýchla správa) ostane na obrazovke
    vibrate: d.quiet ? undefined : [200, 100, 200], timestamp: Date.now(),
    data: { url: d.url || "/#/prehlad" },
  });
  // číslo na ikone aplikácie (iPhone z plochy, Android, Windows/macOS)
  const badge = typeof d.badge === "number" && self.navigator.setAppBadge
    ? self.navigator.setAppBadge(Math.max(1, d.badge)).catch(() => {}) : Promise.resolve();
  return Promise.all([show, badge]);
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.location.origin)) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
