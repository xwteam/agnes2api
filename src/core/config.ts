import type { Storage } from "../ports/storage.js";
import { registrarFromEnv, type RegistrarConfig } from "./registrar/config.js";
import { NULL_LOGGER, type Logger } from "../ports/logger.js";
// **优先级判断（env > 存储 > 默认值）与逐字段来源推导都在那个文件里，这里一份都没有。**
// 设计 §5.3 逐字：`loadConfig` 退化成 `loadConfigWithProvenance` 的薄封装，
// 且「不允许在面板层另写一套来源推导——那必然与 `loadConfig` 漂移」。
import { DEFAULTS, num, loadConfigWithProvenance } from "./config-provenance.js";

// `envLockedFields` 与 `ENV_LOCK_MAP` 同住 `config-provenance.ts`（那张表既是「面板
// 改了也不生效」的依据，又是四元组里 `env`/`lockedBy` 两格的数据源，拆两处必漂）。
// 这里**原样再导出一次**：它的调用方（`src/http/wire.ts` 与几处测试）从 P1 起
// 就从本模块拿它，为一次搬家去改那些调用点不值得。
export { envLockedFields } from "./config-provenance.js";

export interface GatewayConfig {
  gatewayToken: string;
  agnesBaseUrl: string;
  upstreamTimeoutMs: number;
  /**
   * 同步端点（图片生成、视频建任务）的上游超时。
   *
   * 与 `upstreamTimeoutMs` 分开是因为两者度量的**根本不是同一件事**：流式对话的首字节
   * 只代表「上游开始说话」，8 秒足够；而同步端点的首字节要等整张图渲染完才到达——实测
   * 直连上游 `/images/generations` 首字节耗时 11.99 秒（HTTP 200）。用 8 秒去卡它的结果
   * 是图片生成 100% 失败，且每次请求会把池中每把 key 各记一次 strike，三次请求就能把
   * 整个池子打进 30 分钟长冷却，连对话一起拖死。
   */
  upstreamSyncTimeoutMs: number;
  maxStrikes: number;
  cooldownRateLimitMs: number;
  cooldownPaymentMs: number;
  cooldownStrikeMs: number;
  /**
   * 见 `KeyPoolRepoOptions.cacheTtlMs`。**0 = 关闭缓存。**
   *
   * **建 app 时读一次**，不是逐次生效：它绑定的是部署形态（活跃 isolate 数 ×
   * 池大小），不是逐次可调的策略。改它要重启容器 / 等 isolate 回收，
   * `.env.example` 与五语言 DEPLOY.md 都写明了这一点，面板文案不许写「立即生效」。
   */
  poolCacheTtlMs: number;
  /** 见 `KeyPoolRepoOptions.touchIntervalMs`。0 = 关闭写消除。生效时机同上。 */
  poolTouchIntervalMs: number;
  registrar: RegistrarConfig;
  /**
   * 本次装载有没有降级（存储的 config 键读不出来 / 某些字段回落了默认值）。
   *
   * ⚠️ **这段注释原来写着「全仓还没有任何代码读它」，那句已经过期了**
   *（全分支评审 A9）：消费链在**同一期**（P3b Task 5）就接上了，三级——
   * `src/http/admin/handlers/overview.ts:112`（放进响应的 `config.degraded`）
   * → `admin-ui/js/pure/overview.mjs:107`（取值并窄化成 `boolean | null`）
   * → `admin-ui/js/sec-overview.js:154`（`=== true` 时把红色横幅显示出来）。
   * 「保存了却没生效」是这个项目最高频的用户困惑，不让它可见就等于让面板撒谎，
   * 而现在它是可见的。**这条链一断，面板会安静地不再报降级**——
   * `tests/contract/admin-overview.test.ts` 与 `tests/ui/overview.test.ts` 各守一段。
   *
   * 这一处是本仓「注释在写下那一刻是真的，后来被同一期自己的新代码推翻，
   * 没人回头改」的标本，第十二道门禁（`tests/unit/check-comment-refs.test.ts`）
   * 就是为这个形态加的。
   */
  degraded: boolean;
}

type Env = Record<string, string | undefined>;

export function configFromEnv(env: Env, logger: Logger = NULL_LOGGER): GatewayConfig {
  const gatewayToken = env.GATEWAY_TOKEN;
  if (!gatewayToken) throw new Error("缺少 GATEWAY_TOKEN，网关无法启动");

  return {
    gatewayToken,
    agnesBaseUrl: env.AGNES_BASE_URL ?? DEFAULTS.agnesBaseUrl,
    upstreamTimeoutMs: num(env, "UPSTREAM_TIMEOUT_MS", "upstreamTimeoutMs", undefined, DEFAULTS.upstreamTimeoutMs, logger),
    upstreamSyncTimeoutMs: num(env, "UPSTREAM_SYNC_TIMEOUT_MS", "upstreamSyncTimeoutMs", undefined, DEFAULTS.upstreamSyncTimeoutMs, logger),
    maxStrikes: num(env, "MAX_STRIKES", "maxStrikes", undefined, DEFAULTS.maxStrikes, logger),
    cooldownRateLimitMs: num(env, "COOLDOWN_RATE_LIMIT_MS", "cooldownRateLimitMs", undefined, DEFAULTS.cooldownRateLimitMs, logger),
    cooldownPaymentMs: num(env, "COOLDOWN_PAYMENT_MS", "cooldownPaymentMs", undefined, DEFAULTS.cooldownPaymentMs, logger),
    cooldownStrikeMs: num(env, "COOLDOWN_STRIKE_MS", "cooldownStrikeMs", undefined, DEFAULTS.cooldownStrikeMs, logger),
    poolCacheTtlMs: num(env, "POOL_CACHE_TTL_MS", "poolCacheTtlMs", undefined, DEFAULTS.poolCacheTtlMs, logger, 0),
    poolTouchIntervalMs: num(env, "POOL_TOUCH_INTERVAL_MS", "poolTouchIntervalMs", undefined, DEFAULTS.poolTouchIntervalMs, logger, 0),
    registrar: registrarFromEnv(env, {}, logger),
    // 恒为 false：这条路径没有「存储」这个降级来源，纯 env + 内置默认值不存在
    // 「保存了却没生效」这种可能，没有什么好提示的。
    degraded: false,
  };
}

export async function loadConfig(
  env: Env,
  storage: Storage,
  logger: Logger = NULL_LOGGER,
  opts: {
    /**
     * 存储读不出来时要不要降级到 env + 默认值。**默认 false（严格：如实抛）。**
     *
     * `loadConfig` 有**两个**调用身份，而它们要的是相反的行为：
     * ① `ConfigHolder` 的 `Refreshable.load`——热实例每 `CONFIG_TTL_MS` 就会
     *    调一次。这条路径上 `Refreshable.reload()` 本来就有**严格更好**的兜底：
     *    抛错时原样保留上一份合法快照（见 refreshable.ts）。若这里自己把
     *    「读不出来」吞成「降级」，热路径上一次瞬时读抖动就会把面板保存的配置
     *    **静默**换成内置默认值——而且免费档读桶按 UTC 天重置，这不是几十秒
     *    的抖动，是剩下的一整天（评审实测复现：`maxStrikes` 9→3、
     *    `cooldownStrikeMs` 7,777,000→1,800,000、`registrar.enabled` true→false，
     *    补池被静默关掉）。**这条路径必须传 false（或不传），让异常原样冒给
     *    `Refreshable.reload()` 处理**，不许在这里截胡。
     * ② `createConfigHolder` 的 `prime()`（冷启动）与两个入口各自的
     *    `buildTendDeps`——这里没有「上一份合法快照」可退，抛出去的后果是
     *    Worker 冷 isolate 全部 500 / Node 重启循环，而 GATEWAY_TOKEN 通常就在
     *    环境变量里，存储那份只是覆盖层，读不出来不该让整个网关起不来。
     *    **只有这条路径才该传 true。**
     */
    degradeOnUnreadable?: boolean;
  } = {},
): Promise<GatewayConfig> {
  // **薄封装，逐字**：优先级判断、字段级降级、存储读不出来的处置、四元组的推导，
  // 全部只有 `loadConfigWithProvenance` 那一份实现（设计 §5.3）。这里唯一做的事是
  // **把 `source` 丢掉**——绝大多数调用方（转发路径、两个入口、补池）只要生效值。
  //
  // ⚠️ **不许在这里补任何一条「顺手的」判断。** 只要这个函数体里出现第二条优先级
  // 规则，面板（走 `source`）与网关（走这里）就有了两份实现，而它们的差恰好落在
  // 「面板说的生效值」与「真正的生效值」不一致的那一格上——那正是本期最不能出的
  // 那类缺陷。`tests/unit/config-provenance.test.ts` 的
  // 「loadConfig 与 loadConfigWithProvenance 对同一组输入给出逐字节相同的 config」
  // 把这条钉住。
  return (await loadConfigWithProvenance(env, storage, logger, opts)).config;
}

