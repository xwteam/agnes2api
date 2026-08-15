import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { MemoryStorage } from "../helpers/fake-storage.js";

describe("loadConfig", () => {
  it("无任何来源时用内置默认值", async () => {
    const c = await loadConfig({ GATEWAY_TOKEN: "t" }, new MemoryStorage());
    expect(c.agnesBaseUrl).toBe("https://apihub.agnes-ai.com/v1");
    expect(c.upstreamTimeoutMs).toBe(8000);
    expect(c.maxStrikes).toBe(3);
    expect(c.cooldownRateLimitMs).toBe(60_000);
    expect(c.cooldownPaymentMs).toBe(3_600_000);
  });

  // C-RM2：同步端点（图片生成、视频建任务）的首字节要等上游把结果算完才到达，
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

  it("数值型配置为非法值时抛错而不是静默取 NaN", async () => {
    await expect(
      loadConfig({ GATEWAY_TOKEN: "t", UPSTREAM_TIMEOUT_MS: "abc" }, new MemoryStorage()),
    ).rejects.toThrow(/UPSTREAM_TIMEOUT_MS/);
  });

  it("存储中的数值型配置为非法值时抛错", async () => {
    const s = new MemoryStorage();
    await s.put("config", { upstreamTimeoutMs: "abc" as any });
    await expect(loadConfig({ GATEWAY_TOKEN: "t" }, s)).rejects.toThrow(/upstreamTimeoutMs/);
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

  // M4：只校验 Number.isFinite 是不够的。
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

    it("存储中的越界数值同样抛错", async () => {
      const s = new MemoryStorage();
      await s.put("config", { maxStrikes: 0 });
      await expect(loadConfig({ GATEWAY_TOKEN: "t" }, s)).rejects.toThrow(/maxStrikes/);
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
});
