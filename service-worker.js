const NOTIFICATION_ICON = "/assets/app-icon.png";

self.addEventListener("push", (event) => {
  event.waitUntil(showTodayEventNotification(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openScheduleApp(event.notification.data?.url || "/"));
});

async function showTodayEventNotification(event) {
  const payload = readPushPayload(event);
  const notification = payload || (await fetchTodayEventNotification());
  if (!notification?.body) return;

  await self.registration.showNotification(notification.title || "Today's Event", {
    body: notification.body,
    icon: notification.icon || NOTIFICATION_ICON,
    badge: NOTIFICATION_ICON,
    tag: notification.tag || "shift-event-today",
    renotify: true,
    data: {
      url: notification.url || "/",
    },
  });
}

function readPushPayload(event) {
  try {
    return event.data ? event.data.json() : null;
  } catch {
    return null;
  }
}

async function fetchTodayEventNotification() {
  const subscription = await self.registration.pushManager.getSubscription();
  if (!subscription?.endpoint) return null;

  const response = await fetch("/api/reminders/today", {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      endpoint: subscription.endpoint,
    }),
  });

  if (!response.ok) return null;
  const result = await response.json();
  const events = Array.isArray(result.events) ? result.events : [];
  const body = events.map((item) => item.text).filter(Boolean).join("\n");
  if (!body) return null;

  return {
    title: "Today's Event",
    body,
    tag: `shift-event-${result.dateKey || "today"}`,
    url: "/",
  };
}

async function openScheduleApp(url) {
  const targetUrl = new URL(url, self.location.origin).href;
  const windowClients = await clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  for (const client of windowClients) {
    if (client.url.startsWith(self.location.origin) && "focus" in client) {
      await client.focus();
      if ("navigate" in client) await client.navigate(targetUrl);
      return;
    }
  }

  if (clients.openWindow) await clients.openWindow(targetUrl);
}
