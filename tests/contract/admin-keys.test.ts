import { describe, it, expect } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN, TEST_CONFIG } from "../helpers/make-app.js";
import type { KeyView } from "../../src/core/admin/key-view.js";

/**
 * **contract ⇒ node 与 workerd 各跑一遍**（两份 vitest 配置的 include 都收 tests/contract）。
 *
 * 每条用例的注释都写清它防住哪个真实故障——只写「测 keys 端点」的用例，
 * 在被删掉一半功能之后照样绿。
 */
const NOW = 1000;
const AUTH = { headers: { "x-admin-key": TEST_ADMIN_TOKEN } };

interface KeysBody {
  items: KeyView[];
  total: number; page: number; size: number; pages: number;
  counts: { all: number; fresh: number; cooling: number; evicted: number };
  approximate: boolean;
  generatedAt: number;
}

async function getKeys(app: Awaited<ReturnType<typeof makeApp>>["app"], query = ""): Promise<KeysBody> {
  const res = await app.request(`/admin/api/keys${query}`, AUTH);
  expect(res.status, `GET /admin/api/keys${query}`).toBe(200);
  return await res.json() as KeysBody;
}

describe("GET /admin/api/keys", () => {
  it("未鉴权 401（矩阵已逐格覆盖，这里只留一条冒烟）", async () => {
    const { app } = await makeApp();
    expect((await app.request("/admin/api/keys")).status).toBe(401);
  });

  /**
   * **响应里永不出现明文 key。**
   *
   * `KeyPoolRepo.all()` 返回的记录含完整明文，直接 JSON 吐出去等于把整池上游 key
   * 交给任何拿到面板口令的人，而这套系统**没有任何 reveal 端点**——那条保证的
   * 全部依据就是投影这一步。
   *
   * 断言的是**整段响应文本**，不是 `items[0].key === undefined`：后者对
   * 「顺手塞进 note / raw / debug 字段」这种实现完全无感。
   */
  it("响应体整段文本里都找不到明文 key", async () => {
    const { app } = await makeApp([], ["sk-CONTRACT-SECRET-VALUE-xyz"]);
    const res = await app.request("/admin/api/keys", AUTH);
    const text = await res.text();
    expect(text, "明文 key 泄漏进了管理接口的响应体").not.toContain("CONTRACT-SECRET");
    // 反向自检：这条响应确实含着那把 key 的投影，不是因为返回了个空列表才「没泄漏」。
    expect(text).toContain("sk-CO");
  });

  /**
   * **分档计数永远按整池算，不受筛选影响。**
   *
   * 拿筛完的集合去算的话，`?bucket=fresh` 时四个数会变成
   * `{all:3, fresh:3, cooling:0, evicted:0}`——筛选器旁边那几个「切换过去能看到几条」
   * 的提示全变成 0，面板等于在撒谎。
   */
  it("counts 按整池算：请求 ?bucket=fresh 时另外两档的条数照样是真的", async () => {
    const { app, repo } = await makeApp([], ["k1", "k2", "k3", "k4", "k5"], {}, () => NOW);
    const all = await repo.all();
    await repo.save({ ...all[3]!, cooldownUntil: NOW + 10_000, cooldownReason: "rate limited" });
    await repo.save({ ...all[4]!, evicted: true, evictedReason: "upstream 401" });

    const body = await getKeys(app, "?bucket=fresh");
    // 手写字面量，不从 items 反推。
    expect(body.counts).toEqual({ all: 5, fresh: 3, cooling: 1, evicted: 1 });
    // 而 items 本身确实被筛过了——否则上面那条在「筛选压根没生效」时也会绿。
    expect(body.total).toBe(3);
    expect(body.items.map((v) => v.bucket)).toEqual(["fresh", "fresh", "fresh"]);
  });

  it("?bucket= 传垃圾值时当没筛（不是返回空列表）", async () => {
    const { app } = await makeApp([], ["k1", "k2"], {}, () => NOW);
    expect((await getKeys(app, "?bucket=not-a-bucket")).total).toBe(2);
  });

  it("分页边界：size=2&page=3 拿到最后一格的 1 条", async () => {
    const { app } = await makeApp([], ["k1", "k2", "k3", "k4", "k5"], {}, () => NOW);
    const body = await getKeys(app, "?size=2&page=3");
    expect({ total: body.total, page: body.page, size: body.size, pages: body.pages })
      .toEqual({ total: 5, page: 3, size: 2, pages: 3 });
    expect(body.items).toHaveLength(1);
  });

  /**
   * 越界页号**回落到第 1 页**，不是最后一页。
   *
   * ⚠️ 计划正文的括注写的是「回落到最后一页」，而它给出的 `intParam` 实现落在
   * 第 1 页（越界即取 fallback）。这里按**实现的真实行为**钉住，并把这处不一致
   * 如实登记在 task-4-report 里——两者只能留一个，而悄悄改行为去迎合一句括注，
   * 正是这个项目反复强调不许做的那件事。
   */
  it("page 越界回落到第 1 页，且不返回空列表", async () => {
    const { app } = await makeApp([], ["k1", "k2", "k3"], {}, () => NOW);
    const body = await getKeys(app, "?size=2&page=999");
    expect({ page: body.page, pages: body.pages, items: body.items.length })
      .toEqual({ page: 1, pages: 2, items: 2 });
  });

  it("size 越界 / 非整数一律回落到默认 20，不接受 size=0 把 pages 变成 Infinity", async () => {
    const { app } = await makeApp([], ["k1", "k2", "k3"], {}, () => NOW);
    for (const q of ["?size=0", "?size=99999", "?size=abc", "?size=-3", "?size=1.5"]) {
      const body = await getKeys(app, q);
      expect({ q, size: body.size, pages: body.pages }).toEqual({ q, size: 20, pages: 1 });
    }
  });

  /**
   * **搜索不是明文预言机。**
   *
   * `?q` 若匹配完整明文，任何拿到面板口令的人都能逐字猜：提交一段猜测、看返回条数，
   * 「没有 reveal 端点」这条保证就降级成一个慢速预言机。
   */
  it("拿明文中段搜返回 0 条，拿 id 前缀搜返回 1 条", async () => {
    const { app, repo } = await makeApp([], ["sk-headPROBEMIDDLEtail-zz"], {}, () => NOW);
    const id = (await repo.all())[0]!.id;
    expect((await getKeys(app, "?q=PROBEMIDDLE")).total, "明文中段能搜到 ⇒ 它是个预言机").toBe(0);
    expect((await getKeys(app, `?q=${id.slice(0, 6)}`)).total).toBe(1);
    expect((await getKeys(app, "?q=")).total, "空查询不该把列表清空").toBe(1);
  });

  /**
   * **Tier-1 端到端。** 夹具默认 `poolTouchIntervalMs: 0`（关掉写消除），每次终态都落盘。
   * 这一格证明的是「六处终态各自记到该记的那一栏」，尤其是 4xx 直通**单列**而不是
   * 并进 failed——把它记成这把 key 的失败会让运维去查一把其实没问题的 key。
   */
  it("3 次成功 + 1 次上游 500 + 1 次上游 400 之后，stats 是 5/3/1/1", async () => {
    const { app } = await makeApp(
      [
        { status: 200, body: "{}" }, { status: 200, body: "{}" }, { status: 200, body: "{}" },
        { status: 500, body: "{}" }, { status: 400, body: "{}" },
      ],
      ["sk-tier1-e2e-key-aaaaaaaa"], {}, () => NOW,
    );
    const call = () => app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_CONFIG.gatewayToken}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    for (const expected of [200, 200, 200, 500, 400]) {
      expect((await call()).status, "前置条件：这五次转发的结果必须如夹具所设").toBe(expected);
    }

    const body = await getKeys(app);
    expect(body.items[0]!.stats).toEqual({
      requests: 5, success: 3, failed: 1, clientErrors: 1,
      lastErrorAt: NOW, lastErrorKind: "upstream 500",
    });
    // 不变式：requests === success + failed + clientErrors。
    const s = body.items[0]!.stats;
    expect(s.requests).toBe(s.success + s.failed + s.clientErrors);
  });

  /**
   * **同一段流量，开着写消除再跑一遍。**
   *
   * 生产默认 `POOL_TOUCH_INTERVAL_MS=21600000`，而夹具默认把它关了——只测上面那格
   * 等于只测了「没有写消除的世界」（本项目登记的第 5 种假阳性）。开着写消除时
   * 第 2、3 次成功的写会被整个丢弃，计数只能靠 `pendingStats` 攒着、在第 4 次
   * （strike 改了调度字段，本来就要落盘）一起带下去。
   * 不攒的话这里读到的是 `requests: 2`。
   */
  it("开着写消除时，被消除的那两次成功在下一次状态变更时一起落盘", async () => {
    const { app } = await makeApp(
      [{ status: 200, body: "{}" }, { status: 200, body: "{}" }, { status: 200, body: "{}" }, { status: 500, body: "{}" }],
      ["sk-tier1-elide-key-bbbbbb"],
      { poolTouchIntervalMs: 21_600_000, poolCacheTtlMs: 60_000 },
      () => NOW,
    );
    const call = () => app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_CONFIG.gatewayToken}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    for (const expected of [200, 200, 200, 500]) {
      expect((await call()).status).toBe(expected);
    }

    const body = await getKeys(app);
    expect(body.items[0]!.stats.requests, "被写消除吃掉的那两次成功没能带下来").toBe(4);
    expect(body.items[0]!.stats.success).toBe(3);
    expect(body.items[0]!.stats.failed).toBe(1);
  });

  /**
   * `approximate` 不是装饰：面板靠它决定打不打 `≈`。**断言字面量 `true`**，
   * 不是 `toBeTruthy()`——后者对 `approximate: "yes"` 这种实现也照样通过。
   */
  it("响应里带 approximate: true", async () => {
    const { app } = await makeApp();
    expect((await getKeys(app)).approximate).toBe(true);
  });

  it("generatedAt 来自注入的时钟，不是 handler 自己读的墙上时间", async () => {
    const { app } = await makeApp([], ["k1"], {}, () => 424_242);
    expect((await getKeys(app)).generatedAt).toBe(424_242);
  });

  it("**/admin/api/keys 不被静态兜底吃掉**——注册顺序错了它会变成 404", async () => {
    const { app } = await makeApp();
    expect((await app.request("/admin/api/keys", AUTH)).status).toBe(200);
  });
});
