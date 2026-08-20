import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import {
  EVENTS_POLL_MIN_MS, EVENTS_POLL_MAX_MS,
} from "../../../admin-ui/js/pure/events.mjs";
import { I18N } from "../../../admin-ui/js/i18n-dict.js";

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
