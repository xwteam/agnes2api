/**
 * 用量板块的取值判定。
 *
 * ⚠️ **这个板块的全部难点是三态**：「今天真的是 0 次请求」「Tier-2 没开」「读不出来」
 * 在面板上长得一模一样，而它们是三件事。设计文档 §10.6 与它的精度纪律那一条只说了
 * 「接口失败显示 `—`，绝不伪造 `0`」，那覆盖的是第三态；第二态（没开）它另给了一张
 * 说明卡。**本模块把三者变成一个显式的枚举，让板块文件不可能把它们揉在一起。**
 *
 * ── 本模块不写什么（P3d Task 5 评审 I17）──────────────────────────────────────
 * ⚠️ **不许再写一份 `fmtDash` / `fmtPercent`**。`admin-ui/js/pure/format.mjs` 的
 * `fmtDash` 与本模块第一版的 `fmtCell` **三条分支逐条相同、连注释理由都相同**
 * ——那是「改名抄」，而 `tests/ui/pure-boundary.test.ts` 的
 * 「盲区清单不是空的——如实登记按名字扫拦不住的那几类」那一格里，
 * `KNOWN_BLIND_SPOTS` 第一条逐字写着「改名抄：按名字扫抓不住」⇒ **零机器信号**。
 * 同理 `format.mjs` 的 `fmtPercent(num, den)` 已经带着「分母 `<= 0` 返回 —」
 * 这条不变量，重写一遍会让**同一个比率在概览页与用量页显示不同的字**。
 * ⇒ 数字格用 `fmtCount` / `fmtDash`，比率用 `fmtPercent`，
 * **本模块只负责「取哪个数、那个数算哪一种结局」，不负责「怎么写它」。**
 *
 * ── 这个模块与后端 `note` 的分工，一次说清 ───────────────────────────────────
 * `src/http/admin/handlers/usage.ts` 的 `USAGE_NOTES` 是一张**运行期**的 code 表，
 * 而 `note` 那一格是**摘要**：每一条 code 的判据全部来自同一份响应体里的其它字段
 *（`tier` / `range.clamped` / `days === null` / `shards` / `malformed`）。
 * ⇒ 本模块**两条路都走，而且刻意分开**：
 * · 顶部横幅照 `note` 走（后端已经定好优先级，前端再定一次就是第二份知识）；
 * · 「这份数字完不完整」照 `shards` / `malformed` 两个**字段**走（`malformedKind`）。
 * ⚠️ **两条路分开不是冗余，是必需的**：`GET /admin/api/usage/:date` **根本不发**
 * `all_malformed` / `partial_malformed` 这两条 code（它常态恒是 `no_request_detail`），
 * 单日下钻要判「这一天的分解是不是缺了几块」**只能靠字段**。
 * 同一件事在两条端点上有两套判据，本模块用**同一个函数**回答它们两个。
 */

/**
 * 时间范围按钮组。**顺序就是渲染顺序**（设计 §10.6：`24h / 3d / 7d / 30d`）。
 *
 * ⚠️ **`30d` 刻意不是默认档**（P3d 计划待验证清单 U-H）：它一次要发
 * `30 × USAGE_SLOTS` 次子请求，而 Cloudflare 的两页官方文档在「一次调用能发
 * 多少次子请求」上互相对不上（Workers limits 页免费档 50，KV limits 页 1,000，
 * 而前者没有定义 KV 算哪一行）。**在 P3e 的真机验收把它了结之前，
 * 这里、板块文案、以及任何一处注释都不许写成「那些子请求是安全的」。**
 * 能写下来的只有一句：把它做成默认档等于让每一个打开面板的人都先付一次那个赌注。
 */
export const RANGES = ["24h", "3d", "7d", "30d"];

/** 默认档位。见 `RANGES` 上方那段——**不是 `30d`**。 */
export const DEFAULT_RANGE = "24h";

/** UTC 一天的毫秒数。与 `src/core/admin/usage-stats.ts` 的 `USAGE_DAY_MS` 同一个数。 */
const DAY_MS = 86400000;

/** 有限数字，否则 `null`。**`NaN` / `Infinity` / 非数字一律当「没有值」**。 */
function finite(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 普通对象，否则 `null`。数组不算（`days` 的元素才是对象，`days` 自己是数组）。 */
function obj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
}

/**
 * 档位 → 按钮上的文案 key。
 *
 * ⚠️ **一律字面量，禁止把档位名拼进 key**（写成 `t(某个前缀 + range)` 那种；
 * P3d 全局约束 12）：
 * `scripts/check-i18n.mjs` 的第 ④ 条把动态拼出来的 key 一律看成「未被引用」，
 * 而那一条**只报警告、从不 exit 1**。
 * ⚠️⚠️ **别把这句读成「所以有门禁在守」**：那道门禁连本仓主流的
 * `elI18n(tag, key, attrs)` 写法都看不见（352 个 key 里只认得 95 个），
 * **新增 key 的拼写没有任何机器在守**，靠的是评审 + 人工冒烟。
 *
 * 表外返回 `null`，与 `admin-ui/js/pure/registrar.mjs` 的 `failureReasonKey`
 * 同一条纪律：**调用方拿到 `null` 时把原值照实显示出来，绝不冒充任何一档已知档位。**
 */
export function rangeLabelKey(range) {
  switch (range) {
    case "24h": return "usage.range.24h";
    case "3d": return "usage.range.3d";
    case "7d": return "usage.range.7d";
    case "30d": return "usage.range.30d";
    default: return null;
  }
}

/**
 * 时间范围按钮 → 查询参数。**只发 `from` / `to` 两个 epoch 毫秒**，
 * 参数契约由 `src/http/admin/handlers/usage.ts` 的 `parseRange` 钉死
 *（`days` 不是参数，服务端一个字都不认）。
 *
 * ── `from = to − (N − 1) × 86400000`，差一天的后果不是「多一天数据」 ──────────
 * 服务端按**整 UTC 天**取，而「N 天」含今天。发成 `now − N × 86400000` 的话
 * `askedFromDay = 今天 − N`，而保留期起点是 `今天 − (USAGE_DAY_RETAIN − 1)`
 * ⇒ **`30d` 那一档每一次都 `clamped: true`**，面板于是每一次都说
 * 「这段时间早于保留期，只显示了能拿到的部分」——**说到运维不再看它**。
 *
 * ⚠️⚠️ **P3d Task 5 简报 Step 1 给的那段示例代码写的正是 `nowMs - days * 86400000`，
 * 它与本仓后端的契约相反，这里刻意不照抄。** 正反两个方向都由
 * `tests/contract/admin-usage.test.ts` 的
 * 「四个档位按 from = to − (N−1) 天 发：clamped 全是 false；按 N 天发：30d 那一档恒为 true」
 * 那一格钉着（**两边都断言**，只写正向的话「clamped 恒为 false」的实现也全绿）。
 *
 * **区间取整由服务端做**（滚动 30 天会横跨 31 个 UTC 日），前端只发滚动时刻，
 * 并**渲染服务端回读的 `range`**，不自己算显示区间。
 *
 * `nowMs` 不是有限数时返回 `null`：拿 `NaN` 拼查询串会得到 `from=NaN`，
 * 而那是一条 400（`msParam` 的 `Number.isSafeInteger` 判据），
 * 让面板显示「参数发错了」比让它显示「这段时间没有数据」诚实得多。
 */
export function rangeToQuery(range, nowMs) {
  const days = { "24h": 1, "3d": 3, "7d": 7, "30d": 30 }[range];
  if (days === undefined) return null;
  const to = finite(nowMs);
  if (to === null) return null;
  return { from: to - (days - 1) * DAY_MS, to };
}

/**
 * 分片畸形到什么程度。**判据是 `shards` 与 `malformed` 两个字段，不是 `note`。**
 *
 * | 返回值 | 判据 | 意味着 |
 * |---|---|---|
 * | `"unknown"` | 两个字段里有一个不是有限数字（含整块 `null`） | 分片计数本身读不出来 |
 * | `"none"` | `malformed === 0` | 读到的分片全是好的 |
 * | `"all"` | `malformed > 0 && shards === 0` | **读到了分片，但每一个都坏** |
 * | `"partial"` | `malformed > 0 && shards > 0` | **一部分坏 ⇒ 这份数字是不完整的** |
 *
 * ⚠️ **这是本模块唯一回答「分片坏没坏」的地方，两条端点共用它**（见文件头）：
 * 汇总端点在 `note` 里也说了同一件事，单日下钻端点**只说字段**。
 * 让两条端点各写一份判据的后果是它们迟早对同一份响应给出不同的结论。
 */
export function malformedKind(resp) {
  const r = obj(resp);
  if (r === null) return "unknown";
  const shards = finite(r.shards);
  const malformed = finite(r.malformed);
  if (shards === null || malformed === null) return "unknown";
  if (malformed <= 0) return "none";
  return shards === 0 ? "all" : "partial";
}

/**
 * 整块用量的状态。**四态互不重叠。**
 *
 * @returns {"off"|"unavailable"|"empty"|"data"}
 *
 * ⚠️ **判据取的是顶层 `total.requests`，不是 `days` 里有没有非零的一天**，
 * 而这一条不是随手选的：`src/http/admin/handlers/usage.ts` 的 `total` 字段上方
 * 逐字写着「**别把它写成恒等于 Σ`days`**」——一个自报 `day` 与它所在的键对不上的
 * 分片会进 `total` 而进不了任何一格 `days`，方向是「`total` 只多不少」。
 * ⇒ 照 `days` 判会得到「横幅说『这段时间没有请求』，而总请求数那张卡写着 42」。
 * **状态判据必须与卡片除以的那个数同源。**
 *
 * ⚠️⚠️ **`all_malformed` 归 `unavailable`，这一条是本模块自己的裁定，写下理由**：
 * 那一档下 `days` 每天一格全是 0 桶、`total` 也是 0 桶，但**那些 0 不是知识**
 * ——读到的每一个分片都是坏的，我们对这段时间的用量**一无所知**。
 * 把它渲染成 `0` 正是全局约束 9 禁的「伪造 0」，只是这一次伪造的不是「接口失败」
 * 那一档，而是「读到的全是垃圾」那一档。归 `unavailable` ⇒ 六张卡全是 EM DASH，
 * 顶部横幅照 `note` 说 `all_malformed`（「去查存储」），两件事都说准了。
 * ⇒ **`partial_malformed` 不归这里**：那一档确实读到了好分片，数字是真的，
 * 只是不全 —— 由 `malformedKind` 交给板块打「不完整」标记（见 `summaryCards`）。
 */
export function usageState(resp) {
  const r = obj(resp);
  if (r === null) return "unavailable";
  if (r.tier === "off") return "off";
  if (!Array.isArray(r.days)) return "unavailable";
  if (malformedKind(r) === "all") return "unavailable";
  const total = obj(r.total);
  const requests = total === null ? null : finite(total.requests);
  if (requests === null) return "unavailable";
  return requests > 0 ? "data" : "empty";
}

/**
 * 平均延迟。`latencyCount === 0` 时返回 `null` —— **没有样本不等于零延迟**。
 * **调用方拿 `cellKind` 去决定它渲染成哪一种破折号**，本模块不决定它长什么样
 *（见文件头的 I17）。
 */
export function avgLatency(bucket) {
  const b = obj(bucket);
  if (b === null) return null;
  const c = finite(b.latencyCount);
  const sum = finite(b.latencySum);
  if (c === null || sum === null || c <= 0) return null;
  return Math.round(sum / c);
}

/**
 * 一个数字格的三种结局。**这是「三态不许长得一样」在单元格这一层的落点。**
 *
 * | 返回值 | 什么时候 | 板块渲染成 |
 * |---|---|---|
 * | `"value"` | 整块读成功了，而且这一格是个有限数字（**含 0**） | 那个数字 |
 * | `"none"` | 整块读成功了，但这一格没有可用的样本 / 分母 | **`–` EN DASH（U+2013）** |
 * | `"unknown"` | 整块就没读出来（`off` / `unavailable`） | **`—` EM DASH（U+2014）** |
 *
 * ⚠️⚠️ **计数类在 `empty` 态显示 `0` 是对的，别「修」成破折号**：这一次读成功了，
 * 我们**确实知道**答案是零。把真零画成破折号是**反向的撒谎**，与「接口失败伪造 0」
 * 同样严重、方向相反。`empty` 态下 `total.requests` 就是数字 `0` ⇒ 这里返回
 * `"value"` ⇒ 卡上是 `0`。**而同一个 `empty` 态下比率与平均延迟走的是 `"none"`**
 *（分母是 0、样本是 0），两类卡因此在同一个状态下长得不一样 —— 那正是要的。
 *
 * ⚠️ **两个破折号必须视觉可区分，而判据在这里、不在板块文件里**：让板块自己
 * 目测「这一格该画哪一根」就等于把三态判定复制回了 DOM 拼装代码。
 */
export function cellKind(state, value) {
  if (state === "off" || state === "unavailable") return "unknown";
  return finite(value) === null ? "none" : "value";
}

/**
 * 比率格的结局。**分母 `<= 0` 就是「没有比率可算」，不是「比率是 0%」。**
 *
 * 与 `format.mjs` 的 `fmtPercent` 那条「分母 `<= 0` 返回 —」是同一条不变量的
 * 两个面：`fmtPercent` 回答「写成什么字」，这里回答「这一格属于三态里的哪一态」。
 * ⚠️ **少了这一层，`empty` 与 `unavailable` 在比率卡上会长得一模一样**：
 * `fmtPercent(0, 0)` 与 `fmtPercent(null, null)` **都返回 EM DASH**，
 * 而前者的意思是「这段时间没有请求」、后者是「读取失败」。
 */
export function ratioKind(state, den) {
  const d = finite(den);
  return cellKind(state, d === null || d <= 0 ? null : d);
}

/**
 * 六张汇总卡要的那几个数（设计 §10.6：
 * `总请求数 / 成功率 / 平均延迟 / 错误率 / Token（仅非流式）/ 流式请求数`）。
 *
 * **全部取自顶层 `total`**，不自己把 `days` 加一遍——理由与 `usageState` 上方
 * 那段同源（`total` 只多不少，自己加会**少报**一段真实发生过的流量，
 * 而少报比多报更难被发现）。
 *
 * `complete` **由 `malformedKind` 驱动，不是常量**（全局约束 10：诚实标记由
 * 后端字段驱动）：`"partial"` ⇒ `false` ⇒ 板块必须把这几个数标成不完整的。
 * ⚠️ **`partial_malformed` 那一档的数字是真的，只是不全** —— 渲染成完整的
 * 就是伪造「这份数据是全的」这个印象，而全局约束 9 禁的伪造**不只是伪造 `0`**。
 *
 * 整块读不出来时六格全是 `null`，`complete` 是 `true`（**没有数据就谈不上残缺**
 * ——那一档由 `usageState` 的 `unavailable` 整个接管，六格已经是 EM DASH，
 * 再叠一个「不完整」标记只会让运维以为「有一部分是好的」）。
 */
export function summaryCards(resp) {
  const r = obj(resp);
  const total = r === null ? null : obj(r.total);
  const kind = malformedKind(r);
  const pick = (name) => (total === null ? null : finite(total[name]));
  return {
    requests: pick("requests"),
    success: pick("success"),
    errors: pick("errors"),
    tokensIn: pick("tokensIn"),
    tokensOut: pick("tokensOut"),
    streamingRequests: pick("streamingRequests"),
    latencyMs: avgLatency(total),
    complete: total === null ? true : kind !== "partial",
    malformed: r === null ? null : finite(r.malformed),
  };
}

/**
 * 后端 `note` → i18n key。
 *
 * ⚠️⚠️ **表外返回 `null`，而这一条不是形式主义。**
 * `tests/contract/admin-usage.test.ts` 的
 * 「八种状态两两不同 —— 面板不用猜，也不该猜（但这一格证明不了没有第九种）」
 * 那一格的名字自己就把边界说清了：它证明的是**已列出的那八种互不相同**，
 * **不是「没有第九种」**。`src/http/admin/handlers/usage.ts` 的 `USAGE_NOTES`
 * 今天有九条 code，而后端加第十条时这里不会有任何东西红。
 * ⇒ **前端不许假设 `note` 只可能是表内的值**：拿到表外的 code 时调用方
 * 把它**原样显示出来**（运维至少能拿着那个串去 grep 后端），
 * 绝不退回一句「加载失败」——那会把一条本来说得清的信号抹成一句废话。
 * 这条纪律与 `admin-ui/js/pure/registrar.mjs` 的 `failureReasonKey`
 * / `refuseReasonKey` 逐字相同。
 */
export function usageNoteKey(note) {
  switch (note) {
    case "tier2_off": return "usage.note.tier2Off";
    case "clock_unavailable": return "usage.note.clockUnavailable";
    case "read_failed": return "usage.note.readFailed";
    case "range_clamped": return "usage.note.rangeClamped";
    case "date_out_of_retention": return "usage.note.dateOutOfRetention";
    case "no_shards": return "usage.note.noShards";
    case "all_malformed": return "usage.note.allMalformed";
    case "partial_malformed": return "usage.note.partialMalformed";
    case "no_request_detail": return "usage.note.noRequestDetail";
    default: return null;
  }
}

/**
 * 这条 `note` 该用哪一档横幅。`null` = 不出横幅（`note` 本来就没有）。
 *
 * @returns {"error"|"warn"|"info"|null}
 *
 * ⚠️ **分档判据是「谁需要人去查」，与后端 `note` 的优先级同源**
 *（`src/http/admin/handlers/usage.ts` 的 `usageHandler` 上方那张表底下逐字写着
 * 「畸形要人去查存储，被夹只是一句提示」）：
 * · `error` —— `read_failed` / `clock_unavailable` / 畸形那两条：**要人去查**；
 * · `warn` —— `range_clamped`：只是一句提示；
 * · `info` —— `tier2_off` / `no_shards` / `date_out_of_retention` /
 *   `no_request_detail`：都是「本来就该是这样」的常态说明。
 *
 * ⚠️ **表外的 code 归 `warn`，刻意不归 `info` 也不归 `error`**：
 * 归 `info` 等于把一条读不懂的信号当成常态（那正是 `note: null` 曾经干过的事，
 * 见 `USAGE_NOTES` 的 `partial_malformed` 上方那段），归 `error` 又会在后端
 * 加一条纯提示型 code 的那天把面板变成一片红。
 */
export function noteSeverity(note) {
  if (note === null || note === undefined) return null;
  switch (note) {
    case "read_failed":
    case "clock_unavailable":
    case "all_malformed":
    case "partial_malformed":
      return "error";
    case "range_clamped":
      return "warn";
    case "tier2_off":
    case "no_shards":
    case "date_out_of_retention":
    case "no_request_detail":
      return "info";
    default:
      return "warn";
  }
}

/**
 * 日汇总表的行。**每天一格，缺数据的那天是 0 桶** —— 后端就是这么发的
 *（`src/http/admin/handlers/usage.ts` 的 `days` 字段上方：「恒是『每天一格』，
 * 不是『只列有数据的那几天』」），前端**不许自己补缺口**，那等于把「哪些天该出现」
 * 这条知识复制一份到面板。
 *
 * 整块读不出来（`days` 不是数组）时返回空数组：表本身不渲染，那一档由顶部横幅承担。
 * 形状不对的单行**跳过而不是补零**：一行读不懂就是读不懂，补一行 0 是伪造一天的记录。
 */
export function dayRows(resp) {
  const r = obj(resp);
  if (r === null || !Array.isArray(r.days)) return [];
  const out = [];
  for (const d of r.days) {
    const row = obj(d);
    if (row === null || typeof row.date !== "string" || row.date === "") continue;
    out.push({ date: row.date, total: obj(row.total) });
  }
  return out;
}

/**
 * 单日下钻那三张表（`hours` / `byModel` / `byProtocol`）的行。
 *
 * ⚠️⚠️ **入参是后端交出来的**无原型对象**，键来自客户端填的模型名**
 *（`__proto__` / `toString` / `constructor` 都造得出来，
 * `src/http/admin/handlers/usage.ts` 的 `usageDateHandler` 上方逐条写着）。
 * ⇒ **这里只用 `Object.keys()` + 下标取值**，
 * **不许调 `.hasOwnProperty()` / `.toString()` 这类挂在 `Object.prototype` 上的方法**
 * ——那条原型链上什么都没有，调用会直接 `TypeError`。
 *
 * `sort` 用的是**键的字典序**，不是按请求数降序：键里会出现客户端填进来的任意串，
 * 而按值排序会让同一天的两次刷新在数字相等时给出不同的行序（读的人以为数据变了）。
 * ⚠️ **`hours` 的键是 `"0"`…`"23"`，字典序会把 `"10"` 排在 `"2"` 前面**
 * ⇒ 小时表由调用方传 `numeric: true` 走数值序。**两种序都在这里，板块不自己排。**
 */
export function breakdownRows(map, numeric) {
  const m = obj(map);
  if (m === null) return [];
  const keys = Object.keys(m);
  if (numeric === true) {
    keys.sort((a, b) => {
      const x = finite(Number(a));
      const y = finite(Number(b));
      if (x === null || y === null) return a < b ? -1 : a > b ? 1 : 0;
      return x - y;
    });
  } else {
    keys.sort();
  }
  return keys.map((k) => ({ key: k, total: obj(m[k]) }));
}

/**
 * `capabilities.stats.tokensCoverage`（裸 `string[]` 的协议 **id**）
 * → `GET /admin/api/models` 的 `protocols[].label`（展示名）。
 *
 * ⚠️ **三条都不许走**（P3d Task 5 评审 I20）：
 * ① 本地再写一张 id → 名的映射 —— 那是第二份知识，与
 *    `src/core/admin/protocol-catalog.ts` 的 `PROTOCOLS` 迟早漂；
 * ② 把 id 拼进一个 i18n key（`t(某个前缀 + id)`）—— 违反全局约束 12，
 *    且对 i18n 门禁完全隐身（它只认得引号紧跟在后面的那种字面量引用）；
 * ③ 直接渲染裸 id —— 运维看不懂 `responses` 是哪个协议。
 * `label` **刻意不进 i18n**：它是协议的专名（"OpenAI Chat Completions"），
 * 翻译它只会制造歧义（`ProtocolEntry.label` 上方逐字写着这一条）。
 *
 * ⚠️ **有一条 id 解析不出来就整条退回 `null`，不给半张名单**：
 * 半张名单会让运维**少估**覆盖范围，而这个 tooltip 的全部用途就是回答
 * 「Token 这张卡到底盖住了哪几条协议」。调用方拿到 `null` 时改说一句
 * 「覆盖范围读不出来」，而不是把残缺的那半当成全部。
 */
export function tokensCoverageLabels(coverage, protocols) {
  if (!Array.isArray(coverage) || coverage.length === 0) return null;
  if (!Array.isArray(protocols)) return null;
  const out = [];
  for (const id of coverage) {
    let label = null;
    for (const p of protocols) {
      const entry = obj(p);
      if (entry !== null && entry.id === id && typeof entry.label === "string" && entry.label !== "") {
        label = entry.label;
        break;
      }
    }
    if (label === null) return null;
    out.push(label);
  }
  return out;
}

/**
 * 未落盘的尾巴。`null` = 这条信息本身拿不到（Tier-2 没开，或者整块 `pending` 是 null）。
 *
 * ⚠️⚠️ **`ms` 数的是「距上一次落盘*尝试*多久」，不是「距上一次写成功多久」**
 *（`src/http/usage-sink.ts` 的 `status()` 上方写着全文）⇒ **`count > 0 && ms ≈ 0`
 * 要读作「刚试过、没写成」，不是「没有尾巴」**。判别尾巴的字段是 `count`，**不是 `ms`**。
 * ⇒ 本函数因此**只拿 `count` 当「有没有尾巴」的判据**，`ms` 只原样带出去给文案用。
 *
 * `budgetExhausted` 必须一起带出来：预算耗尽与存储抛错这两种失败态在
 * `count` + `ms` 上长得一模一样，砍掉它面板就只能猜。
 */
export function pendingTail(resp) {
  const r = obj(resp);
  const p = r === null ? null : obj(r.pending);
  if (p === null) return null;
  const count = finite(p.count);
  if (count === null || count <= 0) return null;
  return { count, ms: finite(p.ms), budgetExhausted: p.budgetExhausted === true };
}
