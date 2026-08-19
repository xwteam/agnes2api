import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { makeApp, TEST_ADMIN_TOKEN, TEST_CONFIG } from "../helpers/make-app.js";

/**
 * 全应用级安全头。
 *
 * Task 6 之前整个网关**一条安全响应头都没有**（`/health` 的
 * `x-content-type-options` 实测是 null），而 Task 6 又正是第一次在这个 origin 上
 * 建立凭据存储的提交：面板把 `ADMIN_TOKEN` 原样放进 localStorage，作用域是
 * **origin 而不是 path** ⇒ `/admin` 之外任何一条能被浏览器当 HTML 解析的响应，
 * 都是这份凭据的攻击面。
 *
 * 这一组**刻意覆盖非 /admin 的路径**：`/admin/*` 的全套头由 ui-serve.test.ts 守，
 * 只测那棵树的话，「把 nosniff 从全局挪回 uiRoutes 里」这个回归不会被发现。
 */
describe("全应用级 nosniff", () => {
  const CASES: Array<{ name: string; path: string; headers?: Record<string, string> }> = [
    { name: "免鉴权的 /health", path: "/health" },
    { name: "网关 200（/v1/models）", path: "/v1/models", headers: { authorization: `Bearer ${TEST_CONFIG.gatewayToken}` } },
    { name: "网关 401（错凭据，响应体会回显部分请求内容）", path: "/v1/models" },
    { name: "管理 401", path: "/admin/api/session" },
    { name: "管理 200", path: "/admin/api/session", headers: { "x-admin-key": TEST_ADMIN_TOKEN } },
    { name: "Hono 默认 404（压根没注册的路径）", path: "/definitely-not-a-route" },
  ];

  for (const { name, path, headers } of CASES) {
    it(`${name} 带 nosniff`, async () => {
      const { app } = await makeApp();
      const res = await app.request(path, { headers: headers ?? {} });
      expect(res.headers.get("x-content-type-options"), `${name} -> ${res.status}`).toBe("nosniff");
    });
  }

  it("未设 ADMIN_TOKEN 时 /admin 落到 Hono 默认 404，也带 nosniff", async () => {
    const { app } = await makeApp([], ["k1"], {}, undefined, { adminToken: undefined });
    const res = await app.request("/admin");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  /**
   * **范围要说准**：全局只提 nosniff。CSP / X-Frame-Options 防的是「文档被渲染 /
   * 被套进 iframe」，而 `/v1/*` 与 `/health` 从不返回文档，给它们加上去只是仪式感。
   * 这一条把「只加了 nosniff」这个**有意的取舍**钉住——将来谁顺手全局加 CSP，
   * 得先来这里改掉它并说明理由，而不是默默扩大一条会影响所有下游客户端的响应头。
   */
  it("网关侧刻意**不**加 CSP / X-Frame-Options（面板那棵树才加）", async () => {
    const { app } = await makeApp();
    const res = await app.request("/health");
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("x-frame-options")).toBeNull();
  });

  /**
   * **把 app.ts 里那句「必须写在 await next() 之后」变成可证伪的断言。**
   *
   * 这条测的是我们**依赖的 Hono 语义**，不是我们自己的路由——因为在本仓当前的路由
   * 清单下，把 `c.header` 挪到 next() 之前是**不可观测的**：唯一返回裸 `new Response`
   * 的是 /admin 那棵树，而它自己也设了 nosniff（已实测：挪到之前，全套测试照绿）。
   *
   * 也就是说那个变异今天不是缺陷，是留给**下一个** handler 的陷阱。等 P3b 加一个
   * 返回裸 Response 的管理端点，写反的顺序会让它静默地少一条头。所以这里直接把
   * 语义本身钉住：谁想"顺手简化"成写在前面，先看这条用例说的是什么。
   */
  it("Hono 语义：next() **之前**写的头只对 Hono 自己构造的响应生效，裸 Response 会丢", async () => {
    const build = (when: "before" | "after") => {
      const app = new Hono();
      app.use("*", async (c, next) => {
        if (when === "before") { c.header("x-probe", "set"); await next(); return; }
        await next();
        c.header("x-probe", "set");
      });
      app.get("/bare", () => new Response("raw", { status: 200 }));
      app.get("/json", (c) => c.json({ ok: 1 }));
      return app;
    };

    const before = build("before");
    // Hono 自己构造的：两种写法都生效，所以只测这一种的话什么都证明不了。
    expect((await before.request("/json")).headers.get("x-probe")).toBe("set");
    // 裸 Response：**静默丢掉**。这一格就是 app.ts 那句注释的全部依据。
    expect((await before.request("/bare")).headers.get("x-probe")).toBeNull();

    const after = build("after");
    expect((await after.request("/json")).headers.get("x-probe")).toBe("set");
    expect((await after.request("/bare")).headers.get("x-probe")).toBe("set");
  });

  it("/health 的响应体键集合未因此扩大——池子规模不许从免鉴权端点漏出去", async () => {
    const { app } = await makeApp();
    const body = await (await app.request("/health")).json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["status", "storage", "version"]);
  });
});
