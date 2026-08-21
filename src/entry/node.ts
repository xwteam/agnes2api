import { serve } from "@hono/node-server";
import { setTimeout as nodeSetTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import { buildApp, buildTendDeps, type TendRoundDeps } from "../http/wire.js";
import { FileStorage } from "../adapters/storage-file.js";
import { KeyPoolRepo } from "../core/keypool-repo.js";
import { ConsoleLogger } from "../adapters/logger-console.js";
import { StoreLogger } from "../adapters/logger-store.js";
import { multiLogger } from "../adapters/logger-multi.js";
import { nodeRuntime } from "../adapters/runtime-node.js";
import { tendOnce, summarizeFailures } from "../core/registrar/tender.js";
import { loadConfig } from "../core/config.js";
import { startTendScheduler } from "../core/tend-scheduler.js";
import { acquireTendLock, releaseTendLock } from "../http/admin/tend-lock.js";

/**
 * node 运行时的真实启动路径：选存储实现（FileStorage）、装配 app、监听端口。
 * 导出成函数是为了让回归测试能直接调用它（而不是只测试它调用的 buildApp），
 * 同时避免测试环境下 import 这个模块就顺带把服务器起在真实端口上。
 */
export async function main(env: Record<string, string | undefined> = process.env) {
  const storage = new FileStorage(env.DATA_DIR ?? "/app/data");
  const logger = new ConsoleLogger();
  // 数据目录是绑定挂载，属主不匹配就整个网关不可用（写不进 store.json），
  // 必须在启动那一刻探出来并让 /health 如实报告，不能等到第一个请求失败才发现。
  const { app, configHolder, tendGate } = await buildApp(env, storage, nodeRuntime(), { probeStorage: true });
  const port = Number(env.PORT ?? 8080);

  // 在途守卫。递归 setTimeout **天然不会重叠**（下一轮的定时器要等本轮 resolve 之后
  // 才排上），所以它现在防的不是定时器自己，而是「面板『立即补池』按钮与定时轮撞车」
  // ——那是第三次把并发放进来的机会，前两次分别是 setInterval 不等 resolve（C4）
  // 和 Worker 的 Cron 重叠。
  //
  // **P3c Task 5 起它不再是本文件的一个局部变量**：那颗按钮跑在同一个进程里，
  // 各拿各的布尔等于形同虚设，所以这一把由 `buildApp` 建、由 app 与本文件**共用**
  //（`BuiltApp.tendGate`）。它与下面那把存储级锁**不是冗余**——一把挡同进程重入、
  // 一把挡跨副本重叠，对照表见 `src/http/admin/tend-lock.ts`。
  const runTend = async () => {
    const leave = tendGate.tryEnter();
    if (leave === null) {
      console.warn(
        "[registrar] 上一轮补池仍在进行，跳过本次触发（可调大 TEND_INTERVAL_MS 或调小 MINT_BATCH）",
      );
      return;
    }
    try {
      // key 池索引对账。**必须在「注册机是否启用」的判断之前**——下面是 `if (!deps) return`，
      // 放在后面等于注册机关着时永不对账，而索引残留（孤儿记录 / 幽灵索引项）恰恰不挑
      // 注册机开没开。与 Worker 的 scheduled() 同一份口径，见那里的说明。
      try {
        const repo = new KeyPoolRepo(storage, { now: () => Date.now(), logger });
        await repo.reconcileIndex();
      } catch (err) {
        // 对账失败不该影响补池：索引残留是 fail-safe 的（key 不被用，而不是坏 key 被用）。
        console.error("[agnes2api] key 池索引对账失败", err);
      }

      // **每一轮都重新读一次配置**（环境变量 + 存储），与 Worker 侧每次 Cron 都
      // 重新 buildTendDeps 的行为对齐。此前只在启动时装配一次、之后一直复用那份
      // 快照：P3 的面板是这份配置的编辑器（设计 §11），同一个面板操作在 Worker
      // 上立即生效、在 Node 上却必须重启进程；更糟的是启动时 enabled=false 就
      // 根本没有定时器，此后怎么改存储都打不开，而启动时 enabled=true 则从存储
      // 关也关不掉。
      //
      // 未启用时 buildTendDeps 在构造任何 provider 之前就返回 null：这一轮**不会
      // 触达邮箱或 Agnes**，与 Worker 侧 REGISTRAR_ENABLED=false 时 Cron 空转的语义
      // 完全一致。注意口径是「无外部副作用」而不是「零副作用」——这一轮仍然会读一次
      // 配置，上面那次索引对账也照做（索引不存在时还会写一次）。
      // 补池这条路自己的事件 sink（本任务）。**每一轮新建一个**，理由与
      // `src/entry/worker.ts` 里同位置那段完全相同（双运行时对等是硬约束）：
      // Worker 上每次 Cron 本来就很可能是新 isolate，Node 是长寿进程，不新建的话
      // 写预算（`EVENT_WRITES_PER_DAY` = 12，实例字段）会让第 13 轮之后**静默不写**
      // ——而那条预算对这根轴本来就不适用（订正 F4：上界是补池频率本身）。
      const tendStore = new StoreLogger({
        storage,
        now: () => Date.now(),
        shardId: crypto.randomUUID().slice(0, 8),
        onError: (err) => logger.log({
          level: "error", event: "storage.event_flush_failed",
          msg: "补池事件落盘失败，本轮缓冲已丢弃（不重试同一批）",
          fields: { error: err instanceof Error ? err.message : String(err) },
        }),
      });

      let deps: TendRoundDeps | null;
      try {
        deps = await buildTendDeps(env, storage, {
          // **`ConsoleLogger` 那一路一条都不丢**：落库是 fan-out 出来的第二条路。
          logger: multiLogger(logger, tendStore),
          // **`flush()` 不是 `maybeFlush()`** —— 见 worker.ts 同位置的说明与
          // `StoreLogger.flush()`：跑得快的那一轮会被最小间隔闸整轮吃掉，
          // 且 errs=0、dropped=0、不抛不报。
          flush: () => tendStore.flush(),
        });
      } catch (err) {
        // 装配失败（例如注册机配置被改成非法值）只记日志：转发能力与补池能力
        // 相互独立，不该因为补池装配失败而让整个网关进程停摆。
        console.error("[registrar] 装配补池依赖失败", err);
        return;
      }
      if (!deps) return; // 注册机未启用：不触达邮箱/Agnes（对账已在上面做过）

      // 存储级短锁。**这在 P3c Task 5 之前是没有的**：Node 侧只有上面那把进程内守卫，
      // 而 Docker 的多副本共卷部署（同一个 DATA_DIR 挂给两个容器）下它形同虚设
      //——两个副本各有各的布尔，两轮补池同时跑，同时撞邮箱建号限流与上游注册风控。
      // 与 Worker 的 Cron 路径**共用同一份实现与同一把键**，见 `tend-lock.ts`。
      const lock = await acquireTendLock(storage, Date.now());
      if (!lock.ok) {
        console.warn("[registrar] 另一个副本正在补池，跳过本次触发（多副本共卷部署下这是正常的）");
        return;
      }

      const roundStartedAt = Date.now();
      try {
        const r = await tendOnce(deps);
        // 每轮汇总落进 `tend:history`（设计 §7.3）。与 Worker 同一份口径。
        await deps.recordRound(r, "cron");
        if (!r.skipped) {
          console.log(
            `[registrar] 补池完成 available=${r.available} attempted=${r.attempted} minted=${r.minted}`,
          );
          // 有名额没铸出来时把归因也打出来：只看 minted=0 无法区分 Agnes 挂了、
          // 邮箱通道挂了、还是通道配错了，而这三种的处置完全不同。
          if (r.minted < r.attempted) {
            console.warn(`[registrar] 本轮有名额未铸出，归因 reasons=${summarizeFailures(r.failures)}`);
          }
        }
      } catch (err) {
        // 补池失败不该让网关进程崩掉——转发能力与补池能力是相互独立的。
        // **但它必须在面板上占一格**（评审 C1）：原来这里只有一行裸
        // `console.error`，它进不了事件缓冲 ⇒ `flush()` 首行就 return；而
        // `recordRound` 排在 `tendOnce` 之后、一抛就整个跳过 ⇒ 面板上这一轮
        // 什么都没有，**与「注册机根本没跑」逐字节不可区分**。
        // 与 Worker 侧同一份口径，见那里的说明。
        // **原有的控制台行数一行都不减**，见 worker.ts 同位置的说明。
        console.error("[registrar] 补池失败", err);
        deps.logger.log({
          level: "error", event: "registrar.round_failed",
          msg: "补池整轮抛错中断，本轮没有产出；下一次调度会重新开始",
          fields: { error: err instanceof Error ? err.message : String(err) },
        });
        await deps.recordCrashedRound({
          at: roundStartedAt, channel: deps.config.primary ?? "",
          durationMs: Date.now() - roundStartedAt, trigger: "cron",
        });
      } finally {
        // 锁必须释放，否则下一轮要空等到 TTL 到期才肯干活。与 Worker 侧同一条口径：
        // 释放失败走 `deps.logger`（不是裸 console.warn），因为那正是运维要在事件
        // 板块里看到的那类事——它意味着接下来的触发会被跳过，最长到锁自然过期。
        try {
          await releaseTendLock(storage);
        } catch (err) {
          console.warn("[registrar] 释放补池锁失败，最坏情况下要等锁自然过期", err);
          deps.logger.log({
            level: "warn", event: "registrar.lock_release_failed",
            msg: "释放补池锁失败，最坏情况下要等锁自然过期（期间补池触发会被跳过）",
            fields: { error: err instanceof Error ? err.message : String(err) },
          });
        }
        // **补池事件落盘。必须是这一轮的最后一件事**——上面 catch 里那条
        // 「补池失败」、刚才那条 `lock_release_failed`、以及 `recordRound` 可能打出的
        // warn 都要赶上这一次落盘，这一轮再没有第二次机会（下一轮是一个全新的 sink 实例）。
        // 与 Worker 侧 `ctx.waitUntil` 的 `finally` 同一条口径。
        await deps.flush();
      }
    } finally {
      leave();
    }
  };

  // 初始间隔只取 buildApp 已经 primed 过的 configHolder：它是用真实 ConsoleLogger
  // 建的、只读一次存储，不再像此前那样为了拿 tendIntervalMs 单独调一次 loadConfig
  // （那是本文件此前的一处独立存储读取，且没有传 logger，配置告警会静默落到
  // NULL_LOGGER——tests/unit/entry-node-tend-failure.test.ts 的「启动时只读一次
  // config 键」防回归用例钉着这一条）。未启用时 buildTendDeps 返回 null、拿不到
  // tendIntervalMs，而定时器必须先存在，之后从存储打开注册机才有东西可触发。
  const { registrar } = configHolder.current();

  startTendScheduler({
    runOnce: runTend,
    // **每一轮重排都重新读一次配置**（而不是复用 configHolder 的 30 秒 TTL 缓存），
    // 与 buildTendDeps 每轮都重新 loadConfig 的口径对齐，也是本次要修的缺陷
    // 本身——I4 之前这里读的是启动时那份快照，永远不变。不能用 buildTendDeps 取
    // 间隔：它在注册机未启用时返回 null，而定时器必须在关闭状态下也继续存在。
    readIntervalMs: async () => (await loadConfig(env, storage, logger)).registrar.tendIntervalMs,
    // 显式用 node:timers 的 setTimeout（而非全局 setTimeout）：这个项目的
    // tsconfig 同时装了 @cloudflare/workers-types 和 node 的类型，全局
    // setTimeout 的重载在两者间不保证解析到带 unref() 的 Node 版本。unref
    // 让定时器不阻止进程退出，否则容器收到停止信号后要等到下一次触发才肯退，
    // 测试里也会因为悬挂的 timer handle 导致 vitest 进程不退出。
    setTimer: (fn, ms) => { nodeSetTimeout(fn, ms).unref(); },
    initialIntervalMs: registrar.tendIntervalMs,
    onError: (kind, err) => {
      console.error(
        kind === "run"
          ? "[registrar] 补池轮出现未捕获异常，已重排下一轮"
          : "[registrar] 重排时读配置失败，沿用上一次已知的合法间隔",
        err,
      );
    },
  });

  return serve({ fetch: app.fetch, port }, (info) => {
    console.log(`agnes2api listening on :${info.port}`);
  });
}

// 只有直接执行这个文件（`node dist/entry/node.js`）时才真正启动；
// 被其他模块 import（例如测试）时不产生任何副作用。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
