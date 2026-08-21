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
 * ── ⚠️ 它为什么住在 `src/http/admin/`：**一条约定，不是一道门禁**───────────────
 *
 * **先说结论，因为上一版这段话在这里写错过一次**：**没有任何门禁拦着它进 `src/core/`。**
 * 上一版写的是「`acquireTendLock` 做 IO，而 `src/core/` 有零 IO 门禁拦着」——
 * **那是假的，评审实测**：真把本文件挪进 `src/core/admin/` 并改齐 10 处 import 之后，
 * `tsc --noEmit` 干净，而 `tests/unit/source-guards.test.ts` 的
 * 「扫描到的使用点恰好等于手写的豁免清单」**一点反应都没有**（那一组 24/24 全绿）。
 * 那道门禁的扫描目标是**时间/随机/定时/网络/环境全局**，`storage.get/put/delete`
 * 一个都不在内；同一个文件里还并排放着一条**正面**断言
 * 「注入的端口不算数——deps.fetcher.fetch() / this.o.now() 正是零 IO 想要的形态」，
 * 而 `acquireTendLock(storage, now)` 收的正是「注入端口 + 注入时刻」，
 * **它是那道门禁祝福的形态，不是它禁止的形态。**
 *
 * **真正的理由是 `src/core/admin/` 的一条约定**（六个文件无一例外，`grep -n "^import"
 * src/core/admin/*.ts` 可复核：没有一个 import 过任何 IO 端口，`storage` 只出现在注释里）：
 * **「键名常量 + 窄化 + 纯判据」进 core，「真的读写存储」的那几行留在外层。**
 * 同一批里的 `src/core/admin/tend-guard.ts` 就是范例——`MANUAL_GUARD_KEY` 与
 * `checkManualTend()` 在 core，读写它的那两行在 `handlers/registrar.ts`。
 *
 * ⇒ **本文件今天违反了那条约定**：`TEND_LOCK_KEY` / `TEND_LOCK_TTL_MS` /
 * `narrowTendLock()` 三样按约定该住 `src/core/admin/`，只有 `acquire`/`release`
 * 该留在这里。**没拆是范围取舍，不是有什么东西拦着**——拆开要动两个入口 + wire + handler
 * 的 import，而本任务是本期风险最高的一个。**拆分成本很低，随时可以做，
 * 而且做完之后本段可以整个删掉。**
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
