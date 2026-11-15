# 人情录 · Cloudflare 单域名版

> 将「人情录」飞牛OS 应用的前端与接口迁移为 **Cloudflare 单域名部署**：静态前端、API、数据库都在 Cloudflare 上运行，GitHub 仅托管代码并驱动 Cloudflare Builds 自动部署。
>
> 在线地址：<https://rq.fuxicun.top>（API 同源：`/api/*`）

## 账号模型（跨设备同一本账）

- **手机号 + PIN 账号**：首次「注册」输入手机号并设 4–16 位 PIN，得到一个 8 位**恢复码**（忘记 PIN 时可凭恢复码重置）。之后在**任何浏览器、任何设备**登录同一手机号，看到的就是同一本账；登录后本浏览器被记住（设备绑定），再次访问免输 PIN。
- **游客**：不登录也能用，数据属于本机浏览器（`dev:<设备>`）。清缓存/换浏览器后这些数据"消失"，但注册手机号时可勾选**把本浏览器已有数据并入账号**找回；也可用「导出加密备份 → 导入」迁移。
- **微信小程序 / 第三方客户端**：在设置里生成**接口密钥**（`X-Api-Key`），与手机号账号读写同一本账，浏览器登录态变化不影响小程序。

> 注意：PIN 与恢复码仅存于你自己的 Cloudflare D1，服务端只存其哈希。注册时请保存好恢复码。

## 架构

```
浏览器 / 微信小程序 / 第三方客户端
        │  https://rq.fuxicun.top（页面）、https://rq.fuxicun.top/api（接口）
        ▼
Cloudflare Worker（xiaozhou-ledger-web）
        ├─ /api/*        → API 逻辑（按手机号账号作用域）
        └─ 其他路径       → 静态前端（Worker Assets，来自 www/）
        │
        ▼
Cloudflare D1（xiaozhou-ledger-web）
```

- `www/`：官方 `gift-ledger-x86-1.2.0.fpk` 安装包中的前端静态资源（React SPA，Hash 路由），由 Worker 直接托管。
- `src/index.js`：重新实现的后端，覆盖 Web 端与小程序所需的 HTTP API：账号注册/登录/找回、会话、活动、礼金增删改查、统计、联系人、年度报告、CSV、AI 解析、加密备份、意见反馈、接口密钥与 `X-Api-Key` 认证。
- 仓库根级 `wrangler.toml`：Cloudflare 通过 **Workers Builds** 连接本 GitHub 仓库后，push 到 `main` 自动 `wrangler deploy`（见下文「部署联动」）。

## 部署联动（GitHub → Cloudflare 自动构建，方法 A）

代码改动只在 GitHub 仓库，Cloudflare 负责拉取并构建：

1. Cloudflare 控制台 → **Workers & Pages → `xiaozhou-ledger-web` → Settings → Builds → Connect to Git**（或 Workers Builds 独立面板）。
2. 选择 GitHub 账号并授权，选择仓库 `zhoudedi/xiaozhou-ledger`，分支 `main`。
3. 构建命令保持 `npm install && npx wrangler deploy`（仓库根级 `wrangler.toml` 会被自动识别），保存后触发首次构建。
4. 以后每次 `git push` 到 `main`，Cloudflare 自动拉取、构建、部署；无需再手动 `wrangler deploy`。

> `BACKUP_SECRET` 等密钥通过 Cloudflare 控制台的 Worker Secrets 管理，**不要**写进 GitHub 仓库。

## 手动部署（不接 Builds 时）

```bash
npm install

# 创建 D1（若已有可跳过），把 database_id 填入 wrangler.toml
npx wrangler d1 create xiaozhou-ledger-web

# 初始化表结构
npx wrangler d1 execute xiaozhou-ledger-web --remote --file=schema.sql
# 旧库升级到账号体系
npx wrangler d1 execute xiaozhou-ledger-web --remote --file=migrate-account.sql

# 设置备份加密密钥
npx wrangler secret put BACKUP_SECRET

# 部署（自动上传 www/ 静态资源 + API）
npx wrangler deploy
```

DNS / 路由：站点域名 `rq.fuxicun.top` 通过 Cloudflare「已代理」记录 + Worker 路由 `rq.fuxicun.top/* → xiaozhou-ledger-web` 提供（已配置）。`/api/*` 保留 HTTP 以兼容小程序明文访问，页面强制 HTTPS。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/account/register` | 注册手机号账号（`phone`/`pin`/`importDevice`），返回 `recoveryCode` |
| POST | `/api/account/login` | 登录校验 PIN |
| GET | `/api/account/check?phone=` | 查询手机号是否已注册 |
| POST | `/api/account/recovery` | 凭 phone+PIN 取恢复码 |
| POST | `/api/account/reset` | 凭恢复码重置 PIN |
| DELETE | `/api/account/device` | 解除本机设备绑定（重新要求 PIN） |
| GET | `/api/session` | 会话与会员信息（`auth.loggedIn/guest`） |
| GET/POST | `/api/events` | 活动列表 / 新建（按账号+类型+日期去重） |
| POST/DELETE | `/api/events/:id` | 更新 / 删除活动（级联删其礼金） |
| GET/POST | `/api/gifts` | 礼金列表 / 新建 |
| GET/PUT/DELETE | `/api/gifts/:id` | 查询 / 更新 / 删除 |
| GET | `/api/overview` | 总览统计 |
| GET | `/api/people` | 联系人汇总 |
| GET | `/api/report/yearly?year=` | 年度报告 |
| GET | `/api/export/csv?type=` | CSV 导出 |
| GET/POST | `/api/ai/config`、`POST /api/ai/parse` | AI 模型配置 / 解析 |
| GET/POST | `/api/export/backup`、`/api/import/backup` | 加密备份导出 / 导入 |
| POST | `/api/feedback` | 意见反馈 |
| GET/POST | `/api/apikey`、`/api/apikey/rotate`、`/api/apikey/port` | 接口密钥状态 / 生成 / 端口 |
| GET | `/api/membership` | 会员信息（永久版） |

**认证头**（按优先级）：`X-Ledger-Phone`(+`X-Ledger-Pin`) → `X-Api-Key`/`X-Token`/`Authorization: Bearer` → 已绑定设备 `X-Ledger-Token` → 游客 `X-Ledger-Token`。手机号账号需 PIN；接口密钥与已绑定设备免 PIN。不同账号之间数据相互隔离。

## 已知限制

- 无短信/邮箱验证，手机号仅作为"自报 + PIN + 恢复码"身份；PIN 强度依赖用户自设。
- 微信支付购买入口不可用（本部署视为永久版）。
- 小程序客户端源码与原作者云端网关不在发布物中；服务端已兼容其接口契约，端到端绑定取决于官方小程序是否直连配置码地址。
- 前端为官方编译产物，未重新打包；仅做了 API 地址、设备标识、二维码协议自适应与账号 UI 注入。

## 版权与致谢

- 应用「人情录」及其前端资源归原作者 [pdf-covert/gift-ledger](https://github.com/pdf-covert/gift-ledger) 所有。本仓库仅用于个人自用部署与技术研究，未获得原作者授权，请勿用于商业分发。
- 后端为根据前端接口契约重新实现的独立作品。
