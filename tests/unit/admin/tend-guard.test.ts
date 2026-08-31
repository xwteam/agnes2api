import { describe, it, expect } from "vitest";
import {
  MANUAL_GUARD_KEY, MANUAL_TEND_COOLDOWN_MS, MANUAL_TENDS_PER_DAY,
  checkManualTend, dayEndsAt, dayIndex, narrowManualGuard, type ManualGuard,
} from "../../../src/core/admin/tend-guard.js";
import { TEND_LOCK_KEY, TEND_LOCK_TTL_MS } from "../../../src/http/admin/tend-lock.js";
import { TEND_HISTORY_KEY } from "../../../src/core/admin/tend-history.js";

/** 某一天的 UTC 零点（day 序号 20000 = 2024-10-04），加上一点偏移当"上午"。 */
const DAY = 86_400_000;
const DAY_START = 20_000 * DAY;
const MORNING = DAY_START + 9 * 3_600_000;

describe("手动补池护栏的两个数字本身就是策略，独立钉死", () => {
  /**
   * ⚠️ **写字面量 `600_000` / `24`，不许写成 `MANUAL_TEND_COOLDOWN_MS` 的等价表达。**
   * 从被测常量推导出来的期望值恒等于实际值，那条断言永远绿（本仓登记的第 6 种假阳性，
   * `ADMIN_TOKEN_MIN_LENGTH` 那一格栽过一次）。这两个数是**对外承诺**：
   * 10 分钟写在设计 §10.2、每天 24 次写进五语言 DEPLOY.md 的配额账。
   */
  it("冷却是 10 分钟，日预算是 24 次", () => {
    expect(MANUAL_TEND_COOLDOWN_MS).toBe(600_000);
    expect(MANUAL_TENDS_PER_DAY).toBe(24);
  });

  /**
   * **三把键的键名逐字钉死，一把都不许漏。**
   *
   * 它们都不带 TTL、要长期驻留在存储里，清理路径（手动删键）写进了五语言 REGISTRAR.md
   * ——改名会让文档教的那条 `wrangler kv key delete` 删掉一把不存在的键，而真正的那把
   * 继续挡着运维。
   *
   * ⚠️ **`TEND_LOCK_KEY` 那一行是评审发现补的，成因是本期第七次同款**：三把键，
   * `MANUAL_GUARD_KEY` 与 `TEND_HISTORY_KEY` 都加了锚，**第三把的镜像另一半留着**。
   * 实测：把 `TEND_LOCK_KEY` 改成 `"registrar_tend_lock_RENAMED"` ⇒ **1816/1816 全绿**。
   * 而这一把恰恰是**两种运行时的 Cron 与面板三处共用**的那一把。
   */
  it("三把键的键名逐字钉死：护栏键 / 补池锁 / 补池历史", () => {
    expect(MANUAL_GUARD_KEY).toBe("registrar_manual_guard");
    expect(TEND_LOCK_KEY).toBe("registrar_tend_lock");
    expect(TEND_HISTORY_KEY).toBe("tend:history");
  });

  /**
   * **锁的有效期是用户可见的**：它进 `409` 响应体的 `until`（面板显示「最晚几点结束」），
   * 也是「释放锁失败之后最长停摆多久」的上界，五语言 REGISTRAR.md 写着 15 分钟。
   *
   * ⚠️ **评审发现：这个数往大改可以全仓逃逸。** 改成 `86_400_000`（24 小时）⇒
   * **1816/1816 全绿**——唯一那个观测点当时写的是 `until: NOW + TEND_LOCK_TTL_MS`，
   * **期望值从被测对象自己推导**（第 6 种假阳性）。
   * 修法照 `roundBudgetMs` 那条：**手写字面量 + 常量本身也钉一次**，
   * 于是「改常量」与「两边一起改」都拦得住。
   */
  it("补池锁的有效期是 15 分钟这个数字本身就是策略，独立钉死", () => {
    expect(TEND_LOCK_TTL_MS).toBe(900_000);
  });
});

describe("dayIndex / dayEndsAt", () => {
  it("按 UTC 自然日切，且 resetAt 恰好是当日 24:00", () => {
    expect(dayIndex(DAY_START)).toBe(20_000);
    expect(dayIndex(DAY_START + DAY - 1), "当日最后一毫秒仍是同一天").toBe(20_000);
    expect(dayIndex(DAY_START + DAY), "跨过 24:00 就是下一天").toBe(20_001);
    expect(dayEndsAt(MORNING)).toBe(DAY_START + DAY);
  });
});

describe("narrowManualGuard", () => {
  /**
   * 存储里的东西一律不可信（`Storage.get` 是裸 `JSON.parse` + `as`）。
   * **方向是刻意的**：读不得就当「今天还没点过」放行一次，而不是当「已经耗尽」。
   * 反过来的话，一把被外部写坏的键会把「立即补池」这颗按钮**永久锁死**，
   * 而面板上看不出任何原因。
   */
  it.each([
    ["null", null],
    ["数组", [1, 2]],
    ["标量", 7],
    ["字符串", "{}"],
    ["缺 used", { day: 1, cooldownUntil: 0 }],
    ["缺 day", { used: 1, cooldownUntil: 0 }],
    ["缺 cooldownUntil", { day: 1, used: 1 }],
    ["used 是字符串", { day: 1, used: "3", cooldownUntil: 0 }],
    ["day 是 NaN", { day: NaN, used: 1, cooldownUntil: 0 }],
  ])("读不得的形态一律返回 null：%s", (_name, raw) => {
    expect(narrowManualGuard(raw)).toBeNull();
  });

  it("三个字段齐全且都是有限数时原样收下", () => {
    expect(narrowManualGuard({ day: 20_000, used: 3, cooldownUntil: 123, 多余字段: "x" }))
      .toEqual({ day: 20_000, used: 3, cooldownUntil: 123 });
  });

  it("读不得 ⇒ 放行一次（fail-open 方向），而不是把按钮永久锁死", () => {
    const v = checkManualTend(narrowManualGuard("坏掉的值"), MORNING);
    expect(v.ok, "读不得就当成「今天还没点过」").toBe(true);
    expect(v.remaining).toBe(MANUAL_TENDS_PER_DAY - 1);
  });
});

describe("checkManualTend", () => {
  const fresh = (over: Partial<ManualGuard> = {}): ManualGuard =>
    ({ day: dayIndex(MORNING), used: 1, cooldownUntil: 0, ...over });

  /**
   * ⚠️ **评审发现：`remaining` 的 ok 分支只在一个数据点（`used = 0`）上被观测过。**
   * 实测：把 `remaining: remaining - 1` 改成常量 `MANUAL_TENDS_PER_DAY - 1` ⇒ **42 格全绿**
   *（其余三处 `remaining` 断言都在 429 分支上，表达式不同，约束不到 ok 分支）。
   * 这是第 5 种假阳性——**而这个字段正是第 3 条护栏「消耗明示」的载体**：
   * 错误实现下面板会永远显示「还剩 23 次」，恰恰是「让运维毫不知情地撞墙」本身。
   *
   * ⚠️ **期望值写手写字面量 `18`，不写 `MANUAL_TENDS_PER_DAY - 6`**：后者从被测常量
   * 推导，把 K 改成 8 也照样绿（第 6 种假阳性，本仓 `ADMIN_TOKEN_MIN_LENGTH` 栽过一次）。
   */
  it("ok 分支的 remaining 真的跟着 used 走：用过 5 次之后还剩 18 次", () => {
    const v = checkManualTend(fresh({ used: 5, cooldownUntil: 0 }), MORNING);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.remaining, "24 − 5 − 1（含正在处理的这一次）").toBe(18);
    expect(v.next.used).toBe(6);
  });

  /**
   * **绝对时刻与相对时长成对给**（评审 m3）。放行那一支两者说的是同一件事，
   * 相对量恒等于冷却本身——**显式给出比让面板自己拿本地时钟去减更不容易错**。
   */
  it("放行时同时给绝对的 cooldownUntil 与相对的 retryAfterMs，两者说的是同一件事", () => {
    const v = checkManualTend(null, MORNING);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.cooldownUntil).toBe(MORNING + 600_000);
    expect(v.retryAfterMs, "手写字面量：10 分钟").toBe(600_000);
    expect(v.cooldownUntil - MORNING, "两种基准必须自洽").toBe(v.retryAfterMs);
  });

  it("第一次点：放行，`next` 写下今天的 day、used=1、冷却到 10 分钟后", () => {
    const v = checkManualTend(null, MORNING);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.next).toEqual({
      day: 20_000, used: 1, cooldownUntil: MORNING + MANUAL_TEND_COOLDOWN_MS,
    });
    expect(v.remaining, "还剩 K-1 次").toBe(23);
    expect(v.resetAt).toBe(DAY_START + DAY);
  });

  it("冷却期内被拒，冷却到点后放行 —— 判据是 `now < cooldownUntil` 这一处值比较", () => {
    const cur = fresh({ cooldownUntil: MORNING + MANUAL_TEND_COOLDOWN_MS });
    const inside = checkManualTend(cur, MORNING + MANUAL_TEND_COOLDOWN_MS - 1);
    expect(inside.ok).toBe(false);
    if (inside.ok) return;
    expect(inside.reason).toBe("manual_cooldown");
    expect(inside.retryAfterMs, "面板要能说「还差多久」，不是只说「不行」").toBe(1);
    // 成对给（评审 m3）：这一支原来只有相对量，面板要显示「几点恢复」就只能拿本地时钟去减。
    if (inside.reason === "manual_cooldown") {
      expect(inside.cooldownUntil).toBe(MORNING + MANUAL_TEND_COOLDOWN_MS);
    }
    // 边界：`now === cooldownUntil` 就是到点了，不许再多挡一毫秒。
    expect(checkManualTend(cur, MORNING + MANUAL_TEND_COOLDOWN_MS).ok).toBe(true);
  });

  /**
   * **`remaining` 三支都要给。** 只在耗尽那一支给它，面板就只能等到点不动了才说
   * ——运维会在毫不知情的情况下撞上一堵墙。
   * **变红条件**：把 `manual_cooldown` 那一支的 `remaining` 去掉或写死成 0。
   */
  it("冷却被拒时也如实报「今天还剩几次」，不是等到耗尽才说", () => {
    const v = checkManualTend(fresh({ used: 5, cooldownUntil: MORNING + 1 }), MORNING);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.remaining, "24 - 5").toBe(19);
    expect(v.resetAt).toBe(DAY_START + DAY);
  });

  it("用满 24 次之后 429 write_budget_exhausted，remaining 0、resetAt 是当日 24:00", () => {
    const v = checkManualTend(fresh({ used: MANUAL_TENDS_PER_DAY }), MORNING);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("write_budget_exhausted");
    expect(v.remaining).toBe(0);
    expect(v.resetAt).toBe(DAY_START + DAY);
    expect(v.retryAfterMs).toBe(DAY_START + DAY - MORNING);
    // 边界：第 24 次本身是放行的，第 25 次才被拒。
    expect(checkManualTend(fresh({ used: 23 }), MORNING).ok).toBe(true);
  });

  /**
   * **顺序有意义：预算排在冷却前面。**
   *
   * 两条同时不满足时报冷却的话，运维会等 10 分钟再点一次，然后撞上「今天用完了」
   * ——报的那句话必须是他照着能改的那一句。同一条纪律见
   * `tests/contract/admin-auth.test.ts` 的
   * 「又短又含汉字时报 not_sendable 而不是 too_short」。
   * **变红条件**：把两条判断对调。
   */
  it("预算耗尽 + 还在冷却里 ⇒ 报预算耗尽，不报冷却（处置完全不同）", () => {
    const v = checkManualTend(
      fresh({ used: MANUAL_TENDS_PER_DAY, cooldownUntil: MORNING + 5 * 60_000 }),
      MORNING,
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("write_budget_exhausted");
  });

  /**
   * **跨天靠 `day` 这一处值比较，两个方向都算「新的一天」。**
   *
   * 时钟回拨与正常前进走同一条判据（`day !== 今天`），与本仓其余四处
   * （`Refreshable` / `listOnReadPath` / `KeyPoolRepo` / `WriteBudget` 的 `age < 0`）
   * 同一套语义：回拨立刻恢复，不会把预算冻结到"回拨量走完"才解封。
   * **变红条件**：去掉 `cur.day === today` 这个判断（则 used 永不归零）。
   */
  it("换了一天 used 归零 —— 往前跨与往回拨都算新的一天", () => {
    const yesterday = { day: 19_999, used: MANUAL_TENDS_PER_DAY, cooldownUntil: 0 };
    const forward = checkManualTend(yesterday, MORNING);
    expect(forward.ok, "跨到今天：昨天用满了也不该拦").toBe(true);
    if (forward.ok) expect(forward.next.used).toBe(1);

    const tomorrow = { day: 20_001, used: MANUAL_TENDS_PER_DAY, cooldownUntil: 0 };
    const backward = checkManualTend(tomorrow, MORNING);
    expect(backward.ok, "时钟回拨：同样按新的一天处理，立刻恢复").toBe(true);
    if (backward.ok) expect(backward.next.day, "写回去的是**现在**这一天").toBe(20_000);
  });

  /**
   * **同一天内 `used` 只增不重置** —— 上面那一格的镜像另一半。
   * 只测「会归零」的话，一个"永远归零"的错误实现照样全绿（第 5 种假阳性：
   * 覆盖的状态让被测的选择不可观测）。
   */
  it("同一天内 used 累加，11 分钟之后再点也不归零", () => {
    const cur = fresh({ used: 3, cooldownUntil: MORNING + MANUAL_TEND_COOLDOWN_MS });
    const later = checkManualTend(cur, MORNING + 11 * 60_000);
    expect(later.ok, "11 分钟 > 10 分钟冷却，该放行").toBe(true);
    if (!later.ok) return;
    expect(later.next.used, "同一天内必须是 4，不是 1").toBe(4);
    expect(later.next.day).toBe(20_000);
  });

  /**
   * 🔴 **如实登记的残留**：`cooldownUntil` 不跟着跨天一起清（两个字段互不借用）。
   * 时钟往回拨一小时时，冷却会比 10 分钟多挡约 50 分钟。方向是 fail-safe 的
   *（少写、不多写），而让跨天顺手清冷却就等于把 `day` 的职责借给 `cooldownUntil`
   * ——那正是评审那个失效读法的错处，只是方向反过来。
   */
  it("【如实登记】跨天不清冷却：回拨时钟时冷却会多挡一阵子", () => {
    const cur = { day: 20_001, used: 0, cooldownUntil: MORNING + 3_600_000 };
    const v = checkManualTend(cur, MORNING);
    expect(v.ok, "预算按新的一天算，但冷却仍然拦着").toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("manual_cooldown");
    expect(v.remaining, "预算那一半确实已经归零重算了").toBe(MANUAL_TENDS_PER_DAY);
  });
});
