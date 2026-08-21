import type { Context } from "hono";
import type { Logger } from "../../../ports/logger.js";
import type { Storage } from "../../../ports/storage.js";
import type { RuntimeInfo, BackgroundCtx } from "../../../ports/runtime.js";
import type { ConfigHolder } from "../../config-holder.js";
import {
  MANUAL_GUARD_KEY, checkManualTend, narrowManualGuard,
} from "../../../core/admin/tend-guard.js";
import { acquireTendLock, releaseTendLock, type TendGate } from "../tend-lock.js";

/**
 * `POST /admin/api/registrar/tend` —— 面板的「立即补池」（设计 §10.2 / §10.3，风险 L6）。
 *
 * ── 四条护栏，逐条落在这个文件里 ────────────────────────────────────────────
 *
 * | # | 护栏 | 落点 | 挡什么 |
 * |---|---|---|---|
 * | 1a | 进程/isolate 内在途守卫 | `deps.gate.tryEnter()` | 同副本内的重入（定时轮 × 按钮、两个并发请求） |
 * | 1b | 存储级短锁 | `acquireTendLock()` | **跨副本**的重叠（多容器共卷 / Worker 两个 isolate） |
 * | 2 | 10 分钟手动冷却 | `checkManualTend()` 的 `cooldownUntil` | 连点烧邮箱名额 |
 * | 4 | 每天 K 次写预算闸 | `checkManualTend()` 的 `day` / `used` | 连点烧 **KV 写配额**（三重护栏挡不住这一条，计划 F11） |
 *
 * 第 3 条护栏（确认弹窗明示消耗）在**面板**上，后端做不了；它要的那两个数字
 *（本次最多铸几把 key / 最多消耗几个临时邮箱）来自 `/admin/api/overview` 已有的
 * `pool` 与 `config` 块。⚠️ 设计 §10.2 那句文案后面还写了「YYDS 免费档活跃邮箱上限
 * 15 个；MoeMail 默认上限 30 个」——**这两个数字本仓一次都没有核实过**，
 * 是外部服务的配额，**不许照抄进面板文案或这里的响应体**（面板上的数字会被运维当成事实）。
 *
 * ── 顺序有意义：先读护栏（不写）→ 抢锁 → 才写护栏 ─────────────────────────
 *
 * 反过来（先消费护栏再抢锁）时，一次抢锁失败会白白吃掉一格日预算与一次 10 分钟冷却
 * ——**明明什么都没跑，按钮却被锁住十分钟**。现在抢锁失败那一支一次写都不产生。
 *
 * ── 诚实限定，不许被改写成「并发已解决」─────────────────────────────────
 *
 * KV 是最终一致的，存储锁与护栏键都是**读改写**，两者都会丢更新：
 *
 * | 处 | 丢更新的后果 | 上界 |
 * |---|---|---|
 * | `registrar_manual_guard` | 两副本同时点，各读到 `used=K-1`、各写回 `used=K` ⇒ 闸门多放行一次 | 每次并发窗口最多多放行 (并发数−1) 次 |
 * | `registrar_tend_lock` | 两个都抢到 ⇒ 两轮补池并发跑 | 同上 |
 * | `tend:history`（`wire.ts` 的 `appendHistory`） | 丢一轮记录 ⇒「每轮汇总」缺一行 | 每次并发窗口最多丢 (并发数−1) 轮 |
 *
 * **这三处是尽力而为，不是原子操作**；存储锁把并发窗口压到很小，但压不到零。
 * 为什么不做成无读改写：`tend:history` 改成一轮一键就要付 `list`（红线 1 直接禁止），
 * 护栏键改成一天一键则跨天时仍要读旧键。**两条路都更差，代价明写比消除更诚实。**
 */

/**
 * 手动补池真正要用到的两样东西，**成对给或者一个都不给**。
 *
 * 成对是刻意的：只给存储不给执行体，端点会写下护栏与锁然后什么都不跑；
 * 只给执行体不给存储，四条护栏一条都不成立。两者分开成两个可选字段就等于
 * 允许这两种半装配状态存在，而它们都会让面板说一句「已开始」的假话。
 */
export interface ManualTendWiring {
  /** 护栏键与补池锁都落在这里。**与 key 池同一个存储**，不新增依赖。 */
  storage: Storage;
  /**
   * 真的跑一轮**手动**补池（装配依赖 → `tendOnce` → 写 `tend:history` → 落盘事件）。
   * 由 `wire.ts` 提供，因为只有它手上有 `env`。
   *
   * **允许抛错**：抛出来由本文件接住并记一条事件，**而锁一定在 `finally` 里释放**。
   */
  run: () => Promise<void>;
}

export interface ManualTendDeps {
  /**
   * 手动补池的接线。**`null` = 这个部署压根没接执行体**（只有直接调 `createApp`
   * 而不经 `wire.ts` 的装配才会这样），此时端点如实回 `503`，不假装 202。
   */
  wiring: ManualTendWiring | null;
  now: () => number;
  /**
   * 事件 sink。**用 app 那一个（fan-out 到 `StoreLogger`）**：手动补池是"池子为什么变了"
   * 的一个原因，漏在事件板块外面，那个板块就只说了一半真话。
   */
  logger: Logger;
  /** 后台任务的载体（Worker 的 `ctx.waitUntil` / Node 的 fire-and-forget），见 `RuntimeInfo`。 */
  runtime: RuntimeInfo;
  /** 判「注册机开没开」用它，零额外 IO（`configRefresh` 中间件本请求已经刷过一次）。 */
  configHolder: ConfigHolder;
  /** 进程/isolate 内的在途守卫。**与定时轮共用同一把**，见 `tend-lock.ts` 的对照表。 */
  gate: TendGate;
}

/**
 * Hono 的 `c.executionCtx` 在**没有** `ExecutionContext` 时抛错，不是返回 `undefined`
 *（Node 形态、以及 `app.request(url)` 这种不带 ctx 的调用都会走到）。
 *
 * 这里 `try/catch` 问的是「Hono 这次请求有没有带载体」，**不是在嗅探运行时**——
 * 拿到之后做什么完全由注入的 `runtime.background` 决定（Node 侧那份连看都不看它）。
 */
function backgroundCtx(c: Context): BackgroundCtx | null {
  try {
    return c.executionCtx;
  } catch {
    return null;
  }
}

/** 409 的两种形态各自的机器可读判别字段。面板靠它选五语言文案，不靠解析中文 `message`。 */
const REASON_IN_FLIGHT = "tend_in_flight";
const REASON_LOCKED = "locked";
const REASON_DISABLED = "registrar_disabled";
const REASON_NOT_WIRED = "not_wired";

export function manualTendHandler(deps: ManualTendDeps) {
  return async (c: Context) => {
    const now = deps.now();

    // 注册机关着时一次写都不产生（配额账那根轴：**默认部署下本任务新增的写是 0**）。
    // 判据取 `configHolder`（本请求已经刷新过）而不是再读一次存储：面板显示的
    // 「注册机：已关闭」用的就是这一份，两处必须是同一个答案。
    if (!deps.configHolder.current().registrar.enabled) {
      return c.json({
        error: {
          type: "conflict",
          message: "注册机未启用，没有可补的池；请先在设置里打开注册机并配好至少一条邮箱通道",
        },
        reason: REASON_DISABLED,
      }, 409);
    }

    // 注册机开着、执行体却没接上：这是**装配错误**，不是运行状态。如实回 503 并留一条
    // error 事件——返回 202 会让面板显示「已开始」，而实际上什么都不会发生，
    // 那正是本仓反复裁过的「面板说保存成功、其实没落盘」的同一形状。
    const wiring = deps.wiring;
    if (wiring === null) {
      deps.logger.log({
        level: "error", event: "registrar.manual_tend_not_wired",
        msg: "注册机已启用，但这个 app 没有接手动补池的执行体（装配没走 wire.ts 的 buildApp）",
      });
      return c.json({
        error: { type: "internal_error", message: "这个部署没有接上手动补池的执行体" },
        reason: REASON_NOT_WIRED,
      }, 503);
    }

    // **同步获取，之后才允许出现 `await`。** 写成「先问一句 busy() 再去 run()」就把
    // 检查与占用之间的窗口造回来了，那个形态下第二个并发请求会拿到 202 却什么都没跑。
    const leave = deps.gate.tryEnter();
    if (leave === null) {
      return c.json({
        error: { type: "conflict", message: "这个副本上已经有一轮补池在跑，请等它结束" },
        reason: REASON_IN_FLIGHT,
      }, 409);
    }

    let started = false;
    try {
      const verdict = checkManualTend(narrowManualGuard(await wiring.storage.get(MANUAL_GUARD_KEY)), now);
      if (!verdict.ok) {
        // 429 的两种 reason 措辞必须分得开：一种是「再等几分钟」，
        // 另一种是「今天的额度用完了，到 UTC 零点恢复」，处置完全不同。
        return c.json({
          error: {
            type: "rate_limit_error",
            message: verdict.reason === "write_budget_exhausted"
              ? "今天的手动补池次数已用完（这道闸挡的是存储写配额，不是邮箱名额），到期后自动恢复"
              : "两次手动补池之间至少要隔一段冷却时间，请稍后再试",
          },
          reason: verdict.reason,
          remaining: verdict.remaining,
          resetAt: verdict.resetAt,
          retryAfterMs: verdict.retryAfterMs,
        }, 429);
      }

      const lock = await acquireTendLock(wiring.storage, now);
      if (!lock.ok) {
        // **抢锁失败这一支一次写都不产生**：护栏还没消费，冷却也没起算。
        return c.json({
          error: {
            type: "conflict",
            message: "另一个副本正在补池，本次没有启动（补池是顺序执行的，并发会同时撞邮箱建号限流与上游注册风控）",
          },
          reason: REASON_LOCKED,
          until: lock.until,
        }, 409);
      }

      // 护栏**在这里才落盘**，且**不传 `expiresAt`**——传了就是评审 C2 那个失效读法
      //（键跟着冷却蒸发 ⇒ `used` 每 10 分钟归零 ⇒ 日预算闸永远走不到耗尽）。
      await wiring.storage.put(MANUAL_GUARD_KEY, verdict.next);

      const task = (async () => {
        try {
          await wiring.run();
        } catch (err) {
          deps.logger.log({
            level: "error", event: "registrar.manual_tend_failed",
            msg: "手动补池整轮抛错中断；面板已经回过 202，所以这条事件是运维唯一能看到它失败的地方",
            fields: { error: err instanceof Error ? err.message : String(err) },
          });
        } finally {
          // **必须在 `finally` 里。** 放进 `try` 的末尾时，一次抛错的补池会让锁留到
          // 自然过期（最长 `TEND_LOCK_TTL_MS`）才肯放下一轮进来——一次失败换一段停摆。
          try {
            await releaseTendLock(wiring.storage);
          } catch (err) {
            deps.logger.log({
              level: "warn", event: "registrar.lock_release_failed",
              msg: "释放补池锁失败，最坏情况下要等锁自然过期（期间补池会被跳过）",
              fields: { error: err instanceof Error ? err.message : String(err) },
            });
          }
          leave();
        }
      })();
      started = true;

      // 载体由注入的运行时决定：Worker 交给 `ctx.waitUntil`（不交就会被从中间砍断、
      // 临时邮箱漏删），Node 直接 fire-and-forget。差异是**被断言的**，不是被容忍的。
      deps.runtime.background(task, backgroundCtx(c));

      deps.logger.log({
        level: "info", event: "registrar.manual_tend_started",
        msg: "面板触发了一轮手动补池",
        fields: { remaining: verdict.remaining, cooldownUntil: verdict.next.cooldownUntil },
      });

      // ⚠️ **`remaining` 必须在这一支也给。** 只在耗尽那一支给它，等于让运维毫不知情地
      // 撞上一堵墙——面板要**如实显示还剩几次**，而不是等到点不动了才说。
      return c.json({
        started: true,
        trigger: "manual",
        remaining: verdict.remaining,
        resetAt: verdict.resetAt,
        cooldownUntil: verdict.next.cooldownUntil,
      }, 202);
    } finally {
      // 任何一条提前返回（429 / 409 / 抛错）都要把守卫还回去，否则这个副本上的
      // 补池会被一次被拒的点击永久堵死。真的起跑之后由上面那个 `finally` 负责。
      if (!started) leave();
    }
  };
}
