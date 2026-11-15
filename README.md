# 人情录 · Cloudflare 单域名版

> 将「人情录」飞牛OS 应用的前端与接口迁移为 **Cloudflare 单域名部署**：静态前端、API、数据库都在 Cloudflare 上运行，GitHub 仅托管代码。
>
> 在线地址：<https://rq.fuxicun.top>（API 同源：`/api/*`）

## 架构

```
浏览器 / 微信小程序 / 第三方客户端
        │  https://rq.fuxicun.top（页面）、http(s)://rq.fuxicun.top/api（接口）
        ▼
Cloudflare Worker（xiaozhou-ledger-api）
        ├─ /api/*  → API 逻辑
        └─ 其他路径 → 静态前端（Worker Assets，来自 docs/）
        │
        ▼
Cloudflare D1（xiaozhou-ledger-web）
```

- `docs/`：官方 `gift-ledger-x86-1.2.0.fpk` 安装包中的前端静态资源（React SPA，Hash 路由），由 Worker 直接托管。
- `worker/`：重新实现的后端，覆盖 Web 端与小程序所需的 HTTP API：会话、活动、礼金、统计、联系人、年度报告、CSV、AI 解析、加密备份、意见反馈、接口密钥与 `X-Api-Key` 认证。
- GitHub 仅托管代码；仓库仍可开启 GitHub Pages 作为镜像，但线上请求全部由 Cloudflare 处理。

## 功能

- 账本总览、份子钱记录、统计分析、往来联系人
- 记一笔 / 编辑 / 删除，按姓名、事由、月份筛选
- **接口密钥与小程序绑定**：设置 → 接口密钥 → 生成密钥 → 修改端口为 `80` → 绑定二维码。配置码包含 `http://rq.fuxicun.top:80` 与该设备账本的接口密钥。
- **客户端认证**：API 同时支持 `X-Ledger-Token`（浏览器匿名设备）、`X-Api-Key`、`X-Token`、`Authorization: Bearer`。绑定密钥的客户端与生成密钥的浏览器读写同一本账。
- **统计接口**：`/api/overview`、`/api/people`、`/api/report/yearly`、`/api/export/csv`（礼金明细 / 活动列表 / 人情往来）。
- AI 记账：设置 → AI 模型，配置任意 OpenAI Chat Completions 兼容接口（DeepSeek、智谱、Kimi 等），自然语言解析后预览入账
- 加密备份导出 / 导入（AES-256-GCM），用于换设备迁移
- 意见反馈（保存在 D1）

## 数据与隐私

- **每个浏览器是一本独立账本**：浏览器首次访问生成随机设备标识（`localStorage`），通过 `X-Ledger-Token` 访问自己的数据。生成接口密钥后，小程序/第三方客户端可通过该密钥访问同一本账。
- 数据保存在部署者自己的 Cloudflare D1 数据库中；D1 仅能被该 Worker 访问。
- **清除浏览器数据会导致设备标识丢失**，请定期在「设置 → 导出全部数据」保存加密备份；接口密钥也可用于绑定新客户端，但密钥本身不足以恢复浏览器端设备标识。
- 备份文件由 Worker 使用部署时设置的 `BACKUP_SECRET` 加密；更换密钥后旧备份将无法导入。
- 接口密钥等同账本访问权，泄露后请在「设置 → 接口密钥」更换。为了兼容官方小程序（其配置码使用 `http://host:port`），`/api/*` 允许走 HTTP；浏览器访问请使用 HTTPS。

## 小程序说明（重要）

1. 你遇到的「生成密钥失败 / 二维码不显示」已修复：`GET /api/apikey` 现在返回密钥，端口设置后即可生成绑定二维码。
2. 本仓库的公开内容只包含**Web 前端**和**编译后的 NAS 后端**；微信小程序客户端与其云端网关不在发布包中，无法从安装包克隆。
3. 我们已按原后端的接口契约补齐 `X-Api-Key` 认证和统计/报告/CSV 接口。若小程序直接访问配置码中的 NAS 地址，即可连接；若它强依赖原作者的云端网关/AppID，则该部分无法从现有发布物复刻。
4. 在「设置 → 接口密钥」把端口设为 **80**（不要用 443：小程序按 `http://host:port` 访问，443 是 TLS 端口）。

## 自行部署

```bash
cd worker
npm install

# 创建 D1（若已有可跳过），把 database_id 填入 wrangler.toml
npx wrangler d1 create xiaozhou-ledger-web

# 初始化表结构
npx wrangler d1 execute xiaozhou-ledger-web --remote --file=schema.sql

# 设置备份加密密钥
npx wrangler secret put BACKUP_SECRET

# 部署（会自动上传 docs/ 静态资源）
npx wrangler deploy
```

然后：

1. DNS 为站点域名添加一条**已代理**的记录（本部署为 `rq` CNAME → `zhoudedi.github.io`，仅作占位，实际由 Worker 路由处理）。
2. 在 Workers & Pages → xiaozhou-ledger-api → Settings → Triggers → Routes 添加 `rq.fuxicun.top/*`（本部署已配置）。
3. 可选：添加一条仅针对站点的「强制 HTTPS」重定向规则，并排除 `/api/*`（为小程序保留 HTTP 接口）。
4. 使用其他域名时，修改 `docs/index.html` 中 `API_BASE`（同源部署保持空字符串）与 Worker 的 `ALLOWED_ORIGINS`。

前端为 Hash 路由，页面地址形如 `https://rq.fuxicun.top/#/settings`。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/session` | 会话与会员信息 |
| GET/POST | `/api/events` | 活动列表 / 新建活动（按类型+日期去重） |
| POST/DELETE | `/api/events/:id` | 更新 / 删除活动（删除会级联删除其礼金） |
| GET/POST | `/api/gifts` | 礼金列表 / 新建礼金 |
| GET/PUT/DELETE | `/api/gifts/:id` | 查询 / 更新 / 删除礼金 |
| GET | `/api/overview` | 总览统计 |
| GET | `/api/people` | 联系人汇总 |
| GET | `/api/report/yearly?year=YYYY` | 年度报告 |
| GET | `/api/export/csv?type=gifts\|events\|people` | CSV 导出 |
| GET/POST | `/api/ai/config` | 读取 / 测试并保存 AI 模型配置 |
| POST | `/api/ai/parse` | 自然语言解析为礼金记录 |
| GET/POST | `/api/export/backup`、`/api/import/backup` | 加密备份导出 / 导入 |
| POST | `/api/feedback` | 意见反馈 |
| GET/POST | `/api/apikey`、`/api/apikey/rotate`、`/api/apikey/port` | 接口密钥状态 / 生成 / 端口 |
| GET | `/api/membership` | 会员信息（本部署为永久版） |

认证优先级：`X-Ledger-Token` → `X-Api-Key` / `X-Token` / `Authorization: Bearer`。不同设备/密钥之间的数据相互隔离。

## 已知限制

- 无账号体系：账本与浏览器设备标识绑定；跨设备请使用加密备份，或通过接口密钥绑定客户端。
- 微信支付购买入口不可用（本部署视为永久版）。
- 小程序客户端/原开发者云端网关不在发布物中；接口已兼容，但端到端绑定取决于官方小程序是否直接访问配置码中的地址。
- 前端为官方编译产物，未重新打包；仅做了 API 地址、设备标识与少量文案适配。

## 版权与致谢

- 应用「人情录」及其前端资源归原作者 [pdf-covert/gift-ledger](https://github.com/pdf-covert/gift-ledger) 所有。本仓库仅用于个人自用部署与技术研究，未获得原作者授权，请勿用于商业分发。
- 后端为根据前端接口契约重新实现的独立作品。
