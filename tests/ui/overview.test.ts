import { describe, it, expect } from "vitest";
import {
  poolCounts, processCells, usageStats, configSummary, storageInfo,
  freshnessValues, poolKnobs, kvReadEstimatePerIsolatePerDay,
  POOL_CARDS, poolCardLabelKey, runtimeNameLabelKey, storageBackendLabelKey,
} from "../../admin-ui/js/pure/overview.mjs";
import { I18N } from "../../admin-ui/js/i18n-dict.js";

/** 一份"正常"的 /admin/api/overview 响应，各条用例在它上面改一处。 */
const body = {
  version: "0.1.0",
  serverTime: 5000,
  runtime: { name: "node" },
  process: { pid: 4242, rssBytes: 123456789, uptimeMs: 987654 },
  storage: { backend: "file", writable: true, checkedAt: 4000 },
  pool: { total: 5, fresh: 2, cooling: 1, evicted: 2, disabled: 0 },
  poolStats: { requests: 100, success: 90, failed: 8, clientErrors: 2, approximate: true },
  freshness: {
    poolCacheTtlMs: 60_000, poolVisibilityUpperBoundMs: 120_000,
    poolTouchIntervalMs: 21_600_000, configTtlMs: 30_000,
    configVisibilityUpperBoundMs: 90_000, kvEdgeCacheMs: 60_000,
  },
  config: {
    registrarEnabled: true, primary: "yyds", fallback: "moemail",
    targetKeys: 20, envLocked: ["maxStrikes"], degraded: false,
  },
};

/**
 * **产品不变式：绝不伪造 0。**（同 keys.mjs 的 cardCounts，评审 C1 在那一侧栽过一次，
 * 这里从第一天就照着写。）`pool` 块失败（`null`）时五张汇总卡必须显示 `—`。
 */
describe("poolCounts：没有数据就是没有数据", () => {
  it("pool 为 null / 缺失 / 畸形时五项全是 null，不是 0", () => {
    for (const empty of [null, undefined, {}, { pool: null }, { pool: "oops" }]) {
      expect(poolCounts(empty), String(empty))
        .toEqual({ total: null, fresh: null, cooling: null, evicted: null, disabled: null });
    }
  });
  it("有数据时逐项透传", () => {
    expect(poolCounts(body)).toEqual({ total: 5, fresh: 2, cooling: 1, evicted: 2, disabled: 0 });
  });
  it("某一项坏掉（非数字）只让那一项变 null，不整块丢弃", () => {
    const broken = { pool: { total: 5, fresh: "2", cooling: null, evicted: 2, disabled: 1 } };
    expect(poolCounts(broken)).toEqual({ total: 5, fresh: null, cooling: null, evicted: 2, disabled: 1 });
  });
  it("真实的 0 照样是 0——「没有数据」与「数出来是零」必须分得开", () => {
    expect(poolCounts({ pool: { total: 0, fresh: 0, cooling: 0, evicted: 0, disabled: 0 } }))
      .toEqual({ total: 0, fresh: 0, cooling: 0, evicted: 0, disabled: 0 });
  });
  /**
   * `poolHealth()` 的四格互斥且穷尽，所以概览上少显示一格就意味着
   * `总数 ≠ 可用 + 冷却中 + 已剔除`，而屏幕上没有任何东西解释那几把 key 去哪了。
   * **变红条件**：从 `POOL_CARDS` 里删掉 `"disabled"`（取数与渲染共用它这一份）。
   */
  it("后端给了 disabled 计数，概览就必须取得到它——否则五格之和对不上总数", () => {
    // 夹具里 2 + 1 + 1 + 2 === 6：取不到 disabled 这一格时，屏幕上那 2 把 key 凭空消失。
    expect(poolCounts({ pool: { total: 6, fresh: 2, cooling: 1, evicted: 1, disabled: 2 } }))
      .toEqual({ total: 6, fresh: 2, cooling: 1, evicted: 1, disabled: 2 });
  });
});

/**
 * **产品不变式 11**：Worker 形态下内存/CPU/PID 必须显示「Serverless · 无常驻进程」，
 * 不是 0、不是空、不隐藏格子。**判据是 `process === null`，不是 `runtime.name`**
 * ——设计文档 §13.3 第 6 条与硬约束 1 都点名要求。
 */
describe("processCells：判据是 process === null，不是 runtime.name", () => {
  it("process 为 null ⇒ serverless，不管 runtime.name 写的是什么", () => {
    expect(processCells({ ...body, runtime: { name: "worker" }, process: null }))
      .toEqual({ kind: "serverless" });
    // ⚠️ 关键格：runtime.name 明明是 "node"，但只要 process 是 null 照样判 serverless。
    // 只测上面那一格的话，「靠 runtime.name 判断」这种实现也能蒙混过关。
    expect(processCells({ ...body, runtime: { name: "node" }, process: null }))
      .toEqual({ kind: "serverless" });
  });
  it("process 是真实指标对象 ⇒ metrics，即使 runtime.name 写的是 worker（同一条判据反过来）", () => {
    const withMetrics = { ...body, runtime: { name: "worker" }, process: { pid: 1, rssBytes: 2, uptimeMs: 3 } };
    expect(processCells(withMetrics)).toEqual({ kind: "metrics", pid: 1, rssBytes: 2, uptimeMs: 3 });
  });
  it("process 这个字段整个不存在（既不是 null 也不是对象）⇒ unknown，不伪装成任何一种", () => {
    for (const bad of [undefined, "oops", 3, []]) {
      const r = processCells({ ...body, process: bad });
      expect(r.kind, String(bad)).toBe("unknown");
    }
  });
  it("process 是对象但字段坏掉：**逐字段**补 null，不整块判 unknown（与 stats.ts 的 normalizeStats 同一条哲学）", () => {
    expect(processCells({ ...body, process: {} })).toEqual({ kind: "metrics", pid: null, rssBytes: null, uptimeMs: null });
    expect(processCells({ ...body, process: { pid: "x", rssBytes: 5, uptimeMs: 6 } }))
      .toEqual({ kind: "metrics", pid: null, rssBytes: 5, uptimeMs: 6 });
  });
});

/**
 * **I1（评审必修，Task 4 I4 的原样复发）**：`≈` 必须由后端的 `approximate` 字段
 * 驱动，不许硬编码。第一版 `usageStats()` 丢掉了这个字段、注释却写着「由
 * approximate 驱动」——那句话当时是假的，`sec-overview.js` 把 `（≈）` 焊死在标题里。
 */
describe("usageStats：poolStats 为 null 时全部 null，不是 0；approx 由响应的 approximate 驱动", () => {
  it("poolStats 缺失/畸形时四项计数全是 null，approx 按保守方向给 true", () => {
    for (const empty of [null, undefined, {}]) {
      expect(usageStats({ ...body, poolStats: empty }), String(empty))
        .toEqual({ requests: null, success: null, failed: null, clientErrors: null, approx: true });
    }
  });
  it("有数据时逐项透传，approximate: true ⇒ approx: true", () => {
    expect(usageStats(body)).toEqual({ requests: 100, success: 90, failed: 8, clientErrors: 2, approx: true });
  });
  it("approximate: false ⇒ approx: false，不打 ≈（真正驱动的地方，不是形状断言）", () => {
    const b = { ...body, poolStats: { ...body.poolStats, approximate: false } };
    expect(usageStats(b).approx).toBe(false);
  });
  it("poolStats 存在但没带 approximate 字段时按近似处理——宁可多打一个 ≈", () => {
    const { approximate, ...rest } = body.poolStats;
    expect(usageStats({ ...body, poolStats: rest }).approx).toBe(true);
  });
});

describe("configSummary：block 整体缺失是单个 null 哨兵，不是逐字段 null", () => {
  /**
   * **这条钉住实施时抓到的一个真实 bug（评审前自查）**：如果 `config` 缺失时
   * 也逐字段返回 `{primary: null, fallback: null, ...}`，就会跟「config 块本来就
   * 存在、但注册机没启用所以 primary/fallback 合法地是 null」撞出同一个值——
   * 调用方没法区分「该显示 —」还是「该显示『无』」。整块用一个 `null` 哨兵表示，
   * 这种撞车就不可能发生：调用方必须先判 `configSummary(x) === null`。
   */
  it("config 整体缺失（null / undefined / 非对象）时返回 null 这一个哨兵，不是一个逐项 null 的对象", () => {
    for (const empty of [null, undefined, "oops", 3]) {
      expect(configSummary({ ...body, config: empty }), String(empty)).toBeNull();
    }
  });
  it("config 是个空对象（技术上是对象，只是字段都没有）时走逐字段降级，不是整块 null——与 poolCounts 同一条哲学", () => {
    expect(configSummary({ ...body, config: {} })).toEqual({
      registrarEnabled: null, primary: null, fallback: null,
      targetKeys: null, envLocked: [], degraded: null,
    });
  });
  it("有数据时逐项透传", () => {
    expect(configSummary(body)).toEqual({
      registrarEnabled: true, primary: "yyds", fallback: "moemail",
      targetKeys: 20, envLocked: ["maxStrikes"], degraded: false,
    });
  });
  it("config 块存在、但 primary/fallback 合法为 null（注册机未启用）时，与「整块缺失」是两种不同的返回形状", () => {
    const r = configSummary({ ...body, config: { ...body.config, registrarEnabled: false, primary: null, fallback: null } });
    expect(r).not.toBeNull();
    expect(r!.primary).toBeNull();
    expect(r!.fallback).toBeNull();
    // 而 targetKeys / envLocked / degraded 这些跟 primary 无关的字段照样是原始值，
    // 不会被「primary 是 null」连累成整块 null——这正是哨兵设计要保住的那条区分。
    expect(r!.targetKeys).toBe(20);
  });
  it("envLocked 不是数组时按空数组处理，不是 null（悬停列表要能安全 .map）", () => {
    expect(configSummary({ ...body, config: { ...body.config, envLocked: "oops" } })!.envLocked).toEqual([]);
  });
  it("envLocked 里混进非字符串元素时只保留字符串", () => {
    expect(configSummary({ ...body, config: { ...body.config, envLocked: ["maxStrikes", 3, null] } })!.envLocked)
      .toEqual(["maxStrikes"]);
  });
});

describe("storageInfo", () => {
  it("storage 缺失/畸形时三项都是 null", () => {
    for (const empty of [null, undefined, {}]) {
      expect(storageInfo({ ...body, storage: empty })).toEqual({ backend: null, writable: null, checkedAt: null });
    }
  });
  it("backend 只认 file/kv 两种取值，别的一律 null", () => {
    expect(storageInfo({ ...body, storage: { ...body.storage, backend: "s3" } }).backend).toBeNull();
    expect(storageInfo(body).backend).toBe("file");
  });
  it("有数据时逐项透传", () => {
    expect(storageInfo(body)).toEqual({ backend: "file", writable: true, checkedAt: 4000 });
  });
});

describe("freshnessValues", () => {
  it("freshness 缺失/畸形时六项都是 null", () => {
    for (const empty of [null, undefined, {}]) {
      expect(freshnessValues({ ...body, freshness: empty })).toEqual({
        poolCacheTtlMs: null, poolVisibilityUpperBoundMs: null, poolTouchIntervalMs: null,
        configTtlMs: null, configVisibilityUpperBoundMs: null, kvEdgeCacheMs: null,
      });
    }
  });
  it("有数据时逐项透传", () => {
    expect(freshnessValues(body)).toEqual(body.freshness);
  });
});

/**
 * **carry-forward（Task 4 → Task 5）**：Key 池板块的 `{ttl}` / `{touch}` 占位符
 * 在 Task 4 交付时没有数据源，暂用「点名旋钮 + 括注默认值」。这个函数是它们现在
 * 唯一的数据源——两个板块共用同一份取值，不许各写各的。
 */
describe("poolKnobs：Key 池板块与概览板块共用的两个旋钮当前值", () => {
  it("正常响应：从 freshness 里取出 ttl 与 touch", () => {
    expect(poolKnobs(body)).toEqual({ ttl: 60_000, touch: 21_600_000 });
  });
  it("freshness 缺失时两者都是 null（渲染成 —，不是旧的硬编码默认值）", () => {
    expect(poolKnobs({ ...body, freshness: null })).toEqual({ ttl: null, touch: null });
  });
});

describe("kvReadEstimatePerIsolatePerDay", () => {
  /**
   * 公式与 `src/core/keypool-repo.ts` 的 `KeyPoolRepoOptions.cacheTtlMs` 文档同源，
   * 用该文档**已经写死的独立示例**核对（60 秒快照、20 把 key、30 秒配置 TTL
   * ⇒ 1440 × 21 + 2880 = 33,120 次/天/isolate）：期望值抄自那份文档，不是从本函数
   * 自己反推——避免同义反复（本项目已发现的第 6 种假阳性）。
   */
  it("与 keypool-repo.ts 文档给出的独立示例一致：1440×21+2880=33,120", () => {
    const b = {
      freshness: { poolCacheTtlMs: 60_000, configTtlMs: 30_000 },
      pool: { total: 20 },
    };
    expect(kvReadEstimatePerIsolatePerDay(b)).toBe(33_120);
  });
  it("poolCacheTtlMs <= 0（关闭快照缓存）时给不出这个估算，返回 null 而不是 Infinity/伪造值", () => {
    expect(kvReadEstimatePerIsolatePerDay({
      freshness: { poolCacheTtlMs: 0, configTtlMs: 30_000 }, pool: { total: 5 },
    })).toBeNull();
  });
  it("pool 块本身降级（total 缺失）时也给不出估算", () => {
    expect(kvReadEstimatePerIsolatePerDay({
      freshness: { poolCacheTtlMs: 60_000, configTtlMs: 30_000 }, pool: null,
    })).toBeNull();
  });
});

describe("分档与形态标签的映射（同 keys.mjs 的 bucketLabelKey 那一套）", () => {
  it("五张池子卡的 i18n key 逐档手写，且每一个都真的在字典里", () => {
    expect(POOL_CARDS.map(poolCardLabelKey)).toEqual([
      "ov.pool.total", "ov.pool.fresh", "ov.pool.cooling", "ov.pool.evicted", "ov.pool.disabled",
    ]);
    for (const k of POOL_CARDS.map(poolCardLabelKey)) expect(I18N, k).toHaveProperty(k);
  });
  it("runtimeNameLabelKey：只有 worker 才是 worker 文案，别的（含未知值）一律 node", () => {
    expect(runtimeNameLabelKey("worker")).toBe("ov.runtime.worker");
    expect(runtimeNameLabelKey("node")).toBe("ov.runtime.node");
    expect(runtimeNameLabelKey(undefined)).toBe("ov.runtime.node");
    expect(I18N).toHaveProperty("ov.runtime.worker");
    expect(I18N).toHaveProperty("ov.runtime.node");
  });
  it("storageBackendLabelKey：只有 kv 才是 kv 文案，别的一律 file", () => {
    expect(storageBackendLabelKey("kv")).toBe("ov.storage.kv");
    expect(storageBackendLabelKey("file")).toBe("ov.storage.file");
    expect(storageBackendLabelKey(null)).toBe("ov.storage.file");
    expect(I18N).toHaveProperty("ov.storage.kv");
    expect(I18N).toHaveProperty("ov.storage.file");
  });
});
