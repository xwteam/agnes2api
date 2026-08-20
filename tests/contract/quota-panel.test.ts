import { describe, it, expect } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { CountingStorage } from "../helpers/counting-storage.js";

/**
 * **面板的轮询路径不许出现 `list()`，也不许产生额外的读。**
 *
 * 设计文档 §2.4 第 1 条：面板每 15 秒轮询一次，若走 `list("…")`，
 * 单个开着的标签页就是 5,760 次 list/天——**一个忘了关的浏览器标签能把当天的
 * list 配额打爆 5 倍，而它和网关转发共用同一个桶**。
 *
 * 这一组测的是**次数**，不是「有没有调用 list」这种形状：
 * 数出来的必须恰好等于手写的期望值。
 */
describe("面板轮询的配额账", () => {
  it("连打 20 次 /admin/api/keys，list 次数为 0，get 次数不增加", async () => {
    const st = new CountingStorage();
    const { app } = await makeApp([], ["k1", "k2", "k3"], { poolCacheTtlMs: 60_000 }, () => 1000, { storage: st });
    await app.request("/admin/api/keys", { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });  // 预热快照
    const base = { lists: st.lists, gets: st.gets };
    for (let i = 0; i < 20; i++) {
      const res = await app.request("/admin/api/keys", { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });
      expect(res.status).toBe(200);
    }
    expect(st.lists - base.lists, "面板轮询路径出现了 list()").toBe(0);
    expect(st.gets - base.gets, "面板轮询路径产生了额外的读，它应当共用转发路径的快照").toBe(0);
  });

  /**
   * 反向自检：上面那条「0 次读」若是因为**请求压根没打到 handler**（比如端点被静态
   * 兜底吃成 404、或者鉴权把它挡在外面），同样是 0——那样它什么都没证明。
   * 这里把「预热那一次真的读了存储」钉住：4 = 1 次索引 + 3 条记录。
   */
  it("反向自检：冷启动那一次是真读了存储的（否则上面的 0 毫无意义）", async () => {
    const st = new CountingStorage();
    const { app } = await makeApp([], ["k1", "k2", "k3"], { poolCacheTtlMs: 60_000 }, () => 1000, { storage: st });
    const before = st.gets;
    const res = await app.request("/admin/api/keys", { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });
    expect(res.status).toBe(200);
    expect(st.gets - before, "冷启动那一次应当读 1 次索引 + 3 条记录").toBe(4);
  });

  /**
   * **面板与转发共用同一份快照。**
   *
   * 各建一个 `KeyPoolRepo` 的话上面两条照样绿（面板那份自己缓存自己的），
   * 但每个面板请求都会在**自己的** TTL 到期时再读一遍整池 —— §2.4 那笔账就是
   * 按「一份快照」算的。这一格让转发先把快照装起来，再看面板请求读不读存储。
   */
  it("转发先预热之后，面板请求零存储访问——两边不是各自一份快照", async () => {
    const st = new CountingStorage();
    const { app } = await makeApp(
      [{ status: 200, body: "{}" }], ["k1", "k2", "k3"],
      { poolCacheTtlMs: 60_000, poolTouchIntervalMs: 21_600_000 }, () => 1000, { storage: st },
    );
    const fwd = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(fwd.status, "前置条件：转发这一次要真的走完并装载快照").toBe(200);

    const base = { lists: st.lists, gets: st.gets };
    const res = await app.request("/admin/api/keys", { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });
    expect(res.status).toBe(200);
    expect(st.lists - base.lists).toBe(0);
    expect(st.gets - base.gets, "面板另开了一份快照：它没有复用转发刚装载的那一份").toBe(0);
  });

  /**
   * **事件板块（评审 C2 修完之后的重写版）的零 list 断言。**
   *
   * `/admin/api/events` 没有 isolate 级缓存——每一次轮询都老老实实按
   * `candidateKeys()` 算出来的候选键各 get 一次。它不再有"索引"，候选键数**有界**
   * 且只取决于 `after` 参数：`after` 缺失（裸调用 API，从不复用返回的 cursor）时是
   * "冷读"，回看 `EVENT_WINDOW_RETAIN`（24）个窗口 × `EVENT_SLOTS`（2）槽位 = **48**
   * 次 get；这是没有任何缓存效应时的**每次固定代价**。
   *
   * **手写字面量 48/960**（不是从 `EVENT_WINDOW_RETAIN × EVENT_SLOTS` 现算的表达式），
   * 好让这条断言与被测代码的实际取数逻辑相互独立。
   */
  it("连打 20 次 /admin/api/events（从不带 after，模拟裸调用 API），list 次数为 0，get 次数恰好为 960（20×48）", async () => {
    const st = new CountingStorage();
    const { app } = await makeApp([], ["k1"], {}, () => 1000, { storage: st });
    const base = { lists: st.lists, gets: st.gets };
    for (let i = 0; i < 20; i++) {
      const res = await app.request("/admin/api/events", { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });
      expect(res.status).toBe(200);
    }
    expect(st.lists - base.lists, "events 轮询路径出现了 list()").toBe(0);
    expect(st.gets - base.gets, "20 次请求 × 48（EVENT_WINDOW_RETAIN × EVENT_SLOTS 的冷读代价）").toBe(960);
  });

  /**
   * **评审 C4：单次请求读放大的直接回归测试。**
   *
   * 修复前，评审用真实 HTTP 端点实测 `?after=0` 打出约 **992,224** 次 get
   * （2 秒），`?after=-1e11` 约 **1,047,780** 次（1.7 秒）——`candidateKeys` 没有
   * 钳位 `fromWindow`，候选键数随"`now` 与 `after` 相差多少个时间窗"线性增长，
   * 没有上界。修复后（`fromWindow` 钳位在 `nowWindow - EVENT_WINDOW_RETAIN + 1`），
   * **无论 `after` 多陈旧，单次请求的 get 次数都不超过冷读的 48**——这条用例断言
   * 的正是这件事：`?after=0`（评审点名的敌意输入）恰好等于冷读的次数，不多不少
   * （手写字面量 48，不是从 `EVENT_WINDOW_RETAIN × EVENT_SLOTS` 现算的表达式）。
   */
  it("?after=0（评审 C4 点名的敌意输入）单次请求的 get 次数恰好为 48，与冷读相同（不再放大）", async () => {
    const st = new CountingStorage();
    // **不能用离纪元零点很近的时钟**（例如固定 1000）：那样 `floor` 本身也是负数，
    // `after=0` 恰好落在候选区间里，钳位这条性质根本没被触发——用一个真实量级的
    // 时间戳（第 10,000 个时间窗附近，约合 1970 年之后 1 年多），`after=0` 才是
    // 一个真正"远早于 floor"的陈旧值，钳位才会被真正用到。
    const now = 10_000 * 3_600_000;
    const { app } = await makeApp([], ["k1"], {}, () => now, { storage: st });
    const base = { lists: st.lists, gets: st.gets };
    const res = await app.request("/admin/api/events?after=0", { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });
    expect(res.status).toBe(200);
    expect(st.lists - base.lists).toBe(0);
    expect(st.gets - base.gets).toBe(48);
  });

  /**
   * **评审 C4b：稳态"安静"场景不再随游标陈旧度线性增长。**
   *
   * 模拟"某天有过一条事件、之后网关一直健康、面板持续开着轮询"这个评审指出的
   * 反直觉场景：`after` 冻结在一个很早的时间点，`now` 不断往前走。连打 20 次，
   * **每一次都应该被钳位在 48**，总数恰好 `20 × 48 = 960`（与"从不带 after"的
   * 那条用例数值相同，不是巧合——钳位之后"陈旧的 after"与"没有 after"在
   * `candidateKeys` 眼里是同一件事）。
   */
  it("游标冻结在很早以前、之后 20 次轮询 now 持续推进（评审 C4b 的安静场景），get 总数恰好为 960，不随陈旧度增长", async () => {
    const st = new CountingStorage();
    // **起点必须已经远早于 floor 会追上的那一刻**：如果从纪元零点附近开始推进，
    // 前几次轮询 `nowWindow` 还没有超过 `EVENT_WINDOW_RETAIN`，`floor` 本身还是
    // 非正数，钳位这条性质根本没被触发（第一版这条用例就是这么写砸的，实测
    // 总数是 460 不是 960——前几次轮询没被钳住，天然就在 48 以下）。这里让起点
    // 已经是第 30 个时间窗，游标冻结在第 0 个时间窗，从第一次轮询开始就已经
    // 超过保留期，20 次全部应当被钳位在 48。
    let t = 30 * 3_600_000;
    const { app } = await makeApp([], ["k1"], {}, () => t, { storage: st });
    const frozenAfter = 0; // 一个早于任何一次轮询的、冻结不变的游标
    const base = { lists: st.lists, gets: st.gets };
    for (let i = 0; i < 20; i++) {
      t += 3_600_000; // 每次轮询 now 往前走一个时间窗，模拟"过了很久"
      const res = await app.request(`/admin/api/events?after=${frozenAfter}`,
        { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });
      expect(res.status).toBe(200);
    }
    expect(st.lists - base.lists).toBe(0);
    expect(st.gets - base.gets).toBe(960);
  });

  /**
   * **面板真实使用模式：从第二次轮询起带上上一次返回的 `cursor`。**
   *
   * 这是"稳态轮询成本从随历史深度增长降到常数"这条设计意图的直接验证：第一次
   * （`after` 为空）是冷读 48 次 get；此后只要 `after` 与 `now` 落在同一个时间窗内，
   * 每次只需要 `EVENT_SLOTS`（2）次 get，与保留了多少历史窗口无关。
   * 固定时钟下 19 次暖读都落在同一个窗口 ⇒ 总数 **48 + 19×2 = 86**（手写字面量）。
   */
  it("面板轮询模式（第 2 次起带 cursor）：20 次里第 1 次冷读、其余 19 次暖读，get 总数恰好为 86", async () => {
    const st = new CountingStorage();
    let t = 1000;
    const now = () => t;
    const { app, storeLogger } = await makeApp([], ["k1"], {}, now, { storage: st });
    // 种一条真正落盘的事件：冷启动首刷受节流（构造时 lastFlushAt = now()），
    // 推进过 EVENT_FLUSH_MIN_INTERVAL_MS 再 flush 才会真的写。
    storeLogger.log({ level: "info", event: "seed" });
    t += 60_000;
    await storeLogger.maybeFlush();
    // 之后 20 次轮询固定在同一时刻（`t` 不再推进），确保全部落在同一个时间窗内，
    // 「暖读只需要 EVENT_SLOTS 次 get」这条性质才可观测，不被"恰好跨窗口"干扰。

    const base = { lists: st.lists, gets: st.gets };
    let after: number | null = null;
    for (let i = 0; i < 20; i++) {
      const qs = after === null ? "" : `?after=${after}`;
      const res = await app.request(`/admin/api/events${qs}`, { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { cursor: number | null };
      if (body.cursor !== null) after = body.cursor;
    }
    expect(st.lists - base.lists, "events 轮询路径出现了 list()").toBe(0);
    expect(st.gets - base.gets, "1 次冷读(48) + 19 次暖读(2×19=38) = 86").toBe(86);
  });
});
