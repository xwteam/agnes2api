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
});
