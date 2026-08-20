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
 *
 * 形参是 `unknown` **不是** `KeyStats | undefined`：真实输入来自 `JSON.parse`
 * （`storage.get` 的返回值），运行期什么形状都可能是。写成 `KeyStats | undefined`
 * 就是在签名上撒谎——证据是测试当时必须靠 `as unknown as KeyStats` 强转才写得出
 * 「存储被写坏」那几格，而**需要强转才能表达的输入，正说明签名把它排除在外了**。
 */
export function normalizeStats(raw: unknown): KeyStats {
  if (!raw || typeof raw !== "object") return { ...EMPTY_STATS };
  const r = raw as Partial<Record<keyof KeyStats, unknown>>;
  const at = typeof r.lastErrorAt === "number" && Number.isFinite(r.lastErrorAt) ? r.lastErrorAt : null;
  return {
    requests: n(r.requests), success: n(r.success),
    failed: n(r.failed), clientErrors: n(r.clientErrors),
    lastErrorAt: at,
    lastErrorKind: typeof r.lastErrorKind === "string" ? r.lastErrorKind : null,
  };
}

/**
 * 逐字段取较大者。**计数只会涨，所以「取大」等价于「绝不回退」。**
 *
 * 它是 `KeyPoolRepo` 那份落盘基线（`pendingStats[].base`）唯一的更新方式，
 * 存在的理由是 C2 那条缺陷的两半：
 * · 调用方（`dispatch` 的 `commit`）把**未合并的 next** 写回 `records[at]`，
 *   于是它下一次交上来的 `prev` 比存储**旧**——直接采信就会把已落盘的计数往回写；
 * · 而快照过了 TTL 之后又可能带回**别的 isolate 写得更高**的值，那时该采信它。
 * 一个 `max` 同时处理这两个方向，且不需要知道是哪一种。
 *
 * ⚠️ **它对 `lastErrorKind` 不可交换，这是有意的、写下来免得后人以为它是对称的**：
 * 判据是 `b.lastErrorAt > a.lastErrorAt`（严格大于），所以两条错误**同毫秒**时保留
 * `a` 的那条 kind，`maxStats(x, y)` 与 `maxStats(y, x)` 会给出不同的 kind。
 * 计数那四项是真正的 max（可交换），只有这一项不是。
 * 取严格大于是因为「同毫秒」下没有任何依据判定谁更新，而稳定地保留左侧（= 已有基线）
 * 比让顺序决定结果更可预期。这条不对称由 `tests/unit/admin/stats.test.ts`
 * 的「同毫秒时保留左侧」钉着。
 */
export function maxStats(a: KeyStats, b: KeyStats): KeyStats {
  const newer = b.lastErrorAt !== null && (a.lastErrorAt === null || b.lastErrorAt > a.lastErrorAt);
  return {
    requests: Math.max(a.requests, b.requests),
    success: Math.max(a.success, b.success),
    failed: Math.max(a.failed, b.failed),
    clientErrors: Math.max(a.clientErrors, b.clientErrors),
    lastErrorAt: newer ? b.lastErrorAt : a.lastErrorAt,
    lastErrorKind: newer ? b.lastErrorKind : a.lastErrorKind,
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
