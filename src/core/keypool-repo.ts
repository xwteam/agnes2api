import type { Storage } from "../ports/storage.js";
import type { Logger } from "../ports/logger.js";
import type { KeyRecord } from "./types.js";
import {
  KEY_PREFIX, POOL_INDEX_KEY,
  makePoolIndex, parsePoolIndex, idsFromKeyNames, sameIdSet,
} from "./pool-index.js";

/**
 * key 的 id = SHA-256 的前 8 字节。
 *
 * 全局 `crypto.subtle` 是**既定豁免**（硬约束 2）：WebCrypto 在 Cloudflare Workers
 * 与 Node 都是标准全局 API，不属于「环境能力注入」的范畴——注入它只会多一个端口、
 * 多一份假实现，换不到任何可测性。
 */
export async function keyId(key: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface KeyPoolRepoOptions {
  /**
   * 注入的时钟。`add()` 用它填 `addedAt`（原来是裸 `Date.now()`）。
   * Task 4 的快照缓存 TTL 与写消除的触达间隔也用同一个——**三处必须共用一个时间源**，
   * 否则测试里给了假时钟而缓存用真时钟，就是这个项目最容易出的那类假阳性。
   */
  now: () => number;
  logger: Logger;
}

export interface ReconcileResult {
  indexed: number;
  actual: number;
  repaired: boolean;
  added: string[];
  removed: string[];
}

/**
 * key 池仓储。
 *
 * **一条原则贯穿全文件：记录（`key:<id>`）是真源，索引（`pool:index`）是派生缓存。**
 * 两条写序都从这一句推出来：
 *   - `add`：① 写记录 → ② 进索引。中途失败留下**孤儿记录**（不被使用）。
 *   - `delete`：① 删记录 → ② 出索引。中途失败留下**幽灵索引项**（读到 null 被 filter 掉）。
 * 两种残留都是 fail-safe，且都由 `reconcileIndex()` 以 `list()` 为准修回来。
 *
 * **两条写序反过来各有各的坏处，且性质不同：**
 *   - `delete` 若先出索引再删记录，中途失败留下的是孤儿记录，而对账以 `list()` 为准
 *     会把它**加回索引**——等于把一次删除悄悄撤销了。这是正确性问题。
 *   - `add` 若先进索引再写记录，中途失败时 key 材料压根没落盘，而调用方（注册机）
 *     此刻已经在 Agnes 侧真实建号并领到了 token——**丢了就再也找不回来，对账也修不了，
 *     因为对账只认存储里已有的记录**。这是数据丢失问题。
 * 两条都有测试守着（tests/unit/keypool-repo.test.ts 里的「先写记录」「先删记录」两条）。
 */
export class KeyPoolRepo {
  constructor(
    private readonly storage: Storage,
    private readonly o: KeyPoolRepoOptions,
  ) {}

  async all(): Promise<KeyRecord[]> {
    const ids = await this.readIndexIds();
    const rs = await Promise.all(ids.map((id) => this.storage.get<KeyRecord>(KEY_PREFIX + id)));
    // 幽灵索引项在这里被丢掉。**刻意不顺手把它从索引里剪掉**：`add` 的写序天然存在
    // 「索引已更新、记录尚未可见」的窗口（KV 是最终一致的），在读路径剪枝会把一把刚
    // 铸出来的新 key 从池子里悄悄抹掉。剪枝一律交给 reconcileIndex()。
    return rs.filter((r): r is KeyRecord => r !== null);
  }

  async get(id: string): Promise<KeyRecord | null> {
    return await this.storage.get<KeyRecord>(KEY_PREFIX + id);
  }

  async save(r: KeyRecord): Promise<void> {
    await this.storage.put(KEY_PREFIX + r.id, r);
  }

  async add(key: string): Promise<KeyRecord> {
    const r: KeyRecord = {
      id: await keyId(key), key, addedAt: this.o.now(), lastUsedAt: null,
      cooldownUntil: 0, cooldownReason: null, strikes: 0, evicted: false, evictedReason: null,
    };
    await this.save(r);          // ① 记录先写
    await this.indexAdd(r.id);   // ② 再进索引
    return r;
  }

  async delete(id: string): Promise<void> {
    await this.storage.delete(KEY_PREFIX + id);   // ① 记录先删
    await this.indexRemove(id);                   // ② 再出索引
  }

  /**
   * 索引与实际记录对账，**以 `list()` 的结果为准**。
   *
   * 这是全系统除「索引缺失回落」之外唯一用 `list()` 的地方，且不在热路径上：
   * 两个入口的补池调度各在开头调一次（Worker Cron 每 30 分钟 ⇒ 48 次/天，
   * 占免费档 list 配额的 4.8%）。
   */
  async reconcileIndex(): Promise<ReconcileResult> {
    const actual = idsFromKeyNames(await this.storage.list(KEY_PREFIX));
    const cur = parsePoolIndex(await this.storage.get<unknown>(POOL_INDEX_KEY));
    const indexed = cur?.ids ?? [];
    const added = actual.filter((x) => !indexed.includes(x));
    const removed = indexed.filter((x) => !actual.includes(x));
    const repaired = cur === null || !sameIdSet(indexed, actual);

    if (repaired) {
      await this.storage.put(POOL_INDEX_KEY, makePoolIndex(actual));
      this.o.logger.log({
        level: cur === null ? "info" : "warn",
        event: cur === null ? "pool.index_bootstrapped" : "pool.index_repaired",
        msg: cur === null
          ? "key 池索引缺失，已按实际记录建立"
          : "key 池索引与实际记录不一致，已按实际记录修复",
        fields: { indexed: indexed.length, actual: actual.length, added: added.length, removed: removed.length },
      });
    }
    return { indexed: indexed.length, actual: actual.length, repaired, added, removed };
  }

  /**
   * 读索引。读不到合法索引就回落 `list()` 并重建——**这是热路径上唯一可能出现
   * `list()` 的地方，且只在索引缺失/结构不认识时走一次**。
   */
  private async readIndexIds(): Promise<string[]> {
    const idx = parsePoolIndex(await this.storage.get<unknown>(POOL_INDEX_KEY));
    if (idx !== null) return idx.ids;

    const ids = idsFromKeyNames(await this.storage.list(KEY_PREFIX));
    // **尽力而为**：存储只读时，原来的 all() 是能工作的，不能因为写索引失败就把
    // 读路径也弄挂。写不进去的后果只是下次还要再 list 一遍。
    try {
      await this.storage.put(POOL_INDEX_KEY, makePoolIndex(ids));
      this.o.logger.log({
        level: "info", event: "pool.index_bootstrapped",
        msg: "key 池索引缺失，已按 list 结果重建", fields: { ids: ids.length },
      });
    } catch (err) {
      this.o.logger.log({
        level: "warn", event: "pool.index_write_failed",
        msg: "重建 key 池索引时写入失败，本次仍按 list 结果工作",
        fields: { err: err instanceof Error ? err.message : String(err) },
      });
    }
    return ids;
  }

  private async indexAdd(id: string): Promise<void> {
    const ids = await this.readIndexIds();
    if (ids.includes(id)) return;   // 已在索引里：不写，省一次 put
    await this.storage.put(POOL_INDEX_KEY, makePoolIndex([...ids, id]));
  }

  private async indexRemove(id: string): Promise<void> {
    const cur = parsePoolIndex(await this.storage.get<unknown>(POOL_INDEX_KEY));
    if (cur === null) return;       // 没索引就没什么可摘的，对账会建
    if (!cur.ids.includes(id)) return;
    await this.storage.put(POOL_INDEX_KEY, makePoolIndex(cur.ids.filter((x) => x !== id)));
  }
}
