import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import { I18N } from "../../../admin-ui/js/i18n-dict.js";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **单把 key 的验活入口的 DOM 行为覆盖。**
 * 端点、出站探测护栏、以及「响应体里一个字节上游正文都不回来」那条，是后端那一半
 * 交付的，由 `tests/contract/admin-verify.test.ts`「上游 401 的响应正文一个字节都不回给面板 —— 凭据无效的错误体正是各家 API 最爱回显 key 片段的地方」
 * 那一族守着；这一组守的是**入口那一半**：
 * 行内动作、并发态、以及「两种 429 在面板上说的是两句不同的话」。
 *
 * ── 第 9 种假阳性（替身比真实更强）的开工前检查，结论逐条写在这里 ──────────────
 *
 * `tests/helpers/fake-dom.ts` 上有九个「替身有、真实 DOM 没有」的能力。
 * 本任务的**发货代码**（`admin-ui/js/sec-keys.js` 的 `verifyControl()` /
 * `verifyOne()` / `abortVerifies()`）用到的 DOM 面只有：
 * `createElement` / `setAttribute` / `appendChild` / `addEventListener` /
 * `textContent` / `.disabled`。逐条对过：
 * · **`.disabled`** —— 那份夹具把它挂在**每一个**元素上，真实 DOM 只有表单控件才有
 *   （`KNOWN_BLIND_SPOTS` 第三条如实登记着这一点）。⇒ 发货代码只把它设在
 *   `elI18n("button", …)` 造出来的**真 `<button>`** 上，**下面每一格断言也只落在
 *   `tagName === "button"` 的节点上**（`verifyButton()` 里那句 `expect` 就是这条检查
 *   本身，不是注释里的一句承诺）。
 * · **`querySelectorAll()` 回真数组 / `.children` 回真数组** —— 发货代码这一段
 *   **一次都没有调用**它们（`verifyControl()` 全程 `appendChild`），所以那两条形态
 *   在本任务的 diff 里不可能出现；本文件里的 `.find(...)` 是**测试代码**，
 *   而 `tests/ui/dom/fake-dom-parity.test.ts`「admin-ui/js/ 下的发货代码不许出现 fake-dom.ts 独有的成员名」
 *   那一格的扫描范围只有 `admin-ui/js/`。
 * · `.walk()` / `.parent` / `.input()` / `.attrs` / `.listeners` /
 *   `classList.reset()` / `submit()` —— 发货代码一处都没用到。
 *   （本文件的 `allTitles()` 用了 `walk()`，那是**测试**代码：夹具的盲区清单里
 *   `keydown()` 那一条已经为「只有测试在调」这种用法表过态。）
 *
 * ── 另一条必须先说清楚的替身边界 ─────────────────────────────────────────────
 * `tests/ui/dom/harness.ts` 的 `fetch` 替身与 `tests/helpers/fake-dom.ts`
 * **零处**看 `signal` ⇒ 被 abort 的那条链在测试里照样 resolve。
 * 所以下面几格钉的**不是 `abort()` 本身**，是 `sec-keys.js` 里
 * `if (ctl.signal.aborted) return;` 那道闸（真实浏览器里 abort 会让它以
 * `AbortError` 拒绝，那道闸同样挡得住——两种环境走同一条判据）。
 * 这与 `usage-section.test.ts` / `models-section.test.ts` 用世代号守同一件事同源。
 */
const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Resp = { status: number; body: unknown };

function keyView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "id-default", masked: "sk-de…fault", seq: 1, bucket: "fresh",
    addedAt: NOW - 10_000, lastUsedAt: null, cooldownUntil: 0,
    cooldownReason: null, evictedReason: null, strikes: 0,
    disabled: false, evicted: false, note: null,
    stats: { requests: 0, success: 0, failed: 0, clientErrors: 0, lastErrorAt: null, lastErrorKind: null },
    ...overrides,
  };
}

function listBody(items: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  return {
    items, total: items.length, page: 1, pages: 1, size: 20,
    counts: { all: items.length, fresh: 0, cooling: 0, evicted: 0, disabled: 0 },
    approximate: true, generatedAt: NOW,
    ...overrides,
  };
}

/** 进壳层、切到 Key 池板块。 */
async function openKeys(respond: (url: string, method: string) => Resp | Promise<Resp>) {
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000) },
    respond,
  });
  await settle(12);
  h.dom.document.querySelectorAll(".nav-item")
    .find((b) => b.getAttribute("data-section") === "keys")!
    .click();
  await settle(12);
  return h;
}

function rowOf(section: FakeElement, id: string): FakeElement {
  const row = section.querySelectorAll(`[data-key-id="${id}"]`)[0];
  if (!row) throw new Error(`找不到 id=${id} 的行`);
  return row;
}

/**
 * 某一行的「验活」按钮。**顺带把「它必须是真的 `<button>`」这条检查做进来**——
 * 夹具把 `.disabled` 挂在每个元素上，落在 `<span>` / `<td>` 上时用例照样绿、
 * 浏览器里毫无作用（评审 Minor 13）。
 */
function verifyButton(section: FakeElement, id: string): FakeElement {
  const btn = rowOf(section, id).querySelectorAll("button")
    .find((b) => b.getAttribute("data-i18n") === "keys.action.verify");
  if (!btn) throw new Error(`id=${id} 那一行没有验活按钮`);
  expect(btn.tagName, "验活按钮不是真的 <button> —— .disabled 在夹具里对任何元素都生效，浏览器里不是").toBe("button");
  return btn;
}

/** 某一行里那些验活结果元素当前挂的 i18n key，按出现顺序。 */
function resultKeys(section: FakeElement, id: string): string[] {
  return rowOf(section, id).querySelectorAll(".verify-result")
    .map((n) => n.getAttribute("data-i18n") ?? "");
}

/** 一棵子树上所有 `title` 属性的值（测试专用，见文件头对 `walk()` 的表态）。 */
function allTitles(node: FakeElement): string[] {
  return node.walk().map((n) => n.getAttribute("title")).filter((v): v is string => v !== null);
}

/** 一个可以由用例手动放行的应答。 */
function deferred(): { promise: Promise<Resp>; release: (r: Resp) => void } {
  let release!: (r: Resp) => void;
  const promise = new Promise<Resp>((res) => { release = res; });
  return { promise, release };
}

/** 让面板的 `Date.now()` 走到某一刻（冷却是一段**本地**流逝的时间）。 */
function setClock(at: number): void {
  vi.spyOn(Date, "now").mockReturnValue(at);
}

// ───────────────────────────────────────────────────────────────────────────
// 设计 §10.2 的反向断言：绝不做「批量验活」
// ───────────────────────────────────────────────────────────────────────────

describe("批量条", () => {
  /**
   * 设计 §10.2 逐字：「它按 key 数量真打上游——100 把 key 点一次就是 100 次真实
   * 上游调用，与『立即补池』是同型的自毁按钮」。
   *
   * ⚠️ **判据不是「批量条里没有 `keys.action.verify` 这颗按钮」那么松**：
   * 有人另起一个 `keys.bulk.verify` 就绕过去了。这里把批量条的按钮清单**整份**
   * 钉成手写的三条 —— 多长出任何一颗（不管它叫什么）都会红。
   */
  it("批量条里没有验活按钮 —— 批量验活按 key 数量真打上游，是自毁按钮（设计 §10.2）", async () => {
    const items = [keyView({ id: "a", seq: 1 }), keyView({ id: "b", seq: 2 })];
    const h = await openKeys((url) => (url.startsWith("/admin/api/keys?")
      ? { status: 200, body: listBody(items) }
      : { status: 200, body: {} }));
    const bar = h.section("keys").querySelectorAll(".bulk-bar")[0]!;

    expect(
      bar.querySelectorAll("button").map((b) => b.getAttribute("data-i18n")).sort(),
      "批量条长出了第四颗按钮 —— 如果它是验活，那是一颗自毁按钮",
    ).toEqual(["keys.bulk.clearCooldown", "keys.bulk.delete", "keys.bulk.disable"]);
    // 反向自检：批量条真的被扫到了（扫到空的话上面那条会以另一种方式红，但说不清原因）。
    expect(bar.querySelectorAll("button").length, "批量条一颗按钮都没扫到，装置坏了").toBe(3);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 头等一格：同一个 429 下的两种拒绝，在面板上是两句不同的话
// ───────────────────────────────────────────────────────────────────────────

describe("两种 429 的处置完全不同", () => {
  /**
   * ⚠️⚠️⚠️ **这一格是后端那一半交过来的第一条。**
   *
   * `probe_in_flight`（上一次探测还在飞，**等它回来**）与 `probe_cooldown`
   *（两次之间要隔一小段，**稍后再试，而且这不是这把 key 的故障**）
   * **HTTP 状态码一模一样**，后端那句 `message` 只有中文一种，而面板是五语言的。
   * ⇒ **唯一能把它们分开的是顶层 `reason`。**
   *
   * 断言落在渲染出来的那个节点的 `data-i18n` 上，不落在文本上：
   * key 是**手写字面量**（不是从被测代码里推导出来的），而文本随语言变。
   *
   * **变红条件（本任务实测过的三种）**：
   * ① `verifyTransportCode` 的判据从 `err.body.reason` 换回 `err.status === 429`
   *    ⇒ 两行都变成同一个 key；
   * ② 把 `keys-write.mjs` 里 `probe_cooldown` 那一支删掉 ⇒ 它落进默认支
   *    `keys.verify.upstreamError`；
   * ③ `sec-keys.js` 的 catch 分支改成走 `verifyResultCode(e)` ⇒ 两行都变成
   *    `keys.verify.rateLimited`（「上游在限流」——而一次上游请求都没发出去）。
   */
  it("probe_in_flight 与 probe_cooldown 在面板上是两句不同的话 —— 一个是「等它回来」，另一个是「稍后再试，而且不是这把 key 的故障」", async () => {
    const items = [keyView({ id: "busy", seq: 1 }), keyView({ id: "cool", seq: 2 })];
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      if (url === "/admin/api/keys/busy/verify") {
        return {
          status: 429,
          body: { error: { type: "rate_limit_error", message: "上一次探测还没有返回" }, reason: "probe_in_flight" },
        };
      }
      if (url === "/admin/api/keys/cool/verify") {
        return {
          status: 429,
          body: { error: { type: "rate_limit_error", message: "两次探测之间至少要隔一小段时间" }, reason: "probe_cooldown" },
        };
      }
      return { status: 200, body: {} };
    });
    const sec = h.section("keys");

    verifyButton(sec, "busy").click();
    await settle(12);
    verifyButton(sec, "cool").click();
    await settle(12);

    expect(resultKeys(sec, "busy")[0], "「上一次还在飞」被说成了别的").toBe("keys.verify.probeInFlight");
    expect(resultKeys(sec, "cool")[0], "「刚探过」被说成了别的").toBe("keys.verify.probeCooldown");
    expect(
      resultKeys(sec, "busy")[0] === resultKeys(sec, "cool")[0],
      "两种 429 说成了同一句话 —— 只看状态码的实现就是这样",
    ).toBe(false);

    /**
     * **它们不是「上游在限流」。** 探测闸占用时一次上游请求都没发出去，
     * 说成「上游在限流……等一会儿就好」是对运维撒谎（评审发现）。
     */
    for (const id of ["busy", "cool"]) {
      expect(resultKeys(sec, id), `${id}：护栏拒绝被说成了上游限流`).not.toContain("keys.verify.rateLimited");
    }
    // 面板上真的有字，不是一个空节点（否则「两句不同的话」是两句空话）。
    for (const id of ["busy", "cool"]) {
      const node = rowOf(sec, id).querySelectorAll(".verify-result")[0]!;
      expect(node.textContent.length, `${id}：结果节点是空的`).toBeGreaterThan(0);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 一次一发（按行算）、行内状态活过 render()、两条取消闸各管各的
// ───────────────────────────────────────────────────────────────────────────

describe("在飞态与并发", () => {
  /**
   * 一次一发的粒度**是按行算的**，与后端护栏的 `verify:<id>` 粒度一致
   *（`src/http/admin/probe-guard.ts` 写着为什么不用全局粒度）。
   *
   * **变红条件**：把 `verifyControl()` 里的 `disabled` 判据改成一个板块级的
   * 「有没有验活在飞」布尔 ⇒ b 那一行也会被灰掉。
   */
  it("验活在飞时这一行的按钮 disabled，其余行不受影响 —— 一次一发是按行算的", async () => {
    const items = [keyView({ id: "a", seq: 1 }), keyView({ id: "b", seq: 2 })];
    const d = deferred();
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      if (url === "/admin/api/keys/a/verify") return d.promise;
      return { status: 200, body: {} };
    });
    const sec = h.section("keys");

    expect(verifyButton(sec, "a").disabled, "前置条件：一开始它得是可点的").toBe(false);
    verifyButton(sec, "a").click();
    await settle(12);

    expect(verifyButton(sec, "a").disabled, "在飞时这一行还能再点一次 —— 连点会真的多打一次外网").toBe(true);
    expect(verifyButton(sec, "b").disabled, "验 a 把把 b 那一行也灰掉了 —— 后端护栏刻意不是全局粒度").toBe(false);
    // **只灰验活那一颗**，不是把整行冻住：同一行的备注按钮照样能点。
    const noteBtn = rowOf(sec, "a").querySelectorAll("button")
      .find((x) => x.getAttribute("data-i18n") === "keys.action.note")!;
    expect(noteBtn.disabled, "验活在飞把同一行别的动作也冻住了").toBe(false);
    // 在飞时那一行显示的是「正在探测…」，不是上一次的结果。
    expect(resultKeys(sec, "a")).toEqual(["keys.verify.running"]);

    d.release({ status: 200, body: { ok: true, status: 200, latencyMs: 12, reason: null } });
    await settle(12);
    expect(resultKeys(sec, "a")[0]).toBe("keys.verify.ok");
  });

  /**
   * ⚠️⚠️ **`render()` 每次重建整张表**（`sec-keys.js` 里那句 `host.textContent = "";`），
   * 而 `load()` → `render()` 由自动刷新定时器、搜索防抖、每一次行内/批量操作触发。
   * 行内状态若挂在按钮上，「在飞时这一行灰着」与「结果就地显示」**都会被任何一次
   * 并发 `load()` 抹掉**（评审发现）。
   *
   * **装置要点**：这一格**必须真的触发一次 `load()`**（点「刷新」），
   * 不触发的话不写重放逻辑也绿——第一版描述的用例正是全程不触发 `load()`。
   *
   * **变红条件**：把 `verifyControl()` 里那次 `verifyState.get(v.id)` 删掉
   *（也就是不再从那张 Map 重放）。
   */
  it("验活在飞时打断一次 load()：这一行的按钮仍然禁用、行内结果仍然在 —— render() 每次重建整张表", async () => {
    const items = [keyView({ id: "a", seq: 1 })];
    const d = deferred();
    let listCalls = 0;
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys?")) { listCalls++; return { status: 200, body: listBody(items) }; }
      if (url === "/admin/api/keys/a/verify") return d.promise;
      return { status: 200, body: {} };
    });
    const sec = h.section("keys");

    verifyButton(sec, "a").click();
    await settle(12);
    expect(resultKeys(sec, "a"), "前置条件：在飞态得先画出来").toEqual(["keys.verify.running"]);

    const before = listCalls;
    sec.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "common.refresh")!.click();
    await settle(12);
    expect(listCalls, "装置坏了：那一次 load() 根本没发出去，整张表没被重建过").toBe(before + 1);

    expect(verifyButton(sec, "a").disabled, "并发的一次 load() 把「在飞时禁用」抹掉了").toBe(true);
    expect(resultKeys(sec, "a"), "并发的一次 load() 把行内状态抹掉了").toEqual(["keys.verify.running"]);
  });

  /**
   * ⚠️⚠️ **验活必须有自己的 `AbortController`，不许复用模块级那个 `abort`**（评审发现）。
   * `load()` 的第一句就是 `if (abort) abort.abort();` ⇒ 复用的话，**任何一次
   * `load()`（自动刷新 / 搜索防抖 / 任何一次行内动作的收尾）都会把在飞的验活作废**，
   * 结果永远回不来，而按钮已经从「在飞」变回可点——运维会以为自己点漏了。
   *
   * **变红条件**：让 `verifyOne()` 用 `abort.signal` 而不是自己那把
   * ⇒ 那次 `load()` 的 `abort.abort()` 会把它的 `signal.aborted` 置真
   * ⇒ 结果被 `if (ctl.signal.aborted) return;` 丢掉，最后一条断言红。
   *
   * ⚠️⚠️ **反方向（发起验活会不会取消在飞的列表加载）在今天的替身下不可观测。
   * 这不是推的，是量的**：本任务变异往 `verifyOne()` 开头插了一句
   * `if (abort) abort.abort();`（发起验活就把在飞的列表加载掐掉，真实浏览器里
   * 那是一条真缺陷），`keys-write` + `keys-verify` + `keys-actions`
   * **三个文件 145 格全绿、完整逃逸**。
   * 成因：`harness.ts` 的 `fetch` 替身不看 `signal`，而 `load()` 只在 `catch` 里认
   * `AbortError` ⇒ 那条被 abort 的列表加载照样 resolve、照样 `render()`，
   * 两种实现的可观测行为逐字节相同（本仓第 5 种假阳性）。
   * ⇒ 守住那半边的是**结构**而不是断言：`verifyOne()` 每次 `new AbortController()`，
   * 板块里再没有第二处会去动 `abort` 那个变量。
   * **别把这一格读成「两个方向都守住了」。**
   */
  it("验活在飞时跑一次 load()：验活的结果照样落地 —— 两者各用各的取消闸", async () => {
    const items = [keyView({ id: "a", seq: 1 })];
    const d = deferred();
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      if (url === "/admin/api/keys/a/verify") return d.promise;
      return { status: 200, body: {} };
    });
    const sec = h.section("keys");

    verifyButton(sec, "a").click();
    await settle(12);
    // 这一次 `load()` 会 `abort.abort()` —— 复用同一把闸的实现从这里开始就完了。
    sec.querySelectorAll("button").find((b) => b.getAttribute("data-i18n") === "common.refresh")!.click();
    await settle(12);

    d.release({ status: 200, body: { ok: true, status: 200, latencyMs: 12, reason: null } });
    await settle(12);

    expect(
      resultKeys(sec, "a")[0],
      "一次普通的列表刷新把在飞的验活作废了 —— 验活复用了列表加载那把取消闸",
    ).toBe("keys.verify.ok");
    expect(verifyButton(sec, "a").disabled === true && resultKeys(sec, "a")[0] === "keys.verify.running")
      .toBe(false);
  });

  /**
   * 板块契约 §9.3：切走时作废在飞请求，否则切回来时上一次的结果会盖上去。
   *
   * **变红条件（两处，各自单独实测）**：
   * ① 把 `onHide()` 里那句 `abortVerifies()` 删掉；
   * ② 把 `verifyOne()` 里 `.then` / `.catch` 开头那两句 `if (ctl.signal.aborted) return;` 删掉。
   * 两种都会让被作废的那次结果在切回来之后出现在行内。
   */
  it("切走板块时在飞的验活被作废 —— 回来时不会被上一次的结果覆盖，按钮也不会永远停在「在飞」", async () => {
    const items = [keyView({ id: "a", seq: 1 })];
    const d = deferred();
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      if (url === "/admin/api/keys/a/verify") return d.promise;
      return { status: 200, body: {} };
    });
    let sec = h.section("keys");

    verifyButton(sec, "a").click();
    await settle(12);
    expect(resultKeys(sec, "a"), "前置条件：得先真的在飞").toEqual(["keys.verify.running"]);

    // 切走（`showSection` 会调 Key 池板块的 `onHide()`）。
    h.dom.document.querySelectorAll(".nav-item")
      .find((b) => b.getAttribute("data-section") === "overview")!.click();
    await settle(12);

    // 现在才让那次在飞的验活回来 —— 它必须被整份丢掉。
    d.release({ status: 200, body: { ok: true, status: 200, latencyMs: 12, reason: null } });
    await settle(12);

    // 把本地时钟推过最小间隔再切回来：否则按钮会因为「刚探过」而灰着，
    // 那会掩盖「它是不是还卡在在飞」这个真正要看的东西。
    setClock(NOW + 10_000);
    h.dom.document.querySelectorAll(".nav-item")
      .find((b) => b.getAttribute("data-section") === "keys")!.click();
    await settle(12);
    sec = h.section("keys");

    expect(resultKeys(sec, "a"), "被作废的那次结果还是渲染进去了").toEqual([]);
    expect(
      verifyButton(sec, "a").disabled,
      "那颗按钮永远停在「上一次探测还在飞」—— 那一次已经被作废，永远不会回来把它放开",
    ).toBe(false);
  });

  /**
   * ⚠️⚠️ **复评发现：一条已经**回来了**的结果同样不许跨越「离开这个板块」活下来。**
   *
   * 「验活通过」这句话**没有任何时间上下文**——它在面板上长得和「这把 key 现在是
   * 好的」一模一样。切走十分钟再切回来还挂着它，运维读到的就是一个十分钟前的结论
   * 当成当前状态，而这十分钟里这把 key 完全可能已经被上游吊销。
   * 这是订正「结果只就地显示、不落盘」那条纪律的另一半。
   *
   * ⚠️ **`lastAt` 刻意不清**：后端那道最小间隔闸不会因为切了个板块就重置，
   * 所以这一格用**冻住的时钟**切回来，断言按钮仍然因为「刚探过」而灰着——
   * 一并把「别顺手把冷却也清了」钉住。
   *
   * **变红条件**：把 `abortVerifies()` 里那句 `s.code = null;` 删掉。
   */
  it("已经回来的验活结果不许跨越一次「切走再切回」—— 那句话没有时间上下文，十分钟前的结论会被读成当前状态", async () => {
    const items = [keyView({ id: "a", seq: 1 })];
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      if (url === "/admin/api/keys/a/verify") {
        return { status: 200, body: { ok: true, status: 200, latencyMs: 12, reason: null } };
      }
      return { status: 200, body: {} };
    });
    let sec = h.section("keys");

    verifyButton(sec, "a").click();
    await settle(12);
    expect(resultKeys(sec, "a")[0], "前置条件：这一次验活得先真的成功并显示出来").toBe("keys.verify.ok");

    h.dom.document.querySelectorAll(".nav-item")
      .find((b) => b.getAttribute("data-section") === "overview")!.click();
    await settle(12);
    h.dom.document.querySelectorAll(".nav-item")
      .find((b) => b.getAttribute("data-section") === "keys")!.click();
    await settle(12);
    sec = h.section("keys");

    expect(
      resultKeys(sec, "a"),
      "切回来还挂着上一次的「验活通过」—— 那句话没有时间上下文，会被读成当前状态",
    ).toEqual([]);
    // 时钟没动过 ⇒ 后端那道最小间隔仍然生效，按钮必须还是灰的。
    expect(
      verifyButton(sec, "a").disabled,
      "顺手把 lastAt 也清了 —— 后端那道闸不会因为切了个板块就重置，运维按下去只会换回一句 429",
    ).toBe(true);
  });

  /**
   * ⚠️ **复评发现：`onHide()` 之后不许留下孤儿定时器，也不许对一个不可见的板块 `render()`。**
   *
   * `verifyOne()` 的 `.finally()` 里装的那个 3 秒重渲定时器，**只在这一次没被作废时
   * 才该装**。上一版是无条件装的 ⇒ 切走之后那次在飞的验活回来时，
   * 会给一个已经不可见的板块留一个定时器 + 跑一次 `render()`——
   * 而 `stopTimers()` 的注释逐字写着这正是它要消灭的东西。
   *
   * **变红条件**：把 `.finally()` 开头那句 `if (s.ctl !== ctl) return;` 去掉，
   * 让装定时器与 `render()` 变回无条件。
   */
  it("切走之后回来的那次验活不留孤儿定时器，也不对不可见的板块重渲一次", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const items = [keyView({ id: "a", seq: 1 })];
    const d = deferred();
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      if (url === "/admin/api/keys/a/verify") return d.promise;
      return { status: 200, body: {} };
    });

    verifyButton(h.section("keys"), "a").click();
    await settle(12);
    h.dom.document.querySelectorAll(".nav-item")
      .find((b) => b.getAttribute("data-section") === "overview")!.click();
    await settle(12);

    const timersAfterHide = vi.getTimerCount();
    d.release({ status: 200, body: { ok: true, status: 200, latencyMs: 12, reason: null } });
    await settle(12);

    expect(
      vi.getTimerCount(),
      "被作废的那次验活回来之后又装了一个定时器 —— 板块已经切走了，没人要看这张表",
    ).toBe(timersAfterHide);
    vi.useRealTimers();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 只读探针（订正）＋ 明文 key 一个字节都不许出现在这一层
// ───────────────────────────────────────────────────────────────────────────

describe("它是只读探针", () => {
  /**
   * ⚠️⚠️ **装置是这一格的全部内容。** 只断言「验活之后 strikes 还是 3」是**恒真**的
   *（`render()` 用的还是同一份 `data`，第 5 种假阳性）。这里让**第二次**列表响应
   * 给出完全不同的 strikes 与分档 ⇒ 只要 `verifyOne()` 顺手补一句 `load()`，
   * 屏幕上的数字当场就变，断言当场红。
   *
   * **变红条件**：给 `verifyOne()` 的 `.finally()` 加一句 `load()`。
   */
  it("验活成功后这一行的 strikes 与分档徽章一个字都没变 —— 它不许借着「顺手刷新一下」改屏幕上的数（订正）", async () => {
    let listCalls = 0;
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys?")) {
        listCalls++;
        // 第二次起给一份**完全不同**的数据：任何一次多余的 load() 都会把它画上去。
        const items = listCalls === 1
          ? [keyView({ id: "a", seq: 1, strikes: 3, bucket: "cooling" })]
          : [keyView({ id: "a", seq: 1, strikes: 99, bucket: "evicted", evicted: true })];
        return { status: 200, body: listBody(items) };
      }
      if (url === "/admin/api/keys/a/verify") {
        return { status: 200, body: { ok: true, status: 200, latencyMs: 12, reason: null } };
      }
      return { status: 200, body: {} };
    });
    const sec = h.section("keys");

    // 基线在**验活之前**取：面板启动时本来就会写 `agnes2api_section` /
    // `agnes2api_theme`，那与本格无关，拿一份固定清单去比只会测到别人的事。
    const storeBefore = Object.keys(h.store).sort();
    const strikesBefore = rowOf(sec, "a").querySelectorAll("td")[7]!.textContent;
    const badgeBefore = rowOf(sec, "a").querySelectorAll("span")
      .find((s) => (s.getAttribute("class") ?? "").startsWith("badge"))!.textContent;
    expect(strikesBefore, "装置坏了：第一份数据里 strikes 应该是 3").toBe("3");
    expect(badgeBefore.length, "装置坏了：分档徽章是空的").toBeGreaterThan(0);

    verifyButton(sec, "a").click();
    await settle(12);
    expect(resultKeys(sec, "a")[0], "前置条件：这一次验活得真的成功").toBe("keys.verify.ok");

    expect(listCalls, "验活顺手又拉了一次列表 —— 它是只读探针，不许改屏幕上的数").toBe(1);
    expect(rowOf(sec, "a").querySelectorAll("td")[7]!.textContent, "strikes 被验活改掉了").toBe(strikesBefore);
    expect(
      rowOf(sec, "a").querySelectorAll("span").find((s) => (s.getAttribute("class") ?? "").startsWith("badge"))!.textContent,
      "分档徽章被验活改掉了",
    ).toBe(badgeBefore);

    // **结果只在这一行就地显示，不落盘**（订正）：localStorage 一个键都没多。
    expect(Object.keys(h.store).sort(), "验活把结果写进了 localStorage").toEqual(storeBefore);
    // 反向自检：基线不是空的（空的话上面那条在任何实现下都成立）。
    expect(storeBefore, "基线里连会话那两个键都没有，装置坏了").toContain(KEY_STORE);
    expect(storeBefore).toContain(SAVED_AT_STORE);

    // 「这是一次人造探测，不改变这把 key 的状态」这句话必须**看得见**，
    // 否则运维会以为验活成功就等于把 strikes 清了。
    expect(
      rowOf(sec, "a").querySelectorAll(".verify-note").map((n) => n.getAttribute("data-i18n")),
      "结果旁边没有那句「它不改变这把 key 的状态」",
    ).toEqual(["keys.verify.readOnlyNote"]);
  });

  /**
   * ⚠️⚠️ **全局约束 11(a) 的前端半身。** 后端已经钉住了「一个字节的上游正文都不
   * 回给面板」（后端那一半）；**这一层不许把拿到的东西再暴露出去**——尤其别把请求或
   * 响应整份塞进任何调试出口或 `title`。
   *
   * 夹具喂一份**带诱饵**的 200 响应体：一个显然不该出现在屏幕上的字段
   *（模拟将来某次后端改动多回了一个字段）与一个绝不会与真实渲染撞车的 `latencyMs`。
   *
   * **变红条件**：把 `verifyControl()` 里那个结果节点改成
   * `el("span", { title: JSON.stringify(resp) }, …)` 这类写法。
   *
   * ⚠️ **覆盖边界，明写（复评发现）：这一格只喂了 200 那条路径。**
   * 非 2xx 走的是 `ApiError`，而 `ApiError.body` 是**整份被解析过的错误响应体**
   *（`js/api.js` 的 `json()`）——上游 401 的错误体恰恰是各家 API 最爱回显 key 片段
   * 的地方。今天那条路径**结构上安全**：后端从不把上游正文放进错误体
   *（后端那一半的约束 2），而前端 `catch` 分支只把 `e` 交给 `verifyTransportCode()`，
   * 它只读 `e.body.reason` 与 `e.status`、只回一个 code。
   * **但这是「结构上安全」，不是「有一格诱饵盯着」** —— 有人往那条分支里加一句
   * `toast(e.message)` 的话，这一格不会红。
   */
  it("验活之后这一行的文本与 title 里不出现响应体里的任何值 —— 结果节点只承载一个 i18n key（只覆盖 200 那条路径，见上）", async () => {
    const CANARY = "sk-live-LEAKCANARY-0000";
    const LATENCY = 424_242_424;
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys?")) {
        return { status: 200, body: listBody([keyView({ id: "a", seq: 1 })]) };
      }
      if (url === "/admin/api/keys/a/verify") {
        return {
          status: 200,
          body: { ok: true, status: 200, latencyMs: LATENCY, reason: null, probedWith: CANARY },
        };
      }
      return { status: 200, body: {} };
    });
    const sec = h.section("keys");

    verifyButton(sec, "a").click();
    await settle(12);
    expect(resultKeys(sec, "a")[0], "前置条件：这一次验活得真的成功").toBe("keys.verify.ok");

    const text = sec.textContent;
    expect(text, "响应体里的字段被原样渲染出来了").not.toContain(CANARY);
    expect(text, "响应体里的 latencyMs 被原样渲染出来了").not.toContain(String(LATENCY));
    const titles = allTitles(sec).join("\n");
    expect(titles, "响应体被塞进了某个 title").not.toContain(CANARY);
    expect(titles, "响应体的 latencyMs 被塞进了某个 title").not.toContain(String(LATENCY));
    // 反向自检：诱饵真的送到过面板手上（送都没送到的话上面四条恒绿）。
    expect(
      h.calls.some((c) => c.url === "/admin/api/keys/a/verify"),
      "那次验活请求根本没发出去，诱饵没送到，四条 not.toContain 恒真",
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 三条 disable 理由在面板上各自可区分
// ───────────────────────────────────────────────────────────────────────────

describe("按钮的可用性与它的理由", () => {
  /**
   * 「只说不可用，运维只能猜」。三种状态下 `title` 必须是三句**不同**的话，
   * 而且各自来自手写点名的那条字典键（语言无关地比对五种译文，
   * 免得这一格与面板当前语言绑死）。
   *
   * **变红条件**：把 `verifyControl()` 里那句 `setAttribute("title", …)` 删掉，
   * 或者让 `verifyDisabledTitleKey()` 对三种理由回同一个 key。
   */
  it("可用 / 在飞 / 刚探过：三种状态的 title 是三句不同的话，冷却到点后按钮自己恢复", async () => {
    /**
     * ⚠️ **假定时器必须在验活发起**之前**装好。** `verifyOne()` 的 `.finally()` 里
     * 那次 `setTimeout` 是在发起之后排下的——装晚了就排在真实定时器上，
     * 后面 `advanceTimersByTimeAsync()` 推的是另一条队列，那一格会红成
     * 「按钮还灰着」，而真正的原因是装置本身。本任务实测踩过一次。
     * 只 fake `setTimeout` / `clearTimeout`：`Date.now()` 由 `setClock()` 单独管，
     * 两者混在一起会让「本地时钟走到哪」这件事说不清楚。
     */
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const items = [keyView({ id: "a", seq: 1 })];
    const d = deferred();
    const h = await openKeys((url) => {
      if (url.startsWith("/admin/api/keys?")) return { status: 200, body: listBody(items) };
      if (url === "/admin/api/keys/a/verify") return d.promise;
      return { status: 200, body: {} };
    });
    const sec = h.section("keys");
    const variants = (key: string) => Object.values(I18N[key as keyof typeof I18N] as Record<string, string>);

    const enabled = verifyButton(sec, "a").getAttribute("title")!;
    expect(variants("keys.verify.hintEnabled"), "可用时那句话不是「按一下会真的发一次请求」").toContain(enabled);

    verifyButton(sec, "a").click();
    await settle(12);
    const inFlight = verifyButton(sec, "a").getAttribute("title")!;
    expect(variants("keys.verify.disabledInFlight"), "在飞时那句话不是「上一次还在飞」").toContain(inFlight);

    d.release({ status: 200, body: { ok: true, status: 200, latencyMs: 12, reason: null } });
    await settle(12);
    const cooling = verifyButton(sec, "a").getAttribute("title")!;
    expect(variants("keys.verify.disabledCoolingDown"), "刚探完那句话不是「刚探过」").toContain(cooling);
    expect(verifyButton(sec, "a").disabled, "刚探完那一刻按钮还能点 —— 后端会回一句 429，而运维什么错都没犯").toBe(true);

    expect(new Set([enabled, inFlight, cooling]).size, "三种状态说的是同一句话 —— 只说「不可用」运维只能猜").toBe(3);

    /**
     * 冷却到点之后按钮必须自己恢复。**这里刻意不去点任何按钮**（点一下会顺带
     * 触发 `load()` → `render()`，那样测的就不是「它自己恢复」了）——
     * 只把本地时钟推过最小间隔，再等 `verifyOne()` 排下的那次重渲跑完。
     *
     * **变红条件**：把 `verifyOne()` 的 `.finally()` 里那次
     * `setTimeout(… VERIFY_MIN_INTERVAL_MS)` 删掉 ⇒ 按钮会一直显示成「刚探过」，
     * 直到运维碰巧做了点别的事把整张表重画一次。
     */
    setClock(NOW + 10_000);
    await vi.advanceTimersByTimeAsync(4_000);
    vi.useRealTimers();
    await settle(12);

    expect(verifyButton(sec, "a").disabled, "冷却到点了那颗按钮还灰着 —— 没有任何东西会把它重画").toBe(false);
    expect(variants("keys.verify.hintEnabled"), "恢复之后那句话没跟着换回来")
      .toContain(verifyButton(sec, "a").getAttribute("title")!);
  });
});
