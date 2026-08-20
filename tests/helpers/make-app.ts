import { createApp } from "../../src/http/app.js";
import { fixedConfigHolder } from "../../src/http/config-holder.js";
import { KeyPoolRepo } from "../../src/core/keypool-repo.js";
import { createStorageHealth } from "../../src/core/storage-health.js";
import { MemoryStorage } from "./fake-storage.js";
import { FakeFetcher } from "./fake-fetcher.js";
import type { GatewayConfig } from "../../src/core/config.js";
import { registrarFromEnv } from "../../src/core/registrar/config.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";
import { recordingLogger } from "./recording-logger.js";
import type { Storage } from "../../src/ports/storage.js";
import type { RuntimeInfo } from "../../src/ports/runtime.js";
import { nodeRuntime } from "../../src/adapters/runtime-node.js";
import { StoreLogger } from "../../src/adapters/logger-store.js";
import { multiLogger } from "../../src/adapters/logger-multi.js";

/**
 * 夹具的管理口令。27 位（≥ ADMIN_TOKEN_MIN_LENGTH），且与 `TEST_CONFIG.gatewayToken`
 * 不同——两条硬规则都得满足，否则 /admin 根本不会被注册。
 */
export const TEST_ADMIN_TOKEN = "test-admin-token-0123456789";

export interface MakeAppOptions {
  /**
   * **显式传 `undefined` 表示「没配 ADMIN_TOKEN」**，与「不传这个键」是两回事：
   * 后者取默认值 `TEST_ADMIN_TOKEN`。所以下面用 `in` 判断而不是 `??`——P1 那次
   * 实际发生的鉴权绕过，成因正是 `??` 对空串/undefined 的下坠语义。
   */
  adminToken?: string | undefined;
  trustProxy?: boolean;
  /**
   * 注入的存储。默认 `new MemoryStorage()`。
   * 存在的理由：好几条不变量（记账失败不影响响应、overview 逐块降级、事件落库）
   * 只有在「存储会在指定时机抛错」时才可观测，而照抄一遍 wire.ts 的装配去验证，
   * 验证的永远是抄件不是原件（P3a Task 4 已实测过这个陷阱）。
   */
  storage?: Storage;
  /**
   * 双运行时差异的唯一注入点。**默认 `nodeRuntime()`**——契约测试里 workerd 那一侧
   * 需要显式注入 `workerRuntime()` 的用例另外传（见 admin-capabilities/admin-overview
   * 契约测试），不能靠默认值蒙混过关：那正是「两个适配器返回同一份东西」这种实现
   * 完全无感的第 1 种假阳性。
   */
  runtime?: RuntimeInfo;
  /** 被环境变量锁定的字段清单。默认空数组。 */
  envLocked?: readonly string[];
  /**
   * 事件落库分片 id（Task 6）。默认固定字符串——测试要断言可预测的存储键
   * （`event:<shardId>`），不能用生产那种每次随机的 `crypto.randomUUID()`。
   */
  shardId?: string;
}

export const TEST_CONFIG: GatewayConfig = {
  gatewayToken: "t", agnesBaseUrl: "https://upstream.test/v1",
  upstreamTimeoutMs: 8000, upstreamSyncTimeoutMs: 120_000, maxStrikes: 3,
  cooldownRateLimitMs: 60_000, cooldownPaymentMs: 3_600_000, cooldownStrikeMs: 1_800_000,
  // **夹具默认关掉快照缓存与写消除**：既有的几百条用例没有一条是为「有缓存」写的
  // （它们直接改存储再断言 all()、或者数 put 次数），开着缓存会把其中一批变成
  // 「测的是缓存而不是它自己那条不变量」的假阳性。两者本身由
  // tests/unit/pool-cache.test.ts 与 tests/contract/freshness.test.ts 专门覆盖。
  poolCacheTtlMs: 0, poolTouchIntervalMs: 0,
  // 注册机默认关闭，测试夹具无需凭据。
  registrar: registrarFromEnv({}, {}),
  degraded: false,
};

/**
 * `now` 默认是固定的 1000，好让断言能写死 `cooldownUntil` 这类绝对时刻。
 * 需要「时间真的在走」的用例（同步档的跨 key 整体 deadline）传 `() => Date.now()`。
 *
 * **默认就带一棵 /admin 树**（`adminToken` 默认 `TEST_ADMIN_TOKEN`）。这是想要的：
 * 枚举式鉴权矩阵正是要在**默认夹具**上跑，才守得住「新加的端点忘了挂鉴权」。
 */
export async function makeApp(
  outcomes: ConstructorParameters<typeof FakeFetcher>[0] = [],
  keys = ["k1"],
  configOverride: Partial<GatewayConfig> = {},
  now: () => number = () => 1000,
  options: MakeAppOptions = {},
) {
  const config = { ...TEST_CONFIG, ...configOverride };
  // **评审 C5 追加**：默认存储与下面的 StoreLogger 必须共用同一个 `now`——
  // `MemoryStorage` 的 TTL 判定默认走真实 `Date.now()`，本仓测试里的假时钟
  // 几乎全是贴近纪元零点的小数值（`() => 1000`/`let t = 0` 这类），如果不对齐，
  // `StoreLogger` 算出来的 `expiresAt`（同样基于这个假时钟）相对于 `MemoryStorage`
  // 的真实内部时钟必然"生下来就已经过期"，任何经这条默认路径落盘的事件都会立刻
  // 读不到——已实测过一次（详见 P3b Task 6 报告"评审修复轮 4"）。
  const storage = options.storage ?? new MemoryStorage(undefined, now);
  // 与 wire.ts 同一条接线：两个旋钮从配置来，而不是各写各的默认值。
  // 不这么接的话 TEST_CONFIG 里那两个 0 是**死字段**，夹具以为关了缓存其实开着。
  const repo = new KeyPoolRepo(storage, {
    now, logger: NULL_LOGGER,
    cacheTtlMs: config.poolCacheTtlMs,
    touchIntervalMs: config.poolTouchIntervalMs,
  });
  for (const k of keys) await repo.add(k);
  const fetcher = new FakeFetcher(outcomes);
  const storageHealth = createStorageHealth();
  // app 用 recordingLogger（而不是 NULL_LOGGER）：`admin.login_failed` 这类事件
  // 是鉴权唯一对外可断言的行为，静默掉就没法验。repo 仍旧静默——它的日志与本组
  // 断言无关，混进来只会让 entries 变吵。
  const recording = recordingLogger();
  // 事件落库 sink（Task 6）。**与 repo 共用同一个 `storage`/`now`**——这样
  // `tests/contract/admin-events.test.ts` 注入自己的 `CountingStorage` 时，落盘
  // 真的打在调用方能观测到的那个实例上，不是另一份照抄的装配（同一条理由见
  // wire.ts 的 buildApp）。`recording` 仍旧是外部看到的 `logger`（保留
  // `.entries`/`.has()`/`.clear()`），multiLogger 只用在**传给 createApp 那一份**。
  const storeLogger = new StoreLogger({
    storage, now, shardId: options.shardId ?? "test-shard", onError: () => {},
  });
  const app = createApp({
    version: "0.1.0",
    configHolder: fixedConfigHolder(config),
    repo, fetcher, now, storageHealth,
    logger: multiLogger(recording, storeLogger),
    adminToken: "adminToken" in options ? options.adminToken : TEST_ADMIN_TOKEN,
    trustProxy: options.trustProxy ?? false,
    runtime: options.runtime ?? nodeRuntime(),
    envLocked: options.envLocked ?? [],
    storeLogger,
  });
  return { app, fetcher, repo, storageHealth, logger: recording, storage, storeLogger };
}
