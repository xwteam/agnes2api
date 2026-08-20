export interface Storage {
  get<T>(key: string): Promise<T | null>;
  /**
   * `expiresAt`：可选的**绝对**过期时刻（epoch ms，与本仓其余处 `now()` 同一个
   * 时钟基准——不是相对时长）。不传 = 永不过期（原有行为不变）。
   *
   * 评审 C5 追加：有界性必须是「存储自己的性质」，不能靠调用方按某种节奏顺手
   * delete 一个算出来的键——那种方案的有界性依赖"落盘节奏恰好规律"这个前提，
   * 稀疏落盘（gap 超过保留期）或多 isolate 各写各的随机分片时前提不成立，
   * 清理率会跌到 0（`src/adapters/logger-store.ts` 的说明，以及
   * `tests/unit/admin/event-ring.test.ts` 的
   * 「eventExpiresAt：TTL 精确到手算字面量」与 `tests/contract/storage.test.ts` 的
   * 「expiresAt 早于当下：put 完立刻就读不到了」两组回归用例）。
   *
   * ⚠️ **上面这两个锚是 P3c Task 1 评审 I7 改过的，旧的那两个是坏锚**：
   * 原本写的是 `「eventExpiresAt」`/`「expiresAt」`——**光秃秃的标识符**。
   * 名字锚的判据是「这段文字在那个文件里出现过」（整文件压平后子串匹配），
   * 而这两个标识符在各自文件里各出现十来次，**把目标用例整个改名、甚至删掉，
   * 门禁照样绿**（评审实测：改掉唯一含 `eventExpiresAt` 的 `describe` 标题之后
   * 仍有 8 处同名标识符命中 ⇒ `EXIT=0`）。
   * **那是"形状断言冒充行为断言"，而且出现在专治这件事的那道门禁的锚上。**
   * ⇒ **名字锚必须取完整用例名的片段，不能取标识符。**传了 `expiresAt` 的键，实现必须保证过期之后
   * `get`/`list` 都不再能看到它；KV 用原生 `expiration`（零操作开销，不占任何
   * 配额桶）；FileStorage 记一张「key → 过期时刻」的表，读时跳过、写时顺手清掉。
   */
  put<T>(key: string, value: T, expiresAt?: number): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
