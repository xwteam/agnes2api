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

  /**
   * K8 要救的是**冷启动**那条链（prime() 抛 → buildApp 抛 → 全部流量 500），
   * 不能连带把**热路径**的降级语义也改了。`loadConfig` 同时是
   * `Refreshable.load`，热实例每 30 秒的例行刷新走的也是它——那条路径上
   * `Refreshable.reload()` 本来就有**严格更好**的行为：抛错时原样保留上一份
   * 合法快照（上面那条用例钉的就是这个）。如果 `loadConfig` 自己在内部把
   * 「存储读不出来」吞成「降级到默认值」，热路径上一次瞬时读抖动就会把面板
   * 保存的配置**静默**换成内置默认值——而且免费档读桶是按 UTC 天重置的，
   * 这不是 30 秒的抖动，是剩下的一整天。
   *
   * ⚠️ **`env` 必须显式给 `GATEWAY_TOKEN`。** 上面那条用例 `env: {}`，于是即使
   * `loadConfig` 内部把「读不出来」错误地吞成「降级」，`stored` 也被清空、
   * `gatewayToken` 从 env 和 storage 两边都拿不到，`loadConfig` 仍然会因为
   * 「缺少 GATEWAY_TOKEN」这条 fatal 判据而抛出——错误照样冒给
   * `Refreshable.reload()` 兜底，凑巧掩盖了这个缺陷（本用例第一版就是这么
   * 写的，自查时才发现测不出东西）。只有 env 里已经有 token 时，「降级」才会
   * 成功产出一份**看起来合法**的配置而不抛错，缺陷才暴露得出来。
   */
  it("热实例上一次读抖动（不是冷启动）之后，面板保存的字段一个都不许被静默换成默认值", async () => {
    const c = clock();
    const s = new MemoryStorage();
    await s.put("config", {
      maxStrikes: 9,
      cooldownStrikeMs: 7_777_000,
      registrar: { enabled: true, primary: "yyds", yyds: { baseUrl: "https://yyds.test", apiKey: "k" } },
    });
    const logger = recordingLogger();

    // 第二次 get 才抛：第一次是 prime()（冷启动，必须成功读到真实值），
    // 第二次是 TTL 到期后 ensureFresh() 触发的例行刷新（热路径，撞上瞬时抖动）。
    let calls = 0;
    const flaky = {
      async get<T>(k: string): Promise<T | null> {
        if (++calls > 1) throw new Error("KV read quota exhausted");
        return s.get<T>(k);
      },
      async put<T>(k: string, v: T) { return s.put(k, v); },
      async delete(k: string) { return s.delete(k); },
      async list(p: string) { return s.list(p); },
    };
    const h = await createConfigHolder({ env: { GATEWAY_TOKEN: "env-token" }, storage: flaky, logger, now: c.now });
    expect(h.current().maxStrikes, "前置条件：先真的读到了面板存的值").toBe(9);
    expect(h.current().registrar.enabled, "前置条件：先真的读到了面板存的值").toBe(true);

    c.advance(CONFIG_TTL_MS);
    await h.ensureFresh(); // 内部这次 storage.get 会抛

    expect(h.current().maxStrikes, "热路径抖动把面板存的值换成默认值了").toBe(9);
    expect(h.current().cooldownStrikeMs, "热路径抖动把面板存的值换成默认值了").toBe(7_777_000);
    expect(h.current().registrar.enabled, "热路径抖动把补池悄悄关掉了").toBe(true);
    // 事件走的是既有的 reload 失败通路，不是 config.storage_unreadable
    //（那条只在 degradeOnUnreadable=true 的冷启动路径上才会打）。
    expect(logger.has("config.reload_failed"), "抖动必须留痕").toBe(true);
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
