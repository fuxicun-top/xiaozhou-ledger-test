/**
 * 数据库 schema 单一事实来源（全部 DDL 幂等：IF NOT EXISTS）。
 *
 * 用途：
 *  - 运行期兜底自愈（src/index.js）：请求遇到 D1 "no such table"（error code 1101）时，
 *    自动 ensureSchema(env.DB) 建好全部表并重试一次。全新 D1 首次访问即自动完成建表，
 *    fork 部署者无需进 Cloudflare 控制台手工建表；
 *  - 手工建表兜底：schema.sql 与本处保持一致（供控制台手动执行）。
 *
 * 说明：DDL 均为幂等，重复执行无副作用；旧库的列迁移逐条 try/catch 跳过已存在列。
 */

// 全新/旧库通用的全部表与索引（与 schema.sql 一致）
const DDL = [
  `CREATE TABLE IF NOT EXISTS accounts (
    phone TEXT PRIMARY KEY,
    pin_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS users (
    phone TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS device_bindings (
    device_id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bindings_phone ON device_bindings(phone)`,

  `CREATE TABLE IF NOT EXISTS account_keys (
    key TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    date TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_account ON events(account)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_account_type_date ON events(account, type, date)`,

  `CREATE TABLE IF NOT EXISTS gifts (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gifts_account ON gifts(account)`,
  `CREATE INDEX IF NOT EXISTS idx_gifts_account_date ON gifts(account, date)`,

  `CREATE TABLE IF NOT EXISTS account_settings (
    account TEXT PRIMARY KEY,
    ai_base_url TEXT NOT NULL DEFAULT '',
    ai_api_key TEXT NOT NULL DEFAULT '',
    ai_model TEXT NOT NULL DEFAULT ''
  )`,

  `CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS device_settings (
    device_id TEXT PRIMARY KEY,
    ai_base_url TEXT NOT NULL DEFAULT '',
    ai_api_key TEXT NOT NULL DEFAULT '',
    ai_model TEXT NOT NULL DEFAULT '',
    api_port INTEGER NOT NULL DEFAULT 0,
    api_key TEXT NOT NULL DEFAULT '',
    api_key_hash TEXT NOT NULL DEFAULT '',
    api_key_created_at TEXT NOT NULL DEFAULT ''
  )`,

  // 注册冷却记录（REGISTER_COOLDOWN_MINUTES 生效时用于按设备限频）
  `CREATE TABLE IF NOT EXISTS register_log (
    device_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  )`,

  // 全栈操作审计日志（记录所有用户/管理员的读写增删改查、配置、登录注册等）。
  // 由 Worker 在请求边界自动写入（best-effort，写失败不影响主流程）。
  // ua = 客户端 User-Agent（截断），便于区分人/脚本与事故取证。
  `CREATE TABLE IF NOT EXISTS logs (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_logs_actor ON logs(actor)`,

  // 管理员级运行参数（key/value）：log_retention_days（日志保留天数，默认 30）、last_log_purge_at（上次惰性清理时间）
  `CREATE TABLE IF NOT EXISTS admin_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

// 旧库升级（列已存在则报错，逐条跳过）
const LEGACY_MIGRATIONS = [
  `ALTER TABLE events ADD COLUMN account TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE gifts ADD COLUMN account TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE feedback ADD COLUMN account TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE logs ADD COLUMN ua TEXT NOT NULL DEFAULT ''`,
];

/**
 * 幂等地确保数据库结构完整。
 * D1 的 batch() 只接受 D1PreparedStatement（本地 miniflare 对字符串数组直接抛
 * ZodError），因此先把 DDL 全部 prepare 成语句对象再 batch，原子执行；
 * 旧库列迁移用 exec 逐条尝试（已存在则跳过）。
 */
export async function ensureSchema(db) {
  await db.batch(DDL.map((stmt) => db.prepare(stmt)));
  for (const stmt of LEGACY_MIGRATIONS) {
    try {
      await db.exec(stmt);
    } catch {
      /* 列已存在等错误：跳过 */
    }
  }
}

/** 数据库是否已具备核心表（用新体系 users 表探测；旧库无此表时为 false）。 */
export async function isDbReady(db) {
  try {
    await db.prepare('SELECT 1 FROM users LIMIT 1').run();
    return true;
  } catch {
    return false;
  }
}

/** 判断错误是否为"数据库缺表/缺结构"（D1 error code 1101，全新部署常见）。 */
export function isNoSchemaError(e) {
  if (!e) return false;
  if (String(e.code) === '1101') return true;
  return /no such table|no such index|1101/i.test(e.message || '');
}
