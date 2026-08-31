import type { Context } from "hono";
import type { KeyPoolRepo } from "../../../core/keypool-repo.js";
import { toKeyViews, bucketCounts, matchesQuery, BUCKETS, type Bucket } from "../../../core/admin/key-view.js";

/**
 * 分页档位。**导出的理由与 `KEYS_PURGE_PATH` 那条逐字相同**：五份 `docs/{lang}/API.md`
 * 的 `### GET /admin/api/keys` 参数表里逐份写着这两个数，而
 * `tests/unit/docs-parity.test.ts` 的
 * 「B 格：文档里那几个硬编码数字从真源常量现算（各语言各恰 1 处）」
 * 从这里现算 ⇒ 改了这两个数而文档没跟上，那一格当场红
 *（**这类数改一次，文档就静静变假一次**，而变假之后没有任何自然信号）。
 * **不导出的话判据只能在文档侧手抄第二份**，而那正是被咬过的形态
 *（真实发生过：`GET /admin/api/events` 的 `limit` 文档写 50/200、源码是 200/500，
 * 五种语言逐份同错，全仓零判据）。
 */
export const DEFAULT_SIZE = 20;
export const MAX_SIZE = 200;

function intParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

/**
 * Key 池只读列表。
 *
 * **零 `list()`、零额外读**：走 `deps.repo.all()`，与转发路径**共用同一个 isolate 快照**
 *（设计文档 §2.4 第 1、2 条）。面板每刷新一次不产生独立的存储开销——
 * 这条由 `tests/contract/quota-panel.test.ts` 的
 * 「连打 20 次 /admin/api/keys……get 次数不增加」数着 list/get 次数钉住。
 *
 * **投影永不含明文 key，也没有任何 reveal 端点**：有了它，面板口令泄漏就等于整池泄漏。
 * 这条由 `tests/contract/admin-keys.test.ts` 的「响应体整段文本里都找不到明文 key」钉住。
 */
export function keysHandler(repo: KeyPoolRepo, now: () => number) {
  return async (c: Context) => {
    const at = now();
    const records = await repo.all();
    const all = toKeyViews(records, at);

    const q = c.req.query("q") ?? "";
    const bucketRaw = c.req.query("bucket");
    const bucket = (BUCKETS as readonly string[]).includes(bucketRaw ?? "") ? (bucketRaw as Bucket) : null;

    const filtered = all.filter((v) => (bucket === null || v.bucket === bucket) && matchesQuery(v, q));
    const size = intParam(c.req.query("size"), DEFAULT_SIZE, 1, MAX_SIZE);
    const pages = Math.max(1, Math.ceil(filtered.length / size));
    const page = intParam(c.req.query("page"), 1, 1, pages);
    const items = filtered.slice((page - 1) * size, page * size);

    return c.json({
      items, total: filtered.length, page, size, pages,
      // 计数**永远按整池算**，不受筛选影响：筛选器旁边的条数是「切换过去能看到几条」，
      // 拿筛完的集合去算就恒等于当前这一档的条数，另外三档全是 0。
      counts: bucketCounts(all),
      /** Tier-1 是近似值：并发下少计，且最多晚一个 POOL_TOUCH_INTERVAL_MS 落盘。 */
      approximate: true,
      generatedAt: at,
    });
  };
}
