/**
 * Tier-1 用量埋点。**近似值**，两条误差都写在面板的 `≈` 提示里：
 * 并发请求下会少计（KV 没有 CAS），且计数最多晚一个 `POOL_TOUCH_INTERVAL_MS` 落盘。
 */
export interface KeyStats {
  /** 终态归因到这把 key 的请求总数。**不变式：requests === success + failed + clientErrors。** */
  requests: number;
  /** 上游 2xx。 */
  success: number;
  /** 归因到**这把 key** 的失败：超时 / 5xx / 非 JSON 响应体 / 凭据失效 / 限流。 */
  failed: number;
  /** 上游 4xx 直通。**客户端的错，不是这把 key 的错**，所以单列，不并进 failed。 */
  clientErrors: number;
  lastErrorAt: number | null;
  lastErrorKind: string | null;
}

export interface KeyRecord {
  id: string;
  key: string;
  addedAt: number;
  lastUsedAt: number | null;
  cooldownUntil: number;
  /** 当前这段冷却是因何而起（限流 / 欠费 / 瞬时故障累计）。仅供排障，不参与调度。 */
  cooldownReason: string | null;
  strikes: number;
  evicted: boolean;
  evictedReason: string | null;
  /** Tier-1 用量埋点。**可选**：存量记录没有它，读取处统一走 normalizeStats 补默认值。 */
  stats?: KeyStats;
}
