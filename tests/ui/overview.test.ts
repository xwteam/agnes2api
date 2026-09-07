import { describe, it, expect, vi, afterEach } from "vitest";
import {
  poolCounts, processCells, usageStats, usageTipKey, configSummary, storageInfo,
  freshnessValues, poolKnobs, kvReadEstimatePerIsolatePerDay, offsetMs,
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
 * **产品不变式：绝不伪造 0。**（同 keys.mjs 的 cardCounts，评审在那一侧栽过一次，
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
 * **评审必修（同一条发现的原样复发）**：`≈` 必须由后端的 `approximate` 字段
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

describe("usageTipKey：那句尾巴不许对着一个已经开着统计的部署说「要等启用之后才有」", () => {
  /**
   * ⚠️⚠️ **它挡的是一句会把人支开的话。**
   *
   * 累计用量卡底下那一句上一版是**无条件**渲染的
   *（`sec-overview.js` 的 `body.appendChild(elI18n("p", "ov.usage.tip", …))`）：
   *「……按天/按小时的分解要等启用时间序列统计之后才有。」
   * 对一个**已经打开** `USAGE_STATS_ENABLED` 的部署，这句话把他从「用量」板块支开
   * ——而那个板块此刻正挂着「还有 N 条计数没有落盘」的横幅，是他该去的地方。
   *
   * **变红条件**（两条都真跑过，跑的是那四份共 131 格）：
   * 把 `usageTipKey` 改成恒返回 `"ov.usage.tipTier2Off"` ⇒ 红 4（这一格 +
   * 下面「拉不到 capabilities / 字段缺席 / 字段不是布尔 ⇒ 用那句无论开没开都成立的话」+
   * `tests/ui/dom/overview-cards.test.ts` 的
   * 「统计开着时那句尾巴指向「用量」板块，不再说「要等启用之后才有」」与
   * 「capabilities 读不出来时不许默认当成「关着」」两格）；
   * 改成恒返回 `"ov.usage.tip"` ⇒ 红 2（下面「确知关着的时候才多说一句「怎么开」」+
   * `tests/ui/dom/overview-cards.test.ts` 的
   * 「确知统计关着时，那句尾巴仍然说清「要先开」以及开法在哪」）。
   */
  it("统计开着的时候不用那句「要等启用之后才有」", () => {
    expect(
      usageTipKey({ stats: { tier2Enabled: true, flushIntervalMs: 60_000 } }),
      "开着的部署被那句话支开了",
    ).toBe("ov.usage.tip");
  });

  it("确知关着的时候才多说一句「怎么开」", () => {
    expect(usageTipKey({ stats: { tier2Enabled: false } })).toBe("ov.usage.tipTier2Off");
  });

  /**
   * ⚠️⚠️ **判据是白名单（`=== false` 才算关着），不是 `!== true`。**
   *
   * `/capabilities` 拉失败时 `caps` 是 `null`、字段缺席时是 `undefined`
   * ——那两种都是**我们不知道开没开**。黑名单会把它们一起说成「关着」，
   * 也就是在最查不出来的那一档上把上一版那句误导原样留下。
   * ⭐ 与 `pure/usage.mjs` 的 `readSucceeded` 是同一条形状。
   *
   * **变红条件**（**复评实测订正**，上一版这三句连着写错了）：把
   * `c.tier2Enabled === false` 改成 `!(c.tier2Enabled === true)` ⇒ 跑那四份共 131 格，
   * **只红这一格**（`Tests 1 failed | 130 passed`），而且是在下面循环的**第 5 条**
   * `caps={stats:{}}` 上红，**不是第一条 `caps=null`**：`usageTipKey` 先把
   * `caps.stats` 取进 `c`、再接 `c && typeof c === "object" && …`，于是前四条
   *（`null` / `undefined` / `{}` / `{stats:null}`）的 `c` 都是假值，整条 `&&`
   * 在走到 `=== false` 之前就短路了 —— **白名单与黑名单在那四档上根本不可观测**。
   *
   * ⚠️⚠️ **所以循环里后三条不是重复的**（`{stats:{}}` / `{stats:{tier2Enabled:"false"}}` /
   * `{stats:{tier2Enabled:0}}`）：它们是全仓唯一能观测到这个方向的输入。实测把这三条
   * 删掉、同一条变异跑全量 `pnpm test` ⇒ **一格行为判据都不红**，只剩
   * `tests/unit/ui-assets.test.ts`「源目录里每个文件都在生成物里，且内容一字不差」与
   *「重新生成一遍，与仓库里那份逐字节相同」两格在响 —— 那两格钉的是
   * 「改了 `admin-ui/` 却没跑 `pnpm ui:build`」，与这条行为无关。
   *
   * ⚠️ `tests/ui/dom/overview-cards.test.ts` 的「capabilities 读不出来时不许默认当成「关着」」
   * 那一格在这条变异下**照绿**（它喂进去的正是 `caps=null` 那一档，短路了），
   * 上一版把它算作连坐的第 2 格是假的。那一格真正钉的东西写在它自己的注释里。
   */
  it("拉不到 capabilities / 字段缺席 / 字段不是布尔 ⇒ 用那句无论开没开都成立的话", () => {
    for (const caps of [null, undefined, {}, { stats: null }, { stats: {} },
      { stats: { tier2Enabled: "false" } }, { stats: { tier2Enabled: 0 } }]) {
      expect(usageTipKey(caps), `caps=${JSON.stringify(caps)} 被当成了「确知关着」`)
        .toBe("ov.usage.tip");
    }
  });

  /**
   * **两个 key 都得在字典里、五种语言齐全，而且那句默认的话里不许再出现「要等启用」。**
   *
   * ⚠️ 默认那一版是 `caps` 读不到时也要用的那一句 ⇒ 它必须**无论开没开都成立**。
   *
   * **变红条件**（真跑过）：把 `ov.usage.tip` 的中文改回原文 ⇒ 红 2（这一格并点名
   * `zh-CN` + `tests/ui/dom/overview-cards.test.ts` 的
   * 「统计开着时那句尾巴指向「用量」板块，不再说「要等启用之后才有」」那一格）；
   * 反向控制那一段保证禁词表不是死的（`ov.usage.tipTier2Off` 逐语言必须命中）。
   */
  it("默认那句话里，五种语言都不许说「要等启用时间序列统计之后才有」", () => {
    const BANNED: Record<string, string[]> = {
      "zh-CN": ["要等启用", "之后才有"],
      "zh-TW": ["要等啟用", "之後才有"],
      en: ["once time-series stats are enabled", "only appears once"],
      ja: ["有効になってから", "有効化してから"],
      ko: ["활성화된 후에만", "켠 뒤에야"],
    };
    const dict = I18N as Record<string, Record<string, string>>;
    const tip = dict["ov.usage.tip"];
    const off = dict["ov.usage.tipTier2Off"];
    expect(tip, "`ov.usage.tip` 没了 —— 这一格会空转").toBeTruthy();
    expect(off, "`ov.usage.tipTier2Off` 没了 —— 反向控制会空转").toBeTruthy();
    const hits: string[] = [];
    for (const [lang, words] of Object.entries(BANNED)) {
      const text = tip![lang] ?? "";
      expect(text.length, `${lang} 那一格是空的`).toBeGreaterThan(0);
      for (const w of words) if (text.includes(w)) hits.push(`${lang}：「${w}」`);
      // 反向控制：同一张表喂给「确知关着」那一版，每种语言都必须命中，
      // 否则「默认那句不含禁词」证明不了任何事。
      expect(
        words.some((w) => (off![lang] ?? "").includes(w)),
        `${lang} 的禁词一条都对不上 ov.usage.tipTier2Off —— 这一格在空转`,
      ).toBe(true);
    }
    expect(hits, `默认那句话又在说「要等启用之后才有」了：\n${hits.join("\n")}`).toEqual([]);
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
 * **carry-forward（跨三轮接力）**：Key 池板块的 `{ttl}` /
 * `{touch}` 占位符在最初交付时没有数据源，暂用「点名旋钮 + 括注默认值」。
 * 这个函数是它们现在唯一的数据源——两个板块共用同一份取值，不许各写各的。
 *
 * ⚠️ **`edge` 是后来加的第三个旋钮**（待办第 4 条的收尾）：
 * `keys.freshness` 那句文案曾经把「约 60 秒」的 KV 边缘缓存耗时硬编码进
 * 五语言字典，现在与 `ov.freshness.pool` 一样由 `kvEdgeCacheMs` 驱动。
 */
describe("poolKnobs：Key 池板块与概览板块共用的三个旋钮当前值", () => {
  it("正常响应：从 freshness 里取出 ttl / touch / edge", () => {
    expect(poolKnobs(body)).toEqual({ ttl: 60_000, touch: 21_600_000, edge: 60_000 });
  });
  it("freshness 缺失时三者都是 null（渲染成 —，不是旧的硬编码默认值）", () => {
    expect(poolKnobs({ ...body, freshness: null })).toEqual({ ttl: null, touch: null, edge: null });
  });
});

/**
 * **offsetMs：待办第 8 条**——概览 / Key 池 / 事件三个板块曾经各自手抄同一行
 * `-new Date().getTimezoneOffset() * 60000`，现在只有这一份。
 */
describe("offsetMs：三个板块共用的本地时区偏移", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("UTC+8（getTimezoneOffset 返回 -480）时给出 28,800,000 毫秒", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-480);
    expect(offsetMs()).toBe(28_800_000);
  });
  it("UTC-5（getTimezoneOffset 返回 300）时给出 -18,000,000 毫秒", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(300);
    expect(offsetMs()).toBe(-18_000_000);
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
