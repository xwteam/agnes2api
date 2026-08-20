import type { Storage } from "../ports/storage.js";
import type { Logger } from "../ports/logger.js";
import type { KeyRecord } from "./types.js";
import { Refreshable } from "./refreshable.js";
import {
  statsDelta, addDelta, applyDelta, isZeroDelta, maxStats, normalizeStats, ZERO_DELTA,
  type StatsDelta,
} from "./admin/stats.js";
import type { KeyStats } from "./types.js";

/** 见 `KeyPoolRepo.pendingStats`。 */
interface PendingStats {
  /** 本实例认为**已经在存储里**的那份计数。落盘成功时更新成刚写下去的值。 */
  base: KeyStats;
  /** 自 `base` 之后观测到、但还没落盘的增量。 */
  delta: StatsDelta;
  /** 当前这批 `delta` 里最早那一条的时刻。`delta` 清零时这个值没有意义。 */
  since: number;
}
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
 * `tests/unit/pool-cache.test.ts` 的「前提：lastUsedAt 不参与调度……」用例与那条源码扫描
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
   * 管理员手工停用。**scheduling**，且这一格是本表最容易填错、填错后最难被发现的一格。
   *
   * `isAvailable` 读它（`src/core/keypool.ts` 的 `isDisabled`）⇒ 它改变「这把 key 还能
   * 不能用」⇒ 按本表开头那条判据就是 scheduling，没有第二种读法。
   *
   * ⚠️ **填成 telemetry 的后果**：`schedulingEqual(prev, next)` 会判两份相等，
   * 于是「停用一把 key」这次写**被写消除整个吃掉**——面板显示已停用、调度器照常用它。
   * 而且它只在「这把 key 的 `lastUsedAt` 距今不足 `touchIntervalMs`（默认 6 小时）」时
   * 发生，也就是**只对正在被使用的那些 key 发生**——恰恰是最需要能停下来的那些。
   * 由 `tests/unit/pool-cache.test.ts「停用一把刚用过的 key 必须真的落盘」` 钉着：
   * 把这一行挪进 telemetry 会让它变红。
   */
  disabled: "scheduling",
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
  /**
   * Tier-1 用量埋点。**telemetry**：调度逻辑一个字段都不读它
   *（`isAvailable` / `selectKey` / `apply*` / `poolHealth` 全都不碰）。
   *
   * ⚠️ 判为 telemetry 的**后果与 `lastUsedAt` 完全不同**，别把两者并列理解：
   * `lastUsedAt` 被消除只是「面板上的最后使用时间粗一点」，而计数被消除是
   * **计数直接不涨**（实测：50 次成功之后落盘的 requests 是 1）。
   * 所以写消除那条路径上必须把增量攒起来（见 pendingStats），
   * 而不是像 `lastUsedAt` 那样直接丢。
   */
  stats: "telemetry",
  /**
   * 运维备注。**telemetry**：调度逻辑一个字段都不读它（`isAvailable` / `selectKey` /
   * `apply*` / `poolHealth` / `keyBucket` 全都不碰），它只会被显示。
   *
   * ⚠️ **代价与 `lastUsedAt` 不同，这段是写给 P3c Task 3 的人看的。**
   * `lastUsedAt` 被消除只是面板上的时刻粗一点，而**只改 `note` 的那次写会被整个丢弃**：
   * `shouldElide` 的判据是 `schedulingEqual(prev, next)` 且 `lastUsedAt` 没走远，
   * 一次纯改备注的写两条都满足（实测：`save({...r, note:"x"}, r)` ⇒ `puts === 0`，
   * `note` 既不在存储也不在快照）。
   *
   * 🔴 **没有任何自动化会在你写错时变红，这句话不许再被写成别的样子。**
   * 上一版这里写着「等 `PATCH` 落地时那一格会变红」——**那是假的，评审实证**：
   * `MAY_ELIDE` 那一格恰恰断言「这次写被消除是对的」，所以
   * ① 修对了（`save(next)` 不传 `prev`）它是绿的；② 写错了（`save(next, prev)`，
   * 备注静默丢失）它**也是绿的**。它唯一会响的路是有人把本行挪进 `scheduling`
   * ——也就是只在「你已经理解并选择了全局修法」之后才响。
   * ⇒ **做 `PATCH` 的人必须自己建护栏**：一格「只改备注的 `PATCH` 之后 `GET` 读得回来」
   * 的端到端断言。本表兜不住它，本文件也兜不住它。
   */
  note: "telemetry",
};

const SCHEDULING_FIELDS = (Object.keys(FIELD_ROLE) as Array<keyof KeyRecord>)
  .filter((k) => FIELD_ROLE[k] === "scheduling");

function schedulingEqual(a: KeyRecord, b: KeyRecord): boolean {
  return SCHEDULING_FIELDS.every((k) => a[k] === b[k]);
}

/**
 * 索引重建写失败之后的静默窗口。
 *
 * **必须显著大于 `DEFAULT_POOL_CACHE_TTL_MS`，否则这条退避是一条死条件。**
 * 曾经两者都是 60_000，而判据是 `since < RETRY`：读路径每个快照 TTL 回落一次，
 * 两次尝试恰好间隔 60_000，`since === 60_000` 不小于 60_000 ⇒ **一次都不被抑制**
 *（实测跨 10 个 TTL 有 10 次 put 尝试）。取 5 倍，留出「TTL 被调小一档」的余量。
 *
 * ⚠️ **这条注释曾经宣称「有一条数 put 次数的行为用例钉着这个值」，那句话是假的
 * ——已实测勘误。** 这个常数唯二的两个调用点（`bootstrapFromListThrottled` /
 * `rescanEmptyResult`）都在写实际尝试之前先过一遍 `listOnReadPath` 的退避闸
 * （`READ_PATH_LIST_BACKOFF_MS = 600_000`），比这个常数更长；等到那道闸放行时，
 * 距上一次写尝试必然已经超过本值，`since < INDEX_WRITE_RETRY_MS` 永远不成立。
 * 把本值改回 60_000 时，实测**只有**下面的常数字面量/关系断言会变红，
 * `tests/unit/keypool-repo.test.ts` 的「索引写一直失败时，跨 10 个 TTL 的 put 尝试次数远少于 10」
 * 在两个值下都绿
 * ——这个常数在这两个调用点上已经是**功能性死代码**（无害的第二道保险，
 * 不是活跃防线）。真正钉住这个值的只有常数用例本身，改小了就靠它变红。
 */
export const INDEX_WRITE_RETRY_MS = 300_000;

/**
 * **读路径上两次 `list()` 之间的最小间隔。** 空池兜底与索引缺失回落**共用这一个窗口**。
 *
 * `list` 是独立于读配额的第四个桶，免费档 1,000 次/天（设计文档 §17 U1），
 * 而快照缓存只把它压到「每个 TTL 一次」= 60 秒 TTL 下 1,440 次/天/isolate，**本身就超配额**。
 * 两扇门都通向同一个桶，所以退避也必须是同一个：
 *   · 空池兜底（索引合法但一条活记录都读不到）；
 *   · 索引缺失回落（`readIndex()` 返回 null，多半是写桶打穿导致索引一直建不起来）。
 * 只堵前者时，后者实测仍是 1,440 次/天/isolate。
 *
 * 取 10 分钟 ⇒ 86400/600 = **≤144 次/天/isolate**，与文档「配额账」用的同一套
 * isolate 计数口径（3 个活跃 isolate ⇒ 432 次）叠上对账的 48~96 次仍有余量。
 *
 * **代价（写进五语言 DEPLOY.md，别只留在这里）**：池子为空、或索引坏掉时，
 * 手工导入的 key 不再是「下一个请求即生效」，而是最多等本值 + 一个 `POOL_CACHE_TTL_MS`。
 * 想立刻生效就同时更新 `pool:index`（文档给了命令）。
 */
export const READ_PATH_LIST_BACKOFF_MS = 600_000;

/**
 * **头几次连续失败用的快重试窗口。**
 *
 * 只有一个长窗口时，**一次**瞬时 list 抖动会把那份异常粘住整整 10 分钟：期间
 * 一个**真的是空的**池子会报 500「list 配额耗尽」而不是 503 `pool_empty`——
 * 把运维指向完全相反的方向（真相是「你还没导 key」）。
 *
 * ⚠️ **时序要按秒对齐，别凭直觉数「头几次」。** 判据是
 * `failures > 0 && failures < LIST_FAIL_ESCALATE_AFTER`（`LIST_FAIL_ESCALATE_AFTER = 3`），
 * 门槛看的是**已经失败的次数**，不是**尝试的序号**：第 1 次尝试（`t0`）没有上一次
 * `lastReadListAt` 可比，压根不过这道闸；真正被快窗口挡住、因而要多等 60 秒的只有
 * 第 2 次（挡在 `t0+60s`）与第 3 次（挡在 `t0+120s`）尝试，第 3 次失败后
 * `consecutiveListFailures` 达到 3、不再满足 `< LIST_FAIL_ESCALATE_AFTER`，
 * 第 4 次才被换成 600 秒的长窗口（落在 `t0+720s`）。
 * **一共只有 2 个快窗口、累计 2 分钟**，不是 3 个、3 分钟。
 *
 * ⚠️ **这里原来写着「`tests/unit/keypool-repo.test.ts` 的『连续失败三次之后升到
 * 长退避』按这个时序实测钉住：三次真实尝试恰好落在 `t0`、`t0+60s`、`t0+120s`」
 * ——那句是假的**（全分支评审 A9）：那条用例只断言第 4 次尝试之后 `st.lists`
 * **不再增长**，从头到尾没有断言过"恰好三次"这个数。把 `LIST_FAIL_ESCALATE_AFTER`
 * 从 3 改成 2 或 5，它照样全绿。现在补上了：那条用例数了次数
 *（`tests/unit/keypool-repo.test.ts:685`），常数表也把
 * `LIST_FAIL_ESCALATE_AFTER` 加了进去（`:719`）——它此前是本模块唯一一个
 * **缺席常数表**的导出常数。
 *
 * 此后长期持续故障维持在 ≤144 次/天（86400 ÷ 600），另加最初那 2 次快窗口带来的
 * 额外尝试，**全天上界 146 次**（原来这里写的是 147，与它自己给的算式差一）。
 */
export const LIST_FAIL_FAST_RETRY_MS = 60_000;

/** 连续失败几次之后升到长退避。取 3：够滤掉抖动，又不至于让持续故障长时间高频重试。 */
export const LIST_FAIL_ESCALATE_AFTER = 3;

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
   *   1440 × 21 + 2880 = 33,120 次，**3 个活跃 isolate 就用掉 99.36%**
   *（3 × 33,120 = 99,360；再加上每天 48~96 次索引对账约 99.4%，五语言 DEPLOY.md
   *  写的是含对账的那个数。原来这里写的是「99.5%」，与它自己上一行的算式对不上）。
   * 也就是说默认值在推荐配置处已经临界；预期 isolate 更多就要把本值调大
   * （20 把 key、5 个 isolate 需要约 120 秒）。
   *
   * 代价：别的 isolate 判定的冷却/剔除，本 isolate 最多晚**本值 + 约 60 秒**才看到
   * （后者是 KV 边缘缓存的默认 `cacheTtl`，已核实：见 `config-holder.ts` 的
   * `CONFIG_TTL_MS` 注释与其引用的出处）。默认 60000 时上界约 **120 秒**。
   *
   * **而且不只是「看得晚」**：陈旧快照上的任意一次调度写会把整条记录覆写回去，
   * **抹掉**别的 isolate 在这个窗口里刚写下的 `evicted` / `cooldownUntil`——那次判定
   * 要重新发生一遍。这条代价已写进五语言 DEPLOY.md，别只留在这里。
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

  /** 读路径上最近一次 `list()` 的时刻。null = 本实例还没在读路径上 list 过。 */
  private lastReadListAt: number | null = null;
  /** 连续失败次数。成功即归零。见 LIST_FAIL_ESCALATE_AFTER。 */
  private consecutiveListFailures = 0;
  /**
   * 读路径最近一次 `list()` 抛出来的真实异常。null = 上一次是成功的。
   *
   * 存它是因为 `Refreshable.reload` 会把异常吞掉并沿用上一份快照，而空池态的
   * 上一份快照恰恰是 `[]`——于是「存储读不出来」和「池子真的是空的」在 `all()`
   * 的返回值里**完全无法区分**，网关照报 503 `pool_empty`。留下这份异常，
   * `all()` 才能把它如实抛成 500 + 真实原因。
   */
  private lastReadListError: unknown = null;
  /**
   * 本实例最近一次成功 list 得到的 id 清单。**只在索引缺失 + 退避窗口内**用得上：
   * 那时既拿不到索引、又不许 list，沿用上一次的结果比返回空池诚实得多
   *（返回空池会让网关报 503 pool_empty，把运维指向「你还没导 key」）。
   */
  private lastKnownIds: string[] = [];

  private readonly cacheTtlMs: number;
  private readonly touchIntervalMs: number;
  /**
   * isolate 级池快照。**与 `ConfigHolder` 建在同一个 `Refreshable` 上**，不是为了省
   * 代码：两者回答的是同一个问题——「面板刚改完，多久能看见？」——而面板上写的那个
   * 生效时间只有一份。各写一份实现必然漂移出两套语义，那个数字就开始骗人。
   * `tests/contract/freshness.test.ts` 的「新鲜度契约」用同一组断言分别跑两者，
 * 分叉立刻变红。
   */
  private readonly snapshot: Refreshable<KeyRecord[]>;

  /**
   * **每把 key 的 Tier-1 记账状态：一份落盘基线 + 一笔未落盘的增量。**
   *
   * 存在的理由（实测）：成功路径上的写会被写消除整个丢弃，连带把计数丢掉，
   * 于是 `stats.requests` 永远停在 1。把增量攒起来、在**下一次本来就要发生的那次写**
   * 上一起带下去，写配额一次不增，而计数的误差收敛成
   * 「最多晚一个 `touchIntervalMs` 落盘 + isolate 在落盘前被回收时丢这一段」。
   *
   * ⚠️ **为什么必须存 `base` 而不只是 `delta`（C2，评审实测）**：只存 delta 时，
   * 落盘写的是「调用方交上来的 `next.stats` + 攒着的」，而这**默认了调用方的视图
   * 不落后于存储**。`dispatch` 的 `commit()` 恰恰打破这条：它 `records[at] = updated`
   * 存的是**未合并的 next**，于是同一次请求里第二次提交同一把 key 时，
   * `prev` 比存储旧、`pending` 又已在第一次落盘时清空 ⇒ 第二次写把已经落盘的累计
   * **往回退**（实测：21 次成功落盘后被抹成 1）。而「同一次请求里连着提交同一把 key」
   * 不是假想——池里只剩一把可用时 `selectKey` 会在一次 dispatch 内反复选中它。
   *
   * 所以基线由**本实例自己记账**、与调用方视图彻底解耦：落盘之后 `base` 就是刚写下去
   * 的那份，`delta` 清零；调用方之后交上来的 `prev` 只用来算**差值**，以及经
   * `maxStats` **只增不减**地吸收「别的 isolate 写得更高」的情形。
   *
   * `since` 是当前这批增量**最早**那一条的时刻：只靠 `lastUsedAt` 的间隔判据的话，
   * 上游 4xx 直通（既不改调度字段也不改 `lastUsedAt`）会让 `n - p === 0` 恒成立，
   * 一个只被打 4xx 的 key 的计数**永远不会落盘**。
   *
   * 四条不变量各自的守护者（都在 tests/unit/pool-cache.test.ts 的
   * 「Tier-1 计数不许被写消除吃掉」一组里，跑 `pnpm test tests/unit/pool-cache.test.ts` 即见）：
   * 计数不丢 → 「50 次成功之后落盘的 requests 是 50」；
   * 写配额不增 → 同一条里那句 `st.puts - putsAfterAdd === 2`；
   * 删掉的 key 不被复活 → 「记录被删掉时攒着的增量一并丢弃」+「走 delete() 删除时同样丢弃」
   *   +「裸存储删除之后直接重新导入」；
   * 已落盘的不被回退 → 「同一次请求里同一把 key 连提交两次」。
   */
  private readonly pendingStats = new Map<string, PendingStats>();

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
    if (cur.length === 0 && this.lastReadListError !== null) throw this.lastReadListError;
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
    // 索引缺失那条路径刚刚已经（可能）list 过一次，下面的空结果兜底不必再来一次。
    const indexed = idx !== null ? idx.ids : await this.bootstrapFromListThrottled();
    const alive = await this.loadRecords(indexed);
    // 走到这里说明这一趟没经过空池兜底，上一次兜底失败的记忆就此作废，
    // 否则一次陈年的失败会永远把 all() 钉在抛异常上。
    if (alive.length > 0 || idx === null) { this.lastReadListError = null; return alive; }
    return await this.rescanEmptyResult(indexed);
  }

  /**
   * 读路径上的 `list()` 唯一入口。**空池兜底与索引缺失回落都必须走这里**——
   * 它们通向同一个每天 1,000 次的桶，各自开一个窗口等于没开。
   *
   * 返回 `null` 表示「退避窗口内，这次不 list」；调用方据此沿用它已有的信息。
   * 窗口内若上一次是失败的，**如实抛**而不是返回 `null`：把「读不出来」退化成
   * 一个静默的 `[]` 正是 M2 修掉的那个洞。
   */
  private async listOnReadPath(): Promise<string[] | null> {
    const at = this.o.now();
    // **默认（0 次连续失败，即"正常工作但受节流"或"从未失败过"）用长退避**——
    // 这才是这扇闸真正要防的稳态：list 本身一直成功（例如索引缺失但记录都读得到、
    // 或池子确实是空的），此时没有理由每分钟都去 list 一遍。只有「刚经历过 1~2 次
    // 连续失败」这个窄窗口才切到快窗口，让一次孤立的抖动不粘住整整 10 分钟；
    // 连续失败到了 LIST_FAIL_ESCALATE_AFTER 次说明这不是抖动，退回长退避，
    // 不然持续故障会被误判成"值得每分钟重试"而烧穿 list 配额。
    const failures = this.consecutiveListFailures;
    const backoff = failures > 0 && failures < LIST_FAIL_ESCALATE_AFTER
      ? LIST_FAIL_FAST_RETRY_MS
      : READ_PATH_LIST_BACKOFF_MS;
    if (this.lastReadListAt !== null) {
      const since = at - this.lastReadListAt;
      // `since < 0` = 时钟回拨（NTP）。与 writeIndexBestEffort 同一条处理：
      // 回拨之后立刻恢复尝试，而不是被抑制到回拨量走完。
      if (since >= 0 && since < backoff) {
        if (this.lastReadListError !== null) throw this.lastReadListError;
        return null;
      }
    }
    // 窗口**在发起尝试之前**就打上，因此存储持续故障时也只是每个窗口重试一次。
    this.lastReadListAt = at;
    try {
      const names = await this.storage.list(KEY_PREFIX);
      this.consecutiveListFailures = 0;
      this.lastReadListError = null;
      return names;
    } catch (err) {
      this.consecutiveListFailures++;
      this.lastReadListError = err;
      throw err;
    }
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
   * **本身就超配额**。所以这里走共用的 `listOnReadPath()` 退避闸（见 READ_PATH_LIST_BACKOFF_MS）。
   * 正常非空池一步都不会走到这里（`alive.length > 0` 就返回了）。
   *
   * **退避窗口内失败也要记得住**：`list` 抛错时把真实异常留给 `all()` 抛出去，
   * 不许让「读不出来」退化成一个静默的 `[]`。这一点由 `listOnReadPath()` 统一处理。
   *
   * **写回只增不减**：只把 `list` 发现而索引不知道的 id 补进去，绝不从索引里删。
   * 删（剪枝）一律交给 `reconcileIndex()`，理由见 all() 里那段注释。于是
   * 「整池都成了幽灵索引项」时这里不写、不剪，只是每个退避窗口多一次 list，直到对账。
   */
  private async rescanEmptyResult(indexed: readonly string[]): Promise<KeyRecord[]> {
    const names = await this.listOnReadPath();
    if (names === null) return [];
    const actual = idsFromKeyNames(names);
    this.lastKnownIds = actual;
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
    const at = this.o.now();

    // ── 新建（`add()`）：写的是一条**本来就不存在**的记录 ────────────────────
    // 上一世攒着的增量绝不许跟过来。裸存储删除之后**没有任何后续 save**、直接重新
    // 导入同一把 key 时，这一行是唯一的闸：不清的话 `add()` 这次写会把已经被吊销的
    // 那把 key 的用量合并进新记录（只涉及遥测、不涉及凭据，但仍是「删掉的 key 用
    // 增量复活」的一种）。
    if (prev === undefined) {
      this.pendingStats.delete(next.id);
      await this.storage.put(KEY_PREFIX + next.id, next);
      this.replaceInSnapshot(next);
      return;
    }

    // ── `next.id !== prev.id`：写的是**另一个键** ───────────────────────────
    // prev 只是拿来做写消除对照的另一把 key。那条路径上「记录还不存在」本来就是正常
    // 状态，拿存在性去卡它等于把一次新建吃掉——`tests/unit/pool-cache.test.ts` 的
    // 「只有 id 不同的两份之间不许消除」正钉这件事。今天生产上产生不出 id 不同的 next
    // （`keypool.ts` 的 apply* 全部原样透传 id），但这条判据必须自洽，不能靠
    // 「那条路径走不到」来免责。两份属于不同的 key，谈不上计数增量，直接落盘。
    if (next.id !== prev.id) {
      if (this.shouldElide(prev, next)) return;   // `FIELD_ROLE.id` 是 scheduling ⇒ 恒为 false
      await this.storage.put(KEY_PREFIX + next.id, next);
      this.replaceInSnapshot(next);
      return;
    }

    // ── 更新同一条记录 ─────────────────────────────────────────────────────
    const entry = this.trackBaseline(next.id, normalizeStats(prev.stats), at);
    const delta = statsDelta(prev.stats, next.stats);

    // 攒得比一个触达间隔还久就别再消除了，否则只被打 4xx 的 key 永远落不了盘。
    if (this.shouldElide(prev, next) && !this.pendingIsStale(entry, at)) {
      // 这次写整个被丢弃了，但它带的**计数**不能跟着丢：攒起来，等下一次本来
      // 就要发生的那次写一起带下去。
      this.stashPending(entry, delta, at);
      return;
    }
    if (!(await this.stillExists(next.id))) {
      // 记录已经不在了，攒着的增量没有归属——**留着它就等于给复活留了一条路**。
      this.pendingStats.delete(next.id);
      return;
    }

    // 落盘 = **本实例记的基线** + 先前被消除掉的那些 + 本次这一笔。
    // 刻意**不**用 `next.stats` 当基数：那是调用方的视图，它可能落后于存储（C2）。
    const stats = applyDelta(entry.base, addDelta(entry.delta, delta));
    const merged: KeyRecord = { ...next, stats };
    await this.storage.put(KEY_PREFIX + merged.id, merged);
    // **put 成功之后才推进基线**：put 抛错时增量必须留着，下一次再合并一遍。
    entry.base = stats;
    entry.delta = ZERO_DELTA;
    entry.since = at;
    this.replaceInSnapshot(merged);
  }

  /**
   * 取出这把 key 的记账状态，并**只在还没有未落盘增量时**用调用方交上来的那份校准基线。
   *
   * 校准要处理的是「别的 isolate 把计数写得更高」：快照过 TTL 之后带回对方的值，
   * 取大就把它吸收进来，本实例不会再把它压回去。
   *
   * ⚠️ **但只能在 `delta` 为零时吸收（N1）。** `delta` 非零时 `seen` 里含着的正是
   * **仍攒在 `delta` 里、尚未落盘**的那一段（调用方每次都把 next 回写进自己的视图），
   * 把它顶成新基线 ⇒ 落盘写成 `base + 2×delta + 本次` ⇒ **计数虚高**。
   * 实测：2 次成功被消除 + 1 次失败落盘，真值 `requests:3 / success:2`，
   * 不加这个条件落盘写出 `5 / 4`。
   *
   * 虚高比少计更糟：面板已经对用户承诺过「并发下会**少计**」（`keys.approxTip`
   * 与五语言 DEPLOY.md），虚高是在说一句它自己不再保证的话。
   *
   * 「`delta` 为零」恰好就是唯一需要吸收的那个窗口：落盘之后 delta 清零，
   * 下一次 save 的 `trackBaseline` 先于 `stashPending` 跑，此时 `seen` 若更高，
   * 只可能来自存储（快照刷新），不可能来自本实例未落盘的那一段。
   *
   * 今天 `dispatch` 走不到虚高那条路（两个可消除终态都紧跟 `return done(...)`，
   * 其余终态必改调度字段 ⇒ 必真落盘），但**判据必须自洽，不能靠调用方的形态免责**
   * ——这与 `next.id !== prev.id` 那条的处置是同一把尺子。
   */
  private trackBaseline(id: string, seen: KeyStats, at: number): PendingStats {
    const cur = this.pendingStats.get(id);
    if (!cur) {
      const created: PendingStats = { base: seen, delta: ZERO_DELTA, since: at };
      this.pendingStats.set(id, created);
      return created;
    }
    if (isZeroDelta(cur.delta)) cur.base = maxStats(cur.base, seen);
    return cur;
  }

  /** 把一笔被消除掉的增量攒进去。空增量不攒——攒了会平白启动下面那条「攒太久」的计时。 */
  private stashPending(entry: PendingStats, delta: StatsDelta, at: number): void {
    if (isZeroDelta(delta)) return;
    if (isZeroDelta(entry.delta)) entry.since = at;   // 这批的第一条，计时从这里起算
    entry.delta = addDelta(entry.delta, delta);
  }

  /**
   * 攒得比一个触达间隔还久 ⇒ 强制落盘，见 pendingStats 的说明。
   *
   * **空增量一律不算陈旧**：落盘之后 `delta` 清零而条目留着（基线要留），
   * `since` 却还停在旧时刻，不判这一条的话它会把「压根没有计数要落」的 save
   * 也判成陈旧、白写一次盘。
   *
   * ⚠️ **真正被它挡住的是「什么都没变」的 no-op save，不是「只有 `lastUsedAt` 在动」
   * 的那种**——这句话第一版写反了，是实测订正的（N2）：只有 `lastUsedAt` 在动时，
   * `shouldElide` 自己的 `n - p < touchIntervalMs` 已经在同一个节拍上强制落盘了，
   * 带不带这个短路都是 2 次 put（10 次触达、间隔 5s、`touchIntervalMs=20s`）。
   * 而完全 no-op 的 save：带它 **0 次 put**，去掉它 **2 次**。
   * 那条差异由 `tests/unit/pool-cache.test.ts` 的「什么都没变的 save 一次盘都不该落」钉着。
   */
  private pendingIsStale(entry: PendingStats, at: number): boolean {
    if (this.touchIntervalMs <= 0 || isZeroDelta(entry.delta)) return false;
    const age = at - entry.since;
    return age < 0 || age >= this.touchIntervalMs;   // `age < 0` = 时钟回拨，老实落盘
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
      // 失效**本实例**的快照，于是同一个实例上下一次 all() 立刻看得到这把新 key。
      // 放 finally 而不是紧跟在成功之后：②失败留下的是孤儿记录，而孤儿在
      // 「空结果兜底」那条路径上是**看得见**的，快照不刷新就与存储对不上了。
      //
      // ⚠️ **别把它读成「补池刚铸出来的 key 下一个请求就能被选中」——生产上不成立。**
      // 那句话曾经写在这里，而它假设补池与转发用的是同一个实例。实际接线是两个：
      // `buildApp` 给 app 建一个（`wire.ts:91`，TTL = poolCacheTtlMs），
      // `buildTendDeps` 给补池另建一个（`wire.ts:143`，cacheTtlMs = 0）。
      // `Refreshable` 是实例私有状态，所以这次 invalidate 对转发路径毫无影响，
      // **真实可见上界是转发 isolate 自己的一个 `POOL_CACHE_TTL_MS`**
      // （Worker 上还要 × 每个活跃 isolate 各自的 TTL）。为什么不去改接线：见 wire.ts
      // 的 `buildTendDeps` 注释——那里说明了「共用一个实例」会踩到哪三条。
      //
      // 那这一行还有什么用？**P3c 的面板**：它跟转发路径共用 `BuiltApp.repo`
      // （wire.ts 为此把 repo 交了出来），面板写完 key 之后不失效就等于「加了 key，
      // 一分钟内没反应」。今天守它的是同实例的用例，那正是它今天唯一真实的用法。
      this.invalidate();
    }
    return r;
  }

  async delete(id: string): Promise<void> {
    try {
      await this.storage.delete(KEY_PREFIX + id);   // ① 记录先删
      await this.indexRemove(id);                   // ② 再出索引
    } finally {
      // 记录没了，攒着的增量就没有归属了。理由同 save() 里 stillExists 那条分支：
      // 留着它等于给「同一把 key 重新导入时把旧计数合并进来」留一条路。
      this.pendingStats.delete(id);
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
   *
   * **走退避闸**：这扇门与空池兜底通向同一个 list 桶，而它的触发条件恰恰是
   * 「写桶打穿导致索引一直建不起来」这种复合故障——不退避就是每个快照 TTL 一次
   * list，60 秒 TTL 下 1,440 次/天/isolate（实测）。
   *
   * 退避窗口内返回**上一次已知的 id 清单**（本实例内存里的），一条都没有过就返回空：
   * 那时 all() 会走到空池兜底，兜底同样在窗口内 ⇒ 返回 `[]`，语义与「池子是空的」一致，
   * 而这正是索引缺失且 list 不可用时唯一诚实的答案。
   */
  private async bootstrapFromListThrottled(): Promise<string[]> {
    const names = await this.listOnReadPath();
    if (names === null) return this.lastKnownIds;
    const ids = idsFromKeyNames(names);
    this.lastKnownIds = ids;
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

  /**
   * 写路径专用：不走读路径的退避闸。
   *
   * 理由：`indexAdd` 只在**索引缺失**时才走到这里，而它的调用方是 `add()`
   *（注册机铸出一把新 key，或 P3c 的面板导入）——那是低频操作，且这次 list 的结果
   * 会立刻被写成索引。拿一份最多 10 分钟前的陈旧清单去**写索引**，会把窗口内
   * 别人加进来的 id 从索引里抹掉，那是正确性问题，不是配额问题。
   *
   * ⚠️ **P3c 的批量导入不许循环调 `add()`**（K10）：那会是 `M × (1 list + 1 put)`。
   * 批量路径要「一次读索引 → 内存合并 → 一次写索引」。
   */
  private async listForIndexWrite(): Promise<string[]> {
    return idsFromKeyNames(await this.storage.list(KEY_PREFIX));
  }

  /**
   * ⚠️ **P3c 的批量导入不许循环调 `add()`。**
   * `add()` 是「一次记录 put + 一次索引读 + 一次索引 put」，循环 M 次就是 `3M` 次操作，
   * 而写桶只有 1,000/天。批量路径必须是「一次读索引 → 内存合并 → 一次写索引 → M 次记录 put」。
   * 另外在 FileStorage 形态下 `pool:index` 是**纯成本**（读侧零收益、每次 put 都重写整个
   * `store.json`），循环 add 会把全文写放大到 `3M` 次，几百把 key 的导入能卡住整个进程。
   */
  private async indexAdd(id: string): Promise<void> {
    const idx = await this.readIndex();
    if (idx === null) {
      // 索引整个缺失：`add()` 调 `indexAdd` 之前已经 `save()` 过这条记录，
      // 但**不能想当然地信这次 list() 一定读得到它**——`list()` 在 KV 上是
      // 最终一致的（同一条结论 `loadRecords` 的注释里也写着：「索引已更新、
      // 记录尚未可见」的窗口天然存在，这里是反过来的同一枚硬币：记录已写、
      // list() 还没看见）。评审用一个「list() 滞后一拍」的存储实测复现：
      // 全新部署第一次 add() 会写下一份不含这把新 key 的「权威」空索引，
      // 这把 key 就此隐身，直到下一次 cron 对账（默认 30 分钟）才捡得回来。
      // 所以这里必须显式把 id 并进去，不能只信 list() 的结果。
      const ids = await this.listForIndexWrite();
      // 也不能沿用「ids 已含 id 就不写」那条短路判据（那是下面分支的逻辑）：
      // 索引缺失时第一次 add() 必须无条件重建并写一次，不然索引永远建不起来。
      // 这一次**必须**抛：调用方 add() 靠它把「索引没进去」如实告诉注册机。
      await this.storage.put(POOL_INDEX_KEY, makePoolIndex([...new Set([...ids, id])]));
      return;
    }
    if (idx.ids.includes(id)) return;   // 已在索引里：不写，省一次 put
    // 这一次**必须**抛：调用方 add() 靠它把「索引没进去」如实告诉注册机。
    await this.storage.put(POOL_INDEX_KEY, makePoolIndex([...idx.ids, id]));
  }

  private async indexRemove(id: string): Promise<void> {
    const cur = await this.readIndex();
    if (cur === null) return;       // 没索引/索引不可读就没什么可摘的，对账会建
    if (!cur.ids.includes(id)) return;
    await this.storage.put(POOL_INDEX_KEY, makePoolIndex(cur.ids.filter((x) => x !== id)));
  }
}
