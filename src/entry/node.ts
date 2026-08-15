import { serve } from "@hono/node-server";
import { setInterval as nodeSetInterval } from "node:timers";
import { pathToFileURL } from "node:url";
import { buildApp, buildTendDeps } from "../http/wire.js";
import { loadConfig } from "../core/config.js";
import { FileStorage } from "../adapters/storage-file.js";
import { tendOnce, summarizeFailures } from "../core/registrar/tender.js";
import type { TendDeps } from "../core/registrar/tender.js";

/**
 * node 运行时的真实启动路径：选存储实现（FileStorage）、装配 app、监听端口。
 * 导出成函数是为了让回归测试能直接调用它（而不是只测试它调用的 buildApp），
 * 同时避免测试环境下 import 这个模块就顺带把服务器起在真实端口上。
 */
export async function main(env: Record<string, string | undefined> = process.env) {
  const storage = new FileStorage(env.DATA_DIR ?? "/app/data");
  // 数据目录是绑定挂载，属主不匹配就整个网关不可用（写不进 store.json），
  // 必须在启动那一刻探出来并让 /health 如实报告，不能等到第一个请求失败才发现。
  const app = await buildApp(env, storage, { probeStorage: true });
  const port = Number(env.PORT ?? 8080);

  // 在途守卫。`setInterval` 不等上一轮 resolve，而单轮最坏耗时
  //（MINT_BATCH × CODE_TIMEOUT_MS，默认 5×120 秒）轻易就能超过 TEND_INTERVAL_MS，
  // 于是补池轮次会重叠着跑。这正是「顺序铸、不并发」这条**功能性**约束要防的
  // 事：并发会同时撞邮箱服务的建号限流与 Agnes 的注册风控。tender 在**轮内**
  // 严防 Promise.all，轮间的重叠只能在调度接线这一层挡住。
  let inFlight = false;

  const runTend = async () => {
    if (inFlight) {
      console.warn(
        "[registrar] 上一轮补池仍在进行，跳过本次触发（可调大 TEND_INTERVAL_MS 或调小 MINT_BATCH）",
      );
      return;
    }
    inFlight = true;
    try {
      // **每一轮都重新读一次配置**（环境变量 + 存储），与 Worker 侧每次 Cron 都
      // 重新 buildTendDeps 的行为对齐。此前只在启动时装配一次、之后一直复用那份
      // 快照：P3 的面板是这份配置的编辑器（设计 §11），同一个面板操作在 Worker
      // 上立即生效、在 Node 上却必须重启进程；更糟的是启动时 enabled=false 就
      // 根本没有定时器，此后怎么改存储都打不开，而启动时 enabled=true 则从存储
      // 关也关不掉。
      //
      // 未启用时 buildTendDeps 在构造任何 provider 之前就返回 null：这一轮除了
      // 读一次配置不产生任何副作用，不会触达邮箱或 Agnes——与 Worker 侧
      // REGISTRAR_ENABLED=false 时 Cron 空转的语义完全一致。
      let deps: TendDeps | null;
      try {
        deps = await buildTendDeps(env, storage);
      } catch (err) {
        // 装配失败（例如注册机配置被改成非法值）只记日志：转发能力与补池能力
        // 相互独立，不该因为补池装配失败而让整个网关进程停摆。
        console.error("[registrar] 装配补池依赖失败", err);
        return;
      }
      if (!deps) return; // 注册机未启用：零副作用

      try {
        const r = await tendOnce(deps);
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
        console.error("[registrar] 补池失败", err);
      }
    } finally {
      inFlight = false;
    }
  };

  // 定时器的**间隔**仍取自启动时的配置：改间隔要重启进程，改 enabled 及其余配置
  // 项则每一轮都会生效。这里单独读一次配置，是因为未启用时 buildTendDeps 返回
  // null、拿不到 tendIntervalMs，而定时器必须先存在，之后从存储打开注册机才有
  // 东西可触发。
  const { registrar } = await loadConfig(env, storage);

  // 立即跑一轮：否则冷启动后要空等满一个间隔（默认 30 分钟）才开始补池。
  void runTend();

  // 显式用 node:timers 的 setInterval（而非全局 setInterval）：这个项目的
  // tsconfig 同时装了 @cloudflare/workers-types 和 node 的类型，全局
  // setInterval 的重载在两者间不保证解析到带 unref() 的 Node 版本。unref
  // 让定时器不阻止进程退出，否则容器收到停止信号后要等到下一次触发才肯退，
  // 测试里也会因为悬挂的 timer handle 导致 vitest 进程不退出。
  nodeSetInterval(runTend, registrar.tendIntervalMs).unref();

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
