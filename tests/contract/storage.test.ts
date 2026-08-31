import { describe, it, expect, beforeEach } from "vitest";
import type { Storage } from "../../src/ports/storage.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { IS_WORKERD } from "../helpers/is-workerd.js";
import { watchStorage, createStorageHealth } from "../../src/core/storage-health.js";

export function runStorageContract(name: string, make: () => Storage) {
  describe(`Storage 契约: ${name}`, () => {
    let s: Storage;
    beforeEach(() => { s = make(); });

    it("读不存在的键返回 null", async () => {
      expect(await s.get("missing")).toBeNull();
    });

    it("写入后能读回同样的对象", async () => {
      await s.put("k", { a: 1, b: "x" });
      expect(await s.get("k")).toEqual({ a: 1, b: "x" });
    });

    it("覆盖写入后读到新值", async () => {
      await s.put("k", { v: 1 });
      await s.put("k", { v: 2 });
      expect(await s.get("k")).toEqual({ v: 2 });
    });

    it("删除后读不到", async () => {
      await s.put("k", { v: 1 });
      await s.delete("k");
      expect(await s.get("k")).toBeNull();
    });

    it("list 只返回匹配前缀的键", async () => {
      await s.put("key:a", { v: 1 });
      await s.put("key:b", { v: 2 });
      await s.put("config", { v: 3 });
      const keys = (await s.list("key:")).sort();
      expect(keys).toEqual(["key:a", "key:b"]);
    });

    it("list 在无匹配时返回空数组", async () => {
      expect(await s.list("nothing:")).toEqual([]);
    });

    // 以下并发用例针对评审那条并发缺陷：原有 6 条全是单线程顺序操作，
    // 这正是 FileStorage 的并发缺陷（固定 .tmp 互抢 + 读改写竞态）能逃过
    // 15 轮评审的原因。dispatch 在返回成功响应前就要写回 key 状态，
    // 所以「两个并发请求」在生产里是常态而非边角场景。

    // 用独立前缀（而不是 key:）：workerd 下跑的是真 KV，命名空间在同一个测试文件
    // 的用例之间是持久的，共用 key: 前缀会与上面那条 list 用例互相污染。
    it("并发写入不同键时每个键都留存", async () => {
      const n = 20;
      const keys = Array.from({ length: n }, (_, i) => `conc:a${i}`);
      await Promise.all(keys.map((k, i) => s.put(k, { v: i })));

      const got = await Promise.all(keys.map((k) => s.get<{ v: number }>(k)));
      expect(got).toEqual(keys.map((_, i) => ({ v: i })));
      expect((await s.list("conc:a")).sort()).toEqual([...keys].sort());
    });

    it("并发写入同一个键不抛错，最终值是写入过的某一个", async () => {
      const n = 20;
      const results = await Promise.allSettled(
        Array.from({ length: n }, (_, i) => s.put("conc:same", { v: i })),
      );
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);

      const final = await s.get<{ v: number }>("conc:same");
      expect(final).not.toBeNull();
      expect(final!.v).toBeGreaterThanOrEqual(0);
      expect(final!.v).toBeLessThan(n);
    });

    /**
     * **评审发现（第二次修复）**：`put()` 的第三个参数 `expiresAt`。
     *
     * ⚠️ **`KvStorage` 单独分支，诚实记录一个测不到的角落**：真实 Cloudflare KV
     * 的 `expiration` 要求至少比当下晚 60 秒，过近或过去的值会被 API 直接拒绝
     * （不是"存了但没生效"，是 `put()` 本身抛错）——CI 里没有办法真等 60+ 秒去
     * 验证"过期之后真的读不到"，这里只验证"传了一个合法的未来 `expiration`，
     * `put()` 不抛错，且立刻可读"，即 API 用法正确；**KV 的实际过期行为不在这条
     * 契约的覆盖范围内，只能相信 Cloudflare 自己的 TTL 实现**（与本仓其余处「相信
     * 平台原生机制」的取舍一致，例如从不自测 KV 配额本身是不是真的 1,000/天）。
     * `MemoryStorage`/`FileStorage` 没有这条 60 秒下限，用真实短等待即可覆盖到
     * "过期之后真的读不到"这条完整行为——这三个实现里没有一个把 TTL 判定的时钟
     * 做成可注入的（`FileStorage`/`KvStorage` 都是 IO 边界适配器，直接读各自环境
     * 的真实时钟，理由见 `storage-file.ts` 的说明），所以这里没有捷径。
     */
    if (name === "KvStorage") {
      it("expiresAt 是合法的未来值：put 不抛错，且立刻可读（KV 的 60 秒下限决定了只能验证到这里）", async () => {
        await s.put("ttl:kv-future", { v: 1 }, Date.now() + 120_000);
        expect(await s.get("ttl:kv-future")).toEqual({ v: 1 });
      });
    } else {
      it("expiresAt 早于当下：put 完立刻就读不到了（过期时刻可以是过去）", async () => {
        await s.put("ttl:already-gone", { v: 1 }, Date.now() - 1000);
        expect(await s.get("ttl:already-gone")).toBeNull();
      });

      it("expiresAt 是几百毫秒之后：过期前能读到，过期后读不到（真实短等待）", async () => {
        await s.put("ttl:soon", { v: 1 }, Date.now() + 300);
        expect(await s.get("ttl:soon"), "还没到期，应该读得到").toEqual({ v: 1 });
        await new Promise((r) => setTimeout(r, 500));
        expect(await s.get("ttl:soon"), "已经过了 expiresAt，应该读不到了").toBeNull();
      });
    }

    it("不传 expiresAt 时永不过期（原有行为不变，不会被上面的 TTL 逻辑误伤）", async () => {
      await s.put("ttl:forever", { v: 1 });
      await new Promise((r) => setTimeout(r, 300));
      expect(await s.get("ttl:forever")).toEqual({ v: 1 });
    });

    /**
     * **评审 F4**：`src/ports/storage.ts` 的端口文档明写"过期之后 `get`/`list`
     * 都不再能看到它"——`list()` 那一半此前没有任何用例守护（删掉
     * `FileStorage.list()`/`MemoryStorage.list()` 里的过期过滤，`pnpm test` +
     * `pnpm test:workers` 全绿存活，已实测）。这里补上，与 `KvStorage` 分支同一条
     * "60 秒下限测不了真实过期"的理由（见上面那段说明），只验证"未过期的键在
     * `list()` 结果里"，不额外重复"过期之后消失"这条已经由 `get()` 系列用例
     * 覆盖过的行为；非 KV 分支两条都验。
     */
    if (name === "KvStorage") {
      it("list()：expiresAt 是合法的未来值时，键正常出现在结果里", async () => {
        await s.put("ttl-list:kv-future", { v: 1 }, Date.now() + 120_000);
        expect(await s.list("ttl-list:")).toEqual(["ttl-list:kv-future"]);
      });
    } else {
      it("list()：过期之前，键出现在结果里", async () => {
        await s.put("ttl-list:soon", { v: 1 }, Date.now() + 300);
        expect(await s.list("ttl-list:")).toEqual(["ttl-list:soon"]);
      });

      it("list()：过期之后，键从结果里消失（真实短等待）", async () => {
        await s.put("ttl-list:gone", { v: 1 }, Date.now() + 300);
        await new Promise((r) => setTimeout(r, 500));
        expect(await s.list("ttl-list:")).toEqual([]);
      });
    }

    it("并发的写与删混合执行时，未被删的键不受影响", async () => {
      await s.put("conc:keep", { v: "keep" });
      const ops: Promise<void>[] = [];
      for (let i = 0; i < 10; i++) {
        ops.push(s.put(`conc:tmp${i}`, { v: i }));
        ops.push(s.delete(`conc:gone${i}`));
      }
      const results = await Promise.allSettled(ops);
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);

      expect(await s.get("conc:keep")).toEqual({ v: "keep" });
      const survivors = (await s.list("conc:tmp")).sort();
      expect(survivors).toHaveLength(10);
    });
  });
}

runStorageContract("MemoryStorage", () => new MemoryStorage());

/**
 * **结构性隐患，评审要求确认**：`src/` 下一共只有三个类 `implements Storage`
 * （`grep -rln "implements Storage" src/` 核实过）——`FileStorage`/`KvStorage`
 * 已经在下面注册，`WatchedStorage`（`src/core/storage-health.ts` 的
 * `watchStorage()`）此前没有被这份契约测过。它是个纯转发的装饰器（把
 * `put`/`delete` 的成败喂给 `StorageHealth`，其余原样转发），但"纯转发"本身
 * 正是"漏传第三个参数会编译通过、静默解除有界性"这条隐患最容易发生的地方——
 * TypeScript 允许一个只声明两个参数的 `put(key, value)` 实现赋值给要求
 * `put(key, value, expiresAt?)` 的接口。补上这条注册，让同一份契约（含上面
 * 新增的 TTL/list 用例）也跑在装饰器这一层，不只是跑在两个叶子实现上。
 *
 * ⚠️ **评审四审 B 组第 4 条：上面那句"一共只有三个类"用的核实方法本身不可靠，
 * 这里明写清楚它的边界。** `grep -rln "implements Storage" src/` **按构造就看不见
 * 对象字面量**——`src/http/app.ts` 的 `defaultStoreLogger()` 里就有一个：
 * `const inertStorage: Storage = { async get(){…}, async put(){…}, … }`，它满足
 * `Storage` 却永远不会被那条 grep 命中。这条发现（"确认契约覆盖了每一个生产实现"）
 * 的全部要害就是"验证方法要可靠"，而论证本身用了一个不可靠的方法，如实登记。
 *
 * 这个对象**有意不进这份契约名册**，理由不是"漏了"：它是一个 no-op sink（`get`
 * 恒 `null`、`put`/`delete` 什么都不做、`list` 恒空），既不落盘也不持有状态，
 * 不存在这份契约要守的那类性质（TTL 是否生效、`list` 是否过滤过期键、有界性）。
 * 它存在的唯一理由是让 `logFlush` 与 `/admin/api/events` 在"没有配置 storeLogger"
 * 的夹具下有一个可调用的实例——**今天没有有界性后果**（它什么都不写）。
 * 判据由此从"grep 得到的类名单"改成一句可核对的话：**凡是会真的持有数据的
 * `Storage` 实现都必须在这份名册里**；`inertStorage` 不持有数据，所以不在。
 * 将来若有人把它换成会真存东西的东西，这条注释就是那次改动该被拦下的地方。
 */
runStorageContract(
  "WatchedStorage(MemoryStorage)",
  () => watchStorage(new MemoryStorage(), createStorageHealth(), () => Date.now()),
);

// 仅在 workerd 下运行：真实 KV。判据见 tests/helpers/is-workerd.ts（唯一实现，
// 反向防线在 tests/workers-setup.ts）。
if (IS_WORKERD) {
  const { env } = await import("cloudflare:test");
  const { KvStorage } = await import("../../src/adapters/storage-kv.js");
  runStorageContract("KvStorage", () => new KvStorage((env as { POOL: KVNamespace }).POOL));
} else {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { FileStorage } = await import("../../src/adapters/storage-file.js");
  runStorageContract("FileStorage", () => new FileStorage(mkdtempSync(join(tmpdir(), "a2a-"))));
}
