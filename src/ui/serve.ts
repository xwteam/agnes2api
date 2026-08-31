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
  // 强 ETag + 每次回源校验。资源随部署变化，长缓存会让用户升级后看到旧面板。
  //
  // **301 与 404 也必须带**，所以它在这里而不是只挂在 200 分支上：301 会被浏览器
  // 近乎永久地缓存，日后若改成让 `/admin/` 直接发内容，老客户端手里会是一条
  // **拔不掉**的永久跳转。
  "cache-control": "no-cache",
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
    // `/admin/` 规范化到 `/admin`。查表命中制下尾斜杠不在表里，不处理就是 404
    // ——而这是访问面板最自然的两种手输写法之一，部署完第一眼就会撞上。
    //
    // 用 301 而不是「两个 URL 各发一份」：同一份内容挂两个键会有两条缓存、两个
    // ETag，升级后其中一条先失效另一条还是旧的。跳转目标是**硬编码字面量**，
    // 不回显请求里的任何东西，所以不构成开放重定向。
    if (c.req.path === "/admin/") {
      return new Response(null, { status: 301, headers: { ...SECURITY_HEADERS, location: "/admin" } });
    }

    // 直接用注册路径本身查表：Hono 已经把 query 剥掉了。
    //
    // **`/admin/index.html` 是 404，这是有意的**：一份内容一个规范 URL，键就是 `/admin`。
    // ⚠️ **这里原来写着「admin-ui/README.md 让贡献者用浏览器直接打开那个文件（`file://`），
    // 所以这条不影响调试流程」——那句是假的**（定向复评顺手改）：
    // `admin-ui/README.md` 开头那段已经把「`file://` 直接打开就是完整可调试的面板」
    // 登记成**实测推翻**了（资源引用是绝对路径，`file://` 下全部 404；
    // 且现代浏览器把 `file://` 的源当成 null，`type="module"` 会被 CORS 挡下）。
    // 调试一律走 HTTP（`/admin`），**所以这条 404 影响不到调试流程的真正理由是
    // 「没人会去取 `/admin/index.html`」，不是「大家都在用 file:// 」。**
    // 要改的话就和 `/admin/` 一样走 301，别再加一个发同样内容的第二个键
    //（两条缓存两个 ETag，升级后会不同步）。
    const asset = UI_ASSETS[c.req.path];

    // **uiRoutes 自己的 404 带全套安全头**：漏在错误分支上等于在同一个源下放了
    // 一条没有 CSP 的页面。（注意范围：这只管 /admin 这棵树命中 handler 之后的 404。
    // 没配 ADMIN_TOKEN 时整棵树不注册，那时的 404 是 Hono 的默认响应，走不到这里
    // ——它由 app.ts 的全局 nosniff 兜底。）
    // 404 只给固定文案，**不回显有哪些键**。
    if (!asset) {
      return new Response("Not Found", {
        status: 404,
        headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
      });
    }

    const headers: Record<string, string> = { ...SECURITY_HEADERS, etag: asset.etag };
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
