import type { Storage } from "../../src/ports/storage.js";

/**
 * `delayMs`：模拟"这次存储访问要花这么久才返回"。**照抄 `FakeFetcher` 的同一个理由**
 * （见该文件的说明）——瞬时返回的替身让任何 happens-before 性质都不可观测：
 * `await x()` 与 fire-and-forget 的 `x()` 在纯内存、零延迟的实现上找不出行为差异，
 * 因为两条路径的 Promise 链都在**同一个微任务 tick**内就有效地"追上"了调用方的
 * 下一个 `await`。这不是 storage 这一根轴专属的教训——`fake-fetcher.ts` 已经为
 * 同一个问题加过 `delayMs`（14 处在用）；这里补上是把同一条教训在第二根轴上落地，
 * 免得下一个人（第三根轴：mailbox provider、未来的 queue 端口……）还要重新踩一次、
 * 重新造一个自己的 `DelayedStorage`。
 *
 * **默认不传（`undefined`），不是 `0`**——两者行为不同，见下面构造函数的说明；
 * 这不是措辞问题，是本仓已经真实踩过的一次回归（评审查实）。
 */
export class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  /** 评审发现：`put(key, value, expiresAt)` 的过期时刻表，key → epoch ms。 */
  private readonly expiry = new Map<string, number>();

  /**
   * **不设默认值、不用 `= 0`**：`delayMs` 缺省时**完全跳过 `setTimeout`**，走原来
   * 那条纯同步 Map 操作包一层 `async` 的路径。这条区分不是风格偏好——本仓大量
   * 既有用例用 `vi.useFakeTimers()` 测超时/冷却（`dispatcher.test.ts` 等），假定时器
   * 接管之后**真实的 `setTimeout` 不会自己触发**，如果这里对 `delayMs=0` 也无条件
   * 调 `setTimeout(resolve, 0)`，那些用例里任何一次 `storage.get/put` 都会挂起到
   * 天荒地老（已实测：加上无条件 `setTimeout` 之后 `dispatcher.test.ts` 7 条超时
   * 用例全部 5 秒超时失败）。`FakeFetcher` 的 `delayMs` 正是同一条判据
   * （`if (o.delayMs !== undefined) await waitOrAbort(...)`），这里照抄。
   *
   * `now`：过期判定用的时钟，默认 `Date.now`。**评审发现**新增——需要在测试里
   * 模拟"时间流逝、key 过期"（例如 365 天后旧事件键该消失了）又不想真的等待时，
   * 传一个假时钟进来（`new MemoryStorage(undefined, () => t)`）。
   */
  constructor(
    private readonly delayMs?: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private isExpired(key: string): boolean {
    const exp = this.expiry.get(key);
    return exp !== undefined && exp <= this.now();
  }

  async get<T>(key: string): Promise<T | null> {
    if (this.delayMs !== undefined) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.isExpired(key)) return null;
    const raw = this.map.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  async put<T>(key: string, value: T, expiresAt?: number): Promise<void> {
    if (this.delayMs !== undefined) await new Promise((r) => setTimeout(r, this.delayMs));
    this.map.set(key, JSON.stringify(value));
    if (expiresAt !== undefined) this.expiry.set(key, expiresAt); else this.expiry.delete(key);
  }

  async delete(key: string): Promise<void> {
    if (this.delayMs !== undefined) await new Promise((r) => setTimeout(r, this.delayMs));
    this.map.delete(key);
    this.expiry.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    if (this.delayMs !== undefined) await new Promise((r) => setTimeout(r, this.delayMs));
    return [...this.map.keys()].filter((k) => k.startsWith(prefix) && !this.isExpired(k));
  }
}
