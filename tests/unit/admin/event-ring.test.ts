import { describe, it, expect } from "vitest";
import {
  EVENT_RING_SIZE, EVENT_FLUSH_MIN_INTERVAL_MS, EVENT_WRITES_PER_DAY,
  EVENT_WINDOW_MS, EVENT_SLOTS, EVENT_WINDOW_RETAIN, EVENT_TTL_MARGIN_MS,
  windowIndex, slotOf, shardKey, candidateKeys, eventExpiresAt,
  appendRing, truncatedCount, mergeShards,
  FRESH_BUDGET, canWrite, consume,
} from "../../../src/core/admin/event-ring.js";
import type { LogEntry } from "../../../src/ports/logger.js";

function entry(event: string, ts = 0): LogEntry {
  return { ts, level: "info", event };
}

describe("常量", () => {
  it("字面量本身是策略，独立钉死", () => {
    expect(EVENT_RING_SIZE).toBe(100);
    expect(EVENT_FLUSH_MIN_INTERVAL_MS).toBe(60_000);
    expect(EVENT_WRITES_PER_DAY).toBe(12);
    expect(EVENT_WINDOW_MS).toBe(3_600_000);
    expect(EVENT_SLOTS).toBe(2);
    expect(EVENT_WINDOW_RETAIN).toBe(24);
  });
});

describe("windowIndex", () => {
  it("按 EVENT_WINDOW_MS 整除取窗口号（手写字面量）", () => {
    expect(windowIndex(0)).toBe(0);
    expect(windowIndex(3_599_999)).toBe(0);
    expect(windowIndex(3_600_000)).toBe(1);
    expect(windowIndex(7_199_999)).toBe(1);
    expect(windowIndex(7_200_000)).toBe(2);
  });

  /**
   * **评审 F5**：`events.ts` 里 `cursorAhead` 的判据是
   * `windowIndex(after) > windowIndex(now)`——这里直接证明这条判据看的是
   * "有没有跨过窗口边界"，与偏移量的绝对大小无关，防止"1 小时"这个窗口宽度
   * 被误读成"至少要偏移这么多才会触发"这个门槛。
   */
  it("窗口号是否领先只看有没有跨过边界，与偏移量大小无关（评审 F5 的反例，两组都实测过）", () => {
    // 偏移仅 2 毫秒，但恰好跨在窗口边界上：仍然领先一个窗口。
    const now1 = 3_599_999; // 窗口 0 的最后 1ms
    const after1 = now1 + 2; // 落进窗口 1 的第 1ms
    expect(windowIndex(after1) > windowIndex(now1), "2ms 但跨了边界，应该领先").toBe(true);

    // 偏移足足 59 分钟，但两者仍落在同一个窗口内：不领先。
    const now2 = 0;
    const after2 = now2 + 59 * 60 * 1000;
    expect(windowIndex(after2) > windowIndex(now2), "59 分钟但没跨边界，不该领先").toBe(false);
  });
});

describe("slotOf：确定性、稳定，值域在 [0, EVENT_SLOTS)", () => {
  it("同一个 shardId 任何时候算出来的槽位都一样", () => {
    const a = slotOf("shard-abc");
    const b = slotOf("shard-abc");
    expect(a).toBe(b);
  });
  it("值域落在 [0, EVENT_SLOTS)", () => {
    for (const id of ["a", "shard-1", "shard-2", "xyz789", "", "长一点的一个字符串id"]) {
      const s = slotOf(id);
      expect(s, id).toBeGreaterThanOrEqual(0);
      expect(s, id).toBeLessThan(EVENT_SLOTS);
    }
  });
  it("不同输入允许落在不同槽位（不是恒返回同一个值——反形状断言）", () => {
    const slots = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map(slotOf));
    expect(slots.size, "8 个不同输入至少要分散到不止 1 个槽位").toBeGreaterThan(1);
  });
});

describe("shardKey / candidateKeys：有界且可从时钟直接算出来（C2 根治的依据）", () => {
  it("shardKey 格式（手写字面量）", () => {
    expect(shardKey(0, 0)).toBe("event:0:0");
    expect(shardKey(5, 1)).toBe("event:5:1");
  });

  it("after === null（冷读）：回看 EVENT_WINDOW_RETAIN 个窗口 × EVENT_SLOTS 槽位（手写字面量总数）", () => {
    const now = 100 * EVENT_WINDOW_MS; // 第 100 个窗口
    const keys = candidateKeys(now, null);
    expect(keys.length).toBe(EVENT_WINDOW_RETAIN * EVENT_SLOTS);
    expect(keys.length).toBe(48);
    // 首尾窗口号：从 (100 - 24 + 1) 到 100。
    expect(keys[0]).toBe("event:77:0");
    expect(keys[keys.length - 1]).toBe("event:100:1");
  });

  it("after 与 now 同一个窗口内（暖读稳态）：只有 EVENT_SLOTS 个候选键", () => {
    const now = 10 * EVENT_WINDOW_MS + 1000;
    const after = 10 * EVENT_WINDOW_MS + 500; // 同一个窗口
    const keys = candidateKeys(now, after);
    expect(keys.length).toBe(EVENT_SLOTS);
    expect(keys).toEqual(["event:10:0", "event:10:1"]);
  });

  it("after 落在上一个窗口（跨窗口边界那一刻）：EVENT_SLOTS × 2 个候选键，不随保留窗口数增长", () => {
    const now = 11 * EVENT_WINDOW_MS + 10;
    const after = 10 * EVENT_WINDOW_MS + EVENT_WINDOW_MS - 10; // 上一个窗口的尾巴
    const keys = candidateKeys(now, after);
    expect(keys.length).toBe(EVENT_SLOTS * 2);
    expect(keys).toEqual(["event:10:0", "event:10:1", "event:11:0", "event:11:1"]);
  });

  it("after 与 now 在同一个窗口内（暖读稳态、游标新鲜）时只有 EVENT_SLOTS 个候选键", () => {
    const now = 10_000 * EVENT_WINDOW_MS + 1000; // 很晚的一个窗口，模拟部署已经跑了很久
    const after = 10_000 * EVENT_WINDOW_MS + 500; // 仍在同一个窗口
    expect(candidateKeys(now, after).length).toBe(EVENT_SLOTS);
  });

  /**
   * **评审 C4/C4b：这是取代原来那条「暖读候选键数与 EVENT_WINDOW_RETAIN 无关」用例
   * 的版本。原用例是本项目登记的第五种假阳性**——它把 `now` 推到第 10,000 个窗口，
   * 却把 `after` **钉在同一个窗口里**，唯一能让候选键数增长的自由度（`after` 相对
   * `now` 的陈旧程度）被按住了，用例名字声称的性质（"与保留窗口数无关"）比用例体
   * 实际检验的性质（"两者在同一个窗口时是 2 个"）强得多——它只能证明"新鲜游标下
   * 候选键数很小"，证明不了"陈旧游标下候选键数不会爆炸"，而后者才是 C4/C4b 真正
   * 要守住的性质。
   *
   * 这条改成让 `after` **真的陈旧**（比 `now` 早 100 个窗口，远超 `EVENT_WINDOW_RETAIN`
   * 的 24），断言候选键数被钳位在 `EVENT_WINDOW_RETAIN × EVENT_SLOTS`，**不会**
   * 随陈旧程度继续增长——这正是评审实测出"单次请求 99 万次 get"的那个口子，
   * 也是这条用例现在真正在守的东西。
   */
  it("after 严重陈旧（远超保留窗口数）时，候选键数被钳位，不随陈旧程度继续增长（评审 C4/C4b）", () => {
    const now = 10_000 * EVENT_WINDOW_MS + 1000;
    const veryStaleAfter = 9_900 * EVENT_WINDOW_MS; // 比 now 早 100 个窗口，远超 RETAIN=24
    const keys = candidateKeys(now, veryStaleAfter);
    expect(keys.length).toBe(EVENT_WINDOW_RETAIN * EVENT_SLOTS);
    expect(keys.length).toBe(48);
  });

  it("after=0（评审 C4 点名的敌意/极端输入）时，候选键数与冷读完全相同，恰好 48（手写字面量）", () => {
    const now = 10_000 * EVENT_WINDOW_MS + 1000;
    expect(candidateKeys(now, 0).length).toBe(48);
    expect(candidateKeys(now, 0)).toEqual(candidateKeys(now, null));
  });

  it("after 是很大的负数（评审 C4 点名的敌意输入）时，candidateKeys 自身也钳位安全（不依赖 HTTP 层已经拒绝负数这个前提）", () => {
    const now = 10_000 * EVENT_WINDOW_MS + 1000;
    expect(candidateKeys(now, -1e11).length).toBe(48);
  });

  /**
   * **评审 C6**：`after` 所在的窗口比 `now` 所在的窗口还晚（时钟回拨 / isolate 间
   * 时钟偏移写出的未来 `ts` 被当成 cursor）时，扫描区间是空的——这不是一个"读到
   * 0 条事件"的正常结果，`events.ts` 的 `cursorAhead` 字段就是为了让调用方能把
   * 这种情况和"确实没有新事件"区分开。这里先钉住 `candidateKeys` 本身的行为：
   * 空区间不会抛错、也不会因为 `fromWindow > nowWindow` 而反向遍历出奇怪的结果。
   */
  it("after 领先于 now（游标在未来）时返回空数组，不抛错、不反向遍历", () => {
    const now = 10_000 * EVENT_WINDOW_MS;
    const futureAfter = now + 10 * EVENT_WINDOW_MS;
    expect(candidateKeys(now, futureAfter)).toEqual([]);
  });
});

/**
 * **评审 C5（第二次修复）**：存储侧的有界性改走 TTL，`eventExpiresAt(at)` 是
 * `Storage.put()` 第三个参数的来源，见该函数与 `src/adapters/logger-store.ts`
 * 的说明。
 */
describe("eventExpiresAt：TTL 精确到手算字面量（评审 C5）", () => {
  it("EVENT_TTL_MARGIN_MS 就是 EVENT_WINDOW_MS 本身——钉住这条关系，不是钉住某个具体数值", () => {
    expect(EVENT_TTL_MARGIN_MS).toBe(EVENT_WINDOW_MS);
  });

  it("windowIndex(at)=0 时，过期时刻精确等于手算的 90,000,000（=(0+24)×3,600,000+3,600,000）", () => {
    expect(eventExpiresAt(1000)).toBe(90_000_000);
    // 同一个窗口内任何 at 值都落在同一个 window，算出同一个过期时刻。
    expect(eventExpiresAt(0)).toBe(90_000_000);
    expect(eventExpiresAt(EVENT_WINDOW_MS - 1)).toBe(90_000_000);
  });

  it("非零窗口下同样精确等于手算字面量（=(10,000+24)×3,600,000+3,600,000）", () => {
    expect(eventExpiresAt(10_000 * EVENT_WINDOW_MS)).toBe(36_090_000_000);
  });

  /**
   * **行为性质，不只是孤立的算式**：TTL 必须晚于这把键在 `candidateKeys` 眼里
   * "结构性不可达"的那一刻，否则会出现"读路径还认为这把键该在，物理上却已经
   * 被存储清掉"的边界竞态（`eventExpiresAt` 文档注释里论证过的那条理由）。
   * 这里直接用 `candidateKeys` 验证这条关系，不是重新抄一遍公式再互相打对号
   * （那样两边算法一起错也测不出来）。
   */
  it("过期时刻晚于这把键结构性不可达的那一刻，TTL 不会抢在读路径前面清掉还该在的键", () => {
    const at = 5 * EVENT_WINDOW_MS + 1234; // 任意选一个不在窗口边界上的时刻
    const w = windowIndex(at);
    const key = shardKey(w, 0);
    const justBeforeUnreachable = (w + EVENT_WINDOW_RETAIN) * EVENT_WINDOW_MS - 1;
    const firstUnreachableInstant = (w + EVENT_WINDOW_RETAIN) * EVENT_WINDOW_MS;

    expect(candidateKeys(justBeforeUnreachable, null).includes(key),
      "前置条件：再晚 1ms 才不可达之前，这把键应该还在候选范围里").toBe(true);
    expect(candidateKeys(firstUnreachableInstant, null).includes(key),
      "前置条件：这一刻起这把键确实已经结构性不可达了").toBe(false);
    expect(eventExpiresAt(at), "TTL 应该比结构性不可达的那一刻更晚，留出余量")
      .toBeGreaterThan(firstUnreachableInstant);
  });
});

describe("appendRing：超限时丢最旧的", () => {
  it("造 120 条，留下的是第 21..120 条（手写字面量的首尾 id，不是长度断言）", () => {
    const add = Array.from({ length: 120 }, (_, i) => entry(`e${i + 1}`, i + 1));
    const out = appendRing([], add);
    expect(out.length).toBe(100);
    expect(out[0]!.event).toBe("e21");
    expect(out[out.length - 1]!.event).toBe("e120");
  });

  it("cur 与 add 分开累积，超限一样丢最旧的", () => {
    const cur = Array.from({ length: 80 }, (_, i) => entry(`c${i + 1}`, i + 1));
    const add = Array.from({ length: 40 }, (_, i) => entry(`a${i + 1}`, 80 + i + 1));
    const out = appendRing(cur, add);
    expect(out.length).toBe(100);
    expect(out[0]!.event).toBe("c21");
    expect(out[out.length - 1]!.event).toBe("a40");
  });

  it("size 未超限时原样返回全部", () => {
    const cur = [entry("x", 1)];
    const add = [entry("y", 2)];
    expect(appendRing(cur, add).map((e) => e.event)).toEqual(["x", "y"]);
  });

  it("不就地改入参数组（返回新数组）", () => {
    const cur = [entry("c1", 1)];
    const add = [entry("a1", 2)];
    const curSnapshot = [...cur];
    const addSnapshot = [...add];
    appendRing(cur, add, 1);
    expect(cur).toEqual(curSnapshot);
    expect(add).toEqual(addSnapshot);
  });

  it("自定义 size 参数生效", () => {
    const add = [entry("e1", 1), entry("e2", 2), entry("e3", 3)];
    const out = appendRing([], add, 2);
    expect(out.map((e) => e.event)).toEqual(["e2", "e3"]);
  });
});

describe("truncatedCount：算出 appendRing 这一次会截掉多少条已落盘的旧事件（评审 I1）", () => {
  it("不超限时是 0", () => {
    expect(truncatedCount(50, 30, 100)).toBe(0);
    expect(truncatedCount(0, 100, 100)).toBe(0);
  });
  it("超限时精确等于超出的条数（手写字面量）", () => {
    expect(truncatedCount(80, 40, 100)).toBe(20);
    expect(truncatedCount(100, 1, 100)).toBe(1);
  });
  it("与 appendRing 的实际截断行为一致（关系断言：两条独立实现互相印证）", () => {
    const cur = Array.from({ length: 70 }, (_, i) => entry(`c${i}`, i));
    const add = Array.from({ length: 50 }, (_, i) => entry(`a${i}`, 100 + i));
    const merged = appendRing(cur, add, 100);
    const actualDropped = cur.length + add.length - merged.length;
    expect(truncatedCount(cur.length, add.length, 100)).toBe(actualDropped);
    expect(actualDropped).toBe(20);
  });
});

describe("mergeShards：按 ts 降序，同 ts 用 (shard, 序号) 稳定破平", () => {
  it("不同 ts 的条目按降序归并（最新在前）", () => {
    const a = [entry("a-new", 300), entry("a-old", 100)];
    const b = [entry("b-mid", 200)];
    expect(mergeShards([a, b], 10).map((e) => e.event)).toEqual(["a-new", "b-mid", "a-old"]);
  });

  it("同 ts 时按分片序号破平（跑两遍顺序一致，不是引擎巧合稳定）", () => {
    const a = [entry("from-a", 100)];
    const b = [entry("from-b", 100)];
    const run1 = mergeShards([a, b], 10).map((e) => e.event);
    const run2 = mergeShards([a, b], 10).map((e) => e.event);
    expect(run1).toEqual(["from-a", "from-b"]);
    expect(run2).toEqual(run1);
  });

  it("同一分片内同 ts 的多条按原始序号（写入顺序）破平", () => {
    const a = [entry("first", 100), entry("second", 100)];
    expect(mergeShards([a], 10).map((e) => e.event)).toEqual(["first", "second"]);
  });

  it("limit 截断保留最新的那些", () => {
    const a = [entry("newest", 300), entry("mid", 200), entry("oldest", 100)];
    expect(mergeShards([a], 2).map((e) => e.event)).toEqual(["newest", "mid"]);
  });

  it("空分片列表 / 空分片本身都不炸", () => {
    expect(mergeShards([], 10)).toEqual([]);
    expect(mergeShards([[], []], 10)).toEqual([]);
  });
});

describe("canWrite / consume：写预算（按天，不再按小时——见 EVENT_WRITES_PER_DAY 的说明）", () => {
  it("同一天内：第 12 次可写、第 13 次不可写（边界值手写字面量）", () => {
    let b = FRESH_BUDGET;
    for (let i = 0; i < 11; i++) b = consume(b, 1000);
    expect(canWrite(b, 1000), "用了 11 次之后，第 12 次应当可写").toBe(true);
    b = consume(b, 1000);
    expect(canWrite(b, 1000), "用了 12 次之后，第 13 次应当不可写").toBe(false);
  });

  it("perDay 参数可覆盖默认值", () => {
    let b = FRESH_BUDGET;
    b = consume(b, 0);
    expect(canWrite(b, 0, 1), "perDay=1 时用掉 1 次即耗尽").toBe(false);
    expect(canWrite(b, 0, 2), "perDay=2 时用掉 1 次仍可写").toBe(true);
  });

  it("跨过一天时归零：at 落在 24 小时之后", () => {
    let b = FRESH_BUDGET;
    for (let i = 0; i < 12; i++) b = consume(b, 1000);
    expect(canWrite(b, 1000), "本日用满").toBe(false);
    const nextDay = 1000 + 86_400_000;
    expect(canWrite(b, nextDay), "跨过一天后应当归零").toBe(true);
    const b2 = consume(b, nextDay);
    expect(b2).toEqual({ dayStart: nextDay, used: 1 });
  });

  it("时钟回拨：at 比 dayStart 小时按「新的一天」处理，不许算出负 used 或永远拒绝写", () => {
    const exhausted = { dayStart: 100_000, used: 12 };
    expect(canWrite(exhausted, 100_000), "前置条件：这个窗口已经用满").toBe(false);
    const rolledBack = 50_000; // 比 dayStart 小 = 时钟回拨
    expect(canWrite(exhausted, rolledBack), "回拨后不许永远拒绝写").toBe(true);
    const after = consume(exhausted, rolledBack);
    expect(after.used, "不许算出负的 used").toBe(1);
    expect(after.dayStart).toBe(rolledBack);
  });

  it("consume 不改动传入的对象（纯函数）", () => {
    const before = { dayStart: 0, used: 0 };
    const snapshot = { ...before };
    consume(before, 1000);
    expect(before).toEqual(snapshot);
  });
});

describe("M=8 并发 isolate 下的写预算算式（DEPLOY.md 配额账依据，见报告 ③）", () => {
  it("单个 isolate 全天写满：EVENT_WRITES_PER_DAY 次，不多不少（手写字面量 12）", () => {
    let b = FRESH_BUDGET;
    const at = 5000;
    let writes = 0;
    for (let i = 0; i < 20; i++) {
      if (canWrite(b, at)) { b = consume(b, at); writes++; }
    }
    expect(writes).toBe(12);
  });

  it("8 个独立 isolate（各自独立的 WriteBudget 实例）合计写次数恰好是 12 × 8 = 96（手写字面量）", () => {
    const at = 5000;
    let total = 0;
    for (let isolate = 0; isolate < 8; isolate++) {
      let b = FRESH_BUDGET;
      for (let i = 0; i < 20; i++) {
        if (canWrite(b, at)) { b = consume(b, at); total++; }
      }
    }
    expect(total).toBe(96);
  });
});
