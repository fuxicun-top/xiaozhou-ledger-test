-- 迁移：为既有 D1 数据库补齐账号体系（schema.sql 的新建库直接可用，此脚本用于线上旧库）
CREATE TABLE IF NOT EXISTS accounts (
  phone TEXT PRIMARY KEY,
  pin_hash TEXT NOT NULL,
  recovery_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_bindings (
  device_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bindings_phone ON device_bindings(phone);
CREATE TABLE IF NOT EXISTS account_keys (
  key TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_settings (
  account TEXT PRIMARY KEY,
  ai_base_url TEXT NOT NULL DEFAULT '',
  ai_api_key TEXT NOT NULL DEFAULT '',
  ai_model TEXT NOT NULL DEFAULT ''
);
ALTER TABLE events ADD COLUMN account TEXT NOT NULL DEFAULT '';
ALTER TABLE gifts ADD COLUMN account TEXT NOT NULL DEFAULT '';
ALTER TABLE feedback ADD COLUMN account TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_events_account ON events(account);
CREATE INDEX IF NOT EXISTS idx_gifts_account ON gifts(account);
-- 旧数据归属：有 device_id 的归到 dev:<device_id>（游客账号）
UPDATE events SET account = 'dev:' || device_id WHERE account = '' AND device_id <> '';
UPDATE gifts SET account = 'dev:' || device_id WHERE account = '' AND device_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_account_type_date ON events(account, type, date);
CREATE INDEX IF NOT EXISTS idx_gifts_account_date ON gifts(account, date);
