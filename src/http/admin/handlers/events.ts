import type { Context } from "hono";
import type { LogLevel } from "../../../ports/logger.js";
import type { StoreLogger } from "../../../adapters/logger-store.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** 与 `keysHandler` 同一份写法（该文件没有导出，这里各自留一份小的，见该文件的说明）。 */
function intParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function levelParam(raw: string | undefined): LogLevel | null {
  return (LEVELS as readonly string[]).includes(raw ?? "") ? (raw as LogLevel) : null;
}

function afterParam(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * `GET /admin/api/events`。
 *
 * **零 `list()`**：`deps.storeLogger.readEvents()` 只做 1 次 `event:index` get +
 * K 次分片 get（由 `quota-panel.test.ts` 数着次数钉住）。
 *
 * `?after=<ts>&level=<lvl>&limit=<n>`：**归并 → 过滤（after / level）→ 截到 limit**，
 * 顺序不能倒过来——先截断再过滤会把本该出现的旧事件漏掉。
 *
 * ⚠️ **`items` 里的字段一律视为完全不可信**：里面会出现上游返回的内容与未鉴权请求的
 * 路径（例如 `admin.login_failed` 的 `fields.path` 就是攻击者能写的值）。这里**不做**
 * 转义或截断——`ConsoleLogger` 的 logfmt 引用是给**控制台**用的，防的是「一个值撕开
 * 一行文本变成好几个字段」；JSON 响应体是结构化的，字段边界由 JSON 语法本身保证，
 * 没有那个问题。后端只做 `c.json()` 序列化，前端一律 `textContent` 渲染——别以为
 * 这里已经清洗过了。
 */
export function eventsHandler(deps: { storeLogger: StoreLogger; now: () => number }) {
  return async (c: Context) => {
    const after = afterParam(c.req.query("after"));
    const level = levelParam(c.req.query("level"));
    const limit = intParam(c.req.query("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);

    const { items: merged, shardCount } = await deps.storeLogger.readEvents();
    const items = merged
      .filter((e) => after === null || e.ts > after)
      .filter((e) => level === null || e.level === level)
      .slice(0, limit);

    const status = deps.storeLogger.status();
    return c.json({
      items,
      // 归并结果按 ts 降序，`items[0]` 是本页最新的一条；空结果给 null，
      // 前端据此判断「保留上一次的 after」还是「推进到新值」（见 pure/events.mjs 的 nextAfter）。
      cursor: items.length > 0 ? items[0]!.ts : null,
      shards: shardCount,
      buffered: status.buffered,
      dropped: status.dropped,
      budgetExhausted: status.budgetExhausted,
      generatedAt: deps.now(),
    });
  };
}

/**
 * `GET /admin/api/events/download`（订正 F8）。
 *
 * **刻意返回裸 `Response` 而不是 `c.text()`**：progress.md 登记的 N2 说「第一个返回
 * 裸 Response 的管理端点一出现，写反的 nosniff 顺序就让它静默少一条头」，而 P3a 的
 * 路由清单下那条变异是**不可观测**的。这里主动把它变成可观测的，并配一条契约断言
 * （见 tests/contract/admin-events.test.ts）。**别顺手改成 `c.text()`**——那会把这条
 * 护栏又变回摆设（变异表已实测：`c.text()` 抓不住这条，两种写法都带 nosniff，
 * 这条差异只能靠注释 + 评审守住）。
 *
 * 内容是归并结果**逐行 JSON.stringify**（不是一个 JSON 数组）：这是给人在终端里
 * `grep`/逐行处理用的格式，不是给程序反序列化用的 API。
 */
export function eventsDownloadHandler(deps: { storeLogger: StoreLogger }) {
  return async (c: Context) => {
    const { items } = await deps.storeLogger.readEvents();
    const text = items.map((e) => JSON.stringify(e)).join("\n");
    return new Response(text, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="agnes2api-events.txt"',
      },
    });
  };
}
