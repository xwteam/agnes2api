import { describe, it, expect } from "vitest";
import {
  EVENT_RING_SIZE, EVENT_FLUSH_MIN_INTERVAL_MS, EVENT_WRITES_PER_HOUR,
  appendRing, mergeShards, parseShardIndex, makeShardIndex,
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
    expect(EVENT_WRITES_PER_HOUR).toBe(12);
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
    // 前 80 条是 c1..c80，加 40 条 a1..a40 后总共 120 条，丢最旧的 20 条（c1..c20）。
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

describe("parseShardIndex / makeShardIndex", () => {
  it("makeShardIndex 去重", () => {
    expect(makeShardIndex(["a", "b", "a"])).toEqual({ v: 1, shards: ["a", "b"] });
  });

  it("parseShardIndex 结构级错误一律 null（当作索引缺失，逼调用方重建）", () => {
    for (const bad of [null, undefined, "oops", 3, [], { v: 2, shards: ["a"] }, { v: 1, shards: "a" }]) {
      expect(parseShardIndex(bad), String(bad)).toBeNull();
    }
  });

  it("元素级脏数据就地剔掉，不整体作废", () => {
    expect(parseShardIndex({ v: 1, shards: ["a", 3, "", "b", null] })).toEqual({ v: 1, shards: ["a", "b"] });
  });

  it("往返一致", () => {
    const idx = makeShardIndex(["shard-1", "shard-2"]);
    expect(parseShardIndex(idx)).toEqual(idx);
  });
});

describe("canWrite / consume：写预算", () => {
  it("同一小时内：第 12 次可写、第 13 次不可写（边界值手写字面量）", () => {
    let b = FRESH_BUDGET;
    for (let i = 0; i < 11; i++) b = consume(b, 1000);
    expect(canWrite(b, 1000), "用了 11 次之后，第 12 次应当可写").toBe(true);
    b = consume(b, 1000);
    expect(canWrite(b, 1000), "用了 12 次之后，第 13 次应当不可写").toBe(false);
  });

  it("perHour 参数可覆盖默认值", () => {
    let b = FRESH_BUDGET;
    b = consume(b, 0);
    expect(canWrite(b, 0, 1), "perHour=1 时用掉 1 次即耗尽").toBe(false);
    expect(canWrite(b, 0, 2), "perHour=2 时用掉 1 次仍可写").toBe(true);
  });

  it("小时边界跨越时归零：at 落在下一个整点之后", () => {
    let b = FRESH_BUDGET;
    for (let i = 0; i < 12; i++) b = consume(b, 1000);
    expect(canWrite(b, 1000), "本小时用满").toBe(false);
    const nextHour = 1000 + 3_600_000;
    expect(canWrite(b, nextHour), "跨过一小时后应当归零").toBe(true);
    const b2 = consume(b, nextHour);
    expect(b2).toEqual({ hourStart: nextHour, used: 1 });
  });

  it("时钟回拨：at 比 hourStart 小时按「新的一小时」处理，不许算出负 used 或永远拒绝写", () => {
    const exhausted = { hourStart: 100_000, used: 12 };
    expect(canWrite(exhausted, 100_000), "前置条件：这个窗口已经用满").toBe(false);
    const rolledBack = 50_000; // 比 hourStart 小 = 时钟回拨
    expect(canWrite(exhausted, rolledBack), "回拨后不许永远拒绝写").toBe(true);
    const after = consume(exhausted, rolledBack);
    expect(after.used, "不许算出负的 used").toBe(1);
    expect(after.hourStart).toBe(rolledBack);
  });

  it("consume 不改动传入的对象（纯函数）", () => {
    const before = { hourStart: 0, used: 0 };
    const snapshot = { ...before };
    consume(before, 1000);
    expect(before).toEqual(snapshot);
  });
});
