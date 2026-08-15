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
}
