# 注册机（自动补池）

**语言：** [English](../en/REGISTRAR.md) | 简体中文 | [繁體中文](../zh-TW/REGISTRAR.md) | [日本語](../ja/REGISTRAR.md) | [한국어](../ko/REGISTRAR.md)

> **默认关闭。** `REGISTRAR_ENABLED` 默认为 `false`，装上本项目不会自动开始注册任何账号；
> 只有显式把它设为 `true` 才会启用注册机。

## 它是什么

注册机是一个可选组件：当 key 池中的可用 key 数低于 `TARGET_KEYS` 时，它会自动注册新的
Agnes 账号、登录、铸出一把 API key 写入池子。注册过程需要接收 Agnes 发来的邮箱验证码，
因此依赖下文的邮箱通道之一。

> **合规提示**
>
> 批量注册与 Agnes 服务条款之间存在张力。是否启用注册机、以何种频率使用，须由部署者自行
> 判断并承担相应责任——本项目不替使用者做这个决定。

## 两条邮箱通道：如何选择

注册机支持两条邮箱通道，用来接收验证码：

| | YYDS Mail | MoeMail |
|---|---|---|
| 性质 | 第三方临时邮箱服务 | 可自行部署的临时邮箱服务 |
| API 基址 | 有默认值（`YYDS_BASE_URL`，指向其公开 API 端点） | 无默认值（`MOEMAIL_BASE_URL`），需填你自己部署实例的地址 |
| 获取凭据 | 向该服务申请 API Key（`YYDS_API_KEY`） | 在自己部署的实例中生成 API Key（`MOEMAIL_API_KEY`） |

**两条通道完全平级，本项目不预设主通道，也不推荐任何一条。** `REGISTRAR_PRIMARY` 没有
默认值，启用注册机时必须显式指定为 `yyds` 或 `moemail`。`REGISTRAR_FALLBACK` 可选：主
通道遇到**通道级失败**（列域名失败、连续建邮箱失败、凭据无效、收不到验证码）时会自动
降级到备通道；留空表示不降级。

> 「收不到验证码」也算通道级失败：验证码正是经由这条邮箱通道投递的，所以域名 MX 记录
> 失效、邮件转发规则被删这类故障——API 全部返回 2xx、只是信永远不到——同样属于「这条
> 通道现在产不出 key」。

判断依据：注册机靠"换域名"绕开 Agnes 对一次性邮箱域名的屏蔽，可用域名越多，注册机就越
耐用。查一下你在两边各自拥有多少可用域名，域名多的那一条更适合作为主通道——这与是哪家
服务无关，只取决于你自己的账号或自建实例的配置。

## 零内置凭据，请自行准备

本仓库不包含任何真实密钥、账号或私有域名。启用注册机前，你需要自行准备：

- **使用 YYDS Mail**：向该服务申请一个 API Key，写入 `YYDS_API_KEY`（`YYDS_BASE_URL`
  已有默认值，一般无需更改）。
- **使用 MoeMail**：自行部署一个 MoeMail 实例，把它的访问地址填入 `MOEMAIL_BASE_URL`、
  在实例中生成的 API Key 填入 `MOEMAIL_API_KEY`（两项都没有默认值，必须显式提供）。

至少准备好 `REGISTRAR_PRIMARY` 指向的那一条通道；如果配置了 `REGISTRAR_FALLBACK`，也要
准备好对应通道的凭据。

## 配置项

| 变量 | 是否必填 | 默认值 | 说明 |
|---|---|---|---|
| `REGISTRAR_ENABLED` | 否 | `false` | 总开关，为 `true` 才会启用注册机。 |
| `REGISTRAR_PRIMARY` | 启用时必填 | 无 | 主通道，`yyds` 或 `moemail`；两者平级，无默认值。 |
| `REGISTRAR_FALLBACK` | 否 | 空（不降级） | 备通道，`yyds` 或 `moemail`；主通道通道级失败时降级到它。 |
| `TARGET_KEYS` | 否 | `20` | 目标可用 key 数，低于它才会触发补池。 |
| `MINT_BATCH` | 否 | `5` | 单轮最多铸几把 key。 |
| `TEND_INTERVAL_MS` | 否（仅 Node/Docker） | `1800000`（30 分钟） | Node 侧补池调度间隔；Worker 侧由 `wrangler.toml` 的 Cron 决定，见下文。 |
| `CODE_TIMEOUT_MS` | 否 | `120000`（120 秒） | 单次铸 key 等待验证码的超时。 |
| `MINT_DELAY_MIN_MS` | 否 | `2000` | 单轮内每次铸 key 之间随机间隔的下限（毫秒）。 |
| `MINT_DELAY_MAX_MS` | 否 | `5000` | 单轮内每次铸 key 之间随机间隔的上限（毫秒）。 |
| `MAX_DOMAIN_ATTEMPTS` | 否 | `8` | 单次铸 key 最多尝试几个临时邮箱域名。 |
| `REGISTRAR_TOKEN_NAME` | 否 | `auto` | 铸出的 Agnes API key 在 Agnes 后台显示的名称。 |
| `AGNES_PLATFORM_URL` | 否 | `https://platform-backend.agnes-ai.com` | 注册、登录、铸 key 使用的 Agnes 平台后端地址（厂商公开端点）。 |
| `YYDS_BASE_URL` | 否 | `https://maliapi.215.im` | YYDS Mail 的 API 基址（厂商公开端点）。 |
| `YYDS_API_KEY` | 通道为 yyds 时必填 | 空 | YYDS Mail 的 API Key。 |
| `MOEMAIL_BASE_URL` | 通道为 moemail 时必填 | 空 | 你自己部署的 MoeMail 实例地址，无默认值。 |
| `MOEMAIL_API_KEY` | 通道为 moemail 时必填 | 空 | 该 MoeMail 实例的 API Key。 |

`MINT_DELAY_MIN_MS`、`MINT_DELAY_MAX_MS`、`REGISTRAR_TOKEN_NAME`、`AGNES_PLATFORM_URL` 默认没有
写在 `.env.example` 里（默认值通常够用），但两种部署形态都会读取，可按需设置。以上数值
型变量都必须是正整数，否则网关拒绝启动。

## 两种运行时的调度差异

| 部署形态 | 触发方式 | 由谁决定间隔 |
|---|---|---|
| Cloudflare Worker | `wrangler.toml` 的 `[triggers]` Cron（默认 `*/30 * * * *`，即每 30 分钟一次） | 修改 `wrangler.toml` 里的 cron 表达式 |
| Node / Docker | 进程内定时器 | `TEND_INTERVAL_MS`（默认 `1800000` 毫秒） |

两种运行时最终都会调用同一个补池函数，配置项完全相同，区别只在"谁负责按时触发"。

### Cloudflare Cron 触发器的墙钟上限（务必读完再调参数）

若使用 Worker 部署，补池由 Cron Trigger 触发，请务必了解以下限制：

- Cron Trigger 单次调用的墙钟（wall-clock）上限是 **15 分钟（900 秒）**。
- **`ctx.waitUntil()` 不会延长这个上限**——那个宽限机制只对 HTTP 请求生效，对 Cron
  触发的调用不适用。
- CPU 时间上限是 30 秒，但补池过程中的 `await` 网络请求（发验证码、轮询验证码等）不计
  入 CPU 时间，所以 CPU 上限不是实际瓶颈。
- 注册机链路上的**每个 HTTP 请求都有 15 秒的单请求超时**（固定值，不可配置）。它是下面
  两个估算成立的前提：没有它，一个挂起的连接就能让单轮无限拖长。
- **常态耗时**（每个请求都很快返回、第一个域名就没被屏蔽）由等待验证码主导：约
  `MINT_BATCH × CODE_TIMEOUT_MS` = 5 × 120 秒 = 600 秒，加上单轮内铸 key 之间的随机
  间隔（最多 4 次，每次至多 5 秒）约 20 秒，合计约 **600~620 秒**，距 900 秒的墙钟上
  限还有约 **30% 的余量**。
- **理论最坏耗时**要把单请求超时算进去。单次铸 key 除了轮询验证码，还要打「1 次列域名
  ＋每尝试一个域名 3 次（建邮箱、发验证码、删邮箱）＋3 次（注册、登录、建 key）」，
  即 `CODE_TIMEOUT_MS + (1 + 3 × MAX_DOMAIN_ATTEMPTS + 3) × 15 秒`，默认值下约
  120 + 420 = **540 秒**；再乘以 `MINT_BATCH` 就远超 900 秒。也就是说**默认配置在极端
  情况下会顶到墙钟上限**——这是有意接受的取舍：每铸出一把 key 就立即写入存储，被中止
  只会让当轮不完整（见下一条）。若希望连极端情况也留在墙钟内，把 `MINT_BATCH` 调到
  1~2，或调小 `CODE_TIMEOUT_MS` / `MAX_DOMAIN_ATTEMPTS`。
- **配了 `REGISTRAR_FALLBACK` 时，「最坏耗时」要乘以通道数（即 ×2）；常态耗时不变。**
  常态下验证码正常到达，备通道根本不会被启用；只有「收不到验证码」这类通道级失败，才会
  让同一个补池名额在备通道上再等一次 `CODE_TIMEOUT_MS`。启动时那条
  `TEND_INTERVAL_MS 小于单轮最坏耗时` 的告警用的就是这个模型：
  `MINT_BATCH × CODE_TIMEOUT_MS × 通道数`。
- **Worker 形态会在墙钟耗尽前主动收手（覆盖上面「最坏耗时」那一项，不覆盖「理论最坏」）。**
  每次准备开始一次铸 key 之前，注册机都会先算「剩余墙钟够不够完整跑完这一次」，
  判据是 `CODE_TIMEOUT_MS × 通道数` 再加上尝试间隔；不够就**根本不开始**，提前结束
  本轮、打印一条 `本轮墙钟预算不足以再完整跑完一次铸 key，提前收尾`，已经铸好的 key
  照常入池，剩余名额留给下个调度周期。
  关键在于「不开始」而不是「跑到一半被砍」：被平台从中间中止时，那次正在用的临时邮箱
  来不及删除就会残留（YYDS 约 24 小时后随 `expiresAt` 过期，MoeMail 按 1 小时 TTL 过期）。
  因此 **`MINT_BATCH` 在 Worker 上是「单轮上限」而不是「保证值」**：单轮可能铸不满。
  Node/Docker 没有平台墙钟上限，不启用这个机制，`MINT_BATCH` 会照常跑满。
- **⚠️ 这个预算不是万能的，残余场景仍然存在。** 判据里只有占大头的
  `CODE_TIMEOUT_MS × 通道数`，**没有**把单请求超时（每个 15 秒）与 403 退避算进去——
  把它们也算进去就会变成一次尝试都不敢开始（上面那条「理论最坏」本来就高于 900 秒）。
  预算取墙钟的 87%，留下的那约 120 秒余量就是给这些尾巴的。所以：
  - **「上游只是收不到验证码」**（本节最常见的那种慢）**已被完全兜住**；
  - **「几乎每个 HTTP 请求都挂满 15 秒」**这种病态情形，单次尝试可能超出预留余量、
    仍被平台中止，那次的临时邮箱会残留。担心这一种就按上面「理论最坏」的公式把
    `MINT_BATCH` 调到 1~2，或调小 `CODE_TIMEOUT_MS` / `MAX_DOMAIN_ATTEMPTS`。
- **`CODE_TIMEOUT_MS` 别调得过大。** `CODE_TIMEOUT_MS × 通道数` 一旦超过单轮预算
  （墙钟的 87%），Worker 形态下**一次尝试都无法开始**，补池会持续零产出。有两条日志：
  - **启动时**打印一条**警告**（`console.warn`），形如
    `[registrar] CODE_TIMEOUT_MS×通道数(...) 超过 Worker 单轮墙钟预算(...)`。
    它**不会阻止网关启动**——这一点与「缺凭据启动即报错」不同：Node/Docker 没有平台
    墙钟上限，同一份配置在那边完全合法，所以两种形态都会打这条警告，但只有 Worker
    真正受影响。
  - **Worker 每一轮补池**再打一条**错误**（`console.error`），形如
    `[registrar] 单次铸 key 的最坏耗时(...ms = CODE_TIMEOUT_MS×通道数)已超过本轮墙钟预算`。
    每轮都会出现，可据此确认这是持续状态而不是偶发。
- **在调大 `MINT_BATCH`、`CODE_TIMEOUT_MS` 或 `MAX_DOMAIN_ATTEMPTS` 之前，请自行按上面
  两个公式核算。** 顶到上限时，本次 Cron 调用会被平台中止。
- 即使被中止也不会丢失已经铸好的 key——每铸出一把就立即写入存储，只是当轮次的补池不完
  整，下一个调度周期会继续尝试补齐。

## 为什么顺序铸 key、不并发

补池在单轮内**顺序**铸 key，每次之间插入随机间隔，而不是并发发起多个铸 key 请求。这不
是性能取舍，而是功能性约束：并发会同时撞上 YYDS Mail 的建号限流（短时间内建立邮箱超过
约 10 次会返回 `403`）和 Agnes 自身的注册风控。顺序执行加随机间隔是让注册机能持续工作
的必要条件，不建议通过并发来"优化"它。

## 隐私说明

注册过程中产生的邮箱地址、账号密码只在内存中短暂存在，**用完即弃、不会被持久化**；存
储里只会出现铸出的 API key 记录。铸 key 结束后（无论成功还是失败）临时邮箱都会被删除。

## 排障

- **启用后若缺凭据，启动即报错并指明缺少哪一项配置**：注册机采用 fail-closed 策略，
  缺凭据不会静默降级，而是让网关明确失败，方便排查。
- 补池过程中的日志统一带 `[registrar]` 前缀，可据此过滤查看注册机相关的运行状态。
- **一轮里有名额没铸出来时，收尾会多打一条带 `reasons=` 的告警**，形如
  `reasons=yyds:register_failed×3 moemail:code_timeout×1`。先看这一行判断故障在哪一层：
  `code_timeout` = 这条通道收不到 Agnes 的信（域名 MX / 邮件转发规则）；
  `register_failed` / `login_failed` / `key_failed` = Agnes 侧的注册链路变了；
  `provider_error` = 邮箱服务本身（凭据、活跃邮箱配额、服务不可用）；
  `provider_missing` = 内部接线错误，正常配置下不会出现（缺凭据是启动即报错，走不到这里）。
- 若某条通道持续注册失败（例如 Agnes 收紧了验证码或人机验证策略），这是代码层面无法
  规避的上游变化，可以关闭注册机、改为手动导入 key（见 [DEPLOY.md](DEPLOY.md)）。
