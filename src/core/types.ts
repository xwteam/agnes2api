export interface KeyRecord {
  id: string;
  key: string;
  addedAt: number;
  lastUsedAt: number | null;
  cooldownUntil: number;
  strikes: number;
  evicted: boolean;
  evictedReason: string | null;
}
