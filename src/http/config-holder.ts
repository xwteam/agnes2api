import { Refreshable } from "../core/refreshable.js";
import { loadConfig, type GatewayConfig } from "../core/config.js";
import type { Storage } from "../ports/storage.js";
import type { Logger } from "../ports/logger.js";

/**
 * 配置持有者。放入口层而不是 core：它要碰存储。
 *
 * `AppDeps.config` 从**值**改成它，是因为原来那份值在建 app 那一刻就被闭包捕获了
 * （src/http/app.ts:33-34），Worker 的 isolate 与 Node 的进程各自把它冻结到生命周期结束。
 * 后果不只是「保存没生效」，而是**一个撤销不掉的凭据**：没设 GATEWAY_TOKEN 环境变量时，
 * worker.ts 的缓存判断恒为 false，热 isolate 里的旧口令无限期继续有效。
 */
export interface ConfigHolder {
  /** 同步读，**永不抛**。createConfigHolder 已经 prime 过，所以一定有值。 */
  current(): GatewayConfig;
  /** TTL 到期才真的重载。**永不抛**——重载失败保留上一份合法快照。 */
  ensureFresh(): Promise<void>;
  /** 面板写操作成功后调用，让下一次 ensureFresh 一定重载。 */
  invalidate(): void;
}

/**
 * 30 秒。
 *
 * 不取 10：miniflare 写死 `MIN_CACHE_TTL_SECONDS: 30`，小于它直接抛
 * `Invalid cache_ttl of N. Cache TTL must be at least 30.`（已核实）。虽然本项目
 * **不给 KV 的 get 传 cacheTtl**（走默认值），把 holder 的 TTL 和它对齐可以避免
 * 「holder 比边缘缓存还快，于是快出来的那部分毫无意义」。
 *
 * 用户可见的总生效上界 = 本 TTL + KV 边缘缓存与传播时间。后者的确切秒数是
 * 待复核项 U3，**在复核完成之前不许把任何具体秒数写进 UI 文案或用户文档**。
 */
export const CONFIG_TTL_MS = 30_000;

export async function createConfigHolder(deps: {
  env: Record<string, string | undefined>;
  storage: Storage;
  logger: Logger;
  now: () => number;
  ttlMs?: number;
}): Promise<ConfigHolder> {
  const r = new Refreshable<GatewayConfig>({
    load: () => loadConfig(deps.env, deps.storage, deps.logger),
    ttlMs: deps.ttlMs ?? CONFIG_TTL_MS,
    now: deps.now,
    onError: (err) => deps.logger.log({
      level: "error", event: "config.reload_failed",
      msg: "重新读取配置失败，继续沿用上一份合法快照",
      fields: { err: err instanceof Error ? err.message : String(err) },
    }),
  });
  // 首次装载**失败必须抛**：缺 GATEWAY_TOKEN 拒绝服务是 P1 的三条不变量之一。
  await r.prime();
  return {
    // prime 成功过，current() 一定有值。
    current: () => r.current() as GatewayConfig,
    ensureFresh: () => r.ensureFresh(),
    invalidate: () => r.invalidate(),
  };
}

/** 固定配置的 holder。测试夹具与 P3c 的「干跑校验」用，生产路径不用。 */
export function fixedConfigHolder(config: GatewayConfig): ConfigHolder {
  return { current: () => config, ensureFresh: async () => {}, invalidate: () => {} };
}
