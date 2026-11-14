/**
 * 人情录 Web 版后端 —— Cloudflare Worker + D1
 *
 * 前端（GitHub Pages）通过 X-Ledger-Token 携带匿名设备标识，
 * 每个浏览器的账本相互独立；数据存放在 D1。
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

const RELATIONS = new Set(['朋友', '亲戚', '同事', '同学', '邻居', '其他']);
const METHODS = new Set(['cash', 'wechat', 'alipay', 'other']);

const ALLOWED_ORIGINS = new Set([
  'https://rq.fuxicun.top',
  'https://zhoudedi.github.io',
]);

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Ledger-Token',
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
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  return token;
}

/* ------------------------------------------------------------------ */
/* 数据访问                                                            */
/* ------------------------------------------------------------------ */

async function ensureDevice(env, deviceId) {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO devices (id, created_at) VALUES (?, ?)'
  )
    .bind(deviceId, nowIso())
    .run();
  await env.DB.prepare(
    'INSERT OR IGNORE INTO device_settings (device_id) VALUES (?)'
  )
    .bind(deviceId)
    .run();
}

async function getSettings(env, deviceId) {
  return env.DB.prepare('SELECT * FROM device_settings WHERE device_id = ?')
    .bind(deviceId)
    .first();
}

const GIFT_COLUMNS = `id, event_id AS eventId, person, relation, direction,
  amount_fen AS amountFen, method, date, note, created_at AS createdAt`;

const EVENT_COLUMNS = `id, name, type, date, created_at AS createdAt`;

/* ------------------------------------------------------------------ */
/* 会话 / 事件 / 礼金                                                   */
/* ------------------------------------------------------------------ */

async function handleSession(env, deviceId, origin) {
  // 原应用依赖飞牛OS 用户体系；Web 版使用匿名设备身份。
  return jsonRes(
    {
      username: '我',
      uid: `web-${deviceId.slice(0, 8)}`,
      mode: 'dev',
      gateway: {
        configured: true,
        loggedIn: false,
        error: '网页版为独立部署，无需云端网关',
      },
      // 网页版由自建 Worker 提供完整功能，直接视为已开通永久版。
      membership: { lifetime: true, priceFen: 1990 },
    },
    200,
    origin
  );
}

async function handleEventsGet(env, deviceId, origin) {
  const { results } = await env.DB.prepare(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE device_id = ?
     ORDER BY date DESC, created_at DESC, id DESC`
  )
    .bind(deviceId)
    .all();
  return jsonRes(results || [], 200, origin);
}

async function handleEventsCreate(request, env, deviceId, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);

  const type = EVENT_TYPES.has(body.type) ? body.type : 'other';
  const date = isValidDate(body.date) ? body.date : null;
  if (!date) return fail('活动日期格式需为 YYYY-MM-DD', 400, origin);
  const name = asString(body.name, 60).trim() || EVENT_LABELS[type];

  const existing = await env.DB.prepare(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE device_id = ? AND type = ? AND date = ? LIMIT 1`
  )
    .bind(deviceId, type, date)
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
    `INSERT INTO events (id, device_id, name, type, date, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(event.id, deviceId, event.name, event.type, event.date, event.createdAt)
    .run();
  return jsonRes(event, 200, origin);
}

async function handleGiftsGet(request, env, deviceId, origin) {
  const url = new URL(request.url);
  const clauses = ['device_id = ?'];
  const params = [deviceId];

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

async function validateGiftBody(body, env, deviceId) {
  if (!body) return { error: '请求内容格式错误' };
  const person = asString(body.person, 80).trim();
  if (!person) return { error: '请填写往来对象' };

  const eventId = asString(body.eventId, 64);
  if (!eventId) return { error: '缺少活动信息' };
  const event = await env.DB.prepare(
    'SELECT id FROM events WHERE id = ? AND device_id = ?'
  )
    .bind(eventId, deviceId)
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

async function handleGiftsCreate(request, env, deviceId, origin) {
  const body = await readJson(request);
  const { error, value } = await validateGiftBody(body, env, deviceId);
  if (error) return fail(error, 400, origin);

  const gift = {
    id: crypto.randomUUID(),
    ...value,
    createdAt: nowIso(),
  };
  await env.DB.prepare(
    `INSERT INTO gifts
     (id, device_id, event_id, person, relation, direction, amount_fen, method, date, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      gift.id,
      deviceId,
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

async function handleGiftsUpdate(request, env, deviceId, giftId, origin) {
  const body = await readJson(request);
  const { error, value } = await validateGiftBody(body, env, deviceId);
  if (error) return fail(error, 400, origin);

  const result = await env.DB.prepare(
    `UPDATE gifts SET event_id = ?, person = ?, relation = ?, direction = ?,
       amount_fen = ?, method = ?, date = ?, note = ?
     WHERE id = ? AND device_id = ?`
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
      deviceId
    )
    .run();
  if (!result.meta || result.meta.changes === 0) {
    return fail('记录不存在或无权限修改', 404, origin);
  }

  const gift = await env.DB.prepare(
    `SELECT ${GIFT_COLUMNS} FROM gifts WHERE id = ? AND device_id = ?`
  )
    .bind(giftId, deviceId)
    .first();
  return jsonRes(gift, 200, origin);
}

async function handleGiftsDelete(env, deviceId, giftId, origin) {
  const result = await env.DB.prepare(
    'DELETE FROM gifts WHERE id = ? AND device_id = ?'
  )
    .bind(giftId, deviceId)
    .run();
  if (!result.meta || result.meta.changes === 0) {
    return fail('记录不存在或无权限删除', 404, origin);
  }
  return jsonRes({ deleted: true }, 200, origin);
}

/* ------------------------------------------------------------------ */
/* AI 模型                                                             */
/* ------------------------------------------------------------------ */

function chatEndpoint(baseUrl) {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
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
    if (res.status === 429) {
      return { ok: false, error: 'AI 服务返回 429（请求过于频繁），请稍后再试' };
    }
    return {
      ok: false,
      error: `AI 服务返回 ${res.status}${detail ? `：${detail}` : ''}`,
    };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: 'AI 服务返回内容不是有效 JSON' };
  }
  return { ok: true, data };
}

async function handleAiConfigGet(env, deviceId, origin) {
  const s = await getSettings(env, deviceId);
  const baseUrl = (s && s.ai_base_url) || '';
  const model = (s && s.ai_model) || '';
  const configured = Boolean(baseUrl && model && s.ai_api_key);
  return jsonRes({ baseUrl, model, configured }, 200, origin);
}

async function handleAiConfigSave(request, env, deviceId, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);

  const baseUrl = asString(body.baseUrl, 300).trim().replace(/\/+$/, '');
  const model = asString(body.model, 120).trim();
  const apiKeyInput = asString(body.apiKey, 500).trim();

  if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
    return fail('接口地址需以 http:// 或 https:// 开头', 400, origin);
  }
  if (!model) return fail('请填写模型名称', 400, origin);

  const s = await getSettings(env, deviceId);
  const apiKey = apiKeyInput || (s && s.ai_api_key) || '';
  if (!apiKey) return fail('首次配置需填写 API Key', 400, origin);

  const test = await callChat(baseUrl, apiKey, model, [
    { role: 'user', content: '请只回复两个字：正常' },
  ]);
  if (!test.ok) return fail(test.error, 400, origin);

  await env.DB.prepare(
    `UPDATE device_settings SET ai_base_url = ?, ai_api_key = ?, ai_model = ?
     WHERE device_id = ?`
  )
    .bind(baseUrl, apiKey, model, deviceId)
    .run();

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
    const amount = typeof raw.amountYuan === 'number'
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
    records.push({
      direction,
      person,
      relation,
      amountYuan,
      eventType,
      date,
      note: asString(raw.note, 500).trim(),
    });
  }

  for (const item of sourceErrors) {
    const msg = asString(item, 300).trim();
    if (msg) errors.push(msg);
  }
  return { records, errors };
}

async function handleAiParse(request, env, deviceId, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const text = asString(body.text, 4000).trim();
  if (!text) return fail('请先输入要解析的内容', 400, origin);

  const s = await getSettings(env, deviceId);
  if (!s || !s.ai_base_url || !s.ai_model || !s.ai_api_key) {
    return fail('请先在「设置 → AI 模型」中配置模型', 400, origin);
  }

  const result = await callChat(
    s.ai_base_url,
    s.ai_api_key,
    s.ai_model,
    [
      { role: 'system', content: buildParsePrompt() },
      { role: 'user', content: text },
    ],
    2000
  );
  if (!result.ok) return fail(result.error, 502, origin);

  const content = result.data && result.data.choices && result.data.choices[0]
    && result.data.choices[0].message
    ? result.data.choices[0].message.content
    : '';
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
/* 接口密钥（小程序绑定保留接口，Web 版暂不直接使用）                    */
/* ------------------------------------------------------------------ */

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function handleApiKeyGet(env, deviceId, origin) {
  const s = await getSettings(env, deviceId);
  return jsonRes(
    {
      configured: Boolean(s && s.api_key_hash),
      apiPort: (s && s.api_port) || 0,
      createdAt: (s && s.api_key_created_at) || '',
    },
    200,
    origin
  );
}

async function handleApiKeyRotate(env, deviceId, origin) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const key = `gl_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const hash = await sha256Hex(key);
  await env.DB.prepare(
    `UPDATE device_settings SET api_key_hash = ?, api_key_created_at = ?
     WHERE device_id = ?`
  )
    .bind(hash, nowIso(), deviceId)
    .run();
  return jsonRes({ key }, 200, origin);
}

async function handleApiKeyPort(request, env, deviceId, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const raw = asString(body.port, 10).trim();
  let port = 0;
  if (raw && raw !== '0') {
    port = Number.parseInt(raw, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return fail('端口需为 1-65535 的数字', 400, origin);
    }
  }
  await env.DB.prepare('UPDATE device_settings SET api_port = ? WHERE device_id = ?')
    .bind(port, deviceId)
    .run();
  return jsonRes({ apiPort: port }, 200, origin);
}

/* ------------------------------------------------------------------ */
/* 意见反馈 / 会员                                                      */
/* ------------------------------------------------------------------ */

async function handleFeedback(request, env, deviceId, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const content = asString(body.content, 1000).trim();
  const contact = asString(body.contact, 200).trim();
  if (!content) return fail('反馈内容不能为空', 400, origin);

  await env.DB.prepare(
    'INSERT INTO feedback (device_id, content, contact, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(deviceId, content, contact, nowIso())
    .run();
  return jsonRes({ ok: true }, 200, origin);
}

async function handleMembership(origin) {
  return jsonRes({ lifetime: true, priceFen: 1990 }, 200, origin);
}

/* ------------------------------------------------------------------ */
/* 备份导出 / 导入                                                      */
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
  const secret = env.BACKUP_SECRET || 'xiaozhou-ledger-default-backup-key';
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`xiaozhou-ledger-backup-v1:${secret}`)
  );
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function sealPayload(env, payload) {
  const key = await importBackupKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(payload))
  );
  return {
    app: 'gift-ledger',
    kind: 'full',
    alg: 'AES-256-GCM',
    version: 1,
    nonce: b64encode(iv),
    data: b64encode(new Uint8Array(ciphertext)),
    exportedAt: nowIso(),
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

async function handleExportBackup(env, deviceId, origin) {
  const [eventsResult, giftsResult] = await Promise.all([
    env.DB.prepare(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE device_id = ? ORDER BY date ASC`
    )
      .bind(deviceId)
      .all(),
    env.DB.prepare(
      `SELECT ${GIFT_COLUMNS} FROM gifts WHERE device_id = ? ORDER BY date ASC, created_at ASC`
    )
      .bind(deviceId)
      .all(),
  ]);

  const sealed = await sealPayload(env, {
    version: 1,
    exportedAt: nowIso(),
    events: eventsResult.results || [],
    gifts: giftsResult.results || [],
  });

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

async function handleImportBackup(request, env, deviceId, origin) {
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

  const existingEvents = await env.DB.prepare(
    'SELECT id, type, date FROM events WHERE device_id = ?'
  )
    .bind(deviceId)
    .all();
  const eventByKey = new Map(
    (existingEvents.results || []).map((e) => [`${e.type}\u0000${e.date}`, e.id])
  );

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
          `INSERT INTO events (id, device_id, name, type, date, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          targetId,
          deviceId,
          asString(ev.name, 60).trim() || EVENT_LABELS[type],
          type,
          date,
          now
        )
      );
      importedEvents++;
    }
    if (ev.id) eventIdMap.set(String(ev.id), targetId);
  }

  const existingGifts = await env.DB.prepare(
    `SELECT event_id, person, direction, amount_fen, date, note, relation
     FROM gifts WHERE device_id = ?`
  )
    .bind(deviceId)
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
    if (!eventId) {
      eventId = eventByKey.get(`other\u0000${date}`) || null;
    }
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
         (id, device_id, event_id, person, relation, direction, amount_fen, method, date, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(),
        deviceId,
        eventId,
        person,
        relation,
        direction,
        amountFen,
        method,
        date,
        note,
        now
      )
    );
    importedGifts++;
  }

  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }

  return jsonRes(
    { importedEvents, importedGifts, skippedEvents, skippedGifts },
    200,
    origin
  );
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

    try {
      if (path === '/api/health' && request.method === 'GET') {
        return jsonRes(
          { ok: true, service: 'xiaozhou-ledger-api', time: nowIso() },
          200,
          origin
        );
      }

      const deviceId = getDeviceId(request);
      if (!deviceId) {
        return fail('缺少设备身份，请刷新页面后重试', 401, origin);
      }
      await ensureDevice(env, deviceId);

      if (path === '/api/session' && request.method === 'GET') {
        return handleSession(env, deviceId, origin);
      }

      if (path === '/api/events') {
        if (request.method === 'GET') return handleEventsGet(env, deviceId, origin);
        if (request.method === 'POST') return handleEventsCreate(request, env, deviceId, origin);
      }

      if (path === '/api/gifts') {
        if (request.method === 'GET') return handleGiftsGet(request, env, deviceId, origin);
        if (request.method === 'POST') return handleGiftsCreate(request, env, deviceId, origin);
      }

      if (path.startsWith('/api/gifts/')) {
        const giftId = decodeURIComponent(path.slice('/api/gifts/'.length));
        if (giftId) {
          if (request.method === 'PUT') return handleGiftsUpdate(request, env, deviceId, giftId, origin);
          if (request.method === 'DELETE') return handleGiftsDelete(env, deviceId, giftId, origin);
        }
      }

      if (path === '/api/ai/config') {
        if (request.method === 'GET') return handleAiConfigGet(env, deviceId, origin);
        if (request.method === 'POST') return handleAiConfigSave(request, env, deviceId, origin);
      }
      if (path === '/api/ai/parse' && request.method === 'POST') {
        return handleAiParse(request, env, deviceId, origin);
      }

      if (path === '/api/apikey' && request.method === 'GET') {
        return handleApiKeyGet(env, deviceId, origin);
      }
      if (path === '/api/apikey/rotate' && request.method === 'POST') {
        return handleApiKeyRotate(env, deviceId, origin);
      }
      if (path === '/api/apikey/port' && request.method === 'POST') {
        return handleApiKeyPort(request, env, deviceId, origin);
      }

      if (path === '/api/feedback' && request.method === 'POST') {
        return handleFeedback(request, env, deviceId, origin);
      }

      if (path === '/api/export/backup' && request.method === 'GET') {
        return handleExportBackup(env, deviceId, origin);
      }
      if (path === '/api/import/backup' && request.method === 'POST') {
        return handleImportBackup(request, env, deviceId, origin);
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
