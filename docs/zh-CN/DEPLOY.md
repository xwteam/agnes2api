# 部署指南

**语言：** [English](../en/DEPLOY.md) | 简体中文 | [繁體中文](../zh-TW/DEPLOY.md) | [日本語](../ja/DEPLOY.md) | [한국어](../ko/DEPLOY.md)

agnes2api 提供两种部署形态，构建自同一套代码与请求处理逻辑，按你的基础设施二选一即可。
两者仅在存储后端上有区别：Worker 用 Cloudflare KV 命名空间，Docker 用挂载卷上的 JSON
文件。

## 环境变量

| 变量 | 是否必填 | 默认值 | 说明 |
|---|---|---|---|
| `GATEWAY_TOKEN` | **是** | – | 客户端调用本网关时必须携带的令牌。 |
| `AGNES_BASE_URL` | 否 | `https://apihub.agnes-ai.com/v1` | 上游 Agnes API 的基址。 |
| `UPSTREAM_TIMEOUT_MS` | 否 | `8000` | 上游首字节超过这个毫秒数未返回则中止本次调用。 |
| `MAX_STRIKES` | 否 | `3` | 连续瞬时故障（超时、网络错误、上游 `5xx`）累计到该阈值后，该 key 进入长冷却。 |
| `COOLDOWN_RATE_LIMIT_MS` | 否 | `60000` | 上游返回 `429` 后，对应 key 的冷却时长。 |
| `COOLDOWN_PAYMENT_MS` | 否 | `3600000` | 上游返回 `402` 后，对应 key 的冷却时长。 |
| `COOLDOWN_STRIKE_MS` | 否 | `1800000` | key 的瞬时故障累计到 `MAX_STRIKES` 后的冷却时长，到期自动恢复。 |
| `PORT` | 否（仅 Node/Docker） | `8080` | Node 运行时的监听端口，Worker 不使用该变量。 |
| `DATA_DIR` | 否（仅 Node/Docker） | `/app/data` | 文件存储写入 `store.json` 的目录，Worker 不使用该变量。 |

`COOLDOWN_RATE_LIMIT_MS` 与 `COOLDOWN_PAYMENT_MS` 默认没有写在 `.env.example` 里，但两种
部署形态都会读取这两个环境变量，可按需设置。以上数值型变量都必须是正整数，否则网关
拒绝启动。

「剔除」与「冷却」是两回事。无论以上参数如何设置，上游 `401`/`403` 都会**永久**剔除该
key——这两种状态被视为「这个 key 已失效」，重试没有意义。瞬时故障则永远不会导致剔除：
累计到 `MAX_STRIKES` 只是进入 `COOLDOWN_STRIKE_MS` 的冷却，到期自动恢复，因此上游抽风
不会永久损毁你的 key 池。

当没有任何 key 能服务本次请求时，网关返回 `503`，并在 `error.reason` 里给出可判别的原因：
`pool_empty`（尚未导入 key）、`all_cooling`（全部 key 冷却中，会自动恢复，响应头 `Retry-After`
给出恢复时刻）、`all_evicted`（全部 key 因凭据失效被永久剔除，**不会**自愈，请更换 key）、
`upstream_error`（key 本身可用，但上游每次尝试都失败）。

## Cloudflare Worker

### 方式一：Deploy to Cloudflare 按钮

点击根目录 [README](../../README.md) 中的按钮，授权 Cloudflare 后会自动 fork/clone 本
仓库并完成部署。之后仍需按下文完成 **secret** 与 **KV 命名空间** 两步——按钮本身不会
帮你配置这两项。

### 方式二：手动部署

1. 克隆仓库并安装依赖：

   ```bash
   git clone https://github.com/xwteam/agnes2api.git
   cd agnes2api
   pnpm install
   ```

2. 为 key 池创建一个 KV 命名空间并绑定为 `POOL`：

   ```bash
   npx wrangler kv namespace create POOL
   ```

   把返回的命名空间 `id` 填入 `wrangler.toml`，替换掉
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`：

   ```toml
   [[kv_namespaces]]
   binding = "POOL"
   id = "your-namespace-id"
   ```

3. 把网关令牌设置为 Worker secret（绝不要提交进 `wrangler.toml`）：

   ```bash
   npx wrangler secret put GATEWAY_TOKEN
   ```

4. 部署：

   ```bash
   npx wrangler deploy
   ```

### 打 tag 自动部署

`.github/workflows/deploy-worker.yml` 会在推送 `v*` tag 时自动部署 Worker，前提是仓库
在 **Settings → Secrets and variables → Actions** 中配置了 `CLOUDFLARE_API_TOKEN`。若未
配置，工作流会打印警告并跳过部署步骤，不会导致整个运行失败。

### 本地开发

```bash
npx wrangler dev
```

把 `GATEWAY_TOKEN` 写进 `wrangler.toml` 同目录下的本地 `.dev.vars` 文件（已加入
`.gitignore`）——不要把密钥直接写进 `wrangler.toml`。

## Docker

1. 克隆仓库并准备环境变量文件：

   ```bash
   git clone https://github.com/xwteam/agnes2api.git
   cd agnes2api
   cp .env.example .env
   ```

2. 编辑 `.env`，至少设置 `GATEWAY_TOKEN`。其余变量见上文的
   [环境变量](#环境变量) 表。

3. 启动容器：

   ```bash
   docker compose up -d
   ```

   `docker-compose.yml` 默认发布 `8080` 端口（可通过 `.env` 里的 `PORT` 覆盖），并把
   `./data` 挂载到容器内的 `/app/data`——`store.json`（key 池与任何持久化配置）就存在
   这里。重启/升级时务必保留这个目录，它是已导入 key 池的唯一副本。

4. 确认容器健康：

   ```bash
   curl http://localhost:8080/health
   ```

   镜像内置了 `HEALTHCHECK`，Docker 会据此上报容器健康状态。

## 导入 Agnes 上游 key

当前版本的网关没有提供导入 key 的 HTTP 接口，需要直接写入存储后端。每条记录是一个
键为 `key:<id>` 的 JSON 对象，`<id>` 可以是池内唯一的任意字符串（网关自己创建记录时
会用 key 的哈希值派生一个，但读取时不校验这个值，所以手动导入时用任意唯一标识即可）：

```json
{
  "id": "1a2b3c4d5e6f7a8b",
  "key": "你的真实-agnes-api-key",
  "addedAt": 1735689600000,
  "lastUsedAt": null,
  "cooldownUntil": 0,
  "strikes": 0,
  "evicted": false,
  "evictedReason": null
}
```

### Docker

先停止容器，避免与正在运行的进程产生写入竞争；在宿主机上编辑 `./data/store.json`，
在键 `"key:1a2b3c4d5e6f7a8b"` 下加入如上记录，然后再启动容器：

```bash
docker compose stop
# 编辑 ./data/store.json
docker compose start
```

如果 `./data/store.json` 还不存在，直接新建一个 JSON 对象文件，键为若干个
`key:<id>` 字符串即可。

### Cloudflare Worker

用 wrangler 直接把记录写进 `POOL` KV 命名空间：

```bash
npx wrangler kv key put --binding=POOL "key:1a2b3c4d5e6f7a8b" \
  '{"id":"1a2b3c4d5e6f7a8b","key":"你的真实-agnes-api-key","addedAt":1735689600000,"lastUsedAt":null,"cooldownUntil":0,"strikes":0,"evicted":false,"evictedReason":null}' \
  --remote
```

不加 `--remote` 则写入 `wrangler dev` 使用的本地命名空间，而不是生产环境。
