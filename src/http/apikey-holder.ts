import { Refreshable } from "../core/refreshable.js";
import type { Storage } from "../ports/storage.js";
import { ConfigRefusal } from "../core/config-errors.js";
import type { Logger } from "../ports/logger.js";
import type { ApiKeyTable } from "../core/admin/api-keys.js";
import { loadApiKeyTable } from "./apikey-store.js";

/**
 * 对外 API 密钥表的持有者。放入口层而不是 core：它要碰存储。
 *
 * ⚠️⚠️ **它的刷新刻意不挂 `use("*")`。** `ConfigHolder` 是那么接的，而那正是它
 * 每天 2,880 次读的来源。这一份只在 `src/http/middleware/auth.ts` 的第②段里
 * ——也就是「本次请求带的凭据**不等于**主口令」之后——才 `ensureFresh()`。
 * 于是有一档是**结构性的零**：全部客户端都用主口令的部署（也就是今天所有既有部署）
 * 每天 `0` 次读，因为那条路径上根本没有 `ensureFresh()` 的调用点，而不是因为某个 `if`。
 */
export interface ApiKeyHolder {
  /**
   * 同步读当前快照。**永不抛。**
   *
   * `null` 有两种成因（表还没建过 / 表坏了），而在鉴权那条路径上两者**行为相同**
   *（没有任何一把子密钥能被验证通过，主口令不受影响）。要区分它们的是面板那条路径，
   * 它直接读存储，见 `loadApiKeyTable`。
   */
  current(): ApiKeyTable | null;
  /** TTL 到期才真的重载。**永不抛**——重载失败保留上一份合法快照。 */
  ensureFresh(): Promise<void>;
  /** 面板写操作成功后调用，让下一次 ensureFresh 一定重载。 */
  invalidate(): void;
}

/**
 * 默认 5 分钟。
 *
 * **刻意不跟 `POOL_CACHE_TTL_MS` 的 60 秒一致**：两者刷新的东西变更频率差一个量级
 * ——池子每次转发都可能改 cooldown / strikes，而这张表只有人点面板才变。
 *
 * 读的算式（体例同五份 DEPLOY.md 的配额账）：
 *   有客户端用子密钥时，每个活跃副本 每天 = 86400 ÷ (本 TTL 的秒数) × 1
 *   默认 300 秒 ⇒ **288 次/副本/天**；3 个活跃副本 = 864 次/天（读配额 0.86%），
 *   8 个 = 2,304 次/天（2.30%）。
 *   **一把子密钥都没发过、或全部客户端都用主口令时：0 次/天**（见文件头）。
 *
 * **用户可见的总生效上界 = 本 TTL，就是 5 分钟**，中间不再有任何一层缓存。
 * ⚠️ **上一版这里写的是「本 TTL(5 分钟) + KV 边缘缓存默认 60 秒 ≈ 6 分钟」，
 * 那笔欠账已经结清，别再照那句话读**：那 60 秒是 Cloudflare KV 边缘缓存的默认
 * `cacheTtl`，KV 这一层随 Worker 形态一起没了（`FileStorage.get` 直接 `readFile`），
 * v0.4.0 已经把那一整层从常量、公开响应体、面板文案与五语言文档里删干净。
 * ⇒ **「在面板上停用了一把密钥，它最多还能再用约 5 分钟」**——这是安全相关的，
 * 面板文案、ADMIN.md、DEPLOY.md 三处都要写这个具体数字，不许写「稍后生效」。
 * 想更快就调小 `APIKEY_CACHE_TTL_MS`，代价是上面那本读账等量放大，**两头都要写**。
 */
export const APIKEY_CACHE_TTL_MS = 300_000;

/**
 * `APIKEY_CACHE_TTL_MS` 这个环境变量的解析。**装配时判一次，非法值当场抛。**
 *
 * · **空串与「没设」同等对待**：`.env.example` 是给 `cp` + `env_file:` 直接用的，
 *   一个留空的键会以**空字符串**（不是 unset）进到环境里。少了这一行，
 *   `APIKEY_CACHE_TTL_MS=` 会走进 `Number("") = 0`——那恰好是一个**合法值**
 *   （关缓存），于是一份照抄 `.env.example` 的部署会静默地把缓存关掉，
 *   读配额随子密钥请求数线性增长。**这一条是本仓已经吃过一次的亏**
 *   （`USAGE_FLUSH_INTERVAL_MS` 那次是起不来，这一次会是静默烧配额，更难查）。
 * · **`0` 是合法的**（关缓存，逃生口），与 `POOL_CACHE_TTL_MS` 同一族，
 *   所以下界是 0 而不是 1。
 */
export function resolveApiKeyCacheTtl(raw: string | undefined): number {
  if (raw === undefined || raw === "") return APIKEY_CACHE_TTL_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    // **`ConfigRefusal` 而不是裸 `Error`**，理由与 `resolveUsageFlushInterval`
    // 那一处逐字相同（那边写着全文）：运维配错与代码 bug 必须分得开。
    throw new ConfigRefusal(`环境变量 APIKEY_CACHE_TTL_MS 必须是不小于 0 的整数: ${raw}`);
  }
  return n;
}

export function createApiKeyHolder(deps: {
  storage: Storage;
  logger: Logger;
  now: () => number;
  /** `0` = 关缓存（逃生口）：每一次走到第②段的请求都真读一次。 */
  ttlMs?: number;
}): ApiKeyHolder {
  /**
   * 曾经成功读到过（含「表不存在」那一档——那也是一次成功的读）。
   *
   * 它与 `createConfigHolder` 里那个 `primed` 是同一条纪律的同一个形状：
   * **只有「还没有任何一份合法快照可退」的那一次才允许把读失败降级成 `null`**。
   * 有兜底之后读失败一律**抛给 `Refreshable`**，由它保留上一份合法快照
   *（不降级的话，一次瞬时读抖动会把整张表静默换成"没有任何子密钥"，
   * 也就是让所有子密钥客户端 401 一个 TTL）。
   *
   * ⚠️ **冷启动那一档为什么必须降级而不是抛**：抛出去 `Refreshable` 在
   * `everLoaded === false` 时**刻意不推进计时**（见它的 `reload`），
   * 于是每一个走到第②段的请求都会重试一次真读 ⇒ **每个错口令请求一次 KV 读**。
   * 那正是本设计的头号风险：一条零凭据、零限速的路径变成撬动读配额的杠杆。
   * 降级成 `null` 之后它是一份**合法快照**，照样吃满一个 TTL。
   * 判据：`tests/contract/admin-apikeys-quota.test.ts` 的
   * 「表不存在时，1000 次错口令请求只产生 1 次 get」与
   * 「存储读不出来时，1000 次错口令请求同样只产生 1 次 get」。
   */
  let everOk = false;
  const r = new Refreshable<ApiKeyTable | null>({
    load: async () => {
      let read;
      try {
        read = await loadApiKeyTable(deps.storage);
      } catch (err) {
        if (everOk) throw err;
        deps.logger.log({
          level: "error", event: "apikeys.unreadable",
          msg: "读取对外 API 密钥表失败，本次按「没有任何子密钥」处理（主口令不受影响）",
          fields: { err: err instanceof Error ? err.message : String(err) },
        });
        // **它算一次成功的装载**：下一次 ensureFresh 要等满一个 TTL，见上面那段 ⚠️。
        everOk = true;
        return null;
      }
      everOk = true;
      if (read.kind === "ok") return read.table;
      if (read.kind === "invalid") {
        // **绝不静默当空表**：这条事件是运维唯一看得见的信号。
        // 原字节留在存储里没被动过，写路径会拒绝覆盖它（见 `loadApiKeyTable`）。
        deps.logger.log({
          level: "error", event: "apikeys.invalid",
          msg: "存储里的对外 API 密钥表结构不认，全部子密钥暂时失效（主口令不受影响）；"
            + "原始内容没有被改动，面板的写操作会被拒绝以免覆盖它",
          fields: {},
        });
        return null;
      }
      // 表不存在 = **一份合法快照**（还没签发过任何密钥），照样按 TTL 缓存。
      return null;
    },
    ttlMs: deps.ttlMs ?? APIKEY_CACHE_TTL_MS,
    now: deps.now,
    onError: (err) => deps.logger.log({
      level: "error", event: "apikeys.reload_failed",
      msg: "重新读取对外 API 密钥表失败，继续沿用上一份合法快照",
      fields: { err: err instanceof Error ? err.message : String(err) },
    }),
  });
  return {
    // 从未装载过时 `Refreshable.current()` 返回 `undefined`，这里归一成 `null`
    // ——调用方只该面对两档（有表 / 没有可用的表），不该再面对第三档。
    current: () => r.current() ?? null,
    ensureFresh: () => r.ensureFresh(),
    invalidate: () => r.invalidate(),
  };
}
