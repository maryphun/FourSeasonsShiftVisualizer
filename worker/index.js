const MAX_BODY_BYTES = 14 * 1024 * 1024;
const DEFAULT_TIMEZONE = "Asia/Tokyo";
const DEFAULT_VAPID_SUBJECT = "https://shift-visualize-ocr.otopo.workers.dev";
const DEFAULT_REMINDER_TIME = "00:00";
const REMINDER_SLOT_MINUTES = 15;
const REMINDER_DUE_GRACE_MS = 20 * 60 * 1000;
const REMINDER_LOOKAHEAD_LIMIT = 370;
const REMINDER_QUERY_LIMIT = 100;
const REMINDER_VAPID_KEY = "reminder:vapid";

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
        reminders: Boolean(env.REMINDER_DB),
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
  const db = getReminderDb(env);
  if (!db) {
    return jsonResponse({
      enabled: false,
      publicKey: "",
      reason: "Daily alerts need the Cloudflare D1 reminder database.",
    });
  }

  const keys = await getOrCreateVapidKeys(db);
  return jsonResponse({
    enabled: true,
    publicKey: keys.publicKey,
    slotMinutes: REMINDER_SLOT_MINUTES,
  });
}

async function handleReminderEvents(request, env) {
  const db = getReminderDb(env);
  if (!db) return reminderStoreMissingResponse();

  const body = await readJsonBody(request);
  const clientId = normalizeClientId(body.clientId);
  if (!clientId) return jsonResponse({ error: "Missing reminder client." }, 400);

  const events = normalizeReminderEvents(body.events);
  const updatedAt = new Date().toISOString();
  const statements = [db.prepare("DELETE FROM reminder_events WHERE client_id = ?").bind(clientId)];

  for (const [dateKey, eventText] of Object.entries(events)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO reminder_events (client_id, date_key, event_text, updated_at)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(client_id, date_key) DO UPDATE SET
             event_text = excluded.event_text,
             updated_at = excluded.updated_at`,
        )
        .bind(clientId, dateKey, eventText, updatedAt),
    );
  }

  await db.batch(statements);
  await refreshClientDueReminders(db, clientId, new Date(updatedAt));
  return jsonResponse({
    ok: true,
    eventCount: Object.keys(events).length,
  });
}

async function handleReminderSubscribe(request, env) {
  const db = getReminderDb(env);
  if (!db) return reminderStoreMissingResponse();

  const body = await readJsonBody(request);
  const clientId = normalizeClientId(body.clientId);
  const subscription = normalizePushSubscription(body.subscription);
  if (!clientId) return jsonResponse({ error: "Missing reminder client." }, 400);
  if (!subscription) return jsonResponse({ error: "Missing push subscription." }, 400);

  const subscriptionId = await hashText(subscription.endpoint);
  const timezone = normalizeTimezone(body.timezone);
  const notificationEnabled = normalizeReminderEnabled(body.notificationEnabled);
  const reminderTime = normalizeReminderTime(body.reminderTime);
  const reminderSlot = reminderTimeToSlot(reminderTime);
  const updatedAt = new Date().toISOString();
  const nextDue = await nextDueReminderForClient(
    db,
    clientId,
    {
      notificationEnabled,
      timezone,
      reminderTime,
    },
    new Date(updatedAt),
  );

  await db
    .prepare(
      `INSERT INTO reminder_subscriptions (
         subscription_id,
         client_id,
         endpoint,
         p256dh,
         auth,
         expiration_time,
         timezone,
         notification_enabled,
         reminder_time,
         reminder_slot,
         next_due_at,
         next_due_date_key,
         created_at,
         updated_at
       )
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
       ON CONFLICT(subscription_id) DO UPDATE SET
         client_id = excluded.client_id,
         endpoint = excluded.endpoint,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         expiration_time = excluded.expiration_time,
         timezone = excluded.timezone,
         notification_enabled = excluded.notification_enabled,
         reminder_time = excluded.reminder_time,
         reminder_slot = excluded.reminder_slot,
         next_due_at = excluded.next_due_at,
         next_due_date_key = excluded.next_due_date_key,
         updated_at = excluded.updated_at`,
    )
    .bind(
      subscriptionId,
      clientId,
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      subscription.expirationTime,
      timezone,
      notificationEnabled ? 1 : 0,
      reminderTime,
      reminderSlot,
      nextDue?.dueAt || null,
      nextDue?.dateKey || null,
      updatedAt,
    )
    .run();

  return jsonResponse({
    ok: true,
  });
}

async function handleTodayReminder(request, env) {
  const db = getReminderDb(env);
  if (!db) return jsonResponse({ dateKey: "", events: [] });

  const body = await readJsonBody(request);
  const endpoint = String(body.endpoint || "").trim();
  if (!endpoint) return jsonResponse({ dateKey: "", events: [] });

  const subscriptionId = await hashText(endpoint);
  const subscription = await db
    .prepare("SELECT client_id, timezone FROM reminder_subscriptions WHERE subscription_id = ?")
    .bind(subscriptionId)
    .first();
  if (!subscription?.client_id) return jsonResponse({ dateKey: "", events: [] });

  const timezone = normalizeTimezone(subscription.timezone);
  const today = datePartsInTimezone(new Date(), timezone);
  const event = await db
    .prepare("SELECT event_text FROM reminder_events WHERE client_id = ? AND date_key = ?")
    .bind(subscription.client_id, today.dateKey)
    .first();
  const eventText = normalizeReminderText(event?.eventText || event?.event_text);

  return jsonResponse({
    dateKey: today.dateKey,
    events: eventText ? [{ text: eventText }] : [],
  });
}

async function sendDueEventReminders(env, now = new Date()) {
  const db = getReminderDb(env);
  if (!db) return;

  const vapidKeys = await getOrCreateVapidKeys(db);
  const dueRows = await db
    .prepare(
      `SELECT
         s.subscription_id,
         s.client_id,
         s.endpoint,
         s.p256dh,
         s.auth,
         s.expiration_time,
         s.timezone,
         s.notification_enabled,
         s.reminder_time,
         s.next_due_at,
         s.next_due_date_key,
         e.event_text
       FROM reminder_subscriptions s
       JOIN reminder_events e
         ON e.client_id = s.client_id
        AND e.date_key = s.next_due_date_key
       WHERE s.notification_enabled = 1
         AND s.next_due_at IS NOT NULL
         AND s.next_due_at <= ?1
         AND s.next_due_at > ?2
       ORDER BY s.next_due_at ASC
       LIMIT ?3`,
    )
    .bind(now.toISOString(), new Date(now.getTime() - REMINDER_DUE_GRACE_MS).toISOString(), REMINDER_QUERY_LIMIT)
    .all();

  await Promise.all(
    (dueRows.results || []).map((row) => sendDueEventReminder(db, vapidKeys, env, row, now)),
  );
}

async function sendDueEventReminder(db, vapidKeys, env, row, now) {
  try {
    if (!row?.endpoint || !row.client_id) {
      if (row?.subscription_id) await deleteReminderSubscription(db, row.subscription_id);
      return;
    }

    const eventText = normalizeReminderText(row.event_text);
    if (!eventText) {
      await updateSubscriptionNextDue(db, row, new Date(now.getTime() + 60000));
      return;
    }

    const result = await sendWebPush(
      {
        endpoint: row.endpoint,
        expirationTime: row.expiration_time || null,
        keys: {
          p256dh: row.p256dh,
          auth: row.auth,
        },
      },
      {
        keys: vapidKeys,
        subject: env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT,
      },
    );

    if (result.expired) {
      await deleteReminderSubscription(db, row.subscription_id);
      return;
    }

    if (result.ok) {
      await updateSubscriptionNextDue(db, row, new Date(now.getTime() + 60000));
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

function getReminderDb(env) {
  return env.REMINDER_DB || null;
}

function reminderStoreMissingResponse() {
  return jsonResponse({ error: "Daily alerts need the Cloudflare D1 reminder database." }, 503);
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
  if (value === false || value === 0) return false;
  if (value === true || value === 1) return true;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return true;
  return !["false", "0", "off", "no"].includes(text);
}

function normalizeReminderTime(value) {
  const text = String(value || DEFAULT_REMINDER_TIME).trim();
  const match = text.match(/^(\d{1,2}):([0-5]\d)$/);
  if (!match) return DEFAULT_REMINDER_TIME;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return DEFAULT_REMINDER_TIME;

  const rounded = roundReminderTime(hour, minute);
  return `${rounded.hour}:${rounded.minute}`;
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

  const p256dh = String(value.keys?.p256dh || "");
  const auth = String(value.keys?.auth || "");
  if (!p256dh || !auth) return null;

  return {
    endpoint,
    expirationTime: value.expirationTime || null,
    keys: {
      p256dh,
      auth,
    },
  };
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

async function getOrCreateVapidKeys(db) {
  const existingRow = await db
    .prepare("SELECT value FROM reminder_settings WHERE key = ?")
    .bind(REMINDER_VAPID_KEY)
    .first();
  const existing = parseJson(existingRow?.value);
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

  await db
    .prepare(
      `INSERT INTO reminder_settings (key, value, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO NOTHING`,
    )
    .bind(REMINDER_VAPID_KEY, JSON.stringify(keys), keys.createdAt)
    .run();

  const savedRow = await db
    .prepare("SELECT value FROM reminder_settings WHERE key = ?")
    .bind(REMINDER_VAPID_KEY)
    .first();
  const saved = parseJson(savedRow?.value);
  return isValidVapidKeys(saved) ? saved : keys;
}

async function refreshClientDueReminders(db, clientId, now) {
  const [eventRows, subscriptionRows] = await Promise.all([
    reminderEventRows(db, clientId),
    db
      .prepare(
        `SELECT subscription_id, timezone, notification_enabled, reminder_time
         FROM reminder_subscriptions
         WHERE client_id = ?`,
      )
      .bind(clientId)
      .all(),
  ]);

  const updatedAt = now.toISOString();
  const statements = (subscriptionRows.results || []).map((subscription) => {
    const nextDue = nextDueReminderFromRows(eventRows, subscription, now);
    return db
      .prepare(
        `UPDATE reminder_subscriptions
         SET next_due_at = ?1,
             next_due_date_key = ?2,
             updated_at = ?3
         WHERE subscription_id = ?4`,
      )
      .bind(nextDue?.dueAt || null, nextDue?.dateKey || null, updatedAt, subscription.subscription_id);
  });

  if (statements.length) await db.batch(statements);
}

async function updateSubscriptionNextDue(db, row, after) {
  const nextDue = await nextDueReminderForClient(
    db,
    row.client_id,
    {
      notificationEnabled: Number(row.notification_enabled) === 1,
      timezone: row.timezone,
      reminderTime: row.reminder_time,
    },
    after,
  );

  await db
    .prepare(
      `UPDATE reminder_subscriptions
       SET next_due_at = ?1,
           next_due_date_key = ?2,
           updated_at = ?3
       WHERE subscription_id = ?4`,
    )
    .bind(nextDue?.dueAt || null, nextDue?.dateKey || null, new Date().toISOString(), row.subscription_id)
    .run();
}

async function deleteReminderSubscription(db, subscriptionId) {
  await db.prepare("DELETE FROM reminder_subscriptions WHERE subscription_id = ?").bind(subscriptionId).run();
}

async function nextDueReminderForClient(db, clientId, options, after) {
  const eventRows = await reminderEventRows(db, clientId);
  return nextDueReminderFromRows(eventRows, options, after);
}

async function reminderEventRows(db, clientId) {
  const rows = await db
    .prepare(
      `SELECT date_key
       FROM reminder_events
       WHERE client_id = ?
       ORDER BY date_key ASC
       LIMIT ?`,
    )
    .bind(clientId, REMINDER_LOOKAHEAD_LIMIT)
    .all();

  return rows.results || [];
}

function nextDueReminderFromRows(rows, options, after) {
  if (!normalizeReminderEnabled(options.notificationEnabled)) return null;

  const timezone = normalizeTimezone(options.timezone);
  const reminderTime = normalizeReminderTime(options.reminderTime);
  const afterTime = after instanceof Date ? after : new Date(after);

  for (const row of rows) {
    const dateKey = String(row.date_key || row.dateKey || "").trim();
    const dueAt = zonedDateTimeToUtc(dateKey, reminderTime, timezone);
    if (dueAt && dueAt.getTime() > afterTime.getTime()) {
      return {
        dateKey,
        dueAt: dueAt.toISOString(),
      };
    }
  }

  return null;
}

function zonedDateTimeToUtc(dateKey, reminderTime, timezone) {
  const dateMatch = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = normalizeReminderTime(reminderTime).match(/^(\d{2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;

  const targetLocalMs = Date.UTC(year, month - 1, day, hour, minute);
  let utc = new Date(targetLocalMs);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = datePartsInTimezone(utc, timezone);
    const [actualYear, actualMonth, actualDay] = parts.dateKey.split("-").map(Number);
    const actualLocalMs = Date.UTC(
      actualYear,
      actualMonth - 1,
      actualDay,
      Number(parts.hour),
      Number(parts.minute),
    );
    const diff = targetLocalMs - actualLocalMs;
    if (Math.abs(diff) < 1000) return utc;
    utc = new Date(utc.getTime() + diff);
  }

  return utc;
}

function reminderTimeToSlot(reminderTime) {
  return normalizeReminderTime(reminderTime).replace(":", "");
}

function roundReminderTime(hour, minute) {
  const totalMinutes = Number(hour) * 60 + Number(minute);
  const roundedMinutes = Math.round(totalMinutes / REMINDER_SLOT_MINUTES) * REMINDER_SLOT_MINUTES;
  const normalizedMinutes = ((roundedMinutes % 1440) + 1440) % 1440;

  return {
    hour: String(Math.floor(normalizedMinutes / 60)).padStart(2, "0"),
    minute: String(normalizedMinutes % 60).padStart(2, "0"),
  };
}

function parseJson(value) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return null;
  }
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
