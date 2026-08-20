import { describe, it, expect } from "vitest";
import {
  isDeletable, isMustDisableFirstConflict, canClearCooldown, canUnevict, canClearStrikes,
  toggleDisableLabelKey, rowActionNeedsConfirm, bulkNeedsConfirm,
  selectAllIds, pruneSelection, headerSelectAllChecked, bulkBarVisible,
  bulkResultSummary, bulkResultKey, importLines, hasImportableContent,
  importResultCounts, noteToPatch, NOTE_MAX_LENGTH, isOpaqueErrorMessage,
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
  /**
   * ⚠️⚠️ **评审实测抓到的真缺陷，判据从 `bucket === "cooling"` 改成
   * `cooldownUntil > now`**：`bucket` 是优先级投影（`disabled > evicted >
   * cooling > fresh`），一把「已停用且仍在冷却期」的 key 的 `bucket` 是
   * `"disabled"`，不是 `"cooling"`——旧判据会让这把 key 的清冷却按钮永远禁用，
   * 即使后端的 `PATCH { clearCooldown: true }` 照样接受。这一格必须覆盖
   * 「`bucket !== "cooling"` 但 `cooldownUntil` 确实没到」这个反例，
   * 否则判据换回 `bucket` 这条变异会逃逸。
   */
  it("清冷却只在 cooldownUntil > now 时可用（不是 bucket === cooling）", () => {
    const now = 5000;
    expect(canClearCooldown({ ...view, cooldownUntil: now + 1 }, now)).toBe(true);
    expect(canClearCooldown({ ...view, cooldownUntil: now }, now)).toBe(false);
    expect(canClearCooldown({ ...view, cooldownUntil: 0 }, now)).toBe(false);
  });
  it("「已停用且仍在冷却」：bucket 是 disabled，但清冷却必须可用", () => {
    const now = 5000;
    const disabledButCooling = { ...view, bucket: "disabled", disabled: true, cooldownUntil: now + 60_000 };
    expect(
      canClearCooldown(disabledButCooling, now),
      "只看 bucket 的实现会在这一格判错——后端接受这次 PATCH，按钮却说不能",
    ).toBe(true);
  });
  it("非法输入：不可用，不抛异常", () => {
    expect(canClearCooldown(null, 5000)).toBe(false);
    expect(canClearCooldown({ ...view, cooldownUntil: 6000 }, undefined)).toBe(false);
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

/**
 * **评审必改③：这条判据原来直接写在 `sec-keys.js` 的 `deleteOne()` 里**，
 * 与文件头「取值决策一律不写在这里」的说法矛盾——搬过来之后那句话对这一条
 * 才是真的。它与批量路径的 `bulkResultSummary` 判的是同一件事的两种形状。
 */
describe("isMustDisableFirstConflict：单条 DELETE 的 409 拒绝判据", () => {
  it("409 + reason 匹配：是", () => {
    expect(isMustDisableFirstConflict(409, "must_disable_first")).toBe(true);
  });
  it("状态码对但 reason 不对：不是", () => {
    expect(isMustDisableFirstConflict(409, "other_reason")).toBe(false);
    expect(isMustDisableFirstConflict(409, undefined)).toBe(false);
  });
  it("reason 对但状态码不对：不是（同一个 reason 字符串不该跨状态码生效）", () => {
    expect(isMustDisableFirstConflict(400, "must_disable_first")).toBe(false);
    expect(isMustDisableFirstConflict(200, "must_disable_first")).toBe(false);
  });
});

describe("headerSelectAllChecked：表头全选框该不该打勾", () => {
  it("当前页非空、且每一个都在已选集合里：打勾", () => {
    expect(headerSelectAllChecked(["a", "b"], ["a", "b", "c"])).toBe(true);
  });
  it("当前页有一个不在已选集合里：不打勾", () => {
    expect(headerSelectAllChecked(["a", "b"], ["a"])).toBe(false);
  });
  /**
   * ⚠️ **空页恒不打勾，即使 `Array.prototype.every` 对空数组恒真**——
   * 这不是数学边界情形，是产品判据：没有任何一行时打勾等于对运维说"我选中了
   * 点什么"，而屏幕上什么都没有。
   */
  it("当前页是空的：不打勾（不是 every() 对空数组恒真那个陷阱）", () => {
    expect(headerSelectAllChecked([], [])).toBe(false);
    expect(headerSelectAllChecked([], ["a", "b"])).toBe(false);
  });
  it("非法输入：不打勾，不抛异常", () => {
    expect(headerSelectAllChecked(null, null)).toBe(false);
    expect(headerSelectAllChecked(undefined, undefined)).toBe(false);
  });
});

describe("bulkBarVisible：批量条「选中才出现」", () => {
  it("大于 0 才出现", () => {
    expect(bulkBarVisible(1)).toBe(true);
    expect(bulkBarVisible(20)).toBe(true);
  });
  it("等于 0 不出现", () => {
    expect(bulkBarVisible(0)).toBe(false);
  });
  it("非法输入：不出现，不抛异常", () => {
    expect(bulkBarVisible(null)).toBe(false);
    expect(bulkBarVisible(undefined)).toBe(false);
  });
});

/**
 * **评审必改③点名的第四处：这个数字原来是 `sec-keys.js` 里一个没有任何测试
 * 钉着的本地常量，改成 20 也不会有任何东西变红。** 边界值写字面量，理由与
 * `tests/contract/admin-keys-write.test.ts`「三个边界常量写字面量钉死」那格
 * 相同——`docs-parity` 只校验文档彼此一致，不校验文档与代码一致。
 */
describe("NOTE_MAX_LENGTH：与后端 MAX_NOTE_LENGTH 对齐的边界常量", () => {
  it("是 200，不是别的数字", () => {
    expect(NOTE_MAX_LENGTH).toBe(200);
  });
});

/**
 * **评审必改②的判别力全在这一组**：`errorMessage()` 曾经的注释宣称"绝不把裸的
 * http_500 这类内部码丢给运维"，而判据只看"是不是非空字符串"——三种内部码
 * 都是非空字符串，全部会原样进 toast。
 */
describe("isOpaqueErrorMessage：内部码不能原样丢给运维", () => {
  it("http_<状态码> 形态：是内部码", () => {
    expect(isOpaqueErrorMessage("http_500")).toBe(true);
    expect(isOpaqueErrorMessage("http_400")).toBe(true);
    expect(isOpaqueErrorMessage("http_0")).toBe(true);
  });
  it("会话相关的字面量码：是内部码", () => {
    expect(isOpaqueErrorMessage("unauthorized")).toBe(true);
    expect(isOpaqueErrorMessage("session_expired")).toBe(true);
  });
  it("空字符串 / 非字符串：是内部码（视为「没有可读信息」）", () => {
    expect(isOpaqueErrorMessage("")).toBe(true);
    expect(isOpaqueErrorMessage(null)).toBe(true);
    expect(isOpaqueErrorMessage(undefined)).toBe(true);
  });
  it("后端给的人话（哪怕是中文）：不是内部码——这条判据只挡内部码，不挡语言", () => {
    expect(isOpaqueErrorMessage("note 最长 200 个字符")).toBe(false);
    expect(isOpaqueErrorMessage("请先停用这把 key 再删除")).toBe(false);
  });
  it("形似但不是内部码的字符串：不许误伤", () => {
    expect(isOpaqueErrorMessage("http_ 后面没有数字")).toBe(false);
    expect(isOpaqueErrorMessage("httpx_500")).toBe(false);
  });
});
