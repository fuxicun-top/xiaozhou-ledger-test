-- 人情录 Web 版数据库结构（Cloudflare D1 / SQLite）
-- 身份模型：手机号账号（phone + PIN），设备 token 与小程序密钥都绑定到手机号；
-- 未登录的设备使用匿名 guest 账号（dev:<device_id>）。

CREATE TABLE IF NOT EXISTS accounts (
  phone TEXT PRIMARY KEY,
  pin_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_bindings (
  device_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bindings_phone ON device_bindings(phone);

-- 小程序/客户端接口密钥，归属手机号账号
CREATE TABLE IF NOT EXISTS account_keys (
  key TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_account ON events(account);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_account_type_date ON events(account, type, date);

CREATE TABLE IF NOT EXISTS gifts (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT '',
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
CREATE INDEX IF NOT EXISTS idx_gifts_account ON gifts(account);
CREATE INDEX IF NOT EXISTS idx_gifts_account_date ON gifts(account, date);

-- AI 模型配置（按账号共享，登录后多设备一致）
CREATE TABLE IF NOT EXISTS account_settings (
  account TEXT PRIMARY KEY,
  ai_base_url TEXT NOT NULL DEFAULT '',
  ai_api_key TEXT NOT NULL DEFAULT '',
  ai_model TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- 遗留表（仅用于旧数据兼容）
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_settings (
  device_id TEXT PRIMARY KEY,
  ai_base_url TEXT NOT NULL DEFAULT '',
  ai_api_key TEXT NOT NULL DEFAULT '',
  ai_model TEXT NOT NULL DEFAULT '',
  api_port INTEGER NOT NULL DEFAULT 0,
  api_key TEXT NOT NULL DEFAULT '',
  api_key_hash TEXT NOT NULL DEFAULT '',
  api_key_created_at TEXT NOT NULL DEFAULT ''
);
