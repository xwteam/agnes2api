import type { Storage } from "../../ports/storage.js";
import { SCHEDULED_ROUND_WALL_CLOCK_MS } from "../../core/registrar/types.js";

/**
 * 补池的**两把重入锁**。一把在进程内，一把跨副本，**作用域不同、不是冗余**。
 *
 * ── 为什么是两把（这一段是本文件存在的全部理由，别删掉其中一把）─────────────
 *
 * | | `createTendGate()` | `acquireTendLock()` |
 * |---|---|---|
 * | 落在哪 | 一个进程内的布尔变量 | 存储里的 `registrar_tend_lock` 键 |
 * | 挡什么 | **同一个进程内**的重入（定时轮 × 面板按钮、同一个进程上两个并发请求） | **跨副本**的重叠（多容器共卷同一个 `DATA_DIR`） |
 * | 挡不住什么 | 另一个副本（它有自己的那个布尔） | 纳秒级竞态（`get` 与 `put` 之间有真实窗口） |
 *
 * 删掉进程内那把 ⇒ 同一个进程上两个并发请求在存储锁的 `get`→`put` 窗口里**双双
 * 抢到**；删掉存储那把 ⇒ 多副本部署下形同虚设（这正是设计 §10.2 第 1 条点名要补的洞）。
 * 两条用例各钉一把，见 `tests/contract/manual-tend.test.ts` 的
 * 「同一个副本上两个并发请求：只有一个真跑（进程内守卫，存储锁在这里拦不住）」与
 * 「上一轮（Cron）还持着锁时，手动点击拿到 409 locked 且执行体一次都不跑」。
 *
 * ⚠️ **诚实限定，不许被改写成「并发已解决」。** 存储锁是**尽力而为、不是互斥原语**：
 * `acquireTendLock` 是「读 → 判 → 写」三步，中间跨着 await 点，两个容器可以双双读到
 * 空锁再双双写回。**这条限定的理由换过一次，结论没变**：原来的理由是「KV 是最终
 * 一致的」，v0.4.0 摘掉 Worker/KV 形态之后换成 `FileStorage` 的形态——它的写队列
 * 只串行化**本进程**的读改写（见 `src/adapters/storage-file.ts` 的并发说明），
 * 跨容器时两个进程各读一份 `store.json`、各整文件写回。
 * 它挡的是「上一轮明明还在跑」这种最常见的重叠，不是纳秒级竞态。
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
 * ⇒ **本文件今天违反了那条约定**：`TEND_LOCK_KEY` / 两份 `TEND_LOCK_TTL_*` /
 * `narrowTendLock()` 三样按约定该住 `src/core/admin/`，只有 `acquire`/`release`
 * 该留在这里。**没拆是范围取舍，不是有什么东西拦着**——拆开要动入口 + wire + handler
 * 的 import。**拆分成本很低，随时可以做，而且做完之后本段可以整个删掉。**
 */

/** 补池轮次的重入锁，落在与 key 池同一个存储命名空间里（不新增依赖）。 */
export const TEND_LOCK_KEY = "registrar_tend_lock";

/**
 * **定时轮**的锁有效期，取 `SCHEDULED_ROUND_WALL_CLOCK_MS`（15 分钟）。
 *
 * ⚠️ **那个数原来是「Cloudflare Cron Trigger 单次调用的墙钟上限」，v0.4.0 之后
 * 不是了**（Node 的定时轮没有任何平台会来砍它）。它今天的两条依据写在那个常量上：
 * 上界是「必须明显短于 `TEND_INTERVAL_MS`，硬杀之后最多跳过一轮」，
 * 下界是「必须盖得住一轮的真实最坏耗时」。锁到期不代表上一轮真的结束了，
 * 只代表**再拦下去的代价已经大于放行的代价**。
 *
 * ⚠️ **只给定时轮那条路用。** 手动那条路走 `TEND_LOCK_TTL_MANUAL_MS`，
 * 两者混用过一次，代价见那一段。
 *
 * ⚠️ **这把键写的时候不传 `expiresAt`**：有界性靠「单一固定键、数量恒为 1」，
 * 陈旧值无害——读侧是 `until > now` 的**值比较**，过期的锁不拦任何人。
 */
export const TEND_LOCK_TTL_SCHEDULED_MS = SCHEDULED_ROUND_WALL_CLOCK_MS;

/**
 * **手动补池专用的锁有效期。**
 *
 * 🔴 与定时轮那份分开、且**照轮次的真实墙钟定，不照载体定**。取 180 秒的两头夹：
 *
 * - **下界**：手动一轮的真实最坏 ≈ 60 秒（`MANUAL_CODE_TIMEOUT_MS` 等码）
 *   ＋ 注册链上约 5 个 `REGISTRAR_REQUEST_TIMEOUT_MS` = 15 秒的请求尾巴
 *  （发码 / 轮询 / 注册 / 登录 / 建 key）≈ **135 秒**。锁必须盖得住它，否则
 *   `releaseTendLock` 那个**无条件** `storage.delete` 会去删掉别人刚抢到的锁。
 * - **上界**：手动冷却是 600 秒、定时轮间隔 1800 秒。取 180 秒 ⇒ 一次被中断的点击
 *   最多挡住补池 3 分钟，撞上定时轮的概率 180/1800 = 10%，撞上也只跳一轮
 *  （对比出事时那份 15 分钟：**必然**挡掉至少一轮）。
 *
 * ⚠️ **这里原来还有一条「下界②：必须大于 `KV_READ_STALENESS_MS`（60 秒）」，
 * 连同那个常量一起在 v0.4.0 删掉了。** 那 60 秒是 Cloudflare KV 边缘读的陈旧窗口
 * ——「另一个 colo 读到的锁最多陈旧这么久」。`FileStorage` 没有这一层：`get` 直接
 * `readFile`，多容器共卷时看到的是同一份 `store.json`，陈旧窗口是文件系统级的、
 * 不是分钟级的。**删掉它之后 180 秒仍然合格**，因为它由上面那条下界（≈135 秒）
 * 独立地定着，不是靠那 60 秒撑起来的。
 */
export const TEND_LOCK_TTL_MANUAL_MS = 180_000;

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
 *
 * 🔴 **`ttlMs` 必填、刻意不给默认值。** 从前它是文件级常量 `TEND_LOCK_TTL_MS`
 *（= Cron 的 15 分钟），于是手动那条路**无声地**沿用了 Cron 的 TTL，一次被平台中断的
 * 点击就把注册机连同 Cron 一起锁死一刻钟。给这个参数补一个默认值 = 那条缺陷原地复活，
 * 而且下一次同样不会有任何东西提醒你。三个调用点必须各自显式表态用哪一份。
 */
export async function acquireTendLock(
  storage: Storage, now: number, ttlMs: number,
): Promise<TendLockResult> {
  const lock = narrowTendLock(await storage.get(TEND_LOCK_KEY));
  if (lock !== null && lock.until > now) return { ok: false, until: lock.until };
  await storage.put(TEND_LOCK_KEY, { until: now + ttlMs });
  return { ok: true };
}

/**
 * 释放锁。**调用方必须放在 `finally` 里**——放在 `try` 的末尾时，一次抛错的补池会
 * 让锁留到自然过期（定时轮最长 15 分钟、手动轮最长 3 分钟）才肯放下一轮进来，
 * 也就是一次失败换来一段停摆。
 *
 * ⚠️ **`finally` 挡不住进程被硬杀**：`SIGKILL` / OOM kill / 容器重建时它一行都不跑
 *（`SIGTERM` 那一档 Node 会跑完当前微任务，但没有任何保证）。那正是两份 TTL 都必须
 * 有限、且手动那份必须短于冷却的理由——`finally` 失效时，TTL 是最后一道兜底。
 */
export async function releaseTendLock(storage: Storage): Promise<void> {
  await storage.delete(TEND_LOCK_KEY);
}

/**
 * 进程内的在途守卫。
 *
 * **同步获取**是它的关键性质：`tryEnter()` 里没有任何 `await`，所以两个并发调用之间
 * 不存在检查与占用之间的窗口。写成「先问 `busy()` 再 `run()`」就把那个窗口造回来了
 *（两次调用之间隔着若干次存储 IO），而那种形态下第二个请求会拿到一个成功码却什么
 * 都没跑——**面板说跑了而实际没有**，正是本仓反复裁过的那一类。
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
