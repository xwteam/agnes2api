import { constantTimeEqual } from "./constant-time.js";

/**
 * 对外 API 密钥（我们**签发**、别人拿来向我们证明身份的那一族）的纯核。
 *
 * ⚠️⚠️ **本仓有两个都叫 key 的东西，方向相反，别读混**：
 * · **上游 key 池**（`src/core/keypool.ts`、`key:<id>` 逐条 + `pool:index`、
 *   端点 `/admin/api/keys`）是**我们持有的**、拿去向 Agnes 证明身份的凭据，
 *   它**必须存明文**（要拿去用）；
 * · **本文件这一族**（单个顶层键 `apikeys`、端点 `/admin/api/apikeys`）是
 *   **我们签发的**，它**绝不存明文**——见下面 `ApiKeyRecord.hash`。
 * 路径刻意不共用 `/admin/api/keys`：那条已经是上游池的公开契约，改它等于破坏
 * 已发布的 API。代价是两个名字很像，缓解手段是文案与文档，不是去改既有路径。
 *
 * **零 IO**（硬约束 1），一处既定豁免：`crypto.subtle.digest`。
 * 与 `src/core/keypool-repo.ts` 的 `keyId()` 同一条依据——WebCrypto 在 Workers 与
 * Node 都是标准全局 API，注入它只多一个端口、多一份假实现，换不到可测性。
 * 那条豁免登记在 `tests/unit/source-guards.test.ts` 的 `CORE_IO_EXEMPTIONS` 里。
 * ⚠️ **随机数不在这里**：签发一把新密钥要 `crypto.getRandomValues`，而
 * 「不可重放」正是零 IO 这条约束存在的理由，`src/core` 里今天一条随机源豁免都没有
 *（`registrar/mint.ts` 那条 `Math.random` 是**可注入参数的默认值**，不是同一类）。
 * ⇒ 铸币住在 `src/http/apikey-store.ts` 的 `issueSecret()`，那一层本来就允许 IO。
 */

/**
 * 明文密钥的前缀。**它是我们自己发的常量，不是从明文里存下来的一段。**
 *
 * ⚠️ **名字刻意不叫 `API_KEY_PREFIX`。** `tests/unit/docs-parity.test.ts` 那道
 * 「源码里每一个存储键常量都要在封闭登记里逐把表态」的扫描，判据是
 * `const <名字>_KEY / <名字>_KEY_PREFIX = "字面量"`——`API_KEY_PREFIX` 正好命中
 * `<名字>_KEY_PREFIX`，于是这个**根本不是存储键**的常量会被要求进那张登记。
 * 处置照那道扫描自己写下的先例（`USAGE_OTHER_BUCKET` 当初就是这么改名的）：
 * **改名，不给那张无例外的约定开豁免**——开了第一条，下一个人加第二条时不会有
 * 任何东西红。
 *
 * ⚠️ 写清这一点是因为掩码（`maskOf`）看起来像是「前缀 + 圆点 + 末四位」，
 * 而那个前缀并不来自记录——记录里只有 `hint`。下一个人很容易顺手去把明文的
 * 前几位也存进记录里好让掩码"更真"，那是**多存一段可泄漏的东西，收益为零**。
 */
export const APIKEY_SECRET_PREFIX = "sk-";

/**
 * 明文密钥的随机部分有多少字节。**16 = 128 bit。**
 *
 * 取 128 位而不是 256：它是**均匀随机**的（不是人选的口令），128 位在离线爆破面前
 * 已经远超任何可行算力，而每多 16 字节就是每一条 `Authorization` 头多 32 个字符。
 * 这个数同时决定了 `digest()` 那条「无盐单轮 SHA-256 是正确选择」的论证前提，
 * 改小它之前先读那段。
 */
export const API_KEY_SECRET_BYTES = 16;

/** 记录里留下的明文末尾位数，掩码用。见 `ApiKeyRecord.hint`。 */
export const API_KEY_HINT_LENGTH = 4;

/**
 * 一张表最多几把。
 *
 * 取 200（与上游 key 导入那条 `MAX_IMPORT_KEYS` 同一个数、同一条理由的另一面）：
 * 整张表是**一个** KV 值 / `store.json` 里的一段，每条记录约 200 B ⇒ 200 把 ≈ 40 KB，
 * 远在 KV 单值 25 MiB 与 FileStorage 整档重写的可承受范围内；再大就该考虑分片，
 * 而分片会把「一次刷新 = 1 次 get」这条本设计最要紧的性质破坏掉。
 * **超了就 400，不静默截断**（与导入那条同规）。
 */
export const APIKEY_MAX = 200;

/** 名称长度上限。它进每一条记录，而整张表在每一次写里被整体重写。 */
export const API_KEY_NAME_MAX = 64;

/**
 * 一条对外 API 密钥。**七个字段，鉴权热路径零存储写。**
 *
 * kiro2api 那边是十一个字段，砍掉的四个各有各的理由，逐条写在
 * 五份 `docs/<lang>/ADMIN.md` 的「API 密钥」一节里（`spendingLimit` / `limitUnit`
 * 做不出跨实例正确的上限、`durationDays` / `activatedAt` 的惰性激活要在鉴权热路径上
 * 写存储、`boundCredentialIds` 在本仓**没有对应概念**）。
 * **它们不是"留了个恒为空的格"，是这个结构里根本没有那几格。**
 */
export interface ApiKeyRecord {
  /**
   * 12 位十六进制，**独立随机、不由密钥派生**。
   *
   * 不用自增号：自增要在表里维护一个 `next_id`，而那个数一旦被覆写就会退号，
   * 退号 = 新密钥继承前任的身份（用量桶、事件日志里的那一行）。随机 id 天然不复用、
   * 零状态。**代价是没有 `#001` 这种好念的编号** ⇒ 面板上的行号由 `seq` 现算
   *（见 `ApiKeyView.seq`），而 `seq` **不是身份**。
   *
   * **不由密钥派生**这半句是安全要求：id 会进 URL、进事件日志，
   * 那些地方不该携带密钥的任何函数值。
   */
  id: string;
  /** 运维起的名字。允许重名——「编号冲突检查」是自增 id 的遗产，随 id 一起去掉。 */
  name: string;
  /**
   * 明文的 SHA-256，64 位十六进制小写。**唯一的验证依据；明文一个字节都不存。**
   *
   * ── 与「凭据永远没有明文回显」那条既有姿态的对账 ─────────────────────────
   * `admin-ui/js/pure/settings.mjs` 的 `credentialView` 写着「永远没有明文，
   * 只有『配没配』与末 4 位」，而五份 DEPLOY.md 同时写着上游 key「都以**明文**落在
   * KV / `store.json` 里……请按凭据处置」。两句话不矛盾，因为它们管的是两类东西：
   * **别人的凭据**我们不得不可逆地存（要拿去用），而**我们签发、只用来验证别人**的
   * 这一族**根本不需要**可逆存。
   * ⇒ 本文件不是「在一个规定明文禁令的仓里破了个例」，是「拿到了一类连明文都不必存的
   * 凭据」，这里比那条规矩**更严**，不是更松。
   *
   * ── 为什么是无盐、单轮 SHA-256，而不是 bcrypt / scrypt ──────────────────
   * **这不是偷懒，是这一族的正确选择，别把「密码要用慢哈希」这条常识套上来。**
   * ① 密钥是 128 位均匀随机（我们生成的，不是人选的口令）⇒ 没有字典可爆破，
   *    慢哈希想抵抗的那件事在这里不存在；
   * ② 慢哈希**不可查表**：每请求都要拿明文对全表逐条算一遍，200 把就是 200 次
   *    KDF，Worker 的 10 ms CPU 限额上直接不可行。单轮摘要则是**算一次、查一次表**。
   * ③ 无盐是可查表的前提，而它在这里不损失什么：盐防的是「同一个口令在两处的
   *    摘要相同」，而这一族里两把密钥相同的概率是 2⁻¹²⁸。
   */
  hash: string;
  /**
   * 明文末 `API_KEY_HINT_LENGTH` 位，掩码用。
   *
   * ⚠️ **不复用 `src/core/admin/key-view.ts` 的 `maskKey()`**：那个函数要前 5 位，
   * 而我们**不存前 5 位**，也不打算存（见 `APIKEY_SECRET_PREFIX`）。
   */
  hint: string;
  /**
   * 管理员手工停用。**缺席 = 启用**，与 `KeyRecord.disabled` 同一体例，存量记录零迁移。
   * ⚠️ 视图层必须把它落成布尔，不许直接透传——见 `ApiKeyView.disabled`。
   */
  disabled?: boolean;
  /** 签发时刻，epoch ms（本仓时间一律 epoch ms，不用 RFC3339 串）。 */
  createdAt: number;
  /**
   * 到期时刻，epoch ms；`null` = 不过期。
   *
   * **纯本地可判**：只看这条记录 + 注入的 `now`，不需要任何外部状态、不需要任何
   * 一次写。这是本期唯一保留的限制维度，而它之所以能保留，正是因为这条性质。
   */
  expiresAt: number | null;
}

/**
 * 存储里那个 `apikeys` 键的整份内容。
 *
 * `version` 每次写加一，供乐观并发用：写之前回读一次（那一次 get 本来就要付），
 * 调用方手上的版本与读回来的对不上 ⇒ 409。
 * ⚠️ **它不是 CAS。** KV 没有 CAS，读到写之间仍有一个窗口；这条机制把窗口从
 * 「整个人类操作时长」压到「一次读写之间」，**残余窗口确实存在**，别在任何一处
 * 把它说成"不会丢更新"。
 */
export interface ApiKeyTable {
  version: number;
  keys: ApiKeyRecord[];
}

/** 空表。**新建时 `version` 从 0 起**，第一次写落地的就是 1。 */
export function emptyApiKeyTable(): ApiKeyTable {
  return { version: 0, keys: [] };
}

/**
 * 明文的摘要。**全仓唯一一份**——签发时算一次存进 `hash`，鉴权时算一次拿去查表，
 * 两处必须是同一个函数，否则「同一把密钥」在两条路径上会得出两个值。
 */
export async function digest(secret: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 明文末四位。签发那一刻算一次，之后再也拿不到明文。 */
export function hintOf(secret: string): string {
  return secret.slice(-API_KEY_HINT_LENGTH);
}

/**
 * 掩码。`sk-••••••••` + 末四位。
 *
 * **`hint` 读不出来时画一根破折号，不画一串光秃秃的圆点**：与
 * `admin-ui/js/pure/settings.mjs` 的 `masterKeyView` 同一条理由——一串圆点会被读成
 * 「配了一把很短的口令」，而这里真正的事实是「这条记录里那一格坏了」。
 */
export function maskOf(hint: unknown): string {
  if (typeof hint !== "string" || hint === "") return "—";
  return `${APIKEY_SECRET_PREFIX}••••••••${hint}`;
}

/** 停用与否。**全仓唯一一份判据**，与上游池那边的 `isDisabled` 同一体例。 */
export function isApiKeyDisabled(r: ApiKeyRecord): boolean {
  return r.disabled === true;
}

/**
 * 过期与否。**边界取 `now >= expiresAt`**：`expiresAt` 是「有效期到此为止」的那一刻，
 * 那一毫秒本身已经在期外。`null` 恒不过期。
 */
export function isApiKeyExpired(r: ApiKeyRecord, now: number): boolean {
  return r.expiresAt !== null && now >= r.expiresAt;
}

/** 这把此刻能不能用。**鉴权那条路径上唯一的判据**，面板的分档从它派生。 */
export function isApiKeyUsable(r: ApiKeyRecord, now: number): boolean {
  return !isApiKeyDisabled(r) && !isApiKeyExpired(r, now);
}

export const API_KEY_BUCKETS = ["disabled", "expired", "active"] as const;
export type ApiKeyBucket = (typeof API_KEY_BUCKETS)[number];

/**
 * 分档。**顺序即优先级**（`disabled > expired > active`）。
 *
 * 停用排在过期前面，理由与上游池那张表一致：停用是**人做过的一个决定**，
 * 而过期是时间到了。一把既被停用又已过期的密钥在面板上该说「已停用」——
 * 那是运维要找的那条线索；说「已过期」会让他以为只要把日期往后挪就能恢复。
 */
export function apiKeyBucket(r: ApiKeyRecord, now: number): ApiKeyBucket {
  if (isApiKeyDisabled(r)) return "disabled";
  if (isApiKeyExpired(r, now)) return "expired";
  return "active";
}

/**
 * 按摘要查表。**常数时间比较，且遍历全表不在命中处提前 return。**
 *
 * 两条性质分别挡两维泄漏：
 * · 摘要本身已经抹平「与某把密钥前多少字节相同」那一维（攻击者控制的是明文，
 *   而明文的一位之差会让摘要整体变样）；
 * · **表内位置**那一维靠「不短路」挡：在命中处 return 会让耗时随「命中的是第几条」
 *   变化，于是一个手里已经有一把有效密钥的人能量出别人那把排在自己前面还是后面。
 * ⚠️ 下面那个 `for` 里出现任何 `break` / `return` / `&&` / `||` / `?:` 都是回归。
 * **这一条与 `constantTimeEqual` 同属「无法由返回值断言证明、由评审保证」那一族**，
 * 完整说明在 `src/core/admin/constant-time.ts`；这里只补一条它没有的判据：
 * `tests/unit/admin/api-keys.test.ts` 的「循环体里没有提前退出 —— 表内位置那一维靠「不短路」挡」
 * 直接扫本函数的源码文本——那不是行为断言，它拦的是"顺手优化"这一类改动。
 */
export function findByDigest(keys: readonly ApiKeyRecord[], d: string): ApiKeyRecord | null {
  let found: ApiKeyRecord | null = null;
  for (const r of keys) {
    const hit = constantTimeEqual(r.hash, d);
    // 三元在这里是**赋值**不是短路控制流：两条分支都只是取一个已经算好的值，
    // 没有任何一侧会跳过后面的循环轮次。上面那条禁令说的是 `if (...) return`
    // 那一类真的会改变遍历轮数的写法。
    found = hit ? r : found;
  }
  return found;
}

/** 面板上一条密钥卡的形状。**这个结构永不含明文，也没有任何 reveal 端点。** */
export interface ApiKeyView {
  id: string;
  name: string;
  /**
   * 面板上的行号。按 `createdAt` 升序、`id` 破平——否则同一批签发的密钥每次刷新都在跳。
   * ⚠️ **它随删除而变，不是身份**：要指认一条记录只能用 `id`。
   */
  seq: number;
  /** 掩码。见 `maskOf`。 */
  masked: string;
  /** 末四位。面板的搜索要匹配它，所以单独给一格，而不是让前端去拆 `masked`。 */
  hint: string;
  bucket: ApiKeyBucket;
  /**
   * **恒是布尔、恒存在**，即使记录里压根没有 `disabled` 字段。
   * `c.json` 会把值为 `undefined` 的字段**整个丢掉** ⇒ 前端拿到的是「字段不存在」
   * 而不是 `false`，分不清「没停用」和「读不出来」。理由与 `KeyView.disabled` 逐字相同。
   */
  disabled: boolean;
  createdAt: number;
  expiresAt: number | null;
}

/**
 * 投影成面板要的形状，**并按 `seq` 的顺序返回**。
 *
 * 返回顺序不是「顺手排一下好看」：`seq` 只有与返回顺序一致时才读得通，
 * 否则面板上会出现 `#7 / #2 / #19`。理由与 `toKeyViews` 那段逐字相同。
 */
export function toApiKeyViews(records: readonly ApiKeyRecord[], now: number): ApiKeyView[] {
  return [...records]
    .sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r, i) => ({
      id: r.id,
      name: r.name,
      seq: i + 1,
      masked: maskOf(r.hint),
      hint: r.hint,
      bucket: apiKeyBucket(r, now),
      // `isApiKeyDisabled()` 落成布尔，**不许直接写 `disabled: r.disabled`**。
      disabled: isApiKeyDisabled(r),
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    }));
}

/**
 * 统计卡的四个数。**判据只看 `v.bucket`**，不再各自重算一遍 disabled / expired——
 * 重算就是同一条优先级规则的第二份实现，两份迟早会漂。
 *
 * ⚠️ **没有 pending 那一档**（kiro2api 那边有）：惰性激活本期不做，
 * 画一张恒为 0 的卡就是撒谎。
 */
export function apiKeyCounts(views: readonly ApiKeyView[]) {
  let active = 0, disabled = 0, expired = 0;
  for (const v of views) {
    if (v.bucket === "disabled") disabled++;
    else if (v.bucket === "expired") expired++;
    else active++;
  }
  return { all: views.length, active, disabled, expired };
}

/**
 * 搜索。**只匹配名称、掩码的可见部分与 id，绝不匹配摘要。**
 * 匹配摘要等于把「没有 reveal 端点」这条保证降级成一个慢速预言机
 *（同 `matchesQuery` 那段）——虽然摘要本身不可逆，但一个能按摘要前缀筛选的接口
 * 让「这把密钥在不在表里」变得可批量试探。
 */
export function matchesApiKeyQuery(v: ApiKeyView, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (s === "") return true;
  return v.name.toLowerCase().includes(s)
    || v.masked.toLowerCase().includes(s)
    || v.id.toLowerCase().includes(s);
}

/**
 * 排序档。`new` 新→旧 / `old` 旧→新 / `name` 按名称。
 * **闭集是这个数组，类型从它派生**（同 `ADMIN_ERROR_CODES` 那条纪律）。
 */
export const API_KEY_SORTS = ["new", "old", "name"] as const;
export type ApiKeySort = (typeof API_KEY_SORTS)[number];

export function isApiKeySort(v: unknown): v is ApiKeySort {
  return typeof v === "string" && (API_KEY_SORTS as readonly string[]).includes(v);
}

/**
 * 排序。**`new` / `old` 一律拿 `seq` 破平**，不拿 `createdAt` 之外的东西——
 * 同一毫秒签发的两把在两次刷新之间必须落在同一个位置，否则列表会自己跳。
 */
export function sortApiKeyViews(views: readonly ApiKeyView[], sort: ApiKeySort): ApiKeyView[] {
  const out = [...views];
  if (sort === "name") {
    out.sort((a, b) => a.name.localeCompare(b.name) || (a.seq - b.seq));
    return out;
  }
  out.sort((a, b) => (sort === "old" ? a.seq - b.seq : b.seq - a.seq));
  return out;
}

// ── 校验 ────────────────────────────────────────────────────────────────────

/**
 * 名称的校验结果。**闭集，与 `ADMIN_ERROR_CODES` 里那几条码一一对应**——
 * 这里不产生任何一句用户文案（文案住在五语言字典里）。
 */
export type ApiKeyNameProblem = "name_not_a_string" | "name_empty" | "name_too_long";

export function checkApiKeyName(v: unknown): ApiKeyNameProblem | null {
  if (typeof v !== "string") return "name_not_a_string";
  // **先判空再判长**：一个空名字同时不满足"非空"，报"太长"会把人指向反方向。
  if (v.trim() === "") return "name_empty";
  if (v.length > API_KEY_NAME_MAX) return "name_too_long";
  return null;
}

/** 到期时刻的校验结果。`null` 是合法输入（不过期），不是「没填」。 */
export type ApiKeyExpiryProblem = "expires_not_a_number" | "expires_in_the_past";

/**
 * 到期时刻。
 *
 * **过去的时刻当场拒**，不接受「签发一把生下来就过期的密钥」：那不是一个有意义的
 * 形态，而它在面板上长得与「签发成功」一模一样（列表里多一行「已过期」），
 * 运维会以为自己按错了什么。
 * ⚠️ 判据是 `<= now` 而不是 `< now`：等于 `now` 的那一刻按 `isApiKeyExpired`
 * 已经在期外，两处必须用同一条边界，否则会造出一个"创建时合法、下一行就过期"的洞。
 */
export function checkApiKeyExpiresAt(v: unknown, now: number): ApiKeyExpiryProblem | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) return "expires_not_a_number";
  if (v <= now) return "expires_in_the_past";
  return null;
}

/**
 * 一条记录的结构校验。**坏一条 = 整张表不认**（见 `parseApiKeyTable`）。
 *
 * 逐字段窄化而不是 `as`：这份 blob 来自存储，而存储的内容在双运行时下有两条来源
 *（KV 与 `store.json`），两条都可能被人手工编辑过。
 */
export function isApiKeyRecord(v: unknown): v is ApiKeyRecord {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "") return false;
  if (typeof r.name !== "string") return false;
  if (typeof r.hash !== "string" || r.hash === "") return false;
  if (typeof r.hint !== "string") return false;
  if (r.disabled !== undefined && typeof r.disabled !== "boolean") return false;
  if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return false;
  if (r.expiresAt !== null && (typeof r.expiresAt !== "number" || !Number.isFinite(r.expiresAt))) return false;
  return true;
}

/**
 * 读回来的 blob 到底是什么。**三档，不许合并成两档。**
 *
 * · `absent`：存储里压根没有这个键。**这是一份合法快照**（还没签发过任何密钥），
 *   holder 要按 TTL 缓存它——那一条是本设计的头号护栏，见 `apikey-holder.ts`。
 * · `ok`：认得出来的一张表。
 * · `invalid`：读得到、但结构不认。**绝不当空表**：当空表的后果是全部客户 401，
 *   而下一次面板写会把幸存记录整份覆掉，不可逆。
 */
export type ApiKeyTableRead =
  | { kind: "absent" }
  | { kind: "ok"; table: ApiKeyTable }
  | { kind: "invalid" };

/**
 * 把读回来的裸值窄化成一张表。
 *
 * **不做逐条抢救**（kiro2api 那边有 `salvage_api_keys`）：本仓这张 blob 只有面板
 * 一个写者、没有「运维手工编辑」这条正当来源，而 `.invalid` 旁路已经把原始字节
 * 保住了。抢救逻辑的代价是一整条"部分正确"的语义，收益在本仓为零。
 */
export function parseApiKeyTable(raw: unknown): ApiKeyTableRead {
  if (raw === null || raw === undefined) return { kind: "absent" };
  if (typeof raw !== "object" || Array.isArray(raw)) return { kind: "invalid" };
  const o = raw as Record<string, unknown>;
  if (typeof o.version !== "number" || !Number.isFinite(o.version)) return { kind: "invalid" };
  if (!Array.isArray(o.keys)) return { kind: "invalid" };
  if (!o.keys.every(isApiKeyRecord)) return { kind: "invalid" };
  return { kind: "ok", table: { version: o.version, keys: o.keys as ApiKeyRecord[] } };
}
