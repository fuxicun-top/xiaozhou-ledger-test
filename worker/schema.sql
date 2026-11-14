-- 人情录 Web 版数据库结构（Cloudflare D1 / SQLite）
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_device_type_date ON events(device_id, type, date);

CREATE TABLE IF NOT EXISTS gifts (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  person TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL,
  amount_fen INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash',
  date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gifts_device ON gifts(device_id);
CREATE INDEX IF NOT EXISTS idx_gifts_device_date ON gifts(device_id, date);

CREATE TABLE IF NOT EXISTS device_settings (
  device_id TEXT PRIMARY KEY,
  ai_base_url TEXT NOT NULL DEFAULT '',
  ai_api_key TEXT NOT NULL DEFAULT '',
  ai_model TEXT NOT NULL DEFAULT '',
  api_port INTEGER NOT NULL DEFAULT 0,
  api_key_hash TEXT NOT NULL DEFAULT '',
  api_key_created_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  content TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
