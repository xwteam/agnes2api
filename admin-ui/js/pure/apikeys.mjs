/**
 * 「API 密钥」板块的**全部取值决策**。板块文件（`js/sec-apikeys.js`）只剩 DOM 拼装
 * 与网络调用（admin-ui/README.md 硬规则 1）。
 *
 * ⚠️⚠️ **本板块说的是「我们签发给别人」的那一族密钥，不是 Key 池那一族。**
 * 两者方向相反：Key 池装的是**我们持有的**上游凭据（拿去向 Agnes 证明身份），
 * 这里是**别人拿来向我们证明身份**的。名字很像是已知代价，
 * 完整对照表在后端 `src/core/admin/api-keys.ts` 的文件头。
 *
 * 这个目录下的文件受三条硬规则约束（禁 import、禁浏览器全局、纯文本校验），
 * 规则全文见 admin-ui/README.md。
 */

/**
 * 四张统计卡。顺序即渲染顺序。
 *
 * ⚠️ **没有 pending 那一档。** kiro2api 那一页有（惰性激活：发出去还没被用过的那些），
 * 而本网关**根本没有惰性激活这个概念**——到期时刻在签发那一刻就定死了。
 * 画一张恒为 0 的卡就是撒谎，那是本仓反复裁过的一类缺陷。
 */
export const AK_CARDS = ["all", "active", "disabled", "expired"];

/** 排序档。**与后端 `API_KEY_SORTS` 逐字对应**，闭集在后端，这里只负责选哪一档。 */
export const AK_SORTS = ["new", "old", "name"];

/**
 * 签发对话框里那几颗到期快捷 chip（天）。**`0` = 不过期**，排在第一位。
 *
 * ⚠️ **文案必须写成「自签发时刻起 N 天」，不许写成「有效期 N 天」。**
 * 后者会被读成 kiro2api 那种**惰性激活**（发出去之后第一次用才开始计时），
 * 而本网关是签发那一刻就把绝对到期时刻算好写进记录——两者在「发了一批备用密钥、
 * 三个月后才启用」这种用法上差得非常远。
 */
export const AK_EXPIRY_DAYS = [0, 7, 30, 90];

/** 一天多少毫秒。签发对话框把「N 天」换算成绝对到期时刻要用。 */
const DAY_MS = 86_400_000;

/**
 * 统计卡上的四个数。
 *
 * **没有数据时逐项返回 `null`，绝不返回 0**（同 `cardCounts`）：
 * `null` 会被格式化成 `—`，而 0 是一句「我知道，答案是零」的假话。
 */
export function akCounts(data) {
  const c = data && typeof data === "object" ? data.counts : null;
  const out = {};
  for (const k of AK_CARDS) {
    const v = c && typeof c === "object" ? c[k] : null;
    out[k] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return out;
}

/**
 * 列表的三种状态，**恒有一种**：
 * · `unreadable` —— 后端说存储里那张表读不出来（`unreadable: true`）；
 * · `error` —— 这次请求本身失败了；
 * · `ok` —— 拿到了一份列表（可能是空的）。
 *
 * ⚠️⚠️ **`unreadable` 与「一把都没有」必须分开，这是本板块最要紧的一条。**
 * 后端在读不出来时同样返回 `keys: []`，拿 `keys.length === 0` 去判就会把
 * 「表坏了、全部客户端正在 401」画成一句「你还没签发过密钥」——
 * 那是本仓反复裁过的三态混一。
 */
export function akListState(data, failed) {
  if (failed) return "error";
  const d = data && typeof data === "object" ? data : null;
  if (d !== null && d.unreadable === true) return "unreadable";
  return "ok";
}

/** 列表里的条目。**读不出来时给空数组**——那时渲染走 `unreadable` 那一支。 */
export function akItems(data) {
  const d = data && typeof data === "object" ? data : null;
  return d !== null && Array.isArray(d.keys) ? d.keys : [];
}

/**
 * 当前这份列表的版本号。**三条写端点都要把它原样带回去。**
 *
 * `null` = 还不知道（没读到 / 读不出来）⇒ 板块必须把写操作整个禁掉：
 * 不带版本号的写会被后端 400，而那时面板给出的错误对运维毫无意义。
 */
export function akVersion(data) {
  const d = data && typeof data === "object" ? data : null;
  const v = d === null ? null : d.version;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 分档徽章的样式。**三档互不相同**——两档共用一个样式等于面板分不出它们。 */
export function akBadgeClass(bucket) {
  // 「已停用」不带颜色修饰类（中性灰）：它不是故障，是运维自己按下的开关。
  // 与 `badgeClass()` 里 Key 池那一族的同名裁定逐字同源。
  if (bucket === "disabled") return "badge";
  if (bucket === "expired") return "badge badge-warn";
  return "badge badge-ok";
}

/** 分档名的 i18n key。**三条各写一次字面量**，好让 i18n 门禁扫得到。 */
export function akBucketLabelKey(bucket) {
  if (bucket === "disabled") return "ak.bucket.disabled";
  if (bucket === "expired") return "ak.bucket.expired";
  return "ak.bucket.active";
}

/** 统计卡标题的 i18n key。同上，逐条字面量。 */
export function akCardLabelKey(card) {
  if (card === "active") return "ak.card.active";
  if (card === "disabled") return "ak.card.disabled";
  if (card === "expired") return "ak.card.expired";
  return "ak.card.all";
}

/** 排序档名的 i18n key。同上，逐条字面量。 */
export function akSortLabelKey(sort) {
  if (sort === "old") return "ak.sort.old";
  if (sort === "name") return "ak.sort.name";
  return "ak.sort.new";
}

/** 到期快捷 chip 的 i18n key。同上，逐条字面量。 */
export function akExpiryLabelKey(days) {
  if (days === 7) return "ak.expiry.d7";
  if (days === 30) return "ak.expiry.d30";
  if (days === 90) return "ak.expiry.d90";
  return "ak.expiry.never";
}

/**
 * 搜索 + 排序之后要渲染的那一批。
 *
 * ⚠️ **匹配只看名称 / 掩码 / id，绝不看别的**：与后端 `matchesApiKeyQuery` 同一条口径。
 * 排序拿 `seq` 破平——同一毫秒签发的两把在两次刷新之间必须落在同一个位置。
 */
export function akVisible(items, q, sort) {
  const s = String(q === null || q === undefined ? "" : q).trim().toLowerCase();
  const rows = items.filter((v) => {
    if (s === "") return true;
    const name = typeof v.name === "string" ? v.name.toLowerCase() : "";
    const masked = typeof v.masked === "string" ? v.masked.toLowerCase() : "";
    const id = typeof v.id === "string" ? v.id.toLowerCase() : "";
    return name.includes(s) || masked.includes(s) || id.includes(s);
  });
  const seq = (v) => (typeof v.seq === "number" ? v.seq : 0);
  if (sort === "name") {
    rows.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")) || (seq(a) - seq(b)));
    return rows;
  }
  rows.sort((a, b) => (sort === "old" ? seq(a) - seq(b) : seq(b) - seq(a)));
  return rows;
}

/**
 * 「清理失效（N）」那颗按钮上的 N。
 *
 * **判据是分档，与后端 `!isApiKeyUsable` 是同一条**：另写一条判据的话，
 * 那颗按钮删掉的条数会与它自己写的数字对不上。
 * ⚠️ **它数的是整张表，不是当前搜索结果**：那颗按钮清的就是整张表里失效的那些，
 * 让它跟着搜索框变会让人以为自己只清掉了看得见的那几条。
 */
export function akPurgeCount(items) {
  return items.filter((v) => v.bucket === "disabled" || v.bucket === "expired").length;
}

/** N = 0 时那颗按钮整个不画（同 kiro2api）：一颗点了什么都不会发生的按钮比没有更糟。 */
export function akPurgeVisible(items) {
  return akPurgeCount(items) > 0;
}

/** 列表为空时那句话选哪一条。**「没有密钥」与「搜索没命中」是两句不同的话。** */
export function akEmptyKey(items, visible) {
  if (items.length === 0) return "ak.empty";
  return visible.length === 0 ? "ak.emptyFiltered" : null;
}

/**
 * 「停用 / 启用」那颗开关上的文案 key。**看的是这一条此刻的状态，不是它将要变成什么。**
 */
export function akToggleLabelKey(item) {
  return item && item.disabled === true ? "ak.action.enable" : "ak.action.disable";
}

/**
 * 签发表单的校验。**返回 `null` 或一个「管理接口错误码 + 它的 params」**。
 *
 * ⚠️⚠️ **刻意返回码而不是 i18n key。** 后端对同一批输入回的正是这三条码
 *（`name_not_a_string` / `name_empty` / `name_too_long`），而「码 → 文案」全仓
 * 只有一份翻译（`js/pure/keys-write.mjs` 的 `ADMIN_ERROR_TEXT_KEY`）。
 * 在这里返回 key 等于把那张表抄第二份，而且带 `{max}` 占位符的那一条会被
 * `scripts/check-i18n.mjs` 的规则⑧ 判成「当成不带参数的裸标签用了」——
 * 那条门禁指出的正是这个形态。
 *
 * 前端这一份存在的理由不是「再实现一遍」，而是**别把一次注定失败的请求发出去**；
 * 真正的边界仍然由后端强制（面板不许假设自己是唯一的调用方）。
 */
export function akNameProblem(name, max) {
  if (typeof name !== "string") return { code: "name_not_a_string" };
  if (name.trim() === "") return { code: "name_empty" };
  const limit = typeof max === "number" && Number.isFinite(max) ? max : 64;
  return name.length > limit ? { code: "name_too_long", params: { max: limit } } : null;
}

/**
 * 把「快捷 chip 选的天数 / 自定义日期」换算成要送给后端的 `expiresAt`。
 *
 * @param days   选中的快捷档（`0` = 不过期）；`null` 表示用的是自定义日期。
 * @param custom 自定义日期（`YYYY-MM-DD`，浏览器 `<input type="date">` 的值）。
 * @param now    当前时刻（epoch ms），由调用方注入——这个目录不许读时钟。
 * @returns `{ value }`（可送）、`{ code }`（后端那批码里的一条）
 *          或 `{ key }`（纯前端的一档：日期没选 / 认不出来）。
 *
 * ⚠️ **自定义日期取那一天的 UTC 结束时刻（次日 00:00:00Z）**，不是当天 00:00。
 * 取当天零点的话，运维选「今天」会得到一把**已经过期**的密钥，
 * 而他要表达的是「用到今天为止」。
 */
export function akExpiresAt(days, custom, now) {
  if (days === 0) return { value: null };
  if (typeof days === "number" && days > 0) return { value: now + days * DAY_MS };
  const s = typeof custom === "string" ? custom.trim() : "";
  const badDate = { key: "ak.err.pickDate" };
  if (s === "") return badDate;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m === null) return badDate;
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + DAY_MS;
  if (!Number.isFinite(at)) return badDate;
  // **过去的时刻走后端那条码**（同一句话在两侧只有一份文案），
  // 而「没选 / 选了个认不出的日期」是纯前端的一档，后端根本收不到它。
  if (at <= now) return { code: "expires_in_the_past" };
  return { value: at };
}

/**
 * 「停用之后最多还要多久才在别处失效」这句话里的那个数（毫秒）。
 *
 * = 这个部署生效的 `APIKEY_CACHE_TTL_MS` + KV 边缘缓存。
 * ⚠️ **两个数都从后端来**（`capabilities` 与 `overview`），**一个都不许在前端写死**：
 * 写死就会在运维调过 TTL 的那天变成一句假话，而这句话是安全相关的。
 * 任何一个读不出来就返回 `null` ⇒ 渲染成 `—`，不编一个数出来。
 */
export function akRevokeDelayMs(cacheTtlMs, edgeCacheMs) {
  const a = typeof cacheTtlMs === "number" && Number.isFinite(cacheTtlMs) ? cacheTtlMs : null;
  const b = typeof edgeCacheMs === "number" && Number.isFinite(edgeCacheMs) ? edgeCacheMs : null;
  if (a === null || b === null) return null;
  return a + b;
}

/**
 * `GET /admin/api/capabilities` 里 `apiKeys` 那一块，窄化成板块要的形状。
 *
 * **一格都不在前端写死**（全局约束 10）。读不出来时 `wired` 取 `null` 而不是
 * `false`：「这个部署没接」与「还不知道接没接」是两回事，前者要画一句话，
 * 后者只该让那块内容暂时不出现。
 */
export function akCapability(cap) {
  const c = cap && typeof cap === "object" ? cap.apiKeys : null;
  const o = c && typeof c === "object" ? c : null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    wired: o === null || typeof o.wired !== "boolean" ? null : o.wired,
    max: o === null ? null : num(o.max),
    nameMax: o === null ? null : num(o.nameMax),
    plaintextRetrievable: o !== null && o.plaintextRetrievable === true,
    cacheTtlMs: o === null ? null : num(o.cacheTtlMs),
  };
}
