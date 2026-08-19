import { describe, it, expect, vi } from "vitest";
import { buildTendDeps } from "../../../src/http/wire.js";
import { KeyPoolRepo } from "../../../src/core/keypool-repo.js";
import { MemoryStorage } from "../../helpers/fake-storage.js";
import { NULL_LOGGER } from "../../../src/ports/logger.js";

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

  /**
   * 补池那个 repo 必须**关掉快照缓存**。
   *
   * 计划提议的守护用例是「同一个 repo 实例连跑两轮 tend，第二轮看到第一轮铸出来的
   * key」——那条测不出东西：`repo.add()` 自己会 `invalidate()`，本实例刚铸的 key
   * 无论开不开缓存都立刻可见，删掉 `cacheTtlMs: 0` 它照样全绿。
   *
   * 真正会出事的是**别人写的**：另一个 isolate 的补池、面板新增、手工导入。读一份
   * 最多一个 TTL 前的快照会把「当前可用数」算小 ⇒ 缺口高估 ⇒ 超额补铸，而每铸一把
   * 都是一次真实的 Agnes 建号（同时撞注册风控与邮箱建号限流）。所以这里绕过 repo
   * 直接写存储，再看它认不认。
   */
  it("补池用的 repo 关掉了快照缓存——绕过它写进存储的 key 必须立刻算进可用数", async () => {
    const s = new MemoryStorage();
    const d = await buildTendDeps(
      { GATEWAY_TOKEN: "t", REGISTRAR_ENABLED: "true", REGISTRAR_PRIMARY: "yyds", YYDS_API_KEY: "k" },
      s,
    );
    const repo = d!.repo;
    expect(await repo.all()).toHaveLength(0);   // 装载一次快照

    // 模拟「另一个实例铸了一把 key」：走另一个 repo 实例写，本实例毫不知情。
    const other = new KeyPoolRepo(s, { now: () => 1000, logger: NULL_LOGGER, cacheTtlMs: 0 });
    await other.add("sk-minted-by-another-instance");

    // 时钟一动不动。看得见就只能是因为本实例压根没缓存。
    expect(
      await repo.all(),
      "补池读到旧快照会把缺口算大，白烧邮箱配额、白撞注册风控",
    ).toHaveLength(1);
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
