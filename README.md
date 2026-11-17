# 人情录 · Cloudflare 单域名版

> 将「人情录」桌面/飞牛OS 应用的前端与接口迁移为 **Cloudflare 单域名部署**：静态前端、API、数据库全部跑在 Cloudflare 上，数据存自己的 **D1**，不依赖 NAS。
>
> 参考部署（本仓库 owner）：<https://rq.fuxicun.top>。fork 本仓库即可按同样方式部署到自己的 Cloudflare 账号。
>
> **fork 的人只需要看「控制台五步部署」即可上线**：全程网页操作，不用装命令行工具，不用手工建数据库表（Worker 首次访问会自动把表建好），5 分钟搞定。

## 功能与账号模型（跨设备同一本账）

- **手机号 + 密码账号**：注册填手机号 + 密码（8–32 位）+ 可选昵称，登录发 7 天 JWT。之后在**任何浏览器、任何设备**登录同一账号，看到同一本账；JWT 7 天内免输密码，过期重新登录。
- **注册防刷**（部署者可选，控制台 Variables 配置）：`MAX_ACCOUNTS` 限制可注册账号总数、`REGISTER_COOLDOWN_MINUTES` 限制同一设备两次注册的最小间隔。**不设置 = 不限制**，自用部署可以不管。
- **游客**：不登录也能用，数据属于本机浏览器（`dev:<设备>`）。换浏览器后这些数据"消失"，注册账号时**自动并入**本浏览器已有数据（也可用「导出全栈备份 → 导入」迁移）。
- **微信小程序 / 第三方客户端**：在「设置 → 接口密钥」生成密钥（`X-Api-Key`），与账号读写同一本账。

> 密码以加盐迭代哈希存于**你自己的** Cloudflare D1，服务端只存哈希。JWT 密钥默认内置，部署者建议设置 Secret `JWT_SECRET` 自定义（防止 token 伪造）。

> **关于前端**：本项目前端沿用原「人情录」的编译产物（`www/assets/`），已针对云端部署做过静态文案修补（NAS/内网穿透文案改为 Cloudflare Worker + D1），并通过 `/api/session` 的 `mode:'gateway'` 让设置页面板原生显示正确的运行模式；`www/index.html` 中的运行时脚本只保留「登录/账号管理」入口注入。**上游原项目不公开前端源码**，因此请勿指望从上游反向构建；如自行重建前端，保持 `/api/*` 契约与 `window.fetch` 注入逻辑即可。

## 管理员密钥（必须设置）

忘记密码的后台重置、清空账号接口需要管理员密钥，**部署时必设** `ADMIN_KEY`（任意长随机串）。设置后随时可用：

```bash
# 重置某账号的密码
curl -X POST https://你的域名/api/admin/reset-password \
  -H "Content-Type: application/json" -H "X-Admin-Key: <你的 ADMIN_KEY>" \
  -d '{"phone":"13800000000","password":"新密码"}'

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
        ├─ /api/*  → API（按手机号账号作用域；缺表时自动建表后重试一次）
        └─ 其他    → 静态前端（Worker Assets，来自 www/）
        │
        ▼
Cloudflare D1（你自己的数据库实例，数据完全隔离）
```

- `www/`：前端静态资源（React SPA 编译产物，已提交仓库，**无需本地构建前端**）。
- `src/index.js` + `src/db/schema.js`：后端 Worker。`schema.js` 是全部建表语句的"单一事实来源"：请求遇到缺表（D1 error 1101）时自动执行 `ensureSchema` 建齐所有表并重试一次，**全新部署无需任何手工建表步骤**。
- 根级 `wrangler.toml`：D1 绑定与静态资源配置（fork 后需替换 `database_id` 为你自己创建的）。
- `schema.sql`：与 `src/db/schema.js` 保持一致的安装脚本，全部幂等（`IF NOT EXISTS`），可重复执行。**仅在你偏好手工建表时需要**，默认走 Worker 自动建表即可跳过。

---

## 控制台五步部署（fork 者首选，全程网页操作）

**前置**：一个 Cloudflare 账号（免费版即可）+ 你的 GitHub 账号（fork 用）。全程在 <https://dash.cloudflare.com> 完成。

### 第 1 步：创建 D1 数据库

1. 控制台左侧菜单：**Databases → D1**（找不到就在搜索框里输 D1）。
2. **Create a new database → Create database**，名字随意（如 `my-ledger`），Region 随意（如 Americas）。
3. 记下页面显示的 **Database UUID**（`database_id`）——第 3 步要填进 `wrangler.toml`。

> 表结构**不需要**在这里手工建：Worker 上线后第一个 API 请求会自动建齐全部表（自愈机制）。也可以顺手点左侧 **Remote → Queries** 粘贴执行仓库里的 `schema.sql` 提前建好，二选一。

### 第 2 步：fork 仓库并改 `database_id`

1. 到本仓库 GitHub 页面点 **Fork**，fork 到你自己的账号。
2. 在你 fork 的仓库里打开 `wrangler.toml`（网页上直接点 **编辑按钮（铅笔图标）**），把 `database_id` 改成第 1 步拿到的 UUID：

   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "my-ledger"      # 你 D1 的库名
   database_id = "<你的 UUID>"       # ← 改成第 1 步的 UUID
   ```

3. **Commit changes**（提交）。（接 Builds 自动部署的话，这一步必须在第 3 步之前完成。）

### 第 3 步：创建 Worker 并设置密钥

1. 控制台：**Workers & Pages → Create a Worker**（或 Connect to Git，见下文），名字填 `xiaozhou-ledger-web`（与仓库一致，名字可自定）。
   - 若选模板创建，把代码删空没关系，第 4 步接上 GitHub 仓库后会被仓库代码覆盖。
2. 进入你的 Worker 页面 → **Settings → Variables and Secrets**：

   | 类型 | 名称 | 值 | 是否必填 |
   | --- | --- | --- | --- |
   | Encrypted Secret | `ADMIN_KEY` | 任意长随机串（自己生成并记好，界面有"随机生成"按钮） | **必设**（忘记账号密码的后台重置靠它） |
   | Encrypted Secret | `JWT_SECRET` | 任意长随机串 | 建议设（不设用内置默认值，公网部署建议替换） |
   | Variable | `MAX_ACCOUNTS` | 数字，如 `100` | 可选。本实例可注册账号总数上限，防刷满免费配额；**不设 = 不限制** |
   | Variable | `REGISTER_COOLDOWN_MINUTES` | 数字，如 `60` | 可选。同一设备两次注册的最小间隔分钟数；**不设 = 不限制** |

   > 自用部署 `MAX_ACCOUNTS` / `REGISTER_COOLDOWN_MINUTES` 两个可以不填。

### 第 4 步：接 GitHub 仓库自动部署（推荐）或手动部署一次

**方式 A：接 GitHub（以后 push 自动部署，推荐）**

1. 该 Worker 页面 → **Settings → Builds → Connect to Git**，授权你的 GitHub 账号。
2. 选你 **fork 的仓库**、分支 `main`，构建命令保持默认 `npm install && npx wrangler deploy`，保存。
3. 第一次会自动构建部署；以后你 push 任何改动都会自动拉取、构建、部署。

**方式 B：手动部署一次（不装命令行也不行的话，用 CF 网页 IDE 太麻烦，建议本地装 Node）**

```bash
git clone https://github.com/你的用户名/xiaozhou-ledger-web
cd xiaozhou-ledger-web
npm install
npx wrangler deploy
```

### 第 5 步：验证

```bash
curl https://你的Worker地址/api/health
# → {"ok":true,"service":"xiaozhou-ledger-web","dbReady":true,...}
```

- `dbReady: true` 表示数据库表已就绪（首次 `/api` 请求若库是空的，自愈逻辑会先建表再返回）。
- 浏览器打开 Worker 地址（形如 `https://xiaozhou-ledger-web.<你的子域>.workers.dev`），能看到「人情录」首页 = 部署成功。游客模式直接记一笔验证数据读写。

**（可选）绑自有域名**：控制台 → Workers & Pages → 你的 Worker → **Settings → Domains & Routes → Add → Custom Domain**：

- 你的域名已托管在 CF：直接填 `你的域名`（或子域），CF 自动建 DNS；
- 域名不在 CF：按 CF 提示在 DNS 服务商加 `CNAME/AAAA` 记录（或把域名整体转入 CF）。

生效后 `https://你的域名` 即站点地址。

---

## 上手使用

1. 打开站点，进「设置 → 账户」→「绑定手机号」→「注册」：11 位手机号 + 密码（8-32 位）+ 可选昵称。
2. 换手机/电脑登录同一账号，看到同一本账（7 天内免输密码）。忘记密码：部署管理员用 `ADMIN_KEY` 调 `/api/admin/reset-password` 重置。
3. 游客已有数据：注册时自动并入（也可用「导出全栈备份 → 导入」迁移，见下）。
4. （可选）绑小程序：「设置 → 接口密钥」→ 生成密钥 → 扫「绑定二维码」。密钥可随时更换（旧密钥立即失效）。

## 全栈备份（换实例迁移用）

「导出全栈备份」（`/api/export/backup`）导出一个**明文 JSON 文件**，包含该账号的**全部内容**：

- 活动（events）+ 礼金（gifts）；
- AI 配置（接口地址 / 模型 / API Key）；
- 小程序接口密钥（明文密钥 + 端口）。

**不需要任何密钥**：导出/导入都不依赖服务端 Secret。用户 A 导出文件后，换成账号 B 登录后导入，数据自动归属账号 B（按「账号 + 类型 + 日期」去重，已有数据不重复写入）。换实例部署同样直接导入即可，两个实例无需配置相同密钥。

> ⚠️ **备份文件是明文，内含 AI API Key 与小程序接口密钥**——等同于你的账号凭证。请像保管密码一样保管备份文件，不要发到微信群、网盘公开区等地方。任何人拿到备份文件，都能导入并拿到里面的账本和密钥。

## 数据库说明（一般不用管）

- 全部建表语句在 `src/db/schema.js`（单一事实来源，幂等 `IF NOT EXISTS`），`schema.sql` 与其保持一致（控制台手工建表用）。
- **运行期自愈**：任意 `/api` 请求遇到 D1 "no such table"（error 1101，全新部署未建表、或旧库升级缺表）时，自动 `ensureSchema` 建齐全部表并重试一次。你 fork 部署后即使跳过手工建表，第一次访问也自动完成。
- 旧版升级路径：老库（PIN 时代）的 `accounts` 数据在**新账号注册时自动并入** `user:` 体系，无需手工迁移 SQL。

---

## 命令行部署（进阶，可选）

习惯 CLI 的人可以全程命令行（功能等价于上面五步）：

```bash
npm install

# 登录 CF 账号（浏览器授权）
npx wrangler login

# 创建数据库，把输出的 database_id 填入 wrangler.toml
npx wrangler d1 create xiaozhou-ledger-web

# 可选：手工建表（不建也行，Worker 会自动建）
npx wrangler d1 execute xiaozhou-ledger-web --remote --file=schema.sql

# 设置密钥
npx wrangler secret put ADMIN_KEY
npx wrangler secret put JWT_SECRET

# 可选变量（不设=不限制）
npx wrangler secret put MAX_ACCOUNTS                 # 或 Variables 面板填
npx wrangler secret put REGISTER_COOLDOWN_MINUTES

# 部署
npx wrangler deploy
```

验证同第 5 步：`curl https://你的地址/api/health`。

### 从旧版本升级（接口密钥手机号截断修复）

2026-11 之前的版本存在一个缺陷：`/api/apikey/rotate` 等接口把 `account_keys.phone` 写成了**缺首位的截断手机号**（如 `13800138000` → `3800138000`），导致小程序用接口密钥登录时映射到错误账号、看不到自己的数据。代码已修复；**老库需要执行一次数据修复**：

```bash
# 远程库执行（脚本幂等，先跑里面的 SELECT 人工核对，再跑 UPDATE）
npx wrangler d1 execute xiaozhou-ledger-web --remote --file=fix-account-keys.sql
```

执行后用接口密钥调 `/api/session` 确认 `uid` 已是完整的 `user:<手机号>` 即可。

---

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（含 `dbReady` 数据库体检） |
| POST | `/api/account/register` | 注册手机号 + 密码账号（`phone`/`password`/`name`/`importDevice`；受 `MAX_ACCOUNTS`、`REGISTER_COOLDOWN_MINUTES` 限制） |
| POST | `/api/account/login` | 手机号 + 密码登录，发 7 天 JWT |
| GET | `/api/account/check?phone=` | 查询手机号是否已注册 |
| DELETE | `/api/account/device` | 解除本机设备绑定（重新要求登录） |
| POST | `/api/account/profile` | 修改昵称（`name`；需登录，换发 JWT） |
| POST | `/api/account/password` | 修改密码（`oldPassword`/`newPassword`；需登录+验证当前密码） |
| POST | `/api/account/phone` | 更换绑定手机号（`newPhone`/`password`；需登录+验证当前密码，账本数据原子迁移，换发 JWT） |
| POST | `/api/admin/reset-password` | 管理员重置密码（需 `X-Admin-Key` 匹配 `ADMIN_KEY`） |
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
| GET/POST | `/api/export/backup`、`/api/import/backup` | 全栈备份导出 / 导入（明文 JSON，账本 + AI 配置 + 接口密钥；无需密钥） |
| POST | `/api/feedback` | 意见反馈 |
| GET/POST | `/api/apikey`、`/api/apikey/rotate`、`/api/apikey/port` | 接口密钥状态 / 生成 / 端口 |
| GET | `/api/membership` | 会员信息（Web 部署视为永久版） |

**认证头**（按优先级）：`X-Api-Key`/`X-Token`/`Authorization: Bearer`（JWT 或小程序密钥）→ 已绑定设备 `X-Ledger-Token` → 游客 `X-Ledger-Token`。不同账号数据相互隔离。

**跨域**：默认反射请求方 `Origin`（认证全部走自定义头/令牌，不用 Cookie，反射不扩大攻击面）。如需收紧，把 `src/index.js` 中 `corsHeaders` 改回固定白名单并填入自有域名。

## 已知限制

- 无短信/邮箱验证，手机号仅作为"自报 + 密码"身份；密码强度依赖用户自设，服务端只存加盐哈希。忘记密码只能由管理员（`ADMIN_KEY`）重置。
- 微信支付购买入口不可用（Web 部署视为永久版）。
- 小程序客户端源码与原作者云端网关不在本仓库中；服务端已兼容其接口契约，端到端绑定取决于官方小程序是否直连你的配置地址。
- 前端为官方编译产物，未重新打包；仅做了 API 地址、设备标识、二维码协议自适应与账号 UI 注入。

## 版权与致谢

- 应用「人情录」及其前端资源归原作者 [pdf-covert/gift-ledger](https://github.com/pdf-covert/gift-ledger) 所有。本仓库仅用于个人自用部署与技术研究，未获得原作者授权，请勿用于商业分发。
- 后端（`src/`）为根据前端接口契约重新实现的独立作品。
