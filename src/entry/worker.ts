import { buildApp, buildTendDeps } from "../http/wire.js";
import { KvStorage } from "../adapters/storage-kv.js";
import { tendOnce, summarizeFailures } from "../core/registrar/tender.js";
import type { Hono } from "hono";

export interface Env {
  GATEWAY_TOKEN?: string;
  POOL: KVNamespace;
  [k: string]: unknown;
}

let cachedApp: Hono | null = null;
let cachedToken: string | undefined;

/** 补池轮次的重入锁，落在与 key 池同一个 KV 命名空间里（不新增依赖）。 */
const TEND_LOCK_KEY = "registrar_tend_lock";
/**
 * 锁的有效期。取 Cloudflare Cron Trigger 单次调用的墙钟上限（15 分钟）：超过它，
 * 上一轮要么已经结束、要么已经被平台中止，锁不该再拦住新的一轮——否则一次
 * 被中止的调用会让补池永久停摆。
 */
const TEND_LOCK_TTL_MS = 900_000;

/**
 * 补池一轮的墙钟预算，交给 `tendOnce` 用来决定「还要不要再开始一次铸 key」。
 *
 * 取上面那个 15 分钟墙钟上限的 87%，留出约 120 秒余量。余量不是随手定的：预算判据
 * 只算了占大头的那一项（`CODE_TIMEOUT_MS × 通道数`），单次尝试还会额外花掉若干个
 * 15 秒的单请求超时（列域名、每个域名的建/发/删、注册登录建 key）与 403 退避，
 * 这 120 秒就是留给这些尾巴的。把它们也算进判据是行不通的——理论最坏本来就高于
 * 900 秒，那样会变成一次尝试都不敢开始。
 *
 * 因此这条预算**精确针对** M1 引入的那个场景（两条通道都收不到验证码，纯等超时，
 * 5×2×120 秒 = 1200 秒撞穿墙钟）；「每个 HTTP 请求都挂满 15 秒」那种病态情形不在
 * 它的覆盖范围内，那一条是 P2 之前就存在并已在文档里写明接受的取舍。
 *
 * Node/Docker 没有平台墙钟上限，`node.ts` 刻意不传这个字段。
 */
const TEND_ROUND_BUDGET_MS = 780_000;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    let app = cachedApp;

    // token 变化或还未初始化时才重新装配；装配失败绝不复用旧缓存
    // （旧 token 对应的旧 app 可能已经不该再服务当前请求）。
    if (!app || cachedToken !== env.GATEWAY_TOKEN) {
      try {
        app = await buildApp(env as Record<string, string | undefined>, new KvStorage(env.POOL));
      } catch (err) {
        return new Response((err as Error).message, { status: 500 });
      }
      cachedApp = app;
      cachedToken = env.GATEWAY_TOKEN;
    }

    return app.fetch(req);
  },

  /**
   * Cron 触发的补池入口。`wrangler.toml` 里的 `[triggers]` 配了触发频率，平台按
   * 该频率调用这个导出——与 Node 侧命令式的 `setInterval` 不同，这里是声明式的，
   * 触发本身不需要我们自己起定时器。
   *
   * 装配依赖失败或补池失败都只记日志、不重新抛出：一次 Cron 调用失败不该影响
   * 下一次调度，也不该影响 fetch() 处理的正常转发请求。
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const storage = new KvStorage(env.POOL);
    let deps;
    try {
      deps = await buildTendDeps(env as Record<string, string | undefined>, storage);
    } catch (err) {
      console.error("[registrar] 装配补池依赖失败", err);
      return;
    }
    if (!deps) return; // 注册机未启用：零副作用

    // 重入保护。Cloudflare **不会**串行化重叠的 Cron 调用：单轮最坏耗时
    //（MINT_BATCH × CODE_TIMEOUT_MS）超过 Cron 间隔时，上一轮还在跑就会又起一轮，
    // 而「顺序铸、不并发」是功能性约束（并发同时撞邮箱服务的建号限流与 Agnes 的
    // 注册风控），不是性能取舍。KV 是最终一致的，这把锁只是尽力而为、不是互斥
    // 原语；它挡的是"上一轮明明还在跑"这种最常见的重叠，而不是纳秒级的竞态。
    const now = Date.now();
    const lock = await storage.get<{ until?: number }>(TEND_LOCK_KEY);
    if (lock && typeof lock.until === "number" && lock.until > now) {
      console.warn("[registrar] 上一轮补池仍在进行，跳过本次 Cron 触发（可调疏 cron 或调小 MINT_BATCH）");
      return;
    }
    await storage.put(TEND_LOCK_KEY, { until: now + TEND_LOCK_TTL_MS });

    ctx.waitUntil(
      (async () => {
        try {
          // 只有 Worker 形态传轮级预算：Cron 被平台中止时 mintOne 的 finally 不跑、
          // 邮箱漏删，必须靠「不启动跑不完的尝试」来避免（见 TEND_ROUND_BUDGET_MS）。
          const r = await tendOnce({ ...deps, roundBudgetMs: TEND_ROUND_BUDGET_MS });
          if (!r.skipped) {
            console.log(
              `[registrar] 补池完成 available=${r.available} attempted=${r.attempted} minted=${r.minted}`,
            );
            // 与 Node 入口同一份口径：见 node.ts 里同位置的注释。
            if (r.minted < r.attempted) {
              console.warn(`[registrar] 本轮有名额未铸出，归因 reasons=${summarizeFailures(r.failures)}`);
            }
          }
        } catch (err) {
          console.error("[registrar] 补池失败", err);
        } finally {
          // 锁必须释放，否则下一次 Cron 要空等到 TTL 到期才肯干活。释放本身
          // 失败也不能让这个后台任务以异常收场。
          try {
            await storage.delete(TEND_LOCK_KEY);
          } catch (err) {
            console.warn("[registrar] 释放补池锁失败，最坏情况下要等锁自然过期", err);
          }
        }
      })(),
    );
  },
};
