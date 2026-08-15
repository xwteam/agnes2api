import { serve } from "@hono/node-server";
import { setInterval as nodeSetInterval } from "node:timers";
import { pathToFileURL } from "node:url";
import { buildApp, buildTendDeps } from "../http/wire.js";
import { FileStorage } from "../adapters/storage-file.js";
import { tendOnce } from "../core/registrar/tender.js";
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

  // 注册机未启用（默认状态）时 buildTendDeps 直接返回 null，不起定时器。
  // 装配本身也可能失败（例如注册机配置非法）——同下面 runTend() 的原则，装配
  // 阶段的失败也不该让网关整个进程起不来：转发能力与补池能力相互独立。当前
  // buildApp() 先于这里执行、会对同一份注册机配置做同等校验并率先抛错，这层
  // try/catch 眼下不可达，但不该是巧合式安全——防的是未来重构把 buildApp 与
  // buildTendDeps 的校验路径解耦后悄悄引入的回归（与 worker.ts 的 scheduled()
  // 对称）。
  let tendDeps: TendDeps | null = null;
  try {
    tendDeps = await buildTendDeps(env, storage);
  } catch (err) {
    console.error("[registrar] 装配补池依赖失败", err);
  }
  if (tendDeps) {
    const runTend = async () => {
      try {
        const r = await tendOnce(tendDeps);
        if (!r.skipped) {
          console.log(
            `[registrar] 补池完成 available=${r.available} attempted=${r.attempted} minted=${r.minted}`,
          );
        }
      } catch (err) {
        // 补池失败不该让网关进程崩掉——转发能力与补池能力是相互独立的。
        console.error("[registrar] 补池失败", err);
      }
    };

    // 立即跑一轮：否则冷启动后要空等满一个间隔（默认 30 分钟）才开始补池。
    void runTend();

    // 显式用 node:timers 的 setInterval（而非全局 setInterval）：这个项目的
    // tsconfig 同时装了 @cloudflare/workers-types 和 node 的类型，全局
    // setInterval 的重载在两者间不保证解析到带 unref() 的 Node 版本。unref
    // 让定时器不阻止进程退出，否则容器收到停止信号后要等到下一次触发才肯退，
    // 测试里也会因为悬挂的 timer handle 导致 vitest 进程不退出。
    nodeSetInterval(runTend, tendDeps.config.tendIntervalMs).unref();
  }

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
