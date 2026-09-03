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
 * 从一份面板 HTML 里抠出 `<link rel="icon">` 那串 base64，解成 PNG 字节。
 *
 * **这里刻意不引入第二份字节。** 那张图在仓里只有一个真源（`docs/logo.png`），
 * 面板里那两串 base64（`admin-ui/index.html` 的 32×32、`admin-ui/css/shell.css` 的
 * 64×64）由 `scripts/check-png.mjs` 的 `auditUiLogos()` 解回像素、与真源的整数倍
 * 降采样结果**逐字节**对账。给 `/favicon.ico` 再存一份 base64（或往仓里放一个
 * `.png`）就是第三份会漂的字节 —— 所以这里从**已经烧进生成物的那一份**取。
 *
 * ⚠️ **抠不到就抛，不静默返回空图。** 一个 0 字节的图标在浏览器里长得跟「没这条
 * 路由」一模一样，而那正是本轮要修的形态。抛在模块加载期 ⇒ 整个应用起不来，
 * 这个方向是有意的：面板的 HTML 里没有站点图标本身就该在部署前被发现。
 *
 * 判据：`tests/contract/ui-serve.test.ts` 的
 * 「200 + image/png，字节与 /admin 那份 HTML 里内联的那一串逐字节相同」与
 * 「抠不到内联 PNG 时当场抛，不静默给一张 0 字节的图」。
 */
export function faviconPngFrom(html: string): Uint8Array {
  const m = /<link rel="icon" href="data:image\/png;base64,([A-Za-z0-9+/]+=*)">/.exec(html);
  if (m === null) {
    throw new Error(
      "面板 HTML 里找不到 `<link rel=\"icon\" href=\"data:image/png;base64,…\">` ——"
      + " /favicon.ico 的字节就是从那一串来的，抠不到说明 admin-ui/index.html 的写法变了，"
      + "先回来改这里的抠法，别让它退化成一张空图",
    );
  }
  const bin = atob(m[1]!);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 站点图标的字节与它的校验子。**模块加载期算一次**：字节来自编译期常量，
 * 每个请求重算一遍只是白烧 CPU。
 *
 * `etag` 用「`favicon-` + 那份 HTML 的内容哈希」拼出来，两件事各自的理由：
 * · **跟着 HTML 的哈希走**：图标的字节就住在那份 HTML 里，HTML 变了它可能也变了。
 *   反过来 HTML 改了注释而图没变时会多发一次这 ~2 KB —— 判错的方向是「多发一次
 *   全量」，不是「回一个错内容的 304」，与下面 `If-None-Match` 那段是同一条取舍。
 * · **必须带前缀，不许直接复用**：`tests/contract/ui-serve.test.ts` 的
 *   「拿 A 资源的 etag 去请求 B 资源不会得到 304——否则浏览器会拿到错内容」钉的正是
 *   这件事，而图标与那份 HTML 是两份**内容不同**的资源，共用校验子就会让
 *   带着 `/admin` 的 etag 来取图标的浏览器拿到一个 304、把 HTML 当成图渲染。
 */
const FAVICON_PNG = faviconPngFrom(UI_ASSETS["/admin"]!.body);
const FAVICON_ETAG = `"favicon-${UI_ASSETS["/admin"]!.etag.slice(1, -1)}"`;

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

  /**
   * `GET /favicon.ico`。浏览器**不看页面里写了什么**也会来取这一条（新标签页、
   * 收藏夹、历史记录里的图标都走它），在这之前它一直是 404。
   *
   * ⚠️ **挂在网关根路径上，但它属于面板这棵树**：这几行跟 `/admin` 一起注册在
   * `uiRoutes()` 里，而 `uiRoutes()` 只在配了 `ADMIN_TOKEN` 时才被挂上
   *（见 `src/http/admin/router.ts` 末尾那段）⇒ **没有面板就没有这条路由**。
   * 这是有意的：没配管理口令的部署一个 HTML 文档都不发，也就没有标签页要贴图标，
   * 而「有没有这条路由」不该额外泄漏一份运行时事实。
   *
   * **`.ico` 的名字 + `image/png` 的类型**是刻意的组合：名字由浏览器的默认约定定死
   *（`/favicon.ico` 是不看 HTML 也会去取的那一条），类型必须说真话 —— 这串字节
   * 是货真价实的 PNG，而全局那条 `nosniff` 会禁止浏览器去猜，类型写错就是不显示。
   *
   * 缓存策略与面板其余资源**完全一致**（`no-cache` + 强 ETag + 304）：图标随
   * `docs/logo.png` 换图而变，长缓存会让升级过的用户在标签页上盯着旧图标很久，
   * 而它自己只有 ~2 KB，一次条件请求的代价可以忽略。
   */
  app.get("/favicon.ico", (c: Context) => {
    const headers: Record<string, string> = { ...SECURITY_HEADERS, etag: FAVICON_ETAG };
    if (c.req.header("if-none-match") === FAVICON_ETAG) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(FAVICON_PNG, {
      status: 200,
      headers: { ...headers, "content-type": "image/png" },
    });
  });

  app.get("/admin", handler);
  app.get("/admin/*", handler);
  return app;
}
