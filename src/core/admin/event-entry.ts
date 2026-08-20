import type { LogEntry } from "../../ports/logger.js";

/**
 * 从存储里读回来的一条事件。**零 IO 纯函数**（硬约束 2）。
 *
 * 与 `LogEntry` 是**两个类型，不是一个**：`LogEntry` 描述「我们写出去的」，
 * 这里描述「存储里读回来的」——后者是前者的严格超集，因为存储里的东西一律不可信。
 * **唯一被校验过的字段是 `ts`**（有限数字），其余一律 `unknown`：类型上不做任何
 * 我们运行期没有真的验过的承诺。把它写成 `LogEntry` 才是最省事的一种做法，
 * 也正是本仓被咬过二十余次的那一种——「类型上说是 `LogLevel`，运行期是 `"loud"`」。
 *
 * 为什么只校验 `ts`：见 `narrowEntries()` 的说明。
 */
export interface EventEntry {
  /** **唯一被校验过的字段**：有限数字。排序键与游标都只看它。 */
  ts: number;
  level?: unknown;
  event?: unknown;
  msg?: unknown;
  corr?: unknown;
  fields?: unknown;
}

/**
 * 一条从存储里读回来的东西能不能当事件用。
 *
 * **判据只有一条：`ts` 是有限数字。** 这不是"校验得不够"，是一条刻意划出来的界线，
 * 把**结构性不可用**与**显示不好看**分开：
 *
 * - **结构性不可用**（丢）：`ts` 缺失 / 不是数字 / 是 `NaN` 或 `±Infinity`。
 *   这类条目无法排序（`b.ts - a.ts` 得 `NaN`，比较器恒回 `NaN`，顺序不变）、
 *   无法当游标（`cursor` 变成 `undefined` 被 `c.json` 整个丢掉，或变成 `NaN`
 *   被序列化成 `null`），于是面板的游标**永远推不动**，稳态读吞吐从包线 70,560
 *   涨到 276,480 次/天。**这条只在默认的「全部级别」档位下成立**——按级别筛选时
 *   畸形条目被 `e.level === level` 滤掉、游标立刻恢复。默认档恰恰是最常用的一档。
 * - **显示不好看**（留）：`level` 不在四个已知级别里、`event`/`msg` 缺失、
 *   `fields` 不是对象。这些只影响某一列怎么渲染，**丢掉它们就是在一次上游异常
 *   之后把整段证据清空**。
 *
 * **`level` 后端一个字都不动**：归一化已经由前端那一份在跑
 * （`admin-ui/js/pure/events.mjs` 的 `effectiveLevel()` 把畸形 level 归到显式的
 * `"unknown"` 档，`ev.level.unknown` 五语言早已齐备）。后端再做一次就是同一个
 * 判据的第二份实现。**代价明写**：畸形 `level` 的条目在「按级别筛选」时选不中，
 * 只在「全部级别」下可见——**已知限制，登记不修**（修它要动 `LogLevel` 联合与
 * `levelParam`，收益只是「能单独筛出畸形条目」）。
 *
 * 方向相反的那一格与其余几格并排放在
 * `tests/unit/admin/event-entry.test.ts` 的「level 不在四个已知级别里的条目」，
 * 一起读才看得出这条界线。
 */
export function isEventEntry(v: unknown): v is EventEntry {
  return typeof v === "object" && v !== null
    && Number.isFinite((v as { ts?: unknown }).ts);
}

/** 逐条窄化。**不就地改入参**，返回新数组。 */
export function narrowEntries(raw: readonly unknown[]): EventEntry[] {
  return raw.filter(isEventEntry);
}

/**
 * 整个分片的窄化 + 丢弃计数。**读写两侧共用这一份**（`src/adapters/logger-store.ts`）。
 *
 * `raw` 不是数组（含 `null` / `undefined` / 字符串 / 数字 / 对象）时回空分片、
 * `malformed` 计 **0**——`null`/`undefined` 是完全正常的路径（这把键还没被写过），
 * 把它们计进 `malformed` 会让一个全新部署一上来就报「有畸形数据」。
 * 只有**分片本身是数组、里面的某几条不是**时才计数，那才是真正需要被说出来的事。
 *
 * `malformed` 恒为 0 正是它的价值：`src/` 里没有任何路径能产出畸形条目，所以它是
 * 那几条 `narrowEntries` 用例在**生产环境里的对照组**——运维手改存储、KV 值损坏、
 * `store.json` 被写坏时，它是唯一能把「面板少了几条事件」和「本来就没有事件」
 * 区分开的信号。
 */
export function narrowShard(raw: unknown): { entries: EventEntry[]; malformed: number } {
  if (!Array.isArray(raw)) return { entries: [], malformed: 0 };
  const entries = narrowEntries(raw);
  return { entries, malformed: raw.length - entries.length };
}

/** 我们自己写出去的一批（`LogEntry`）当然满足 `EventEntry`——这一行让 `tsc` 替我们盯着。 */
const _writeSideIsReadable: (e: LogEntry) => EventEntry = (e) => e;
void _writeSideIsReadable;
