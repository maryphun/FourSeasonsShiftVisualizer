CREATE TABLE IF NOT EXISTS reminder_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reminder_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  expiration_time INTEGER,
  timezone TEXT NOT NULL,
  notification_enabled INTEGER NOT NULL DEFAULT 1,
  reminder_time TEXT NOT NULL DEFAULT '00:00',
  reminder_slot TEXT NOT NULL DEFAULT '0000',
  next_due_at TEXT,
  next_due_date_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reminder_subscriptions_due
ON reminder_subscriptions (notification_enabled, next_due_at);

CREATE INDEX IF NOT EXISTS idx_reminder_subscriptions_client
ON reminder_subscriptions (client_id);

CREATE TABLE IF NOT EXISTS reminder_events (
  client_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  event_text TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (client_id, date_key)
);

CREATE INDEX IF NOT EXISTS idx_reminder_events_client_date
ON reminder_events (client_id, date_key);
