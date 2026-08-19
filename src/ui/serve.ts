import { Hono } from "hono";
import type { Context } from "hono";
import { UI_ASSETS } from "./assets.generated.js";

/**
 * 安全响应头（设计文档 §8.4）。
 *
 * - `style-src 'self'` **必须有**，漏了整份 CSS 会被拦掉——一个很容易漏的坑。
 * - `script-src 'self'` 要求**零内联脚本**，scripts/build-ui.mjs 会在构建期拦。
 * - `frame-ancestors 'none'` 与 `X-Frame-Options: DENY` 两条都要：面板被 iframe
 *   套住做点击劫持是真实风险，而老浏览器只认后者。
 * - 不加 CORS：面板同源，加了只会扩大攻击面。
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/**
 * 静态资源路由。**查表命中制**——没有任何文件系统路径拼接，因此路径穿越在结构上
 * 就不成立（仍有测试守着）。Worker 与 Node 走的是同一条代码路径：这张表是编译期
 * 常量，两种运行时下连字节都一样。
 *
 * 不用 `hono/serve-static`：它带 path join、isDir → index.html 默认文档、
 * precompressed 探测等一堆用不上的语义，而 ETag / 304 / Cache-Control 又要自己接。
 * 自己写这二十几行，把这三件事完全攥在手里，少一个升级面。
 */
export function uiRoutes(): Hono {
  const app = new Hono();

  const handler = (c: Context) => {
    // 直接用注册路径本身查表：Hono 已经把 query 剥掉了。
    const asset = UI_ASSETS[c.req.path];

    // **404 也要带安全头**：漏在错误分支上等于在同一个源下放了一个没有 CSP 的页面。
    // 404 只给固定文案，**不回显有哪些键**。
    if (!asset) {
      return new Response("Not Found", {
        status: 404,
        headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
      });
    }

    const headers: Record<string, string> = {
      ...SECURITY_HEADERS,
      etag: asset.etag,
      // 强 ETag + 每次回源校验。资源随部署变化，长缓存会让用户升级后看到旧面板。
      "cache-control": "no-cache",
    };
    // 强比较，且只认完全相等：这里刻意不解析 `If-None-Match` 的列表形态与 `W/` 前缀
    // ——判错的方向是「多发一次全量」，不是「回一个错内容的 304」。
    if (c.req.header("if-none-match") === asset.etag) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(asset.body, {
      status: 200,
      headers: { ...headers, "content-type": asset.type },
    });
  };

  app.get("/admin", handler);
  app.get("/admin/*", handler);
  return app;
}
