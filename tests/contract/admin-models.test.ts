import { describe, it, expect } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { SAMPLE_PROMPT } from "../../src/core/admin/protocol-catalog.js";

/**
 * **这个文件只管「协议目录有没有原样过网络」，不重复校验目录内容本身。**
 * 目录自身的不变量在 `tests/unit/admin/protocol-catalog.test.ts`
 * 「四条协议 id 互不重复且恰好四条」一带；「目录里的端点是不是真路由、示例请求是不是
 * 真调得通」在 `tests/contract/protocol-catalog.test.ts`
 * 「每条协议端点都在 app 上真的注册着」一带。
 * 写下这条边界是为了让读的人不必猜这里为什么不比对内容——**三份各守一段，不许互相冒充。**
 */
const withKey = { headers: { "x-admin-key": TEST_ADMIN_TOKEN } };

describe("GET /admin/api/models", () => {
  it("把协议目录整份交出去 —— 四条协议 + 四个模型，一条都不许在路上丢", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin/api/models", withKey);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      protocols: Array<Record<string, unknown>>;
      models: Array<Record<string, unknown>>;
    };
    // 期望值手写字面量，不写 PROTOCOLS.length / MODEL_CATALOG.length（第 6 种假阳性）
    expect(body.protocols.map((p) => p.id)).toEqual(["openai", "anthropic", "responses", "gemini"]);
    expect(body.models.map((m) => m.id)).toEqual([
      "agnes-2.0-flash", "agnes-image-2.1-flash", "agnes-image-2.0-flash", "agnes-video-v2.0",
    ]);
  });

  /**
   * **`sample` 是函数，它过不了网络。** 面板拿到的必须是**算好的请求体**，
   * 否则集成示例卡与 Playground 都会拿到一个 `undefined` 的请求体，
   * 而面板上只会显示一个空的代码块——看不出是「没配」还是「丢了」。
   *
   * 单测那一格（`tests/unit/admin/protocol-catalog.test.ts`
   * 「过网络那一份不含函数」）用 `JSON.parse(JSON.stringify(...))` 模拟这条路，
   * **这一格走的是真序列化 + 真 HTTP 响应**——两者不是一件事。
   * 实测（评审 Minor 1 订正）：把 handler 改成 `c.json(PROTOCOLS)` ⇒
   * **单测那一格照绿，红的是本文件这一带的两格**
   *（「把协议目录整份交出去」+ 本格）。
   * ⇒ 我原来写的「只有这一格会红」实测为假：红的是两格，不是一格。
   */
  it("响应体里 sample 不存在、sampleBody 是真的请求体 —— 函数过不了网络", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin/api/models", withKey);
    const body = await res.json() as {
      protocols: Array<{ id: string; sample?: unknown; sampleBody?: Record<string, unknown> }>;
    };
    for (const p of body.protocols) {
      expect(p.sample, `${p.id} 的 sample 不该出现在响应里`).toBeUndefined();
      // **不是形状断言**：请求体必须真的带着那句样例输入，否则 Playground 的
      // `withPrompt()` 找不到要替换的那段文字，会静默丢弃用户输入。
      expect(JSON.stringify(p.sampleBody), `${p.id} 的 sampleBody`).toContain(SAMPLE_PROMPT);
    }
    // 默认模型是目录里的第一个，手写字面量锚。
    const openai = body.protocols.find((p) => p.id === "openai")!;
    expect(JSON.stringify(openai.sampleBody)).toContain("agnes-2.0-flash");
  });

  /**
   * **零存储读写。** 它和 `capabilities` 一样是面板启动必调的静态数据；
   * 让它读一次存储就等于给每次刷新加一次 KV 读（设计 §2.4 第 1 条），
   * 而 KV 的 read 与 list 是与网关转发共用的同一批每日配额桶。
   *
   * 这一组测的是**次数**，不是「有没有碰存储」这种形状：数出来的必须恰好是手写的 0。
   */
  it("连打 20 次 /admin/api/models —— get / list / put / delete 计数一次都不增加", async () => {
    const st = new CountingStorage();
    const { app } = await makeApp([], ["k1"], {}, () => 1000, { storage: st });
    const base = { gets: st.gets, lists: st.lists, puts: st.puts, deletes: st.deletes };
    for (let i = 0; i < 20; i++) {
      const res = await app.request("/admin/api/models", withKey);
      expect(res.status).toBe(200);
    }
    expect({
      gets: st.gets - base.gets, lists: st.lists - base.lists,
      puts: st.puts - base.puts, deletes: st.deletes - base.deletes,
    }, "静态目录端点碰了存储").toEqual({ gets: 0, lists: 0, puts: 0, deletes: 0 });
  });

  /**
   * 反向自检：上面那四个 0 若是因为**请求压根没打到 handler**（被静态兜底吃成 404、
   * 或者鉴权把它挡在外面），同样是 0——那样它什么都没证明。
   * 这里用**同一个** `CountingStorage` 上的另一条管理端点把计数器本身钉活：
   * `/admin/api/keys` 的冷启动那一次是真读存储的。
   */
  it("反向自检：同一个计数器上，另一条管理端点确实读了存储（否则上面的 0 毫无意义）", async () => {
    const st = new CountingStorage();
    const { app } = await makeApp([], ["k1", "k2", "k3"], {}, () => 1000, { storage: st });
    const before = st.gets;
    expect((await app.request("/admin/api/keys", withKey)).status).toBe(200);
    expect(st.gets - before, "冷启动那一次应当读 1 次索引 + 3 条记录").toBe(4);
  });

  it("没带管理口令是 401 —— 它挂在 adminAuth 之后，不是一条免鉴权端点", async () => {
    const { app } = await makeApp();
    expect((await app.request("/admin/api/models")).status).toBe(401);
    expect((await app.request("/admin/api/models", {
      headers: { "x-admin-key": "wrong-value" },
    })).status).toBe(401);
  });

  /**
   * **端点路径本身是一条对外契约**：面板的三处消费者都硬编码这一条路径去取数
   *（那是唯一允许被硬编码的路径，因为它就是「不许硬编码端点」那条约束的出口）。
   * 改掉它等于把集成示例卡、Playground、模型表三处一起打成空白。
   */
  it("路径逐字是 /admin/api/models —— 改掉它，面板三个消费者一起变空白", async () => {
    const { app } = await makeApp();
    expect(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`))
      .toContain("GET /admin/api/models");
  });
});
