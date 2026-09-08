/**
 * **域名台账**：记住「上游到底认不认这个邮箱域名」，好让稳态下一次成功铸号只打
 * 一次 `/api/verification`。
 *
 * **零 IO 纯函数**（硬约束 2）。读写存储在 `src/http/wire.ts` 的 `buildTendDeps`，
 * 本文件连 `ports/storage.js` 都不 import——`tests/unit/source-guards.test.ts` 的
 * 「`src/core/registrar/` 下 import `ports/storage` 的文件数恰好是 0」把这条从
 * 「今天碰巧如此」变成承重。
 *
 * ── 它治的是什么 ──────────────────────────────────────────────────────────
 *
 * 从前每铸一把 key 都 `shuffle(全部域名).slice(0, maxDomainAttempts)`：上一轮刚被拒
 * 过的域名下一轮可能再撞一次，而**每一次撞都要真建一个临时邮箱、真打一次发码请求**。
 * 上游对发码这条路是有限流的，那些注定失败的请求把额度白白烧光。
 *
 * ⚠️⚠️ **两种 400 必须分开，而分开的判据是启发式的，这句话不许被改写成事实。**
 * 上游用 `400` 同时表达「这个域名被屏蔽了」与「你这个出口发得太频繁了」，
 * **正文是唯一的区分线索**，而正文的措辞是别人家服务的实现细节：上游改一次文案、
 * 或者把语言切成别的，`classifySendCode` 的正向识别就会漏。
 * ⇒ 判死走的是**负向匹配**（「不是限流就算屏蔽」），因此必然会误判。
 * 三层东西压着这个误判，缺一层就变成静默的系统性记错：
 * ① 判死要两跳（`n >= 2`）**而且两跳必须来自两轮**（同一轮里的多条观测先折叠成一条，
 *    见 `commitJournal`），一次误分类只让好域名短暂降权；
 * ② `commitJournal` 的**一轮最多学 1 个域名**的钳位（与文案无关，见那里）；
 * ③ `selectDomains` 全序排序**永不 filter** ⇒ 判死的域名照样在候选里，只是排最后。
 *
 * ⚠️ **我们没有见过「域名真被屏蔽」那条 400 的正文长什么样。** 这是知识空白，
 * 不是代码事实。真机抓到一条之后应该把判死改成**正向**匹配，那时误记概率才降到
 * 接近零；在那之前，`registrar.domain_blocked` 事件里带着截断过的上游 `message`，
 * 运维一眼能看出上游是不是换了文案。
 */

import type { Logger } from "../../ports/logger.js";

/**
 * 台账的存储键。**单一固定键，数量恒为 1。**
 *
 * 冒号命名与 `tend:history` / `pool:index` 同族；**刻意不用 `key:` 前缀**——
 * `KeyPoolRepo` 兜底那条 `list("key:")` 会把它扫进来当成一把 key 记录。
 *
 * ⚠️ **写它的时候一律不传 `expiresAt`**：陈旧判定全靠 `OK_TTL_MS` / `BLOCK_TTL_MS`
 * 这两处**值比较**，给整把键配 TTL 就是让 TTL 兼任 staleness 的职责——那正是
 * `src/core/admin/tend-guard.ts` 的 `MANUAL_GUARD_KEY` 与
 * `src/core/admin/tend-history.ts` 的 `TEND_HISTORY_KEY` 各自逐字裁过的读法。
 * 代价明写：这把键会在存储里长期驻留（1 把），永久关掉注册机之后清理靠手工删键。
 */
export const DOMAIN_LEDGER_KEY = "registrar:domains";

/**
 * 台账里最多记几个域名的结论。
 *
 * **键空间有界不等于值有界**：这把键恒为 1 把，但它的**值**是按上游 `listDomains()`
 * 的返回长起来的，而那是别人家服务的返回。这根轴必须显式关掉。
 *
 * 512 的由来：上游今天返回 374 个域名，留出余量。**这是别人家服务的当前取值、
 * 不是常数**（与 `src/adapters/mailbox-yyds.ts` / `src/adapters/mailbox-moemail.ts`
 * 文件头那两个活跃邮箱上限同一性质），所以它**不进面板文案**——把一个「当前取值」
 * 印在面板上，运维会把它当成自己这套部署的事实。
 */
export const DOMAIN_LEDGER_CAP = 512;

/**
 * 一条 `ok` 结论的有效期：7 天。
 *
 * 🟡 **没有实测支撑。** 它本来就自纠错——一个被上游拉黑的 `ok` 域名下次被挑中就会
 * 拿到 400 当场降级——7 天只是给「上游整体换了策略」封一个上界，顺带压住值体积。
 */
export const OK_TTL_MS = 604_800_000;

/**
 * 一条 `blocked` 结论的有效期：24 小时。
 *
 * 🟡 **没有实测支撑**（我们对「上游多久调一次它的黑名单」零观测）。
 * **刻意取 24 小时而不是更长**：一条错记录的寿命上界越短越好，而代价极小——
 * 过期之后它重新进候选，最多多花 1 次发码请求；真黑名单域名会被两跳规则立刻压回去。
 */
export const BLOCK_TTL_MS = 86_400_000;

/** 上游正文进事件之前截断到多少字符。一张边缘挑战页几十 KB，原样进事件环会把
 * `EVENT_RING_SIZE` 那 100 格缓冲一次冲光（`src/adapters/mailbox-yyds.ts` 为同一件事
 * 登记过代价）。 */
export const BODY_SNIPPET_MAX = 512;

/**
 * 一个域名的结论。
 *
 * **第三态 `unknown` 用「不在 `entries` 里」表示**，不给它一个字段——少一个能撒谎的
 * 字段，也省掉「`s: "unknown"` 与不在表里哪个优先」这种没人会去测的分歧。
 */
export interface DomainEntry {
  /** 结论本身。 */
  s: "ok" | "blocked";
  /** 这条结论最后一次被观测到的时刻（epoch ms）。TTL 判定与 LRU 轮换都只看它。 */
  at: number;
  /**
   * **连续同向的轮数。** 方向一变就归 1，这是「判死要两跳」的载体。
   *
   * ⚠️ **数的是轮不是观测条数**：`commitJournal` 先把同一个域名在这一轮里的多条观测
   * 折叠成一条，所以一轮之内最多 +1。**这条不是文风，是「两跳 = 两轮」的全部依据**
   *（不折叠的话，一轮里同一个域名被拒两次就直接判死，而「两跳」压着的正是一次误分类）。
   */
  n: number;
}

/** 台账的值形状。`v` 是形状版本号，将来换形状时靠它整份作废而不是逐字段猜。 */
export interface DomainLedger {
  v: 1;
  updatedAt: number;
  /**
   * **上一轮观测到的上游域名总数。**面板的「未探过」那一格要它。
   *
   * ⚠️ 它是**上一轮记下来的观测值**，不是现打一次 `listDomains()` 问出来的：
   * `GET /admin/api/registrar/status` 今天一次上游请求都不发，为了凑一个总数破掉
   * 这条性质，等于给面板加了一颗每几秒就打一次上游的按钮。取不到就如实回 `null`。
   */
  total: number | null;
  entries: Record<string, DomainEntry>;
}

/** 一份空台账 = **「什么都没记住」**，不是「全被屏蔽」。 */
export function emptyDomainLedger(): DomainLedger {
  return { v: 1, updatedAt: 0, total: null, entries: {} };
}

/**
 * 从存储读回来的台账。**逐字段窄化**（硬约束 8）：`Storage.get` 是裸 `JSON.parse`
 * + `as` 断言，运行期什么形状都可能来。
 *
 * ⚠️ **失败方向是刻意选的，与 `narrowManualGuard` 同一条**：
 * 任一字段读不得 ⇒ **丢掉那一条**；整个对象读不得 ⇒ 返回**空台账**。
 * 也就是「什么都没记住，多探几次」，**绝不返回「全被屏蔽」**——后者会让注册机
 * 一把 key 都铸不出来，而面板上看不出任何原因。
 */
export function narrowDomainLedger(raw: unknown): DomainLedger {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyDomainLedger();
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return emptyDomainLedger();
  const src = o.entries;
  const entries: Record<string, DomainEntry> = {};
  if (typeof src === "object" && src !== null && !Array.isArray(src)) {
    for (const [domain, v] of Object.entries(src as Record<string, unknown>)) {
      if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
      const e = v as Record<string, unknown>;
      if (e.s !== "ok" && e.s !== "blocked") continue;
      if (!Number.isFinite(e.at) || !Number.isFinite(e.n)) continue;
      entries[domain] = { s: e.s, at: e.at as number, n: e.n as number };
    }
  }
  return {
    v: 1,
    updatedAt: Number.isFinite(o.updatedAt) ? (o.updatedAt as number) : 0,
    total: Number.isFinite(o.total) && (o.total as number) >= 0 ? (o.total as number) : null,
    entries,
  };
}

// ── 发码响应的分类 ──────────────────────────────────────────────────────────

/**
 * 一次 `/api/verification` 的分类结果。
 *
 * `rate_limited_edge` 与 `rate_limited_app` 是**两层不同的限流**，实测形态不同：
 * · edge：上游前面那层边缘网关，`429` + 纯文本正文（不是 JSON），惩罚窗口按分钟计，
 *   且**窗口内每打一次就把窗口续一次**；
 * · app：上游应用自己的注册限流，`400` + 它自己的 JSON 错误体。
 * 两层的处置在本仓是**同一个**（立刻结束整轮 + 记退避），层级只由退避键的 `kind`
 * 与事件字段带出去 —— 所以 `TendFailureReason` 里**没有**为它们各加一个成员。
 */
export type SendCodeClass =
  | "ok"
  | "domain_blocked"
  | "rate_limited_edge"
  | "rate_limited_app"
  | "upstream_error"
  /**
   * **正文里没有任何可判据的东西**（空正文 / 只有空白）。
   *
   * ⚠️ 它不是「域名被屏蔽」的同义词：判死走的是负向匹配，而负向匹配至少要先有
   * 一段正文可读。这一档**不产生任何域名判定**，当次只换下一个域名——与台账出现
   * 之前的行为逐字一致。
   */
  | "unreadable";

/**
 * 应用层限流的正文词表。**全小写子串匹配。**
 *
 * ⚠️⚠️ **这是启发式，不是协议。** 它命中 ⇒ 判限流（安全）；它不命中 ⇒ 判域名屏蔽
 *（有风险）。上游改一次措辞、或者把响应语言切成别的，这张表就漏。
 * 漏掉的后果与它的上界写在本文件头，唯一与文案无关的那道防线是
 * `commitJournal` 的一轮 1 条钳位。
 */
const RATE_LIMIT_MARKERS: readonly string[] = [
  "too many",
  "rate limit",
  "ratelimit",
  "too frequent",
  "频繁",
  "次数过多",
];

/**
 * 把一次发码响应分成五档 + 一档「说不出话」。
 *
 * `403` 并进 `rate_limited_edge`：它在本仓从前是一条**死分支**（撞到的实测全是
 * 429 与 400），但并进来比留一条「睡 5 秒接着打」的路安全——后者正是把惩罚窗口
 * 一次次续上的那个形态。
 */
export function classifySendCode(status: number, body: string): SendCodeClass {
  if (status === 429 || status === 403) return "rate_limited_edge";
  if (status === 400) {
    const t = body.trim();
    if (t === "") return "unreadable";
    const lower = t.toLowerCase();
    return RATE_LIMIT_MARKERS.some((m) => lower.includes(m)) ? "rate_limited_app" : "domain_blocked";
  }
  if (status >= 200 && status < 300) return "ok";
  return "upstream_error";
}

/**
 * 边缘限流正文里那个可 grep 的记号（实测形态是 `error code: 1015`）。
 *
 * ⚠️ **它只进事件字段，不参与任何判定**：判据是状态码 `429`，而这一串是别人家
 * 边缘网关的实现细节。让它参与判定就等于把一条外部实现细节焊进控制流。
 */
export function edgeMarker(body: string): string | null {
  return body.includes("1015") ? "1015" : null;
}

/** 上游正文进事件之前的截断。 */
export function bodySnippet(body: string): string {
  const t = body.trim();
  return t.length <= BODY_SNIPPET_MAX ? t : `${t.slice(0, BODY_SNIPPET_MAX)}…`;
}

/** 回查还是命中时整段丢掉。措辞与 `./url.ts` 的 `UNSAFE_MESSAGE` 同一形态。 */
export const UNSAFE_UPSTREAM_MESSAGE = "<上游正文里仍有邮箱地址，已整段丢弃>";

/** 被抹掉的邮箱地址在消息里留下的占位。 */
export const ADDRESS_PLACEHOLDER = "<邮箱地址>";

/**
 * 把上游正文变成可以安全写进事件的一句话：**截断 + 抹掉邮箱地址 + 后置回查**。
 *
 * 为什么非做不可：这条正文是我们自己刚拿一个临时邮箱地址去换来的，上游把那个地址
 * 原样回显进错误体是常见做法。事件会渲染进面板事件板块、进容器 stdout、进
 * `GET /admin/api/events/download`。
 *
 * ⚠️ **纪律与 `./url.ts` 的 `redactInMessage` 逐字同一条：替换完再回头查一遍，
 * 还命中就整段丢掉。** 「我们没想到的编码形态」的后果因此是**少说一句话**，
 * 不是**多漏一个地址**。
 *
 * 🔴 **顺序是「先脱敏、后截断」，反过来会在边界上漏出地址前缀。**
 * 从前是先 `bodySnippet` 再替换：地址正好跨在 512 那一刀上时，**前半截留在正文里**，
 * 而回查查的是**完整**地址、查不出来 ⇒ 一个 `u0@x` 这样的前缀原样进事件。
 * 泄漏量小，但这一段逐字写着「替换完再回头查一遍，还命中就整段丢掉」——
 * 那句纪律在那一档从前是没做到的。现在替换打在**完整正文**上，边界上剩下的一定是
 * 占位符的一部分，不可能是地址的任何一段。
 *
 * ⚠️ **代价明写**：回查只查**完整地址**（含 URL 编码形态），**不查本地部分**。
 * 本地部分是邮箱通道自己生成的短串（形如 `u0`），回查它会把一大堆本来无害的正文
 * 整段丢掉，而那正是这条诊断存在的理由。这是有意取舍，不是遗漏。
 */
export function upstreamMessage(body: string, address: string): string {
  if (address === "") return bodySnippet(body);
  const redacted = body
    .split(address).join(ADDRESS_PLACEHOLDER)
    .split(encodeURIComponent(address)).join(ADDRESS_PLACEHOLDER);
  const out = bodySnippet(redacted);
  // 回查打在**真正会被写出去的那一段**上：替换本身也可能拼出新的一处命中。
  return out.includes(address) || out.includes(encodeURIComponent(address))
    ? UNSAFE_UPSTREAM_MESSAGE
    : out;
}

// ── 候选域名的排序 ──────────────────────────────────────────────────────────

/** Fisher-Yates 洗牌，随机源注入以便测试可复现。 */
function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** 这个域名现在是不是「已知能用」（`ok` 且没过期）。`mintOne` 的第二道保险要它。 */
export function isKnownGood(ledger: DomainLedger, domain: string, now: number): boolean {
  const e = ledger.entries[domain];
  return e !== undefined && e.s === "ok" && now - e.at < OK_TTL_MS;
}

/**
 * 挑这一次尝试要用的候选域名。
 *
 * 🔴 **它是对 `allDomains` 的全序排序 + 取前 N，绝不是 `filter`。**
 * 这条性质是「好域名不可能被永久排除」的**结构性**回答：只要 `allDomains` 非空、
 * `limit >= 1`，返回值就非空 —— 最坏情况（全表被判死）退化成台账出现之前的随机轮换，
 * 而不是「一个候选都挑不出来 ⇒ `attempted` 恒为 0 ⇒ 注册机静默停摆」。
 * 判据 `tests/unit/registrar/domain-ledger.test.ts`「全表判死时选择器仍返回非空，且第一个是 at 最旧的那个」正面钉它。
 *
 * 四档优先级：
 * ① `ok` 且未过 `OK_TTL_MS` —— 按 `at` 旧→新（**LRU 轮换**，别把一个好域名打成
 *    上游风控的焦点）；
 * ② 不在表里的、以及 `ok` 已过期的 —— 用注入的 `rand` 洗牌（真正的未知）；
 * ③ `blocked` 但已过 `BLOCK_TTL_MS`、或 `n === 1` 的「可疑」 —— 按 `at` 旧→新；
 * ④ `blocked` 且 `n >= 2` 且未过期 —— 列表末尾，同样按 `at` 旧→新。
 *
 * ⚠️ **`at` 一轮之内不变**（台账落盘统一在收尾），所以光靠上面那四档，同一轮里的每个
 * 名额都会拿到**同一个**域名 —— 「LRU 轮换」从前只发生在轮与轮之间，而「打成风控焦点」
 * 这件事发生的正是轮内那几次连续注册。`used` 治的就是这一条：本轮已经派出去过的域名
 * **在自己那一档里**排到后面。
 *
 * 🔴 **它只在档内生效，绝不跨档**：跨档的话「只有一个已知 ok 域名 + 一堆判死域名」这种
 * 台账会在第二个名额上把判死的那些顶到前面 —— 那正是台账存在的理由要挡掉的事。
 * 档内没得换时（比如全表只有一个 ok 域名）它自然退回「还是那一个」，这是对的。
 *
 * 同档内 `at` 相同时以域名字典序兜底，好让排序在任何实现上都是确定的
 *（`Array.prototype.sort` 的稳定性只保证「相等元素保持输入顺序」，而输入顺序本身
 * 是上游返回的顺序 —— 那不是我们能断言的东西）。
 */
export function selectDomains(
  ledger: DomainLedger,
  allDomains: readonly string[],
  now: number,
  limit: number,
  rand: () => number,
  /**
   * 本轮每个域名已经被派出去过几次。**只影响档内次序**，不改档。省略 = 谁都没派过。
   *
   * 用次数而不是「派过没派过」的布尔：布尔在名额数多于域名数时会退化成
   *「p q r p p」（第四个名额之后大家都是「派过」，次序又塌回 `at`），
   * 而次数给出的是真正的轮转「p q r p q」。
   */
  used?: ReadonlyMap<string, number>,
): string[] {
  if (allDomains.length === 0) return [];
  // 洗一次牌把「真正未知」那一档的顺序定下来，再用它当 ② 档的档内次序。
  const shuffled = shuffle(allDomains, rand);
  const shuffleRank = new Map<string, number>();
  shuffled.forEach((d, i) => shuffleRank.set(d, i));

  const tierOf = (d: string): 1 | 2 | 3 | 4 => {
    const e = ledger.entries[d];
    if (e === undefined) return 2;
    const age = now - e.at;
    if (e.s === "ok") return age < OK_TTL_MS ? 1 : 2;
    return age >= BLOCK_TTL_MS || e.n <= 1 ? 3 : 4;
  };

  const ranked = allDomains.map((d) => {
    const tier = tierOf(d);
    const e = ledger.entries[d];
    return {
      d,
      tier,
      // 档内第一顺位：本轮派出去得少的排在前面。
      spent: used?.get(d) ?? 0,
      // ② 档没有可信的 `at`（可能压根不在表里），用洗牌名次当档内次序。
      order: tier === 2 ? (shuffleRank.get(d) ?? 0) : (e?.at ?? 0),
    };
  });
  ranked.sort((a, b) =>
    (a.tier - b.tier) || (a.spent - b.spent) || (a.order - b.order)
    || (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  // `limit` 夹到至少 1：返回空数组会让这一次尝试连一个域名都没有，
  // 而本函数的全部价值就在于「永不返回空」。
  return ranked.slice(0, Math.max(1, Math.floor(limit))).map((r) => r.d);
}

// ── 一轮之内收集到的观测 ────────────────────────────────────────────────────

export type DomainVerdict = "ok" | "blocked";

/**
 * 一轮之内收集到的域名观测。**可变数组，`mintOne` 只往里追加**——
 * 它一次存储都不碰，落盘统一由 `tendOnce` 的收尾做（一轮最多 1 次 put）。
 */
export interface DomainJournal {
  observations: Array<{
    domain: string;
    verdict: DomainVerdict;
    /**
     * 上游那句话（已截断 + 已抹掉邮箱地址）。**只有 `blocked` 那一档带得上**，
     * 而且只会被第二跳判死的那条事件用到——运维靠它一眼看出上游是不是换了文案，
     * 而「换了文案」正是本设计的核心风险。
     */
    message?: string;
  }>;
}

export function newJournal(): DomainJournal {
  return { observations: [] };
}

export function recordVerdict(
  journal: DomainJournal, domain: string, verdict: DomainVerdict, message?: string,
): void {
  journal.observations.push(message === undefined ? { domain, verdict } : { domain, verdict, message });
}

/** `commitJournal` 的产物。 */
export interface CommitResult {
  next: DomainLedger;
  /** 内容真的变了吗。**为假时调用方一次 put 都不许发**（写配额账那根轴）。 */
  dirty: boolean;
  /** 被钳位整体作废的疑似 blocked **域名数**（折叠之后，不是观测条数）。非 0 时调用方要记一条事件。 */
  discarded: number;
  /**
   * 这一轮**第二跳判死**的域名。**只有它们该记 `registrar.domain_blocked` 事件。**
   *
   * ⚠️ 第一跳（`n === 1`）刻意**不记事件**：`EVENT_RING_SIZE` 只有 100 格，
   * 冷启动一轮就能产出好几条，第一跳也记会在最该看诊断的那一刻把诊断挤出环。
   */
  newlyBlocked: Array<{ domain: string; n: number; message: string | null }>;
}

/**
 * 把一轮的观测合进台账。
 *
 * 🔴 **一轮最多学 1 条 `blocked` —— 这道钳位是本设计里唯一与上游文案无关的防线。**
 *
 * 同一轮里出现**第 2 条**疑似 `domain_blocked` 时，本轮**已收集的全部** blocked
 * 判定整体作废（`ok` 那些照常写入——一次 2xx 是干净可靠的证据，不需要保护）。
 * 判据取自实测形态：**限流发作是「一轮里连着好几个域名全挂」**，而有台账之后
 * 正常的域名屏蔽是零星的。
 *
 * ⚠️⚠️ **这一格是那条防线的唯一检测点。** 删掉判据
 * `tests/unit/registrar/domain-ledger.test.ts` 的「一轮最多学一条 blocked」之后，
 * 「上游改了限流文案 ⇒ 好域名被成批判死」这个缺陷就重新变成静默的
 *（形态与 `src/core/admin/tend-guard.ts` 登记的「读法 A 的唯一检测点」逐字同源）。
 *
 * **判死要两跳**（`n >= 2`）：第一次只写 `{s:"blocked", n:1}`，选择器把它当「可疑」
 *（排在 unknown 之后、真判死之前，**仍会被选中**，只是优先级低）；第二次才真判死。
 * 一次 2xx 无条件覆盖回 `{s:"ok", n:1}`。
 *
 * 🔴 **两跳 = 两轮，所以同一个域名在这一轮里的多条观测先折叠成一条**（取最后一条 =
 * 这一轮最新的证据）。不折叠的话「两跳」在**一轮之内**就走得完：钳位数的是**域名数**
 *（`Set`），而 `n` 从前是按**观测条数**累加的 —— 同一个域名在一轮里被拒两次 ⇒ 钳位不
 * 触发（size 还是 1）、`n` 直接到 2 ⇒ 一轮之内从 unknown 判死并发出
 * `registrar.domain_blocked`。而本文件头把「判死要两跳」登记为压着误判的第一层，
 * 逐字写着「一次误分类只让好域名短暂降权」。
 *
 * ⚠️ **折叠之后再算钳位**：一个域名这一轮先被拒、后来又成功过，它的结论就是 `ok`，
 * 不该再去凑「疑似 blocked 的域名数」。
 *
 * **学得慢完全可以接受**：我们要的是记住好域名，不是记全所有坏的。
 */
export function commitJournal(
  ledger: DomainLedger,
  journal: DomainJournal,
  now: number,
  total: number | null,
): CommitResult {
  // 一轮之内同一个域名只留最后一条：`Map` 的 `set` 覆盖旧值但保留首次插入的次序。
  const folded = new Map<string, DomainJournal["observations"][number]>();
  for (const o of journal.observations) folded.set(o.domain, o);
  const roundVerdicts = [...folded.values()];

  const blockedDomains = new Set(
    roundVerdicts.filter((o) => o.verdict === "blocked").map((o) => o.domain),
  );
  const clamp = blockedDomains.size >= 2;
  const applied = roundVerdicts.filter((o) => !(clamp && o.verdict === "blocked"));

  const entries: Record<string, DomainEntry> = { ...ledger.entries };
  const newlyBlocked: CommitResult["newlyBlocked"] = [];
  let changed = false;
  for (const o of applied) {
    const prev = entries[o.domain];
    const s = o.verdict === "ok" ? "ok" : "blocked";
    const n = prev !== undefined && prev.s === s ? prev.n + 1 : 1;
    const wasDead = prev !== undefined && prev.s === "blocked" && prev.n >= 2;
    entries[o.domain] = { s, at: now, n };
    if (s === "blocked" && n >= 2 && !wasDead) {
      newlyBlocked.push({ domain: o.domain, n, message: o.message ?? null });
    }
    changed = true;
  }

  // 值的有界性：键空间恒为 1 把，但值的条目数是上游控制的，这根轴必须显式关掉。
  const names = Object.keys(entries);
  if (names.length > DOMAIN_LEDGER_CAP) {
    names.sort((a, b) => (entries[a]!.at - entries[b]!.at) || (a < b ? -1 : a > b ? 1 : 0));
    for (const d of names.slice(0, names.length - DOMAIN_LEDGER_CAP)) delete entries[d];
    changed = true;
  }

  const totalChanged = total !== null && total !== ledger.total;
  const dirty = changed || totalChanged;
  return {
    next: {
      v: 1,
      updatedAt: dirty ? now : ledger.updatedAt,
      total: total ?? ledger.total,
      entries,
    },
    dirty,
    discarded: clamp ? blockedDomains.size : 0,
    newlyBlocked,
  };
}

/**
 * 两份台账合一份。**KV 没有 CAS，这把键是读-改-写**（与 `pool:index` 同一类已知
 * 问题，`src/core/registrar/tender.ts` 的 `reconcileAfterMint` 整段讲的就是它）。
 *
 * 丢一条域名结论只是下一轮重学（便宜），所以这里的合并只把后果从「整份覆盖」
 * 降到「逐域名取更新的那一条」：同名域名取 `at` 更大的那个，`total` 取新的那份。
 */
export function mergeDomainLedger(cur: DomainLedger, next: DomainLedger): DomainLedger {
  const entries: Record<string, DomainEntry> = { ...cur.entries };
  for (const [d, e] of Object.entries(next.entries)) {
    const prev = entries[d];
    if (prev === undefined || e.at >= prev.at) entries[d] = e;
  }
  const names = Object.keys(entries);
  if (names.length > DOMAIN_LEDGER_CAP) {
    names.sort((a, b) => (entries[a]!.at - entries[b]!.at) || (a < b ? -1 : a > b ? 1 : 0));
    for (const d of names.slice(0, names.length - DOMAIN_LEDGER_CAP)) delete entries[d];
  }
  return {
    v: 1,
    updatedAt: Math.max(cur.updatedAt, next.updatedAt),
    total: next.total ?? cur.total,
    entries,
  };
}

/** 面板取数用的汇总，也是判据的观测点。 */
export interface LedgerSummary {
  /** 上一轮观测到的上游域名总数。**取不到就如实回 `null`**，不现打一次上游去凑。 */
  total: number | null;
  ok: number;
  blocked: number;
  suspect: number;
  /** `total` 未知时它也是 `null`——「未探过」是个减法，减数没有就算不出来。 */
  unknown: number | null;
  updatedAt: number | null;
  /** 台账里实际记着几条。与 `cap` 一起说明「值有没有快撑满」。 */
  size: number;
  cap: number;
}

export function summarizeLedger(ledger: DomainLedger, now: number): LedgerSummary {
  let ok = 0;
  let blocked = 0;
  let suspect = 0;
  for (const e of Object.values(ledger.entries)) {
    const age = now - e.at;
    if (e.s === "ok") {
      if (age < OK_TTL_MS) ok++;
      // 过期的 ok 不计进任何一格：它在选择器里退回「未知」那一档，面板照这个口径说话。
    } else if (age >= BLOCK_TTL_MS || e.n <= 1) {
      suspect++;
    } else {
      blocked++;
    }
  }
  const size = Object.keys(ledger.entries).length;
  return {
    total: ledger.total,
    ok,
    blocked,
    suspect,
    unknown: ledger.total === null ? null : Math.max(0, ledger.total - ok - blocked - suspect),
    updatedAt: ledger.updatedAt === 0 ? null : ledger.updatedAt,
    size,
    cap: DOMAIN_LEDGER_CAP,
  };
}

/** 台账读失败时的兜底：**说一声，然后当成什么都没记住**。 */
export function ledgerReadFailed(logger: Logger, err: unknown): DomainLedger {
  logger.log({
    level: "warn",
    event: "registrar.domain_ledger_read_failed",
    msg: "域名台账读不出来，本轮按「什么都没记住」跑（会多探几个域名，不会误判成全被屏蔽）",
    fields: { err: err instanceof Error ? err.message : String(err) },
  });
  return emptyDomainLedger();
}
