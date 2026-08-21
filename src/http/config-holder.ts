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
 * **用户可见的总生效上界 = 本 TTL(30s) + KV 边缘缓存默认 60s ≈ 90 秒。**
 * 待复核项 U3 已核实：Cloudflare KV 的 `cacheTtl` 最小值 30、默认值 60（官方文档
 * https://developers.cloudflare.com/kv/api/read-key-value-pairs/ ，"cacheTtl... minimum:
 * 30"、"60 is the default"，2026-08-19 复核），与本文件上面那句「miniflare 写死 30」
 * 一致，因此这个数字**可以**写进 UI 文案与用户文档，并且**必须**写——设计文档 §5.2
 * 明说「面板文案必须写这个数，不许写『立即生效』」。
 *
 * ⚠️ 别把它和 `POOL_CACHE_TTL_MS` 那条上界搞混：那条是「别的 isolate 判的冷却/剔除
 * 多久能看到」，= `POOL_CACHE_TTL_MS + 约 60 秒`（默认约 120 秒），是另一个数，
 * 见 `keypool-repo.ts` 的 `KeyPoolRepoOptions.cacheTtlMs` 注释。
 * **面板要把两个数都显示出来**，只显示一个就是又一个「面板不撒谎」的破口。
 */
export const CONFIG_TTL_MS = 30_000;

/**
 * KV 边缘缓存的默认 `cacheTtl`（秒 → 毫秒）。
 *
 * **已核实**：Cloudflare KV 的 `cacheTtl` 最小 30、默认 60（设计文档 §17 U3，2026-08-19）。
 *
 * ⚠️ **它原来是 `src/http/admin/handlers/overview.ts` 里的一个模块私有常量**，
 * P3c Task 7 把它**移**到这里（不是新增第二份）：`PUT /admin/api/config` 的
 * `propagation` 块要报同一个「多久能看见」上界，而那个数字在五语言 DEPLOY.md 里
 * 是对用户的承诺。抄第二份的后果是概览页与保存回执可以给出两个不同的数——
 * 「面板不撒谎」这条在本仓已经因为同一形态破过一次。
 */
export const KV_EDGE_CACHE_MS = 60_000;

export async function createConfigHolder(deps: {
  env: Record<string, string | undefined>;
  storage: Storage;
  logger: Logger;
  now: () => number;
  ttlMs?: number;
}): Promise<ConfigHolder> {
  // **只有 prime() 那一次装载**才允许「存储读不出来」降级到 env + 默认值——
  // 那时没有上一份合法快照可退，不降级的后果是冷启动直接把整个网关拒之门外。
  // 之后每一次 ensureFresh() 触发的例行刷新都必须严格：抛错交给下面的
  // Refreshable 自己的兜底（保留上一份合法快照），不许在 loadConfig 内部
  // 把一次热路径上的瞬时读抖动悄悄换成默认值——完整理由见 loadConfig 里
  // degradeOnUnreadable 那段注释。这个标记只在闭包里活一次，prime() 成功之后
  // 就再也用不上（同一个 Refreshable 实例的 load 之后只会被 reload() 调用）。
  let primed = false;
  const r = new Refreshable<GatewayConfig>({
    load: () => loadConfig(deps.env, deps.storage, deps.logger, { degradeOnUnreadable: !primed }),
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
  primed = true;
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
