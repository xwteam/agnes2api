import { describe, it, expect } from "vitest";
import { KvStorage } from "../../src/adapters/storage-kv.js";

/**
 * **评审 F1**：`KvStorage.put()` 里"把 `expiresAt` 转成 KV 的 `expiration`"这一行
 * 之前**零测试守护**——`tests/contract/storage.test.ts` 跑的是真实（miniflare 模拟
 * 的）KV，只验证了"合法调用不抛错、立刻可读"这个功能性结果，没有验证**我们的
 * 适配器代码本身**有没有真的把 `expiration` 传出去、单位换算对不对。复评把
 * `storage-kv.ts` 那一行整个变异成丢弃 `expiresAt`（相当于永不过期）之后，
 * `pnpm test:workers` 291/291 全绿存活——不是"平台行为测不到"（那部分的边界
 * 已经在 `storage.test.ts` 里写清楚），是"我们自己的代码有没有正确调用平台
 * API"这件事，本该测得到却没测。
 *
 * 这条不需要真的连 KV（也不需要等 60 秒的过期下限）：`KVNamespace` 只是一个
 * TypeScript 接口，`KvStorage` 在调用它之前不做任何 Workers 运行时专属的事，
 * 一个只实现 `put()`（这条测试唯一关心的方法）的假对象足够——这也是这个文件
 * 放在 `tests/unit/`（只跑 node，不需要 workerd）而不是 `tests/contract/` 的原因。
 * 其余方法故意不实现，用 `as unknown as KVNamespace` 跳过完整结构类型检查——
 * 这是"测试替身只覆盖被测方法"的常见做法，不是本仓"unknown + 窄化"那条硬要求
 * 管的范围（那条管解析不可信的 JSON，这里是给一个只用得到一小部分接口的类型
 * 断言）。
 */
class SpyKvNamespace {
  puts: Array<{ key: string; value: string; expiration?: number; expirationTtl?: number }> = [];

  async put(
    key: string,
    value: string,
    options?: { expiration?: number; expirationTtl?: number },
  ): Promise<void> {
    this.puts.push({ key, value, expiration: options?.expiration, expirationTtl: options?.expirationTtl });
  }
}

function makeStorage(): { storage: KvStorage; spy: SpyKvNamespace } {
  const spy = new SpyKvNamespace();
  const storage = new KvStorage(spy as unknown as KVNamespace);
  return { storage, spy };
}

describe("KvStorage：expiresAt → KV 原生 expiration 的转换（评审 F1）", () => {
  it("不传 expiresAt 时，KV 侧不带任何过期 option（原有行为，永不过期）", async () => {
    const { storage, spy } = makeStorage();
    await storage.put("k", { v: 1 });
    expect(spy.puts.length).toBe(1);
    expect(spy.puts[0]!.expiration).toBeUndefined();
    expect(spy.puts[0]!.expirationTtl).toBeUndefined();
  });

  /**
   * **手写字面量，不是从 `Math.floor(expiresAt / 1000)` 反算的表达式**——这条正是
   * 复评点名"单位写错（ms 当秒传）同样无人拦"的那个回归：如果这里改成直接把 `ms`
   * 原样传给 `expiration`，断言会用同一个（错误的）表达式算出同一个（错误的）
   * 期望值，两边一起错也测不出来。
   */
  it("expiresAt 转成绝对 UNIX 秒，不是毫秒——90,000,000ms 必须变成 90,000 秒", async () => {
    const { storage, spy } = makeStorage();
    await storage.put("k", { v: 1 }, 90_000_000);
    expect(spy.puts[0]!.expiration, "90,000,000ms 应该等于 90,000 秒，不是 90,000,000 秒").toBe(90_000);
    expect(spy.puts[0]!.expirationTtl, "只应该用 expiration（绝对值），不该同时/改用 expirationTtl").toBeUndefined();
  });

  it("非整千毫秒的 expiresAt 向下取整，不是四舍五入或截断到别的语义", async () => {
    const { storage, spy } = makeStorage();
    await storage.put("k", { v: 1 }, 90_000_999); // 90000.999 秒
    expect(spy.puts[0]!.expiration, "Math.floor：90,000.999 秒应该落到 90,000，不是 90,001").toBe(90_000);
  });

  it("expiresAt=0（合法边界，纪元零点）同样正确转换，不被 falsy 短路成「不传」", async () => {
    const { storage, spy } = makeStorage();
    await storage.put("k", { v: 1 }, 0);
    expect(spy.puts[0]!.expiration, "0 是一个合法的（虽然离谱地早的）过期时刻，不该被当成 undefined").toBe(0);
  });

  it("写入的 value 本身与 key 不受这次改动影响，仍然是原来的 JSON.stringify 语义", async () => {
    const { storage, spy } = makeStorage();
    await storage.put("my-key", { a: 1, b: "x" }, 90_000_000);
    expect(spy.puts[0]!.key).toBe("my-key");
    expect(spy.puts[0]!.value).toBe(JSON.stringify({ a: 1, b: "x" }));
  });
});
