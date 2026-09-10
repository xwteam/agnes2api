/** 一个临时邮箱。`handle` 供 provider 内部定位（YYDS 用地址、MoeMail 用 id）。 */
export interface Mailbox {
  address: string;
  handle: string;
}

/**
 * 注册机链路上**每一个** HTTP 请求的超时上限（毫秒）。
 *
 * 为什么必须有：注册机的所有耗时预算（`CODE_TIMEOUT_MS`、Worker Cron 的 15 分钟
 * 墙钟）都建立在"每个请求都会及时返回"这个未言明的前提上。一次挂起的请求就能把
 * 单轮推过墙钟上限 → Cron 被平台中止 → 正在铸的那个邮箱的 `finally` 不会执行 →
 * 邮箱泄漏 → 悄悄耗尽活跃邮箱配额。网关的转发路径（`core/dispatcher.ts`）本就带
 * `AbortController`，注册机这条链路此前是唯一的空白。
 *
 * 取 15 秒：这条链路上全是小 JSON 控制面请求（列域名、建邮箱、发码、注册、登录、
 * 建 key），比转发用的首字节超时（默认 8 秒）宽裕一倍，同时让"每个请求都超时"
 * 的病态情况仍是可算的有限值。用 `AbortSignal.timeout()` 而不是自建
 * `AbortController`+`setTimeout`：它是标准 Web API，Node 与 Workers 都原生支持，
 * 且定时器不会阻止进程退出。
 */
export const REGISTRAR_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Cloudflare Cron Trigger 单次调用的墙钟上限（15 分钟）。**平台事实，不是我们的取舍。**
 * 超过它调用被直接中止，`mintOne` 的 `finally` 不执行，临时邮箱漏删。
 */
export const WORKER_CRON_WALL_CLOCK_MS = 900_000;

/**
 * Worker 形态下补池一轮的墙钟预算：上面那个上限的 87%，留出约 120 秒余量。
 *
 * 余量不是随手定的：`tendOnce` 的预算判据算的是 `codeTimeoutMs` 加上一次尝试之内
 * 换域名的那 `maxDomainAttempts − 1` 段间隔，**注册链上那几个
 * `REGISTRAR_REQUEST_TIMEOUT_MS` 仍然没算进去**，这 120 秒就是留给这些尾巴的。
 * 把它们也算进判据是行不通的——理论最坏本来就高于 900 秒，那样会变成一次尝试都不敢开始。
 *
 * ⚠️ **这 120 秒现在还多兜一样东西，如实登记**：预算判据的起点已经挪到**准备阶段之后**
 *（`./tender.ts` 的 `roundStartedAt`，理由与代价全文在那里），于是那一段
 *（`loadDomainLedger()` + 一次 `listDomains()`，最坏是一个 `REGISTRAR_REQUEST_TIMEOUT_MS`
 * 加两次存储读）同样落在这份余量里。780 + 余量仍在 900 秒之内。
 *
 * ⚠️ **这段原来写的是「与 403 退避」。** 那是指着一条**死分支**说话的陈旧注释：
 * 从前撞上限流会 `sleep(5000)` 再换个域名接着打，而实测上游回的是 429 与 400，
 * 那条 403 分支一次都没走到过。它连同那句注释一起删掉了 ——
 * 撞上限流现在是**当场结束整轮 + 记一个跨轮退避**，不再有「等一下接着打」这回事。
 *
 * ⚠️ **这里从前写的是 `codeTimeoutMs × 通道数`。** 两条通道改成二选一、自动降级
 * 拆掉之后没有第二条通道可等了，那个因子整个消失（同一份口径在
 * 同一份口径散在**五处**，改一处就得五处一起改：`src/core/registrar/types.ts` 的
 * `WORKER_ROUND_BUDGET_MS`、`src/core/registrar/config.ts` 的最坏耗时告警、
 * `src/core/registrar/tender.ts` 的 `worstAttemptMs`、`src/http/wire.ts` 传给
 * 「立即补池」的那个预算、`wrangler.toml` 的 Cron 估算段（外加五语言 REGISTRAR.md
 * 的散文）。⚠️ 上一版这张表被写了四份、四份点名的集合互相不一致 —— 照任一份走
 * 都会漏掉一个文件。）。
 *
 * 放在 core 而不是 `entry/worker.ts`：`registrarFromEnv` 要用它做启动期交叉校验
 *（`codeTimeoutMs` 超过它时，Worker 形态第一次尝试就不敢开始 = 永久停摆），
 * 两处必须用同一个数，各写一个字面量迟早漂移。
 */
export const WORKER_ROUND_BUDGET_MS = 780_000;

/**
 * ⚠️⚠️ **以下这一族是「手动补池」专用的，与上面那份 Cron 预算不是一回事，
 * 而把两者混用正是一条实测出来的严重缺陷。**
 *
 * 事故经过（Cloudflare 平台日志原话，不是推断）：面板「立即补池」回 202 之后把整轮
 * 交给 `ctx.waitUntil`，而平台在**响应结束后约 30 秒**就把它取消掉：
 *   `waitUntil() tasks did not complete within the allowed time after invocation end
 *    and have been cancelled.`
 * 实测 3/3 复现，间隔恒定 31~33 秒。
 *
 * 🔴 **取消不抛异常**——整个执行上下文被销毁，于是
 * `src/http/admin/handlers/registrar.ts` 与 `src/http/wire.ts` **两层 `try/catch/finally`
 * 一个都不执行**。后果不止「这一轮没记上」：`finally` 里的 `releaseTendLock` 同样不跑，
 * 锁泄漏到自然过期，而那份 TTL 当时取的是 Cron 的 15 分钟
 * ⇒ **点一次按钮 = 注册机（含 Cron 轮）停摆一刻钟**（日志实证：期间两次
 * 「上一轮补池仍在进行，跳过本次 Cron 触发」）。
 *
 * ⇒ 处置是**换载体**（`fetch` 请求自己 `await` 到底，见 `wire.ts` 的 `manualTend`），
 * 而不是「把预算调小一点继续赌 `waitUntil`」——赌只是把静默截断的概率变小，
 * 没有消除它，而静默截断是这族缺陷里最恶劣的形态。
 */
export const MANUAL_MINT_BATCH = 1;

/**
 * 手动一轮**只试一个域名**。
 *
 * 这不是「保守一点」，是让 `tender.ts` 的 `worstAttemptMs =
 * codeTimeoutMs + (maxDomainAttempts − 1) × mintDelayMaxMs` **退化成常量**。
 * 不压它的话，运维把 `MAX_DOMAIN_ATTEMPTS` 调成 2，`worstAttemptMs` 就跳到
 * 150 秒 > 预算 ⇒ 预算判据当场判「这一次尝试开不起来」⇒ **按钮变成永远铸不出
 * key 的诚实空转**，而且空转得毫无征兆。
 */
export const MANUAL_MAX_DOMAIN_ATTEMPTS = 1;

/**
 * 手动轮的等码超时，取 Cron 那份（默认 120 秒）的一半。
 *
 * **不取更小的值**：`pollCode` 一超时就是 `code_timeout`，而那封信对应的临时邮箱
 * 已经真的建出来、真的花掉了。载体换成请求自身之后没有 30 秒的天花板压着，
 * 没有任何理由把成功率砍到那个量级去换一个已经不存在的约束。
 */
export const MANUAL_CODE_TIMEOUT_MS = 60_000;

/**
 * 手动轮的墙钟预算。
 *
 * 🔴 **它不是耗时上界，别读成上界。** 在 `MANUAL_MINT_BATCH = 1` 之下它**只被判一次**
 *（`tender.ts` 里 `i === 0` 那次），语义是「这一次尝试开不开得起来」。
 * 唯一的硬约束是**必须严格大于 `worstAttemptMs`**（= `MANUAL_CODE_TIMEOUT_MS` = 60 秒），
 * 否则见 `MANUAL_MAX_DOMAIN_ATTEMPTS` 那段说的诚实空转。
 *
 * ⚠️⚠️ **这里原来写着「多出来的 10 秒留给 `elapsedMs`」——那句话是错的，而它错得很贵。**
 * 判据里的 `elapsedMs` 从前是从**整轮开头**算起的，中间隔着 `listDomains()` 这类
 * 单请求就允许 `REGISTRAR_REQUEST_TIMEOUT_MS`（15 秒）的准备动作：**10 秒的余量根本
 * 不够，上游邮箱服务慢一次这颗按钮就诚实空转**，还打出一条指向 `CODE_TIMEOUT_MS` 的
 * 错误处置（而手动轮的 `codeTimeoutMs` 已经被 `Math.min` 压到 60 秒，调它没有用）。
 * ⇒ 处置**不是**把这个数抬到 85 秒（那只是把同一条赌注的赔率改一改，且要连着五语言
 * 文档里那句「预算 70 秒」一起动）：`tender.ts` 里那个起点已经挪到准备阶段**之后**，
 * i=0 时 `elapsedMs ≈ 0`，判据退化成纯配置量 `worstAttemptMs > roundBudgetMs`。
 * 全文与代价记在 `tender.ts` 的 `roundStartedAt` 上方。这 10 秒因此是**余量**，
 * 不再是「留给准备阶段」的预算。
 */
export const MANUAL_ROUND_BUDGET_MS = 70_000;
