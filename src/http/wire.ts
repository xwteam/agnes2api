import { createApp } from "./app.js";
import { loadConfig } from "../core/config.js";
import { KeyPoolRepo } from "../core/dispatcher.js";
import { NativeFetcher } from "../adapters/fetcher-native.js";
import { VERSION } from "../version.js";
import type { Storage } from "../ports/storage.js";

/**
 * 从环境变量与存储装配出完整的 app。两个入口（worker/node）都调用它，
 * 只在“用哪种 Storage 实现”上有区别，其余装配逻辑完全共用。
 *
 * 用 loadConfig 而不是 configFromEnv：buildApp 的调用方（两个入口）手上
 * 总是已经有一个 Storage 实例，loadConfig 能在 env 未显式设置时回退到
 * storage 中持久化的配置（例如未来的管理接口写入的覆盖值），是 configFromEnv
 * 的严格超集；没有理由在有 storage 可用时退化成只读 env 的版本。
 */
export async function buildApp(env: Record<string, string | undefined>, storage: Storage) {
  const config = await loadConfig(env, storage);
  return createApp({
    version: VERSION,
    config,
    repo: new KeyPoolRepo(storage),
    fetcher: new NativeFetcher(),
    now: () => Date.now(),
  });
}
