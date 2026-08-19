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

  // ── Critical 回归：onError 自己抛错不能拖累重排 ──────────────────────────
  //
  // 此前 `onError("run", err)` / `onError("read_interval", err)` 都没有被任何
  // try/catch 包裹：onError 是 TendSchedulerDeps 的公开接口，消费方接一个会抛错
  // 的操作（上报 Sentry、写审计日志、无监听器时同步抛的 EventEmitter.emit('error')）
  // 是真实场景，不是理论上的。onError 一抛，`deps.setTimer(...)` 那一行就永远
  // 走不到——重排彻底不发生，且 tick() 的 promise 变成 unhandled rejection，
  // Node 20+ 默认 `--unhandled-rejections=throw` ⇒ 整个网关进程崩溃，比「补池
  // 永久停止」更严重一级：转发能力也一起没了。

  it("即使 onError 自己也抛错，run 失败路径依然会重排——onError 故障不能拖垮重排", async () => {
    const t = fakeTimers();
    startTendScheduler({
      runOnce: async () => { throw new Error("补池炸了"); },
      readIntervalMs: async () => 60_000,
      setTimer: t.setTimer, initialIntervalMs: 1_800_000,
      onError: () => { throw new Error("onError 自己也挂了（比如上报 Sentry 失败）"); },
    });
    await t.settle();
    expect(t.pending, "onError 抛错也不该让 setTimer 一次都没被调用").toHaveLength(1);
    expect(t.pending[0]!.ms).toBe(60_000);
  });

  it("即使 onError 自己也抛错，read_interval 失败路径依然会重排，沿用上一次已知的合法间隔", async () => {
    const t = fakeTimers();
    startTendScheduler({
      runOnce: async () => {},
      readIntervalMs: async () => { throw new Error("配置被写坏了"); },
      setTimer: t.setTimer, initialIntervalMs: 1_800_000,
      onError: () => { throw new Error("onError 自己也挂了"); },
    });
    await t.settle();
    expect(t.pending, "onError 抛错也不该让 setTimer 一次都没被调用").toHaveLength(1);
    expect(t.pending[0]!.ms, "沿用 initialIntervalMs 这份上一次已知的合法间隔").toBe(1_800_000);
  });

  // `setTimer` 自身抛错**没有写测试**，是刻意的：它是链条里唯一真正无法自救的
  // 情形（`deps.setTimer` 的实现注释里写明了）——finally 块已经保证走到了调用
  // 这一步，它自己再抛就没有更下游的安全网可退，此后果必然是 unhandled
  // rejection。用测试去人为触发一次真实的 unhandled rejection 需要往 process
  // 上挂 'unhandledRejection' 监听器，而 vitest 自己也监听这个事件来判定用例
  // /整个运行是否干净——两者会同时收到同一个事件，我这边挂的监听器只能防止
  // Node 的默认崩溃行为，防不住 vitest 把它算成一条不相关的额外失败，把本任务
  // 一直在消除的那类"看似跟这条用例无关的失败"重新引入回来。这个边界因此只
  // 落在代码注释里，不落在自动化测试里。

  // ── Important 回归：间隔上界 ────────────────────────────────────────────
  //
  // `setTimeout`/`setInterval` 的延迟用 32 位有符号整数表示，超过 2^31-1
  // （约 24.8 天）时 node:timers **既不抛错也不钳到上限**，而是静默把延迟当成
  // `1`（已实测：`setTimeout(fn, 5_000_000_000)` 约 1ms 后就触发）。方向与直觉
  // 相反：把 TEND_INTERVAL_MS 设成超大值不是「补池几乎永不触发」，而是变成
  // 只受一次 readIntervalMs IO 往返约束的紧循环。posInt 从 P1/P2 起就没有给
  // 这个字段设上界，本任务把它从「只能重启进程改」变成「面板保存热更新」，
  // 可达性因此实质性提升，必须在这里钳一道。

  // 钳值有两个独立的落点（`lastGoodIntervalMs` 的初始化 / `readIntervalMs` 每次
  // 读到的新值），下面两条用例分别单独暴露其中一个——都用超大值会让两条路径
  // 互相掩护：`readIntervalMs` 成功时会覆盖 `nextMs`，如果它自己也钳过，
  // 「初始值没钳」这个变异就测不出来（已实测：只去掉初始值那一处的 clamp，
  // 用「两边都给巨大值」的写法全部 10 条用例照样绿，因为 readIntervalMs 那条
  // 路径的钳值把它盖过去了）。

  it("首轮 readIntervalMs 就失败时，initialIntervalMs 本身也要被钳——不能只钳重读出来的值", async () => {
    const t = fakeTimers();
    const HUGE_MS = 5_000_000_000; // 远超 2^31-1
    const MAX_SAFE_DELAY_MS = 2_147_483_647;
    startTendScheduler({
      runOnce: async () => {},
      // 首轮就失败：nextMs 只能来自 initialIntervalMs 这条路径，
      // 与 readIntervalMs 自己的钳值完全无关，才能单独测出「初始值没钳」。
      readIntervalMs: async () => { throw new Error("boom"); },
      setTimer: t.setTimer, initialIntervalMs: HUGE_MS, onError: () => {},
    });
    await t.settle();
    expect(t.pending[0]!.ms).toBe(MAX_SAFE_DELAY_MS);
  });

  it("readIntervalMs 重新读到超大值时同样要钳，不是只在启动那一次生效", async () => {
    const t = fakeTimers();
    const HUGE_MS = 5_000_000_000; // 远超 2^31-1
    const MAX_SAFE_DELAY_MS = 2_147_483_647;
    let call = 0;
    startTendScheduler({
      runOnce: async () => {},
      // readIntervalMs 每一轮都会被调用（包括第一轮），第一次给个正常值、
      // 第二次才给超大值，才能把"第二次重读的钳值"和"启动时的钳值"分开验证
      // ——两次都给巨大值的话，第一轮走的其实也是 readIntervalMs 这条路径
      // （它成功时会覆盖 initialIntervalMs），测不出"不是只在启动那一次生效"。
      readIntervalMs: async () => (++call === 1 ? 60_000 : HUGE_MS),
      setTimer: t.setTimer, initialIntervalMs: 60_000, onError: () => {},
    });
    await t.settle();
    expect(t.pending[0]!.ms, "第一次读到的是正常值，不需要钳").toBe(60_000);
    await t.fire();
    expect(t.pending[0]!.ms, "第二次读到超大值时要被钳").toBe(MAX_SAFE_DELAY_MS);
  });
});
