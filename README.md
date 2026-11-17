# 人情录 · Cloudflare 单域名版

> 把「人情录」（原飞牛 OS 应用）的前端与接口搬到 **Cloudflare**：静态页面、API、数据库全在 Cloudflare 上，数据存进你自己的 **D1**，不依赖 NAS、不依赖任何服务器。
>
> 在线示例（本仓库 owner）：<https://rq.fuxicun.top>
>
> **fork 本仓库后，照着下面的「控制台部署（推荐）」在网页上点几下即可上线**，不用装命令行、不用手工建表——Worker 首次访问会自动建齐所有表。

---

## 目录

- [核心功能](#核心功能)
- [部署前须知](#部署前须知)
- [控制台部署（推荐，全程网页操作）](#控制台部署推荐全程网页操作)
- [命令行部署（进阶）](#命令行部署进阶)
- [管理后台](#管理后台)
- [日常使用](#日常使用)
- [备份与迁移](#备份与迁移)
- [从旧版本升级](#从旧版本升级)
- [API 一览](#api-一览)
- [常见问题](#常见问题)
- [已知限制](#已知限制)
- [版权与致谢](#版权与致谢)

---

## 核心功能

- **手机号 + 密码账号**：注册后 7 天免登录，任意设备登录同一手机号看到同一本账。密码以加盐哈希存在你自己的 D1，服务端不存明文。
- **游客模式**：不注册也能记，数据存在本机浏览器；注册时自动并入账号。
- **微信小程序 / 第三方客户端**：设置页生成接口密钥（`X-Api-Key`），与网页端读写同一本账。
- **统计分析**：收支总览、往来联系人、年度报告、CSV 导出。
- **AI 记账**：配置自己的大模型 API Key，用自然语言批量记一笔（支持浏览器直连兜底应对限流）。
- **个人中心**：头像菜单里改昵称、改密码、换绑定手机号（账本数据自动迁移）。
- **管理后台 `/admin`**：管理所有用户（含帮用户重置密码）、全站数据备份还原。

## 部署前须知

- 需要：一个 **Cloudflare 账号**（免费版够用）+ 一个 **GitHub 账号**（用来 fork 本仓库）。
- 费用：免费额度足够个人/家庭自用（Workers + D1 都有免费层）。
- 本项目**无需本地构建前端**：`www/` 里是编译好的静态文件，已随仓库提交。
- 上游原项目不公开前端源码，本项目用的是其编译产物并做了云端适配；如需重建前端，保持 `/api/*` 契约与 `www/index.html` 中的 `fetch` 注入逻辑即可。

## 控制台部署（推荐，全程网页操作）

### 第 1 步：创建 D1 数据库

1. 打开 <https://dash.cloudflare.com> → 左侧 **Databases → D1**（找不到就在顶部搜索框输入 `D1`）。
2. **Create database**，名称随意（如 `ledger`），Region 随意。
3. 创建完成后，页面会显示 **Database ID（UUID）**——**复制备用**，下一步要填。

> 表结构不用手动建：Worker 上线后第一次 API 请求会自动建齐（`schema.sql` 仅在你坚持手工建表时才需要，可用控制台的 **Remote → Queries** 粘贴执行）。

### 第 2 步：fork 仓库并填入数据库 ID

1. 在本仓库 GitHub 页面点右上角 **Fork**，fork 到你自己的账号。
2. 在你 fork 的仓库里打开 `wrangler.toml`（网页上点铅笔图标编辑），把 `database_id` 换成第 1 步复制的 UUID：

   ```toml
   name = "xiaozhou-ledger-web"     # Worker 名，可改，但要与后面创建 Worker 时一致

   [[d1_databases]]
   binding = "DB"
   database_name = "ledger"          # 你第 1 步填的库名
   database_id = "<你的 UUID>"       # ← 换成第 1 步复制的 Database ID
   ```

3. 点 **Commit changes** 提交。**必须先提交，再做第 4 步的接 Git 自动部署。**

### 第 3 步：创建 Worker

控制台 → **Workers & Pages → Create → Worker**：

- 名称填 `xiaozhou-ledger-web`（与 `wrangler.toml` 里的 `name` 一致；改了别的名字就要同步改 `wrangler.toml`）。
- 如果让你选模板，随便选一个即可，内容会在第 4 步被仓库代码覆盖。

创建后先不部署，下一步设置环境变量。

### 第 4 步：设置环境变量与密钥

进入刚创建的 Worker → **Settings → Variables and Secrets → Add**：

| 类型 | 名称 | 值 | 是否必填 |
| --- | --- | --- | --- |
| Secret（加密） | `ADMIN_KEY` | 任意长随机串（可用"随机生成"） | **必设**。网页管理后台 `/admin` 和命令行管理接口共用这一把 |
| Secret（加密） | `JWT_SECRET` | 任意长随机串 | 强烈建议设；不设则用内置默认值，公网有被伪造登录令牌的风险 |
| Variable（明文） | `MAX_ACCOUNTS` | 数字，如 `100` | 可选。限制可注册账号总数；不设 = 不限 |
| Variable（明文） | `REGISTER_COOLDOWN_MINUTES` | 数字，如 `60` | 可选。同一设备两次注册的最小间隔分钟；不设 = 不限 |

> 最简自用配置：只填 `ADMIN_KEY` + `JWT_SECRET` 即可，其余留空。
> ⚠️ 备份导出/导入是**明文**的，不需要 `BACKUP_SECRET`（老版本曾需要，现已移除）。

### 第 5 步：接 GitHub 自动部署

Worker → **Settings → Builds → Connect to Git**：

1. 授权 GitHub，选择你 **fork 的仓库**、分支 `main`。
2. 构建命令保持默认（`npm install && npx wrangler deploy`），保存。
3. 第一次会自动构建部署；以后你往仓库 push 任何改动，都会自动重新部署。

> 不想接 Git？也可以本地装 Node 后手动部署，见下面「命令行部署」。

### 第 6 步：验证

```bash
curl https://你的Worker地址/api/health
# → {"ok":true,"service":"xiaozhou-ledger-web","dbReady":true,...}
```

- `dbReady: true` = 数据库表已就绪。
- 浏览器打开 Worker 地址（形如 `https://xiaozhou-ledger-web.<你的子域>.workers.dev`），能看到「人情录」首页即部署成功。先记一笔游客账验证读写。
- 打开 `/admin`，输入 `ADMIN_KEY` 登录，确认管理后台可用。

### （可选）绑定自有域名

Worker → **Settings → Domains & Routes → Add → Custom Domain**：

- 域名已托管在 Cloudflare：直接填域名（或子域），CF 自动配 DNS；
- 域名不在 CF：按提示在你的 DNS 服务商添加 `CNAME` 记录指向 CF 提供的地址。

生效后 `https://你的域名` 就是站点地址，`https://你的域名/admin` 是管理后台。

## 命令行部署（进阶）

习惯 CLI 的话，可跳过上面的网页步骤：

```bash
# 1. 克隆你 fork 的仓库（注意仓库名是 xiaozhou-ledger，不是 Worker 名）
git clone https://github.com/你的用户名/xiaozhou-ledger.git
cd xiaozhou-ledger
npm install

# 2. 登录 Cloudflare（浏览器授权）
npx wrangler login

# 3. 创建数据库，把输出的 database_id 填进 wrangler.toml
npx wrangler d1 create xiaozhou-ledger-web

# 4. 设置密钥（交互式输入）
npx wrangler secret put ADMIN_KEY
npx wrangler secret put JWT_SECRET

# 5. 可选变量（也可在 Dashboard 的 Variables 面板填）
# npx wrangler secret put MAX_ACCOUNTS
# npx wrangler secret put REGISTER_COOLDOWN_MINUTES

# 6. 部署（表会在首次请求时自动创建）
npx wrangler deploy
```

验证：`curl https://你的地址/api/health`。

## 管理后台

浏览器打开 **`https://你的域名/admin`**，输入 `ADMIN_KEY` 登录（与命令行接口同一把密钥）。验证通过后签发 12 小时有效的管理员令牌存于本机浏览器，期间不用重复输入；密钥本身不会写进浏览器存储。

功能：

- **用户管理**：查看全部注册用户（含活动数/礼金数/接口密钥状态）；新增用户；改昵称；**重置任意用户密码**（用户忘记密码时在这里改）；删除用户及名下全部数据。
- **全站备份/还原**：导出全站数据（所有用户 + 账本 + 配置）为明文 JSON；导入时可选「合并」（保留现有数据）或「覆盖还原」（清空后重建）。换实例迁移、灾难恢复都靠它。

> ⚠️ `ADMIN_KEY` 权限极高（能改所有人密码、删所有数据、导出全站），务必用强随机串，不要用弱口令。

同一把密钥也可用于命令行：

```bash
# 重置某账号密码
curl -X POST https://你的域名/api/admin/reset-password \
  -H "Content-Type: application/json" -H "X-Admin-Key: <你的 ADMIN_KEY>" \
  -d '{"phone":"13800000000","password":"新密码"}'

# 清空某账号（账号方可重新注册）
curl -X POST https://你的域名/api/admin/purge-account \
  -H "Content-Type: application/json" -H "X-Admin-Key: <你的 ADMIN_KEY>" \
  -d '{"phone":"13800000000"}'
```

未设置 `ADMIN_KEY` 时，网页后台和这两个接口都不可用。

## 日常使用

1. 打开站点 → 右上角头像（或设置页账号按钮）→「绑定手机号（登录/注册）」→ 填手机号、密码（8–32 位）、可选昵称。
2. 换设备登录同一手机号即看到同一本账；7 天内免输密码。
3. **忘记密码**：让管理员在 `/admin` 后台「编辑用户」里重置（或按上面命令行方式）。
4. 账号菜单 →「个人中心」：改昵称、改密码、换绑定手机号（账本数据自动迁移）。
5. （可选）绑小程序：设置 →「接口密钥」→ 生成密钥 → 扫「绑定二维码」。换密钥后旧密钥立即失效，小程序需重新绑定。

## 备份与迁移

### 用户级：全栈备份（设置页）

「设置 → 导出/导入全栈备份」导出一个**明文 JSON**，包含该账号的活动、礼金、AI 配置（含 API Key）、小程序接口密钥。

- 不需要任何密钥，换账号、换实例都能直接导入；导入后数据归属当前登录账号，按「账号+类型+日期」去重。
- ⚠️ 备份文件是明文且含凭证，等同于账号密码，请妥善保管，勿发公开渠道。

### 管理员级：全站备份（`/admin`）

管理后台可导出/导入**整个站点**的全部数据（所有用户及账本），用于换实例迁移或灾难恢复。导入分「合并」和「覆盖」两种，覆盖前务必先导出当前数据留底。

## 从旧版本升级

### 1. 迁移前必须做的数据修复（若从 2026-11 之前的版本升级）

旧版 `/api/apikey/rotate` 等接口把 `account_keys.phone` 写成了**缺首位的截断手机号**（如 `13800138000` → `3800138000`），导致小程序接口密钥映射到错误账号、看不到数据。代码已修复，但**老库需执行一次数据修复**：

```bash
# 远程库执行；脚本幂等，先按里面 SELECT 核对，再跑 UPDATE
npx wrangler d1 execute xiaozhou-ledger-web --remote --file=fix-account-keys.sql
```

执行后用接口密钥调 `/api/session`，确认 `uid` 是完整的 `user:<手机号>`。

### 2. 换了 JWT_SECRET 后所有人需重新登录

设置/更换 `JWT_SECRET` 会使旧登录令牌全部失效，用户重新登录一次即可（前端会自动清除失效令牌回到登录态）。

### 3. 备份从加密改明文

当前版本备份为明文，不再需要 `BACKUP_SECRET`；旧加密备份文件无法读取（可保留 Secret 也无害）。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（含 `dbReady`） |
| POST | `/api/account/register` | 注册（`phone`/`password`/`name`/`importDevice`；受注册上限与冷却限制） |
| POST | `/api/account/login` | 登录，发 7 天 JWT |
| GET | `/api/account/check?phone=` | 查询手机号是否已注册 |
| DELETE | `/api/account/device` | 解除本机设备绑定 |
| POST | `/api/account/profile` | 改昵称（`name`；需登录，换发 JWT） |
| POST | `/api/account/password` | 改密码（`oldPassword`/`newPassword`；需登录） |
| POST | `/api/account/phone` | 换手机号（`newPhone`/`password`；需登录，账本数据原子迁移） |
| GET | `/api/session` | 会话信息 |
| GET/POST | `/api/events` | 活动列表 / 新建 |
| POST/DELETE | `/api/events/:id` | 更新 / 删除活动（级联删礼金） |
| GET/POST | `/api/gifts` | 礼金列表 / 新建 |
| GET/PUT/DELETE | `/api/gifts/:id` | 查询 / 更新 / 删除 |
| GET | `/api/overview` | 总览统计 |
| GET | `/api/people` | 联系人汇总 |
| GET | `/api/report/yearly?year=` | 年度报告 |
| GET | `/api/export/csv?type=` | CSV 导出 |
| GET/POST | `/api/ai/config`、`POST /api/ai/parse` | AI 配置 / 解析（自带模型 Key） |
| GET/POST | `/api/export/backup`、`/api/import/backup` | 用户级全栈备份（明文，无需密钥） |
| POST | `/api/feedback` | 意见反馈 |
| GET/POST | `/api/apikey`、`/api/apikey/rotate`、`/api/apikey/port` | 接口密钥状态 / 生成 / 端口 |
| GET | `/api/membership` | 会员信息（Web 部署视为永久版） |
| POST | `/api/admin/login` | 管理员登录（`adminKey` 或 `X-Admin-Key`）→ 返回 `X-Admin-Token` |
| GET | `/api/admin/users` | 用户列表（需 `X-Admin-Token`） |
| POST | `/api/admin/user/create` | 新增用户 |
| POST | `/api/admin/user/update` | 改昵称/密码 |
| POST | `/api/admin/user/delete` | 删除用户及全部数据 |
| GET | `/api/admin/export-all` | 全站备份导出 |
| POST | `/api/admin/import-all` | 全站备份导入（multipart：`file`，可选 `merge=1`） |
| POST | `/api/admin/reset-password`、`/api/admin/purge-account` | 命令行管理（需 `X-Admin-Key`） |

**用户认证头**（按优先级）：`X-Api-Key`/`X-Token`/`Authorization: Bearer`（JWT 或小程序密钥）→ `X-Ledger-Token`（设备/游客）。不同账号数据相互隔离。
**管理认证**：`/api/admin/login` 用 `ADMIN_KEY` 换 `X-Admin-Token`（12 小时）；旧的两个命令行接口直接用 `X-Admin-Key`。
**跨域**：默认反射请求方 `Origin`（认证全走自定义头，不用 Cookie）。如需收紧，改 `src/index.js` 里的 `corsHeaders` 为固定白名单。

## 常见问题

- **首页显示"无法识别身份/页面加载异常"**：多半是浏览器缓存了旧版页面。强制刷新（Ctrl+F5）；若是刚设置/更换了 `JWT_SECRET`，会自动清除失效登录态，重新登录一次即可。
- **`/api/health` 的 `dbReady` 是 false**：数据库还没建表。随便请求一次任意 `/api` 接口会触发自动建表；或手动执行 `schema.sql`。确认 `wrangler.toml` 的 `database_id` 填的是你自己的库。
- **导出备份报 400／"未配置密钥"**：当前版本备份是明文，**不需要**任何密钥。若还看到这个报错，说明部署的还是旧代码，重新部署最新代码。
- **`/admin` 打不开或登录失败**：确认已设置 Secret `ADMIN_KEY`，且输入的值与 Dashboard 里完全一致（注意空格/换行）。
- **小程序连不上**：设置页确认接口密钥已生成、端口正确；换过密钥要在小程序重新绑定。
- **注册报"尝试过于频繁"**：同一手机号连续输错密码 20 次会封 5 分钟（内存级），等一会儿或让管理员重置密码。

## 已知限制

- 无短信/邮箱验证，手机号仅作"自报 + 密码"身份；忘记密码只能由管理员重置。
- 微信支付购买入口不可用（Web 部署视为永久版）。
- 小程序客户端源码与原作者云端网关不在本仓库；服务端已兼容其接口契约，端到端绑定取决于官方小程序是否直连你的配置地址。
- 前端为官方编译产物，未重新打包；仅做了云端文案适配、API 地址/设备标识/二维码协议自适应与账号 UI 注入。静态资源引用带 `?v=` 版本号，改动后浏览器会自动加载新版本。

## 版权与致谢

- 应用「人情录」及其前端资源归原作者 [pdf-covert/gift-ledger](https://github.com/pdf-covert/gift-ledger) 所有。本仓库仅用于个人自用部署与技术研究，未获得原作者授权，请勿用于商业分发。
- 后端（`src/`）为根据前端接口契约重新实现的独立作品。
