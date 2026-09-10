/**
 * 键值存储端口。
 *
 * ⚠️ **它原来的理由是「KV 与文件存储两种后端」，那个理由在 v0.4.0 没了**
 *（Worker/KV 形态整体摘除，生产实现只剩 `src/adapters/storage-file.ts` 一个）。
 * **仍然留着它，理由换成今天成立的那一条**：这层端口是**测试注入的接缝**。
 * 本仓有一大批不变量（记账失败不影响响应、overview 逐块降级、事件落库、
 * 池索引损坏自愈、写次数配额包线）只有在「存储会在指定时机抛错 / 会数每一次 put」
 * 时才可观测，靠的就是 `tests/helpers/fake-storage.ts` 的 `MemoryStorage` 与
 * `tests/helpers/counting-storage.ts` 从这个接口那里换掉真实现。
 * 去掉端口、让各层直接 `new FileStorage(dir)`，那批用例只能改成照抄一遍装配去验证，
 * 而那验证的永远是抄件不是原件——本仓已经实测踩过这个陷阱。
 */
/**
 * 🔴🔴 **v0.4.0 全仓性登记：「配额账」那一整套数字失去了它的分母。**
 * **本仓凡是提到「每天 N 次读/写配额」「占配额的百分之几」的注释，一律回来读这一段。**
 *
 * 那笔账的分母是 **Cloudflare KV 免费档的四个每日配额桶**（读 100,000、写 1,000、
 * 删 1,000、list 1,000）。Worker/KV 形态整体摘除之后**那四个桶一个都不存在了**，
 * 于是下面这些东西全部悬空：
 * · `src/core/keypool-repo.ts` 的 `cacheTtlMs` / `touchIntervalMs` / `INDEX_READ_BACKOFF`
 *   那三段算式（「3 个活跃副本用掉 99.36%」这类）；
 * · `src/core/admin/event-ring.ts` 的 `EVENT_WRITES_PER_DAY = 12`（9.6% 的写配额）；
 * · `src/core/admin/usage-stats.ts` 的 `USAGE_WRITES_PER_DAY = 13` 与那 60 次读扇出；
 * · `src/core/admin/tend-guard.ts` 的 `MANUAL_TENDS_PER_DAY = 24`；
 * · `src/http/apikey-holder.ts` / `src/http/config-holder.ts` 的 TTL 取值；
 * · 五语言 DEPLOY.md 的「配额账」整节。
 *
 * **这次没有重算它们，也没有删它们，两条理由都写清楚：**
 * ① **每一个数今天都仍然在管一件真事**——`FileStorage` 的每一次 `put` 都**重写整个
 *    `store.json`**，每一次 `list`/`get` 都是**整份文件的 `readFile` + `JSON.parse`**。
 *    把它们放宽是一次真实的性能与磁盘写放大退让，不是「反正没配额了」。
 * ② **重算需要先定一个新的分母**（磁盘写放大与反序列化开销能接受到什么程度），
 *    那是一次独立的性能取舍，不是「摘掉一个形态」的顺带产物。
 * ⇒ **今天的实话是：这些数偏保守，而且没有人重新推导过它们。**
 * 读到任何一段带百分比的旧算式时，请把它读成「当年那个分母下的取值」，
 * 不要把那个百分比当成今天的事实。
 */
export interface Storage {
  get<T>(key: string): Promise<T | null>;
  /**
   * `expiresAt`：可选的**绝对**过期时刻（epoch ms，与本仓其余处 `now()` 同一个
   * 时钟基准——不是相对时长）。不传 = 永不过期（原有行为不变）。
   *
   * 评审裁定追加：有界性必须是「存储自己的性质」，不能靠调用方按某种节奏顺手
   * delete 一个算出来的键——那种方案的有界性依赖"落盘节奏恰好规律"这个前提，
   * 稀疏落盘（gap 超过保留期）时前提不成立，
   * 清理率会跌到 0（`src/adapters/logger-store.ts` 的说明，以及
   * `tests/unit/admin/event-ring.test.ts` 的
   * 「eventExpiresAt：TTL 精确到手算字面量」与 `tests/contract/storage.test.ts` 的
   * 「expiresAt 早于当下：put 完立刻就读不到了」两组回归用例）。
   *
   * ⚠️ **上面这两个锚是评审改过的，旧的那两个是坏锚**：
   * 原本写的是 `「eventExpiresAt」`/`「expiresAt」`——**光秃秃的标识符**。
   * 名字锚的判据是「这段文字在那个文件里出现过」（整文件压平后子串匹配），
   * 而这两个标识符在各自文件里各出现十来次，**把目标用例整个改名、甚至删掉，
   * 门禁照样绿**（评审实测：改掉唯一含 `eventExpiresAt` 的 `describe` 标题之后
   * 仍有 8 处同名标识符命中 ⇒ `EXIT=0`）。
   * **那是"形状断言冒充行为断言"，而且出现在专治这件事的那道门禁的锚上。**
   * ⇒ **名字锚必须取完整用例名的片段，不能取标识符。**传了 `expiresAt` 的键，实现必须保证过期之后
   * `get`/`list` 都不再能看到它；FileStorage 记一张「key → 过期时刻」的表，
   * 读时跳过、写时顺手清掉。
   */
  put<T>(key: string, value: T, expiresAt?: number): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
