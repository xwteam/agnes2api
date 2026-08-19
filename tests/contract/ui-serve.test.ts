import { describe, it, expect } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { UI_ASSETS } from "../../src/ui/assets.generated.js";
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
      ["/admin/js/pure/mask.mjs", "text/javascript"],
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

  it("404 也带安全头——漏在错误分支上等于给了一条无 CSP 的同源页面", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin/js/does-not-exist.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
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
