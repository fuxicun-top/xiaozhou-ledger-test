-- 人情录 Web 版 · 数据库安装脚本（Cloudflare D1 / SQLite）
-- 单一事实来源：本文件即"安装一次"的全部建表语句，全部幂等（IF NOT EXISTS），
-- 可重复执行。fork 部署时只需执行本文件一次；之后任何版本更新 Worker 也会自动补建缺表。
--
-- 身份模型：
--  - user:<phone>  手机号 + 密码 + JWT（主体系，users 表）
--  - phone:<phone> 旧 PIN 体系遗留（accounts 表，仅历史数据兼容，注册新账号时自动并入）
--  - dev:<token>   游客（匿名设备，devices / device_settings）
--
-- 说明：本文件与 src/db/schema.js 的 DDL 保持一致（Worker 运行期自愈用它建表）。
--       若手工改表，请同步两处。

CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 旧 PIN 体系遗留（accounts 表，phone: 作用域），仅用于历史数据兼容
CREATE TABLE IF NOT EXISTS accounts (
  phone TEXT PRIMARY KEY,
  pin_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 设备 ↔ 账号 绑定（游客设备被某账号"记住"后免重复登录；legacy）
CREATE TABLE IF NOT EXISTS device_bindings (
  device_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bindings_phone ON device_bindings(phone);

-- 小程序/第三方客户端接口密钥，归属手机号账号
CREATE TABLE IF NOT EXISTS account_keys (
  key TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 活动
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

-- 礼金
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

-- 意见反馈
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- 游客设备（legacy 匿名 guest 账号 dev:<device_id>）
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

-- 注册冷却记录（REGISTER_COOLDOWN_MINUTES 生效时按设备限频；未设该变量则表存在但不启用）
CREATE TABLE IF NOT EXISTS register_log (
  device_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- 全栈操作审计日志（Worker 在请求边界自动写入，记录所有用户/管理员的读写增删改查、配置、登录注册等）
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
CREATE INDEX IF NOT EXISTS idx_logs_actor ON logs(actor);

-- 管理员级运行参数（key/value）：log_retention_days（日志保留天数，默认 30）、last_log_purge_at（上次惰性清理时间，ISO）
CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
