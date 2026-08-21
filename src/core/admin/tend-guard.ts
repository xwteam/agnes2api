/**
 * 手动补池的**第二、第四条护栏**（设计 §10.2 第 2 条 + 计划 F11）：
 * 两次手动补池之间的 10 分钟冷却，以及每天最多几次的**写预算闸**。
 *
 * **零 IO 纯函数**（硬约束 2）。读写存储在 `src/http/admin/handlers/registrar.ts`。
 *
 * ── 为什么冷却与预算合成**一把键**（评审 C2 的读法 B）──────────────────────
 *
 * 计划第一版写的是「与手动冷却键共用一条读写（省一次 get），且同样带 `expiresAt`」，
 * 那句话有两种合法读法，其中一种让整道闸门失效：
 *
 * · **读法 A（失效）**：冷却与预算共用同一把键、同一个 `expiresAt`。冷却是 10 分钟
 *   ⇒ 这把键每 10 分钟蒸发一次 ⇒ `used` 随之归零 ⇒ **日预算闸永远走不到耗尽**。
 * · **读法 B（本文件）**：一把键装 `{ day, used, cooldownUntil }`，
 *   **两个字段各管各的、互不借用**：`day` 判跨天、`cooldownUntil` 判冷却。
 *
 * 读法 A 的错处是让 TTL 去兼任 `day` 的职责。**这把键一律不传 `expiresAt`**
 *（见 `MANUAL_GUARD_KEY`），于是读法 A 在结构上不存在——**把缺陷做成不可表达，
 * 而不是做成可检测**。
 *
 * ── 有界性挂在哪根轴上（换一根轴自检）────────────────────────────────────
 *
 * 预算的有界性只依赖 `day` 这个**值**：换掉存储的 TTL 能力（比如某个 Storage 实现
 * 压根不支持 `expiresAt`）它照样成立。这与 `tend:history` 是同一条判据——
 * 键名是固定字面量、**数量恒为 1**，根本没有「键空间无界」那根轴可关。
 */

/** 一天的毫秒数。与 `src/core/admin/event-ring.ts` 的 `DAY_MS` 同一个数，各写各的字面量。 */
const DAY_MS = 86_400_000;

/**
 * 手动补池护栏的存储键。**单一固定键，数量恒为 1。**
 *
 * ⚠️ **写它的时候一律不传 `expiresAt`**：陈旧判定全靠两处**值比较**
 *（`day !== 今天`、`now < cooldownUntil`），加 TTL 只会把上面那个失效读法请回来。
 * 代价明写：这把键会在存储里长期驻留（1 把）。永久关掉注册机、或删掉部署但保留
 * KV 命名空间时它不会自己消失，清理靠手工删键（五语言 REGISTRAR.md 写了）。
 */
export const MANUAL_GUARD_KEY = "registrar_manual_guard";

/**
 * 两次手动补池之间的最小间隔（设计 §10.2 第 2 条逐字：10 分钟）。
 *
 * 它挡的是**连点**：一次手动补池最多消耗 `MINT_BATCH` 个临时邮箱，而 YYDS / MoeMail
 * 的活跃邮箱名额是有限的（具体数字见 REGISTRAR.md，本仓**没有**核实过外部服务的配额，
 * 不许把它当既定事实写进代码或面板文案）。
 */
export const MANUAL_TEND_COOLDOWN_MS = 600_000;

/**
 * 每天最多几次手动补池 —— **第四条护栏**（计划 F11）。
 *
 * 三重护栏挡住了并发与邮箱名额，**挡不住 KV 写配额**：10 分钟冷却本身只把上界压到
 * `24 × 6 = 144` 次/天 = `144 × 3 = 432` puts/天，叠上稳态之后占日写配额约 75%，
 * 而稳态那部分（事件 sink 的 `12 × M`）**本身就不是上界**——`M`（并发 isolate 数）
 * 连用户都不能调。**一个占 75% 且两端都在浮动的账，没有余量可言。**
 *
 * ── 取 24 的算式（全局约束 13 要求写进五语言 DEPLOY.md，那里有同一份）──────
 *
 * 一次手动补池的**非铸造**写侧成本固定是 **3 次 put**（护栏键 1 + 抢锁 1 +
 * `tend:history` 1）外加 1 次 delete（释放锁，走另一个桶）；每铸出一把 key 再加
 * 2 次 put（记录 + 索引），而铸造那部分**自限**——`rounds = Math.min(need, mintBatch)`，
 * 缺口填平之后 `need <= 0` 就一把都不铸了。
 *
 * · 可持续：`24 × 3 = 72` puts/天，叠上「注册机开着且每轮都有失败事件」的稳态 320
 *   ⇒ **392/天 = 39.2%**。
 * · 突发上界（每次都铸满默认的 `MINT_BATCH = 5`）：`24 × 13 = 312`
 *   ⇒ **632/天 = 63.2%**，且这一栏靠邮箱名额与 `targetKeys` 先撞死，不可持续。
 *
 * **K 的基线只取「真正有硬上界的那几项」**（key 池 80 + 补池锁 48 + `tend:history` 48），
 * 不拿会随部署形态浮动的 `12 × M` 去当尺子——那会是拿一个非上界当基线。
 */
export const MANUAL_TENDS_PER_DAY = 24;

/**
 * 护栏键的值。**三个字段全是数字，没有可选字段**——从存储读回来的东西一律不可信，
 * 缺一个就整条作废（见 `narrowManualGuard`），而"作废"的语义恰好是安全的那一侧：
 * 当成「今天还没点过」放行一次，而不是当成「已经耗尽」把面板永久锁死。
 */
export interface ManualGuard {
  /** 这条记录属于哪一天（UTC 日序号）。跨天判定**只看它**，不看任何 TTL。 */
  day: number;
  /** 这一天已经点过几次。 */
  used: number;
  /** 冷却到期时刻（epoch ms）。判据是 `now < cooldownUntil` 这一处**值比较**。 */
  cooldownUntil: number;
}

/** UTC 日序号。`day !== dayIndex(now)` 就是「换了一天」，回拨与前进都算。 */
export function dayIndex(now: number): number {
  return Math.floor(now / DAY_MS);
}

/**
 * 当天结束（= 下一天开始）的绝对时刻。**这就是 429 响应里的 `resetAt`**——
 * 面板要能说出"什么时候能再点"，而不是只说"不能点"。
 */
export function dayEndsAt(now: number): number {
  return (dayIndex(now) + 1) * DAY_MS;
}

/**
 * 从存储读回来的护栏值。**逐字段窄化**（硬约束 8）：`Storage.get` 是裸
 * `JSON.parse` + `as` 断言，运行期什么形状都可能是，而这把键的三个数字直接决定
 * 「还能不能点」。
 *
 * 判据比 `narrowTendHistory` 更硬：**任一字段读不得就整条返回 `null`**，
 * 也就是「当成今天还没点过」。方向是刻意选的——被外部写坏一把键的代价是
 * 多放行一轮补池（有存储锁与冷却兜着），而反过来（当成已耗尽）会把「立即补池」
 * 这颗按钮永久锁死，运维在面板上看不出任何原因。
 */
export function narrowManualGuard(raw: unknown): ManualGuard | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Number.isFinite(o.day) || !Number.isFinite(o.used) || !Number.isFinite(o.cooldownUntil)) {
    return null;
  }
  return { day: o.day as number, used: o.used as number, cooldownUntil: o.cooldownUntil as number };
}

/**
 * 判定结果。**`remaining` 三支都给**，口径统一为「从现在起今天还能点几次」
 *（不含正在处理的这一次）。
 *
 * ⚠️ **不许只在耗尽那一支给 `remaining`**：面板要**如实显示还剩几次**，
 * 等到耗尽才说等于让运维在毫不知情的情况下撞上一堵墙。
 */
export type ManualTendVerdict =
  | { ok: true; next: ManualGuard; remaining: number; resetAt: number }
  | {
    ok: false;
    /** 机器可读判别字段。面板靠它选一句五语言文案，靠解析 `message` 的中文是不行的。 */
    reason: "write_budget_exhausted" | "manual_cooldown";
    remaining: number;
    resetAt: number;
    retryAfterMs: number;
  };

/**
 * 这一次「立即补池」放不放行。
 *
 * ⚠️ **写预算排在冷却前面，顺序有意义。** 两条同时不满足时报冷却，运维会等 10 分钟
 * 再点一次，然后撞上预算耗尽——报的那句话得是他照着能改的那一句，而"今天的额度用完了、
 * 到 UTC 零点恢复"与"再等 8 分钟"是两种完全不同的处置。同一条纪律见
 * `tests/contract/admin-auth.test.ts` 的
 * 「又短又含汉字时报 not_sendable 而不是 too_short」。
 *
 * **跨天与时钟回拨走同一条判据**（`day !== 今天`）：回拨到昨天也算「新的一天」，
 * 与本仓其余四处（`Refreshable` / `listOnReadPath` / `KeyPoolRepo` / `WriteBudget`）
 * 的 `age < 0` 立刻恢复是同一套语义。
 *
 * 🔴 **如实登记的残留**：`cooldownUntil` 不跟着跨天一起清（两个字段互不借用）。
 * 时钟往回拨 1 小时时，冷却会比 10 分钟多挡约 50 分钟。方向是 fail-safe 的
 *（少写、不多写），而让跨天顺手清冷却就等于把 `day` 的职责借给了 `cooldownUntil`
 * ——那正是读法 A 的错处，只是方向反过来。
 */
export function checkManualTend(cur: ManualGuard | null, now: number): ManualTendVerdict {
  const today = dayIndex(now);
  const resetAt = dayEndsAt(now);
  // `day` 对不上就是「新的一天」⇒ 已用次数归零。**这一处值比较是跨天的全部判据。**
  const used = cur !== null && cur.day === today ? cur.used : 0;
  const remaining = Math.max(0, MANUAL_TENDS_PER_DAY - used);

  if (used >= MANUAL_TENDS_PER_DAY) {
    return { ok: false, reason: "write_budget_exhausted", remaining: 0, resetAt, retryAfterMs: resetAt - now };
  }
  // 冷却是一处**值比较**，与上面那一处互不借用。陈旧的 `cooldownUntil` 拦不住任何人。
  if (cur !== null && now < cur.cooldownUntil) {
    return {
      ok: false, reason: "manual_cooldown", remaining, resetAt,
      retryAfterMs: cur.cooldownUntil - now,
    };
  }
  return {
    ok: true,
    next: { day: today, used: used + 1, cooldownUntil: now + MANUAL_TEND_COOLDOWN_MS },
    remaining: remaining - 1,
    resetAt,
  };
}
