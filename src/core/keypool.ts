import type { KeyRecord } from "./types.js";

/**
 * 「这把 key 被管理员手工停用了吗」。**全仓唯一一份判据。**
 *
 * 各写各的后果是「面板显示已停用、调度器照常用它」——本字段最难被发现的失败形态。
 * 所以**问这个问题的地方一处都不许自己判**，全部调它。今天有 **7 处**
 * （`grep -rn "isDisabled(" src/`，2026-08-20 重数过一遍）：
 *
 * | 位置 | 干什么 |
 * |---|---|
 * | 本文件 `isAvailable` | 能不能拿去打上游 |
 * | 本文件 `poolHealth` | 四格计数里的 `disabled` 那格 |
 * | `src/core/admin/key-view.ts` 的 `keyBucket` | 面板分档 |
 * | `src/core/admin/key-view.ts` 的 `toKeyViews` | 投影出 `KeyView.disabled` |
 * | `src/core/dispatcher.ts` 的 `unavailable()` | Retry-After 要筛掉停用的 key |
 * | `src/http/admin/handlers/keys-write.ts` 的 `deletable()` | 「必须先停用才能删」那条安全约束 |
 * | 同上，`key.deleted` 事件的 `wasDisabled` 字段 | **不是判据**，只是如实记一笔当时的状态 |
 *
 * ⚠️ **最后一行刻意留在表里而不是省掉**：它是本表第一个**非判据**的调用处，
 * 而「表里只列判据」这条规矩没有任何东西守着——省掉它，下一个人重数时会得到
 * 6 或 7 两个都说得通的答案，然后再写错一次。
 *
 * ⚠️ **这张表是手写的，没有任何门禁校验它的条数**——`scripts/check-comment-refs.mjs` 这道门禁只校验路径解析得开，
 * 校验不了一个数字。**它已经在本任务里错过两次**：先写成「三个读取处」（漏了
 * `poolHealth` 与 `dispatcher`，而那两个恰恰是本任务新引入、后果最重的），
 * 改的时候又顺手写下「`isAvailable` 的调用处有四个」——`isAvailable` **从来没有过
 * 四个调用处**：早先是 2 个（`selectKey` 与 `tendOnce`），现在是 1 个（只剩 `selectKey`）。
 * **改这段时请当场 `grep -rn "isDisabled(" src/` 重数一遍，别信这段话。**
 *
 * ⚠️ **另一条教训，比条数值钱**：下面那条缺陷的成因是**给一个共享判据加条件时 grep 错了对象**。
 * 我当时 grep 的是新字段名 `\.disabled`，它只能查出「谁读这个记录字段」；
 * 而真正会被改变语义的是**这个判据的每一个调用者**——那次漏掉的
 * `src/core/registrar/tender.ts` 就是这么漏的。**该 grep 判据的名字。**
 *
 * **用真值性而不是 `=== true`**，理由是记录的真实来源：`src/core/keypool-repo.ts`
 * 的 `loadRecords()` 走 `storage.get<KeyRecord>()`，那是**裸 `JSON.parse` 之后的 as
 * 断言，没有任何窄化**，运行期什么形状都可能是。对一个安全开关来说，
 * 「读不懂就当停用」是安全的那一侧：key 停用了、面板也如实显示成已停用，运维看得见、
 * 点一下就能改回来；反过来（`=== true`，`"true"` 判成没停用）则是运维明明关了它、
 * 网关继续拿它发请求，而面板还说它是可用的。
 *
 * **刻意不做成 `normalizeFlags(r)` 那样返回对象的形态**：`isAvailable` 在 `selectKey`
 * 的循环里，逐条记录新建一个对象只为读一个布尔，是热路径上白付的代价；而返回布尔
 * 同样满足「所有读取处走同一份实现」这条真正要保的性质。
 */
export function isDisabled(r: KeyRecord): boolean {
  return !!r.disabled;
}

/** 「现在能不能拿这把 key 去打上游」。**只回答这一个问题**，见 `countsTowardTarget`。 */
export function isAvailable(r: KeyRecord, now: number): boolean {
  return !r.evicted && !isDisabled(r) && r.cooldownUntil <= now;
}

/**
 * 「这把 key 还算不算在 `targetKeys` 名额里」——**补池专用，与 `isAvailable` 是两个问题**。
 *
 * 两者曾经是同一个函数，而它们只在**被停用**的 key 上分歧，所以那次合并一直没出事。
 * `disabled` 落地的那一刻它就出事了（评审实测复现）：
 * `src/core/registrar/tender.ts` 的 `tendOnce` 拿 `targetKeys - available` 当缺口，
 * **差多少就真的去注册多少个 Agnes 账号**（建临时邮箱 → 注册 → 建 token）。
 * 让 `isAvailable` 顺手回答这个问题，等于**「在面板上停用一把 key」＝「自动注册一个新账号」**。
 *
 * ⚠️ **判据是 `!r.evicted`，一个字都不多——`disabled` 与 `cooling` 都占名额。**
 * 「停用」刚落地时它写的是 `!evicted && cooldownUntil <= now`（只放过 `disabled`），
 * 那一版把两条同族缺陷留在了线上，后来一并关掉：
 *
 * · **停用一把正在冷却的 key 仍会触发一次补池。** `disabled + cooling` 落在
 *   `cooldownUntil > now` 那一支上 ⇒ 不占名额 ⇒ 照样铸一把新的。实测（`targetKeys=3`）：
 *   `available` 3→2、`minted` 1、池子 3→4，**冷却到期后 `need` 转负，多出来的那把
 *   再也不会退掉**。而**运维最可能去停用一把 key 的起因，恰恰是面板上显示它「冷却中」**
 *   ——这条残留落在的是最常见的路径，不是边角。
 * · **冷却导致池子永久膨胀，线性、不封顶。** 实测（`targetKeys=3`）：稳态 3 →
 *   全池被限流冷却那一轮 `minted=3` ⇒ 池子 **6**；冷却到期 `need=-3` 不再铸
 *   ⇒ **永久停在 6**；下一次风暴 **9**，再下一次 **12**。每一次全池风暴永久
 *   `+targetKeys`，而每一把都是一次真实的 Agnes 建号 + 一个临时邮箱。
 *
 * **改成 `!r.evicted` 之后两条一起消失**：冷却是**会自己回来**的状态，拿它当"缺口"
 * 去铸新号，铸出来的账号却**不会**自己走——一次瞬时故障换来一份永久成本。
 * 只有 `evicted` 才意味着「这把死了，去换一把」，而补池是全仓唯一真的会去换 key 的代码。
 *
 * **代价，明写**：整池都在冷却时补池**不会**去铸替补，网关在冷却窗口内持续 503
 *（最长一个 `COOLDOWN_PAYMENT_MS` / `COOLDOWN_STRIKE_MS`）。这是刻意的取舍——
 * 那种情况下上游要么在限流、要么在故障，铸新号打的是同一个后端，只会同时撞注册风控
 * 与邮箱建号限流，而冷却到期本来就会自己恢复。运维想立刻加人手有两条路：
 * 面板上「清冷却」，或者「立即补池」（它同样受这条判据约束，所以真正的手段是前者）。
 *
 * ⚠️ **`now` 参数是后来去掉的，那不是清理，是判据本身的变化**：这个函数
 * 现在**与时间无关**，「冷却算不算名额」不再是一个可以被时钟影响的问题。
 * 加回一个时间参数就是在把上面两条缺陷的入口重新打开。
 */
export function countsTowardTarget(r: KeyRecord): boolean {
  return !r.evicted;
}

export function selectKey(
  records: KeyRecord[],
  cursor: number,
  now: number,
): { record: KeyRecord; nextCursor: number } | null {
  if (records.length === 0) return null;
  const start = ((cursor % records.length) + records.length) % records.length;
  for (let i = 0; i < records.length; i++) {
    const idx = (start + i) % records.length;
    const r = records[idx]!;
    if (isAvailable(r, now)) return { record: r, nextCursor: idx + 1 };
  }
  return null;
}

export function applySuccess(r: KeyRecord, now: number): KeyRecord {
  return { ...r, strikes: 0, lastUsedAt: now, cooldownReason: null };
}

export function applyCooldown(r: KeyRecord, now: number, ms: number, reason: string): KeyRecord {
  return { ...r, cooldownUntil: now + ms, cooldownReason: reason };
}

/**
 * 累计一次瞬时故障（上游 5xx / 超时 / 网络错误）。
 *
 * 达到 `maxStrikes` 时**不是**永久剔除，而是进入 `cooldownStrikeMs` 的长冷却，
 * 到期自动恢复（设计 §7.2.1）。原实现在这里直接置 `evicted`，后果是上游一次
 * 抖动就能永久摧毁整个 key 池：三把 key 的池子在上游持续 503 时只需五个请求
 * 即全部报废，而当时没有任何 un-evict 路径，上游恢复后网关也永远起不来。
 * 上游故障是暂时的，不该造成不可逆的池子损毁。
 *
 * strikes 在**进入**冷却时即清零，而不是等冷却到期再清：冷却期内这把 key 根本
 * 不会被 selectKey 选中，两种写法对外行为完全一致，但前者不需要额外的惰性归一
 * 化步骤。永久剔除只保留给凭据失效（401/403，见 applyEvict）。
 */
export function applyStrike(
  r: KeyRecord,
  now: number,
  cfg: { maxStrikes: number; cooldownStrikeMs: number },
  reason: string,
): KeyRecord {
  const strikes = r.strikes + 1;
  return strikes >= cfg.maxStrikes
    ? { ...r, strikes: 0, cooldownUntil: now + cfg.cooldownStrikeMs, cooldownReason: reason }
    : { ...r, strikes };
}

/** 永久剔除。只用于 401/403——凭据失效是确定性的，重试无意义。 */
export function applyEvict(r: KeyRecord, reason: string): KeyRecord {
  return { ...r, evicted: true, evictedReason: reason };
}

/**
 * 四格计数。**判定顺序即优先级，且与 `keyBucket` 逐档同序**
 * （`disabled > evicted > cooling > fresh`，设计文档 §10.2）——两处不同序就会出现
 * 「概览卡说 3 把冷却中、Key 池列表一把冷却中的都没有」这种自相矛盾。
 *
 * **被停用的 key 既不算 `fresh` 也不算 `evicted`**（设计文档 §6.2 逐字）：算进
 * `fresh` 会让 `unavailable()` 以为池子还有得用、退回 `upstream_error`；算进
 * `evicted` 会让 503 告诉运维「去换 key」，而其实是他自己在面板上关的。
 *
 * 四格互斥且穷尽 ⇒ `total === fresh + cooling + evicted + disabled` 恒成立。
 */
export function poolHealth(records: KeyRecord[], now: number) {
  let fresh = 0, cooling = 0, evicted = 0, disabled = 0;
  for (const r of records) {
    if (isDisabled(r)) disabled++;
    else if (r.evicted) evicted++;
    else if (r.cooldownUntil > now) cooling++;
    else fresh++;
  }
  return { total: records.length, fresh, cooling, evicted, disabled };
}
