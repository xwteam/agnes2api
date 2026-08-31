import { TEND_FAILURE_REASONS, type TendResult } from "../registrar/tender.js";

/**
 * 一轮补池的结构化记录。设计文档 §7.3，兑现设计 §11 的承诺
 *（「面板会展示 `TendResult` 的历史」——**这份历史在它出现之前根本不存在**，
 * `tendOnce` 的返回值只被两个入口 `console.log` 一行）。
 *
 * **零 IO 纯函数**（硬约束 2）。落盘在入口层，不在这里。
 *
 * `TendResult` 的严格超集，只多一个 `trigger`：**刻意用 `extends` 而不是把
 * `TendResult` 的字段抄一遍**——抄一遍就会漂，而"两份字段清单悄悄分叉"正是本仓
 * 被咬过的形态。（⚠️ 这里原来写「把**九个**字段抄一遍」，当时 `TendResult` 只有
 * **8** 个字段，9 是加上 `trigger` 之后的 `TendRecord`——评审 m6。现在一个数都不写，
 * 免得再漂：字段清单的唯一真源是 `TendResult` 本身与下面的 `FIELD_CHECKS`。）
 */
export interface TendRecord extends TendResult {
  trigger: TendTrigger;
}

export type TendTrigger = "cron" | "manual";

const TRIGGERS: readonly TendTrigger[] = ["cron", "manual"];

/** 环形上限：最近 50 轮。Cron 每 30 分钟一轮 ⇒ 约 25 小时的补池历史。 */
export const TEND_HISTORY_SIZE = 50;

/**
 * 存储键。**单键、无扇出、名字是固定字面量**——它的**数量**恒为 1，
 * 与 `event:<窗口>:<槽位>` 那个随部署年龄增长的键空间**不是同一类东西**，
 * 因此**不需要 TTL**：那条有界性裁定治的是「键空间无界」，而这里根本没有那根增长轴可关。
 * （给它按 `event:` 的样子配一个 `expiresAt` 是一次类比论证，而参照物不具备
 * 被论证的那条性质——本仓明令禁止的那一种。）
 */
export const TEND_HISTORY_KEY = "tend:history";

/** 一轮的结果 + 是谁触发的 ⇒ 一条历史记录。两个入口共用这一份，不各拼各的。 */
export function toTendRecord(result: TendResult, trigger: TendTrigger): TendRecord {
  return { ...result, trigger };
}

/**
 * **这一轮抛错了**，给它造一条如实的记录（评审发现）。
 *
 * 防住的真实故障：`tendOnce` 一抛，`recordRound` 整个被跳过（它排在 `try` 里、
 * 在 `tendOnce` 之后），而 `catch` 里原来是**裸 `console.error`**、进不了事件缓冲
 * ⇒ `flush()` 首行 `buffer.length === 0` 就 return。实测结果是
 * `{"events": [], "history": null}` ——**面板上这一轮什么都没有，与「注册机根本
 * 没跑」逐字节不可区分**，正是早先那条「实测为零」的同一形态。
 *
 * ⚠️ **它也证伪了当初写下的那句「`tend:history` 每轮汇总
 * 一定在」**：那句话只对**跑完**的轮次成立。`tend:history` 免疫的是**槽位碰撞**
 * （它是固定字面量单键，不在 `event:` 键空间里），不是丢失更新、更不是崩轮。
 *
 * 三个数一律 0 且 `skipped: false`——**`skipped` 有且只有一个含义**
 *（`config.enabled === false`），拿它表示"崩了"就是伪造。归因走
 * `round_crashed`，让时间线上这一格自己说清楚发生了什么。
 */
export function crashedTendRecord(
  o: { at: number; channel: string; durationMs: number; trigger: TendTrigger },
): TendRecord {
  return {
    skipped: false, available: 0, attempted: 0, minted: 0, mintedByChannel: {},
    failures: [{ reason: "round_crashed", channel: o.channel }],
    at: o.at, primaryChannel: o.channel, durationMs: o.durationMs, trigger: o.trigger,
  };
}

/** 环形追加：超出上限丢**最旧**的。返回新数组，不就地改。 */
export function appendTendHistory(
  cur: readonly TendRecord[],
  rec: TendRecord,
  size: number = TEND_HISTORY_SIZE,
): TendRecord[] {
  const merged = [...cur, rec];
  return merged.length > size ? merged.slice(merged.length - size) : merged;
}

/**
 * 逐字段判据。**用 `Record<keyof TendRecord, …>` 而不是一串 `if`**：
 * `TendRecord` 加一个字段时 `tsc` 会在这里报错，逼加字段的人当场表态
 * ——与 `TEND_FAILURE_REASONS` 的双向穷尽、`FIELD_ROLE` 用
 * `Record<keyof KeyRecord, …>` 是同一招。
 *
 * ⚠️ **加字段时要做的那个决定，明写在这里**：加了必填字段之后，**升级前写下的
 * 旧记录会因为缺这个字段被整条丢掉**（并计进 `malformed`）。要么把新字段做成
 * 可选、要么接受最多 50 条历史在升级那一刻清零。上面那条 `tsc` 报错保证这个
 * 决定**会被做**，但**不保证它被做对**——这一条登记为已知盲点。
 */
const FIELD_CHECKS: Record<keyof TendRecord, (v: unknown) => boolean> = {
  at: (v) => Number.isFinite(v),
  trigger: (v) => TRIGGERS.includes(v as TendTrigger),
  primaryChannel: (v) => typeof v === "string",
  // 逐通道铸出数（评审发现）：值必须是有限数字，键不限（通道名是配置来的）。
  mintedByChannel: (v) => typeof v === "object" && v !== null && !Array.isArray(v)
    && Object.values(v as Record<string, unknown>).every((n) => Number.isFinite(n)),
  skipped: (v) => typeof v === "boolean",
  available: (v) => Number.isFinite(v),
  attempted: (v) => Number.isFinite(v),
  minted: (v) => Number.isFinite(v),
  durationMs: (v) => Number.isFinite(v),
  failures: isFailureList,
};

function isFailureList(v: unknown): boolean {
  return Array.isArray(v) && v.every((f) =>
    typeof f === "object" && f !== null
    && typeof (f as { channel?: unknown }).channel === "string"
    // reason 必须是**联合成员**，不只是字符串：面板的失败归因渲染是
    // `switch` + `never` 穷尽检查（设计 §7.3），一个表外的 reason 会掉进
    // `default`；而 `reg.fail.<reason>` 的 i18n 键也只对表里的成员齐全
    //（成员数由 `tests/unit/i18n-dict.test.ts` 的
    // 「TendFailureReason 的每个成员都有 reg.fail.<reason> 键」钉着，不在这里写死）。
    && (TEND_FAILURE_REASONS as readonly string[]).includes((f as { reason?: unknown }).reason as string));
}

function isTendRecord(v: unknown): v is TendRecord {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (Object.keys(FIELD_CHECKS) as Array<keyof TendRecord>).every((k) => FIELD_CHECKS[k](o[k]));
}

/**
 * 从存储里读回来的补池历史。**与 `src/core/admin/event-entry.ts` 的 `narrowShard`
 * 同一条理由：存储里的东西一律不可信。** `tend:history` 是本期新增的第二个
 * 「从存储读回来直接喂给面板」的结构，不做它就是在同一天里制造第二个「读回来不窄化」的口子。
 *
 * ⚠️ **判据比 `narrowEntries` 严，这是刻意的，理由必须写清楚**：
 * 事件条目里 `level`/`msg`/`fields` 承载的是**上游来的证据**，一条只有 `ts` 的
 * 事件仍然是证据，所以那边只丢「结构性不可用」的（`ts` 非有限数）。
 * `TendRecord` 不一样——它是一张**定长表的一行**，每个字段全部由本仓自己的代码
 * 一次性写出，面板把它渲染成一行数字汇总。一行里 `minted` 坏掉的记录不是
 * 「不完整的证据」，是**一行读不得的数**，显示它比丢掉它更容易误导运维。
 * ⇒ 逐字段校验，任一字段不合就整条丢掉并计数。
 */
export function narrowTendHistory(raw: unknown): { entries: TendRecord[]; malformed: number } {
  if (!Array.isArray(raw)) return { entries: [], malformed: 0 };
  const entries = raw.filter(isTendRecord);
  return { entries, malformed: raw.length - entries.length };
}
