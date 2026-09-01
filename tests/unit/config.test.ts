import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { recordingLogger } from "../helpers/recording-logger.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";
import type { Storage } from "../../src/ports/storage.js";

describe("loadConfig", () => {
  it("无任何来源时用内置默认值", async () => {
    const c = await loadConfig({ GATEWAY_TOKEN: "t" }, new MemoryStorage());
    expect(c.agnesBaseUrl).toBe("https://apihub.agnes-ai.com/v1");
    expect(c.upstreamTimeoutMs).toBe(8000);
    expect(c.maxStrikes).toBe(3);
    expect(c.cooldownRateLimitMs).toBe(60_000);
    expect(c.cooldownPaymentMs).toBe(3_600_000);
  });

  // 同步端点（图片生成、视频建任务）的首字节要等上游把结果算完才到达，
  // 实测约 12 秒，8 秒预算会让它 100% 失败。默认值必须显著大于流式首字节的 8 秒。
  it("同步端点超时有独立默认值，且远大于流式首字节的 8 秒", async () => {
    const c = await loadConfig({ GATEWAY_TOKEN: "t" }, new MemoryStorage());
    expect(c.upstreamSyncTimeoutMs).toBe(120_000);
    expect(c.upstreamSyncTimeoutMs).toBeGreaterThanOrEqual(60_000);
  });

  it("UPSTREAM_SYNC_TIMEOUT_MS 走同一套优先级：env > 存储 > 默认", async () => {
    const s = new MemoryStorage();
    await s.put("config", { upstreamSyncTimeoutMs: 90_000 });
    expect((await loadConfig({ GATEWAY_TOKEN: "t" }, s)).upstreamSyncTimeoutMs).toBe(90_000);
    expect(
      (await loadConfig({ GATEWAY_TOKEN: "t", UPSTREAM_SYNC_TIMEOUT_MS: "150000" }, s))
        .upstreamSyncTimeoutMs,
    ).toBe(150_000);
  });

  it("调大同步超时不影响流式首字节的 8 秒", async () => {
    const c = await loadConfig(
      { GATEWAY_TOKEN: "t", UPSTREAM_SYNC_TIMEOUT_MS: "150000" },
      new MemoryStorage(),
    );
    expect(c.upstreamTimeoutMs).toBe(8000);
  });

  it("存储中的 config 键覆盖默认值", async () => {
    const s = new MemoryStorage();
    await s.put("config", { upstreamTimeoutMs: 5000 });
    const c = await loadConfig({ GATEWAY_TOKEN: "t" }, s);
    expect(c.upstreamTimeoutMs).toBe(5000);
  });

  it("环境变量优先级高于存储", async () => {
    const s = new MemoryStorage();
    await s.put("config", { upstreamTimeoutMs: 5000 });
    const c = await loadConfig({ GATEWAY_TOKEN: "t", UPSTREAM_TIMEOUT_MS: "9000" }, s);
    expect(c.upstreamTimeoutMs).toBe(9000);
  });

  it("缺少 GATEWAY_TOKEN 时抛错", async () => {
    await expect(loadConfig({}, new MemoryStorage())).rejects.toThrow(/GATEWAY_TOKEN/);
  });

  /**
   * 防住的真实故障：KV 读配额打穿（或存储临时不可用）时，**冷 isolate 起不来**——
   * `loadConfig` 抛 → `prime()` 抛 → `buildApp` 抛 → Worker 全部流量 500 / Node 重启循环。
   * 而 GATEWAY_TOKEN 明明就在环境变量里，存储那份 config 键只是覆盖层。
   * 设计文档 §5.4 定的是「env 非法 fail-fast，存储非法字段级降级」——
   * 存储**读不出来**比存储值非法更轻，不该得到更重的处置。
   *
   * ⚠️ **这条降级只在 `degradeOnUnreadable: true` 时才生效，且只该由冷启动那条
   * 路径（`createConfigHolder` 的 `prime()`）传它。** `loadConfig` 同时是
   * `ConfigHolder` 的 `Refreshable.load`，热实例每个 TTL 都会调它——那条路径上
   * `Refreshable.reload()` 本来就有严格更好的兜底（抛错时保留上一份合法快照），
   * 若默认就在这里降级，热路径上一次瞬时读抖动会把面板保存的配置静默换成默认值
   * （评审实测复现，见 tests/unit/config-holder.test.ts 那条「热实例上一次读
   * 抖动」用例）。所以默认（不传 opts）是**严格**的，见下面单独一条用例。
   */
  it("degradeOnUnreadable=true 时，存储的 config 键读不出来降级到 env + 默认值", async () => {
    const logger = recordingLogger();
    const storage: Storage = {
      get: async () => { throw new Error("read quota exhausted"); },
      put: async () => {}, delete: async () => {}, list: async () => [],
    };
    const cfg = await loadConfig(
      { GATEWAY_TOKEN: "env-token", MAX_STRIKES: "7" }, storage, logger, { degradeOnUnreadable: true },
    );
    expect(cfg.gatewayToken).toBe("env-token");
    // 让「env 覆盖」与「内置默认」在同一条用例里都出现：只验其中一个的话，
    // 「降级时把整份配置换成默认值」这种实现也能过（假阳性形态 1）。
    expect(cfg.maxStrikes).toBe(7);
    expect(cfg.cooldownRateLimitMs).toBe(60_000);
    expect(logger.has("config.storage_unreadable"), "降级必须留痕，否则运维查不出为什么面板里的配置没生效").toBe(true);
  });

  it("degradeOnUnreadable=true 时，存储读不出来**且** env 没给 gatewayToken 仍然 fail-closed", async () => {
    const storage: Storage = {
      get: async () => { throw new Error("read quota exhausted"); },
      put: async () => {}, delete: async () => {}, list: async () => [],
    };
    await expect(
      loadConfig({}, storage, NULL_LOGGER, { degradeOnUnreadable: true }),
    ).rejects.toThrow("缺少 GATEWAY_TOKEN");
  });

  it("默认（不传 opts）是严格的：存储读不出来直接如实抛，不降级——热路径靠这个", async () => {
    const storage: Storage = {
      get: async () => { throw new Error("read quota exhausted"); },
      put: async () => {}, delete: async () => {}, list: async () => [],
    };
    // 即使 env 里有合法的 GATEWAY_TOKEN（换句话说，"降级"本可以拼出一份看起来
    // 合法的配置），默认也不许把读失败吞掉——必须原样抛出去，交给调用方
    // （Refreshable.reload()）决定怎么兜底。
    await expect(
      loadConfig({ GATEWAY_TOKEN: "env-token" }, storage, NULL_LOGGER),
    ).rejects.toThrow("read quota exhausted");
  });

  it("数值型配置为非法值时抛错而不是静默取 NaN", async () => {
    await expect(
      loadConfig({ GATEWAY_TOKEN: "t", UPSTREAM_TIMEOUT_MS: "abc" }, new MemoryStorage()),
    ).rejects.toThrow(/UPSTREAM_TIMEOUT_MS/);
  });

  it("存储里的 upstreamTimeoutMs 非法时回落默认值而不是让网关起不来", async () => {
    const s = new MemoryStorage();
    await s.put("config", { upstreamTimeoutMs: "abc" as any });
    const logger = recordingLogger();
    const c = await loadConfig({ GATEWAY_TOKEN: "t" }, s, logger);
    // 断言具体默认值而不是「是个数」：回落到别的值一样是错的。
    expect(c.upstreamTimeoutMs).toBe(8000);
    expect(logger.entries.find((x) => x.event === "config.invalid")?.fields?.field)
      .toBe("upstreamTimeoutMs");
  });

  it("默认包含 30 分钟的 strike 冷却时长", async () => {
    const c = await loadConfig({ GATEWAY_TOKEN: "t" }, new MemoryStorage());
    expect(c.cooldownStrikeMs).toBe(1_800_000);
  });

  it("COOLDOWN_STRIKE_MS 走同一套优先级：env > 存储 > 默认", async () => {
    const s = new MemoryStorage();
    await s.put("config", { cooldownStrikeMs: 600_000 });
    expect((await loadConfig({ GATEWAY_TOKEN: "t" }, s)).cooldownStrikeMs).toBe(600_000);
    expect(
      (await loadConfig({ GATEWAY_TOKEN: "t", COOLDOWN_STRIKE_MS: "120000" }, s)).cooldownStrikeMs,
    ).toBe(120_000);
  });

  // 只校验 Number.isFinite 是不够的。
  // UPSTREAM_TIMEOUT_MS=-1 会让 setTimeout 立即触发（一个请求打满全池）；
  // MAX_STRIKES=0 让 `strikes >= maxStrikes` 在第一次失败时即成立，等于跳过容错。
  describe("数值下界", () => {
    const cases: [string, string][] = [
      ["UPSTREAM_TIMEOUT_MS", "-1"],
      ["UPSTREAM_TIMEOUT_MS", "0"],
      ["UPSTREAM_SYNC_TIMEOUT_MS", "-1"],
      ["UPSTREAM_SYNC_TIMEOUT_MS", "0"],
      ["UPSTREAM_SYNC_TIMEOUT_MS", "1.5"],
      ["MAX_STRIKES", "0"],
      ["MAX_STRIKES", "-3"],
      ["MAX_STRIKES", "2.5"],
      ["COOLDOWN_RATE_LIMIT_MS", "-1"],
      ["COOLDOWN_PAYMENT_MS", "0"],
      ["COOLDOWN_STRIKE_MS", "-1000"],
    ];

    for (const [name, value] of cases) {
      it(`${name}=${value} 时启动即抛错`, async () => {
        await expect(
          loadConfig({ GATEWAY_TOKEN: "t", [name]: value }, new MemoryStorage()),
        ).rejects.toThrow(new RegExp(name));
      });
    }

    it("存储中的越界数值回落默认值而不是抛错", async () => {
      const s = new MemoryStorage();
      await s.put("config", { maxStrikes: 0 });
      const logger = recordingLogger();
      const c = await loadConfig({ GATEWAY_TOKEN: "t" }, s, logger);
      expect(c.maxStrikes).toBe(3);
      expect(logger.entries.find((x) => x.event === "config.invalid")?.fields?.field).toBe("maxStrikes");
    });

    it("下界之内的合法值照常接受", async () => {
      const c = await loadConfig(
        { GATEWAY_TOKEN: "t", MAX_STRIKES: "1", UPSTREAM_TIMEOUT_MS: "1" },
        new MemoryStorage(),
      );
      expect(c.maxStrikes).toBe(1);
      expect(c.upstreamTimeoutMs).toBe(1);
    });
  });

  /**
   * 两个池子旋钮是**唯一**下界为 0 的配置项：0 对它们不是越界值，而是「关闭」这个
   * 有意义的取值，是用户在 KV 配额上的逃生口（关缓存 / 关写消除）。其余数值项的
   * 下界仍然是 1，不许被这两项顺带放宽——`MAX_STRIKES=0` 等于跳过整个容错机制。
   */
  describe("key 池的两个旋钮", () => {
    it("默认 60 秒缓存 + 6 小时触达间隔", async () => {
      const c = await loadConfig({ GATEWAY_TOKEN: "t" }, new MemoryStorage());
      expect(c.poolCacheTtlMs).toBe(60_000);
      expect(c.poolTouchIntervalMs).toBe(21_600_000);
    });

    it("取 0 是合法的（关闭），**不**抛错", async () => {
      const c = await loadConfig(
        { GATEWAY_TOKEN: "t", POOL_CACHE_TTL_MS: "0", POOL_TOUCH_INTERVAL_MS: "0" },
        new MemoryStorage(),
      );
      expect(c.poolCacheTtlMs).toBe(0);
      expect(c.poolTouchIntervalMs).toBe(0);
    });

    it("负数与小数仍然抛错——下界放宽到 0，不是取消校验", async () => {
      for (const [name, value] of [
        ["POOL_CACHE_TTL_MS", "-1"],
        ["POOL_CACHE_TTL_MS", "1.5"],
        ["POOL_CACHE_TTL_MS", "abc"],
        ["POOL_TOUCH_INTERVAL_MS", "-1"],
        ["POOL_TOUCH_INTERVAL_MS", "2.5"],
      ] as Array<[string, string]>) {
        await expect(
          loadConfig({ GATEWAY_TOKEN: "t", [name]: value }, new MemoryStorage()),
          `${name}=${value}`,
        ).rejects.toThrow(new RegExp(name));
      }
    });

    it("走同一套优先级：env > 存储 > 默认", async () => {
      const s = new MemoryStorage();
      await s.put("config", { poolCacheTtlMs: 5_000, poolTouchIntervalMs: 600_000 });
      const stored = await loadConfig({ GATEWAY_TOKEN: "t" }, s);
      expect(stored.poolCacheTtlMs).toBe(5_000);
      expect(stored.poolTouchIntervalMs).toBe(600_000);

      const env = await loadConfig(
        { GATEWAY_TOKEN: "t", POOL_CACHE_TTL_MS: "9000", POOL_TOUCH_INTERVAL_MS: "900000" }, s,
      );
      expect(env.poolCacheTtlMs).toBe(9_000);
      expect(env.poolTouchIntervalMs).toBe(900_000);
    });

    it("存储里的越界值回落默认值而不是把网关砖掉", async () => {
      const s = new MemoryStorage();
      await s.put("config", { poolCacheTtlMs: -5 });
      const logger = recordingLogger();
      const c = await loadConfig({ GATEWAY_TOKEN: "t" }, s, logger);
      expect(c.poolCacheTtlMs).toBe(60_000);
      expect(logger.entries.find((x) => x.event === "config.invalid")?.fields?.field)
        .toBe("poolCacheTtlMs");
    });

    it("存储里的 0 是合法值，不该被当成「非法」回落成 60 秒", async () => {
      const s = new MemoryStorage();
      await s.put("config", { poolCacheTtlMs: 0 });
      const logger = recordingLogger();
      // 面板把缓存关掉之后重启，值必须还是 0——回落成默认值等于面板上的开关是假的。
      expect((await loadConfig({ GATEWAY_TOKEN: "t" }, s, logger)).poolCacheTtlMs).toBe(0);
      expect(logger.events()).toEqual([]);
    });
  });
});
