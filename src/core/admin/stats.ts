import type { KeyRecord, KeyStats } from "../types.js";

export const EMPTY_STATS: KeyStats = Object.freeze({
  requests: 0, success: 0, failed: 0, clientErrors: 0, lastErrorAt: null, lastErrorKind: null,
});

export interface StatsDelta {
  requests: number; success: number; failed: number; clientErrors: number;
  lastErrorAt: number | null; lastErrorKind: string | null;
}

export const ZERO_DELTA: StatsDelta = Object.freeze({
  requests: 0, success: 0, failed: 0, clientErrors: 0, lastErrorAt: null, lastErrorKind: null,
});

/** 这一笔增量什么都没带。**按值判，不按引用判**：`statsDelta` 每次都新建对象，
 * 拿 `d === ZERO_DELTA` 去判是一行永远为假的死代码。 */
export function isZeroDelta(d: StatsDelta): boolean {
  return d.requests === 0 && d.success === 0 && d.failed === 0
    && d.clientErrors === 0 && d.lastErrorAt === null;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);

/**
 * 存量记录没有 `stats`，存储也可能被写坏。**逐字段补零而不是整块丢弃**：
 * 整块丢弃会让一次坏写把已经攒了几天的计数清零，而面板上看不出发生过这件事。
 */
export function normalizeStats(raw: KeyStats | undefined): KeyStats {
  if (!raw || typeof raw !== "object") return { ...EMPTY_STATS };
  const at = typeof raw.lastErrorAt === "number" && Number.isFinite(raw.lastErrorAt) ? raw.lastErrorAt : null;
  return {
    requests: n(raw.requests), success: n(raw.success),
    failed: n(raw.failed), clientErrors: n(raw.clientErrors),
    lastErrorAt: at,
    lastErrorKind: typeof raw.lastErrorKind === "string" ? raw.lastErrorKind : null,
  };
}

/**
 * 记一次终态。**只碰 `stats`，一个调度字段都不动**——
 * 它要在 `applySuccess` / `applyStrike` / `applyEvict` 之后叠加，
 * 顺手改调度状态就会把两套语义混在一起，而调度那套是「丢一次就是事故」的。
 * （这一条由 tests/unit/admin/stats.test.ts 的「除 stats 之外一个字段都不动」钉住。）
 *
 * `clientError`（上游 4xx 直通）**不记 lastError**：那是客户端发错了请求，
 * 把它记成这把 key 的「最近错误」会让运维去查一把其实没问题的 key。
 */
export function withOutcome(
  rec: KeyRecord,
  outcome: "success" | "failed" | "clientError",
  now: number,
  errKind: string | null,
): KeyRecord {
  const s = normalizeStats(rec.stats);
  const next: KeyStats = {
    requests: s.requests + 1,
    success: s.success + (outcome === "success" ? 1 : 0),
    failed: s.failed + (outcome === "failed" ? 1 : 0),
    clientErrors: s.clientErrors + (outcome === "clientError" ? 1 : 0),
    lastErrorAt: outcome === "failed" ? now : s.lastErrorAt,
    lastErrorKind: outcome === "failed" ? errKind : s.lastErrorKind,
  };
  return { ...rec, stats: next };
}

/** 计数一律取**非负**差：快照比存储旧时算出负增量，合并回去就是把别人的计数抹掉。 */
export function statsDelta(prev: KeyStats | undefined, next: KeyStats | undefined): StatsDelta {
  const a = normalizeStats(prev);
  const b = normalizeStats(next);
  const newer = b.lastErrorAt !== null && (a.lastErrorAt === null || b.lastErrorAt > a.lastErrorAt);
  return {
    requests: Math.max(0, b.requests - a.requests),
    success: Math.max(0, b.success - a.success),
    failed: Math.max(0, b.failed - a.failed),
    clientErrors: Math.max(0, b.clientErrors - a.clientErrors),
    lastErrorAt: newer ? b.lastErrorAt : null,
    lastErrorKind: newer ? b.lastErrorKind : null,
  };
}

export function addDelta(a: StatsDelta, b: StatsDelta): StatsDelta {
  const newer = b.lastErrorAt !== null && (a.lastErrorAt === null || b.lastErrorAt > a.lastErrorAt);
  return {
    requests: a.requests + b.requests,
    success: a.success + b.success,
    failed: a.failed + b.failed,
    clientErrors: a.clientErrors + b.clientErrors,
    lastErrorAt: newer ? b.lastErrorAt : a.lastErrorAt,
    lastErrorKind: newer ? b.lastErrorKind : a.lastErrorKind,
  };
}

export function applyDelta(base: KeyStats | undefined, d: StatsDelta | undefined): KeyStats {
  const s = normalizeStats(base);
  if (!d) return s;
  const newer = d.lastErrorAt !== null && (s.lastErrorAt === null || d.lastErrorAt > s.lastErrorAt);
  return {
    requests: s.requests + d.requests,
    success: s.success + d.success,
    failed: s.failed + d.failed,
    clientErrors: s.clientErrors + d.clientErrors,
    lastErrorAt: newer ? d.lastErrorAt : s.lastErrorAt,
    lastErrorKind: newer ? d.lastErrorKind : s.lastErrorKind,
  };
}

export function sumStats(list: readonly (KeyStats | undefined)[]): KeyStats {
  let acc: KeyStats = { ...EMPTY_STATS };
  for (const s of list) acc = applyDelta(acc, statsDelta(EMPTY_STATS, s));
  return acc;
}
