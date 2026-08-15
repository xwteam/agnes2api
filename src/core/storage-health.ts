import type { Storage } from "../ports/storage.js";

/**
 * 存储可写性的健康状态。
 *
 * 存在的理由（真机验证暴露）：Docker 部署用 `./data:/app/data` 绑定挂载时，宿主目录的
 * 属主（通常 uid 1000）会盖过镜像里 `chown app:app` 的结果，容器内的 app 用户（uid 100）
 * 因此写不进去。此时 `/health` 仍然返回 200——它压根不碰存储——容器被报告为 healthy，
 * 而所有 API 调用都返回 `pool_empty`、导入 key 报 EACCES。这是「CI 绿 + 镜像绿 ≠ 能跑」
 * 里最坏的一类：**静默失败**。健康检查必须能反映存储是否真的可写。
 *
 * 实现上刻意**不在健康检查里写盘**：状态由两处更新——
 *   ① 启动时的一次性探测（见 `probeWritable`，只在 Node/Docker 形态执行）；
 *   ② 运行期每一次**真实**的写操作（见 `watchStorage`），零额外 I/O。
 * 于是 `/health` 只是读一个内存里的布尔值，30 秒一次的 HEALTHCHECK 不会产生任何写入。
 */
export interface StorageStatus {
  writable: boolean;
  /** 最近一次真实写操作（含启动探测）发生的时刻；从未发生过则为 null。 */
  checkedAt: number | null;
}

export interface StorageHealth {
  record(ok: boolean, at: number): void;
  status(): StorageStatus;
}

/**
 * 初始状态取「可写」这一乐观值，因为它表示的是「尚未观测到任何写失败」。
 *
 * Node/Docker 形态启动时会立刻探测一次，乐观初值存在的时间不超过几毫秒；Worker/KV
 * 形态没有绑定挂载这一类失败模式（也不该为了健康检查而每次冷启动都消耗一次 KV 写配额），
 * 由运行期的真实写操作来修正它。
 */
export function createStorageHealth(): StorageHealth {
  let status: StorageStatus = { writable: true, checkedAt: null };
  return {
    record(ok, at) {
      status = { writable: ok, checkedAt: at };
    },
    status: () => status,
  };
}

/**
 * 把一个 Storage 包一层，让它的每次写结果都喂给 StorageHealth。
 *
 * 只观测 `put`/`delete`：读操作（`get`/`list`）在数据目录只读时照样成功，用它们判断
 * 可写性会得出「健康」的错误结论——真机上正是读得到、写不进。
 * 异常一律原样抛出，不吞：调用方的错误处理路径完全不变。
 */
export function watchStorage(inner: Storage, health: StorageHealth, now: () => number): Storage {
  return new WatchedStorage(inner, health, now);
}

class WatchedStorage implements Storage {
  constructor(
    private readonly inner: Storage,
    private readonly health: StorageHealth,
    private readonly now: () => number,
  ) {}

  get<T>(key: string): Promise<T | null> {
    return this.inner.get<T>(key);
  }

  list(prefix: string): Promise<string[]> {
    return this.inner.list(prefix);
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.track(() => this.inner.put(key, value));
  }

  async delete(key: string): Promise<void> {
    await this.track(() => this.inner.delete(key));
  }

  private async track(op: () => Promise<void>): Promise<void> {
    try {
      await op();
    } catch (err) {
      this.health.record(false, this.now());
      throw err;
    }
    this.health.record(true, this.now());
  }
}

/**
 * 探针键。写一次再删掉，不在存储里留下痕迹；与 key 池的 `key:` 前缀不冲突，
 * 因此即使删除那一步失败，也不会被 `KeyPoolRepo.all()` 当成一把 key。
 */
const PROBE_KEY = "health:probe";

/**
 * 启动时探一次「存储是不是真的可写」，返回失败原因（成功则返回 null）。
 *
 * 传进来的 storage 应当是 `watchStorage` 包过的那一层，探测结果会自动记进 StorageHealth。
 * 探测失败**不阻止进程启动**：让容器起来并把 `/health` 报成不健康，比崩溃重启循环更容易
 * 排障——运维能直接 curl 到原因，也仍然会在 `docker ps` 里看到 unhealthy。
 */
export async function probeWritable(storage: Storage): Promise<Error | null> {
  try {
    await storage.put(PROBE_KEY, { at: Date.now() });
    await storage.delete(PROBE_KEY);
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}
