# agnes2api

[![version](https://img.shields.io/badge/version-v0.1.0-success)](../../CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)

**语言：** [English](../en/README.md) | 简体中文 | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | [한국어](../ko/README.md)

agnes2api 是一个轻量级 API 网关，位于 Agnes AI 服务之前，把它重新暴露为四种主流 LLM
API 协议——OpenAI、Anthropic、Gemini、OpenAI-Responses——并提供图片与视频生成的转发端点。
它同时支持 Cloudflare Worker 与 Docker 两种部署形态，并内置一套会自我修复的 key 池：
异常的上游 key 会被自动冷却或剔除。

> **关于商业使用**
>
> 本项目采用 MIT 许可证，**法律上允许商业使用**。但我们**不建议**将其用于商业服务：
>
> 1. 项目依赖第三方服务的免费额度，其可用性、延迟与配额政策随时可能变化，不具备商业
>    服务所需的稳定性保障
> 2. 批量获取免费额度的做法与上游服务条款存在张力，该风险由使用者完全承担
> 3. 项目不提供任何可用性承诺或技术支持
>
> （以上仅为建议，不具有法律约束力，也不是许可证条款的一部分。）

## 特性

- **四种协议、同一上游** —— OpenAI、Anthropic、Gemini、OpenAI-Responses 的官方客户端都能
  直接对接本网关，含流式响应。
- **图片与视频转发** —— 图片生成的同步转发，以及视频生成的建任务/轮询两段式流程。
- **两种部署形态、同一套代码** —— Cloudflare Worker（KV 存储）或 Docker（文件存储），
  两者运行完全相同的请求处理逻辑。
- **会自我修复的 key 池** —— 上游 `429`/`402` 会让对应 key 进入冷却，`401`/`403` 会将其
  永久剔除，连续瞬时故障累计到阈值后同样剔除。
- **存储访问与流量解耦** —— key 池按 isolate／进程缓存，只改遥测字段的更新会被整个丢弃，
  因此稳态下存储的读与写都不随请求量增长。这在 Cloudflare 免费档 KV 上究竟留下多少余量，
  取决于同时活跃的 isolate 数——完整算法与两个可调旋钮见 [DEPLOY.md](DEPLOY.md) 的
  「配额账」小节。
- **接受四种凭据传递方式** —— `Authorization: Bearer`、`x-api-key`、`x-goog-api-key`、
  查询参数 `?key=` 均被接受，正好覆盖各协议官方 SDK 默认发送的凭据形式。
- **可选的自动补池（默认关闭）** —— 启用注册机后，可用 key 低于目标值时会自动注册
  Agnes 账号补齐，见 [REGISTRAR.md](REGISTRAR.md)。

## 端点速查

| 方法 | 路径 | 协议 | 说明 |
|---|---|---|---|
| GET | `/health` | – | 无需鉴权 |
| GET | `/v1/models` | OpenAI | 模型列表 |
| POST | `/v1/chat/completions` | OpenAI | 支持流式 |
| POST | `/v1/messages` | Anthropic | 支持流式 |
| POST | `/v1/responses` | OpenAI-Responses | 支持流式 |
| GET | `/v1beta/models` | Gemini | 模型列表 |
| POST | `/v1beta/models/{model}:generateContent` | Gemini | 非流式 |
| POST | `/v1beta/models/{model}:streamGenerateContent` | Gemini | 流式 |
| POST | `/v1/images/generations` | – | 图片生成 |
| POST | `/v1/videos` | – | 创建视频任务 |
| GET | `/v1/videos/{id}` | – | 轮询视频任务 |

完整请求/响应示例：[API.md](API.md)

## 模型

| 模型 | 类型 |
|---|---|
| `agnes-2.0-flash` | 对话 |
| `agnes-image-2.1-flash` | 图片 |
| `agnes-image-2.0-flash` | 图片 |
| `agnes-video-v2.0` | 视频 |

## 快速开始

### Cloudflare Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xwteam/agnes2api)

```bash
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api
pnpm install
npx wrangler kv namespace create POOL   # 把返回的 id 填入 wrangler.toml
npx wrangler secret put GATEWAY_TOKEN
npx wrangler deploy
```

### Docker

```bash
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api
cp .env.example .env   # 设置 GATEWAY_TOKEN
docker compose up -d
```

完整部署指南、环境变量说明与手动导入 key 的方法：[DEPLOY.md](DEPLOY.md)

## 接入网关

本网关可作为 OpenAI SDK、Anthropic SDK、Google GenAI SDK 的基址直接替换使用，各语言的
接入示例见 [USAGE.md](USAGE.md)。

## 许可证

MIT —— 见 [LICENSE](../../LICENSE)。
