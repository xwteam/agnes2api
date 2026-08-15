import { serve } from "@hono/node-server";
import { pathToFileURL } from "node:url";
import { buildApp } from "../http/wire.js";
import { FileStorage } from "../adapters/storage-file.js";

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
