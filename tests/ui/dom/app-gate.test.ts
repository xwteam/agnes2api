import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { bootPanel, settle, SKELETON_IDS } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import { SESSION_MAX_AGE_MS } from "../../../admin-ui/js/pure/session.mjs";

/**
 * **B1 目标 ①：登录闸 / 会话 / 401 登出这一整条接线的行为覆盖。**
 *
 * 在这一组出现之前，`admin-ui/js/app.js` **零行为覆盖**：`tests/ui/session.test.ts`
 * 的「会话上限的生产接线还在（源码文本级绊线，不是行为断言）」那一小组**只是源码
 * 文本级绊线**（它自己的注释就写着"很弱但方向正确……拦不住
 * 『调了但用错参数』『顺序写反』『异常被吞掉』"）。下面每一格都对应一条当时会
 * 完整逃逸的变异，逐条列在各自的注释里。
 */
const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("面板骨架夹具与真 index.html 对齐", () => {
  /**
   * **夹具是手抄的，所以它与真 `index.html` 的漂移必须会红。**
   * 不钉这一条的话，`index.html` 里改掉一个 id、面板真的坏掉，而下面所有行为
   * 断言照样在一棵自洽的假树上全绿——本仓第 1 种假阳性的经典形态。
   */
  it("index.html 里的每个 id 都在骨架清单里，反之亦然", () => {
    const html = readFileSync("admin-ui/index.html", "utf8");
    const real = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!).sort();
    expect([...SKELETON_IDS].sort(), "骨架与 index.html 的 id 清单漂了").toEqual(real);
  });

  it("八个板块按钮的 data-section 与真 index.html 一致（顺序也是导航顺序）", () => {
    const html = readFileSync("admin-ui/index.html", "utf8");
    const sections = [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]!);
    // 第五项「用量」是后来加的，插在「事件」与「设置」之间：
    // 前四项是「看数据」，`settings` 留在最后一项。
    // 第六项「模型」是再后来加的，同一条理由插在「用量」与「设置」之间。
    // 第七项「调试台」是最后加的，紧挨着「模型」：模型表回答「有哪些能调」，
    // 调试台回答「现在真的调得通吗」，两者是同一件事的两半。`settings` 仍然留在最后。
    // **期望值手写字面量，不从 `NAV_SECTIONS` 推导**——夹具那份清单与真
    // `index.html` 漂移正是这一格要抓的东西，拿夹具当期望值就成了同义反复。
    expect(sections).toEqual([
      "overview", "keys", "registrar", "events", "usage", "models", "playground", "settings",
    ]);
  });
});

describe("登录闸：口令怎么进去、怎么被拒", () => {
  /** 冷启动、没存过口令：停在登录闸，一个请求都不发。 */
  it("没有已存口令时停在闸上，且不发任何探针", async () => {
    const h = await bootPanel({ now: NOW });
    await settle();
    expect(h.gate.classList.contains("off"), "没登录却把闸关了").toBe(false);
    expect(h.shell.classList.contains("on"), "没登录却进了壳层").toBe(false);
    expect(h.calls, "没口令还发了请求").toEqual([]);
  });

  /**
   * **登录成功这一整条**：探针 → 写两个键 → 关闸 → 进壳层 → 渲染出板块内容。
   *
   * 瞄准的变异（每一条当时都完整逃逸）：
   * · 把 `store("set", key)` 里写 `SAVED_AT_STORE` 那一行删掉 ⇒ 下面第二条断言变红；
   * · 把 `enter()` 里的 `showSection(saved)` 删掉 ⇒ 最后一条（板块渲染出内容）变红。
   */
  it("口令正确：写下口令与时刻两个键、关闸、进壳层、板块渲染出内容", async () => {
    const h = await bootPanel({ now: NOW });
    h.input.value = TOKEN;
    h.form.submit();
    await settle();

    expect(h.calls[0]?.url, "探针没打到 /admin/api/session").toBe("/admin/api/session");
    expect(h.calls[0]?.headers["x-admin-key"], "探针没把口令放进请求头").toBe(TOKEN);
    expect(h.store[KEY_STORE]).toBe(TOKEN);
    expect(h.store[SAVED_AT_STORE], "时刻键没写 —— 会话上限会把刚登录的人立刻判成过期").toBe(String(NOW));
    expect(h.gate.classList.contains("off")).toBe(true);
    expect(h.shell.classList.contains("on")).toBe(true);
    expect(h.section("overview").textContent.length, "进了壳层却什么都没渲染").toBeGreaterThan(0);
  });

  /**
   * **口令错误：一个字都不许落进存储。**
   * 变异：把 `if (!r.ok) { …; return; }` 里的 `return` 删掉 ⇒ 登录失败照样
   * `store("set")` + `enter()`，面板装出一副"进去了"的样子而每个请求都 401。
   */
  it("口令错误（401）：不写存储、不进壳层，且给出可读的错误文案", async () => {
    const h = await bootPanel({ now: NOW, respond: () => ({ status: 401, body: {} }) });
    h.input.value = TOKEN;
    h.form.submit();
    await settle();

    expect(h.store[KEY_STORE], "登录失败却把口令存了下来").toBeUndefined();
    expect(h.store[SAVED_AT_STORE]).toBeUndefined();
    expect(h.shell.classList.contains("on")).toBe(false);
    expect(h.err.textContent, "错误文案是空的，用户不知道发生了什么").not.toBe("");
    // **不许是裸 key**：`t()` 找不到 key 时返回 key 本身，那种"文案"运维读不懂。
    expect(h.err.textContent).not.toMatch(/^gate\./);
  });

  /**
   * **403 明确不当"口令错误"**（`probe()` 里那条与 `api.js` 对称的判断）。
   * 变异：把 `if (res.status === 401)` 改成 `if (!res.ok)` ⇒ 这一格变红。
   */
  it("403：报的是「接口出错」而不是「密钥无效」，且同样不写存储", async () => {
    const h = await bootPanel({ now: NOW, respond: () => ({ status: 403, body: {} }) });
    h.input.value = TOKEN;
    h.form.submit();
    await settle();
    expect(h.store[KEY_STORE]).toBeUndefined();
    expect(h.err.textContent).toContain("403");
  });

  /**
   * 字符集判定（`js/pure/sendable.mjs`）真的接在提交路径上。
   * 变异：把 `if (!sendable(key)) …` 整条删掉 ⇒ 请求会被发出去，这一格变红。
   */
  it("含发不出去的字符时**根本不发请求**", async () => {
    const h = await bootPanel({ now: NOW });
    h.input.value = "管理口令管理口令管理口令管理口令管理口令管理口令";
    h.form.submit();
    await settle();
    expect(h.calls, "把浏览器根本送不出去的口令发出去了").toEqual([]);
    expect(h.err.textContent).not.toBe("");
  });
});

describe("已存会话：绝对上限与 401 登出", () => {
  /**
   * **12 小时上限在启动那一次就生效**，且**连探针都不发**。
   * 变异：把启动那段的 `sessionExpired(...)` 判断删掉 ⇒ 会发出探针，第二条断言变红。
   */
  it("存了超过 12 小时的会话：清掉两个键、停在闸上、不发探针", async () => {
    const h = await bootPanel({
      now: NOW,
      store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - SESSION_MAX_AGE_MS) },
    });
    await settle();
    expect(h.calls, "会话早就到点了还发探针").toEqual([]);
    expect(h.store[KEY_STORE], "过期会话没被清掉").toBeUndefined();
    expect(h.store[SAVED_AT_STORE]).toBeUndefined();
    expect(h.shell.classList.contains("on")).toBe(false);
    expect(h.err.textContent).not.toBe("");
  });

  it("会话还新鲜：验一次就直接进壳层", async () => {
    const h = await bootPanel({
      now: NOW,
      store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000) },
    });
    await settle();
    expect(h.calls[0]?.url).toBe("/admin/api/session");
    expect(h.shell.classList.contains("on"), "会话新鲜却没进壳层").toBe(true);
  });

  /**
   * **任何一个 401 都把人送回登录闸，并清掉两个键。**
   *
   * 这是 `onUnauthorized(() => leave("common.sessionExpired"))` 那一行的行为覆盖。
   * 变异：把那一行删掉 ⇒ 401 之后面板停在一个所有请求都失败的壳层里，
   * 而在这一格出现之前**全套用例一条都不红**。
   *
   * 做法：先正常进壳层，再把服务端切成一律 401，然后驱动一次板块刷新。
   */
  it("进壳层之后收到 401：清两个键、退回登录闸、并说清原因", async () => {
    const h = await bootPanel({
      now: NOW,
      store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000) },
    });
    await settle();
    expect(h.shell.classList.contains("on"), "前置条件：先得真的进了壳层").toBe(true);

    h.respond(() => ({ status: 401, body: {} }));
    // 概览板块的「刷新」按钮 = 一次真实的 `api.get("/overview")`。
    const refresh = h.section("overview").querySelectorAll("button")[0]!;
    refresh.click();
    await settle();

    expect(h.store[KEY_STORE], "401 之后口令还留在浏览器里").toBeUndefined();
    expect(h.store[SAVED_AT_STORE]).toBeUndefined();
    expect(h.shell.classList.contains("on"), "401 之后还停在壳层里").toBe(false);
    expect(h.gate.classList.contains("off")).toBe(false);
    expect(h.err.textContent, "没告诉用户为什么被踢出来").not.toBe("");
    expect(h.err.textContent).not.toMatch(/^common\./);
  });

  /**
   * **B1 目标 ②（与 A4 合并）：写入方与读取方用的是同一个键。**
   *
   * 这一格是那条实测缺陷的**行为形态**：登录成功之后，后续每个请求送出去的
   * `x-admin-key` 必须就是刚才存下去的那把口令。键名一分叉，送出去的就是空串。
   * `tests/ui/storage-keys.test.ts` 从"源码里不许再写字面量"那一侧堵；这一格从
   * "运维实际经历的那条路"这一侧堵，两边都在。
   */
  it("登录之后每个后续请求都带着刚存下去的那把口令（键名分叉会让它变成空串）", async () => {
    const h = await bootPanel({ now: NOW });
    h.input.value = TOKEN;
    h.form.submit();
    await settle();

    const after = h.calls.slice(1);
    expect(after.length, "进壳层之后一个请求都没发，这一格什么都没验到").toBeGreaterThan(0);
    for (const c of after) {
      expect(c.headers["x-admin-key"], `${c.url} 送出去的口令头不对`).toBe(TOKEN);
    }
  });

  /**
   * **待办第 6 条：`app.js` 的 `leave()` 退出登录时必须清空 `#gate-key`。**
   *
   * ⚠️ **这是当时唯一仍逃逸的瞄准缺陷**：`app.js:82` 的 `input.value = "";`
   * 那一行本身在这次任务开工前就已经是对的，缺的只是一格会红的测试——账本
   * `progress.md` 记着当时实测「删掉这一行，1438 条全绿」。变红条件：删掉
   * `leave()` 里那一行 `input.value = "";`。
   *
   * 不清空的后果不是好看：同一台机器给别人用时，上一个管理员的口令原样留在
   * 输入框里，下一个人一眼就能看见。
   */
  it("退出登录之后 #gate-key 是空的（不清空的话上一个人的口令原样留在输入框里）", async () => {
    const h = await bootPanel({ now: NOW });
    h.input.value = TOKEN;
    h.form.submit();
    await settle();
    expect(h.shell.classList.contains("on"), "前置条件：先得真的登录成功").toBe(true);
    expect(h.input.value, "前置条件：输入框里现在确实还留着口令").toBe(TOKEN);

    h.dom.byId("logout-btn").click();
    await settle();

    expect(h.shell.classList.contains("on")).toBe(false);
    expect(h.gate.classList.contains("off")).toBe(false);
    expect(h.input.value, "退出登录之后输入框里还留着上一个人的口令").toBe("");
  });
});
