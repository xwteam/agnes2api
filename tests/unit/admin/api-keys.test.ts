import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../../helpers/strip-comments.js";
import {
  APIKEY_MAX, API_KEY_NAME_MAX, API_KEY_HINT_LENGTH, API_KEY_SECRET_BYTES, APIKEY_SECRET_PREFIX,
  API_KEY_BUCKETS, API_KEY_SORTS,
  apiKeyBucket, apiKeyCounts, checkApiKeyExpiresAt, checkApiKeyName, digest, emptyApiKeyTable,
  findByDigest, hintOf, isApiKeyDisabled, isApiKeyExpired, isApiKeySort, isApiKeyRecord,
  isApiKeyUsable, maskOf, matchesApiKeyQuery, parseApiKeyTable, sortApiKeyViews, toApiKeyViews,
  type ApiKeyRecord,
} from "../../../src/core/admin/api-keys.js";

/**
 * 对外 API 密钥那一族纯函数的边界。
 *
 * ⚠️ **这里一条 HTTP 都不打**：端点行为、双运行时一致、配额与「明文只出现一次」
 * 那几条都在 `tests/contract/admin-apikeys.test.ts` 与
 * `tests/contract/admin-apikeys-quota.test.ts` 里，那两份跑在双运行时上。
 */

const rec = (over: Partial<ApiKeyRecord> = {}): ApiKeyRecord => ({
  id: "aaaabbbbcccc", name: "n", hash: "0".repeat(64), hint: "3d41",
  createdAt: 1000, expiresAt: null, ...over,
});

describe("掩码", () => {
  it("是「前缀 + 圆点 + 末四位」，前缀来自常量而不是记录", () => {
    expect(maskOf("3d41")).toBe(`${APIKEY_SECRET_PREFIX}••••••••3d41`);
  });

  it("hint 读不出来时画破折号，不画一串光秃秃的圆点", () => {
    // 一串圆点会被读成「配了一把很短的密钥」，而真相是「这条记录里那一格坏了」。
    for (const bad of [undefined, null, "", 42, {}]) expect(maskOf(bad)).toBe("—");
  });

  it("hintOf 取的是明文末四位，位数由常量定", () => {
    expect(hintOf("sk-0123456789abcdef")).toBe("cdef");
    expect(hintOf("sk-0123456789abcdef")).toHaveLength(API_KEY_HINT_LENGTH);
  });
});

describe("摘要", () => {
  it("是 64 位十六进制小写，且对同一个明文稳定", async () => {
    const a = await digest("sk-abc");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await digest("sk-abc")).toBe(a);
  });

  it("差一个字符的两个明文，摘要不共享任何前缀结构 —— 这是「不必藏表内位置以外的东西」的前提", async () => {
    const a = await digest("sk-abc");
    const b = await digest("sk-abd");
    expect(a).not.toBe(b);
    // 只断言「第一位就不同」的话会依赖具体取值；这里断言的是「不是只差最后几位」。
    expect(a.slice(0, 8)).not.toBe(b.slice(0, 8));
  });
});

describe("过期与分档", () => {
  it("expiresAt 为 null 时恒不过期", () => {
    expect(isApiKeyExpired(rec(), Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("边界是 now >= expiresAt —— 等于那一刻已经在期外", () => {
    const r = rec({ expiresAt: 5000 });
    expect(isApiKeyExpired(r, 4999)).toBe(false);
    expect(isApiKeyExpired(r, 5000)).toBe(true);
    expect(isApiKeyExpired(r, 5001)).toBe(true);
  });

  it("停用的判据是 `=== true`，缺席就是启用", () => {
    expect(isApiKeyDisabled(rec())).toBe(false);
    expect(isApiKeyDisabled(rec({ disabled: false }))).toBe(false);
    expect(isApiKeyDisabled(rec({ disabled: true }))).toBe(true);
  });

  it("分档的优先级是 disabled > expired > active —— 两者都成立时报「已停用」", () => {
    // 已停用又已过期的那把在面板上必须说「已停用」：那是运维要找的线索。
    // 说「已过期」会让他以为把日期往后挪就能恢复。
    expect(apiKeyBucket(rec({ disabled: true, expiresAt: 1 }), 9999)).toBe("disabled");
    expect(apiKeyBucket(rec({ expiresAt: 1 }), 9999)).toBe("expired");
    expect(apiKeyBucket(rec(), 9999)).toBe("active");
  });

  it("isApiKeyUsable 与分档等价：active 当且仅当可用", () => {
    const cases = [rec(), rec({ disabled: true }), rec({ expiresAt: 1 }), rec({ disabled: true, expiresAt: 1 })];
    for (const r of cases) {
      expect(isApiKeyUsable(r, 9999)).toBe(apiKeyBucket(r, 9999) === "active");
    }
  });

  it("档位闭集恰好三档 —— 没有 pending 那一档（惰性激活本期不做，画一张恒为 0 的卡就是撒谎）", () => {
    expect([...API_KEY_BUCKETS]).toEqual(["disabled", "expired", "active"]);
  });
});

describe("findByDigest", () => {
  const table = [rec({ id: "1", hash: "a".repeat(64) }), rec({ id: "2", hash: "b".repeat(64) })];

  it("命中时交出那一条", () => {
    expect(findByDigest(table, "b".repeat(64))?.id).toBe("2");
  });

  it("没命中交出 null，空表也是 null", () => {
    expect(findByDigest(table, "c".repeat(64))).toBeNull();
    expect(findByDigest([], "a".repeat(64))).toBeNull();
  });

  it("长度不同一律不命中 —— 比较先比长度", () => {
    expect(findByDigest(table, "a")).toBeNull();
  });

  /**
   * ⚠️ **这一格是源码文本断言，不是行为断言，刻意的。**
   * 「遍历全表不提前退出」这条性质**不在返回值里**：把循环改成命中即 `return`，
   * 上面每一格的返回值逐点相同，变的只是耗时——与 `constantTimeEqual` 那条
   * 「无法由返回值断言证明」是同一族。它拦的是「顺手优化成提前退出」这类改动。
   */
  it("循环体里没有提前退出 —— 表内位置那一维靠「不短路」挡", () => {
    const src = readFileSync("src/core/admin/api-keys.ts", "utf8");
    const at = src.indexOf("export function findByDigest");
    expect(at, "findByDigest 改名了 —— 回来改这条判据，别把它放宽成恒真").toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("\n}", at));
    // **只取那个 `for` 的花括号体，并且先抠掉注释**：函数收尾那句 `return found;`
    // 在循环之外、完全正当，而本仓的注释里到处复述代码（这一段自己就写着 `return`）
    // ——不抠的话这一格会对着两样正当的东西恒红，那比没有更糟。
    const open = body.indexOf("{", body.indexOf("for ("));
    let depth = 0, close = open;
    for (let i = open; i < body.length; i++) {
      if (body[i] === "{") depth += 1;
      if (body[i] === "}") { depth -= 1; if (depth === 0) { close = i; break; } }
    }
    // **抠注释走全仓唯一那一份**（`tests/helpers/strip-comments.ts` 的转导出）：
    // 自己写一对正则去抠正是本仓明令禁止的形态，理由全文在那个真源的文件头。
    const loop = stripComments(body.slice(open, close + 1));
    expect(loop, "循环体里出现了 break/return —— 那会让耗时随「命中的是第几条」变化")
      .not.toMatch(/\b(break|return)\b/);
  });
});

describe("视图与排序", () => {
  const table = [
    rec({ id: "c", name: "zeta", createdAt: 3000, hint: "0003" }),
    rec({ id: "a", name: "alpha", createdAt: 1000, hint: "0001" }),
    rec({ id: "b", name: "mid", createdAt: 1000, hint: "0002" }),
  ];

  it("按 createdAt 升序、id 破平，seq 与返回顺序一致", () => {
    const views = toApiKeyViews(table, 9999);
    expect(views.map((v) => v.id)).toEqual(["a", "b", "c"]);
    expect(views.map((v) => v.seq)).toEqual([1, 2, 3]);
  });

  it("disabled 恒是布尔、恒存在 —— c.json 会把 undefined 整个丢掉", () => {
    const [v] = toApiKeyViews([rec()], 9999);
    expect(v).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(v!, "disabled")).toBe(true);
    expect(v!.disabled).toBe(false);
  });

  it("视图里没有 hash 这一格 —— 摘要不出网", () => {
    const [v] = toApiKeyViews([rec()], 9999);
    expect(JSON.stringify(v)).not.toContain("0".repeat(64));
    expect(Object.keys(v!)).not.toContain("hash");
  });

  it("统计只看 bucket，四个数加起来等于总数", () => {
    const views = toApiKeyViews(
      [rec({ id: "1" }), rec({ id: "2", disabled: true }), rec({ id: "3", expiresAt: 1 })],
      9999,
    );
    expect(apiKeyCounts(views)).toEqual({ all: 3, active: 1, disabled: 1, expired: 1 });
  });

  it("排序三档：新→旧 / 旧→新 / 名称，且都拿 seq 破平", () => {
    const views = toApiKeyViews(table, 9999);
    expect(sortApiKeyViews(views, "old").map((v) => v.id)).toEqual(["a", "b", "c"]);
    expect(sortApiKeyViews(views, "new").map((v) => v.id)).toEqual(["c", "b", "a"]);
    expect(sortApiKeyViews(views, "name").map((v) => v.name)).toEqual(["alpha", "mid", "zeta"]);
    expect([...API_KEY_SORTS]).toEqual(["new", "old", "name"]);
    expect(isApiKeySort("new")).toBe(true);
    expect(isApiKeySort("nope")).toBe(false);
  });

  it("搜索匹配名称 / 掩码 / id，**绝不匹配摘要**", () => {
    const [v] = toApiKeyViews([rec({ name: "mobile", hash: "dead".padEnd(64, "0") })], 9999);
    expect(matchesApiKeyQuery(v!, "")).toBe(true);
    expect(matchesApiKeyQuery(v!, "MOBILE")).toBe(true);
    expect(matchesApiKeyQuery(v!, "3d41")).toBe(true);
    expect(matchesApiKeyQuery(v!, "aaaabbbb")).toBe(true);
    // 摘要前缀：能按它筛选就等于把「这把在不在表里」做成一个可批量试探的接口。
    expect(matchesApiKeyQuery(v!, "dead")).toBe(false);
  });
});

describe("校验", () => {
  it("名称：非字符串 / 空 / 超长各是一档，空排在超长前面", () => {
    expect(checkApiKeyName(123)).toBe("name_not_a_string");
    expect(checkApiKeyName("")).toBe("name_empty");
    expect(checkApiKeyName("   ")).toBe("name_empty");
    expect(checkApiKeyName("x".repeat(API_KEY_NAME_MAX))).toBeNull();
    expect(checkApiKeyName("x".repeat(API_KEY_NAME_MAX + 1))).toBe("name_too_long");
  });

  it("到期：null 合法，非整数与过去的时刻各是一档", () => {
    expect(checkApiKeyExpiresAt(null, 1000)).toBeNull();
    expect(checkApiKeyExpiresAt("soon", 1000)).toBe("expires_not_a_number");
    expect(checkApiKeyExpiresAt(1.5, 1000)).toBe("expires_not_a_number");
    expect(checkApiKeyExpiresAt(Number.POSITIVE_INFINITY, 1000)).toBe("expires_not_a_number");
    expect(checkApiKeyExpiresAt(1001, 1000)).toBeNull();
  });

  it("到期的下界与 isApiKeyExpired 是同一条边界 —— 等于 now 的那一刻已经在期外", () => {
    // 两处用两条边界会造出一个「创建时合法、下一行就过期」的洞。
    expect(checkApiKeyExpiresAt(1000, 1000)).toBe("expires_in_the_past");
    expect(isApiKeyExpired(rec({ expiresAt: 1000 }), 1000)).toBe(true);
  });
});

describe("blob 的窄化", () => {
  it("键不存在是 absent —— 那是一份合法快照（还没签发过），不是错", () => {
    expect(parseApiKeyTable(null)).toEqual({ kind: "absent" });
    expect(parseApiKeyTable(undefined)).toEqual({ kind: "absent" });
  });

  it("认得出来的一张表是 ok", () => {
    const t = { version: 3, keys: [rec()] };
    const read = parseApiKeyTable(t);
    expect(read.kind).toBe("ok");
    expect(read.kind === "ok" && read.table.version).toBe(3);
  });

  it("结构不认一律 invalid —— **绝不当空表**", () => {
    // 当空表的后果是全部客户 401，而下一次面板写把幸存记录整份覆掉，不可逆。
    for (const bad of [
      "一段字符串", 42, [], {}, { version: 1 }, { keys: [] },
      { version: "1", keys: [] }, { version: 1, keys: {} },
      { version: 1, keys: [{ id: "x" }] },
    ]) {
      expect(parseApiKeyTable(bad), JSON.stringify(bad)).toEqual({ kind: "invalid" });
    }
  });

  it("逐字段窄化：每一格坏掉都会让整条记录不认", () => {
    expect(isApiKeyRecord(rec())).toBe(true);
    expect(isApiKeyRecord({ ...rec(), id: "" })).toBe(false);
    expect(isApiKeyRecord({ ...rec(), name: 1 })).toBe(false);
    expect(isApiKeyRecord({ ...rec(), hash: "" })).toBe(false);
    expect(isApiKeyRecord({ ...rec(), hint: null })).toBe(false);
    expect(isApiKeyRecord({ ...rec(), disabled: "yes" })).toBe(false);
    expect(isApiKeyRecord({ ...rec(), createdAt: "1000" })).toBe(false);
    expect(isApiKeyRecord({ ...rec(), expiresAt: "never" })).toBe(false);
    // `disabled` 缺席是合法的（存量记录零迁移），`expiresAt: null` 也是。
    expect(isApiKeyRecord({ ...rec(), disabled: undefined })).toBe(true);
  });

  it("空表的 version 从 0 起 —— 第一次写落地的就是 1", () => {
    expect(emptyApiKeyTable()).toEqual({ version: 0, keys: [] });
  });
});

describe("常量", () => {
  it("三个边界常量写字面量钉死 —— 它们是与面板、文档对齐的契约，不是随手选的数", () => {
    expect(APIKEY_MAX).toBe(200);
    expect(API_KEY_NAME_MAX).toBe(64);
    // 128 bit：`ApiKeyRecord.hash` 上方那条「无盐单轮 SHA-256 是正确选择」的论证
    // 以它为前提，改小它之前先去读那一段。
    expect(API_KEY_SECRET_BYTES).toBe(16);
  });
});
