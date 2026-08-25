import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import {
  EVENTS_POLL_MIN_MS, EVENTS_POLL_MAX_MS,
} from "../../../admin-ui/js/pure/events.mjs";
import { I18N } from "../../../admin-ui/js/i18n-dict.js";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **B1 目标 ④：事件板块的轮询调度**——它守的是**发货给用户的那条读配额包线**。
 *
 * 五语言 DEPLOY.md 白纸黑字承诺「安静部署单开一个面板标签页 = 每天 70,560 次读」，
 * 而那个数字的分母就是**稳态轮询间隔 60 秒**。把 `scheduleNext()` 里的
 * `pollState.delayMs` 换成硬编码的 15 秒，生产吞吐立刻变成 4 倍
 *（`(86400 ÷ 15) × 49 = 282,240`，是免费档读配额的 2.8 倍 —— 面板一开就把整天的
 * 读配额打穿），**而在这一组出现之前全套用例一条都不红**：
 * `pure/events.mjs` 的 `nextPollDelayMs` 被测得很细，但**没有任何东西验证板块文件
 * 真的把它的返回值喂给了 `setTimeout`**。这正是本仓登记的
 * 「我验的是我实现的那条路径，不是文档承诺的那件事」。
 *
 * 观测点：`setTimeout` 的**第二个实参**——运维付的那笔钱就是按它算的。
 */
const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** 进壳层、切到事件板块，并把每一次 `setTimeout` 的延迟记下来。 */
async function openEvents(bodies: Array<{ items: unknown[]; cursor: number | null }>) {
  const delays: number[] = [];
  const timers: Array<() => void> = [];
  vi.stubGlobal("setTimeout", (fn: () => void, ms: number) => {
    delays.push(ms);
    timers.push(fn);
    return timers.length;
  });
  vi.stubGlobal("clearTimeout", () => {});

  let round = 0;
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000) },
    respond: (url) => {
      if (!url.startsWith("/admin/api/events")) return { status: 200, body: {} };
      const b = bodies[Math.min(round, bodies.length - 1)]!;
      round++;
      return {
        status: 200,
        body: {
          items: b.items, cursor: b.cursor, cursorAhead: false,
          dropped: 0, budgetExhausted: false, truncated: false, buffered: 0,
          shardId: "s", generatedAt: NOW,
        },
      };
    },
  });
  await settle();
  // 切到事件板块（真实点击导航按钮）。
  h.dom.document.querySelectorAll(".nav-item")
    .find((b) => b.getAttribute("data-section") === "events")!
    .click();
  await settle();
  return { h, delays, tick: async () => { timers.pop()!(); await settle(); } };
}

describe("事件板块的轮询间隔：DEPLOY.md 那条读配额包线的分母", () => {
  /**
   * **反向自检先行**：有新内容时必须回到最短间隔（15 秒）。少了这一格，
   * 「一律用 60 秒」也能让下面那格全绿——而那会让运维盯着屏幕等一分钟才看到新事件。
   */
  it("有新事件时回到最短间隔（15 秒）", async () => {
    const { delays } = await openEvents([{ items: [{ ts: NOW, level: "info", event: "x" }], cursor: NOW }]);
    expect(delays.length, "进板块之后一次轮询都没排上").toBeGreaterThan(0);
    expect(delays[delays.length - 1], "有新内容却没回到最短间隔").toBe(EVENTS_POLL_MIN_MS);
  });

  /**
   * **正向：连续没有新内容 ⇒ 指数退避一路顶到 60 秒并稳住。**
   * 这就是包线里那个 `86400 ÷ 60`。
   */
  it("连续没有新事件时退避到 60 秒上限并稳住 —— 这是 70,560 那条包线的分母", async () => {
    const { delays, tick } = await openEvents([{ items: [], cursor: null }]);
    for (let i = 0; i < 6; i++) await tick();
    expect(delays[0], "第一轮之后应当先翻倍到 30 秒").toBe(EVENTS_POLL_MIN_MS * 2);
    expect(delays[delays.length - 1], "退避没有顶到上限").toBe(EVENTS_POLL_MAX_MS);
    // 稳住：最后三轮都必须是上限，而不是"碰一下就掉回去"。
    expect(delays.slice(-3)).toEqual([EVENTS_POLL_MAX_MS, EVENTS_POLL_MAX_MS, EVENTS_POLL_MAX_MS]);
  });

  /**
   * **递增序列整条钉住。** 只断言"最后是 60 秒"的话，把退避改成"第一轮就跳到 60"
   * 也全绿——那会让运维在最需要盯着看的头一分钟里什么都看不到。
   */
  it("退避序列恰好是 30 / 60 / 60…（翻倍并封顶，不是一步到位）", async () => {
    const { delays, tick } = await openEvents([{ items: [], cursor: null }]);
    for (let i = 0; i < 3; i++) await tick();
    expect(delays.slice(0, 4)).toEqual([30_000, 60_000, 60_000, 60_000]);
  });

  /**
   * **退避之后又来了新内容 ⇒ 立刻掉回 15 秒。**
   * 这一条把"退避"与"回弹"两半连起来：只测其中一半时，
   * 「退避到 60 之后永远回不来」与「一直是 15」各能骗过一半。
   */
  it("退避到上限之后来了新事件：立刻掉回 15 秒", async () => {
    const { delays, tick } = await openEvents([
      { items: [], cursor: null },
      { items: [], cursor: null },
      { items: [], cursor: null },
      { items: [{ ts: NOW + 1, level: "warn", event: "y" }], cursor: NOW + 1 },
    ]);
    await tick();
    await tick();
    expect(delays[delays.length - 1], "前置条件：先得真的退到上限").toBe(EVENTS_POLL_MAX_MS);
    await tick();
    expect(delays[delays.length - 1], "来了新事件却没回到最短间隔").toBe(EVENTS_POLL_MIN_MS);
  });

  /**
   * **「清空」按钮之后列表区那句话必须说真话**（全分支评审 I5 的**行为形态**）。
   *
   * ⚠️ **这一格是自查补的：第一轮 B1 做完之后拿这条变异实测，它完整逃逸。**
   * 把 `clearBtn` 的回调从 `{ view = []; cleared = true; render(); }` 改回
   * `{ view = []; render(); }`（也就是那个**已经上线**的缺陷原样重放），
   * 29 条 DOM 用例一条都不红——`pure/events.mjs` 的 `eventsListMessageKey` 被测得
   * 很细，但**没有任何东西验证板块文件真的把 `cleared` 喂给了它**。
   * 这正是本仓登记的"我验的是我实现的那条路径，不是文档承诺的那件事"，
   * 也正是 ESCAPED 的第二种成因（变异对齐了，是**观测点**不对）。
   *
   * 观测的是**运维实际读到的那句话**：清空之后不许出现「还没有事件。」——
   * 服务端明明有事件，那句话与同一个按钮的 tooltip 当场矛盾。
   */
  it("点「清空」之后列表区说的是「已清空」，不是「还没有事件」", async () => {
    const { h } = await openEvents([{ items: [{ ts: NOW, level: "info", event: "x" }], cursor: NOW }]);
    const section = h.section("events");
    const empty = I18N["ev.empty"]!["zh-CN"]!;
    const cleared = I18N["ev.cleared"]!["zh-CN"]!;

    expect(section.textContent, "前置条件：清空之前得真的有事件显示出来").toContain("x");

    section.querySelectorAll("button")
      .find((b) => b.getAttribute("data-i18n") === "ev.clear")!
      .click();
    await settle();

    const text = section.textContent;
    expect(text, "清空之后面板对运维说「还没有事件」—— 而服务端明明有").not.toContain(empty);
    expect(text, "清空之后没给出那句说明（含恢复路径）").toContain(cleared);
  });

  /**
   * **反向：一个真正全新的部署要说「还没有事件」，不是「已清空」。**
   * 只写上面那格的话，「一律说已清空」也全绿——那对一个刚部署完的用户同样是假话。
   */
  it("从来没点过清空、服务端也确实没有事件时，说的是「还没有事件」", async () => {
    const { h } = await openEvents([{ items: [], cursor: null }]);
    const text = h.section("events").textContent;
    expect(text).toContain(I18N["ev.empty"]!["zh-CN"]!);
    expect(text).not.toContain(I18N["ev.cleared"]!["zh-CN"]!);
  });

  /**
   * **暂停按钮真的把轮询停掉。**
   * 变异：把 `if (state.paused || document.hidden) return;` 删掉 ⇒ 暂停之后仍在排下一轮，
   * 面板嘴上说"已暂停"、实际照样在烧配额。
   */
  it("点了暂停之后不再排下一轮（否则面板嘴上暂停、实际照烧配额）", async () => {
    const { h, delays, tick } = await openEvents([{ items: [], cursor: null }]);
    const pause = h.section("events").querySelectorAll("button")
      .find((b) => b.getAttribute("data-i18n") === "ev.pause")!;
    const before = delays.length;
    pause.click();
    await settle();
    await tick();
    expect(delays.length, "暂停之后还在排下一轮轮询").toBe(before);
  });
});

/**
 * **黄条的接线：判据在 `pure/`，但"真的挂上去了"这件事只有 DOM 通道验得了。**
 *
 * ⚠️ **这一组是第三轮补的，成因如实登记**：`shouldWarn` 收下 `cursorBroken`（评审 I6）
 * 之后，**判据被钉住了、接线没有**——把 `sec-events.js` 里那两行
 * `nodes.warnCursorBroken.style.display = …` 改成永不显示（并重跑 `build-ui.mjs`），
 * 全量 1541 一条都不红。
 *
 * ⚠️ 而当时 `sec-events.js` 与 `events-cursor-heal.test.ts` 里都写着
 * 「**本仓无 DOM 测试通道**」——**那句话早就不成立了**（本目录有 harness + 四份用例，
 * `events-poll.test.ts` 就在真点导航按钮、真驱动事件板块）。
 * 一句写下时为真、后来被同一个仓自己的新代码推翻的断言，正是本仓记了二十余次的那一种。
 */
describe("事件板块的黄条：后端字段 → 真的显示出来", () => {
  const TOKEN2 = "admin-token-0123456789-ok!";
  const AT = 1_700_000_000_000;

  /** 进壳层、切到事件板块，用给定的响应体驱动一轮。 */
  async function openWith(body: Record<string, unknown>) {
    const h = await bootPanel({
      now: AT,
      store: { [KEY_STORE]: TOKEN2, [SAVED_AT_STORE]: String(AT - 1000) },
      respond: (url) => (url.startsWith("/admin/api/events")
        ? { status: 200, body: { items: [], shardId: "s", generatedAt: AT, ...body } }
        : { status: 200, body: {} }),
    });
    await settle();
    h.dom.document.querySelectorAll(".nav-item")
      .find((b) => b.getAttribute("data-section") === "events")!
      .click();
    await settle();
    return h;
  }

  /** 事件板块里当前**可见**的全部文本（`display: none` 的不算）。 */
  function visible(h: Awaited<ReturnType<typeof openWith>>): string {
    const out: string[] = [];
    const walk = (el: { children: unknown[]; textContent: string; style: { display: string } }) => {
      if (el.style.display === "none") return;
      if (el.children.length === 0) out.push(el.textContent);
      for (const c of el.children) walk(c as never);
    };
    walk(h.section("events") as never);
    return out.join(" | ");
  }

  /**
   * **反向自检先行**：契约正常时那条黄条必须**不**显示。少了它，
   * 「一律显示」也能让下面那格全绿——而常驻的假告警比没有告警更糟。
   */
  it("cursor 合法（数字）时，契约破坏那条黄条不显示", async () => {
    const h = await openWith({ cursor: AT, cursorAhead: false, dropped: 0, budgetExhausted: false, truncated: false, buffered: 0, malformed: 0 });
    expect(visible(h)).not.toContain(I18N["ev.warnCursorBroken"]["zh-CN"]);
  });

  it("cursor 合法（null = 本页没有新事件）时同样不显示", async () => {
    const h = await openWith({ cursor: null, cursorAhead: false, dropped: 0, budgetExhausted: false, truncated: false, buffered: 0, malformed: 0 });
    expect(visible(h)).not.toContain(I18N["ev.warnCursorBroken"]["zh-CN"]);
  });

  /**
   * **后端契约被破坏（响应体里根本没有 `cursor` 字段）⇒ 黄条必须真的出现在页面上。**
   * 这正是 W2 实测到的那个响应体形状：`c.json` 把 `undefined` 整个丢掉。
   * 变红条件：`sec-events.js` 里那两行 `warnCursorBroken` 的接线被删/改成永不显示。
   */
  it("响应体缺 cursor 字段时，契约破坏那条黄条真的显示出来", async () => {
    const h = await openWith({ cursorAhead: false, dropped: 0, budgetExhausted: false, truncated: false, buffered: 0, malformed: 0 });
    expect(
      visible(h),
      "判据（shouldWarn）钉住了，但接线没有 —— 黄条压根没挂上去",
    ).toContain(I18N["ev.warnCursorBroken"]["zh-CN"]);
  });
});

/**
 * ── `aria-pressed`：级别分段的选中态得读得出来（P3e Task 20）─────────────────────
 *
 * ⚠️⚠️ **这一组是「就地改状态、不重建按钮」的**：`setLevel()` 握着 `levelButtons`
 * **就地** `classList.toggle("active", …)`（其余板块每次 `render()` 重建，
 * 创建时属性对象里那一行就够了）。只补创建处、不补 `setLevel()` 的话，
 * 首帧那一格照样绿，而屏幕上换了档、读屏读出来的**永远是「全部」**
 * ——那正是 P3d 那次「就地更新够不着盒子外的节点」的同一个形状。
 *
 * `tests/unit/source-guards.test.ts「sec-*.js 里每一个 btn-toggle 创建点都带 aria-pressed」`
 * 只拦「创建点漏写」，拦不住这一族；这一格就是那一半。
 * 「就地改的今天只有这一处」由
 * `tests/unit/source-guards.test.ts「反向控制：就地改 aria-pressed 的只有 sec-events.js 那一处」`
 * 钉着。
 */
describe("事件级别分段的 aria-pressed 跟着点击走", () => {
  it("点 error 那一颗：「全部」转 false、error 转 true —— setLevel 里漏了这一行就红", async () => {
    const { h } = await openEvents([{ items: [], cursor: null }]);
    const sec = h.section("events");
    const btns: FakeElement[] = [];
    for (const b of sec.querySelectorAll(".btn-toggle")) btns.push(b);
    // 「全部」+ 四个级别。期望值手写字面量。
    expect(btns.length, "前置条件：级别按钮得真的画出来了").toBe(5);
    expect(btns.map((b) => b.getAttribute("aria-pressed")), "首帧默认停在「全部」")
      .toEqual(["true", "false", "false", "false", "false"]);
    expect(btns.map((b) => b.getAttribute("data-i18n")), "按钮顺序变了 —— 下面那条点的就不是 error 了")
      .toEqual(["ev.level.all", "ev.level.debug", "ev.level.info", "ev.level.warn", "ev.level.error"]);

    // ⚠️ **握着同一批节点断言**：这一组就地改状态、不重建按钮，重新查一次也是同一批。
    btns[4]!.click();
    await settle();
    expect(
      btns.map((b) => b.getAttribute("aria-pressed")),
      "屏幕上换了档，aria-pressed 还停在首帧那一档 —— 读屏用户读到的是假的",
    ).toEqual(["false", "false", "false", "false", "true"]);
    // 与 `.active` 成对：两条一起才说明这两条腿没有分家。
    expect(btns.map((b) => b.classList.contains("active")))
      .toEqual([false, false, false, false, true]);
  });
});
