import { describe, it, expect } from "vitest";
import { narrowEntries, narrowShard } from "../../../src/core/admin/event-entry.js";

/**
 * 防住的真实故障（本计划 W2 实测，五种形态穷举）：
 * 存储里的一条畸形事件条目会让 `/admin/api/events` 直接 500，或者更糟——
 * **不 500，但把 `cursor` 变成 undefined**，让面板游标永远推不动，
 * 稳态读吞吐涨到 276,480 次/天（包线 70,560 的 3.9 倍）。
 * **这一条只在默认的「全部级别」档位下成立**：点任一个级别按钮，畸形条目被
 * `e.level === level` 滤掉、游标立刻恢复（W3 轴 ④）。默认档恰恰是最常用的一档，
 * 所以等级不降，但**不许写成「永不自愈」**。
 *
 * ⚠️ `src/adapters/logger-store.ts` 原来那句注释**没有说错**：它写的是
 * 「`get` 返回 `null` 或不是数组」当空分片处理——**那个范围它确实做到了**。
 * 问题是那个「畸形」的定义太窄，窄到把最常见的一种漏在外面：**分片本身是数组、
 * 里面的某一条不是**。措辞订正与本函数一起做，不许留着让下一个人以为这里已经安全了。
 */
describe("narrowEntries：逐条窄化", () => {
  it("null 条目被丢掉，同分片其余条目照常返回", () => {
    // 变红条件：实现只做 Array.isArray（今天的行为）⇒ null 会留在结果里
    expect(narrowEntries([null, { ts: 5, level: "info", event: "a" }]))
      .toEqual([{ ts: 5, level: "info", event: "a" }]);
  });

  it("ts 不是数字的条目被丢掉 —— 它是让 cursor 变成 undefined 的那一种", () => {
    // 变红条件：实现只查 typeof e === "object"（漏掉 ts 的类型）
    expect(narrowEntries([{ level: "info", event: "a" }, { ts: 5, level: "info", event: "b" }]))
      .toEqual([{ ts: 5, level: "info", event: "b" }]);
  });

  /**
   * **NaN / Infinity 与「缺 ts」是同一种不可用**，不是两件事：
   * `b.ts - a.ts` 得 NaN ⇒ 排序比较器恒回 NaN ⇒ 顺序不变 ⇒ items[0] 就是它；
   * 而 `c.json` 把 NaN/Infinity 序列化成 `null` ⇒ 前端读到「本页没有新事件」，
   * 与「后端在吐畸形数据」完全无法区分。
   */
  it("ts 是 NaN / Infinity / -Infinity 的条目一样被丢掉", () => {
    // 变红条件：判据只写 `typeof e.ts === "number"`，没有 Number.isFinite
    expect(narrowEntries([
      { ts: Number.NaN, level: "info", event: "nan" },
      { ts: Number.POSITIVE_INFINITY, level: "info", event: "inf" },
      { ts: Number.NEGATIVE_INFINITY, level: "info", event: "-inf" },
      { ts: 5, level: "info", event: "ok" },
    ])).toEqual([{ ts: 5, level: "info", event: "ok" }]);
  });

  it("字符串条目被丢掉 —— 它会原样出现在响应里，而内容可能来自上游", () => {
    // 变红条件：实现用 e != null 当判据（字符串非 null，会通过）
    expect(narrowEntries(["evil-string", { ts: 5, level: "info", event: "b" }]))
      .toEqual([{ ts: 5, level: "info", event: "b" }]);
  });

  /**
   * **数组条目**：`typeof [] === "object"` 且 `!== null`，所以「是对象」这个判据
   * 单独用是不够的。它没有 `ts`，靠 ts 判据被丢掉——这一格证明 ts 判据确实兜住了
   * 这一形态，不需要为它单开一条 `Array.isArray` 分支。
   */
  it("数组条目被丢掉（typeof [] 是 object，光判 object 拦不住）", () => {
    expect(narrowEntries([[], [1, 2], { ts: 5, level: "info", event: "b" }]))
      .toEqual([{ ts: 5, level: "info", event: "b" }]);
  });

  /**
   * ⚠️ **这一格与上面几格方向相反，是刻意的。**
   * 把「结构性不可用」（无法排序、无法当游标）与「显示不好看」（level 不认识）
   * 区分开，是这条设计的全部内容。分不清就会写成「凡是不完美的都丢掉」——
   * 那会在一次上游异常之后把整段证据清空。
   *
   * **后端什么都不做**：归一化已经由前端那一份在跑（`effectiveLevel()` 把畸形
   * level 归到显式的 `"unknown"` 档，`ev.level.unknown` 五语言早就有了）。
   * 后端再做一次就是同一个判据的第二份实现。
   * **代价明写**：畸形 level 的条目在「按级别筛选」时选不中（`e.level === level`
   * 恒假），只在「全部级别」下可见。**已知限制，登记不修。**
   */
  it("level 不在四个已知级别里的条目**原样保留，后端不动它的 level**", () => {
    // 变红条件：实现把畸形 level 兜底成 "info"（那是"伪造"，与产品不变式 10 矛盾）；
    //   或者整条丢掉（那是丢证据）；或者后端自己归一到 "unknown"（见上面的说明）
    expect(narrowEntries([{ ts: 5, level: "loud", event: "a" }]))
      .toEqual([{ ts: 5, level: "loud", event: "a" }]);
  });

  it("level 缺失、event 缺失、fields 是数字 —— 都只是显示问题，一律原样保留", () => {
    // 变红条件：把 level/event/fields 也列进结构性判据（那会在一次上游异常之后清空证据）
    expect(narrowEntries([{ ts: 5 }, { ts: 6, level: 7, event: null, fields: 9 }]))
      .toEqual([{ ts: 5 }, { ts: 6, level: 7, event: null, fields: 9 }]);
  });

  it("合法条目的其余字段一个都不许被改写（msg / corr / fields 原样透传）", () => {
    // 变红条件：实现顺手"清洗"了字段（截断、转义、补默认值）——那是伪造
    const one = { ts: 5, level: "warn", event: "a", msg: "m", corr: "c", fields: { k: 1 } };
    expect(narrowEntries([one])).toEqual([one]);
  });
});

describe("narrowShard：整片窄化 + 丢弃计数", () => {
  it("丢掉了几条要能被数出来 —— 静默丢弃就是撒谎", () => {
    // 变红条件：实现直接 return filtered，不交出丢弃计数
    expect(narrowShard([null, "x", { ts: 5, level: "info", event: "a" }]).malformed).toBe(2);
  });

  it("整个分片不是数组时回空分片且计 0 —— 已有行为不许回退", () => {
    // 变红条件：把原来的 Array.isArray 判据删掉
    expect(narrowShard("not-an-array")).toEqual({ entries: [], malformed: 0 });
  });

  /**
   * **`null` / `undefined` 分片必须走「空分片」这一支，不是「畸形」这一支。**
   * 它们是完全正常的路径（这把键还没被写过），实测 `errs=0`：写侧原来的
   * `(await get()) ?? []` 就把两者接住了。把它们计进 `malformed` 会让一个全新
   * 部署一上来就报「有畸形数据」——那是面板在撒谎。
   */
  it("null / undefined 分片：空分片、malformed 计 0（这是正常路径，不是畸形）", () => {
    expect(narrowShard(null)).toEqual({ entries: [], malformed: 0 });
    expect(narrowShard(undefined)).toEqual({ entries: [], malformed: 0 });
  });

  it("全是好条目时 malformed 恒为 0（挡住「把 malformed 写成常数非零」）", () => {
    expect(narrowShard([{ ts: 1, level: "info", event: "a" }, { ts: 2, level: "warn", event: "b" }]))
      .toEqual({ entries: [{ ts: 1, level: "info", event: "a" }, { ts: 2, level: "warn", event: "b" }], malformed: 0 });
  });

  it("空数组分片：entries 空、malformed 0（与「不是数组」区分开，但结果同形）", () => {
    expect(narrowShard([])).toEqual({ entries: [], malformed: 0 });
  });

  /**
   * **不就地改入参。** `narrowShard` 是纯函数（硬约束 2：`src/core/` 零 IO），
   * 写侧拿它的结果去 `appendRing` 再 `put` 回存储；如果它顺手改了入参，
   * 同一批数据在别处（例如读侧的 `mergeShards`）就会看到一份被改过的快照。
   */
  it("不就地改入参：原数组在调用后逐字节不变", () => {
    const raw: unknown[] = [null, { ts: 5, level: "info", event: "a" }];
    const snapshot = JSON.stringify(raw);
    narrowShard(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });
});
