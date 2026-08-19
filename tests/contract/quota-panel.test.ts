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
});
