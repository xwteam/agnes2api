import { describe, it, expect } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { MemoryStorage } from "../helpers/fake-storage.js";

const AUTH = { headers: { "x-admin-key": TEST_ADMIN_TOKEN } };

/**
 * **诚实记录**：本文件下方那条逐字照抄简报的 U-C 用例（"一次请求之后，存储里确实
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
 * 这一点之后新补的，是本任务里唯一真正守住 U-C 的用例；上面那条逐字照抄简报的
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
    expect(typeof body.generatedAt).toBe("number");
  });

  /**
   * **U-C（订正 F7 / 待验证）：这是本期唯一一处依赖运行时调度时序的地方。**
   * 事件落库的 `put` 在中间件里被 `await`，必须在响应返回前完成。
   * 两种运行时**各断言一遍**——workerd 的 isolate 生命周期与 node 完全不同，
   * 只在 node 侧验过就假设 worker 侧一样，正是这个项目栽过的那类「未经核实的前提」。
   */
  it("一次请求之后，存储里确实有事件分片落盘（两种运行时各跑一遍）", async () => {
    const st = new CountingStorage();
    let t = 0;
    const { app } = await makeApp([], ["k1"], {}, () => (t += 61_000), { storage: st });
    // 打一个必然产生事件的请求：未鉴权的管理接口 ⇒ admin.login_failed
    await app.request("/admin/api/session");
    await app.request("/admin/api/session"); // 第二次的收尾把第一次攒的落盘
    const keys = await st.inner.list("event:");
    expect(keys.some((k) => k.startsWith("event:")), "事件没有落盘").toBe(true);
  });

  /**
   * **U-C 真正的守卫：响应返回时，落盘必须已经完成**（不是"最终会完成"）。
   * 用 `DelayedStorage` 让每次存储访问都真的经过一次 `setTimeout`——这样
   * "`await flush()` 与否"这件事才会在**响应返回的那一刻**产生可观测的差异：
   * awaited 版本里 `app.request()` 的 Promise 要等 `maybeFlush()` 的存储调用全部
   * 落定才会 resolve；fire-and-forget 版本里 `app.request()` 提前 resolve，
   * 这时候存储里还没有写完。两种运行时各跑一遍。
   */
  it("响应返回的那一刻（不是之后某个时刻），事件已经落盘（真实异步延迟下可观测）", async () => {
    const st = new MemoryStorage(5);
    let t = 0;
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
   * **补的第三条 U-C 用例，专门对齐"挂在 next() 之前"这条变异。**
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
    const st = new MemoryStorage(5);
    let t = 0;
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

  it("?limit=<n> 截断结果，truncated 如实报 true（评审 I3）", async () => {
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
   * **N2 从陷阱变成断言**：这里刻意验证下载端点是裸 `Response`（`content-type`
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
