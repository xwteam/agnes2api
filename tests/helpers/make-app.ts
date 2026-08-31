import { createApp } from "../../src/http/app.js";
import { fixedConfigHolder, createConfigHolder } from "../../src/http/config-holder.js";
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
import type { RegistrarWiring } from "../../src/http/admin/handlers/registrar.js";
import type { TendGate } from "../../src/http/admin/tend-lock.js";
import type { ConfigWiring } from "../../src/http/admin/handlers/config.js";
import type { UsageSink } from "../../src/http/usage-sink.js";

/**
 * 夹具的管理口令。27 位（≥ ADMIN_TOKEN_MIN_LENGTH），且与 `TEST_CONFIG.gatewayToken`
 * 不同——两条硬规则都得满足，否则 /admin 根本不会被注册。
 */
export const TEST_ADMIN_TOKEN = "test-admin-token-0123456789";

export interface MakeAppOptions {
  /**
   * **显式传 `undefined` 表示「没配 ADMIN_TOKEN」**，与「不传这个键」是两回事：
   * 后者取默认值 `TEST_ADMIN_TOKEN`。所以下面用 `in` 判断而不是 `??`——早期那次
   * 实际发生的鉴权绕过，成因正是 `??` 对空串/undefined 的下坠语义。
   */
  adminToken?: string | undefined;
  trustProxy?: boolean;
  /**
   * 注入的存储。默认 `new MemoryStorage()`。
   * 存在的理由：好几条不变量（记账失败不影响响应、overview 逐块降级、事件落库）
   * 只有在「存储会在指定时机抛错」时才可观测，而照抄一遍 wire.ts 的装配去验证，
   * 验证的永远是抄件不是原件（已实测过这个陷阱）。
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
   * 事件落库分片 id。默认固定字符串——测试要断言可预测的存储键
   * （`event:<shardId>`），不能用生产那种每次随机的 `crypto.randomUUID()`。
   */
  shardId?: string;
  /**
   * 用**生产那一个** `ConfigHolder`（`createConfigHolder` + `CONFIG_TTL_MS`），
   * 而不是 `fixedConfigHolder`。
   *
   * ⚠️ **配额类用例必须传它**（评审发现）。`fixedConfigHolder.ensureFresh`
   * 是一个空函数，于是**生产上每请求都会经过的那次配置读在夹具里根本不存在**：
   * `configRefresh` 中间件挂在 `createApp` 的第一位，TTL 是 30 秒，而事件板块稳态
   * 的轮询间隔是 60 秒 ⇒ 生产上**每一轮轮询恰好多一次 `storage.get("config")`**。
   * 用固定 holder 量出来的 48 次/轮是**只属于夹具的数字**，五语言 DEPLOY.md 却
   * 拿它对用户承诺了一条读配额包线——这正是本仓登记的"我验的是我实现的那条路径，
   * 不是文档承诺的那件事"。
   *
   * 代价：这条路径上的配置只从 `env.GATEWAY_TOKEN` + 内置默认值来，`configOverride`
   * 对**它**无效（`repo` 那两个旋钮跟着 holder 的实际值走，见下面的接线）。
   * 需要改配置又要真 holder 的用例请直接往 `storage` 里写 `config` 键。
   */
  realConfigHolder?: boolean;
  /**
   * 注册机的接线（先建了一样，后来扩到三样成套）。
   * **默认不传 ⇒ `createApp` 收到 `undefined`**，三条端点会如实回 `503 not_wired`。
   *
   * 需要真的验四条护栏的用例传一个可控的执行体进来（例如一个手动 resolve 的
   * promise，好让「上一轮还在跑」这个状态**在断言的那一刻真的成立**）。
   * **`storage` 必须与用例自己观测的那一个是同一个实例**——护栏键、补池锁与补池历史
   * 都写在它上面，另给一份就是「测的是抄件不是原件」。
   */
  registrar?: RegistrarWiring;
  /**
   * 补池在途守卫。默认让 `createApp` 自己建一把（每个 app 一把，与 Worker 的
   * `fetch` isolate 形态一致）。两个 app 要共用同一把（模拟 Node 单进程里
   * 定时轮 × 面板按钮）的用例显式传同一个实例。
   */
  tendGate?: TendGate;
  /**
   * 配置读写的接线。**默认不传 ⇒ `createApp` 收到 `undefined`**，
   * 四条端点会如实回 `503 not_wired`。
   *
   * ⚠️ **`storage` 必须与用例自己观测的那一个是同一个实例**：`config` 键就写在
   * 它上面，另给一份就是「测的是抄件不是原件」。
   * ⚠️ **`env` 是这条接线判别力的另一半**：`lockedBy` 与 `locked_by_env` 两条
   * 都只从它来，传一个空对象等于把「被环境变量锁定」这整条性质做成不可观测。
   */
  config?: ConfigWiring;
  /**
   * Tier-2 用量 sink。**默认不传 ⇒ `createApp` 收到 `undefined`
   * ⇒ Tier-2 关着**，与生产默认值一致，既有的几百条用例行为一个字节都没变。
   *
   * ⚠️ **传它只覆盖「sink 存在之后会发生什么」那一半**：「`USAGE_STATS_ENABLED`
   * 到底决不决定 sink 建不建」是 `wire.ts` 的事，那一半必须走 `buildApp`
   *（见 `tests/contract/usage-tier2.test.ts` 里那两组各自的说明）。
   * **`storage` 必须与用例自己观测的那一个是同一个实例**，否则数的是另一份装配。
   */
  usageSink?: UsageSink;
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
  // **Tier-2 默认关，与生产默认值逐字相同**（全局约束）。
  // ⚠️ 把它改成 true 在这里是**无效**的：`createApp` 认的是 `AppDeps.usageSink`
  // 那一格（建没建 sink），不是配置里这个开关——真正读这个开关的是 `wire.ts`。
  // ⇒ 要验 Tier-2 的用例走 `buildApp` + `USAGE_STATS_ENABLED`，
  // 那才是原件（`tests/contract/usage-tier2.test.ts` 全组都这么做）。
  usageStatsEnabled: false,
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
  // **评审追加**：默认存储与下面的 StoreLogger 必须共用同一个 `now`——
  // `MemoryStorage` 的 TTL 判定默认走真实 `Date.now()`，本仓测试里的假时钟
  // 几乎全是贴近纪元零点的小数值（`() => 1000`/`let t = 0` 这类），如果不对齐，
  // `StoreLogger` 算出来的 `expiresAt`（同样基于这个假时钟）相对于 `MemoryStorage`
  // 的真实内部时钟必然"生下来就已经过期"，任何经这条默认路径落盘的事件都会立刻
  // 读不到——已实测过一次（当时的"评审修复轮 4"登记在案）。
  const storage = options.storage ?? new MemoryStorage(undefined, now);
  // 生产 holder 那一支的 `prime()` 会真的读一次 `config` 键（配额类用例都在
  // makeApp 返回之后才开始计数，所以这一次落在量测窗口之外）。
  const configHolder = options.realConfigHolder
    ? await createConfigHolder({
      env: { GATEWAY_TOKEN: config.gatewayToken }, storage, logger: NULL_LOGGER, now,
    })
    : fixedConfigHolder(config);
  // 与 wire.ts 同一条接线：两个旋钮从配置来，而不是各写各的默认值。
  // 不这么接的话 TEST_CONFIG 里那两个 0 是**死字段**，夹具以为关了缓存其实开着。
  // **从 holder 现读**而不是从 `config` 拷：走真 holder 那一支时两者并不相同
  // （真 holder 用的是内置默认值），拷 `config` 会让 repo 与 app 各按一份不同的
  // 配置跑——那正是本仓反复登记的"测的是抄件不是原件"。
  const effective = configHolder.current();
  const repo = new KeyPoolRepo(storage, {
    now, logger: NULL_LOGGER,
    cacheTtlMs: effective.poolCacheTtlMs,
    touchIntervalMs: effective.poolTouchIntervalMs,
  });
  for (const k of keys) await repo.add(k);
  const fetcher = new FakeFetcher(outcomes);
  const storageHealth = createStorageHealth();
  // app 用 recordingLogger（而不是 NULL_LOGGER）：`admin.login_failed` 这类事件
  // 是鉴权唯一对外可断言的行为，静默掉就没法验。repo 仍旧静默——它的日志与本组
  // 断言无关，混进来只会让 entries 变吵。
  const recording = recordingLogger();
  // 事件落库 sink。**与 repo 共用同一个 `storage`/`now`**——这样
  // `tests/contract/admin-events.test.ts` 注入自己的 `CountingStorage` 时，落盘
  // 真的打在调用方能观测到的那个实例上，不是另一份照抄的装配（同一条理由见
  // wire.ts 的 buildApp）。`recording` 仍旧是外部看到的 `logger`（保留
  // `.entries`/`.has()`/`.clear()`），multiLogger 只用在**传给 createApp 那一份**。
  const storeLogger = new StoreLogger({
    storage, now, shardId: options.shardId ?? "test-shard", onError: () => {},
  });
  const app = createApp({
    version: "0.1.0",
    configHolder,
    repo, fetcher, now, storageHealth,
    logger: multiLogger(recording, storeLogger),
    adminToken: "adminToken" in options ? options.adminToken : TEST_ADMIN_TOKEN,
    trustProxy: options.trustProxy ?? false,
    runtime: options.runtime ?? nodeRuntime(),
    envLocked: options.envLocked ?? [],
    storeLogger,
    // 两者都原样透传（含 `undefined`）：`createApp` 自己有兜底，而在这里替它兜底
    // 会让「没接执行体」这个真实形态在夹具里不可达。
    registrar: options.registrar,
    tendGate: options.tendGate,
    config: options.config,
    // 原样透传（含 `undefined`）：**缺席就是 Tier-2 关着**，那是生产默认值，
    // 在这里替它兜底会让「关」这个真实形态在夹具里不可达。
    usageSink: options.usageSink,
  });
  return { app, fetcher, repo, storageHealth, logger: recording, storage, storeLogger };
}
