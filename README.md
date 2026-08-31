<div align="center">

<img src="docs/logo.png" width="128" height="128" alt="agnes2api">

<h1>agnes2api</h1>
<h3>多协议 AI 中转 · Agnes 后端</h3>
<p>一套代码同时兼容 OpenAI / Anthropic / OpenAI-Responses / Gemini 四大 AI SDK，由 Agnes AI 后端统一供给对话与图片、视频生成，Cloudflare Worker 与 Node 双运行时共用同一份转发内核，Docker 快速部署。</p>

<p>
  <img src="https://img.shields.io/badge/TypeScript-7.0-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Hono-4.13-E36002?style=flat-square&logo=hono&logoColor=white" alt="Hono">
  <img src="https://img.shields.io/badge/Cloudflare%20Workers-edge-F38020?style=flat-square&logo=cloudflareworkers&logoColor=white" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/Docker-20.10+-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/arch-amd64%20%7C%20arm64-4285F4?style=flat-square&logo=linux&logoColor=white" alt="Arch">
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/version-v0.1.1-success?style=flat-square" alt="Version">
</p>

<p>
  <a href="#-最近更新">最近更新</a> &bull;
  <a href="#-核心功能">核心功能</a> &bull;
  <a href="#-系统要求">系统要求</a> &bull;
  <a href="#-快速部署">快速部署</a> &bull;
  <a href="#-接入示例">接入示例</a> &bull;
  <a href="#-api-端点">API 端点</a> &bull;
  <a href="#-配置说明">配置说明</a> &bull;
  <a href="#-注意事项">注意事项</a> &bull;
  <a href="#-开发路线">开发路线</a>
</p>

<p>
  📖 文档语言：<a href="docs/zh-CN/README.md">简体中文</a> | <a href="docs/zh-TW/README.md">繁體中文</a> | <a href="docs/en/README.md">English</a> | <a href="docs/ja/README.md">日本語</a> | <a href="docs/ko/README.md">한국어</a>
</p>

<br>

<a href="https://github.com/xwteam/agnes2api/actions/workflows/ci.yml"><img src="https://github.com/xwteam/agnes2api/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
<a href="https://github.com/xwteam/agnes2api/issues"><img src="https://img.shields.io/github/issues/xwteam/agnes2api?style=flat-square" alt="Issues"></a>
<a href="https://github.com/xwteam/agnes2api/stargazers"><img src="https://img.shields.io/github/stars/xwteam/agnes2api?style=flat-square" alt="Stars"></a>

</div>

---

> [!NOTE]
> 本项目仅供研究和学习用途，请合理使用，不建议用于任何商业目的。

> [!WARNING]
> 本项目与 Agnes AI 无任何关联或授权关系。它把 Agnes AI 服务封装成多协议兼容 API，这种用法可能不符合上游的服务条款；批量获取免费额度的做法与上游条款存在张力。使用风险自负，作者不对任何账号处罚或数据丢失承担责任。

> [!TIP]
> 上游由一池 Agnes API key 供给：对话走 `agnes-2.0-flash`，图片走 `agnes-image-2.1-flash` 与 `agnes-image-2.0-flash`，视频走 `agnes-video-v2.0`（建任务 + 轮询两段式）。key 池会自愈——上游 `429`/`402` 让对应 key 进入冷却，`401`/`403` 把它永久剔除，连续瞬时故障累计到 `MAX_STRIKES` 后让它进入长冷却（`COOLDOWN_STRIKE_MS`，默认 30 分钟）而不是剔除。到期自动恢复的那几类不需要人工干预。

> [!IMPORTANT]
> **本网关是 fail-closed 的，不存在「不配口令也能用」这种状态。** `GATEWAY_TOKEN` 是必填项，缺失时网关**直接拒绝启动**（`src/core/config.ts` 抛「缺少 GATEWAY_TOKEN，网关无法启动」）；注意这条启动路径**只判存在、不判长度**，短口令照样能把网关拉起来，够不够强由你自己负责。管理面板默认**不存在**：未设置 `ADMIN_TOKEN` 时整棵 `/admin` 树根本不注册、访问得到 404；设了但短于 24 位（`ADMIN_TOKEN_MIN_LENGTH`）同样不启用，日志写「管理面板未启用（网关转发不受影响）」；设了且够长、却与 `GATEWAY_TOKEN` **相同**时，管理接口持续返回 503（网关转发照常）。`ADMIN_TOKEN` 只从环境变量读、不从存储读，面板无法自助轮换自己的钥匙。

---

## 📝 最近更新

| 日期 | 更新内容 |
|------|----------|
| 2026-08-31 | v0.1.1 - 🧹 **整备版**：把内部研发编号从公开仓大面积清掉。面板资源那 470 处会随 /admin/js/*.js 发给每个打开面板的访客，是唯一真正外泄的一块；其余散在源码、测试、门禁脚本、出货文档与提交信息里。顺带修好「一条排版豁免被静静升级成泄漏豁免」和三格卡在默认超时边界上的测试。行为面没有改动 |
| 2026-08-31 | v0.1.0 - 🎉 **首个版本**：四协议网关、注册机与管理面板一次成型，同一份代码同时跑 Cloudflare Worker 与 Node / Docker 两种运行时。四条入站协议共用同一套上游调度、同一个 key 池、同一份失败归因；注册机的两条临时邮箱通道严格平级；面板八个板块零构建；文档五语言各一份 |

> 完整更新日志请查看 [CHANGELOG.md](CHANGELOG.md)。

---

## 🌟 核心功能

> 📖 详细使用文档：[简体中文](docs/zh-CN/USAGE.md) | [繁體中文](docs/zh-TW/USAGE.md) | [English](docs/en/USAGE.md) | [日本語](docs/ja/USAGE.md) | [한국어](docs/ko/USAGE.md)

### 🔌 四协议前端，一套上游

- 一个服务同时提供 **OpenAI Chat**、**Anthropic Messages**、**OpenAI Responses**、**Gemini 原生** 四种 SDK 格式，各协议官方 SDK 只改基址即可直连
- 四条入站协议共用同一套上游调度、同一个 key 池、同一份失败归因，流式（SSE）在四条上都支持
- 除对话外还转发**图片生成**（`/v1/images/generations`）与**视频生成**（`/v1/videos` 建任务 + `/v1/videos/{id}` 轮询的两段式）
- 路径只有**裸前缀**一套：OpenAI 与 Anthropic 挂在 `/v1` 下，Gemini 挂在 `/v1beta` 下

### 🔐 统一鉴权闸

- 四种凭据通道一视同仁地接受：`Authorization: Bearer`、`x-api-key`、`x-goog-api-key`、查询参数 `?key=`，正好覆盖各协议官方 SDK 默认发送的那一种
- 网关口令 `GATEWAY_TOKEN` **必填**，缺失时进程起不来；管理口令 `ADMIN_TOKEN` 与它是**两把不同的钥匙**，相同即停用管理接口
- `/health` 探活端点不鉴权，其余全部走鉴权闸

### 🔄 key 池自愈与自动补池

> 📖 详细注册机文档：[简体中文](docs/zh-CN/REGISTRAR.md) | [繁體中文](docs/zh-TW/REGISTRAR.md) | [English](docs/en/REGISTRAR.md) | [日本語](docs/ja/REGISTRAR.md) | [한국어](docs/ko/REGISTRAR.md)

- 上游 `429`/`402` 让对应 key 进入分级冷却，`401`/`403` 永久剔除，连续瞬时故障累计到 `MAX_STRIKES` 后进入长冷却（默认 30 分钟）、到期自动恢复
- 一把 key 都用不上时如实回 `503` 并给出可分辨的 `reason`（尚未导入 / 全部冷却 / 全部停用 / 全部剔除 / 上游持续失败），冷却那一种带 `Retry-After`
- **自动补池默认关闭**：打开 `REGISTRAR_ENABLED` 之后，可用 key 低于 `TARGET_KEYS` 时会自动注册 Agnes 账号补齐
- 注册机的两条临时邮箱通道（`yyds` / `moemail`）**严格平级**，主备由你自己选，不预设推荐值

### 🔀 双运行时，同一份转发内核

- 同一份 TypeScript 代码同时跑 **Cloudflare Worker**（key 池落 KV）与 **Node / Docker**（key 池落单文件 JSON），请求处理逻辑逐字相同
- 存储访问与流量解耦：key 池按 isolate／进程缓存，只改遥测字段的更新会被整个丢弃，稳态下存储的读与写都**不随请求量增长**
- Worker 形态的补池调度走 Cron 触发器，Node 形态走进程内定时器，两边的补池语义一致

### 🖥 Web 管理面板

> 📖 详细面板文档：[简体中文](docs/zh-CN/ADMIN.md) | [繁體中文](docs/zh-TW/ADMIN.md) | [English](docs/en/ADMIN.md) | [日本語](docs/ja/ADMIN.md) | [한국어](docs/ko/ADMIN.md)

- **默认关闭**：未设置 `ADMIN_TOKEN` 时整棵 `/admin` 树根本不注册，访问得到 404，而不是一个不鉴权的面板
- 八个板块：概览、key 池、注册机、事件、用量、模型、调试台、设置
- **零构建**：`admin-ui/` 原样挂在 `/admin/` 下就是可调试的面板，构建脚本只把它逐字节烧进一份生成物
- 口令只走 `x-admin-key` 请求头，不落 Cookie、不进 query

### ⚡ 高性能架构

- 基于 **TypeScript + Hono**，Worker 与 Node 两个入口共用同一棵路由树
- 上游响应以流式转发为主；非流式请求原样以 `stream:false` 发给上游，网关解析上游那份 JSON 再翻译成你用的协议形状
- 端口层与适配层分离（存储、抓取、日志、邮箱都是可替换的 port），契约测试在两种运行时上各跑一遍
- 多阶段 Docker 构建、非 root 运行、多架构镜像（amd64 / arm64）、健康检查

---

## 🏗 技术架构

```
                              agnes2api
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Client (OpenAI SDK / Anthropic SDK / Gemini SDK / cURL)    │
│       |                                                     │
│  POST /v1/chat/completions              (OpenAI)            │
│  POST /v1/messages                      (Anthropic)         │
│  POST /v1/responses                     (OpenAI-Responses)  │
│  POST /v1beta/models/:m:generateContent (Gemini)            │
│  POST /v1/images/generations · /v1/videos   (媒体转发)      │
│       |                                                     │
│       v                                                     │
│  +-----------+    +----------------+    +---------------+   │
│  |   Auth    |--->|   Dispatcher   |--->|   Key Pool    |   │
│  | 四种通道  |    |  (转发内核)    |    |  (取号+归因)  |   │
│  +-----------+    +----------------+    +---------------+   │
│                           |                     |           │
│                           |          ┌──────────┴────────┐  │
│                           |          v                   v  │
│                           |    Worker: KV        Node: File │
│                           |    (POOL 绑定)     (store.json) │
│                           |                                 │
│  +-----------+    +----------------+    +---------------+   │
│  | Registrar |    |  Admin Panel   |    |  Events/Usage │   │
│  | (可选补池)|    |  (可选 /admin) |    |   (可选统计)  │   │
│  +-----------+    +----------------+    +---------------+   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                           |
                    Agnes AI 上游 API
              对话 / 图片同步 · 视频建任务 + 轮询
                           |
                           v
                   agnes-2.0-flash 等模型
```

---

## 📋 系统要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | 22.13+ | 仅从源码构建或直接用 Node 跑时需要；Docker 部署无需本地安装 |
| Docker | 20.10+ | 推荐用 Docker 部署，官方镜像多架构 |
| Agnes 账号 | — | 需要至少一把有效的 Agnes API key（也可交给注册机自动补池） |
| Cloudflare 账号 | wrangler 4+ | 仅 Cloudflare Worker 形态需要：一个 KV 命名空间加一次部署 |

> [!TIP]
> 使用 Docker 部署无需本地安装 Node.js 环境，只需 Docker 和有效的 Agnes API key 即可。部署到 Cloudflare Worker 则连服务器都不需要，只要一个 Cloudflare 账号和 wrangler 命令行。

---

## ⚡ 快速部署

> 📖 详细部署文档：[简体中文](docs/zh-CN/DEPLOY.md) | [繁體中文](docs/zh-TW/DEPLOY.md) | [English](docs/en/DEPLOY.md) | [日本語](docs/ja/DEPLOY.md) | [한국어](docs/ko/DEPLOY.md)

> **前置条件**：你需要至少一把有效的 Agnes API key，以及一个 Cloudflare 账号（Worker 形态）或一台能跑 Docker 的机器。

### 1. 获取上游 key

在 Agnes AI 平台创建一把 API key 备用。不想手工准备也可以先把网关跑起来，再打开注册机让它自动补池——两条路都在部署文档里写全了。

### 2. 部署

#### Cloudflare Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xwteam/agnes2api)

一键部署省掉本地克隆这一步，但有两件事它替不了你：`wrangler.toml` 里的 KV 命名空间 id（仓库里那个恒为占位符）与 `GATEWAY_TOKEN` secret——缺任何一项网关都起不来。想全程自己走，或者部署完回来补这两项，用下面这几条命令：

```bash
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api
pnpm install

# 建一个 KV 命名空间，把返回的 id 填进 wrangler.toml
npx wrangler kv namespace create POOL

# 网关口令是必填的敏感值，用 secret 注入，不要写进仓库
npx wrangler secret put GATEWAY_TOKEN

npx wrangler deploy
```

#### Docker

```bash
# 克隆仓库
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api

# 创建环境变量文件
cp .env.example .env
```

编辑 `.env`，至少填一个网关口令：

```env
GATEWAY_TOKEN=你的网关口令
# 管理面板口令；不填则整棵 /admin 树不注册。填就必须与 GATEWAY_TOKEN 不同，且至少 24 位。
ADMIN_TOKEN=
```

启动服务：

```bash
mkdir -p data
docker compose up -d
```

查看日志确认启动成功：

```bash
docker compose logs -f
# 看到监听端口即表示启动成功
```

> **首个镜像发布之前**（或在 fork 里），`docker compose up -d` 会回落到本地构建
> —— `docker-compose.yml` 里那段 `build:` 就是干这个的。

### 3. 验证

```bash
# 健康检查（不鉴权）。Worker 形态换成你的 https://<name>.<sub>.workers.dev
curl http://localhost:8080/health
# {"status":"ok","version":"0.1.0"}

# 查看可用模型
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-gateway-token"

# 发送测试请求
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-2.0-flash","messages":[{"role":"user","content":"你好"}]}'
```

看到 AI 回复的文字即部署成功。如果返回 401，请检查 API Key 是否正确。

---

## 🧪 接入示例

> [!NOTE]
> 所有请求都要带上网关口令。鉴权闸对以下四种凭据通道一视同仁——不需要为某个 SDK 做额外配置：
> - `Authorization: Bearer <token>`（OpenAI SDK 默认发这一种）
> - `x-api-key: <token>`（Anthropic SDK 默认发这一种）
> - `x-goog-api-key: <token>`（Google GenAI SDK 默认发这一种）
> - 查询参数 `?key=<token>`（手动调用与浏览器场景）
>
> 下文的 `http://localhost:8080` 请换成你实际部署的地址（Worker 的 `*.workers.dev` 域名、自定义域名，或 Docker 部署的本机地址），`your-gateway-token` 换成你真实的网关口令。

<details>
<summary><b>OpenAI SDK（Python）</b></summary>

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="your-gateway-token",
)

resp = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

流式调用与直接对接 OpenAI 完全一样——传 `stream=True`，遍历返回的生成器即可。

</details>

<details>
<summary><b>Anthropic SDK（Python）</b></summary>

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:8080",
    api_key="your-gateway-token",
)

msg = client.messages.create(
    model="agnes-2.0-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好"}],
)
print(msg.content[0].text)
```

注意 SDK 的 `base_url` **不带** `/v1`——SDK 内部会自己拼上 `/v1/messages`。

</details>

<details>
<summary><b>Gemini SDK（Python）</b></summary>

```python
from google import genai

client = genai.Client(
    api_key="your-gateway-token",
    http_options={"base_url": "http://localhost:8080"},
)

resp = client.models.generate_content(
    model="agnes-2.0-flash",
    contents="你好",
)
print(resp.text)
```

SDK 的 `base_url` 同样**不带** `/v1beta`——SDK 会自己拼上 `/v1beta/models/...`。

</details>

<details>
<summary><b>OpenAI-Responses（cURL）</b></summary>

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-2.0-flash","input":"你好"}'
```

这条协议目前还没有被广泛使用的专用 SDK，所以直接用一次纯 HTTP 调用示范。完整的响应结构与流式事件序列见各语言的 API 文档。

</details>

<details>
<summary><b>图片生成</b></summary>

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-image-2.1-flash","prompt":"一只猫"}'
```

同步转发：请求体与响应体都原样透传自上游，网关不改写结构。它走的是同步超时预算，不是流式的首字节超时。

</details>

<details>
<summary><b>视频生成（两段式）</b></summary>

```bash
# ① 建任务，立即返回
curl -X POST http://localhost:8080/v1/videos \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-video-v2.0","prompt":"一只猫在跑"}'

# ② 拿上一步的 id 轮询
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

任务在上游异步执行，网关只负责转发与轮询，两步的响应体都原样透传。

</details>

---

## 📡 API 端点

> 📖 详细 API 文档：[简体中文](docs/zh-CN/API.md) | [繁體中文](docs/zh-TW/API.md) | [English](docs/en/API.md) | [日本語](docs/ja/API.md) | [한국어](docs/ko/API.md)

<details>
<summary><b>点击展开完整端点列表</b></summary>

### OpenAI 兼容（`/v1`）

| 方法 | 端点 | 功能 |
|------|------|------|
| GET | `/v1/models` | 模型列表 |
| POST | `/v1/chat/completions` | 对话补全（支持流式） |

### OpenAI Responses（`/v1`）

| 方法 | 端点 | 功能 |
|------|------|------|
| POST | `/v1/responses` | Responses API（支持流式） |

### Anthropic 兼容（`/v1`）

| 方法 | 端点 | 功能 |
|------|------|------|
| POST | `/v1/messages` | Messages（支持流式） |

### Gemini 原生（`/v1beta`）

| 方法 | 端点 | 功能 |
|------|------|------|
| GET | `/v1beta/models` | 模型列表 |
| POST | `/v1beta/models/{model}:generateContent` | 内容生成（非流式） |
| POST | `/v1beta/models/{model}:streamGenerateContent` | 流式生成 |

### 图片与视频

| 方法 | 端点 | 功能 |
|------|------|------|
| POST | `/v1/images/generations` | 图片生成（同步转发） |
| POST | `/v1/videos` | 创建视频任务 |
| GET | `/v1/videos/{id}` | 轮询视频任务 |

### 管理接口

| 方法 | 端点 | 功能 |
|------|------|------|
| GET | `/admin` | 管理面板本体（**未设 `ADMIN_TOKEN` 时整棵树不注册，访问得 404**） |
| GET · POST · PUT · DELETE | `/admin/api/*` | 管理接口：key 池 / 注册机 / 事件 / 用量 / 模型 / 配置（凭 `x-admin-key`） |

### 系统

| 方法 | 端点 | 功能 |
|------|------|------|
| GET | `/health` | 探活（不鉴权，返回版本与存储健康） |

</details>

> URL 里的 `localhost:8080` 只是示例：Node 形态的端口由 `PORT` 决定，Worker 形态是你自己的 `*.workers.dev` 或自定义域名，按你的部署替换。
>
> 鉴权闸接受四种凭据通道：`Authorization: Bearer`、`x-api-key`、`x-goog-api-key`、查询参数 `?key=`。厂商原生的头与参数**同样被接受**，官方 SDK 只换基址即可直连；要换掉的是**值**——任何通道里传的都必须是**本网关**的口令，而不是真正的厂商密钥。

---

## ⚙ 配置说明

优先级：**环境变量 > 存储里的配置 > 内置默认**。下表只列最常用的那几个；全部变量的取值范围与「默认值是怎么算出来的」见 `.env.example` 与各语言的部署文档。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `GATEWAY_TOKEN` | ✅ | — | 网关口令，客户端用它调用本网关；缺失时网关拒绝启动 |
| `ADMIN_TOKEN` | ❌ | — | 管理面板口令；未设时整棵 `/admin` 树不注册，设了必须与网关口令不同且至少 24 位 |
| `AGNES_BASE_URL` | ❌ | `https://apihub.agnes-ai.com/v1` | Agnes 上游基址 |
| `PORT` | ❌ | `8080` | Node 形态的监听端口（Worker 不用） |
| `DATA_DIR` | ❌ | `/app/data` | 文件存储的落盘目录（Worker 不用） |
| `UPSTREAM_TIMEOUT_MS` | ❌ | `8000` | 流式响应与视频轮询的上游首字节超时（毫秒） |
| `UPSTREAM_SYNC_TIMEOUT_MS` | ❌ | `120000` | 同步端点的整体超时预算（毫秒） |
| `MAX_STRIKES` | ❌ | `3` | 瞬时故障累计上限，达到则进入长冷却 |
| `POOL_CACHE_TTL_MS` | ❌ | `60000` | key 池快照在单个 isolate／进程里的存活时长（毫秒） |
| `REGISTRAR_ENABLED` | ❌ | `false` | 注册机总开关；打开后可用 key 低于目标值会自动补池 |
| `TRUST_PROXY` | ❌ | — | 置 1 才信任转发头；放在 Cloudflare 后面时应当设上 |
| `USAGE_STATS_ENABLED` | ❌ | `false` | 面板「用量」板块的时间序列；默认关，关闭时零成本 |

**Cloudflare Worker 侧的配置不走 `.env`**：非敏感项写在 `wrangler.toml` 的 `[vars]` 段里，敏感值用 secret 注入，KV 命名空间与补池 Cron 也在同一份文件里声明。

```bash
npx wrangler secret put GATEWAY_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

---

## ⚠ 注意事项

1. **对外部署必须设置 `GATEWAY_TOKEN`，面板要用就再设 `ADMIN_TOKEN`**：前者缺失时网关**根本起不来**，不存在「没配也能用」这种状态；后者不设时整棵 `/admin` 树**不注册**（404），设了则必须与网关口令不同、且不短于 24 位，否则面板不启用（网关转发不受影响）。

2. **流式输出**：四种协议均支持流式；`stream:false` 时网关同样以 `stream:false` 请求上游，把上游那份 JSON 翻译成你用的协议形状后一次性返回（上游回 `200` 但响应体不是 JSON 时回 `502`）。上游报错原样透传（`401`/`403` 的响应体除外，它可能回显 key 片段）；**上游流中途断开时网关不会插入错误事件**——客户端看到的是一次外观正常收尾的流，要判断有没有被截断请依赖上游自己的 `finish_reason`。

3. **key 池自愈**：上游 `429`/`402` 让对应 key 冷却，连续瞬时故障累计到 `MAX_STRIKES` 后进入长冷却（`COOLDOWN_STRIKE_MS`，默认 30 分钟）、到期自动恢复；**永久剔除只发生在上游 `401`/`403`**。一把可用 key 都没有时返回 `503` 并给出可分辨的原因；同步档把总预算耗光、一把 key 都没应答的那一种返回 `504`。

4. **Cloudflare 免费档的 KV 配额**：每天的读次数只与刷新频率和活跃 isolate 数有关，与请求量无关，但默认值在推荐配置处已经临界。上线前请按部署文档里的「配额账」算一遍，必要时调大 `POOL_CACHE_TTL_MS`。

5. **网络环境**：部署侧需要能访问 Agnes 上游（`AGNES_BASE_URL`）。启用注册机时还要能访问所选的临时邮箱服务与 Agnes 平台后端。

---

## 🗂 项目结构

```
agnes2api/
├── src/
│   ├── entry/                      # 两个运行时入口
│   │   ├── node.ts                 #   Node / Docker（监听端口 + 定时补池）
│   │   └── worker.ts               #   Cloudflare Worker（fetch + scheduled）
│   ├── http/                       # 路由装配、鉴权闸、错误出口
│   │   ├── app.ts                  #   路由树（顺序敏感，注释里写明了原因）
│   │   ├── routes/                 #   四协议入口 + 媒体转发 + /health
│   │   ├── middleware/             #   鉴权
│   │   └── admin/                  #   /admin 子树（未配口令则整棵不注册）
│   ├── core/                       # 与运行时无关的内核
│   │   ├── dispatcher.ts           #   转发内核（取号、重试、失败归因）
│   │   ├── keypool.ts              #   key 池状态机（冷却 / 剔除 / strike）
│   │   ├── config.ts               #   配置（env > 存储 > 默认）
│   │   ├── protocol/               #   四协议的请求/响应转换与 SSE
│   │   ├── registrar/              #   注册机（双通道、铸 key、补池）
│   │   └── admin/                  #   面板用的纯逻辑（校验、统计、事件环）
│   ├── adapters/                   # 端口实现
│   │   ├── storage-kv.ts           #   Worker：KV 存储
│   │   ├── storage-file.ts         #   Node：单文件 JSON 存储
│   │   ├── mailbox-yyds.ts         #   注册机通道之一
│   │   └── mailbox-moemail.ts      #   注册机通道之一
│   ├── ports/                      # 抓取 / 日志 / 邮箱 / 存储的接口定义
│   └── ui/                         # 面板静态资源的生成物
├── admin-ui/                       # 管理面板源码（零构建，原样挂载）
├── docs/                           # 5 语言文档
│                                   #   README/API/DEPLOY/USAGE/ADMIN/REGISTRAR/SPONSORS
├── scripts/                        # 门禁脚本与发版脚本
├── tests/                          # 单元 / 契约（双运行时）/ 前端纯函数
├── data/                           # 持久化数据（Docker 卷挂载；Worker 走 KV 不用它）
├── Dockerfile                      # 多阶段构建（多架构、非 root）
├── docker-compose.yml              # 编排配置
├── wrangler.toml                   # Cloudflare Worker 编排（KV 绑定 + 补池 Cron）
├── package.json
└── .env.example
```

---

## 🗺 开发路线

- [x] 四协议前端（OpenAI / Anthropic / OpenAI-Responses / Gemini）
- [x] 统一转发内核 + 四种凭据通道的鉴权闸
- [x] 流式（SSE）与非流式在四条协议上一致
- [x] 图片生成转发 + 视频生成两段式转发
- [x] key 池：取号、分级冷却、永久剔除、可分辨的耗尽原因
- [x] 双运行时：Cloudflare Worker（KV）与 Node / Docker（文件存储）同一份代码
- [x] 注册机：两条临时邮箱通道平级，从收码到入池全自动
- [x] Web 管理面板八个板块（零构建，默认关闭）
- [x] 管理接口鉴权：fail-closed，口令只走请求头
- [x] 五语言文档与五语言面板
- [x] CI 十三道门禁 + 双运行时契约测试
- [ ] 用真实上游样本核对协议目录（今天上游事实表里每一条都标着 assumed）
- [ ] 发布首个公开容器镜像

---

## ☕ 赞赏 & 共享

> 完整内容请查看 [SPONSORS.md](SPONSORS.md)

觉得有帮助？欢迎给项目点个 Star，这是对开源维护者最直接的支持。

agnes2api 主要由个人维护，欢迎通过代码、文档、修复或 PR 参与建设。

**参与贡献：**

1. Fork 本仓库
2. 创建分支 `git checkout -b feature/your-feature`
3. 提交代码 `git commit -m "feat: add something"`
4. 推送并创建 Pull Request

提代码前请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。发现安全问题请按 [SECURITY.md](SECURITY.md) 私下上报，不要开公开 issue。

---

## 🙏 致谢

感谢每一位愿意花时间试用它的人。bug 复现、日志、兼容性反馈和功能建议都欢迎提到 [Issues](https://github.com/xwteam/agnes2api/issues) —— 这是首个版本，key 池、注册机、双运行时、多协议兼容、Web 面板都还在等真实场景来打磨。

---

## ⭐ Star History

<a href="https://star-history.com/#xwteam/agnes2api&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=xwteam/agnes2api&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=xwteam/agnes2api&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=xwteam/agnes2api&type=date&legend=top-left" />
 </picture>
</a>

---

## 📄 许可协议

本项目采用 [MIT 许可](LICENSE)：

- **授予**：使用、复制、修改、合并、发布、分发、再授权与销售本软件的权利
- **要求**：保留版权与许可声明

本项目与 Agnes AI 无关联。使用者需自行承担风险并遵守相关服务条款。

---

## ⚠ 免责声明

1. **技术性质**：agnes2api 是一个技术研究项目，把 Agnes AI 后端封装为多协议兼容 API。本项目不提供任何 AI 服务，所有生成内容均来自上游。使用本项目可能违反相关服务条款，由此产生的一切后果由使用者自行承担。

2. **无担保声明**：本项目按"原样"提供，不作任何明示或暗示的保证，包括但不限于适销性、特定用途适用性。开发者不对因使用本项目导致的账号封禁、数据丢失或其他任何损失承担责任。

3. **数据与隐私**：本项目跑在**你自己的 Cloudflare 账号或你自己的服务器**上，作者侧不接收、不上传、不存储任何数据。你的上游 key 与网关口令只保存在你的 KV 命名空间或本地配置里，请妥善保管，切勿泄露；启用注册机时它还会代你访问所选的临时邮箱服务，那条链路上的数据同样只经过你自己的部署。

4. **合规责任**：使用者应确保其使用行为符合所在地区的法律法规。严禁将本项目用于任何违法违规活动。

5. **第三方服务**：本项目与 Agnes AI 无任何关联或授权关系。上游服务的可用性、稳定性及内容准确性均由其提供方负责，与本项目无关。

---

<div align="center">
  <sub>Built with TypeScript + Hono + Cloudflare Workers | Powered by Agnes AI</sub>
</div>
