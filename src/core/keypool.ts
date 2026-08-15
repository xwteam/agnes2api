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
  return { ...r, strikes: 0, lastUsedAt: now };
}

export function applyCooldown(r: KeyRecord, now: number, ms: number): KeyRecord {
  return { ...r, cooldownUntil: now + ms };
}

export function applyStrike(r: KeyRecord, maxStrikes: number, reason: string): KeyRecord {
  const strikes = r.strikes + 1;
  return strikes >= maxStrikes
    ? { ...r, strikes, evicted: true, evictedReason: reason }
    : { ...r, strikes };
}

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
