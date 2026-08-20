import { describe, it, expect } from "vitest";
import { maskKey, keyBucket, toKeyViews, bucketCounts, matchesQuery, BUCKETS } from "../../../src/core/admin/key-view.js";
import { isAvailable } from "../../../src/core/keypool.js";
import type { KeyRecord } from "../../../src/core/types.js";

const mk = (over: Partial<KeyRecord>): KeyRecord => ({
  id: "id0", key: "sk-abcdefghijklmnop", addedAt: 0, lastUsedAt: null,
  cooldownUntil: 0, cooldownReason: null, strikes: 0, evicted: false, evictedReason: null, ...over,
});

/**
 * 掩码是硬规则，不是显示偏好：`KeyPoolRepo.all()` 返回的记录含完整明文 key，
 * 直接 JSON 吐给面板等于把整池上游 key 交出去。**且没有任何 reveal 端点**——
 * 有了它，面板口令泄漏就等于整池泄漏。
 */
describe("KeyView 永不含明文", () => {
  it("投影出来的对象里没有 key 字段，也没有任何值等于原串", () => {
    const rec = mk({ key: "sk-THE-WHOLE-SECRET-VALUE" });
    const [v] = toKeyViews([rec], 0);
    expect(Object.keys(v!)).not.toContain("key");
    // 逐个值扫一遍：只断言「没有 key 这个字段名」拦不住「顺手塞进 note 字段」。
    for (const val of Object.values(v!)) {
      expect(JSON.stringify(val)).not.toContain("WHOLE-SECRET");
    }
  });
  /**
   * @refs-ignore（本段要点名那个已被删掉的前端副本）
   * ⚠️ **这里原来还有一格「maskKey 与前端那份 `pure/mask.mjs` 在同一组夹具上结果
   * 一致」，随 `admin-ui/js/pure/mask.mjs` 一起删掉了**（全分支评审 B3）。
   *
   * 理由不是"那条断言不好"，而是**它守的东西没有消费者**：`mask.mjs` 在
   * `admin-ui/js/` 里零导入者——面板显示的 `masked` 是后端这一份算好之后放进
   * `GET /admin/api/keys` 响应里的（见下面 `toKeyViews`）。一份没有任何页面会跑
   * 的实现，加上一条为它写的一致性断言，正是本项目已经裁过三次的那个形态：
   * **没有消费者的东西迟早会漂，而漂了也没人会发现**。
   *
   * 掩码这条硬规则本身**没有失去保护**：上面那格「投影出来的对象里没有 key 字段，
   * 也没有任何值等于原串」跑在真正发货的这一份上，下面还有一整组 `maskKey` 的
   * 边界用例。真要在浏览器侧再算一次掩码时，把那个模块与这条一致性断言一起加回来。
   */
  it("maskKey 的边界：短串整串隐去、绝不返回原值", () => {
    for (const s of ["", "sk", "0123456789"]) {
      expect(maskKey(s), s).toBe("…");
      expect(maskKey(s), `${s} 不许被原样吐出`).not.toBe(s);
    }
    expect(maskKey("0123456789a")).toBe("01234…789a");
    expect(maskKey("sk-abcdefghijklmnop")).toBe("sk-ab…mnop");
  });
});

/**
 * **分档必须与真实调度语义一致。**
 *
 * @refs-ignore（本段要点名那两个已被删掉的前端文件）
 * ⚠️ **这组 CASES 原本是从 `tests/ui/bucket.test.ts` 逐格搬过来的，别再"精简"回去。**
 *（那份前端副本与 `admin-ui/js/pure/bucket.mjs` 已在全分支评审 B3 一并删除——
 *  面板显示的 `bucket` 来自本文件测的这一份，前端那份零导入者。**这里就是这条
 *  等价关系今天唯一的护栏了**，删一格就没有第二处兜着。）
 * 那边用一整段注释记着一次实测：如果没有一格真的把 `disabled` 设成 `true`，
 * 「给 keyBucket 加一档 disabled 但不改 isAvailable」这个变异**不会被等价关系循环抓住**
 * ——所有 fixture 的 `disabled` 都是 `undefined`，变异后的 keyBucket 对它们仍然走到
 * `return "fresh"`，与 isAvailable 继续一致，循环全绿。本文件第一版正是那样写的，
 * 而 `key-view.ts` 里却写着"加档而不改调度会让它变红"——**那句话当时是假的**（评审 I3）。
 */
describe("keyBucket 与 isAvailable 等价（后端这一份同样要钉）", () => {
  const NOW = 1000;
  const CASES: ReadonlyArray<{ name: string; rec: KeyRecord }> = [
    { name: "全新", rec: mk({}) },
    { name: "冷却中", rec: mk({ cooldownUntil: NOW + 1 }) },
    { name: "冷却刚好到期（边界：<= now 即可用）", rec: mk({ cooldownUntil: NOW }) },
    { name: "已剔除", rec: mk({ evicted: true, evictedReason: "401" }) },
    { name: "已剔除且冷却中（两者同时成立——单状态用例区分不了优先级，第 5 种假阳性）", rec: mk({ evicted: true, cooldownUntil: NOW + 1 }) },
    { name: "有 strikes 但未冷却（strikes 不参与可用性判定）", rec: mk({ strikes: 2 }) },
    /**
     * ⚠️ **这一格是 P3b 的人预先埋下的靶子，P3c Task 2 落地时它照约定生效了。**
     * 原注释写着「KeyRecord 今天还没有这个字段，未来加了却忘改 isAvailable 时，
     * 这一格必须能把它抓出来」——Task 2 开工前按计划复跑了那次实验（给 BUCKETS 加
     * 第四档 + keyBucket 加分支、**不动** isAvailable）：**实测 2 条红**，正是这一格
     * 与下面那条档位字面量。**别删它**，`disabled` 的等价关系今天仍然只靠它。
     */
    { name: "已停用（disabled=true）", rec: mk({ disabled: true }) },
    /**
     * 单状态用例区分不了优先级（第 5 种假阳性），所以两个字段必须给**不同**的组合，
     * 不能两个都 true 就完事。
     */
    { name: "已停用且已剔除（两者同时成立）", rec: mk({ disabled: true, evicted: true, evictedReason: "401" }) },
    { name: "已停用且冷却中", rec: mk({ disabled: true, cooldownUntil: NOW + 1 }) },
  ];
  for (const { name, rec } of CASES) {
    it(`${name}：keyBucket === "fresh" 当且仅当 isAvailable`, () => {
      expect(keyBucket(rec, NOW) === "fresh").toBe(isAvailable(rec, NOW));
    });
  }
  it("优先级：已剔除且冷却中时报 evicted，不报 cooling", () => {
    expect(keyBucket(mk({ evicted: true, cooldownUntil: NOW + 1 }), NOW)).toBe("evicted");
  });
  /**
   * 第四档的**反向夹具**：`disabled` 压过 `evicted`。
   * **变红条件**：把 `BUCKETS` 里 `disabled` 与 `evicted` 两档对调，或把 `keyBucket`
   * 里那两个 `if` 对调。
   *
   * 两格给的是**不同的**字段组合（第 1 种假阳性防护）：只写 `disabled=true &&
   * evicted=true` 那一格的话，「优先级反了」与「压根没看 disabled」在这一格上给出
   * 同一个答案，断言区分不了它们。
   */
  it("优先级：disabled 压过 evicted——两者的处置完全不同，混为一谈会把运维指错方向", () => {
    expect(keyBucket(mk({ disabled: true, evicted: false }), NOW)).toBe("disabled");
    expect(keyBucket(mk({ disabled: true, evicted: true, evictedReason: "401" }), NOW)).toBe("disabled");
    expect(keyBucket(mk({ disabled: false, evicted: true, evictedReason: "401" }), NOW)).toBe("evicted");
  });
  /**
   * **存量记录**：对象里**真的没有 `disabled` 这个键**（`mk` 只在 `over` 里给了才有）。
   * 刻意不写 `{ ...mk({}), disabled: undefined }`——那在 TS 里能过，但 JSON 往返之后
   * 与「字段不存在」不等价，**测的就成了抄件不是原件**（第 7 种假阳性）。
   * 加一个可选字段不许把整池 key 挪进新档。
   */
  it("存量记录（压根没有 disabled 字段）照常落 fresh 档", () => {
    const legacy = mk({});
    expect("disabled" in legacy, "前置条件：夹具必须是一条真的不带该字段的旧记录").toBe(false);
    expect(keyBucket(legacy, NOW)).toBe("fresh");
    expect(keyBucket(JSON.parse(JSON.stringify(legacy)) as KeyRecord, NOW), "JSON 往返之后也一样").toBe("fresh");
  });
  it("档位集合是手写字面量，加档必须在评审里被看见；**顺序即优先级**", () => {
    expect([...BUCKETS]).toEqual(["disabled", "evicted", "cooling", "fresh"]);
  });
});

describe("序号与返回顺序", () => {
  /**
   * ⚠️ **返回顺序本身就是契约**（评审 I1）：`keysHandler` 的分页直接切这个数组，
   * 而传入顺序来自 `pool:index`，`pool-index.ts` 明写"顺序无语义"、对账会整体重排它。
   * 只断言 `seq` 不断言顺序的话，「按传入顺序返回」与「按 seq 返回」在**顺序导入的
   * 夹具上数学等价**（第 5 种假阳性）——所以这里的输入刻意是乱序的。
   */
  it("按 addedAt 升序返回，seq 从 1 开始；**与传入顺序无关**", () => {
    const views = toKeyViews([mk({ id: "c", addedAt: 30 }), mk({ id: "a", addedAt: 10 }), mk({ id: "b", addedAt: 20 })], 0);
    expect(views.map((v) => [v.id, v.seq])).toEqual([["a", 1], ["b", 2], ["c", 3]]);
  });
  it("seq 与下标严格对齐——分页切的是这个数组，错位就是翻页重复/漏项", () => {
    const views = toKeyViews([mk({ id: "e", addedAt: 5 }), mk({ id: "d", addedAt: 4 }), mk({ id: "f", addedAt: 6 })], 0);
    expect(views.map((v) => v.seq)).toEqual([1, 2, 3]);
    expect(views.map((v) => v.id)).toEqual(["d", "e", "f"]);
  });
  it("addedAt 相同时用 id 破平——否则同一批导入的 key 序号每次刷新都在跳", () => {
    const views = toKeyViews([mk({ id: "b", addedAt: 5 }), mk({ id: "a", addedAt: 5 })], 0);
    expect(views.map((v) => [v.id, v.seq])).toEqual([["a", 1], ["b", 2]]);
  });
});

describe("搜索绝不能变成明文预言机", () => {
  /**
   * `?q` 若匹配完整明文 key，管理员（或任何拿到面板口令的人）就能**逐字猜**：
   * 提交一段猜测、看返回条数，把「没有 reveal 端点」这条保证降级成一个慢速预言机。
   * ⇒ 只匹配 id 与掩码后的可见部分。
   */
  it("拿明文 key 的中间片段搜，一条都搜不到", () => {
    const [v] = toKeyViews([mk({ id: "abc123", key: "sk-headMIDDLEtail" })], 0);
    expect(matchesQuery(v!, "MIDDLE")).toBe(false);
    expect(matchesQuery(v!, "headMIDDLEtail")).toBe(false);
  });
  it("按 id 前缀、以及掩码里**看得见**的那两段能搜到（否则搜索框没用）", () => {
    const [v] = toKeyViews([mk({ id: "abc123", key: "sk-headMIDDLEtail" })], 0);
    expect(matchesQuery(v!, "abc")).toBe(true);
    expect(matchesQuery(v!, "sk-he")).toBe(true);   // maskKey 保留前 5 位
    expect(matchesQuery(v!, "tail")).toBe(true);    // maskKey 保留后 4 位
  });
  it("空查询匹配一切（筛选器不该在没输入时把列表清空）", () => {
    const [v] = toKeyViews([mk({})], 0);
    expect(matchesQuery(v!, "")).toBe(true);
  });
});

describe("bucketCounts", () => {
  it("五个数各自独立，且 all === fresh + cooling + evicted + disabled", () => {
    const views = toKeyViews([
      mk({ id: "a" }), mk({ id: "b", cooldownUntil: 5000 }),
      mk({ id: "c", evicted: true }), mk({ id: "d", evicted: true, cooldownUntil: 5000 }),
      mk({ id: "e", disabled: true }), mk({ id: "f", disabled: true, evicted: true }),
    ], 1000);
    const c = bucketCounts(views);
    // 手写字面量，不从 views 反推。
    expect(c).toEqual({ all: 6, fresh: 1, cooling: 1, evicted: 2, disabled: 2 });
    expect(c.all).toBe(c.fresh + c.cooling + c.evicted + c.disabled);
  });
});

/**
 * **约束 10（诚实标记由后端字段驱动）落在这个字段上的那一半。**
 *
 * `KeyRecord.disabled` 是可选的，而 `c.json` 会把值为 `undefined` 的字段**整个丢掉**
 * ⇒ 前端拿到「字段不存在」而不是 `false`，分不清「没停用」和「读不出来」。
 * 所以投影必须落成真布尔。
 */
describe("KeyView.disabled 恒是布尔、恒存在", () => {
  it("存量记录（没有该字段）投影出来是 false，而且这个字段活得过 JSON 往返", () => {
    const legacy = mk({});
    expect("disabled" in legacy, "前置条件：夹具必须是一条真的不带该字段的旧记录").toBe(false);
    const [v] = toKeyViews([legacy], 0);
    expect(v!.disabled).toBe(false);
    // **判据是「往返之后这个键还在」，不是「值等于 false」**：直接写 `disabled: r.disabled`
    // 时值也是 undefined ⇒ 上面那条 `toBe(false)` 会红，但真正会咬人的是这一条——
    // 端点走的是 `c.json`，JSON 序列化会把 undefined 的键整个删掉。
    const roundTripped = JSON.parse(JSON.stringify(v)) as Record<string, unknown>;
    expect(Object.keys(roundTripped), "字段缺失 ⇒ 前端分不清「没停用」和「读不出来」")
      .toContain("disabled");
    expect(roundTripped.disabled).toBe(false);
  });
  it("停用的记录投影出来是 true，并与 bucket 同步", () => {
    const [v] = toKeyViews([mk({ disabled: true })], 0);
    expect(v!.disabled).toBe(true);
    expect(v!.bucket).toBe("disabled");
  });
  /**
   * 存储被写坏成非布尔时，**投影与调度必须给出同一个答案**——各说各的就是
   * 「面板显示已停用、调度器照常用它」，本字段最难被发现的那个失败形态。
   * 三处共用 `isDisabled` 正是为了这条。
   */
  it("非布尔真值时，投影出来仍是真布尔 true，且与 isAvailable 不打架", () => {
    const broken = mk({ disabled: "yes" as unknown as boolean });
    const [v] = toKeyViews([broken], 0);
    expect(v!.disabled).toBe(true);
    expect(isAvailable(broken, 0)).toBe(false);
  });
});
