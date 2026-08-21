import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/http/wire.js";
import { nodeRuntime } from "../../src/adapters/runtime-node.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { makeApp, TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { UsageSink } from "../../src/http/usage-sink.js";
import {
  USAGE_FLUSH_MIN_INTERVAL_MS, mergeDayShards, type UsageDayShard,
} from "../../src/core/admin/usage-stats.js";
import type { Storage } from "../../src/ports/storage.js";

/**
 * Tier-2 用量统计的接线契约（P3d Task 3）。
 *
 * **contract ⇒ node 与 workerd 各跑一遍**（`tests/global-setup.ts` 的 `POLICY` 强制）。
 * 这正是本组该在的地方：Tier-2 的落盘时机是 P3d 计划点名的三个「双运行时上不是照抄
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
 *   （`"u1"`/`"s1"` 都是 0）——落 0 的话「槽位写死成 0」这条实现不可观测（评审 I-2 实测过）。
 * · `expiresAt = 1_730_678_400_000`：`(20000 + 30 + 1) × 86_400_000`，
 *   即 `20031 × 86_400_000`。**在测试外面手算的**，不是从 `usageExpiresAt` 取回来的
 *   ——取回来就是同义反复。
 */

/** UTC 日序号。选一个远离纪元零点的真实量级，免得「日」这一维退化成 0 而不可观测。 */
const DAY0 = 20_000;
const DAY_MS = 86_400_000;
const DAY0_MS = DAY0 * DAY_MS;
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
 * 的观测点都正是那个数（P3d 计划全局约束 16 的变红条件逐字就是
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
  /** 最近一次 put 收到的 `expiresAt`（`undefined` = 调用方压根没传第三参）。 */
  lastExpiresAt: number | undefined;
  /**
   * `usagePutDelayMs`：**只加在 `usage:` 这一类 put 上的额外挂起**。
   *
   * ⚠️ **它必须明显长于这条中间件链上任何别的 I/O**（本任务变异实测逼出来的）：
   * 只给存储一个统一的 1 毫秒延迟时，「用量 flush 没 `await`」这条变异**逃逸**了
   * ——`usageFlush` 的收尾之后紧接着还有 `logFlush` 的收尾，而后者同样要做一次
   * 带 1 毫秒延迟的存储写，**那 1 毫秒恰好够 fire-and-forget 的用量写完成**。
   * 换句话说，那次「已经写完」是被邻居的 I/O 顺手带完的，不是被 `await` 保证的。
   * ⇒ 挂起点要长到「链上任何顺带的等待都盖不住它」，这条性质才不依赖中间件的排序。
   */
  constructor(readonly inner: Storage, private readonly usagePutDelayMs = 0) {}
  async get<T>(k: string): Promise<T | null> { return this.inner.get<T>(k); }
  async put<T>(k: string, v: T, expiresAt?: number): Promise<void> {
    const isUsage = k.startsWith("usage:");
    this.allPuts++;
    if (isUsage) { this.usagePuts.push(k); this.lastExpiresAt = expiresAt; }
    if (this.putFails) throw new Error("write quota exhausted");
    if (isUsage && this.usagePutDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.usagePutDelayMs));
    }
    await this.inner.put(k, v, expiresAt);
    if (isUsage) this.usagePutsDone++;
  }
  async delete(k: string): Promise<void> { return this.inner.delete(k); }
  async list(p: string): Promise<string[]> { return this.inner.list(p); }
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
  const storage = new UsagePutCounter(new MemoryStorage(1, o.now), 40);
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
   * **「关」必须是零成本**（P3d 计划全局约束 16）。
   *
   * ⚠️ **两个方向在同一格里跑，顺序是「先证明夹具真的会落盘，再证明关掉之后不落」。**
   * 只写关着那一侧的话，这条断言在任何「其实压根没到落盘条件」的夹具上都是绿的
   * ——那正是 P3c Task 3 那格「鉴权失败的非幂等请求必须零副作用」踩过的陷阱：
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
  it("落盘在响应返回之前就完成 —— fire-and-forget 在 Worker 上会被响应返回后的 isolate 停摆静默截断", async () => {
    let t = DAY0_MS;
    const g = await gateway({ enabled: true, now: () => t });
    await g.hit();
    t += USAGE_FLUSH_MIN_INTERVAL_MS + 1;
    const res = await g.hit();
    expect(res.status, "夹具前提：这一次请求本身是走通了的").toBe(503);
    // **响应已经回来了，此刻那次写必须已经落定**。手写字面量 1。
    // `void flush()` 的实现在这一刻是 0：写调用发出去了，1 毫秒的挂起还没走完。
    expect(
      g.storage.usagePutsDone,
      "响应返回时那次落盘还没写完 —— 中间件没有 await，Worker 上这次写会被截断",
    ).toBe(1);
  });

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
  it("四条协议各打一次：byProtocol 分出四个键，且只有 anthropic/responses/gemini 三条带 token —— OpenAI 那条网关没解析过响应体（订正 F1），缺口由 tokensCoverage 如实说出去", async () => {
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
    expect(tokensOf("gemini"), "拿协议目录的 usagePath（Gemini 那条是 usageMetadata）去取上游对象只会取到 undefined ⇒ 恒 0").toEqual({ tokensIn: 7, tokensOut: 11 });
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
  const storage = new UsagePutCounter(new MemoryStorage(1, o.now), 40);
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
  it("一次落盘只写 1 个键，跨 UTC 零点那一次写 2 个 —— 预算数的是 put 不是 flush（评审 C1），少扣一格配额账就是假的", async () => {
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
   * ② **`consume()` 每写一个键调一次，不是每次 flush 调一次**（评审 C1 的正主）：
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
   * 设计原方案是 Cron 压实 + 删分片，被评审 C5 推翻：那种有界性依赖「落盘节奏恰好
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
