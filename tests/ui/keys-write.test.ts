import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  isDeletable, isMustDisableFirstConflict, canClearCooldown, canUnevict, canClearStrikes,
  toggleDisableLabelKey, rowActionNeedsConfirm, bulkNeedsConfirm,
  selectAllIds, pruneSelection, headerSelectAllChecked, bulkBarVisible,
  toggleSelection, applySelectAll, knobsLoaded, hasNote,
  bulkResultSummary, bulkResultKey, bulkResultPresentation, importLines, hasImportableContent,
  importResultCounts, importResultPresentation, noteToPatch, NOTE_MAX_LENGTH, isOpaqueErrorMessage,
  verifyDisabledReason, verifyDisabledTitleKey, verifyResultCode, verifyTransportCode,
  verifyResultLabelKey, VERIFY_MIN_INTERVAL_MS,
  ADMIN_ERROR_TEXT_KEY, adminErrorFields, adminErrorText,
} from "../../admin-ui/js/pure/keys-write.mjs";
import { ADMIN_ERROR_CODES, ADMIN_ERROR_PARAMS } from "../../src/core/admin/admin-errors.js";
import { refuseReasonKey } from "../../admin-ui/js/pure/registrar.mjs";
import { I18N } from "../../admin-ui/js/i18n-dict.js";
import { PROBE_MIN_INTERVAL_MS } from "../../src/http/admin/probe-guard.js";
import { stripComments } from "../helpers/strip-comments.js";

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

/**
 * **评审第二轮点名的六处例外（除已有测试的批量 toast 组装外），逐一补测试。**
 * 这批判据原来直接写在 `sec-keys.js` 的事件处理器 / 渲染函数里，评审点名之后
 * 搬进了本模块，这里是它们第一次被单独测试的地方。
 */
describe("toggleSelection：单行勾选的去重加入 / 过滤移除", () => {
  it("勾选：加入选中集合", () => {
    expect(toggleSelection(["a"], "b", true)).toEqual(["a", "b"]);
  });
  it("勾选一个已经在集合里的 id：不重复加入", () => {
    expect(toggleSelection(["a", "b"], "a", true)).toEqual(["a", "b"]);
  });
  it("取消勾选：从集合里移除", () => {
    expect(toggleSelection(["a", "b"], "a", false)).toEqual(["b"]);
  });
  it("取消勾选一个不在集合里的 id：不报错，集合不变", () => {
    expect(toggleSelection(["a"], "z", false)).toEqual(["a"]);
  });
  it("非法输入：当成空集合处理，不抛异常", () => {
    expect(toggleSelection(null, "a", true)).toEqual(["a"]);
    expect(toggleSelection(undefined, "a", false)).toEqual([]);
  });
});

describe("applySelectAll：全选 / 取消全选的并集 / 差集", () => {
  it("全选：当前页 id 并入选中集合，跨页已选的不受影响", () => {
    expect(applySelectAll(["x"], ["a", "b"], true)).toEqual(["x", "a", "b"]);
  });
  it("全选去重：已经选中的当前页 id 不重复出现", () => {
    expect(applySelectAll(["a"], ["a", "b"], true)).toEqual(["a", "b"]);
  });
  it("取消全选：只删当前页的 id，不影响跨页已选的", () => {
    expect(
      applySelectAll(["x", "a", "b"], ["a", "b"], false),
      "取消全选清掉了不该管的、别的页面选中的 id",
    ).toEqual(["x"]);
  });
  it("非法输入：当成空集合处理，不抛异常", () => {
    expect(applySelectAll(null, ["a"], true)).toEqual(["a"]);
    expect(applySelectAll(["a"], null, false)).toEqual(["a"]);
  });
});

describe("hasNote：备注格显示内容还是显示 —", () => {
  it("非空字符串：有内容", () => {
    expect(hasNote({ ...view, note: "换了下游客户" })).toBe(true);
  });
  it("空字符串：没有内容（不是「有内容但是空的」）", () => {
    expect(hasNote({ ...view, note: "" })).toBe(false);
  });
  it("null：没有内容", () => {
    expect(hasNote({ ...view, note: null })).toBe(false);
  });
  it("非法输入：没有内容，不抛异常", () => {
    expect(hasNote(null)).toBe(false);
    expect(hasNote({ ...view, note: 42 })).toBe(false);
  });
});

describe("knobsLoaded：三个旋钮是不是已经拿到过一次生效值", () => {
  it("三个都是 null：还没拿到", () => {
    expect(knobsLoaded({ ttl: null, touch: null, edge: null })).toBe(false);
  });
  it("任意一个非 null：算拿到过——三个字段来自同一次响应的同一个块", () => {
    expect(knobsLoaded({ ttl: 60_000, touch: null, edge: null })).toBe(true);
    expect(knobsLoaded({ ttl: null, touch: 21_600_000, edge: null })).toBe(true);
    expect(knobsLoaded({ ttl: null, touch: null, edge: 60_000 })).toBe(true);
  });
  it("非法输入：还没拿到，不抛异常", () => {
    expect(knobsLoaded(null)).toBe(false);
    expect(knobsLoaded(undefined)).toBe(false);
  });
});

/**
 * ⚠️⚠️ **这是「批量里有 3 把被拒」那条交接在"完整投影"层面的钉子**：
 * `bulkResultPresentation()` 一次性给出拼哪些 key、`kind`、`sticky`，
 * 三者曾经在 `sec-keys.js` 里分别判断，这里把它们锁在同一个来源上。
 */
describe("bulkResultPresentation：批量结果 toast 该拼哪些 key、kind、sticky", () => {
  it("全部成功：headline 是 allOk，只有一个固定的计数后缀，kind 是 ok，不 sticky", () => {
    const p = bulkResultPresentation({ total: 2, ok: 2, failed: 0, mustDisableFirst: 0, notFound: 0, otherFailed: 0 });
    expect(p).toEqual({ messageKeys: ["keys.bulk.allOk", "keys.bulk.countsSuffix"], kind: "ok", sticky: false });
  });
  it("部分失败（must_disable_first）：headline 是 partial，多拼一段后缀，kind 是 warn，sticky", () => {
    const p = bulkResultPresentation({ total: 20, ok: 17, failed: 3, mustDisableFirst: 3, notFound: 0, otherFailed: 0 });
    expect(p).toEqual({
      messageKeys: ["keys.bulk.partial", "keys.bulk.countsSuffix", "keys.bulk.mustDisableFirstSuffix"],
      kind: "warn", sticky: true,
    });
  });
  it("两种失败原因都有：两段后缀都拼上，且顺序是 mustDisableFirst 在前", () => {
    const p = bulkResultPresentation({ total: 5, ok: 1, failed: 4, mustDisableFirst: 2, notFound: 2, otherFailed: 0 });
    expect(p.messageKeys).toEqual([
      "keys.bulk.partial", "keys.bulk.countsSuffix",
      "keys.bulk.mustDisableFirstSuffix", "keys.bulk.notFoundSuffix",
    ]);
  });
  it("非法输入：退化成「全部成功」的形状，不抛异常", () => {
    expect(bulkResultPresentation(null)).toEqual({
      messageKeys: ["keys.bulk.allOk", "keys.bulk.countsSuffix"], kind: "ok", sticky: false,
    });
  });
});

describe("importResultPresentation：导入结果 toast 的插值参数 + 要不要拼不合法的行 + kind", () => {
  it("没有不合法的行：kind 是 ok，不拼后缀", () => {
    const p = importResultPresentation({ added: 2, duplicated: 0, invalidLines: [], reset: 0 });
    expect(p).toEqual({
      resultParams: { added: 2, duplicated: 0, reset: 0, invalid: 0 },
      showInvalidSuffix: false, kind: "ok",
    });
  });
  it("有不合法的行：kind 是 warn，要拼后缀", () => {
    const p = importResultPresentation({ added: 1, duplicated: 0, invalidLines: [3], reset: 0 });
    expect(p.showInvalidSuffix).toBe(true);
    expect(p.kind).toBe("warn");
    expect(p.resultParams.invalid, "invalid 参数要取行号数组的长度，不是原始数组").toBe(1);
  });
  it("非法输入：退化成全 0、不 warn，不抛异常", () => {
    expect(importResultPresentation(null)).toEqual({
      resultParams: { added: 0, duplicated: 0, reset: 0, invalid: 0 },
      showInvalidSuffix: false, kind: "ok",
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 单把 key 的验活。端点与出站探测护栏由后端交付。
// ───────────────────────────────────────────────────────────────────────────

describe("verifyDisabledReason：三条 disable 理由各自可区分", () => {
  const row = { ...view, id: "k1" };

  it("没有可寻址的 id：no_key（这一行点了只会 404）", () => {
    expect(verifyDisabledReason(null, undefined, 1000)).toBe("no_key");
    expect(verifyDisabledReason({ ...row, id: "" }, undefined, 1000)).toBe("no_key");
    expect(verifyDisabledReason({ ...row, id: 7 }, undefined, 1000)).toBe("no_key");
  });

  /**
   * ⚠️ **停用 / 被剔除的 key 必须仍然验得动**——「它是不是真的死了」正是运维最想
   * 验的那一把。把这两种也算进 `no_key` 会把这颗按钮从唯一有用的场景里拿走。
   * **变红条件**：给 `verifyDisabledReason` 加一句 `if (row.disabled || row.evicted) return "no_key";`
   */
  it("已停用 / 已被剔除的 key 照样可以验 —— 那正是最想验的一把", () => {
    expect(verifyDisabledReason({ ...row, disabled: true }, undefined, 1000)).toBeNull();
    expect(verifyDisabledReason({ ...row, evicted: true }, undefined, 1000)).toBeNull();
  });

  it("从没验过（state 是 undefined）：可用", () => {
    expect(verifyDisabledReason(row, undefined, 1000)).toBeNull();
  });

  /**
   * ⚠️⚠️ **这一格是第 5 种假阳性的正面解法：一条用例里同时放进会让两种实现分叉的
   * 多个状态。** 在飞期间 `lastAt` 恒等于「刚刚」⇒ 两条判据**同时成立**，
   * 只覆盖单一状态的话「先判冷却」与「先判在飞」两种实现数学上等价。
   * **变红条件**：把 `verifyDisabledReason` 里 `cooling_down` 那一支挪到
   * `in_flight` 前面 ⇒ 运维会看到「刚探过，隔一会儿再试」，而真相是那一次还没回来
   * ——两种处置不同（等它 / 稍后再来），与后端把 429 分成两条 reason 是同一条理由。
   */
  it("在飞与冷却同时成立时报的是在飞 —— 顺序反了会把「还没回来」说成「刚探过」", () => {
    const now = 100_000;
    expect(verifyDisabledReason(row, { inFlight: true, lastAt: now }, now)).toBe("in_flight");
  });

  /**
   * 边界值**手写字面量**，不写成 `VERIFY_MIN_INTERVAL_MS ± 1`（第 6 种假阳性：
   * 期望值从被测对象自己推导）。3_000 这个数本身由下面「与后端是同一个数」那格钉着。
   */
  it("刚探过 2999 毫秒仍是 cooling_down，3000 毫秒放行", () => {
    expect(verifyDisabledReason(row, { inFlight: false, lastAt: 0 }, 2_999)).toBe("cooling_down");
    expect(verifyDisabledReason(row, { inFlight: false, lastAt: 0 }, 3_000)).toBeNull();
  });

  it("lastAt / now 不是有限数时不当成冷却（读不出时刻就别拦人）", () => {
    expect(verifyDisabledReason(row, { inFlight: false, lastAt: null }, 1)).toBeNull();
    expect(verifyDisabledReason(row, { inFlight: false, lastAt: Number.NaN }, 1)).toBeNull();
    expect(verifyDisabledReason(row, { inFlight: false, lastAt: 0 }, undefined)).toBeNull();
  });

  /**
   * **前端这个数不是护栏**（真正的护栏在后端且是进程内的），但两处必须相等——
   * 各写一份的话，改了后端而没改前端时不会有任何信号，运维会一直换回 429。
   * **变红条件**：把 `VERIFY_MIN_INTERVAL_MS` 改成别的数。
   */
  it("前端这个最小间隔与后端 PROBE_MIN_INTERVAL_MS 是同一个数", () => {
    expect(VERIFY_MIN_INTERVAL_MS).toBe(PROBE_MIN_INTERVAL_MS);
    // 反向自检：两边同时坏成 undefined 时上面那条恒成立。
    expect(VERIFY_MIN_INTERVAL_MS, "常量本身没了").toBe(3_000);
  });

  it("四种 disable 理由各自一条 title 文案，且互不相同、都在字典里", () => {
    const keys = [null, "in_flight", "cooling_down", "no_key"].map(verifyDisabledTitleKey);
    expect(keys).toEqual([
      "keys.verify.hintEnabled",
      "keys.verify.disabledInFlight",
      "keys.verify.disabledCoolingDown",
      "keys.verify.disabledNoKey",
    ]);
    expect(new Set(keys).size, "两条理由共用了同一句话 —— 只说「不可用」运维只能猜").toBe(4);
    for (const k of keys) expect(k in I18N, `${k} 不在字典里`).toBe(true);
  });
});

describe("verifyResultCode：200 响应体 → 文案 code", () => {
  /**
   * ⚠️ **变红条件**：把 `s === 429` 那一支删掉，让它落进 `upstream_error`。
   * 401/403 说的是「这把 key 失效了、要换一把」，429 说的是「上游在限流、等一会儿
   * 就好」——合成一条就是让运维去做一件没用的事。
   */
  it("401 与 429 映射成两个不同的 code —— 前者要换 key，后者等一会儿就好，合成一条就是让运维白忙", () => {
    expect(verifyResultCode({ ok: false, status: 401, reason: null })).toBe("unauthorized");
    expect(verifyResultCode({ ok: false, status: 403, reason: null })).toBe("unauthorized");
    expect(verifyResultCode({ ok: false, status: 429, reason: null })).toBe("rate_limited");
    expect(verifyResultCode({ ok: false, status: 500, reason: null })).toBe("upstream_error");
    expect(verifyResultCode({ ok: true, status: 200, reason: null })).toBe("ok");
    expect(verifyResultCode({ ok: true, status: 204, reason: null })).toBe("ok");
  });

  /**
   * ⚠️ 超时的那一次**根本没有 status**（后端 catch 分支回 `status: null`）。
   * 先判 status 的实现会在这里落进 `network_error`，把「上游慢」说成「连不上」。
   */
  it("reason 为 timeout 时不看 status —— 超时的那次根本没有 status", () => {
    expect(verifyResultCode({ ok: false, status: null, reason: "timeout" })).toBe("timeout");
    expect(verifyResultCode({ ok: false, status: null, reason: "network_error" })).toBe("network_error");
    // 就算后端将来同时给了两者，reason 仍然优先：它说的是「这次探测有没有发出去」。
    expect(verifyResultCode({ ok: false, status: 200, reason: "timeout" })).toBe("timeout");
  });

  /**
   * ⚠️⚠️ **表外的 reason 必须落进 `unknown_reason`，不许当成 `network_error`。**
   * 「后端加了一种、面板还不认识」在护栏那一轮上真实发生过一次；落进
   * `network_error` 的后果是面板对运维说一句**确定的假话**（「连不上上游」）。
   * **变红条件**：把 `verifyBodyReasonCode` 的表外分支改成 `return "network_error"`。
   */
  it("表外的 reason 落进 unknown_reason —— 绝不冒充任何一档已知原因", () => {
    expect(verifyResultCode({ ok: false, status: null, reason: "quota_exhausted" })).toBe("unknown_reason");
    expect(verifyResultLabelKey("unknown_reason")).toBe("keys.verify.unknownReason");
  });

  it("整个响应体不是对象时按「没拿到任何响应」处理，不抛异常", () => {
    expect(verifyResultCode(null)).toBe("network_error");
    expect(verifyResultCode("ok")).toBe("network_error");
    expect(verifyResultCode({ ok: true })).toBe("network_error");
  });
});

describe("verifyTransportCode：管理层传输错误 → 文案 code（判据是顶层 reason，不是状态码）", () => {
  /**
   * ⚠️⚠️ **这是本任务的头等一格。** 探测闸占用返回的 **429** 一次上游请求都没发出去，
   * 交给 `verifyResultCode` 会落进 `rate_limited`——那句文案是「上游在限流」，
   * 是一句对运维说的假话（评审发现）。
   * **变红条件**：把 429 也交给 `verifyResultCode` 处理（`rate_limited ≠ probe_*`）。
   */
  it("429 走 verifyTransportCode，不是 rate_limited —— 探测闸占用时一次上游请求都没发出去，说成「上游在限流」就是对运维撒谎（评审发现）", () => {
    const busy = { status: 429, body: { error: { type: "rate_limit_error" }, reason: "probe_in_flight" } };
    expect(verifyTransportCode(busy)).not.toBe("rate_limited");
    expect(verifyResultLabelKey(verifyTransportCode(busy))).not.toBe("keys.verify.rateLimited");
  });

  /**
   * ⚠️⚠️⚠️ **「两种 429 处置不同」由这一格钉住。**
   * `probe_in_flight` = 上一次还在飞，**等它回来**；
   * `probe_cooldown`  = 两次之间要隔一小段，**稍后再试，而且这不是这把 key 的故障**。
   * 它们的 **HTTP 状态码一模一样**，中文 `message` 也只有中文一种（面板是五语言的）
   * ⇒ **唯一能分开它们的只有顶层 `reason`**。
   *
   * **变红条件（三种，都实测过）**：
   * ① 把 `verifyTransportCode` 的判据从 `err.body.reason` 换回 `err.status === 429`
   *    ⇒ 两种落到同一个 code，`new Set(...).size` 从 2 掉到 1；
   * ② 把两条 `return` 中的任意一条改成另一条的值 ⇒ 同上；
   * ③ 把 `verifyResultLabelKey` 里 `probe_cooldown` 那一支删掉 ⇒ 它落进
   *    默认支 `keys.verify.upstreamError`，`EXPECTED` 那两行逐条比较当场红。
   */
  it("同一个 429 下的两种拒绝映射成两个不同的 code 与两句不同的文案 —— 一个是「等它回来」，另一个是「稍后再试，而且不是这把 key 的故障」", () => {
    const EXPECTED: ReadonlyArray<readonly [string, string, string]> = [
      ["probe_in_flight", "probe_in_flight", "keys.verify.probeInFlight"],
      ["probe_cooldown", "probe_cooldown", "keys.verify.probeCooldown"],
    ];
    for (const [reason, code, labelKey] of EXPECTED) {
      const err = { status: 429, body: { error: { type: "rate_limit_error" }, reason } };
      expect(verifyTransportCode(err), reason).toBe(code);
      expect(verifyResultLabelKey(code), reason).toBe(labelKey);
      expect(labelKey in I18N, `${labelKey} 不在字典里`).toBe(true);
    }
    const labels = EXPECTED.map(([, code]) => verifyResultLabelKey(code));
    expect(new Set(labels).size, "两种 429 共用了同一句文案 —— 只看状态码的实现就是这样").toBe(2);
    // 五种语言逐条核：少一种时面板在那个语言下显示裸 key。
    for (const [, , labelKey] of EXPECTED) {
      for (const lang of ["zh-CN", "zh-TW", "en", "ja", "ko"] as const) {
        expect(
          typeof (I18N as Record<string, Record<string, string>>)[labelKey]![lang],
          `${labelKey}/${lang}`,
        ).toBe("string");
      }
    }
  });

  it("404 / 401 各自一条，其余落进通用的 transport_error", () => {
    expect(verifyTransportCode({ status: 404, body: { error: { message: "没有这把 key" } } })).toBe("key_not_found");
    expect(verifyTransportCode({ status: 401, body: null })).toBe("unauthorized_admin");
    expect(verifyTransportCode({ status: 500, body: null })).toBe("transport_error");
    expect(verifyTransportCode(null)).toBe("transport_error");
  });

  /**
   * 表外的 429（今天后端产不出第三种）**不冒充任何一档已知原因**——与
   * `js/pure/registrar.mjs` 的 `refuseReasonKey()` 表外回 `null` 同一条纪律。
   * 「今天产不出」正是下面那格源码级对表守着的东西。
   */
  it("429 但 reason 不认识：落进 transport_error，不猜成 probe_cooldown", () => {
    expect(verifyTransportCode({ status: 429, body: { reason: "probe_budget_exhausted" } }))
      .toBe("transport_error");
  });
});

describe("verifyResultLabelKey：code → 文案 key（十二条逐条对，外加一个规模锚）", () => {
  /**
   * **手写的完整清单。** 顺序无关，但**每一条都是手写字面量**（第 6 种假阳性：
   * 期望值不许从被测对象自己推导）。
   *
   * ⚠️ **数字与枚举一起改**：简报第一版写「六个 code」，把传输码算进来是十个，
   * 而本任务把 `probe_busy` 拆成 `probe_in_flight` / `probe_cooldown`（那是本任务
   * 的头等交接）、又补了一条 `unknown_reason`（「后端加了一种、面板还不认识」的
   * 诚实出口）⇒ **今天是十二个**。
   */
  const EXPECTED_VERIFY_KEY: ReadonlyArray<readonly [string, string]> = [
    ["ok", "keys.verify.ok"],
    ["unauthorized", "keys.verify.unauthorized"],
    ["rate_limited", "keys.verify.rateLimited"],
    ["upstream_error", "keys.verify.upstreamError"],
    ["timeout", "keys.verify.timeout"],
    ["network_error", "keys.verify.networkError"],
    ["unknown_reason", "keys.verify.unknownReason"],
    ["probe_in_flight", "keys.verify.probeInFlight"],
    ["probe_cooldown", "keys.verify.probeCooldown"],
    ["key_not_found", "keys.verify.keyNotFound"],
    ["unauthorized_admin", "keys.verify.unauthorizedAdmin"],
    ["transport_error", "keys.verify.transportError"],
  ];

  /**
   * ⚠️ **`t()` 的拼写没有任何机器在守**（全局约束 12 的 ⚠️ 那一段：门禁连
   * `elI18n(tag, key)` 都看不见）。守这一条的**就是这一格**，
   * **不许在任何地方把它写成「由 i18n 门禁保证」**。
   */
  it("十二个 code 每一个都有对应的五语言字典键，且 key 由 verifyResultLabelKey 给出 —— 少一个面板上会出现裸的 key，而 i18n 门禁对拼出来的 key 是瞎的（评审发现）", () => {
    for (const [code, key] of EXPECTED_VERIFY_KEY) {
      expect(verifyResultLabelKey(code), code).toBe(key);
      expect(key in I18N, `${key} 不在字典里`).toBe(true);
      for (const lang of ["zh-CN", "zh-TW", "en", "ja", "ko"] as const) {
        const s = (I18N as Record<string, Record<string, string>>)[key]![lang];
        expect(typeof s === "string" && s.trim() !== "", `${key}/${lang} 是空的`).toBe(true);
      }
    }
    // 十二句话必须是十二句话：合并任意两条，运维就会拿到一句与处置对不上的提示。
    expect(new Set(EXPECTED_VERIFY_KEY.map(([, k]) => k)).size, "有两个 code 共用了同一句文案").toBe(12);
    // **手写字面量的规模锚**：这张表短一条**不会**让上面那个循环变红（它只遍历表自己），
    // 只有这一条能拦住「悄悄把某一种从表里删掉」。
    expect(EXPECTED_VERIFY_KEY.length, "文案 code 表被改过，请在评审里确认这是有意的").toBe(12);
  });

  /**
   * ⚠️⚠️ **这一格是源码级的，不能用行为断言代替**：把这个函数改成「前缀字面量 +
   * `code` 拼起来」之后，只要 code 的写法跟着改，**行为可以逐字节相同**
   *（第 5 种假阳性：覆盖的状态让被测的选择不可观测）。而拼出来的 key 对
   * `scripts/check-i18n.mjs` 的第 ① 条与
   * `tests/unit/i18n-dict.test.ts`「板块里当参数传的 i18n key（elI18n / labelKey 这类）同样必须在字典里」
   * 那两条扫描**同时隐身**。
   * ⚠️ **后果不是「全绿」了**（复评 F1；上一版这里写的是
   *「拼错一个字母，面板显示裸 key、三道 i18n 门禁全绿」）：第 ④ 条已升成硬错
   * ⇒ 拼的话这十二个**正在用**的 key 落进「未被引用」、CI 当场红，
   * 而顺着报文去「清理未被引用的 key」删掉的就是活文案。
   * ⇒ 这一格要钉的东西没变（源码里必须是字面量），变的是不照做的代价。
   *
   * 判据是**名字锚**（`grep -F` 可验），不是计数：十二条逐条要求那个字面量真的
   * 出现在源码里。**变红条件**：把任意一条 `return "keys.verify.x";` 改成拼接。
   */
  it("十二个 code 的 i18n key 逐条以字面量出现在源码里 —— 拼出来的 key 三道门禁都看不见", () => {
    const src = readFileSync("admin-ui/js/pure/keys-write.mjs", "utf8");
    const missing = EXPECTED_VERIFY_KEY
      .map(([, key]) => key)
      .filter((key) => !src.includes(`"${key}"`));
    expect(missing, "这些 key 在 keys-write.mjs 里不是双引号字面量 —— 拼出来的 key 门禁看不见").toEqual([]);
    // 反向自检：探针本身得能命中。**拿仓里真实那一行去喂它**（本仓纪律：
    // 写完一条形状判据，先拿真实那一行喂一遍，别探在会过的那一侧）。
    expect(src.includes('return "keys.verify.probeCooldown";'), "探针连真实那一行都命中不了").toBe(true);
    expect(src.includes('"keys.verify." +'), "源码里出现了拼 key 的形态").toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 「后端加了 reason、前端没跟上」—— 跨 src/ 与 admin-ui/ 的源码级对表
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⚠️⚠️⚠️ **这一格存在的全部理由，是护栏那一轮自己就是那个案例。**
 *
 * 那一轮给出站探测加了护栏，`ProbeAcquire` 因此多出两条顶层 `reason`
 *（`probe_in_flight` / `probe_cooldown`）——而 `admin-ui/js/pure/registrar.mjs`
 * 的 `refuseReasonKey()` 表**当时没有跟着加**，于是「刚测过，隔几秒再来」与
 *「这条通道真的连不上」在面板上长得一模一样，而运维恰恰会在一次失败之后立刻重试。
 *
 * **既有的护栏拦不住这件事，两条都实测过**：
 * · `tests/ui/registrar.test.ts`「每一种 reason 各自一条键，且每条都真的在字典里」
 *   那一格里 `EXPECTED_REFUSE_KEY` 的规模锚
 *   （`length === 10`）**只拦删、不拦加**：后端多一条 reason 时那个 10 纹丝不动。
 * · 行为断言更拦不住：新 reason 落进各自的默认支（`null` / `transport_error`），
 *   而所有既有用例喂进去的都是它们**认识**的那几条。
 * ⇒ 唯一拦得住的形状是**从后端源码里把「它可能产出什么」读出来**，
 *   再要求前端的映射表是它的超集。
 *
 * **覆盖边界，明写（别读成「所有后端 reason 都被守住了」）**：
 * 这一格只读**两个文件**——出站探测护栏 `src/http/admin/probe-guard.ts`
 * 与验活端点 `src/http/admin/handlers/verify.ts`。
 * `src/http/admin/handlers/registrar.ts` 自己那一族 reason（`tend_in_flight` /
 * `locked` / `registrar_disabled` / `write_budget_exhausted` / `manual_cooldown` /
 * `not_wired` / `unknown_channel` / `channel_not_configured`）**不在这一格的射程内**，
 * 它们今天仍然只有那个规模锚守着（同样只拦删不拦加）。
 * 那一半属于注册机板块的归属，本任务不在这里假装解决。
 */
describe("源码级对表：后端可能产出的顶层 reason ⊆ 前端映射表", () => {
  /**
   * 从一份 TS 源码里把**写成 `reason:` 这一种形态**的位置读出来。
   *
   * ⚠️⚠️⚠️ **它读的不是「所有 reason 位置」，只是「`reason:` 后面紧跟着东西」这一种
   * 书写形态。这句话是复评订正的——上一版的文档写的是「把所有 `reason:`
   * 位置读出来」，而那句话在两种零成本的合法改法下当场为假**（复评用本任务自己那套
   * 方法实测：条件恒假、行为逐字节不变，只换书写形态）：
   * · **shorthand**：`const reason = "..."; return c.json({ …, reason })`
   *   ⇒ **97/97 全绿**（既不进 `literals` 也不进 `dynamic`，静默通过）；
   * · **引号键**：`return c.json({ …, "reason": "..." })` ⇒ **97/97 全绿**。
   * 而 `handlers/verify.ts` 的产出全都在 `c.json({…})` 里，这两种都是**顺手就能写出来**
   * 的形态 ⇒ **这一格专门为之而生的那个缺陷可以原封不动重新长回来。**
   *
   * ⇒ **今天的分工是两条，缺一不可**：
   * ① 这个函数只认 `reason:` + 双引号字面量 / 三元 / 联合类型这一族；
   * ② 别的书写形态由下面 `FORBIDDEN_REASON_FORMS` **反向扫描**挡在门外
   *   （「不许出现」比「读得懂」便宜得多，而且两条加起来才是闭合的）。
   * **改这个函数之前先看那张表——单独加强任何一条都会留下另一条的缺口。**
   *
   * · `literals`：那个位置上出现过的字符串字面量（含联合类型里的多个）；
   * · `dynamic` ：那个位置上**不是**字面量、也不是 `null` 的表达式原文
   *   （例如 `g.reason`）——这一族是这道扫描的**盲点**，所以它必须被报出来、
   *   由下面的用例逐条表态，而不是被静默跳过。
   *
   * **必须先去注释**：`handlers/verify.ts` 的注释里逐字写着
   * `{ ok: false, reason: "network_error" }`，不去注释的话扫描会把一段说明
   * 当成一条真实的产出。去注释用的是 `tests/helpers/strip-comments.ts` 那**一份**
   * 逐字符实现（正则版会把字符串里的 `/*` 当块注释开头，本仓踩过）。
   *
   * **还有一条边界，方向是安全的那一侧**（复评 L6）：去注释之后**字符串字面量还在**，
   * 所以一句 `const msg = "reason: xxx";` 会被当成一处产出而误报。
   * 那是**假红不是假绿**——有人来看一眼就能判掉，代价远小于为它放宽判据。
   */
  function reasonSites(src: string): { literals: string[]; dynamic: string[] } {
    const literals = new Set<string>();
    const dynamic: string[] = [];
    for (const m of stripComments(src).matchAll(/\breason:\s*([^,\n}]*)/g)) {
      const expr = m[1]!.trim();
      if (expr === "" || expr === "null") continue;
      const found = [...expr.matchAll(/"([A-Za-z0-9_]+)"/g)].map((x) => x[1]!);
      if (found.length === 0) { dynamic.push(expr); continue; }
      for (const f of found) literals.add(f);
    }
    return { literals: [...literals].sort(), dynamic };
  }

  /**
   * **`reasonSites()` 读不懂的那几种书写形态，一律不许出现在这两个文件里**（复评 HIGH）。
   *
   * 这是上面那个函数的另一半：它读不懂的东西，**不能靠「今天没人这么写」放过去**——
   * 「今天没人这么写」正是这一格存在的全部理由所要防的那句话。
   * 每一条都在下面那一格里**各种一次探针**，证明它真的抓得住（正向），
   * 并且在真文件上是零命中（反向）。
   */
  const FORBIDDEN_REASON_FORMS: ReadonlyArray<{ re: RegExp; label: string; why: string }> = [
    {
      // `{ ok, reason }` / `{\n  reason,\n}` 都算。`\s` 覆盖换行。
      re: /[,{]\s*reason\s*[,}]/,
      label: "shorthand（`{ …, reason }`）",
      why: "属性名与变量同名时可以省掉 `reason:`，扫描器一个字都读不到"
        + "——既不进 literals 也不进 dynamic，静默通过。写成 `reason: reason` 即可。",
    },
    {
      // `"reason":` / `'reason':` / `["reason"]:` 与任何把它写成字符串的形态。
      re: /["'`]reason["'`]/,
      label: "引号键（`\"reason\":` / `[\"reason\"]:`）",
      why: "JS 允许把属性名写成字符串字面量，`\\breason:` 那条判据同样看不见它。"
        + "边界：一句恰好含 `\"reason\"` 的普通字符串也会命中 —— 假红不是假绿，看一眼就能判掉。",
    },
  ];

  const GUARD_FILE = "src/http/admin/probe-guard.ts";
  const VERIFY_FILE = "src/http/admin/handlers/verify.ts";

  /**
   * ⭐ **写完一条形状判据，先拿仓里真实那一行去喂它。**
   * 本仓在护栏那一轮上连续三次栽在「探针探在了会过的那一侧」，
   * 所以这一格先证明扫描器在**真文件**上给出的就是手写的那两个集合，
   * 再用一份手写探针证明它**不是**被写死成两条。
   *
   * ⚠️⚠️ **复评 HIGH 之后这一格多了后半段：`reasonSites()` 读不懂的两种书写形态
   * 必须被反向扫描挡住，而且那两条判据自己也要各种一次探针。**
   * 「我读得懂的部分对得上」与「我读不懂的部分不存在」是两件事，
   * 上一版只做了前一件，于是那条边界连散文都没写。
   */
  it("扫描器先在真文件上对得上；它读不懂的两种书写形态一律不许出现 —— 探针不许探在会过的那一侧", () => {
    const guard = reasonSites(readFileSync(GUARD_FILE, "utf8"));
    expect(guard.literals, `${GUARD_FILE} 里的顶层 reason 变了`).toEqual(["probe_cooldown", "probe_in_flight"]);
    expect(guard.dynamic, `${GUARD_FILE} 里出现了非字面量的 reason，这道扫描在那一行上是瞎的`).toEqual([]);

    const verify = reasonSites(readFileSync(VERIFY_FILE, "utf8"));
    expect(verify.literals, `${VERIFY_FILE} 里的顶层 reason 变了`).toEqual(["network_error", "timeout"]);
    /**
     * 唯一那处非字面量：429 那一支把护栏给的 `reason` 原样转出去。
     * 它**不是**盲点，因为它转的正是上面 `guard.literals` 那两条——
     * 但**必须写在这里逐字锚住**：再多一个动态位置，这道扫描就在那一行上瞎了，
     * 而那正是「后端加了、前端没跟上」重新长回来的入口。
     */
    expect(verify.dynamic, "验活端点多出了一个非字面量的 reason 位置").toEqual(["g.reason"]);

    // 手写探针：证明扫描器认得联合类型里的多条、认得动态位置、且**会去注释**。
    const probe = reasonSites([
      "const a = { reason: \"alpha\" };",
      "type T = { ok: false; reason: \"beta\" | \"gamma\"; message: string };",
      "const c = { reason: computeIt() };",
      "const d = { reason: null };",
      "/* 一段注释，里面写着 reason: \"ghost\" */",
      "// 行注释里也写着 reason: \"phantom\"",
    ].join("\n"));
    expect(probe.literals, "扫描器漏掉了联合类型里的某一条").toEqual(["alpha", "beta", "gamma"]);
    expect(probe.dynamic, "扫描器没把动态位置报出来").toEqual(["computeIt()"]);
    expect(probe.literals.includes("ghost"), "注释里的 reason 被当成真实产出了").toBe(false);
    expect(probe.literals.includes("phantom"), "行注释里的 reason 被当成真实产出了").toBe(false);

    // ── 后半段：反向扫描 —— 扫描器读不懂的两种书写形态一律不许出现 ────────────
    //
    // ⚠️ **每一条先证明它抓得住（正向探针），再断言真文件上零命中。**
    // 只做后半句的话，一条永远匹配不上的死正则会给出一模一样的绿——
    // 那正是本仓「探针探在了会过的那一侧」栽过三次的形态。
    const POSITIVE_PROBES: ReadonlyArray<readonly [string, string]> = [
      ["shorthand（`{ …, reason }`）", 'const reason = "x";\nreturn c.json({ ok: false, status: null, reason });'],
      ["引号键（`\"reason\":` / `[\"reason\"]:`）", 'return c.json({ ok: false, "reason": "x" });'],
      ["引号键（`\"reason\":` / `[\"reason\"]:`）", 'return c.json({ ok: false, ["reason"]: "x" });'],
    ];
    for (const [label, bad] of POSITIVE_PROBES) {
      const form = FORBIDDEN_REASON_FORMS.find((f) => f.label === label)!;
      expect(form.re.test(stripComments(bad)), `这条判据连它自己点名的写法都抓不住：${label}`).toBe(true);
      // 这两种形态对 `reasonSites()` 是**完全隐身**的 —— 这就是它们必须被反向扫描
      // 挡住的全部理由（复评实测：只换书写形态，97/97 全绿）。
      const blind = reasonSites(bad);
      expect(
        blind.literals.length === 0 && blind.dynamic.length === 0,
        `${label} 居然被 reasonSites 读到了，那这条反向判据的理由就不成立了，回来重写这一段`,
      ).toBe(true);
    }

    for (const file of [GUARD_FILE, VERIFY_FILE]) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const { re, label, why } of FORBIDDEN_REASON_FORMS) {
        expect(re.test(code), `${file} 里出现了 ${label} —— ${why}`).toBe(false);
      }
    }
  });

  /**
   * **护栏那两条：两个消费者都必须认得。**
   *
   * 它们是**同一份护栏**服务的两条端点（通道连通性测试 / 单把 key 验活），
   * 所以两个前端映射表都要跟上——当时漏的正是其中一个。
   *
   * **变红条件（逐条实测）**：
   * ① 往 `ProbeAcquire` 的 reason 联合里加第三条（后端一行 diff）而前端不动
   *    ⇒ 这一格当场红，报出那条没人认得的 reason；
   * ② 删掉 `verifyTransportCode` 里 `probe_cooldown` 那一支 ⇒ 它落进
   *    `transport_error`，第一条断言红；
   * ③ 删掉 `refuseReasonKey` 里任意一支 ⇒ 它回 `null`，第二条断言红。
   */
  it("护栏产出的每一条 reason，验活与通道测试两个前端都认得 —— 护栏那一轮就是「后端加了两条、前端没跟上」的那个案例", () => {
    const { literals } = reasonSites(readFileSync(GUARD_FILE, "utf8"));
    expect(literals.length, "一条都没扫到，扫描本身坏了").toBeGreaterThanOrEqual(2);

    const unmappedByVerify = literals.filter(
      (r) => verifyTransportCode({ status: 429, body: { reason: r } }) === "transport_error",
    );
    expect(
      unmappedByVerify,
      "护栏会产出这些 reason，而 Key 池的验活入口把它们当成一句通用的传输错误"
      + "——「上一次还在飞」与「刚探过」会说成同一句话",
    ).toEqual([]);

    const unmappedByRegistrar = literals.filter((r) => refuseReasonKey(r) === null);
    expect(
      unmappedByRegistrar,
      "护栏会产出这些 reason，而注册机板块的通道测试认不出来，会退回一句通用的「测试失败」"
      + "——「刚测过」与「这条通道真的连不上」会长得一模一样",
    ).toEqual([]);

    // 认得还不够：**必须各自是一句不同的话**，否则等于没分开。
    const verifyLabels = literals.map((r) => verifyResultLabelKey(verifyTransportCode({ status: 429, body: { reason: r } })));
    expect(new Set(verifyLabels).size, "两条 reason 在验活这一侧共用了同一句文案").toBe(literals.length);
    const registrarLabels = literals.map((r) => refuseReasonKey(r));
    expect(new Set(registrarLabels).size, "两条 reason 在通道测试那一侧共用了同一句文案").toBe(literals.length);
    for (const k of [...verifyLabels, ...registrarLabels]) expect(k! in I18N, `${k} 不在字典里`).toBe(true);
  });

  /**
   * **验活端点自己那两条（200 响应体里的 `reason`）。**
   *
   * **变红条件**：往 `handlers/verify.ts` 的 catch 分支里再加一档 reason
   *（例如把网关自己的内部错误从 `network_error` 里分出来——那份文件头的
   * 「代价，明写」那一段正好登记着这条将来可能会做的改动）而前端不动
   * ⇒ `verifyResultCode` 回 `unknown_reason`，这一格当场红。
   */
  it("验活端点 200 响应体里的每一条 reason，面板都认得 —— 认不得的会被诚实地说成「面板还不认识」，而这一格要求根本别走到那里", () => {
    const { literals } = reasonSites(readFileSync(VERIFY_FILE, "utf8"));
    expect(literals.length, "一条都没扫到，扫描本身坏了").toBeGreaterThanOrEqual(2);

    const unknown = literals.filter((r) => verifyResultCode({ ok: false, status: null, reason: r }) === "unknown_reason");
    expect(
      unknown,
      "验活端点会产出这些 reason，而面板还没给它们文案 —— 面板会显示「后端给出了还不认识的结果」",
    ).toEqual([]);

    const labels = literals.map((r) => verifyResultLabelKey(verifyResultCode({ ok: false, status: null, reason: r })));
    expect(new Set(labels).size, "两条 reason 共用了同一句文案").toBe(literals.length);
    for (const k of labels) expect(k in I18N, `${k} 不在字典里`).toBe(true);
  });
});

/**
 * **面板这一侧：拿码查五语言字典，表外的码回落并带一个看得见的标记**。
 *
 * ⚠️⚠️ **这是那条「归属定死」的破口的前端半身。** 后端半身（400/404/409 带不带
 * 闭集里的码）在 `tests/contract/admin-keys-write.test.ts` 的
 * 「每一条失败都带 error.code，而且 code 在闭集里」那一格，**跑在两份配置上**。
 *
 * ⚠️ **最容易走成的错法是「把中文 message 翻译成英文」**——那样 ja / ko 用户看到的
 * 仍然是一句看不懂的话，只是换了一种看不懂。下面「五种语言逐格各是各的」那格判的正是它。
 */

/** 绑定到某种语言的取词函数，行为与 `admin-ui/js/i18n.js` 的 `t()` 逐字相同（缺 key 回 key 本身）。 */
function tFor(lang: string) {
  return (key: string, params?: Record<string, unknown>) => {
    const row = (I18N as Record<string, Record<string, string>>)[key];
    let s = row ? (row[lang] ?? row["zh-CN"]) : undefined;
    if (s === undefined) return key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
    return s;
  };
}

const UI_LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"];

describe("管理接口错误码 → 面板文案", () => {
  it("后端每一个 code 都有一行、这里也没有多出后端不认的码（双向）", () => {
    expect(Object.keys(ADMIN_ERROR_TEXT_KEY).sort()).toEqual([...ADMIN_ERROR_CODES].sort());
    for (const [code, key] of Object.entries(ADMIN_ERROR_TEXT_KEY)) {
      expect(key in I18N, `code「${code}」指向的 ${key} 不在字典里`).toBe(true);
    }
  });

  it("已知 code ⇒ 渲染五语言字典里的那句，不是后端那句中文", () => {
    const err = { code: "note_too_long", message: "note 最长 200 个字符", params: { max: 200 } };
    expect(adminErrorText(err, tFor("ja"), "keys.writeFailed"))
      .toBe((I18N as Record<string, Record<string, string>>)["err.note_too_long"]!.ja!.replace("{max}", "200"));
    // **后端那句中文一个字都不许出现在 ja 的结果里。**
    expect(adminErrorText(err, tFor("ja"), "keys.writeFailed")).not.toContain("note 最长");
  });

  it("五种语言逐格各是各的 —— 「把中文翻译成英文」这种做法在这一格上过不去", () => {
    // 只翻一种语言的话，ja / ko 那两格会与 en 那格相等（或者与中文那格相等）。
    for (const code of ADMIN_ERROR_CODES) {
      const key = ADMIN_ERROR_TEXT_KEY[code]!;
      const rendered = UI_LANGS.map((l) => adminErrorText({ code, message: "后端原话" }, tFor(l), "keys.writeFailed"));
      expect(new Set(rendered).size, `${key} 的五种语言里有重复：${rendered.join(" | ")}`).toBe(UI_LANGS.length);
      // 后端那句话在**任何**一格里都不该出现——已知码这条路根本不读 `message`。
      for (const r of rendered) expect(r).not.toContain("后端原话");
    }
  });

  it("每个 code 的五语言字典串里的占位符与后端声明的 params 逐字相等", () => {
    // ⚠️ 这一格顶的是 `node scripts/check-i18n.mjs` 规则⑧ 的一个已登记盲点：
    // 这一族 key 是 `ADMIN_ERROR_TEXT_KEY` 里一张表的**值**，后面天然跟着逗号
    // ⇒ 那条规则对它结构性地看不见，而漏一格 params 会在屏幕上画出裸的 `{max}`。
    for (const code of ADMIN_ERROR_CODES) {
      const key = ADMIN_ERROR_TEXT_KEY[code]!;
      const declared = [...ADMIN_ERROR_PARAMS[code]].sort();
      for (const lang of UI_LANGS) {
        const s = (I18N as Record<string, Record<string, string>>)[key]![lang]!;
        const found = [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
        expect([...new Set(found)], `${key}/${lang} 的占位符与后端声明对不上`).toEqual(declared);
      }
    }
  });

  it("反向控制：占位符判据认得出真的占位符 —— 否则上一格在「一个都没找到」时恒绿", () => {
    // 拿仓里真实存在的一条带占位符的文案（后端声明它带 `max`）当正样本。
    const s = (I18N as Record<string, Record<string, string>>)["err.note_too_long"]!.ja!;
    expect([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1])).toEqual(["max"]);
    expect(ADMIN_ERROR_PARAMS.note_too_long).toEqual(["max"]);
  });

  it("表外的 code ⇒ 回落到后端原话，并且带一个看得见的标记", () => {
    // 静默把一句读不懂的话摆上去 = 撒谎的近亲；而删掉回落分支 = 未知错误变成空白，
    // 比读不懂更糟。**两条都不许。**
    const r = adminErrorText({ code: "zzz_unknown", message: "某种中文" }, tFor("ja"), "keys.writeFailed");
    expect(r).toContain("某种中文");
    // **标记必须真的加了东西**，不能等于原话——那就是「静默摆上去」。
    expect(r).not.toBe("某种中文");
    expect(r).toBe((I18N as Record<string, Record<string, string>>)["err.untranslated"]!.ja!
      .replace("{message}", "某种中文"));
  });

  it("回落标记五种语言各有一份，每一种都真的把原话包起来了", () => {
    for (const lang of UI_LANGS) {
      const r = adminErrorText({ code: "", message: "某种中文" }, tFor(lang), "keys.writeFailed");
      expect(r, `${lang} 的回落把原话弄丢了`).toContain("某种中文");
      expect(r, `${lang} 的回落没有任何看得见的标记`).not.toBe("某种中文");
    }
  });

  it("表外的 code + 内部码 message ⇒ 走通用文案，不把 http_500 摆给运维", () => {
    // 第三支：`isOpaqueErrorMessage()` 那一档。它比回落更靠后——回落只对「人话」成立。
    for (const raw of ["http_500", "unauthorized", "session_expired", ""]) {
      expect(adminErrorText({ code: "zzz_unknown", message: raw }, tFor("ja"), "keys.writeFailed"))
        .toBe((I18N as Record<string, Record<string, string>>)["keys.writeFailed"]!.ja);
    }
  });

  it("adminErrorFields 从 ApiError 那种嵌套形状里摊得出码，也收扁平的三元组", () => {
    // 运行期走的是前一种（`js/api.js` 的 `json()` 把 `error.message` 提到 `e.message` 上），
    // 测试里写的是后一种。**两种必须落到同一条判据上**，否则被测的不是屏幕上跑的那份。
    const apiError = {
      message: "note 最长 200 个字符",
      body: { error: { type: "invalid_request_error", code: "note_too_long", params: { max: 200 } } },
    };
    expect(adminErrorFields(apiError)).toEqual({
      code: "note_too_long", message: "note 最长 200 个字符", params: { max: 200 },
    });
    expect(adminErrorFields({ code: "empty_patch", message: "至少要改一个字段" }))
      .toEqual({ code: "empty_patch", message: "至少要改一个字段", params: undefined });
    // 什么都没有时三格都是空，交给回落/通用那两支处理。
    expect(adminErrorFields(null)).toEqual({ code: "", message: "", params: undefined });
  });

  it("板块文件不再自己判 message —— 唯一的出口是 adminErrorText", () => {
    // ⚠️ 判据建在**源码**上：`sec-keys.js` 里只要还留着一条「非空就原样显示」的分支，
    // 上面那些行为断言全绿而屏幕上照旧漏中文（第一版的破口就是这个形状）。
    // ⚠️ **它是源码文本门禁，得猜缺陷长成什么语法形态**（`tests/helpers/fake-dom.ts` 文件头
    // 逐字反对只靠这一种）。真正走一遍渲染的那一格在
    // `tests/ui/dom/keys-actions.test.ts`「复评 F2：ja 面板上写失败画的是日文那句 —— 不是中文原话，也不是裸占位符」。
    const src = stripComments(readFileSync("admin-ui/js/sec-keys.js", "utf8"));
    expect(src).toContain("adminErrorText(adminErrorFields(e), t, \"keys.writeFailed\")");
    // 反向控制：同一份源码里确实还有别的 `t(` 调用 —— 上一格不是在一份空文本上比对。
    expect(src.includes("t(\"keys.actionOk\")")).toBe(true);
  });

  /**
   * **「全面板只有一处会碰到后端 `message`」这句话的牙**（复评 F4）。
   *
   * ⚠️⚠️ 上一版这句射程声明只是**散文**：新守卫只扫 `sec-keys.js` 一个文件。
   * 复评实测（N10）把 `admin-ui/js/sec-registrar.js:137` 的 `t("reg.channel.testError")`
   * 改成回落显示 `e.message` ⇒ **`tests/ui` + `tests/unit` 92 文件 2547 条全绿**，
   * 而那条路上后端给的正是「注册机未启用……」这种**无 code 的中文**
   * ——本任务刚关掉的破口，在隔壁板块里零阻力重开。
   *
   * ⚠️ **白名单是空的，这不是笔误。** `sec-keys.js` 自己也**不**直接读 `.message`：
   * 它走 `adminErrorFields(e)`，而摊平那一步住在 `pure/keys-write.mjs`（本判据不扫 `pure/`）。
   * ⇒ 口径是「**板块文件一个都不许自己读 `.message`**，后端 message 的唯一入口是
   * `adminErrorFields()`」。开白名单就等于开一个永久的洞，所以一格都不开。
   *
   * **边界（登记，不是承诺）**：判据是 `\.message\b`，抠注释之后再扫。
   * 写成 `e["message"]` / 先解构 `const { message } = e` 躲得掉——今天射程内（`admin-ui/js/sec-*.js`）零处，
   * 真要躲的人也躲得过任何一条源码文本判据，这一条挡的是「顺手写一行」。
   */
  it("板块文件一个都不许自己读 .message —— 隔壁板块一行就能把刚关掉的破口原样重开", () => {
    const offenders: string[] = [];
    for (const name of readdirSync("admin-ui/js").sort()) {
      if (!name.startsWith("sec-") || !name.endsWith(".js")) continue;
      const src = stripComments(readFileSync(`admin-ui/js/${name}`, "utf8"));
      for (const line of src.split("\n")) if (/\.message\b/.test(line)) offenders.push(`${name}: ${line.trim()}`);
    }
    expect(
      offenders,
      "板块文件自己读了后端的 error.message —— 那是一句没有 code 的中文，会直投给 ja/en/ko 用户。"
      + "唯一的出口是 pure/keys-write.mjs 的 adminErrorFields() + adminErrorText()。\n"
      + offenders.join("\n"),
    ).toEqual([]);
  });

  it("反向控制：同一条判据在真的读了 .message 的那个文件上确实说「有」", () => {
    // **用仓里真实存在的文件**：`admin-ui/js/api.js` 的 `json()` 就是把
    // `parsed.error.message` 提到 `e.message` 上的那一处（全面板唯一合法的读点）。
    const src = stripComments(readFileSync("admin-ui/js/api.js", "utf8"));
    expect(src.split("\n").filter((l) => /\.message\b/.test(l)).length).toBeGreaterThan(0);
    // 而 `sec-*.js` 的清单里确实**有文件**被扫到（不是 readdir 一个都没匹配上）。
    expect(readdirSync("admin-ui/js").filter((n) => n.startsWith("sec-") && n.endsWith(".js")).length)
      .toBeGreaterThan(1);
  });

  /**
   * **`tFor()` 是 `admin-ui/js/i18n.js` 里 `t()` 的手抄副本**（复评 F5）。
   *
   * 上面那十格全部经它取词，而真源 `t()` 的插值 / 回落语义改一个字它不跟 ⇒
   * 十格照样绿而屏幕会变。这里把两者**对拍**：真 `t()` 在 node 里绑到 `zh-CN`
   *（`readLang()` 读不到 `localStorage` 会走 `FALLBACK`），逐条比较 `err.*` 这一族
   * 的取词结果，含带 params 的插值与「缺 key 回 key 本身」那一支。
   */
  it("tFor 与 admin-ui/js/i18n.js 的真 t() 逐条同结果 —— 手抄副本不许自己漂", async () => {
    const { t: realT, currentLang } = await import("../../admin-ui/js/i18n.js");
    expect(currentLang(), "真 t() 在 node 里应当绑在回落语言上").toBe("zh-CN");
    const mine = tFor("zh-CN");
    for (const code of ADMIN_ERROR_CODES) {
      const key = ADMIN_ERROR_TEXT_KEY[code]!;
      const params = Object.fromEntries([...ADMIN_ERROR_PARAMS[code]].map((n) => [n, `<${n}>`]));
      expect(mine(key, params), `${key} 的取词与真 t() 不一致`).toBe(realT(key, params));
    }
    // **三条边界也对拍**：缺 key 回 key 本身、无 params、params 里有真源不认的名字。
    expect(mine("zzz.not.a.real.key")).toBe(realT("zzz.not.a.real.key"));
    expect(mine("err.note_too_long")).toBe(realT("err.note_too_long"));
    expect(mine("err.note_too_long", { nope: 1 })).toBe(realT("err.note_too_long", { nope: 1 }));
    // **反向控制**：这组样本里确实有一条会发生插值的（否则上面整圈在「params 恒空」时空转）。
    expect(mine("err.note_too_long", { max: 7 })).toContain("7");
    expect(mine("err.note_too_long", { max: 7 })).not.toBe(mine("err.note_too_long"));
  });
});
