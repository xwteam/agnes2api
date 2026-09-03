import { describe, it, expect } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { UI_ASSETS } from "../../src/ui/assets.generated.js";
import { faviconPngFrom } from "../../src/ui/serve.js";
import { VERSION } from "../../src/version.js";

/**
 * **contract ⇒ node 与 workerd 各跑一遍**（vitest.config.ts 与 vitest.workers.config.ts
 * 的 include 都收 tests/contract）。静态资源在两种运行时下走的是**同一条代码路径**
 * ——查 `UI_ASSETS` 这张编译期常量表——所以这一组用例本身就是「双运行时对等」的证据。
 *
 * CSP 在这里**写成字面量而不是 import serve.ts 的常量**：从被测对象读期望值是同义反复
 *（本项目已发现的第 6 种假阳性），那样删掉 style-src 两边一起变、测试照绿。
 */
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
  + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

describe("静态资源伺服", () => {
  it("GET /admin 免鉴权返回 index.html，字节与生成物一致", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(UI_ASSETS["/admin"]!.body);
  });

  it("CSS / JS / .mjs 各自带正确的 content-type", async () => {
    const { app } = await makeApp();
    for (const [path, type] of [
      ["/admin/css/base.css", "text/css"],
      ["/admin/js/boot.js", "text/javascript"],
      ["/admin/js/pure/session.mjs", "text/javascript"],
    ] as const) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain(type);
    }
  });

  it("每个响应都带全套安全头", async () => {
    const { app } = await makeApp();
    for (const p of ["/admin", "/admin/css/base.css", "/admin/js/app.js"]) {
      const res = await app.request(p);
      expect(res.headers.get("content-security-policy"), p).toBe(CSP);
      // frame-ancestors 与 X-Frame-Options 两条都要：面板被 iframe 套住做点击劫持
      // 是真实风险，而老浏览器只认后者。
      expect(res.headers.get("x-frame-options"), p).toBe("DENY");
      expect(res.headers.get("x-content-type-options"), p).toBe("nosniff");
      expect(res.headers.get("referrer-policy"), p).toBe("no-referrer");
    }
  });

  /**
   * 范围说准：这管的是 **uiRoutes 自己**命中 handler 之后的 404。
   * 没配 `ADMIN_TOKEN` 时整棵树不注册，那时 `/admin` 落到 Hono 的默认 404，
   * 走不到这里——它只有 app.ts 的全局 nosniff（见 security-headers.test.ts）。
   */
  it("uiRoutes 自己的 404 也带全套安全头——漏在错误分支上等于给了一条无 CSP 的同源页面", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin/js/does-not-exist.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  /**
   * `cache-control: no-cache` **四个分支都要有**。
   *
   * 301 是这里的要害：不带缓存指令的永久跳转会被浏览器近乎无限期地缓存，
   * 日后若改成让 `/admin/` 直接发内容，老客户端手里就是一条**拔不掉**的跳转。
   */
  it("200 / 304 / 301 / 404 四个分支都带 cache-control: no-cache", async () => {
    const { app } = await makeApp();
    const etag = (await app.request("/admin")).headers.get("etag")!;
    const cases: Array<[string, RequestInit, number]> = [
      ["/admin", {}, 200],
      ["/admin", { headers: { "if-none-match": etag } }, 304],
      ["/admin/", {}, 301],
      ["/admin/js/does-not-exist.js", {}, 404],
    ];
    for (const [path, init, status] of cases) {
      const res = await app.request(path, init);
      expect(res.status, path).toBe(status);
      expect(res.headers.get("cache-control"), `${path} -> ${status}`).toBe("no-cache");
    }
  });

  it("带匹配的 If-None-Match 返回 304 且无响应体", async () => {
    const { app } = await makeApp();
    const first = await app.request("/admin");
    const etag = first.headers.get("etag")!;
    expect(etag.length).toBeGreaterThan(0);
    const second = await app.request("/admin", { headers: { "if-none-match": etag } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("不匹配的 If-None-Match 返回 200 全量", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin", { headers: { "if-none-match": '"nope"' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(UI_ASSETS["/admin"]!.body);
  });

  it("拿 A 资源的 etag 去请求 B 资源不会得到 304——否则浏览器会拿到错内容", async () => {
    const { app } = await makeApp();
    const cssEtag = (await app.request("/admin/css/base.css")).headers.get("etag")!;
    const res = await app.request("/admin/js/boot.js", { headers: { "if-none-match": cssEtag } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(UI_ASSETS["/admin/js/boot.js"]!.body);
  });

  it("GET /admin/ 尾斜杠 301 跳到 /admin——手输带斜杠是最自然的两种写法之一", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin/");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/admin");
    expect(await res.text()).toBe("");
    // 跳转也免鉴权（否则登录闸打不开），且跟着 /admin 一起存在或消失。
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("尾斜杠跳转不回显请求内容——不是开放重定向", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin/?next=https://evil.example.com");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/admin");
  });

  it("未设 ADMIN_TOKEN 时 /admin/ 也是 404，不该靠跳转泄漏「这里有个后台」", async () => {
    const { app } = await makeApp([], ["k1"], {}, undefined, { adminToken: undefined });
    expect((await app.request("/admin/")).status).toBe(404);
  });

  it("未知路径 404，且**不泄漏**生成物里有哪些键", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin/js/does-not-exist.js");
    expect(res.status).toBe(404);
    const body = await res.text();
    for (const key of Object.keys(UI_ASSETS)) {
      expect(body, `404 响应体不该回显路由 ${key}`).not.toContain(key);
    }
  });

  it("路径穿越拿不到东西——查表命中制，没有文件系统拼接，但这条要有测试守着", async () => {
    const { app } = await makeApp();
    for (const p of [
      "/admin/../package.json",
      "/admin/js/../../../etc/passwd",
      "/admin//js/boot.js",
      "/admin/%2e%2e/package.json",
    ]) {
      expect((await app.request(p)).status, p).not.toBe(200);
    }
  });

  it("**/admin/api/* 不会被静态兜底吃掉**——注册顺序错了会让整套管理 API 变成 404", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin/api/session", { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    // 且未鉴权时是 401 而不是静态兜底的 404。
    expect((await app.request("/admin/api/session")).status).toBe(401);
  });

  it("未设 ADMIN_TOKEN 时 /admin 与静态资源一起 404", async () => {
    const { app } = await makeApp([], ["k1"], {}, undefined, { adminToken: undefined });
    expect((await app.request("/admin")).status).toBe(404);
    expect((await app.request("/admin/css/base.css")).status).toBe(404);
  });
});

/**
 * ── `GET /favicon.ico` ─────────────────────────────────────────────────────
 *
 * 浏览器**不看页面里写了什么**也会去取这一条，而在这之前网关根路径上没有它。
 *
 * 期望值**不从 `faviconPngFrom()` 取**（那是同义反复：抠法写坏两边一起变、测试照绿），
 * 而是在这里用另一条抠法（按 `base64,` 与引号切）从 `/admin` 那份 HTML 里独立解一遍。
 * 那一串本身由 `scripts/check-png.mjs` 的 `auditUiLogos()` 与 `docs/logo.png` 逐像素
 * 对账，所以这一组等于把 `/favicon.ico` 也接到了那张图这个唯一真源上。
 */
describe("站点图标：GET /favicon.ico", () => {
  /** 从一份 HTML 里独立解出内联 PNG 的字节。**与被测实现不共用一行代码。** */
  function inlinedPng(html: string): Uint8Array {
    const b64 = html.split("base64,")[1]!.split('"')[0]!;
    const bin = atob(b64);
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  }

  it("200 + image/png，字节与 /admin 那份 HTML 里内联的那一串逐字节相同", async () => {
    const { app } = await makeApp();
    const res = await app.request("/favicon.ico");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const got = new Uint8Array(await res.arrayBuffer());
    const want = inlinedPng(UI_ASSETS["/admin"]!.body);
    expect(got.length, "长度先对上，逐字节那格红了才读得出是哪一位").toBe(want.length);
    expect([...got]).toEqual([...want]);
  });

  it("发出去的真是一张 PNG：头 8 字节是 PNG 魔数，尾 4 字节是 IEND", async () => {
    const { app } = await makeApp();
    const bytes = new Uint8Array(await (await app.request("/favicon.ico")).arrayBuffer());
    // 手写字面量，不从被测字节里现读。全局那条 nosniff 禁止浏览器猜类型 ⇒
    // 声明成 image/png 的东西必须真的是 PNG，否则标签页上就是一个空白。
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect([...bytes.slice(-4)]).toEqual([0xae, 0x42, 0x60, 0x82]);
  });

  it("带匹配的 If-None-Match 返回 304 且无响应体", async () => {
    const { app } = await makeApp();
    const etag = (await app.request("/favicon.ico")).headers.get("etag")!;
    expect(etag.length).toBeGreaterThan(0);
    const res = await app.request("/favicon.ico", { headers: { "if-none-match": etag } });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  /**
   * 图标的字节住在 `/admin` 那份 HTML 里，所以它的 etag 是从那份 HTML 的内容哈希
   * 拼出来的 —— **但两份内容不同，校验子必须不同**。直接复用的话，浏览器拿着
   * `/admin` 的 etag 来取图标会得到 304，然后把那份 HTML 当成图去渲染。
   */
  it("拿 /admin 的 etag 去请求图标不会得到 304，反过来也不会", async () => {
    const { app } = await makeApp();
    const htmlEtag = (await app.request("/admin")).headers.get("etag")!;
    const icoEtag = (await app.request("/favicon.ico")).headers.get("etag")!;
    expect(icoEtag).not.toBe(htmlEtag);
    expect((await app.request("/favicon.ico", { headers: { "if-none-match": htmlEtag } })).status).toBe(200);
    expect((await app.request("/admin", { headers: { "if-none-match": icoEtag } })).status).toBe(200);
  });

  it("200 与 304 两个分支都带全套安全头与 cache-control: no-cache", async () => {
    const { app } = await makeApp();
    const etag = (await app.request("/favicon.ico")).headers.get("etag")!;
    for (const [init, status] of [[{}, 200], [{ headers: { "if-none-match": etag } }, 304]] as const) {
      const res = await app.request("/favicon.ico", init);
      expect(res.status).toBe(status);
      expect(res.headers.get("content-security-policy"), `${status}`).toBe(CSP);
      expect(res.headers.get("x-frame-options"), `${status}`).toBe("DENY");
      expect(res.headers.get("x-content-type-options"), `${status}`).toBe("nosniff");
      expect(res.headers.get("referrer-policy"), `${status}`).toBe("no-referrer");
      expect(res.headers.get("cache-control"), `${status}`).toBe("no-cache");
    }
  });

  it("未设 ADMIN_TOKEN 时它跟着面板一起消失 —— 有没有图标不该额外泄漏一份运行时事实", async () => {
    const { app } = await makeApp([], ["k1"], {}, undefined, { adminToken: undefined });
    expect((await app.request("/favicon.ico")).status).toBe(404);
  });

  /**
   * **反向控制**：抠法退化成「什么都抠不到」时必须当场抛，不许静默返回一张空图
   * ——0 字节的图标在浏览器里跟「没这条路由」长得一模一样，那正是本轮要修的形态。
   */
  it("抠不到内联 PNG 时当场抛，不静默给一张 0 字节的图", () => {
    expect(() => faviconPngFrom("<html><head><title>没有图标</title></head></html>"))
      .toThrow(/找不到/);
    // 正向：真 HTML 抠得到，且解出来的就是那串 base64 的字节（否则上面那格是空转）。
    expect([...faviconPngFrom(UI_ASSETS["/admin"]!.body)])
      .toEqual([...inlinedPng(UI_ASSETS["/admin"]!.body)]);
  });
});

/**
 * 登录闸是**面向公网的第一个 HTML 页面**：任何人都能不带凭据把它整份拉走。
 * 因此它必须是一份与运行时状态无关的常量——版本号、配置、池子规模、
 * 「ADMIN_TOKEN 是否已配置以外的任何信息」都不许出现在里面。
 */
describe("登录闸不泄漏运行时信息", () => {
  it("页面里没有版本号，也没有任何一把口令", async () => {
    const { app } = await makeApp();
    const html = await (await app.request("/admin")).text();
    expect(html, "版本号只走鉴权后的 /admin/api/session").not.toContain(VERSION);
    expect(html).not.toContain(TEST_ADMIN_TOKEN);
  });

  it("响应头里也没有版本号或服务端指纹", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin");
    const dump = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    expect(dump).not.toContain(VERSION);
    expect(res.headers.get("x-powered-by")).toBeNull();
    expect(res.headers.get("server")).toBeNull();
  });
});
