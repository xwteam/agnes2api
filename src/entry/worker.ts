import { buildApp, buildTendDeps } from "../http/wire.js";
import { KvStorage } from "../adapters/storage-kv.js";
import { KeyPoolRepo } from "../core/keypool-repo.js";
import { ConsoleLogger } from "../adapters/logger-console.js";
import { StoreLogger } from "../adapters/logger-store.js";
import { multiLogger } from "../adapters/logger-multi.js";
import { workerRuntime } from "../adapters/runtime-worker.js";
import { tendOnce, summarizeFailures } from "../core/registrar/tender.js";
import { WORKER_CRON_WALL_CLOCK_MS, WORKER_ROUND_BUDGET_MS } from "../core/registrar/types.js";
import type { Hono } from "hono";

export interface Env {
  GATEWAY_TOKEN?: string;
  POOL: KVNamespace;
  [k: string]: unknown;
}

let cachedApp: Hono | null = null;

/** 补池轮次的重入锁，落在与 key 池同一个 KV 命名空间里（不新增依赖）。 */
const TEND_LOCK_KEY = "registrar_tend_lock";
/**
 * 锁的有效期。取 Cloudflare Cron Trigger 单次调用的墙钟上限（15 分钟）：超过它，
 * 上一轮要么已经结束、要么已经被平台中止，锁不该再拦住新的一轮——否则一次
 * 被中止的调用会让补池永久停摆。
 */
const TEND_LOCK_TTL_MS = WORKER_CRON_WALL_CLOCK_MS;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
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
    return app.fetch(req);
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
    //    不适用（订正 F4：真正的上界是补池频率）。每轮一个新实例让上界回到频率本身。
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
    const now = Date.now();
    const lock = await storage.get<{ until?: number }>(TEND_LOCK_KEY);
    if (lock && typeof lock.until === "number" && lock.until > now) {
      console.warn("[registrar] 上一轮补池仍在进行，跳过本次 Cron 触发（可调疏 cron 或调小 MINT_BATCH）");
      return;
    }
    await storage.put(TEND_LOCK_KEY, { until: now + TEND_LOCK_TTL_MS });

    ctx.waitUntil(
      (async () => {
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
          console.error("[registrar] 补池失败", err);
        } finally {
          // 锁必须释放，否则下一次 Cron 要空等到 TTL 到期才肯干活。释放本身
          // 失败也不能让这个后台任务以异常收场。
          try {
            await storage.delete(TEND_LOCK_KEY);
          } catch (err) {
            console.warn("[registrar] 释放补池锁失败，最坏情况下要等锁自然过期", err);
          }
          // **flush 必须是这个 finally 里的最后一件事。**
          // ⚠️ 计划 Step 6 写的是「先 flush 再释放锁」，理由是「释放锁失败会走
          // catch，而事件正是要记录这件事」——**那个理由要求的恰恰是相反的顺序**：
          // 先 flush 的话，flush 之后产生的任何事件（释放锁失败、写 tend:history
          // 失败）都还留在缓冲里，而这一轮再也没有第二次落盘机会。这里按理由走，
          // 不按那句话走。释放锁排在前面还有一层好处：它在挡着下一次 Cron，
          // 早一点放开比晚一点好，而 flush 是一次可能很慢的 KV 写。
          await deps.flush();
        }
      })(),
    );
  },
};
