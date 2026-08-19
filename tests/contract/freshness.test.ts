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
  /** 闸门要卡住的那一把 key——必须是**承载被读值**的那个键，不是装载过程里第一个被读到的键。 */
  gatedKey(k: string): boolean;
  read(): Promise<string>;
  writeUnderlying(v: string): Promise<void>;
  ensureFresh(): Promise<void>;
  invalidate(): void;
}

function clock() {
  let t = 1000;
  return { now: () => t, advance(ms: number) { t += ms; } };
}

/**
 * 可闸断的存储：`get` **先取样、后交付**，闸门关上时卡在交付前。
 *
 * 真 KV 的一次读就是这个形态（一次网络往返），而「装载途中世界变了」这条竞态
 * 只有在这个窗口里才造得出来。`put` 不入闸——它模拟的是「另一个实例/面板此刻改了」。
 *
 * ⚠️ **闸门必须按键匹配。** 原来是「关上之后第一次 get 就卡住」，而 `KeyPoolRepo.loadAll()`
 * 的第一次 get 是 `pool:index`、**承载被读值的是紧随其后的 `key:<id>` 那次**——
 * 于是记录那次 get 发生在开闸之后，取到的已经是改动后的新值，
 * 「在途那次带回旧值」这个前提根本没被造出来，整格是**空断言**。
 * 评审实测：把 refreshable.ts 的代数保护删掉，只有 ConfigHolder 那格变红（1 failed / 9 passed）。
 * 改成按键匹配之后，同一条变异让**两格**都变红（2 failed / 8 passed）。
 *
 * `blocked()` 是为了去掉竞态：不等这个信号就往下走，写入与取样谁先谁后取决于
 * 微任务调度，用例会时红时绿——那比空断言更糟。
 */
class GatedStorage extends MemoryStorage {
  private release: (() => void) | null = null;
  private gate: Promise<void> | null = null;
  private match: (key: string) => boolean = () => true;
  private arrived: (() => void) | null = null;
  private arrival: Promise<void> | null = null;

  block(match: (key: string) => boolean): void {
    this.match = match;
    this.gate = new Promise<void>((r) => { this.release = r; });
    this.arrival = new Promise<void>((r) => { this.arrived = r; });
  }

  /** 解析于「一次匹配的 get 已经取完样、正卡在交付前」。 */
  blocked(): Promise<void> {
    return this.arrival ?? Promise.resolve();
  }

  open(): void {
    this.release?.();
    this.release = null;
    this.gate = null;
  }

  override async get<T>(key: string): Promise<T | null> {
    const sampled = await super.get<T>(key);
    if (this.gate && this.match(key)) {
      this.arrived?.();
      this.arrived = null;
      await this.gate;
    }
    return sampled;
  }
}

async function configSubject(c: ReturnType<typeof clock>, s: GatedStorage): Promise<Freshness> {
  await s.put("config", { gatewayToken: "v0" });
  const h = await createConfigHolder({ env: {}, storage: s, logger: NULL_LOGGER, now: c.now, ttlMs: TTL });
  return {
    gatedKey: (k) => k === "config",
    read: async () => h.current().gatewayToken,
    writeUnderlying: async (v) => s.put("config", { gatewayToken: v }),
    ensureFresh: () => h.ensureFresh(),
    invalidate: () => h.invalidate(),
  };
}

async function poolSubject(c: ReturnType<typeof clock>, s: GatedStorage): Promise<Freshness> {
  const repo = new KeyPoolRepo(s, {
    now: c.now, logger: NULL_LOGGER, cacheTtlMs: TTL,
    // 关掉写消除：本文件量的是**读**的新鲜度，写消除是另一条正交的语义
    //（由 tests/unit/pool-cache.test.ts 覆盖），掺进来只会让失败原因变糊。
    touchIntervalMs: 0,
  });
  const rec = await repo.add("sk-freshness-subject-aaa");
  return {
    gatedKey: (k) => k.startsWith(KEY_PREFIX),
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
    const subject = async (c: ReturnType<typeof clock>) => {
      const s = new GatedStorage();
      return { s, f: await make(c, s) };
    };

    it("初始读到底层的值", async () => {
      const c = clock();
      const { f } = await subject(c);
      await f.ensureFresh();
      expect(await f.read()).toBe("v0");
    });

    it("底层改了但 TTL 未到 ⇒ 仍是旧值（这是被承诺的上界，不是缺陷）", async () => {
      const c = clock();
      const { f } = await subject(c);
      await f.ensureFresh();
      await f.writeUnderlying("v1");
      c.advance(TTL - 1);
      await f.ensureFresh();
      expect(await f.read()).toBe("v0");
    });

    it("TTL 到期 ⇒ 读到新值", async () => {
      const c = clock();
      const { f } = await subject(c);
      await f.ensureFresh();
      await f.writeUnderlying("v1");
      c.advance(TTL);
      await f.ensureFresh();
      expect(await f.read()).toBe("v1");
    });

    it("invalidate 之后立刻读到新值，不必等 TTL", async () => {
      const c = clock();
      const { f } = await subject(c);
      await f.ensureFresh();
      await f.writeUnderlying("v1");
      f.invalidate();
      await f.ensureFresh();
      expect(await f.read()).toBe("v1");
    });

    /**
     * **在途刷新不许把 invalidate 吃掉。**
     *
     * 真存储的一次装载是「先取样、后交付」。取样之后、交付之前，面板/补池完全
     * 可能把底层改掉并调 `invalidate()`；那次在途刷新随后落地，如果它无条件推进
     * 「上次加载时刻」，就等于把**改动之前**那份快照盖回来并锁住一整个 TTL：
     * 对 `KeyPoolRepo` 是「刚删掉的 key 继续被选中」「刚铸出来的 key 下个请求看不见」，
     * 对 `ConfigHolder` 是「已撤销的口令再活一个 TTL」——同一个洞，两处后果。
     */
    it("装载途中被 invalidate ⇒ 在途那次结果不算数，下一次一定重新读", async () => {
      const c = clock();
      const { s, f } = await subject(c);
      await f.ensureFresh();
      expect(await f.read()).toBe("v0");

      c.advance(TTL);           // 让下面这次 ensureFresh 真的触发重载
      s.block(f.gatedKey);      // 只卡住承载被读值的那把 key
      const inflight = f.ensureFresh();
      await s.blocked();        // 确定性地等到「取样完成、卡在交付前」

      // 世界在这次装载的中途变了，而且调用方**明确**调了 invalidate。
      await f.writeUnderlying("v1");
      f.invalidate();

      s.open();
      await inflight;           // 在途那次落地，带回来的是取样时的 v0

      // 时钟一动不动：读到 v1 就只能是因为它真的重新读了一遍。
      await f.ensureFresh();
      expect(await f.read(), "在途刷新把 invalidate 吃掉了").toBe("v1");
    });
  });
}
