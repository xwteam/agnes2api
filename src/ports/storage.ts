export interface Storage {
  get<T>(key: string): Promise<T | null>;
  /**
   * `expiresAt`：可选的**绝对**过期时刻（epoch ms，与本仓其余处 `now()` 同一个
   * 时钟基准——不是相对时长）。不传 = 永不过期（原有行为不变）。
   *
   * 评审 C5 追加：有界性必须是「存储自己的性质」，不能靠调用方按某种节奏顺手
   * delete 一个算出来的键——那种方案的有界性依赖"落盘节奏恰好规律"这个前提，
   * 稀疏落盘（gap 超过保留期）或多 isolate 各写各的随机分片时前提不成立，
   * 清理率会跌到 0（`src/adapters/logger-store.ts` 的说明与
   * `tests/unit/admin/event-ring.test.ts`/`tests/contract/storage.test.ts` 的
   * 回归用例记录了具体数字）。传了 `expiresAt` 的键，实现必须保证过期之后
   * `get`/`list` 都不再能看到它；KV 用原生 `expiration`（零操作开销，不占任何
   * 配额桶）；FileStorage 记一张「key → 过期时刻」的表，读时跳过、写时顺手清掉。
   */
  put<T>(key: string, value: T, expiresAt?: number): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
