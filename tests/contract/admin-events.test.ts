import { describe, it, expect } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { shardKey, windowIndex } from "../../src/core/admin/event-ring.js";

const AUTH = { headers: { "x-admin-key": TEST_ADMIN_TOKEN } };

/**
 * **诚实记录**：本文件下方那条逐字照抄简报的落盘用例（"一次请求之后，存储里确实
 * 有事件落盘"）用的是**零延迟**的 `MemoryStorage`——它的 `get`/`put` 是包了 `async`
 * 的同步 Map 操作，每次 `await` 只消耗**一个微任务 tick**，不产生任何真实的异步
 * 延迟。**实测**：把 `log-flush.ts` 的 `await flush()` 改成 fire-and-forget 的
 * `flush()` 之后，那条用例**仍然全绿**（两种运行时都是）——因为 Hono 自身处理
 * 一个请求要经过的微任务链，比 `maybeFlush()` 内部 `get→put` 那几级 `await` 更长，
 * 零延迟存储的写入总能在 `app.request()` 真正返回前"追上"，掩盖了
 * await/fire-and-forget 的差异。这正是硬要求 B 第 4 条点名的第二种 ESCAPED
 * 成因："用例的观测点不对"，不是变异没对齐——变异改的就是 `log-flush.ts` 那一行，
 * 找错的是拿什么存储去观测它。
 *
 * 用 `new MemoryStorage(5)`（**真实带异步延迟**，5ms，与 `FakeFetcher` 的
 * `delayMs` 同一个机制，见 `tests/helpers/fake-storage.ts` 的说明）包一层，
 * 才能把"响应有没有等写完"这件事变得可观测——这与生产里 Worker 真实 KV 写入 /
 * Node 真实磁盘写入都有不可忽略的 IO 延迟是同一个道理。下面这些用例就是诊断出
 * 这一点之后新补的，是本任务里唯一真正守住「响应返回前必须落盘」的用例；上面那条照抄简报的
 * 用例继续保留（它仍然验证"最终确实落盘"，只是不验证"响应返回前"这个时序）。
 */

interface EventsBody {
  items: Array<{ ts: number; level: string; event: string; msg?: string; corr?: string;
    fields?: Record<string, unknown> }>;
  cursor: number | null;
  shardId: string;
  buffered: number;
  dropped: number;
  budgetExhausted: boolean;
  truncated: boolean;
  cursorAhead: boolean;
  malformed: number;
  generatedAt: number;
}

async function getEvents(
  app: Awaited<ReturnType<typeof makeApp>>["app"],
  qs = "",
): Promise<{ status: number; body: EventsBody }> {
  const res = await app.request(`/admin/api/events${qs}`, AUTH);
  return { status: res.status, body: (await res.json()) as EventsBody };
}

describe("GET /admin/api/events", () => {
  it("未鉴权 401（矩阵已覆盖，这里只留一条冒烟）", async () => {
    const { app } = await makeApp();
    expect((await app.request("/admin/api/events")).status).toBe(401);
  });

  it("没有任何事件时：items 是空数组、cursor 是 null、字段如实为 0/false", async () => {
    const { app } = await makeApp();
    const { status, body } = await getEvents(app);
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.cursor).toBeNull();
    // makeApp() 默认给的 shardId 是固定字面量 "test-shard"（见 tests/helpers/make-app.ts）。
    expect(body.shardId).toBe("test-shard");
    expect(body.buffered).toBe(0);
    expect(body.dropped).toBe(0);
    expect(body.budgetExhausted).toBe(false);
    expect(body.truncated).toBe(false);
    expect(body.cursorAhead).toBe(false);
    // makeApp() 默认时钟是固定字面量 1000（见 tests/helpers/make-app.ts）——评审
    // T2：这里原来是 `typeof body.generatedAt === "number"`，形状断言冒充行为断言，
    // 把 `generatedAt: now` 改成 `Date.now()` 照样全绿存活（已实测）。下面另有一条
    // 专门的用例（照抄 admin-keys.test.ts 的同名用例）钉死"来自注入的时钟"这条
    // 行为，这里顺手把手写字面量也钉上，两处不冲突。
    expect(body.generatedAt).toBe(1000);
  });

  /**
   * **评审 T2**：照抄 `tests/contract/admin-keys.test.ts` 的
   * 「generatedAt 来自注入的时钟，不是 handler 自己读的墙上时间」——姊妹端点
   * 早就这么钉了，事件端点这次才补上。用一个与 `makeApp()` 默认值（1000）不一样
   * 的字面量，避免"恰好撞上默认值"这种巧合掩盖"其实读的是 handler 自己的墙上
   * 时间"这类回归。
   */
  it("generatedAt 来自注入的时钟，不是 handler 自己读的墙上时间", async () => {
    const { app } = await makeApp([], ["k1"], {}, () => 424_242);
    expect((await getEvents(app)).body.generatedAt).toBe(424_242);
  });

  /**
   * **（订正 / 待验证）这是本期唯一一处依赖运行时调度时序的地方。**
   * 事件落库的 `put` 在中间件里被 `await`，必须在响应返回前完成。
   * 两种运行时**各断言一遍**——workerd 的 isolate 生命周期与 node 完全不同，
   * 只在 node 侧验过就假设 worker 侧一样，正是这个项目栽过的那类「未经核实的前提」。
   */
  it("一次请求之后，存储里确实有事件分片落盘（两种运行时各跑一遍）", async () => {
    let t = 0;
    // `st` 的内部 MemoryStorage 与下面 makeApp 的 `now` 必须共用同一个 `t`
    // （评审发现：TTL 判定默认走真实 Date.now()，不对齐会让刚落盘的事件"生下来
    // 就已经过期"，见 tests/helpers/make-app.ts 的同一条说明）。
    const st = new CountingStorage(new MemoryStorage(undefined, () => t));
    const { app } = await makeApp([], ["k1"], {}, () => (t += 61_000), { storage: st });
    // 打一个必然产生事件的请求：未鉴权的管理接口 ⇒ admin.login_failed
    await app.request("/admin/api/session");
    await app.request("/admin/api/session"); // 第二次的收尾把第一次攒的落盘
    const keys = await st.inner.list("event:");
    expect(keys.some((k) => k.startsWith("event:")), "事件没有落盘").toBe(true);
  });

  /**
   * **`fetch` 路径仍然受最小间隔节流 —— 这条闸不许被顺手拆掉。**
   *
   * 本任务给 `StoreLogger` 加了一个**绕过最小间隔**的 `flush()`（补池那条路必须
   * 用它，否则跑得快的那一轮一条事件都写不出去）。它是个逃生口：`src/http/app.ts`
   * 里那行 `logFlush(() => storeLogger.maybeFlush())` 一旦被顺手改成 `flush()`，
   * §8.5 点名的那根杠杆就彻底放开了——白名单里的 `admin.login_failed` 是**任何
   * 未鉴权请求都能触发**的，等于让攻击者按请求数驱动 KV 写。
   *
   * 变异实测（本任务）：把 app.ts 那一行改成 `flush()`，**这一格是全套 1400+
   * 用例里唯一变红的**——上面几格都在推进 61 秒的时钟，不推时钟的这一格才是
   * 那道闸的观测点。
   *
   * 时钟**刻意不推进**：三次请求落在同一个最小间隔窗口内，只有第一次收尾
   * （距构造时刻已过 61 秒）会真的写。
   */
  it("fetch 路径仍然受最小间隔节流：同一窗口内连打三次请求，事件分片只写一次", async () => {
    let t = 1000;
    const st = new CountingStorage(new MemoryStorage(undefined, () => t));
    // 只在**装配之后**推进一次，之后 now 恒定 ⇒ 后续请求全部落在同一个间隔窗口内。
    const { app } = await makeApp([], ["k1"], {}, () => t, { storage: st });
    t += 61_000;
    await app.request("/admin/api/session"); // 攒一条 admin.login_failed
    await app.request("/admin/api/session"); // 这一次的收尾把上一条落盘
    const after2 = st.puts;
    await app.request("/admin/api/session");
    await app.request("/admin/api/session");
    expect(
      st.puts - after2,
      "同一个最小间隔窗口内的后续请求不许再落盘——那道闸被拆了",
    ).toBe(0);
    expect(after2, "前置条件：第一次收尾确实写了一次，不是整段都没写").toBeGreaterThan(0);
  });

  /**
   * **真正的守卫：响应返回时，落盘必须已经完成**（不是"最终会完成"）。
   * 用 `DelayedStorage` 让每次存储访问都真的经过一次 `setTimeout`——这样
   * "`await flush()` 与否"这件事才会在**响应返回的那一刻**产生可观测的差异：
   * awaited 版本里 `app.request()` 的 Promise 要等 `maybeFlush()` 的存储调用全部
   * 落定才会 resolve；fire-and-forget 版本里 `app.request()` 提前 resolve，
   * 这时候存储里还没有写完。两种运行时各跑一遍。
   */
  it("响应返回的那一刻（不是之后某个时刻），事件已经落盘（真实异步延迟下可观测）", async () => {
    let t = 0;
    // storage 与 now 必须共用同一个假时钟（评审发现，理由见 tests/helpers/make-app.ts
    // 的同一条说明），否则 list() 前置条件本身先假到把这条用例的意义架空。
    const st = new MemoryStorage(5, () => t);
    const { app } = await makeApp([], ["k1"], {}, () => (t += 61_000), { storage: st });
    await app.request("/admin/api/session");
    await app.request("/admin/api/session"); // 第二次的收尾把第一次攒的落盘
    // **不额外等待**：这条用例的意义就在于紧接着 app.request() resolve 之后立刻查，
    // 不给任何补救的机会。
    const keys = await st.list("event:");
    expect(keys.some((k) => k.startsWith("event:")),
      "响应已经返回，但事件还没有落盘——落盘没有真的被 await").toBe(true);
  });

  /**
   * **补的第三条落盘用例，专门对齐"挂在 next() 之前"这条变异。**
   *
   * 上面两条用例都打了**两次**请求，检验的是"最终有没有事件落盘"——这条性质
   * 对"logFlush 挂到 next() 之前"这个变异**不够精确**：挂在 next() 之前时，
   * 每次请求的 flush() 落的是**上一次**请求攒下的旧事件（这次自己的事件要等
   * next() 跑完才会进缓冲，永远慢一拍），只打两次的话第一次的事件依然会在
   * 第二次请求的"提前 flush"里被写掉——两条用例都误判为绿（**已实测**，
   * 见下方"诚实记录"）。
   *
   * 只打**一次**请求就不再有"下一次帮着补"的机会：正确顺序下，这一次请求
   * 自己产生的事件必须自己被落盘（已用真实进程验证过，见任务报告）；
   * 挂在 next() 之前时，flush() 跑的时候缓冲还是空的，这一次事件永远进不去。
   */
  it("只打一次请求，这次请求自己产生的事件就必须自己被落盘（对齐 next() 之前这条变异）", async () => {
    let t = 0;
    // 同一条说明：storage 与 now 必须共用同一个假时钟。
    const st = new MemoryStorage(5, () => t);
    const { app } = await makeApp([], ["k1"], {}, () => (t += 61_000), { storage: st });
    await app.request("/admin/api/session");
    const keys = await st.list("event:");
    expect(keys.some((k) => k.startsWith("event:")),
      "这次请求自己的事件没有落盘——logFlush 是不是被挂到了 next() 之前？").toBe(true);
  });

  it("落盘之后，/admin/api/events 能读到那条 admin.login_failed", async () => {
    let t = 0;
    const { app } = await makeApp([], ["k1"], {}, () => (t += 61_000));
    await app.request("/admin/api/session");
    await app.request("/admin/api/session");
    const { body } = await getEvents(app);
    expect(body.items.some((e) => e.event === "admin.login_failed")).toBe(true);
    expect(body.shardId).toBe("test-shard");
  });

  it("items 按 ts 降序返回（最新在前）", async () => {
    let t = 1000;
    const now = () => t;
    const { app, storeLogger } = await makeApp([], ["k1"], {}, now);
    storeLogger.log({ level: "info", event: "a.oldest" });
    t = 2000;
    storeLogger.log({ level: "info", event: "b.middle" });
    t = 3000;
    storeLogger.log({ level: "info", event: "c.newest" });
    // 冷启动首刷受节流（构造时 lastFlushAt = now() = 1000），推进过最小间隔才会真的写。
    t = 1000 + 60_000;
    await storeLogger.maybeFlush();
    const { body } = await getEvents(app);
    expect(body.items.map((e) => e.event)).toEqual(["c.newest", "b.middle", "a.oldest"]);
  });

  it("?after=<ts> 只返回更新的事件", async () => {
    let t = 0;
    const now = () => (t += 61_000);
    const { app, storeLogger } = await makeApp([], ["k1"], {}, now);
    storeLogger.log({ level: "info", event: "old.one" });
    await storeLogger.maybeFlush();
    const firstTs = t;
    storeLogger.log({ level: "info", event: "new.one" });
    await storeLogger.maybeFlush();

    const all = await getEvents(app);
    expect(all.body.items.map((e) => e.event).sort()).toEqual(["new.one", "old.one"]);

    const after = await getEvents(app, `?after=${firstTs}`);
    expect(after.body.items.map((e) => e.event)).toEqual(["new.one"]);
  });

  /**
   * **评审发现**：负数 `after` 是敌意/无意义输入，`afterParam` 直接当缺失处理
   * （回落成冷读），不是让它原样流进 `candidateKeys`。
   */
  it("?after 是负数时当缺失处理（冷读，不 400、不放大）", async () => {
    let t = 100_000;
    const { app, storeLogger } = await makeApp([], ["k1"], {}, () => t);
    storeLogger.log({ level: "info", event: "e.info" });
    t += 60_000;
    await storeLogger.maybeFlush();
    const { status, body } = await getEvents(app, "?after=-100000");
    expect(status).toBe(200);
    expect(body.items.map((e) => e.event)).toEqual(["e.info"]);
  });

  /**
   * **评审发现**：`after` 所在的时间窗比当前请求的 `now` 所在的窗口还晚时
   * （时钟回拨，或者某个 isolate 的时钟偏快、写出的 ts 是"未来值"），
   * `items` 会是空的——`cursorAhead` 必须如实报出来，不能让调用方把这种情况
   * 误判成"确实没有新事件"。
   */
  it("?after 领先于服务器当前时钟时，items 为空但 cursorAhead 如实报 true", async () => {
    const { app } = await makeApp([], ["k1"], {}, () => 1_000_000);
    // 服务器当前时钟是 1,000,000；after 传一个远超过它的未来值。
    const { status, body } = await getEvents(app, "?after=100000000000");
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.cursorAhead, "游标领先于本次请求的时钟，必须如实报出来").toBe(true);
  });

  it("cursorAhead 在正常情况下（after 落后于 now）是 false，不是恒 true", async () => {
    let t = 100_000;
    const { app, storeLogger } = await makeApp([], ["k1"], {}, () => t);
    storeLogger.log({ level: "info", event: "e.info" });
    t += 60_000;
    await storeLogger.maybeFlush();
    const { body } = await getEvents(app, "?after=1000"); // 远早于当前时钟，正常的陈旧游标
    expect(body.cursorAhead).toBe(false);
  });

  /**
   * **评审二审：如实记录一个盲区，不是修它。**
   *
   * `after` 领先 `now` 但仍落在**同一个时间窗**内时（这里 `after = now + 10min`，
   * 窗口宽度 `EVENT_WINDOW_MS` 是 1 小时），`cursorAhead` 的判据
   * `windowIndex(after) > windowIndex(now)` 不成立——`items` 依旧是空的，但
   * `cursorAhead` 报 `false`，与"确实没有新事件"依旧无法区分。这条用例把这个
   * 盲区钉成一条断言（不是当作 bug 修掉）：`events.ts` 的 JSDoc 已经订正过这一段，
   * 这里补上真实证据，不让文字描述空转。
   */
  it("after 领先 now 但仍在同一个时间窗内：items 为空、cursorAhead 仍是 false（评审二审，已知盲区，非 bug）", async () => {
    const now = 1_000_000;
    const { app } = await makeApp([], ["k1"], {}, () => now);
    const nearFutureAfter = now + 10 * 60_000; // +10 分钟，仍在同一个 1 小时窗口内
    const { status, body } = await getEvents(app, `?after=${nearFutureAfter}`);
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.cursorAhead, "同一窗口内的未来 after 不会触发 cursorAhead——这是已知、自限的盲区").toBe(false);
  });

  it("?level=<lvl> 只返回该级别的事件", async () => {
    let t = 100_000;
    const { app, storeLogger } = await makeApp([], ["k1"], {}, () => t);
    storeLogger.log({ level: "info", event: "e.info" });
    storeLogger.log({ level: "error", event: "e.error" });
    t += 60_000; // 冷启动首刷受节流，推进过最小间隔才会真的写
    await storeLogger.maybeFlush();

    const errorOnly = await getEvents(app, "?level=error");
    expect(errorOnly.body.items.map((e) => e.event)).toEqual(["e.error"]);

    const warnOnly = await getEvents(app, "?level=warn");
    expect(warnOnly.body.items).toEqual([]);
  });

  it("?level 传一个不认识的值时，等同不筛（回落，不 400）", async () => {
    let t = 100_000;
    const { app, storeLogger } = await makeApp([], ["k1"], {}, () => t);
    storeLogger.log({ level: "info", event: "e.info" });
    t += 60_000;
    await storeLogger.maybeFlush();
    const { status, body } = await getEvents(app, "?level=not-a-level");
    expect(status).toBe(200);
    expect(body.items.map((e) => e.event)).toEqual(["e.info"]);
  });

  it("?limit=<n> 截断结果，truncated 如实报 true（评审发现）", async () => {
    let t = 100_000;
    const { app, storeLogger } = await makeApp([], ["k1"], {}, () => t);
    for (let i = 0; i < 5; i++) storeLogger.log({ level: "info", event: `e${i}` });
    t += 60_000;
    await storeLogger.maybeFlush();
    const { body } = await getEvents(app, "?limit=2");
    expect(body.items.length).toBe(2);
    expect(body.truncated, "5 条过滤后剩 5 条，limit=2 截掉了 3 条").toBe(true);
  });

  it("?limit 没有截断任何东西时 truncated 是 false（不是恒 true）", async () => {
    let t = 100_000;
    const { app, storeLogger } = await makeApp([], ["k1"], {}, () => t);
    storeLogger.log({ level: "info", event: "only.one" });
    t += 60_000;
    await storeLogger.maybeFlush();
    const { body } = await getEvents(app, "?limit=200");
    expect(body.items.length).toBe(1);
    expect(body.truncated).toBe(false);
  });

  it("dropped 如实反映环形缓冲丢弃的条数", async () => {
    const { app, storeLogger } = await makeApp();
    for (let i = 0; i < 150; i++) storeLogger.log({ level: "info", event: `e${i}` });
    const { body } = await getEvents(app);
    expect(body.dropped).toBe(50);
    expect(body.buffered).toBe(100);
  });

  it("budgetExhausted 如实反映写预算用尽（12 次/天用满之后）", async () => {
    let t = 0;
    const now = () => (t += 61_000);
    const { app, storeLogger } = await makeApp([], ["k1"], {}, now);
    for (let i = 0; i < 13; i++) {
      storeLogger.log({ level: "info", event: `e${i}` });
      await storeLogger.maybeFlush();
    }
    const { body } = await getEvents(app);
    expect(body.budgetExhausted).toBe(true);
  });

  /**
   * **明文凭据不外泄（硬要求第 8 条）**：断言的是**整段响应文本**，不是某个字段
   * 为 undefined——后者对「凭据被塞进了别的字段」完全无感。
   */
  it("整段响应文本不含明文管理口令，即便触发过登录失败事件", async () => {
    let t = 0;
    const now = () => (t += 61_000);
    const { app } = await makeApp([], ["k1"], {}, now);
    await app.request("/admin/api/session", { headers: { "x-admin-key": "guessed-secret-value" } });
    await app.request("/admin/api/session"); // 收尾把上一条落盘
    const res = await app.request("/admin/api/events", AUTH);
    const text = await res.text();
    expect(text).not.toContain(TEST_ADMIN_TOKEN);
    expect(text).not.toContain("guessed-secret-value");
  });
});

describe("GET /admin/api/events/download", () => {
  it("未鉴权 401（矩阵已覆盖，这里只留一条冒烟）", async () => {
    const { app } = await makeApp();
    expect((await app.request("/admin/api/events/download")).status).toBe(401);
  });

  /**
   * **那条陷阱变成断言**：这里刻意验证下载端点是裸 `Response`（`content-type`
   * 由 handler 自己设，不是 Hono 的 `c.text()` 那条自动路径）**仍然**带全局
   * nosniff——把 `app.ts` 的 `c.header` 挪到 `next()` 之前，这条会变红。
   */
  it("下载端点是裸 Response，且**仍然**带全局 nosniff", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin/api/events/download", AUTH);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-disposition")).toContain("agnes2api-events.txt");
    expect(res.headers.get("x-content-type-options"), "全局 nosniff 对裸 Response 失效了").toBe("nosniff");
  });

  it("正文是逐行 JSON.stringify，每行都能独立解析", async () => {
    let t = 100_000;
    const { app, storeLogger } = await makeApp([], ["k1"], {}, () => t);
    storeLogger.log({ level: "info", event: "e.one", fields: { a: 1 } });
    storeLogger.log({ level: "warn", event: "e.two" });
    t += 60_000;
    await storeLogger.maybeFlush();

    const res = await app.request("/admin/api/events/download", AUTH);
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    const events = lines.map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events.sort()).toEqual(["e.one", "e.two"]);
  });

  it("整段响应文本不含明文管理口令", async () => {
    let t = 0;
    const now = () => (t += 61_000);
    const { app } = await makeApp([], ["k1"], {}, now);
    await app.request("/admin/api/session", { headers: { "x-admin-key": "guessed-secret-value" } });
    await app.request("/admin/api/session");
    const res = await app.request("/admin/api/events/download", AUTH);
    const text = await res.text();
    expect(text).not.toContain(TEST_ADMIN_TOKEN);
    expect(text).not.toContain("guessed-secret-value");
  });
});

/**
 * **畸形事件条目那条 Critical 的端点级回归，五种形态逐条穷举（不是抽样）。**
 *
 * 触发条件如实写：`src/` 里今天没有产出畸形分片值的代码路径，已知的现实来源是
 * **存储外部**——运维手改 KV / `store.json`、KV 值损坏、Node 侧进程被杀时
 * `store.json` 写到一半。**这不是"不可达"，是"不经我们的代码可达"**，
 * 所以夹具直接往存储里写，而不是去构造一条产出它的代码路径。
 *
 * 修复前的实测结果逐行记在每一格里，别把它们读成"现在的行为"。
 */
describe("存储里的畸形事件条目：端点必须活着，且游标契约不许破", () => {
  const AT = 1000;
  /** 把一个任意值直接摆进第 0 个时间窗的第 0 号槽位。 */
  async function withShard(value: unknown) {
    const t = AT;
    const storage = new MemoryStorage(undefined, () => t);
    await storage.put(shardKey(windowIndex(t), 0), value);
    return makeApp([], ["k1"], {}, () => t, { storage });
  }

  it("单条 [null]：修复前 500，现在 200 且 items 为空、cursor 为 null", async () => {
    // 变红条件：narrowShard 退回 `Array.isArray(s) ? s : []`
    const { app } = await withShard([null]);
    const { status, body } = await getEvents(app);
    expect(status, "一条 null 让整个事件板块 500").toBe(200);
    expect(body.items).toEqual([]);
    expect(body.cursor).toBeNull();
    expect(body.malformed, "丢了几条要能被数出来 —— 静默丢弃就是撒谎").toBe(1);
  });

  it("[null] 且带 ?after=1：修复前同样 500（抛点在 filter 那一行，不是 mergeShards）", async () => {
    const { app } = await withShard([null]);
    const { status, body } = await getEvents(app, "?after=1");
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
  });

  it("[null, 好条目]：坏的被丢掉，好的照常返回（不是整片丢掉）", async () => {
    const { app } = await withShard([null, { ts: 5, level: "info", event: "good" }]);
    const { status, body } = await getEvents(app);
    expect(status).toBe(200);
    expect(body.items.map((e) => e.event)).toEqual(["good"]);
    expect(body.cursor).toBe(5);
    expect(body.malformed).toBe(1);
  });

  /**
   * **最要命的那两种根本不 500。** 修复前它们一路通过、原样进 `items`，
   * 并且让 `cursor` 变成 `undefined` ⇒ `c.json` 把该字段**整个丢掉** ⇒
   * 前端读到"字段不存在" ⇒ 游标永远推不动 ⇒ 稳态读吞吐 276,480 次/天。
   * 所以这两格除了断言条目被丢掉，**还必须断言 `cursor` 这个字段本身存在**。
   */
  it("字符串条目：被丢掉，且响应体里 cursor 字段必须存在（修复前它整个消失）", async () => {
    // 变红条件：handler 退回 `cursor: items[0]!.ts`
    const { app } = await withShard(["evil-string", { ts: 5, level: "info", event: "good" }]);
    const { status, body } = await getEvents(app);
    expect(status).toBe(200);
    expect(body.items.map((e) => e.event)).toEqual(["good"]);
    expect("cursor" in body, "cursor 字段不许从响应体里消失").toBe(true);
    expect(body.cursor).toBe(5);
  });

  it("缺 ts 的对象条目：同上，被丢掉且 cursor 字段还在", async () => {
    const { app } = await withShard([{ level: "info", event: "no-ts" }, { ts: 5, level: "info", event: "good" }]);
    const { body } = await getEvents(app);
    expect(body.items.map((e) => e.event)).toEqual(["good"]);
    expect("cursor" in body).toBe(true);
    expect(body.cursor).toBe(5);
  });

  /**
   * **`cursor` 只有两种合法值，逐种形态断言一次。** 这是契约本身，
   * 与"某一种畸形输入被处理掉了"是两回事：即便全部条目都被丢光，
   * `cursor` 也必须是 `null` 而不是消失、不是 `undefined`、不是 `NaN`。
   */
  it("整片都是畸形条目时，cursor 是 null（不是 undefined、不是 NaN）", async () => {
    const { app } = await withShard(["a", null, 7, { level: "info" }, [], { ts: "5" }]);
    const { status, body } = await getEvents(app);
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect("cursor" in body).toBe(true);
    expect(body.cursor).toBeNull();
    expect(body.malformed).toBe(6);
  });

  /**
   * ⚠️ **用例名与实际喂进去的输入曾经对不上，如实登记（评审 m3）**：
   * 这一格原来叫「ts 是 NaN 的条目也被丢掉」，而夹具经 `MemoryStorage` 的
   * `JSON.stringify` 走了一圈——**JSON 承载不了 `NaN`，它落地时已经是 `null`**。
   * 也就是说这一格从来没有真的测过 `NaN`。**真的 `NaN` 由
   * `tests/unit/admin/event-entry.test.ts` 的
   * 「ts 是 NaN / Infinity / -Infinity 的条目一样被丢掉」在单测层面覆盖**
   * （那里不经 JSON）。这一格改成如实描述它真正测的那件事。
   */
  it("ts 是 null 的条目也被丢掉（JSON 里 NaN 落地就是 null，这是端点侧真正会遇到的形态）", async () => {
    const { app } = await withShard([{ ts: null, level: "info", event: "null-ts" }]);
    const { body } = await getEvents(app);
    expect(body.items).toEqual([]);
    expect(body.cursor).toBeNull();
  });

  it("整片不是数组（字符串 / 数字 / 对象）：当空分片，且 malformed 计 0 而不是瞎报", async () => {
    for (const bad of ["abc", 7, { a: 1 }]) {
      const { app } = await withShard(bad);
      const { status, body } = await getEvents(app);
      expect(status, JSON.stringify(bad)).toBe(200);
      expect(body.items).toEqual([]);
      expect(body.malformed, "整片不是数组属于「这把键还没被写过」那一类，不是畸形条目").toBe(0);
    }
  });

  it("level 畸形的条目**原样保留**（那只是显示问题，归一化在前端）", async () => {
    const { app } = await withShard([{ ts: 5, level: "loud", event: "kept" }]);
    const { body } = await getEvents(app);
    expect(body.items.map((e) => e.event)).toEqual(["kept"]);
    expect(body.items[0]!.level, "后端一个字都不许改它的 level").toBe("loud");
    expect(body.malformed, "它没有被丢，所以不计数").toBe(0);
  });

  /**
   * **按级别过滤那一轴的代价，明写成用例，别让它变成一句没人验的话。**
   * 畸形 `level` 的条目在「按级别筛选」时选不中（`e.level === level` 恒假），
   * 只在「全部级别」下可见。**这是已知限制，登记不修。**
   */
  it("已知限制：level 畸形的条目按级别筛选时选不中，只在「全部级别」下可见", async () => {
    const { app } = await withShard([{ ts: 5, level: "loud", event: "kept" }]);
    expect((await getEvents(app)).body.items.length, "全部级别下看得到").toBe(1);
    for (const lvl of ["debug", "info", "warn", "error"]) {
      expect((await getEvents(app, `?level=${lvl}`)).body.items.length, lvl).toBe(0);
    }
  });

  /**
   * **下载端点不是同样的行为，详表第 2 行**：单条 `[null]` 修复前它返回
   * **200，正文是字面量 `null`**（`JSON.stringify(null)`），账本里没有这条。
   * 两条以上时才 500。修复后两种都回空正文。
   */
  it("下载端点：畸形条目不再变成正文里的字面量 null，也不再 500", async () => {
    const one = await withShard([null]);
    const r1 = await one.app.request("/admin/api/events/download", AUTH);
    expect(r1.status).toBe(200);
    expect(await r1.text(), "正文曾经是字面量 null").toBe("");

    const two = await withShard([null, { ts: 5, level: "info", event: "good" }]);
    const r2 = await two.app.request("/admin/api/events/download", AUTH);
    expect(r2.status, "两条以上时曾经 500").toBe(200);
    expect(await r2.text()).toContain("good");
  });

  it("没有畸形数据时 malformed 恒为 0 —— 这正是它当对照组的全部价值", async () => {
    const { app } = await withShard([{ ts: 5, level: "info", event: "good" }]);
    expect((await getEvents(app)).body.malformed).toBe(0);
  });

  /**
   * **handler 自己那道闸，单独钉一次。**
   *
   * ⚠️ **这一格是变异验证逼出来的，成因如实登记**：那条变异（`cursor` 退回
   * `items[0]!.ts`）在**端到端**用例下 **ESCAPED** —— 因为经过 `narrowShard`
   * 之后 `items[0].ts` 必然已经是有限数字，两种写法在那些状态下**数学上等价**
   * （本仓登记的第 5 种假阳性：覆盖的状态让被测的选择不可观测）。
   *
   * 这**不是**"这条性质不成立"，是"观测点不对"：`events.ts` 那行是**第二道闸**，
   * 只有在第一道（窄化）不存在时才看得出差别。所以观测点下沉一层——把这一个
   * `storeLogger`（**app 持有的正是同一个实例**，`makeApp` 交出来的就是它）的
   * `readEvents` 换掉，让 handler 收到一批畸形条目。跑的仍然是**真的**
   * `eventsHandler` 与真的路由，只替换了它下面那一层。
   *
   * 换掉之后那条变异 **CAUGHT**：`cursor` 变成 `undefined` ⇒ `c.json` 把字段整个丢掉。
   */
  it("handler 自己保证 cursor 是 number 或 null —— 即便下层交上来的是畸形条目", async () => {
    const { app, storeLogger } = await makeApp();
    for (const bad of [
      [{ level: "info", event: "no-ts" }],
      [{ ts: "5", level: "info", event: "string-ts" }],
      [{ ts: Number.NaN, level: "info", event: "nan-ts" }],
    ]) {
      // 只替换 readEvents 这一层，handler / 路由 / 序列化全是真的。
      storeLogger.readEvents = async () => ({ items: bad as never, malformed: 0 });
      const { status, body } = await getEvents(app);
      expect(status, JSON.stringify(bad)).toBe(200);
      expect("cursor" in body, `cursor 字段从响应体里消失了：${JSON.stringify(bad)}`).toBe(true);
      expect(body.cursor, `cursor 必须是 null 而不是 ${String(body.cursor)}`).toBeNull();
    }
  });
});
