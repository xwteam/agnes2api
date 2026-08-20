import { describe, it, expect } from "vitest";
import {
  EVENTS_POLL_MIN_MS, EVENTS_POLL_MAX_MS, LEVELS,
  levelLabelKey, effectiveLevel, eventLevelLabelKey, levelBadgeClass,
  eventsQuery, itemsOf, eventsListMessageKey, shardIdOf, bufferStatus,
  shouldWarn, nextAfter, nextPollDelayMs, pollIndicatorState, pollIndicatorLabelKey, matchesSearch,
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
 * **评审 I4**：`effectiveLevel` 是"一条事件真实显示成哪个级别"的唯一判据——
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
 * **评审 M5**：判据必须是"视图里有没有数据"，不是"这一次有没有成功过"——后者
 * 会让重新进入本板块时，只要第一轮轮询恰好失败，就把已经攒下的历史事件整个
 * 换成"读取失败"。
 */
describe("eventsListMessageKey：列表区该显示哪条消息", () => {
  it("视图为空且读取失败 ⇒ loadFailed", () => {
    expect(eventsListMessageKey(true, 0, 0)).toBe("common.loadFailed");
  });
  it("视图有数据，即使这一轮读取失败，也不显示 loadFailed——继续显示已有数据（评审 M5 的核心断言）", () => {
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
});

describe("shardIdOf：本 isolate 的分片 id（评审 M2），绝不伪造", () => {
  it("缺失/畸形时是 null，不是空串", () => {
    for (const bad of [null, undefined, {}, { shardId: 1 }, { shardId: "" }, { shardId: null }]) {
      expect(shardIdOf(bad), String(bad)).toBeNull();
    }
  });
  it("有数据时透传", () => {
    expect(shardIdOf(body)).toBe("shard-1");
  });
});

describe("bufferStatus：dropped / budgetExhausted / truncated 绝不伪造", () => {
  it("缺失/畸形时逐项 null", () => {
    for (const bad of [null, undefined, {}, { dropped: "5" }, { budgetExhausted: "yes" }, { truncated: "yes" }]) {
      expect(bufferStatus(bad), String(bad)).toEqual({ dropped: null, budgetExhausted: null, truncated: null });
    }
  });
  it("有数据时逐项透传，含真实的 0/false", () => {
    expect(bufferStatus({ dropped: 0, budgetExhausted: false, truncated: false }))
      .toEqual({ dropped: 0, budgetExhausted: false, truncated: false });
    expect(bufferStatus({ dropped: 50, budgetExhausted: true, truncated: true }))
      .toEqual({ dropped: 50, budgetExhausted: true, truncated: true });
  });
});

/**
 * **硬要求第 5 条**：诚实标记必须由后端字段驱动，且要有一条"字段为 false ⇒
 * 标记消失"的用例——不是形状断言，是行为断言。
 */
describe("shouldWarn：黄条是否出现，完全由后端字段驱动", () => {
  it("dropped=0 且 budgetExhausted=false 且 truncated=false ⇒ 不警告（字段全为 false，标记消失）", () => {
    expect(shouldWarn({ dropped: 0, budgetExhausted: false, truncated: false })).toBe(false);
  });
  it("dropped>0 ⇒ 警告", () => {
    expect(shouldWarn({ dropped: 1, budgetExhausted: false, truncated: false })).toBe(true);
  });
  it("budgetExhausted=true ⇒ 警告（即使其余两项都是 false）", () => {
    expect(shouldWarn({ dropped: 0, budgetExhausted: true, truncated: false })).toBe(true);
  });
  it("truncated=true ⇒ 警告（评审 I3，即使其余两项都是 false）", () => {
    expect(shouldWarn({ dropped: 0, budgetExhausted: false, truncated: true })).toBe(true);
  });
  it("三项都是 null（没有数据）⇒ 不警告——不知道不等于有问题", () => {
    expect(shouldWarn({ dropped: null, budgetExhausted: null, truncated: null })).toBe(false);
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

/**
 * **评审 I4**：这个函数原来是 `sec-events.js` 里的纯取值逻辑，零测试覆盖，
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
