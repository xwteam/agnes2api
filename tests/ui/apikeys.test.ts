import { describe, it, expect } from "vitest";
import {
  AK_CARDS, AK_SORTS, AK_EXPIRY_DAYS,
  akCounts, akListState, akItems, akVersion, akBadgeClass, akBucketLabelKey,
  akCardLabelKey, akSortLabelKey, akExpiryLabelKey, akVisible, akPurgeCount,
  akPurgeVisible, akEmptyKey, akToggleLabelKey, akNameProblem, akExpiresAt,
  akRevokeDelayMs, akCapability,
} from "../../admin-ui/js/pure/apikeys.mjs";
import { API_KEY_BUCKETS, API_KEY_SORTS } from "../../src/core/admin/api-keys.js";
import { ADMIN_ERROR_CODES } from "../../src/core/admin/admin-errors.js";

/**
 * 「API 密钥」板块的取值决策（`admin-ui/js/pure/apikeys.mjs`）。
 *
 * ⚠️ 渲染那一半在 `tests/ui/dom/apikeys-section.test.ts`：这里全绿而板块文件
 * 根本没把这些判定画出来，是本仓登记过的一类假阳性。
 */

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const item = (over = {}) => ({
  id: "aaaabbbbcccc", name: "n", seq: 1, masked: "sk-••••••••3d41", hint: "3d41",
  bucket: "active", disabled: false, createdAt: NOW, expiresAt: null, ...over,
});

describe("统计卡", () => {
  it("四张卡，没有 pending 那一档 —— 惰性激活本期不存在，画一张恒为 0 的卡就是撒谎", () => {
    expect([...AK_CARDS]).toEqual(["all", "active", "disabled", "expired"]);
  });

  it("没有数据时逐项 null（会被画成 —），绝不返回 0", () => {
    for (const bad of [null, undefined, {}, { counts: null }, "x"]) {
      expect(akCounts(bad)).toEqual({ all: null, active: null, disabled: null, expired: null });
    }
  });

  it("有数据时原样交出四个数", () => {
    expect(akCounts({ counts: { all: 3, active: 1, disabled: 1, expired: 1 } }))
      .toEqual({ all: 3, active: 1, disabled: 1, expired: 1 });
  });

  it("卡标题的 key 逐条字面量 —— 拼出来的话 i18n 门禁扫不到它们", () => {
    expect(AK_CARDS.map(akCardLabelKey))
      .toEqual(["ak.card.all", "ak.card.active", "ak.card.disabled", "ak.card.expired"]);
  });
});

describe("列表的三种状态", () => {
  it("请求失败是 error", () => {
    expect(akListState({ unreadable: false, keys: [] }, true)).toBe("error");
  });

  it("后端说读不出来是 unreadable —— **它与「一把都没有」不是同一档**", () => {
    // 两者的响应体里 `keys` 都是空数组：拿 `keys.length === 0` 去判，
    // 会把「表坏了、全部下游正在 401」画成「你还没签发过密钥」。
    expect(akListState({ unreadable: true, keys: [] }, false)).toBe("unreadable");
    expect(akListState({ unreadable: false, keys: [] }, false)).toBe("ok");
  });

  it("版本号读不出来时是 null —— 那时写操作必须整个禁掉", () => {
    expect(akVersion(null)).toBeNull();
    expect(akVersion({ version: null })).toBeNull();
    expect(akVersion({ version: "7" })).toBeNull();
    expect(akVersion({ version: 0 })).toBe(0);
    expect(akVersion({ version: 7 })).toBe(7);
  });

  it("条目：不是数组时给空数组，不抛", () => {
    expect(akItems(null)).toEqual([]);
    expect(akItems({ keys: "nope" })).toEqual([]);
    expect(akItems({ keys: [item()] })).toHaveLength(1);
  });
});

describe("分档与徽章", () => {
  it("三档的样式互不相同 —— 两档共用一个样式等于面板分不出它们", () => {
    const classes = API_KEY_BUCKETS.map(akBadgeClass);
    expect(new Set(classes).size).toBe(API_KEY_BUCKETS.length);
  });

  it("「已停用」不带颜色修饰类：它不是故障，是运维自己按下的开关", () => {
    expect(akBadgeClass("disabled")).toBe("badge");
  });

  it("档位名的 key 与后端那张闭集一一对应", () => {
    expect(API_KEY_BUCKETS.map(akBucketLabelKey))
      .toEqual(["ak.bucket.disabled", "ak.bucket.expired", "ak.bucket.active"]);
  });
});

describe("搜索与排序", () => {
  const rows = [
    item({ id: "c0", name: "zeta", seq: 3, masked: "sk-••••••••0003" }),
    item({ id: "a0", name: "alpha", seq: 1, masked: "sk-••••••••0001" }),
    item({ id: "b0", name: "mid", seq: 2, masked: "sk-••••••••0002" }),
  ];

  it("排序档与后端那张闭集逐字对应", () => {
    expect([...AK_SORTS]).toEqual([...API_KEY_SORTS]);
    expect(AK_SORTS.map(akSortLabelKey)).toEqual(["ak.sort.new", "ak.sort.old", "ak.sort.name"]);
  });

  it("新→旧 / 旧→新 / 按名称，三档都拿 seq 破平", () => {
    const seqs = (sort: string): number[] =>
      akVisible(rows, "", sort).map((v: { seq: number }) => v.seq);
    expect(seqs("new")).toEqual([3, 2, 1]);
    expect(seqs("old")).toEqual([1, 2, 3]);
    expect(akVisible(rows, "", "name").map((v: { name: string }) => v.name))
      .toEqual(["alpha", "mid", "zeta"]);
  });

  it("搜索匹配名称 / 掩码 / id，大小写与首尾空白都不敏感", () => {
    const ids = (q: string): string[] => akVisible(rows, q, "new").map((v: { id: string }) => v.id);
    expect(ids("  ZETA ")).toEqual(["c0"]);
    expect(ids("0002")).toEqual(["b0"]);
    expect(ids("a0")).toEqual(["a0"]);
    expect(akVisible(rows, "", "new")).toHaveLength(3);
  });
});

describe("「清理失效（N）」那颗按钮", () => {
  const mixed = [
    item({ id: "1", bucket: "active" }),
    item({ id: "2", bucket: "disabled" }),
    item({ id: "3", bucket: "expired" }),
  ];

  it("N 数的是「此刻用不了的那些」，与两张统计卡之和逐条相同", () => {
    expect(akPurgeCount(mixed)).toBe(2);
    expect(akPurgeVisible(mixed)).toBe(true);
  });

  it("N = 0 时整颗按钮不画 —— 一颗点了什么都不会发生的按钮比没有更糟", () => {
    expect(akPurgeCount([item()])).toBe(0);
    expect(akPurgeVisible([item()])).toBe(false);
    expect(akPurgeVisible([])).toBe(false);
  });
});

describe("空列表那句话", () => {
  it("「一把都没有」与「搜索没命中」是两句不同的话", () => {
    expect(akEmptyKey([], [])).toBe("ak.empty");
    expect(akEmptyKey([item()], [])).toBe("ak.emptyFiltered");
    expect(akEmptyKey([item()], [item()])).toBeNull();
  });
});

describe("行内开关的文案", () => {
  it("看的是这一条此刻的状态，不是它将要变成什么", () => {
    expect(akToggleLabelKey(item({ disabled: false }))).toBe("ak.action.disable");
    expect(akToggleLabelKey(item({ disabled: true }))).toBe("ak.action.enable");
  });
});

describe("表单校验", () => {
  it("三档各回一条**后端那批码**，不回 i18n key —— 「码 → 文案」全仓只有一份翻译", () => {
    expect(akNameProblem(123, 64)?.code).toBe("name_not_a_string");
    expect(akNameProblem("   ", 64)?.code).toBe("name_empty");
    expect(akNameProblem("x".repeat(65), 64)).toEqual({ code: "name_too_long", params: { max: 64 } });
    expect(akNameProblem("x".repeat(64), 64)).toBeNull();
  });

  it("回的那几条码都在后端那张闭集里 —— 编一条码出来，面板会画出一句 untranslated", () => {
    const codeOf = (r: unknown): string | null => {
      const o = r as { code?: unknown } | null;
      return o !== null && typeof o.code === "string" ? o.code : null;
    };
    const codes = [
      akNameProblem(123, 64), akNameProblem("", 64), akNameProblem("x".repeat(65), 64),
      akExpiresAt(null, "2000-01-01", NOW),
    ].map(codeOf).filter((c): c is string => c !== null);
    expect(codes).toHaveLength(4);
    for (const c of codes) expect(ADMIN_ERROR_CODES as readonly string[]).toContain(c);
  });

  it("上限缺席时回落到 64，与后端常量同一个数", () => {
    expect(akNameProblem("x".repeat(65), null)).toEqual({ code: "name_too_long", params: { max: 64 } });
  });
});

describe("到期换算", () => {
  it("快捷档：0 = 不过期，其余是「自签发时刻起 N 天」的绝对时刻", () => {
    expect([...AK_EXPIRY_DAYS]).toEqual([0, 7, 30, 90]);
    expect(akExpiresAt(0, "", NOW)).toEqual({ value: null });
    expect(akExpiresAt(30, "", NOW)).toEqual({ value: NOW + 30 * DAY });
  });

  it("快捷档的文案 key 逐条字面量，且「不过期」是默认那一支", () => {
    expect(AK_EXPIRY_DAYS.map(akExpiryLabelKey))
      .toEqual(["ak.expiry.never", "ak.expiry.d7", "ak.expiry.d30", "ak.expiry.d90"]);
    expect(akExpiryLabelKey(999)).toBe("ak.expiry.never");
  });

  it("自定义日期取那一天的**结束**时刻 —— 取零点的话「选今天」会得到一把已经过期的密钥", () => {
    expect(akExpiresAt(null, "2026-01-02", NOW)).toEqual({ value: Date.UTC(2026, 0, 3) });
  });

  it("没选 / 认不出的日期是纯前端那一档（`key`），过去的时刻走后端那条码（`code`）", () => {
    expect(akExpiresAt(null, "", NOW)).toEqual({ key: "ak.err.pickDate" });
    expect(akExpiresAt(null, "not-a-date", NOW)).toEqual({ key: "ak.err.pickDate" });
    expect(akExpiresAt(null, "2000-01-01", NOW)).toEqual({ code: "expires_in_the_past" });
  });
});

/**
 * ⚠️ **上一版这两格测的是「生效的缓存 TTL **+ KV 边缘缓存**」两个入参**
 *（`(300_000, 60_000) → 360_000`）。v0.4.0 把 KV 边缘缓存那一整层删了
 *（KV 随 Worker 形态一起没了），这个数退回**只有一个来源**：`capabilities`
 * 报的 `APIKEY_CACHE_TTL_MS`。**判别力一格没丢，锚换了**：原来守的是
 * 「两个数都从后端来、任一读不出就画 —」，现在守的是「这个数从后端来、
 * 读不出就画 —」，反面那一格照旧在。
 */
describe("「多久才在别处失效」那个数", () => {
  it("= 生效的缓存 TTL 本身，从后端来（中间不再有任何一层缓存）", () => {
    expect(akRevokeDelayMs(300_000)).toBe(300_000);
  });

  it("读不出来就回 null（画成 —），**不编一个数出来**", () => {
    // 这句话是安全相关的：编一个数出来会让运维以为吊销比实际更快。
    expect(akRevokeDelayMs(null)).toBeNull();
    expect(akRevokeDelayMs(undefined)).toBeNull();
    expect(akRevokeDelayMs("300000")).toBeNull();
  });
});

describe("capabilities 那一块", () => {
  it("读不出来时 wired 是 null（还不知道），不是 false（这个部署没接）", () => {
    expect(akCapability(null).wired).toBeNull();
    expect(akCapability({}).wired).toBeNull();
    expect(akCapability({ apiKeys: {} }).wired).toBeNull();
    expect(akCapability({ apiKeys: { wired: false } }).wired).toBe(false);
  });

  it("上限 / TTL 一格都不在前端写死，读不出来就是 null", () => {
    expect(akCapability({ apiKeys: { wired: true } }))
      .toEqual({ wired: true, max: null, nameMax: null, plaintextRetrievable: false, cacheTtlMs: null });
    expect(akCapability({
      apiKeys: { wired: true, max: 200, nameMax: 64, plaintextRetrievable: false, cacheTtlMs: 300_000 },
    })).toEqual({ wired: true, max: 200, nameMax: 64, plaintextRetrievable: false, cacheTtlMs: 300_000 });
  });

  it("plaintextRetrievable 只认逐字的 true —— 缺席一律当「取不回来」", () => {
    expect(akCapability({ apiKeys: { plaintextRetrievable: "yes" } }).plaintextRetrievable).toBe(false);
    expect(akCapability({ apiKeys: { plaintextRetrievable: true } }).plaintextRetrievable).toBe(true);
  });
});
