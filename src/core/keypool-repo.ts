import type { Storage } from "../ports/storage.js";
import type { Logger } from "../ports/logger.js";
import type { KeyRecord } from "./types.js";
import { Refreshable } from "./refreshable.js";
import {
  KEY_PREFIX, POOL_INDEX_KEY,
  makePoolIndex, parsePoolIndex, idsFromKeyNames, sameIdSet,
  type PoolIndex,
} from "./pool-index.js";

export const DEFAULT_POOL_CACHE_TTL_MS = 60_000;
export const DEFAULT_POOL_TOUCH_INTERVAL_MS = 21_600_000; // 6 小时

/**
 * `KeyRecord` 每个字段的角色。**这张表是写消除唯一的合法性依据，也是它唯一的钉子。**
 *
 * - `scheduling`：变化会改变「这把 key 还能不能用、什么时候能用」，**丢一次就是事故**
 *   （吃掉一次 strike ⇒ 坏 key 被无限重试，而且测试全绿——这是本模块最危险的失败形态）。
 * - `telemetry`：纯展示，任何调度逻辑都不读它，因此只有它变化的那次写可以整个丢弃。
 *
 * 类型写成 `Record<keyof KeyRecord, …>` 不是为了好看：**给 `KeyRecord` 加字段时
 * `tsc` 会在这里报错**，逼着加字段的人显式表态，而不是让新字段被 `schedulingEqual`
 * 默默忽略掉。`schedulingEqual` 直接从这张表推导，两者不可能漂移。
 *
 * `lastUsedAt` 判为 telemetry 的依据（每次改动都请重新核一遍，别信这行注释）：
 * 全仓只有 `applySuccess` 写它，`isAvailable` / `selectKey` / `applyStrike` /
 * `applyCooldown` / `applyEvict` / `poolHealth` 一个都不读。这条前提由
 * `tests/unit/pool-cache.test.ts` 的「调度完全不读 lastUsedAt」用例与那条源码扫描
 * 一起钉住——**将来谁拿 lastUsedAt 做 LRU 选 key，那两条会先变红**，而不是靠这段注释。
 */
export const FIELD_ROLE: Record<keyof KeyRecord, "scheduling" | "telemetry"> = {
  id: "scheduling",
  key: "scheduling",
  cooldownUntil: "scheduling",
  cooldownReason: "scheduling",
  strikes: "scheduling",
  evicted: "scheduling",
  evictedReason: "scheduling",
  /**
   * 建号时刻。**判 telemetry 的理由与 `lastUsedAt` 完全不同，别把两者并列理解**：
   * `lastUsedAt` 有 `touchIntervalMs` 兜底（最迟每 6 小时一定落一次盘），
   * `addedAt` **一条兜底都没有**——它变化的那次写会被无条件丢弃。
   * 之所以安全，是因为这条路径不可达：`addedAt` 只在 `add()` 里赋值一次，
   * 此后 `keypool.ts` 的 `apply*` 全部原样透传，全仓没有任何代码会产生一个
   * `addedAt` 不同的 next。**哪天有了「重置建号时刻」这种操作，它必须改成 scheduling。**
   */
  addedAt: "telemetry",
  /** 纯遥测，见上。有 touchIntervalMs 兜底，不会永远不落盘。 */
  lastUsedAt: "telemetry",
};

const SCHEDULING_FIELDS = (Object.keys(FIELD_ROLE) as Array<keyof KeyRecord>)
  .filter((k) => FIELD_ROLE[k] === "scheduling");

function schedulingEqual(a: KeyRecord, b: KeyRecord): boolean {
  return SCHEDULING_FIELDS.every((k) => a[k] === b[k]);
}

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
 * 空池态下两次 `list` 兜底之间的最小间隔。**这个数是拿 KV 的 list 配额倒推出来的，
 * 不是拍的。**
 *
 * `list` 是**独立于读配额的第四个桶**，免费档 1,000 次/天（§17 U1 已核实）。
 * 加这条退避之前，空池态每个快照 TTL 就烧一次 list ⇒ 默认 60 秒 TTL 下
 * 86400/60 = **1,440 次/天/isolate**，一个全新的、还没导 key 的部署光靠客户端
 * 的重试循环就能在几小时内把桶打穿；桶穿了之后用户这才导入 key，`list` 抛错、
 * `Refreshable` 吞掉只记一条 `pool.load_failed`、`current()` 继续沿用 `[]`，
 * 而被文档指定为修复者的 `reconcileIndex()` 读同一个桶**同样抛**——两条自愈路径
 * 一起死，当天剩余时间全部 503 且查不出原因。
 *
 * 取 10 分钟 ⇒ 86400/600 = **≤144 次/天/isolate**，与文档「配额账」那一节
 * 用的同一套 isolate 计数口径（3 个活跃 isolate ⇒ 432 次）叠上对账的 48~96 次
 * 仍有余量。
 *
 * **代价（写进五语言 DEPLOY.md，别只留在这里）**：池子为空时手工导入的 key
 * 不再是「下一个请求即生效」，而是最多等本值 + 一个 `POOL_CACHE_TTL_MS`。
 * 想立刻生效就同时更新 `pool:index`（文档给了命令）。
 */
export const EMPTY_POOL_RESCAN_MS = 600_000;

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
   * 快照缓存的 TTL 与写消除的触达间隔也用同一个——**三处必须共用一个时间源**，
   * 否则测试里给了假时钟而缓存用真时钟，就是这个项目最容易出的那类假阳性。
   */
  now: () => number;
  logger: Logger;
  /**
   * isolate 级快照缓存的存活时长。**0 = 关闭缓存**（每次 all() 都真读存储）。
   *
   * 它决定每天的 KV 读取次数，而读取次数与请求数**无关**：
   *
   *   读取次数/天 = 活跃 isolate 数 × [ (86400 / 本值秒数) × (1 + 池中 key 数)
   *                                  + 86400 / CONFIG_TTL_MS 秒数 ]
   *                + 对账（每天 48~96）
   *
   * **中括号里第二项是 `ConfigHolder` 的，别漏**：它每 30 秒也刷新一次配置键，
   * 吃的是同一个 100,000/天的桶，每个 isolate 每天 2,880 次。漏算它会把余量算多
   * 将近一成——本项目已经栽过一次「把有条件的保证写成无条件」。
   *
   * 默认值（本值 60 秒、20 把 key、配置 TTL 30 秒）下每个 isolate 每天
   *   1440 × 21 + 2880 = 33,120 次，**3 个活跃 isolate 就用掉 99.5%**。
   * 也就是说默认值在推荐配置处已经临界；预期 isolate 更多就要把本值调大
   * （20 把 key、5 个 isolate 需要约 120 秒）。
   *
   * 代价：别的 isolate 判定的冷却/剔除，本 isolate 最多晚这么久才看到。
   */
  cacheTtlMs?: number;
  /**
   * `lastUsedAt` 最多多久落盘一次。**0 = 关闭写消除**（每次都落盘）。
   *
   * 改造前每个成功请求写一次 KV，而免费档写配额是 1,000 次/天 ⇒ 与 list 一起
   * 把转发数卡死在约 1,000/天。`lastUsedAt` 是纯遥测字段，为它付一次写不划算。
   * 代价：面板「最后使用」的精度最粗到这个间隔；但**任何其他状态变更的落盘都会
   * 顺带刷新它**，所以有故障发生时它反而是新的。
   */
  touchIntervalMs?: number;
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

  /** 见 EMPTY_POOL_RESCAN_MS。null 表示「本实例还没做过空池 list 兜底」。 */
  private emptyRescanAt: number | null = null;
  /**
   * 空池态最近一次 `list` 兜底抛出来的真实异常。null = 上一次是成功的。
   *
   * 存它是因为 `Refreshable.reload` 会把异常吞掉并沿用上一份快照，而空池态的
   * 上一份快照恰恰是 `[]`——于是「存储读不出来」和「池子真的是空的」在 `all()`
   * 的返回值里**完全无法区分**，网关照报 503 `pool_empty`，运维手上只有一条
   * `pool.load_failed`。留下这份异常，`all()` 才能把它如实抛成 500 + 真实原因。
   */
  private emptyRescanError: unknown = null;

  private readonly cacheTtlMs: number;
  private readonly touchIntervalMs: number;
  /**
   * isolate 级池快照。**与 `ConfigHolder` 建在同一个 `Refreshable` 上**，不是为了省
   * 代码：两者回答的是同一个问题——「面板刚改完，多久能看见？」——而面板上写的那个
   * 生效时间只有一份。各写一份实现必然漂移出两套语义，那个数字就开始骗人。
   * `tests/contract/freshness.test.ts` 用同一组断言分别跑两者，分叉立刻变红。
   */
  private readonly snapshot: Refreshable<KeyRecord[]>;

  constructor(
    private readonly storage: Storage,
    private readonly o: KeyPoolRepoOptions,
  ) {
    this.cacheTtlMs = o.cacheTtlMs ?? DEFAULT_POOL_CACHE_TTL_MS;
    this.touchIntervalMs = o.touchIntervalMs ?? DEFAULT_POOL_TOUCH_INTERVAL_MS;
    this.snapshot = new Refreshable<KeyRecord[]>({
      load: () => this.loadAll(),
      ttlMs: this.cacheTtlMs,
      now: o.now,
      onError: (err) => o.logger.log({
        level: "error", event: "pool.load_failed",
        msg: "读取 key 池失败，继续沿用上一份快照",
        fields: { err: err instanceof Error ? err.message : String(err) },
      }),
    });
  }

  async all(): Promise<KeyRecord[]> {
    if (this.cacheTtlMs <= 0) return await this.loadAll();
    await this.snapshot.ensureFresh();
    const cur = this.snapshot.current();
    // 从未成功装载过（冷启动就撞上存储故障）：再走一次真加载把**真实异常**抛出来，
    // 保持 P1「存储读失败 → app.onError → JSON 500」的既有行为，
    // 而不是换成一句自造的、排障时毫无信息量的错误。
    //
    // **代价要说清楚**：这条分支下每个请求会读两遍存储（`ensureFresh` 内部那次
    // 异常被吞掉了，这里再来一次），并多打一条 `pool.load_failed`。也就是说
    // 「冷启动 + 存储彻底不可用」期间是 2× 读放大 + 每请求一条 error 日志。
    // 接受它的理由：这段时间里网关本来就在返 500、根本没有有效流量，而把**真实
    // 异常**（哪个文件、哪个键）交到运维手上比省一次注定失败的读重要得多。
    // 只要成功装载过一次，就再也走不到这里（失败会沿用上一份快照）。
    if (cur === undefined) return await this.loadAll();
    // 空池态的 `list` 兜底失败了：**绝不许把「存储读不出来」伪装成「池子是空的」**。
    // 沿用 `[]` 的话调用方得到的是 503 `pool_empty`——一条把运维指向「你还没导 key」
    // 的错误结论，而真相是 list 配额打穿 / 存储故障，且此时 `reconcileIndex()`
    // 读同一个桶同样在抛，文档指定的两条自愈路径都已经死了。抛出去 ⇒ 500 + 真实原因。
    if (cur.length === 0 && this.emptyRescanError !== null) throw this.emptyRescanError;
    // **浅拷贝**：dispatch 的 commit 会 `records[at] = updated` 就地改数组元素，
    // 直接把缓存数组交出去等于让一次请求的中间状态污染 isolate 级缓存。
    // （记录对象本身永不被就地修改——keypool.ts 的 apply* 全部返回新对象。）
    return [...cur];
  }

  /**
   * 真正去存储读一遍。原来的 `all()` 就是它，**一个字都不许精简**：
   * 「索引缺失回落 list」与「空结果兜底」两条防线都在这里面，后者正是「对账在空池
   * 写下权威空索引之后，手工导入的 key 永远隐身」那个 503 场景唯一的解药。
   */
  private async loadAll(): Promise<KeyRecord[]> {
    const idx = await this.readIndex();
    // 索引缺失那条路径刚刚已经 list 过一次，下面的空结果兜底不必再来一次。
    const indexed = idx !== null ? idx.ids : await this.bootstrapFromList();
    const alive = await this.loadRecords(indexed);
    // 走到这里说明这一趟没经过空池兜底，上一次兜底失败的记忆就此作废，
    // 否则一次陈年的失败会永远把 all() 钉在抛异常上。
    if (alive.length > 0 || idx === null) { this.emptyRescanError = null; return alive; }
    return await this.rescanEmptyResult(indexed);
  }

  /** 面板写 key 之后调用（P3c）。与 `ConfigHolder.invalidate()` 是两把独立的钥匙，不互相代劳。 */
  invalidate(): void {
    this.snapshot.invalidate();
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
   * 代价**不**可控，这一点原来这里写错了（原文是「池子真空时本来每个请求都在返
   * 503，这次 `list` 不吃有效配额」）：`list` 是独立于读配额的第四个桶，免费档
   * 1,000 次/天，而快照缓存只把它压到「每个 TTL 一次」= 1,440 次/天/isolate，
   * **本身就超配额**。所以这里按 `EMPTY_POOL_RESCAN_MS` 再退避一层（见那里的账）。
   * 正常非空池一步都不会走到这里（`alive.length > 0` 就返回了）。
   *
   * **退避窗口内失败也要记得住**：`list` 抛错时把真实异常留给 `all()` 抛出去，
   * 不许让「读不出来」退化成一个静默的 `[]`。窗口是在**发起尝试之前**就打上的，
   * 因此存储持续故障时也只是每 `EMPTY_POOL_RESCAN_MS` 重试一次，不会每请求都撞。
   *
   * **写回只增不减**：只把 `list` 发现而索引不知道的 id 补进去，绝不从索引里删。
   * 删（剪枝）一律交给 `reconcileIndex()`，理由见 all() 里那段注释。于是
   * 「整池都成了幽灵索引项」时这里不写、不剪，只是每个退避窗口多一次 list，直到对账。
   */
  private async rescanEmptyResult(indexed: readonly string[]): Promise<KeyRecord[]> {
    const at = this.o.now();
    if (this.emptyRescanAt !== null) {
      const since = at - this.emptyRescanAt;
      // `since < 0` = 时钟回拨（NTP）。与 writeIndexBestEffort 同一条处理：
      // 回拨之后立刻恢复尝试，而不是被抑制到回拨量走完。
      if (since >= 0 && since < EMPTY_POOL_RESCAN_MS) {
        // 上一次兜底是**失败**的：退避窗口内也要如实抛。不抛的话，冷启动那条
        // （`all()` 里 `cur === undefined` ⇒ 再走一次 loadAll）会正好落进这个分支，
        // 于是真实异常被一个静默的 `[]` 吃掉，又变回「503 pool_empty，原因不明」。
        if (this.emptyRescanError !== null) throw this.emptyRescanError;
        return [];
      }
    }
    this.emptyRescanAt = at;

    let names: string[];
    try {
      names = await this.storage.list(KEY_PREFIX);
    } catch (err) {
      this.emptyRescanError = err;
      throw err;
    }
    this.emptyRescanError = null;

    const actual = idsFromKeyNames(names);
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

  /**
   * 落盘一条记录。
   *
   * @param prev 上一份（`dispatch` 传 `records[at]`）。它有**两个**作用，别只记住第一个：
   *   ① **写消除**：若两份之间只有 `lastUsedAt` 不同、且距上次落盘不到 `touchIntervalMs`，
   *      整个丢弃这次更新（存储不写、缓存也不动）。不给 prev 就一定落盘——
   *      写消除是可选优化，缺少对照时必须保守。
   *   ② **区分「更新」与「新建」**：给了 prev 就意味着「我手上有一份旧的，要把它改成
   *      新的」，于是要先确认那份旧的还在（见 stillExists）；`add()` 不给 prev，
   *      因为它写的是一条**本来就不存在**的记录。
   */
  async save(next: KeyRecord, prev?: KeyRecord): Promise<void> {
    if (prev !== undefined) {
      if (this.shouldElide(prev, next)) return;
      // **只在「改的就是手上这一份」时确认存在性。** `next.id !== prev.id` 时调用方写的
      // 是一个**全新的键**（prev 只是拿来做写消除对照的另一把 key），那条路径上「记录
      // 还不存在」本来就是正常状态，拿存在性去卡它等于把一次新建吃掉——
      // `tests/unit/pool-cache.test.ts` 的「只有 id 不同的两份之间不许消除」正钉这件事。
      // 今天生产上产生不出 id 不同的 next（`keypool.ts` 的 apply* 全部原样透传 id），
      // 但这条判据必须自洽，不能靠「那条路径走不到」来免责。
      if (next.id === prev.id && !(await this.stillExists(next.id))) return;
    }
    await this.storage.put(KEY_PREFIX + next.id, next);
    this.replaceInSnapshot(next);
  }

  /**
   * 更新落盘前确认记录还在。**这是「删除不许被陈旧写回撤销」这条不变量的全部实现。**
   *
   * 缺它时的失效链（评审实测复现，Worker 与单副本 Docker 都中招）：
   * Task 4 之后 `all()` 交出的是一份最长 `poolCacheTtlMs` 的 isolate 级快照，
   * 而运维吊销一把泄漏的 key 只有一种姿势——`wrangler kv key delete "key:<id>"`
   * 或直接编辑 `store.json`。记录没了，可**本 isolate 的快照里它还在**：下一个
   * 落到这里的请求照样选中它，上游一报错就 `applyStrike` ⇒ 调度字段变了 ⇒
   * 无条件 `put` 把整条记录原样写回去 ⇒ **被吊销的凭据复活**。更糟的是它此后不会
   * 自愈：手工删除不动 `pool:index`，索引里那个 id 还在，复活的记录立刻重新可用；
   * 就算走的是 `delete()`（索引已摘掉），复活出来的孤儿记录也会被 `reconcileIndex()`
   * **以 list() 为准捡回索引**——那正是本文件开头写序那一段说的「等于把一次删除
   * 悄悄撤销了」，只是这次是从另一扇门进来的。
   *
   * **为什么选「写回前确认存在」，而不是墓碑法或让对账不再收养孤儿**（三条都评估过）：
   * · **墓碑法**（delete 先写 `evicted:true` 的墓碑再摘索引，物理删交给对账）只护得住
   *   `delete()` 这一条路径。而 P3a 还没有面板，**今天唯一存在的吊销姿势恰恰是绕过
   *   `delete()` 的裸存储删除**——它压根不会写下墓碑。修的是还不存在的路径，漏的是
   *   正在用的那条。何况墓碑里仍然躺着 key 材料，对「吊销一把泄漏的 key」而言是反效果。
   * · **对账不再无条件收养孤儿**要求一份「已删 id」的持久集合，同样在裸存储删除下拿不到；
   *   而且孤儿收养这条路是 `add()` 崩在①②之间时**唯一**的补救（那时 Agnes 侧已经真实
   *   建号、key 材料只在这条孤儿记录里，丢了对账也修不回来——本文件开头把它定性为
   *   数据丢失）。为了修 A 去拆掉 B 的唯一救生索，不划算。
   * · 本条改在**写侧**，因而对上面三种删除路径一视同仁，且不碰对账语义。
   *
   * **代价（老实算）**：每次真正要落盘的更新多一次 `get`。稳态下调度字段变化很稀疏，
   * 写侧全天只有 `key 数 × 4` 次（`lastUsedAt` 触达），多这一次读在 100,000/天的读桶
   * 里可以忽略；`POOL_TOUCH_INTERVAL_MS=0`（关掉写消除）时每次成功转发都会多一次读，
   * 那个配置本来就写在「会打爆写配额」的逃生口一档里，与它一致。
   *
   * **残余风险（同样老实算）**：KV 的 `get` 走边缘缓存（默认 60 秒，§17 U3），
   * 所以刚删掉的记录在**本 colo** 可能还能被读到，这一窗口内确认仍会通过。也就是说
   * 在 KV 上它把「永久复活且不自愈」压成「最多一个 KV 传播窗口内可能复活」，
   * 不是零。FileStorage（Docker）没有这层缓存，那里是精确的。要彻底消掉那个窗口，
   * 得等 P3c 的面板删除按钮落地后再叠一层墓碑——两者不冲突。
   */
  private async stillExists(id: string): Promise<boolean> {
    if ((await this.storage.get<KeyRecord>(KEY_PREFIX + id)) !== null) return true;
    this.o.logger.log({
      level: "warn", event: "pool.stale_write_dropped",
      msg: "记录已被删除，丢弃这次基于陈旧快照的写回（删除不会被撤销），并立刻刷新快照",
      fields: { id },
    });
    // 记录确实没了，而本 isolate 的快照里还留着它——不失效的话它会继续被选中整整
    // 一个 TTL，等于「删了还在用」。与 delete() 里那次 invalidate 是同一条理由。
    this.invalidate();
    return false;
  }

  private shouldElide(prev: KeyRecord, next: KeyRecord): boolean {
    if (this.touchIntervalMs <= 0) return false;
    // **刻意不再单独判 `prev.id !== next.id`**：`id` 在 FIELD_ROLE 里就是 scheduling，
    // `schedulingEqual` 已经比过它了。变异实测确认那一行永远改变不了结果（去掉它
    // 全绿），而写一行永远改变不了行为的代码等于给后人留一条不可证伪的注释。
    // 「prev 是另一把 key 时不许消除」这条不变量由 FIELD_ROLE.id 守着，有用例钉。
    if (!schedulingEqual(prev, next)) return false;
    // 从未用过（null）⇒ 差值是 Infinity ⇒ 首次使用一定落盘，
    // 否则面板永远显示「从未使用」。
    const p = prev.lastUsedAt ?? Number.NEGATIVE_INFINITY;
    const n = next.lastUsedAt ?? Number.NEGATIVE_INFINITY;
    if (n < p) return false;   // 时钟回拨：老实写，不当成「没变化」
    return n - p < this.touchIntervalMs;
  }

  /** 写穿透：同一 isolate 内下一次 all() 立刻看到刚写下去的状态，不必等 TTL。 */
  private replaceInSnapshot(r: KeyRecord): void {
    const cur = this.snapshot.current();
    if (cur === undefined) return;
    const i = cur.findIndex((x) => x.id === r.id);
    if (i < 0) return;   // 不在当前快照里（刚 add 的）：交给 invalidate 后的下一次刷新
    const next = [...cur];
    next[i] = r;
    this.snapshot.set(next);
  }

  async add(key: string): Promise<KeyRecord> {
    const r: KeyRecord = {
      id: await keyId(key), key, addedAt: this.o.now(), lastUsedAt: null,
      cooldownUntil: 0, cooldownReason: null, strikes: 0, evicted: false, evictedReason: null,
    };
    try {
      await this.save(r);          // ① 记录先写
      await this.indexAdd(r.id);   // ② 再进索引
    } finally {
      // 补池刚铸出来的 key 必须**下一个请求**就能被选中，等一个 TTL 是错的。
      // 放 finally 而不是紧跟在成功之后：②失败留下的是孤儿记录，而孤儿在
      // 「空结果兜底」那条路径上是**看得见**的，快照不刷新就与存储对不上了。
      this.invalidate();
    }
    return r;
  }

  async delete(id: string): Promise<void> {
    try {
      await this.storage.delete(KEY_PREFIX + id);   // ① 记录先删
      await this.indexRemove(id);                   // ② 再出索引
    } finally {
      // **必须放 finally。** 记录已经删掉了，②失败时若不失效快照，这把（多半是刚
      // 被判定要撤销的）key 还会继续被选中整整一个 TTL——删除看起来生效了其实没有。
      this.invalidate();
    }
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
      // 对账刚刚改变了「all() 会返回哪些 id」（把孤儿捡回来、把幽灵剪掉），
      // 与 add()/delete() 是同一类写操作，**同样自己失效快照**。
      //
      // **今天这一行在生产里是空操作，别误以为它在兜什么底**：两个入口的对账都是
      // 现建一个 repo、调完就扔（快照本来就是空的），`tendOnce` 收尾那次用的又是
      // `cacheTtlMs: 0` 的实例。真正会用到它的是 P3c——面板上的「立即对账」按钮跟
      // 转发路径共用同一个 repo 实例，那时不失效就等于「点了对账，池子一分钟内没反应」。
      // 现在就写对，好过等到那天再想起来。有用例钉着（reconcileIndex 那条）。
      this.invalidate();
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
