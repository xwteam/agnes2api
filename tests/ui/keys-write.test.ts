import { describe, it, expect } from "vitest";
import {
  isDeletable, canClearCooldown, canUnevict, canClearStrikes, toggleDisableLabelKey,
  rowActionNeedsConfirm, bulkNeedsConfirm, selectAllIds, pruneSelection,
  bulkResultSummary, bulkResultKey, importLines, hasImportableContent,
  importResultCounts, noteToPatch,
} from "../../admin-ui/js/pure/keys-write.mjs";

/** 一份"正常"的 KeyView，各条用例在它上面改一处。 */
const view = {
  id: "abc123", masked: "sk-ab…wxyz", seq: 1, bucket: "fresh",
  addedAt: 1000, lastUsedAt: 2000, cooldownUntil: 0,
  cooldownReason: null, evictedReason: null, strikes: 0, disabled: false, evicted: false,
  note: null,
  stats: { requests: 0, success: 0, failed: 0, clientErrors: 0, lastErrorAt: null, lastErrorKind: null },
};

/**
 * **M1 的判别力全在这一组。**
 *
 * ⚠️ **变异点**：`isDeletable` 判据只看 `evicted`（即 `return view.evicted === true`）。
 * 夹具必须给 `{disabled:true,evicted:false}` 与 `{disabled:false,evicted:true}`
 * **两格**——两个都 true 的那一格谁赢都通过，那是本仓登记的第 1 种假阳性
 * （夹具 A/B 同值）。
 */
describe("isDeletable：与后端 keys-write.ts 的 deletable() 是同一条判据的前端半身", () => {
  it("两条都不成立：不能删", () => {
    expect(isDeletable({ ...view, disabled: false, evicted: false })).toBe(false);
  });
  it("只停用、没被剔除：能删（只看 evicted 的实现会在这里判错）", () => {
    expect(isDeletable({ ...view, disabled: true, evicted: false })).toBe(true);
  });
  it("只被剔除、没手动停用：能删（只看 disabled 的实现会在这里判错）", () => {
    expect(isDeletable({ ...view, disabled: false, evicted: true })).toBe(true);
  });
  it("两条都成立：能删", () => {
    expect(isDeletable({ ...view, disabled: true, evicted: true })).toBe(true);
  });
  it("空值：不能删，不抛异常", () => {
    expect(isDeletable(null)).toBe(false);
    expect(isDeletable(undefined)).toBe(false);
  });
});

describe("行内动作的可用性判据", () => {
  it("清冷却只在 bucket === cooling 时可用", () => {
    expect(canClearCooldown({ ...view, bucket: "cooling" })).toBe(true);
    expect(canClearCooldown({ ...view, bucket: "fresh" })).toBe(false);
    expect(canClearCooldown({ ...view, bucket: "evicted" })).toBe(false);
  });
  it("解除剔除只在 evicted === true 时可用", () => {
    expect(canUnevict({ ...view, evicted: true })).toBe(true);
    expect(canUnevict({ ...view, evicted: false })).toBe(false);
  });
  it("停用/启用按钮文案随当前状态切换", () => {
    expect(toggleDisableLabelKey({ ...view, disabled: false })).toBe("keys.action.disable");
    expect(toggleDisableLabelKey({ ...view, disabled: true })).toBe("keys.action.enable");
  });
});

/**
 * ⚠️ **控制端追加裁定**：`clearStrikes` 补进行内动作之后，`rowActionNeedsConfirm`
 * 从「只认不可撤销」扩成两条理由（见该函数的说明）——`delete` 与 `clearStrikes`
 * 各自成立的理由完全不同，这一组把两条都测到，不许只测其中一条就说"改对了"。
 */
describe("确认文案要不要出现：两条不同的理由（不可撤销 / 容易与相邻动作混淆）", () => {
  it("行内动作：delete（不可撤销）与 clearStrikes（易与清冷却混淆）都需要确认，其余不需要", () => {
    expect(rowActionNeedsConfirm("delete")).toBe(true);
    expect(rowActionNeedsConfirm("clearStrikes")).toBe(true);
    expect(rowActionNeedsConfirm("disable")).toBe(false);
    expect(rowActionNeedsConfirm("clearCooldown")).toBe(false);
    expect(rowActionNeedsConfirm("unevict")).toBe(false);
  });
  it("批量动作：三个动作里只有 delete 需要确认（bulk 没有 clearStrikes 这个动作）", () => {
    expect(bulkNeedsConfirm("delete")).toBe(true);
    expect(bulkNeedsConfirm("disable")).toBe(false);
    expect(bulkNeedsConfirm("clearCooldown")).toBe(false);
  });
});

describe("canClearStrikes：只在确实有连续失败计数时才有意义", () => {
  it("strikes > 0 时可用", () => {
    expect(canClearStrikes({ ...view, strikes: 1 })).toBe(true);
    expect(canClearStrikes({ ...view, strikes: 7 })).toBe(true);
  });
  it("strikes === 0 时不可用（点了也什么都不会变）", () => {
    expect(canClearStrikes({ ...view, strikes: 0 })).toBe(false);
  });
  it("非法输入：不可用，不抛异常", () => {
    expect(canClearStrikes(null)).toBe(false);
    expect(canClearStrikes({ ...view, strikes: "7" })).toBe(false);
  });
});

/**
 * **M2 的判别力全在这一组。**
 *
 * ⚠️ **变异点**：把「全选」改成选中全部筛选结果（例如凭空构造出超出 `items`
 * 长度的一批 id）。`selectAllIds` 的入参就是唯一的信任边界——它没有办法访问
 * `items` 之外的任何东西，所以这一组只需要证明「入参是什么，输出就是什么」，
 * 且**绝不比入参多**。
 */
describe("selectAllIds：全选只能选中调用方传入的那些 —— 也就是当前页", () => {
  it("返回值恰好是 items 里的 id，逐个不多不少", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(selectAllIds(items)).toEqual(["a", "b", "c"]);
  });
  it("一页 20 条时返回 20 个 id，不是 total/counts 里可能出现的更大数字", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `k${i}` }));
    const ids = selectAllIds(items);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size, "全选出现了 items 之外的 id").toBe(20);
  });
  it("非法输入：不是数组时返回空数组，不抛异常", () => {
    expect(selectAllIds(null)).toEqual([]);
    expect(selectAllIds(undefined)).toEqual([]);
    expect(selectAllIds("not-an-array")).toEqual([]);
  });
  it("items 里混着畸形条目：跳过它们，不让整体调用抛异常", () => {
    expect(selectAllIds([{ id: "a" }, null, { id: 42 }, { id: "b" }])).toEqual(["a", "b"]);
  });
});

describe("pruneSelection：换页 / 换筛选之后收窄选择", () => {
  it("丢掉不在当前页 items 里的 id，保留还在的", () => {
    const items = [{ id: "a" }, { id: "b" }];
    expect(pruneSelection(["a", "x", "b", "y"], items)).toEqual(["a", "b"]);
  });
  it("全部选中的 id 都消失了：结果是空数组", () => {
    expect(pruneSelection(["a", "b"], [{ id: "c" }])).toEqual([]);
  });
});

/**
 * **2(a) 的判别力全在这一组：`bulk` 端点 200 + 逐项 reason 的形状必须被前端认出来。**
 *
 * 夹具原样照抄简报里的场景：批量删除 20 把，其中 3 把因为 `must_disable_first`
 * 被拒——HTTP 层面这是一次彻头彻尾的 200 成功响应。
 */
describe("bulkResultSummary：状态码看不到的拒绝，从这里能看到", () => {
  it("批量删除 20 把、3 把因未停用被拒：failed 必须是 3，不是 0", () => {
    const results = [
      ...Array.from({ length: 17 }, (_, i) => ({ id: `ok${i}`, ok: true, reason: null })),
      { id: "bad0", ok: false, reason: "must_disable_first" },
      { id: "bad1", ok: false, reason: "must_disable_first" },
      { id: "bad2", ok: false, reason: "must_disable_first" },
    ];
    const s = bulkResultSummary(results);
    expect(s).toEqual({ total: 20, ok: 17, failed: 3, mustDisableFirst: 3, notFound: 0, otherFailed: 0 });
  });
  it("混合 not_found 与 must_disable_first：两个桶各自计数，互不覆盖", () => {
    const results = [
      { id: "a", ok: true, reason: null },
      { id: "b", ok: false, reason: "must_disable_first" },
      { id: "c", ok: false, reason: "not_found" },
    ];
    expect(bulkResultSummary(results)).toEqual({
      total: 3, ok: 1, failed: 2, mustDisableFirst: 1, notFound: 1, otherFailed: 0,
    });
  });
  it("全部成功：failed 是 0", () => {
    const results = [{ id: "a", ok: true, reason: null }, { id: "b", ok: true, reason: null }];
    expect(bulkResultSummary(results)).toEqual({
      total: 2, ok: 2, failed: 0, mustDisableFirst: 0, notFound: 0, otherFailed: 0,
    });
  });
  it("畸形响应（不是数组 / 元素不是对象）：不抛异常，退化成空", () => {
    expect(bulkResultSummary(null)).toEqual({ total: 0, ok: 0, failed: 0, mustDisableFirst: 0, notFound: 0, otherFailed: 0 });
    expect(bulkResultSummary([null, 42, "x"])).toEqual({ total: 3, ok: 0, failed: 0, mustDisableFirst: 0, notFound: 0, otherFailed: 0 });
  });

  it("bulkResultKey：只要 failed > 0 就必须选中「partial」，不是「allOk」", () => {
    expect(bulkResultKey({ failed: 3 })).toBe("keys.bulk.partial");
    expect(bulkResultKey({ failed: 0 })).toBe("keys.bulk.allOk");
  });
});

/**
 * **2(c) 的判别力全在这一组：导入框必须原样按行发，空行也发。**
 */
describe("importLines：原样按行拆，空行也发（口径定死在 src/core/keypool-repo.ts 的 addMany）", () => {
  it("中间的空行与末尾换行留下的空元素都要保留", () => {
    const text = "sk-a\n\nsk-b\n";
    // 拆出 4 个元素："sk-a" / "" / "sk-b" / ""（末尾换行留下的空字符串）——
    // 这正是 addMany() 用来对齐"位置=行号"口径的那份原始数组形状。
    expect(importLines(text)).toEqual(["sk-a", "", "sk-b", ""]);
  });
  it("Windows 换行（\\r\\n）与孤立 \\r 都按行拆", () => {
    expect(importLines("a\r\nb\rc")).toEqual(["a", "b", "c"]);
  });
  it("空字符串：返回空数组，不是 ['']（没有输入就是没有输入）", () => {
    expect(importLines("")).toEqual([]);
  });
  it("非字符串输入：返回空数组，不抛异常", () => {
    expect(importLines(null)).toEqual([]);
    expect(importLines(undefined)).toEqual([]);
  });

  it("hasImportableContent：全是空白行时判定为「没有内容」", () => {
    expect(hasImportableContent(["", "   ", ""])).toBe(false);
    expect(hasImportableContent(["", "sk-real-key", ""])).toBe(true);
    expect(hasImportableContent([])).toBe(false);
  });
});

/**
 * **2(d) 的判别力全在这一组：`reset` 必须来自响应字段，不是 `duplicated.length`。**
 *
 * 夹具刻意让两个数字不相等（`duplicated` 4 条、`reset` 只有 1），
 * 照抄 `tests/contract/admin-keys-write.test.ts` 那格「reset 计数只算本批之前
 * 就在池子里的那些，不是 duplicated 的条数」用的同一个反例形状。
 */
describe("importResultCounts：reset 必须原样取自响应字段", () => {
  it("duplicated=4、reset=1：两个数字不相等，取到的必须是 1 不是 4", () => {
    const body = { added: ["x"], duplicated: ["a", "b", "c", "d"], invalid: [], reset: 1 };
    const c = importResultCounts(body);
    expect(c.reset, "取成了 duplicated.length，这正是简报点名的那个撒谎方式").toBe(1);
    expect(c.duplicated).toBe(4);
  });
  it("invalid 是位置数组，原样透传（过滤掉非数字项，不改变顺序）", () => {
    const body = { added: [], duplicated: [], invalid: [2, 7, 9], reset: 0 };
    expect(importResultCounts(body).invalidLines).toEqual([2, 7, 9]);
  });
  it("响应体畸形（字段缺失/类型不对）：全部计数退化成 0/空数组，不抛异常", () => {
    expect(importResultCounts({})).toEqual({ added: 0, duplicated: 0, invalidLines: [], reset: 0 });
    expect(importResultCounts(null)).toEqual({ added: 0, duplicated: 0, invalidLines: [], reset: 0 });
    expect(importResultCounts({ reset: "not-a-number" }).reset).toBe(0);
  });
});

describe("noteToPatch：清空输入框等于清空备注（null），不是空字符串", () => {
  it("空字符串 ⇒ null", () => {
    expect(noteToPatch("")).toBeNull();
  });
  it("有内容 ⇒ 原样返回，不 trim（后端本来就不 trim note）", () => {
    expect(noteToPatch("  换了下游客户  ")).toBe("  换了下游客户  ");
  });
  it("非字符串 ⇒ null，不抛异常", () => {
    expect(noteToPatch(null)).toBeNull();
    expect(noteToPatch(undefined)).toBeNull();
  });
});
