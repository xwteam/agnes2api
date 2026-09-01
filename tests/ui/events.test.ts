import { describe, it, expect } from "vitest";
import {
  EVENTS_POLL_MIN_MS, EVENTS_POLL_MAX_MS, LEVELS,
  levelLabelKey, effectiveLevel, eventLevelLabelKey, levelBadgeClass,
  eventsQuery, itemsOf, eventsListMessageKey, shardIdOf, generatedAtOf, bufferStatus,
  shouldWarn, nextAfter, cursorOutcome, initialPollState, resumePollState, pollOutcome, nextPollDelayMs,
  pollIndicatorState, pollIndicatorLabelKey, matchesSearch,
  formatFields, buildDetailText, groupEvents, orderForDisplay, mergeIntoView,
} from "../../admin-ui/js/pure/events.mjs";
import { I18N } from "../../admin-ui/js/i18n-dict.js";

/** 一份"正常"的 /admin/api/events 响应，各条用例在它上面改一处。 */
const body = {
  items: [
    { ts: 3000, level: "warn", event: "admin.login_failed", fields: { ip: "203.0.113.7", hasHeader: true } },
    { ts: 2000, level: "info", event: "pool.key_added", msg: "已导入", fields: { id: "abc" } },
    { ts: 1000, level: "error", event: "registrar.mint_failed" },
  ],
  cursor: 3000, shardId: "shard-1", buffered: 0, dropped: 0, budgetExhausted: false,
  truncated: false, generatedAt: 4000,
};

describe("常量", () => {
  it("轮询区间字面量本身是策略，独立钉死", () => {
    expect(EVENTS_POLL_MIN_MS).toBe(15_000);
    expect(EVENTS_POLL_MAX_MS).toBe(60_000);
  });
  it("LEVELS 四个级别，顺序即渲染顺序", () => {
    expect(LEVELS).toEqual(["debug", "info", "warn", "error"]);
  });
});

describe("levelLabelKey：工具栏筛选按钮专用，四个级别各自映射不同的 i18n key", () => {
  it("四个级别各自映射不同的 key，且都在字典里", () => {
    const keys = new Set();
    for (const level of LEVELS) {
      const k = levelLabelKey(level);
      keys.add(k);
      expect(I18N[k], `${level} → ${k} 应当在字典里`).toBeDefined();
    }
    expect(keys.size).toBe(4);
  });
});

/**
 * **评审发现**：`effectiveLevel` 是"一条事件真实显示成哪个级别"的唯一判据——
 * 四个已知级别透传，其余一律显式归到 "unknown"，不冒充任何已知级别（尤其不冒充
 * "info"，那会让脏数据顶着绿色徽章蒙混过去）。
 */
describe("effectiveLevel / eventLevelLabelKey：缺失或畸形的 level 显式归为 unknown，不冒充已知级别", () => {
  it("四个已知级别原样透传", () => {
    for (const lvl of LEVELS) expect(effectiveLevel({ level: lvl })).toBe(lvl);
  });
  it("缺失/畸形/不认识的字符串一律是 unknown，不是 info（不伪造成看起来正常的级别）", () => {
    for (const bad of [{ level: undefined }, {}, { level: 123 }, { level: "not-a-level" }, null, undefined]) {
      expect(effectiveLevel(bad), JSON.stringify(bad)).toBe("unknown");
    }
  });
  it("eventLevelLabelKey 对五种输出（四个已知 + unknown）各自映射到字典里存在的 key", () => {
    const keys = new Set([...LEVELS, "unknown"].map(eventLevelLabelKey));
    expect(keys.size).toBe(5);
    for (const k of keys) expect(I18N[k], k).toBeDefined();
  });
  it("levelBadgeClass 对 unknown 不给任何看起来正常/异常的颜色（不含 badge-ok/-warn/-danger）", () => {
    const cls = levelBadgeClass("unknown");
    expect(cls).not.toContain("badge-ok");
    expect(cls).not.toContain("badge-warn");
    expect(cls).not.toContain("badge-danger");
  });
  it("error/warn 与 debug/info 使用不同颜色的徽章", () => {
    expect(levelBadgeClass("error")).toContain("badge-danger");
    expect(levelBadgeClass("warn")).toContain("badge-warn");
    expect(levelBadgeClass("info")).not.toContain("badge-danger");
    expect(levelBadgeClass("debug")).not.toContain("badge-warn");
  });
});

describe("eventsQuery：查询串", () => {
  it("三个参数都给时全部出现", () => {
    expect(eventsQuery({ after: 1000, level: "error", limit: 50 })).toBe("after=1000&level=error&limit=50");
  });
  it("level=\"all\" 不发这个参数（后端把无法识别的值当不筛，发了只是噪音）", () => {
    expect(eventsQuery({ after: 1000, level: "all", limit: 50 })).toBe("after=1000&limit=50");
  });
  it("after 缺失/非法时不发这个参数", () => {
    for (const bad of [undefined, null, "oops", Number.NaN]) {
      expect(eventsQuery({ level: "all", limit: 50, after: bad })).toBe("limit=50");
    }
  });
  it("空 state（什么都没给）产出空串", () => {
    expect(eventsQuery({})).toBe("");
  });
});

describe("itemsOf：全模块唯一的\"有没有可渲染条目\"判据", () => {
  it("缺失/畸形时是 null", () => {
    for (const bad of [null, undefined, {}, { items: null }, { items: "oops" }]) {
      expect(itemsOf(bad), String(bad)).toBeNull();
    }
  });
  it("有数据时透传", () => {
    expect(itemsOf(body)).toBe(body.items);
  });
});

/**
 * **评审发现**：判据必须是"视图里有没有数据"，不是"这一次有没有成功过"——后者
 * 会让重新进入本板块时，只要第一轮轮询恰好失败，就把已经攒下的历史事件整个
 * 换成"读取失败"。
 */
describe("eventsListMessageKey：列表区该显示哪条消息", () => {
  it("视图为空且读取失败 ⇒ loadFailed", () => {
    expect(eventsListMessageKey(true, 0, 0)).toBe("common.loadFailed");
  });
  it("视图有数据，即使这一轮读取失败，也不显示 loadFailed——继续显示已有数据（评审发现的核心断言）", () => {
    expect(eventsListMessageKey(true, 3, 3)).toBeNull();
  });
  it("视图有数据、读取失败、但搜索过滤后恰好一条都不剩 ⇒ noMatch（不是 loadFailed）", () => {
    expect(eventsListMessageKey(true, 3, 0)).toBe("ev.noMatch");
  });
  it("没有读取失败、视图本身是空的 ⇒ empty", () => {
    expect(eventsListMessageKey(false, 0, 0)).toBe("ev.empty");
  });
  it("没有读取失败、视图有数据但过滤后没有匹配 ⇒ noMatch", () => {
    expect(eventsListMessageKey(false, 5, 0)).toBe("ev.noMatch");
  });
  it("有数据可显示时返回 null（显示表格）", () => {
    expect(eventsListMessageKey(false, 5, 5)).toBeNull();
  });

  /**
   * **评审发现：面板对运维说假话（这是一个已经上线的缺陷）。**
   *
   * 点「清空」之后 `view` 变成 `[]`，原来只看 `viewLength === 0` ⇒ 列表区显示
   * 「还没有事件。」——与同一个按钮的 tooltip（「不影响服务端已落盘的事件」）
   * 当场自相矛盾，而且它说的那件事是假的：服务端明明有事件。运维照着这句话会
   * 得出「这个部署从来没出过事」的结论，而那正是事件板块存在的全部理由。
   *
   * **两个方向都断言**：只写正向那格（清空后 ⇒ ev.cleared）的话，把判据改成
   * 「一律返回 ev.cleared」也能全绿——而那会让一个真正全新的部署被告知
   * 「已清空本页显示」，同样是假话，只是方向反过来。
   */
  it("点过清空 ⇒ ev.cleared（不是 ev.empty —— 服务端明明有事件）", () => {
    expect(eventsListMessageKey(false, 0, 0, true)).toBe("ev.cleared");
  });
  it("没点过清空、视图本来就是空的 ⇒ 仍然是 ev.empty（反向：判据不许一律说『已清空』）", () => {
    expect(eventsListMessageKey(false, 0, 0, false)).toBe("ev.empty");
  });
  it("cleared 缺省（调用方没传）等同于 false —— 旧调用点不会被静默改语义", () => {
    expect(eventsListMessageKey(false, 0, 0, undefined)).toBe("ev.empty");
  });
  it("清空之后遇上读取失败：仍然先报 loadFailed（那是更要紧的那件事）", () => {
    expect(eventsListMessageKey(true, 0, 0, true)).toBe("common.loadFailed");
  });
  it("清空之后又拉到了新事件、但被搜索框滤空 ⇒ noMatch（不是 ev.cleared）", () => {
    expect(eventsListMessageKey(false, 3, 0, true)).toBe("ev.noMatch");
  });
});

describe("shardIdOf：本 isolate 的分片 id（评审发现），绝不伪造", () => {
  it("缺失/畸形时是 null，不是空串", () => {
    for (const bad of [null, undefined, {}, { shardId: 1 }, { shardId: "" }, { shardId: null }]) {
      expect(shardIdOf(bad), String(bad)).toBeNull();
    }
  });
  it("有数据时透传", () => {
    expect(shardIdOf(body)).toBe("shard-1");
  });
});

describe("generatedAtOf：响应生成时刻（评审发现 [LOW]），绝不伪造", () => {
  it("缺失/畸形时是 null", () => {
    for (const bad of [null, undefined, {}, { generatedAt: "4000" }, { generatedAt: NaN }]) {
      expect(generatedAtOf(bad), String(bad)).toBeNull();
    }
  });
  it("有数据时透传，含真实的 0", () => {
    expect(generatedAtOf(body)).toBe(4000);
    expect(generatedAtOf({ generatedAt: 0 })).toBe(0);
  });
});

describe("bufferStatus：dropped / budgetExhausted / truncated / buffered / cursorAhead / malformed 绝不伪造", () => {
  const NONE = {
    dropped: null, budgetExhausted: null, truncated: null, buffered: null, cursorAhead: null, malformed: null,
  };
  it("缺失/畸形时逐项 null", () => {
    for (const bad of [
      null, undefined, {}, { dropped: "5" }, { budgetExhausted: "yes" }, { truncated: "yes" },
      { buffered: "3" }, { cursorAhead: "yes" }, { malformed: "2" },
    ]) {
      expect(bufferStatus(bad), String(bad)).toEqual(NONE);
    }
  });
  it("有数据时逐项透传，含真实的 0/false", () => {
    expect(bufferStatus({
      dropped: 0, budgetExhausted: false, truncated: false, buffered: 0, cursorAhead: false, malformed: 0,
    })).toEqual({
      dropped: 0, budgetExhausted: false, truncated: false, buffered: 0, cursorAhead: false, malformed: 0,
    });
    expect(bufferStatus({
      dropped: 50, budgetExhausted: true, truncated: true, buffered: 7, cursorAhead: true, malformed: 3,
    })).toEqual({
      dropped: 50, budgetExhausted: true, truncated: true, buffered: 7, cursorAhead: true, malformed: 3,
    });
  });
  it("buffered 单独缺失/畸形时只有它是 null，其余字段不受影响（评审发现）", () => {
    expect(bufferStatus({ ...NONE, dropped: 0, budgetExhausted: false, truncated: false, buffered: "3", cursorAhead: false, malformed: 0 }))
      .toEqual({ ...NONE, dropped: 0, budgetExhausted: false, truncated: false, buffered: null, cursorAhead: false, malformed: 0 });
  });
  it("cursorAhead 单独缺失/畸形时只有它是 null，其余字段不受影响（评审发现）", () => {
    expect(bufferStatus({ ...NONE, dropped: 0, budgetExhausted: false, truncated: false, buffered: 0, cursorAhead: 1, malformed: 0 }))
      .toEqual({ ...NONE, dropped: 0, budgetExhausted: false, truncated: false, buffered: 0, cursorAhead: null, malformed: 0 });
  });
  /**
   * **`malformed` 是本任务加的，它恒为 0 —— 而这一格正是为了让"恒为 0"这句话
   * 有代价**：`0` 与 `null` 必须分得开。`0` 是「后端说了：一条都没丢」，
   * `null` 是「读不出来」。混在一起，一个真的丢了条目的部署与一个字段没发过来的
   * 部署就长得一模一样。
   */
  it("malformed 单独缺失/畸形时只有它是 null；真实的 0 与 null 不许混为一谈", () => {
    expect(bufferStatus({ ...NONE, dropped: 0, budgetExhausted: false, truncated: false, buffered: 0, cursorAhead: false, malformed: "2" }))
      .toEqual({ ...NONE, dropped: 0, budgetExhausted: false, truncated: false, buffered: 0, cursorAhead: false, malformed: null });
    expect(bufferStatus({ malformed: 0 }).malformed, "真实的 0 不许被当成「读不出来」").toBe(0);
    expect(bufferStatus({}).malformed, "字段缺席就是 null，不许兜底成 0").toBeNull();
  });
});

/**
 * **硬要求第 5 条**：诚实标记必须由后端字段驱动，且要有一条"字段为 false ⇒
 * 标记消失"的用例——不是形状断言，是行为断言。
 */
describe("shouldWarn：黄条是否出现，完全由后端字段驱动", () => {
  const allClear = {
    dropped: 0, budgetExhausted: false, truncated: false, buffered: 0,
    cursorAhead: false, malformed: 0, cursorBroken: false,
  };

  it("dropped=0 且 budgetExhausted=false 且 truncated=false 且 cursorAhead=false ⇒ 不警告（字段全为 false，标记消失）", () => {
    expect(shouldWarn(allClear)).toBe(false);
  });
  it("dropped>0 ⇒ 警告", () => {
    expect(shouldWarn({ ...allClear, dropped: 1 })).toBe(true);
  });
  it("budgetExhausted=true ⇒ 警告（即使其余项都是 false）", () => {
    expect(shouldWarn({ ...allClear, budgetExhausted: true })).toBe(true);
  });
  it("truncated=true ⇒ 警告（评审发现，即使其余项都是 false）", () => {
    expect(shouldWarn({ ...allClear, truncated: true })).toBe(true);
  });
  it("cursorAhead=true ⇒ 警告（评审发现，即使其余项都是 false）", () => {
    expect(shouldWarn({ ...allClear, cursorAhead: true })).toBe(true);
  });
  it("buffered 单独很大 ⇒ 不警告——单纯缓冲区里有事件是正常运行态，不占用黄条（评审发现的取舍）", () => {
    expect(shouldWarn({ ...allClear, buffered: 999 })).toBe(false);
  });
  it("全部是 null（没有数据）⇒ 不警告——不知道不等于有问题", () => {
    expect(shouldWarn({
      dropped: null, budgetExhausted: null, truncated: null, buffered: null,
      cursorAhead: null, malformed: null, cursorBroken: null,
    })).toBe(false);
  });

  /**
   * **`cursorBroken=true` ⇒ 黄条**（评审发现）。它比在座任何一条都更该在：
   * 意味着后端**此刻正在违约**，游标推不动、面板可能**永远看不到新事件**；
   * 而判据里那条 `cursorAhead` 反倒是会自愈的时钟纠纷。
   * 第一版只把它接进 tooltip —— 等于把「面板在撒谎」降级成「面板在小声说」。
   */
  it("cursorBroken=true ⇒ 警告（评审发现，即使其余项都是 false）", () => {
    expect(shouldWarn({ ...allClear, cursorBroken: true })).toBe(true);
  });

  it("malformed 单独很大 ⇒ 不警告 —— 它恒为 0，挂上黄条只会多一条永远为假的分支", () => {
    expect(shouldWarn({ ...allClear, malformed: 999 })).toBe(false);
  });
});

describe("nextAfter：轮询游标推进", () => {
  it("cursor 是数字时推进到该值", () => {
    expect(nextAfter(1000, 2000)).toBe(2000);
  });
  it("cursor 为 null（本页没有新事件）时保留当前值，不回退成 null", () => {
    expect(nextAfter(1000, null)).toBe(1000);
  });
  it("cursor 非法（非数字）时同样保留当前值", () => {
    expect(nextAfter(1000, "oops")).toBe(1000);
    expect(nextAfter(1000, Number.NaN)).toBe(1000);
  });
});

/**
 * **本任务的核心前端断言：三种输入，三种语义，不许合并成两种。**
 *
 * 防住的真实故障（实测）：存储里一条畸形事件让后端的 `cursor` 变成
 * `undefined` ⇒ `c.json` 把该字段整个丢掉 ⇒ 前端读到"字段不存在"。原来这一支
 * 与「`cursor: null` = 本页没有新事件」**合并**，于是「后端在吐畸形数据」被显示成
 * 「一切正常」——面板在撒谎，而且撒的正是让人查不下去的那种。
 */
describe("cursorOutcome：把「没有新事件」与「后端契约被破坏」分开", () => {
  it("有限数字 ⇒ 推进，broken 为假", () => {
    expect(cursorOutcome(1000, 2000)).toEqual({ after: 2000, broken: false });
    expect(cursorOutcome(null, 0), "真实的 0 是合法游标，不许当成缺失").toEqual({ after: 0, broken: false });
  });
  it("恰好是 null ⇒ 保留当前值，broken 为假（这是「本页没有新事件」）", () => {
    expect(cursorOutcome(1000, null)).toEqual({ after: 1000, broken: false });
  });
  /**
   * **`undefined` 与 `null` 必须分到两支**——这一格是整条设计的要害：
   * `c.json` 对 `undefined` 的处理是**把字段整个丢掉**，所以前端拿到的正是
   * `undefined`；把它并进 `null` 那一支，缺陷就再也说不出口了。
   */
  it("缺字段 / undefined / NaN / 字符串 / 对象 ⇒ 保留当前值，但 broken 为真", () => {
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, "2000", {}, [], true]) {
      expect(cursorOutcome(1000, bad), JSON.stringify(bad) ?? "undefined")
        .toEqual({ after: 1000, broken: true });
    }
  });
  it("broken 时保留的是「当前值」而不是某个兜底常量（current 是 null 就保留 null）", () => {
    expect(cursorOutcome(null, undefined)).toEqual({ after: null, broken: true });
  });
});

/**
 * **评审二审**：轮询结果的完整决策（after 自愈 + view 清空 + hadNewItems
 * 信号），原来摊在 `sec-events.js` 里裸写、零测试覆盖，两个联带 bug（视图重复、
 * 退避永远回不到最长间隔）都是从这个洞里漏出来的——见 `pure/events.mjs` 的说明。
 */
describe("pollOutcome：轮询结果的完整决策（after 自愈 + view 清空 + hadNewItems + healing）", () => {
  /** 一个"正常轮询中"的上一轮状态。三个字段都手写，不从被测对象取。 */
  const idle = { after: 1000, healing: false, delayMs: 15_000 };

  it("正常情况（cursorAhead 非 true）：after 走 nextAfter 原样推进，不清视图", () => {
    expect(pollOutcome(idle, [{ ts: 2000 }], 2000, false)).toEqual({
      resetView: false, hadNewItems: true, cursorBroken: false,
      next: { after: 2000, healing: false, delayMs: 15_000 },
    });
  });
  it("正常情况下 items 为空 ⇒ hadNewItems 为 false，after 保留原值（cursor 为 null），退避翻倍", () => {
    expect(pollOutcome(idle, [], null, false)).toEqual({
      resetView: false, hadNewItems: false, cursorBroken: false,
      next: { after: 1000, healing: false, delayMs: 30_000 },
    });
  });
  it("cursorAhead 缺失（null/undefined）时按非自愈处理，不是自愈的默认值", () => {
    expect(pollOutcome(idle, [], null, null).next.after).toBe(1000);
    expect(pollOutcome(idle, [], null, null).resetView).toBe(false);
    expect(pollOutcome(idle, [], null, undefined).next.after).toBe(1000);
    expect(pollOutcome(idle, [], null, undefined).resetView).toBe(false);
  });
  it("cursorAhead 为 true：无条件把 after 清成 null，不管 cursor 算出来是什么", () => {
    // 故意给一个"看起来正常"的 cursor（9999），自愈应当无视它，直接清成 null。
    expect(pollOutcome(idle, [], 9999, true)).toEqual({
      resetView: true, hadNewItems: false, cursorBroken: false,
      next: { after: null, healing: true, delayMs: 30_000 },
    });
  });
  it("cursorAhead 为 true 时 resetView 恒为 true——这是评审二审(b) 点名的那条视图重复 bug 的直接防线", () => {
    expect(pollOutcome({ after: 5000, healing: false, delayMs: 15_000 }, [], null, true).resetView).toBe(true);
  });
  it("hadNewItems 只看 items.length，不看 after 有没有变——这是评审二审(a) 点名的那条退避 bug 的直接防线", () => {
    // after 从 1000 自愈成 null（明显"变了"），但 items 是空的：hadNewItems 必须是 false，
    // 不能因为"游标变了"就误判成"来了新内容"。
    expect(pollOutcome(idle, [], null, true).hadNewItems).toBe(false);
  });
  it("items 不是数组（畸形响应）时 hadNewItems 安全地为 false，不抛错", () => {
    expect(pollOutcome(idle, null, null, false).hadNewItems).toBe(false);
    expect(pollOutcome(idle, undefined, null, false).hadNewItems).toBe(false);
  });
  it("上一轮状态畸形/缺失时按初始状态处理，不抛错也不产出 NaN 间隔", () => {
    expect(pollOutcome(undefined, [], null, false).next).toEqual({
      after: null, healing: false, delayMs: 30_000,
    });
    expect(pollOutcome({ after: "oops", healing: 1, delayMs: "x" }, [], null, false).next).toEqual({
      after: null, healing: false, delayMs: 30_000,
    });
  });

  /**
   * **后端吐畸形游标时：`cursorBroken` 为真，且退避不许被顶回 15 秒。**
   *
   * 这两件事是同一条链的两端，必须写在同一格里（第 5 种假阳性：分开写的话，
   * 各自单独覆盖的状态下两种实现数学上等价）。喂进去的是一份**有 items、
   * 但缺 `cursor` 字段**的响应——那正是那条畸形条目实测出的真实响应体形状。
   */
  it("后端吐畸形游标（缺 cursor 字段）：cursorBroken 为真，且退避不回 15 秒", () => {
    const out = pollOutcome({ after: null, healing: false, delayMs: 15_000 }, [{ ts: 1 }], undefined, false);
    expect(out.cursorBroken, "缺字段必须被说出去，不能显示成「一切正常」").toBe(true);
    expect(out.hadNewItems, "畸形游标下这批 items 每轮都是同一批，不算「新内容」").toBe(false);
    expect(out.next.delayMs, "退避必须继续翻倍，不许被顶回最短间隔").toBe(30_000);
    expect(out.next.after, "游标保留当前值（这里是 null）").toBeNull();
  });

  it("反向：游标合法且真的有新条目时，退避照常回到 15 秒（判据不许一律说 broken）", () => {
    const out = pollOutcome({ after: 1000, healing: false, delayMs: 60_000 }, [{ ts: 2000 }], 2000, false);
    expect(out.cursorBroken).toBe(false);
    expect(out.hadNewItems).toBe(true);
    expect(out.next.delayMs).toBe(15_000);
  });

  /**
   * **稳态吞吐那条 Critical，做成一条会变红的用例。**
   *
   * 量法与当时的临时探针同形（直接驱动发货的 `pollOutcome`，不抄一份循环——
   * 第 7 种假阳性），只是把结论钉住：畸形游标下 `after` 恒为 `null` ⇒ 每一轮都是
   * **满额冷读**。冷读的候选键数是 `EVENT_WINDOW_RETAIN × EVENT_SLOTS = 24 × 2`，
   * **手写字面量 48**，不从常量反算（第 6 种假阳性）。
   *
   * · 修复前（`broken` 并进「没有新事件」那一支）：`items` 非空 ⇒ `hadNewItems`
   *   恒为真 ⇒ 退避每轮被顶回 15 秒 ⇒ `(86400 ÷ 15) × 48 = 276,480` 次/天，
   *   是 DEPLOY.md 承诺的包线 **70,560** 的 **3.9 倍**。
   * · 修复后：退避正常爬到 60 秒封顶 ⇒ `(86400 ÷ 60) × 48 = 69,120` 次/天，**在包线内**。
   *
   * ⚠️ **这条只在默认的「全部级别」档位下成立**（按级别过滤那一轴）：点任一个级别按钮，
   * 畸形条目被后端 `e.level === level` 滤掉、游标立刻恢复。**不许写成「永不自愈」。**
   */
  it("畸形游标的稳态读吞吐落在 70,560 包线内（修复前是 276,480 = 3.9 倍）", () => {
    const GETS_PER_COLD_READ = 48;     // 24 个时间窗 × 2 个槽位，手写
    const ENVELOPE_PER_DAY = 70_560;   // 五语言 DEPLOY.md 承诺的包线，手写
    let state = { after: null, healing: false, delayMs: 15_000 };
    let gets = 0;
    let elapsedMs = 0;
    // 跑 12 轮，量后 6 轮（前几轮还在退避爬升，不是稳态）。
    for (let i = 0; i < 12; i++) {
      const out = pollOutcome(state, [{ ts: 1000 + i }], undefined, false);
      state = out.next;
      if (i >= 6) { gets += GETS_PER_COLD_READ; elapsedMs += state.delayMs; }
    }
    expect(state.delayMs, "量测窗口应当整段处在退避上限的稳态").toBe(60_000);
    const perDay = Math.round((gets / (elapsedMs / 1000)) * 86_400);
    expect(perDay, "畸形游标下的稳态读吞吐").toBe(69_120);
    expect(perDay).toBeLessThan(ENVELOPE_PER_DAY);
  });

  /**
   * **评审三审(a) + 四审**：`healing` 是"上一次自愈之后、还没有重新建立起
   * 游标"的那一整段（不是"刚好上一轮"）。这段里即使真的拉到了 items，也不算
   * "来了新内容"——那批 items 正是自愈时 resetView 刚扔掉的同一批。
   *
   * 三审(a) 的"只遮一轮"版本在 k≥3（负载均衡每 3 轮以上才命中一次领先 isolate）
   * 时一次都不起作用：冷读状态会持续很多轮，第 2 轮之后 `justHealed` 就已经清了，
   * 再命中领先 isolate 时退避照样塌回 15 秒。逐 k 的稳态吞吐实测见
   * `tests/contract/events-cursor-heal.test.ts`。
   */
  describe("healing：自愈之后直到重新建立起游标为止，都不把冷读结果误判成新内容", () => {
    const healing = { after: null, healing: true, delayMs: 60_000 };

    it("healing=true 且这一轮真的拉到了 items：hadNewItems 仍然是 false（不是 true）", () => {
      const outcome = pollOutcome(healing, [{ ts: 2000 }, { ts: 1000 }], 2000, false);
      expect(outcome.hadNewItems, "自愈之后拉回来的第一批不算新内容").toBe(false);
      // 但 after 依然要正常推进——只压制 hadNewItems 这一个信号，不影响游标。
      expect(outcome.next.after).toBe(2000);
      expect(outcome.resetView).toBe(false);
    });
    it("healing=false 时行为不变，items 有内容就正常算新内容、退避回到最短", () => {
      const outcome = pollOutcome({ after: null, healing: false, delayMs: 60_000 }, [{ ts: 2000 }], 2000, false);
      expect(outcome.hadNewItems).toBe(true);
      expect(outcome.next.delayMs).toBe(15_000);
    });
    it("healing=true 但 items 本来就是空的：hadNewItems 仍然是 false（结果不变，不是从别的值被压成 false）", () => {
      expect(pollOutcome(healing, [], null, false).hadNewItems).toBe(false);
    });
    it("healing 不影响这一轮自己的 resetView——这一轮又撞上 cursorAhead 时照样清视图", () => {
      expect(pollOutcome(healing, [], null, true).resetView).toBe(true);
    });

    /**
     * **评审四审的核心三条**：置位 / 保持 / 清位，各钉一条。"保持"那条是
     * 三审(a) 版本唯一缺的东西——它只有置位与"下一轮自动清位"。
     */
    it("置位：自愈那一轮把 healing 置成 true", () => {
      expect(pollOutcome(idle, [], null, true).next.healing).toBe(true);
    });
    it("保持：自愈之后连续多轮冷读（cursor 恒为 null）时 healing 一直是 true，不是只遮一轮", () => {
      let s: { after: number | null; healing: boolean; delayMs: number } = idle;
      s = pollOutcome(s, [], null, true).next; // 自愈
      expect(s.healing, "自愈后立刻置位").toBe(true);
      for (let i = 0; i < 5; i++) {
        const o = pollOutcome(s, [], null, false); // 冷读，落后的 isolate 看不见未来窗口
        expect(o.hadNewItems).toBe(false);
        s = o.next;
        expect(s.after, "冷读拿不到游标，after 停在 null").toBe(null);
        expect(s.healing, `第 ${i + 1} 轮冷读之后 healing 必须仍然是 true`).toBe(true);
      }
      // 这一轮才终于命中领先 isolate，拉回旧事件：仍然不算新内容，但游标重新建立，
      // healing 随之清位。
      const back = pollOutcome(s, [{ ts: 7777 }], 7777, false);
      expect(back.hadNewItems, "自愈之后拉回来的第一批仍然不算新内容").toBe(false);
      expect(back.next.healing, "游标重新建立 ⇒ 清位").toBe(false);
      expect(back.next.after).toBe(7777);
      // 再下一轮才是真正的新内容，退避这时才该回到最短。
      const fresh = pollOutcome(back.next, [{ ts: 8888 }], 8888, false);
      expect(fresh.hadNewItems).toBe(true);
      expect(fresh.next.delayMs).toBe(15_000);
    });
    it("清位判据是『游标重新建立』而不是『这一轮有 items』——after 非 null 就清位", () => {
      // 上一轮不是自愈（after 还留着 1000），这一轮 cursor 为 null：after 保持 1000
      // ⇒ 非 null ⇒ healing 清位。这条区分的是"after 恰好非 null"与"这一轮有内容"。
      expect(pollOutcome({ after: 1000, healing: true, delayMs: 60_000 }, [], null, false).next.healing).toBe(false);
    });
  });
});

describe("initialPollState / resumePollState：跨轮状态的两种重置（评审四审）", () => {
  it("initialPollState：游标、自愈、退避全部归零——切换级别相当于换了一条流", () => {
    expect(initialPollState()).toEqual({ after: null, healing: false, delayMs: 15_000 });
  });
  it("resumePollState：保留游标，但把退避与自愈状态归零", () => {
    expect(resumePollState({ after: 4321, healing: true, delayMs: 60_000 }))
      .toEqual({ after: 4321, healing: false, delayMs: 15_000 });
  });
  it("resumePollState 对畸形/缺失入参安全（游标归 null，不是 undefined 或 NaN）", () => {
    expect(resumePollState(undefined)).toEqual({ after: null, healing: false, delayMs: 15_000 });
    expect(resumePollState({ after: "oops" })).toEqual({ after: null, healing: false, delayMs: 15_000 });
    expect(resumePollState({ after: Number.NaN })).toEqual({ after: null, healing: false, delayMs: 15_000 });
  });
});

describe("nextPollDelayMs：指数退避", () => {
  it("有新内容 ⇒ 立刻回到最短间隔", () => {
    expect(nextPollDelayMs(60_000, true)).toBe(EVENTS_POLL_MIN_MS);
  });
  it("没有新内容 ⇒ 翻倍", () => {
    expect(nextPollDelayMs(15_000, false)).toBe(30_000);
    expect(nextPollDelayMs(30_000, false)).toBe(60_000);
  });
  it("翻倍后封顶在 EVENTS_POLL_MAX_MS，不会继续涨", () => {
    expect(nextPollDelayMs(60_000, false)).toBe(EVENTS_POLL_MAX_MS);
    expect(nextPollDelayMs(45_000, false)).toBe(EVENTS_POLL_MAX_MS);
  });
});

describe("pollIndicatorState：三态", () => {
  it("暂停优先于出错", () => {
    expect(pollIndicatorState({ paused: true, lastError: true })).toBe("paused");
  });
  it("未暂停但有错误 ⇒ error", () => {
    expect(pollIndicatorState({ paused: false, lastError: true })).toBe("error");
  });
  it("都没有 ⇒ active", () => {
    expect(pollIndicatorState({ paused: false, lastError: false })).toBe("active");
  });
});

describe("pollIndicatorLabelKey：三态各自映射到字典里存在的 key", () => {
  it("三态各自不同，且都在字典里", () => {
    const keys = new Set(["active", "paused", "error"].map(pollIndicatorLabelKey));
    expect(keys.size).toBe(3);
    for (const k of keys) expect(I18N[k], k).toBeDefined();
  });
  it("不认识的状态兜底成 active", () => {
    expect(pollIndicatorLabelKey("not-a-state")).toBe(pollIndicatorLabelKey("active"));
  });
});

describe("matchesSearch", () => {
  const item = { ts: 1, level: "warn", event: "admin.login_failed", fields: { ip: "203.0.113.7", path: "/x" } };
  it("空串一律匹配（不筛）", () => {
    expect(matchesSearch(item, "")).toBe(true);
    expect(matchesSearch(item, "   ")).toBe(true);
  });
  it("匹配 event 名（不区分大小写）", () => {
    expect(matchesSearch(item, "LOGIN_FAILED")).toBe(true);
  });
  it("匹配 fields 里的值", () => {
    expect(matchesSearch(item, "203.0.113.7")).toBe(true);
  });
  it("不匹配就是不匹配", () => {
    expect(matchesSearch(item, "nothing-like-this")).toBe(false);
  });
  it("匹配 msg", () => {
    expect(matchesSearch({ ...item, msg: "管理接口凭据无效" }, "凭据无效")).toBe(true);
  });
  it("匹配 corr", () => {
    expect(matchesSearch({ ...item, corr: "req-abc123" }, "req-abc")).toBe(true);
  });
  it("item 本身畸形时不匹配（不抛）", () => {
    expect(matchesSearch(null, "x")).toBe(false);
    expect(matchesSearch(undefined, "x")).toBe(false);
  });
});

describe("formatFields", () => {
  it("没有 fields 时是空串", () => {
    expect(formatFields(undefined)).toBe("");
    expect(formatFields(null)).toBe("");
  });
  it("逐个 key=value 拼接", () => {
    expect(formatFields({ ip: "203.0.113.7", hasHeader: true })).toBe("ip=203.0.113.7 hasHeader=true");
  });
  it("null 值渲染成字面量 null，不是空串（区分「没给」与「给了个 null」）", () => {
    expect(formatFields({ reason: null })).toBe("reason=null");
  });
});

/**
 * **评审发现**：这个函数原来是 `sec-events.js` 里的纯取值逻辑，零测试覆盖，
 * 搬进 pure 之后由这里的用例跑到。
 */
describe("buildDetailText：说明 / 字段列的文本拼装", () => {
  it("只有 msg 时就是 msg", () => {
    expect(buildDetailText({ msg: "管理接口凭据无效" })).toBe("管理接口凭据无效");
  });
  it("只有 fields 时就是格式化后的 fields", () => {
    expect(buildDetailText({ fields: { ip: "203.0.113.7" } })).toBe("ip=203.0.113.7");
  });
  it("两者都有时用 · 连接", () => {
    expect(buildDetailText({ msg: "管理接口凭据无效", fields: { hasHeader: false } }))
      .toBe("管理接口凭据无效 · hasHeader=false");
  });
  it("两者都没有时是空串，不留多余的分隔符", () => {
    expect(buildDetailText({})).toBe("");
  });
  it("畸形输入不抛", () => {
    expect(buildDetailText(null)).toBe("");
    expect(buildDetailText(undefined)).toBe("");
  });
});

describe("groupEvents：按 corr 相邻折叠成时间线", () => {
  /**
   * **人工冒烟项**：本期几乎没有事件带 corr（后来才串进注册机），
   * 所以分组必须在「一个都没有」时也表现正常——不崩、不把互不相关的事件粘在一起。
   */
  it("全部无 corr 时：每条各自独立成组（人工冒烟：零 corr 场景）", () => {
    const items = [
      { ts: 3, level: "info", event: "a" },
      { ts: 2, level: "info", event: "b" },
      { ts: 1, level: "info", event: "c" },
    ];
    const groups = groupEvents(items);
    expect(groups.length).toBe(3);
    for (const g of groups) {
      expect(g.corr).toBeNull();
      expect(g.items.length).toBe(1);
    }
  });

  /**
   * **人工冒烟项**：手工构造带 corr 的批次（生产今天还打不出这种数据，后来才有），
   * 验证相邻折叠的核心逻辑本身是对的。
   */
  it("相邻的同 corr 事件折叠成一条时间线", () => {
    const items = [
      { ts: 5, level: "info", event: "solo-before" },
      { ts: 4, level: "warn", event: "registrar.list_domains_failed", corr: "req-1" },
      { ts: 3, level: "warn", event: "registrar.code_timeout", corr: "req-1" },
      { ts: 2, level: "error", event: "registrar.delete_mailbox_failed", corr: "req-1" },
      { ts: 1, level: "info", event: "solo-after" },
    ];
    const groups = groupEvents(items);
    expect(groups.length).toBe(3);
    expect(groups[0]).toEqual({ corr: null, items: [items[0]] });
    expect(groups[1]!.corr).toBe("req-1");
    expect(groups[1]!.items.length).toBe(3);
    expect(groups[1]!.items.map((e) => e.event)).toEqual([
      "registrar.list_domains_failed", "registrar.code_timeout", "registrar.delete_mailbox_failed",
    ]);
    expect(groups[2]).toEqual({ corr: null, items: [items[4]] });
  });

  it("不相邻的同 corr 不合并（隔着别的事件更可能是巧合，不该被强行拼一起）", () => {
    const items = [
      { ts: 3, level: "info", event: "x", corr: "req-1" },
      { ts: 2, level: "info", event: "unrelated" },
      { ts: 1, level: "info", event: "y", corr: "req-1" },
    ];
    const groups = groupEvents(items);
    expect(groups.length).toBe(3);
    expect(groups[0]!.items.length).toBe(1);
    expect(groups[2]!.items.length).toBe(1);
  });

  it("空 corr 串按无 corr 处理", () => {
    const items = [{ ts: 1, level: "info", event: "e", corr: "" }];
    expect(groupEvents(items)).toEqual([{ corr: null, items }]);
  });

  it("畸形输入不抛，返回空数组", () => {
    expect(groupEvents(null)).toEqual([]);
    expect(groupEvents(undefined)).toEqual([]);
    expect(groupEvents("oops")).toEqual([]);
  });
});

describe("orderForDisplay：后端 ts 降序 → 面板正序（旧→新，配合自动滚动）", () => {
  it("反转顺序", () => {
    const items = [{ ts: 3 }, { ts: 2 }, { ts: 1 }];
    expect(orderForDisplay(items)).toEqual([{ ts: 1 }, { ts: 2 }, { ts: 3 }]);
  });
  it("不改动入参（返回新数组）", () => {
    const items = [{ ts: 2 }, { ts: 1 }];
    const snapshot = [...items];
    orderForDisplay(items);
    expect(items).toEqual(snapshot);
  });
  it("畸形输入不抛，返回空数组", () => {
    expect(orderForDisplay(null)).toEqual([]);
    expect(orderForDisplay(undefined)).toEqual([]);
  });
});

describe("mergeIntoView：新一批（更新）并入客户端已攒的视图，整体仍是 ts 降序", () => {
  it("新的拼在前面", () => {
    const existing = [{ ts: 100, event: "old" }];
    const incoming = [{ ts: 200, event: "new" }];
    expect(mergeIntoView(existing, incoming)).toEqual([{ ts: 200, event: "new" }, { ts: 100, event: "old" }]);
  });
  it("incoming 为空时原样返回 existing 的内容", () => {
    const existing = [{ ts: 100, event: "old" }];
    expect(mergeIntoView(existing, [])).toEqual(existing);
  });
  it("existing 为空（首次拉取）时就是 incoming", () => {
    const incoming = [{ ts: 200, event: "new" }];
    expect(mergeIntoView([], incoming)).toEqual(incoming);
  });
  it("畸形入参不抛", () => {
    expect(mergeIntoView(null, null)).toEqual([]);
    expect(mergeIntoView(undefined, undefined)).toEqual([]);
  });
});
