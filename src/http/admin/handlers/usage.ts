import type { Context } from "hono";
import type { Storage } from "../../../ports/storage.js";
import type { KeyPoolRepo } from "../../../core/keypool-repo.js";
import type { UsageSink } from "../../usage-sink.js";
import { normalizeStats } from "../../../core/admin/stats.js";
import { httpError } from "../../errors.js";
import {
  USAGE_DAY_MS, USAGE_DAY_RETAIN,
  usageDayIndex, usageCandidateKeys, mergeDayShards,
  type UsageBucket,
} from "../../../core/admin/usage-stats.js";

/**
 * Tier-2 读侧的接线。**`null` = 这个 app 没建 sink，也就是 Tier-2 关着。**
 *
 * ⚠️ **`storage` 与 `sink` 是同一份存储上的读与写**，所以 `createApp` 传的是
 * `usageSink.storage`（那个 getter 交出来的正是 sink 自己落盘用的那一个实例），
 * **不是另外注入一个 `Storage`**。
 *
 * ⚠️⚠️ **这个决定的理由订正过一次，因为上一版给的危害场景是假的（评审 I6）。**
 * 上一版写「`wire.ts` 手上同时有 `storage` 与 `watched` 两个引用，传错一个就会**读到空**」
 * ——**那是从一个不成立的前提推出来的**：`WatchedStorage` 的 `get` / `list`
 * 都是**直通**，只有 `put` / `delete` 被观测（`src/core/storage-health.ts` 的类说明
 * 逐字写着「只观测 `put`/`delete`：读操作（`get`/`list`）在数据目录只读时照样成功」
 * ——**括号那半上一版引漏了**，而本仓对「逐字」是有标准的，定向复评 N7），
 * 而 `wire.ts` 里 `watched` 包的就是同一个 `storage`
 * ⇒ **两个引用读出来逐字节相同**，传错的真实后果只是 `/health` 少一路可写性信号，
 * **不可能「读到空」**。
 * ⭐ 本仓已经登记过同型的一次（`src/core/admin/usage-stats.ts` 的
 * `USAGE_FLUSH_MIN_INTERVAL_MS` 上方那段「从假前提推出的论证」，P3d Task 3 评审 I1），
 * 这是同一期的第二次。**结论不变，被换掉的是理由。**
 *
 * ⇒ **真正的两条理由**：
 * ① **省掉往 `AppDeps` 里加一格 `Storage` 的接线** —— `createApp` 今天手上没有存储
 *    （`repo` / `storeLogger` 各自私有地持有它），为读侧单开一格要牵动装配与几十个夹具；
 * ② **让「读的和写的是同一个实例」成为结构性的，而不是靠装配时记得传对。**
 *    ⚠️ **如实说明：这条性质今天没有任何可观测后果**（见上，两个引用读出来一样），
 *    它是零成本地买了一份将来的保险——任何一个「读侧另有一层」的改动
 *    （只读副本、读缓存、换命名空间）都会让它立刻有后果。
 *
 * ⚠️ **整块可空，而不是「存储恒在 + 一个 enabled 布尔」**（全局约束 16）：
 * 关闭时读路径**在结构上不存在**，不是一个 `if` 挡着。一个「反正 enabled 是 false」
 * 的读路径迟早会被某次改动接上。
 *
 * ⚠️ **代价明写，并且是实测过的**（本任务变异 M1b，**装置一并记下否则复现不出来**）：
 * 「关着时不读存储」这条性质**不是一行可以被变异掉的代码**——要证伪它得先把接线
 * 本身改回「存储恒在」。实测那一次动了 **7 处，逐条列全**（上一版只列了 5 条却写着 7，
 * 评审 I9）：① `StoreLogger` 加一个 `storage` getter；② `AdminRouterDeps` 多一格
 * `usageProbe: Storage`；③ `router.ts` 顶部多一行 `import type { Storage }`；
 * ④ `createApp` 把 `storeLogger.storage` 当 `usageProbe` 传下来；
 * ⑤ `router.ts` 把它塞进那个 `usage` 参数对象；⑥ `usageHandler` 的 deps 多一个 `probe`；
 * ⑦ off 分支里加一次 `readShards`。
 * 之后 `tests/contract/admin-usage.test.ts` 的
 * 「① 统计没开：tier 是 off，days 与 pending 都是 null，而且一次存储读都没有」
 * 那一格**当场变红**。⇒ 那条断言有牙，只是牙咬的是「谁把接线改回两格」，
 * 不是「谁在 handler 里写错了一个 `if`」。
 */
export interface UsageWiring {
  storage: Storage;
  sink: UsageSink;
}

/**
 * `note` 的取值全集。**是 code 不是句子**：面板是五语言的，自由文本没法 i18n，
 * 前端拿它去查字典。写成运行期数组（不是纯类型联合）的理由与
 * `src/core/dispatcher.ts` 的 `FAIL_REASONS` 逐字相同——一个只存在于类型系统里的
 * 联合，测试没法穷举它，加一条新 code 而忘了在面板字典里补五种语言时没有任何东西会红。
 *
 * ⚠️ **这张表由 `tests/contract/admin-usage.test.ts` 的
 * 「USAGE_NOTES 里每一条 code 都真的被某一条端点产出过 —— 一条永远产不出来的 code
 * 会让面板字典里多一条永远用不上的文案，而少一条会让面板拿到一个查不到的 key」
 * 穷尽**：那一格把七条 code 各自摆出来跑一遍，再与这张表双向比对。
 *
 * ⚠️ **`note` 是**摘要**，不是第二个真源**：每一条 code 的判据全部来自同一份响应体
 * 里的其它字段（`tier` / `range.clamped` / `days === null` / `shards === 0`），
 * 由同一个 handler 在同一处算出。前端读 note 还是读那些字段都行，**但两者不许打架**
 * ——`no_shards` 与 `days !== null && shards === 0` 的等价性由那份契约测试里
 * 「note 与它自己的判据字段恒一致 —— note 是摘要不是第二个真源」一格钉着。
 */
export const USAGE_NOTES = [
  /** `tier === "off"`：`USAGE_STATS_ENABLED` 没打开，这个部署根本没在记账。 */
  "tier2_off",
  /** 服务端时钟给不出有限数字：区间与保留期都算不出来，**这不是「没有数据」**。 */
  "clock_unavailable",
  /** 读存储那一块抛了：`days` / `hours` 整块是 `null`，面板显示 `—` 而不是 0。 */
  "read_failed",
  /** 请求的区间被夹到了保留期起点或 `now`，`range` 回读的是服务端真正用的那一对。 */
  "range_clamped",
  /** 单日下钻要的那一天整个落在保留期之外：**不是那天没有请求，是那天已经不在了**。 */
  "date_out_of_retention",
  /**
   * 读成功了，区间里**一个分片都没有**（合法的没有、畸形的也没有）⇒ 真的没有记录到用量。
   * ⚠️ **判据是 `shards === 0 && malformed === 0` 两个一起**，见下面 `all_malformed`。
   */
  "no_shards",
  /**
   * 读成功了，**读到了分片，但每一个都是畸形的**（`shards === 0 && malformed > 0`）。
   *
   * ⚠️⚠️ **这一条是评审 C1 抓出来的第七种状态。缺陷只有一条：`note` 那句话是假的。**
   * 在这条 code 出现之前，它与「一个分片都没有」**同报 `no_shards`**
   * ⇒ 面板照 `note` 分支就会把「读到了 N 个分片、但每一个都坏」说成
   * 「这段时间一个分片都没有」，而分片明明有、只是全坏了。两者的处置完全不同
   *（前者「没人用」，后者「存储里的东西坏了，去看是谁写的」）。
   *
   * ⚠️⚠️ **立案理由订正过一次，别照上一版那句去理解（定向复评 N1）**：
   * 上一版写「它与 `no_shards` 的**响应体逐字相同**」——**那句是假的**，
   * 而且被同一个提交自己推翻：`malformed` 在 C1 之前就已经在返回语句里，
   * 两种状态一直是 `"malformed":0` 与 `"malformed":2`、**分得开的**。
   * ⇒ **真正的缺陷只有「`note` 撒谎」这一条，而它本来就够立案了。**
   * ⭐ 记一条形状：**给一个真缺陷编一个更吓人的理由，会把它变成假的**——
   * 而理由一被证伪，缺陷本身也会跟着被人当成没有。
   *
   * 由 `tests/contract/admin-usage.test.ts` 的
   * 「⑦ 分片都在、但每一个都是畸形的：note 是 all_malformed 而不是 no_shards —— 后者是假话」
   * 钉着。
   */
  "all_malformed",
  /**
   * 读成功了，**一部分分片是好的、另一部分是畸形的**（`shards > 0 && malformed > 0`）。
   *
   * ⚠️⚠️ **这是定向复评 N2 抓出来的第八种状态，而它上一版走的是 `note: null`
   * ——也就是「一切正常」那一支**。那不只是少一条 code：
   * `note: null` 让面板把**一份缺了几个分片的数据**渲染成完整的。
   * 全局约束 9 的原话是「绝不伪造」，而**伪造的不只是 `0`，还有「这份数据是全的」
   * 这个印象**；全局约束 10 的原话是「诚实标记由后端字段驱动」——`malformed`
   * 那个数字虽然一直在响应里，**但面板不该被要求自己去推**。
   *
   * ⚠️ **它逃过了上一轮全部的格子，成因很干净**：那格 note 一致性用例给五条 code
   * 各写了一个双条件，**唯独没给 `note === null` 定义任何判据** ⇒ `null` 就是那格的
   * 逃逸口。现在 `null` 也有自己的双条件了，见
   * 「note 与它自己的判据字段恒一致 —— note 是摘要不是第二个真源」。
   */
  "partial_malformed",
  /** 单日下钻的常态：**没有逐请求流水**（设计 §10.6），面板据它渲染那句指路的话。 */
  "no_request_detail",
] as const;

export type UsageNote = (typeof USAGE_NOTES)[number];

/**
 * 单把 key 的 Tier-1 计数。**与 Tier-2 完全无关**，Tier-2 关着时它照样可用
 * （设计 §10.6：「Tier-1 的按 key 用量在 Tier-2 关闭时也仍然可用」）。
 *
 * **零额外读**：走 `repo.all()`，与转发路径共用同一个 isolate 快照。
 * 这条由 `tests/contract/admin-usage.test.ts` 的
 * 「连打 20 次逐 key 用量：get / list 计数一次都不增加 —— 面板轮询不许各自去读一遍存储」
 * 数着计数钉住。
 */
export function keyUsageHandler(repo: KeyPoolRepo, now: () => number) {
  return async (c: Context) => {
    // `?? ""` 与 `handlers/keys-write.ts` 的 `paramId` 同一条理由：`c.req.param()`
    // 的静态类型是 `string | undefined`，而**刻意不写 `as string`**。落到空串时
    // 下面那次查找如实 404；写成 `as string` 的话 `undefined` 会一路进响应体的 `id`，
    // 而 `c.json` 会把 undefined 的字段**整个丢掉** —— 前端读到「字段不存在」。
    const id = c.req.param("id") ?? "";
    const rec = (await repo.all()).find((r) => r.id === id);
    // ⚠️ **走 `httpError`，不自己拼 `c.json({error}, 404)`**（评审 I4）：
    // `src/http/admin/handlers/keys-write.ts` 那两条同语义的 404 用的就是它
    //（逐字同一句「没有这把 key」）。
    // ⚠️⚠️ **这个改动今天一格用例都不会红，如实登记**（本任务变异 I4-M 实测：
    // 改回自己拼 `c.json` ⇒ **整份全绿、完整逃逸**）——两种写法产出的信封
    // **今天逐字节相同**。留着它的理由因此不是「防住了什么」，而是
    // **别绕开 `errorResponse()` 这个唯一出口**：哪天信封要加一个字段
    //（`request_id` 之类），绕开的那一条会静默地少那一格，而那时同样没有东西会红。
    // **别把这条注释读成「有护栏」。**
    if (!rec) throw httpError(404, "not_found", "没有这把 key");
    return c.json({
      id,
      stats: normalizeStats(rec.stats),
      /** Tier-1 是近似值：并发下少计，且最多晚一个 POOL_TOUCH_INTERVAL_MS 落盘。 */
      approximate: true,
      generatedAt: now(),
    });
  };
}

/**
 * `from` / `to` 的解析结果。**三种结局分得开**，这是本文件存在的头等理由。
 *
 * ⚠️ **`usageCandidateKeys` 对「`from`/`to` 是 `NaN`」与「`nowMs` 不是有限数」
 * 两种入参都返回空数组，而空数组与「这段时间真的没有数据」在它的返回值上
 * 完全不可区分。**
 * ⚠️ **两种的成因不同，别都记到那两道护栏头上（评审 I10 订正）**：
 * `src/core/admin/usage-stats.ts` 的 `usageCandidateKeys` 上方那两道护栏
 * **从头到尾只讲 `nowMs`**（有限性闸 + 结构性计数闸），
 * **一个字都没提 `from`/`to` 是 `NaN` 的情形**；后者返回空数组靠的是另一件事——
 * `NaN` 参与的比较恒为 `false`，于是 `d <= newest` 一上来就不成立、循环一次都不进。
 * 那不是它的缺陷——它是纯函数，本来就只该回答「取哪些键」。
 * **把这三件事分开是入参解析这一层的职责**，也就是这里：
 * · 客户端把参数写错 ⇒ **400**，让前端立刻知道自己发错了；
 * · 服务端时钟坏了 ⇒ `clock_unavailable`；
 * · 参数与时钟都好、区间里就是没有分片 ⇒ `no_shards`。
 * 三者混成一句「这段时间没有数据」正是全局约束 9 点名的那件事。
 */
type RangeParse =
  | { kind: "ok"; from: number; to: number; fromDay: number; toDay: number; clamped: boolean }
  | { kind: "clock" };

/**
 * 单个 epoch 毫秒参数。**缺席返回 `null`，非法直接抛 400，不做「善意纠正」。**
 *
 * ⚠️ **判据是 `Number.isSafeInteger` 而不是 `Number.isInteger`**，这一条不是洁癖：
 * `Number.isInteger(1e24)` 是 **true**，而 `usageDayIndex(1e24)` 已经远超 `2**53`，
 * 在那个量级上 `d + 1 === d` 可能成立（`usageCandidateKeys` 上方那张四行实测表逐项
 * 记着它，成因是相邻可表示浮点数的间距已经大于 1）。那道结构性计数闸挡住了
 * 「循环不终止」，**但挡不住「回一个语义上莫名其妙的区间」**。在入口就把这一档
 * 判成客户端错误，比让它走到底再解释便宜得多。
 *
 * ⚠️ **负数一律 400，不当成缺失**：epoch 毫秒没有负数这回事，而「悄悄纠正」会让
 * 前端把参数发成 `-1` 这件事永远不被发现（`handlers/events.ts` 的 `afterParam`
 * 对 `after` 取的是另一个口径——那一条是客户端回传的游标，容错是它的语义的一部分；
 * 这两条是人点按钮选出来的时间范围，发错就是 bug）。
 */
function msParam(c: Context, name: string): number | null {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw httpError(
      400, "invalid_request_error",
      `${name} 必须是不小于 0 的整数（epoch 毫秒），收到的是：${raw}`,
    );
  }
  return n;
}

/**
 * 把查询串解析成服务端真正会用的那一对时刻。
 *
 * | 参数 | 类型 | 单位 | 缺省 | 越界处理 |
 * |---|---|---|---|---|
 * | `from` | 整数 | **epoch 毫秒** | `to - 86400000` | 早于保留期的夹到保留期起点，`clamped` 为真 |
 * | `to` | 整数 | **epoch 毫秒** | 服务端 `now()` | 晚于 `now()` 的夹到 `now()`，`clamped` 为真 |
 *
 * **`days` 不是参数**：它是前端按钮的档位，服务端不认。前端只发 `from` / `to`。
 *
 * ── 档位 → `(from, to)` 的映射，**在这里钉死**（评审 I3）───────────────────────
 * 服务端不认档位，**但两边必须对同一个映射有共识**，否则「30d」这个按钮到底从哪天
 * 算起，前后端各说各的。设计 §10.6 的按钮组是 `24h / 3d / 7d / 30d`，对应：
 *
 * | 按钮 | `N` | `to` | `from` |
 * |---|---|---|---|
 * | `24h` | 1 | `now` | `now − 0 × 86400000` |
 * | `3d` | 3 | `now` | `now − 2 × 86400000` |
 * | `7d` | 7 | `now` | `now − 6 × 86400000` |
 * | `30d` | 30 | `now` | `now − 29 × 86400000` |
 *
 * ⇒ **`from = to − (N − 1) × 86400000`**，因为服务端按**整 UTC 天**取，
 * 而「N 天」含今天。
 *
 * ⚠️⚠️ **差一天的后果不是「多一天数据」，是那句警告永久常驻**：发
 * `from = now − 30 × 86400000` 的话 `askedFromDay = 今天 − 30`，而保留期起点是
 * `今天 − 29` ⇒ **每一次点 30d 都 `clamped: true`**，面板于是每一次都说
 * 「这段时间早于保留期，只显示了能拿到的部分」——**说到运维不再看它**，
 * 而那正是 `clamped` 这个字段上方刚论证过要避免的形态。
 * 两个方向都由 `tests/contract/admin-usage.test.ts` 的
 * 「四个档位按 from = to − (N−1) 天 发：clamped 全是 false；按 N 天发：30d 那一档恒为 true」
 * 钉着（**两边都断言**，只写正向的话「clamped 恒为 false」的实现也全绿）。
 *
 * ── 三处顺序是有讲究的，写下来免得后人以为可以换 ─────────────────────────────
 * ① **先校验客户端真的发了的那两个值**（`msParam`）——它不需要时钟，所以时钟坏了
 *    也不该把一个格式错误报成 `clock_unavailable`；
 * ② **再查时钟**——`to` 的缺省值是 `now()`，时钟不可用时下面每一步都算不出来；
 * ③ **`from > to` 用夹逼之前的那一对判**。夹逼之后再判会把「客户端发了一个自洽的
 *    未来区间」误报成 400：`to` 被夹到 `now` 之后确实 `from > to`，但那不是客户端的错。
 *    ⚠️ **夹完之后有效窗口为空是允许的，而那时回读的 `range.from` 会大于 `range.to`**
 *    ——例如整段区间都在未来（`from = now + 40 天`、`to = now + 41 天`）。
 *    那不是编出来的一对，它逐字就是服务端算出来的那个空窗口；`days` 因此是空数组、
 *    `shards` 是 0，而 `note` 是 **`range_clamped`**（它压过 `no_shards`，
 *    见 `usageHandler` 上方那张表下面的说明）。**不把它「修正」成一段非空区间**：
 *    那才是编，而面板会照着那段区间说「这几天没有请求」——一句关于**根本没被查过的
 *    日子**的断言。
 *
 * ── 滚动窗口 vs UTC 日键的错位，在这里一并裁掉 ────────────────────────────────
 * `now − 30 天` 是一个**滚动**时刻，而日桶是 **UTC 日**，滚动 30 天会横跨 **31** 个
 * UTC 日，最老那一个只有一部分落在区间内。⇒ **服务端一律按「`from` 所在的 UTC 日」
 * 到「`to` 所在的 UTC 日」取整天**，并在 `range` 里回读**取整之后**的那一对
 * （`from` = 起始日的零点，`to` = 结束日的最后一毫秒）。
 * **日桶的粒度就是天，装作能给出半天是撒谎。**
 *
 * ⚠️ **取整本身不算 `clamped`**：它是无条件适用的口径（每一次请求都会发生），
 * 而 `clamped` 要回答的是「服务端有没有因为拿不到而缩小了你要的窗口」——那句话
 * 面板要拿去说「这段时间早于保留期，只显示了能拿到的部分」。两者混成一个布尔，
 * 面板就会对每一次正常请求都说那句话，说到运维不再看它。取整之后的真实窗口
 * 由 `range` 那一对如实回读，一个字都没有藏。
 */
function parseRange(c: Context, nowMs: number): RangeParse {
  const rawFrom = msParam(c, "from");
  const rawTo = msParam(c, "to");
  if (!Number.isFinite(nowMs)) return { kind: "clock" };

  const to = rawTo ?? nowMs;
  const from = rawFrom ?? to - USAGE_DAY_MS;
  if (from > to) {
    throw httpError(
      400, "invalid_request_error",
      `from 不得晚于 to（from=${from}, to=${to}）`,
    );
  }

  // 夹逼。**两个方向各自记一笔**，合起来才是 `clamped`。
  const clampedTo = Math.min(to, nowMs);
  const oldestAllowedDay = usageDayIndex(nowMs) - USAGE_DAY_RETAIN + 1;
  const askedFromDay = usageDayIndex(Math.max(0, from));
  const fromDay = Math.max(askedFromDay, oldestAllowedDay);
  const toDay = usageDayIndex(clampedTo);
  return {
    kind: "ok",
    from, to,
    fromDay, toDay,
    clamped: clampedTo !== to || fromDay !== askedFromDay,
  };
}

/** UTC 日序号 → `YYYY-MM-DD`。**日期一律 UTC**（设计 §7.1 末条：Worker 是多 colo 的）。 */
function utcDateString(day: number): string {
  return new Date(day * USAGE_DAY_MS).toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` → UTC 日序号。**认不出来返回 `null`。**
 *
 * ⚠️⚠️ **必须回读一遍再比对，而理由恰好与「直觉」相反 —— 这一段订正过一次，
 * 上一版把两个例子写反了（评审 I5）**。逐项实测（node v24 / V8）：
 *
 * | 入参 | `Date.parse(…T00:00:00.000Z)` | 谁挡下它 |
 * |---|---|---|
 * | `"2026-02-31"`（日历上不存在的一天） | **`1772496000000`（= 2026-03-03，滚过去了）** | **只有回读比对** |
 * | `"2024-02-31"`（同上，本仓夹具用的那个） | **`1709337600000`（= 2024-03-02）** | **只有回读比对** |
 * | `"2026-13-01"`（月份越界） | **`NaN`** | 上面那句 `Number.isFinite` |
 *
 * ⇒ **「日历上不存在的一天」拿得到一个正常数字，「月份越界」才是 `NaN`。**
 * 上一版写的正好是反的，而那会让人以为回读那一步是可有可无的冗余——
 * **恰恰相反，`2024-02-31` 这一档今天完全靠它挡着**
 *（`tests/contract/admin-usage.test.ts` 的「date %s ⇒ 400，不做善意纠正」那一组
 * 里 `["日历上不存在的一天", "2024-02-31"]` 那一行就是这一档）。
 * 「解析出来的那一天再格式化回去必须逐字等于客户端给的串」同时也是一条
 * **与实现无关**的判据：别的 JS 实现在这两档上宽容到什么程度都不影响结论。
 */
function parseUtcDate(raw: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const ms = Date.parse(`${raw}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return null;
  const day = Math.floor(ms / USAGE_DAY_MS);
  return utcDateString(day) === raw ? day : null;
}

/**
 * 逐块读回来的那一块。**成功与失败是两种形状，不是「失败给个空的」**（全局约束 9）。
 *
 * ⚠️ **失败时 `shards` / `malformed` 也必须是 `null`，不许留 0**：一个「读失败但
 * 分片数写着 0」的响应体，面板照着渲染就是「这段时间有 0 个分片贡献了数据」
 * ——**那正是伪造 0**。三个字段同生同死。
 */
type ReadBlock =
  | { ok: true; merged: ReturnType<typeof mergeDayShards> }
  | { ok: false };

/**
 * 把候选键一次性读回来并合并。
 *
 * ⚠️ **一个键都不许吞**：任何一次 `get` 抛错都让整块失败（返回 `{ ok: false }`），
 * **绝不把读到的那部分当成全份交出去**。
 * ⚠️ **出处订正（评审 I8）**：「不许把一段不完整的 30 天显示成完整的」这句话
 * **不是设计里的原话**（全仓 grep 当时只命中当期那份内部计划文档），它是那份计划的话。
 * 设计那一段自己的原话是**「接口失败显示 `—`，绝不伪造 `0`」**（精度纪律那一条），
 * 结论同源、措辞不同。**上一版把计划的话记在了设计头上。**
 * 两份文档都未随公开仓发布；被订正的那句结论逐字留在这里，不依赖它们。
 * 而 30 天那一档正是本仓第一个会一次发出 60 次子请求的读扇出
 * ——`src/core/admin/usage-stats.ts` 的 `USAGE_DAY_RETAIN` 上方记着 U-H 的裁定：
 * **Cloudflare 的两页官方文档在「一次调用能发多少次子请求」上互相对不上**
 * （Workers limits 页免费档 50，KV limits 页 1,000，而前者没有定义 KV 算哪一行），
 * 所以**这里不许写成「60 次是安全的」**——那句裁定至今有效，理由见那一段。
 * ⚠️ **真机冒烟（`scripts/smoke-dual-runtime.sh` 的 ④ 那一格）已经把「跑不跑得完」
 * 这一半量出来了：本次实测在本地 workerd 上跑得完**（回的是 `tier2` + 30 段 days，
 * 不是 `read_failed`）。**但它跑的是 `wrangler dev`，不是线上边缘**，
 * 所以「线上免费档会不会超」仍然没有答案，那一半仍然按「没有平台承诺」处置。
 * 能写下来的仍然只有那一句：**它在 Worker 上失败的时候要失败得诚实。**
 *
 * `Promise.all` 而不是逐个 `await`：串行 60 次要付 60 个往返，并发只付 1 个。
 * ⚠️ **刻意不写「串行要几秒」**：本仓对 KV 的往返延迟没有任何量测，
 * 那个数会是一句编出来的话（上一版写的正是「串行在 KV 上是秒级的」）。
 * ⚠️ **它不改变 get 的次数**（`Promise.all` 不做去重也不短路），
 * 所以读扇出那四格数出来的仍然是 `天数 × USAGE_SLOTS`。
 */
async function readShards(storage: Storage, keys: readonly string[]): Promise<ReadBlock> {
  try {
    const raw = await Promise.all(keys.map((k) => storage.get<unknown>(k)));
    return { ok: true, merged: mergeDayShards(raw) };
  } catch {
    return { ok: false };
  }
}

/**
 * sink 的自述状态，原样转成响应里的 `pending` 块。
 *
 * ⚠️⚠️ **`pendingMs` 数的是「距上一次落盘*尝试*多久」，不是「距上一次写成功多久」**
 * （`src/http/usage-sink.ts` 的 `status()` 上方写着全文）。⇒ **`count > 0 && ms ≈ 0`
 * 要读作「刚试过、没写成」，不是「没有尾巴」**。判别未落盘尾巴的字段是 `count`，
 * **不是 `ms`**；`ms` 只回答「这条尾巴最长可能有多旧」。
 *
 * ⚠️ **`budgetExhausted` 必须一起发出去**：那两种失败态（预算耗尽 / 存储抛错）
 * 在 `count` + `ms` 上长得一模一样，把它砍掉面板就只能猜。它是全局约束 10 的原话
 * 「诚实标记由后端字段驱动」在这个板块的落点。
 * 这两条由 `tests/contract/admin-usage.test.ts` 的
 * 「落盘失败之后 pending.count 仍然大于 0 而 pending.ms 是 0 —— 刚试过没写成，不是没有尾巴」
 * 钉着。
 */
function pendingBlock(sink: UsageSink): { count: number; ms: number; budgetExhausted: boolean } {
  const s = sink.status();
  return { count: s.pending, ms: s.pendingMs, budgetExhausted: s.budgetExhausted };
}

/**
 * `days` 里那些「读到了，就是没有」的日子用的零桶。
 *
 * ⚠️ **这不是「伪造 0」**（全局约束 9），差别要说清楚：这一天的两个候选键都**真的
 * 被读过**、都返回了 `null`，「没有记录」就是这次读的真实结果。真正被禁止的是
 * 「读失败了却报 0」，而那一档由 `days === null` 整块承担，不会落到这里。
 * 边界上唯一的含糊是 TTL 过期与「本来就没写过」在 KV 上不可区分，而整段区间已经
 * 被夹进保留期内（`range.clamped` 会把这件事说出来），所以那一档也不会落到这里。
 *
 * **冻起来**：它被塞进每一个空日子，写成可变对象的话任何一处误改都会串味。
 */
const EMPTY_DAY: UsageBucket = Object.freeze({
  requests: 0, success: 0, errors: 0, tokensIn: 0, tokensOut: 0,
  streamingRequests: 0, latencySum: 0, latencyCount: 0,
});

/**
 * `GET /admin/api/usage`（Tier-2 汇总）。
 *
 * ── 七种状态必须在响应字段上分得开（全局约束 9 在本期的主战场）───────────────
 *
 * ⚠️ **编号与 `tests/contract/admin-usage.test.ts` 里那一组的编号逐字一致**，
 * 改一边就要改另一边——上一版两处各编各的，读的人要在两套编号之间换算。
 *
 * | # | 状态 | HTTP | `tier` | `range` | `days` / `total` | `shards` | `malformed` | `pending` | `note` |
 * |---|---|---|---|---|---|---|---|---|---|
 * | ① | Tier-2 没开 | 200 | **`"off"`** | 有 | **null** | **null** | **null** | **null** | `tier2_off` |
 * | ② | 读不出来 | 200 | `"tier2"` | 有 | **null** | **null** | **null** | 有 | `read_failed` |
 * | ③ | 区间里一个分片都没有 | 200 | `"tier2"` | 有 | 每天一格、全是 0 桶 | **0** | **0** | 有 | `no_shards` |
 * | ④ | 有分片，只是请求数是 0 | 200 | `"tier2"` | 有 | 有 | **> 0** | 0 | 有 | **null** |
 * | ⑤ | 时钟给不出有限数字 | 200 | 有 | **null** | **null** | **null** | **null** | 有 | `clock_unavailable` |
 * | ⑥ | 参数发错了（非整数 / 负数 / `from > to`） | **400** | — | — | — | — | — | — | — |
 * | ⑦ | 分片都在，但**每一个都是畸形的** | 200 | `"tier2"` | 有 | 每天一格、全是 0 桶 | **0** | **> 0** | 有 | `all_malformed` |
 * | ⑧ | **一部分分片畸形**（数据不完整） | 200 | `"tier2"` | 有 | 有，**但不完整** | **> 0** | **> 0** | 有 | `partial_malformed` |
 *
 * ③ 与 ④ 是两件事，第一版会把它们压成同一个「今日请求数 0」：前者说「这段时间
 * 这个部署没有记下任何东西」（可能是没流量，也可能是 isolate 没活到一次落盘），
 * 后者说「有实例落过盘，那些盘里的请求数就是 0」。**判据是 `shards`，不是 `total`。**
 *
 * ⚠️⚠️ **⑦ 是评审 C1 抓出来的，缺陷只有一条：`note` 那句话是假的。**
 * 在 `all_malformed` 出现之前，⑦ 与 ③ **同报 `no_shards`**，于是面板照 `note` 分支
 * 就会把「读到了 N 个分片、但每一个都坏」说成「这段时间一个分片都没有」。
 * ⇒ `no_shards` 的判据从此是 **`shards === 0 && malformed === 0` 两个一起**。
 * ⚠️ **立案理由订正（定向复评 N1）**：上一版写「⑦ 与 ③ 的**响应体逐字相同**」
 * ——**那句是假的**，`malformed` 在 C1 之前就已经在返回语句里，两者一直分得开。
 * 完整的订正与那条形状（**给一个真缺陷编一个更吓人的理由，会把它变成假的**）
 * 记在 `USAGE_NOTES` 的 `all_malformed` 上方，**这里不复述**。
 *
 * ⚠️⚠️ **⑧ 是定向复评 N2 抓出来的，而它上一版走的是 `note: null`（「一切正常」那一支）。**
 * 一份**缺了几个分片**的数据被渲染成完整的 —— 全局约束 9 禁的「伪造」
 * **不只是伪造 `0`，还有伪造「这份数据是全的」这个印象**。
 * 它逃过上一轮全部格子的成因：那格 note 一致性用例**没给 `note === null` 定义判据**，
 * 于是 `null` 成了逃逸口。现在 `null` 也有双条件了。
 *
 * ⚠️ **`days` 恒是「每天一格」，不是「只列有数据的那几天」**：一个 30 天的区间
 * 恒给 30 格，缺数据的那天是 0 桶（见 `EMPTY_DAY` 上方对「这不是伪造 0」的论证）。
 * 让面板去补缺口等于把「哪些天该出现」这条知识复制一份到前端。
 *
 * ── `note` 只有一格，所以要定优先级；下面这个顺序是有判据的 ──────────────────
 * `read_failed` > `all_malformed` / `partial_malformed` > `range_clamped` > `no_shards` > `null`。
 *
 * · **畸形那两条压过 `range_clamped`，这个顺序订正过一次（定向复评 N6）。**
 *   上一版是反的（`range_clamped` 在前），判据写的是「你要的窗口被缩小了更该先说」。
 *   ⚠️ **那个顺序与 I3 那个场景叠起来会变成永久静音**：面板的 `30d` 按钮只要把
 *   `from` 发成 `now − 30 天`（差一天，`parseRange` 上方那张表正在防的那件事），
 *   `clamped` 就**恒为真** ⇒ **`all_malformed` / `partial_malformed` 在那一档上
 *   永远不可达**，存储坏成什么样面板都只会说「这段时间早于保留期」。
 *   ⇒ **判据换成「谁需要人去查」**：畸形要人去查存储，被夹只是一句提示。
 * · **`all_malformed` 与 `partial_malformed` 互斥**（`shards === 0` vs `> 0`），
 *   不存在谁压谁。
 * · **`range_clamped` 仍然压过 `no_shards`**：窗口被缩小往往正是「里面没东西」的成因。
 * ⚠️ **代价明写、方向与上一版相反**：被夹过**且**有畸形分片时，面板拿到的是
 *   畸形那条 code，**`clamped` 那句提示不再由 `note` 说** —— 但 `range.clamped`
 *   这个布尔一直在响应里，面板照样渲染得出来（全局约束 10 要的正是「由字段驱动」）。
 * ⚠️ **这个顺序让每一条 code 的判据仍然是一个干净的双条件**，由
 * `tests/contract/admin-usage.test.ts` 的
 * 「note 与它自己的判据字段恒一致 —— note 是摘要不是第二个真源」逐条钉着；
 * 顺序一改，那一格里的双条件就会红。
 *
 * ⚠️ **`tier` 那一格永远不许是 `null`**（Step 5）：它是「统计开没开」，来自内存里的
 * 接线，读不出来是不可能的。写成可空会让前端多一条永远走不到的分支，
 * 而那条分支迟早会被误用来兜别的 null。
 *
 * ⚠️ **`tokensCoverage` 不在这里**（评审 I20）：它只从 `GET /admin/api/capabilities`
 * 发。同一份知识两个出口，前端就要面对「读哪一个」这个不该存在的问题。
 * 这一条由 `tests/contract/admin-usage.test.ts` 的
 * 「用量端点不带 tokensCoverage —— 同一份知识只许有一个出口」钉着。
 *
 * ⚠️ **关着的时候一次存储访问都不许有**（全局约束 16）。这条在本文件里是**结构性**的：
 * `deps.usage` 为 `null` 时压根没有 `Storage` 可读。见 `UsageWiring` 上方那段。
 */
export function usageHandler(deps: { usage: UsageWiring | null; now: () => number }) {
  return async (c: Context) => {
    const at = deps.now();
    const wiring = deps.usage;
    const tier = wiring === null ? "off" : "tier2";
    // ★ 参数校验排在最前：客户端发错了参数，无论 Tier-2 开没开、时钟好不好，
    //   都该立刻拿到 400。这一步只看客户端真的发了的那两个串，不碰时钟。
    const parsed = parseRange(c, at);

    const base = {
      tier,
      /** 日期一律 UTC，并且**在响应里说出来**（设计 §7.1 末条）。 */
      timezone: "UTC" as const,
      approximate: true as const,
      generatedAt: at,
    };

    if (parsed.kind === "clock") {
      // ⑤ 时钟坏了：区间与保留期都算不出来。**这不是「没有数据」**，所以
      //    `range` 与 `days` 一起是 null，note 单独有一条 code。
      // ⚠️ **`generatedAt` 与 `pending.ms` 这一档下是 `null`，而那是 wire 级的**：
      //    两者都由 `NaN` 算出，`JSON.stringify` 把 `NaN` 序列化成 `null`
      //    （`c.json` 走的就是它）。**不是 handler 显式写的 null**，但对前端来说
      //    形状一样，所以照样是「拿不到就如实说拿不到」。由那一格用例正面钉着。
      return c.json({
        ...base,
        range: null, days: null, total: null, shards: null, malformed: null,
        pending: wiring === null ? null : pendingBlock(wiring.sink),
        note: (wiring === null ? "tier2_off" : "clock_unavailable") satisfies UsageNote,
      });
    }

    const range = {
      from: parsed.fromDay * USAGE_DAY_MS,
      // 结束日的**最后一毫秒**：回读的是服务端真正覆盖到的那一段，不是 `to` 那一天的零点。
      to: (parsed.toDay + 1) * USAGE_DAY_MS - 1,
      clamped: parsed.clamped,
    };

    if (wiring === null) {
      // ① Tier-2 没开。**`range` 照常回读**（参数是好的），`pending` 是 null
      //    （没有 sink 就没有「未落盘的尾巴」这件事，报 0 是伪造）。
      return c.json({
        ...base, range,
        days: null, total: null, shards: null, malformed: null, pending: null,
        note: "tier2_off" satisfies UsageNote,
      });
    }

    const keys = usageCandidateKeys(at, parsed.from, parsed.to);
    const block = await readShards(wiring.storage, keys);
    const pending = pendingBlock(wiring.sink);

    if (!block.ok) {
      // ② 读不出来。三个字段同生同死（见 `ReadBlock`）。**不是 500**：
      //    `tier` / `range` / `pending` 这三块都还是真的，整条 500 会把它们一起丢掉。
      return c.json({
        ...base, range,
        days: null, total: null, shards: null, malformed: null, pending,
        note: "read_failed" satisfies UsageNote,
      });
    }

    const { byDay, total, shards, malformed } = block.merged;
    const days: Array<{ date: string; total: UsageBucket }> = [];
    // ── 这个循环的上界，以及那个 `n < USAGE_DAY_RETAIN` 到底在守什么 ──────────
    //
    // **格数的上界来自夹逼，不来自那个计数闸**：`fromDay >= usageDayIndex(now) − 29`
    // 且 `toDay <= usageDayIndex(now)` ⇒ 跨度恒 `<= 30`，**对任何有限的 `now` 都成立**。
    // 由「要一整年的区间也只回 30 格 days ——……」那一格钉着（手写字面量 30）。
    //
    // ⚠️⚠️ **那个计数闸今天是一条走不到的路，这是实测 + 算出来的，别读成「它在挡着什么」**
    // （本任务先照 `usageCandidateKeys` 的形状加了它，再变异 M15 把它删掉 ⇒
    // **整份全绿、完整逃逸**（刻意不写死格数，那个数每加一条用例就过期一次）,
    // 回头才算清楚为什么）：
    // 那边那道闸挡的是「`d++` 原地打转」（`d >= 2**53 = 9007199254740992` 时 ULP 超过 1），
    // 而**这个循环体里排在最前的 `utcDateString(d)` 会先抛**——`toISOString()`
    // 只在 `|d × 86_400_000| <= 8.64e15` 即 **`d <= 1e8`** 时成功（两个数都实测过）。
    // `1e8 << 2**53` ⇒ **「`d++` 不前进」与「`toISOString()` 还能成功」互斥**，
    // 循环在打转之前一定已经因为抛而离开了。
    //
    // ⇒ **留着它的理由只有一条，写清楚**：上面那个互斥论证**依赖 `utcDateString` 会抛**。
    // 哪天有人把它改成「抛不出来就回个兜底串」（一个看起来更稳健的改动），互斥当场瓦解，
    // 而失效形态是**不返回**、不是数字变大——那是挂死 isolate，不是一条错数据。
    // 一行结构性的闸换掉那个风险是划算的；**但它不是今天的护栏，别在报告里那么写。**
    //
    // ⚠️ **另有一条残留，如实登记、不为它加 try/catch**：`now` 大到 `d > 1e8` 时
    // 这条端点是 **500**（`RangeError`）。它**从 `Date.now()` 到不了**（两个生产入口
    // 的时钟都是它），而为一条到不了的路加防御正是本仓用 `String()` 那一课换来的教训
    //（`src/core/admin/usage-stats.ts` 的 `USAGE_MODEL_KEY_MAX_LEN` 上方全文）。
    // 「它返回 500 而不是挂死」由「时钟是 1e300 这种「有限但荒诞」的数：端点必须返回，不许把 isolate 挂死」那一格如实记着。
    for (let d = parsed.fromDay, n = 0; d <= parsed.toDay && n < USAGE_DAY_RETAIN; d++, n++) {
      // ⚠️ **`byDay` 是无原型对象**（`mergeDayShards` 的硬契约）：这里只做下标取值 +
      // `?? null`，**不许调 `.hasOwnProperty()` / `.toString()` 这类 `Object.prototype`
      // 上的方法**——那条原型链上什么都没有，调用会直接 `TypeError`。
      days.push({ date: utcDateString(d), total: byDay[String(d)] ?? EMPTY_DAY });
    }

    return c.json({
      ...base, range, days, shards, malformed, pending,
      /**
       * ⚠️ **`malformed` 那一维先判，而且它把「全坏」与「部分坏」分成两条 code**
       *（评审 C1 + 定向复评 N2）：
       * · 只看 `shards` 的话，「读到了 N 个分片、但每一个都坏」会被报成
       *   「一个分片都没有」——**那是一句假话**；
       * · 而「一部分坏」上一版走的是 `note: null`（「一切正常」那一支）
       *   ——**那是把一份缺了几个分片的数据说成完整的**。
       * 优先级（畸形族 > `range_clamped` > `no_shards` > `null`）的判据写在
       * 本函数上方那张表底下，**订正过一次，别照上一版的顺序读**。
       * ⚠️ 与 `total.requests` 无关（③ vs ④）：有分片而请求数是 0 是**第四种**状态。
       */
      note: (
        // ★ **畸形那两条排在最前**（定向复评 N6）：它们要人去查存储，
        //   而 `range_clamped` 只是一句提示；排在后面会在 `clamped` 恒真的那一档
        //   （见 `parseRange` 上方那张档位表）把它们变成永久静音。
        malformed > 0
          ? (shards === 0 ? "all_malformed" : "partial_malformed")
          : parsed.clamped ? "range_clamped"
            : shards === 0 ? "no_shards"
              : null
      ) satisfies UsageNote | null,
      /**
       * 整段区间的合计。面板拿它当分母，不必自己把 `days` 再加一遍。
       *
       * ⚠️ **别把它写成「恒等于 Σ`days`」**（全称量词落笔前先找反例，这里有一个）：
       * `total` 数的是**读到的每一个分片**，而 `days` 是按分片自报的 `sh.day` 分的键
       * 并且只列区间内的那些天。一个自报 `day` 与它所在的键对不上的分片
       *（手改 KV、写到一半的 `store.json`）会进 `total` 而进不了任何一格 `days`
       * ⇒ 两者相差那一份。**方向是「`total` 只多不少」**，而那正是想要的：
       * 少报一段真实发生过的流量，比多报一段更难被发现。
       */
      total,
    });
  };
}

/**
 * `GET /admin/api/usage/:date`（单日下钻，`date` 是 UTC 的 `YYYY-MM-DD`）。
 *
 * **没有逐请求流水**（设计 §10.6）⇒ 常态下 `note` 恒是 `no_request_detail`，
 * 让面板能渲染那句「需要逐请求粒度请看容器 stdout / Cloudflare Workers Logs」，
 * **而不是给一张永远空着的表**。
 * ⚠️ **代价明写**：`note` 只有一格，出问题时它会被 `read_failed` 这类占掉，
 * 那句指路的话就不显示了。这是刻意的取舍——**出问题的时候先说出问题**，
 * 而「这里本来就没有流水」是一句任何时候都成立的静态说明，面板可以自己常驻。
 *
 * ⚠️ **只把那一天的分片喂进 `mergeDayShards`**：那个函数把每个分片的 `hours`
 * 无差别地加在一起，多日区间下 `hours["13"]` 是**「区间里所有天的 13 点之和」**
 * ——`src/core/admin/usage-stats.ts` 的 `mergeDayShards` 上方把这条列成了硬契约。
 * 拿多日区间的返回值去画单日小时图是错的。
 *
 * ⚠️ **`hours` / `byModel` / `byProtocol` 原样交出去，一个都不重建**：
 * 它们是 `mergeDayShards` 交出来的**无原型对象**，键来自客户端填的模型名
 * （`__proto__` / `toString` / `constructor` 都造得出来）。
 *
 * ⚠️⚠️ **「往普通 `{}` 里搬一遍就会坏」这句话只对一半，两种写法要分开说**
 * （本任务变异实测，**别把它简写成一句**）：
 * · **逐键赋值**（`for (const k of Object.keys(m)) out[k] = m[k]`，`out = {}`）
 *   ⇒ `out["__proto__"] = 桶` 命中 `Object.prototype` 上那个**访问器**，
 *   改的是原型而不是加一个键 ⇒ **那一条彻底消失**。实测：变异 M10' 让
 *   「模型名叫 __proto__ / toString / hasOwnProperty / constructor 时，四条都原样出现在响应里」变红；
 * · **展开**（`{ ...m }`）⇒ **不会坏**。展开走的是 `CreateDataPropertyOrThrow`，
 *   绕过访问器，四个键一个不少。实测：变异 M10（把三处都改成 `{ ...m }`）
 *   **整份全绿、完整逃逸**。
 * ⇒ **写「搬一遍就坏」是一句会被人一试就证伪的话**，而代价是他从此不信这一整段。
 * 这里仍然选「一个都不重建」：两种写法里只有一种是安全的，而记住「哪一种」
 * 比记住「都别搬」贵，且下一个人多半只会记住结论、记不住条件。
 *
 * 由 `tests/contract/admin-usage.test.ts` 的
 * 「模型名叫 __proto__ / toString / hasOwnProperty / constructor 时，四条都原样出现在响应里」
 * 钉着——**它钉得住逐键赋值那一种，钉不住展开那一种**（后者本来就不是缺陷）。
 *
 * ⚠️ **缺席的小时不是「读不出来」**：`hours` 只含有过流量的那些小时。
 * 「这一天读成功了没有」由 `hours` **整块**是不是 `null` 承担，
 * 不由某个小时在不在里面承担——面板对缺席的小时画 0 是对的。
 */
export function usageDateHandler(deps: { usage: UsageWiring | null; now: () => number }) {
  return async (c: Context) => {
    const at = deps.now();
    const wiring = deps.usage;
    // `?? ""` 见 `keyUsageHandler` 里同一句的说明。空串走不过下面那道正则 ⇒ 400。
    const raw = c.req.param("date") ?? "";
    const day = parseUtcDate(raw);
    if (day === null) {
      throw httpError(
        400, "invalid_request_error",
        `date 必须是 UTC 的 YYYY-MM-DD，收到的是：${raw}`,
      );
    }

    const base = {
      tier: wiring === null ? "off" : "tier2",
      timezone: "UTC" as const,
      date: raw,
      approximate: true as const,
      generatedAt: at,
    };
    const empty = { hours: null, byModel: null, byProtocol: null, shards: null, malformed: null };

    if (wiring === null) return c.json({ ...base, ...empty, note: "tier2_off" satisfies UsageNote });
    if (!Number.isFinite(at)) {
      return c.json({ ...base, ...empty, note: "clock_unavailable" satisfies UsageNote });
    }

    const nowDay = usageDayIndex(at);
    if (day > nowDay || day < nowDay - USAGE_DAY_RETAIN + 1) {
      // 那一天整个落在保留期之外。**不是「那天没有请求」，是那天已经不在了**——
      // 报成 `no_shards` 会让运维以为那天真的没人用（全局约束 9）。
      return c.json({ ...base, ...empty, note: "date_out_of_retention" satisfies UsageNote });
    }

    const dayMs = day * USAGE_DAY_MS;
    const keys = usageCandidateKeys(at, dayMs, dayMs);
    const block = await readShards(wiring.storage, keys);
    if (!block.ok) return c.json({ ...base, ...empty, note: "read_failed" satisfies UsageNote });

    const { hours, byModel, byProtocol, shards, malformed } = block.merged;
    return c.json({
      ...base, hours, byModel, byProtocol, shards, malformed,
      note: "no_request_detail" satisfies UsageNote,
    });
  };
}
