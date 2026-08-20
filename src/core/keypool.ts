import type { KeyRecord } from "./types.js";

/**
 * 「这把 key 被管理员手工停用了吗」。**全仓唯一一份判据。**
 *
 * 三个读取处必须问同一个问题：调度（下面的 `isAvailable`）、分档
 * （`src/core/admin/key-view.ts` 的 `keyBucket`）、投影（同文件 `toKeyViews` 的 `disabled` 字段）。
 * 各写各的后果是「面板显示已停用、调度器照常用它」——本字段最难被发现的失败形态。
 *
 * ⚠️ **「三个」数的是问这个问题的地方，不是 `isAvailable` 的调用处——后者有四个。**
 * 这句话原来写成「三个读取处」就收尾了，而**第四个调用处 `tendOnce` 当时正被这次改动
 * 悄悄改掉语义**（评审 C1）。它刻意**不**问这个问题，理由见下面的 `countsTowardTarget`。
 * 加一个共享判据的新条件时，**该 grep 的是这个判据的名字，不是新字段的名字**——
 * 只 grep `\.disabled` 只能查出「谁读记录字段」，查不出「谁受这个判据影响」。
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
 * 两者曾经是同一个函数，而它们**只在被停用的 key 上分歧**，所以那次合并一直没出事。
 * `disabled` 落地的那一刻它就出事了（评审 C1，实测复现）：
 * `src/core/registrar/tender.ts` 的 `tendOnce` 拿 `targetKeys - available` 当缺口，
 * **差多少就真的去注册多少个 Agnes 账号**（建临时邮箱 → 注册 → 建 token）。
 * 让 `isAvailable` 顺手回答这个问题，等于**「在面板上停用一把 key」＝「自动注册一个新账号」**。
 *
 * **而且永不自愈**：`cooling` 会自己回来、下一轮 `need` 随之归零；`disabled` 不会——
 * 那把只要还停着，**每一轮 Cron 都把缺口重新填满**，每停用 1 把就永久多 1 个账号。
 * 运维最自然的批量操作（全停以暂停这个池子）会变成代价最高、且铸出来的账号收不回去的
 * 那一个，正是「邮箱配额自杀」那条链。
 *
 * 判据是 `!evicted && 不在冷却`，**刻意不读 `isDisabled`**：只有 `evicted` 才意味着
 * 「这把死了，去换一把」，而补池就是全仓唯一真的会去换 key 的代码——这与
 * `all_disabled` 不复用 `all_evicted` 是同一条理由，两处不一致的话本任务的立论自相矛盾。
 *
 * ⚠️ **对 `cooling` 的既有语义一个字都没改**：这个式子与 P3b 的 `isAvailable` 逐字相同
 * （由 `tests/unit/registrar/tender.test.ts「补池的名额判据与 P3b 的 isAvailable 逐字等价」`
 * 钉着，那一格穷举四种状态比对两个函数）。冷却相关的一条既有缺陷单独登记，不在本任务改。
 */
export function countsTowardTarget(r: KeyRecord, now: number): boolean {
  return !r.evicted && r.cooldownUntil <= now;
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
 * 即全部报废，而 P1 没有任何 un-evict 路径，上游恢复后网关也永远起不来。
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
