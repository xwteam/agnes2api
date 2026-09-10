import { Refreshable } from "../core/refreshable.js";
import { loadConfig, type GatewayConfig } from "../core/config.js";
import type { Storage } from "../ports/storage.js";
import type { Logger } from "../ports/logger.js";

/**
 * 配置持有者。放入口层而不是 core：它要碰存储。
 *
 * `AppDeps.config` 从**值**改成它，是因为原来那份值在建 app 那一刻就被闭包捕获了，
 * 进程把它冻结到自己的生命周期结束。
 * 后果不只是「保存没生效」，而是**一个撤销不掉的凭据**：没设 GATEWAY_TOKEN 环境变量时，
 * 那时入口层那个「口令变了才重建 app」的缓存判断恒为 false，进程里的旧口令无限期继续有效。
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
 * ⚠️⚠️ **取 30 的原理由在 v0.4.0 没了，如实登记。** 原话是：「不取 10：miniflare 写死
 * `MIN_CACHE_TTL_SECONDS: 30`，小于它直接抛；把 holder 的 TTL 和 KV 边缘缓存对齐，
 * 可以避免『holder 比边缘缓存还快，于是快出来的那部分毫无意义』。」
 * **摘掉 Worker/KV 形态之后没有边缘缓存可对齐**，`FileStorage.get` 是直接 `readFile`。
 * **值没有跟着改**，理由换成今天成立的这一条：这个 TTL 决定的是**每个请求路径上
 * 那次配置读的摊薄倍数**——每次 `ensureFresh` 真读一次就是一遍整份 `store.json` 的
 * `readFile` + `JSON.parse`，30 秒把它摊薄到 2,880 次/天/副本；取更小是拿一次全量
 * 反序列化去换更快的生效，取更大则是让面板「保存」看起来更久不生效。
 *
 * **用户可见的总生效上界就是本 TTL 的 30 秒**，中间不再有任何一层缓存。
 * ⚠️ **上一版这里登记的是「本 TTL(30s) + KV 边缘缓存默认 60s ≈ 90 秒」，那笔欠账
 * 已经结清，别再照那句话读。** 当时的登记说：那 60 秒是 Cloudflare KV 边缘读的陈旧
 * 窗口、这一层随 Worker 形态一起没了，但那个数已经以一个常量 + 一个字段的形态进了
 * `GET /admin/api/overview` 的 `freshness` 块、`PUT /admin/api/config` 的
 * `propagation` 块、面板三个板块的文案与五语言文档，删它要跨后端 / 面板 / 五语言
 * 文档一起动，所以先登记着。**v0.4.0 里那一整层已经全部删干净**（常量、两个响应块
 * 里的那个字段、面板取值与五语言文案），两条「多久能看见」的上界因此退化成各自的
 * TTL。设计文档 §5.2 那条「面板文案必须写这个数，不许写『立即生效』」照旧成立。
 *
 * ⚠️ 别把它和 `POOL_CACHE_TTL_MS` 那条上界搞混：那条是「别的副本判的冷却/剔除
 * 多久能看到」，= `POOL_CACHE_TTL_MS` 本身（默认 60 秒），是另一个数，
 * 见 `keypool-repo.ts` 的 `KeyPoolRepoOptions.cacheTtlMs` 注释。
 * **面板要把两个数都显示出来**，只显示一个就是又一个「面板不撒谎」的破口。
 */
export const CONFIG_TTL_MS = 30_000;

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
  // 首次装载**失败必须抛**：缺 GATEWAY_TOKEN 拒绝服务是网关的三条不变量之一。
  await r.prime();
  primed = true;
  return {
    // prime 成功过，current() 一定有值。
    current: () => r.current() as GatewayConfig,
    ensureFresh: () => r.ensureFresh(),
    invalidate: () => r.invalidate(),
  };
}

/** 固定配置的 holder。测试夹具与面板的「干跑校验」用，生产路径不用。 */
export function fixedConfigHolder(config: GatewayConfig): ConfigHolder {
  return { current: () => config, ensureFresh: async () => {}, invalidate: () => {} };
}
