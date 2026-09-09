import type { Hono } from "hono";
import { createApp } from "./app.js";
import { createApiKeyHolder, resolveApiKeyCacheTtl } from "./apikey-holder.js";
import { createConfigHolder, type ConfigHolder } from "./config-holder.js";
import { loadConfig, envLockedFields } from "../core/config.js";
import { loadConfigWithProvenance } from "../core/config-provenance.js";
import { KeyPoolRepo } from "../core/keypool-repo.js";
import type { RuntimeInfo } from "../ports/runtime.js";
import { NativeFetcher } from "../adapters/fetcher-native.js";
import { createStorageHealth, probeWritable, watchStorage } from "../core/storage-health.js";
import { VERSION } from "../version.js";
import type { Storage } from "../ports/storage.js";
import type { Channel } from "../core/registrar/config.js";
import type { MailProvider } from "../ports/mailbox.js";
import type { TendDeps, TendResult } from "../core/registrar/tender.js";
import {
  TEND_HISTORY_KEY, appendTendHistory, narrowTendHistory, toTendRecord, crashedTendRecord,
  type TendTrigger, type TendRecord,
} from "../core/admin/tend-history.js";
import { YydsProvider } from "../adapters/mailbox-yyds.js";
import { MoeMailProvider } from "../adapters/mailbox-moemail.js";
import { ConsoleLogger } from "../adapters/logger-console.js";
import { StoreLogger } from "../adapters/logger-store.js";
import { UsageSink, resolveUsageFlushInterval, USAGE_ERROR_REPORT } from "./usage-sink.js";
import { multiLogger } from "../adapters/logger-multi.js";
import type { Logger } from "../ports/logger.js";
import { createTendGate, type TendGate } from "./admin/tend-lock.js";
import type { ChannelProbe } from "./admin/handlers/registrar.js";
import { tendOnce, summarizeFailures } from "../core/registrar/tender.js";
import { WORKER_ROUND_BUDGET_MS } from "../core/registrar/types.js";
import {
  DOMAIN_LEDGER_KEY, narrowDomainLedger, mergeDomainLedger, type DomainLedger,
} from "../core/registrar/domain-ledger.js";
import {
  REGISTRAR_BACKOFF_KEY, narrowBackoff, mergeBackoff, type BackoffState,
} from "../core/registrar/backoff.js";

export interface BuildOptions {
  /**
   * 装配时探一次存储可写性（写一个探针键再删掉）。
   *
   * 只有 Node/Docker 形态该开：那里的数据目录是绑定挂载，属主不匹配就整个网关不可用，
   * 必须在启动那一刻就发现。Worker/KV 形态没有这个失败模式，而 worker 入口在每个隔离体
   * 冷启动时都会重新装配一次 app，开着它等于把 KV 的写配额消耗在健康检查上。
   */
  probeStorage?: boolean;
  /**
   * 事件落库分片 id 的生成函数。**生产用 `crypto.randomUUID().slice(0, 8)`**
   * ——每个 isolate/进程装配一次 app 时生成一次，此后终生不变（见
   * `StoreLogger` 的存储形态说明：`event:<shardId>` 每 isolate 一份）。
   * 测试注入固定值，好让分片 key 可预测、可断言。
   */
  newShardId?: () => string;
  /**
   * 这次装配里**所有**组件共用的时钟。**默认 `Date.now`，生产两个入口都不传。**
   *
   * 存在的理由与 `newShardId` 完全同源：Tier-2 的落盘间隔是 2 小时
   *（`USAGE_FLUSH_MIN_INTERVAL_MS`），**真实时钟下任何测试都等不到第一次落盘**
   * ⇒ 「开着时到底写不写」在真装配上不可观测，只剩「照抄一遍 wire.ts 的装配」
   * 这一条路，而照抄的那份永远验证不了原件（本文件 `BuiltApp.repo` 上方那段
   * 已经为同一件事付过一次代价）。
   *
   * ⚠️ **一次注入喂给这里的每一个组件**（存储可写性观测、事件 sink、配置持有者、
   * key 池、用量 sink、`createApp`），**不许只喂其中一个**：不同组件看到不同的
   * 「现在」是一种自造的假阳性——例如 `MemoryStorage` 的 TTL 按真实时钟判、
   * 而 sink 按假时钟算 `expiresAt`，落下去的键会「生下来就已经过期」
   *（实测踩过一次）。
   */
  now?: () => number;
}

/** buildApp 的返回值。两个入口都需要 configHolder：node.ts 用它取 registrar.tendIntervalMs
 * 建定时器，不必为此再单独读一次存储（见下面 buildApp 的说明）。 */
export interface BuiltApp {
  app: Hono;
  configHolder: ConfigHolder;
  /**
   * app 实际在用的那个 key 池仓储。
   *
   * 交出来的理由有两个，都不是「为了测试方便」：
   * ① 面板写完 key 之后要调 `repo.invalidate()`，而它必须是**这一个**实例
   *    ——另建一个实例调 invalidate 是纯粹的空操作，快照仍然是旧的。
   * ② 不交出来的话，「两个池子旋钮有没有真的接到 app 的 repo 上」就只能靠在测试里
   *    照抄一遍 wire.ts 的装配来验证，而照抄的那份永远验证不了原件（变异实测：
   *    把这两行删掉，全套测试逃逸）。
   */
  repo: KeyPoolRepo;
  /**
   * 这个进程 / isolate 的补池在途守卫。
   *
   * **交出来的理由与 `repo` 完全同源**：Node 入口的定时轮与面板的「立即补池」必须
   * 共用**这一把**——各拿各的等于同一个进程里两条补池可以同时跑，而「顺序铸、不并发」
   * 是功能性约束（并发会同时撞邮箱服务的建号限流与上游的注册风控），不是性能取舍。
   * `src/entry/node.ts` 原来那个 `let inFlight = false` 就是它的前身。
   *
   * 它与存储级锁**不是冗余**，作用域不同，对照表见 `src/http/admin/tend-lock.ts`。
   */
  tendGate: TendGate;
}

/**
 * 从环境变量与存储装配出完整的 app。两个入口（worker/node）都调用它，
 * 只在“用哪种 Storage 实现”上有区别，其余装配逻辑完全共用。
 *
 * 用 loadConfig 而不是 configFromEnv：buildApp 的调用方（两个入口）手上
 * 总是已经有一个 Storage 实例，loadConfig 能在 env 未显式设置时回退到
 * storage 中持久化的配置（例如未来的管理接口写入的覆盖值），是 configFromEnv
 * 的严格超集；没有理由在有 storage 可用时退化成只读 env 的版本。
 *
 * 返回值带上 `configHolder`（而不只是 `app`）：调用方若还需要读一次配置
 * （目前只有 node.ts 的定时器要取 `registrar.tendIntervalMs`），复用这一份
 * 而不是自己再调一次 loadConfig——那样会产生第二次独立的存储读取，且很容易
 * 忘记传 logger，导致配置告警在生产里静默消失（评审登记过的隐患）。
 */
export async function buildApp(
  env: Record<string, string | undefined>,
  storage: Storage,
  /**
   * **必填，不给默认值。** 默认值会让某个入口忘了传时静默退化成另一种运行时形态，
   * 而那正是「双运行时对等」（硬约束 1）最难查的失效形态——两个入口各自
   * `nodeRuntime()` / `workerRuntime()` 显式传入。
   */
  runtime: RuntimeInfo,
  options: BuildOptions = {},
): Promise<BuiltApp> {
  // **这次装配的唯一时钟**，见 `BuildOptions.now`：下面每一个要时间的组件都用它，
  // 不许有第二个时间来源。
  const now = options.now ?? (() => Date.now());
  const storageHealth = createStorageHealth();
  const consoleLogger = new ConsoleLogger();
  // 包一层之后，后续所有写操作（key 池状态回写、启动探测）的成败都会自动反映到
  // /health 上，健康检查自身不需要再写盘。
  const watched = watchStorage(storage, storageHealth, now);

  /**
   * 这个 isolate/进程的分片 id。**生成一次，事件 sink 与用量 sink 共用同一个。**
   *
   * 共用是想要的：两者都在回答「这份数据是哪个实例写的」，面板上那句
   * 「这一天有几个分片贡献了数据」跨两个板块指的必须是同一批实例。
   * 两个键空间互不相干（`event:<窗口>:<槽位>` 与 `usage:<日>:<槽位>`），
   * 而且**两者的槽位数各自算各的**（`EVENT_SLOTS` / `USAGE_SLOTS`），
   * 所以同一个 id 在两边可能落在不同槽位——那是对的，不是 bug。
   */
  const shardId = (options.newShardId ?? (() => crypto.randomUUID().slice(0, 8)))();

  /**
   * 事件落库 sink。`onError` 走 `consoleLogger` 直接打（**通常是
   * ConsoleLogger**，见 `StoreLogger` 构造参数的说明）而不是 fan-out 之后的
   * `logger`：sink 自己出故障时把诊断信息再塞回同一个正在故障的 sink 没有意义，
   * 而 console 这条路径与存储无关，永远打得出来。
   */
  const storeLogger = new StoreLogger({
    storage: watched,
    now,
    shardId,
    onError: (err) => consoleLogger.log({
      level: "error", event: "storage.event_flush_failed",
      msg: "事件落盘失败，本轮缓冲已丢弃（不重试同一批，下一轮再攒新的）",
      fields: { error: err instanceof Error ? err.message : String(err) },
    }),
  });
  const logger: Logger = multiLogger(consoleLogger, storeLogger);

  if (options.probeStorage) {
    const err = await probeWritable(watched, storageHealth, now, logger);
    if (err) {
      console.error(
        `[agnes2api] 数据目录不可写，key 池无法持久化，/health 将报告 degraded：${err.message}`,
      );
      console.error(
        "[agnes2api] Docker 绑定挂载常见原因：宿主 ./data 的属主与容器内运行用户不一致。" +
          "本镜像的 entrypoint 会以 root 启动并 chown 数据目录后再降权，若仍不可写，请检查该目录是否只读或位于不支持 chown 的文件系统。",
      );
    }
  }

  const configHolder = await createConfigHolder({ env, storage: watched, logger, now });
  // **这两个旋钮是建 app 时读一次的**，不随 ConfigHolder 每次刷新而变：它们绑定的是
  // 部署形态（活跃 isolate 数 × 池大小），不是逐次生效的策略。改了要重启容器 /
  // 等 isolate 回收——`.env.example` 与五语言 DEPLOY.md 的环境变量表**那两格逐格写明了**，
  // 面板文案同样不许写「立即生效」。
  //
  // ⚠️ **上面那半句一度是假的，如实登记（勘察当日逐份读过）**：
  // `.env.example` 里只有 `POOL_CACHE_TTL_MS` 那格写了这件事，`POOL_TOUCH_INTERVAL_MS`
  // 那格一个字都没有；五份 DEPLOY.md 是环境变量表**下面**的正文段落写了、**表格那两格没写**，
  // 而那张表的开场白自己声明「完整的取值范围与代价以本表为准」——照着表逐格读参数的人
  // 一条都看不到。两处补齐之后这句话才成立，而且**两半都不靠人守**——
  // 两半的守卫都在 `tests/ui/settings.test.ts` 的「建实例时读一次的那两个旋钮」这一组：
  // · `.env.example` 那一半：「.env.example 里这两个旋钮各自都写明了改了要重启、面板改它不会立刻生效」，
  //   配一条「逐次生效的字段那一格不许写这句话」的反向控制，外加一条整份文件扫的
  //   「写这句话的恰好就是 BUILD_TIME_FIELDS 那几格（不多不少）」——**面板改不到的旋钮上
  //   写这句话同样红**（复评发现 5 就是这么冒出来的：`USAGE_STATS_ENABLED` 那格原来也写着它，
  //   而它压根不在 `EDITABLE` 里）。
  // · 五语言那一半：「五语言 DEPLOY.md 的那两格里，正文逐格写着「面板改它不会立刻生效」，
  //   而且指着出处」——**逐语言查的是本地化正文，不是只查一个路径锚**，配同形反向控制。
  //
  // ⚠️ **「不再靠人守」这句话在复评时对五语言那一半还是过头话，如实登记**：
  // 当时那一半只有 `tests/unit/docs-parity.test.ts` 的
  // 「五语言 DEPLOY.md 里……的出现次数彼此一致」那条路径 token 计数守着，而复评时实测
  // 「五份**同步**删掉那句正文、只留 `src/http/wire.ts` 这个路径」——docs-parity 那份
  // 66 格全绿、`check-comment-refs` EXIT=0，而本句当场变假。上面那条逐语言查正文的守卫是补它的。
  // docs-parity 那条锚今天仍在，但它管的是**跨五种语言对等**（某一份漏改就红），是另一件事。
  //
  // ⚠️ **面板那一半也不再只是一句文案**：`admin-ui/js/pure/settings.mjs` 的
  // `BUILD_TIME_FIELDS` 就是下面这两行读到的字段与后端 `EDITABLE` 的交集，由
  // `tests/ui/settings.test.ts` 的
  // 「BUILD_TIME_FIELDS 就是 wire.ts 建 app 时读的那份快照里、面板又能改的那几格」
  // 抠掉注释之后从本文件反查着钉住。**在这里多读一个面板能改得动的字段而不回去补那张表，
  // 那一格当场红**——因为保存回执会对它继续说「本实例已经生效」，而那是假的。
  const cfg = configHolder.current();
  const repo = new KeyPoolRepo(watched, {
    now, logger,
    cacheTtlMs: cfg.poolCacheTtlMs,
    touchIntervalMs: cfg.poolTouchIntervalMs,
  });
  const tendGate = createTendGate();

  /**
   * Tier-2 用量 sink。**这一行是「默认关」的唯一落点。**
   *
   * ⚠️ **开关为假时这里必须是 `undefined`，不是「建好再用一个 if 拦住写」**
   *（那条全局约束的原话：关闭时一次存储访问都不许有、**一个内存累加器都不许建**）。
   * 设计 §7.1 给的理由是「统计吃掉写配额会连带打死 key 池的状态回写」——两者抢的是
   * 同一个每天 1,000 次的写桶。而一条「反正没写盘」的累加路径挂在那里，
   * **迟早会被某次改动接上写**，那时没有任何东西会响。
   * 由 `tests/contract/usage-tier2.test.ts` 的
   * 「USAGE_STATS_ENABLED 不为 true 时：连打 50 次 /v1，usage: 前缀的 put 计数一次都不涨 ——……」
   * 数着 put 计数钉住（**不是断言「sink 是不是 null」**——那是形状断言）。
   *
   * ⚠️ **`cfg` 是建 app 时读的那一份，不逐次刷新**，与上面两个池子旋钮同一条理由：
   * 它绑定的是部署形态，不是逐次生效的策略。改了要重启容器 / 等 isolate 回收，
   * `.env.example` 与五语言 DEPLOY.md 都写明了。
   *
   * `onError` 走 `consoleLogger` 而不是 fan-out 之后的 `logger`：与上面事件 sink
   * 完全同源——把 sink 自己的故障再塞回同一个正在故障的存储没有意义。
   * **而且这里比事件那边更要紧**：用量落盘失败若走 `logger`，就会往事件缓冲里
   * 塞一条，下一次请求把它落盘 ⇒ **统计故障自己制造额外的写**，正好打在
   * 存储已经出问题的时候。
   */
  // 落盘间隔与每天写预算。**判据是存储有没有写配额（`runtime.quotaModel`），
  // 不是在哪个运行时上跑**——完整论证见 `resolveUsageFlushInterval()` 上方那段。
  // ⚠️ **无论 Tier-2 开没开都要算一次**：① 非法值必须在启动时就抛（部署时错误，
  // 不许等到有人打开开关的那天才发现）；② `capabilities` 要如实报出生效的那个间隔，
  // 而面板拿它算「未落盘的尾巴最长多久」，关着的时候那句说明卡也要说得准。
  const usageFlush = resolveUsageFlushInterval(env.USAGE_FLUSH_INTERVAL_MS, runtime.quotaModel === "kv");
  const usageSink = cfg.usageStatsEnabled
    ? new UsageSink({
      storage: watched,
      now,
      shardId,
      flushIntervalMs: usageFlush.flushIntervalMs,
      budgetPerDay: usageFlush.budgetPerDay,
      // ⚠️ **查表，不在这里写三元**（认账修正）：两个 phase 的事件名与
      // 文案住在 `USAGE_ERROR_REPORT` 里，连同「为什么两句话必须分家」「record 那条
      // 今天到底可不可达」的全文。在这里再写一份三元的后果是加新 phase 时 else
      // 分支会把它**误报成**旧的那条，而 `tsc` 一个字都不会说。
      onError: (err, phase) => consoleLogger.log({
        level: "error",
        ...USAGE_ERROR_REPORT[phase],
        fields: { error: err instanceof Error ? err.message : String(err), phase },
      }),
    })
    : undefined;

  /**
   * 对外 API 密钥表的缓存持有者。**这里建一把，交给两处**（网关鉴权的第②段与
   * 面板那五条端点），「面板写的和网关认的是同一张表」因此是结构性的。
   *
   * ⚠️ **它无条件建，与 `usageSink` 那条「关必须是零成本」刻意不同。** 两者的差别
   * 是真的：`usageSink` 建出来就会**攒内存、迟早写盘**，而这一份在「一把子密钥都没
   * 签发过」的部署上**一次存储调用都不产生**——鉴权第②段只在「凭据不等于主口令」
   * 之后才走到，而那条路径上的读还被 TTL 摊平。它没有可省的成本，
   * 也就没有一个「关掉它」的开关该存在。
   *
   * **存储传 `watched`**（与 `configHolder` 同）：这张表读不出来说明存储真的出了
   * 问题，那条该进 `/health` 的可写性信号。
   */
  const apiKeyCacheTtlMs = resolveApiKeyCacheTtl(env.APIKEY_CACHE_TTL_MS);
  const apiKeyHolder = createApiKeyHolder({ storage: watched, logger, now, ttlMs: apiKeyCacheTtlMs });

  const app = createApp({
    version: VERSION,
    configHolder,
    repo,
    tendGate,
    // 注册机的执行体。**只有这里装配得出来**：三样都要 `env`（`buildTendDeps` 的入参）
    // 与 `storage`，而 `createApp` 两样都没有。直接调 `createApp` 的调用方拿不到这份
    // 接线，三条端点会如实回 503 而不是假装——见 `RegistrarWiring`。
    registrar: {
      storage,
      tend: (channel) => runManualTendRound(env, storage, channel),
      probeChannel: (channel) => probeChannel(env, storage, channel),
    },
    // 配置读写。**与上面的 `registrar` 同一条理由：只有这里有 `env`。**
    // 传的是 `storage` 而不是 `watched`：写配置失败不该被记进 `/health` 的可写性信号
    // ——那是转发能力的信号，而一次配置保存失败只影响这一次点击（面板会当场看到 500）。
    // ⚠️ 这与 `configHolder` 用的是 `watched` 并不矛盾：**读**配置在每个请求的
    // 热路径上，读不出来确实说明存储出了问题，那条该进 `/health`。
    // `adminToken` 只用来查一条：面板写进去的 `gatewayToken` 不许等于它
    // （写成相等 ⇒ 管理面每请求 503，而改回去的那条 `PUT` 也是 503，面板把自己锁死）。
    config: { storage, env, adminToken: env.ADMIN_TOKEN },
    fetcher: new NativeFetcher(),
    now,
    storageHealth,
    logger,
    // **只从环境变量读、不从存储读**：面板不该能改自己的钥匙。没配就整棵 /admin
    // 树不注册（404），但网关照常转发——注册机默认关闭时不让网关起不来是同一条规矩。
    adminToken: env.ADMIN_TOKEN,
    // 只有部署者显式声明自己在反代后面才信 X-Forwarded-For：这个值会写进登录失败
    // 事件，无脑信任等于允许任何人把爆破痕迹嫁祸给别人。
    trustProxy: env.TRUST_PROXY === "1",
    runtime,
    // env 在运行中不会变，装配时算一次即可（见 envLockedFields 的说明）。
    envLocked: envLockedFields(env),
    storeLogger,
    // **缺席（`undefined`）就是 Tier-2 关着**，见上面 `usageSink` 那段。
    usageSink,
    // 生效的落盘间隔。**面板不许写死这个数**（全局约束 10：诚实标记由后端字段驱动）。
    usageFlushIntervalMs: usageFlush.flushIntervalMs,
    // 对外 API 密钥。**只有这里装配得出来**（它要 `Storage`，而 `createApp` 没有），
    // 与 `config` / `usageSink` 同一条理由。
    apiKeys: { storage: watched, holder: apiKeyHolder },
    // 生效的 TTL。**面板不许写死这个数**（全局约束 10）：它决定「停用之后最多还能
    // 用多久」那句话里的分钟数，而那句话是安全相关的。
    apiKeyCacheTtlMs,
  });
  return { app, configHolder, repo, tendGate };
}

/**
 * 跑一轮**手动**补池（面板「立即补池」的执行体）。
 *
 * ⚠️ **`roundBudgetMs` 与 Cron 那一份逐字相同（`WORKER_ROUND_BUDGET_MS` = 780_000），
 * 这一行是本函数最容易被写漏的一行。** 不传的话：点一次「立即补池」，Worker 铸到
 * 第三把被平台回收，`mintOne` 的 `finally` 不跑，**两个临时邮箱留在上游**；
 * 点几次占满活跃邮箱名额 ⇒ 注册机彻底铸不出 key，**而面板上没有任何东西会说明原因**。
 * 由 `tests/contract/manual-tend.test.ts` 的
 * 「手动补池传的 roundBudgetMs 与 Cron 那一份逐字相同（780_000 手写字面量锚）」钉着
 * ——那一格的观测点是 `registrar.round_budget_impossible` 事件里的 `roundBudgetMs` 字段，
 * 所以「不传」与「传另一个值」是两种不同的红，两条变异各自都拦得住。
 *
 * ⚠️ **两种运行时传同一个值，这是刻意的。** Node/Docker 没有平台墙钟上限，
 * Cron 那条路在 Node 上确实不传（`src/entry/node.ts`）；但手动这条路在 Node 上同样
 * 传，因为「一次点击最多跑多久」是**这颗按钮自己的**性质，不是运行时的性质——
 * 两侧不同就等于同一颗按钮在两种部署下能铸出不同把数，而那个差异没有任何人会去断言。
 * 代价：Node 上手动补池可能比定时轮少铸几把（判据是 `codeTimeoutMs`），
 * 下一次定时轮会接着补。
 * ⚠️ **这里从前还乘着一个「通道数」，本轮是第四处订正。** 两条通道改成二选一之后
 * 没有第二次等待了，那个因子整个消失 —— 另外三处是 `src/core/registrar/tender.ts`
 * 的 `worstAttemptMs`、`src/core/registrar/config.ts` 的最坏耗时告警、
 * 与 `wrangler.toml` 的 Cron 间隔估算段。**四处同源，改一处就得四处一起改。**
 *
 * ⚠️ **残余风险如实登记**：预算把「跑不完的尝试」挡在门外，**它不消灭泄漏，只把概率
 * 压下来**。平台仍可能在预算窗口之内中止调用，`mintOne` 的 `finally` 仍可能不跑。
 * 而且 780_000 这个数的出处是 **Cron Trigger 的 15 分钟墙钟**，
 * `fetch` 路径上 `ctx.waitUntil` 的实际上限本仓**没有核实过**，不许当既定事实用。
 *
 * **每一轮新建一个事件 sink 并在 `finally` 里 `flush()`**，理由与两个入口的 Cron 轮
 * 完全相同（见 `src/entry/worker.ts` 里同位置那段）：`maybeFlush()` 会把毫秒级返回的
 * 那一轮整轮吃掉，而手动补池恰恰经常是毫秒级返回的（`need <= 0` 的健康池）。
 * 这里**不能**靠 app 那个 sink 的 `logFlush` 中间件——响应早就返回了。
 */
async function runManualTendRound(
  env: Record<string, string | undefined>,
  storage: Storage,
  /**
   * 这一轮临时改用这条通道（面板「添加 Key」菜单里【自动注册】那两项，设计 §10.2）。
   * `null` = 用设置里选中的那条，与加通道参数之前的行为逐字相同。
   *
   * ⚠️ **实现方式是给这一轮换一份 `config`，`src/core/registrar/tender.ts` 一个字都没改。**
   * 两条通道改成二选一之后这个手法反而更干净：`tendOnce` 本来就只读 `config.channel`
   * 这一个字段，把它换掉就是「这一轮用那条」。**上一版这里讲的是「把 primary 换成
   * 选中的通道、fallback 置空」那个技巧——那个机制已经不存在了。**
   * **代价明写**：`TendResult.primaryChannel` 记的是**这一轮实际用的那条**，
   * 不是设置里选中的那条——补池历史里由 `trigger: "manual"` 那一列把它们分开。
   */
  channel: Channel | null,
): Promise<void> {
  const tendConsole = new ConsoleLogger();
  const tendStore = new StoreLogger({
    storage,
    now: () => Date.now(),
    shardId: crypto.randomUUID().slice(0, 8),
    onError: (err) => tendConsole.log({
      level: "error", event: "storage.event_flush_failed",
      msg: "手动补池事件落盘失败，本轮缓冲已丢弃（不重试同一批）",
      fields: { error: err instanceof Error ? err.message : String(err) },
    }),
  });

  const gate: { reason: "disabled" | "blocked" | null } = { reason: null };
  const deps = await buildTendDeps(env, storage, {
    logger: multiLogger(tendConsole, tendStore),
    flush: () => tendStore.flush(),
    gate,
  });
  // 端点在起跑前已经查过一次 `registrar.enabled` / `blocked`（走 ConfigHolder）。走到
  // 这里还是 `null`，说明存储里的配置在这两步之间被改掉了——**如实说一声，别静默返回**：
  // 面板已经收到 202，这条事件是运维唯一能看出「按了但没跑」的地方。
  //
  // ⚠️ **文案按档分岔**：原来这里写死「注册机已被关掉」，而 blocked 那一档开关还开着
  // ——那句话在这一档上是假的。
  if (!deps) {
    tendStore.log({
      level: "warn", event: "registrar.manual_tend_skipped",
      msg: gate.reason === "blocked"
        ? "手动补池启动后发现这份注册机配置装不起来，本轮什么都没做（面板已经回过 202）"
        : "手动补池启动后发现注册机已被关掉，本轮什么都没做（面板已经回过 202）",
      fields: { reason: gate.reason ?? "disabled" },
    });
    await tendStore.flush();
    return;
  }

  // 「只用这一条通道」＝换一份 config，理由见上面 `channel` 参数的说明。
  // **端点已经验过这条通道有凭据**（`channelConfigured`），走到这里 `providers[channel]`
  // 必然存在；万一配置在这两步之间被改掉，`tendOnce` 会照常记一条 `provider_missing`
  // 失败——那正是它该做的，不需要在这里再判一次。
  const config = channel === null ? deps.config : { ...deps.config, channel };

  const roundStartedAt = Date.now();
  try {
    const r = await tendOnce({ ...deps, config, roundBudgetMs: WORKER_ROUND_BUDGET_MS });
    // `trigger: "manual"` —— 补池历史里这一行必须能与 Cron 那些区分开，
    // 否则运维看到池子突然多了两把 key 时分不清是自动补的还是有人点的。
    await deps.recordRound(r, "manual");
    // ⚠️ **这里刻意没有两个入口那两行裸 `console`**（`补池完成 …` / `本轮有名额未铸出 …`），
    // 而且这不是省事：
    // ① 归因那一行只在 `minted < attempted` 时打，**手动这一轮的完整汇总本来就无条件
    //    落进 `tend:history`**（面板的补池历史），而这颗按钮存在的全部理由就是让人
    //    在面板上看结果，不是在容器日志里 grep；
    // ② 换成 `deps.logger.log()` 的话每一次点击都多一条事件 ⇒ **多一次 put**，
    //    而配额账里手动补池那一栏算的是 3 次（护栏键 + 抢锁 + `tend:history`）。
    //    健康的一轮不写事件，这条性质与 Cron 那一栏是同一条，不该在这里被打破。
    // 容器日志里仍然看得见这次点击：`registrar.manual_tend_started` 走的是 app 的
    // `multiLogger(ConsoleLogger, StoreLogger)`，`ConsoleLogger` 那一路会打出来。
    if (r.minted < r.attempted) {
      // 有名额没铸出来是**异常**，不是稳态——它本来就伴随着 `mintOne` 打出的那些
      // `registrar.*` 失败事件（缓冲已经非空），所以这一条不额外制造 put。
      deps.logger.log({
        level: "warn", event: "registrar.manual_tend_partial",
        msg: "手动补池有名额没铸出来",
        fields: { attempted: r.attempted, minted: r.minted, reasons: summarizeFailures(r.failures) },
      });
    }
  } catch (err) {
    // **抛错那一轮也必须在面板上占一格**（与两个入口的 Cron 轮同一条口径，评审发现）：
    // `recordRound` 排在 `tendOnce` 之后、一抛就整个跳过 ⇒ 不补这两件事的话，
    // 面板上这一轮什么都没有，与「压根没点过」逐字节不可区分。
    deps.logger.log({
      level: "error", event: "registrar.round_failed",
      msg: "手动补池整轮抛错中断，本轮没有产出；池子状态没有变化",
      fields: { error: err instanceof Error ? err.message : String(err) },
    });
    await deps.recordCrashedRound({
      // **崩掉的那一轮记的也是「这一轮实际用的通道」**，与上面 `config` 同一份，
      // 不是配置里的主通道——否则一次「只用 MoeMail」崩掉之后，补池历史上那一行
      // 会指着 YYDS 说它崩了。
      at: roundStartedAt, channel: config.channel ?? "",
      durationMs: Date.now() - roundStartedAt, trigger: "manual",
    });
  } finally {
    await deps.flush();
  }
}

/**
 * 探一条通道的连通性（`POST /admin/api/registrar/channels/:channel/test` 的执行体）。
 *
 * ── 两步，第二步是本轮加的，代价明写 ────────────────────────────────────────
 *
 * ① `listDomains()` —— 可用域名数（设计 §10.3 第 6 条：用数据代替推荐）；
 * ② `verifyCredentials(domains[0])` —— **真的证明一次这把凭据能用**。
 *
 * ⚠️⚠️ **「这一步会不会消耗名额」由适配器决定，本函数不知道也不该知道。**
 * YYDS 侧那条实现是「建一个再删掉」⇒ **每点一次消耗一个活跃邮箱名额（用完即删）**；
 * MoeMail 侧那条只重打一次它本来就会校验凭据的读端点 ⇒ 零名额。
 * **这个差别不许被搬到这里来做分支**——那就是把「谁在哪一步校验凭据」这句关于
 * 别人家服务今天行为的断言钉回本仓，而它腐烂时没有任何门禁看得见。全文在
 * `src/ports/mailbox.ts` 的 `MailProvider.verifyCredentials` 上方。
 * 连点由 `src/http/admin/probe-guard.ts` 那把与单把 key 验活共用的护栏挡着，
 * 这里不另造一套。
 *
 * ⚠️ **上一版这里逐字写着「只调 `listDomains()`：不建邮箱、不注册账号、不消耗任何
 * 活跃邮箱名额」，那句话今天是假的，已随行为一起改掉**——留着它就是一句门禁看不见
 * 的假话，而面板文案与五语言文档都是照它写的（本轮一并改了）。
 *
 * **仍然一次存储写都不产生**（`buildTendDeps` 里那次 `loadConfig` 是读）。
 *
 * ⚠️ **provider 走 `buildTendDeps` 拿，不在这里另建一个**。另建的那份要自己重解一遍
 * 凭据、自己传一遍 `sleep`/`now`/`logger`——于是这颗按钮测的就是**抄件**，而运维点它
 * 正是为了确认**原件**（真正补池时用的那个 provider）连不连得上。本仓已经为
 * 「测的是抄件不是原件」栽过好几次，这里不再造第二份。
 * 代价：多解析一次配置（1 次存储读）与几个用不到的对象（`KeyPoolRepo` 不发起任何 IO
 * 直到被调用）。一次人工点击付得起。
 *
 * 上游报错**原样抛出**，由 `channelTestHandler` 接住转成 `{ ok: false }` 并记事件——
 * 这里不吞、也不翻译，翻译发生在唯一知道要给面板什么形状的那一层。
 * 失败那一支的**分档依据是这一次的状态码，不是通道名**（全文在 `channelTestHandler`
 * 那个 `catch` 上方）。**`verifyCredentials` 抛出来的错走的是同一条路、同一套分档**，
 * 于是「凭据被拒 / 上游限流 / 上游抖动」三档天然分得开——这正是端口契约要求
 * 实现别 catch、把真实状态码原样挂上去的原因。
 *
 * ── 这一步到底证明了什么：射程写死在这里 ──────────────────────────────────
 *
 * ⚠️⚠️ **`domains` 与「凭据可用」是两条独立的结论，返回值因此分两格。**
 * 一次真机观测（**2026-08-25，北京时间**；出处：本轮缺陷报告里那份逐条读数，
 * **未随公开仓发布**，本仓不落任何地址与 key）：拿一把**故意写错**的 key 打 YYDS
 * 的列域名端点 ⇒ **200**；同一把错 key 打 MoeMail 的列域名端点 ⇒ **401**。
 * **射程**：那是**那一天、那两个部署**的反应，不是这两家服务的性质，更不是常数。
 * ⇒ 处置是**别把它写成分支**（见上面那段），而不是照着它给某条通道写一档。
 *
 * ⚠️ **一个域名都没读到时不去验凭据，`credentials` 如实回 `"not_checked"`。**
 * 两条理由，缺一条这个早退都不成立：① 建东西那条实现需要一个域名，硬编一个
 * 就是伪造；② 没有域名可用时补池那一步本来就会直接失败，凭据好不好都不改变处置。
 * **这一档面板必须自己说清「没验凭据」**（`reg.channel.testOkNoDomains`）。
 */
async function probeChannel(
  env: Record<string, string | undefined>,
  storage: Storage,
  channel: Channel,
): Promise<ChannelProbe> {
  // 这条路只读不写，**不接 `StoreLogger`**：一次连通性测试不该在事件板块里刷屏，
  // 而真正值得留痕的那一条（测试失败）由 handler 用 app 的 sink 打（那条带 `channel`
  // 与耗时，比这里的适配器内部日志更贴近运维要看的东西）。
  const gate: { reason: "disabled" | "blocked" | null } = { reason: null };
  /**
   * ⚠️⚠️ **装配这一截单独接住，它抛错时「一次上游请求都没发出去」。**
   *
   * `buildTendDeps` 会读一次存储（`loadConfigWithProvenance`）。那次读抛错时，
   * 上一版让它一路穿到 `channelTestHandler` 的 `catch`，被记成
   * `reason: "upstream_error"` —— 而**上游被调 0 次**（本轮实测：真装配，
   * KV `get` 抛错 ⇒ 上游 0 次，响应体 `{"ok":false,"reason":"upstream_error"}`）。
   * 那是一句把本网关自己的故障说成上游故障的假话，处置方向正好相反：
   * 这一档要去看的是存储/KV，不是地址、DNS、TLS 与上游。
   *
   * ⇒ 它有自己的一档 `probe_setup_failed`，**不并进任何一个上游档**。
   * 原始错误不往外带（它可能带着存储实现的内部细节），详情由 handler 记事件。
   */
  let deps: TendRoundDeps | null;
  try {
    deps = await buildTendDeps(env, storage, { gate });
  } catch (err) {
    return { ok: false, reason: "probe_setup_failed", error: err };
  }
  // **两档分开报**：面板对 `registrar_disabled` 的五语言文案逐字是「注册机没有打开
  // ……请先在设置里打开它」，而 blocked 那一档开关明明是开的——照旧混报就是撒谎。
  if (deps === null) {
    return { ok: false, reason: gate.reason === "blocked" ? "registrar_blocked" : "registrar_disabled" };
  }
  const provider = deps.providers[channel];
  if (provider === undefined) return { ok: false, reason: "provider_missing" };
  const domains = await provider.listDomains();
  // 见上面那段：没有域名可用时不去验，如实说没验。
  if (domains.length === 0) return { ok: true, domains: 0, credentials: "not_checked", cleaned: true };
  const proof = await provider.verifyCredentials(domains[0]!);
  return { ok: true, domains: domains.length, credentials: "accepted", cleaned: proof.cleaned };
}

/**
 * `buildTendDeps` 的返回形状：`tendOnce` 要的那一份，外加两个**只有入口层才有
 * 地方调用**的收尾句柄。
 */
export type TendRoundDeps = TendDeps & {
  /** 把补池这条路的事件缓冲落盘。**入口层必须在 `finally` 里 await 它。** */
  flush: () => Promise<void>;
  /** 把这一轮的汇总追加进 `tend:history`。 */
  recordRound: (result: TendResult, trigger: TendTrigger) => Promise<void>;
  /**
   * 这一轮**抛错了**，补一条如实的记录（评审发现）。
   * 与 `recordRound` 分成两个入口而不是让调用方自己拼一个 `TendResult`：
   * 拼的那一份会漂，而且很容易顺手把 `skipped` 当成"崩了"用——**`skipped` 有且
   * 只有一个含义**（注册机关着），拿它表示别的就是伪造。
   */
  recordCrashedRound: (o: {
    at: number; channel: string; durationMs: number; trigger: TendTrigger;
  }) => Promise<void>;
};

/**
 * 为 `tendOnce` 装配依赖。注册机未启用（`registrar.enabled=false`，默认状态）时
 * 在构造任何 provider 之前就返回 `null`——两个入口据此判断要不要起调度
 * （Worker 的 `scheduled` 导出 / Node 的定时器），未启用时不会产生触达邮箱/Agnes
 * 侧的网络请求（`loadConfig` 本身仍会读一次存储，对 Worker/KV 形态而言是一次
 * 真实的 KV 读取，不在此列）。
 *
 * 不复用 `buildApp` 内部 watchStorage 包过的存储：补池失败已经由调用方各自
 * 的 try/catch 兜底并打日志（见两个入口），不需要接入 `/health` 的可写性
 * 探测——那是网关转发能力的信号，与补池能力相互独立。
 */
export async function buildTendDeps(
  env: Record<string, string | undefined>,
  storage: Storage,
  opts: {
    /**
     * 补池这条路的事件 sink。**缺省仍是裸 `ConsoleLogger`**，不破坏现有调用方；
     * 两个入口传的是 `multiLogger(console, storeLogger)`——`ConsoleLogger` 那一路
     * **一条都不许丢**，落库是加出来的第二条路，不是替换。
     */
    logger?: Logger;
    /**
     * 把上面那个 sink 的缓冲落盘。由**调用方**提供，因为只有它手上有那个
     * `StoreLogger` 实例。缺省是空操作（没传 logger 的调用方也没有东西要落）。
     */
    flush?: () => Promise<void>;
    /**
     * 返回 `null` 时**是哪一档**。与 `num()` 的 `flags` 同一套「可变标记」形态，
     * 理由也一样：把它做成返回值的一部分会牵连全部 `=== null` 的调用点，
     * 而让调用方自己再读一次配置就是多付一次 KV 读。
     *
     * **两档的处置完全不同**：`disabled` = 「去设置里打开它」，
     * `blocked` = 「它开着，但这份配置装不起来，去补齐缺的那几格」。
     * 拿一句话糊两档正是本仓反复裁过的形态（面板会对着一个开着的开关说「没打开」）。
     */
    gate?: { reason: "disabled" | "blocked" | null };
  } = {},
): Promise<TendRoundDeps | null> {
  // **接上这条线之前，这里是裸 `ConsoleLogger`**，`registrar.*` 事件因此进不了
  // `/admin/api/events`——早先验收「看到最近的补池发生了什么」实测为零就是
  // 这么来的。当时不接的理由记在这里，因为它同时
  // 解释了现在这个形状：Worker 的 `scheduled()` 与 `fetch()` 是**两个独立的
  // isolate 生命周期**，没有请求/响应边界可以挂 `logFlush` 那种"收尾 await"的
  // 中间件 ⇒ 落盘触发点只能由入口层在补池收尾时自己给（Worker 走 `ctx.waitUntil`
  // 里的 `finally`、Node 走 `runTend` 的 `finally`），所以 `flush` 是参数不是内部行为。
  //
  // ⚠️ **写预算这根轴换掉了，不许照抄事件 sink 那一套**（订正）：
  // `EVENT_WRITES_PER_DAY`（每实例每天 12 次）在 `fetch` 路径上有意义，是因为
  // 一个 isolate 服务很多请求、预算在一个长寿实例上被反复消费。**`scheduled()`
  // 那条路上这根轴没了**——每次 Cron 触发很可能是一个新 isolate，一生只有一次
  // 落盘机会，每次都带着一份全新的预算 ⇒ 那套预算既拦不住什么也不构成上界。
  // **真正的上界是补池频率本身**（Worker 的 Cron、Node 的 `TEND_INTERVAL_MS`），
  // 五语言 DEPLOY.md 里就是这么写的。
  const logger: Logger = opts.logger ?? new ConsoleLogger();
  const flush = opts.flush ?? (async () => {});
  // **`loadConfigWithProvenance` 而不是 `loadConfig`：零额外 IO，同一次读。**
  // 多要的那一格是 `registrarBlocked`——日志里要说清「缺的是哪几格」，
  // 只报一个 count 的话运维还得自己去面板对一遍。
  const prov = await loadConfigWithProvenance(env, storage, logger);
  const reg = prov.config.registrar;
  if (!reg.enabled) { if (opts.gate) opts.gate.reason = "disabled"; return null; }
  /**
   * ⚠️⚠️ **这道 gate 是整个「装不起来不再抛错」那套改动的承重点。**
   *
   * `blocked` 为真时 `RegistrarConfig` 会出现一个从前不存在的状态：
   * `enabled=true` 且 `channel="moemail"` 而 `moemail=null`。下游拿着这份配置去跑，
   * 最坏是 `mintOne` 的 `finally` 不跑 ⇒ **临时邮箱漏删**。本方案靠 **gate 而不是
   * 改状态** 挡住它，因此这一句必须排在**建任何 provider 之前**——
   * `tests/unit/registrar/scheduling-wiring.test.ts` 的
   * 「blocked ⇒ 返回 null，且一个 provider 都没建」钉的正是这个行为
   *（只断返回值抓不住「先建了 provider 再返回 null」）。
   *
   * ⚠️ **不按 blocker 的码分支**：`gatewayToken` 那条在 `loadConfigWithProvenance`
   * 里已经抛掉了，走到这里的 blocker 全是注册机自己的。
   *
   * ⚠️ **必须是 error 级、必须每轮都打。** 这次改动把一次**响亮**的故障（进程退出 /
   * 全线 500）换成了一次**安静**的故障（补池停摆、池子慢慢耗干、几小时到几天后以
   * `pool_empty` 503 的形式炸出来）。缓解手段全是「你得去看」型的：这条事件 +
   * 面板三处横幅。少一条，这个方案就把一个吵闹的故障换成了一个安静的故障。
   */
  if (reg.blocked) {
    if (opts.gate) opts.gate.reason = "blocked";
    logger.log({
      level: "error", event: "registrar.blocked",
      msg: "注册机已启用，但这份配置装不起来，本次没有启动它（转发不受影响）。"
        + "去面板设置页按下面这几格补齐，改完保存即可恢复，不需要重启容器 / 重新部署。",
      fields: {
        count: prov.registrarBlocked.length,
        fields: prov.registrarBlocked.map((b) => `${b.field}:${b.code}`).join(","),
      },
    });
    return null;
  }

  const fetcher = new NativeFetcher();
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const now = () => Date.now();

  const providers: Partial<Record<Channel, MailProvider>> = {};
  if (reg.yyds) providers.yyds = new YydsProvider({ fetcher, ...reg.yyds, sleep, now, logger });
  if (reg.moemail) providers.moemail = new MoeMailProvider({ fetcher, ...reg.moemail, sleep, now, logger });

  /**
   * 读改写 `tend:history` 一次。**读侧的窄化结果里那个 `malformed` 必须被说出去**
   *（评审发现）：这里是 `tend:history` **唯一的窄化点**——事件那一侧读路径每次都会
   * 独立报出 `malformed`，而这份历史今天只有写侧一个人看得见它。丢掉它意味着
   * **被外部写坏的那几行在下一次补池时被永久抹掉，无事件、无 warn、无计数**，
   * 等这份历史的读端点建好时证据早就没了。
   */
  const appendHistory = async (record: TendRecord): Promise<void> => {
    try {
      const narrowed = narrowTendHistory(await storage.get(TEND_HISTORY_KEY));
      if (narrowed.malformed > 0) {
        logger.log({
          level: "warn", event: "registrar.history_malformed",
          msg: "tend:history 里有读不得的记录，已在这次写回时丢掉（多半是存储被本网关之外的东西写过）",
          fields: { malformed: narrowed.malformed },
        });
      }
      await storage.put(TEND_HISTORY_KEY, appendTendHistory(narrowed.entries, record));
    } catch (err) {
      logger.log({
        level: "warn", event: "registrar.history_write_failed",
        msg: "本轮补池已完成，但写 tend:history 失败；面板的补池历史会缺这一轮",
        fields: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  };

  /**
   * 域名台账与退避状态的读写。**四个都是必填字段，不给默认值**（`TendDeps` 那里
   * 逐字写着理由：给默认值就等于某个入口忘接线时静默退化成本次要修的那个缺陷）。
   *
   * ⚠️ **写回一律「先 get 再 merge」，不是裸覆盖。** KV 没有 CAS，这是本仓第四处
   * 读-改-写（前三处是 `pool:index`、`registrar_manual_guard` / `registrar_tend_lock`、
   * `tend:history`，`src/http/admin/handlers/registrar.ts` 顶部那张诚实表列着）。
   * 丢一条域名结论只是下一轮重学（便宜）；**丢掉退避的截止时刻等于退避窗口凭空消失
   * ⇒ 继续打 ⇒ 每打一次把上游的惩罚窗口续一次 ⇒ 正好回到本次要修的那个缺陷**。
   * merge 把丢更新的后果从「覆盖」降到「取更保守的那个」，**但消灭不了它**——
   * 没有 CAS 就消灭不了，这句限定不许被改写成「并发已解决」。
   */
  const loadDomainLedger = async (): Promise<DomainLedger> =>
    narrowDomainLedger(await storage.get(DOMAIN_LEDGER_KEY));
  const saveDomainLedger = async (next: DomainLedger): Promise<void> => {
    const cur = narrowDomainLedger(await storage.get(DOMAIN_LEDGER_KEY));
    // **不传 `expiresAt`**：陈旧判定全靠台账里那两处 TTL 值比较，给整把键配 TTL
    // 就是让 TTL 兼任 staleness 的职责（理由与 `registrar_manual_guard` 同源）。
    await storage.put(DOMAIN_LEDGER_KEY, mergeDomainLedger(cur, next));
  };
  const loadBackoff = async (): Promise<BackoffState | null> =>
    narrowBackoff(await storage.get(REGISTRAR_BACKOFF_KEY));
  const saveBackoff = async (next: BackoffState | null): Promise<void> => {
    if (next === null) {
      // 清退避是**显式动作**（一次成功铸号），不 merge —— merge 会把刚清掉的
      // `until` 又取回来，那就永远清不掉了。
      await storage.put(REGISTRAR_BACKOFF_KEY, null);
      return;
    }
    const cur = narrowBackoff(await storage.get(REGISTRAR_BACKOFF_KEY));
    await storage.put(REGISTRAR_BACKOFF_KEY, mergeBackoff(cur, next));
  };

  return {
    repo: new KeyPoolRepo(storage, {
      now, logger,
      // **补池必须看当前真实的可用数**：读一份最多一个 TTL 前的快照会把缺口算错，
      // 别的实例（或面板）刚加进去的 key 还没进本进程的快照 ⇒ 重复补池 ⇒ 白烧邮箱
      // 配额（两条通道各自的活跃邮箱上限，数字与出处见
      // `src/adapters/mailbox-yyds.ts` 与 `src/adapters/mailbox-moemail.ts` 的文件头，
      // 这里不复述——它们都不是常数），而每一次补池都是一次真实的 Agnes
      // 建号，同时撞注册风控与建号限流。它每 30 分钟才跑一次，多付 1+N 次读完全
      // 不是问题。
      //
      // ⚠️ **这是与 `buildApp` 那个 repo 相互独立的第二个实例，有可观测的后果**：
      // `add()` 里那次 `invalidate()` 打在**这一个**实例上，转发路径永远读不到它，
      // 所以补池铸出来的 key **在转发路径上最多晚一个 `POOL_CACHE_TTL_MS` 才可见**
      // （Worker 上还要 × 每个活跃 isolate 各自的 TTL）。空池 + 补池成功时，日志已经
      // 报了 `minted=1` 而网关还会继续 503 长达一个 TTL——这条写进了五语言
      // REGISTRAR.md，别让它只留在这里。
      //
      // **为什么不改成共用 `BuiltApp.repo`**（评估过，三条都拦着）：
      // ① Worker 的 `scheduled` 与 `fetch` 是两次独立装配，根本不共享实例。只在 Node
      //    侧改就制造出一处**运行时行为分叉**，而双运行时对等是硬约束——分叉了就得写进
      //    文档，那还不如老老实实把上界写清楚。
      // ② `buildApp` 用的是 `watchStorage` 包过的存储，写失败会记进 `/health` 的可写性
      //    信号；补池刻意不接那条线（见本函数上面的说明），共用实例就把两者绑死了。
      // ③ 补池必须看当前真实可用数，共用之后得在 `tendOnce` 开头调一次 `invalidate()`，
      //    照样付 1+N 次读——省不掉任何东西，只换来上面两处耦合。
      cacheTtlMs: 0,
    }),
    config: reg,
    providers,
    agnes: { fetcher, platformUrl: reg.agnesPlatformUrl },
    now,
    sleep,
    rand: Math.random,
    logger,
    loadDomainLedger,
    saveDomainLedger,
    loadBackoff,
    saveBackoff,
    flush,
    /**
     * 把这一轮的汇总追加进 `tend:history`。
     *
     * **放在这里而不是让两个入口各写一遍**：读改写 + 窄化 + 环形追加是四步，
     * 抄两份必漂，而漂了没人会发现——这与 `summarizeFailures()` 当初被提到
     * `tender.ts` 去的理由是同一条。面板那颗「立即补池」按钮会走同一份
     * （`trigger: "manual"`）。
     *
     * 失败只记一条 warn 就算了：补池本身已经成功了，让一次历史写失败把它变成
     * 「补池失败」是误导。**这条 warn 走 `logger`**，所以它会被随后的 `flush()`
     * 一起落盘——前提是入口层把 `flush()` 放在**最后**（见两个入口的 `finally`）。
     */
    recordRound: (result, trigger) => appendHistory(toTendRecord(result, trigger)),
    recordCrashedRound: (o) => appendHistory(crashedTendRecord(o)),
  };
}
