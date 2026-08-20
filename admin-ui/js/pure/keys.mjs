/**
 * Key 池板块的**全部取值决策**。板块文件（`js/sec-keys.js`）只剩 DOM 拼装与网络调用。
 *
 * 这不是「顺手拆一下」：admin-ui/README.md 的硬规则 1 就是这么写的
 * （需要测试的逻辑必须放这个目录），而本板块第一版把这些决策留在了板块文件里，
 * 结果 `counts()` 那个「没有数据就当 0」的兜底**直接违反了「绝不伪造 0」**
 * 而没有任何东西能发现——接口一失败，四张汇总卡显示 `0/0/0/0`，
 * 运维看到「可用 0」的第一反应是整池死了。搬到这里之后 `tests/ui/keys.test.ts` 跑得到它。
 *
 * 这个目录下的文件受三条硬规则约束（禁 import、禁浏览器全局、纯文本校验），
 * 规则全文见 admin-ui/README.md。
 */

/**
 * 五个分档。顺序即渲染顺序（汇总卡与筛选下拉共用）。
 *
 * ⚠️ **`disabled` 这一档不是装饰**：后端的 `bucket` 白名单来自 `BUCKETS`，这里漏掉它
 * 的话，运维在筛选下拉里根本选不到「已停用」，而汇总卡也会少一格
 * ——`all` 与另外四格之和对不上，运维看不出那几把 key 去哪了。
 */
export const CARDS = ["all", "fresh", "cooling", "evicted", "disabled"];

/** 自动刷新档位（秒）。**首项是 0 = 关**：面板不替用户决定去轮询。 */
export const AUTO_SECONDS = [0, 30, 60];

/**
 * 汇总卡 / 筛选下拉里的条数。
 *
 * **没有数据时逐项返回 `null`，绝不返回 0。** `null` 会被格式化成 `—`。
 * 返回 0 就是伪造一个「我知道，答案是零」的事实——而字典里那句
 * `common.loadFailed` 逐字写着「读取失败，显示为 —」，两边不能各说各的。
 */
export function cardCounts(data) {
  const c = data && typeof data === "object" ? data.counts : null;
  const out = {};
  for (const k of CARDS) {
    const v = c && typeof c === "object" ? c[k] : null;
    out[k] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return out;
}

/**
 * 分档徽章的样式。**四档必须互不相同**——两档共用一个样式就等于面板分不出它们。
 *
 * `disabled` 取中性的 muted 而不是红：它**不是故障**，是运维自己按下的开关，
 * 用报警色会让人以为出事了。
 */
export function badgeClass(bucket) {
  if (bucket === "disabled") return "badge badge-muted";
  if (bucket === "evicted") return "badge badge-danger";
  if (bucket === "cooling") return "badge badge-warn";
  return "badge badge-ok";
}

/** 分档名的 i18n key。**五条各写一次字面量**，好让 i18n 门禁扫得到。 */
export function bucketLabelKey(bucket) {
  if (bucket === "fresh") return "keys.bucket.fresh";
  if (bucket === "cooling") return "keys.bucket.cooling";
  if (bucket === "evicted") return "keys.bucket.evicted";
  if (bucket === "disabled") return "keys.bucket.disabled";
  return "keys.bucket.all";
}

export function autoLabelKey(sec) {
  if (sec === 30) return "keys.auto.30";
  if (sec === 60) return "keys.auto.60";
  return "keys.auto.off";
}

/**
 * 列表请求的查询串。
 *
 * `q` 必须转义：搜索框里的 `&` / `=` / `#` 不转义会把后面的参数整个吃掉
 * （`?q=a&bucket=evicted` 会被解析成两个参数），而 `bucket` 是个安全过滤器
 * ——用户敲一个 `&` 就能看到与筛选器显示不符的列表。
 * `all` 档**不发 bucket 参数**：后端把无法识别的值当作不筛，发过去只是噪音。
 */
export function keysQuery(state) {
  const parts = [`page=${state.page}`, `size=${state.size}`];
  if (state.bucket && state.bucket !== "all") parts.push(`bucket=${encodeURIComponent(state.bucket)}`);
  if (state.q !== undefined && state.q !== null && state.q !== "") parts.push(`q=${encodeURIComponent(state.q)}`);
  return parts.join("&");
}

/**
 * 冷却剩余毫秒。**只有 cooling 档才有这个值**，其余一律 `null`（渲染成 `—`）。
 *
 * 参照时刻用服务端的 `generatedAt` 而不是浏览器时钟：两者不同源，拿浏览器的 now
 * 去减服务端的 `cooldownUntil`，时钟有偏差时会算出负数或虚高的剩余时间。
 */
export function cooldownRemaining(view, now) {
  if (!view || view.bucket !== "cooling") return null;
  if (typeof view.cooldownUntil !== "number" || !Number.isFinite(view.cooldownUntil)) return null;
  return view.cooldownUntil - now;
}

/** 最近一次错误。没有就是 `null`——**不返回空串**，空串会被渲染成一个空格子而不是 `—`。 */
export function lastErrorParts(view) {
  const s = view && view.stats ? view.stats : null;
  if (!s || typeof s.lastErrorKind !== "string" || s.lastErrorKind === "") return null;
  return { kind: s.lastErrorKind, at: typeof s.lastErrorAt === "number" ? s.lastErrorAt : null };
}

/**
 * 用量格。`approx` **由后端的 `approximate` 驱动**，不是无条件打 `≈`。
 *
 * 一个没有消费者的响应字段迟早会漂：后端说「这批数字是准的」而面板照样打 `≈`
 * （或反过来）就是两边各说各的。响应里没带这个字段时按**近似**处理——
 * 保守方向是「宁可多打一个 ≈」，不是「悄悄宣称精确」。
 */
export function usageParts(view, approximate) {
  const s = (view && view.stats) || {};
  return {
    approx: approximate !== false,
    requests: typeof s.requests === "number" ? s.requests : null,
    success: typeof s.success === "number" ? s.success : null,
  };
}

/**
 * 「最后使用」同样是近似值。
 *
 * 它与计数的 staleness **完全相同**（同一次落盘一起带下去），而 `lastUsedAt` 正是
 * 写消除的头号对象：五语言 DEPLOY.md 的 `POOL_TOUCH_INTERVAL_MS` 那一行逐字写着
 * 「面板『最后使用』的精度最粗到这个间隔」（默认 6 小时）。计数打了 `≈` 而它裸着，
 * 就是同一份不确定性只标了一半——运维恰恰靠这一列判断「这把 key 是不是已经不转了」。
 * **从未使用过（null）时不打 `≈`**：那不是「不准」，那是确定的「没用过」。
 */
export function lastUsedParts(view, approximate) {
  const at = view && typeof view.lastUsedAt === "number" ? view.lastUsedAt : null;
  return { at, approx: at !== null && approximate !== false };
}

/**
 * 「这份响应里有没有可渲染的条目」——**全模块唯一的判据**。
 *
 * 存在的理由：分页复位、列表消息、要不要建表这三处以前各写各的，
 * 其中「`items` 不是数组」一处当空列表、一处放行去建表，一份畸形响应就会走到
 * `for (const v of data.items)` 抛异常。今天后端恒返回数组、走不到，
 * 但三处判据并存本身就是下一次改动的绊子。
 */
export function itemsOf(data) {
  return data && typeof data === "object" && Array.isArray(data.items) ? data.items : null;
}

/**
 * 分页控件的状态。**两条早退分支（读失败 / 空列表）必须一并复位**，
 * 否则读失败之后下面还挂着上一次的「第 1/2 页 · 共 3 条」，那是在展示一份已经不存在的数据。
 */
export function pagerState(data) {
  const items = itemsOf(data);
  if (items === null || items.length === 0) {
    return { prevDisabled: true, nextDisabled: true, info: null };
  }
  const page = typeof data.page === "number" ? data.page : 1;
  const pages = typeof data.pages === "number" ? data.pages : 1;
  const total = typeof data.total === "number" ? data.total : 0;
  return {
    prevDisabled: page <= 1,
    nextDisabled: page >= pages,
    info: { page, pages, total },
  };
}

/**
 * 列表区该显示哪条消息（`null` = 显示表格）。
 *
 * 「池子里还没有 key」与「没有符合条件的 key」必须分开：前者是「去导入」，
 * 后者是「把筛选条件放宽」，指向完全相反的动作。
 */
export function listMessageKey(data, loadError) {
  if (loadError) return "common.loadFailed";
  const items = itemsOf(data);
  if (items === null || items.length > 0) return null;
  const c = cardCounts(data);
  return c.all === 0 ? "keys.empty" : "keys.noMatch";
}
