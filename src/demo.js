/* 首次部署演示数据（seed）
 * 目的：全新实例部署后，自动创建一个可登录的测试账号并填充模拟账本，
 *       方便第一时间查看界面效果，不必先手动注册、逐级录入。
 *
 * 设计要点：
 *  - 以"测试账号是否已存在"为准：全新库和已有真实账号的实例，部署后都会有一个
 *    test 账号用于效果展示；演示数据全部隔离在 user:18000000000 账号下，不影响
 *    任何真实用户。管理员可在后台「用户管理」里看到并按需清空该账号数据。
 *  - 用 admin_settings.demo_seeded 作为标记，配合 INSERT ... 的原子占位防止
 *    Cloudflare 多 isolate 并发重复写入。
 *  - 可用环境变量 DISABLE_DEMO=1 关闭（部署者在 Cloudflare 控制台配置）。
 *  - 全部 best-effort：seed 失败不影响 Worker 正常服务。
 */

const DEMO_PHONE = '18000000000';
const DEMO_PASSWORD = '12345678';
const DEMO_NAME = '演示账号';

// 事由（与 src/index.js 的 EVENT_TYPES / 前端 EVENT_TYPES 一致）
const EVENT_TYPES = ['wedding', 'baby', 'birthday', 'housewarming', 'graduation', 'funeral', 'other'];
const EVENT_LABELS = {
  wedding: '婚礼', baby: '满月', birthday: '生日', housewarming: '乔迁',
  graduation: '升学', funeral: '白事', other: '其他',
};
// 关系（与 RELATIONS 一致）
const RELATIONS = ['朋友', '亲戚', '同事', '同学', '邻居', '其他'];
const METHODS = ['cash', 'wechat', 'alipay', 'other'];

const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '胡', '朱', '高', '林', '何', '郭', '马', '罗', '梁', '宋', '郑', '谢', '韩', '唐', '冯', '于', '董', '萧'];
const GIVEN = ['伟', '芳', '娜', '敏', '静', '丽', '强', '磊', '军', '洋', '勇', '艳', '杰', '娟', '涛', '明', '超', '秀', '霞', '平', '刚', '桂', '文', '辉', '力', '俊', '峰', '燕', '梅', '浩', '宇', '轩', '晨', '雨', '欣', '悦'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function personName() { return pick(SURNAMES) + pick(GIVEN) + (Math.random() < 0.35 ? pick(GIVEN) : ''); }

/** 生成近 12 个月内、格式 YYYY-MM-DD 的随机日期；distinct 用于避开同类型重复日期。 */
function randomDate(used) {
  const now = new Date();
  for (let i = 0; i < 30; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - randInt(1, 360));
    const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!used || !used.has(s)) { if (used) used.add(s); return s; }
  }
  // 兜底：极大概率不会发生
  const d = new Date(now.getTime() - randInt(1, 360) * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 供 index.js 使用的哈希函数占位：由 index.js 注入，避免重复实现加密逻辑。 */
let hashPasswordFn = null;
export function setDemoHasher(fn) { hashPasswordFn = fn; }

/**
 * 确保演示数据存在（幂等、best-effort）。
 * @param {{DB: any, DISABLE_DEMO?: string}} env
 */
export async function ensureDemoData(env) {
  try {
    if (!env || !env.DB) return;
    if (String(env.DISABLE_DEMO || '').toLowerCase() === '1') return;
    if (typeof hashPasswordFn !== 'function') return;

    // 原子占位：只有一个 isolate 能拿到 seed 权（key 不存在时 INSERT 成功 changes=1）
    let claimed;
    try {
      claimed = await env.DB.prepare(
        `INSERT INTO admin_settings (key, value) VALUES ('demo_seeded', 'pending')
         ON CONFLICT(key) DO NOTHING`
      ).run();
    } catch {
      return; // 表还未建好（首次启动自愈前），本次跳过，下次请求会触发
    }
    const changes = claimed && claimed.meta && claimed.meta.changes;
    if (!changes) return; // 已被其他 isolate 占位或已完成

    // 已有测试账号则直接完成（幂等，避免重装/重启后重复写入演示数据）
    const exists = await env.DB.prepare('SELECT 1 AS x FROM users WHERE phone = ?').bind(DEMO_PHONE).first();
    if (exists) {
      await env.DB.prepare(`UPDATE admin_settings SET value = 'done' WHERE key = 'demo_seeded'`).run();
      return;
    }

    const now = new Date().toISOString();
    const salt = crypto.randomUUID();
    const passwordHash = `${salt}|${await hashPasswordFn(DEMO_PASSWORD, salt)}`;
    const account = `user:${DEMO_PHONE}`;

    // 账号
    await env.DB.prepare(
      `INSERT INTO users (phone, name, password_hash, created_at) VALUES (?, ?, ?, ?)`
    ).bind(DEMO_PHONE, DEMO_NAME, passwordHash, now).run();
    await env.DB.prepare('INSERT OR IGNORE INTO account_settings (account) VALUES (?)').bind(account).run();

    // 事由：每种 2 个活动（同类型日期不同）
    const events = [];
    const usedDates = new Set();
    for (const type of EVENT_TYPES) {
      for (let i = 0; i < 2; i++) {
        const date = randomDate(usedDates);
        const ev = {
          id: crypto.randomUUID(),
          name: pick([EVENT_LABELS[type], `${pick(SURNAMES)}家${EVENT_LABELS[type]}`]),
          type, date,
        };
        await env.DB.prepare(
          `INSERT INTO events (id, device_id, account, name, type, date, created_at)
           VALUES (?, '', ?, ?, ?, ?, ?)`
        ).bind(ev.id, account, ev.name, ev.type, ev.date, now).run();
        events.push(ev);
      }
    }

    // 礼金：每个活动 2 条，relation 循环覆盖全部 6 种；金额 100-500 元
    let relIdx = 0;
    for (const ev of events) {
      for (let i = 0; i < 2; i++) {
        const relation = RELATIONS[relIdx++ % RELATIONS.length];
        const amountFen = randInt(100, 500) * 100;
        await env.DB.prepare(
          `INSERT INTO gifts
           (id, device_id, account, event_id, person, relation, direction, amount_fen, method, date, note, created_at)
           VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          crypto.randomUUID(), account, ev.id, personName(), relation,
          Math.random() < 0.62 ? 'out' : 'in', // 随礼（支出）略多于收礼
          amountFen, pick(METHODS), ev.date,
          pick(['随礼', '人情往来', '心意', '恭贺', '节礼', '']), now
        ).run();
      }
    }

    await env.DB.prepare(`UPDATE admin_settings SET value = 'done' WHERE key = 'demo_seeded'`).run();
  } catch (e) {
    // 种子失败不影响服务；把标记改成 failed，避免后续每次请求都重试占坑
    try {
      if (env && env.DB) {
        await env.DB.prepare(`UPDATE admin_settings SET value = 'failed' WHERE key = 'demo_seeded' AND value = 'pending'`).run();
      }
    } catch { /* ignore */ }
    console.error('ensureDemoData failed', e && e.stack ? e.stack : e);
  }
}
