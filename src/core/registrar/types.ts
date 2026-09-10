/** 一个临时邮箱。`handle` 供 provider 内部定位（YYDS 用地址、MoeMail 用 id）。 */
export interface Mailbox {
  address: string;
  handle: string;
}

/**
 * 注册机链路上**每一个** HTTP 请求的超时上限（毫秒）。
 *
 * 为什么必须有：注册机的所有耗时预算（`CODE_TIMEOUT_MS`、下面那份定时轮墙钟）
 * 都建立在"每个请求都会及时返回"这个未言明的前提上。一次挂起的请求就能把单轮
 * 拖过锁的 TTL → 下一轮在上一轮还活着的时候开跑 → 两轮同时占邮箱名额；容器这时
 * 被重启（`docker compose up -d` / OOM kill）则正在铸的那个邮箱的 `finally` 不会执行
 * → 邮箱泄漏 → 悄悄耗尽活跃邮箱配额。网关的转发路径（`core/dispatcher.ts`）本就带
 * `AbortController`，注册机这条链路此前是唯一的空白。
 *
 * 取 15 秒：这条链路上全是小 JSON 控制面请求（列域名、建邮箱、发码、注册、登录、
 * 建 key），比转发用的首字节超时（默认 8 秒）宽裕一倍，同时让"每个请求都超时"
 * 的病态情况仍是可算的有限值。用 `AbortSignal.timeout()` 而不是自建
 * `AbortController`+`setTimeout`：它是标准 Web API、定时器不会阻止进程退出。
 */
export const REGISTRAR_REQUEST_TIMEOUT_MS = 15_000;

/**
 * **定时轮允许占用的墙钟上限（15 分钟），同时就是补池锁那份 TTL 的取值**
 *（`src/http/admin/tend-lock.ts` 的 `TEND_LOCK_TTL_SCHEDULED_MS`）。
 *
 * ⚠️ **它原来是「Cloudflare Cron Trigger 单次调用的墙钟上限」——一条平台事实。
 * v0.4.0 摘掉 Worker 形态之后那条事实没了**：Node 的定时轮是 `setInterval`，
 * 没有任何平台会来砍它。**值没变，出处换成了我们自己的取舍**，两条依据：
 * · **上界**：必须**明显短于**补池间隔（`TEND_INTERVAL_MS` 默认 1_800_000 = 30 分钟）。
 *   锁是这么用的：进程被硬杀（容器重启 / OOM kill）时 `finally` 一行都不跑，锁只能
 *   靠自然过期放开——TTL 取到间隔的一半，代价上界就是**最多跳过一轮**。
 * · **下界**：必须盖得住一轮真实最坏耗时（下面那份 `SCHEDULED_ROUND_BUDGET_MS`
 *   加上准备阶段的尾巴），否则一把还活着的锁会被下一轮读成空的，两轮同时开跑。
 */
export const SCHEDULED_ROUND_WALL_CLOCK_MS = 900_000;

/**
 * 定时轮补池一轮的墙钟预算：上面那个上限的 87%，留出约 120 秒余量。
 *
 * 🔴 **它今天没有运行期消费者，只剩启动期交叉校验这一个用途。**
 * `tendOnce` 的 `roundBudgetMs` 是可选参数，**只有手动那一轮传**
 *（`src/http/wire.ts` 传 `MANUAL_ROUND_BUDGET_MS`）；定时轮一直不传，
 * 从前传它的是 Worker 入口那个 `scheduled()` 导出，那个入口在 v0.4.0 整个删了。
 * ⇒ 今天这个常量的唯一读者是 `./config.ts` 的启动期告警，
 * 它拿这个数当「一次尝试最坏耗时的上限参考值」——**超过它意味着一轮可能跑过
 * 补池锁的有效期**（`SCHEDULED_ROUND_WALL_CLOCK_MS`，那 120 秒余量正是给
 * 准备阶段与注册链尾巴留的），锁一过期，下一轮/另一个副本就会并发开跑。
 * 那条告警上方写着完整论证。**别把它读成「运行期真的会截断」——今天不会。**
 *
 * 余量不是随手定的：`tendOnce` 的预算判据算的是 `codeTimeoutMs` 加上一次尝试之内
 * 换域名的那 `maxDomainAttempts − 1` 段间隔，**注册链上那几个
 * `REGISTRAR_REQUEST_TIMEOUT_MS` 仍然没算进去**，这 120 秒就是留给这些尾巴的。
 * 把它们也算进判据是行不通的——理论最坏本来就高于 900 秒，那样会变成一次尝试都不敢开始。
 *
 * ⚠️ **跑过头的后果也换了，别照旧版读**：旧版是「被平台中止 ⇒ `finally` 不跑
 * ⇒ 邮箱漏删」。今天没有平台会来中止，也没有人把这个数传给 `tendOnce`
 *（见上面那段红字），所以跑过头**不会被截断**——后果是这一轮可能跑过自己那把
 * 补池锁的有效期，锁一过期就允许下一轮并发开跑。完整论证在 `./config.ts` 那条告警上方。
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
 * 拆掉之后没有第二条通道可等了，那个因子整个消失。同一份口径散在**四处**，
 * 改一处就得四处一起改：本文件的 `SCHEDULED_ROUND_BUDGET_MS`、
 * `src/core/registrar/config.ts` 的最坏耗时告警、
 * `src/core/registrar/tender.ts` 的 `worstAttemptMs`、`src/http/wire.ts` 传给
 * 「立即补池」的那个预算（外加五语言 REGISTRAR.md 的散文）。
 *（**这张表原来是「五处」，第五处是 `wrangler.toml` 的 Cron 估算段**，
 * 随 Worker 形态一起在 v0.4.0 删掉了。上上一版这张表还被写了四份、四份点名的集合
 * 互相不一致 —— 照任一份走都会漏掉一个文件，所以它今天只写在这一处。）
 *
 * 放在 core 而不是入口层：`registrarFromEnv` 要用它做启动期交叉校验，
 * 而它与 `SCHEDULED_ROUND_WALL_CLOCK_MS` 是一条固定比例关系（87% / 120 秒余量），
 * 五语言 REGISTRAR.md 拿这两个数向用户解释余量从哪来
 *（`tests/unit/registrar/config.test.ts` 的「文档写的 87% 与代码里的预算/墙钟比例一致」
 * 钉着）。各写一个字面量迟早漂移。
 */
export const SCHEDULED_ROUND_BUDGET_MS = 780_000;

/**
 * ⚠️⚠️ **以下这一族是「手动补池」专用的，与上面那份定时轮预算不是一回事，
 * 而把两者混用曾经是一条实测出来的严重缺陷。**
 *
 * 事故经过（Cloudflare 平台日志原话，不是推断）：面板「立即补池」回 202 之后把整轮
 * 交给 `ctx.waitUntil`，而平台在**响应结束后约 30 秒**就把它取消掉，实测 3/3 复现。
 * 取消不抛异常 ⇒ 两层 `try/catch/finally` 一个都不执行 ⇒ 不写补池历史、不发事件、
 * 锁泄漏到自然过期（当时那份 TTL 取的是 15 分钟）⇒ 点一次按钮把注册机整个停摆一刻钟。
 *
 * ⚠️ **v0.4.0 摘掉 Worker 形态之后，那个平台前提没了；这一族仍然留着，理由换成
 * 今天成立的那一条**：当时的处置是**换载体**——端点自己 `await` 这一轮再返回
 *（见 `src/http/admin/handlers/registrar.ts`）。换完之后这一轮的载体就是**这条 HTTP
 * 请求本身**，于是它的墙钟上限变成「浏览器 / 反向代理愿意等多久」，那是一个**比
 * 定时轮小一个量级**的数，与跑在哪种运行时上无关。⇒ 手动一族**不是**定时轮那一族
 * 的一个副本，两者今天仍然不许合并。
 *
 * 事故本身留在这里不删：它是「为什么手动轮的预算必须自己算，不许抄定时轮那份」
 * 这条纪律的来历，而来历被删掉之后，下一个人只会看到两族长得很像的常量。
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
 * 手动轮的等码超时，取定时轮那份（默认 120 秒）的一半。
 *
 * **不取更小的值**：`pollCode` 一超时就是 `code_timeout`，而那封信对应的临时邮箱
 * 已经真的建出来、真的花掉了。载体是这条 HTTP 请求本身（端点 `await` 到底），
 * 没有任何后台额度天花板压着，没有理由把成功率砍下去换一个不存在的约束。
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
