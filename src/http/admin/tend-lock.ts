import type { Storage } from "../../ports/storage.js";
import { WORKER_CRON_WALL_CLOCK_MS } from "../../core/registrar/types.js";

/**
 * 补池的**两把重入锁**。一把在进程/isolate 内，一把跨副本，**作用域不同、不是冗余**。
 *
 * ── 为什么是两把（这一段是本文件存在的全部理由，别删掉其中一把）─────────────
 *
 * | | `createTendGate()` | `acquireTendLock()` |
 * |---|---|---|
 * | 落在哪 | 一个进程内的布尔变量 | 存储里的 `registrar_tend_lock` 键 |
 * | 挡什么 | **同一个进程/isolate 内**的重入（Node 的定时轮 × 面板按钮、同一个 isolate 上两个并发请求） | **跨副本 / 跨 isolate** 的重叠（多容器共卷、Worker 的 `scheduled()` 与 `fetch()` 是两个 isolate） |
 * | 挡不住什么 | 另一个副本（它有自己的那个布尔） | 纳秒级竞态（KV 最终一致，`get` 与 `put` 之间有真实窗口） |
 *
 * 删掉进程内那把 ⇒ 同一个 isolate 上两个并发请求在存储锁的 `get`→`put` 窗口里**双双
 * 抢到**；删掉存储那把 ⇒ 多副本部署下形同虚设（Node 侧此前**只有**进程内那把，
 * 这正是设计 §10.2 第 1 条点名要补的洞）。两条用例各钉一把，见
 * `tests/contract/manual-tend.test.ts` 的
 * 「同一个副本上两个并发请求：只有一个真跑（进程内守卫，存储锁在这里拦不住）」与
 * 「两个副本同时点『立即补池』，只有一个真的跑起来，另一个拿到 409」。
 *
 * ⚠️ **诚实限定，不许被改写成「并发已解决」。** KV 是最终一致的，存储锁是**尽力而为、
 * 不是互斥原语**；它挡的是「上一轮明明还在跑」这种最常见的重叠，不是纳秒级竞态。
 * 同一个限定在 `src/entry/worker.ts` 的 Cron 路径上从第一天就写着，本文件只是把它
 * 抽出来给两种运行时共用。
 *
 * ── ⚠️ 它为什么住在 `src/http/admin/`（这个位置是别扭的，别以为是随手放的）─────
 *
 * **它的两个消费者里有一个与 admin / http 毫无关系**：`src/entry/worker.ts` 的
 * `scheduled()` 与 `src/entry/node.ts` 的定时轮都 import 这个文件，而那条路上既没有
 * 请求也没有面板。按职责它更该住在 `src/core/registrar/`。
 *
 * **进不去的原因是一条硬约束，不是偷懒**：`acquireTendLock` / `releaseTendLock` 真的做
 * IO（`storage.get/put/delete`），而 `src/core/` 有零 IO 门禁
 *（`tests/unit/source-guards.test.ts` 的
 * 「调用点恰好等于手写的豁免清单——绕过注入 Logger 的事件永远进不了面板」那一组扫的就是
 * 这一类）。`src/adapters/` 也不合适：那一层是「隔离某个具体运行时能力」的适配器，
 * 而这里是**业务判据**（谁能开始下一轮补池），只是恰好要读写存储。
 *
 * ⇒ **现状是在「零 IO 门禁」与「分层直觉」之间选了前者**，代价就是这个别扭的路径。
 * 真要挪，`src/core/registrar/` 之外还有一个候选是新开一层（例如 `src/services/`），
 * 但那是全仓性的分层决定，不该由一个锁文件顺手带出来。**改名成本很低，随时可以重来。**
 */

/** 补池轮次的重入锁，落在与 key 池同一个存储命名空间里（不新增依赖）。 */
export const TEND_LOCK_KEY = "registrar_tend_lock";

/**
 * 锁的有效期。取 Cloudflare Cron Trigger 单次调用的墙钟上限（15 分钟）：超过它，
 * 上一轮要么已经结束、要么已经被平台中止，锁不该再拦住新的一轮——否则一次
 * 被中止的调用会让补池永久停摆。
 *
 * ⚠️ **这把键写的时候不传 `expiresAt`**：有界性靠「单一固定键、数量恒为 1」，
 * 陈旧值无害——读侧是 `until > now` 的**值比较**，过期的锁不拦任何人。
 */
export const TEND_LOCK_TTL_MS = WORKER_CRON_WALL_CLOCK_MS;

/** 存储里读回来的锁值。窄化：`Storage.get` 是裸 `JSON.parse` + `as`，什么形状都可能是。 */
export function narrowTendLock(raw: unknown): { until: number } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const until = (raw as Record<string, unknown>).until;
  return Number.isFinite(until) ? { until: until as number } : null;
}

export type TendLockResult = { ok: true } | { ok: false; until: number };

/**
 * 抢锁。**`get` → 存在性检查 → `put` 三步**，中间那一步不能省：省掉它就是
 * 「两个都抢到」，而那正是这把锁存在的全部理由。
 *
 * 返回 `{ ok: false, until }` 时 `until` 是当前持锁方声明的到期时刻，
 * 面板拿它显示「上一轮还在跑，最晚 X 之前会结束」。
 */
export async function acquireTendLock(storage: Storage, now: number): Promise<TendLockResult> {
  const lock = narrowTendLock(await storage.get(TEND_LOCK_KEY));
  if (lock !== null && lock.until > now) return { ok: false, until: lock.until };
  await storage.put(TEND_LOCK_KEY, { until: now + TEND_LOCK_TTL_MS });
  return { ok: true };
}

/**
 * 释放锁。**调用方必须放在 `finally` 里**——放在 `try` 的末尾时，一次抛错的补池会
 * 让锁留到自然过期（最长 15 分钟）才肯放下一轮进来，也就是一次失败换来一段停摆。
 */
export async function releaseTendLock(storage: Storage): Promise<void> {
  await storage.delete(TEND_LOCK_KEY);
}

/**
 * 进程 / isolate 内的在途守卫。
 *
 * **同步获取**是它的关键性质：`tryEnter()` 里没有任何 `await`，所以两个并发调用之间
 * 不存在检查与占用之间的窗口。写成「先问 `busy()` 再 `run()`」就把那个窗口造回来了
 *（两次调用之间隔着若干次存储 IO），而那种形态下第二个请求会拿到 202 却什么都没跑
 * ——**面板说「已开始」而实际没有**，正是本仓反复裁过的那一类。
 */
export interface TendGate {
  /**
   * 占住守卫。返回释放函数；已被占住时返回 `null`。
   * **释放函数必须被调用恰好一次**，重复调用是无害的空操作。
   */
  tryEnter(): (() => void) | null;
}

export function createTendGate(): TendGate {
  let inFlight = false;
  return {
    tryEnter() {
      if (inFlight) return null;
      inFlight = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight = false;
      };
    },
  };
}
