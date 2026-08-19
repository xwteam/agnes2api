import type { Storage } from "../ports/storage.js";
import type { Logger } from "../ports/logger.js";
import type { KeyRecord } from "./types.js";
import {
  KEY_PREFIX, POOL_INDEX_KEY,
  makePoolIndex, parsePoolIndex, idsFromKeyNames, sameIdSet,
  type PoolIndex,
} from "./pool-index.js";

/**
 * 索引重建写失败之后的静默窗口。
 *
 * 存储只读（Docker 绑定挂载属主不匹配）或写配额耗尽时，索引一次都写不进去，
 * 而重建走的是读路径 ⇒ **每个转发请求都会多一次注定失败的 `put` 加一条 warn**。
 * put 失败也照样计入 KV 的写配额，等于用配额去买日志噪音。记住上次失败的时刻，
 * 窗口内只跳过「写」这一步，`list` 回落照常，读路径的行为完全不变。
 */
export const INDEX_WRITE_RETRY_MS = 60_000;

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
  /** 见 INDEX_WRITE_RETRY_MS。null 表示「上一次索引写是成功的」。 */
  private indexWriteFailedAt: number | null = null;

  constructor(
    private readonly storage: Storage,
    private readonly o: KeyPoolRepoOptions,
  ) {}

  async all(): Promise<KeyRecord[]> {
    const idx = await this.readIndex();
    // 索引缺失那条路径刚刚已经 list 过一次，下面的空结果兜底不必再来一次。
    const indexed = idx !== null ? idx.ids : await this.bootstrapFromList();
    const alive = await this.loadRecords(indexed);
    if (alive.length > 0 || idx === null) return alive;
    return await this.rescanEmptyResult(indexed);
  }

  /**
   * 索引解析成功、却一条活记录都没读到时，回落一次 `list()` 兜底。
   *
   * **不加这一步会出人命的场景**（评审实测，真 KV 复现）：全新部署的 Worker 上
   * cron 先在空 KV 上跑了一次对账，写下**权威的空索引** `{"v":1,"ids":[]}`；用户
   * 随后按 DEPLOY.md 手工 `wrangler kv key put` 导入 key——而 P3a 还没有面板、
   * 注册机默认关闭，手工导入就是 Worker 用户装 key 的唯一路径。此时索引「合法」，
   * 永远不会走缺失回落，`all()` 恒返回 0 条，网关一直 503 pool_empty。
   * 改造前 `all()` 直接 `list("key:")`，导入即刻生效——这是本次改造引入的回退。
   *
   * 代价可控：正常非空池一步都不会走到这里（`alive.length > 0` 就返回了）；
   * 池子真空时本来每个请求都在返 503，这次 `list` 不吃有效配额。
   *
   * **写回只增不减**：只把 `list` 发现而索引不知道的 id 补进去，绝不从索引里删。
   * 删（剪枝）一律交给 `reconcileIndex()`，理由见 all() 里那段注释。于是
   * 「整池都成了幽灵索引项」时这里不写、不剪，只是每个请求多一次 list，直到对账。
   */
  private async rescanEmptyResult(indexed: readonly string[]): Promise<KeyRecord[]> {
    const actual = idsFromKeyNames(await this.storage.list(KEY_PREFIX));
    const merged = [...new Set([...indexed, ...actual])];
    if (!sameIdSet(merged, indexed)) {
      await this.writeIndexBestEffort(
        merged, "pool.index_backfilled",
        "索引说池子是空的，但 list 找到了记录（多半是手工导入），已把它们补进索引",
      );
    }
    return await this.loadRecords(actual);
  }

  private async loadRecords(ids: readonly string[]): Promise<KeyRecord[]> {
    const rs = await Promise.all(ids.map((id) => this.storage.get<KeyRecord>(KEY_PREFIX + id)));
    // 幽灵索引项在这里被丢掉。**刻意不顺手把它从索引里剪掉**，硬理由是：
    // 剪枝要写索引，而那是**热路径上多出来的一次 `put`**——写配额恰恰是最紧的桶，
    // 这一下就把本模块存在的全部意义抵消掉了。
    // 次要理由：`add` 的写序天然存在「索引已更新、记录尚未可见」的窗口（KV 是最终
    // 一致的），在读路径剪枝会把一把刚铸出来的新 key 打成孤儿（仍是 fail-safe 态、
    // 对账捡得回来，但白白多绕一圈）。剪枝一律交给 reconcileIndex()。
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
    const cur = await this.readIndex();
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
   * 读索引。**读取本身抛错也一律当成「索引缺失」**，返回 null。
   *
   * 这一层 try/catch 不是防御性编程，是补一条真实的防线漏洞（评审用真 KV 实测）：
   * `parsePoolIndex` 的「结构脏 ⇒ 当作缺失 ⇒ 重建」架在 **JSON 之上**，而
   * `KvStorage.get(k, "json")` 遇到坏字节是**先抛**的，`parsePoolIndex` 根本没机会
   * 执行。后果是每个转发请求 500，**并且被指定为修复者的 `reconcileIndex()` 读同一个
   * 键同样抛**——两个入口的 try/catch 只吞掉记一条日志，于是它每 30 分钟徒劳地挂
   * 一次，永远修不好，只能人工删键。
   *
   * 抛了就当缺失 ⇒ 调用方回落 `list()` 并**顺手把坏值覆盖掉**，自愈。
   * 存储是真挂了（不止这一个键坏）的话，紧接着那次 `list()` 照样会抛，错误仍然
   * 如实浮到 500 上——这里放行的只有「索引这一个值坏了」这一种情形。
   */
  private async readIndex(): Promise<PoolIndex | null> {
    let raw: unknown;
    try {
      raw = await this.storage.get<unknown>(POOL_INDEX_KEY);
    } catch (err) {
      this.o.logger.log({
        level: "warn", event: "pool.index_unreadable",
        msg: "key 池索引读取失败（多半是存了非 JSON 字节），按索引缺失处理并重建",
        fields: { err: err instanceof Error ? err.message : String(err) },
      });
      return null;
    }
    return parsePoolIndex(raw);
  }

  /**
   * 索引缺失/不可读时的回落：`list()` 一次并尽力重建。
   * **这是热路径上唯一可能出现 `list()` 的地方之一**（另一处见 rescanEmptyResult）。
   */
  private async bootstrapFromList(): Promise<string[]> {
    const ids = idsFromKeyNames(await this.storage.list(KEY_PREFIX));
    await this.writeIndexBestEffort(
      ids, "pool.index_bootstrapped", "key 池索引缺失，已按 list 结果重建",
    );
    return ids;
  }

  /**
   * 写索引，**尽力而为**：存储只读时，原来的 all() 是能工作的，不能因为写索引失败
   * 就把读路径也弄挂。写不进去的后果只是下次还要再 list 一遍。
   * 连续失败时按 INDEX_WRITE_RETRY_MS 退避，避免每个请求都白扔一次 put。
   *
   * **成功之后刻意不把 `indexWriteFailedAt` 清回 null**：那行代码是死的，不是省略。
   * 证明——一次尝试能发生，前提就是 `at - failedAt >= RETRY`；时钟单调，之后的每次
   * 调用只会让 `at` 更大，因而同样不被抑制。清不清，结果一个字都不差。写一行永远
   * 改变不了行为的代码，等于给后人留一条不可证伪的注释。
   *
   * 时钟**不**单调那一种情形（NTP 回拨）确实观测得到，所以下面显式挡了 `since < 0`：
   * 回拨之后立刻恢复尝试，而不是被抑制到回拨量走完。
   */
  private async writeIndexBestEffort(
    ids: readonly string[], event: string, msg: string,
  ): Promise<void> {
    const at = this.o.now();
    if (this.indexWriteFailedAt !== null) {
      const since = at - this.indexWriteFailedAt;
      if (since >= 0 && since < INDEX_WRITE_RETRY_MS) return;
    }
    try {
      await this.storage.put(POOL_INDEX_KEY, makePoolIndex(ids));
      this.o.logger.log({ level: "info", event, msg, fields: { ids: ids.length } });
    } catch (err) {
      this.indexWriteFailedAt = at;
      this.o.logger.log({
        level: "warn", event: "pool.index_write_failed",
        msg: "重建 key 池索引时写入失败，本次仍按 list 结果工作",
        fields: { err: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private async indexAdd(id: string): Promise<void> {
    const idx = await this.readIndex();
    const ids = idx !== null ? idx.ids : await this.bootstrapFromList();
    if (ids.includes(id)) return;   // 已在索引里：不写，省一次 put
    // 这一次**必须**抛：调用方 add() 靠它把「索引没进去」如实告诉注册机。
    await this.storage.put(POOL_INDEX_KEY, makePoolIndex([...ids, id]));
  }

  private async indexRemove(id: string): Promise<void> {
    const cur = await this.readIndex();
    if (cur === null) return;       // 没索引/索引不可读就没什么可摘的，对账会建
    if (!cur.ids.includes(id)) return;
    await this.storage.put(POOL_INDEX_KEY, makePoolIndex(cur.ids.filter((x) => x !== id)));
  }
}
