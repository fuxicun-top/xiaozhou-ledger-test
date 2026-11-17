# 人情录（xiaozhou-gift-ledger）全面测试报告

- **测试日期**：2026-11-17
- **测试方式**：静态代码审查 + `wrangler dev`（本地 miniflare + 本地 D1）实测，共 64 项功能测试
- **环境**：wrangler 4.163.0，Node 20+，未修改任何代码
- **测试环境说明**：本地全新 D1 初始为空库，测试期间通过 `wrangler d1 execute --local --file=schema.sql` 手工建表后完成全部功能测试

---

## 一、总体结论

| 维度 | 结论 |
|---|---|
| 页面/静态资源 | ✅ 全部正常 |
| API 接口（30+ 个） | ✅ 除 1 项外全部正常 |
| 前后端集成 | ✅ 正常（前端调用的 14 个 API 全部联通） |
| 数据读写 | ✅ 正常（增删改查、去重、隔离、备份导入均正常） |
| 配置 | ✅ 正常，发现 1 处 P1 级自愈缺陷 + 若干建议项 |

**发现 1 个 P0 级 Bug（API 密钥手机号截断，导致小程序端数据分裂）、1 个 P1 级 Bug（本地自愈建表失败）。核心记账功能（活动/礼金/统计/备份）全部正常。**

---

## 二、功能测试明细（64 项）

### 1. 静态资源与页面（5/5 正常）

| # | 测试项 | 结果 | 说明 |
|---|---|---|---|
| 1 | GET /（首页） | ✅ 200 | text/html |
| 2 | GET /assets/index-CHaro1Qz.js | ✅ 200 | 634KB React 构建产物 |
| 3 | GET /assets/index-0wU_Pyvo.css | ✅ 200 | |
| 4 | GET /favicon.png | ✅ 200 | |
| 5 | SPA 未知路由回退 | ✅ 200 | 返回 index.html（not_found_handling=single-page-application 生效） |

### 2. 数据库与自愈（发现 P1 问题）

| # | 测试项 | 结果 | 说明 |
|---|---|---|---|
| 6 | 游客首访触发自动建表 | ❌ **失败** | 全新本地库首个 /api 请求返回 500「服务暂时不可用」；日志显示 `ensureSchema` 内 `db.batch(DDL)` 抛 `ZodError: Failed to parse body as JSON`（传的是字符串数组而非 D1PreparedStatement），自愈重试同样失败 → **P1-①** |
| 7 | 手工建表后 /api/health | ✅ | `dbReady:true` |
| — | wrangler d1 execute --local --file=schema.sql | ✅ | 幂等建表成功 |

### 3. 账号体系（10/10 正常）

| # | 测试项 | 结果 | 说明 |
|---|---|---|---|
| 8 | 注册（含游客数据并入） | ✅ | 返回 JWT，7 天有效期 |
| 9 | 重复注册 | ✅ 409 | 「该手机号已注册」 |
| 10 | 弱密码（<8 位） | ✅ 400 | 服务端校验 |
| 11 | 登录 | ✅ | 返回 JWT |
| 12 | 错误密码 | ✅ 403 | |
| 13 | JWT 会话（Bearer） | ✅ | uid=user:13800138000 |
| 60 | JWT 会话（X-Ledger-Auth 头） | ✅ | 备用头方式可用 |
| 14 | 无凭证访问受保护接口 | ✅ 401 | |
| 15 | 伪造 JWT | ✅ 401 | 签名校验生效 |
| 53 | /api/account/check | ✅ | registered:true |
| 58 | 游客数据注册并入 | ✅ | importedEvents:1 |
| 59 | 登录防爆破（20 次失败后） | ✅ 429 | 封禁 5 分钟生效（内存级） |

### 4. 活动 / 礼金 CRUD（12/12 正常）

| # | 测试项 | 结果 |
|---|---|---|
| 16 | 创建活动 | ✅ |
| 17 | 相同类型+日期幂等去重 | ✅ 返回已有活动 |
| 18 | 活动列表 | ✅ |
| 32 | 更新活动（POST /api/events/{id}） | ✅ |
| 49 | 删除活动（级联删除礼金） | ✅ |
| 19/20 | 创建礼金（收/支） | ✅ |
| 21 | 礼金列表 | ✅ |
| 22 | 礼金搜索（q=姓名模糊） | ✅ |
| 23 | 单条礼金查询 | ✅ |
| 24 | 更新礼金（PUT） | ✅ |
| 48 | 删除礼金 | ✅ |
| 47 | 游客设备间数据隔离 | ✅ |

### 5. 输入校验（5/5 正常）

| # | 测试项 | 结果 |
|---|---|---|
| 25 | 负数金额 | ✅ 400 |
| 26 | 非法日期（2026-13-45） | ✅ 400 |
| 27 | 不存在的活动引用 | ✅ 400 |
| 10 | 弱密码 | ✅ 400 |
| 38 | 空反馈内容 | ✅ 400 |

### 6. 统计 / 导出（4/4 正常）

| # | 测试项 | 结果 |
|---|---|---|
| 28 | /api/overview 总览 | ✅ 收支/结余/Top5 计算正确 |
| 29 | /api/people 联系人汇总 | ✅ |
| 30 | /api/report/yearly 年度报告 | ✅ 按类型/月份汇总正确 |
| 31 | /api/export/csv | ✅ 含 BOM、Excel 中文兼容、CSV 转义正确 |

### 7. 接口密钥（发现 P0 问题）

| # | 测试项 | 结果 | 说明 |
|---|---|---|---|
| 33 | /api/apikey/rotate 生成密钥 | ✅（表象正常） | |
| 34 | /api/apikey 查询 | ✅（表象正常） | |
| 35 | /api/apikey/port 端口设置 | ✅ | |
| 36 | X-Api-Key 访问 session | ❌ **严重错误** | uid 返回 `user:3800138000`——手机号 13800138000 被截断首位数字 → **P0-①** |
| 40 | X-Api-Key 查询礼金 | ❌ **返回空列表** | 数据存于 `user:13800138000`，密钥却映射到 `user:3800138000`，小程序端读到一本空账 → **P0-① 数据分裂** |
| 41 | account_keys 表数据 | ❌ | phone 字段存的是 `3800138000`（截断值） |

### 8. 反馈 / 会员 / 其他（6/6 正常）

| # | 测试项 | 结果 |
|---|---|---|
| 37 | 提交意见反馈 | ✅ |
| 39 | /api/membership | ✅ lifetime:true |
| 45 | 未知 API 路径 | ✅ 404「接口不存在」 |
| 46 | 不支持的方法（DELETE /api/events） | ✅ 404 |
| 57 | 设备解绑（DELETE /api/account/device） | ✅ |
| 62 | 尾斜杠容错（/api/events/） | ✅ |

### 9. 备份导出 / 导入

| # | 测试项 | 结果 | 说明 |
|---|---|---|---|
| 42 | /api/export/backup | ⚠️ 500 | 未配置 `BACKUP_SECRET`（README 已声明必设），但报错文案是笼统的「服务暂时不可用」，未提示缺配置 → **P2-①** |
| 50 | 旧版明文 JSON 备份导入 | ✅ | importedEvents:1, importedGifts:1 |
| 52 | 重复导入去重 | ✅ | skipped:1/1，幂等 |

### 10. CORS（2/2 正常）

| # | 测试项 | 结果 |
|---|---|---|
| 43 | OPTIONS 预检 | ✅ 204 |
| 44 | 响应头 Origin 反射 | ✅ | 任意 Origin 反射（代码内有注释说明为有意设计，配合令牌认证） |

---

## 三、发现的问题（按优先级）

### 🔴 P0-① API 密钥账号手机号截断 —— 小程序端数据分裂

- **文件**：`src/index.js` 第 341 行 `accountPhone()`：
  ```js
  if (account.startsWith('user:') || account.startsWith('phone:')) return account.slice(5 + 1);
  ```
- **原因**：`"user:"` 前缀长度是 5，`slice(5 + 1)` = `slice(6)`，把手机号第一位切掉了；`"phone:"` 前缀才是 6。
- **实测证据**：注册 13800138000 → rotate 生成密钥 → `account_keys.phone` 存入 `3800138000` → X-Api-Key 请求解析为 `user:3800138000` → 礼金列表为空（JWT 用户数据在 `user:13800138000` 下）。
- **影响范围**（所有调用 `accountPhone()` 的路径）：
  - `handleApiKeyRotate / handleApiKeyPort / handleApiKeyGet`（src/index.js:1507、1566、1698 等）——密钥写入/查询的 phone 全部截断；
  - `handleAccountUnbindDevice`（:647）；
  - `handleExportBackup` 中接口密钥导出（:1700）；
  - `resolveIdentity`（:283）中 API-Key 用户的 `phone` 字段。
- **建议修改**（一处改动即可）：
  ```js
  if (account.startsWith('user:')) return account.slice(5);
  if (account.startsWith('phone:')) return account.slice(6);
  ```
- **修复后还需数据修复**：已部署库中 `account_keys.phone` 可能已存截断值，需要一条 UPDATE 修正（可复用现有正则定位受影响行）。

### 🟠 P1-① ensureSchema 本地自愈建表失败

- **文件**：`src/db/schema.js` 第 123 行 `await db.batch(DDL)`
- **原因**：`DDL` 是**字符串数组**，而 D1 `batch()` 要求 `D1PreparedStatement[]`。本地 miniflare 代理直接抛 `ZodError: Failed to parse body as JSON`。README 承诺的「fork 后无需建表、首个请求自动建表」在本地环境（以及任何 batch 不接受字符串的运行时）失效。
- **建议修改**：
  ```js
  for (const stmt of DDL) await db.prepare(stmt).run();  // 或 DDL.map(s => db.prepare(s)) 后再 batch
  ```
  （`prepare()` 之后再 `batch` 可同时保住原子性，两种环境都安全。）

### 🟡 P2 级问题

1. **备份导出缺 BACKUP_SECRET 时报笼统 500**（src/index.js:1620 抛错后被外层兜底成「服务暂时不可用」）。建议捕获后在 `handleExportBackup` 入口先检查 `env.BACKUP_SECRET`，返回 400 + 明确提示「请先配置 BACKUP_SECRET」。**位置**：`src/index.js:1618-1626`、外层 `:1909-1928`。
2. **JWT 默认密钥内置**（src/index.js:213-215）：`JWT_SECRET` 未设置时用硬编码默认值，公网部署可被伪造 token（README 有提示但代码不强制）。建议：生产环境未设置时拒绝签发/校验，或启动时 `console.warn`。
3. **前端无源码 + DOM 猴子补丁维护风险**：仓库只有编译后的 `www/assets/index-CHaro1Qz.js`（634KB 压缩产物），无前端工程源码；`www/index.html`（及完全重复的 `404.html`）内 ~500 行脚本用 `MutationObserver` + `setInterval(800ms)` 反复向 React 渲染的 DOM 注入按钮、改文案（`injectLedgerPanel`）。React 结构一变就静默失效。建议：前端源码入库（GitHub 仓库），把账号面板做进 React 组件而不是运行时打补丁。
4. **www/404.html 与 index.html 全文重复**：SPA 模式下未匹配路由一律回退 index.html，`404.html` 实际永远不会被服务（实测 `/missing.txt` 返回 200 index.html），却要和 index.html 同步维护两份内联脚本。建议删除或改为构建产物。

### 🟢 P3 级（低优先 / 记录备用）

1. **todayStr/nowIso 使用 UTC**（src/index.js:86-88）：东八区 00:00–08:00 之间，AI 解析默认日期、年度统计的「今年」会差一天/差一年。建议按用户时区（+08:00）计算。
2. **登录防爆破为内存级**（src/index.js:361，代码注释已自知）：Worker 实例重启/多 PoP 隔离即清零，只能缓解。如需持久封禁可落到 D1/KV。
3. **密码哈希为迭代 HMAC**（1000/2000 轮，src/index.js:144-163）：非内存困难哈希（PBKDF2/scrypt），受 Workers API 限制属折中方案；已有加盐，个人部署威胁模型下可接受。
4. **CORS 反射任意 Origin**（src/index.js:49-61）：注释已说明设计意图（令牌认证、无 Cookie），可接受；若收紧可改白名单。
5. **/api/ 根路径返回 401 而非 404**：空 `/api/` 规范化成 `/api` 后落入鉴权分支。行为无害，仅不一致。
6. **handleEventDelete 先删礼金再删活动**（src/index.js:774-783）：若活动本身不存在（404），名下礼金已被删。正常流程不可能出现（礼金创建时已校验活动归属），边界场景顺序问题。
7. **package.json 无 lint/test/format 脚本**，`wrangler ^4.0.0` 范围较宽；建议锁定或加 `wrangler --dry-run` 的 CI 检查。

---

## 四、代码规范与结构审查

| 检查项 | 结论 |
|---|---|
| SQL 注入 | ✅ 全部查询使用 `prepare().bind()` 参数化，无拼接风险（gifts 过滤条件子句拼接的是占位符，参数走 bind） |
| schema.sql ↔ src/db/schema.js 一致性 | ✅ 逐表比对一致（表/索引/默认值均相同） |
| wrangler.toml | ✅ D1 绑定、assets、`run_worker_first=["/api/*"]`、observability 配置正确；`compatibility_date=2026-11-14` 合理 |
| 幂等性 | ✅ 建表 IF NOT EXISTS；活动 (account,type,date) 唯一索引 + 业务幂等返回；导入去重 |
| 错误兜底 | ✅ 外层 try/catch + 500 兜底；`isNoSchemaError` 自愈设计（本地因 P1-① 失效） |
| 敏感信息 | ✅ .gitignore 排除 .dev.vars/.env；仓库无密钥泄露 |
| README | ✅ 环境变量、部署步骤、API 文档齐全，与代码行为一致（含「BACKUP_SECRET 必设」等） |
| 前后端契约 | ✅ 前端 bundle 实际调用 14 个 API 全部实现且行为匹配；服务端另有 overview/people/yearly/csv/events 编辑删除等接口供小程序/第三方使用（Web 前端在客户端自行计算统计） |

---

## 五、优先级修改建议汇总（待确认后实施）

| 优先级 | 问题 | 文件:行 | 修改方案 |
|---|---|---|---|
| P0 | accountPhone 截断 user: 手机号 → API 密钥数据分裂 | src/index.js:341 | slice(5)/slice(6) 分支修正 + account_keys 存量数据 UPDATE |
| P1 | ensureSchema batch 字符串数组本地失败 | src/db/schema.js:123 | 改为 `DDL.map(s => db.prepare(s))` 后 batch（或循环 run） |
| P2 | 备份导出缺 BACKUP_SECRET 报笼统 500 | src/index.js:1618 | 入口前置检查返回 400 明确提示 |
| P2 | JWT_SECRET 默认值不强制 | src/index.js:213 | 未设置时告警或拒绝签发 |
| P2 | 前端无源码 + DOM 猴子补丁 | www/index.html | 前端工程源码入库，账号面板组件化 |
| P3 | 时区（UTC→+08:00） | src/index.js:86 | todayStr 按东八区计算 |

> 以上均为建议，**未实施任何修改**。请确认要处理的项（建议至少处理 P0 与 P1），我再动手。

---

## 六、修复实施记录（2026-11-17 09:00 用户确认后实施）

| 项 | 状态 | 修改内容 | 回归验证 |
|---|---|---|---|
| P0-① | ✅ 已修复 | `src/index.js` accountPhone() 改为 `user:`→slice(5)、`phone:`→slice(6) 分支取值 | R6/R7/R8：account_keys 存完整手机号；X-Api-Key uid=`user:13700137000`；礼金 total=1 ✅ |
| P0-① 数据修复 | ✅ 新增 `fix-account-keys.sql` | 检查 + 幂等 UPDATE（按 users 表补全截断手机号，含残留行提示） | R12–R14：模拟截断→数据不可见→执行脚本→数据恢复 ✅ |
| P1-① | ✅ 已修复 | `src/db/schema.js` ensureSchema 改为 `DDL.map(s => db.prepare(s))` 后 batch | R1/R2：全新本地 D1 首个请求自动建表成功，dbReady=true ✅ |
| P2-① | ✅ 已修复 | handleExportBackup 入口前置检查 `env.BACKUP_SECRET`，返回 400 + 明确提示 | R15：HTTP 400「服务端未配置备份密钥…」 ✅ |
| P2-② | ✅ 已修复 | jwtSecret() 未设置 JWT_SECRET 时 console.warn（保留默认值兼容，不破坏现有部署） | 日志告警逻辑已就位 |
| P3-① 时区 | ✅ 已修复 | 新增 cnDate()/thisYear()（东八区），todayStr、总览年度、年度报告改用 | 代码审查确认，语法检查通过 |
| P2-③ 前端源码 | ⏸ 未实施 | 需要 React 工程源码入库并组件化账号面板（本仓库只有编译产物，无法在此完成） | — |
| P2-④ 404.html 重复 | ⏸ 未实施 | 建议在前端构建流程中处理 | — |

**其余回归**：备份导出/导入加解密往返（R9–R11，AES-256-GCM，restored=1，去重正确）✅

**部署提醒**：代码修复后，**已部署的生产库需执行一次** `npx wrangler d1 execute xiaozhou-ledger-web --remote --file=fix-account-keys.sql`（先跑脚本内 SELECT 核对），然后 `npx wrangler deploy` 发布新代码。README 已补充对应升级说明。

---

## 七、第二轮深度全栈测试与修复（2026-11-17 09:06）

### 第二轮新增测试（D1–D34，含 AI mock 链路）

| 类别 | 覆盖 | 结果 |
|---|---|---|
| 管理员接口 | 重置密码（D2–D5）、清空账号（D34）、错误/缺失 ADMIN_KEY | ✅ |
| 旧 PIN 体系 | PIN 校验（D8/D9）、注册并入 phone: 数据（D30–D33）、迁移后 PIN 失效 | ✅ |
| 认证变体 | 过期 JWT 拒绝（D6）、X-Token / Bearer 携带密钥（D10/D11） | ✅ |
| AI 记账全链路 | mock OpenAI 服务：配置连通性测试（D21）、解析（D23）、错误 key 400（D24）、连不通 400（D25）、429 容忍保存 + 浏览器直连兜底载荷（D27/D28） | ✅ |
| 并发竞态 | 并发创建相同活动（D12）、并发注册相同手机号（D13） | ⚠️ 逻辑存在竞态窗口（见下） |
| 边界 | 活动日期冲突（D14）、各类 404（D15–D17）、会员下单 400（D18）、礼金过滤（D19/D20） | ✅ |

### 第二轮修复（4 项）

| 问题 | 文件 | 修复 |
|---|---|---|
| 活动/注册 SELECT-then-INSERT 并发竞态（撞唯一索引 → 500） | src/index.js | 捕获 UNIQUE 约束错误：活动回读已存在记录返回（保持幂等，F4 验证）；注册返回 409（F5 验证） |
| 删除活动先删礼金后查活动，活动不存在时礼金被误删 | src/index.js handleEventDelete | 先 SELECT 确认活动存在再级联删（F2 验证：礼金数不变） |
| `importDevice:false` 注册仍删除旧 PIN 账号，phone: 数据变孤儿 | src/index.js handleAccountRegister | 仅在并入数据时才停用旧 PIN 账号（F6/F7 验证：PIN 仍可访问） |
| www/404.html 与 index.html 全文重复且永不服务 | 已删除 | F3 验证：/404.html 回退 index.html 200 |

### 第二轮最终冒烟（S1–S9）：会话 / 活动 CRUD / 礼金 CRUD / 统计三件套 / CSV 两种 / API 密钥 / 备份加解密往返 / 反馈 / 游客 → 全部 ✅

### 仍保留未改（有意设计，非缺陷）

- `/api/` 根路径 401 而非 404：鉴权优先于路由匹配的常见模式，行为一致；
- PUT 不存在礼金先报"活动不存在"：校验顺序统一（前端始终携带有效 eventId）；
- CORS 反射任意 Origin、登录防爆破为内存级、密码哈希为迭代 HMAC：均为代码注释/README 已声明的设计取舍。

---

## 八、P2-③ 前端页面完善（2026-11-17 09:20）

### 背景调查

检查了用户提供的飞牛 OS 原始应用包 `E:\下载\gift-ledger-x86-1.2.0\gift-ledger-x86-1.2`：

- `manifest` 指向开源仓库 `github.com/pdf-covert/gift-ledger`，实测该仓库**只是应用介绍与 Releases 发布页**，从不公开源码；
- `app.tgz` 解包内容只有 Go 二进制（`server/gift-ledger`）、编译后的前端 bundle（`www/assets/index-CHaro1Qz.js`，与本项目文件名完全相同）、图标与配置——**原项目同样没有公开的 React 前端源码**。

结论：P2-③「前端工程源码入库 + 组件化改造」无法从原项目获得源码实现。改用「后端字段适配 + bundle 静态修补 + 运行时补丁瘦身」等价方案，消除了该问题的核心危害（脆弱的定时器 DOM 打补丁）。

### 修改内容

| 问题 | 位置 | 处理 |
|---|---|---|
| 设置页「运行模式」显示"开发模式" | `src/index.js` handleSession | `/api/session` 的 `mode` 由 `'cloud'` 改为前端识别的 `'gateway'`（面板原生显示「云端网关」）；`gateway` 增加 `username` 字段（显示「已连接（用户名）」），游客 error 文案改为「未登录账号（当前为游客模式）」 |
| bundle 残留 NAS/内网穿透文案（接口密钥面板说明、端口提示、密钥链路图、备份说明、密钥说明、二维码 alt、config.json 提示、版本号） | `www/assets/index-CHaro1Qz.js` | 9 处文案静态替换为云端版（如「你的 NAS（唯一存储）」→「你的 Cloudflare Worker（唯一存储）」），用 Edit 精确替换（每处仅出现 1 次），模块语法校验通过 |
| 靠 `MutationObserver` + 3 个定时器（800ms/800ms/3000ms）反复改 React DOM 文案 | `www/index.html` | 删除 `patchAccountText`/`patchKeyText` 及相关定时器（共 ~92 行），只保留必要的功能性按钮注入（登录/账号管理入口）；移除死函数 `getLoginName`/`maskPhone`；内联脚本语法校验通过 |

### 验证（V1–V4，全部 ✅）

- V1：登录态 `/api/session` 返回 `mode:'gateway'`、`gateway.username:'回归用户'` → 面板将显示「云端网关 / 已连接（回归用户）」；
- V2：游客态返回 `gateway.loggedIn:false` + 友好提示，uuid 保留 dev: 前缀；
- V3：首页、bundle JS、CSS 静态服务均 200；
- V4：bundle 通过 Worker 服务后新文案可见；ES module 语法校验通过。

### 仍保留

- 「绑定手机号」按钮仍需运行时注入（原前端是闭源编译产物，账号面板本就是本项目新增的功能），但已从"反复改文案"瘦身为"单一幂等按钮挂载"，风险显著降低。
