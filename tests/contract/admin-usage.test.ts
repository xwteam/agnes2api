import { describe, it, expect, vi } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { UsageSink, USAGE_ERROR_REPORT } from "../../src/http/usage-sink.js";
import { buildApp } from "../../src/http/wire.js";
import { nodeRuntime } from "../../src/adapters/runtime-node.js";
import { USAGE_NOTES } from "../../src/http/admin/handlers/usage.js";
import type { Storage } from "../../src/ports/storage.js";

/**
 * 用量三条端点的契约。
 *
 * **contract ⇒ node 与 workerd 各跑一遍**（`tests/global-setup.ts` 的 `POLICY` 强制）。
 *
 * ── 这一组的头等目标：把「长得一模一样的六件事」变成六种可区分的响应 ──────────
 *
 * 全局约束 9 的原话是「接口失败显示 `—`，绝不伪造 `0`」，而用量板块是它的主战场：
 * **「今天 0 次请求」「统计没开」「读不出来」在面板上长得一模一样，而它们是三件事**。
 * 再加上 `usageCandidateKeys` 那两道有限性护栏带来的三种
 *（`from`/`to` 是 `NaN`、`nowMs` 不是有限数、区间里真的没有分片
 * ——`src/core/admin/usage-stats.ts` 的 `usageCandidateKeys` 上方写着它们在**返回值上
 * 完全不可区分**），这一层要分清的是**六种**。
 * 这一组的命门是本文件末尾那一格：六种状态两两比对，任何两种压成同一份响应体就红。
 *
 * ── 期望值全部手写字面量（第 6 种假阳性）────────────────────────────────────
 * · 读扇出的四个数 `2 / 6 / 14 / 60` 直接写死，**不写成 `days * USAGE_SLOTS`**；
 * · 日期串 `2024-09-05` / `2024-10-04` 是在测试外面按 `19971` / `20000` 手算的
 *   （`new Date(19971 * 86_400_000).toISOString()`），**不是从被测代码取回来的**；
 * · 区间端点 `1725494400000` / `1728086399999` 同理。
 *
 * ── 时钟落在 UTC 日的零点上，这是刻意的 ──────────────────────────────────────
 * `NOW = 20000 × 86_400_000` 恰好是 UTC 日 20000 的零点，好让「跨不跨零点」这一维
 * 是**确定的**：`24h` 那一档因此恰好覆盖 1 个 UTC 日（2 次 get）而不是「1 或 2 个」。
 * 计划 §配额账「读侧」那张表列的正是「1 或 2（跨零点）⇒ **2 或 4**」，
 * 这一组取的是不跨零点那一端。
 */

const DAY = 86_400_000;
/** UTC 日序号。远离纪元零点的真实量级，免得「日」这一维退化成 0 而不可观测。 */
const DAY0 = 20_000;
/** 恰好是 UTC 日 20000 的零点。手算：`20000 × 86_400_000`。 */
const NOW = 1_728_000_000_000;
/** `new Date(20000 × 86_400_000).toISOString().slice(0, 10)`，手算。 */
const DAY0_DATE = "2024-10-04";
/** 保留期最老的那一天：`20000 − 30 + 1 = 19971`。手算的日期串与毫秒。 */
const OLDEST_DAY = 19_971;
const OLDEST_DATE = "2024-09-05";
const OLDEST_MS = 1_725_494_400_000;
/** 日 20000 的最后一毫秒：`20001 × 86_400_000 − 1`，手算。 */
const DAY0_END_MS = 1_728_086_399_999;

const H = { "x-admin-key": TEST_ADMIN_TOKEN };

/** 一个满桶。**逐字段写死**，好让「合并把哪一格加错了」看得见。 */
function bucket(o: Partial<Record<string, number>> = {}) {
  return {
    requests: 0, success: 0, errors: 0, tokensIn: 0, tokensOut: 0,
    streamingRequests: 0, latencySum: 0, latencyCount: 0, ...o,
  };
}

/**
 * 按前缀分开数的读计数器，**并且能让第 N 次 `usage:` 读真的 `throw`**（第 2 种假阳性：
 * stub 只 resolve 一个错误对象而被测代码根本不看它）。
 *
 * **必须按前缀分**：同一个存储上还有 key 池快照、配置、事件分片在读，
 * 混成一个「gets」会让「读用量到底扇出了几次」这个问题永远答不准——而计划
 * §配额账「读侧」那张表逐档承诺的正是那个数。
 */
class UsageReadCounter implements Storage {
  /** 落到 `usage:` 前缀上的那些 get 的 key，**按发生顺序**。 */
  readonly usageGets: string[] = [];
  /** 其余所有 get（配置、key 池、事件分片……）。 */
  otherGets = 0;
  lists = 0;
  /** 第 N 次 `usage:` 读抛错（**1 基**）。`null` = 从不抛。 */
  failUsageGetAt: number | null = null;
  /** 置真之后每一次 put 都**真的 throw**。 */
  putFails = false;
  constructor(readonly inner: Storage) {}
  async get<T>(k: string): Promise<T | null> {
    if (!k.startsWith("usage:")) { this.otherGets++; return this.inner.get<T>(k); }
    this.usageGets.push(k);
    if (this.failUsageGetAt !== null && this.usageGets.length === this.failUsageGetAt) {
      throw new Error("KV read failed");
    }
    return this.inner.get<T>(k);
  }
  async put<T>(k: string, v: T, expiresAt?: number): Promise<void> {
    if (this.putFails) throw new Error("write quota exhausted");
    return this.inner.put(k, v, expiresAt);
  }
  async delete(k: string): Promise<void> { return this.inner.delete(k); }
  async list(p: string): Promise<string[]> { this.lists++; return this.inner.list(p); }
  snapshot() { return { usage: this.usageGets.length, other: this.otherGets, lists: this.lists }; }
}

/** sink 自己报的错。**存下来而不是丢掉**：`record` / `flush` 两个 phase 要分开断言。 */
type SinkError = { err: unknown; phase: "record" | "flush" };

/**
 * 一个 Tier-2 **开着**的 app。走 `createApp`（`makeApp`）而不是 `buildApp`：
 * 「`USAGE_STATS_ENABLED` 到底决不决定 sink 建不建」那一半已经由
 * `tests/contract/usage-tier2.test.ts` 的
 * 「USAGE_STATS_ENABLED 不为 true 时：连打 50 次 /v1，usage: 前缀的 put 计数一次都不涨……」
 * 守着，本组要验的是**读侧**，
 * 需要的是可控的时钟、可控的存储故障点、以及能直接摆状态的那个 sink 本身。
 *
 * ⚠️ **sink 与 app 必须共用同一个 `storage` 实例**：读侧的接线是
 * `createApp` 从 `usageSink.storage` 上取的，另给一份就是「测的是抄件不是原件」，
 * 而那正好是这条接线唯一会出错的地方。
 */
async function tier2On(o: { now: () => number; storage?: UsageReadCounter; keys?: string[] }) {
  const now = o.now;
  const storage = o.storage ?? new UsageReadCounter(new MemoryStorage(undefined, now));
  const errors: SinkError[] = [];
  const sink = new UsageSink({
    storage, now, shardId: "u2",
    onError: (err, phase) => { errors.push({ err, phase }); },
  });
  const { app, repo } = await makeApp(
    [], o.keys ?? [], { poolCacheTtlMs: 60_000 }, now, { storage, usageSink: sink },
  );
  const get = (path: string) => app.request(path, { headers: H });
  return { app, repo, storage, sink, errors, get };
}

/** 一个 Tier-2 **关着**的 app（默认形态：不传 `usageSink`）。 */
async function tier2Off(o: { now: () => number; storage?: UsageReadCounter }) {
  const storage = o.storage ?? new UsageReadCounter(new MemoryStorage(undefined, o.now));
  const { app, repo } = await makeApp([], [], { poolCacheTtlMs: 60_000 }, o.now, { storage });
  return { app, repo, storage, get: (p: string) => app.request(p, { headers: H }) };
}

/**
 * 往存储里放一个日分片。
 *
 * **键是手写字面量 `usage:<日>:<槽位>`**，不经 `usageDayKey()` ——
 * 从被测代码取键就是同义反复，而键的形状本身是这一层与写侧的契约。
 * 值经 `JSON.parse` 造，**这是必需的而不是风格**：`{ "__proto__": x }` 写成对象字面量
 * 时 JS 会去**改原型**而不是加一个键，那样那一格用例根本摆不出想验的那个状态。
 */
async function seed(storage: Storage, day: number, slot: number, json: string) {
  await storage.put(`usage:${day}:${slot}`, JSON.parse(json));
}

/** 最小可用的一份分片 JSON。`day` 与桶里的数都由调用方给。 */
function shardJson(day: number, o: {
  requests: number; hours?: string; byModel?: string; byProtocol?: string;
}) {
  return JSON.stringify({
    shardId: "u2", day, updatedAt: 1,
    total: bucket({ requests: o.requests, success: o.requests }),
  }).replace(/}$/, "")
    + `,"hours":${o.hours ?? "{}"}`
    + `,"byModel":${o.byModel ?? "{}"}`
    + `,"byProtocol":${o.byProtocol ?? "{}"}}`;
}

// ───────────────────────────────────────────────────────────────────────────
// ① Tier-1：单把 key 的用量（与 Tier-2 完全无关）
// ───────────────────────────────────────────────────────────────────────────

describe("GET /admin/api/keys/:id/usage（Tier-1 逐 key）", () => {
  /**
   * 设计 §10.6 明写「Tier-1 的按 key 用量在 Tier-2 关闭时也仍然可用」。
   * **夹具刻意用 Tier-2 关着的那一侧**：把它接到 Tier-2 上的实现会在这里当场变红。
   */
  it("Tier-2 关着时照样交出这把 key 的 Tier-1 计数 —— 两者本来就是两套账", async () => {
    const now = () => NOW;
    const { app, repo } = await tier2Off({ now });
    await repo.add("sk-tier1-usage-probe");
    const rec = (await repo.all())[0]!;
    await repo.save({
      ...rec,
      stats: {
        requests: 12, success: 9, failed: 2, clientErrors: 1,
        lastErrorAt: NOW - 5, lastErrorKind: "upstream_5xx",
      },
    }, rec);

    const res = await app.request(`/admin/api/keys/${rec.id}/usage`, { headers: H });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBe(rec.id);
    expect(body.stats).toEqual({
      requests: 12, success: 9, failed: 2, clientErrors: 1,
      lastErrorAt: NOW - 5, lastErrorKind: "upstream_5xx",
    });
    // Tier-1 并发下少计、且最多晚一个 POOL_TOUCH_INTERVAL_MS 落盘 ⇒ 面板要打 `≈`。
    expect(body.approximate).toBe(true);
    expect(body.generatedAt).toBe(NOW);
  });

  /**
   * **零额外读**：这条端点走 `repo.all()`，与转发路径共用同一个 isolate 快照
   * （设计 §2.4 第 1、2 条）。面板把它接到某个「按 id 读一次存储」的实现上，
   * 20 次轮询就是 20 次 KV 读——而它与网关转发共用同一个每天的读桶。
   *
   * ⚠️ **反向自检在「反向自检：冷启动那一次是真读了存储的（否则上面那个 0 毫无意义）」那一格**：
   * 这里的 0 若是因为请求压根没打到 handler
   * （被静态兜底吃成 404、或者鉴权拦在外面），同样是 0。
   */
  it("连打 20 次逐 key 用量：get / list 计数一次都不增加 —— 面板轮询不许各自去读一遍存储", async () => {
    const st = new CountingStorage();
    const { app, repo } = await makeApp(
      [], ["k1", "k2", "k3"], { poolCacheTtlMs: 60_000 }, () => NOW, { storage: st },
    );
    const id = (await repo.all())[0]!.id;
    await app.request(`/admin/api/keys/${id}/usage`, { headers: H });  // 预热快照
    const base = { lists: st.lists, gets: st.gets };
    for (let i = 0; i < 20; i++) {
      const res = await app.request(`/admin/api/keys/${id}/usage`, { headers: H });
      expect(res.status, "前置条件：这 20 次要真的打到 handler").toBe(200);
    }
    expect(st.lists - base.lists, "逐 key 用量路径出现了 list()").toBe(0);
    expect(st.gets - base.gets, "逐 key 用量路径产生了额外的读，它应当共用转发路径的快照").toBe(0);
  });

  /**
   * ⚠️ **这一格刻意用一个不存在的 id**，理由不是省事：拿一个真 id 的话得先
   * `await repo.all()` 才知道它是什么，而**那一次调用自己就把快照预热了**
   *（`poolCacheTtlMs: 60_000` + 固定时钟 ⇒ 之后永远命中缓存），
   * 于是这一格量到的是 0 而不是 4，反向自检反过来把自己证伪。
   * 用不存在的 id 走的是同一条 `repo.all()`，冷读一次不落，只是结局是 404。
   */
  it("反向自检：冷启动那一次是真读了存储的（否则上面那个 0 毫无意义）", async () => {
    const st = new CountingStorage();
    const { app } = await makeApp(
      [], ["k1", "k2", "k3"], { poolCacheTtlMs: 60_000 }, () => NOW, { storage: st },
    );
    const before = st.gets;
    const res = await app.request("/admin/api/keys/deadbeefdeadbeef/usage", { headers: H });
    expect(res.status, "走的是同一条 repo.all()，只是结局是 404").toBe(404);
    expect(st.gets - before, "冷启动那一次应当读 1 次索引 + 3 条记录").toBe(4);
  });

  /**
   * **「这把 key 没有用量」与「没有这把 key」是两件事**（全局约束 9 的同一条判据在
   * Tier-1 这一侧的落点）：回一份全 0 的计数会让面板把一个打错的 id 渲染成
   * 「这把 key 一次都没被用过」，而运维会照着这个结论去查一把根本不存在的 key。
   */
  it("不存在的 key 是 404，而不是一份全 0 的计数 —— 那两件事不许压成一件", async () => {
    const { app } = await tier2Off({ now: () => NOW });
    const res = await app.request("/admin/api/keys/deadbeefdeadbeef/usage", { headers: H });
    expect(res.status).toBe(404);
    const body = await res.json() as { error?: { type?: string } };
    expect(body.error?.type).toBe("not_found");
    expect(body).not.toHaveProperty("stats");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ② 查询参数契约（评审发现：第一版全文没定义过它）
// ───────────────────────────────────────────────────────────────────────────

describe("GET /admin/api/usage 的查询参数契约", () => {
  /**
   * **非整数、负数、`from > to` 一律 400，不做「善意纠正」。**
   *
   * 悄悄纠正会让「前端把参数发错」这件事**永远不被发现**——第一版全计划里唯一出现
   * 查询串的地方是一个测试里的占位 `?from=…&to=…`，而前端的 `rangeToQuery`
   * 发的是 `{from,to,days}` 三个字段、单位没说、谁夹逼也没说：两边各说各的，
   * 前端发错参数名也照样绿。
   *
   * ⚠️ **`1e24` 那两格是最要紧的**：`Number.isInteger(1e24)` 是 **true**，
   * 而 `usageDayIndex(1e24)` 已远超 `2**53`，在那个量级上 `d + 1 === d` 可能成立
   * （`src/core/admin/usage-stats.ts` 的 `usageCandidateKeys` 上方那张四行实测表）。
   *
   * ⚠️⚠️ **两格里只有 `to=1e24` 那一格真的在验 `Number.isSafeInteger`，这条差别
   * 必须写下来**（本任务变异实测：把判据换成 `Number.isInteger` 之后，
   * **只有 `to 超出安全整数` 那一格变红**，`from 超出安全整数` 那一格照绿）——
   * 后者被 `from > to` 那道判据先接住了（`to` 缺省是 `now`，而 `1e24 > now`）。
   * ⇒ **别把 `from=1e24` 那一格当成这条性质的证据**，它证明的是另一件事。
   */
  it.each([
    ["from 不是数字", "?from=abc"],
    ["from 是小数", "?from=1.5"],
    ["from 是负数", "?from=-1"],
    ["to 不是数字", "?to=abc"],
    ["to 是负数", "?to=-1"],
    ["from 晚于 to", "?from=2&to=1"],
    ["from 超出安全整数（Number.isInteger 认它、Number.isSafeInteger 不认）", "?from=1e24"],
    ["to 超出安全整数", "?to=1e24"],
  ])("%s ⇒ 400 invalid_request_error，不许被善意纠正成一个能跑的区间", async (_label, qs) => {
    const { get } = await tier2On({ now: () => NOW });
    const res = await get(`/admin/api/usage${qs}`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { type?: string } };
    expect(body.error?.type).toBe("invalid_request_error");
  });

  /**
   * **`days` 不是参数**：它是前端按钮的档位，服务端不认。
   * 服务端认了它就等于同一份「时间范围」知识有两个真源，而前端与后端对
   * 「30 天从哪天算起」的理解迟早会分叉。
   */
  it("days 不是参数：发 days=30 服务端一个字都不认，区间仍然是缺省的那一段", async () => {
    const { get } = await tier2On({ now: () => NOW });
    const a = await (await get("/admin/api/usage?days=30")).json() as { range: unknown };
    const b = await (await get("/admin/api/usage")).json() as { range: unknown };
    expect(a.range).toEqual(b.range);
    // 缺省 = `to = now`、`from = to − 86400000` ⇒ 覆盖日 19999 与 20000 两整天。
    expect(a.range).toEqual({ from: 1_727_913_600_000, to: DAY0_END_MS, clamped: false });
  });

  /**
   * **面板不承诺，只回读**（与设计 §5.3「保存后回读生效值」完全同源）。
   *
   * 服务端一律按「`from` 所在的 UTC 日」到「`to` 所在的 UTC 日」取整天：
   * 滚动 30 天会横跨 **31** 个 UTC 日，而日桶的粒度就是天，装作能给出半天是撒谎。
   * ⚠️ **入参刻意取日中间的一个时刻**（`NOW − 3600_000`，即日 19999 的 23:00）——
   * 取零点的话「有没有取整」这一维不可观测（第 5 种假阳性）。
   */
  it("range 回读的是取整到 UTC 整天之后的那一对，不是客户端发来的那一对", async () => {
    const { get } = await tier2On({ now: () => NOW });
    const res = await get(`/admin/api/usage?from=${NOW - 3_600_000}&to=${NOW - 1}`);
    const body = await res.json() as { range: unknown };
    // 手算：from 落在日 19999 ⇒ 19999 × 86_400_000；to 落在日 19999 ⇒ 那天的最后一毫秒。
    expect(body.range).toEqual({
      from: 1_727_913_600_000, to: 1_727_999_999_999, clamped: false,
    });
  });

  /**
   * 「不许把一段不完整的 30 天显示成完整的」是**本期计划**的话（评审订正：
   * 它不在设计 §10.6 里，设计那一段的原话是「接口失败显示 `—`，绝不伪造 `0`」）。
   * `clamped` 为真时面板要说「这段时间早于保留期，只显示了能拿到的部分」。
   */
  it("早于保留期的 from 被夹到保留期起点：clamped 为真，note 说明被夹过", async () => {
    const { get } = await tier2On({ now: () => NOW });
    const res = await get(`/admin/api/usage?from=0&to=${NOW}`);
    const body = await res.json() as { range: { from: number; clamped: boolean }; note: string };
    expect(body.range.from, "应当被夹到保留期最老的那一天（19971）的零点").toBe(OLDEST_MS);
    expect(body.range.clamped).toBe(true);
    expect(body.note).toBe("range_clamped");
  });

  /**
   * **`days` 的格数有硬上界，而那条上界来自夹逼**：`fromDay >= usageDayIndex(now) − 29`
   * 且 `toDay <= usageDayIndex(now)` ⇒ 跨度恒 `<= 30`，对任何有限的 `now` 都成立。
   * **30 这个数手写死**，不写成 `USAGE_DAY_RETAIN`（第 6 种假阳性）。
   *
   * ⚠️ **它不是那个 `n < USAGE_DAY_RETAIN` 计数闸的护栏**——把那道闸删掉，本文件
   * **整份全绿**（本任务变异实测）。那道闸今天走不到，理由算在
   * `src/http/admin/handlers/usage.ts` 那个循环上方。**别把这两件事读成一件。**
   */
  it("要一整年的区间也只回 30 格 days —— 上界来自夹逼，不许随请求的区间涨", async () => {
    const { get } = await tier2On({ now: () => NOW });
    const body = await (await get(`/admin/api/usage?from=0&to=${NOW}`)).json() as {
      days: Array<{ date: string }>;
    };
    expect(body.days.length).toBe(30);
    expect(body.days[0]!.date, "最老的那一格是保留期起点").toBe(OLDEST_DATE);
    expect(body.days[29]!.date, "最新的那一格是今天").toBe(DAY0_DATE);
  });

  /**
   * **登记一条残留，并且把它变成一个会红的事实而不是一句注释。**
   *
   * `1e300` 是有限数（所以过得了 `clock_unavailable` 那道闸），而
   * `usageDayIndex(1e300) ≈ 1.157e292` 远超 `toISOString()` 能表示的上限
   * （实测：`d` 超过 **`1e8`** 就抛 `RangeError`）⇒ **这条端点是 500**。
   * 那条路**从 `Date.now()` 到不了**（两个生产入口的时钟都是它），所以刻意不为它
   * 加 try/catch——为到不了的路加防御是本仓用 `String()` 那一课换来的教训。
   *
   * ⚠️⚠️ **这一格没有对应的变异，如实说明**：它守的不是某一行代码，而是
   * **「它返回了」这件事本身**——`RangeError` 与「挂死 isolate」在生产上不是一个量级
   * 的事，而后者今天走不到（那个循环体第一步就抛，`d++` 打不起转来，
   * 算式见 `src/http/admin/handlers/usage.ts` 那个循环上方）。
   * 把 `utcDateString` 改成「抛不出来就回个兜底串」的那一天，这一格会先红，
   * **而那正是该有人停下来看一眼的时刻**。
   * ⚠️ **别把 `.toBe(500)` 读成「500 是我们想要的行为」**：它是量出来的现状。
   */
  it("时钟是 1e300 这种「有限但荒诞」的数：端点必须返回，不许把 isolate 挂死", async () => {
    let t: number = NOW;
    const { get } = await tier2On({ now: () => t });
    t = 1e300;
    const res = await get("/admin/api/usage");
    expect(
      res.status,
      "它必须返回。500 是登记在案的残留（toISOString 抛 RangeError），挂死不是",
    ).toBe(500);
  });

  it("晚于 now 的 to 被夹到 now：clamped 为真，不许凭空多出几天未来的格子", async () => {
    const { get } = await tier2On({ now: () => NOW });
    const res = await get(`/admin/api/usage?from=${NOW}&to=${NOW + 30 * DAY}`);
    const body = await res.json() as {
      range: { to: number; clamped: boolean }; days: Array<{ date: string }>;
    };
    expect(body.range.to).toBe(DAY0_END_MS);
    expect(body.range.clamped).toBe(true);
    expect(body.days.map((d) => d.date)).toEqual([DAY0_DATE]);
  });

  /**
   * **取整本身不算 `clamped`**，这条要正面钉住：把两者混成一个布尔的话，
   * **每一次正常请求**都会被标成「被夹过」，面板那句「只显示了能拿到的部分」
   * 会天天出现，运维很快就不再看它。
   * ⚠️ 判别状态是「入参落在日中间、且完全落在保留期内」——那时取整真的发生了
   * （`range` 与入参不等），而 `clamped` 必须是 false。
   */
  it("取整到整天不算被夹过：range 与入参不等，clamped 仍然是 false", async () => {
    const { get } = await tier2On({ now: () => NOW });
    const from = NOW - 3_600_000;
    const res = await get(`/admin/api/usage?from=${from}&to=${NOW - 1}`);
    const body = await res.json() as { range: { from: number; clamped: boolean } };
    expect(body.range.from, "前置条件：取整真的发生了，否则这一格什么都没验").not.toBe(from);
    expect(body.range.clamped).toBe(false);
  });

  /**
   * **档位 → `(from, to)` 的映射是一份契约，两边必须对上**（评审发现）。
   * 服务端不认 `days` 这个参数，但「30d 这个按钮从哪天算起」如果前后端各说各的，
   * 后果**不是「多一天数据」而是那句警告永久常驻**：差一天会让每一次点 30d 都
   * `clamped: true`，面板每一次都说「这段时间早于保留期，只显示了能拿到的部分」
   * ——说到运维不再看它。映射与理由写在 `parseRange` 上方那张表。
   *
   * ⚠️ **两个方向都断言，缺一不可**（第 5 种假阳性）：只写正向的话，
   * 一个「`clamped` 恒为 false」的实现照样全绿；只写反向的话，
   * 「恒为 true」的实现照样全绿。**`N` 与期望的格数全部手写字面量。**
   */
  it("四个档位按 from = to − (N−1) 天 发：clamped 全是 false；按 N 天发：30d 那一档恒为 true", async () => {
    const { get } = await tier2On({ now: () => NOW });
    // ── 正向：契约里那个映射。四档全部 clamped: false，且格数就是 N。
    for (const [label, n, days] of [
      ["24h", 1, 1], ["3d", 3, 3], ["7d", 7, 7], ["30d", 30, 30],
    ] as const) {
      const body = await (await get(
        `/admin/api/usage?from=${NOW - (n - 1) * DAY}&to=${NOW}`,
      )).json() as { range: { clamped: boolean }; days: unknown[] };
      expect(body.range.clamped, `${label}：按契约发不该被夹`).toBe(false);
      expect(body.days.length, `${label}：格数就是 N`).toBe(days);
    }
    // ── 反向：差一天。**只有 30d 那一档会撞上保留期起点**，另外三档差一天也还在期内。
    const off1 = await (await get(
      `/admin/api/usage?from=${NOW - 30 * DAY}&to=${NOW}`,
    )).json() as { range: { clamped: boolean }; days: unknown[] };
    expect(off1.range.clamped, "30d 发成 30 天回退 ⇒ 每一次都被夹，那句警告就永久常驻").toBe(true);
    expect(off1.days.length, "被夹之后仍然只有 30 格 —— 多要的那一天根本拿不到").toBe(30);
    // ⚠️ **这一条守的不是「一律 true」——那件事由上面那个正向循环守着，
    //    而且它先炸**（定向复评实测：把 `clamped` 改成恒真之后，
    //    先红的是同一格里 `24h：按契约发不该被夹` 那句，这一行**根本跑不到**）。
    //    它真正守的是**「差一天到底会不会撞上保留期起点」这件事取决于 N**：
    //    `30d` 差一天撞得上（`N = USAGE_DAY_RETAIN`），`7d` 差一天撞不上。
    //    把保留期缩到 ≤ 7 天的那一天，这一行会响，而上面那个 `off1` 不会。
    const stillFine = await (await get(
      `/admin/api/usage?from=${NOW - 7 * DAY}&to=${NOW}`,
    )).json() as { range: { clamped: boolean } };
    expect(stillFine.range.clamped, "7d 差一天仍在保留期内 ⇒ 不该被夹；撞不撞得上取决于 N 与保留期的关系")
      .toBe(false);
  });

  /**
   * **有效窗口为空时 `range.from > range.to`，那不是编出来的一对。**
   * 上一版只在 `parseRange` 上方写了这件事，**一格用例都没有**（评审 Minor）：
   * 一句只活在注释里的行为描述，改坏了没有任何东西会红。
   *
   * ⚠️ 判别状态取「整段区间都在未来」：`to` 被夹到 `now` ⇒ `toDay = 今天`，
   * 而 `fromDay = 今天 + 40` ⇒ 窗口为空、`days` 是空数组。
   * **不把它「修正」成一段非空区间**——那样面板会照着那段区间说「这几天没有请求」，
   * 而那是一句关于根本没被查过的日子的断言。
   */
  it("整段区间都在未来时：range.from 大于 range.to、days 是空数组 —— 空窗口如实回读，不许被修正成一段非空的", async () => {
    const { get } = await tier2On({ now: () => NOW });
    const body = await (await get(
      `/admin/api/usage?from=${NOW + 40 * DAY}&to=${NOW + 41 * DAY}`,
    )).json() as {
      range: { from: number; to: number; clamped: boolean };
      days: unknown[]; shards: number; note: string;
    };
    expect(body.range.from, "起始日就是客户端要的那一天（今天 + 40）").toBe(NOW + 40 * DAY);
    expect(body.range.to, "结束日被夹到今天 ⇒ 今天的最后一毫秒").toBe(DAY0_END_MS);
    expect(body.range.from).toBeGreaterThan(body.range.to);
    expect(body.range.clamped).toBe(true);
    expect(body.days, "一天都没查过 ⇒ 一格都不许有").toEqual([]);
    expect(body.shards).toBe(0);
    expect(body.note).toBe("range_clamped");
  });

  it("timezone 恒是 UTC 并且写在响应里 —— Worker 是多 colo 的，硬编码 CST 是自托管单地域的假设", async () => {
    const { get } = await tier2On({ now: () => NOW });
    const body = await (await get("/admin/api/usage")).json() as { timezone: string };
    expect(body.timezone).toBe("UTC");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ③ 读扇出：四档各一格，期望值全部手写字面量
// ───────────────────────────────────────────────────────────────────────────

describe("读扇出（计划 §配额账「读侧」那张表）", () => {
  /**
   * **四个数必须与计划 §配额账「读侧」那张表逐字对上**（`24h`=2 / `3d`=6 / `7d`=14 /
   * `30d`=**60**）。对不上就先回去改配额账——第一版正是在任务里算出了一个数（1440）
   * 却没搬回配额账（评审发现）。
   *
   * **期望值不写成 `days * USAGE_SLOTS`**（第 6 种假阳性）：写成表达式的话，把
   * `USAGE_SLOTS` 改成 1 这条变异会让期望值跟着变，四格全绿。
   *
   * ⚠️ **`30d` 那一档的 60 是本仓第一个会跨过 Cloudflare「每次调用 50 次子请求」
   * 那条线的读扇出**（待验证清单里那一条：两页官方文档互相对不上，见
   * `src/core/admin/usage-stats.ts` 的 `USAGE_DAY_RETAIN` 上方）。
   * **不许为了「省配额」把它悄悄改小**——那不是省，那是把 30 天的图表画成假的。
   */
  it.each([
    ["24h", 1, 2],
    ["3d", 3, 6],
    ["7d", 7, 14],
    ["30d", 30, 60],
  ])("读 %s 的用量：usage: 前缀的 get 次数恰好 %i 天 × 2 槽位 = %i —— 读扇出不许随实现浮动",
    async (_label, days, expected) => {
      const { get, storage } = await tier2On({ now: () => NOW });
      await get("/admin/api/usage");                       // 预热：把链上其余读跑掉
      const before = storage.snapshot();
      const to = NOW;
      const from = to - (days - 1) * DAY;
      const res = await get(`/admin/api/usage?from=${from}&to=${to}`);
      expect(res.status).toBe(200);
      const after = storage.snapshot();
      expect(after.usage - before.usage).toBe(expected);
      // 三条红线第 1 条：面板轮询路径不许出现 `list()`。
      expect(after.lists - before.lists, "读用量路径出现了 list()").toBe(0);
      // `usage:` 之外一次都不许多读：把它写成「读一遍 key 池再算」的实现会在这里红。
      expect(after.other - before.other, "读用量路径读了 usage: 之外的键").toBe(0);
    });

  /**
   * ⚠️⚠️ **「读了哪些天」与「画了哪些天」是两套各算各的推导，而它们必须一致**
   *（评审发现）：
   * · **读**的那一套在 `usageCandidateKeys(now, from, to)` 里（`src/core/admin/usage-stats.ts`）；
   * · **画**的那一套在 `parseRange()` 算出来的 `fromDay` / `toDay` 里（handler 自己）。
   * 两边各自对 `now` / `from` / `to` 做一遍夹逼，**谁也没有引用谁**。散了的后果是
   * 「画的天」与「读的天」错位：面板上某一天有格子却永远是 0（那天根本没被读），
   * 或者读回来的分片落在区间外被整份丢掉。**两种都长得像「那天没人用」。**
   *
   * 这一格把两套绑起来：从计数器里拿到**真正被 get 过的那些键**，
   * 解析出它们覆盖的 UTC 日集合，与 `days` 里那些日期逐一比对。
   * ⚠️ **区间刻意取 3 天而不是 1 天**：1 天时两套推导都只可能给出一个日子，
   * 「有没有错位」这一维不可观测（第 5 种假阳性）。
   */
  it("读回来的那些键覆盖的 UTC 日，与 days 里列出的那些天逐一对上 —— 那两套日子是各算各的", async () => {
    const { get, storage } = await tier2On({ now: () => NOW });
    await get("/admin/api/usage");                         // 预热
    storage.usageGets.length = 0;
    const body = await (await get(`/admin/api/usage?from=${NOW - 2 * DAY}&to=${NOW}`)).json() as {
      days: Array<{ date: string }>;
    };
    // `usage:<日序号>:<槽位>` → 日序号 → `YYYY-MM-DD`（手写换算，不调被测代码）。
    const readDays = [...new Set(storage.usageGets.map((k) => Number(k.split(":")[1])))]
      .sort((a, b) => a - b)
      .map((d) => new Date(d * DAY).toISOString().slice(0, 10));
    expect(readDays, "读的那三天").toEqual(["2024-10-02", "2024-10-03", DAY0_DATE]);
    expect(body.days.map((d) => d.date), "画的那三天，必须与读的逐一对上").toEqual(readDays);
  });

  /**
   * 反向自检：`读 %s 的用量：usage: 前缀的 get 次数恰好 %i 天 × 2 槽位 = %i` 那一组
   * 数的是**同一条真路由**，而不是一条被 404 掉的路径。
   * 一条 404 的路由同样是 0 次 `usage:` 读，那时那一组会红、
   * 但**如果四档全都退化成 0，只有 `24h` 那一格的 2 能拦住它**——把这件事
   * 单独钉一格，比指望某一格顺手接住可靠。
   */
  it("反向自检：这四格数的是真路由 —— 端点返回 200 且 usage: 读次数不是 0", async () => {
    const { get, storage } = await tier2On({ now: () => NOW });
    const before = storage.snapshot();
    expect((await get("/admin/api/usage")).status).toBe(200);
    expect(storage.snapshot().usage - before.usage).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ④ 六种状态必须在响应字段上分得开（全局约束 9 的主战场）
// ───────────────────────────────────────────────────────────────────────────

describe("八种状态在响应字段上分得开", () => {
  it("① 统计没开：tier 是 off，days 与 pending 都是 null，而且一次存储读都没有", async () => {
    const { get, storage } = await tier2Off({ now: () => NOW });
    await get("/admin/api/usage");                         // 预热
    const before = storage.snapshot();
    const res = await get("/admin/api/usage");
    expect(res.status, "关着不等于坏了：这条端点照常 200").toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.tier).toBe("off");
    expect(body.days).toBeNull();
    expect(body.total).toBeNull();
    expect(body.shards).toBeNull();
    // **没有 sink 就没有「未落盘的尾巴」这件事，报 0 是伪造。**
    expect(body.pending).toBeNull();
    expect(body.note).toBe("tier2_off");
    // `range` 照常回读：参数是好的，藏起来只会让前端多猜一次。
    expect(body.range).not.toBeNull();
    // 全局约束 16：关闭时**一次存储访问都不许有**。
    expect(storage.snapshot().usage - before.usage, "Tier-2 关着却去读了存储").toBe(0);
  });

  it("② 读不出来：days / total / shards / malformed 四个一起是 null，而不是 0", async () => {
    const st = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const { get } = await tier2On({ now: () => NOW, storage: st });
    await seed(st, DAY0, 0, shardJson(DAY0, { requests: 5 }));
    st.failUsageGetAt = 1;
    const res = await get("/admin/api/usage");
    expect(res.status, "读不出来不是 500：tier / range / pending 三块都还是真的").toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.tier).toBe("tier2");
    expect(body.days).toBeNull();
    expect(body.total).toBeNull();
    // ★ 这两格是本格的判别力所在：留 0 的话，面板会渲染成
    //   「这段时间有 0 个分片贡献了数据」——那正是伪造 0。
    expect(body.shards).toBeNull();
    expect(body.malformed).toBeNull();
    expect(body.note).toBe("read_failed");
  });

  it("③ 区间里一个分片都没有：shards 与 malformed 都是 0，note 是 no_shards", async () => {
    const { get } = await tier2On({ now: () => NOW });
    const res = await get(`/admin/api/usage?from=${NOW}&to=${NOW}`);
    const body = await res.json() as {
      days: Array<{ date: string; total: { requests: number } }>;
      shards: number; malformed: number; note: string;
    };
    expect(body.days.map((d) => d.date)).toEqual([DAY0_DATE]);
    expect(body.days[0]!.total).toEqual(bucket());
    expect(body.shards).toBe(0);
    expect(body.malformed).toBe(0);
    expect(body.note).toBe("no_shards");
  });

  /**
   * **④ 与 ③ 是两件事，而第一版会把它们压成同一个「今日请求数 0」。**
   * 前者说「有实例落过盘，那些盘里的请求数就是 0」，后者说「这个部署根本没记下东西」
   * （可能是没流量，也可能是 isolate 没活到一次落盘就没了）。
   * **判据是 `shards`，不是 `total.requests`。**
   */
  it("④ 有分片、只是请求数是 0：shards 大于 0 而 total.requests 是 0，note 是 null", async () => {
    const st = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const { get } = await tier2On({ now: () => NOW, storage: st });
    await seed(st, DAY0, 0, shardJson(DAY0, { requests: 0 }));
    const res = await get(`/admin/api/usage?from=${NOW}&to=${NOW}`);
    const body = await res.json() as {
      shards: number; total: { requests: number }; note: string | null;
    };
    expect(body.shards, "分片是真的读到了").toBe(1);
    expect(body.total.requests).toBe(0);
    expect(body.note, "有分片就不是 no_shards —— 那两件事不许压成一件").toBeNull();
  });

  /**
   * **⑤ 服务端时钟给不出有限数字。**
   *
   * `usageCandidateKeys` 对 `nowMs` 不是有限数时**返回空数组**
   * （`src/core/admin/usage-stats.ts` 那两道护栏里的第 1 道），
   * 而空数组与「这段时间真的没有数据」在它的返回值上完全不可区分。
   * ⇒ **把它们分开是入参解析这一层的职责**，也就是这条端点。
   *
   * ⚠️ **时钟是「事后拨坏」的**：装配期用好时钟，请求那一刻才变成 NaN。
   * 一上来就 NaN 会让 `createConfigHolder` / `MemoryStorage` 的 TTL 一起进未定义地带，
   * 那时红了也说不清是谁红的。
   */
  it("⑤ 时钟给不出有限数字：range 与 days 一起是 null，note 是 clock_unavailable", async () => {
    let t: number = NOW;
    const { get } = await tier2On({ now: () => t });
    t = NaN;
    const res = await get("/admin/api/usage");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.tier, "tier 永远不许是 null：它来自内存里的接线").toBe("tier2");
    expect(body.range, "算不出区间就如实说算不出，不许回一段编出来的").toBeNull();
    expect(body.days).toBeNull();
    expect(body.note).toBe("clock_unavailable");
  });

  it("⑥ 参数发错了：400，而不是一份「这段时间没有数据」的 200", async () => {
    const { get } = await tier2On({ now: () => NOW });
    expect((await get("/admin/api/usage?from=abc")).status).toBe(400);
  });

  /**
   * ── ⑦ 评审抓出来的第七种状态 ────────────────────────────────────────────
   *
   * **分片明明在，只是每一个都坏了。** 在 `all_malformed` 这条 code 出现之前，
   * 它与 ③ **同报 `no_shards`**，于是面板照 `note` 分支就会把
   * 「读到了 N 个分片、但每一个都坏」说成「这段时间一个分片都没有」
   * ——**那句话是假的**，而两者的处置完全不同：
   * 前者「没人用这台网关」，后者「存储里的东西坏了，去查是谁写的」。
   *
   * ⚠️⚠️ **立案理由订正（定向复评）**：上一版这里写「它与 ③ 的响应体**逐字相同**」
   * ——**那句是假的**。`malformed` 在评审之前就已经在响应体里，
   * ③ 是 `"malformed":0`、本格是 `"malformed":2`，**一直分得开**。
   * ⇒ **缺陷只有「`note` 撒谎」这一条，而它本来就够立案了。**
   * ⭐ **给一个真缺陷编一个更吓人的理由，会把它变成假的**——理由一被证伪，
   * 缺陷本身也会跟着被人当成没有。
   *
   * ⚠️ **夹具必须让两个槽位都畸形**：留一个好的就变成「有好有坏」（`shards > 0`），
   * 摆不出 `shards === 0 && malformed > 0` 这个判别状态。
   * ⚠️ **两条畸形数据刻意用不同的坏法**（`total: []` 与 `total: "nope"`）：
   * 前者是「数组冒充桶」那一档（`typeof [] === "object"` 且 truthy，只判 `typeof`
   * 的窄化会把它记成合法分片），后者是纯粹的类型不对。同一种坏法写两遍，
   * 「窄化只挡住了其中一种」这件事就不可观测。
   *
   * ⚠️ **反向那一半在同一格里**：同样这两条畸形分片，`③` 那一格用的是空存储。
   * 只写本格的话，一个「`shards === 0` 一律报 `all_malformed`」的实现也全绿
   * ——而那会让一个真正没流量的部署被告知「数据坏了」。
   */
  it("⑦ 分片都在、但每一个都是畸形的：note 是 all_malformed 而不是 no_shards —— 后者是假话", async () => {
    const st = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const { get } = await tier2On({ now: () => NOW, storage: st });
    await seed(st, DAY0, 0, String.raw`{"shardId":"u2","day":20000,"total":[]}`);
    await seed(st, DAY0, 1, String.raw`{"shardId":"u2","day":20000,"total":"nope"}`);

    const body = await (await get(`/admin/api/usage?from=${NOW}&to=${NOW}`)).json() as {
      shards: number; malformed: number; note: string; days: unknown[];
    };
    expect(body.shards, "一个合法分片都没有").toBe(0);
    expect(body.malformed, "但确实读到了两条，而且都是坏的").toBe(2);
    expect(body.note, "报成 no_shards 就是对运维说「没人用」，而真相是「数据坏了」")
      .toBe("all_malformed");
    // 反向：同一个 note 判据下，真正的空区间必须仍然是 no_shards。
    const empty = await tier2On({ now: () => NOW });
    const b2 = await (await empty.get(`/admin/api/usage?from=${NOW}&to=${NOW}`)).json() as {
      malformed: number; note: string;
    };
    expect(b2.malformed).toBe(0);
    expect(b2.note, "没有畸形分片就不许报 all_malformed").toBe("no_shards");
  });

  /**
   * ── ⑧ 定向复评抓出来的第八种状态 ────────────────────────────────────────
   *
   * **一部分分片是好的、另一部分坏了 ⇒ 面板上那些数字是不完整的。**
   * 上一版这一档走的是 `note: null`，也就是**「一切正常」那一支**
   * ——把一份缺了几个分片的数据渲染成完整的。全局约束 9 禁的「伪造」
   * **不只是伪造 `0`，还有伪造「这份数据是全的」这个印象**；
   * 而全局约束 10 的原话是「诚实标记由后端字段驱动」，
   * `malformed` 那个数字虽然一直在，**但面板不该被要求自己去推**。
   *
   * ⚠️ **它逃过了上一轮全部的格子**（定向复评实测：把这一档改成谎报
   * `no_shards` —— 即评审亲手判定为「一句假话」的那种谎 —— **全仓全绿、完整逃逸**）。
   * 成因很干净：那格 note 一致性用例给五条 code 各写了双条件，
   * **唯独没给 `note === null` 定义判据** ⇒ `null` 就是逃逸口。现在补上了。
   *
   * ⚠️ **判别状态必须是「一好一坏」**：两个都好 ⇒ ④，两个都坏 ⇒ ⑦，
   * 只有一好一坏才落在这一档。**同格里带 ④ 的对照**，
   * 否则「`shards > 0` 一律报 `partial_malformed`」的实现照样全绿。
   */
  it("⑧ 一部分分片畸形：note 是 partial_malformed 而不是 null —— null 是在说「这份数据是全的」", async () => {
    const st = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const { get } = await tier2On({ now: () => NOW, storage: st });
    await seed(st, DAY0, 0, shardJson(DAY0, { requests: 5 }));                       // 好的
    await seed(st, DAY0, 1, String.raw`{"shardId":"u2","day":20000,"total":[]}`);    // 坏的

    const body = await (await get(`/admin/api/usage?from=${NOW}&to=${NOW}`)).json() as {
      shards: number; malformed: number; note: string | null; total: { requests: number };
    };
    expect(body.shards, "好的那一个").toBe(1);
    expect(body.malformed, "坏的那一个").toBe(1);
    expect(body.total.requests, "交出去的数字只含好的那一份 —— 所以它是不完整的").toBe(5);
    expect(body.note, "报 null 就是对面板说「这份数据是全的」，而它不是")
      .toBe("partial_malformed");

    // 对照：两个分片都是好的 ⇒ note 必须回到 null（④）。
    const clean = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const g = await tier2On({ now: () => NOW, storage: clean });
    await seed(clean, DAY0, 0, shardJson(DAY0, { requests: 5 }));
    await seed(clean, DAY0, 1, shardJson(DAY0, { requests: 2 }));
    const ok = await (await g.get(`/admin/api/usage?from=${NOW}&to=${NOW}`)).json() as {
      shards: number; malformed: number; note: string | null;
    };
    expect(ok.shards).toBe(2);
    expect(ok.malformed).toBe(0);
    expect(ok.note, "没有畸形分片就不许报 partial_malformed").toBeNull();
  });

  /**
   * ── 优先级那条的落点：被夹过**且**有畸形分片时，`note` 归谁 ───────────────
   *
   * `note` 只有一格，所以要定优先级。上一版把 `range_clamped` 排在畸形那两条**之前**，
   * 判据是「你要的窗口被缩小了更该先说」。⚠️ **那个顺序与档位差一天那件事叠起来
   * 会变成永久静音**：面板的 `30d` 按钮只要把 `from` 发成 `now − 30 天`
   *（`四个档位按 from = to − (N−1) 天 发：clamped 全是 false；按 N 天发：30d 那一档恒为 true`
   * 正在防的那件事），`clamped` 就**恒为真** ⇒ 存储坏成什么样，
   * 面板都只会说「这段时间早于保留期」。
   * ⇒ 判据换成**「谁需要人去查」**：畸形要人去查存储，被夹只是一句提示。
   *
   * ⚠️ **这一格是那条优先级唯一的护栏，而它上一版不存在**（定向复评实测：
   * 把顺序改回去 ⇒ **整份全绿、完整逃逸**）。成因是**没有任何一格同时摆出
   * 「被夹」与「有畸形分片」这两个状态** —— 第 5 种假阳性的标准形态：
   * 几条测试各自只覆盖单一状态，而在那些状态下两种优先级数学上等价。
   *
   * ⚠️ **`clamped` 那半信息没有丢**：`range.clamped` 这个布尔一直在响应里，
   * 面板照样渲染得出来（全局约束 10 要的正是「由字段驱动」）。本格连同它一起断言。
   */
  it("被夹过且有畸形分片时 note 归畸形那条 —— 档位差一天会让 clamped 恒真，排在它后面就是永久静音", async () => {
    const st = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const { get } = await tier2On({ now: () => NOW, storage: st });
    await seed(st, DAY0, 0, String.raw`{"shardId":"u2","day":20000,"total":[]}`);
    await seed(st, DAY0, 1, String.raw`{"shardId":"u2","day":20000,"total":"nope"}`);

    // `from=0` ⇒ 夹到保留期起点 ⇒ `clamped` 为真，同时区间里那两个分片全是畸形的。
    const all = await (await get(`/admin/api/usage?from=0&to=${NOW}`)).json() as {
      range: { clamped: boolean }; malformed: number; note: string;
    };
    expect(all.range.clamped, "前置条件：这一次真的被夹了").toBe(true);
    expect(all.malformed).toBe(2);
    expect(all.note, "被夹只是一句提示，分片全坏要人去查存储").toBe("all_malformed");

    // 同理，一好一坏 + 被夹 ⇒ partial_malformed。
    const half = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const g = await tier2On({ now: () => NOW, storage: half });
    await seed(half, DAY0, 0, shardJson(DAY0, { requests: 5 }));
    await seed(half, DAY0, 1, String.raw`{"shardId":"u2","day":20000,"total":[]}`);
    const part = await (await g.get(`/admin/api/usage?from=0&to=${NOW}`)).json() as {
      range: { clamped: boolean }; note: string;
    };
    expect(part.range.clamped).toBe(true);
    expect(part.note).toBe("partial_malformed");

    // 反向：被夹但**没有**畸形分片 ⇒ 仍然是 range_clamped（否则上面两条只是「一律畸形」）。
    const clean = await tier2On({ now: () => NOW });
    const plain = await (await clean.get(`/admin/api/usage?from=0&to=${NOW}`)).json() as {
      malformed: number; note: string;
    };
    expect(plain.malformed).toBe(0);
    expect(plain.note).toBe("range_clamped");
  });

  /**
   * ── 这一组的命门 ────────────────────────────────────────────────────────
   *
   * `describe("八种状态在响应字段上分得开")` 里那八格各自只看自己那一种状态，
   * 而**「它们两两不同」这条性质，
   * 单独看任何一格都验不出来**（第 5 种假阳性：几条测试各自只覆盖单一状态，
   * 而在那些状态下两个候选实现数学上等价）。
   * 这一格把八份响应放在一起两两比对：任何两种被压成同一份响应体就红。
   *
   * ⚠️⚠️⚠️ **这一格证明的是「**已列出的这八种**互不相同」，
   * 它证明不了「没有第九种」—— 这条限制必须写在这里，因为它已经真的咬过两次。**
   * · 第一次：这一格断言 `size === 6` 时，**第七种（分片都在但全是畸形的）
   *   落在那六格之外**，评审抓到了它，而这一格当时全绿；
   * · 第二次：改成 `size === 7` 之后，**第八种（一部分分片畸形）又落在七格之外**，
   *   定向复评抓到了它，这一格**又是全绿**。
   * ⇒ **一个「所有已知状态互不相同」的断言，对未知状态一言不发 —— 连续两轮都这样。**
   * 加一种状态的时候，**先在上面补一格，再把这里的期望数一起加**——
   * 光改这个数字不会让任何东西变红。
   *
   * ⚠️⚠️ **它也拦不住「note 说了假话」，这条同样是实测出来的**（当时的变异：
   * 把 `no_shards` 的判据退回「只看 `shards`」，也就是评审之前的那个写法）：
   * **这一格照绿**——因为 `malformed` 在签名里，③ 与 ⑦ 仍然是两份不同的签名，
   * 只是其中一份的 `note` 变成了假话。红的是另外 3 格
   *（「⑦ 分片都在、但每一个都是畸形的：note 是 all_malformed 而不是 no_shards —— 后者是假话」、
   * 「USAGE_NOTES 里每一条 code 都真的被某一条端点产出过 ——……」、
   * 「note 与它自己的判据字段恒一致 —— note 是摘要不是第二个真源」）。
   * ⇒ **「两两不同」与「每一句都是真话」是两条独立的性质，各由各的格子守。**
   *
   * ⚠️ **比对的是「面板真正会拿去分支的那几格」**，不是整份响应体：
   * `generatedAt` 之类的字段天然各不相同，拿整份去比会让这一格恒绿。
   * ⚠️ **`malformed` 必须进签名**（评审那条的另一半）：③ 与 ⑦ 在被夹过的那一档下
   * `note` 相同，那时全靠这一格分。
   *
   * ⚠️⚠️ **它守的是「两两不同」，不是任何一种状态自己的形状 —— 这条边界是实测出来的**
   *（本任务变异：把 `parseRange` 里那道时钟有限性闸删掉）：删掉之后 `nowMs = NaN`
   * 会一路算出 `range: { from: null, to: null, clamped: true }` + `days: []`
   * + `note: "range_clamped"` ——**那仍然是一份与其余几种都不同的签名，所以这一格照绿**。
   * **那条变异实测红的是 2 格**（上一版这里写「红的是上面那格」，只数了一格，评审发现）：
   * 「⑤ 时钟给不出有限数字：range 与 days 一起是 null，note 是 clock_unavailable」
   * 与「USAGE_NOTES 里每一条 code 都真的被某一条端点产出过 ——……」。
   */
  it("八种状态两两不同 —— 面板不用猜，也不该猜（但这一格证明不了没有第九种）", async () => {
    const probe = async (): Promise<Array<{ name: string; sig: string }>> => {
      const out: Array<{ name: string; sig: string }> = [];
      const sig = async (name: string, res: Response) => {
        if (res.status !== 200) { out.push({ name, sig: `status:${res.status}` }); return; }
        const b = await res.json() as Record<string, unknown>;
        const pending = b.pending as { count: number } | null;
        out.push({
          name,
          sig: JSON.stringify({
            tier: b.tier,
            range: b.range === null ? null : "有",
            days: b.days === null ? null : (b.days as unknown[]).length === 0 ? "空" : "有",
            shards: b.shards,
            // ★ **`malformed` 必须在签名里**（评审发现）：③「一个分片都没有」与
            //   ⑦「分片都在但全是畸形的」在被夹过的那一档下 `note` 相同，全靠它分。
            malformed: b.malformed,
            pending: pending === null ? null : "有",
            note: b.note,
          }),
        });
      };

      const off = await tier2Off({ now: () => NOW });
      await sig("统计没开", await off.get("/admin/api/usage"));

      const failing = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
      const g1 = await tier2On({ now: () => NOW, storage: failing });
      failing.failUsageGetAt = 1;
      await sig("读不出来", await g1.get("/admin/api/usage"));

      const g2 = await tier2On({ now: () => NOW });
      await sig("一个分片都没有", await g2.get(`/admin/api/usage?from=${NOW}&to=${NOW}`));

      const seeded = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
      const g3 = await tier2On({ now: () => NOW, storage: seeded });
      await seed(seeded, DAY0, 0, shardJson(DAY0, { requests: 0 }));
      await sig("有分片但请求数是 0", await g3.get(`/admin/api/usage?from=${NOW}&to=${NOW}`));

      let t: number = NOW;
      const g4 = await tier2On({ now: () => t });
      t = NaN;
      await sig("时钟坏了", await g4.get("/admin/api/usage"));

      const g5 = await tier2On({ now: () => NOW });
      await sig("参数发错了", await g5.get("/admin/api/usage?from=abc"));

      // ⑦ 分片都在，但每一个都是畸形的（评审发现）。**两个槽位都放畸形的**，
      //    留一个好的就变成 ⑧ 那种，摆不出 `shards === 0 && malformed > 0`。
      const broken = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
      const g6 = await tier2On({ now: () => NOW, storage: broken });
      await seed(broken, DAY0, 0, String.raw`{"shardId":"u2","day":20000,"total":[]}`);
      await seed(broken, DAY0, 1, String.raw`{"shardId":"u2","day":20000,"total":"nope"}`);
      await sig("分片都在但全是畸形的", await g6.get(`/admin/api/usage?from=${NOW}&to=${NOW}`));

      // ⑧ 一部分分片畸形（定向复评）。**一好一坏**，与 ⑦ 只差一个槽位。
      const partial = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
      const g7 = await tier2On({ now: () => NOW, storage: partial });
      await seed(partial, DAY0, 0, shardJson(DAY0, { requests: 5 }));
      await seed(partial, DAY0, 1, String.raw`{"shardId":"u2","day":20000,"total":[]}`);
      await sig("一部分分片畸形", await g7.get(`/admin/api/usage?from=${NOW}&to=${NOW}`));
      return out;
    };

    const rows = await probe();
    expect(rows.length, "八种状态一种都不许少").toBe(8);
    const sigs = rows.map((r) => r.sig);
    expect(
      new Set(sigs).size,
      `有两种状态被压成了同一份响应体：\n${rows.map((r) => `  ${r.name} → ${r.sig}`).join("\n")}`,
    ).toBe(8);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ⑤ 30d 那一档必须失败得诚实（那条待验证项的落点）
// ───────────────────────────────────────────────────────────────────────────

describe("30d 那一档失败得诚实", () => {
  /**
   * 那条裁定：Cloudflare 的两页官方文档在「一次调用能发多少次子请求」上互相对不上
   * （Workers limits 页免费档 **50**，KV limits 页 **1,000**，而前者从头到尾没定义
   * KV 算哪一行）。⇒ **任何注释都不许写成「60 次是安全的」**，能做的只有让它
   * **失败得诚实**。
   * ⚠️ 真机冒烟（`scripts/smoke-dual-runtime.sh` 的 ④ 那一格）已经量过「跑不跑得完」
   * 那一半：本次实测在本地 workerd 上跑得完。**「线上免费档会不会超」那一半仍然没有
   * 答案**（本地 dev 不是线上边缘），所以这一格照旧存在，措辞照旧不许软化——
   * 两句话的射程差别写在 `src/core/admin/usage-stats.ts` 的 `USAGE_DAY_RETAIN` 上方。
   *
   * ⚠️ **模拟的是「第 47 次 get 抛错」而不是「第 1 次」**：第 1 次就抛的话，
   * 「把读到的那部分当成全份交出去」这条错误实现同样交不出东西，这一格会恒绿。
   * 让前 46 次成功、第 47 次抛，两种实现才分叉。
   */
  it("读 30 天时第 47 次 get 抛错：整条仍然是 200，days 是 null，绝不把读到的那 46 个当成全份", async () => {
    const st = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const { get } = await tier2On({ now: () => NOW, storage: st });
    // 前 20 天各放一份真数据，好让「半份当全份」这条实现真的能凑出一段像样的曲线。
    for (let i = 0; i < 20; i++) {
      await seed(st, OLDEST_DAY + i, 0, shardJson(OLDEST_DAY + i, { requests: 3 }));
    }
    await get("/admin/api/usage");                         // 预热
    st.usageGets.length = 0;
    st.failUsageGetAt = 47;

    const res = await get(`/admin/api/usage?from=${OLDEST_MS}&to=${NOW}`);
    expect(res.status, "不许 500：tier / range / pending 三块都还是真的").toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.days, "半份数据不许当成全份交出去").toBeNull();
    expect(body.shards).toBeNull();
    expect(body.total).toBeNull();
    expect(body.note).toBe("read_failed");
    expect(body.tier, "tier 那一格永远不许是 null").toBe("tier2");
    expect(body.range, "range 是算出来的，不受读失败影响").not.toBeNull();
    // 前置条件：这一次真的走到了 30 天那一档（60 个候选键），否则第 47 次根本没发生。
    expect(st.usageGets.length).toBe(60);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ⑥ pending：「刚试过、没写成」不是「没有尾巴」
// ───────────────────────────────────────────────────────────────────────────

describe("pending 块（UsageSink.status() 的三个字段）", () => {
  /**
   * `UsageSink.status()` 上方逐字写着：**`pendingMs` 数的是「距上一次落盘*尝试*多久」，
   * 不是「距上一次写成功多久」**。预算耗尽或存储抛错的那一次 `maybeFlush()` 照样把
   * `lastFlushAt` 推到当下（那是节流要的语义）。
   * ⇒ **`count > 0 && ms ≈ 0` 要读作「刚试过、没写成」，不是「没有尾巴」。**
   *
   * ⚠️ **两种状态放在同一格里跑**（第 5 种假阳性）：只摆失败那一侧的话，
   * 一个「把 `ms === 0` 当成没有尾巴」的实现在成功那一侧同样报 0，看不出差别。
   * 判别力来自「两种状态下 `ms` 都是 0，而 `count` 一个是 1、一个是 0」。
   */
  it("落盘失败之后 pending.count 仍然大于 0 而 pending.ms 是 0 —— 刚试过没写成，不是没有尾巴", async () => {
    let t: number = NOW;
    const st = new UsageReadCounter(new MemoryStorage(undefined, () => t));
    const { get, sink, errors } = await tier2On({ now: () => t, storage: st });

    const hit = () => sink.record({
      protocol: "openai", model: "agnes-2.0-flash", ok: true, stream: false,
      latencyMs: 12, tokensIn: 3, tokensOut: 4,
    });

    // ── ① 失败那一侧：真的 throw（第 2 种假阳性：stub 从不真抛）。
    st.putFails = true;
    hit();
    t += 7_200_001;                                        // 推过一个完整的落盘间隔
    await sink.maybeFlush();
    expect(errors.map((e) => e.phase), "前置条件：那一次落盘要真的失败").toEqual(["flush"]);
    const failed = await (await get("/admin/api/usage")).json() as {
      pending: { count: number; ms: number; budgetExhausted: boolean };
    };
    expect(failed.pending.ms, "落盘*尝试*就在刚才 ⇒ ms 是 0").toBe(0);
    expect(failed.pending.count, "写没写成？没有。那条尾巴还在").toBeGreaterThan(0);

    // ── ② 成功那一侧：同样是「刚落过盘」，ms 同样是 0，而 count 归零。
    st.putFails = false;
    t += 7_200_001;
    await sink.maybeFlush();
    const ok = await (await get("/admin/api/usage")).json() as {
      pending: { count: number; ms: number };
    };
    expect(ok.pending.ms, "两种状态下 ms 都是 0 —— 所以 ms 不是判据").toBe(0);
    expect(ok.pending.count, "判据是 count").toBe(0);
  });

  /**
   * **`budgetExhausted` 必须一起发出去**（全局约束 10：诚实标记由后端字段驱动）：
   * 「预算耗尽」与「存储抛错」这两种失败态在 `count` + `ms` 上长得一模一样，
   * 砍掉它面板就只能猜。
   * ⚠️ 本夹具是 `nodeRuntime()`（`quotaModel: "file"`）⇒ 没有那道闸，它恒 false；
   * 这一格钉的是**字段在不在**，KV 那一侧的真值由
   * `tests/contract/usage-tier2.test.ts` 的
   * 「status() 的三个字段：budgetExhausted 在第 13 次 put 之后才翻真……」守着。
   */
  it("pending 里带着 budgetExhausted —— 少了它，预算耗尽与存储抛错在面板上没法区分", async () => {
    const { get } = await tier2On({ now: () => NOW });
    const body = await (await get("/admin/api/usage")).json() as {
      pending: Record<string, unknown>;
    };
    expect(Object.keys(body.pending).sort()).toEqual(["budgetExhausted", "count", "ms"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ⑦ 单日下钻
// ───────────────────────────────────────────────────────────────────────────

describe("GET /admin/api/usage/:date（单日下钻）", () => {
  /**
   * `mergeDayShards` 把每个分片的 `hours` **无差别地加在一起**，所以多日区间下
   * `hours["13"]` 是「区间里所有天的 13 点之和」（`src/core/admin/usage-stats.ts`
   * 的 `mergeDayShards` 上方把这条列成了硬契约）。
   * ⇒ **单日下钻必须只把那一天的分片喂进去。**
   *
   * ⚠️ **夹具刻意在相邻两天的同一个小时上都放了数**（第 1 种假阳性：A/B 同值）：
   * 两天给同一个小时不同的值，把整段区间喂进去的实现会得到 7 而不是 5。
   */
  it("单日下钻只把那一天的分片喂进合并 —— hours 是这一天的，不是区间里所有天的同一小时之和", async () => {
    const st = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const { get } = await tier2On({ now: () => NOW, storage: st });
    await seed(st, DAY0, 0, shardJson(DAY0, {
      requests: 5, hours: JSON.stringify({ "13": bucket({ requests: 5 }) }),
    }));
    await seed(st, DAY0 - 1, 0, shardJson(DAY0 - 1, {
      requests: 2, hours: JSON.stringify({ "13": bucket({ requests: 2 }) }),
    }));

    const res = await get(`/admin/api/usage/${DAY0_DATE}`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      date: string; hours: Record<string, { requests: number }>; shards: number; note: string;
    };
    expect(body.date).toBe(DAY0_DATE);
    expect(body.hours["13"]!.requests, "把前一天也算进来的话这里是 7").toBe(5);
    expect(body.shards).toBe(1);
    expect(body.note).toBe("no_request_detail");
  });

  /**
   * **没有逐请求流水**（设计 §10.6）。这条 code 让面板能渲染那句
   * 「需要逐请求粒度请看容器 stdout / Cloudflare Workers Logs」，
   * **而不是给一张永远空着的表**。
   */
  it("常态下 note 是 no_request_detail —— 面板据它指路，而不是画一张永远空着的表", async () => {
    const { get } = await tier2On({ now: () => NOW });
    const body = await (await get(`/admin/api/usage/${DAY0_DATE}`)).json() as { note: string };
    expect(body.note).toBe("no_request_detail");
  });

  /**
   * ⚠️⚠️ **这一格钉的是 `mergeDayShards` 交出来的那三个 map 是无原型对象
   * （`Object.create(null)`）这条硬契约的消费者一侧**——那条契约在本任务之前
   * **没有任何机器守着**（该函数上方原话：「消费者还不存在，所以既没有类型上的区分，
   * 也没有一格用例」）。
   *
   * 两个方向都由这一格接住，**而第二个方向只对一半，写清楚**（本任务变异实测）：
   * · handler 在那三个 map 上调 `Object.prototype` 的方法（`.hasOwnProperty(k)` /
   *   `.toString()`）⇒ **直接 `TypeError`** ⇒ 这条端点 500，本格红（变异 ⇒ 多格红，含本格）；
   * · handler **逐键赋值**搬进普通 `{}`（`out[k] = m[k]`）⇒ `__proto__` 那一条
   *   **彻底消失**，本格红（逐键赋值那一版 ⇒ **只有本格红**）。
   * ⚠️ **但用展开搬（`{ ...m }`）不会坏，本格也抓不住**——展开走
   *   `CreateDataPropertyOrThrow`，绕过 `Object.prototype.__proto__` 那个访问器，
   *   四个键一个不少（变异实测：**整份全绿，完整逃逸**）。
   *   那不是漏网，是**那个写法本来就不是缺陷**；记在这里免得下一个人拿它当反例
   *   去证明这一格没用。
   *
   * ⚠️ **夹具必须经 `JSON.parse` 造**：`{ "__proto__": x }` 写成对象字面量时
   * JS 去改的是原型而不是加键，那样这一格根本摆不出想验的那个状态。
   */
  it("模型名叫 __proto__ / toString / hasOwnProperty / constructor 时，四条都原样出现在响应里", async () => {
    const st = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const { get } = await tier2On({ now: () => NOW, storage: st });
    const byModel = String.raw`{"__proto__":{"requests":7,"success":7,"errors":0,"tokensIn":0,"tokensOut":0,"streamingRequests":0,"latencySum":0,"latencyCount":0},"toString":{"requests":3,"success":3,"errors":0,"tokensIn":0,"tokensOut":0,"streamingRequests":0,"latencySum":0,"latencyCount":0},"hasOwnProperty":{"requests":2,"success":2,"errors":0,"tokensIn":0,"tokensOut":0,"streamingRequests":0,"latencySum":0,"latencyCount":0},"constructor":{"requests":1,"success":1,"errors":0,"tokensIn":0,"tokensOut":0,"streamingRequests":0,"latencySum":0,"latencyCount":0}}`;
    await seed(st, DAY0, 0, shardJson(DAY0, { requests: 13, byModel }));

    const res = await get(`/admin/api/usage/${DAY0_DATE}`);
    expect(res.status, "在无原型对象上调 Object.prototype 的方法会直接抛").toBe(200);
    const body = await res.json() as { byModel: Record<string, { requests: number }> };
    expect(Object.keys(body.byModel).sort())
      .toEqual(["__proto__", "constructor", "hasOwnProperty", "toString"]);
    // 逐格取值：只数键名的话，「那一格被算成一堆 NaN」这半仍然逃得掉。
    const own = (k: string) => Object.getOwnPropertyDescriptor(body.byModel, k)?.value as
      { requests: number } | undefined;
    expect(own("__proto__")?.requests).toBe(7);
    expect(own("toString")?.requests).toBe(3);
    expect(own("hasOwnProperty")?.requests).toBe(2);
    expect(own("constructor")?.requests).toBe(1);
  });

  it.each([
    ["不是日期", "abc"],
    ["少一位", "2024-1-4"],
    ["日历上不存在的一天", "2024-02-31"],
    ["月份越界", "2024-13-01"],
  ])("date %s ⇒ 400，不做善意纠正", async (_label, raw) => {
    const { get } = await tier2On({ now: () => NOW });
    const res = await get(`/admin/api/usage/${raw}`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { type?: string } };
    expect(body.error?.type).toBe("invalid_request_error");
  });

  /**
   * **「那天已经不在了」与「那天没有请求」是两件事**（全局约束 9）。
   * 报成 `no_shards` 的话，运维会以为那天真的没人用这台网关。
   * ⚠️ 判别状态取的是**保留期起点的前一天**（`19970`）——取一个很远的日期时，
   * 「有没有真的算过保留期」这一维不可观测（`usageCandidateKeys` 的夹逼会把两者
   * 都变成空数组）。
   */
  it("落在保留期之外的那一天：note 是 date_out_of_retention，不是 no_shards", async () => {
    const { get } = await tier2On({ now: () => NOW });
    const outside = await (await get("/admin/api/usage/2024-09-04")).json() as {
      note: string; hours: unknown;
    };
    expect(outside.note).toBe("date_out_of_retention");
    expect(outside.hours, "拿不到就如实说拿不到").toBeNull();
    // 紧挨着的那一天（保留期最老的一天）必须是正常那一支——否则上一句断言只是
    // 「随便一个日期都 out_of_retention」，什么都没证明。
    const inside = await (await get(`/admin/api/usage/${OLDEST_DATE}`)).json() as { note: string };
    expect(inside.note).toBe("no_request_detail");
  });

  it("未来的那一天同样是 date_out_of_retention —— 不许凭空给出一份 0", async () => {
    const { get } = await tier2On({ now: () => NOW });
    const body = await (await get("/admin/api/usage/2024-10-05")).json() as { note: string };
    expect(body.note).toBe("date_out_of_retention");
  });

  it("统计没开时单日下钻也是 tier off，三个 map 一起是 null，且一次存储读都没有", async () => {
    const { get, storage } = await tier2Off({ now: () => NOW });
    await get(`/admin/api/usage/${DAY0_DATE}`);            // 预热
    const before = storage.snapshot();
    const res = await get(`/admin/api/usage/${DAY0_DATE}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.tier).toBe("off");
    expect(body.hours).toBeNull();
    expect(body.byModel).toBeNull();
    expect(body.byProtocol).toBeNull();
    expect(body.note).toBe("tier2_off");
    expect(storage.snapshot().usage - before.usage).toBe(0);
  });

  it("单日下钻读不出来时：三个 map 与 shards / malformed 一起是 null，note 是 read_failed", async () => {
    const st = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const { get } = await tier2On({ now: () => NOW, storage: st });
    st.failUsageGetAt = 1;
    const res = await get(`/admin/api/usage/${DAY0_DATE}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.hours).toBeNull();
    expect(body.shards).toBeNull();
    expect(body.malformed).toBeNull();
    expect(body.note).toBe("read_failed");
  });

  /**
   * `mergeDayShards` 的 `malformed` 是给面板看的：**静默丢弃就是撒谎**。
   * ⚠️ 夹具用的是**数组冒充桶**那一档（`total: []`）——`typeof [] === "object"`
   * 且 `[]` 是 truthy，只判 `typeof` 的窄化会把它记成一个合法分片
   * （`src/core/admin/usage-stats.ts` 的 `narrowBucket` 上方那段），
   * 那样这一格会数到 `shards: 1, malformed: 0`。
   */
  it("读到畸形分片时面板拿得到条数 —— 静默丢弃就是撒谎", async () => {
    const st = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const { get } = await tier2On({ now: () => NOW, storage: st });
    await seed(st, DAY0, 0, String.raw`{"shardId":"u2","day":20000,"total":[]}`);
    await seed(st, DAY0, 1, shardJson(DAY0, { requests: 4 }));
    const body = await (await get(`/admin/api/usage/${DAY0_DATE}`)).json() as {
      shards: number; malformed: number;
    };
    expect(body.shards).toBe(1);
    expect(body.malformed).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ⑧ note 的枚举、一致性，与「同一份知识只许有一个出口」
// ───────────────────────────────────────────────────────────────────────────

describe("note 是 code 不是句子", () => {
  /**
   * `note` 写成运行期数组（不是纯类型联合）的理由与 `src/core/dispatcher.ts` 的
   * `FAIL_REASONS` 逐字相同：一个只存在于类型系统里的联合，**测试没法穷举它**。
   *
   * 这一格把七条 code 各自摆出来跑一遍，再与那张表双向比对：
   * 少一条 ⇒ 面板会拿到一个查不到的 key；多一条 ⇒ 字典里有永远用不上的文案，
   * 而五语言字典里一条没人用的文案没有任何机器守得住它的正确性。
   */
  it("USAGE_NOTES 里每一条 code 都真的被某一条端点产出过 —— 一条永远产不出来的 code 会让面板字典里多一条永远用不上的文案，而少一条会让面板拿到一个查不到的 key", async () => {
    const seen = new Set<string>();
    const take = async (res: Response) => {
      const b = await res.json() as { note: string | null };
      if (b.note !== null) seen.add(b.note);
    };

    const off = await tier2Off({ now: () => NOW });
    await take(await off.get("/admin/api/usage"));                          // tier2_off

    let t: number = NOW;
    const broken = await tier2On({ now: () => t });
    t = NaN;
    await take(await broken.get("/admin/api/usage"));                       // clock_unavailable

    const failing = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const g1 = await tier2On({ now: () => NOW, storage: failing });
    failing.failUsageGetAt = 1;
    await take(await g1.get("/admin/api/usage"));                           // read_failed

    const g2 = await tier2On({ now: () => NOW });
    await take(await g2.get(`/admin/api/usage?from=0&to=${NOW}`));          // range_clamped
    await take(await g2.get(`/admin/api/usage?from=${NOW}&to=${NOW}`));     // no_shards
    await take(await g2.get("/admin/api/usage/2024-09-04"));                // date_out_of_retention
    await take(await g2.get(`/admin/api/usage/${DAY0_DATE}`));              // no_request_detail

    const corrupt = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const g3 = await tier2On({ now: () => NOW, storage: corrupt });
    await seed(corrupt, DAY0, 0, String.raw`{"shardId":"u2","day":20000,"total":[]}`);
    await take(await g3.get(`/admin/api/usage?from=${NOW}&to=${NOW}`));     // all_malformed

    const half = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const g4 = await tier2On({ now: () => NOW, storage: half });
    await seed(half, DAY0, 0, shardJson(DAY0, { requests: 5 }));
    await seed(half, DAY0, 1, String.raw`{"shardId":"u2","day":20000,"total":[]}`);
    await take(await g4.get(`/admin/api/usage?from=${NOW}&to=${NOW}`));     // partial_malformed

    expect([...seen].sort()).toEqual([...USAGE_NOTES].sort());
  });

  /**
   * **`note` 是摘要，不是第二个真源。** 每一条 code 的判据都来自同一份响应体里的
   * 其它字段，由同一个 handler 在同一处算出。前端读 note 还是读那些字段都行，
   * **但两者不许打架**——那是本仓一贯反对的「同一份知识两个出口」在一个响应体内部
   * 的版本，而它比跨端点那种更难发现。
   */
  it("note 与它自己的判据字段恒一致 —— note 是摘要不是第二个真源", async () => {
    const cases: Array<() => Response | Promise<Response>> = [];
    const off = await tier2Off({ now: () => NOW });
    cases.push(() => off.get("/admin/api/usage"));

    const failing = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const g1 = await tier2On({ now: () => NOW, storage: failing });
    failing.failUsageGetAt = 1;
    cases.push(() => g1.get("/admin/api/usage"));

    const g2 = await tier2On({ now: () => NOW });
    cases.push(() => g2.get(`/admin/api/usage?from=0&to=${NOW}`));
    cases.push(() => g2.get(`/admin/api/usage?from=${NOW}&to=${NOW}`));

    const seeded = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const g3 = await tier2On({ now: () => NOW, storage: seeded });
    await seed(seeded, DAY0, 0, shardJson(DAY0, { requests: 9 }));
    cases.push(() => g3.get(`/admin/api/usage?from=${NOW}&to=${NOW}`));

    // ⑦ 分片都在但全是畸形的（评审发现）。**必须进这一组**：少了它，
    //    `all_malformed` 那条双条件的右半永远是 false，等于没验。
    const broken = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const g4 = await tier2On({ now: () => NOW, storage: broken });
    await seed(broken, DAY0, 0, String.raw`{"shardId":"u2","day":20000,"total":[]}`);
    cases.push(() => g4.get(`/admin/api/usage?from=${NOW}&to=${NOW}`));

    // ⑧ 一部分分片畸形（定向复评）。**同理必须进这一组**。
    const partial = new UsageReadCounter(new MemoryStorage(undefined, () => NOW));
    const g5 = await tier2On({ now: () => NOW, storage: partial });
    await seed(partial, DAY0, 0, shardJson(DAY0, { requests: 5 }));
    await seed(partial, DAY0, 1, String.raw`{"shardId":"u2","day":20000,"total":[]}`);
    cases.push(() => g5.get(`/admin/api/usage?from=${NOW}&to=${NOW}`));

    // **被夹 + 有畸形分片**（定向复评）。**这一条是下面那两行双条件里
    //「不带 `!clamped`」那一半唯一能被观测到的状态** —— 少了它，畸形族与
    // `range_clamped` 谁先谁后在数学上等价（第 5 种假阳性）。
    cases.push(() => g5.get(`/admin/api/usage?from=0&to=${NOW}`));

    for (const run of cases) {
      const b = await (await run()).json() as {
        tier: string; range: { clamped: boolean } | null;
        days: unknown[] | null; shards: number | null; malformed: number | null;
        note: string | null;
      };
      const label = JSON.stringify(b.note);
      const clamped = b.range?.clamped ?? false;
      expect(b.note === "tier2_off", `${label}：tier2_off ⟺ tier === "off"`)
        .toBe(b.tier === "off");
      expect(b.note === "read_failed", `${label}：read_failed ⟺ tier2 开着而 days 是 null`)
        .toBe(b.tier === "tier2" && b.days === null && b.range !== null);
      // ⚠️ **右半带着 `malformed === 0`，那是优先级订正的直接后果**（定向复评）：
      //    畸形族排在 `range_clamped` **之上**，所以「被夹了」不再蕴含
      //    `note === "range_clamped"`。上一版这里写的是干净的
      //    `⟺ range.clamped`，**改优先级时它当场变红** —— 那正是想要的。
      expect(b.note === "range_clamped", `${label}：range_clamped ⟺ 被夹了、且没有畸形分片`)
        .toBe(b.range !== null && clamped && b.malformed === 0);
      // ⚠️ 这两条的右半带着 `!clamped`，那是优先级 `range_clamped > all_malformed >
      //    no_shards` 的直接后果（判据写在 `usageHandler` 上方那张表底下）。
      //    优先级一改，这两条会当场红——那正是想要的。
      // ⚠️ **畸形那两条的右半刻意**不带** `!clamped`**（定向复评）：
      //    它们的优先级在 `range_clamped` **之上**，所以被夹过也照样报它们。
      //    这两行与那条优先级是**同一件事的两种写法**，顺序一改这里就红。
      expect(b.note === "all_malformed", `${label}：all_malformed ⟺ 读成功了、shards 是 0、而 malformed 大于 0`)
        .toBe(b.days !== null && b.shards === 0 && (b.malformed ?? 0) > 0);
      expect(b.note === "partial_malformed", `${label}：partial_malformed ⟺ 读成功了、shards 大于 0、而 malformed 也大于 0`)
        .toBe(b.days !== null && (b.shards ?? 0) > 0 && (b.malformed ?? 0) > 0);
      expect(b.note === "no_shards", `${label}：no_shards ⟺ 读成功了、shards 与 malformed 都是 0、且没被夹`)
        .toBe(b.days !== null && b.shards === 0 && b.malformed === 0 && !clamped);
      // ⚠️⚠️ **`note === null` 也必须有判据 —— 少了这一行就是上一轮那条发现的逃逸口**
      //    （定向复评的根因：五条 code 各有双条件，而「一切正常」那一支没有，
      //    于是任何一种没被列出来的状态都能悄悄落进 `null` 而不被任何东西发现）。
      expect(b.note === null, `${label}：null ⟺ 读成功了、有好分片、没有畸形分片、且没被夹`)
        .toBe(b.days !== null && (b.shards ?? 0) > 0 && b.malformed === 0 && !clamped);
    }
  });

  /**
   * **同一份知识只许有一个出口**（评审发现）：`tokensCoverage` 只从
   * `GET /admin/api/capabilities` 的 `stats` 里发。两个出口一出现，前端就要面对
   * 「读哪一个」这个不该存在的问题，而两边迟早会分叉。
   */
  it("用量端点不带 tokensCoverage —— 同一份知识只许有一个出口", async () => {
    const { get } = await tier2On({ now: () => NOW });
    const summary = await (await get("/admin/api/usage")).json() as Record<string, unknown>;
    const daily = await (await get(`/admin/api/usage/${DAY0_DATE}`)).json() as Record<string, unknown>;
    expect(summary).not.toHaveProperty("tokensCoverage");
    expect(daily).not.toHaveProperty("tokensCoverage");
    // 反向自检：它确实在另一个出口上（否则这一格只是「两边都没有」）。
    const caps = await (await get("/admin/api/capabilities")).json() as {
      stats: { tokensCoverage: string[] };
    };
    expect(caps.stats.tokensCoverage.length).toBeGreaterThan(0);
  });

  /**
   * `capabilities.stats.tier2Enabled` 与 `usage.tier` 说的是同一件事，而它们今天
   * 各走一条 `AdminRouterDeps`（`usageStatsEnabled` 与 `usage`）。
   * 两者同真同假靠的是 `createApp` 里两行都从同一个 `usageSink` 变量算出来，
   * **那不是一条约束**（`src/http/admin/router.ts` 的 `usageStatsEnabled` 上方登记着）。
   * ⇒ **本格在自己体内把开着与关着两侧各跑一遍**（一格用例、两个状态，不是两格
   * ——只跑一侧的话「`tier` 恒等于某个常量」的实现照样全绿）：分叉的后果是
   * 面板照 capabilities 画了图表，而用量端点回 `tier: "off"`。
   */
  it("capabilities 的 tier2Enabled 与 usage 的 tier 说的是同一件事 —— 两边不许分叉", async () => {
    for (const [label, make] of [
      ["开着", () => tier2On({ now: () => NOW })],
      ["关着", () => tier2Off({ now: () => NOW })],
    ] as const) {
      const { get } = await make();
      const caps = await (await get("/admin/api/capabilities")).json() as {
        stats: { tier2Enabled: boolean };
      };
      const usage = await (await get("/admin/api/usage")).json() as { tier: string };
      expect(usage.tier, label).toBe(caps.stats.tier2Enabled ? "tier2" : "off");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ⑨ record 期与 flush 期是两条错误通道（认账修正）
// ───────────────────────────────────────────────────────────────────────────

describe("record 期出错与 flush 期出错说的不是同一句话", () => {
  /**
   * **在这条修正之前，两者共用 `storage.usage_flush_failed` 与「累加器保留，
   * 下一次落盘会带上」那一句文案，而对 record 期那一类，那句承诺是假的**：
   * `record()` 里可能抛的那些步骤全排在任何一次写入累加器之前
   * （`src/http/usage-sink.ts` 的 `record()` 上方写着这条顺序的理由），
   * 所以抛出去之后累加器一个字节都没变、`dirty` 也没被置上
   * ⇒ **那一条计数永久消失，下一次落盘不会也没法把它补上。**
   *
   * ⚠️⚠️ **抛点用的是「注入的时钟」，而这不是随便挑的一个替身 —— 它是今天唯一
   * 还够得着的那一个，理由必须写下来**（本任务实测）：
   * 拿 `JSON.parse('{"toString":1,"valueOf":1}')` 当 `model` 打过去，
   * **`onError` 一次都没被调到** —— `boundUsageKey` 那一步走的是
   * `src/core/admin/usage-stats.ts` 里的 `safeString()` 兜底，`record()` 根本没抛，
   * 那一条计数照常记进了累加器（实测：`errors` 是 `[]`、`pending` 从 1 涨到 2）。
   * ⇒ 这条 catch 今天是**一个还没被走到的陷阱**，不是一条活着的缺陷。
   * **别把这一格读成「修了一个正在咬人的问题」**，它守的是「`safeString` 哪天被谁
   * 删掉的那一天，说出去的话是真的」。
   *
   * ⚠️ **判别力不在「onError 被调了几次」这种形状断言上**（第 4 种假阳性），
   * 而在两处：① `phase` 真的分得开；② record 抛错之后 `pending` **一点都没涨**
   * ——那正是「这条计数没进累加器」的可观测形态。
   */
  it("record 期出错时那条计数永久丢了：phase 是 record，且 pending 一点都没涨", async () => {
    let t: number = NOW;
    let clockBroken = false;
    /** **只给 sink 与 app 用**；`MemoryStorage` 的 TTL 时钟另走 `() => t`，不受影响。 */
    const now = () => { if (clockBroken) throw new Error("clock exploded"); return t; };
    const st = new UsageReadCounter(new MemoryStorage(undefined, () => t));
    const { sink, errors } = await tier2On({ now, storage: st });

    const one = {
      protocol: "openai", model: "ok-model", ok: true, stream: false,
      latencyMs: 1, tokensIn: 0, tokensOut: 0,
    };
    // 先记一条正常的，好让 pending 有一个非零基线（否则「没涨」与「本来就是 0」同值）。
    sink.record(one);
    const before = sink.status().pending;
    expect(before, "前置条件：基线要非零").toBe(1);

    clockBroken = true;
    sink.record(one);
    clockBroken = false;

    expect(errors.map((e) => e.phase)).toEqual(["record"]);
    expect(sink.status().pending, "record 抛错之后累加器一个字节都没变 ⇒ 那条计数永久丢了")
      .toBe(before);

    // 对照：flush 期出错走的是另一个 phase。**两个阶段在同一格里都摆出来**，
    // 只摆一个的话「phase 恒等于某个常量」这种实现照样绿（第 1 种假阳性）。
    st.putFails = true;
    t += 7_200_001;
    await sink.maybeFlush();
    expect(errors.map((e) => e.phase)).toEqual(["record", "flush"]);
  });

  /**
   * 「record 期出错时那条计数永久丢了：phase 是 record，且 pending 一点都没涨」
   * 钉的是 `phase` 传得对不对；**这一格钉的是它被翻译成哪一条事件、
   * 哪一句文案**——那才是运维真正读到的东西。
   *
   * ⚠️ **两个阶段都要断言，而 record 那一条今天在端到端上不可达**
   *（实测见「record 期出错时那条计数永久丢了：phase 是 record，且 pending 一点都没涨」），
   * 所以判据落在那张查表上（`USAGE_ERROR_REPORT`，与 `router.ts` 的 `REJECT_MESSAGE`
   * 同一套做法），并**另外证明这张表真的被装配层用上了**——只验表不验接线的话，
   * 一个把 wire.ts 改回写死文案的改动照样绿。
   */
  it("record 期出错与 flush 期出错走两条不同的事件，文案不许互相冒充", async () => {
    // ── ① 表本身：两条 code、两句话，且 record 那句不许承诺「会补上」。
    expect(Object.keys(USAGE_ERROR_REPORT).sort()).toEqual(["flush", "record"]);
    expect(USAGE_ERROR_REPORT.record.event).toBe("usage.record_failed");
    expect(USAGE_ERROR_REPORT.flush.event).toBe("storage.usage_flush_failed");
    expect(USAGE_ERROR_REPORT.record.event).not.toBe(USAGE_ERROR_REPORT.flush.event);
    // ⚠️ 判据取的是 flush 那句话里**做出承诺的那一小段**，不是「出现过『下一次落盘』
    // 这四个字」——record 那句自己也提了下一次落盘（「下一次落盘**也不会**把它补上」），
    // 用后者当判据会把一句正确的话判成错的。
    expect(USAGE_ERROR_REPORT.record.msg, "record 期不许承诺「下一次落盘会把这一段带上」——那是假的")
      .not.toContain("会把这一段带上");
    expect(USAGE_ERROR_REPORT.record.msg).toContain("永久丢失");
    expect(USAGE_ERROR_REPORT.record.msg).toContain("不会把它补上");
    expect(USAGE_ERROR_REPORT.flush.msg).toContain("下一次落盘会把这一段带上");

    // ── ② 接线：走 `buildApp`（真装配），从 `ConsoleLogger` 那一路截。
    //    flush 那条是今天唯一端到端可达的，用它证明这张表真的接上了。
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      let t: number = NOW;
      const st = new UsageReadCounter(new MemoryStorage(undefined, () => t));
      const { app } = await buildApp(
        { GATEWAY_TOKEN: "t", ADMIN_TOKEN: TEST_ADMIN_TOKEN, USAGE_STATS_ENABLED: "true" },
        st, nodeRuntime(), { now: () => t, newShardId: () => "u2" },
      );
      // 池子空 ⇒ 转发直接 503 `pool_empty`，一个出站请求都不发，而 Tier-2 该记的
      // 终态一样不少（`ok: false` 也是终态）。
      const hit = () => app.request("/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ model: "ok-model", messages: [] }),
      });
      await hit();
      st.putFails = true;
      t += 7_200_001;
      await hit();
      const flushLines = lines.filter((l) => l.includes(USAGE_ERROR_REPORT.flush.event));
      expect(flushLines.length, "flush 期出错要真的说一声").toBeGreaterThan(0);
      expect(flushLines[0]).toContain("phase=flush");
      expect(flushLines[0]).toContain(USAGE_ERROR_REPORT.flush.msg);
      expect(
        lines.some((l) => l.includes(USAGE_ERROR_REPORT.record.event)),
        "两条事件不许混：flush 期出错时绝不能打成 record",
      ).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
