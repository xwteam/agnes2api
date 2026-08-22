import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  mediaEndpoints, modelIdsForModality, mediaEmbeddable, mediaLinkable, mediaResultUrls,
  videoTaskIdOk, videoTaskIdOf, buildPollRequest, buildRequest, videoPollNext,
  VIDEO_POLL_INTERVAL_MS, VIDEO_POLL_MAX_ATTEMPTS, VIDEO_POLL_MAX_MS,
} from "../../admin-ui/js/pure/playground.mjs";
import { catalogPayload, VIDEO_TASK_ID_RE } from "../../src/core/admin/protocol-catalog.js";
import { stripComments } from "../helpers/strip-comments.js";

/**
 * **Playground 的媒体模式（P3d Task 12）的纯函数判据。**
 *
 * ── 这一组守的是什么 ────────────────────────────────────────────────────────
 * 全局约束 17：**面板不许渲染任何第三方源的图片 / 视频 / iframe**，
 * 而媒体模式正是最想违反它的那一处——上游会回一条地址，而「把它画出来」是最自然的写法。
 * 裁定是：**只展示地址 + 复制 + 在新标签页打开，不内嵌；不许为了内嵌去放宽 CSP。**
 * 理由不是洁癖：`ADMIN_TOKEN` 就存在这个 origin 的浏览器本地存储里（作用域是 origin
 * 不是 path），而 `src/core/dispatcher.ts` 的 `DOCUMENT_MIME` 那段长注释已经论证过
 * 「这个源上可以出现一个攻击者影响得了的同源文档」这条通路。
 *
 * ── 替身能力核对（第 9 种假阳性）───────────────────────────────────────────
 * 本文件**一个 DOM 都不碰**（纯函数 + `node:fs`），所以那 8 条替身独有能力一条都用不到。
 * 媒体那几格 DOM 行为（`rel` 属性、有没有画出内嵌元素）在
 * `tests/ui/dom/playground-section.test.ts` 里，那边有它自己的替身核对。
 */

/** 面板自己所在的源，**取一个显然是探针的值**（与 DOM 夹具同一条理由）。 */
const ORIGIN = "https://panel-probe.invalid";

/** 真源那一份，**不手抄**（第 7 种假阳性：测的是抄件不是原件）。 */
function realPayload(): unknown {
  return JSON.parse(JSON.stringify(catalogPayload()));
}

describe("媒体裁定：不内嵌远端、不放宽 CSP", () => {
  /**
   * ── **「不内嵌」与「不放宽 CSP」是同一件事，这一格把它们绑在一起** ──────────
   *
   * 判据的**两侧各自独立**，没有一侧是从另一侧推导出来的（反同义反复）：
   * · 一侧是 `src/ui/serve.ts` 里那条**真的会被发出去**的 CSP 字符串；
   * · 另一侧是 `js/pure/playground.mjs` 里 `mediaEmbeddable()` 那条正则。
   *
   * **变红条件（三条，逐条实测，见 progress note 的 M1/M2/M3）**：
   * ① 往 `img-src` 里加任何一个远端来源（`https:` / 通配主机）⇒ 源列表那条断言红；
   * ② 给 CSP 加一条 `media-src` ⇒ 「没有 media-src」那条断言红；
   * ③ 把 `mediaEmbeddable()` 放宽成 `/^https?:/` （「远端图片也画出来吧」最自然的写法）
   *    ⇒ 下面那条「凡是判成可内嵌的，协议必须是 CSP 放行的 data」红。
   *
   * ⚠️ **`stripComments()` 用 `tests/helpers/strip-comments.ts` 那一份**（本仓裁定：
   * 不许抄第六份）：不去注释的话，`serve.ts` 文件头那段解释 CSP 的散文里同样有
   * `img-src` 这几个字，而这一格要看的是**真的进了响应头的那一条**。
   */
  it("面板 CSP 的 img-src 里没有任何远端主机、也没有 media-src —— "
     + "放宽任何一条都会让媒体结果不内嵌这条裁定失去它的理由（全局约束 17）", () => {
    const src = stripComments(readFileSync("src/ui/serve.ts", "utf8"));
    const m = /"content-security-policy":\s*((?:"[^"]*"\s*\+?\s*)+)/.exec(src);
    expect(m, "没在 serve.ts 里找到那条 CSP —— 它被改写成别的形状了，判据要跟着改").not.toBeNull();
    // 把拼接起来的那几段字符串还原成一条完整的 CSP。
    const csp = [...m![1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!).join("");
    // 前置条件：还原出来的确实是一条 CSP，否则下面两条断言在一条空串上空洞地通过。
    expect(csp, "还原出来的不是一条 CSP").toContain("default-src 'none'");

    const directives = new Map(
      csp.split(";").map((d) => d.trim()).filter((d) => d !== "")
        .map((d) => d.split(/\s+/)).map((parts) => [parts[0]!, parts.slice(1)] as const),
    );
    // **源列表逐条手写字面量**（第 6 种假阳性：不从 CSP 自己推）。
    expect(directives.get("img-src"), "img-src 里出现了远端来源").toEqual(["'self'", "data:"]);
    expect(directives.has("media-src"), "CSP 里多了一条 media-src —— video 元素从此能加载远端资源")
      .toBe(false);

    // **两侧对上**：凡是被判成可内嵌的，它的协议必须是上面那条 img-src 真的放行的那个。
    const probes = [
      "data:image/png;base64,iVBORw0KGgo=",
      "data:image/svg+xml,%3Csvg%2F%3E",
      "https://cdn.example.invalid/a.png",
      "http://cdn.example.invalid/a.png",
      "data:text/html,%3Cscript%3E",
      "blob:https://panel-probe.invalid/abc",
    ];
    for (const p of probes) {
      if (!mediaEmbeddable(p)) continue;
      expect(p.slice(0, 5), `${p} 被判成可内嵌，但它的协议不在 img-src 的放行表里`).toBe("data:");
    }
    // 非空锚：一条都没被判成可内嵌的话，上面那个循环是空转（第 5 种假阳性）。
    expect(probes.filter(mediaEmbeddable).length, "一条探针都没被判成可内嵌，上面那个循环什么都没证明")
      .toBe(2);
  });

  /**
   * 变红条件：把 `mediaEmbeddable()` 放宽成 `/^https?:\/\//i`（「远端图片也画出来吧」）
   * ⇒ 这一格红。
   */
  it("远端 http(s) 地址一律不可内嵌 —— 面板 CSP 的 img-src 里没有任何远端主机（订正 F6）", () => {
    expect(mediaEmbeddable("https://cdn.example.invalid/a.png")).toBe(false);
    expect(mediaEmbeddable("http://cdn.example.invalid/a.png")).toBe(false);
    // **同源那条也不行**：它同样是一条上游给的地址，而「同源」这件事在这里只是碰巧
    // ——判据是 `data:` 而不是「主机等于面板自己的主机」，后者要在纯函数里知道 origin。
    expect(mediaEmbeddable(`${ORIGIN}/v1/videos/x`)).toBe(false);
    expect(mediaEmbeddable(null)).toBe(false);
    expect(mediaEmbeddable(undefined)).toBe(false);
    expect(mediaEmbeddable(123)).toBe(false);
  });

  /**
   * 变红条件：把 `mediaEmbeddable()` 的判据从 MIME 退回协议前缀（`/^data:/i`）
   * ⇒ `data:text/html,…` 会被判成可内嵌 ⇒ 这一格红。
   * **那正是「这个源上出现一个攻击者影响得了的同源文档」那条通路的入口。**
   */
  it("data 里是图片才可内嵌，是 HTML 不行 —— 判据是 MIME 不是协议前缀", () => {
    expect(mediaEmbeddable("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(mediaEmbeddable("DATA:IMAGE/PNG;base64,iVBORw0KGgo="), "大小写不敏感").toBe(true);
    expect(mediaEmbeddable("data:text/html,%3Cscript%3Ealert(1)%3C%2Fscript%3E")).toBe(false);
    expect(mediaEmbeddable("data:application/json,%7B%7D")).toBe(false);
    // `data:` 后面直接跟逗号时 MIME 默认是 text/plain —— 同样不是图片。
    expect(mediaEmbeddable("data:,hello")).toBe(false);
    // **不许靠子串**：`x-data:image/` 不是一条 data 地址。
    expect(mediaEmbeddable("https://evil.invalid/#data:image/png")).toBe(false);
  });

  /**
   * 变红条件：把 `mediaLinkable()` 改成黑名单写法
   * （`!/^javascript:/i.test(url)`，评审 I9 原话里那一条）⇒ 除 `javascript:` 外的
   * 每一条都会被判成可做链接 ⇒ 这一格红。
   *
   * ⚠️ **靠 CSP 的 script-src 兜住 `javascript:` 是第二道防线在替第一道干活**：
   * CSP 一旦有人放宽，这里就直接漏，而那时没有任何一格会红。
   */
  it("javascript: / blob: / file: 一律不可做链接，只有 http(s) 可以 —— "
     + "白名单不是黑名单，靠 CSP 兜是第二道防线在替第一道干活（评审 I9）", () => {
    expect(mediaLinkable("https://cdn.example.invalid/a.mp4")).toBe(true);
    expect(mediaLinkable("http://cdn.example.invalid/a.mp4")).toBe(true);
    expect(mediaLinkable("HTTPS://CDN.EXAMPLE.INVALID/a.mp4"), "大小写不敏感").toBe(true);
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "  javascript:alert(1)",
      "data:image/png;base64,iVBORw0KGgo=",
      "data:text/html,%3Cscript%3E",
      "blob:https://panel-probe.invalid/abc",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
      "//cdn.example.invalid/a.mp4",
      "/v1/videos/x",
    ]) {
      expect(mediaLinkable(bad), `${bad} 被判成可以做成链接`).toBe(false);
    }
    expect(mediaLinkable(null)).toBe(false);
    expect(mediaLinkable(123)).toBe(false);
  });

  /**
   * **两条判据不是同一条，而且刻意在 `data:image/` 上分叉。**
   * 少了这一格，把 `mediaLinkable` 写成 `mediaEmbeddable || http(s)` 也能让上面几格全绿
   * ——而那一版会给一条 `data:` 地址做出一个可以点开的链接，
   * 点开之后得到的是一个**由上游内容决定的顶层文档**，哪怕它是一张图。
   */
  it("data 图片能内嵌但不能做成链接 —— 内嵌进 img 与「点开导航过去」是两件事", () => {
    const u = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E";
    expect(mediaEmbeddable(u)).toBe(true);
    expect(mediaLinkable(u)).toBe(false);
  });
});

describe("媒体结果地址的收集", () => {
  /**
   * 判据建在「这个字符串是不是一条地址」上，**不是一张字段对照表**——上游到底把成片
   * 放在哪一格本仓从来没有核实过（`src/http/routes/media.ts` 的文件头只承诺原样转发）。
   *
   * 变红条件：把 `mediaResultUrls()` 换成只看 `body.data[0].url` 的写法
   * ⇒ 下面那三种嵌套形状里有两种收不到 ⇒ 红。
   */
  it("三种完全不同的响应形状里都能把地址收上来 —— 编一张字段对照表就会漏掉换了实现的上游", () => {
    expect(mediaResultUrls({ created: 1, data: [{ url: "https://cdn.invalid/a.png" }] }))
      .toEqual(["https://cdn.invalid/a.png"]);
    expect(mediaResultUrls({ id: "t1", status: "completed", url: "https://cdn.invalid/b.mp4" }))
      .toEqual(["https://cdn.invalid/b.mp4"]);
    expect(mediaResultUrls({ output: { assets: [{ href: { download: "https://cdn.invalid/c.mp4" } }] } }))
      .toEqual(["https://cdn.invalid/c.mp4"]);
  });

  it("保持出现顺序并去重 —— 顺序就是运维在屏幕上看到的顺序", () => {
    expect(mediaResultUrls({
      data: [
        { url: "https://cdn.invalid/1.png" },
        { url: "https://cdn.invalid/2.png" },
        { url: "https://cdn.invalid/1.png" },
      ],
    })).toEqual(["https://cdn.invalid/1.png", "https://cdn.invalid/2.png"]);
  });

  /**
   * **收上来的那一批必须已经过了白名单**：不过的话，一条 `javascript:` 会一路走到
   * 渲染那一层，而那时候唯一拦着它的是渲染代码记不记得再判一次。
   */
  it("javascript: / blob: 这类地址根本进不了结果列表 —— 拦在收集这一层，不留给渲染层去记得判", () => {
    const urls = mediaResultUrls({
      data: [
        { url: "javascript:alert(1)" },
        { url: "blob:https://panel-probe.invalid/x" },
        { url: "https://cdn.invalid/ok.png" },
        { url: "data:image/png;base64,iVBORw0KGgo=" },
      ],
    });
    expect(urls).toEqual(["https://cdn.invalid/ok.png", "data:image/png;base64,iVBORw0KGgo="]);
  });

  it("非对象 / 空响应给空数组，不抛 —— 一份读不出来的响应不该让整个板块炸掉", () => {
    for (const v of [null, undefined, "", 0, [], {}, { status: "queued" }]) {
      expect(mediaResultUrls(v), String(v)).toEqual([]);
    }
  });

  /**
   * 深度嵌套用的是显式栈而不是递归。**这一格是那条选择的执行机构**：
   * 递归实现会在这里 `RangeError: Maximum call stack size exceeded`，
   * 而那个异常会从渲染路径里冒出去、把整块右栏打空。
   */
  it("很深的嵌套不会把调用栈打爆 —— 抛出去的话整块右栏会空掉而不是显示一条结果", () => {
    let node: unknown = { url: "https://cdn.invalid/deep.png" };
    for (let i = 0; i < 20_000; i++) node = { next: node };
    expect(mediaResultUrls(node)).toEqual(["https://cdn.invalid/deep.png"]);
  });
});

describe("视频两段式：任务标识与轮询", () => {
  /**
   * ── **登记项 ⑤：面板那条判据与网关那条不许漂** ──────────────────────────────
   *
   * 两侧独立：一侧是 `js/pure/playground.mjs` 里 `videoTaskIdOk()` 的字面量正则，
   * 另一侧是 `src/core/admin/protocol-catalog.ts` 的 `VIDEO_TASK_ID_RE`
   * （`src/http/routes/media.ts` 用的就是它）。
   *
   * **变红条件（两个方向，逐条实测，见 progress note 的 M6/M7）**：
   * ① 把面板那条收紧（比如去掉 `-`）⇒ 面板会拦下一个网关其实收的 id ⇒ 红；
   * ② 把面板那条放宽（比如允许 `.`）⇒ 面板会发一条注定 400 的请求 ⇒ 红。
   * 探针表覆盖两侧边界：长度 1 / 128 / 129、四类允许字符、以及穿越用的那几个字符。
   */
  it("面板那条任务标识判据与网关那条逐个探针同判 —— "
     + "两处一漂，一侧发注定 400 的请求、另一侧拦下网关其实收的 id", () => {
    const probes = [
      "a", "task-1", "task_1-ABC", "0", "A".repeat(128), "A".repeat(129),
      "", "任务", "a.b", "a/b", "..", "%2e%2e", "a b", "a?x=1", "a#f", "a:b", "-", "_",
    ];
    for (const p of probes) {
      expect(videoTaskIdOk(p), `面板与网关对 ${JSON.stringify(p)} 判得不一样`)
        .toBe(VIDEO_TASK_ID_RE.test(p));
    }
    // 非空锚：两侧必须真的有分歧点，否则「同判」可以由「两边恒 true」空洞地满足。
    expect(probes.filter((p) => VIDEO_TASK_ID_RE.test(p)).length, "探针表里一条都没被放行").toBe(7);
    expect(probes.filter((p) => !VIDEO_TASK_ID_RE.test(p)).length, "探针表里一条都没被拦下").toBe(11);
    // 非字符串在网关那侧走不到（路由参数恒是字符串），面板这侧要自己挡。
    expect(videoTaskIdOk(null)).toBe(false);
    expect(videoTaskIdOk(123)).toBe(false);
  });

  /**
   * 变红条件：把 `videoTaskIdOf()` 改成「随便找一个过得了形状判据的字符串」
   * ⇒ `{ id: "..", status: "queued" }` 那一格会取到 `"queued"`
   * ⇒ 面板拿着它去轮一个不存在的任务，直到轮满上限。
   */
  it("建任务的响应里取不到合法 id 时不猜 —— 猜的话一个 queued 状态值就会被当成任务标识", () => {
    expect(videoTaskIdOf({ id: "task-1", status: "queued" })).toBe("task-1");
    // `id` 在，但它过不了形状判据 ⇒ **不许退而求其次去找别的字段**。
    expect(videoTaskIdOf({ id: "..", status: "queued" })).toBeNull();
    expect(videoTaskIdOf({ id: "a/b", task_id: "task-2" })).toBeNull();
    expect(videoTaskIdOf({ status: "queued" })).toBeNull();
    expect(videoTaskIdOf({ id: 12345 })).toBeNull();
    expect(videoTaskIdOf(null)).toBeNull();
    expect(videoTaskIdOf(["task-1"])).toBeNull();
  });

  /**
   * 变红条件：把 `buildPollRequest()` 里的 `split`/`join` 换成什么都不做
   * ⇒ URL 里留着那个占位符 ⇒ 逐字比对红（网关那边会 404，而面板上什么都看不出来）。
   *
   * ⚠️ 期望值**手写整条**：`ORIGIN` 是本文件的探针常量，路径那一半是手写字面量。
   * 从 `catalogPayload()` 里取出来再回填就是第 6 种假阳性。
   */
  it("轮询 URL 由真实目录拼出来，逐字等于手写的那一条 —— 占位符残留在 URL 里的话网关只会 404", () => {
    const endpoints = mediaEndpoints(realPayload())!;
    const poll = endpoints.find((e) => e.op === "poll")!;
    const req = buildPollRequest(poll, "task_1-ABC", ORIGIN);
    expect(req).toEqual({
      url: "https://panel-probe.invalid/v1/videos/task_1-ABC",
      method: "GET",
      headerName: "authorization",
      body: undefined,
    });
    // **GET 不许带请求体**：`js/gw-api.js` 那边 `JSON.stringify(undefined)` 就是
    // `undefined`，于是 fetch 一个字节都不发；给它一个空对象的话浏览器直接抛。
    expect(Object.prototype.hasOwnProperty.call(req!, "body"), "body 这一格得在，值是 undefined")
      .toBe(true);
    expect(req!.body).toBeUndefined();
  });

  it("非法的视频任务标识在前端就被拦下 —— 送出去只会得到一个 400 而运维不知道为什么", () => {
    const poll = mediaEndpoints(realPayload())!.find((e) => e.op === "poll")!;
    for (const bad of ["", "..", "a/b", "a?x=1", "任务", "A".repeat(129), null, 123]) {
      expect(buildPollRequest(poll, bad, ORIGIN), `${JSON.stringify(bad)} 没被拦下`).toBeNull();
    }
    // 前置条件：合法那条确实构造得出来，否则上面那串 `null` 有第二种成因。
    expect(buildPollRequest(poll, "ok-1", ORIGIN)).not.toBeNull();
  });

  it("没有占位符的端点构造不出轮询请求 —— 拼出来的会是建任务那条路径，一轮一个新任务", () => {
    const create = mediaEndpoints(realPayload())!.find((e) => e.id === "video.create")!;
    expect(create.taskSlot, "前置条件：建任务那条本来就没有占位符").toBeNull();
    expect(buildPollRequest(create, "ok-1", ORIGIN)).toBeNull();
    expect(buildPollRequest(null, "ok-1", ORIGIN)).toBeNull();
  });

  /**
   * ── **轮询上限：一个忘了关的标签页就是一台永动打点机** ──────────────────────
   *
   * 期望值**手写字面量**，不写 `MAX ± 1`（第 6 种假阳性）：常量本身由下面
   * 「三条常量逐条手写字面量」那一格单独锚死，**这一格锚的是关系**。
   *
   * 变红条件：把 `videoPollNext()` 里 `attempt >= VIDEO_POLL_MAX_ATTEMPTS` 那句删掉
   * ⇒ 第 60 次之后照样返回 `poll` ⇒ 红。
   */
  it("轮询到达次数上限后停下 —— 无限轮就是一台永动打点机，每一次打点都烧一次配额", () => {
    expect(videoPollNext({ attempt: 0, elapsedMs: 0 })).toEqual({ action: "poll", delayMs: 5_000 });
    expect(videoPollNext({ attempt: 59, elapsedMs: 0 })).toEqual({ action: "poll", delayMs: 5_000 });
    expect(videoPollNext({ attempt: 60, elapsedMs: 0 })).toEqual({ action: "giveUp" });
    expect(videoPollNext({ attempt: 999, elapsedMs: 0 })).toEqual({ action: "giveUp" });
  });

  /**
   * 变红条件：把 `elapsedMs >= VIDEO_POLL_MAX_MS` 那句删掉 ⇒ 这一格红。
   * **两条上限缺一不可**：只判次数的话，谁把间隔改大之后一个标签页能挂上几个小时。
   */
  it("轮询到达时长上限后停下 —— 只判次数的话把间隔改大就能挂上几个小时", () => {
    expect(videoPollNext({ attempt: 0, elapsedMs: 299_999 })).toEqual({ action: "poll", delayMs: 5_000 });
    expect(videoPollNext({ attempt: 0, elapsedMs: 300_000 })).toEqual({ action: "giveUp" });
    // **两条同时判，先到哪条算哪条**：次数没到而时长到了，同样得停。
    expect(videoPollNext({ attempt: 1, elapsedMs: 600_000 })).toEqual({ action: "giveUp" });
  });

  it("入参缺胳膊少腿时按「刚开始」处理，不抛也不当成已到上限 —— "
     + "当成已到上限的话，一次状态丢失会让每一轮视频都不轮询", () => {
    expect(videoPollNext(null)).toEqual({ action: "poll", delayMs: 5_000 });
    expect(videoPollNext({})).toEqual({ action: "poll", delayMs: 5_000 });
    expect(videoPollNext({ attempt: -5, elapsedMs: -5 })).toEqual({ action: "poll", delayMs: 5_000 });
    expect(videoPollNext({ attempt: "60", elapsedMs: 0 })).toEqual({ action: "poll", delayMs: 5_000 });
  });

  /**
   * 三条常量的**字面量锚**（评审 I8 那条纪律：常量没有字面量锚就是自我推导）。
   * 这一格与上面两格是分工关系：这里锚「值是多少」，那里锚「关系成不成立」。
   */
  it("三条轮询常量逐条手写字面量 —— 上面那两格锚的是关系，这一格锚的是值", () => {
    expect(VIDEO_POLL_INTERVAL_MS).toBe(5_000);
    expect(VIDEO_POLL_MAX_ATTEMPTS).toBe(60);
    expect(VIDEO_POLL_MAX_MS).toBe(300_000);
    // 两条上限得是同一个量级的约束，不然其中一条永远先到、另一条形同虚设。
    // 手写的 300000 与 60 × 5000 相等**是刻意的**，这一行把它写下来。
    expect(VIDEO_POLL_MAX_ATTEMPTS * VIDEO_POLL_INTERVAL_MS).toBe(300_000);
  });
});

describe("媒体端点目录的窄化", () => {
  it("真实目录窄化出三条端点，逐条手写字面量 —— 少一条就是媒体那一档静静地没有入口", () => {
    const out = mediaEndpoints(realPayload());
    expect(out!.map((e) => [e.id, e.modality, e.op, e.method, e.pathTemplate, e.taskSlot])).toEqual([
      ["image.generate", "image", "generate", "POST", "/v1/images/generations", null],
      ["video.create", "video", "generate", "POST", "/v1/videos", null],
      ["video.poll", "video", "poll", "GET", "/v1/videos/:id", ":id"],
    ]);
    // 那句占位文本跟着响应一起来（与协议那份同一条），**不是本模块自己知道的**。
    expect(out!.every((e) => e.samplePrompt === "ping")).toBe(true);
  });

  /**
   * **任何一格不对就整份判成读不出来，不是把坏的那条跳过。**
   * 跳过之后视频会少掉轮询那一条，而屏幕上看起来完全正常——运维建完任务永远等不到成片。
   *
   * ⚠️ **逐格种一次，不是只种一格**：只种一格的话，「其余每一格根本没判」这件事
   * 完全不可观测（本仓在同型的 `playgroundProtocols()` 上守的是同一条）。
   */
  it.each([
    ["id", ""], ["modality", ""], ["op", ""], ["method", ""],
    ["pathTemplate", ""], ["authHeader", ""],
  ] as const)("媒体端点少了 %s 就整份读不出来 —— 跳过坏的那条会让视频永远等不到成片", (key, bad) => {
    const p = realPayload() as { media: Array<Record<string, unknown>> };
    p.media[0]![key] = bad;
    expect(mediaEndpoints(p)).toBeNull();
  });

  it("占位符那一格写坏了同样整份读不出来 —— 轮询 URL 会恒等于建任务那条路径", () => {
    const drop = realPayload() as { media: Array<Record<string, unknown>> };
    // 轮询那条把占位符删掉 ⇒ 轮询 URL 里没有任务标识的位置。
    drop.media[2]!.taskSlot = null;
    expect(mediaEndpoints(drop)).toBeNull();

    const drift = realPayload() as { media: Array<Record<string, unknown>> };
    // 占位符在，但路径模板里没有它（两处改一处，最自然的漏改形态）。
    drift.media[2]!.taskSlot = ":taskId";
    expect(mediaEndpoints(drift)).toBeNull();

    // `undefined` 不算「这一条不带任务标识」：一格拼错名字的字段会静默变成它。
    const gone = realPayload() as { media: Array<Record<string, unknown>> };
    delete gone.media[0]!.taskSlot;
    expect(mediaEndpoints(gone)).toBeNull();
  });

  it("请求体那一格与 op 必须对得上 —— 生成端点漏了它就会发一条空请求，轮询多了它就是一条带 body 的 GET", () => {
    const noBody = realPayload() as { media: Array<Record<string, unknown>> };
    noBody.media[0]!.sampleBody = null;
    expect(mediaEndpoints(noBody), "生成端点没有请求体却照样收下了").toBeNull();

    const extraBody = realPayload() as { media: Array<Record<string, unknown>> };
    extraBody.media[2]!.sampleBody = { model: "m", prompt: "ping" };
    expect(mediaEndpoints(extraBody), "轮询端点带着请求体却照样收下了").toBeNull();
  });

  it("整份响应缺 media 这一格就是读不出来 —— 空数组与「这份响应我们没读懂」是两句话", () => {
    expect(mediaEndpoints({ protocols: [], models: [], samplePrompt: "ping" })).toBeNull();
    expect(mediaEndpoints(null)).toBeNull();
    expect(mediaEndpoints({ media: {}, samplePrompt: "ping" })).toBeNull();
    // 空数组是合法的（这个网关一条媒体端点都没有），**它不等于读不出来**。
    expect(mediaEndpoints({ media: [], samplePrompt: "ping" })).toEqual([]);
  });
});

describe("媒体模式的模型与请求构造", () => {
  /**
   * 变红条件：把 `modelIdsForModality()` 换成 `models.map((m) => m.id)`
   * ⇒ 对话模型会混进图片下拉，而选中它只会换来一次注定 4xx 的请求。
   *
   * 期望值手写字面量（真源里今天就是这三个媒体模型）。
   */
  it("图片与视频各自只列自己形态的模型 —— 对话模型混进来就是一次注定 4xx 的请求", () => {
    const models = (realPayload() as { models: unknown }).models;
    expect(modelIdsForModality("image", models))
      .toEqual(["agnes-image-2.1-flash", "agnes-image-2.0-flash"]);
    expect(modelIdsForModality("video", models)).toEqual(["agnes-video-v2.0"]);
    expect(modelIdsForModality("chat", models)).toEqual(["agnes-2.0-flash"]);
    expect(modelIdsForModality("", models)).toEqual([]);
    expect(modelIdsForModality("image", null)).toEqual([]);
  });

  /**
   * **媒体走的是同一个 `buildRequest()`，不是第二条请求构造路径**（全局约束 15）。
   * 这一格同时证明两件事：URL 由 origin + 真源路径拼出来（一个硬编码路径都没有），
   * 而且运维输入的那句话真的替掉了样例里那句占位文本。
   *
   * 变红条件：把真源里某条媒体端点的 `pathTemplate` 改一个字符 ⇒ 这一格红。
   * URL 期望值**手写整条**。
   */
  it("两条媒体生成端点各构造一次请求，URL 全部由 origin + 真源路径拼出 —— 一个硬编码路径都没有", () => {
    const endpoints = mediaEndpoints(realPayload())!;
    const image = endpoints.find((e) => e.id === "image.generate")!;
    const video = endpoints.find((e) => e.id === "video.create")!;

    expect(buildRequest(image, {
      model: "agnes-image-2.1-flash", prompt: "一只猫", stream: false, origin: ORIGIN,
    })).toEqual({
      url: "https://panel-probe.invalid/v1/images/generations",
      method: "POST",
      headerName: "authorization",
      body: { model: "agnes-image-2.1-flash", prompt: "一只猫" },
    });

    expect(buildRequest(video, {
      model: "agnes-video-v2.0", prompt: "一只猫在跑", stream: false, origin: ORIGIN,
    })).toEqual({
      url: "https://panel-probe.invalid/v1/videos",
      method: "POST",
      headerName: "authorization",
      body: { model: "agnes-video-v2.0", prompt: "一只猫在跑" },
    });
  });

  /**
   * **样例里那句占位文本必须真的被换掉。**
   * 少了这一格，`withPrompt()` 哪天在媒体这条路上退化成「原样返回样例」也不会有人发现
   * ——面板会**静默地把运维输入的提示词丢掉、恒发样例那句话**，而屏幕上一切正常。
   */
  it("媒体请求体里那句占位文本被换成了运维输入的那句 —— 换不掉就是静默丢弃用户输入", () => {
    const image = mediaEndpoints(realPayload())!.find((e) => e.id === "image.generate")!;
    const req = buildRequest(image, {
      model: "agnes-image-2.1-flash", prompt: "换掉我", stream: false, origin: ORIGIN,
    });
    expect(JSON.stringify(req!.body), "样例那句话还留在请求体里").not.toContain("ping");
    expect(JSON.stringify(req!.body)).toContain("换掉我");
  });
});
