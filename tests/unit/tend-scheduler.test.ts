import { describe, it, expect } from "vitest";
import { startTendScheduler } from "../../src/core/tend-scheduler.js";

/**
 * 假定时器队列。**注意 flush 用的是真 setTimeout(0) 这个宏任务**，
 * 不是 `await Promise.resolve()` 那种微任务自旋——P2 栽过一次「微任务饥饿式挂起」：
 * 变异之后测试挂死到连 vitest 自身的超时都排不上号，看起来像卡住而不是失败。
 */
function fakeTimers() {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    pending,
    setTimer(fn: () => void, ms: number) { pending.push({ fn, ms }); },
    /** 触发最早排上的那个定时器，然后把它引发的异步链推完。 */
    async fire(): Promise<void> {
      const t = pending.shift();
      if (!t) throw new Error("没有待触发的定时器——链条断了");
      t.fn();
      await flush(); await flush(); await flush();
    },
    async settle(): Promise<void> { await flush(); await flush(); await flush(); },
  };
}

describe("startTendScheduler", () => {
  it("启动立刻跑一轮，然后按读到的间隔重排——冷启动不该空等满一个间隔", async () => {
    const t = fakeTimers();
    let runs = 0;
    startTendScheduler({
      runOnce: async () => { runs++; },
      readIntervalMs: async () => 1_800_000,
      setTimer: t.setTimer, initialIntervalMs: 1_800_000, onError: () => {},
    });
    await t.settle();
    expect(runs).toBe(1);
    expect(t.pending).toHaveLength(1);
    expect(t.pending[0]!.ms).toBe(1_800_000);
  });

  it("**间隔改了，第二次重排就用新值**——I4 的全部内容", async () => {
    const t = fakeTimers();
    // 两次读到不同的值。fixture 刻意给不同值：都给 1800000 的话，
    // 把实现改回「读启动快照」也会通过——那是典型的无冲突 fixture。
    const intervals = [1_800_000, 60_000, 60_000];
    let i = 0;
    startTendScheduler({
      runOnce: async () => {},
      readIntervalMs: async () => intervals[i++] ?? 60_000,
      setTimer: t.setTimer, initialIntervalMs: 1_800_000, onError: () => {},
    });
    await t.settle();
    expect(t.pending[0]!.ms, "第一次用启动时读到的值").toBe(1_800_000);
    await t.fire();
    expect(t.pending[0]!.ms, "第二次必须用新读到的值").toBe(60_000);
  });

  it("读间隔失败时按**上一次已知的合法间隔**重排，链条绝不断", async () => {
    const t = fakeTimers();
    const errs: string[] = [];
    let call = 0;
    startTendScheduler({
      runOnce: async () => {},
      readIntervalMs: async () => {
        call++;
        if (call === 1) return 60_000;
        // stub 必须真的 throw。返回一个「失败对象」测不出任何东西。
        throw new Error("配置被写坏了");
      },
      setTimer: t.setTimer, initialIntervalMs: 1_800_000,
      onError: (kind) => errs.push(kind),
    });
    await t.settle();
    expect(t.pending[0]!.ms).toBe(60_000);
    await t.fire();
    expect(errs).toContain("read_interval");
    expect(t.pending, "链条断了就是「面板一次误操作永久停掉补池」").toHaveLength(1);
    expect(t.pending[0]!.ms, "沿用上一次已知的合法间隔").toBe(60_000);
  });

  it("首轮就读失败时用 initialIntervalMs 兜底", async () => {
    const t = fakeTimers();
    startTendScheduler({
      runOnce: async () => {},
      readIntervalMs: async () => { throw new Error("boom"); },
      setTimer: t.setTimer, initialIntervalMs: 1_800_000, onError: () => {},
    });
    await t.settle();
    expect(t.pending[0]!.ms).toBe(1_800_000);
  });

  it("runOnce 抛错时照样重排，并把异常交给 onError——补池失败不该停掉补池", async () => {
    const t = fakeTimers();
    const errs: string[] = [];
    startTendScheduler({
      runOnce: async () => { throw new Error("补池炸了"); },
      readIntervalMs: async () => 60_000,
      setTimer: t.setTimer, initialIntervalMs: 1_800_000,
      onError: (kind) => errs.push(kind),
    });
    await t.settle();
    expect(errs).toEqual(["run"]);
    expect(t.pending).toHaveLength(1);
  });

  it("递归天然不重叠：上一轮没跑完之前不会排下一个定时器", async () => {
    const t = fakeTimers();
    let release!: () => void;
    let runs = 0;
    startTendScheduler({
      runOnce: () => { runs++; return new Promise<void>((r) => { release = r; }); },
      readIntervalMs: async () => 60_000,
      setTimer: t.setTimer, initialIntervalMs: 60_000, onError: () => {},
    });
    await t.settle();
    expect(runs).toBe(1);
    // 这才是与 setInterval 的本质差别：那边不等上一轮 resolve 就会再起一轮。
    expect(t.pending, "上一轮还挂着，不该有待触发的定时器").toHaveLength(0);
    release();
    await t.settle();
    expect(t.pending).toHaveLength(1);
  });

  it("连跑五轮，每轮都重新读一次间隔", async () => {
    const t = fakeTimers();
    let reads = 0;
    startTendScheduler({
      runOnce: async () => {},
      readIntervalMs: async () => { reads++; return 1000; },
      setTimer: t.setTimer, initialIntervalMs: 1000, onError: () => {},
    });
    await t.settle();
    for (let i = 0; i < 4; i++) await t.fire();
    expect(reads).toBe(5);
  });
});
