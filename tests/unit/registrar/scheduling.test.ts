import { describe, it, expect, vi } from "vitest";
import { buildTendDeps } from "../../../src/http/wire.js";
import { MemoryStorage } from "../../helpers/fake-storage.js";

describe("buildTendDeps", () => {
  it("注册机未启用时返回 null（不构造任何 provider）", async () => {
    const d = await buildTendDeps({ GATEWAY_TOKEN: "t" }, new MemoryStorage());
    expect(d).toBeNull();
  });

  it("启用后返回可用依赖，且只构造配置声明的通道", async () => {
    const d = await buildTendDeps(
      { GATEWAY_TOKEN: "t", REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k" },
      new MemoryStorage(),
    );
    expect(d).not.toBeNull();
    expect(d!.providers.yyds).toBeDefined();
    expect(d!.providers.moemail).toBeUndefined();
  });

  it("启用两条通道时两个 provider 都构造", async () => {
    const d = await buildTendDeps({
      GATEWAY_TOKEN: "t", REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k",
      REGISTRAR_FALLBACK: "moemail", MOEMAIL_BASE_URL: "https://m.test", MOEMAIL_API_KEY: "mk",
    }, new MemoryStorage());
    expect(d!.providers.yyds).toBeDefined();
    expect(d!.providers.moemail).toBeDefined();
  });
});

describe("Worker scheduled 处理器", () => {
  it("未启用时不调 tendOnce", async () => {
    const mod = await import("../../../src/entry/worker.js");
    const spy = vi.fn();
    // scheduled 内部通过 buildTendDeps 得到 null 后直接返回，不应抛错
    await expect(
      mod.default.scheduled!(
        { scheduledTime: Date.now(), cron: "*/30 * * * *" } as ScheduledController,
        { GATEWAY_TOKEN: "t", POOL: new MemoryStorage() } as never,
        { waitUntil: spy, passThroughOnException: () => {} } as never,
      ),
    ).resolves.toBeUndefined();
    // 未启用时零副作用：waitUntil 不该被调用（没有后台任务要延长执行）。
    expect(spy).not.toHaveBeenCalled();
  });
});
