import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/http/wire.js";
import { nodeRuntime } from "../../src/adapters/runtime-node.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { makeApp, TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { UsageSink } from "../../src/http/usage-sink.js";
import { resolveUsageFlushInterval } from "../../src/http/usage-sink.js";
import { workerRuntime } from "../../src/adapters/runtime-worker.js";
import {
  USAGE_FLUSH_MIN_INTERVAL_MS, USAGE_WRITES_PER_DAY, mergeDayShards, type UsageDayShard,
} from "../../src/core/admin/usage-stats.js";
import type { Storage } from "../../src/ports/storage.js";

/**
 * Tier-2 用量统计的接线契约。
 *
 * **contract ⇒ node 与 workerd 各跑一遍**（`tests/global-setup.ts` 的 `POLICY` 强制）。
 * 这正是本组该在的地方：Tier-2 的落盘时机是计划点名的三个「双运行时上不是照抄
 * 一份就行」的地方之一，而本任务给出的答案是**两种运行时同一条代码路径**
 *（请求收尾 `await`，不是 `ctx.waitUntil`、不是定时器）⇒ **同一份断言必须在两边都成立**。
 *
 * ── 两组，切分点是「谁决定 sink 建不建」 ──────────────────────────────────
 * ① **接线组**走 `buildApp`（真装配）：`USAGE_STATS_ENABLED` → 建不建 sink → 写不写盘。
 *    这一段只有 `wire.ts` 有，`createApp` 看不见那个环境变量。
 * ② **落盘契约组**直接驱动 `UsageSink`（**生产那个类本身，不是抄件**）：
 *    预算、跨天、失败保留、TTL。这些性质要摆出「一次 flush 面对 20 个待落盘的日」
 *    这类状态，而经 HTTP 摆不出来——每个请求都会顺手 flush 一次。
 *
 * ⚠️ **所有期望值都是手写字面量**（第 6 种假阳性）。两处需要说明来历：
 * · `slot = 1`：`usageSlotOf("u2")` 的值。**刻意不用会落到槽位 0 的 shardId**
 *   （`"u1"`/`"s1"` 都是 0）——落 0 的话「槽位写死成 0」这条实现不可观测（评审当时实测过）。
 * · `expiresAt = 1_730_678_400_000`：`(20000 + 30 + 1) × 86_400_000`，
 *   即 `20031 × 86_400_000`。**在测试外面手算的**，不是从 `usageExpiresAt` 取回来的
 *   ——取回来就是同义反复。
 */

/** UTC 日序号。选一个远离纪元零点的真实量级，免得「日」这一维退化成 0 而不可观测。 */
const DAY0 = 20_000;
const DAY_MS = 86_400_000;
const DAY0_MS = DAY0 * DAY_MS;
/**
 * 「等链上其它挂起点结清」那一格的预算（收口复评）。
 *
 * `WAIT_ROUNDS` 轮 × 每轮一次被钳到约 1 毫秒的 `setTimeout(0)` ⇒ 约 3 秒；
 * `WAIT_TIMEOUT_MS` 把它连同请求本身一起兜住，**并且刻意留出余量**，
 * 好让「等不够」以**超时红掉**的形式暴露，而不是悄悄变绿。
 */
const WAIT_ROUNDS = 3000;
const WAIT_TIMEOUT_MS = 15_000;

/** `usageSlotOf("u2")`，手算见文件头。 */
const SHARD = "u2";
const SLOT = 1;
const KEY_DAY0 = `usage:${DAY0}:${SLOT}`;
const KEY_DAY1 = `usage:${DAY0 + 1}:${SLOT}`;

/**
 * 按 key 分开数的 put 计数器。
 *
 * **必须按 key 分**：同一个存储上还有 key 池状态回写与事件分片在写，
 * 混成一个「puts」会让「Tier-2 写了几次」这个问题永远答不准——而本组几乎每一格
 * 的观测点都正是那个数（全局约束的变红条件逐字就是
 * 「`USAGE_STATS_ENABLED` 为假时有任何一次 `storage.put`」）。
 */
class UsagePutCounter implements Storage {
  /** 落到 `usage:` 前缀上的那些 put 的 key，**按发生顺序**。在 put **被调用**那一刻记。 */
  readonly usagePuts: string[] = [];
  /**
   * 已经**真正写完**的 `usage:` put 次数。
   *
   * ⚠️ **它与 `usagePuts.length` 不是同一个数，这条区别是本文件唯一能观测
   * 「中间件到底 `await` 没 `await`」的地方**（第 8 种假阳性的正主）：
   * `usagePuts.push` 发生在 `put()` **被调用**的那一刻，而 `void flush()` 这种
   * fire-and-forget 同样会把调用发出去 ⇒ 两种实现在 `usagePuts` 上一模一样。
   * 只有「写完了没有」能分辨，而它要求替身有一个**真实的挂起点**（`delayMs`）。
   */
  usagePutsDone = 0;
  /** 所有 put 的次数，含 key 池与事件分片。 */
  allPuts = 0;
  /** 置真之后每一次 put 都**真的 throw**（第 2 种假阳性：stub 从不真抛）。 */
  putFails = false;
  /**
   * **非 `usage:` 的存储操作里，此刻还有几个没返回。**
   *
   * ⚠️ **它是「链上其它挂起点跑完了没有」的事件驱动信号**（定向复评）：
   * 上一版那格时序用例靠「50 轮宏任务 + 一次 20ms」去等，**那不是摆脱了时序依赖，
   * 只是把阈值从约 1 毫秒抬到了约 70 毫秒** —— 把 `MemoryStorage` 的 `delayMs`
   * 调到 200，那条 fire-and-forget 变异就又逃逸了，**我点名要消灭的失效形态原样保留**。
   * 数在途数之后，判据变成「等到它归零并稳住」，**与任何一个挂起点有多长无关**。
   */
  otherInFlight = 0;
  /** 最近一次 put 收到的 `expiresAt`（`undefined` = 调用方压根没传第三参）。 */
  lastExpiresAt: number | undefined;
  /**
   * `usage:` 那一类 put 的**手动闸门**：设了就在写下去之前 `await` 它。
   *
   * ⚠️ **它取代了上一版那个「40 毫秒延迟」的做法，这个替换是评审 m4 要求的，
   * 而那一版确实是一场时长竞赛**：起初给存储一个统一的 1 毫秒延迟，
   * 「用量 flush 没 `await`」这条变异**逃逸**了——`usageFlush` 的收尾之后紧接着还有
   * `logFlush` 的收尾，后者同样要做一次带 1 毫秒延迟的存储写，
   * **那 1 毫秒恰好够 fire-and-forget 的用量写完成**；换成 40 毫秒之后才红，
   * 也就是说那一格是靠约 13 倍的时序余量成立的，**哪天链上多一个更慢的挂起点，
   * 它会静默退回第 9 种假阳性**。
   *
   * 闸门没有这个问题：正确实现（`await flush()`）**在闸门放开之前永远回不了响应**，
   * 所以用例想等多久都行——等得越久结论越强；而 fire-and-forget 的实现**不会被闸门挡住**
   *（它照样要等完链上其它挂起点，所以**不是「立刻」返回**——上一版这里写的正是「立刻」，
   * 而 `delayMs = 200` 时它要等 `logFlush` 跑完才返回，那句话是假的）。
   * 判别力来自「有没有被闸门挡住」，不是「谁比谁快」；
   * 「其它挂起点跑完了没有」由 `otherInFlight` 事件驱动地判，不数毫秒。
   */
  usagePutGate: (() => Promise<void>) | null = null;
  constructor(readonly inner: Storage) {}
  async get<T>(k: string): Promise<T | null> {
    this.otherInFlight++;
    try { return await this.inner.get<T>(k); } finally { this.otherInFlight--; }
  }
  async put<T>(k: string, v: T, expiresAt?: number): Promise<void> {
    const isUsage = k.startsWith("usage:");
    this.allPuts++;
    if (isUsage) { this.usagePuts.push(k); this.lastExpiresAt = expiresAt; }
    if (this.putFails) throw new Error("write quota exhausted");
    if (isUsage && this.usagePutGate !== null) await this.usagePutGate();
    if (!isUsage) this.otherInFlight++;
    try { await this.inner.put(k, v, expiresAt); } finally { if (!isUsage) this.otherInFlight--; }
    if (isUsage) this.usagePutsDone++;
  }
  async delete(k: string): Promise<void> { return this.inner.delete(k); }
  async list(p: string): Promise<string[]> {
    this.otherInFlight++;
    try { return await this.inner.list(p); } finally { this.otherInFlight--; }
  }
}

/**
 * 一个走**真装配**的网关，时钟可控。
 *
 * ⚠️ **`delayMs: 1`**（第 8 种假阳性）：零延迟的存储替身让「写在响应返回前完成」
 * 这条 happens-before 性质不可观测——`await flush()` 与 fire-and-forget 的 `flush()`
 * 在纯同步 Map 上找不出行为差异。带一个真实挂起点之后，中间件若改成不 `await`，
 * 下面那些「响应回来之后立刻数 put」的断言就会数到 0。
 *
 * **池子刻意留空**：`dispatch()` 在没有可用 key 时直接回 503 `pool_empty`，
 * **一个出站请求都不发、一次 key 池写都不产生** ⇒ 这条夹具不需要桩掉网络，
 * 而 Tier-2 该记的东西（协议、模型、成败、延迟）一样不少（`ok: false` 也是终态）。
 */
async function gateway(o: { enabled: boolean; now: () => number }) {
  const storage = new UsagePutCounter(new MemoryStorage(1, o.now));
  const env: Record<string, string | undefined> = { GATEWAY_TOKEN: "t" };
  if (o.enabled) env.USAGE_STATS_ENABLED = "true";
  const { app } = await buildApp(env, storage, nodeRuntime(), {
    now: o.now, newShardId: () => SHARD,
  });
  const hit = () => app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ model: "agnes-2.0-flash", messages: [{ role: "user", content: "ping" }] }),
  });
  return { app, storage, hit };
}

// ───────────────────────────────────────────────────────────────────────────
// ① 接线组：`USAGE_STATS_ENABLED` → 建不建 sink → 写不写盘（走 buildApp 真装配）
// ───────────────────────────────────────────────────────────────────────────

describe("Tier-2 接线（USAGE_STATS_ENABLED → wire.ts）", () => {
  /**
   * **「关」必须是零成本**（全局约束）。
   *
   * ⚠️ **两个方向在同一格里跑，顺序是「先证明夹具真的会落盘，再证明关掉之后不落」。**
   * 只写关着那一侧的话，这条断言在任何「其实压根没到落盘条件」的夹具上都是绿的
   * ——那正是「鉴权失败的非幂等请求必须零副作用」那一格踩过的陷阱：
   * 一个从来没被 arm 过的夹具，无论开关坏没坏都是 0 次写。
   *
   * ⚠️ **观测点是 put 计数，不是「sink 是不是 null」**（第 4 种假阳性：形状断言
   * 冒充行为断言）。全局约束 16 的变红条件逐字就是「为假时有任何一次 `storage.put`」。
   */
  it("USAGE_STATS_ENABLED 不为 true 时：连打 50 次 /v1，usage: 前缀的 put 计数一次都不涨 —— 「关」必须是零成本，否则那条路径迟早会被某次改动接上写", async () => {
    /** 把状态摆到「累加器非空 + 已过落盘间隔」，也就是**真的该落盘**的那一刻。 */
    const arm = async (g: Awaited<ReturnType<typeof gateway>>, bump: () => void) => {
      await g.hit();                 // 攒一条计数（此刻 since = 0，还不到间隔）
      bump();                        // 推过一个完整的落盘间隔
    };

    // ── ① 反向自检：同一套夹具、同一套时序，开着的时候**真的会写**。
    let tOn = DAY0_MS;
    const on = await gateway({ enabled: true, now: () => tOn });
    await arm(on, () => { tOn += USAGE_FLUSH_MIN_INTERVAL_MS + 1; });
    await on.hit();
    expect(
      on.storage.usagePuts.length,
      "前置条件不成立：开着的时候都没能落盘，下面那个 0 就什么都不证明",
    ).toBeGreaterThan(0);

    // ── ② 正向：关着（默认值，env 里根本没有这个键），同样的时序，连打 50 次。
    let tOff = DAY0_MS;
    const off = await gateway({ enabled: false, now: () => tOff });
    await arm(off, () => { tOff += USAGE_FLUSH_MIN_INTERVAL_MS + 1; });
    for (let i = 0; i < 50; i++) await off.hit();
    // 期望值是**手写的 0**，不是从计数器自己反算出来的。
    expect(
      off.storage.usagePuts,
      "Tier-2 关着却写了盘 —— 它与 key 池的状态回写抢同一个每天 1,000 次的写桶",
    ).toEqual([]);
  });

  /**
   * **一个「转不成字符串」的 model 不许把网关打成 500 —— 开着关着都不许**
   *（收口复评，这是上一轮为修另一条发现而加的防御自己制造的回归）。
   *
   * 成因值得记成一条判据：那两行 `String(req.model ?? "")` 加在了路由的 `record`
   * **闭包体里**，而 `recordUsage()` 的「sink 缺席就 return」**在它之后** ⇒
   * 那一行在 **Tier-2 关着**时照样求值 ⇒ 一次抛就把
   * 「关是零成本」（全局约束 16）打破，**把影响面从「开了统计的人」扩大成「所有部署」**。
   * ⇒ **防御要加在「只有开着才跑」的那一侧**，本仓那一侧是 `boundUsageKey()`。
   *
   * ⚠️ **关着那一侧必须单独验**：只验开着的话，把归一化放回路由里照样绿
   *（那正是上一轮的形态）。两侧一格里跑完。
   */
  it("model 是一个转不成字符串的对象时：Tier-2 开着关着都不许 500 —— 归一化若加在路由的闭包体里，它在「统计关着」时也会跑，一次抛就把「关是零成本」打破", async () => {
    // `JSON.parse` 完全造得出：两个转换方法都不是函数，`String()` 对它自己抛。
    const body = {
      model: JSON.parse('{"toString":1,"valueOf":1}') as unknown,
      max_tokens: 64,
      messages: [{ role: "user", content: "ping" }],
      input: "ping",
    };
    for (const enabled of [false, true]) {
      let t = DAY0_MS;
      const g = await gateway({ enabled, now: () => t });
      // ⚠️ **四条协议路由一条都不许漏**（末轮复评）：上一版这个数组只有
      // `/v1/messages` 与 `/v1/responses` 两条——**恰好漏掉了 `openai.ts`，
      // 而那条的强转还在，于是同一个缺陷原样活着，只是换了条路由**。
      // 漏的原因很具体：上一轮的问题清单写的是「那两条路由缺 String()」，
      // 裁定变成「删掉那两道」之后，注意力就停在那份清单上，没回头看第三条。
      // ⇒ **这个数组必须是「四条协议路由」的全集，不是「上一轮被点名的那几条」。**
      for (const path of ["/v1/chat/completions", "/v1/messages", "/v1/responses"]) {
        const res = await g.app.request(path, {
          method: "POST",
          headers: { authorization: "Bearer t", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        // 手写字面量 503（`pool_empty`，池子刻意留空）。**500 = 网关自己抛了。**
        expect(
          res.status,
          `Tier-2 ${enabled ? "开" : "关"}着，${path} 被一个转不成字符串的 model 打成了 ${res.status}`,
        ).toBe(503);
      }
    }
  });

  /**
   * **写量不许随请求数走**，那正是设计 §2 拆掉的那根轴：
   * 每请求写一次 KV 的话，免费档 1,000 次/天的写配额几十个请求就见底，
   * 连 key 的冷却与剔除都写不进去。
   */
  it("开着时：一个落盘间隔内连打 50 次，只落 1 次盘 —— 写量不许随请求数走，那正是设计 §2 拆掉的那根轴", async () => {
    let t = DAY0_MS;
    const g = await gateway({ enabled: true, now: () => t });
    await g.hit();
    t += USAGE_FLUSH_MIN_INTERVAL_MS + 1;
    for (let i = 0; i < 50; i++) await g.hit();
    // 手写字面量：50 次请求 ⇒ 恰好 1 个键、写 1 次。第一次请求跨过间隔触发落盘，
    // 其余 49 次的 `since` 都小于间隔。
    expect(
      g.storage.usagePuts,
      "50 次请求写了不止 1 次 —— 落盘最小间隔那道闸没起作用",
    ).toEqual([KEY_DAY0]);
  });

  /**
   * **落盘必须在响应返回之前完成**（`await`，不是 `ctx.waitUntil`、不是 fire-and-forget）。
   *
   * 这条是「两种运行时同一条代码路径」那个承诺的**全部内容**：Worker 上响应返回后
   * isolate 随时可能停摆，fire-and-forget 的写会被**截断**，而截断是静默的
   *——面板上只会显示「这一段时间没有用量」。`src/http/log-flush.ts` 的文件头
   * 为事件那一侧逐字写过同一句。
   *
   * ⚠️ **观测点必须是「写完了没有」，不是「写调用发出去了没有」**（本任务变异实测）：
   * `void flush()` 与 `await flush()` 在「put 被调用了几次」上**一模一样**，
   * 两者的差别只在完成时刻。⇒ 用 `usagePutsDone`（内层 put resolve 之后才 +1）
   * 配合替身上那个**真实的挂起点**（`MemoryStorage` 的 `delayMs: 1`）。
   * 零延迟替身在这里什么都证明不了：两条路径的 Promise 链会在同一个微任务 tick 里
   * 双双「追上」调用方（第 8 种假阳性，`tests/helpers/fake-storage.ts` 文件头原话）。
   */
  it("落盘在响应返回之前就完成：把那次写卡在闸门上，响应就出不来 —— fire-and-forget 在 Worker 上会被响应返回后的 isolate 停摆静默截断", async () => {
    let t = DAY0_MS;
    const g = await gateway({ enabled: true, now: () => t });
    await g.hit();
    t += USAGE_FLUSH_MIN_INTERVAL_MS + 1;

    // 把 `usage:` 那次写卡住，闸门由本用例亲手放开。
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    g.storage.usagePutGate = () => gate;

    let responded = false;
    const inFlight = (async () => {
      const r = await g.hit();
      responded = true;
      return r;
    })();

    // ★ **等到链上其它挂起点确证跑完，而不是数一个写死的毫秒数**（定向复评）。
    // 判据：非 `usage:` 的存储操作在途数归零，**并且连续若干轮都还是零**（静默）。
    //
    // ⚠️ **它有预算，不是「多久都能等」**（收口复评，上一版那句是假的）：
    // 循环上界 `WAIT_ROUNDS` 轮 × 每轮一次被钳到约 1 毫秒的 `setTimeout(0)`
    // ⇒ 这一格实际能等到的时间约 `WAIT_ROUNDS` 毫秒，而 `WAIT_TIMEOUT_MS` 又给了它
    // 一个上限。**超出预算时它的失效方式是「响亮地红掉」，不是「静默变绿」**
    // ——这正是它比上一版（约 70 毫秒之后静默逃逸）强的地方，也是这里不再改机制、
    // 只把话说准的理由。
    //
    // ⭐ **实测天花板 + 装置一起写下来**（末轮复评；上一版写的「400–600 毫秒」
    // 是抄了评审探针的数字而**没抄它的装置** —— 换一套装置那个数就是假的，
    // 这正是「凡写实测 X 就把入参一起写下」那条规矩）：
    // · **装置**：本用例 + `WAIT_ROUNDS = 3000` + `WAIT_TIMEOUT_MS = 15000`，
    //   把 `gateway()` 夹具里 `MemoryStorage` 的 `delayMs` 依次改成下列值，跑**正确实现**；
    // · **结果**：900 / 1000 / 1100 通过，**1200 / 1500 / 2000 失败**
    //   ⇒ 天花板在 **(1100, 1200]**；
    // · **失效方式**：不是 vitest 超时，是下面那句显式护栏
    //   「链上其它存储操作没有结清，下面那条断言等早了」自己红掉（`expected 1 to be +0`）；
    // · 天花板随 `WAIT_ROUNDS` 线性走，而且它要盖住的是这条链上**若干次串行**
    //   存储操作的**总和**，不是单个挂起点的长度。
    let quiet = 0;
    for (let i = 0; i < WAIT_ROUNDS && quiet < 5; i++) {
      await new Promise((r) => setTimeout(r, 0));
      quiet = g.storage.otherInFlight === 0 ? quiet + 1 : 0;
    }
    expect(g.storage.otherInFlight, "链上其它存储操作没有结清，下面那条断言等早了").toBe(0);

    expect(
      responded,
      "那次落盘还卡在闸门上，响应却已经回来了 —— 中间件没有 await，Worker 上这次写会被响应返回后的 isolate 停摆截断",
    ).toBe(false);
    expect(g.storage.usagePutsDone, "闸门还没放开，不可能有写完的").toBe(0);

    release();
    const res = await inFlight;
    expect(res.status, "夹具前提：这一次请求跑完了整条中间件链（503 = pool_empty，刻意不打上游）").toBe(503);
    // 放开之后那次写必须已经落定。手写字面量 1。
    expect(g.storage.usagePutsDone, "闸门放开、响应也回来了，那次写却没落定").toBe(1);
  }, WAIT_TIMEOUT_MS);

  /**
   * **`capabilities` 说的是真话，而「真话」的来源是「这个 app 建没建 sink」。**
   *
   * 两个方向都断言（第 1 种假阳性：夹具 A/B 同值）。观测点是 HTTP 响应体，
   * 但它**不是自报**：同一格里顺带证明了「说 true 的那一侧真的会写盘」，
   * 两者绑在同一个夹具上，`tier2Enabled` 因此不可能与实际记账状态分叉。
   */
  it("capabilities.stats.tier2Enabled 两个方向都跟着 USAGE_STATS_ENABLED 走，且说 true 的那一侧真的落得下盘", async () => {
    const read = async (g: Awaited<ReturnType<typeof gateway>>) => {
      const res = await g.app.request("/admin/api/capabilities", {
        headers: { "x-admin-key": TEST_ADMIN_TOKEN },
      });
      expect(res.status).toBe(200);
      return await res.json() as { stats: { tier2Enabled: boolean; flushIntervalMs: number; tokensCoverage: string[] } };
    };
    // `buildApp` 的 ADMIN_TOKEN 从 env 来，两侧都要给（不给整棵 /admin 树不注册 ⇒ 404）。
    let tOn = DAY0_MS;
    const on = await gatewayWithAdmin({ enabled: true, now: () => tOn });
    let tOff = DAY0_MS;
    const off = await gatewayWithAdmin({ enabled: false, now: () => tOff });

    expect((await read(on)).stats.tier2Enabled, "开着却报 false").toBe(true);
    expect((await read(off)).stats.tier2Enabled, "关着却报 true —— 面板会画一张空图表并把它当成「这段时间没有流量」").toBe(false);

    // 说 true 的那一侧必须真的写得出去，否则 `tier2Enabled` 就只是一句自报。
    await on.hit();
    tOn += USAGE_FLUSH_MIN_INTERVAL_MS + 1;
    await on.hit();
    expect(on.storage.usagePuts, "报了 true 却一次都没落盘").toEqual([KEY_DAY0]);
  });

  /**
   * **`tokensCoverage` 与「哪几条协议真的记到了 token」必须是同一件事。**
   *
   * 两侧各自锚在**同一个手写字面量**上：左边是 `capabilities` 发出去的清单，
   * 右边是四条协议各打一次之后 `byProtocol` 里真的带上 token 的那些。
   * 只断言其中一边的话，「目录改了而路由没改」或者「路由改了而目录没改」
   * 都不会红，而面板会照着那份清单去解释缺口。
   */
  it("四条协议各打一次：byProtocol 分出四个键，且只有 anthropic/responses/gemini 三条带 token —— OpenAI 那条网关没解析过响应体（订正），缺口由 tokensCoverage 如实说出去", async () => {
    /** 上游那份 OpenAI 格式的响应体。四条协议共用同一份（网关内部只有这一种）。 */
    const upstream = JSON.stringify({
      id: "c1",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 },
    });
    let t = DAY0_MS;
    const storage = new UsagePutCounter(new MemoryStorage(undefined, () => t));
    const sink = new UsageSink({ storage, now: () => t, shardId: SHARD, onError: () => {} });
    const { app } = await makeApp(
      [{ status: 200, body: upstream }, { status: 200, body: upstream },
        { status: 200, body: upstream }, { status: 200, body: upstream }],
      ["k1"], {}, () => t, { storage, usageSink: sink },
    );
    const post = (path: string, body: unknown) => app.request(path, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const M = "agnes-2.0-flash";
    expect((await post("/v1/chat/completions", { model: M, messages: [{ role: "user", content: "ping" }] })).status).toBe(200);
    expect((await post("/v1/messages", { model: M, max_tokens: 64, messages: [{ role: "user", content: "ping" }] })).status).toBe(200);
    expect((await post("/v1/responses", { model: M, input: "ping" })).status).toBe(200);
    expect((await post(`/v1beta/models/${M}:generateContent`, { contents: [{ role: "user", parts: [{ text: "ping" }] }] })).status).toBe(200);

    t += USAGE_FLUSH_MIN_INTERVAL_MS + 1;
    await sink.maybeFlush();
    const shard = await storage.get<UsageDayShard>(KEY_DAY0);
    expect(shard, "这一天的分片压根没落下去").not.toBeNull();

    // 四条协议各一次，**手写字面量**。
    expect(Object.keys(shard!.byProtocol).sort())
      .toEqual(["anthropic", "gemini", "openai", "responses"]);
    const tokensOf = (p: string) => ({
      tokensIn: shard!.byProtocol[p]!.tokensIn, tokensOut: shard!.byProtocol[p]!.tokensOut,
    });
    expect(tokensOf("anthropic"), "anthropic 这条网关解析过响应体，token 必须记下来").toEqual({ tokensIn: 7, tokensOut: 11 });
    expect(tokensOf("responses")).toEqual({ tokensIn: 7, tokensOut: 11 });
    expect(tokensOf("gemini"), "Gemini 这条也必须记到 token —— 若改成拿协议目录的 usagePath（它是 usageMetadata）去取上游那份 OpenAI 格式的对象，取到的是 undefined，这里会变成 0").toEqual({ tokensIn: 7, tokensOut: 11 });
    expect(tokensOf("openai"), "OpenAI 这条没传 expectJson，网关从头到尾没解析过响应体").toEqual({ tokensIn: 0, tokensOut: 0 });

    // 而面板拿到的那份「哪几条有 token」必须与上面完全对得上。
    const cap = await app.request("/admin/api/capabilities", { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });
    const body = await cap.json() as { stats: { tokensCoverage: string[]; flushIntervalMs: number } };
    expect([...body.stats.tokensCoverage].sort(), "capabilities 说的覆盖范围与实际记到的对不上")
      .toEqual(["anthropic", "gemini", "responses"]);
    // 面板要拿它算「未落盘的尾巴最长多久」，写死在前端就会在改常量那天变成假话。
    expect(body.stats.flushIntervalMs).toBe(USAGE_FLUSH_MIN_INTERVAL_MS);
  });
});

/** 与 `gateway()` 相同，只多一个 `ADMIN_TOKEN`（否则 /admin 整棵树不注册）。 */
async function gatewayWithAdmin(o: { enabled: boolean; now: () => number }) {
  const storage = new UsagePutCounter(new MemoryStorage(1, o.now));
  const env: Record<string, string | undefined> = {
    GATEWAY_TOKEN: "t", ADMIN_TOKEN: TEST_ADMIN_TOKEN,
  };
  if (o.enabled) env.USAGE_STATS_ENABLED = "true";
  const { app } = await buildApp(env, storage, nodeRuntime(), {
    now: o.now, newShardId: () => SHARD,
  });
  const hit = () => app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ model: "agnes-2.0-flash", messages: [{ role: "user", content: "ping" }] }),
  });
  return { app, storage, hit };
}

// ───────────────────────────────────────────────────────────────────────────
// ② 落盘契约组：直接驱动生产那个 `UsageSink`
// ───────────────────────────────────────────────────────────────────────────

describe("UsageSink 的落盘契约", () => {
  /** 一个可控时钟 + 计数存储 + sink 三件套。 */
  function rig(startAt = DAY0_MS) {
    let t = startAt;
    const storage = new UsagePutCounter(new MemoryStorage(undefined, () => t));
    const sink = new UsageSink({ storage, now: () => t, shardId: SHARD, onError: () => {} });
    const one = (o: Partial<{ protocol: string; model: string; ok: boolean }> = {}) => sink.record({
      protocol: o.protocol ?? "openai", model: o.model ?? "agnes-2.0-flash",
      ok: o.ok ?? true, stream: false, latencyMs: 10, tokensIn: 0, tokensOut: 0,
    });
    return {
      storage, sink, one,
      at: () => t,
      advance: (ms: number) => { t += ms; },
      /** 推过一个完整的落盘间隔，让下一次 `maybeFlush()` 真的写。 */
      pastInterval: () => { t += USAGE_FLUSH_MIN_INTERVAL_MS + 1; },
    };
  }

  /**
   * **累加器按 UTC 日分桶，不是一份自启动以来的全局累计。**
   *
   * 一份全局累计 + 按天分的键 = 重复计数：第 2 天那个键里装着从 isolate 启动到现在的
   * 全部量，跨天读回来求和就把第 1 天的量又算了一遍。
   * **而重复计数在面板上长得完全正常**——没有任何别的断言会因为数字偏大而红。
   */
  it("跨两个 UTC 日各落一次盘，合并读回来不许重复计数 —— 累加器若是「自启动累计」而键按天分，第二天那个键会把第一天的量再算一遍", async () => {
    const r = rig();
    // 第 1 天 3 次。
    r.one(); r.one(); r.one();
    r.pastInterval();
    await r.sink.maybeFlush();
    // 跨到第 2 天，2 次。
    r.advance(DAY_MS);
    r.one(); r.one();
    r.pastInterval();
    await r.sink.maybeFlush();

    const shards = [
      await r.storage.get<unknown>(KEY_DAY0),
      await r.storage.get<unknown>(KEY_DAY1),
    ];
    const merged = mergeDayShards(shards);
    // **期望值三个手写字面量**：3 + 2 = 5，两天分别 3 与 2。
    // 全局累计的实现会给出 total=8（3 + 5）、第 2 天那格 = 5。
    expect(merged.total.requests, "合并之后的总数不是 3 + 2 —— 多半是重复计数").toBe(5);
    expect(merged.byDay[String(DAY0)]!.requests).toBe(3);
    expect(merged.byDay[String(DAY0 + 1)]!.requests).toBe(2);
  });

  /**
   * **一次落盘通常只写 1 个键，跨 UTC 零点那一次写 2 个。**
   *
   * 这条是配额账那个 `13 = 12 + 1` 里的 `+1` 的来历，也是下面那格预算用例的前提。
   */
  it("一次落盘只写 1 个键，跨 UTC 零点那一次写 2 个 —— 预算数的是 put 不是 flush（评审发现），少扣一格配额账就是假的", async () => {
    const r = rig();
    r.one();
    r.pastInterval();
    await r.sink.maybeFlush();
    // 手写字面量：第一次落盘恰好 1 个键。
    expect(r.storage.usagePuts).toEqual([KEY_DAY0]);

    // 再攒一条在第 1 天，然后把时钟推进到第 2 天再攒一条，一次 flush 落两个键。
    r.one();
    r.advance(DAY_MS);
    r.one();
    r.pastInterval();
    await r.sink.maybeFlush();
    // **顺序也钉住：先旧后新。** 预算不够时先落旧的，那条性质靠这个顺序成立。
    expect(
      r.storage.usagePuts,
      "跨 UTC 零点那一次没有写两个键 —— 配额账里的 13 = 12 + 1 里那个 +1 就是它",
    ).toEqual([KEY_DAY0, KEY_DAY0, KEY_DAY1]);
  });

  /**
   * **预算按 `USAGE_WRITES_PER_DAY`（13）计，不是事件板块的 `EVENT_WRITES_PER_DAY`（12）。**
   *
   * ⚠️ 这一格同时钉住三件事，缺一件都会让配额账变成一句假话：
   * ① **`canWrite` 的第三参必须显式传。** 漏传**不会有类型错误、不会有编译期信号**，
   *    预算会静默按 12 计——第 13 次 put 被拒 ⇒ 下面那个 13 变成 12，红。
   * ② **`consume()` 每写一个键调一次，不是每次 flush 调一次**（评审那条的正主）：
   *    挪到循环外的话这一次 flush 只扣一格，20 个待落盘的日会**一次全写出去**，
   *    put 计数变成 20，红。
   * ③ **耗尽之后当天不再写**：`canWrite` 那道判断删掉 ⇒ 同样是 20，红。
   *
   * **为什么摆 20 个待落盘的日而不是打 20 次请求**：落盘间隔 2 小时 × 预算 13
   * 在设计上恰好覆盖一整天（`间隔 × (预算 − 1) = 一天`，没有余量），所以正常节奏下
   * 预算**永远不会拒绝任何一次写**——不构造一个「一次 flush 面对很多天」的状态，
   * 这条闸就是不可观测的。这个状态本身是真实的：时钟跳变、实例挂起后恢复都会到这里。
   */
  it("预算按 13 计而不是事件板块的 12 —— 一次 flush 面对 20 个待落盘的日时恰好写 13 个键，第 14 个起当天不再写", async () => {
    const r = rig();
    // 攒 20 个互不相同的 UTC 日，**中途一次都不 flush**。
    for (let i = 0; i < 20; i++) { r.one(); r.advance(DAY_MS); }
    r.pastInterval();
    await r.sink.maybeFlush();
    // **手写字面量 13。** 12 ⇒ 第三参漏传了；20 ⇒ consume 在循环外，或者 canWrite 没了。
    expect(
      r.storage.usagePuts.length,
      "写出去的键数不是 13：12 说明 canWrite 的 perDay 用了事件板块的默认值，20 说明预算根本没起作用",
    ).toBe(13);
    // 落的是**最早的 13 天**（预算不够时先落旧的，新的下一轮还有机会）。
    expect(r.storage.usagePuts[0]).toBe(`usage:${DAY0}:${SLOT}`);
    expect(r.storage.usagePuts[12]).toBe(`usage:${DAY0 + 12}:${SLOT}`);

    // 同一个 UTC 日里再 flush 一次：一个字都不许再写。
    const before = r.storage.usagePuts.length;
    r.pastInterval();
    await r.sink.maybeFlush();
    expect(r.storage.usagePuts.length - before, "预算耗尽之后当天还在写").toBe(0);

    // **下一个 UTC 日自动恢复**，而且补的正是上一轮欠下的那些天（数据不丢）。
    r.advance(DAY_MS);
    await r.sink.maybeFlush();
    expect(
      r.storage.usagePuts.length - before,
      "跨到新的一天之后预算没恢复 —— 那 7 天欠账就永远补不上了",
    ).toBe(7);
    expect(r.storage.usagePuts[before]).toBe(`usage:${DAY0 + 13}:${SLOT}`);
  });

  /**
   * **落盘失败不清那一天的累加器、也不从 dirty 里移除。**
   *
   * 清掉等于把这一段计数永久丢了，而下一次落盘本来能带上它
   *（`USAGE_WRITES_PER_DAY` 上方那句「数据不丢：那天的 `dirty` 不清，下一轮补上」
   * 说的就是这条，本格是它的落点）。
   *
   * ⚠️ **stub 必须真的 `throw`**（第 2 种假阳性）：只 resolve 一个「失败」是测不出
   * 这条的——被测代码走的是 try/catch，不看返回值。
   */
  it("落盘失败不清那一天的累加器、也不从 dirty 里移除，下一次落盘把这一段带上 —— 清掉等于把这段计数永久丢了", async () => {
    const errs: unknown[] = [];
    let t = DAY0_MS;
    const storage = new UsagePutCounter(new MemoryStorage(undefined, () => t));
    const sink = new UsageSink({ storage, now: () => t, shardId: SHARD, onError: (e) => errs.push(e) });
    const one = () => sink.record({
      protocol: "openai", model: "m", ok: true, stream: false,
      latencyMs: 10, tokensIn: 0, tokensOut: 0,
    });

    one(); one();
    storage.putFails = true;
    t += USAGE_FLUSH_MIN_INTERVAL_MS + 1;
    await expect(sink.maybeFlush(), "统计是旁路，永不抛").resolves.toBeUndefined();
    expect(errs.length, "落盘失败必须走 onError 说一声，静默吞掉就是撒谎").toBe(1);
    expect(await storage.get<unknown>(KEY_DAY0), "写失败了当然什么都没落下去").toBeNull();

    // ── ① 存储恢复，**这一段刻意不再产生任何新计数**。
    // ⚠️ **这一步不许省**（本任务变异实测）：如果这里先补一条新记录再断言，
    // 「失败时把这一天从 `dirty` 里删掉」这条变异**照样绿**——新记录会把这一天
    // 重新标脏，而累加器从来没被清过，于是数字看着是对的。
    // 真正的危害恰恰发生在**没有后续流量**的时候：那两条会永远留在内存里，
    // 随实例回收一起消失。所以观测点必须落在「零新增量的下一次落盘」上。
    storage.putFails = false;
    t += USAGE_FLUSH_MIN_INTERVAL_MS + 1;
    await sink.maybeFlush();
    const afterRetry = await storage.get<UsageDayShard>(KEY_DAY0);
    // **手写字面量 2**：失败那一批原封不动地补上了。
    // 从 `dirty` 里删掉的实现在这一步写不出任何东西 ⇒ `afterRetry` 是 null。
    expect(
      afterRetry?.total.requests,
      "存储恢复之后那两条没有被补上 —— 落盘失败时把这一天从 dirty 里移除了，它们被永久丢了",
    ).toBe(2);

    // ── ② 再攒一条：同一天的下一次落盘写的是**这一天的累计值**（整份覆写），
    // 不是增量 ⇒ 3，不是 1。清零累加器的实现会给出 1。
    one();
    t += USAGE_FLUSH_MIN_INTERVAL_MS + 1;
    await sink.maybeFlush();
    const shard = await storage.get<UsageDayShard>(KEY_DAY0);
    expect(
      shard?.total.requests,
      "同一天的第二次落盘只写了增量 —— 那个键是整份覆写的，写增量等于把先前的量抹掉",
    ).toBe(3);
  });

  /**
   * **空转的 flush 不许把落盘时钟（`lastFlushAt`）往前推。**
   *
   * ⚠️ **这一格是变异实测逼出来的**：`maybeFlush()` 开头那句
   * `if (this.dirty.size === 0) return` 删掉之后，「零流量不写盘」那一格**照样绿**
   * ——因为空集合上的 `for` 循环本来就一次都不进循环体。那句话保护的其实是**这里**。
   *
   * 危害很具体：面板轮询（15~60 秒一次）与任何 `/admin/api/*` 请求都会走这条中间件。
   * 零流量期间它们每一次都会「空转」一遍 flush；空转若把时钟刷到当下，
   * **真的来了第一条计数时它要再等满 2 小时才落得下去**，而运维看到的是
   * 「我明明打了请求，面板上半天没数」。
   */
  it("空转的 flush 不许把落盘时钟往前推：闲置一整段时间里反复 flush 之后，第一条计数仍然在紧接着的那一次落盘就写出去", async () => {
    const r = rig();
    // 闲置：一条计数都没有，但请求照来（面板轮询就是这样），每次收尾都 flush 一遍。
    for (let i = 0; i < 5; i++) { r.advance(USAGE_FLUSH_MIN_INTERVAL_MS + 1); await r.sink.maybeFlush(); }
    expect(r.storage.usagePuts, "空转期间就不该有写").toEqual([]);

    // 第一条计数来了，**同一时刻**收尾 flush（同一个请求的两步）。
    r.one();
    await r.sink.maybeFlush();
    // 手写字面量：一个键。空转推过时钟的实现在这里 `since = 0`，一个字都写不出去。
    expect(
      r.storage.usagePuts,
      "第一条计数没能立刻落盘 —— 空转的 flush 把落盘时钟推到了当下，它还要再等满一个间隔",
    ).toEqual([KEY_DAY0]);
  });

  /**
   * **有界性是存储自己的性质，不靠任何人顺手 delete。**
   *
   * 设计原方案是 Cron 压实 + 删分片，被评审推翻：那种有界性依赖「落盘节奏恰好
   * 规律」这个前提，稀疏落盘或多 isolate 各写各的槽位时清理率能跌到 0。
   */
  it("落盘写的键带 expiresAt，且是 usageExpiresAt(day) 算出来的那个绝对时刻 —— 有界性是存储自己的性质，不靠任何人顺手 delete", async () => {
    const r = rig();
    r.one();
    r.pastInterval();
    await r.sink.maybeFlush();
    // **手写字面量**：`(20000 + 30 + 1) × 86_400_000 = 20031 × 86_400_000`。
    // 保留 30 天 + 一整天的时钟偏差余量（`USAGE_TTL_MARGIN_MS`）。
    expect(
      r.storage.lastExpiresAt,
      "put 的第三参没传（undefined）或算错了 —— 这个键会永远留在存储里",
    ).toBe(1_730_678_400_000);
  });

  /**
   * **槽位是构造时由 `shardId` 定死的，此后这个 sink 写的每一个键都在同一个槽位上。**
   *
   * `src/core/admin/usage-stats.ts` 的 `usageSlotOf` 上方写着
   * 「『构造时算一次、终生不变』是对 `UsageSink` 的要求，不是本函数的性质」，
   * 本格就是那句话的落点。
   *
   * ⚠️ **边界明写，不许把它读成更强的东西**：`usageSlotOf` 是纯函数，
   * 「每次现算」与「构造时算一次」在外部**行为上等价**，这一格分辨不了、也不该声称
   * 分辨得了。它钉住的是**能被观测到的那一半**：槽位只由 `shardId` 决定
   *（写死成 0 ⇒ 红，因为 `usageSlotOf("u2")` 是 1），且**不随日期变**
   *（改成按 day 现算 ⇒ 两天两个槽位 ⇒ 红）。后者才是真正的危害：
   * 同一天的两次落盘落进两个键，读回来就是重复计数。
   */
  it("槽位是构造时算一次、终生不变：同一个 sink 跨两天落盘只写同一个槽位，而那个槽位由 shardId 决定（usageSlotOf(\"u2\") = 1，不是 0）", async () => {
    const r = rig();
    r.one();
    r.pastInterval();
    await r.sink.maybeFlush();
    r.advance(DAY_MS);
    r.one();
    r.pastInterval();
    await r.sink.maybeFlush();
    // 手写字面量：两天、同一个槽位 1。
    expect(r.storage.usagePuts).toEqual([`usage:${DAY0}:1`, `usage:${DAY0 + 1}:1`]);
  });

  /**
   * **`maybeFlush()` 不许可重入**（评审发现）。
   *
   * 它由**每一个请求的收尾**调用，而请求是并发的。`lastFlushAt` 与 `budget` 若在
   * `await put` **之后**才推进，两个并发的 flush 就会双双通过间隔闸、
   * **各写一遍同一个键、各扣一格预算**。
   *
   * ⚠️ **为什么这是 Critical 而不是「多写一次」**：本仓的
   * `落盘间隔 × (预算 − 1) = 一天` **两边恰好相等、没有余量，那是刻意的**
   *（见 `USAGE_FLUSH_MIN_INTERVAL_MS`）⇒ **任何一次重复写都直接击穿当天的覆盖**。
   * 13 个并发请求撞上同一个 2 小时边界（繁忙网关的常态）⇒ 当天预算在第一次落盘
   * 就耗尽，此后到下一个 UTC 日一个字不写 ⇒ 五语言 DEPLOY.md 那句「最多旧 2 小时」
   * 变成最多旧 24 小时；Worker 上 isolate 活不到第二天，那些计数直接消失。
   *
   * 对照组在 `src/adapters/logger-store.ts`：它把窗口与预算推到 `await` 之前，
   * 所以从来没有这个洞。本格把同一条性质钉在用量这一侧。
   */
  it("10 个并发请求的收尾 flush 同时撞上落盘间隔：只落 1 次盘 —— lastFlushAt 与预算若在 await 之后才推进，10 个并发就各写一遍同一个键，而「间隔 × (预算 − 1) = 一天」没有余量，一次重复写就击穿当天覆盖", async () => {
    const r = rig();
    r.one();
    r.pastInterval();
    // **同时**发起 10 次收尾 flush，模拟 10 个并发请求撞上同一个落盘边界。
    await Promise.all(Array.from({ length: 10 }, () => r.sink.maybeFlush()));
    // 手写字面量：1 个键、1 次写。可重入的实现在这里是 10 个 `usage:20000:1`。
    expect(
      r.storage.usagePuts,
      "同一个键被并发写了多次 —— 预算跟着被多扣了几格，而这条轴上一格都不能浪费",
    ).toEqual([KEY_DAY0]);
  });

  /**
   * **`status()` 那三个字段各自说得准**（评审发现）。
   *
   * ⚠️ **这一格存在的直接原因：`sink.status()` 在整个测试目录里一次都没被调用过。**
   * 后果实测过两条，都是「改了没人红」：
   * ① `status()` 里的 `canWrite` 漏传第三参 ⇒ 预算静默按 12 计
   *    ⇒ `budgetExhausted` **提前一格翻真**，而面板据它渲染的「预算耗尽」是一句假话
   *    （全局约束 10 的原话正是「诚实标记由后端字段驱动」）；
   * ② `pending` 改回无条件归零 ⇒ 预算耗尽时面板会说「没有未落盘的尾巴」，
   *    而那时明明还有 7 天没落下去（全局约束 9 点名的「三件事长得一模一样」）。
   *
   * ⚠️ **判别状态必须是「已用 12 格」**（第 5 种假阳性）：那一刻 13 与 12 两种实现
   * 才分叉（13 说还能写、12 说已耗尽）；在「已用 13 格」上两者都说耗尽，
   * 只测 13 是测不出来的。
   */
  it("status() 的三个字段：budgetExhausted 在第 13 次 put 之后才翻真（已用 12 格时必须仍是 false），预算耗尽时 pending 不许归零", async () => {
    const r = rig();
    // 攒 12 个互不相同的 UTC 日，一次 flush 恰好写 12 个键（预算 13，够）。
    for (let i = 0; i < 12; i++) { r.one(); r.advance(DAY_MS); }
    r.pastInterval();
    await r.sink.maybeFlush();
    expect(r.storage.usagePuts.length, "夹具前提：这一次应当写满 12 个键").toBe(12);
    // ★ **判别点**：已用 12 格。perDay = 13 ⇒ 还能写；perDay = 12 ⇒ 已耗尽。
    expect(
      r.sink.status().budgetExhausted,
      "已用 12 格就说预算耗尽 —— status() 里的 canWrite 用了事件板块的默认值 12",
    ).toBe(false);

    // 再写 1 个键（同一个 UTC 日内），累计 13 格 ⇒ 这才该翻真。
    r.one();
    r.pastInterval();
    await r.sink.maybeFlush();
    expect(r.storage.usagePuts.length, "夹具前提：这一次再写 1 个键").toBe(13);
    expect(r.sink.status().budgetExhausted, "已用满 13 格却还说没耗尽").toBe(true);

    // ── `pending` / `pendingMs`：**预算耗尽、还欠着账的那一刻**三个字段的组合。
    const r2 = rig();
    for (let i = 0; i < 20; i++) { r2.one(); r2.advance(DAY_MS); }
    r2.pastInterval();
    await r2.sink.maybeFlush();
    expect(r2.storage.usagePuts.length, "夹具前提：预算把这一次卡在 13 个键").toBe(13);
    // **三个手写字面量一次断完**，这正是报告里交下来的那条读法：
    // `pending > 0 && pendingMs === 0` 读作「刚试过、没写成」，不是「刚写完」。
    expect(
      r2.sink.status(),
      "预算耗尽、还有 7 天没落下去，status() 却说没有未落盘的尾巴",
    ).toEqual({ shardId: SHARD, pending: 20, pendingMs: 0, budgetExhausted: true });
  });

  /**
   * **`byModel` 的键完全由客户端控制，必须有上界**（评审发现）。
   *
   * 模型名一路来自请求体（`String(body.model ?? "")`），每个不同的串就是一个新桶，
   * 而那份 map **永不清理、每次落盘整份覆写进一个键**。没有上界的话：
   * Node 长驻进程内存无上界；**KV 单值 25MB 上限撞上之后 `put` 抛错 ⇒ 那天永远 dirty
   * ⇒ 每个间隔重试一次、白烧预算**，这一天的数据再也写不出去。
   *
   * 两条上界一起验：**格数**（超出并进 `__other__`）与**单个键的长度**。
   */
  it("byModel 的键有上界：200 个不同的模型名只留 32 个具名格 + 一个 __other__，且超长模型名被截断 —— 那一维的键完全由客户端控制，无上界就能把单个值撑爆 KV 的 25MB 上限", async () => {
    const r = rig();
    for (let i = 0; i < 200; i++) r.one({ model: `m${i}` });
    r.pastInterval();
    await r.sink.maybeFlush();
    const shard = (await r.storage.get<UsageDayShard>(KEY_DAY0))!;
    const keys = Object.keys(shard.byModel);
    // 手写字面量 33 = 32 个具名 + `__other__` 自己那一格。
    expect(keys.length, "byModel 的格数没有上界").toBe(33);
    expect(keys.includes("__other__"), "超出上界的那些没有被并进 __other__，而是被丢了").toBe(true);
    // 前 32 个具名格是最先出现的那些；总数一条都不许丢。
    expect(shard.byModel["m0"]!.requests, "先出现的模型必须保住自己的格子").toBe(1);
    expect(shard.byModel["__other__"]!.requests, "并进 __other__ 的应当是 200 − 32 = 168 条").toBe(168);
    expect(shard.total.requests, "上界不许把总数弄丢").toBe(200);

    // 长度截断：64 字符。**两个只在第 65 个字符起不同的模型名会并成同一格**，
    // 这是截断的代价，明写在这里。
    const r2 = rig();
    r2.one({ model: "x".repeat(300) });
    r2.pastInterval();
    await r2.sink.maybeFlush();
    const shard2 = (await r2.storage.get<UsageDayShard>(KEY_DAY0))!;
    expect(Object.keys(shard2.byModel), "300 字符的模型名原样进了要落盘的值里").toEqual(["x".repeat(64)]);
  });

  /**
   * **`record()` 与落盘的 `await` 重叠时，那一条计数不许丢**（定向复评）。
   *
   * `maybeFlush()` 挂在 `await put` 上的那段时间里，`record()` 照样在跑（同一个
   * isolate 里的另一个并发请求）。发起写之前那道间隔闸只挡得住 **flush 与 flush**
   * 的重叠；**record 与 flush 的重叠**要靠「快照 + 版本比对」。
   *
   * 少了它，两种形态都坏，而且都很难从面板上看出来：
   * · KV（`JSON.stringify` 在 await 前同步求值）⇒ 那一条**永久消失**：
   *   落盘里没有它、`dirty` 又被清了 ⇒ 再过一整个间隔重跑 flush 仍然只有 1 次 put，
   *   而 `status()` 报 `pending: 0`（「没有未落盘的尾巴」）；
   * · 文件存储 / 延迟序列化 ⇒ 它蹭进了 `hours`/`byModel`/`byProtocol` 而 `total` 是旧的
   *   ⇒ **落盘的分片自己和自己对不上**。
   */
  it("落盘挂起期间到达的那一条计数不许丢：写第一条的 await 还没回来时又来一条，那一天必须仍然是脏的，下一轮把两条一起写出去，且落下去的分片自己和自己对得上", async () => {
    let t = DAY0_MS;
    const storage = new UsagePutCounter(new MemoryStorage(undefined, () => t));
    const sink = new UsageSink({ storage, now: () => t, shardId: SHARD, onError: () => {} });
    // ⚠️ **alpha 与 beta 必须是同一条协议、不同的模型**（末轮复评）。
    // 上一版 beta 用的是另一条协议（`anthropic`）⇒ `byProtocol.openai` 那一格的数
    // **根本不会变** ⇒ 「把原地改只施加在 byProtocol 桶值上」那条变异**31 格全绿逃逸**，
    // 而那条复评加的那个 `openai: 1` 字面量只是看着像有牙。
    // 同协议之后：`byProtocol.openai.requests` 在「没有快照」与「原地改桶值」两种
    // 实现下都会变成 2；不同模型则让 `byModel` 那一维照旧钉住「多出一个键」那一支。
    const one = (model: string) => sink.record({
      protocol: "openai", model, ok: true, stream: false, latencyMs: 1, tokensIn: 0, tokensOut: 0,
    });

    one("m-alpha");                      // alpha
    t += USAGE_FLUSH_MIN_INTERVAL_MS + 1;

    // 把这次写卡在闸门上，**在它挂起期间**再记一条。
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => { entered = r; });
    storage.usagePutGate = () => { entered(); return gate; };

    const flushing = sink.maybeFlush();
    await enteredP;                      // 确证已经挂在写上了（事件驱动，不是等毫秒）
    one("m-beta");                       // ★ beta：await 期间到达（同协议、不同模型）
    release();
    await flushing;

    // ① 落下去的那一份**自己和自己对得上**（快照的作用）。
    const first = (await storage.get<UsageDayShard>(KEY_DAY0))!;
    // ⚠️ **要比桶里的数，不能只比键**（收口复评）：把原地改**只**施加在
    // `byProtocol` 的桶值上（正是快照那段注释所依赖的那条前提）时，
    // 只按 `Object.keys` 比的版本 29 格全绿逃逸——键没变，变的是键指向的那个数。
    expect(
      {
        total: first.total.requests,
        byModel: Object.keys(first.byModel).sort(),
        // ★ **这一格才是「变的是键指向的那个数」那条变异的牙**（末轮复评）：
        // 键表在同协议下不会变，只有桶里的数会。
        openai: first.byProtocol.openai!.requests,
      },
      "落下去的分片自相矛盾 —— total 是旧的而 byModel/byProtocol 蹭进了 await 期间那一条",
    ).toEqual({ total: 1, byModel: ["m-alpha"], openai: 1 });

    // ② 那一天**必须还是脏的**，`pending` 也不许归零（版本比对的作用）。
    expect(
      sink.status().pending,
      "await 期间到达的那一条被当成已落盘了 —— 它既不在分片里、也不会被下一轮补上",
    ).toBe(2);

    // ③ 下一轮把两条一起写出去。
    t += USAGE_FLUSH_MIN_INTERVAL_MS + 1;
    await sink.maybeFlush();
    expect(storage.usagePuts.length, "第二轮应当真的又写了一次").toBe(2);
    const second = (await storage.get<UsageDayShard>(KEY_DAY0))!;
    // 手写字面量：2 条、同一条协议、两个模型。
    expect(
      {
        total: second.total.requests,
        byModel: Object.keys(second.byModel).sort(),
        openai: second.byProtocol.openai!.requests,
      },
      "下一轮没有把 await 期间那一条补上 —— 它永久消失了",
    ).toEqual({ total: 2, byModel: ["m-alpha", "m-beta"], openai: 2 });
  });

  /**
   * **`model` 不是字符串时不许把网关打成 500**（定向复评，本轮引入的缺陷）。
   *
   * 请求体的类型是**纯编译期**的（`c.req.json<T>()`），运行时什么都可能来。
   * `boundUsageKey()` 里那个 `raw.slice(...)` 对 `123` / `{}` / `true` 直接抛，
   * ⚠️ **`record()` 现在有 try/catch 了**（末轮复评：上一版这里写的是「一路没有
   * try/catch ⇒ 打开统计就等于多一条 500」，**那句话被同一个提交里加的兜底改成了假的**）。
   * ⇒ 今天缺了 `safeString` 的后果不是 500，是**那一条计数被 catch 静默吞掉、永久消失**
   *（实测：删掉 `safeString` 打 `{"model":123}`，开着关着都是 503）。
   *
   * ⚠️ **连带说明：下面那句 `.not.toThrow()` 已经退化成恒真断言**，留着只是文档作用
   *（`record()` 现在不可能抛）。**这一格真正的牙是后面两条**：键表必须完整
   *（少一个就说明那一条被吞了）、`total.requests` 必须是 5。
   *
   * ⚠️ **`[1,2]` 必须一起测**：数组恰好有 `.slice`，是这一族里唯一侥幸不抛的，
   * 只挑它做样本的话这条变异不可观测（第 5 种假阳性）。
   */
  it("model 不是字符串时不许把网关打成 500：123 / 对象 / 布尔 / 数组四种都要照常记账，键退化成它们的字符串形式", async () => {
    const r = rig();
    // ⚠️ **最后那个是 `String()` 自己也会抛的那一档**（收口复评）：
    // `JSON.parse('{"toString":1,"valueOf":1}')` 造得出一个两个转换方法都不是函数的
    // 对象，对它取原始值直接 `TypeError`。**上一版四个样本全停在「没有 .slice」
    // 那一层**，把 `raw.slice` 换成 `String(raw).slice` 之后它们就全过了 ——
    // 样本选在缺陷够不到的地方，等于没验。
    const unstringifiable: unknown = JSON.parse('{"toString":1,"valueOf":1}');
    for (const bad of [123, { a: 1 }, true, [1, 2], unstringifiable] as unknown[]) {
      expect(
        () => r.sink.record({
          protocol: "openai", model: bad as string, ok: true, stream: false,
          latencyMs: 1, tokensIn: 0, tokensOut: 0,
        }),
        // ⚠️ 这一条今天恒真（`record()` 有兜底），保留是为了让「它不该抛」这件事
        // 在用例里看得见；**真正的牙在下面的键表与 total**（末轮复评）。
        `model = ${JSON.stringify(bad)} 把 record() 打抛了`,
      ).not.toThrow();
    }
    r.pastInterval();
    await r.sink.maybeFlush();
    const shard = (await r.storage.get<UsageDayShard>(KEY_DAY0))!;
    // 手写字面量：五条各自的字符串形式，一条都不许丢。
    // 最后那一档转不出来 ⇒ 落到固定的兜底键（**不是空串**：空串会和「客户端没填
    // model」混成同一格，那是把两件事画成一件）。
    expect(Object.keys(shard.byModel).sort())
      .toEqual(["1,2", "123", "[object Object]", "[unstringifiable]", "true"]);
    expect(shard.total.requests).toBe(5);
  });

  /**
   * **原型链上的名字被当成模型名时，那一条计数不许消失、也不许变成 null**
   *（收口复评）。
   *
   * 两种坏法**不一样，所以两种都要验**：
   * · `__proto__` ⇒ 普通 `{}` 上那次赋值**去改了原型**，自有键里没有它、
   *   `JSON.stringify` 也看不见 ⇒ **那一条彻底消失**；
   * · `toString` / `constructor` / `hasOwnProperty` ⇒ `?? emptyBucket()` 摸到了
   *   `Function.prototype` 上的同名函数，拿函数做加法 ⇒ 那一格序列化成
   *   `{"requests":null,…}`。
   *
   * **两种都让落盘分片自己和自己对不上（`total` ≠ Σ`byModel`）** —— 正是并发那半
   * 刚消灭掉的失效形态，从另一个入口原样回来。判据因此落在**那条等式**上，
   * 而不只是「键还在不在」。
   */
  it("原型链上的名字当模型名：__proto__ 不许让那一条消失、toString 不许让它变成 null，落盘分片的 total 必须等于 byModel 各格之和", async () => {
    for (const evil of ["__proto__", "toString", "constructor", "hasOwnProperty"]) {
      const r = rig();
      r.one({ model: evil });
      r.one({ model: "gpt-x" });
      r.pastInterval();
      await r.sink.maybeFlush();
      const shard = (await r.storage.get<UsageDayShard>(KEY_DAY0))!;
      const buckets = Object.entries(shard.byModel);
      // ① 两个模型各自都在，一个都没消失（`__proto__` 那一档会只剩 gpt-x）。
      expect(
        buckets.map(([k]) => k).sort(),
        `model = ${evil}：它那一条从落盘的分片里消失了`,
      ).toEqual([evil, "gpt-x"].sort());
      // ② 每一格的数都是真数字，不是 null（`toString` 那一档会是 null）。
      for (const [k, b] of buckets) {
        expect(b.requests, `model = ${evil}：byModel[${k}] 的 requests 不是数字`).toBe(1);
      }
      // ③ **那条等式**：total 必须等于各格之和。手写字面量 2。
      const sum = buckets.reduce((n, [, b]) => n + b.requests, 0);
      expect(
        { total: shard.total.requests, sum },
        `model = ${evil}：落盘分片自己和自己对不上，total ≠ Σ byModel`,
      ).toEqual({ total: 2, sum: 2 });

      // ④ **读侧也要过一遍**（收口复评的另一半）：那个键会**原样从存储里回来**，
      // 而 `mergeDayShards` / `narrowRecord` 里的 map 若是普通 `{}`，同一个洞会在
      // 读路径上重演一次 —— 写侧堵住而读侧没堵，等于把它挪到下一个任务。
      const merged = mergeDayShards([shard]);
      const mergedKeys = Object.keys(merged.byModel).sort();
      expect(
        mergedKeys,
        `model = ${evil}：合并之后那一条消失了 —— 读侧的 map 也得是无原型的`,
      ).toEqual([evil, "gpt-x"].sort());
      const mergedSum = Object.values(merged.byModel).reduce((n, b) => n + b.requests, 0);
      expect(
        { total: merged.total.requests, sum: mergedSum },
        `model = ${evil}：合并之后 total ≠ Σ byModel`,
      ).toEqual({ total: 2, sum: 2 });
    }
  });

  /**
   * **满桶之后，已经存在的键仍然认得出来**（定向复评）。
   *
   * ⚠️ **这一格是补上来的，因为上一版那个上界用例钉不住它**：那里 200 个模型名
   * **各只出现一次**，满桶之后从不复用旧键 ⇒ 把 `boundUsageKey()` 里那句
   * `hasOwnProperty` 早返回删掉，**全量 2182 全绿**。
   * 而它防的是一条真危害：同一个模型会因为 map 满了而在两次请求之间被分到
   * 两个不同的格子，**计数直接错位**。
   */
  it("满桶之后再打一次早期的模型名，它仍然进自己那一格 —— 而不是被并进 __other__", async () => {
    const r = rig();
    for (let i = 0; i < 40; i++) r.one({ model: `m${i}` });   // 40 > 32，桶已经满了
    r.one({ model: "m0" });                                    // ★ 再打一次最早那个
    r.pastInterval();
    await r.sink.maybeFlush();
    const shard = (await r.storage.get<UsageDayShard>(KEY_DAY0))!;
    // 手写字面量 2：删掉那句早返回之后这里会是 1（第二次被并进了 __other__）。
    expect(
      shard.byModel["m0"]!.requests,
      "满桶之后同一个模型被分到了另一个格子 —— 它的计数从此错位",
    ).toBe(2);
  });

  /**
   * **预算在发起写之前就扣，失败不回滚**（定向复评）。
   *
   * ⚠️ **这一格是补上来的**：上一版把 `consume()` 原样挪回 `await` 之后
   *（只留 `lastFlushAt` 在前面）⇒ **全量 2182 全绿**，预算那一半根本没被钉住。
   * 而「失败会白扣一格」正是 `maybeFlush()` 注释里写着的那条代价——
   * 一条写下来的代价必须有一格看得见它。
   */
  it("落盘失败也照样扣掉那一格预算：预算是在发起写之前扣的，失败不回滚 —— 回滚等于让一个正在故障的存储无限重试", async () => {
    const r = rig();
    // 先把预算用掉 12 格（12 个待落盘的日，一次写完）。
    for (let i = 0; i < 12; i++) { r.one(); r.advance(DAY_MS); }
    r.pastInterval();
    await r.sink.maybeFlush();
    expect(r.storage.usagePuts.length, "夹具前提：这一次写满 12 个键").toBe(12);
    expect(r.sink.status().budgetExhausted, "夹具前提：12 格时还没耗尽").toBe(false);

    // 第 13 次写**失败**。预算仍然要被扣掉 ⇒ 当天从此耗尽。
    r.storage.putFails = true;
    r.one();
    r.pastInterval();
    await r.sink.maybeFlush();
    expect(
      r.sink.status().budgetExhausted,
      "落盘失败之后预算没被扣 —— 预算是在 await 之后才扣的，一个一直失败的存储可以无限重试",
    ).toBe(true);
  });

  /**
   * **没有未落盘增量时是 no-op，一次写都不产生**（设计 §7.1 原话）。
   *
   * 少了这一条，一个开着 Tier-2 但**零流量**的部署每 2 小时照样写一次盘
   *（一天 12 次 × 并发 isolate 数），而它一条计数都没有。
   */
  it("开着但没有任何流量时：反复 flush 一次写都不产生 —— 零流量的部署不许因为「开了统计」就每天多 12 次 put", async () => {
    const r = rig();
    for (let i = 0; i < 5; i++) { r.pastInterval(); await r.sink.maybeFlush(); }
    expect(r.storage.usagePuts, "没有任何计数却写了盘").toEqual([]);

    // 反向自检：这个 sink 本身是能写的，上面那个空数组不是因为它坏了。
    r.one();
    r.pastInterval();
    await r.sink.maybeFlush();
    expect(r.storage.usagePuts.length, "前置条件不成立：这个 sink 压根写不出去").toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ③ USAGE_FLUSH_INTERVAL_MS：判据是「存储有没有写配额」，不是「在哪个运行时上跑」
// ───────────────────────────────────────────────────────────────────────────

describe("USAGE_FLUSH_INTERVAL_MS 的接线（判据是存储能力，不是 runtime.name）", () => {
  /**
   * **默认值两种存储形态逐字相同** —— 这是「双运行时对等」在这个旋钮上的落点。
   *
   * 分叉只发生在**运维显式设了它**的时候，那是一次知情选择；没设的部署两边
   * 一个字节都不差。**这一格必须先立住**，否则下面那两格的差异读起来会像
   * 「两种运行时天生不一样」，而那正是设计明令禁止的东西。
   */
  it("没设这个环境变量时：两种存储形态拿到逐字相同的间隔（2 小时），差别只在「有没有写配额」那道闸", () => {
    // 手写字面量：常量本身 + 两侧各自的预算。
    expect(resolveUsageFlushInterval(undefined, true))
      .toEqual({ flushIntervalMs: 7_200_000, budgetPerDay: 13 });
    expect(resolveUsageFlushInterval(undefined, false))
      .toEqual({ flushIntervalMs: 7_200_000, budgetPerDay: null });
    // 反向自检：上面那两个字面量就是后端常量本身，不是碰巧相等。
    expect(USAGE_FLUSH_MIN_INTERVAL_MS).toBe(7_200_000);
    expect(USAGE_WRITES_PER_DAY).toBe(13);
  });

  /**
   * **有写配额的那一侧：调小到会让半天没数据的值 ⇒ fail-closed 直接抛。**
   *
   * 不许默默接受：`间隔 × (预算 − 1) >= 一天` 破了之后，写量仍然合格
   * （预算封着顶），**而数据从中午起就是假的** —— 那比起不来更难发现。
   * 错误消息里必须给出最小可用值，否则运维只知道被拒、不知道该填多少。
   */
  it("有写配额的存储上把间隔调到 300 秒：启动就抛，且消息里给出最小可用值 7200000 —— 写量合格而数据从中午起就是假的，比起不来更难发现", () => {
    expect(() => resolveUsageFlushInterval("300000", true)).toThrow(/7200000/);
    // 边界两侧各一格（手写字面量）：恰好等于最小值放行，少 1 毫秒就抛。
    expect(resolveUsageFlushInterval("7200000", true))
      .toEqual({ flushIntervalMs: 7_200_000, budgetPerDay: 13 });
    expect(() => resolveUsageFlushInterval("7199999", true)).toThrow(/USAGE_FLUSH_INTERVAL_MS/);
    // 调大随便。
    expect(resolveUsageFlushInterval("14400000", true))
      .toEqual({ flushIntervalMs: 14_400_000, budgetPerDay: 13 });
  });

  /**
   * **没有写配额的那一侧：同一个 300 秒放行，而且没有每天的写预算。**
   *
   * 留着那道 13 次/天的闸的话，调到 300 秒的结果是「头 65 分钟写满 13 次、
   * 之后整天不写」——**比默认值更糟**，那正是 `USAGE_FLUSH_MIN_INTERVAL_MS`
   * 上方已经论证过的形态。⇒ 没有写配额时上界就是间隔本身。
   */
  it("没有写配额的存储上：同一个 300 秒放行，且不再设每天的写预算 —— 留着 13 次/天的闸会让「头 65 分钟写满、之后整天不写」，比默认值更糟", () => {
    expect(resolveUsageFlushInterval("300000", false))
      .toEqual({ flushIntervalMs: 300_000, budgetPerDay: null });
  });

  /**
   * **空串与「没设」同等对待**（定向复评，本轮引入的缺陷）。
   *
   * `.env.example` 是给 `cp .env.example .env` + `docker-compose` 的 `env_file:` 直接用的，
   * 一个留空的键会以**空字符串**（不是 unset）进到环境里。`Number("") = 0` 过不了
   * 「不小于 1 的整数」这一关 ⇒ **全新的 Docker 部署直接起不来**。
   * 本仓那份文件里另外 9 个留空项全部容忍空串，这一个不该是例外。
   */
  it("USAGE_FLUSH_INTERVAL_MS= （空串）与没设它完全一样 —— .env.example 里留空的键是以空字符串进环境的，抛的话全新 Docker 部署直接起不来", () => {
    // 手写字面量，两种存储形态各一次；与「没设」逐字相同。
    expect(resolveUsageFlushInterval("", true))
      .toEqual({ flushIntervalMs: 7_200_000, budgetPerDay: 13 });
    expect(resolveUsageFlushInterval("", false))
      .toEqual({ flushIntervalMs: 7_200_000, budgetPerDay: null });
    // 走真装配再验一遍：空串不许让 buildApp 抛。
    expect(resolveUsageFlushInterval("", true)).toEqual(resolveUsageFlushInterval(undefined, true));
  });

  /** 环境变量的非法值继续 fail-fast：部署时错误，运维必须立刻看得见。 */
  it("非法值一律抛，不降级：abc / 0 / -1 / 1.5 四种写法都要被拒", () => {
    for (const bad of ["abc", "0", "-1", "1.5"]) {
      expect(() => resolveUsageFlushInterval(bad, true), `「${bad}」被放行了`)
        .toThrow(/USAGE_FLUSH_INTERVAL_MS/);
    }
  });

  /**
   * **预算那一格真的接到了 sink 上**（不是算出来就丢掉）。
   *
   * 两个方向在同一格里跑（第 1 种假阳性：夹具 A/B 同值）：同样 20 个待落盘的日、
   * 同样一次 flush，有预算的那一侧被卡在 13，没预算的那一侧 20 个全写出去。
   */
  it("budgetPerDay 真的接到了 sink 上：同样 20 个待落盘的日，有写配额的一侧卡在 13 个键，没写配额的一侧 20 个全写", async () => {
    const run = async (budgetPerDay: number | null) => {
      let t = DAY0_MS;
      const storage = new UsagePutCounter(new MemoryStorage(undefined, () => t));
      const sink = new UsageSink({
        storage, now: () => t, shardId: SHARD, onError: () => {}, budgetPerDay,
      });
      for (let i = 0; i < 20; i++) {
        sink.record({ protocol: "openai", model: "m", ok: true, stream: false, latencyMs: 1, tokensIn: 0, tokensOut: 0 });
        t += DAY_MS;
      }
      t += USAGE_FLUSH_MIN_INTERVAL_MS + 1;
      await sink.maybeFlush();
      return storage.usagePuts.length;
    };
    // 手写字面量，两个方向。
    expect(await run(13), "有写配额的一侧没被预算卡住").toBe(13);
    expect(await run(null), "没写配额的一侧仍然被一道不该存在的闸卡着").toBe(20);
  });

  /**
   * **走真装配的接线证据**：`USAGE_FLUSH_INTERVAL_MS` 从 env 一路生效到
   * ① sink 的落盘节奏（行为观测）与 ② `capabilities.stats.flushIntervalMs`（面板读的那个数）。
   *
   * ⚠️ **两样都要**：只验 capabilities 的话，「读了但没接到 sink 上」照样绿
   *（那个数就成了 handler 自报）；只验节奏的话，面板可能还在报后端常量，
   * 而运维据它算出来的「尾巴最长多久」是错的。
   *
   * 这里用 `nodeRuntime()`（`quotaModel: "file"` ⇒ 没有写配额）才调得动 300 秒，
   * **而这正是那条判据的意思**：能不能调小取决于存储有没有写配额。
   */
  it("空串走 buildApp 也不许抛：模拟 `cp .env.example .env` 之后那份配置", async () => {
    const { app } = await buildApp(
      { GATEWAY_TOKEN: "t", USAGE_FLUSH_INTERVAL_MS: "" },
      new UsagePutCounter(new MemoryStorage()), workerRuntime(), { newShardId: () => SHARD },
    );
    expect((await app.request("/health")).status, "全新部署起不来了").toBe(200);
  });

  it("走 buildApp 的接线证据：USAGE_FLUSH_INTERVAL_MS 同时改变了落盘节奏与 capabilities 报出去的那个数", async () => {
    let t = DAY0_MS;
    const storage = new UsagePutCounter(new MemoryStorage(1, () => t));
    const { app } = await buildApp(
      { GATEWAY_TOKEN: "t", ADMIN_TOKEN: TEST_ADMIN_TOKEN, USAGE_STATS_ENABLED: "true", USAGE_FLUSH_INTERVAL_MS: "300000" },
      storage, nodeRuntime(), { now: () => t, newShardId: () => SHARD },
    );
    const hit = () => app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-2.0-flash", messages: [{ role: "user", content: "ping" }] }),
    });

    // ① 节奏：**推 300 秒零 1 毫秒**（远小于后端常量的 2 小时）就该落盘。
    await hit();
    t += 300_001;
    await hit();
    expect(
      storage.usagePuts,
      "推过 300 秒还没落盘 —— 那个环境变量没有接到 sink 上，间隔还是后端常量",
    ).toEqual([KEY_DAY0]);

    // ② 面板读的那个数必须是生效值，不是后端常量。
    const res = await app.request("/admin/api/capabilities", { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });
    const body = await res.json() as { stats: { flushIntervalMs: number } };
    // 手写字面量；顺带反向自检它确实不等于常量。
    expect(body.stats.flushIntervalMs, "capabilities 报的是后端常量而不是生效值").toBe(300_000);
    expect(body.stats.flushIntervalMs).not.toBe(USAGE_FLUSH_MIN_INTERVAL_MS);
  });

  /**
   * **有写配额的那一侧，同一个值会让装配直接失败** —— 与上一格是同一个环境变量、
   * 同一个值，只有存储能力这一维不同。两格合起来才说明「判据是存储能力」。
   */
  it("同一个 300000，在有写配额的存储形态上 buildApp 直接抛 —— 判据是存储能力（quotaModel），不是 runtime.name", async () => {
    await expect(buildApp(
      { GATEWAY_TOKEN: "t", USAGE_STATS_ENABLED: "true", USAGE_FLUSH_INTERVAL_MS: "300000" },
      new UsagePutCounter(new MemoryStorage()), workerRuntime(), { newShardId: () => SHARD },
    )).rejects.toThrow(/7200000/);
  });
});
