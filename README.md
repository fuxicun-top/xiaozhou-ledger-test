# 人情录 · Cloudflare 单域名版

> 将「人情录」桌面/飞牛OS 应用的前端与接口迁移为 **Cloudflare 单域名部署**：静态前端、API、数据库全部跑在 Cloudflare 上，数据存自己的 **D1**，不依赖 NAS。
>
> 参考部署（本仓库 owner）：<https://rq.fuxicun.top>。fork 本仓库即可按同样方式部署到自己的 Cloudflare 账号。

## 功能与账号模型（跨设备同一本账）

- **手机号 + PIN 账号**：首次「注册」输入手机号并设 4–16 位 PIN。之后在**任何浏览器、任何设备**登录同一手机号，看到同一本账；登录后本浏览器被记住（设备绑定），再次访问免输 PIN。
- **忘记 PIN**：两条路：① 联系部署管理员，由其用管理员密钥重置 PIN；② 重新注册该手机号——需**二次点击确认**，会清空该手机号名下全部数据，之后设一个新 PIN 继续使用。
- **游客**：不登录也能用，数据属于本机浏览器（`dev:<设备>`）。换浏览器后这些数据"消失"，但注册手机号时可勾选**把本浏览器已有数据并入账号**找回；也可用「导出加密备份 → 导入」迁移。
- **微信小程序 / 第三方客户端**：在「设置 → 接口密钥」生成密钥（`X-Api-Key`），与手机号账号读写同一本账。

> PIN 只存于**你自己的** Cloudflare D1（服务端只存哈希）。忘记 PIN 时：联系部署管理员（用管理员密钥重置），或重新注册该手机号（清空名下数据，二次点击确认执行）。

## 管理员密钥（可选）

忘记 PIN 的后台重置接口需要管理员密钥。部署者在 Cloudflare 控制台为 Worker 设置 Secret `ADMIN_KEY`（任意随机串）后，可用：

```bash
# 重置某账号的 PIN
curl -X POST https://你的域名/api/admin/reset-pin \
  -H "Content-Type: application/json" -H "X-Admin-Key: <你的 ADMIN_KEY>" \
  -d '{"phone":"13800000000","pin":"1234"}'

# 清空某账号（删账号及名下全部数据，账号方可重新注册）
curl -X POST https://你的域名/api/admin/purge-account \
  -H "Content-Type: application/json" -H "X-Admin-Key: <你的 ADMIN_KEY>" \
  -d '{"phone":"13800000000"}'
```

未设置 `ADMIN_KEY` 时这两个接口拒绝所有请求。

## 架构

```
浏览器 / 微信小程序 / 第三方客户端
        │  https://你的域名（页面） + https://你的域名/api（接口）
        ▼
Cloudflare Worker（托管静态前端 + API 逻辑）
        ├─ /api/*  → API（按手机号账号作用域）
        └─ 其他    → 静态前端（Worker Assets，来自 www/）
        │
        ▼
Cloudflare D1（你自己的数据库实例，数据完全隔离）
```

- `www/`：前端静态资源（React SPA 编译产物，已提交仓库，**无需本地构建前端**）。
- `src/index.js`：后端 Worker，覆盖 Web 端与小程序所需的 HTTP API。
- 根级 `wrangler.toml`：D1 绑定与静态资源配置。
- `schema.sql` / `migrate-account.sql`：数据库表结构。

---

## 从零部署（跟着做一遍即可）

**前置**：一个 Cloudflare 账号（免费版即可）+ Node.js 18+。域名可选：

- **无自有域名**：直接用 Cloudflare 提供的 `*.workers.dev` 子域（免费，HTTPS）；
- **有自有域名**：加一条「已代理」DNS 记录并绑到 Worker 上。

### 1. 创建 D1 数据库并初始化表结构

```bash
# 安装 Cloudflare CLI（需要 wrangler 5+）
npm install -g wrangler     # 或每次 npx wrangler

# 登录（浏览器授权，关联你自己的 CF 账号）
npx wrangler login

# 创建数据库（名字随意），把输出里的 database_id 填入 wrangler.toml
npx wrangler d1 create my-ledger
#   └─> 编辑 wrangler.toml：
#       [[d1_databases]]
#       binding = "DB"
#       database_name = "my-ledger"
#       database_id = "<上一步输出的 uuid>"

# 建表
npx wrangler d1 execute my-ledger --remote --file=schema.sql
# migrate-account.sql 仅老库升级用，全新部署跳过
```

> **通过 Cloudflare 网页控制台做也行**：Databases → D1 → Create → New Database，然后 `D1 → 你的库 → 远程 → 查询` 直接粘贴执行 `schema.sql` 的内容。

### 2. 设置备份密钥

```bash
npx wrangler secret put BACKUP_SECRET
# 输入一个足够长的随机字符串（用于「导出/导入加密备份」的加解密），记好
```

也可在 控制台 → Workers → 你的 Worker → Settings → Variables → Encrypted Secrets 里设置。

### 3. 部署 Worker

```bash
npx wrangler deploy
# 首次部署会提示创建 Worker；成功后输出 URL，形如 https://<worker>.<子域>.workers.dev
# 访问该 URL 应能看到「人情录」首页（未登录 = 游客模式，可直接记一笔）
```

验证：

```bash
curl https://<你的地址>/api/health
# → {"ok":true,"service":"xiaozhou-ledger-web",...}
```

### 4. （可选）绑定自有域名

控制台 → Workers & Pages → 你的 Worker → **Settings → Domains & Routes**：

- 你的域名已托管在 CF：直接 Add → Custom Domain → 填 `你的域名`（或子域，如 `ledger.example.com`），CF 自动建 DNS 记录；
- 域名不在 CF：CF 会提示在 DNS 服务商添加 `CNAME/AAAA` 记录（照做即可，或把域名整体转入 CF 更省事）。

生效后 `https://你的域名` 即站点地址。

### 5. 注册手机号，绑定设备

1. 打开你的站点，进入「设置 → 账户」，点「绑定手机号（登录 / 注册）」。
2. 点「注册」标签 → 输入 11 位手机号 + 设置 PIN → 提交。
3. 之后换手机/电脑登录同一手机号，即看到同一本账。忘记 PIN：联系部署管理员，或重新注册该手机号（二次点击确认，清空名下数据）。

游客数据想保留：注册时勾选「把本浏览器已有的账本数据并入手机号账号」。

### 6. （可选）绑定微信小程序

「设置 → 接口密钥」→ 生成密钥 → 点「绑定二维码」→ 用小程序「扫码配置」扫一下。密钥可随时更换（旧密钥立即失效）。

---

## 用 GitHub 仓库自动部署（Cloudflare Builds，推荐）

不想每次手动 `wrangler deploy`，可以让 Cloudflare 监听 GitHub 仓库，push 到 `main` 自动构建部署：

1. Fork 本仓库到你自己的 GitHub 账号（**fork 后你的部署与你 owner 的数据完全隔离**——数据在你自己的 D1，代码只是载体）。
2. 在你的 fork 里把 `wrangler.toml` 的 `database_id` 换成你第 1 步创建的自己 D1 的 id，并 commit + push（这一步必须在 CF 连接仓库前完成，或连接后在 CF 的 Builds 环境里改也行，但改仓库最直接）。
3. 在 Cloudflare 控制台：**Workers & Pages → 你的 Worker → Settings → Builds → Connect to Git**，授权你的 GitHub 账号，选你的 fork、分支 `main`。
4. 构建命令保持默认的 `npm install && npx wrangler deploy`（仓库根级 `wrangler.toml` 会被自动识别，前端产物已在 `www/`，无额外构建步骤）。
5. 以后任何对 fork 的 push 都会自动拉取、构建、部署。

> 密钥（`BACKUP_SECRET`）只在 CF 控制台管理，**不要**写进仓库。
> 若 CF 账号里还没有这个 Worker（全新账号），先在「Workers & Pages → Create → 任意模板」建一个占位 Worker（名字随意），再走第 3 步把它和你的仓库关联；或直接手动 `wrangler deploy` 一次（第 3 步），Builds 自动接管后续。

## 纯手动部署（不接 Builds）

```bash
npm install

# 若 D1 已存在可跳过；database_id 需与 wrangler.toml 一致
npx wrangler d1 create xiaozhou-ledger-web
npx wrangler d1 execute xiaozhou-ledger-web --remote --file=schema.sql
# 旧库升级到账号体系（全新部署不需要）：
# npx wrangler d1 execute xiaozhou-ledger-web --remote --file=migrate-account.sql

npx wrangler secret put BACKUP_SECRET

# 部署（自动上传 www/ 静态资源 + API）
npx wrangler deploy
```

---

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/account/register` | 注册手机号账号（`phone`/`pin`/`importDevice`；`force=true` 时清空该手机号原有全部数据并重建账号） |
| POST | `/api/account/login` | 登录校验 PIN |
| GET | `/api/account/check?phone=` | 查询手机号是否已注册 |
| DELETE | `/api/account/device` | 解除本机设备绑定（重新要求 PIN） |
| POST | `/api/admin/reset-pin` | 管理员重置 PIN（需 `X-Admin-Key` 匹配 `ADMIN_KEY`） |
| POST | `/api/admin/purge-account` | 管理员清空账号及其全部数据（需 `X-Admin-Key`） |
| GET | `/api/session` | 会话信息（`auth.loggedIn/guest`） |
| GET/POST | `/api/events` | 活动列表 / 新建（按账号+类型+日期去重） |
| POST/DELETE | `/api/events/:id` | 更新 / 删除活动（级联删其礼金） |
| GET/POST | `/api/gifts` | 礼金列表 / 新建 |
| GET/PUT/DELETE | `/api/gifts/:id` | 查询 / 更新 / 删除 |
| GET | `/api/overview` | 总览统计 |
| GET | `/api/people` | 联系人汇总 |
| GET | `/api/report/yearly?year=` | 年度报告 |
| GET | `/api/export/csv?type=` | CSV 导出 |
| GET/POST | `/api/ai/config`、`POST /api/ai/parse` | AI 模型配置 / 解析（需自带模型 API Key） |
| GET/POST | `/api/export/backup`、`/api/import/backup` | 加密备份导出 / 导入（需 `BACKUP_SECRET`） |
| POST | `/api/feedback` | 意见反馈 |
| GET/POST | `/api/apikey`、`/api/apikey/rotate`、`/api/apikey/port` | 接口密钥状态 / 生成 / 端口 |
| GET | `/api/membership` | 会员信息（Web 部署视为永久版） |

**认证头**（按优先级）：`X-Ledger-Phone`(+`X-Ledger-Pin`) → `X-Api-Key`/`X-Token`/`Authorization: Bearer` → 已绑定设备 `X-Ledger-Token` → 游客 `X-Ledger-Token`。手机号账号需 PIN；接口密钥与已绑定设备免 PIN。不同账号数据相互隔离。

**跨域**：默认反射请求方 `Origin`（认证全部走自定义头/令牌，不用 Cookie，反射不扩大攻击面）。如需收紧，把 `src/index.js` 中 `corsHeaders` 改回固定白名单并填入自有域名。

## 已知限制

- 无短信/邮箱验证，手机号仅作为「自报 + PIN」身份；PIN 强度依赖用户自设，服务端只存 PIN 哈希。忘记 PIN 只能由管理员重置或重新注册（清空数据）。
- 微信支付购买入口不可用（Web 部署视为永久版）。
- 小程序客户端源码与原作者云端网关不在本仓库中；服务端已兼容其接口契约，端到端绑定取决于官方小程序是否直连你的配置地址。
- 前端为官方编译产物，未重新打包；仅做了 API 地址、设备标识、二维码协议自适应与账号 UI 注入。

## 版权与致谢

- 应用「人情录」及其前端资源归原作者 [pdf-covert/gift-ledger](https://github.com/pdf-covert/gift-ledger) 所有。本仓库仅用于个人自用部署与技术研究，未获得原作者授权，请勿用于商业分发。
- 后端（`src/index.js`）为根据前端接口契约重新实现的独立作品。
