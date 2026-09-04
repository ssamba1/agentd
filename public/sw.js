// Service worker: the only reason the PWA hears anything while backgrounded.
//
// No caching strategy on purpose. agentd is reached over a LAN/Tailscale link
// where staleness is a worse failure than a slow load -- a cached shell showing
// yesterday's approvals would be actively misleading.

self.addEventListener("install", (event) => {
  // Take over immediately so a redeployed daemon is not talking to an old
  // worker that no longer matches its push payload shape.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = { title: "agentd", body: "Something needs you.", tag: "agentd", url: "/" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    if (event.data) payload.body = event.data.text();
  }

  // iOS permits no silent push: every message must render something, or the
  // subscription gets penalised.
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      renotify: true,
      data: { url: payload.url },
      requireInteraction: false,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Focus an existing window rather than piling up duplicates.
      for (const client of all) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(target).catch(() => {});
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
