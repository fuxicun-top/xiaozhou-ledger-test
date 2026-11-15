# 人情录 · Web 版

> 将飞牛OS 应用「人情录」的前端静态资源部署到 **GitHub Pages**，后端使用 **Cloudflare Workers + D1** 重新实现。
>
> 在线地址：<https://rq.fuxicun.top> ｜ API：`https://rqapi.fuxicun.top`

## 架构

```
浏览器（React SPA，托管于 GitHub Pages / rq.fuxicun.top）
        │  fetch api/...  +  X-Ledger-Token
        ▼
Cloudflare Worker（xiaozhou-ledger-api / rqapi.fuxicun.top）
        │
        ▼
Cloudflare D1（SQLite）
```

- `docs/`：前端静态资源（来自官方发布的 `gift-ledger-x86-1.2.0.fpk` 安装包），由 GitHub Pages 托管。
- `worker/`：Cloudflare Worker 后端源码，实现了原应用的 HTTP API（会话、活动、礼金增删改查、AI 解析、备份导入导出、意见反馈等）。
- 前端 `index.html` 中注入了一小段脚本，把相对路径 `api/...` 重写到 Worker 域名，并为每个浏览器生成匿名设备标识。

## 功能

- 账本总览、份子钱记录、统计分析、往来联系人
- 记一笔 / 编辑 / 删除，按姓名、事由、月份筛选
- AI 记账：在「设置 → AI 模型」配置任意 OpenAI Chat Completions 兼容接口（DeepSeek、智谱、Kimi 等），自然语言解析后预览入账
- 加密备份导出 / 导入（AES-256-GCM），用于换设备迁移
- 意见反馈（保存在 D1）

## 数据与隐私

- **每个浏览器是一本独立账本**：浏览器首次访问时生成随机设备标识，保存在 `localStorage`，通过 `X-Ledger-Token` 请求头访问自己的数据。这与原应用「每位家人打开都是自己的独立账本」的设计一致。
- 数据保存在部署者自己的 Cloudflare D1 数据库中，不经过任何第三方。
- **清除浏览器数据会导致设备标识丢失，从而无法再访问原账本**，请定期使用「设置 → 导出全部数据」保存加密备份。
- 备份文件由 Worker 使用部署时设置的 `BACKUP_SECRET` 加密；更换密钥后旧备份将无法导入。
- 短信、支付、微信小程序绑定等原应用云端能力在本部署中不可用；应用视为已开通永久版，全部记账功能免费使用。

## 自行部署

### 1. 前端（GitHub Pages）

1. 将本仓库推送到 GitHub。
2. 仓库 **Settings → Pages**：Source 选择 `Deploy from a branch`，Branch 选 `main`，目录选 `/docs`。
3. 在 Cloudflare DNS 中添加记录：`rq` CNAME → `<你的 GitHub 用户名>.github.io`（DNS only）。
4. 在 Pages 设置中把 Custom domain 设为 `rq.fuxicun.top` 并启用 HTTPS（`docs/CNAME` 已包含域名）。

### 2. 后端（Cloudflare Worker + D1）

```bash
cd worker
npm install

# 创建 D1 数据库（若已有可跳过），把返回的 database_id 填入 wrangler.toml
npx wrangler d1 create xiaozhou-ledger

# 初始化表结构
npx wrangler d1 execute xiaozhou-ledger --remote --file=schema.sql

# 设置备份加密密钥
npx wrangler secret put BACKUP_SECRET

# 部署
npx wrangler deploy
```

然后在 Cloudflare 控制台为 Worker 添加自定义域名（如 `rqapi.fuxicun.top`）
（Workers & Pages → xiaozhou-ledger-api → Settings → Domains & Routes → Add custom domain），
并在 `docs/index.html` 中修改 `API_BASE`，以及在 `worker/src/index.js` 的 `ALLOWED_ORIGINS` 中加入你的前端域名。

## API

与官方应用保持兼容的主要接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/session` | 会话与会员信息 |
| GET/POST | `/api/events` | 活动列表 / 新建活动（按类型+日期去重） |
| GET/POST | `/api/gifts` | 礼金列表 / 新建礼金 |
| PUT/DELETE | `/api/gifts/:id` | 更新 / 删除礼金 |
| GET/POST | `/api/ai/config` | 读取 / 测试并保存 AI 模型配置 |
| POST | `/api/ai/parse` | 自然语言解析为礼金记录 |
| GET | `/api/export/backup` | 导出加密备份 |
| POST | `/api/import/backup` | 导入备份（`file` + `mode=merge`） |
| POST | `/api/feedback` | 意见反馈 |
| GET/POST | `/api/apikey`、`/api/apikey/rotate`、`/api/apikey/port` | 接口密钥（保留接口） |
| GET | `/api/health` | 健康检查 |

所有数据接口都需要 `X-Ledger-Token` 请求头，不同令牌之间的数据相互隔离。

## 已知限制

- 无账号体系，账本与浏览器绑定；跨设备迁移请使用加密备份。
- 微信小程序远程记账 / 扫码绑定依赖原开发者的云端网关，本部署不支持。
- 微信支付购买入口不可用（本部署已视为永久版）。
- 前端为官方编译产物，未做二次打包；仅通过 `index.html` 中的脚本做 API 地址与设备标识适配。

## 版权与致谢

- 应用「人情录」及其前端资源归原作者 [pdf-covert/gift-ledger](https://github.com/pdf-covert/gift-ledger) 所有。本仓库仅用于个人自用部署与技术研究，未获得原作者授权，请勿用于商业分发。
- 后端为根据前端接口契约重新实现的独立作品。
