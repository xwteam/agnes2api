import { describe, it, expect } from "vitest";
import {
  EVENTS_POLL_MIN_MS, EVENTS_POLL_MAX_MS, LEVELS,
  levelLabelKey, levelBadgeClass, eventsQuery, itemsOf, shardsCount, bufferStatus,
  shouldWarn, nextAfter, nextPollDelayMs, pollIndicatorState, pollIndicatorLabelKey, matchesSearch,
  formatFields, groupEvents, orderForDisplay, mergeIntoView,
} from "../../admin-ui/js/pure/events.mjs";
import { I18N } from "../../admin-ui/js/i18n-dict.js";

/** 一份"正常"的 /admin/api/events 响应，各条用例在它上面改一处。 */
const body = {
  items: [
    { ts: 3000, level: "warn", event: "admin.login_failed", fields: { ip: "203.0.113.7", hasHeader: true } },
    { ts: 2000, level: "info", event: "pool.key_added", msg: "已导入", fields: { id: "abc" } },
    { ts: 1000, level: "error", event: "registrar.mint_failed" },
  ],
  cursor: 3000, shards: 1, buffered: 0, dropped: 0, budgetExhausted: false, generatedAt: 4000,
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

describe("levelLabelKey / levelBadgeClass：每条级别在字典里都有对应键", () => {
  it("四个级别 + all 各自映射不同的 i18n key，且都在字典里", () => {
    const keys = new Set();
    for (const level of [...LEVELS, "all", "not-a-level"]) {
      const k = levelLabelKey(level);
      keys.add(k);
      expect(I18N[k], `${level} → ${k} 应当在字典里`).toBeDefined();
    }
    // "not-a-level" 与 "all" 应当落在同一个兜底键上（"不认识就当不筛"）。
    expect(levelLabelKey("not-a-level")).toBe(levelLabelKey("all"));
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

describe("shardsCount：绝不伪造 0", () => {
  it("缺失/畸形时是 null，不是 0", () => {
    for (const bad of [null, undefined, {}, { shards: "1" }, { shards: null }]) {
      expect(shardsCount(bad), String(bad)).toBeNull();
    }
  });
  it("真实的 0 照样是 0——没有数据与数出来是零必须分得开", () => {
    expect(shardsCount({ shards: 0 })).toBe(0);
  });
  it("有数据时透传", () => {
    expect(shardsCount(body)).toBe(1);
  });
});

describe("bufferStatus：dropped / budgetExhausted 绝不伪造", () => {
  it("缺失/畸形时逐项 null", () => {
    for (const bad of [null, undefined, {}, { dropped: "5" }, { budgetExhausted: "yes" }]) {
      expect(bufferStatus(bad), String(bad)).toEqual({ dropped: null, budgetExhausted: null });
    }
  });
  it("有数据时逐项透传，含真实的 0/false", () => {
    expect(bufferStatus({ dropped: 0, budgetExhausted: false })).toEqual({ dropped: 0, budgetExhausted: false });
    expect(bufferStatus({ dropped: 50, budgetExhausted: true })).toEqual({ dropped: 50, budgetExhausted: true });
  });
});

/**
 * **硬要求第 5 条**：诚实标记必须由后端字段驱动，且要有一条"字段为 false ⇒
 * 标记消失"的用例——不是形状断言，是行为断言。
 */
describe("shouldWarn：黄条是否出现，完全由后端字段驱动", () => {
  it("dropped=0 且 budgetExhausted=false ⇒ 不警告（字段为 false，标记消失）", () => {
    expect(shouldWarn({ dropped: 0, budgetExhausted: false })).toBe(false);
  });
  it("dropped>0 ⇒ 警告", () => {
    expect(shouldWarn({ dropped: 1, budgetExhausted: false })).toBe(true);
  });
  it("budgetExhausted=true ⇒ 警告（即使 dropped=0）", () => {
    expect(shouldWarn({ dropped: 0, budgetExhausted: true })).toBe(true);
  });
  it("两者都是 null（没有数据）⇒ 不警告——不知道不等于有问题", () => {
    expect(shouldWarn({ dropped: null, budgetExhausted: null })).toBe(false);
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

describe("groupEvents：按 corr 相邻折叠成时间线（P-1）", () => {
  /**
   * **人工冒烟项**：本期几乎没有事件带 corr（P3c 才串进注册机），
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
   * **人工冒烟项**：手工构造带 corr 的批次（生产今天还打不出这种数据，P3c 才有），
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
