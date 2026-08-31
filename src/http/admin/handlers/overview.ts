import type { Context } from "hono";
import type { KeyPoolRepo } from "../../../core/keypool-repo.js";
import type { ConfigHolder } from "../../config-holder.js";
import type { StorageHealth } from "../../../core/storage-health.js";
import type { RuntimeInfo } from "../../../ports/runtime.js";
import { poolHealth } from "../../../core/keypool.js";
import { sumStats } from "../../../core/admin/stats.js";
// **两个数都从 `config-holder.ts` 取，这里一个字面量都没有。**
// `KV_EDGE_CACHE_MS` 原本是本文件的模块私有常量，设置页那一轮把它移了过去：
// `PUT /admin/api/config` 的 `propagation` 块要报同一个上界，而那个数字在五语言
// DEPLOY.md 里是对用户的承诺——抄成两份就等于允许概览页与保存回执各说一个数。
// 面板上的两条「多久能看见」上界都要把它算进去：设计 §5.2 在 config 那条上算了，
// 池快照那条原来漏了，五语言文档已经改准。
import { CONFIG_TTL_MS, KV_EDGE_CACHE_MS } from "../../config-holder.js";

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
    /**
     * **刻意不包 `block()`。** `ConfigHolder.current()` 的接口契约（见
     * `src/http/config-holder.ts`）逐字写着「同步读，**永不抛**」——它只读内存里
     * 最近一次成功装载的快照，从不直接碰存储；装载失败的处理发生在 `ConfigHolder`
     * 内部（`Refreshable.reload()` 保留上一份合法快照并只打一条 error 日志），
     * 不会冒泡到这里。包一层 `block()` 会让 `config` 看起来像是在跟 `pool`/
     * `poolStats` 一样参与逐块降级、有个「读失败 ⇒ null」的分支，而那个分支
     * 实际上**永远走不到**——评审用 `BrokenStorage`（每个方法都真抛）实测过，
     * `body.config` 仍是一个完整对象，不是 `null`。
     */
    const cfg = deps.configHolder.current();

    /** 存储可写性只读一次，`writable` 与 `checkedAt` 保证来自同一份快照。 */
    const storageStatus = deps.storageHealth.status();
    /**
     * **`process()` 包 `block()`**：`nodeRuntime().process()` 内部调用
     * `process.memoryUsage()`，理论上可抛（V8 罕见故障）；不包的话一次这样的抖动
     * 会让整个 `overview` 请求 500，与「逐块降级」的立意矛盾。类型上与「Worker
     * 恒 null」天然复用同一个 `ProcessMetrics | null`——block() 失败与「本来就是
     * serverless」在前端渲染成同一句「Serverless · 无常驻进程」，这个简化是可接受的：
     * 两者对用户来说都是「这里没有可看的进程指标」。
     */
    const processMetrics = await block(() => deps.runtime.process());

    const poolTtl = cfg.poolCacheTtlMs;
    const touch = cfg.poolTouchIntervalMs;

    return c.json({
      version: deps.version,
      serverTime: at,
      runtime: { name: deps.runtime.name },
      process: processMetrics,
      storage: {
        backend: deps.runtime.storageBackend,
        writable: storageStatus.writable,
        checkedAt: storageStatus.checkedAt,
      },
      pool: records === null ? null : poolHealth(records, at),
      /**
       * Tier-1 池级聚合。**近似值**，前端必须打 ≈（`poolStats.approximate` 驱动，
       * 见 `pure/overview.mjs` 的 `usageStats()`）。**只挑用得上的四个计数字段**，
       * 不整段 `...sumStats(...)` 展开——`sumStats()` 还带着 `lastErrorAt`/
       * `lastErrorKind`，概览面板不消费这两个字段（错误面正经的归宿是
       * 事件板块，那里有完整上下文），挂两个没人看的字段在响应里只会造成
       * 「这大概有用吧」的误会，且没有消费者的响应字段迟早会漂（评审发现）。
       */
      poolStats: records === null ? null : (() => {
        const s = sumStats(records.map((r) => r.stats));
        return {
          requests: s.requests, success: s.success, failed: s.failed, clientErrors: s.clientErrors,
          approximate: true,
        };
      })(),
      /**
       * 两个 TTL **都要给**（progress.md:232 登记的那条）：只显示一个就是又一个
       * 「面板不撒谎」的破口。两个上界都把 KV 边缘缓存算进去——池快照那条原来漏了。
       * `cfg` 恒有值，这两个数因此恒是数字，不再是 `number | null`。
       */
      freshness: {
        poolCacheTtlMs: poolTtl,
        poolVisibilityUpperBoundMs: poolTtl + KV_EDGE_CACHE_MS,
        poolTouchIntervalMs: touch,
        configTtlMs: CONFIG_TTL_MS,
        configVisibilityUpperBoundMs: CONFIG_TTL_MS + KV_EDGE_CACHE_MS,
        kvEdgeCacheMs: KV_EDGE_CACHE_MS,
      },
      config: {
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
 * 根本不存在**（设计文档 §12 L5 把它排在注册机板块那一轮）。渲染一个永远空着的区块正是
 * 设计文档 §10.6 点名禁止的形态（「而不是给一张永远空着的表」）。另行登记，
 * 与注册机板块一起做。
 *
 * ⚠️ 「今日用量」本期改成「累计用量」（F9）：Tier-1 的 `KeyRecord.stats` 是自这把
 * key 加入以来的累计值，没有任何时间维度；按天切分需要 Tier-2 时间序列。
 * 把累计值标成「今日」是撒谎，面板标题写「累计」，`≈` 由 `poolStats.approximate`
 * 逐格驱动渲染（不是焊死在标题文案里，见 pure/overview.mjs 的 usageStats()）。
 */
