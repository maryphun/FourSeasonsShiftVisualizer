const MAX_BODY_BYTES = 14 * 1024 * 1024;
const DEFAULT_TIMEZONE = "Asia/Tokyo";
const DEFAULT_VAPID_SUBJECT = "https://shift-visualize-ocr.otopo.workers.dev";
const DEFAULT_REMINDER_TIME = "00:01";
const REMINDER_EVENTS_PREFIX = "reminder:events:";
const REMINDER_SUBSCRIPTION_PREFIX = "reminder:subscription:";
const REMINDER_SENT_PREFIX = "reminder:sent:";
const REMINDER_VAPID_KEY = "reminder:vapid";
const REMINDER_SENT_TTL_SECONDS = 60 * 60 * 36;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/vision") {
      return handleVision(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/version") {
      return handleVersion(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/reminders/config") {
      return handleReminderConfig(env);
    }

    if (request.method === "POST" && url.pathname === "/api/reminders/events") {
      return handleReminderEvents(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/reminders/subscribe") {
      return handleReminderSubscribe(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/reminders/today") {
      return handleTodayReminder(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      return jsonResponse({
        ok: true,
        googleAuth: env.GOOGLE_VISION_API_KEY ? "API key" : "not configured",
        reminders: Boolean(env.REMINDER_STORE),
      });
    }

    return env.ASSETS.fetch(request);
  },
  scheduled(event, env, ctx) {
    ctx.waitUntil(sendDueEventReminders(env, new Date(event.scheduledTime || Date.now())));
  },
};

async function handleVersion(request, env) {
  const indexUrl = new URL("/", request.url);
  const response = await env.ASSETS.fetch(new Request(indexUrl, { method: "GET" }));
  const html = await response.text();

  return jsonResponse({
    version: extractAppVersion(html),
  });
}

async function handleVision(request, env) {
  const body = await readJsonBody(request);
  const imageBase64 = String(body.imageBase64 || "").replace(/^data:image\/\w+;base64,/, "");
  const apiKey = String(env.GOOGLE_VISION_API_KEY || body.googleApiKey || "").trim();

  if (!imageBase64) {
    return jsonResponse({ error: "Missing image data" }, 400);
  }

  if (!apiKey) {
    return jsonResponse({ error: "Google Vision auth is not configured." }, 401);
  }

  const googleUrl = new URL("https://vision.googleapis.com/v1/images:annotate");
  googleUrl.searchParams.set("key", apiKey);

  const googleResponse = await fetch(googleUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      requests: [
        {
          image: {
            content: imageBase64,
          },
          features: [
            {
              type: "DOCUMENT_TEXT_DETECTION",
              maxResults: 1,
            },
          ],
        },
      ],
    }),
  });

  const result = await googleResponse.json();
  const apiError = result.error || result.responses?.[0]?.error;

  if (!googleResponse.ok || apiError) {
    return jsonResponse(
      {
        error: apiError?.message || googleResponse.statusText || "Google Vision request failed",
        details: apiError || result,
      },
      googleResponse.status || 502,
    );
  }

  const annotation = result.responses?.[0]?.fullTextAnnotation;
  const text = annotation?.text || result.responses?.[0]?.textAnnotations?.[0]?.description || "";

  return jsonResponse({
    text,
    words: collectWords(annotation),
    auth: "API key",
  });
}

async function handleReminderConfig(env) {
  const store = getReminderStore(env);
  if (!store) {
    return jsonResponse({
      enabled: false,
      publicKey: "",
      reason: "Daily alerts need the Cloudflare reminder store.",
    });
  }

  const keys = await getOrCreateVapidKeys(store);
  return jsonResponse({
    enabled: true,
    publicKey: keys.publicKey,
  });
}

async function handleReminderEvents(request, env) {
  const store = getReminderStore(env);
  if (!store) return reminderStoreMissingResponse();

  const body = await readJsonBody(request);
  const clientId = normalizeClientId(body.clientId);
  if (!clientId) return jsonResponse({ error: "Missing reminder client." }, 400);

  const record = {
    clientId,
    timezone: normalizeTimezone(body.timezone),
    notificationEnabled: normalizeReminderEnabled(body.notificationEnabled),
    reminderTime: normalizeReminderTime(body.reminderTime),
    events: normalizeReminderEvents(body.events),
    updatedAt: new Date().toISOString(),
  };

  await store.put(`${REMINDER_EVENTS_PREFIX}${clientId}`, JSON.stringify(record));
  return jsonResponse({
    ok: true,
    eventCount: Object.keys(record.events).length,
  });
}

async function handleReminderSubscribe(request, env) {
  const store = getReminderStore(env);
  if (!store) return reminderStoreMissingResponse();

  const body = await readJsonBody(request);
  const clientId = normalizeClientId(body.clientId);
  const subscription = normalizePushSubscription(body.subscription);
  if (!clientId) return jsonResponse({ error: "Missing reminder client." }, 400);
  if (!subscription) return jsonResponse({ error: "Missing push subscription." }, 400);

  const subscriptionId = await hashText(subscription.endpoint);
  const record = {
    clientId,
    timezone: normalizeTimezone(body.timezone),
    notificationEnabled: normalizeReminderEnabled(body.notificationEnabled),
    reminderTime: normalizeReminderTime(body.reminderTime),
    subscription,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await store.put(`${REMINDER_SUBSCRIPTION_PREFIX}${subscriptionId}`, JSON.stringify(record));
  return jsonResponse({
    ok: true,
  });
}

async function handleTodayReminder(request, env) {
  const store = getReminderStore(env);
  if (!store) return jsonResponse({ dateKey: "", events: [] });

  const body = await readJsonBody(request);
  const endpoint = String(body.endpoint || "").trim();
  if (!endpoint) return jsonResponse({ dateKey: "", events: [] });

  const subscriptionId = await hashText(endpoint);
  const subscription = await store.get(`${REMINDER_SUBSCRIPTION_PREFIX}${subscriptionId}`, "json");
  if (!subscription?.clientId) return jsonResponse({ dateKey: "", events: [] });

  const eventRecord = await store.get(`${REMINDER_EVENTS_PREFIX}${subscription.clientId}`, "json");
  const timezone = normalizeTimezone(subscription.timezone || eventRecord?.timezone);
  const today = datePartsInTimezone(new Date(), timezone);
  const eventText = normalizeReminderText(eventRecord?.events?.[today.dateKey]);

  return jsonResponse({
    dateKey: today.dateKey,
    events: eventText ? [{ text: eventText }] : [],
  });
}

async function sendDueEventReminders(env, now = new Date()) {
  const store = getReminderStore(env);
  if (!store) return;

  const vapidKeys = await getOrCreateVapidKeys(store);
  let cursor;

  do {
    const page = await store.list({
      prefix: REMINDER_SUBSCRIPTION_PREFIX,
      cursor,
      limit: 500,
    });
    cursor = page.cursor;

    await Promise.all(
      page.keys.map((key) => sendDueEventReminder(store, vapidKeys, env, key, now)),
    );
  } while (cursor);
}

async function sendDueEventReminder(store, vapidKeys, env, key, now) {
  try {
    const subscriptionId = key.name.slice(REMINDER_SUBSCRIPTION_PREFIX.length);
    const subscriptionRecord = await store.get(key.name, "json");
    if (!subscriptionRecord?.subscription?.endpoint || !subscriptionRecord.clientId) {
      await store.delete(key.name);
      return;
    }

    const eventRecord = await store.get(`${REMINDER_EVENTS_PREFIX}${subscriptionRecord.clientId}`, "json");
    if (subscriptionRecord.notificationEnabled === false || eventRecord?.notificationEnabled === false) return;

    const timezone = normalizeTimezone(subscriptionRecord.timezone || eventRecord?.timezone);
    const reminderTime = normalizeReminderTime(subscriptionRecord.reminderTime || eventRecord?.reminderTime);
    const due = reminderDueParts(now, timezone, reminderTime);
    if (!due) return;

    const sentKey = `${REMINDER_SENT_PREFIX}${subscriptionId}:${due.dateKey}:${due.timeKey}`;
    if (await store.get(sentKey)) return;

    const eventText = normalizeReminderText(eventRecord?.events?.[due.dateKey]);
    if (!eventText) return;

    const result = await sendWebPush(subscriptionRecord.subscription, {
      keys: vapidKeys,
      subject: env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT,
    });

    if (result.expired) {
      await store.delete(key.name);
      return;
    }

    if (result.ok) {
      await store.put(sentKey, new Date().toISOString(), {
        expirationTtl: REMINDER_SENT_TTL_SECONDS,
      });
    }
  } catch (error) {
    console.warn("Daily reminder skipped for one subscription", error);
  }
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    throw new Error("Upload is too large.");
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new Error("Upload is too large.");
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Invalid JSON request body.");
  }
}

function getReminderStore(env) {
  return env.REMINDER_STORE || null;
}

function reminderStoreMissingResponse() {
  return jsonResponse({ error: "Daily alerts need the Cloudflare reminder store." }, 503);
}

function normalizeClientId(value) {
  const text = String(value || "").trim();
  return /^[a-zA-Z0-9._:-]{8,120}$/.test(text) ? text : "";
}

function normalizeTimezone(value) {
  const timezone = String(value || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function normalizeReminderEvents(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, text]) => [String(key || "").trim(), normalizeReminderText(text)])
      .filter(([key, text]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && text),
  );
}

function normalizeReminderEnabled(value) {
  if (value === false) return false;
  const text = String(value || "").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(text);
}

function normalizeReminderTime(value) {
  const text = String(value || DEFAULT_REMINDER_TIME).trim();
  const match = text.match(/^(\d{1,2}):([0-5]\d)$/);
  if (!match) return DEFAULT_REMINDER_TIME;

  const hour = Number(match[1]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return DEFAULT_REMINDER_TIME;

  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function normalizeReminderText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function normalizePushSubscription(value) {
  const endpoint = String(value?.endpoint || "").trim();
  if (!endpoint || !/^https:\/\//i.test(endpoint)) return null;

  return {
    endpoint,
    expirationTime: value.expirationTime || null,
    keys: {
      p256dh: String(value.keys?.p256dh || ""),
      auth: String(value.keys?.auth || ""),
    },
  };
}

function reminderDueParts(date, timezone, reminderTime = DEFAULT_REMINDER_TIME) {
  const parts = datePartsInTimezone(date, timezone);
  const [targetHour, targetMinute] = normalizeReminderTime(reminderTime).split(":");
  if (parts.hour === targetHour && parts.minute === targetMinute) {
    return {
      ...parts,
      timeKey: `${targetHour}${targetMinute}`,
    };
  }
  return null;
}

function datePartsInTimezone(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: normalizeTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));

  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parts.hour,
    minute: parts.minute,
  };
}

async function getOrCreateVapidKeys(store) {
  const existing = await store.get(REMINDER_VAPID_KEY, "json");
  if (isValidVapidKeys(existing)) return existing;

  const keyPair = await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const keys = {
    privateJwk,
    publicKey: publicApplicationServerKey(publicJwk),
    createdAt: new Date().toISOString(),
  };

  await store.put(REMINDER_VAPID_KEY, JSON.stringify(keys));
  return keys;
}

function isValidVapidKeys(value) {
  return Boolean(value?.privateJwk?.d && value.privateJwk.x && value.privateJwk.y && value.publicKey);
}

function publicApplicationServerKey(publicJwk) {
  const x = base64UrlDecode(publicJwk.x);
  const y = base64UrlDecode(publicJwk.y);
  const key = new Uint8Array(65);
  key[0] = 4;
  key.set(x, 1);
  key.set(y, 33);
  return base64UrlEncode(key);
}

async function sendWebPush(subscription, options) {
  const endpoint = String(subscription?.endpoint || "");
  if (!endpoint) return { ok: false };

  const audience = new URL(endpoint).origin;
  const jwt = await createVapidJwt(options.keys.privateJwk, {
    audience,
    subject: options.subject,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${options.keys.publicKey}`,
      TTL: "3600",
      Urgency: "normal",
    },
  });

  return {
    ok: response.ok,
    expired: response.status === 404 || response.status === 410,
    status: response.status,
  };
}

async function createVapidJwt(privateJwk, options) {
  const header = base64UrlEncodeJson({
    typ: "JWT",
    alg: "ES256",
  });
  const payload = base64UrlEncodeJson({
    aud: options.audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: options.subject || DEFAULT_VAPID_SUBJECT,
  });
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    {
      name: "ECDSA",
      hash: "SHA-256",
    },
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64UrlEncode(ecdsaSignatureToJose(new Uint8Array(signature)))}`;
}

function ecdsaSignatureToJose(signature) {
  if (signature.length === 64) return signature;
  if (signature[0] !== 0x30) return signature;

  let offset = signature[1] > 0x80 ? 3 : 2;
  if (signature[offset] !== 0x02) return signature;
  const rLength = signature[offset + 1];
  const r = signature.slice(offset + 2, offset + 2 + rLength);
  offset += 2 + rLength;
  if (signature[offset] !== 0x02) return signature;
  const sLength = signature[offset + 1];
  const s = signature.slice(offset + 2, offset + 2 + sLength);

  const jose = new Uint8Array(64);
  jose.set(trimAndPadEcInteger(r), 0);
  jose.set(trimAndPadEcInteger(s), 32);
  return jose;
}

function trimAndPadEcInteger(value) {
  let bytes = value;
  while (bytes.length > 32 && bytes[0] === 0) bytes = bytes.slice(1);
  const output = new Uint8Array(32);
  output.set(bytes.slice(-32), 32 - Math.min(32, bytes.length));
  return output;
}

function base64UrlEncodeJson(value) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

async function hashText(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function collectWords(annotation) {
  const words = [];

  for (const page of annotation?.pages || []) {
    for (const block of page.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const word of paragraph.words || []) {
          const vertices = normalizeVertices(word.boundingBox?.vertices || []);
          words.push({
            text: (word.symbols || []).map((symbol) => symbol.text || "").join(""),
            confidence: word.confidence ?? "",
            x0: Math.min(...vertices.map((vertex) => vertex.x)),
            y0: Math.min(...vertices.map((vertex) => vertex.y)),
            x1: Math.max(...vertices.map((vertex) => vertex.x)),
            y1: Math.max(...vertices.map((vertex) => vertex.y)),
          });
        }
      }
    }
  }

  return words;
}

function normalizeVertices(vertices) {
  return [0, 1, 2, 3].map((index) => ({
    x: Number(vertices[index]?.x || 0),
    y: Number(vertices[index]?.y || 0),
  }));
}

function extractAppVersion(html) {
  const text = String(html || "");
  const metaTag = text.match(/<meta\b[^>]*name=["']app-version["'][^>]*>/i)?.[0] || "";
  const metaVersion = metaTag.match(/\bcontent=["']([^"']+)["']/i)?.[1];
  const scriptVersion = text.match(/\bapp\.js\?v=(\d+)\b/i)?.[1];
  const version = Number(metaVersion || scriptVersion || 0);
  return Number.isFinite(version) ? version : 0;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
