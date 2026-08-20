/**
 * 事件板块的**全部取值决策**。板块文件（`js/sec-events.js`）只剩 DOM 拼装、
 * 网络调用与 i18n 查表。理由与 `pure/keys.mjs` / `pure/overview.mjs` 同一条
 * （admin-ui/README.md 硬规则 1）。
 *
 * 这个目录下的文件受三条硬规则约束（禁 import、禁浏览器全局、纯文本校验），
 * 规则全文见 admin-ui/README.md。
 */

/** 轮询最短间隔（页面可见、内容有变化时）。 */
export const EVENTS_POLL_MIN_MS = 15_000;
/** 轮询最长间隔（内容连续无变化时指数退避到这里封顶）。 */
export const EVENTS_POLL_MAX_MS = 60_000;

/** 四个日志级别，顺序即级别按钮组的渲染顺序。不含 "all"（那是"不筛"，另处理）。 */
export const LEVELS = ["debug", "info", "warn", "error"];

export function levelLabelKey(level) {
  if (level === "debug") return "ev.level.debug";
  if (level === "info") return "ev.level.info";
  if (level === "warn") return "ev.level.warn";
  if (level === "error") return "ev.level.error";
  return "ev.level.all";
}

/** 级别徽章颜色。与 `pure/keys.mjs` 的 `badgeClass` 同一套配色语义。 */
export function levelBadgeClass(level) {
  if (level === "error") return "badge badge-danger";
  if (level === "warn") return "badge badge-warn";
  return "badge badge-ok"; // debug / info
}

/**
 * `GET /admin/api/events` 的查询串。
 *
 * `level` 为 `"all"`（或任何不认识的值）时**不发这个参数**——与 `keysQuery` 的
 * `bucket` 处理同一条理由：后端把无法识别的值当作不筛，发过去只是噪音。
 */
export function eventsQuery(state) {
  const parts = [];
  if (typeof state.after === "number" && Number.isFinite(state.after)) parts.push(`after=${state.after}`);
  if (LEVELS.includes(state.level)) parts.push(`level=${encodeURIComponent(state.level)}`);
  if (typeof state.limit === "number" && Number.isFinite(state.limit)) parts.push(`limit=${state.limit}`);
  return parts.join("&");
}

/** 「这份响应里有没有可渲染的条目」——同 `pure/keys.mjs` 的 `itemsOf`，全模块唯一判据。 */
export function itemsOf(body) {
  return body && typeof body === "object" && Array.isArray(body.items) ? body.items : null;
}

/** 参与归并的分片数。**没有数据时是 null，不是 0**——那是「不知道」，不是「确实零个」。 */
export function shardsCount(body) {
  const v = body && typeof body === "object" ? body.shards : null;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 环形缓冲的自述状态。**没有数据时逐项 null**（不是 0/false）——那两个字面上恰好
 * 也是"一切正常"的值，混进"读不出来"里会把面板变成在撒谎。
 */
export function bufferStatus(body) {
  const dropped = body && typeof body === "object" ? body.dropped : null;
  const budgetExhausted = body && typeof body === "object" ? body.budgetExhausted : null;
  return {
    dropped: typeof dropped === "number" && Number.isFinite(dropped) ? dropped : null,
    budgetExhausted: typeof budgetExhausted === "boolean" ? budgetExhausted : null,
  };
}

/**
 * 顶部黄条要不要出现。**诚实标记必须由后端字段驱动**（Task 4 评审 I4 的裁定，
 * 在 Task 5 隔了一个任务原样复发过一次）：判据只看 `status.dropped` / `budgetExhausted`
 * 这两个从响应里取出来的值，不许在这里或调用方硬编码一个 true/false。
 * `null`（没有数据）不触发——不知道不等于"有问题"。
 */
export function shouldWarn(status) {
  return status.dropped !== null && status.dropped > 0 || status.budgetExhausted === true;
}

/**
 * 下一次轮询该带的 `after` 游标。
 *
 * `cursor` 为 `null`（本页没有新事件）时**保留当前值**，不能回退成 null 或某个
 * 旧值——那会让下一次轮询把已经看过的事件重新拉一遍。`cursor` 是数字时才推进。
 */
export function nextAfter(current, cursor) {
  return typeof cursor === "number" && Number.isFinite(cursor) ? cursor : current;
}

/**
 * 指数退避的下一个轮询间隔。**有新内容 ⇒ 立刻回到最短间隔**（运维正在盯着，
 * 让它尽快看见后续变化）；**没有新内容 ⇒ 翻倍，封顶到 `EVENTS_POLL_MAX_MS`**。
 */
export function nextPollDelayMs(currentDelayMs, hadNewItems) {
  if (hadNewItems) return EVENTS_POLL_MIN_MS;
  const doubled = currentDelayMs * 2;
  return doubled > EVENTS_POLL_MAX_MS ? EVENTS_POLL_MAX_MS : doubled;
}

/** 轮询状态指示灯该显示哪个状态。三态：暂停 / 出错 / 正常，暂停优先于出错。 */
export function pollIndicatorState(state) {
  if (state.paused) return "paused";
  if (state.lastError) return "error";
  return "active";
}

/** 轮询状态 → i18n key。三条各写一次字面量，好让 i18n 门禁扫得到（同 levelLabelKey）。 */
export function pollIndicatorLabelKey(kind) {
  if (kind === "paused") return "ev.pollStatus.paused";
  if (kind === "error") return "ev.pollStatus.error";
  return "ev.pollStatus.active";
}

/**
 * 搜索框的过滤判据。匹配 `event` / `msg` / `corr` / 字段值（不区分大小写的子串匹配）。
 * `q` 为空串时一律匹配（不筛）。
 */
export function matchesSearch(item, q) {
  const needle = typeof q === "string" ? q.trim().toLowerCase() : "";
  if (needle === "") return true;
  if (!item || typeof item !== "object") return false;
  const haystack = [
    typeof item.event === "string" ? item.event : "",
    typeof item.msg === "string" ? item.msg : "",
    typeof item.corr === "string" ? item.corr : "",
    item.fields && typeof item.fields === "object" ? JSON.stringify(item.fields) : "",
  ].join(" ").toLowerCase();
  return haystack.includes(needle);
}

/**
 * `fields` 对象格式化成一行文本，供渲染时整体塞进一个 `textContent`。
 * **值一律不可信**（可能是攻击者能控制的内容），但这里只做展示格式化，
 * 不做转义/截断——由调用方统一走 `textContent`，不解析成 HTML。
 */
export function formatFields(fields) {
  if (!fields || typeof fields !== "object") return "";
  return Object.entries(fields).map(([k, v]) => `${k}=${v === null ? "null" : String(v)}`).join(" ");
}

/**
 * 按 `corr` 相邻折叠成时间线。**只折叠相邻的**（不是全局按 corr 分组）——
 * 与设计意图一致：同一次操作打出的几条事件在时间上天然挨在一起，
 * 隔着别的事件的两条同名 corr 更可能是巧合，不该被强行拼进同一条时间线。
 *
 * 本期几乎没有事件带 `corr`（P3c 才串进注册机），**无 corr 的每条都是独立的单条组**
 * ——这条函数在"一个 corr 都没有"时必须一样能正确工作（见 `tests/ui/events.test.ts`
 * 的人工冒烟项）。
 */
export function groupEvents(items) {
  if (!Array.isArray(items)) return [];
  const groups = [];
  for (const item of items) {
    const corr = item && typeof item === "object" && typeof item.corr === "string" && item.corr !== ""
      ? item.corr : null;
    const last = groups[groups.length - 1];
    if (corr !== null && last && last.corr === corr) {
      last.items.push(item);
    } else {
      groups.push({ corr, items: [item] });
    }
  }
  return groups;
}

/** 后端给的是 ts 降序（最新在前）；面板要"自动滚动"到最新，按时间正序（旧→新）展示。 */
export function orderForDisplay(items) {
  return Array.isArray(items) ? [...items].reverse() : [];
}

/**
 * 把新拉到的一批（ts 降序，且全部比 `existing` 里任何一条都新——由 `after` 游标保证）
 * 并入客户端已经攒下的视图。**新的在前**，保持整体仍是 ts 降序，与后端契约一致，
 * 只在渲染前的最后一步（`orderForDisplay`）才反转成正序。
 */
export function mergeIntoView(existing, incoming) {
  const inc = Array.isArray(incoming) ? incoming : [];
  const cur = Array.isArray(existing) ? existing : [];
  return [...inc, ...cur];
}
