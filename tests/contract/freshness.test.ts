import { describe, it, expect } from "vitest";
import { createConfigHolder } from "../../src/http/config-holder.js";
import { KeyPoolRepo } from "../../src/core/keypool-repo.js";
import { KEY_PREFIX } from "../../src/core/pool-index.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";

/**
 * 配置与 key 池是面板会改的**两样东西**，它们的「刚改完多久能看见」必须是同一套语义——
 * 面板上写的生效时间只有一份，两边行为一旦分叉，那个数字就在骗人。
 *
 * 这个文件用**同一组断言**分别跑两者。放 tests/contract/ ⇒ node 与 workerd 各跑一遍。
 *
 * 每条断言都让「命中缓存」与「真去读」返回**不同的值**——只数读取次数的话，底层
 * 数据没变时两条路径的返回值一模一样，谁赢都通过，那是缓存类测试最常见的假阳性。
 */
const TTL = 30_000;

interface Freshness {
  read(): Promise<string>;
  writeUnderlying(v: string): Promise<void>;
  ensureFresh(): Promise<void>;
  invalidate(): void;
}

function clock() {
  let t = 1000;
  return { now: () => t, advance(ms: number) { t += ms; } };
}

async function configSubject(c: ReturnType<typeof clock>): Promise<Freshness> {
  const s = new MemoryStorage();
  await s.put("config", { gatewayToken: "v0" });
  const h = await createConfigHolder({ env: {}, storage: s, logger: NULL_LOGGER, now: c.now, ttlMs: TTL });
  return {
    read: async () => h.current().gatewayToken,
    writeUnderlying: async (v) => s.put("config", { gatewayToken: v }),
    ensureFresh: () => h.ensureFresh(),
    invalidate: () => h.invalidate(),
  };
}

async function poolSubject(c: ReturnType<typeof clock>): Promise<Freshness> {
  const s = new MemoryStorage();
  const repo = new KeyPoolRepo(s, {
    now: c.now, logger: NULL_LOGGER, cacheTtlMs: TTL,
    // 关掉写消除：本文件量的是**读**的新鲜度，写消除是另一条正交的语义
    //（由 tests/unit/pool-cache.test.ts 覆盖），掺进来只会让失败原因变糊。
    touchIntervalMs: 0,
  });
  const rec = await repo.add("sk-freshness-subject-aaa");
  return {
    read: async () => String((await repo.all())[0]?.cooldownReason ?? "v0"),
    // 绕过 repo 直接改存储，模拟「另一个实例改了」。
    writeUnderlying: async (v) => s.put(KEY_PREFIX + rec.id, { ...rec, cooldownReason: v }),
    ensureFresh: async () => { await repo.all(); },
    invalidate: () => repo.invalidate(),
  };
}

const SUBJECTS = [["ConfigHolder", configSubject], ["KeyPoolRepo", poolSubject]] as const;

for (const [name, make] of SUBJECTS) {
  describe(`新鲜度契约: ${name}`, () => {
    it("初始读到底层的值", async () => {
      const c = clock();
      const f = await make(c);
      await f.ensureFresh();
      expect(await f.read()).toBe("v0");
    });

    it("底层改了但 TTL 未到 ⇒ 仍是旧值（这是被承诺的上界，不是缺陷）", async () => {
      const c = clock();
      const f = await make(c);
      await f.ensureFresh();
      await f.writeUnderlying("v1");
      c.advance(TTL - 1);
      await f.ensureFresh();
      expect(await f.read()).toBe("v0");
    });

    it("TTL 到期 ⇒ 读到新值", async () => {
      const c = clock();
      const f = await make(c);
      await f.ensureFresh();
      await f.writeUnderlying("v1");
      c.advance(TTL);
      await f.ensureFresh();
      expect(await f.read()).toBe("v1");
    });

    it("invalidate 之后立刻读到新值，不必等 TTL", async () => {
      const c = clock();
      const f = await make(c);
      await f.ensureFresh();
      await f.writeUnderlying("v1");
      f.invalidate();
      await f.ensureFresh();
      expect(await f.read()).toBe("v1");
    });
  });
}
