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
| `UPSTREAM_TIMEOUT_MS` | 否 | `8000` | **流式**响应与视频轮询的首字节超时：超过这个毫秒数未收到上游首字节则中止本次调用。 |
| `UPSTREAM_SYNC_TIMEOUT_MS` | 否 | `120000` | **同步**端点的整体超时预算，只作用于「首字节要等上游把整个结果算完才到达」的请求：图片生成、视频建任务，以及所有**非流式**对话。见下文说明。 |
| `MAX_STRIKES` | 否 | `3` | 连续瞬时故障（超时、网络错误、上游 `5xx`）累计到该阈值后，该 key 进入长冷却。 |
| `COOLDOWN_RATE_LIMIT_MS` | 否 | `60000` | 上游返回 `429` 后，对应 key 的冷却时长。 |
| `COOLDOWN_PAYMENT_MS` | 否 | `3600000` | 上游返回 `402` 后，对应 key 的冷却时长。 |
| `COOLDOWN_STRIKE_MS` | 否 | `1800000` | key 的瞬时故障累计到 `MAX_STRIKES` 后的冷却时长，到期自动恢复。 |
| `POOL_CACHE_TTL_MS` | 否 | `60000` | 每个 isolate/进程在内存里缓存一份 key 池快照，本值是它的存活时长；`0` = 关闭缓存。**KV 读取次数与请求数无关**，只取决于刷新频率，算法见下文「配额账」。代价：别的 isolate 判定的冷却/剔除，本 isolate 最多晚这么久才看到。 |
| `POOL_TOUCH_INTERVAL_MS` | 否 | `21600000` | key 的「最后使用时间」最多多久落盘一次；`0` = 每次成功请求都落盘。它是纯展示字段、不参与调度，为它每请求写一次 KV 会把免费档 1,000 次/天的写配额吃光，连冷却与剔除都写不进去。代价：面板「最后使用」的精度最粗到这个间隔。 |
| `PORT` | 否（仅 Node/Docker） | `8080` | Node 运行时的监听端口，Worker 不使用该变量。 |
| `DATA_DIR` | 否（仅 Node/Docker） | `/app/data` | 文件存储写入 `store.json` 的目录，Worker 不使用该变量。 |

`COOLDOWN_RATE_LIMIT_MS` 与 `COOLDOWN_PAYMENT_MS` 默认没有写在 `.env.example` 里，但两种
部署形态都会读取这两个环境变量，可按需设置。以上数值型变量都必须是整数；除
`POOL_CACHE_TTL_MS` 与 `POOL_TOUCH_INTERVAL_MS` 的下界是 `0`（`0` 表示「关闭」）之外，
其余都必须大于 `0`，否则网关拒绝启动。

`POOL_CACHE_TTL_MS` 与 `POOL_TOUCH_INTERVAL_MS` 是**建 app 时读一次**的，改了要重启容器 /
等 isolate 回收才生效，不像其余配置项那样逐次生效。

### 配额账：Worker + 免费档 KV 能撑多少请求

免费档 KV 每天 100,000 次读、1,000 次写。网关的读写次数都**不随请求数增长**，所以这笔账
不是「每请求几次」，而是「每天固定几次」：

- **默认配置下 KV 不再是瓶颈**，上限变成 Cloudflare Worker 免费档自身的 **100,000 次请求/天**。
  但这条结论**有前提，不是无条件的**：KV 的读配额转而约束「同时活跃的 isolate 数」，而那
  是随流量地理分布变化的量，你无法直接设定。每个活跃 isolate 每天消耗

      (86400 ÷ POOL_CACHE_TTL_MS 秒数) × (1 + 池中 key 数)  +  2880

  次读，末项 2880 是配置持有者每 30 秒一次的刷新，吃同一个桶。默认值 + 20 把 key 时
  是每 isolate **33,120 次**，加上每天 48~96 次索引对账，**3 个活跃 isolate 就用掉约 99.5%**。
  也就是默认值在推荐配置处已经临界；预期 isolate 更多就要把 `POOL_CACHE_TTL_MS` 调大
  （20 把 key、5 个 isolate 需要约 `120000`）。
- **关掉缓存**（`POOL_CACHE_TTL_MS=0`，逃生口）时读随请求数线性增长，保底约
  `100,000 ÷ (1 + key 数)` ⇒ 20 把 key 时约 **4,700 次请求/天**。
- **写侧**：稳态每天约 `key 数 × 4` 次（`lastUsedAt` 每 6 小时触达一次），20 把 key 时 80 次，
  占写配额 8%，其余留给冷却与剔除的记账。每把 key **首次**被用到时另有一次性的一次写。

### 注册机相关变量（可选，默认关闭）

注册机是一套可选的自动补池组件，默认关闭，不影响网关的核心转发功能。以下只列变量速查，
工作原理、两条邮箱通道如何选择、Cloudflare Cron 墙钟限制等完整说明见
[REGISTRAR.md](REGISTRAR.md)。

| 变量 | 是否必填 | 默认值 | 说明 |
|---|---|---|---|
| `REGISTRAR_ENABLED` | 否 | `false` | 总开关，为 `true` 才会启用注册机。 |
| `REGISTRAR_PRIMARY` | 启用时必填 | 无 | 主通道，`yyds` 或 `moemail`；两者平级，无默认值。 |
| `REGISTRAR_FALLBACK` | 否 | 空（不降级） | 备通道，`yyds` 或 `moemail`。 |
| `TARGET_KEYS` | 否 | `20` | 目标可用 key 数。 |
| `MINT_BATCH` | 否 | `5` | 单轮最多铸几把 key。 |
| `TEND_INTERVAL_MS` | 否（仅 Node/Docker） | `1800000` | Node 侧补池间隔；Worker 侧由 `wrangler.toml` 的 Cron 决定。 |
| `CODE_TIMEOUT_MS` | 否 | `120000` | 轮询验证码的超时。 |
| `MINT_DELAY_MIN_MS` / `MINT_DELAY_MAX_MS` | 否 | `2000` / `5000` | 每次铸 key 之间的随机间隔。 |
| `MAX_DOMAIN_ATTEMPTS` | 否 | `8` | 单次铸 key 最多尝试几个域名。 |
| `REGISTRAR_TOKEN_NAME` | 否 | `auto` | 铸出的 key 在 Agnes 后台显示的名称。 |
| `AGNES_PLATFORM_URL` | 否 | `https://platform-backend.agnes-ai.com` | 注册用的 Agnes 平台后端地址。 |
| `YYDS_BASE_URL` / `YYDS_API_KEY` | 否 / 通道为 yyds 时必填 | `https://maliapi.215.im` / 空 | YYDS Mail 通道凭据。 |
| `MOEMAIL_BASE_URL` / `MOEMAIL_API_KEY` | 通道为 moemail 时必填 | 空 / 空 | MoeMail 通道凭据（自建服务，无默认地址）。 |

### 两档超时分别管什么

判据是「上游的第一个字节什么时候才可能到达」，不是端点的名字：

| 档位 | 适用端点 | 用哪个变量 |
|---|---|---|
| 首字节档 | **流式**对话（`stream: true`）、视频轮询 `GET /v1/videos/{id}` | `UPSTREAM_TIMEOUT_MS` |
| 同步档 | 图片生成、视频建任务、**所有非流式对话**（四种协议均如此） | `UPSTREAM_SYNC_TIMEOUT_MS` |

非流式请求要等上游把整段回答生成完才发响应头，和图片生成是同一种延迟语义，用 8 秒的
首字节档去卡它只会让正常请求大量失败并连累 key 池。

`UPSTREAM_SYNC_TIMEOUT_MS` 是**一次请求的总预算**，也就是客户端的最坏等待时间——不是
「池大小 × 预算」。网关在这个预算里最多为单把 key 花掉一半，剩下的用来换一把 key 再试，
这样池里有一把 key 挂起（连得上但永不响应）时不会白白吃掉这次请求。因此把它设成
**单次调用最坏耗时的两倍以上**。

同步档超时不会立刻惩罚 key：只有当同一次请求里换的另一把 key 真的成功了，网关才把超时
算到先超时的那把 key 头上（累计到 `MAX_STRIKES` 进冷却）；如果本次请求里每一把都超时，
则一把都不惩罚——那更可能是预算配小了或上游整体变慢。

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

   镜像内置了 `HEALTHCHECK`，Docker 会据此上报容器健康状态。数据目录不可写时 `/health`
   返回 `503` 且 `status` 为 `degraded`，容器会被标成 unhealthy，具体原因见容器日志。

### 容器会改写 `./data` 的属主（请先知悉）

容器**以 root 进入 entrypoint**，做两件事后再降权：

- 若 `DATA_DIR`（默认 `/app/data`）的属主与容器内运行用户 `app`（**uid 100 / gid 101**）
  不一致，就递归 `chown` 该目录；属主已经一致时不做任何改写。
- 随后用 `su-exec` 降权，**主进程（PID 1）以 app 运行，不是 root**。

必须在运行期做这件事的原因是：绑定挂载时宿主目录的属主会盖过镜像里构建期的 `chown`，
容器内的 app 因此写不进 `store.json`，而这种失败是静默的（所有 API 返回 `pool_empty`）。

**副作用**：绑定挂载改的是**宿主**上的文件——`docker compose up -d` 之后，你的 `./data`
及其中的文件属主会从你自己的 uid 变成 `100:101`，之后在宿主上读写或备份它需要 `sudo`。
不希望发生这件事的话，用 `--user`（或 compose 的 `user:`）指定非 root 运行：此时
entrypoint 完全不 chown，数据目录的属主与可写性由你自己准备。

出于同样的原因，镜像**没有** `USER app`，默认用户是 root
（`docker inspect --format '{{.Config.User}}' <image>` 输出为空）。这对 Kubernetes 有影响：
配了 `runAsNonRoot: true` 却没显式给 `runAsUser` 时，kubelet 会拒绝启动该容器。这类部署请
显式写 `runAsUser: 100`、`runAsGroup: 101`（或任何你自己的 uid），并自行准备卷的属主——
非 root 启动时 entrypoint 走的是「不 chown、直接执行」的分支。

安全边界：`DATA_DIR` 被设成 `/` 或某个顶层系统目录（`/etc`、`/usr` 等）时，entrypoint
拒绝在其上递归 chown（只打印警告，不影响启动），避免把整个容器文件系统改成 app 可写。

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

这样导入的 key 从下一个请求起立即生效：网关用一个 `pool:index` 键保存池内的 id 列表
（这样每次转发都不必消耗 KV 的 `list` 操作——免费档的 list 配额只有每天 1,000 次），
而索引不知道的手工导入记录会被自动发现并补进索引。

**即使你完全不用注册机，也不要删掉 `wrangler.toml` 里的 `[triggers]`**：那个 cron 是
`pool:index` 与实际 `key:` 记录之间唯一的对账修复路径，且与 `REGISTRAR_ENABLED` 无关。
