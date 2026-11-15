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

const ALLOWED_ORIGINS = new Set([
  'https://rq.fuxicun.top',
  'http://rq.fuxicun.top',
]);

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type,X-Ledger-Token,X-Ledger-Phone,X-Ledger-Pin,X-Api-Key,X-Token,Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

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

function todayStr() {
  return new Date().toISOString().slice(0, 10);
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

/* ------------------------------------------------------------------ */
/* PIN / 恢复码                                                        */
/* ------------------------------------------------------------------ */

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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

function recoveryCode(phone, pin) {
  return `恢复码：${sha256Hex(`${phone}|${pin}|recovery`).slice(0, 8).toUpperCase()}`;
}

/* ------------------------------------------------------------------ */
/* 身份解析                                                            */
/* ------------------------------------------------------------------ */

async function resolveIdentity(request, env) {
  const deviceId = getDeviceId(request);
  const phoneRaw = (request.headers.get('X-Ledger-Phone') || '').trim();
  const phone = /^\d{5,20}$/.test(phoneRaw) ? phoneRaw : null;

  let account = null;
  let viaKey = false;

  if (phone) {
    const exists = await env.DB.prepare('SELECT 1 AS x FROM accounts WHERE phone = ?')
      .bind(phone)
      .first();
    account = exists ? `phone:${phone}` : null;
  }

  if (!account) {
    const apiKey = getApiKeyHeader(request);
    if (apiKey) {
      let row = await env.DB.prepare('SELECT phone FROM account_keys WHERE key = ?')
        .bind(apiKey)
        .first();
      if (row) {
        account = `phone:${row.phone}`;
        viaKey = true;
      } else {
        row = await env.DB.prepare('SELECT device_id FROM device_settings WHERE api_key = ?')
          .bind(apiKey)
          .first();
        if (row && row.device_id) {
          const b = await env.DB.prepare('SELECT phone FROM device_bindings WHERE device_id = ?')
            .bind(row.device_id)
            .first();
          account = b ? `phone:${b.phone}` : `dev:${row.device_id}`;
          viaKey = true;
        }
      }
    }
  }

  if (!account && deviceId) {
    const b = await env.DB.prepare('SELECT phone FROM device_bindings WHERE device_id = ?')
      .bind(deviceId)
      .first();
    if (b) {
      // 已绑定设备：该浏览器之前登录过此手机号，等同“记住此设备”，免 PIN。
      account = `phone:${b.phone}`;
      viaKey = true;
    } else {
      account = `dev:${deviceId}`;
    }
  }

  return {
    deviceId,
    phone,
    account,
    viaKey,
    isPhone: Boolean(account && account.startsWith('phone:') && !viaKey),
  };
}

async function ensureIdentity(env, identity) {
  const { deviceId, account } = identity;
  if (account && account.startsWith('phone:')) {
    if (deviceId) {
      await env.DB.prepare('INSERT OR IGNORE INTO device_bindings (device_id, phone, created_at) VALUES (?, ?, ?)')
        .bind(deviceId, account.slice(6), nowIso())
        .run();
    }
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

/* ------------------------------------------------------------------ */
/* 账号：注册 / 登录 / 恢复码 / 重置 PIN / 解绑设备                    */
/* ------------------------------------------------------------------ */

function validPhone(phone) {
  return /^\d{5,20}$/.test(phone);
}

function validPin(pin) {
  return /^\d{4,16}$/.test(pin);
}

async function handleAccountRegister(request, env, identity, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = asString(body.phone, 20).trim();
  const pin = asString(body.pin, 20).trim();
  if (!validPhone(phone)) return fail('请输入正确的手机号', 400, origin);
  if (!validPin(pin)) return fail('PIN 需为 4-16 位数字', 400, origin);

  const exists = await env.DB.prepare('SELECT 1 AS x FROM accounts WHERE phone = ?')
    .bind(phone)
    .first();
  if (exists) return fail('该手机号已注册，请直接登录', 409, origin);

  const salt = crypto.randomUUID();
  const pinHash = `${salt}|${await hashPin(pin, salt)}`;
  const recoveryHash = await sha256Hex(`${phone}|${pin}|recovery`);

  const account = `phone:${phone}`;
  await env.DB.prepare('INSERT INTO accounts (phone, pin_hash, recovery_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind(phone, pinHash, recoveryHash, nowIso())
    .run();
  await env.DB.prepare('INSERT OR IGNORE INTO account_settings (account) VALUES (?)')
    .bind(account)
    .run();

  // 把当前浏览器的游客数据并入手机号账号
  let importEvents = 0;
  let importGifts = 0;
  const guestAcc = identity.deviceId ? `dev:${identity.deviceId}` : null;
  if (body.importDevice && guestAcc) {
    const g1 = await env.DB.prepare('UPDATE events SET account = ? WHERE account = ?')
      .bind(account, guestAcc)
      .run();
    const g2 = await env.DB.prepare('UPDATE gifts SET account = ? WHERE account = ?')
      .bind(account, guestAcc)
      .run();
    importEvents = (g1.meta && g1.meta.changes) || 0;
    importGifts = (g2.meta && g2.meta.changes) || 0;
  }

  // 遗留的设备接口密钥并入账号密钥
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

  if (identity.deviceId) {
    await env.DB.prepare('INSERT OR IGNORE INTO device_bindings (device_id, phone, created_at) VALUES (?, ?, ?)')
      .bind(identity.deviceId, phone, nowIso())
      .run();
  }

  const recovery = (await sha256Hex(`${phone}|${pin}|recovery`)).slice(0, 8).toUpperCase();
  return jsonRes(
    {
      phone,
      registered: true,
      importedEvents: importEvents,
      importedGifts: importGifts,
      recoveryCode: recovery,
      hint:
        importEvents + importGifts > 0
          ? '本浏览器已有数据已并入账号'
          : '请保存恢复码，忘记 PIN 时可用它重置',
    },
    200,
    origin
  );
}

async function verifyPin(env, phone, pin) {
  const acc = await env.DB.prepare('SELECT pin_hash FROM accounts WHERE phone = ?')
    .bind(phone)
    .first();
  if (!acc) return false;
  // pin_hash 存储格式：salt|hash
  const [salt, hash] = String(acc.pin_hash).split('|');
  const computed = await hashPin(pin, salt);
  return computed === hash;
}

async function handleAccountLogin(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = asString(body.phone, 20).trim();
  const pin = asString(body.pin, 20).trim();
  if (!validPhone(phone)) return fail('请输入正确的手机号', 400, origin);

  const acc = await env.DB.prepare('SELECT 1 AS x FROM accounts WHERE phone = ?')
    .bind(phone)
    .first();
  if (!acc) return fail('该手机号未注册，请切换到注册', 404, origin);

  const ok = await verifyPin(env, phone, pin);
  if (!ok) return fail('PIN 不正确', 403, origin);

  return jsonRes({ phone, loggedIn: true }, 200, origin);
}

async function handleAccountCheck(request, env, origin) {
  const url = new URL(request.url);
  const phone = url.searchParams.get('phone') || '';
  if (!validPhone(phone)) return fail('请输入手机号', 400, origin);
  const acc = await env.DB.prepare('SELECT 1 AS x FROM accounts WHERE phone = ?')
    .bind(phone)
    .first();
  return jsonRes({ phone, registered: Boolean(acc) }, 200, origin);
}

async function handleAccountRecovery(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = asString(body.phone, 20).trim();
  const pin = asString(body.pin, 20).trim();
  const acc = await env.DB.prepare('SELECT 1 AS x FROM accounts WHERE phone = ?')
    .bind(phone)
    .first();
  if (!acc) return fail('该手机号未注册', 404, origin);
  const ok = await verifyPin(env, phone, pin);
  if (!ok) return fail('PIN 不正确', 403, origin);
  return jsonRes({ code: (await sha256Hex(`${phone}|${pin}|recovery`)).slice(0, 8).toUpperCase() }, 200, origin);
}

async function handleAccountReset(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = asString(body.phone, 20).trim();
  const code = asString(body.recovery, 16).trim().toUpperCase();
  const newPin = asString(body.pin, 20).trim();
  if (!validPhone(phone)) return fail('请输入正确的手机号', 400, origin);
  if (!validPin(newPin)) return fail('新 PIN 需为 4-16 位数字', 400, origin);

  const acc = await env.DB.prepare('SELECT * FROM accounts WHERE phone = ?')
    .bind(phone)
    .first();
  if (!acc) return fail('该手机号未注册', 404, origin);

  // 恢复码校验：注册/重置时存了 recovery_hash = sha256(phone|pin|recovery)，
  // 用户凭恢复码（前 8 位）即可重置 PIN。
  const stored = acc.recovery_hash;
  if (!stored || stored.slice(0, 8).toUpperCase() !== code) {
    return fail('恢复码不正确', 403, origin);
  }

  const salt = crypto.randomUUID();
  const pinHash = `${salt}|${await hashPin(newPin, salt)}`;
  const recoveryHash = await sha256Hex(`${phone}|${newPin}|recovery`);
  await env.DB.prepare('UPDATE accounts SET pin_hash = ?, recovery_hash = ? WHERE phone = ?')
    .bind(pinHash, recoveryHash, phone)
    .run();
  return jsonRes({ phone, reset: true }, 200, origin);
}

async function handleAccountUnbindDevice(request, env, identity, origin) {
  if (!identity.isPhone || !identity.deviceId) return fail('未登录或无设备标识', 401, origin);
  const pin = (request.headers.get('X-Ledger-Pin') || '').trim();
  const ok = await verifyPin(env, identity.phone, pin);
  if (!ok) return fail('PIN 不正确', 403, origin);
  await env.DB.prepare('DELETE FROM device_bindings WHERE device_id = ? AND phone = ?')
    .bind(identity.deviceId, identity.phone)
    .run();
  return jsonRes({ unbound: true }, 200, origin);
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

async function handleSession(env, identity, origin) {
  const { account, phone, isPhone } = identity;
  let username = '访客';
  let auth = { loggedIn: false, guest: true, newPhone: false };

  if (isPhone) {
    username = maskPhone(phone);
    auth = { loggedIn: true, phone, guest: false };
  } else if (phone) {
    // 传了手机号但未注册
    auth = { loggedIn: false, phone, guest: false, newPhone: true };
  }

  return jsonRes(
    {
      username,
      uid: account ? account : `dev-${(identity.deviceId || '').slice(0, 8)}`,
      mode: 'dev',
      gateway: {
        configured: true,
        loggedIn: isPhone,
        error: isPhone ? '' : '未登录手机号账号',
      },
      // 网页版由自建 Worker 提供完整功能，直接视为已开通永久版。
      membership: { lifetime: true, priceFen: 1990 },
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
  await env.DB.prepare(
    `INSERT INTO events (id, device_id, account, name, type, date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(event.id, '', account, event.name, event.type, event.date, event.createdAt)
    .run();
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
  await env.DB.prepare('DELETE FROM gifts WHERE event_id = ? AND account = ?')
    .bind(eventId, account)
    .run();
  const events = await env.DB.prepare('DELETE FROM events WHERE id = ? AND account = ?')
    .bind(eventId, account)
    .run();
  if (!events.meta || events.meta.changes === 0) return fail('活动不存在', 404, origin);
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
  const year = new Date().toISOString().slice(0, 4);

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
  const nowYear = String(new Date().getFullYear());
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

async function callChat(baseUrl, apiKey, model, messages, maxTokens) {
  const payload = { model, messages, temperature: 0.2, stream: false };
  if (maxTokens) payload.max_tokens = maxTokens;

  let res;
  try {
    res = await fetch(chatEndpoint(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    return { ok: false, error: `AI 服务连接失败：${e && e.message ? e.message : e}` };
  }

  if (!res.ok) {
    let detail = '';
    try {
      const data = await res.json();
      detail = (data && data.error && data.error.message) || (data && data.message) || '';
    } catch {
      /* ignore */
    }
    if (res.status === 429) return { ok: false, error: 'AI 服务返回 429（请求过于频繁），请稍后再试' };
    return { ok: false, error: `AI 服务返回 ${res.status}${detail ? `：${detail}` : ''}` };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: 'AI 服务返回内容不是有效 JSON' };
  }
  return { ok: true, data };
}

async function getAiSettings(env, account) {
  if (account.startsWith('phone:')) {
    return env.DB.prepare('SELECT * FROM account_settings WHERE account = ?')
      .bind(account)
      .first();
  }
  const deviceId = account.slice(4);
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
  if (!test.ok) return fail(test.error, 400, origin);

  if (account.startsWith('phone:')) {
    await env.DB.prepare(
      'UPDATE account_settings SET ai_base_url = ?, ai_api_key = ?, ai_model = ? WHERE account = ?'
    )
      .bind(baseUrl, apiKey, model, account)
      .run();
  } else {
    await env.DB.prepare(
      'UPDATE device_settings SET ai_base_url = ?, ai_api_key = ?, ai_model = ? WHERE device_id = ?'
    )
      .bind(baseUrl, apiKey, model, account.slice(4))
      .run();
  }

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
  if (!result.ok) return fail(result.error, 502, origin);

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

  if (account.startsWith('phone:')) {
    const phone = account.slice(6);
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
      .bind(account.slice(4))
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

  if (account.startsWith('phone:')) {
    const phone = account.slice(6);
    await env.DB.prepare('DELETE FROM account_keys WHERE phone = ?').bind(phone).run();
    await env.DB.prepare('INSERT INTO account_keys (key, phone, port, created_at) VALUES (?, ?, 0, ?)')
      .bind(key, phone, nowIso())
      .run();
  } else {
    const deviceId = account.slice(4);
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
  if (account.startsWith('phone:')) {
    await env.DB.prepare('UPDATE account_keys SET port = ? WHERE phone = ?')
      .bind(port, account.slice(6))
      .run();
  } else {
    await env.DB.prepare('UPDATE device_settings SET api_port = ? WHERE device_id = ?')
      .bind(port, account.slice(4))
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
/* ------------------------------------------------------------------ */

function b64encode(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function b64decode(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importBackupKey(env) {
  const secret = env.BACKUP_SECRET;
  if (!secret) throw new Error('服务端未配置备份密钥 BACKUP_SECRET');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`xiaozhou-ledger-backup-v1:${secret}`)
  );
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function sealPayload(env, account, events, gifts) {
  const key = await importBackupKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify({ version: 1, exportedAt: nowIso(), events, gifts }))
  );
  return {
    app: 'gift-ledger',
    kind: 'full',
    alg: 'AES-256-GCM',
    version: 1,
    nonce: b64encode(iv),
    data: b64encode(new Uint8Array(ciphertext)),
    exportedAt: nowIso(),
    account,
  };
}

async function openPayload(env, doc) {
  if (doc && doc.app === 'gift-ledger' && doc.alg === 'AES-256-GCM' && typeof doc.data === 'string') {
    const key = await importBackupKey(env);
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64decode(doc.nonce || '') },
        key,
        b64decode(doc.data)
      );
      return JSON.parse(new TextDecoder().decode(plain));
    } catch {
      throw new Error('备份文件解密失败：不是本服务导出的备份');
    }
  }
  if (doc && (Array.isArray(doc.events) || Array.isArray(doc.gifts))) return doc;
  throw new Error('无法识别的备份文件格式');
}

async function handleExportBackup(env, account, origin) {
  const { events, gifts } = await loadAccountData(env, account);
  const sealed = await sealPayload(env, account, events, gifts);
  return new Response(JSON.stringify(sealed), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="gift-ledger-backup-${todayStr()}.enc.json"`,
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
    payload = await openPayload(env, doc);
  } catch (e) {
    return fail(e && e.message ? e.message : '备份文件无法解析', 400, origin);
  }
  if (!payload || (!Array.isArray(payload.events) && !Array.isArray(payload.gifts))) {
    return fail('备份文件内容不完整', 400, origin);
  }

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

  return jsonRes({ importedEvents, importedGifts, skippedEvents, skippedGifts }, 200, origin);
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
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
        return jsonRes({ ok: true, service: 'xiaozhou-ledger-web', time: nowIso() }, 200, origin);
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
      if (path === '/api/account/recovery' && request.method === 'POST') {
        return handleAccountRecovery(request, env, origin);
      }
      if (path === '/api/account/reset' && request.method === 'POST') {
        return handleAccountReset(request, env, origin);
      }

      const identity = await resolveIdentity(request, env);
      if (!identity.account) {
        return fail('未登录或接口密钥无效', 401, origin);
      }
      // 手机号账号：无接口密钥时必须校验 PIN（X-Ledger-Pin）。
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
      console.error('unhandled error', e && e.stack ? e.stack : e);
      return fail('服务暂时不可用，请稍后再试', 500, origin);
    }
  },
};
