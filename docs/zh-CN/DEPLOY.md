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
| `POOL_CACHE_TTL_MS` | 否 | `60000` | 每个 isolate/进程在内存里缓存一份 key 池快照，本值是它的存活时长；`0` = 关闭缓存。**KV 读取次数与请求数无关**，只取决于刷新频率，算法见下文「配额账」。代价：别的 isolate 判定的冷却/剔除，本 isolate 最多晚**本值 + 约 60 秒**才看到（后者是 KV 边缘缓存的默认 `cacheTtl`）；默认 60000 时上界约 **120 秒**。而且不只是「看得晚」：陈旧快照上的任意一次调度写会把整条记录覆写回去，**抹掉**别的 isolate 在这个窗口里刚写下的 `evicted` / `cooldownUntil`，那次判定要重新发生一遍。 |
| `POOL_TOUCH_INTERVAL_MS` | 否 | `21600000` | key 的「最后使用时间」最多多久落盘一次；`0` = 每次成功请求都落盘。它是纯展示字段、不参与调度，为它每请求写一次 KV 会把免费档 1,000 次/天的写配额吃光，连冷却与剔除都写不进去。代价：面板「最后使用」的精度最粗到这个间隔。同一个间隔也管着面板上的用量计数（请求数 / 成功率）。**手工改小存储里的 `stats`（例如清零）之后，面板可能先显示为已清零、随后又被顶回旧值**：快照过一个 TTL 会读到清零后的值，而还在运行的实例记着自己的落盘基线，下一次真落盘又会按基线写回去，最迟到这个实例被回收之后才真正一致；P3c 会提供一条经过 repo 的正式重置路径。 |
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
- **`list` 与 `delete` 是另外两个桶，各 1,000 次/天**，与读、写那两个桶互不相通。稳态转发
  一次 `list` 都不用——`pool:index` 索引键正是为此存在的。会消耗它的一共**三处**：每天
  48~96 次索引对账（独立的定时任务）；**池子为空时的兜底扫描**（索引合法却一条活记录都
  读不到时，网关 `list` 一次，确认是不是有手工导入的记录没进索引）；以及**索引缺失回落**
  （`pool:index` 本身读不出来或结构损坏时，网关同样 `list` 一次并尝试重建索引，多半是写桶
  被打穿导致索引一直建不起来）。后两者**共用同一个**内置的 **10 分钟**退避窗口（固定常量，
  不是环境变量）——它们通向同一个 `list` 桶，各自开一扇窗等于没开——因此空池或索引损坏期间
  每个 isolate 每天最多 144 次，叠上索引对账的 48~96 次仍有余量。
- **`list` 桶被打穿的后果是失能而不是降级。** 池子为空且 `list` 失败时，网关返回 `500` 并把
  真实原因写进日志，**不会**伪装成 `503 pool_empty`——因为此时对账用的是同一个桶、同样在失败，
  本文档给出的两条自愈路径都已经不可用，只能等 UTC 跨天配额重置。

**上面的读取公式有一个前提：「isolate 活得比 TTL 长」。** 流量很低、或者分散到很多
Cloudflare 边缘节点时，isolate 常常活不满一个 TTL 就被回收，那时每个 isolate 一生至少
要装载一次池子，读取次数由**冷启动次数**而不是 TTL 决定，上界约
`100000 ÷ (池中 key 数 + 2)` 次冷启动/天（分母里的 `+2` 是索引与配置各一次）。**这个区间
里调大 `POOL_CACHE_TTL_MS` 一次读都省不掉**——它只能省「同一个 isolate 内的重复装载」。

同理，空池态与索引缺失态的 `list` 退避也是**每实例**的：冷 isolate 各付一次，总量随
isolate 数线性增长。

### 管理面板相关变量（P3，默认关闭）

| 变量 | 是否必填 | 默认值 | 说明 |
|---|---|---|---|
| `ADMIN_TOKEN` | 否 | 无（面板不启用） | 管理接口的口令。**必须与 `GATEWAY_TOKEN` 不同**，且至少 24 位。另外**首尾不得有空白**：HTTP 请求头的值在传输层会被去掉首尾空白，而环境变量不会，带空白的口令任何客户端都送不出来。未设置或不合规时整棵 `/admin` 树都不注册，具体原因记在 `admin.token_rejected` 事件里。 |
| `TRUST_PROXY` | 否 | 未设置（**任何**转发头都不信） | 只有在网关确实位于代理之后时才设成 `1`——**Cloudflare Worker 形态也属于这种情况，应当设上**。设了之后，登录失败事件里的客户端 IP 取自 `CF-Connecting-IP`，缺席时才退到 `X-Forwarded-For` 的首段。 |

**没配就是面板整个不可用，而网关照常转发。** 此时访问 `/admin/...` 得到的是 **`404` 而不是
`401`**：整棵树压根没注册，因此不会泄漏「这里有个后台」。这与注册机默认关闭是同一条规矩——
`ADMIN_TOKEN` 缺失或配错，绝不能让网关转发停摆。

**为什么有 24 位的下限。** Worker 形态**没有分布式登录限速**。要做它就得拿 KV 当计数窗口，
那等于给攻击者一根消耗写配额的杠杆，把攻击面从「猜口令」扩大到「打死 key 池的状态回写」。
因此口令熵是这里唯一的防线，下限不是建议值。低于下限时面板不会启用，容器日志里会有一条
`admin.token_rejected`。

**为什么必须与 `GATEWAY_TOKEN` 不同。** `GATEWAY_TOKEN` 是你发给**每一个下游用户**的中转
口令。复用它当面板口令，等于任何拿到中转口令的人都能读走你的整池 key、关掉注册机、把注册
后端指向他自己的服务器——从此每一次注册的邮箱、密码、验证码都会被他收走。

这条规则**只在每一个管理请求上复查，不在启动时拦**。若两者相同——例如用
`wrangler kv key put` 或直接编辑 `store.json` 手工把 `gatewayToken` 写成了管理口令——管理
接口会**返回 `503`**，同时打一条 error 级的 `admin.token_conflict`（启动时就撞上冲突的话，
启动日志里也会有同样一条，方便你立刻看到原因）。**网关转发不受影响。** 把其中任一把口令改回去，
管理接口会自行恢复：改存储里的 `gatewayToken`，在配置缓存下一次刷新之后生效，**不需要重启**；
改 `ADMIN_TOKEN` 则因为它是环境变量，需要重新部署（Worker）或重建容器（Docker）。

**为什么这一条刻意不在启动时拦。** `gatewayToken` 运行中会变，而启动时的判定没有第二次求值的
机会：一旦在那里把整棵 `/admin` 树反注册掉，冲突期间冷启动的 isolate（以及冲突期间启动的整个
Docker 容器）就会**永久 404**，把配置改回去也救不了，必须重启——而冲突之前建好的那些只是 `503`
且改回去立刻恢复。同一份配置、同一时刻两种结果，上面那句「不需要重启」就成了半句假话。
相比之下 `ADMIN_TOKEN` 自身的两条规则（首尾空白 / 长度不足）只取决于环境变量，运行中不会变，
所以它们仍然在启动时拦，失效形态是 `404`。

`ADMIN_TOKEN` **只从环境变量读、不从存储读**：面板不能自助轮换自己的钥匙。轮换方式：Worker
执行 `npx wrangler secret put ADMIN_TOKEN` 后重新部署；Docker 改 `.env` 后重建容器。

**`TRUST_PROXY` 是安全开关，所以默认关闭。** 它决定的客户端 IP 会写进 `admin.login_failed`
事件，无脑信任一个由客户端提供的头，等于允许任何人把爆破痕迹嫁祸给任意 IP。

**关闭时任何转发头都不信，该字段一律记 `null`——`CF-Connecting-IP` 也不例外。** 这个头常被说成
「平台注入、伪造不了」，但那个性质**只在请求真的经过 Cloudflare 时**成立；Node/Docker 直连暴露时
没有任何东西会覆盖它，客户端自己发一个 `CF-Connecting-IP: 1.2.3.4` 就会被采信——而直连正是 Docker
部署的默认形态。

**打开时 `CF-Connecting-IP` 优先，`X-Forwarded-For` 只作兜底。** 两个头的可伪造性根本不同：

- `CF-Connecting-IP` 由 Cloudflare 边缘写入，并且会**覆盖**客户端传来的同名头——只要请求真的经过
  Cloudflare，它就伪造不了。
- `X-Forwarded-For` 是任何中间件都能追加的链，客户端可以自己发一个假的，可信与否完全取决于你的
  代理链长什么样。

**Worker 形态请设 `TRUST_PROXY=1`。** 那里 Cloudflare 定义上就在前面，`CF-Connecting-IP` 是权威值；
在这种形态下优先 `X-Forwarded-For` 是错的——那条链里可能装着客户端自己塞的东西。不设这个开关的话，
该字段就只是记成 `null`。

**通用反代（nginx / Caddy / Traefik）后面打开 `TRUST_PROXY=1` 时，请在反代上把
`CF-Connecting-IP` 剥掉。** 那种拓扑里没有任何东西会覆盖这个头，而网关按「Cloudflare 在前面」
优先采信它，于是攻击者自带一个就会**压过**反代刚写好的 `X-Forwarded-For`。nginx 加一行即可：

```nginx
proxy_set_header CF-Connecting-IP "";
```

Caddy 用 `header_up CF-Connecting-IP ""`，Traefik 用中间件的 `customRequestHeaders`。

**两个头都会先过一遍形态校验**：只有 IPv4 点分十进制与 IPv6 形态（十六进制、冒号，以及
`::ffff:` 映射里的点）能进事件，其余一律记 `null`。这条不是鉴权防线（这个值全仓只有登录失败
事件一个消费点），它防的是「未鉴权的调用方往审计字段里塞任意文本」——管理面板的事件板块
要按这个字段做筛选与展示。

什么都拿不到时该字段如实记 `null`，**绝不伪造一个 `"unknown"`**——那会被当成一个真实来源。

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

2. 为 key 池创建一个 KV 命名空间并写回 `wrangler.toml`：

   ```bash
   node scripts/setup-worker.mjs
   ```

   仓库里 `wrangler.toml` 的 `id` 永远是占位符（公开仓不放任何真实部署细节），
   这一步必不可少。脚本内部做的事等价于手动执行 `npx wrangler kv namespace
   create POOL` 后把返回的 `id` 填进 `[[kv_namespaces]]` 段替换掉
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`。**跑完不要提交这次对 `wrangler.toml`
   的改动**——`check-wrangler-placeholder.mjs` 那道 CI 门禁会拦下误提交的真实 id。

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

网关用一个 `pool:index` 键保存池内的 id 列表，这样每次转发都不必消耗 KV 的 `list` 操作
（免费档的 `list` 配额只有每天 1,000 次，是独立于读、写之外的另一个桶）。**手工写记录不会
动这个索引**，所以新 key 多久能被用上，取决于池子当时的状态：

- **池子为空时**：索引说池子是空的、记录也确实一条都读不到，网关会回落一次 `list` 扫描把
  手工导入的记录发现并补进索引。这条扫描有内置的 10 分钟退避（见上文「配额账」），因此
  可见上界是 **≤10 分钟 + 一个 `POOL_CACHE_TTL_MS`**。
- **池子非空时**：转发路径只按索引取记录，索引不知道的记录**完全隐身**，而且没有任何报错。
  它要等下一次 Cron 对账把索引修好（默认 30 分钟，且**触发时机没有官方保证**，见下），
  之后再等最多一个 `POOL_CACHE_TTL_MS`。

**想让手工导入立刻生效，就在写记录的同时把 id 补进 `pool:index`：**

```bash
npx wrangler kv key get --binding=POOL "pool:index" --remote
# 把新 id 追加进 ids 数组再整个写回（v 固定为 1）
npx wrangler kv key put --binding=POOL "pool:index" \
  '{"v":1,"ids":["已有的id","1a2b3c4d5e6f7a8b"]}' --remote
```

索引写完之后，各 isolate 最多再等一个 `POOL_CACHE_TTL_MS` 就会用上这把 key。

**即使你完全不用注册机，也不要删掉 `wrangler.toml` 里的 `[triggers]`**：那个 cron 是
`pool:index` 与实际 `key:` 记录之间唯一的对账修复路径，且与 `REGISTRAR_ENABLED` 无关。

**这个 cron 的触发时机没有官方保证。** Cloudflare 没有文档化 Cron Trigger 按
`crons` 表达式触发的可靠性承诺（不保证不跳过、不保证延迟上界）。这对配额账
是安全的——对账触发得越少，实际消耗的 KV 读写只会比预估更少，不会更多；但
**孤儿记录 / 幽灵索引项被捡回索引的时间没有保证**，极端情况下可能比预期的
「最长 30 分钟」更晚。这段等待期间该 key 只是暂时用不上，不会造成数据损坏。

## 吊销一把 key

**删记录、再把 id 从 `pool:index` 里摘掉，两步都要做。** 只删记录不会出错（读不到的记录会被
直接过滤掉），但索引里那个 id 还在，每次刷新都白付一次读，要等下一次对账才会被剪掉。

```bash
npx wrangler kv key delete --binding=POOL "key:1a2b3c4d5e6f7a8b" --remote
# 把该 id 从 ids 数组里去掉再整个写回
npx wrangler kv key put --binding=POOL "pool:index" '{"v":1,"ids":["剩下的id"]}' --remote
```

Docker 形态就是在 `./data/store.json` 里删掉 `"key:<id>"` 那个键，并把 `"pool:index"` 的
`ids` 数组改好，建议先 `docker compose stop`。

已经装载了旧快照的 isolate / 进程最多再等一个 `POOL_CACHE_TTL_MS` 才会停止选中这把 key；
Worker 上还要再加一个 KV 的传播窗口（约 60 秒），因为删除要这么久才对所有 colo 可见。

**这段窗口里它也不会被写回来**：网关在落盘任何状态变更之前都会先确认记录还在，读不到就
丢弃这次写并立刻刷新自己的快照。唯一的例外同样是那个传播窗口——确认用的那次读若被 KV
的边缘缓存挡下，本 colo 会以为记录还在。Docker（文件存储）没有这层缓存，那里是精确的。
