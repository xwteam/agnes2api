import { describe, it, expect } from "vitest";
import {
  DOMAIN_LEDGER_CAP, OK_TTL_MS, BLOCK_TTL_MS,
  classifySendCode, edgeMarker, upstreamMessage, UNSAFE_UPSTREAM_MESSAGE, ADDRESS_PLACEHOLDER,
  emptyDomainLedger, narrowDomainLedger, selectDomains, isKnownGood,
  newJournal, recordVerdict, commitJournal, mergeDomainLedger, summarizeLedger,
  type DomainLedger,
} from "../../../src/core/registrar/domain-ledger.js";

const NOW = 1_700_000_000_000;

function ledgerOf(entries: DomainLedger["entries"], total: number | null = null): DomainLedger {
  return { v: 1, updatedAt: NOW - 1000, total, entries };
}

// ───────────────────────────────────────────────────────────────────────────
// 两种 400 的分辨
// ───────────────────────────────────────────────────────────────────────────

describe("classifySendCode：同一个 400 有两种含义，正文是唯一线索", () => {
  /**
   * 🔴 **承重格。** 真机上撞到的应用层限流逐字就是这个形状：`400` + 上游自己的
   * `{"code":...}` 错误体。把它读成「这个域名被屏蔽了」的后果是双重的：
   * ① 一个本来能用的域名被记成不能用；② 更要命的是处置错了 —— 换个域名接着打，
   * 而惩罚窗口里每打一次就把窗口续一次。
   *
   * **删掉这一格，缺陷会重新变成静默的**：分类器改成「400 一律 domain_blocked」
   * 之后，行为上看到的只是「补池慢了一点」。
   */
  it("400 + 限流文案 ⇒ 判成应用层限流，绝不判域名死", () => {
    expect(classifySendCode(
      400, JSON.stringify({ code: 400, message: "Too many registration attempts from this IP" }),
    )).toBe("rate_limited_app");
  });

  it("400 + 不含限流词的正文 ⇒ 才判域名被屏蔽（判死走的是负向匹配，这一格钉的就是它）", () => {
    expect(classifySendCode(400, '{"code":400,"message":"domain not allowed"}')).toBe("domain_blocked");
  });

  it("429 ⇒ 边缘限流；正文里那串记号只进事件字段，不参与判定", () => {
    // 判据是状态码。正文换成任何东西，档次都不许变——记号是别人家边缘网关的实现细节。
    expect(classifySendCode(429, "error code: 1015")).toBe("rate_limited_edge");
    expect(classifySendCode(429, "")).toBe("rate_limited_edge");
    expect(edgeMarker("error code: 1015")).toBe("1015");
    expect(edgeMarker("Too Many Requests")).toBeNull();
  });

  it("403 并进边缘限流那一档（它今天是死分支，但并进来比留一条「睡一会儿接着打」的路安全）", () => {
    expect(classifySendCode(403, "{}")).toBe("rate_limited_edge");
  });

  it("400 但正文空白 ⇒ unreadable，不产生任何域名判定", () => {
    // 负向匹配至少要先有一段正文可读。没有正文时判死就是纯粹的猜。
    expect(classifySendCode(400, "")).toBe("unreadable");
    expect(classifySendCode(400, "   \n ")).toBe("unreadable");
  });

  it("2xx ⇒ ok；其余非 2xx ⇒ upstream_error（不许混进域名那一档）", () => {
    expect(classifySendCode(200, "{}")).toBe("ok");
    expect(classifySendCode(204, "")).toBe("ok");
    expect(classifySendCode(500, "boom")).toBe("upstream_error");
    expect(classifySendCode(503, "")).toBe("upstream_error");
  });

  it("限流词表按小写子串匹配，中英文各认一批", () => {
    for (const body of [
      "TOO MANY requests", "Rate Limit exceeded", "ratelimit", "too frequent",
      "请求过于频繁", "今日注册次数过多",
    ]) {
      expect(classifySendCode(400, body), body).toBe("rate_limited_app");
    }
  });
});

describe("upstreamMessage：上游正文进事件之前先抹掉邮箱地址", () => {
  it("正文里回显的邮箱地址被换成占位符", () => {
    const out = upstreamMessage('{"message":"u0@x.test is blocked"}', "u0@x.test");
    expect(out).toContain(ADDRESS_PLACEHOLDER);
    expect(out).not.toContain("u0@x.test");
  });

  it("URL 编码形态同样抹掉", () => {
    const out = upstreamMessage("bad: u0%40x.test", "u0@x.test");
    expect(out).not.toContain("u0%40x.test");
    expect(out).toContain(ADDRESS_PLACEHOLDER);
  });

  it("超过 512 字符先截断（一张挑战页几十 KB，原样进事件环会把缓冲一次冲光）", () => {
    const out = upstreamMessage("x".repeat(5000), "u0@x.test");
    expect(out).toHaveLength(513); // 512 + 那一个省略号
  });

  /**
   * 🔴 **承重格：先脱敏、后截断。**
   *
   * **这一格的上一版用例名说的是反话，评审抓到，如实登记**：它当时叫「截断把地址切成
   * 两半时整段丢掉，而不是漏半个出去」，而两条断言是 `not.toBe(UNSAFE)` +
   * `not.toContain(完整地址)` —— 也就是**明确断言不整段丢**、只查完整地址。
   * 那时的实现是先 `bodySnippet` 再替换，地址跨在 512 那一刀上时**前半截原样留在正文里**
   *（实测尾巴是 `…yyyyu0@x…`，含地址前 4 个字符），而这一格照绿。
   * 名字听着对、断言其实在守一个已知代价 —— 本仓反复登记的那一类。
   *
   * 变异：把实现换回 `bodySnippet(body)` 之后再 `split(address)`
   * ⇒ 下面那条「地址的前缀一个字符都不许出现」当场红。
   */
  it("截断把地址切成两半时不漏地址前缀（脱敏先做，截断后做）", () => {
    const addr = "u0@x.test";
    // 让地址正好跨在 512 的边界上：先截断的话前半截会留在 snippet 里，后半截被切掉。
    const body = "y".repeat(508) + addr + "z".repeat(100);
    const out = upstreamMessage(body, addr);
    // ① 完整地址不在里面（这一档从前就守着）。
    expect(out).not.toContain(addr);
    // ② **地址的任何一段都不在里面**：手写前缀字面量，不从被测输入反查。
    expect(out).not.toContain("u0@");
    expect(out).not.toContain("u0");
    // ③ 不是「整段丢掉」那一档 —— 边界上剩下的是占位符的一部分，不是地址，
    //    正文的诊断价值（那 508 个 y）照常留着。
    expect(out).not.toBe(UNSAFE_UPSTREAM_MESSAGE);
    expect(out.startsWith("y".repeat(508))).toBe(true);
    expect(out).toHaveLength(513);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 窄化：读不出来 ⇒ 「什么都没记住」，绝不是「全被屏蔽」
// ───────────────────────────────────────────────────────────────────────────

describe("narrowDomainLedger：失败方向是刻意选的", () => {
  it("整个对象读不得 ⇒ 空台账（= 多探几次），不是「全被屏蔽」", () => {
    for (const raw of [null, undefined, 42, "x", [], { v: 2 }, { entries: 1 }]) {
      expect(narrowDomainLedger(raw).entries, JSON.stringify(raw)).toEqual({});
    }
  });

  it("单条读不得只丢那一条，别的照收", () => {
    const got = narrowDomainLedger({
      v: 1, updatedAt: 5, total: 7,
      entries: {
        good: { s: "ok", at: 1, n: 1 },
        badState: { s: "maybe", at: 1, n: 1 },
        badAt: { s: "ok", at: "x", n: 1 },
        badN: { s: "blocked", at: 1, n: null },
        notObj: 3,
      },
    });
    expect(Object.keys(got.entries)).toEqual(["good"]);
    expect(got.updatedAt).toBe(5);
    expect(got.total).toBe(7);
  });

  it("total 读不得 ⇒ null（面板上「未探过」那一格如实说不知道，不伪造成 0）", () => {
    expect(narrowDomainLedger({ v: 1, updatedAt: 1, total: "x", entries: {} }).total).toBeNull();
    expect(narrowDomainLedger({ v: 1, updatedAt: 1, total: -1, entries: {} }).total).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// selectDomains：全序排序，永不 filter
// ───────────────────────────────────────────────────────────────────────────

describe("selectDomains：好域名不可能被永久排除", () => {
  /**
   * 🔴 **承重格。** 这是「全序排序而不是 filter」那条结构性保证的唯一正面判据。
   *
   * 变异：把实现写成 `allDomains.filter((d) => 台账里不是 blocked)` ⇒ 返回空数组
   * ⇒ `mintOne` 拿到零个候选 ⇒ 每一轮 `attempted` 都在但一次上游请求都发不出去，
   * 而**面板上看不出任何原因**。
   */
  it("全表判死时选择器仍返回非空，且第一个是 at 最旧的那个", () => {
    // 374 个域名全部 `blocked`、`n=5`、**全都在 BLOCK_TTL 之内**（离过期还早）。
    // `at` 刻意错开：只有错开，「最旧的排在最前面」这句话才有可判定的含义。
    const entries: DomainLedger["entries"] = {};
    const all: string[] = [];
    for (let i = 0; i < 374; i++) {
      const d = `d${String(i).padStart(3, "0")}.test`;
      all.push(d);
      entries[d] = { s: "blocked", at: NOW - i, n: 5 };
    }
    const got = selectDomains(ledgerOf(entries), all, NOW, 1, () => 0.5);
    expect(got).not.toEqual([]);
    // `at` 最小 = NOW - 373 = 最后那一个域名。手写下标，不从被测对象反查。
    expect(got[0]).toBe("d373.test");
  });

  it("已知 ok 且没过期的排在最前面，且同档内按 at 旧→新轮换（别把一个好域名打成风控焦点）", () => {
    const got = selectDomains(
      ledgerOf({
        fresh: { s: "ok", at: NOW - 10, n: 3 },
        stale: { s: "ok", at: NOW - 1000, n: 1 },
        dead: { s: "blocked", at: NOW, n: 4 },
      }),
      ["dead", "fresh", "stale", "never"], NOW, 4, () => 0,
    );
    expect(got.slice(0, 2)).toEqual(["stale", "fresh"]);
    // 没探过的排在 ok 之后、判死之前。
    expect(got[2]).toBe("never");
    expect(got[3]).toBe("dead");
  });

  it("blocked 但只挨过一次（n=1）算「可疑」，排在未知之后、真判死之前 —— 它仍然会被选中", () => {
    const got = selectDomains(
      ledgerOf({
        suspect: { s: "blocked", at: NOW, n: 1 },
        dead: { s: "blocked", at: NOW, n: 2 },
      }),
      ["dead", "suspect", "never"], NOW, 3, () => 0,
    );
    expect(got).toEqual(["never", "suspect", "dead"]);
  });

  it("blocked 过了 24 小时就退回可疑档（一条错记录的寿命上界）", () => {
    const got = selectDomains(
      ledgerOf({
        expired: { s: "blocked", at: NOW - BLOCK_TTL_MS, n: 9 },
        dead: { s: "blocked", at: NOW, n: 9 },
      }),
      ["dead", "expired"], NOW, 2, () => 0,
    );
    expect(got).toEqual(["expired", "dead"]);
  });

  it("ok 过了 7 天退回「未知」档，不再享受第一档的优先次序", () => {
    const got = selectDomains(
      ledgerOf({ old: { s: "ok", at: NOW - OK_TTL_MS, n: 1 }, live: { s: "ok", at: NOW, n: 1 } }),
      ["old", "live"], NOW, 2, () => 0,
    );
    expect(got).toEqual(["live", "old"]);
  });

  it("空域名表 ⇒ 空结果（没有域名可挑就是没有，不编一个出来）", () => {
    expect(selectDomains(emptyDomainLedger(), [], NOW, 5, () => 0)).toEqual([]);
  });

  it("limit 是 0 或负数时仍然给一个候选 —— 本函数的全部价值就在于永不返回空", () => {
    expect(selectDomains(emptyDomainLedger(), ["a", "b"], NOW, 0, () => 0)).toHaveLength(1);
    expect(selectDomains(emptyDomainLedger(), ["a", "b"], NOW, -3, () => 0)).toHaveLength(1);
  });

  /**
   * 🔴 **承重格：轮内轮换。**
   *
   * 台账**轮内不更新**（落盘统一在收尾），而这一档是按 `at` 的全序排序 ⇒ 不给
   * `used` 的话，同一份台账连调几次拿到的**永远是同一个域名**。默认
   * `MAX_DOMAIN_ATTEMPTS = 1` 时那就是「一轮 5 个名额全打同一个域名」，
   * 而本函数的 JSDoc 逐字写着「LRU 轮换，别把一个好域名打成上游风控的焦点」。
   *
   * 变异：删掉排序里的 `spent` 那一项 ⇒ 三次全是 `p.test` ⇒ 红。
   */
  it("本轮已经派出去过的域名在自己那一档里排到后面（`at` 轮内不变，光靠它每个名额都会拿到同一个）", () => {
    const ledger = ledgerOf({
      "p.test": { s: "ok", at: NOW - 300, n: 1 },
      "q.test": { s: "ok", at: NOW - 200, n: 1 },
      "r.test": { s: "ok", at: NOW - 100, n: 1 },
    });
    const all = ["p.test", "q.test", "r.test"];
    const used = new Map<string, number>();
    const picked: string[] = [];
    // 名额数刻意多于域名数：数的是**次数**不是「派过没派过」，所以第 4、5 个名额
    // 要接着轮转回去，而不是塌回「谁的 at 最旧就一直是谁」。
    for (let i = 0; i < 5; i++) {
      const got = selectDomains(ledger, all, NOW, 1, () => 0.5, used);
      picked.push(got[0]!);
      for (const d of got) used.set(d, (used.get(d) ?? 0) + 1);
    }
    // 手写字面量：`at` 旧→新，而每挑走一个就把它挪到本档后面。
    expect(picked).toEqual(["p.test", "q.test", "r.test", "p.test", "q.test"]);
    // 反向控制：**不传 `used` 就是旧行为**（同一份台账连调五次全是同一个）——
    // 这一行说明上面那几个不同的名字确实来自 `used`，不是来自别的什么。
    expect([0, 1, 2, 3, 4].map(() => selectDomains(ledger, all, NOW, 1, () => 0.5)[0]))
      .toEqual(["p.test", "p.test", "p.test", "p.test", "p.test"]);
  });

  it("轮换只在档内发生：一个已知 ok 的域名派出去过之后，仍排在判死的那些前面", () => {
    const ledger = ledgerOf({
      "good.test": { s: "ok", at: NOW - 100, n: 1 },
      "dead.test": { s: "blocked", at: NOW - 999, n: 3 },
    });
    const got = selectDomains(
      ledger, ["good.test", "dead.test"], NOW, 2, () => 0, new Map([["good.test", 3]]),
    );
    // 全表只剩这一个 ok 域名时，「还是它」才是对的：跨档轮换等于主动去打已知不行的域名。
    expect(got).toEqual(["good.test", "dead.test"]);
  });

  it("未知那一档真的用注入的 rand 洗牌（不是原样照抄上游返回的顺序）", () => {
    const all = ["a", "b", "c", "d"];
    const asc = selectDomains(emptyDomainLedger(), all, NOW, 4, () => 0);
    const other = selectDomains(emptyDomainLedger(), all, NOW, 4, () => 0.999);
    expect(asc.slice().sort()).toEqual([...all].sort());
    expect(other).not.toEqual(asc);
  });
});

describe("isKnownGood：mintOne 那条「点名一个已知能用的域名被拒了」的诊断取的就是它", () => {
  it("ok 且没过期 ⇒ 真；过期 / blocked / 不在表里 ⇒ 假", () => {
    const l = ledgerOf({
      fresh: { s: "ok", at: NOW, n: 1 },
      old: { s: "ok", at: NOW - OK_TTL_MS, n: 1 },
      bad: { s: "blocked", at: NOW, n: 1 },
    });
    expect(isKnownGood(l, "fresh", NOW)).toBe(true);
    expect(isKnownGood(l, "old", NOW)).toBe(false);
    expect(isKnownGood(l, "bad", NOW)).toBe(false);
    expect(isKnownGood(l, "never", NOW)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// commitJournal：两跳判死 + 一轮最多学一条
// ───────────────────────────────────────────────────────────────────────────

describe("commitJournal", () => {
  /**
   * 🔴 **承重格：一轮最多学一条 blocked。**
   *
   * 这是**唯一与上游文案无关**的那道防线。词表是启发式的，上游改一次措辞、
   * 或者把响应语言换掉，`classifySendCode` 的正向识别就漏；那时一轮里连着好几个
   * 域名全挂就会被逐条记成「域名被屏蔽」。
   *
   * ⚠️ **删掉这一格，那个缺陷就重新变成静默的** —— 形态与
   * `src/core/admin/tend-guard.ts` 登记的「读法 A 的唯一检测点」逐字同源。
   */
  it("一轮里冒出第 2 条疑似 blocked ⇒ 本轮的域名判定整体作废（文案无关的钳位）", () => {
    const j = newJournal();
    for (let i = 0; i < 8; i++) recordVerdict(j, `d${i}.test`, "blocked");
    const got = commitJournal(emptyDomainLedger(), j, NOW, 374);
    expect(Object.keys(got.next.entries)).toEqual([]);
    expect(got.discarded).toBe(8);
    expect(got.newlyBlocked).toEqual([]);
  });

  it("钳位只作废 blocked，2xx 那些照常写入（一次成功是干净可靠的证据）", () => {
    const j = newJournal();
    recordVerdict(j, "good.test", "ok");
    recordVerdict(j, "a.test", "blocked");
    recordVerdict(j, "b.test", "blocked");
    const got = commitJournal(emptyDomainLedger(), j, NOW, 374);
    expect(got.next.entries).toEqual({ "good.test": { s: "ok", at: NOW, n: 1 } });
    expect(got.discarded).toBe(2);
  });

  /**
   * 🔴 **承重格：两跳必须来自两轮。**
   *
   * **这一格的上一版把一个洞固化成了「性质」，评审抓到，如实登记**：它当时断言的是
   * `n: 2` —— 也就是「同一个域名在一轮里被拒两次就直接判死」。钳位数的是**域名数**
   *（`Set`，size 还是 1 ⇒ 不触发），而 `n` 当时按**观测条数**累加 ⇒ **一轮之内从
   * unknown 判死**并发出 `registrar.domain_blocked`，而
   * `src/core/registrar/domain-ledger.ts` 的文件头逐字把「判死要两跳」登记为压着误判的
   * 第一层、「一次误分类只让好域名短暂降权」。那一版还**不断言 `newlyBlocked`**，
   * 于是「一轮之内就发判死事件」这件事没有任何机器守着。
   *
   * 可达性不是理论的：台账暖起来之后 `selectDomains` 在一轮之内会**确定性地**把同一个
   * 域名派给每个名额（本文件里「本轮已经派出去过的域名在自己那一档里排到后面（`at` 轮内
   * 不变，光靠它每个名额都会拿到同一个）」那一格钉着修法）。
   *
   * 变异：把折叠去掉（`n` 改回按观测条数累加）⇒ `n` 变 2、`newlyBlocked` 冒出一条 ⇒ 红。
   */
  it("同一个域名在一轮里被判两次 blocked 只算一跳：n 到 1 为止，且不发判死", () => {
    const j = newJournal();
    recordVerdict(j, "a.test", "blocked");
    recordVerdict(j, "a.test", "blocked");
    const got = commitJournal(emptyDomainLedger(), j, NOW, 374);
    // 钳位数的是域名数，这一轮只有一个域名 ⇒ 不触发。
    expect(got.discarded).toBe(0);
    expect(got.next.entries["a.test"]).toEqual({ s: "blocked", at: NOW, n: 1 });
    // 第二跳只能来自下一轮 ⇒ 这一轮一条判死事件都不许有。
    expect(got.newlyBlocked).toEqual([]);
  });

  it("一轮里同一个域名先被拒后成功 ⇒ 这一轮的结论是 ok，也不去凑钳位那个域名数", () => {
    const j = newJournal();
    recordVerdict(j, "a.test", "blocked", "上游那句话");
    recordVerdict(j, "a.test", "ok");
    recordVerdict(j, "b.test", "blocked");
    const got = commitJournal(emptyDomainLedger(), j, NOW, 374);
    // a 折叠成 ok（一次 2xx 是干净可靠的证据），于是「疑似 blocked 的域名」只剩 b 一个
    // ⇒ 钳位不触发，b 照常记第一跳。
    expect(got.discarded).toBe(0);
    expect(got.next.entries["a.test"]).toEqual({ s: "ok", at: NOW, n: 1 });
    expect(got.next.entries["b.test"]).toEqual({ s: "blocked", at: NOW, n: 1 });
  });

  it("判死要两跳：第一次只写 n=1（可疑），第二次才 n>=2 并进 newlyBlocked", () => {
    const j1 = newJournal();
    recordVerdict(j1, "a.test", "blocked");
    const one = commitJournal(emptyDomainLedger(), j1, NOW, 374);
    expect(one.next.entries["a.test"]).toEqual({ s: "blocked", at: NOW, n: 1 });
    expect(one.newlyBlocked).toEqual([]);

    const j2 = newJournal();
    recordVerdict(j2, "a.test", "blocked", "上游那句话");
    const two = commitJournal(one.next, j2, NOW + 1, 374);
    expect(two.next.entries["a.test"]).toEqual({ s: "blocked", at: NOW + 1, n: 2 });
    expect(two.newlyBlocked).toEqual([{ domain: "a.test", n: 2, message: "上游那句话" }]);
  });

  it("已经判死的域名再挨一次不重复记事件（事件环只有 100 格，别把诊断挤出去）", () => {
    const j = newJournal();
    recordVerdict(j, "a.test", "blocked");
    const got = commitJournal(ledgerOf({ "a.test": { s: "blocked", at: NOW - 1, n: 2 } }), j, NOW, 374);
    expect(got.next.entries["a.test"]!.n).toBe(3);
    expect(got.newlyBlocked).toEqual([]);
  });

  it("一次 2xx 无条件把判死覆盖回 ok，n 归 1", () => {
    const j = newJournal();
    recordVerdict(j, "a.test", "ok");
    const got = commitJournal(ledgerOf({ "a.test": { s: "blocked", at: NOW - 1, n: 9 } }), j, NOW, 374);
    expect(got.next.entries["a.test"]).toEqual({ s: "ok", at: NOW, n: 1 });
  });

  it("空本子 ⇒ dirty 为假（调用方据此一次 put 都不发），且 total 没变时也不脏", () => {
    const got = commitJournal(ledgerOf({}, 374), newJournal(), NOW, 374);
    expect(got.dirty).toBe(false);
    expect(got.next.updatedAt).toBe(NOW - 1000);
  });

  it("上游域名总数变了也算脏（面板那一格要跟着走）", () => {
    const got = commitJournal(ledgerOf({}, 374), newJournal(), NOW, 375);
    expect(got.dirty).toBe(true);
    expect(got.next.total).toBe(375);
  });

  it("这一轮没问到域名总数时不动 total（「没问到」不是「上游只有 0 个」）", () => {
    const got = commitJournal(ledgerOf({}, 374), newJournal(), NOW, null);
    expect(got.next.total).toBe(374);
    expect(got.dirty).toBe(false);
  });

  /**
   * **值的有界性**：这把键的**数量**恒为 1，但它的**值**是按上游 `listDomains()`
   * 的返回长起来的。键空间有界不等于值有界 —— 这根轴必须显式关掉。
   */
  it("条目数超过上限时按 at 丢最旧的（键空间有界不等于值有界）", () => {
    const entries: DomainLedger["entries"] = {};
    for (let i = 0; i < DOMAIN_LEDGER_CAP + 5; i++) {
      entries[`d${String(i).padStart(4, "0")}.test`] = { s: "ok", at: NOW - (DOMAIN_LEDGER_CAP + 5 - i), n: 1 };
    }
    const got = commitJournal(ledgerOf(entries), newJournal(), NOW, 374);
    expect(Object.keys(got.next.entries)).toHaveLength(DOMAIN_LEDGER_CAP);
    // 丢的是最旧的那 5 个，手写下标。
    expect(got.next.entries["d0000.test"]).toBeUndefined();
    expect(got.next.entries["d0004.test"]).toBeUndefined();
    expect(got.next.entries["d0005.test"]).toBeDefined();
    expect(got.dirty).toBe(true);
  });
});

describe("mergeDomainLedger：KV 没有 CAS，写回一律先 get 再 merge", () => {
  it("同名域名取 at 更新的那一条（丢更新的后果从「覆盖」降到「取更新的那个」）", () => {
    const got = mergeDomainLedger(
      ledgerOf({ a: { s: "ok", at: NOW, n: 3 }, b: { s: "ok", at: NOW, n: 1 } }, 374),
      ledgerOf({ a: { s: "blocked", at: NOW - 100, n: 1 }, c: { s: "ok", at: NOW, n: 1 } }, 375),
    );
    expect(got.entries.a).toEqual({ s: "ok", at: NOW, n: 3 });
    expect(got.entries.b).toBeDefined();
    expect(got.entries.c).toBeDefined();
    expect(got.total).toBe(375);
  });

  it("合并之后同样受条目上限约束", () => {
    const cur: DomainLedger["entries"] = {};
    const next: DomainLedger["entries"] = {};
    for (let i = 0; i < 400; i++) cur[`c${i}`] = { s: "ok", at: NOW - 400 + i, n: 1 };
    for (let i = 0; i < 400; i++) next[`n${i}`] = { s: "ok", at: NOW + i, n: 1 };
    const got = mergeDomainLedger(ledgerOf(cur), ledgerOf(next));
    expect(Object.keys(got.entries)).toHaveLength(DOMAIN_LEDGER_CAP);
  });
});

describe("summarizeLedger：面板那一行的取数", () => {
  it("四格各按各的判据数，未探过是 total 减出来的", () => {
    const got = summarizeLedger(ledgerOf({
      ok1: { s: "ok", at: NOW, n: 1 },
      ok2: { s: "ok", at: NOW, n: 2 },
      dead: { s: "blocked", at: NOW, n: 3 },
      suspect: { s: "blocked", at: NOW, n: 1 },
      expiredBlock: { s: "blocked", at: NOW - BLOCK_TTL_MS, n: 5 },
      expiredOk: { s: "ok", at: NOW - OK_TTL_MS, n: 1 },
    }, 10), NOW);
    // 手写字面量：ok 2 个、判死 1 个、可疑 2 个（n=1 那个 + 过期那个），
    // 过期的 ok 一格都不计（它在选择器里退回未知档）。
    expect(got.ok).toBe(2);
    expect(got.blocked).toBe(1);
    expect(got.suspect).toBe(2);
    expect(got.unknown).toBe(10 - 2 - 1 - 2);
    expect(got.size).toBe(6);
    expect(got.cap).toBe(DOMAIN_LEDGER_CAP);
  });

  it("总数不知道时「未探过」如实回 null，不伪造成 0", () => {
    const got = summarizeLedger(emptyDomainLedger(), NOW);
    expect(got.total).toBeNull();
    expect(got.unknown).toBeNull();
    expect(got.updatedAt).toBeNull();
  });
});
