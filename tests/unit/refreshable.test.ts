import { describe, it, expect } from "vitest";
import { Refreshable } from "../../src/core/refreshable.js";

/** 递进假时钟。**不要用 `now: () => 0` 那种冻结时钟**——TTL 类测试在冻结时钟下变异后是挂起而不是失败。 */
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance(ms: number) { t += ms; } };
}

describe("Refreshable", () => {
  it("TTL 内不重复加载——它就是「读取次数与请求数解耦」这条配额结论的全部依据", async () => {
    const c = clock();
    let loads = 0;
    const r = new Refreshable<number>({ load: async () => ++loads, ttlMs: 1000, now: c.now });
    await r.ensureFresh();
    await r.ensureFresh();
    c.advance(999);
    await r.ensureFresh();
    expect(loads).toBe(1);
    c.advance(1);
    await r.ensureFresh();
    expect(loads).toBe(2);
  });

  it("并发 ensureFresh 只触发一次加载——突发流量下 N 个请求变成 N 次存储读取正是配额账最怕的形态", async () => {
    const c = clock();
    let loads = 0;
    let release!: (v: number) => void;
    const r = new Refreshable<number>({
      load: () => { loads++; return new Promise<number>((res) => { release = res; }); },
      ttlMs: 1000, now: c.now,
    });
    const all = Promise.all([r.ensureFresh(), r.ensureFresh(), r.ensureFresh()]);
    release(7);
    await all;
    expect(loads).toBe(1);
    expect(r.current()).toBe(7);
  });

  it("加载失败时保留上一份快照，并把异常交给 onError——绝不让网关挂掉", async () => {
    const c = clock();
    let mode: "ok" | "boom" = "ok";
    const seen: string[] = [];
    const r = new Refreshable<string>({
      // stub 必须真的 throw。只 resolve 一个「失败对象」测不出任何东西。
      load: async () => { if (mode === "boom") throw new Error("KV 挂了"); return "good"; },
      ttlMs: 1000, now: c.now,
      onError: (e) => seen.push((e as Error).message),
    });
    await r.ensureFresh();
    expect(r.current()).toBe("good");
    mode = "boom";
    c.advance(1001);
    await expect(r.ensureFresh()).resolves.toBeUndefined(); // 不抛
    expect(r.current()).toBe("good");                        // 保留上一份
    expect(seen).toEqual(["KV 挂了"]);
  });

  it("失败后要等满一个 TTL 才重试——故障期每请求都重试等于把存储打爆", async () => {
    const c = clock();
    let loads = 0;
    const r = new Refreshable<string>({
      load: async () => { loads++; if (loads > 1) throw new Error("boom"); return "good"; },
      ttlMs: 1000, now: c.now,
    });
    await r.ensureFresh();          // loads=1，成功
    c.advance(1001);
    await r.ensureFresh();          // loads=2，失败
    await r.ensureFresh();          // 不该再加载
    c.advance(999);
    await r.ensureFresh();          // 仍不该
    expect(loads).toBe(2);
    c.advance(2);
    await r.ensureFresh();
    expect(loads).toBe(3);
  });

  it("从未成功装载过时，失败不推进计时——否则冷启动撞一次抖动就要空等一个 TTL", async () => {
    const c = clock();
    let loads = 0;
    const r = new Refreshable<string>({
      load: async () => { loads++; throw new Error("boom"); }, ttlMs: 60_000, now: c.now,
    });
    await r.ensureFresh();
    await r.ensureFresh();
    await r.ensureFresh();
    expect(loads).toBe(3);
    expect(r.isEmpty()).toBe(true);
  });

  it("invalidate 之后下一次 ensureFresh 一定真的重载——面板保存后立刻生效靠的就是它", async () => {
    const c = clock();
    let loads = 0;
    const r = new Refreshable<number>({ load: async () => ++loads, ttlMs: 60_000, now: c.now });
    await r.ensureFresh();
    await r.ensureFresh();
    expect(loads).toBe(1);
    r.invalidate();
    await r.ensureFresh();
    expect(loads).toBe(2);
  });

  it("invalidate 后加载失败仍保留旧值，且不会陷入每次都重试", async () => {
    const c = clock();
    let loads = 0;
    const r = new Refreshable<string>({
      load: async () => { loads++; if (loads > 1) throw new Error("boom"); return "good"; },
      ttlMs: 1000, now: c.now,
    });
    await r.ensureFresh();
    r.invalidate();
    await r.ensureFresh();   // loads=2，失败
    await r.ensureFresh();   // 不该再加载
    expect(loads).toBe(2);
    expect(r.current()).toBe("good");
  });

  it("prime 失败会抛——启动时的 fail-closed 靠它，绝不能被 ensureFresh 的兜底吞掉", async () => {
    const c = clock();
    const r = new Refreshable<string>({ load: async () => { throw new Error("缺少 GATEWAY_TOKEN"); }, ttlMs: 1000, now: c.now });
    await expect(r.prime()).rejects.toThrow(/GATEWAY_TOKEN/);
  });

  it("set 写穿透不产生加载，且**不延长** TTL 窗口——延长了就再也读不到别的实例的改动", async () => {
    const c = clock();
    let loads = 0;
    const r = new Refreshable<number>({ load: async () => ++loads, ttlMs: 1000, now: c.now });
    await r.ensureFresh();          // loads=1，loadedAt=0
    c.advance(900);
    r.set(42);
    expect(r.current()).toBe(42);
    expect(loads).toBe(1);
    c.advance(101);                 // 距上次真加载 1001ms
    await r.ensureFresh();
    expect(loads).toBe(2);          // set 没有把窗口推后
  });

  /**
   * `invalidate()` 不许被**在途的**那次 reload 吃掉。
   *
   * 上面那条 invalidate 用例是「先失效、再加载」，测不到这个：真存储的一次装载
   * 跨越 await（先取样、后交付），失效完全可能发生在装载的**中途**。此时那次装载
   * 带回来的是取样时刻的旧值，若它照旧推进「上次加载时刻」，调用方明确要求的
   * 「下一次一定重载」就被静默降级成「再等满一个 TTL」。
   */
  it("装载途中调 invalidate ⇒ 在途那次不推进 TTL，下一次仍然真的重载", async () => {
    const c = clock();
    let loads = 0;
    let release!: () => void;
    const r = new Refreshable<number>({
      load: async () => {
        const n = ++loads;                                            // 取样
        // **只卡住第一次**：第二次也卡住的话，缺陷的表现是整条用例挂起而不是失败
        //（本项目已登记的第三类假阳性），而挂起给不出任何归因。
        if (n === 1) await new Promise<void>((res) => { release = res; });
        return n;
      },
      ttlMs: 1000, now: c.now,
    });

    const inflight = r.ensureFresh();
    r.invalidate();          // 装载**中途**失效
    release();
    await inflight;
    expect(r.current(), "在途那次的值照留作兜底").toBe(1);

    // 时钟一动不动。再读一次必须真的重载，而不是被那次在途结果满足。
    await r.ensureFresh();
    expect(loads, "invalidate 被在途 reload 吃掉了").toBe(2);
    expect(r.current()).toBe(2);
  });

  /**
   * 失效之后紧接着撞上一次读失败，**不该被「失败也推进计时」那条退避规则罚等一个 TTL**。
   *
   * 那条退避是给「TTL 自然到期后的例行刷新失败」用的（故障期每请求都重试会把存储打爆）。
   * 但调用方**明确**调过 `invalidate()`，说明底层刚被改过；此时把它和例行刷新一视同仁，
   * 面板上「保存成功」之后要等满一个 TTL 才生效，而且中间那次失败对用户完全不可见。
   */
  it("装载途中 invalidate 且那次装载失败 ⇒ 下一次立刻重试，不被退避罚等一个 TTL", async () => {
    const c = clock();
    let loads = 0;
    let release!: () => void;
    const r = new Refreshable<string>({
      load: async () => {
        const n = ++loads;
        if (n === 1) return "good";                 // 先成功一次，建立兜底快照
        // 只有第二次卡住并真的 throw——stub 必须真抛，返回「失败对象」测不出东西。
        if (n === 2) {
          await new Promise<void>((res) => { release = res; });
          throw new Error("KV 挂了");
        }
        return "fresh";
      },
      ttlMs: 1000, now: c.now,
    });

    await r.ensureFresh();
    c.advance(1001);
    const inflight = r.ensureFresh();   // 第二次装载在途
    r.invalidate();                     // 途中失效
    release();
    await inflight;
    expect(r.current(), "失败仍保留上一份合法快照").toBe("good");

    // 时钟一动不动：有兜底快照时例行失败会等满一个 TTL，但这次是 invalidate 过的。
    await r.ensureFresh();
    expect(loads, "失效后撞上一次读失败，不该再等满一个 TTL").toBe(3);
    expect(r.current()).toBe("fresh");
  });

  /**
   * **这条用例守的是一个「看起来像 bug 的正确选择」，改之前先读完。**
   *
   * `invalidate()` 递增失效代数而 `set()` **不**递增。这个不对称很容易被当成疏漏，
   * 顺手加一行 `this.gen++` 就「修」掉了——而那才是缺陷。理由：
   *
   * 写穿透最密集的时刻恰恰是上游出事的时刻（429 突发 ⇒ 一批 key 同时进冷却 ⇒
   * 一批 `save()` + `set()`）。`set()` 若递增代数，每一次写穿透都会作废掉正在途中的
   * 那次装载并立刻重来 ⇒ **在最需要缓存的时候引发 reload 风暴**，把「读取次数与请求数
   * 解耦」这条结论整个打掉。
   *
   * 代价是本用例第一条断言的那个：在途装载落地时会盖掉刚写穿透的那份。边界是清楚的
   * ——该状态在**本 isolate 的快照**里最多晚一个 TTL 可见（**存储里始终是对的**），
   * 而「跨 isolate 最多晚一个 TTL 才看到别人判的冷却/剔除」这条上界本来就已被接受并
   * 写进文档。也就是说这个取舍没有把已承诺的上界变松，只是让本 isolate 在极窄的竞态
   * 窗口里退化到与跨 isolate 相同的水平。
   *
   * 两者承诺强度不同才是根据：`invalidate()` 的「下一次一定重载」是**硬保证**，
   * 写穿透只是「我自己写的我立刻看得见」的尽力优化。只有硬保证值得付那个代价。
   */
  it("写穿透被在途 reload 盖掉是**刻意取舍**：set() 不递增代数，否则上游抖动时会引发 reload 风暴", async () => {
    const c = clock();
    let loads = 0;
    let release!: () => void;
    const r = new Refreshable<string>({
      load: async () => {
        const n = ++loads;
        // **只卡住第二次**：第三次也卡住的话，变异后的表现是挂起而不是失败，
        // 而挂起给不出任何归因（本项目已登记的第三类假阳性）。
        if (n === 2) await new Promise<void>((res) => { release = res; });
        return `v${n}`;
      },
      ttlMs: 1000, now: c.now,
    });

    await r.ensureFresh();              // loads=1 → "v1"
    c.advance(1001);
    const inflight = r.ensureFresh();   // loads=2，取样完成、卡在交付前

    r.set("write-through");             // 装载途中写穿透
    expect(r.current()).toBe("write-through");

    release();
    await inflight;

    // ① 代价：在途那份把写穿透盖掉了。这是被接受的，不是缺陷。
    expect(r.current(), "在途装载落地会盖掉写穿透——存储里仍然是对的，只是本 isolate 的快照旧了")
      .toBe("v2");

    // ② 收益：TTL 计时照常推进，写穿透**不会**引发额外装载。
    //    时钟一动不动，所以再读一次必须命中缓存。
    await r.ensureFresh();
    expect(
      loads,
      "set() 递增代数的话这里会再装载一次 ⇒ 429 突发时一批写穿透就是一轮 reload 风暴",
    ).toBe(2);
  });

  it("ttlMs=0 时每次都重载——这是用户的逃生口，必须真的关掉缓存", async () => {
    const c = clock();
    let loads = 0;
    const r = new Refreshable<number>({ load: async () => ++loads, ttlMs: 0, now: c.now });
    await r.ensureFresh();
    await r.ensureFresh();
    await r.ensureFresh();
    expect(loads).toBe(3);
  });

  /**
   * 防住的真实故障：NTP 把时钟往回拨 T 毫秒之后，`now() - loadedAt` 变成负数，
   * 判据 `< ttlMs` 恒成立 ⇒ **这个 Refreshable 在 T + ttl 这段时间里再也不刷新**。
   * 对 ConfigHolder 是「口令撤销不掉」在回拨期间复活，对 KeyPoolRepo 是
   * 「别的实例判的冷却/剔除一直看不见」。只咬 Node 常驻进程（Worker 的 isolate 活不了那么久）。
   *
   * 同一个模块家族里 `writeIndexBestEffort` / `listOnReadPath` 都显式挡了 `since < 0`，
   * 这里没挡——**同一份代码库里两套时钟语义**本身就是缺陷。
   */
  it("时钟回拨之后立刻恢复刷新，而不是冻结到回拨量走完", async () => {
    let t = 1_000_000;
    let loaded = 0;
    const r = new Refreshable<number>({
      load: async () => ++loaded,
      ttlMs: 30_000,
      now: () => t,
    });
    await r.prime();
    expect(r.current()).toBe(1);

    t -= 3_600_000;                    // NTP 往回拨一小时
    await r.ensureFresh();
    // 期望值 2 是手写字面量。断言的是**加载真的又发生了一次**（行为），
    // 不是「没抛错」（形状）。
    expect(r.current(), "时钟回拨把刷新冻住了").toBe(2);
  });

  it("onError 自己抛错不会影响主流程——sink 故障不许拖垮网关", async () => {
    const c = clock();
    const r = new Refreshable<string>({
      load: async () => { throw new Error("boom"); }, ttlMs: 1000, now: c.now,
      onError: () => { throw new Error("sink 也挂了"); },
    });
    await expect(r.ensureFresh()).resolves.toBeUndefined();
  });
});
