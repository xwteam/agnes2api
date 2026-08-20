import type { Context } from "hono";
import type { LogLevel } from "../../../ports/logger.js";
import type { StoreLogger } from "../../../adapters/logger-store.js";
import { windowIndex } from "../../../core/admin/event-ring.js";

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

/**
 * `after` 不是一个可信输入——它是客户端回传给我们的一个数字，任何人都能直接
 * 拿 curl 打 `?after=` 任意值。**负数一律当缺失处理（评审 C4）**：时间戳没有
 * 负数这回事，放行负数除了让语义变得含糊之外没有任何好处；`candidateKeys()`
 * 自身对负数也已经钳位安全（`Math.max(floor, windowIndex(负数))` 恒等于
 * `floor`），这里拒绝纯粹是让参数语义干净，不是这条安全性质的必要条件。
 */
function afterParam(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * `GET /admin/api/events`。
 *
 * **零 `list()`、零索引读**：`deps.storeLogger.readEvents(after)` 只按
 * `candidateKeys()` 算出来的候选键各 get 一次，且这个次数**对任何 `after` 值都有
 * 硬上界**（`EVENT_WINDOW_RETAIN × EVENT_SLOTS`，评审 C4/C4b 修复），不随"游标
 * 陈旧了多久""部署跑了多久"增长——由 `quota-panel.test.ts` 数着次数钉住。
 *
 * `?after=<ts>&level=<lvl>&limit=<n>`：**归并 → 过滤（after / level）→ 截到 limit**，
 * 顺序不能倒过来——先截断再过滤会把本该出现的旧事件漏掉。
 *
 * **`truncated`（评审 I3）**：`after` + `limit` 组合会让"被截掉的较旧事件永远拉不回来"
 * 这件事在默认参数下天然发生（K 个分片、每片最多 100 条，K≥3 就可能触发默认
 * `limit=200`）。**这本身不是 bug**——环形缓冲的本意就是"新事件比旧事件更值得看"，
 * 但面板必须如实说"这一页不是全部"，不能悄悄吞掉一部分历史却什么都不说。
 *
 * **`cursorAhead`（评审 C6）**：`after` 所在的时间窗比 `now` 所在的时间窗还晚时，
 * `candidateKeys()` 的扫描区间是空的（`fromWindow > nowWindow`，循环一次都不进），
 * 于是 `items` 恒为空、`cursor` 恒为 `null`——**这与"确实没有新事件"在响应体里
 * 完全无法区分**，而触发条件不止运维手动改错时钟：任何一个 isolate 的时钟只要
 * 比当前处理请求的这个 isolate 快，写出的 `ts` 就是"未来值"，一旦被面板当成
 * `cursor` 存起来，后续所有请求都会撞上这堵墙，面板永久空白直到墙钟追上。
 * 如实报出来，前端据此把冻结的游标丢掉重新冷读（见 `pure/events.mjs` 的
 * `bufferStatus`/`sec-events.js` 的 `poll()`）。
 *
 * ⚠️ **评审 C6 二审订正：上一段"任何一个 isolate 的时钟只要快"这句话本身写得
 * 过宽**——判据是 `windowIndex(after) > windowIndex(now)`，**必须跨过一个完整的
 * 时间窗边界（`EVENT_WINDOW_MS`，1 小时）才会触发**，单纯"快了几分钟但还在
 * 同一个窗口内"不会。
 *
 * ⚠️ **评审 F5：上面这句"1 小时"极易被读错，专门澄清一次——这条判据看的是
 * 「有没有跨过窗口边界」，与偏移量的绝对大小无关，"1 小时"只是窗口宽度这个
 * 参照系，不是"至少要偏移这么多"的门槛。** 反例两组，都已实测：偏移仅
 * **2 毫秒**、但恰好跨在窗口边界上（例如 `now` 在窗口末尾前 1ms、`after` 在
 * 下一个窗口的第 1ms）⇒ `cursorAhead: true`；偏移足足 **59 分钟**、但两者仍在
 * 同一个窗口内 ⇒ `cursorAhead: false`。这留了一个真实存在、且**没有任何测试或
 * 代码覆盖**的盲区：
 * `after` 只比 `now` 快、但仍落在同一个窗口时（实测 `after = now + 10min`），
 * `cursorAhead` 是 `false`，但 `candidateKeys()` 算出来的窗口里没有任何真实事件
 * 的 `ts` 能大于这个"未来的" `after`（`events.ts` 上面那行 `filter((e) => after
 * === null || e.ts > after)`），过滤结果照样是空——**与"确实没有新事件"依旧无法
 * 区分，只是这一段盲区自己会在至多一个窗口宽度（≤ `EVENT_WINDOW_MS`）之内自愈**
 * （要么真实时间追上 `after` 所在的窗口，`after` 变回过去、`cursorAhead` 判据
 * 用不上；要么时钟偏移原本就足够大，窗口边界很快被跨过，`cursorAhead` 正常
 * 触发）。**别让这句订正之前的旧话被后人当成"这个角落已经覆盖"**——它没有，
 * 只是自限在一个可以接受的小时间窗里。
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
    const now = deps.now();

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
      // 游标领先于本次请求的时钟（评审 C6）：空结果不代表没有事件，是时钟纠纷。
      cursorAhead: after !== null && windowIndex(after) > windowIndex(now),
      generatedAt: now,
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
