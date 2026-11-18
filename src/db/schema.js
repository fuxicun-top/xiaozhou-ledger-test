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
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'suggestion',
    status TEXT NOT NULL DEFAULT 'new',
    source TEXT NOT NULL DEFAULT 'web',
    ref_phone TEXT NOT NULL DEFAULT ''
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
  // 反馈闭环：区分类型（建议/密码重置申请）、处理状态、来源（web/miniapp）、重置申请携带的手机号与新密码
  `ALTER TABLE feedback ADD COLUMN kind TEXT NOT NULL DEFAULT 'suggestion'`,
  `ALTER TABLE feedback ADD COLUMN status TEXT NOT NULL DEFAULT 'new'`,
  `ALTER TABLE feedback ADD COLUMN source TEXT NOT NULL DEFAULT 'web'`,
  `ALTER TABLE feedback ADD COLUMN ref_phone TEXT NOT NULL DEFAULT ''`,
];

/**
 * 幂等地确保数据库结构完整。
 * D1 的 batch() 只接受 D1PreparedStatement（本地 miniflare 对字符串数组直接抛
 * ZodError），因此先把 DDL 全部 prepare 成语句对象再 batch，原子执行；
 * 旧库列迁移逐条 prepare().run() 尝试（列已存在会报错，跳过即可）。
 *
 * 注意：早期用 db.exec() 执行 ALTER，在部分 D1 运行时上静默失败（不抛错也不补列），
 * 被空 catch 吞掉后导致旧库列永远补不上、写入一直报 no such column（500）。
 * 改用 prepare().run() 是 D1 官方推荐且行为一致的方式。
 */
export async function ensureSchema(db) {
  await db.batch(DDL.map((stmt) => db.prepare(stmt)));
  for (const stmt of LEGACY_MIGRATIONS) {
    try {
      await db.prepare(stmt).run();
    } catch {
      /* 列已存在等错误：跳过 */
    }
  }
  await repairLegacyFeedback(db);
}

/**
 * 修复远古库遗留的 feedback 旧结构：早期版本曾用 device_id TEXT NOT NULL（无默认值），
 * 而当前代码 INSERT 不带该列 → "NOT NULL constraint failed: feedback.device_id" → 500。
 * 检测到该列存在时，重建为当前结构并迁移可识别字段（正常库不含此列，零影响）。
 */
async function repairLegacyFeedback(db) {
  try {
    const info = await db.prepare('PRAGMA table_info(feedback)').all();
    const cols = (info.results || []).map((r) => r.name);
    if (!cols.includes('device_id')) return;
    // 仅保留目标结构存在的列；数据为空/极少，重建安全
    const keep = ['id', 'account', 'content', 'contact', 'created_at', 'kind', 'status', 'source', 'ref_phone'].filter((c) => cols.includes(c));
    const colList = keep.join(', ');
    const feedbackDDL = DDL.find((s) => /CREATE TABLE IF NOT EXISTS feedback \(/i.test(s));
    await db.prepare('ALTER TABLE feedback RENAME TO feedback_legacy').run();
    await db.prepare(feedbackDDL.trim()).run();
    if (colList) {
      await db.prepare(`INSERT INTO feedback (${colList}) SELECT ${colList} FROM feedback_legacy`).run();
    }
    await db.prepare('DROP TABLE feedback_legacy').run();
  } catch {
    /* 探测/重建失败不阻断：正常库不会走到这里 */
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

/** 判断错误是否为"数据库缺表/缺列/缺索引"（触发 ensureSchema 自愈重建/补列）。
 *  兼容两种报错文案：原生 SQLite 的 "no such column"，以及 D1 运行时的
 *  "table xxx has no column named yyy"。后者曾是旧库缺列不自愈、写入一直 500 的根因。 */
export function isNoSchemaError(e) {
  if (!e) return false;
  if (String(e.code) === '1101') return true;
  return /no such table|no such index|no such column|has no column named|1101/i.test(e.message || '');
}
