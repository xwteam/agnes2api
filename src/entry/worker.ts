import { buildApp, buildTendDeps } from "../http/wire.js";
import { KvStorage } from "../adapters/storage-kv.js";
import { KeyPoolRepo } from "../core/keypool-repo.js";
import { ConsoleLogger } from "../adapters/logger-console.js";
import { StoreLogger } from "../adapters/logger-store.js";
import { multiLogger } from "../adapters/logger-multi.js";
import { workerRuntime } from "../adapters/runtime-worker.js";
import { tendOnce, summarizeFailures } from "../core/registrar/tender.js";
import { WORKER_ROUND_BUDGET_MS } from "../core/registrar/types.js";
import { acquireTendLock, releaseTendLock } from "../http/admin/tend-lock.js";
import type { Hono } from "hono";

export interface Env {
  GATEWAY_TOKEN?: string;
  POOL: KVNamespace;
  [k: string]: unknown;
}

let cachedApp: Hono | null = null;

export default {
  /**
   * ⚠️ **`ctx` 必须一路传给 `app.fetch`。** 不传的话 `c.executionCtx` 在 handler 里
   * 直接抛错 ⇒ `runtime.background()` 拿到 `null` ⇒ 「立即补池」退化成
   * fire-and-forget ⇒ 响应一返回 isolate 就可能停摆，补池被从中间砍断、
   * `mintOne` 的 `finally` 不跑、**临时邮箱漏删**。
   * 这一行**是后来补的**（早先全仓只有 `scheduled()` 用得上 ctx），
   * 由 `tests/unit/entry-worker.test.ts` 的
   * 「fetch 把 ExecutionContext 一路传给 app —— 不传的话 waitUntil 在生产里根本拿不到」钉着。
   *
   * `ctx` 声明成可选：Workers 运行时总是传三个参数，而本仓既有的十几处
   * `worker.fetch(req, env)` 测试调用与它无关，不该为一个后台载体去牵连它们。
   */
  async fetch(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    let app = cachedApp;
    // **app 现在可以无条件缓存**：它自己不再持有任何配置值，配置全部走 ConfigHolder
    // 每请求读一次（TTL 内命中缓存）。原来那个 `cachedToken !== env.GATEWAY_TOKEN`
    // 的判断在「没设 GATEWAY_TOKEN 环境变量」时恒为 false，是「口令撤销不掉」的直接成因；
    // 而 env 在一个 deployment 内不会变，这个判断本来也从没真正触发过。
    if (!app) {
      try {
        ({ app } = await buildApp(
          env as Record<string, string | undefined>, new KvStorage(env.POOL), workerRuntime(),
        ));
      } catch (err) {
        // **不回显 err.message**：这是未鉴权路径，异常信息里可能带存储键名、
        // 内部路径与栈帧。与 app.onError 刻意不回显、/health 刻意不回显底层错误
        // 是同一条策略——原实现在这里自相矛盾。
        console.error("[agnes2api] 装配失败", err);
        return new Response(
          JSON.stringify({ error: { type: "internal_error", message: "网关内部错误" } }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      cachedApp = app;
    }
    return app.fetch(req, env, ctx);
  },

  /**
   * Cron 触发的补池入口。`wrangler.toml` 里的 `[triggers]` 配了触发频率，平台按
   * 该频率调用这个导出——与 Node 侧命令式的 `setInterval` 不同，这里是声明式的，
   * 触发本身不需要我们自己起定时器。
   *
   * 装配依赖失败或补池失败都只记日志、不重新抛出：一次 Cron 调用失败不该影响
   * 下一次调度，也不该影响 fetch() 处理的正常转发请求。
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const storage = new KvStorage(env.POOL);

    // key 池索引对账。**必须在「注册机是否启用」的判断之前**——下面是 `if (!deps) return`，
    // 放在后面等于注册机关着时永不对账，而索引残留（孤儿记录 / 幽灵索引项）恰恰不挑
    // 注册机开没开：手工导入、面板删除、以及任何一次中途失败的写都会产生它。
    // 成本：一次 list + 一次 get（每 30 分钟一次 ⇒ 48 次/天，占免费档 list 配额 4.8%），
    // 只有真不一致时才多一次 put。
    try {
      const repo = new KeyPoolRepo(storage, { now: () => Date.now(), logger: new ConsoleLogger() });
      await repo.reconcileIndex();
    } catch (err) {
      // 对账失败不该影响补池：索引残留是 fail-safe 的（key 不被用，而不是坏 key 被用）。
      console.error("[agnes2api] key 池索引对账失败", err);
    }

    // 补池这条路自己的事件 sink（本任务）。**每一轮新建一个**，不复用、不缓存：
    // ① Worker 上每次 `scheduled()` 本来就很可能是新 isolate，Node 上新建一个才能
    //    与 Worker 行为对齐（双运行时对等是硬约束）；
    // ② 写预算是实例字段，长寿实例上 48 轮/天会在第 13 轮撞上
    //    `EVENT_WRITES_PER_DAY`（12）并从此静默不写——而那条预算对这根轴本来就
    //    不适用（订正：真正的上界是补池频率）。每轮一个新实例让上界回到频率本身。
    // **`ConsoleLogger` 那一路一条都不丢**：落库是 fan-out 出来的第二条路。
    const tendConsole = new ConsoleLogger();
    const tendStore = new StoreLogger({
      storage,
      now: () => Date.now(),
      shardId: crypto.randomUUID().slice(0, 8),
      onError: (err) => tendConsole.log({
        level: "error", event: "storage.event_flush_failed",
        msg: "补池事件落盘失败，本轮缓冲已丢弃（不重试同一批）",
        fields: { error: err instanceof Error ? err.message : String(err) },
      }),
    });

    let deps;
    try {
      deps = await buildTendDeps(env as Record<string, string | undefined>, storage, {
        logger: multiLogger(tendConsole, tendStore),
        // **`flush()` 不是 `maybeFlush()`**：这一轮如果跑得快（`need <= 0` 的健康
        // 稳态、`provider_missing`、`round_budget_impossible` 都是毫秒级返回），
        // 距构造时刻的间隔远小于 `EVENT_FLUSH_MIN_INTERVAL_MS`，`maybeFlush()`
        // 会**一条都不写、而且 errs=0、dropped=0、不抛不报**（实测：24 个模拟窗口
        // × 48 次 Cron，写入 432 条、可见 0 条）。这条路径的上界是 Cron 频率本身，
        // 不需要那道为 `fetch` 路径挡 DoS 的最小间隔闸。见 `StoreLogger.flush()`。
        flush: () => tendStore.flush(),
      });
    } catch (err) {
      console.error("[registrar] 装配补池依赖失败", err);
      return;
    }
    if (!deps) return; // 注册机未启用：不触达邮箱/Agnes（对账已在上面做过）

    // 重入保护。Cloudflare **不会**串行化重叠的 Cron 调用：单轮最坏耗时
    //（MINT_BATCH × CODE_TIMEOUT_MS）超过 Cron 间隔时，上一轮还在跑就会又起一轮，
    // 而「顺序铸、不并发」是功能性约束（并发同时撞邮箱服务的建号限流与 Agnes 的
    // 注册风控），不是性能取舍。KV 是最终一致的，这把锁只是尽力而为、不是互斥
    // 原语；它挡的是"上一轮明明还在跑"这种最常见的重叠，而不是纳秒级的竞态。
    //
    // **判据与键名已抽进 `src/http/admin/tend-lock.ts`**，与 Node 入口
    // 和面板的「立即补池」共用同一份实现——三处各写各的 `get`→检查→`put`，
    // 迟早有一处把中间那步省掉（那正是「两个都抢到」）。
    const lock = await acquireTendLock(storage, Date.now());
    if (!lock.ok) {
      console.warn("[registrar] 上一轮补池仍在进行，跳过本次 Cron 触发（可调疏 cron 或调小 MINT_BATCH）");
      return;
    }

    ctx.waitUntil(
      (async () => {
        const roundStartedAt = Date.now();
        try {
          // 只有 Worker 形态传轮级预算：Cron 被平台中止时 mintOne 的 finally 不跑、
          // 邮箱漏删，必须靠「不启动跑不完的尝试」来避免。预算取值与理由见
          // core/registrar/types.ts 的 WORKER_ROUND_BUDGET_MS。
          const r = await tendOnce({ ...deps, roundBudgetMs: WORKER_ROUND_BUDGET_MS });
          // 每轮汇总落进 `tend:history`（设计 §7.3）。**事件流水与它是两件事**：
          // 流水回答"发生了什么"，这份历史回答"每一轮的 available/attempted/minted
          // 各是多少"，而后者正是运维真正要问的那一句，也是 §15.2 验收要看的那半句。
          await deps.recordRound(r, "cron");
          if (!r.skipped) {
            console.log(
              `[registrar] 补池完成 available=${r.available} attempted=${r.attempted} minted=${r.minted}`,
            );
            // 与 Node 入口同一份口径：见 node.ts 里同位置的注释。
            if (r.minted < r.attempted) {
              console.warn(`[registrar] 本轮有名额未铸出，归因 reasons=${summarizeFailures(r.failures)}`);
            }
          }
        } catch (err) {
          // **抛错的那一轮也必须在面板上占一格**（评审发现）。
          // 原来这里只有一行裸 `console.error`：它进不了事件缓冲 ⇒ `flush()` 首行
          // 就 return；而 `recordRound` 排在 `tendOnce` 之后、一抛就整个跳过
          // ⇒ **面板上这一轮什么都没有，与「注册机根本没跑」逐字节不可区分**。
          // 实测：`{"events": [], "history": null}`。两件事都补：
          // ① 事件走 `deps.logger`（fan-out 到 console + StoreLogger）；
          // ② 补池历史补一条 `round_crashed`，让时间线上这一格自己说清楚。
          // **原有的控制台行数一行都不减**：`ConsoleLogger` 那一路是排障的第一
          // 现场，且它那条 `[registrar]` 前缀由 `tests/unit/logger.test.ts` 的
          // 「registrar.* 事件渲染成 [registrar] 前缀」按事件名派生出来。
          // 落库是**加**出来的第二条路，不是替换。
          // ⚠️ **上一版这里指的是 `tests/unit/registrar/log-prefix.test.ts` 的
          // 「这些文件里一个 console 调用点都没有」，那是错的**（注释断言
          // 词表补上归属式那一族之后，这条指向第一次被要求给锚，一给就发现它落不下去）：
          // 那份测试守的是「几个 core 文件里没有裸 console」与事件名本身，
          // **前缀怎么从事件名派生**不在它的射程里。
          // ⚠️ 下面那一行 `console.error` 的前缀是**手写字面量**、不走上面那条派生，
          // 它另有东西钉着：`tests/unit/registrar/scheduling-wiring.test.ts` 的
          // 「Worker 侧：补池抛错也会释放锁，下一次 Cron 不会被永久挡住」逐字断言了它。
          //（这一句是查证出来的：第一版这里写的是「它今天没有任何机器守着」，
          // 而那句话在写下的当天就是假的——本轮差点在「让注释说真话」的同一次改动里
          // 写下一句新的假话。）
          console.error("[registrar] 补池失败", err);
          deps.logger.log({
            level: "error", event: "registrar.round_failed",
            msg: "补池整轮抛错中断，本轮没有产出；下一次 Cron 会重新开始",
            fields: { error: err instanceof Error ? err.message : String(err) },
          });
          await deps.recordCrashedRound({
            at: roundStartedAt, channel: deps.config.primary ?? "",
            durationMs: Date.now() - roundStartedAt, trigger: "cron",
          });
        } finally {
          // 锁必须释放，否则下一次 Cron 要空等到 TTL 到期才肯干活。释放本身
          // 失败也不能让这个后台任务以异常收场。
          try {
            await releaseTendLock(storage);
          } catch (err) {
            // **走 `deps.logger` 而不是裸 `console.warn`**（评审发现）：释放锁失败
            // 恰恰是运维要在事件板块里看到的那类事——它意味着下一次 Cron 要空等
            // 到锁自然过期（最长 15 分钟）才肯干活。
            // **这也是下面那行 flush 必须排在最后的唯一真实理由**：这条事件是在
            // 释放锁之后才产生的，flush 排在前面就永远赶不上它。
            console.warn("[registrar] 释放补池锁失败，最坏情况下要等锁自然过期", err);
            deps.logger.log({
              level: "warn", event: "registrar.lock_release_failed",
              msg: "释放补池锁失败，最坏情况下要等锁自然过期（期间 Cron 触发会被跳过）",
              fields: { error: err instanceof Error ? err.message : String(err) },
            });
          }
          // **flush 必须是这个 finally 里的最后一件事。**
          // ⚠️ 计划 Step 6 写的是「先 flush 再释放锁」，理由是「释放锁失败会走
          // catch，而事件正是要记录这件事」——**那个理由要求的恰恰是相反的顺序**。
          // 按理由走，不按那句话走。
          //
          // ⚠️ **评审二审订正**：这个顺序**在上面那条 `lock_release_failed`
          // 改走 `logger` 之前是没有东西可守的**——当时"释放锁失败"走裸
          // `console.warn`（根本进不了缓冲）、"写 tend:history 失败"的
          // `recordRound` 整个排在 `finally` 之前，两种顺序都赶得上，把 flush 挪回
          // 释放锁之前**全套用例照样全绿**。现在那条事件是在释放锁之后产生的，
          // 顺序第一次有了真实后果，并由 `tests/contract/registrar-events.test.ts` 的
          // 「释放补池锁失败时……那条事件仍然落得了盘」钉住。
          await deps.flush();
        }
      })(),
    );
  },
};
