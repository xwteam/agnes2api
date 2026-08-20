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
 * **零 `list()`、零索引读**：`deps.storeLogger.readEvents(after)` 只按
 * `candidateKeys()` 算出来的候选键各 get 一次（由 `quota-panel.test.ts` 数着次数
 * 钉住，评审 C2 之后候选键数是个有界常数，不再随部署年龄增长）。
 *
 * `?after=<ts>&level=<lvl>&limit=<n>`：**归并 → 过滤（after / level）→ 截到 limit**，
 * 顺序不能倒过来——先截断再过滤会把本该出现的旧事件漏掉。
 *
 * **`truncated`（评审 I3）**：`after` + `limit` 组合会让"被截掉的较旧事件永远拉不回来"
 * 这件事在默认参数下天然发生（K 个分片、每片最多 100 条，K≥3 就可能触发默认
 * `limit=200`）。**这本身不是 bug**——环形缓冲的本意就是"新事件比旧事件更值得看"，
 * 但面板必须如实说"这一页不是全部"，不能悄悄吞掉一部分历史却什么都不说。
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

    const { items: merged } = await deps.storeLogger.readEvents(after);
    const filtered = merged
      .filter((e) => after === null || e.ts > after)
      .filter((e) => level === null || e.level === level);
    const items = filtered.slice(0, limit);

    const status = deps.storeLogger.status();
    return c.json({
      items,
      // 归并结果按 ts 降序，`items[0]` 是本页最新的一条；空结果给 null，
      // 前端据此判断「保留上一次的 after」还是「推进到新值」（见 pure/events.mjs 的 nextAfter）。
      cursor: items.length > 0 ? items[0]!.ts : null,
      // **本 isolate** 的自述状态与标识（评审 M2：多 isolate 下相邻两次轮询可能落到
      // 不同 isolate，`buffered`/`dropped`/`budgetExhausted` 因此可能来回跳——
      // 带上 `shardId` 面板才能把"这句话说的是哪一个 isolate"钉清楚）。
      shardId: status.shardId,
      buffered: status.buffered,
      dropped: status.dropped,
      budgetExhausted: status.budgetExhausted,
      // 过滤/截断确实丢掉了一部分本该出现的旧事件（评审 I3）。
      truncated: filtered.length > items.length,
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
 * **同样clamp 到 `MAX_LIMIT`（评审 M3）**：候选键空间在 C2 修完之后已经结构性有界
 * （`EVENT_WINDOW_RETAIN × EVENT_SLOTS`，不再随部署年龄增长），但单次归并结果的
 * 理论上限仍是"候选键数 × 每键 100 条"，直接全量序列化没有必要——与列表端点用
 * 同一个上限，行为可预期。
 *
 * 内容是归并结果**逐行 JSON.stringify**（不是一个 JSON 数组）：这是给人在终端里
 * `grep`/逐行处理用的格式，不是给程序反序列化用的 API。
 */
export function eventsDownloadHandler(deps: { storeLogger: StoreLogger }) {
  return async (c: Context) => {
    const { items } = await deps.storeLogger.readEvents(null);
    const text = items.slice(0, MAX_LIMIT).map((e) => JSON.stringify(e)).join("\n");
    return new Response(text, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="agnes2api-events.txt"',
      },
    });
  };
}
