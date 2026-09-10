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
import { acquireTendLock, releaseTendLock, TEND_LOCK_TTL_SCHEDULED_MS } from "../http/admin/tend-lock.js";

/**
 * **空串视同「没设」。** 只用在本文件这两个运行时开关上，不是全局规则。
 *
 * 起因是一条 shell 与 JS 对空串**不同义**造成的静默失败：`.env.example` 是给
 * `cp .env.example .env` + compose 的 `env_file:` 直接用的，那条路径上一个留空的键
 * 送进来的是**空字符串**（不是「未设置」），而 `??` 只接 `undefined`，接不住空串。
 * 容器那一侧同一个变量走的却是 shell 的 `${DATA_DIR:-/app/data}`（`docker-entrypoint.sh`）
 * 与 `${PORT:-8080}`（`docker-compose.yml`）——`:-` 把空串**当未设**。两边一分叉：
 *
 * · `DATA_DIR=` ⇒ entrypoint 照旧准备并 chown `/app/data`，而进程这边
 *   `new FileStorage("")` 让 `join("", "store.json")` 退化成相对路径 `store.json`，
 *   落在 `WORKDIR /app` 下的 `/app/store.json`。那里**可写**（Dockerfile 的
 *   `chown -R app:app /app`）⇒ 启动存储探测通过、`/health` 报 healthy、面板一切正常，
 *   而 `./data:/app/data` 那个卷从头到尾是空的 ⇒ **容器一重建，整池 key 与配置静默消失**。
 * · `PORT=` ⇒ compose 仍按 `${PORT:-8080}` 发布 8080，容器内 `Number("")` 却是 0
 *   （监听随机端口）⇒ 端口映射打空；连 Dockerfile 的 HEALTHCHECK 都写的是
 *   `PORT||8080`（`||` 同样把空串当没设），只有这里从前用 `??`，是四处里唯一不同义的。
 *
 * ⚠️ **别把这条推广成「全仓空串都当没设」**：数值型配置项（`MAX_STRIKES` 等）留空
 * 时抛错是**有意的** fail-fast（`src/core/config-provenance.ts` 的 `num()`：环境变量
 * 的非法值必须让运维立刻看得见）。这两个之所以归一，是因为它们的失败方向相反——
 * 不响，而且要等到容器重建那一刻才看得见。
 */
const orUnset = (raw: string | undefined): string | undefined => (raw === "" ? undefined : raw);

/** 文件存储的目录。空串视同没设，理由见 `orUnset`。 */
export const nodeDataDir = (env: Record<string, string | undefined>): string =>
  orUnset(env.DATA_DIR) ?? "/app/data";

/** 监听端口。空串视同没设；显式的 `PORT=0` 仍然是「让内核挑一个」，测试就靠它。 */
export const nodePort = (env: Record<string, string | undefined>): number =>
  Number(orUnset(env.PORT) ?? 8080);

/**
 * 网关的真实启动路径：建 `FileStorage`、装配 app、监听端口。
 * **v0.4.0 起这是仓里唯一的入口**（Cloudflare Worker 那一个已整体删除）。
 * 导出成函数是为了让回归测试能直接调用它（而不是只测试它调用的 buildApp），
 * 同时避免测试环境下 import 这个模块就顺带把服务器起在真实端口上。
 */
export async function main(env: Record<string, string | undefined> = process.env) {
  const storage = new FileStorage(nodeDataDir(env));
  const logger = new ConsoleLogger();
  // 数据目录是绑定挂载，属主不匹配就整个网关不可用（写不进 store.json），
  // 必须在启动那一刻探出来并让 /health 如实报告，不能等到第一个请求失败才发现。
  const { app, configHolder, tendGate } = await buildApp(env, storage, { probeStorage: true });
  const port = nodePort(env);

  // 在途守卫。递归 setTimeout **天然不会重叠**（下一轮的定时器要等本轮 resolve 之后
  // 才排上），所以它现在防的不是定时器自己，而是「面板『立即补池』按钮与定时轮撞车」
  // ——那是第二次把并发放进来的机会，第一次是 setInterval 不等 resolve。
  //
  // **它不再是本文件的一个局部变量**：那颗按钮跑在同一个进程里，
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
      // 注册机开没开。
      try {
        const repo = new KeyPoolRepo(storage, { now: () => Date.now(), logger });
        await repo.reconcileIndex();
      } catch (err) {
        // 对账失败不该影响补池：索引残留是 fail-safe 的（key 不被用，而不是坏 key 被用）。
        console.error("[agnes2api] key 池索引对账失败", err);
      }

      // **每一轮都重新读一次配置**（环境变量 + 存储）。此前只在启动时装配一次、
      // 之后一直复用那份快照：面板是这份配置的编辑器（设计 §11），改完必须重启进程
      // 才生效；更糟的是启动时 enabled=false 就根本没有定时器，此后怎么改存储都
      // 打不开，而启动时 enabled=true 则从存储关也关不掉。
      //
      // 未启用时 buildTendDeps 在构造任何 provider 之前就返回 null：这一轮**不会
      // 触达邮箱或 Agnes**。注意口径是「无外部副作用」而不是「零副作用」——这一轮
      // 仍然会读一次配置，上面那次索引对账也照做（索引不存在时还会写一次）。
      //
      // 补池这条路自己的事件 sink。**每一轮新建一个**：这里是长寿进程，
      // 不新建的话写预算（`EVENT_WRITES_PER_DAY` = 12，**实例字段**）会让第 13 轮
      // 之后**静默不写**——而那条预算对这根轴本来就不适用（上界是补池频率本身，
      // 见 `src/http/wire.ts` 里 `buildTendDeps` 上方那段）。
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
          // **`flush()` 不是 `maybeFlush()`** —— 见 `StoreLogger.flush()`：
          // 跑得快的那一轮会被最小间隔闸整轮吃掉，且 errs=0、dropped=0、不抛不报。
          flush: () => tendStore.flush(),
        });
      } catch (err) {
        // 装配失败只记日志：转发能力与补池能力相互独立，不该因为补池装配失败
        // 而让整个网关进程停摆。
        //
        // ⚠️ **括号里原来举的例子（「注册机配置被改成非法值」）在本轮之后成了假话，
        // 已删。** `buildTendDeps` 现在走 `loadConfigWithProvenance`，注册机配置非法
        // 这一族**再也不会抛**：要么字段级降级，要么产 blocker 走 gate 早退（返回
        // `null`，走的是下面那句 `if (!deps) return`，根本不是这条 catch）。
        // 今天在 Node 上还够得着这条 catch 的只剩两条，**都不是「配置被改成非法值」**：
        // ① 面板把存储里的 `gatewayToken` 清掉、而环境变量里也没有 ⇒ `ConfigRefusal`；
        // ② 这一次存储读失败 ⇒ 原样抛（`buildTendDeps` 不传 `degradeOnUnreadable`，
        //    那个降级只给冷启动那条路）。
        // `num()` 的 env 侧非法值这一档在**这里**够不着：env 在运行中不变，
        // 而同一份 env 已经在上面 `buildApp` 那一步过了一遍，不合格的话进程早就
        // `process.exit(1)` 了（本文件末尾那个 `main().catch`）。
        console.error("[registrar] 装配补池依赖失败", err);
        return;
      }
      if (!deps) return; // 注册机未启用：不触达邮箱/Agnes（对账已在上面做过）

      // 存储级短锁。**这是后来补的**：早先 Node 侧只有上面那把进程内守卫，
      // 而 Docker 的多副本共卷部署（同一个 DATA_DIR 挂给两个容器）下它形同虚设
      //——两个副本各有各的布尔，两轮补池同时跑，同时撞邮箱建号限流与上游注册风控。
      // **与面板那颗「立即补池」共用同一份实现与同一把键**，见 `tend-lock.ts`。
      // 这一路是定时轮，用定时轮那份 TTL（15 分钟）；手动那条路另有一份 3 分钟的。
      const lock = await acquireTendLock(storage, Date.now(), TEND_LOCK_TTL_SCHEDULED_MS);
      if (!lock.ok) {
        console.warn("[registrar] 另一个副本正在补池，跳过本次触发（多副本共卷部署下这是正常的）");
        return;
      }

      const roundStartedAt = Date.now();
      try {
        const r = await tendOnce(deps);
        // 每轮汇总落进 `tend:history`（设计 §7.3）。
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
        // **但它必须在面板上占一格**（评审发现）：原来这里只有一行裸
        // `console.error`，它进不了事件缓冲 ⇒ `flush()` 首行就 return；而
        // `recordRound` 排在 `tendOnce` 之后、一抛就整个跳过 ⇒ 面板上这一轮
        // 什么都没有，**与「注册机根本没跑」逐字节不可区分**。
        // **原有的控制台行数一行都不减**：`docker logs` 是运维的第一现场，
        // 事件板块是第二现场，两边都要看得见这一轮炸了。
        console.error("[registrar] 补池失败", err);
        deps.logger.log({
          level: "error", event: "registrar.round_failed",
          msg: "补池整轮抛错中断，本轮没有产出；下一次调度会重新开始",
          fields: { error: err instanceof Error ? err.message : String(err) },
        });
        await deps.recordCrashedRound({
          at: roundStartedAt, channel: deps.config.channel ?? "",
          durationMs: Date.now() - roundStartedAt, trigger: "cron",
        });
      } finally {
        // 锁必须释放，否则下一轮要空等到 TTL 到期才肯干活。
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
    // 本身——修它之前这里读的是启动时那份快照，永远不变。不能用 buildTendDeps 取
    // 间隔：它在注册机未启用时返回 null，而定时器必须在关闭状态下也继续存在。
    readIntervalMs: async () => (await loadConfig(env, storage, logger)).registrar.tendIntervalMs,
    // 显式用 node:timers 的 setTimeout（而非全局 setTimeout）：拿到的是**确定**
    // 带 `unref()` 的那一个重载，不必指望全局 `setTimeout` 解析到哪一份类型。
    // `unref()` 让定时器不阻止进程退出，否则容器收到停止信号后要等到下一次触发
    // 才肯退，测试里也会因为悬挂的 timer handle 导致 vitest 进程不退出。
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
