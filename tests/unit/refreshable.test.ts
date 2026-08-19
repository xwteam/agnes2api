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

  it("ttlMs=0 时每次都重载——这是用户的逃生口，必须真的关掉缓存", async () => {
    const c = clock();
    let loads = 0;
    const r = new Refreshable<number>({ load: async () => ++loads, ttlMs: 0, now: c.now });
    await r.ensureFresh();
    await r.ensureFresh();
    await r.ensureFresh();
    expect(loads).toBe(3);
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
