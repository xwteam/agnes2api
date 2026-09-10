/**
 * 概览板块的**全部取值决策**。板块文件（`js/sec-overview.js`）只剩 DOM 拼装、
 * 网络调用与 i18n 查表。理由与 `pure/keys.mjs` 同一条（admin-ui/README.md 硬规则 1）：
 * 早先那版 `cardCounts()` 就是把这类判断留在板块文件里而漏掉「绝不伪造 0」的地方，
 * 这里从第一天就把它们搬过来，好让 `tests/ui/overview.test.ts` 跑得到。
 *
 * 这个目录下的文件受三条硬规则约束（禁 import、禁浏览器全局、纯文本校验），
 * 规则全文见 admin-ui/README.md。
 */

/**
 * 5 张池子卡。顺序即渲染顺序。
 *
 * ⚠️ **第五格（已停用）是后来补上的，它不是可选的装饰**：`poolHealth()` 的四格
 * 互斥且穷尽，少显示一格就意味着 `总数 ≠ 可用 + 冷却中 + 已剔除`，而屏幕上没有任何
 * 东西解释那几把 key 去哪了。设计 §10.1 写的是「+ 有 disabled 时第五格」，
 * 这里**恒显示**：一个真实的 `0` 本来就是真话（读不出来时 `fmtCount(null)` 给 `—`，
 * 「绝不伪造 0」那条仍然由 `poolCounts` 守着），而按条件显隐要多一份判据、
 * 多一条只有它自己会走的渲染分支。
 */
export const POOL_CARDS = ["total", "fresh", "cooling", "evicted", "disabled"];

/** 池子卡的 i18n key。**五条各写一次字面量**，好让 i18n 门禁扫得到（同 keys.mjs 的 bucketLabelKey）。 */
export function poolCardLabelKey(card) {
  if (card === "fresh") return "ov.pool.fresh";
  if (card === "cooling") return "ov.pool.cooling";
  if (card === "evicted") return "ov.pool.evicted";
  if (card === "disabled") return "ov.pool.disabled";
  return "ov.pool.total";
}

/** 运行时名字 → i18n key。判据只看响应里 `runtime.name` 这一个字符串字段。 */
export function runtimeNameLabelKey(name) {
  return name === "worker" ? "ov.runtime.worker" : "ov.runtime.node";
}

/** 存储后端 → i18n key。 */
export function storageBackendLabelKey(backend) {
  return backend === "kv" ? "ov.storage.kv" : "ov.storage.file";
}

/**
 * 5 张池子卡的取数。**没有数据（`pool` 为 null）时逐项返回 `null`，绝不返回 0。**
 * 判据只看 `body.pool` 存不存在、形状对不对，不看别的块——`overview` 是逐块降级的，
 * 池子块坏了不该连累别的卡。
 *
 * 取数用的是 `POOL_CARDS` 本身，**不再另写一份键名清单**：两份清单曾经并排放着，
 * 加第五格时只改一份就会得到一张永远是 `—` 的卡。
 */
export function poolCounts(body) {
  const p = body && typeof body === "object" ? body.pool : null;
  const out = {};
  for (const k of POOL_CARDS) {
    const v = p && typeof p === "object" ? p[k] : null;
    out[k] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return out;
}

/**
 * 运行时信息面板里「内存 / 进程存活 / PID」三格该怎么渲染。
 *
 * **判据是 `body.process === null`，不是 `runtime.name === "worker"`**——设计文档
 * §13.3 第 6 条与硬约束 1 都点名要求形态分支只读接口返回的实际数据，不许自己嗅探
 * 运行时名字。返回 `{ kind: "serverless" }` 时面板显示「Serverless · 无常驻进程」，
 * **不是 0、不是空、不隐藏格子**；返回 `{ kind: "metrics", ... }` 时才显示真实数字。
 */
export function processCells(body) {
  const p = body && typeof body === "object" ? body.process : undefined;
  if (p === null) return { kind: "serverless" };
  if (!p || typeof p !== "object" || Array.isArray(p)) return { kind: "unknown" };
  const pid = typeof p.pid === "number" ? p.pid : null;
  const rssBytes = typeof p.rssBytes === "number" ? p.rssBytes : null;
  const uptimeMs = typeof p.uptimeMs === "number" ? p.uptimeMs : null;
  return { kind: "metrics", pid, rssBytes, uptimeMs };
}

/**
 * 累计用量卡的五个数。**`poolStats` 为 null 时全部 null**（绝不伪造 0），
 * 成功率交给调用方用 `fmtPercent` 现算——这里只投影原始计数，不重复实现百分比逻辑。
 *
 * **`approx` 由响应的 `approximate` 字段驱动**（产品不变式 10：近似值必须带 `≈`）。
 * 这是同一条评审裁定的原样复发——那一次的裁定是「一个没有消费者的响应字段迟早会
 * 漂」，第一版的 `usageStats()` 就是又一次没有消费者的字段：写了「由 approximate
 * 驱动」的注释，却没有真的读它，`sec-overview.js` 把 `（≈）` 硬编码进了标题。
 * 响应里没带这个字段（block 缺失）时按**近似**处理——保守方向是宁可多打一个 ≈，
 * 不是悄悄宣称精确，与 `pure/keys.mjs` 的 `usageParts()` 同一条哲学。
 */
export function usageStats(body) {
  const s = body && typeof body === "object" ? body.poolStats : null;
  const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  if (!s || typeof s !== "object") {
    return { requests: null, success: null, failed: null, clientErrors: null, approx: true };
  }
  return {
    requests: numOrNull(s.requests), success: numOrNull(s.success),
    failed: numOrNull(s.failed), clientErrors: numOrNull(s.clientErrors),
    approx: s.approximate !== false,
  };
}

/**
 * 累计用量卡底下那句话该用哪个 key。**入参是 `/capabilities` 的响应，不是 `/overview`。**
 *
 * ⚠️⚠️ **它存在的理由是一句会被合理误读的话**（终检点名的第二处）：那一句上一版
 * 是**无条件**渲染的「按天/按小时的分解要等启用时间序列统计之后才有」——
 * 对一个**已经打开** `USAGE_STATS_ENABLED` 的部署，它把人从「用量」板块支开，
 * 而那个板块此刻正是他该去看横幅的地方。
 *
 * ⚠️⚠️ **默认是那句「无论开没开都成立」的话，只有确知关着时才多说一句怎么开**：
 * 判据是**白名单**（`tier2Enabled === false` 才算「确知关着」），不是
 * `!== true`。`/capabilities` 拉失败时 `caps` 是 `null`、字段缺席时是 `undefined`
 * ——那两种都是**我们不知道开没开**，而黑名单会把它们一起说成「关着」，
 * 也就是在最查不出来的那一档上把上一版那句误导原样留下。
 * ⭐ 与 `pure/usage.mjs` 的 `readSucceeded` 是同一条形状：
 * 「排除已知的坏情况」与「只放行已知的好情况」在今天的取值上等价，明天不等价。
 *
 * ⚠️ **这里没有为它新增任何后端字段**：`stats.tier2Enabled` 是
 * `src/http/admin/handlers/capabilities.ts` 早就在发的，概览板块也早就把
 * `/capabilities` 拉进 `caps` 了（`sec-overview.js` 的 `loadCapabilities()`）。
 */
export function usageTipKey(caps) {
  const c = caps && typeof caps === "object" ? caps.stats : null;
  const off = c && typeof c === "object" && c.tier2Enabled === false;
  return off ? "ov.usage.tipTier2Off" : "ov.usage.tip";
}

/**
 * 配置摘要卡。**`config` 整块缺失（存储读失败）时返回 `null` 这一个哨兵**，
 * 不是逐字段各自 null——`channel` 在 `config` 块**存在**时本来就可能是
 * 合法的 `null`（注册机未启用，两条通道平级、没有默认值），把「整块读不出来」
 * 与「读出来了、确实没配」用同一个 `null` 表示，调用方就分不清该显示 `—`
 * 还是显示「无」——这正是本任务实现时抓到的一个真实 bug（评审前自查）。
 */
export function configSummary(body) {
  const c = body && typeof body === "object" ? body.config : null;
  if (!c || typeof c !== "object") return null;
  const envLocked = Array.isArray(c.envLocked) ? c.envLocked.filter((x) => typeof x === "string") : [];
  return {
    registrarEnabled: typeof c.registrarEnabled === "boolean" ? c.registrarEnabled : null,
    /**
     * **开着、但这份配置本次没装起来。** 不取这一格的话，概览卡片会照旧写
     * 「注册机：已启用」——而补池一轮都没跑，池子在慢慢耗干。
     * 读不到记 `null`（不是 `false`），与本文件其余各格同一条纪律。
     */
    registrarBlocked: typeof c.registrarBlocked === "boolean" ? c.registrarBlocked : null,
    channel: typeof c.channel === "string" ? c.channel : null,
    targetKeys: typeof c.targetKeys === "number" ? c.targetKeys : null,
    envLocked,
    degraded: typeof c.degraded === "boolean" ? c.degraded : null,
  };
}

/**
 * 存储卡。`overview.storage` 不经过逐块降级（它是内存态的 getter，读不出「失败」这回事），
 * 但响应仍可能畸形（接口读失败时整段 body 都拿不到），故一样做防御式取值。
 */
export function storageInfo(body) {
  const s = body && typeof body === "object" ? body.storage : null;
  if (!s || typeof s !== "object") return { backend: null, writable: null, checkedAt: null };
  return {
    backend: s.backend === "file" || s.backend === "kv" ? s.backend : null,
    writable: typeof s.writable === "boolean" ? s.writable : null,
    checkedAt: typeof s.checkedAt === "number" ? s.checkedAt : null,
  };
}

/**
 * 新鲜度卡的五个数，原样投影（`overview.freshness` 本身不参与逐块降级，
 * 除非整段响应都拿不到）。
 */
export function freshnessValues(body) {
  const f = body && typeof body === "object" ? body.freshness : null;
  const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  if (!f || typeof f !== "object") {
    return {
      poolCacheTtlMs: null, poolVisibilityUpperBoundMs: null, poolTouchIntervalMs: null,
      configTtlMs: null, configVisibilityUpperBoundMs: null,
    };
  }
  return {
    poolCacheTtlMs: numOrNull(f.poolCacheTtlMs),
    poolVisibilityUpperBoundMs: numOrNull(f.poolVisibilityUpperBoundMs),
    poolTouchIntervalMs: numOrNull(f.poolTouchIntervalMs),
    configTtlMs: numOrNull(f.configTtlMs),
    configVisibilityUpperBoundMs: numOrNull(f.configVisibilityUpperBoundMs),
  };
}

/**
 * `POOL_CACHE_TTL_MS` / `POOL_TOUCH_INTERVAL_MS` 两个旋钮的**当前生效值**。
 *
 * **两个板块共用这一个函数**：Key 池板块（`sec-keys.js`）的文案曾经只能
 * 「点名旋钮 + 括注默认值」，因为那时没有任何接口报告这两个旋钮的实际值——它们是
 * 建 app 时读一次、此后不随 `ConfigHolder` 刷新的部署期常量（见 `wire.ts`），
 * 只有 `overview.freshness` 报告了它们。两个板块各自 fetch 一次 `/overview`
 * 拿到同一份数据，用这个函数取出同一组数字，不许各写各的取值逻辑。
 *
 * ⚠️ **上一版这里还有第三个旋钮 `edge`（KV 边缘缓存那个量），v0.4.0 整层删掉了**：
 * KV 随 Worker 形态一起没了，`FileStorage.get` 是直接 `readFile`，那一层不存在
 * ⇒ 两条「多久能看见」的上界就等于各自的 TTL（见 `src/http/config-holder.ts`）。
 * 两个板块照旧从这同一个函数取同一组数字，别再各写各的取值逻辑。
 */
export function poolKnobs(body) {
  const f = freshnessValues(body);
  return { ttl: f.poolCacheTtlMs, touch: f.poolTouchIntervalMs };
}

/**
 * 本地时区相对 UTC 的偏移（毫秒），供 `pure/format.mjs` 的 `fmtInstant` 当第二个
 * 参数用。**三个板块共用这一个函数**（同样是一条待办的收尾）：概览 / Key 池 / 事件
 * 板块曾经各自手抄同一行 `-new Date().getTimezoneOffset() * 60000`——三份完全
 * 相同的代码互相之间没有任何约束，改掉其中一份、留下另外两份不动，三个板块的
 * 时间戳就会用不同的时区偏移渲染同一份数据，而没有任何自动化会发现。
 *
 * 放在这个模块而不是 `pure/format.mjs`：`fmtInstant` 的契约是「偏移量由调用方
 * 算好传进来」，它本身刻意不读运行环境（见该文件的文件头）；这个函数才是那个
 * 「调用方」，三个板块共用它的道理与上面的 `poolKnobs()` 是同一条——
 * 这个模块已经是三个板块公认的「共用取值」落脚点。
 */
export function offsetMs() {
  return -new Date().getTimezoneOffset() * 60000;
}

/**
 * Worker 存储卡那一行「本部署的 KV 读写与请求数无关，只取决于刷新频率」的估算。
 *
 * 公式与 `keypool-repo.ts` 的 `KeyPoolRepoOptions.cacheTtlMs` 文档同源（**每个
 * isolate 每天**）：`(86400000 / 池快照TTL) × (1 + 池中key数) + 86400000 / 配置TTL`。
 * **这是单个 isolate 的估算，不是全部署的总量**——总量还要乘以并发的 isolate 数目，
 * 而那个数字面板拿不到，文案必须老实说清楚，不能默认成 1。
 *
 * `poolCacheTtlMs <= 0`（关闭快照缓存，即「每次都真读」）时公式的前提整个不成立
 * ——那种配置下读写次数直接和请求量挂钩，不再是「与请求数无关」，返回 `null`
 * 表示「给不出这个估算」，不是伪造一个基于错误前提的数字。
 */
export function kvReadEstimatePerIsolatePerDay(body) {
  const f = freshnessValues(body);
  const pool = poolCounts(body);
  if (f.poolCacheTtlMs === null || f.poolCacheTtlMs <= 0) return null;
  if (f.configTtlMs === null || f.configTtlMs <= 0) return null;
  if (pool.total === null) return null;
  const DAY_MS = 86_400_000;
  const poolReads = (DAY_MS / f.poolCacheTtlMs) * (1 + pool.total);
  const configReads = DAY_MS / f.configTtlMs;
  return Math.round(poolReads + configReads);
}
