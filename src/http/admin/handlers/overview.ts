import type { Context } from "hono";
import type { KeyPoolRepo } from "../../../core/keypool-repo.js";
import type { ConfigHolder } from "../../config-holder.js";
import type { StorageHealth } from "../../../core/storage-health.js";
import type { RuntimeInfo } from "../../../ports/runtime.js";
import { poolHealth } from "../../../core/keypool.js";
import { sumStats } from "../../../core/admin/stats.js";
import { CONFIG_TTL_MS } from "../../config-holder.js";

/**
 * KV 边缘缓存的默认 `cacheTtl`（秒 → 毫秒）。
 * **已核实**：Cloudflare KV 的 `cacheTtl` 最小 30、默认 60（设计文档 §17 U3，2026-08-19）。
 * 面板上的两条「多久能看见」上界都要把它算进去——设计 §5.2 在 config 那条上算了，
 * 池快照那条原来漏了（K4），Task 2 已把五语言文档改准，这里的数字必须与文档一致。
 */
const KV_EDGE_CACHE_MS = 60_000;

/**
 * 逐块取数，**某块失败就该块返回 `null`**（设计文档 §10.1 的失败降级纪律）。
 * 前端见 `null` 渲染 `—`。**绝不伪造 0**——那是产品不变式，不是风格偏好。
 */
async function block<T>(fn: () => Promise<T> | T): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

export function overviewHandler(deps: {
  repo: KeyPoolRepo;
  configHolder: ConfigHolder;
  storageHealth: StorageHealth;
  runtime: RuntimeInfo;
  envLocked: readonly string[];
  version: string;
  now: () => number;
}) {
  return async (c: Context) => {
    const at = deps.now();

    const records = await block(() => deps.repo.all());
    const cfg = await block(() => deps.configHolder.current());

    const poolTtl = cfg?.poolCacheTtlMs ?? null;
    const touch = cfg?.poolTouchIntervalMs ?? null;

    return c.json({
      version: deps.version,
      serverTime: at,
      runtime: { name: deps.runtime.name },
      /** **Worker 恒 null**，前端见 null 渲染「Serverless · 无常驻进程」。 */
      process: deps.runtime.process(),
      storage: {
        backend: deps.runtime.storageBackend,
        writable: deps.storageHealth.status().writable,
        checkedAt: deps.storageHealth.status().checkedAt,
      },
      pool: records === null ? null : poolHealth(records, at),
      /** Tier-1 池级聚合。**近似值**，前端必须打 ≈。 */
      poolStats: records === null ? null : { ...sumStats(records.map((r) => r.stats)), approximate: true },
      /**
       * 两个 TTL **都要给**（progress.md:232 登记的那条）：只显示一个就是又一个
       * 「面板不撒谎」的破口。两个上界都把 KV 边缘缓存算进去——池快照那条原来漏了。
       */
      freshness: {
        poolCacheTtlMs: poolTtl,
        poolVisibilityUpperBoundMs: poolTtl === null ? null : poolTtl + KV_EDGE_CACHE_MS,
        poolTouchIntervalMs: touch,
        configTtlMs: CONFIG_TTL_MS,
        configVisibilityUpperBoundMs: CONFIG_TTL_MS + KV_EDGE_CACHE_MS,
        kvEdgeCacheMs: KV_EDGE_CACHE_MS,
      },
      config: cfg === null ? null : {
        registrarEnabled: cfg.registrar.enabled,
        primary: cfg.registrar.primary ?? null,
        fallback: cfg.registrar.fallback ?? null,
        targetKeys: cfg.registrar.targetKeys,
        envLocked: [...deps.envLocked],
        /** 本次装载有没有降级（存储读不出来 / 字段回落默认值）。红色横幅的依据。 */
        degraded: cfg.degraded,
      },
    });
  };
}

/**
 * ⚠️ `tend`（最近一次补池 / 下次预计时间）本期不做：`tend:history` 这个键**现在
 * 根本不存在**（设计文档 §12 L5 把它排在 P3c）。渲染一个永远空着的区块正是
 * 设计文档 §10.6 点名禁止的形态（「而不是给一张永远空着的表」）。登记 P3c，
 * 与注册机板块一起做。
 *
 * ⚠️ 「今日用量」本期改成「累计用量」（F9）：Tier-1 的 `KeyRecord.stats` 是自这把
 * key 加入以来的累计值，没有任何时间维度；按天切分需要 Tier-2 时间序列（P3d）。
 * 把累计值标成「今日」是撒谎，面板标题写「累计（≈）」。
 */
