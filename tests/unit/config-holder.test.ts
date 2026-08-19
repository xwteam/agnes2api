import { describe, it, expect } from "vitest";
import { createConfigHolder, fixedConfigHolder, CONFIG_TTL_MS } from "../../src/http/config-holder.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { recordingLogger } from "../helpers/recording-logger.js";
import { TEST_CONFIG } from "../helpers/make-app.js";

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance(ms: number) { t += ms; } };
}

describe("ConfigHolder", () => {
  it("冷启动缺 GATEWAY_TOKEN 时 create 直接抛——P1 的三条不变量之一，不许被 TTL 兜底吞掉", async () => {
    await expect(createConfigHolder({
      env: {}, storage: new MemoryStorage(), logger: recordingLogger(), now: () => 0,
    })).rejects.toThrow(/GATEWAY_TOKEN/);
  });

  it("存储里的 gatewayToken 改了之后，最多一个 TTL 就生效——这是「口令能撤销」的全部依据", async () => {
    const c = clock();
    const s = new MemoryStorage();
    await s.put("config", { gatewayToken: "old-token" });
    // 刻意**不设** env.GATEWAY_TOKEN：这正是「撤销不掉的凭据」那个安全缺陷的触发条件。
    const h = await createConfigHolder({ env: {}, storage: s, logger: recordingLogger(), now: c.now });
    expect(h.current().gatewayToken).toBe("old-token");

    await s.put("config", { gatewayToken: "new-token" });
    await h.ensureFresh();
    expect(h.current().gatewayToken, "TTL 内不该变").toBe("old-token");

    c.advance(CONFIG_TTL_MS);
    await h.ensureFresh();
    expect(h.current().gatewayToken).toBe("new-token");
  });

  it("invalidate 之后立刻生效——面板 PUT 成功后走的就是这条路", async () => {
    const c = clock();
    const s = new MemoryStorage();
    await s.put("config", { gatewayToken: "old-token" });
    const h = await createConfigHolder({ env: {}, storage: s, logger: recordingLogger(), now: c.now });
    await s.put("config", { gatewayToken: "new-token" });
    h.invalidate();
    await h.ensureFresh();
    expect(h.current().gatewayToken).toBe("new-token");
  });

  it("重载失败保留上一份并记 config.reload_failed——绝不让网关跟着挂", async () => {
    const c = clock();
    const s = new MemoryStorage();
    await s.put("config", { gatewayToken: "good" });
    const logger = recordingLogger();

    // 让存储在第二次 get 时真的抛，而不是返回一个「失败对象」。
    let calls = 0;
    const flaky = {
      async get<T>(k: string): Promise<T | null> { if (++calls > 1) throw new Error("KV 挂了"); return s.get<T>(k); },
      async put<T>(k: string, v: T) { return s.put(k, v); },
      async delete(k: string) { return s.delete(k); },
      async list(p: string) { return s.list(p); },
    };
    const h3 = await createConfigHolder({ env: {}, storage: flaky, logger, now: c.now });
    expect(h3.current().gatewayToken).toBe("good");
    c.advance(CONFIG_TTL_MS);
    await expect(h3.ensureFresh()).resolves.toBeUndefined();
    expect(h3.current().gatewayToken, "失败后仍是上一份合法快照").toBe("good");
    expect(logger.has("config.reload_failed")).toBe(true);
  });
});

describe("存储里的非法值：字段级降级（面板的一次误操作不得把网关砖掉）", () => {
  it("存储的 upstreamTimeoutMs 非法时回落默认值并记 config.invalid，**不抛错**", async () => {
    const s = new MemoryStorage();
    await s.put("config", { gatewayToken: "t", upstreamTimeoutMs: -5 });
    const logger = recordingLogger();
    const h = await createConfigHolder({ env: {}, storage: s, logger, now: () => 0 });
    expect(h.current().upstreamTimeoutMs).toBe(8000);
    const e = logger.entries.find((x) => x.event === "config.invalid");
    expect(e?.fields?.field).toBe("upstreamTimeoutMs");
    expect(e?.fields?.source).toBe("stored");
  });

  it("**环境变量**的非法值继续 fail-fast——那是部署时错误，运维必须立刻看得见", async () => {
    await expect(createConfigHolder({
      env: { GATEWAY_TOKEN: "t", UPSTREAM_TIMEOUT_MS: "abc" },
      storage: new MemoryStorage(), logger: recordingLogger(), now: () => 0,
    })).rejects.toThrow(/UPSTREAM_TIMEOUT_MS/);
  });

  it("多个字段同时非法时逐个降级，且每个各记一条事件", async () => {
    const s = new MemoryStorage();
    await s.put("config", { gatewayToken: "t", maxStrikes: 0, cooldownPaymentMs: "x" });
    const logger = recordingLogger();
    const h = await createConfigHolder({ env: {}, storage: s, logger, now: () => 0 });
    expect(h.current().maxStrikes).toBe(3);
    expect(h.current().cooldownPaymentMs).toBe(3_600_000);
    expect(logger.entries.filter((x) => x.event === "config.invalid").map((x) => x.fields?.field).sort())
      .toEqual(["cooldownPaymentMs", "maxStrikes"]);
  });

  it("RESET_CONFIG=1 时整个忽略存储的 config 键——但只忽略不删，是逃生口不是删除键", async () => {
    const s = new MemoryStorage();
    await s.put("config", { gatewayToken: "stored-token", upstreamTimeoutMs: 4321 });
    const h = await createConfigHolder({
      env: { GATEWAY_TOKEN: "env-token", RESET_CONFIG: "1" },
      storage: s, logger: recordingLogger(), now: () => 0,
    });
    expect(h.current().upstreamTimeoutMs).toBe(8000);
    expect(await s.get("config"), "存储里那份必须原封不动").toEqual({
      gatewayToken: "stored-token", upstreamTimeoutMs: 4321,
    });
  });

  it("gatewayToken 完全缺失仍然 fatal——没有口令就无法鉴权，继续跑更危险", async () => {
    const s = new MemoryStorage();
    await s.put("config", { upstreamTimeoutMs: 5000 });
    await expect(createConfigHolder({
      env: {}, storage: s, logger: recordingLogger(), now: () => 0,
    })).rejects.toThrow(/GATEWAY_TOKEN/);
  });
});

describe("fixedConfigHolder", () => {
  it("current 恒返回同一份，ensureFresh 与 invalidate 都是 no-op", async () => {
    const h = fixedConfigHolder(TEST_CONFIG);
    h.invalidate();
    await h.ensureFresh();
    expect(h.current()).toBe(TEST_CONFIG);
  });
});
