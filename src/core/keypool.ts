import type { KeyRecord } from "./types.js";

export function isAvailable(r: KeyRecord, now: number): boolean {
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

export function poolHealth(records: KeyRecord[], now: number) {
  let fresh = 0, cooling = 0, evicted = 0;
  for (const r of records) {
    if (r.evicted) evicted++;
    else if (r.cooldownUntil > now) cooling++;
    else fresh++;
  }
  return { total: records.length, fresh, cooling, evicted };
}
