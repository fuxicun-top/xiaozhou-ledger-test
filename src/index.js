import { ensureSchema, isDbReady, isNoSchemaError } from './db/schema.js';

/**
 * 人情录 Web 版后端 —— Cloudflare Worker + D1
 *
 * 身份模型（跨设备一致）：
 *  - 手机号账号：X-Ledger-Phone 头（可选 X-Ledger-Pin），数据按手机号隔离；
 *  - 小程序/第三方客户端：X-Api-Key / X-Token / Bearer（account_keys 或遗留 device_settings）；
 *  - 游客：仅 X-Ledger-Token（localStorage 匿名设备），数据归属 dev:<token>，
 *    注册手机号后可一键并入账号（importDevice）。
 */

const EVENT_TYPES = new Set([
  'wedding',
  'baby',
  'birthday',
  'housewarming',
  'graduation',
  'funeral',
  'other',
]);

const EVENT_LABELS = {
  wedding: '婚礼',
  baby: '满月',
  birthday: '生日',
  housewarming: '乔迁',
  graduation: '升学',
  funeral: '白事',
  other: '其他',
};

const METHOD_LABELS = {
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝',
  other: '其他',
};

const RELATIONS = new Set(['朋友', '亲戚', '同事', '同学', '邻居', '其他']);
const METHODS = new Set(['cash', 'wechat', 'alipay', 'other']);

/* 跨域策略：默认反射请求方 Origin。
 * 本 API 的认证全部基于自定义请求头/令牌（X-Ledger-Phone/Pin、X-Api-Key、X-Ledger-Token），
 * 不使用 Cookie 会话，反射 Origin 不会扩大跨站写入面——写操作仍需调用方自己的凭据。
 * 这样任何部署者把本仓库部署到自有 Cloudflare + D1 时无需改代码即可跨域调用。
 * 部署方若希望收紧，可把下方 corsHeaders 改回固定白名单并填入自有域名。 */

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type,X-Ledger-Token,X-Ledger-Phone,X-Ledger-Pin,X-Api-Key,X-Token,Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function jsonRes(data, status = 200, origin = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}

function fail(message, status = 400, origin = null) {
  return jsonRes({ error: message }, status, origin);
}

function nowIso() {
  return new Date().toISOString();
}

/* 业务日期按东八区（+08:00）计算：凌晨 0-8 点 UTC 仍是中国的"今天"，
 * 直接用 UTC 会让 AI 解析默认日期、年度统计的"今年"差一天/差一年。 */
const CN_TZ_OFFSET_MIN = 8 * 60;

function cnDate() {
  return new Date(Date.now() + CN_TZ_OFFSET_MIN * 60000).toISOString();
}

function todayStr() {
  return cnDate().slice(0, 10);
}

function thisYear() {
  return cnDate().slice(0, 4);
}

function asString(value, max = 500) {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, max);
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getDeviceId(request) {
  const token = (request.headers.get('X-Ledger-Token') || '').trim();
  return /^[A-Za-z0-9_-]{16,64}$/.test(token) ? token : null;
}

function getApiKeyHeader(request) {
  const direct = (request.headers.get('X-Api-Key') || request.headers.get('X-Token') || '').trim();
  if (direct) return direct;
  const auth = (request.headers.get('Authorization') || '').trim();
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : '';
}

function maskPhone(phone) {
  if (!phone || phone.length < 7) return phone || '';
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/** D1/SQLite 唯一约束冲突（用于并发竞态兜底：SELECT-then-INSERT 窗口内撞唯一索引）。 */
function isUniqueError(e) {
  return Boolean(e && /unique constraint failed/i.test(String(e.message || '')));
}

/* ------------------------------------------------------------------ */
/* PIN 哈希                                                            */
/* ------------------------------------------------------------------ */

async function hmacSha256Hex(keyText, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyText),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 迭代 HMAC 派生 PIN 哈希（盐 + 1000 轮）。 */
async function hashPin(pin, salt) {
  let h = await hmacSha256Hex(pin, `${salt}:init`);
  for (let i = 0; i < 1000; i++) {
    h = await hmacSha256Hex(pin, `${salt}:${i}`);
  }
  return h;
}

/* ------------------------------------------------------------------ */
/* 密码哈希 / JWT（Web 账号体系：手机号 + 密码）                        */
/* ------------------------------------------------------------------ */

/** 密码哈希：盐 + 迭代 HMAC（与 PIN 同一套原语，2000 轮）。 */
async function hashPassword(password, salt) {
  let h = await hmacSha256Hex(password, `${salt}:init`);
  for (let i = 0; i < 2000; i++) {
    h = await hmacSha256Hex(password, `${salt}:${i}`);
  }
  return h;
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(obj) {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function jwtSign(payload, secret) {
  const enc = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const head = `${enc}.${b64urlJson(payload)}`;
  const sig = b64url(
    new Uint8Array(await hmacSha256Raw(secret, head))
  );
  return `${head}.${sig}`;
}

async function jwtVerify(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = b64url(new Uint8Array(await hmacSha256Raw(secret, `${parts[0]}.${parts[1]}`)));
  if (expected !== parts[2]) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    ));
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

async function hmacSha256Raw(keyText, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyText),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
}

/** 取 Worker 的 JWT 密钥：Secret JWT_SECRET 优先，未设置时回退到内置默认值（部署者可在控制台设置自己的）。 */
let jwtSecretWarned = false;
function jwtSecret(env) {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  if (!jwtSecretWarned) {
    jwtSecretWarned = true;
    console.warn(
      '[security] JWT_SECRET 未设置，正在使用内置默认密钥，公网部署存在 token 伪造风险；请执行 wrangler secret put JWT_SECRET'
    );
  }
  return 'xiaozhou-ledger-web-default-jwt-secret';
}

const JWT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 天


/* ------------------------------------------------------------------ */
/* 身份解析                                                            */
/* ------------------------------------------------------------------ */

async function resolveIdentity(request, env) {
  const deviceId = getDeviceId(request);

  let account = null;
  let viaKey = false;

  // ① Web 账号 JWT（Authorization: Bearer 或 X-Ledger-Auth）：校验签名与有效期
  const authHeader = (request.headers.get('Authorization') || '').trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(authHeader);
  const jwt = (bearer ? bearer[1] : (request.headers.get('X-Ledger-Auth') || '').trim());
  if (jwt) {
    const payload = await jwtVerify(jwt, jwtSecret(env));
    if (payload && validPhone(payload.phone)) {
      return {
        deviceId,
        phone: payload.phone,
        name: payload.name || null,
        account: `user:${payload.phone}`,
        viaKey: false,
        isPhone: true,
        viaJwt: true,
      };
    }
    // JWT 无效：若是 Bearer 携带，再给它一次机会按旧接口密钥处理；都不行则拒绝（不降级游客）
    if (bearer) {
      account = await legacyKeyAccount(request, env, bearer[1]);
      if (account) viaKey = true;
    }
    if (!account) {
      return { deviceId, phone: null, account: null, viaKey: false, isPhone: false, jwtInvalid: true };
    }
  }

  // ② 旧 PIN 体系（X-Ledger-Phone + PIN）：遗留数据兼容，数据存 phone:<phone>
  const phoneRaw = (request.headers.get('X-Ledger-Phone') || '').trim();
  const phone = /^\d{5,20}$/.test(phoneRaw) ? phoneRaw : null;
  if (!account && phone) {
    const exists = await env.DB.prepare('SELECT 1 AS x FROM accounts WHERE phone = ?')
      .bind(phone)
      .first();
    account = exists ? `phone:${phone}` : null;
  }

  // ③ 小程序/客户端接口密钥（X-Api-Key / X-Token）
  if (!account) {
    const apiKey = getApiKeyHeader(request);
    if (apiKey) {
      account = await legacyKeyAccount(request, env, apiKey);
      if (account) viaKey = true;
    }
  }

  // ④ 游客设备：dev:<deviceId>
  if (!account && deviceId) {
    account = `dev:${deviceId}`;
  }

  return {
    deviceId,
    phone: accountPhone(account) || phone,
    account,
    viaKey,
    isPhone: Boolean(account && account.startsWith('user:')),
  };
}

/** 旧接口密钥 → 账号（user:<phone> / dev:<deviceId>）；无效返回 null。 */
async function legacyKeyAccount(request, env, apiKey) {
  const row1 = await env.DB.prepare('SELECT phone FROM account_keys WHERE key = ?')
    .bind(apiKey)
    .first();
  if (row1) return `user:${row1.phone}`;
  const row2 = await env.DB.prepare('SELECT device_id FROM device_settings WHERE api_key = ?')
    .bind(apiKey)
    .first();
  if (row2 && row2.device_id) {
    const b = await env.DB.prepare('SELECT phone FROM device_bindings WHERE device_id = ?')
      .bind(row2.device_id)
      .first();
    return b ? `user:${b.phone}` : `dev:${row2.device_id}`;
  }
  return null;
}

async function ensureIdentity(env, identity) {
  const { deviceId, account } = identity;
  if (account && (account.startsWith('user:') || account.startsWith('phone:'))) {
    await env.DB.prepare('INSERT OR IGNORE INTO account_settings (account) VALUES (?)')
      .bind(account)
      .run();
  } else if (account && account.startsWith('dev:') && deviceId) {
    await env.DB.prepare('INSERT OR IGNORE INTO devices (id, created_at) VALUES (?, ?)')
      .bind(deviceId, nowIso())
      .run();
    await env.DB.prepare('INSERT OR IGNORE INTO device_settings (device_id) VALUES (?)')
      .bind(deviceId)
      .run();
  }
}

function requireIdentity(identity) {
  if (!identity.account) {
    return {
      error: fail('未登录或接口密钥无效', 401),
    };
  }
  return { identity };
}

/** 数据作用域：按 account 查；游客账号为 dev:<deviceId>。 */
function accOf(identity) {
  return identity.account;
}

/** 账号手机号：user:<phone>（新体系）或 phone:<phone>（旧 PIN 体系遗留数据）。 */
function accountPhone(account) {
  if (!account) return null;
  // 注意前缀长度：'user:' 为 5，'phone:' 为 6，必须分别取值，
  // 否则 user: 账号的手机号会被截断首位（历史 P0 缺陷）。
  if (account.startsWith('user:')) return account.slice(5);
  if (account.startsWith('phone:')) return account.slice(6);
  return null;
}

/** 游客设备号：dev:<deviceId>。 */
function accountDevice(account) {
  if (account && account.startsWith('dev:')) return account.slice(4);
  return null;
}

/* ------------------------------------------------------------------ */
/* 账号：注册 / 登录（手机号 + 密码，JWT）/ 管理员操作                  */
/* ------------------------------------------------------------------ */

function validPhone(phone) {
  return /^\d{5,20}$/.test(phone);
}

// 登录防爆破（内存级，Worker 实例内有效；重启即清空，属临时缓解而非持久化封禁）：
// 同一手机号 10 分钟失败 20 次 → 封禁 5 分钟。
const loginFailures = new Map(); // phone -> { n, first, blockedUntil }
const LOGIN_MAX_FAILS = 20;
const LOGIN_FAIL_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BLOCK_MS = 5 * 60 * 1000;

function loginLocked(phone) {
  const rec = loginFailures.get(phone);
  if (!rec) return false;
  const now = Date.now();
  if (rec.blockedUntil && now < rec.blockedUntil) return true;
  if (now - rec.first > LOGIN_FAIL_WINDOW_MS) {
    loginFailures.delete(phone);
    return false;
  }
  return false;
}

function recordLoginFail(phone) {
  const now = Date.now();
  let rec = loginFailures.get(phone);
  if (!rec || now - rec.first > LOGIN_FAIL_WINDOW_MS) {
    rec = { n: 0, first: now, blockedUntil: 0 };
  }
  rec.n += 1;
  if (rec.n >= LOGIN_MAX_FAILS) rec.blockedUntil = now + LOGIN_BLOCK_MS;
  loginFailures.set(phone, rec);
  if (loginFailures.size > 500) {
    const oldest = [...loginFailures.entries()].sort((a, b) => a[1].first - b[1].first)[0];
    if (oldest) loginFailures.delete(oldest[0]);
  }
}

function clearLoginFails(phone) {
  loginFailures.delete(phone);
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 32;
}

/** 旧 PIN 体系校验（仅用于 phone: 遗留账号访问；新体系用 JWT）。 */
async function verifyPin(env, phone, pin) {
  if (!pin) return false;
  const acc = await env.DB.prepare('SELECT pin_hash FROM accounts WHERE phone = ?')
    .bind(phone)
    .first();
  if (!acc) return false;
  const [salt, hash] = String(acc.pin_hash).split('|');
  const computed = await hashPin(pin, salt);
  return computed === hash;
}

// 把「某手机号名下」的全部数据并入目标账号（游客 / 旧 PIN 账号 / 新用户）
async function importAccountData(env, fromAccounts, toAccount) {
  let importedEvents = 0;
  let importedGifts = 0;
  for (const from of fromAccounts) {
    const e = await env.DB.prepare('UPDATE events SET account = ? WHERE account = ?')
      .bind(toAccount, from)
      .run();
    const g = await env.DB.prepare('UPDATE gifts SET account = ? WHERE account = ?')
      .bind(toAccount, from)
      .run();
    importedEvents += (e.meta && e.meta.changes) || 0;
    importedGifts += (g.meta && g.meta.changes) || 0;
  }
  return { importedEvents, importedGifts };
}

async function handleAccountRegister(request, env, identity, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = asString(body.phone, 20).trim();
  const name = asString(body.name, 32).trim() || '账本用户';
  const password = asString(body.password, 64);
  if (!validPhone(phone)) return fail('请输入正确的手机号', 400, origin);
  if (!validPassword(password)) return fail('密码需为 8-32 位', 400, origin);

  // 部署者限制（Cloudflare 控制台 Variables 配置，未设置 = 不限制）：
  //  - MAX_ACCOUNTS：本实例可注册账号总数上限，保护免费配额不被刷满；
  //  - REGISTER_COOLDOWN_MINUTES：同一设备两次注册的最小间隔（分钟）。
  const cooldownMin = Number.parseInt(asString(env.REGISTER_COOLDOWN_MINUTES, 10), 10);
  if (Number.isFinite(cooldownMin) && cooldownMin > 0 && identity.deviceId) {
    let last = null;
    try {
      last = await env.DB.prepare('SELECT created_at FROM register_log WHERE device_id = ?')
        .bind(identity.deviceId)
        .first();
    } catch {
      last = null; // register_log 表未建（极旧库）时跳过冷却检查，自愈会补建
    }
    if (last && last.created_at) {
      const elapsedMin = (Date.now() - Date.parse(last.created_at)) / 60000;
      const remainMin = Math.ceil(cooldownMin - elapsedMin);
      if (remainMin > 0) {
        return fail(`本设备注册过于频繁，请 ${remainMin} 分钟后再试`, 429, origin);
      }
    }
  }

  const maxAccounts = Number.parseInt(asString(env.MAX_ACCOUNTS, 10), 10);
  if (Number.isFinite(maxAccounts) && maxAccounts > 0) {
    const countRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    const used = (countRow && Number(countRow.n)) || 0;
    if (used >= maxAccounts) {
      return fail(`本实例注册名额已满（${used}/${maxAccounts}），请联系管理员或部署自己的实例`, 403, origin);
    }
  }

  const userAccount = `user:${phone}`;
  const exists = await env.DB.prepare('SELECT 1 AS x FROM users WHERE phone = ?')
    .bind(phone)
    .first();
  if (exists) return fail('该手机号已注册，请直接登录', 409, origin);

  const salt = crypto.randomUUID();
  const passwordHash = `${salt}|${await hashPassword(password, salt)}`;
  try {
    await env.DB.prepare('INSERT INTO users (phone, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .bind(phone, name, passwordHash, nowIso())
      .run();
  } catch (e) {
    // 并发竞态：两个请求同时通过"该手机号已注册"检查，撞 users 主键。
    if (isUniqueError(e)) return fail('该手机号已注册，请直接登录', 409, origin);
    throw e;
  }
  await env.DB.prepare('INSERT OR IGNORE INTO account_settings (account) VALUES (?)')
    .bind(userAccount)
    .run();
  // 记录本次注册（供 REGISTER_COOLDOWN_MINUTES 冷却判断；表缺失/失败不影响注册主流程）
  if (identity.deviceId) {
    try {
      await env.DB.prepare(
        `INSERT INTO register_log (device_id, created_at) VALUES (?, ?)
         ON CONFLICT(device_id) DO UPDATE SET created_at = excluded.created_at`
      )
        .bind(identity.deviceId, nowIso())
        .run();
    } catch {
      /* register_log 表未建（极旧库）时忽略，运行期自愈会补建 */
    }
  }

  // 首次注册：把 ① 本浏览器游客数据 ② 旧 PIN 账号（accounts 表）数据 并入新账号
  let importedEvents = 0;
  let importedGifts = 0;
  if (body.importDevice !== false) {
    const froms = [
      identity.deviceId ? `dev:${identity.deviceId}` : null,
      `phone:${phone}`,
    ].filter(Boolean);
    ({ importedEvents, importedGifts } = await importAccountData(env, froms, userAccount));
  }

  // 遗留设备接口密钥并入账号密钥
  if (identity.deviceId) {
    const legacy = await env.DB.prepare('SELECT api_key, api_port FROM device_settings WHERE device_id = ?')
      .bind(identity.deviceId)
      .first();
    if (legacy && legacy.api_key) {
      await env.DB.prepare('DELETE FROM account_keys WHERE phone = ?').bind(phone).run();
      await env.DB.prepare('INSERT INTO account_keys (key, phone, port, created_at) VALUES (?, ?, ?, ?)')
        .bind(legacy.api_key, phone, legacy.api_port || 0, nowIso())
        .run();
      await env.DB.prepare('UPDATE device_settings SET api_key = ?, api_key_hash = ? WHERE device_id = ?')
        .bind('', '', identity.deviceId)
        .run();
    }
  }

  // 旧 PIN 账号（accounts 表）数据已并入，停用旧体系：删除 PIN 账号与其设备绑定，
  // 之后该手机号只能走新体系（user: 账号 + JWT）。
  // 注意：仅在"并入数据"时才停用旧 PIN 账号——用户选了 importDevice:false（明确不并入）
  // 时保留 phone: 数据的可访问性，否则数据会变成谁也访问不到的孤儿。
  if (body.importDevice !== false) {
    await env.DB.prepare('DELETE FROM device_bindings WHERE phone = ?').bind(phone).run();
    await env.DB.prepare('DELETE FROM accounts WHERE phone = ?').bind(phone).run();
  }

  const now = Math.floor(Date.now() / 1000);
  const token = await jwtSign(
    { phone, name, iat: now, exp: now + JWT_TTL_SECONDS },
    jwtSecret(env)
  );
  return jsonRes(
    {
      phone,
      name,
      registered: true,
      token,
      importedEvents,
      importedGifts,
      hint:
        importedEvents + importedGifts > 0
          ? '已有数据已并入账号'
          : '注册成功，7 天内无需重复登录',
    },
    200,
    origin
  );
}

async function handleAccountLogin(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = asString(body.phone, 20).trim();
  const password = asString(body.password, 64);
  if (!validPhone(phone)) return fail('请输入正确的手机号', 400, origin);

  if (loginLocked(phone)) {
    return fail('尝试过于频繁，请 5 分钟后再试或联系管理员重置密码', 429, origin);
  }

  const user = await env.DB.prepare('SELECT * FROM users WHERE phone = ?')
    .bind(phone)
    .first();
  if (!user) {
    recordLoginFail(phone);
    return fail('该手机号未注册，请切换到注册', 404, origin);
  }

  const [salt, stored] = String(user.password_hash).split('|');
  const computed = await hashPassword(password, salt);
  if (computed !== stored) {
    recordLoginFail(phone);
    return fail('手机号或密码不正确', 403, origin);
  }
  clearLoginFails(phone);

  const now = Math.floor(Date.now() / 1000);
  const token = await jwtSign(
    { phone, name: user.name, iat: now, exp: now + JWT_TTL_SECONDS },
    jwtSecret(env)
  );
  return jsonRes({ phone, name: user.name, loggedIn: true, token }, 200, origin);
}

async function handleAccountCheck(request, env, origin) {
  const url = new URL(request.url);
  const phone = url.searchParams.get('phone') || '';
  if (!validPhone(phone)) return fail('请输入手机号', 400, origin);
  const user = await env.DB.prepare('SELECT 1 AS x FROM users WHERE phone = ?')
    .bind(phone)
    .first();
  return jsonRes({ phone, registered: Boolean(user) }, 200, origin);
}

// 忘记 PIN：管理员重置（部署者在 Cloudflare 控制台设置 ADMIN_KEY 密钥）
async function handleAdminResetPassword(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const adminKey = (request.headers.get('X-Admin-Key') || '').trim();
  if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
    return fail('管理员密钥无效', 403, origin);
  }
  const phone = asString(body.phone, 20).trim();
  const newPassword = asString(body.password, 64);
  if (!validPhone(phone)) return fail('请输入正确的手机号', 400, origin);
  if (!validPassword(newPassword)) return fail('密码需为 8-32 位', 400, origin);
  const user = await env.DB.prepare('SELECT 1 AS x FROM users WHERE phone = ?')
    .bind(phone)
    .first();
  if (!user) return fail('该手机号未注册', 404, origin);
  const salt = crypto.randomUUID();
  const passwordHash = `${salt}|${await hashPassword(newPassword, salt)}`;
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE phone = ?')
    .bind(passwordHash, phone)
    .run();
  return jsonRes({ phone, reset: true }, 200, origin);
}

// 清空账号：删除用户及名下全部数据（user: 新账号 + phone: 旧 PIN 账号）
async function handleAdminPurge(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const adminKey = (request.headers.get('X-Admin-Key') || '').trim();
  if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
    return fail('管理员密钥无效', 403, origin);
  }
  const phone = asString(body.phone, 20).trim();
  if (!validPhone(phone)) return fail('请输入正确的手机号', 400, origin);
  for (const account of [`user:${phone}`, `phone:${phone}`]) {
    await env.DB.prepare('DELETE FROM events WHERE account = ?').bind(account).run();
    await env.DB.prepare('DELETE FROM gifts WHERE account = ?').bind(account).run();
    await env.DB.prepare('DELETE FROM account_settings WHERE account = ?').bind(account).run();
  }
  await env.DB.prepare('DELETE FROM account_keys WHERE phone = ?').bind(phone).run();
  await env.DB.prepare('DELETE FROM device_bindings WHERE phone = ?').bind(phone).run();
  await env.DB.prepare('DELETE FROM users WHERE phone = ?').bind(phone).run();
  await env.DB.prepare('DELETE FROM accounts WHERE phone = ?').bind(phone).run();
  return jsonRes({ phone, purged: true }, 200, origin);
}

/* ------------------------------------------------------------------ */
/* 管理后台：ADMIN_KEY 登录 + 用户管理 + 全站备份还原                     */
/*                                                                    */
/* 管理员凭证来自 Cloudflare Secret：ADMIN_KEY（与命令行接口同一个）。     */
/* 登录页输入该 key → 签发 role:'admin' 的 JWT（12 小时），               */
/* 后续请求头 X-Admin-Token 携带，无需再记第二套账号密码。                */
/* ------------------------------------------------------------------ */

const ADMIN_TOKEN_TTL = 12 * 60 * 60; // 管理会话 12 小时

function adminConfigured(env) {
  return Boolean(env.ADMIN_KEY);
}

/** 校验 X-Admin-Token：必须是本服务签发、未过期、role='admin' 的 JWT。 */
async function verifyAdminToken(request, env) {
  const token = (request.headers.get('X-Admin-Token') || '').trim();
  if (!token) return false;
  const payload = await jwtVerify(token, jwtSecret(env));
  return Boolean(payload && payload.role === 'admin');
}

/** 管理员登录：校验 ADMIN_KEY（与命令行接口同一把密钥），签发 admin JWT。 */
async function handleAdminLogin(request, env, origin) {
  if (!adminConfigured(env)) {
    return fail('管理后台未启用：请先在 Cloudflare 配置 ADMIN_KEY 密钥', 503, origin);
  }
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  // 兼容两种字段名：adminKey（新）、X-Admin-Key 头（老脚本习惯）
  const supplied = (asString(body.adminKey, 256) || (request.headers.get('X-Admin-Key') || '').trim());
  if (supplied !== env.ADMIN_KEY) {
    return fail('管理员密钥不正确', 403, origin);
  }
  const now = Math.floor(Date.now() / 1000);
  const token = await jwtSign(
    { role: 'admin', iat: now, exp: now + ADMIN_TOKEN_TTL },
    jwtSecret(env)
  );
  return jsonRes({ token, expiresIn: ADMIN_TOKEN_TTL }, 200, origin);
}

/** 用户列表：users + 每个账号的数据量统计 + 接口密钥状态。 */
async function handleAdminUsers(env, origin) {
  const { results } = await env.DB.prepare(
    'SELECT phone, name, created_at FROM users ORDER BY created_at DESC'
  ).all();
  const users = results || [];
  // 逐账号统计（个人站点量级小，顺序查询足够；避免大 JOIN 拖慢）
  for (const u of users) {
    const account = `user:${u.phone}`;
    const [ev, gf, key] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE account = ?').bind(account).first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM gifts WHERE account = ?').bind(account).first(),
      env.DB.prepare('SELECT 1 AS x FROM account_keys WHERE phone = ? LIMIT 1').bind(u.phone).first(),
    ]);
    u.eventCount = (ev && Number(ev.n)) || 0;
    u.giftCount = (gf && Number(gf.n)) || 0;
    u.hasApiKey = Boolean(key);
  }
  return jsonRes({ users, total: users.length }, 200, origin);
}

/** 管理员新增用户（手机号+密码+昵称）。 */
async function handleAdminUserCreate(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = asString(body.phone, 20).trim();
  const name = asString(body.name, 32).trim() || '账本用户';
  const password = asString(body.password, 64);
  if (!validPhone(phone)) return fail('请输入正确的手机号', 400, origin);
  if (!validPassword(password)) return fail('密码需为 8-32 位', 400, origin);
  if (await env.DB.prepare('SELECT 1 AS x FROM users WHERE phone = ?').bind(phone).first()) {
    return fail('该手机号已存在', 409, origin);
  }
  const salt = crypto.randomUUID();
  const hash = `${salt}|${await hashPassword(password, salt)}`;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (phone, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .bind(phone, name, hash, nowIso()),
    env.DB.prepare('INSERT OR IGNORE INTO account_settings (account) VALUES (?)').bind(`user:${phone}`),
  ]);
  return jsonRes({ phone, name, created: true }, 200, origin);
}

/** 管理员改用户信息：昵称 / 密码（均按传入字段可选）。 */
async function handleAdminUserUpdate(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = asString(body.phone, 20).trim();
  if (!validPhone(phone)) return fail('请输入正确的手机号', 400, origin);
  const user = await env.DB.prepare('SELECT * FROM users WHERE phone = ?').bind(phone).first();
  if (!user) return fail('用户不存在', 404, origin);
  const name = body.name !== undefined ? (asString(body.name, 32).trim() || '账本用户') : user.name;
  let passwordHash = user.password_hash;
  if (body.password !== undefined && body.password !== '') {
    const password = asString(body.password, 64);
    if (!validPassword(password)) return fail('密码需为 8-32 位', 400, origin);
    const salt = crypto.randomUUID();
    passwordHash = `${salt}|${await hashPassword(password, salt)}`;
  }
  await env.DB.prepare('UPDATE users SET name = ?, password_hash = ? WHERE phone = ?')
    .bind(name, passwordHash, phone)
    .run();
  return jsonRes({ phone, name, updated: true }, 200, origin);
}

/** 管理员删除用户及其名下全部数据（复用现有清空逻辑）。 */
async function handleAdminUserDelete(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = asString(body.phone, 20).trim();
  if (!validPhone(phone)) return fail('请输入正确的手机号', 400, origin);
  for (const account of [`user:${phone}`, `phone:${phone}`]) {
    await env.DB.prepare('DELETE FROM events WHERE account = ?').bind(account).run();
    await env.DB.prepare('DELETE FROM gifts WHERE account = ?').bind(account).run();
    await env.DB.prepare('DELETE FROM account_settings WHERE account = ?').bind(account).run();
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM account_keys WHERE phone = ?').bind(phone),
    env.DB.prepare('DELETE FROM device_bindings WHERE phone = ?').bind(phone),
    env.DB.prepare('DELETE FROM users WHERE phone = ?').bind(phone),
    env.DB.prepare('DELETE FROM accounts WHERE phone = ?').bind(phone),
  ]);
  return jsonRes({ phone, deleted: true }, 200, origin);
}

// 全站备份包含的全部表（顺序：先主体后配置；导入时同序）
const ADMIN_BACKUP_TABLES = [
  'users', 'accounts', 'device_bindings', 'account_keys',
  'devices', 'device_settings', 'events', 'gifts',
  'account_settings', 'feedback', 'register_log',
];

/** 全站导出：所有表所有行，明文 JSON。 */
async function handleAdminExportAll(env, origin) {
  const data = {};
  let totalRows = 0;
  for (const table of ADMIN_BACKUP_TABLES) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
    data[table] = results || [];
    totalRows += data[table].length;
  }
  const doc = {
    app: 'gift-ledger',
    kind: 'admin-full',
    version: 1,
    exportedAt: nowIso(),
    tables: ADMIN_BACKUP_TABLES,
    totalRows,
    data,
  };
  return new Response(JSON.stringify(doc, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="gift-ledger-site-backup-${todayStr()}.json"`,
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}

/** 全站导入：按表清空后重建（可选 merge 模式则不清空）。明文 JSON。 */
async function handleAdminImportAll(request, env, origin) {
  let form;
  try { form = await request.formData(); } catch { return fail('请求格式错误', 400, origin); }
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail('请选择备份文件', 400, origin);
  const merge = String(form.get('merge') || '') === '1';
  let doc;
  try { doc = JSON.parse(await file.text()); } catch { return fail('备份文件不是有效的 JSON', 400, origin); }
  if (!doc || doc.kind !== 'admin-full' || !doc.data || typeof doc.data !== 'object') {
    return fail('不是有效的管理后台全站备份文件', 400, origin);
  }

  const stats = {};
  try {
    // 逐表处理：清空（可选）后分批 INSERT OR REPLACE，单表每批 40 条控制语句数
    for (const table of ADMIN_BACKUP_TABLES) {
      const rows = Array.isArray(doc.data[table]) ? doc.data[table] : [];
      if (!merge) {
        await env.DB.prepare(`DELETE FROM ${table}`).run();
      }
      let inserted = 0;
      for (let i = 0; i < rows.length; i += 40) {
        const batch = [];
        for (const row of rows.slice(i, i + 40)) {
          if (!row || typeof row !== 'object') continue;
          // 列名只允许字母/数字/下划线，防止从上载文件注入 SQL
          const cols = Object.keys(row).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
          if (!cols.length) continue;
          const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
          batch.push(env.DB.prepare(sql).bind(...cols.map((k) => row[k] ?? null)));
        }
        if (batch.length) await env.DB.batch(batch);
        inserted += batch.length;
      }
      stats[table] = inserted;
    }
  } catch (e) {
    console.error('admin import failed', e && e.stack ? e.stack : e);
    return fail('导入失败：数据结构与当前版本不兼容或文件损坏', 500, origin);
  }
  return jsonRes({ ok: true, merge, stats }, 200, origin);
}

async function handleAccountUnbindDevice(request, env, identity, origin) {
  // 登出/退出：只清除本地登录态。Web 账号的"信任本设备"即 JWT（localStorage 存了 7 天），
  // 清掉即退出；设备密钥/绑定关系保留，便于再次登录免输密码前快速恢复。
  const phone = accountPhone(identity.account);
  if (!identity.deviceId) return fail('无设备标识', 400, origin);
  if (phone) {
    await env.DB.prepare('DELETE FROM device_bindings WHERE device_id = ? AND phone = ?')
      .bind(identity.deviceId, phone)
      .run();
  }
  return jsonRes({ unbound: true }, 200, origin);
}

/* ------------------------------------------------------------------ */
/* 个人中心：修改昵称 / 密码 / 绑定手机号                               */
/* ------------------------------------------------------------------ */

/** 仅登录账号（手机号+密码体系）可改个人信息；游客无账号可改。 */
function requirePhoneAccount(identity, origin) {
  if (!identity.isPhone) return { error: fail('请先登录账号后再操作', 401, origin) };
  return { phone: accountPhone(identity.account) };
}

/** 发新 JWT（token 内含 phone/name，改完信息后必须换发）。 */
async function reissueToken(env, phone, name) {
  const now = Math.floor(Date.now() / 1000);
  return jwtSign({ phone, name, iat: now, exp: now + JWT_TTL_SECONDS }, jwtSecret(env));
}

/** 改昵称 */
async function handleProfileUpdate(request, env, identity, origin) {
  const guard = requirePhoneAccount(identity, origin);
  if (guard.error) return guard.error;
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const name = asString(body.name, 32).trim() || '账本用户';
  const phone = guard.phone;
  await env.DB.prepare('UPDATE users SET name = ? WHERE phone = ?').bind(name, phone).run();
  return jsonRes({ phone, name, token: await reissueToken(env, phone, name) }, 200, origin);
}

/** 改密码：验证当前密码 */
async function handlePasswordChange(request, env, identity, origin) {
  const guard = requirePhoneAccount(identity, origin);
  if (guard.error) return guard.error;
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = guard.phone;
  const oldPassword = asString(body.oldPassword, 64);
  const newPassword = asString(body.newPassword, 64);
  if (!validPassword(newPassword)) return fail('新密码需为 8-32 位', 400, origin);
  const user = await env.DB.prepare('SELECT password_hash, name FROM users WHERE phone = ?')
    .bind(phone)
    .first();
  if (!user) return fail('账号不存在', 404, origin);
  const [salt, stored] = String(user.password_hash).split('|');
  if ((await hashPassword(oldPassword, salt)) !== stored) return fail('当前密码不正确', 403, origin);
  const newSalt = crypto.randomUUID();
  const passwordHash = `${newSalt}|${await hashPassword(newPassword, newSalt)}`;
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE phone = ?').bind(passwordHash, phone).run();
  return jsonRes({ phone, changed: true }, 200, origin);
}

/** 改绑定手机号：验证密码 → 校验新号 → 原子迁移全部账号数据 → 换发 JWT。 */
async function handlePhoneChange(request, env, identity, origin) {
  const guard = requirePhoneAccount(identity, origin);
  if (guard.error) return guard.error;
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = guard.phone;
  const newPhone = asString(body.newPhone, 20).trim();
  const password = asString(body.password, 64);
  if (!validPhone(newPhone)) return fail('请输入正确的手机号', 400, origin);
  if (newPhone === phone) return fail('新手机号不能与当前手机号相同', 400, origin);

  const user = await env.DB.prepare('SELECT * FROM users WHERE phone = ?').bind(phone).first();
  if (!user) return fail('账号不存在', 404, origin);
  const [salt, stored] = String(user.password_hash).split('|');
  if ((await hashPassword(password, salt)) !== stored) return fail('当前密码不正确', 403, origin);
  const dup = await env.DB.prepare('SELECT 1 AS x FROM users WHERE phone = ?').bind(newPhone).first();
  if (dup) return fail('该手机号已被注册', 409, origin);

  const oldAccount = `user:${phone}`;
  const newAccount = `user:${newPhone}`;
  // 全部迁移在一个 batch 内原子执行：任一步失败则整体回滚，不会出现半迁移状态。
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (phone, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .bind(newPhone, user.name, user.password_hash, user.created_at),
    env.DB.prepare('DELETE FROM users WHERE phone = ?').bind(phone),
    env.DB.prepare('UPDATE events SET account = ? WHERE account = ?').bind(newAccount, oldAccount),
    env.DB.prepare('UPDATE gifts SET account = ? WHERE account = ?').bind(newAccount, oldAccount),
    env.DB.prepare(
      `INSERT OR REPLACE INTO account_settings (account, ai_base_url, ai_api_key, ai_model)
       SELECT ?, ai_base_url, ai_api_key, ai_model FROM account_settings WHERE account = ?`
    ).bind(newAccount, oldAccount),
    env.DB.prepare('DELETE FROM account_settings WHERE account = ?').bind(oldAccount),
    env.DB.prepare('UPDATE account_keys SET phone = ? WHERE phone = ?').bind(newPhone, phone),
    env.DB.prepare('UPDATE device_bindings SET phone = ? WHERE phone = ?').bind(newPhone, phone),
    env.DB.prepare('UPDATE feedback SET account = ? WHERE account = ?').bind(newAccount, oldAccount),
  ]);
  return jsonRes(
    { phone: newPhone, name: user.name, changed: true, token: await reissueToken(env, newPhone, user.name) },
    200,
    origin
  );
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

async function handleSession(env, identity, origin) {
  const { account, phone, isPhone, name } = identity;
  let username = '访客';
  let auth = { loggedIn: false, guest: true };

  if (isPhone) {
    username = name || maskPhone(phone);
    auth = { loggedIn: true, phone, guest: false, name: name || null };
  } else if (account && account.startsWith('phone:')) {
    // 旧 PIN 体系遗留身份
    username = maskPhone(account.slice(6));
    auth = { loggedIn: true, phone: account.slice(6), guest: false };
  }

  const loggedIn = isPhone || Boolean(account && account.startsWith('phone:'));

  return jsonRes(
    {
      username,
      uid: account ? account : `dev-${(identity.deviceId || '').slice(0, 8)}`,
      // 前端设置页判断 mode==='gateway' 显示「云端网关」（其余显示「开发模式」），
      // 本部署即云端服务，返回 gateway 让面板文案原生正确。
      mode: 'gateway',
      gateway: {
        configured: true,
        username: loggedIn ? username : undefined,
        loggedIn,
        error: loggedIn ? '' : '未登录账号（当前为游客模式）',
      },
      // 网页版由自建 Worker 提供完整功能，直接视为已开通永久版。
      membership: { lifetime: true, priceFen: 1990 },
      // 前端设置页「云端服务：已连接（gateway.username）」——登录账号显示完整手机号，
      // 便于用户确认当前数据归属哪个账号；游客不显示。
      gatewayPhone: loggedIn ? phone : null,
      auth,
    },
    200,
    origin
  );
}

/* ------------------------------------------------------------------ */
/* 活动 / 礼金（按 account 作用域）                                    */
/* ------------------------------------------------------------------ */

const GIFT_COLUMNS = `gifts.id, gifts.event_id AS eventId, gifts.person, gifts.relation, gifts.direction,
  COALESCE((SELECT e2.type FROM events e2 WHERE e2.id = gifts.event_id AND e2.account = gifts.account), 'other') AS eventType,
  gifts.amount_fen AS amountFen, gifts.method, gifts.date, gifts.note, gifts.created_at AS createdAt`;

const EVENT_COLUMNS = `id, name, type, date, created_at AS createdAt`;

async function handleEventsGet(env, account, origin) {
  const { results } = await env.DB.prepare(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE account = ?
     ORDER BY date DESC, created_at DESC, id DESC`
  )
    .bind(account)
    .all();
  return jsonRes(results || [], 200, origin);
}

async function handleEventsCreate(request, env, account, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);

  const type = EVENT_TYPES.has(body.type) ? body.type : 'other';
  const date = isValidDate(body.date) ? body.date : null;
  if (!date) return fail('活动日期格式需为 YYYY-MM-DD', 400, origin);
  const name = asString(body.name, 60).trim() || EVENT_LABELS[type];

  const existing = await env.DB.prepare(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE account = ? AND type = ? AND date = ? LIMIT 1`
  )
    .bind(account, type, date)
    .first();
  if (existing) return jsonRes(existing, 200, origin);

  const event = {
    id: crypto.randomUUID(),
    name,
    type,
    date,
    createdAt: nowIso(),
  };
  try {
    await env.DB.prepare(
      `INSERT INTO events (id, device_id, account, name, type, date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(event.id, '', account, event.name, event.type, event.date, event.createdAt)
      .run();
  } catch (e) {
    // 并发竞态：两个请求同时通过上方"已存在"检查，撞 (account, type, date) 唯一索引。
    // 回读已存在的那条返回，保持接口幂等语义（与上方 existing 分支一致）。
    if (isUniqueError(e)) {
      const raced = await env.DB.prepare(
        `SELECT ${EVENT_COLUMNS} FROM events WHERE account = ? AND type = ? AND date = ? LIMIT 1`
      )
        .bind(account, type, date)
        .first();
      if (raced) return jsonRes(raced, 200, origin);
    }
    throw e;
  }
  return jsonRes(event, 200, origin);
}

async function handleEventUpdate(request, env, account, eventId, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const type = EVENT_TYPES.has(body.type) ? body.type : null;
  const date = isValidDate(body.date) ? body.date : null;
  if (!type) return fail('活动类型不正确', 400, origin);
  if (!date) return fail('活动日期格式需为 YYYY-MM-DD', 400, origin);
  const name = asString(body.name, 60).trim() || EVENT_LABELS[type];

  const clash = await env.DB.prepare(
    'SELECT id FROM events WHERE account = ? AND type = ? AND date = ? AND id <> ? LIMIT 1'
  )
    .bind(account, type, date, eventId)
    .first();
  if (clash) return fail('已存在相同类型与日期的活动', 400, origin);

  const result = await env.DB.prepare(
    'UPDATE events SET name = ?, type = ?, date = ? WHERE id = ? AND account = ?'
  )
    .bind(name, type, date, eventId, account)
    .run();
  if (!result.meta || result.meta.changes === 0) return fail('活动不存在', 404, origin);
  const event = await env.DB.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ? AND account = ?`)
    .bind(eventId, account)
    .first();
  return jsonRes(event, 200, origin);
}

async function handleEventDelete(env, account, eventId, origin) {
  // 先确认活动存在（且属于本账号），再级联删除礼金：
  // 否则活动不存在时礼金已被误删（历史顺序缺陷）。
  const exists = await env.DB.prepare('SELECT 1 AS x FROM events WHERE id = ? AND account = ?')
    .bind(eventId, account)
    .first();
  if (!exists) return fail('活动不存在', 404, origin);

  await env.DB.prepare('DELETE FROM gifts WHERE event_id = ? AND account = ?')
    .bind(eventId, account)
    .run();
  await env.DB.prepare('DELETE FROM events WHERE id = ? AND account = ?')
    .bind(eventId, account)
    .run();
  return jsonRes({ deleted: true }, 200, origin);
}

async function handleGiftsGet(request, env, account, origin) {
  const url = new URL(request.url);
  const clauses = ['account = ?'];
  const params = [account];

  const eventId = url.searchParams.get('eventId');
  if (eventId) {
    clauses.push('event_id = ?');
    params.push(eventId);
  }
  const person = url.searchParams.get('person');
  if (person) {
    clauses.push('person = ?');
    params.push(person);
  }
  const direction = url.searchParams.get('direction');
  if (direction === 'in' || direction === 'out') {
    clauses.push('direction = ?');
    params.push(direction);
  }
  const q = url.searchParams.get('q');
  if (q) {
    const like = `%${q}%`;
    clauses.push('(person LIKE ? OR note LIKE ? OR relation LIKE ?)');
    params.push(like, like, like);
  }

  let limit = Number.parseInt(url.searchParams.get('limit') || '', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 5000;
  limit = Math.min(limit, 10000);

  const { results } = await env.DB.prepare(
    `SELECT ${GIFT_COLUMNS} FROM gifts WHERE ${clauses.join(' AND ')}
     ORDER BY date DESC, created_at DESC, id DESC LIMIT ?`
  )
    .bind(...params, limit)
    .all();

  const gifts = results || [];
  return jsonRes({ gifts, total: gifts.length }, 200, origin);
}

async function validateGiftBody(body, env, account) {
  if (!body) return { error: '请求内容格式错误' };
  const person = asString(body.person, 80).trim();
  if (!person) return { error: '请填写往来对象' };

  const eventId = asString(body.eventId, 64);
  if (!eventId) return { error: '缺少活动信息' };
  const event = await env.DB.prepare('SELECT id FROM events WHERE id = ? AND account = ?')
    .bind(eventId, account)
    .first();
  if (!event) return { error: '活动不存在，请刷新后重试' };

  const direction = body.direction === 'in' || body.direction === 'out' ? body.direction : null;
  if (!direction) return { error: '收支方向不正确' };

  const amountFen = Number(body.amountFen);
  if (!Number.isFinite(amountFen) || !Number.isInteger(amountFen) || amountFen <= 0) {
    return { error: '请输入正确的金额' };
  }
  if (amountFen > 100000000000) return { error: '金额超出范围' };

  const date = isValidDate(body.date) ? body.date : null;
  if (!date) return { error: '日期格式需为 YYYY-MM-DD' };

  return {
    value: {
      eventId,
      person,
      relation: RELATIONS.has(body.relation) ? body.relation : '朋友',
      direction,
      amountFen,
      method: METHODS.has(body.method) ? body.method : 'cash',
      date,
      note: asString(body.note, 500).trim(),
    },
  };
}

async function handleGiftsCreate(request, env, account, origin) {
  const body = await readJson(request);
  const { error, value } = await validateGiftBody(body, env, account);
  if (error) return fail(error, 400, origin);

  const gift = {
    id: crypto.randomUUID(),
    ...value,
    createdAt: nowIso(),
  };
  await env.DB.prepare(
    `INSERT INTO gifts
     (id, device_id, account, event_id, person, relation, direction, amount_fen, method, date, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      gift.id,
      '',
      account,
      gift.eventId,
      gift.person,
      gift.relation,
      gift.direction,
      gift.amountFen,
      gift.method,
      gift.date,
      gift.note,
      gift.createdAt
    )
    .run();
  return jsonRes(gift, 200, origin);
}

async function handleGiftGet(env, account, giftId, origin) {
  const gift = await env.DB.prepare(`SELECT ${GIFT_COLUMNS} FROM gifts WHERE id = ? AND account = ?`)
    .bind(giftId, account)
    .first();
  if (!gift) return fail('记录不存在', 404, origin);
  return jsonRes(gift, 200, origin);
}

async function handleGiftsUpdate(request, env, account, giftId, origin) {
  const body = await readJson(request);
  const { error, value } = await validateGiftBody(body, env, account);
  if (error) return fail(error, 400, origin);

  const result = await env.DB.prepare(
    `UPDATE gifts SET event_id = ?, person = ?, relation = ?, direction = ?,
       amount_fen = ?, method = ?, date = ?, note = ?
     WHERE id = ? AND account = ?`
  )
    .bind(
      value.eventId,
      value.person,
      value.relation,
      value.direction,
      value.amountFen,
      value.method,
      value.date,
      value.note,
      giftId,
      account
    )
    .run();
  if (!result.meta || result.meta.changes === 0) {
    return fail('记录不存在或无权限修改', 404, origin);
  }
  const gift = await env.DB.prepare(`SELECT ${GIFT_COLUMNS} FROM gifts WHERE id = ? AND account = ?`)
    .bind(giftId, account)
    .first();
  return jsonRes(gift, 200, origin);
}

async function handleGiftsDelete(env, account, giftId, origin) {
  const result = await env.DB.prepare('DELETE FROM gifts WHERE id = ? AND account = ?')
    .bind(giftId, account)
    .run();
  if (!result.meta || result.meta.changes === 0) return fail('记录不存在或无权限删除', 404, origin);
  return jsonRes({ deleted: true }, 200, origin);
}

/* ------------------------------------------------------------------ */
/* 统计 / 联系人 / 年度报告 / CSV                                       */
/* ------------------------------------------------------------------ */

function buildPersonSummaries(gifts, events) {
  const eventById = new Map((events || []).map((e) => [e.id, e]));
  const map = new Map();
  for (const g of gifts) {
    const key = g.person;
    let p = map.get(key);
    if (!p) {
      p = {
        person: g.person,
        relation: g.relation || '',
        totalInFen: 0,
        totalOutFen: 0,
        giftCount: 0,
        inCount: 0,
        outCount: 0,
        firstDate: g.date,
        lastDate: g.date,
        maxIn: 0,
        maxOut: 0,
        events: new Set(),
      };
      map.set(key, p);
    }
    p.giftCount++;
    if (g.direction === 'in') {
      p.totalInFen += g.amountFen;
      p.inCount++;
      p.maxIn = Math.max(p.maxIn, g.amountFen);
    } else {
      p.totalOutFen += g.amountFen;
      p.outCount++;
      p.maxOut = Math.max(p.maxOut, g.amountFen);
    }
    if (g.date < p.firstDate) p.firstDate = g.date;
    if (g.date > p.lastDate) p.lastDate = g.date;
    const ev = eventById.get(g.eventId);
    if (ev && ev.name) p.events.add(ev.name);
  }
  const list = [...map.values()].map((p) => {
    const totalFen = p.totalInFen + p.totalOutFen;
    return {
      person: p.person,
      relation: p.relation,
      events: [...p.events],
      lastDate: p.lastDate,
      totalFen,
      totalInFen: p.totalInFen,
      totalOutFen: p.totalOutFen,
      inFen: p.totalInFen,
      outFen: p.totalOutFen,
      netFen: p.totalInFen - p.totalOutFen,
      count: p.giftCount,
      giftCount: p.giftCount,
      inCount: p.inCount,
      outCount: p.outCount,
      firstDate: p.firstDate,
      maxIn: p.maxIn,
      maxOut: p.maxOut,
    };
  });
  list.sort((a, b) => b.totalFen - a.totalFen);
  return list;
}

async function loadAccountData(env, account) {
  const [eventsRes, giftsRes] = await Promise.all([
    env.DB.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE account = ? ORDER BY date ASC`)
      .bind(account)
      .all(),
    env.DB.prepare(`SELECT ${GIFT_COLUMNS} FROM gifts WHERE account = ? ORDER BY date ASC, created_at ASC`)
      .bind(account)
      .all(),
  ]);
  return { events: eventsRes.results || [], gifts: giftsRes.results || [] };
}

async function handleOverview(env, account, origin) {
  const { events, gifts } = await loadAccountData(env, account);
  const year = thisYear();

  let totalInFen = 0;
  let totalOutFen = 0;
  let yearInFen = 0;
  let yearOutFen = 0;
  let maxIn = 0;
  let maxOut = 0;
  let firstDate = '';
  for (const g of gifts) {
    if (g.direction === 'in') {
      totalInFen += g.amountFen;
      if (g.date.startsWith(year)) yearInFen += g.amountFen;
      maxIn = Math.max(maxIn, g.amountFen);
    } else {
      totalOutFen += g.amountFen;
      if (g.date.startsWith(year)) yearOutFen += g.amountFen;
      maxOut = Math.max(maxOut, g.amountFen);
    }
    if (!firstDate || g.date < firstDate) firstDate = g.date;
  }
  const people = buildPersonSummaries(gifts, events);

  return jsonRes(
    {
      eventCount: events.length,
      giftCount: gifts.length,
      totalInFen,
      totalOutFen,
      netFen: totalInFen - totalOutFen,
      yearInFen,
      yearOutFen,
      personCount: people.length,
      topPersons: people.slice(0, 5),
      maxIn,
      maxOut,
      firstDate,
    },
    200,
    origin
  );
}

async function handlePeople(env, account, origin) {
  const { events, gifts } = await loadAccountData(env, account);
  return jsonRes(buildPersonSummaries(gifts, events), 200, origin);
}

async function handleYearlyReport(request, env, account, origin) {
  const url = new URL(request.url);
  const nowYear = thisYear();
  const rawYear = url.searchParams.get('year') || '';
  const year = /^\d{4}$/.test(rawYear) ? rawYear : nowYear;

  const { events, gifts } = await loadAccountData(env, account);
  const eventType = new Map(events.map((e) => [e.id, e.type]));
  const years = [...new Set(gifts.map((g) => g.date.slice(0, 4)))].sort().reverse();
  const yearGifts = gifts.filter((g) => g.date.startsWith(year));

  const byTypeMap = new Map();
  const byMonthMap = new Map();
  let totalInFen = 0;
  let totalOutFen = 0;

  for (const g of yearGifts) {
    const type = eventType.get(g.eventId) || g.eventType || 'other';
    let t = byTypeMap.get(type);
    if (!t) {
      t = { type, inFen: 0, outFen: 0, count: 0 };
      byTypeMap.set(type, t);
    }
    const month = g.date.slice(0, 7);
    let m = byMonthMap.get(month);
    if (!m) {
      m = { month, inFen: 0, outFen: 0, count: 0 };
      byMonthMap.set(month, m);
    }
    if (g.direction === 'in') {
      totalInFen += g.amountFen;
      t.inFen += g.amountFen;
      m.inFen += g.amountFen;
    } else {
      totalOutFen += g.amountFen;
      t.outFen += g.amountFen;
      m.outFen += g.amountFen;
    }
    t.count++;
    m.count++;
  }

  const byType = [...byTypeMap.values()]
    .map((t) => ({
      type: t.type,
      label: EVENT_LABELS[t.type] || t.type,
      inFen: t.inFen,
      outFen: t.outFen,
      netFen: t.inFen - t.outFen,
      totalFen: t.inFen + t.outFen,
      count: t.count,
    }))
    .sort((a, b) => b.totalFen - a.totalFen);
  const byMonth = [...byMonthMap.values()]
    .map((m) => ({
      month: m.month,
      inFen: m.inFen,
      outFen: m.outFen,
      netFen: m.inFen - m.outFen,
      totalFen: m.inFen + m.outFen,
      count: m.count,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return jsonRes(
    {
      year: Number(year),
      count: yearGifts.length,
      years,
      inFen: totalInFen,
      outFen: totalOutFen,
      netFen: totalInFen - totalOutFen,
      totalFen: totalInFen + totalOutFen,
      totalInFen,
      totalOutFen,
      byType,
      byMonth,
      topPersons: buildPersonSummaries(yearGifts, events).slice(0, 5),
      recent: yearGifts.slice(0, 10),
    },
    200,
    origin
  );
}

function csvEscape(value) {
  const text = String(value === null || value === undefined ? '' : value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function handleExportCsv(request, env, account, origin) {
  const url = new URL(request.url);
  const kind = url.searchParams.get('type') || url.searchParams.get('kind') || 'gifts';
  const { events, gifts } = await loadAccountData(env, account);
  const eventById = new Map(events.map((e) => [e.id, e]));

  const rows = [];
  let filename = '礼金明细.csv';

  if (kind === 'events') {
    filename = '活动列表.csv';
    rows.push(['名称', '类型', '日期', '笔数']);
    for (const e of [...events].sort((a, b) => b.date.localeCompare(a.date))) {
      const count = gifts.filter((g) => g.eventId === e.id).length;
      rows.push([e.name, EVENT_LABELS[e.type] || e.type, e.date, count]);
    }
  } else if (kind === 'people') {
    filename = '人情往来.csv';
    rows.push(['姓名', '关系', '收礼(元)', '随礼(元)', '结余(元)', '笔数', '最近日期']);
    for (const p of buildPersonSummaries(gifts, events)) {
      rows.push([
        p.person,
        p.relation,
        (p.totalInFen / 100).toFixed(2),
        (p.totalOutFen / 100).toFixed(2),
        (p.netFen / 100).toFixed(2),
        p.giftCount,
        p.lastDate,
      ]);
    }
  } else {
    rows.push(['日期', '姓名', '关系', '方向', '活动', '方式', '金额(元)', '备注']);
    for (const g of [...gifts].sort((a, b) => b.date.localeCompare(a.date))) {
      const event = eventById.get(g.eventId);
      rows.push([
        g.date,
        g.person,
        g.relation,
        g.direction === 'in' ? '收礼' : '随礼',
        event ? event.name : '',
        METHOD_LABELS[g.method] || g.method,
        (g.amountFen / 100).toFixed(2),
        g.note,
      ]);
    }
  }

  const csv = '﻿' + rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  const disposition = `attachment; filename="export-${kind}.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': disposition,
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}

/* ------------------------------------------------------------------ */
/* AI 模型（按账号保存，登录后多设备一致）                             */
/* ------------------------------------------------------------------ */

function chatEndpoint(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 429/连接抖动自动重试：最多 3 次尝试（首次 + 2 次退避重试），
// 429 优先遵循服务端 Retry-After；总耗时控制在 Worker 墙钟限制内。
// 失败时尽量带上提供方原始响应片段，方便定位是限流、余额还是参数问题。
async function callChat(baseUrl, apiKey, model, messages, maxTokens) {
  const payload = { model, messages, temperature: 0.2, stream: false };
  if (maxTokens) payload.max_tokens = maxTokens;

  let lastDetail = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(chatEndpoint(baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      lastDetail = `AI 服务连接失败：${e && e.message ? e.message : e}`;
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return { ok: false, error: lastDetail };
    }

    // 读取响应（429 与非 429 都需要原始文本；429 中间轮次读完即重试）
    const raw = await res.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { /* 非 JSON 响应 */ }
    const detail =
      (parsed && (
        (parsed.error && (typeof parsed.error === 'string' ? parsed.error : parsed.error.message)) ||
        parsed.message ||
        (typeof parsed.error === 'object' && parsed.error.detail)
      )) ||
      (raw ? raw.slice(0, 200) : '');

    if (res.status === 429 && attempt < 2) {
      lastDetail = detail || 'AI 服务返回 429（请求过于频繁）';
      const ra = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10000) : 1000 * (attempt + 1);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      if (res.status === 429) {
        return {
          ok: false,
          error: `AI 服务返回 429（请求过于频繁/配额不足）${detail ? `：${detail}` : ''}，稍后再试；持续出现请检查该模型服务的限流与余额`,
        };
      }
      return { ok: false, error: `AI 服务返回 ${res.status}${detail ? `：${detail}` : ''}` };
    }

    if (!parsed) {
      return { ok: false, error: `AI 服务返回内容不是有效 JSON${raw ? `（开头：${raw.slice(0, 120)}…）` : ''}` };
    }
    return { ok: true, data: parsed };
  }
  return { ok: false, error: `AI 服务返回 429（请求过于频繁/配额不足）${lastDetail ? `：${lastDetail}` : ''}，稍后再试；持续出现请检查该模型服务的限流与余额` };
}

async function getAiSettings(env, account) {
  if (account.startsWith('user:') || account.startsWith('phone:')) {
    return env.DB.prepare('SELECT * FROM account_settings WHERE account = ?')
      .bind(account)
      .first();
  }
  const deviceId = accountDevice(account);
  return env.DB.prepare('SELECT * FROM device_settings WHERE device_id = ?')
    .bind(deviceId)
    .first();
}

function aiView(s) {
  const baseUrl = (s && s.ai_base_url) || '';
  const model = (s && s.ai_model) || '';
  const key = (s && s.ai_api_key) || '';
  return { baseUrl, model, configured: Boolean(baseUrl && model && key) };
}

async function handleAiConfigGet(env, account, origin) {
  return jsonRes(aiView(await getAiSettings(env, account)), 200, origin);
}

async function handleAiConfigSave(request, env, account, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);

  const baseUrl = asString(body.baseUrl, 300).trim().replace(/\/+$/, '');
  const model = asString(body.model, 120).trim();
  const apiKeyInput = asString(body.apiKey, 500).trim();

  if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
    return fail('接口地址需以 http:// 或 https:// 开头', 400, origin);
  }
  if (!model) return fail('请填写模型名称', 400, origin);

  const s = await getAiSettings(env, account);
  const apiKey = apiKeyInput || (s && s.ai_api_key) || '';
  if (!apiKey) return fail('首次配置需填写 API Key', 400, origin);

  const test = await callChat(baseUrl, apiKey, model, [
    { role: 'user', content: '请只回复两个字：正常' },
  ]);

  if (account.startsWith('user:') || account.startsWith('phone:')) {
    await env.DB.prepare(
      'UPDATE account_settings SET ai_base_url = ?, ai_api_key = ?, ai_model = ? WHERE account = ?'
    )
      .bind(baseUrl, apiKey, model, account)
      .run();
  } else {
    await env.DB.prepare(
      'UPDATE device_settings SET ai_base_url = ?, ai_api_key = ?, ai_model = ? WHERE device_id = ?'
    )
      .bind(baseUrl, apiKey, model, accountDevice(account))
      .run();
  }

  // 429（限流/配额窗口）不阻止保存：配置先存好，解析时走浏览器直连兜底；
  // 其他失败（401 key 错、404 地址错、连不通等）才报错不保存，避免存下坏配置。
  if (!test.ok && test.error.indexOf('429') !== -1) {
    return jsonRes(
      {
        baseUrl,
        model,
        configured: true,
        warning:
          '配置已保存，但该模型服务当前限流（429），连通性测试未通过。稍后重试保存可完成测试；「AI 记账」解析时会自动尝试浏览器直连兜底。',
      },
      200,
      origin
    );
  }
  if (!test.ok) return fail(test.error, 400, origin);

  return jsonRes({ baseUrl, model, configured: true, warning: '' }, 200, origin);
}

function buildParsePrompt() {
  const today = todayStr();
  return `你是「人情录」(份子钱/礼金账本)的记录解析器。把用户的描述提取为礼金记录,只输出 JSON,不要任何解释或 markdown。
输出格式:{"records":[{"direction":"in|out","person":"姓名","relation":"朋友|亲戚|同事|同学|邻居|其他","amountYuan":600,"eventType":"wedding|baby|birthday|housewarming|graduation|funeral|other","date":"YYYY-MM-DD","note":""}]}
规则:收到=in,送出/随礼=out;金额单位元(数字);eventType 按场合映射(婚礼=wedding,满月/百日=baby,生日/寿宴=birthday,乔迁=housewarming,升学=graduation,白事/丧事=funeral,其余=other);日期未提及时用今天(${today})。无法解析的内容放到 errors 数组。`;
}

function stripCodeFence(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function normalizeAiRecords(parsed) {
  const records = [];
  const errors = [];
  const sourceRecords = Array.isArray(parsed && parsed.records) ? parsed.records : [];
  const sourceErrors = Array.isArray(parsed && parsed.errors) ? parsed.errors : [];

  const today = todayStr();
  for (const raw of sourceRecords) {
    if (!raw || typeof raw !== 'object') continue;
    const person = asString(raw.person, 80).trim();
    if (!person) {
      errors.push('有一条记录缺少姓名，已跳过');
      continue;
    }
    const direction = raw.direction === 'in' || raw.direction === 'out' ? raw.direction : null;
    if (!direction) {
      errors.push(`「${person}」的收支方向无法识别，已跳过`);
      continue;
    }
    const amount =
      typeof raw.amountYuan === 'number'
        ? raw.amountYuan
        : Number(String(raw.amountYuan || '').replace(/[^\d.]/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push(`「${person}」的金额无法识别，已跳过`);
      continue;
    }
    const amountYuan = amount.toFixed(2).replace(/\.00$/, '');
    const eventType = EVENT_TYPES.has(raw.eventType) ? raw.eventType : 'other';
    const relation = RELATIONS.has(raw.relation) ? raw.relation : '朋友';
    const date = isValidDate(raw.date) ? raw.date : today;
    records.push({ direction, person, relation, amountYuan, eventType, date, note: asString(raw.note, 500).trim() });
  }

  for (const item of sourceErrors) {
    const msg = asString(item, 300).trim();
    if (msg) errors.push(msg);
  }
  return { records, errors };
}

async function handleAiParse(request, env, account, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const text = asString(body.text, 4000).trim();
  if (!text) return fail('请先输入要解析的内容', 400, origin);

  const s = await getAiSettings(env, account);
  const view = aiView(s);
  if (!view.configured) return fail('请先在「设置 → AI 模型」中配置模型', 400, origin);

  const result = await callChat(view.baseUrl, s.ai_api_key, view.model, [
    { role: 'system', content: buildParsePrompt() },
    { role: 'user', content: text },
  ]);
  if (!result.ok) {
    // Worker 出口 IP（Cloudflare）常被 AI 服务商限流（429/配额）。
    // 把完整 AI 配置带进响应，前端检测到 429 后会用浏览器（用户本机 IP）直连重试；
    // 这是该账号自己的 key，只回到该账号自己的浏览器，不产生新的泄露面。
    if (result.error.indexOf('429') !== -1) {
      return jsonRes(
        {
          error: result.error,
          direct: {
            baseUrl: view.baseUrl,
            apiKey: s.ai_api_key,
            model: view.model,
            system: buildParsePrompt(),
            user: text,
          },
        },
        502,
        origin
      );
    }
    return fail(result.error, 502, origin);
  }

  const choice = result.data && result.data.choices && result.data.choices[0];
  let content = choice && choice.message ? choice.message.content : '';
  if (Array.isArray(content)) {
    content = content.map((part) => (typeof part === 'string' ? part : (part && part.text) || '')).join('');
  }
  if (!content && choice && typeof choice.text === 'string') content = choice.text;
  if (!content) return fail('AI 未返回解析结果', 502, origin);

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch {
    return fail('AI 返回内容不是有效 JSON，请换个说法再试', 502, origin);
  }

  const normalized = normalizeAiRecords(parsed);
  if (!normalized.records.length && !normalized.errors.length) {
    normalized.errors.push('没有解析出记录，换个说法试试');
  }
  return jsonRes(normalized, 200, origin);
}

/* ------------------------------------------------------------------ */
/* 接口密钥（小程序绑定）                                              */
/* ------------------------------------------------------------------ */

async function handleApiKeyGet(env, account, origin) {
  let configured = false;
  let key = '';
  let port = 0;
  let createdAt = '';

  if (account.startsWith('user:') || account.startsWith('phone:')) {
    const phone = accountPhone(account);
    const row = await env.DB.prepare(
      'SELECT key, port, created_at FROM account_keys WHERE phone = ? ORDER BY created_at DESC LIMIT 1'
    )
      .bind(phone)
      .first();
    if (row) {
      configured = true;
      key = row.key;
      port = row.port;
      createdAt = row.created_at;
    }
  } else {
    const legacy = await env.DB.prepare('SELECT api_key, api_port FROM device_settings WHERE device_id = ?')
      .bind(accountDevice(account))
      .first();
    if (legacy && legacy.api_key) {
      configured = true;
      key = legacy.api_key;
      port = legacy.api_port || 0;
    }
  }

  // 原应用的「绑定二维码」用这里的 key 生成配置码，因此返回明文。
  return jsonRes({ configured, key, apiPort: port, createdAt }, 200, origin);
}

async function handleApiKeyRotate(env, account, origin) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const key = `gl_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

  if (account.startsWith('user:') || account.startsWith('phone:')) {
    const phone = accountPhone(account);
    await env.DB.prepare('DELETE FROM account_keys WHERE phone = ?').bind(phone).run();
    await env.DB.prepare('INSERT INTO account_keys (key, phone, port, created_at) VALUES (?, ?, 0, ?)')
      .bind(key, phone, nowIso())
      .run();
  } else {
    const deviceId = accountDevice(account);
    await env.DB.prepare(
      'UPDATE device_settings SET api_key = ?, api_key_hash = ?, api_key_created_at = ? WHERE device_id = ?'
    )
      .bind(key, '', nowIso(), deviceId)
      .run();
  }
  return jsonRes({ key }, 200, origin);
}

async function handleApiKeyPort(request, env, account, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const raw = asString(body.port, 10).trim();
  let port = 0;
  if (raw && raw !== '0') {
    port = Number.parseInt(raw, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) return fail('端口需为 1-65535 的数字', 400, origin);
  }
  if (account.startsWith('user:') || account.startsWith('phone:')) {
    await env.DB.prepare('UPDATE account_keys SET port = ? WHERE phone = ?')
      .bind(port, accountPhone(account))
      .run();
  } else {
    await env.DB.prepare('UPDATE device_settings SET api_port = ? WHERE device_id = ?')
      .bind(port, accountDevice(account))
      .run();
  }
  return jsonRes({ apiPort: port }, 200, origin);
}

/* ------------------------------------------------------------------ */
/* 意见反馈 / 会员                                                     */
/* ------------------------------------------------------------------ */

async function handleFeedback(request, env, account, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const content = asString(body.content, 1000).trim();
  const contact = asString(body.contact, 200).trim();
  if (!content) return fail('反馈内容不能为空', 400, origin);

  await env.DB.prepare('INSERT INTO feedback (account, content, contact, created_at) VALUES (?, ?, ?, ?)')
    .bind(account, content, contact, nowIso())
    .run();
  return jsonRes({ ok: true }, 200, origin);
}

async function handleMembership(origin) {
  return jsonRes({ lifetime: true, priceFen: 1990 }, 200, origin);
}

/* ------------------------------------------------------------------ */
/* 备份导出 / 导入                                                     */
/*                                                                    */
/* 备份为明文 JSON：导出/导入都不依赖任何服务端密钥，用户换账号、换实例    */
/* 都能直接导入。注意备份文件内含 AI API Key 与小程序接口密钥（完整还原    */
/* 所需），请像保管密码一样保管备份文件，不要发到公开渠道。               */
/* ------------------------------------------------------------------ */

/** 组装明文备份文档（无加密、无密钥依赖）。 */
function buildPayload(account, events, gifts, ai, apiKey) {
  return {
    app: 'gift-ledger',
    kind: 'full',
    alg: 'plain',
    version: 2,
    exportedAt: nowIso(),
    account,
    events,
    gifts,
    // 全栈备份附加项：AI 模型配置与接口密钥（旧备份无这两个字段时按 undefined 处理）
    ai: ai
      ? {
          baseUrl: ai.ai_base_url || '',
          apiKey: ai.ai_api_key || '',
          model: ai.ai_model || '',
        }
      : undefined,
    apiKey,
  };
}

/** 读取明文备份文档。备份全程无加密、无密钥依赖。 */
function openPayload(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('无法识别的备份文件格式');
  if (Array.isArray(doc.events) || Array.isArray(doc.gifts)) return doc;
  throw new Error('无法识别的备份文件格式');
}

async function handleExportBackup(env, account, origin) {
  const { events, gifts } = await loadAccountData(env, account);

  // 全栈备份：连同该账号的 AI 配置与（明文）接口密钥一起导出，
  // 换实例部署后可一键恢复（AI 模型服务/小程序绑定），不必重新配置。
  let ai = null;
  let apiKey = null;
  if (account.startsWith('user:') || account.startsWith('phone:')) {
    const aiRow = await env.DB.prepare(
      'SELECT ai_base_url, ai_api_key, ai_model FROM account_settings WHERE account = ?'
    )
      .bind(account)
      .first();
    // 仅当确有配置时才写入备份（注册时生成的全空默认行不备份）
    if (aiRow && (aiRow.ai_base_url || aiRow.ai_api_key || aiRow.ai_model)) ai = aiRow;
    const keyRow = await env.DB.prepare(
      'SELECT key, port, created_at FROM account_keys WHERE phone = ? ORDER BY created_at DESC LIMIT 1'
    )
      .bind(accountPhone(account))
      .first();
    if (keyRow) apiKey = { key: keyRow.key, apiPort: keyRow.port, createdAt: keyRow.created_at };
  } else {
    const deviceId = accountDevice(account);
    const s = await env.DB.prepare(
      'SELECT ai_base_url, ai_api_key, ai_model, api_key, api_port, api_key_created_at FROM device_settings WHERE device_id = ?'
    )
      .bind(deviceId)
      .first();
    // 仅当确有配置时才写入备份（全空行不备份）
    ai = s && (s.ai_base_url || s.ai_api_key || s.ai_model) ? s : null;
    if (s && s.api_key) apiKey = { key: s.api_key, apiPort: s.api_port || 0, createdAt: s.api_key_created_at || '' };
  }

  const payload = buildPayload(account, events, gifts, ai, apiKey);
  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="gift-ledger-backup-${todayStr()}.json"`,
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}

async function handleImportBackup(request, env, account, origin) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return fail('请求格式错误', 400, origin);
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail('请选择备份文件', 400, origin);

  let doc;
  try {
    doc = JSON.parse(await file.text());
  } catch {
    return fail('备份文件不是有效的 JSON', 400, origin);
  }

  let payload;
  try {
    payload = openPayload(doc);
  } catch (e) {
    return fail(e && e.message ? e.message : '备份文件无法解析', 400, origin);
  }
  if (!payload) return fail('备份文件内容不完整', 400, origin);

  const now = nowIso();
  const incomingEvents = Array.isArray(payload.events) ? payload.events : [];
  const incomingGifts = Array.isArray(payload.gifts) ? payload.gifts : [];

  const existingEvents = await env.DB.prepare('SELECT id, type, date FROM events WHERE account = ?')
    .bind(account)
    .all();
  const eventByKey = new Map((existingEvents.results || []).map((e) => [`${e.type}\u0000${e.date}`, e.id]));

  const statements = [];
  const eventIdMap = new Map();
  let importedEvents = 0;
  let skippedEvents = 0;

  for (const ev of incomingEvents) {
    if (!ev || typeof ev !== 'object') continue;
    const type = EVENT_TYPES.has(ev.type) ? ev.type : 'other';
    const date = isValidDate(ev.date) ? ev.date : null;
    if (!date) continue;
    const key = `${type}\u0000${date}`;
    let targetId = eventByKey.get(key);
    if (targetId) {
      skippedEvents++;
    } else {
      targetId = crypto.randomUUID();
      eventByKey.set(key, targetId);
      statements.push(
        env.DB.prepare(
          `INSERT INTO events (id, device_id, account, name, type, date, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(targetId, '', account, asString(ev.name, 60).trim() || EVENT_LABELS[type], type, date, now)
      );
      importedEvents++;
    }
    if (ev.id) eventIdMap.set(String(ev.id), targetId);
  }

  const existingGifts = await env.DB.prepare(
    `SELECT event_id, person, direction, amount_fen, date, note, relation FROM gifts WHERE account = ?`
  )
    .bind(account)
    .all();
  const giftKeys = new Set(
    (existingGifts.results || []).map((g) =>
      [g.event_id, g.person, g.direction, g.amount_fen, g.date, g.note || '', g.relation || ''].join('\u0001')
    )
  );

  let importedGifts = 0;
  let skippedGifts = 0;

  for (const g of incomingGifts) {
    if (!g || typeof g !== 'object') continue;
    const person = asString(g.person, 80).trim();
    const direction = g.direction === 'in' || g.direction === 'out' ? g.direction : null;
    const amountFen = Number(g.amountFen);
    const date = isValidDate(g.date) ? g.date : null;
    if (!person || !direction || !Number.isInteger(amountFen) || amountFen <= 0 || !date) {
      skippedGifts++;
      continue;
    }

    let eventId = eventIdMap.get(String(g.eventId));
    if (!eventId) eventId = eventByKey.get(`other\u0000${date}`) || null;
    if (!eventId) {
      skippedGifts++;
      continue;
    }

    const relation = RELATIONS.has(g.relation) ? g.relation : '朋友';
    const note = asString(g.note, 500).trim();
    const method = METHODS.has(g.method) ? g.method : 'cash';
    const dedupeKey = [eventId, person, direction, amountFen, date, note, relation].join('\u0001');
    if (giftKeys.has(dedupeKey)) {
      skippedGifts++;
      continue;
    }
    giftKeys.add(dedupeKey);

    statements.push(
      env.DB.prepare(
        `INSERT INTO gifts
         (id, device_id, account, event_id, person, relation, direction, amount_fen, method, date, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), '', account, eventId, person, relation, direction, amountFen, method, date, note, now)
    );
    importedGifts++;
  }

  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }

  // 全栈备份恢复：AI 配置与接口密钥（仅当备份内含对应字段；旧备份无则跳过）
  let restored = 0;
  const isPhoneAccount = account.startsWith('user:') || account.startsWith('phone:');
  if (payload.ai && (payload.ai.baseUrl || payload.ai.model || payload.ai.apiKey)) {
    const ai = payload.ai;
    const base = asString(ai.baseUrl, 300).trim();
    const model = asString(ai.model, 120).trim();
    const aiKey = asString(ai.apiKey, 500).trim();
    if (isPhoneAccount) {
      await env.DB.prepare(
        `INSERT INTO account_settings (account, ai_base_url, ai_api_key, ai_model) VALUES (?, ?, ?, ?)
         ON CONFLICT(account) DO UPDATE SET
           ai_base_url = excluded.ai_base_url,
           ai_api_key = excluded.ai_api_key,
           ai_model = excluded.ai_model`
      )
        .bind(account, base, aiKey, model)
        .run();
    } else {
      const deviceId = accountDevice(account);
      await env.DB.prepare(
        `INSERT INTO device_settings (device_id, ai_base_url, ai_api_key, ai_model) VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           ai_base_url = excluded.ai_base_url,
           ai_api_key = excluded.ai_api_key,
           ai_model = excluded.ai_model`
      )
        .bind(deviceId, base, aiKey, model)
        .run();
    }
    restored++;
  }
  if (payload.apiKey && payload.apiKey.key) {
    const ak = payload.apiKey;
    const port = Number(ak.apiPort) || 0;
    if (isPhoneAccount) {
      // key 是全局主键：备份里的密钥可能仍属于导出方账号，先清掉其它账号的同名记录，
      // 否则跨账号导入会撞主键（UNIQUE constraint failed: account_keys.key）。
      await env.DB.prepare('DELETE FROM account_keys WHERE key = ?').bind(ak.key).run();
      await env.DB.prepare('DELETE FROM account_keys WHERE phone = ?')
        .bind(accountPhone(account))
        .run();
      await env.DB.prepare('INSERT INTO account_keys (key, phone, port, created_at) VALUES (?, ?, ?, ?)')
        .bind(ak.key, accountPhone(account), port, nowIso())
        .run();
    } else {
      const deviceId = accountDevice(account);
      await env.DB.prepare(
        `INSERT INTO device_settings (device_id, api_key, api_port, api_key_created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           api_key = excluded.api_key,
           api_port = excluded.api_port,
           api_key_created_at = excluded.api_key_created_at`
      )
        .bind(deviceId, ak.key, port, nowIso())
        .run();
    }
    restored++;
  }

  return jsonRes({ importedEvents, importedGifts, skippedEvents, skippedGifts, restored }, 200, origin);
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    try {
      return await apiRequest(request, env);
    } catch (e) {
      // 兜底自愈：请求触发"数据库缺表/缺结构"（D1 error code 1101，常见于
      // 全新部署尚未建表、或旧库升级）时，自动执行 ensureSchema 并重试一次。
      // 这样即使部署钩子不可用/未触发，站点也能自动把表建好，无需进控制台。
      if (isNoSchemaError(e) && env.DB) {
        try {
          await ensureSchema(env.DB);
          return await apiRequest(request, env);
        } catch (e2) {
          console.error('auto-ensureSchema retry failed', e2 && e2.stack ? e2.stack : e2);
        }
      }
      console.error('unhandled error', e && e.stack ? e.stack : e);
      const origin = request.headers.get('Origin');
      return fail('服务暂时不可用，请稍后再试', 500, origin);
    }
  },
};

async function apiRequest(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const path = url.pathname.replace(/\/+$/, '') || '/';

    // 非 /api/* 的请求由静态资源（Worker Assets）处理；这里做兜底。
    if (!url.pathname.startsWith('/api/')) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return fail('页面不存在', 404, origin);
    }

    try {
      if (path === '/api/health' && request.method === 'GET') {
        // 数据库体检：dbReady=false 表示核心表尚未建好（全新部署且自愈未跑过）。
        // 任意 /api 请求遇到缺表会自动 ensureSchema 补建，这里仅用于部署后快速确认。
        let dbReady = true;
        if (env.DB) {
          try {
            dbReady = await isDbReady(env.DB);
          } catch {
            dbReady = false;
          }
        }
        return jsonRes(
          {
            ok: true,
            service: 'xiaozhou-ledger-web',
            time: nowIso(),
            dbReady,
          },
          200,
          origin
        );
      }

      // ---- 账号管理（无需已有身份）----
      if (path === '/api/account/register' && request.method === 'POST') {
        const identity = await resolveIdentity(request, env);
        return handleAccountRegister(request, env, identity, origin);
      }
      if (path === '/api/account/login' && request.method === 'POST') {
        return handleAccountLogin(request, env, origin);
      }
      if (path === '/api/account/check' && request.method === 'GET') {
        return handleAccountCheck(request, env, origin);
      }
      // ---- 管理后台（账号密码登录，独立于普通用户体系）----
      if (path === '/api/admin/login' && request.method === 'POST') {
        return handleAdminLogin(request, env, origin);
      }
      if (path.startsWith('/api/admin/')) {
        if (!(await verifyAdminToken(request, env))) {
          return fail('管理员身份无效或已过期，请重新登录', 401, origin);
        }
        if (path === '/api/admin/users' && request.method === 'GET') {
          return handleAdminUsers(env, origin);
        }
        if (path === '/api/admin/user/create' && request.method === 'POST') {
          return handleAdminUserCreate(request, env, origin);
        }
        if (path === '/api/admin/user/update' && request.method === 'POST') {
          return handleAdminUserUpdate(request, env, origin);
        }
        if (path === '/api/admin/user/delete' && request.method === 'POST') {
          return handleAdminUserDelete(request, env, origin);
        }
        if (path === '/api/admin/export-all' && request.method === 'GET') {
          return handleAdminExportAll(env, origin);
        }
        if (path === '/api/admin/import-all' && request.method === 'POST') {
          return handleAdminImportAll(request, env, origin);
        }
      }

      // 忘记 PIN/密码：管理员重置（新体系密码）/ 清空账号（需 X-Admin-Key 与 env.ADMIN_KEY 匹配）
      if (path === '/api/admin/reset-password' && request.method === 'POST') {
        return handleAdminResetPassword(request, env, origin);
      }
      if (path === '/api/admin/purge-account' && request.method === 'POST') {
        return handleAdminPurge(request, env, origin);
      }

      const identity = await resolveIdentity(request, env);
      if (!identity.account) {
        return fail('未登录或接口密钥无效', 401, origin);
      }
      // 旧 PIN 体系账号（phone:）访问需继续校验 PIN（X-Ledger-Pin）；新体系（user:）靠 JWT。
      if (identity.account.startsWith('phone:') && !identity.viaKey) {
        const pin = (request.headers.get('X-Ledger-Pin') || '').trim();
        const ok = await verifyPin(env, identity.phone, pin);
        if (!ok) return fail('PIN 不正确', 403, origin);
      }
      await ensureIdentity(env, identity);
      const account = accOf(identity);

      if (path === '/api/session' && request.method === 'GET') {
        return handleSession(env, identity, origin);
      }

      if (path === '/api/account/device' && request.method === 'DELETE') {
        return handleAccountUnbindDevice(request, env, identity, origin);
      }

      // 个人中心：修改昵称 / 密码 / 绑定手机号（均需已登录账号）
      if (path === '/api/account/profile' && request.method === 'POST') {
        return handleProfileUpdate(request, env, identity, origin);
      }
      if (path === '/api/account/password' && request.method === 'POST') {
        return handlePasswordChange(request, env, identity, origin);
      }
      if (path === '/api/account/phone' && request.method === 'POST') {
        return handlePhoneChange(request, env, identity, origin);
      }

      if (path === '/api/events') {
        if (request.method === 'GET') return handleEventsGet(env, account, origin);
        if (request.method === 'POST') return handleEventsCreate(request, env, account, origin);
      }

      if (path.startsWith('/api/events/')) {
        const eventId = decodeURIComponent(path.slice('/api/events/'.length));
        if (eventId) {
          if (request.method === 'POST') return handleEventUpdate(request, env, account, eventId, origin);
          if (request.method === 'DELETE') return handleEventDelete(env, account, eventId, origin);
        }
      }

      if (path === '/api/gifts') {
        if (request.method === 'GET') return handleGiftsGet(request, env, account, origin);
        if (request.method === 'POST') return handleGiftsCreate(request, env, account, origin);
      }

      if (path.startsWith('/api/gifts/')) {
        const giftId = decodeURIComponent(path.slice('/api/gifts/'.length));
        if (giftId) {
          if (request.method === 'GET') return handleGiftGet(env, account, giftId, origin);
          if (request.method === 'PUT') return handleGiftsUpdate(request, env, account, giftId, origin);
          if (request.method === 'DELETE') return handleGiftsDelete(env, account, giftId, origin);
        }
      }

      if (path === '/api/overview' && request.method === 'GET') {
        return handleOverview(env, account, origin);
      }
      if (path === '/api/people' && request.method === 'GET') {
        return handlePeople(env, account, origin);
      }
      if (path === '/api/report/yearly' && request.method === 'GET') {
        return handleYearlyReport(request, env, account, origin);
      }
      if (path === '/api/export/csv' && request.method === 'GET') {
        return handleExportCsv(request, env, account, origin);
      }

      if (path === '/api/ai/config') {
        if (request.method === 'GET') return handleAiConfigGet(env, account, origin);
        if (request.method === 'POST') return handleAiConfigSave(request, env, account, origin);
      }
      if (path === '/api/ai/parse' && request.method === 'POST') {
        return handleAiParse(request, env, account, origin);
      }

      if (path === '/api/apikey' && request.method === 'GET') {
        return handleApiKeyGet(env, account, origin);
      }
      if (path === '/api/apikey/rotate' && request.method === 'POST') {
        return handleApiKeyRotate(env, account, origin);
      }
      if (path === '/api/apikey/port' && request.method === 'POST') {
        return handleApiKeyPort(request, env, account, origin);
      }

      if (path === '/api/feedback' && request.method === 'POST') {
        return handleFeedback(request, env, account, origin);
      }

      if (path === '/api/export/backup' && request.method === 'GET') {
        return handleExportBackup(env, account, origin);
      }
      if (path === '/api/import/backup' && request.method === 'POST') {
        return handleImportBackup(request, env, account, origin);
      }

      if (path === '/api/membership' && request.method === 'GET') {
        return handleMembership(origin);
      }
      if (
        (path === '/api/membership/order' || path === '/api/membership/order/status') &&
        request.method === 'POST'
      ) {
        return fail('当前为永久完整版，无需购买', 400, origin);
      }

      return fail('接口不存在', 404, origin);
    } catch (e) {
      // 让错误冒到外层 fetch：缺表(1101)时由外层自动 ensureSchema 并重试一次
      throw e;
    }
  }
