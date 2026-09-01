import { describe, it, expect } from "vitest";
import {
  USAGE_WRITES_PER_DAY, USAGE_FLUSH_MIN_INTERVAL_MS, USAGE_DAY_RETAIN, USAGE_SLOTS,
  USAGE_DAY_MS, usageCandidateKeys, usageExpiresAt, usageDayIndex, usageHourOf,
  usageSlotOf, usageDayKey,
  emptyBucket, addToBucket, mergeDayShards, canWrite, type WriteBudget,
} from "../../../src/core/admin/usage-stats.js";

describe("Tier-2 的配额算术", () => {
  /**
   * ⚠️ **这三格是配额账的机器锚，必须一起看。**
   * 评审发现：第一版只有下面第三格那条关系断言，而它的两个输入**都是被测常量本身，
   * 一个手写字面量锚都没有** —— 同向改两个（间隔 1h + 预算 24）它照样绿，
   * 而写量翻倍、五语言 DEPLOY.md 的数字全变假话。
   * 这正是计划自己列的第 6 种假阳性：**无锚的推导 = 同义反复。**
   */
  it("预算与间隔各自钉死在手写字面量上 —— 改了它们就必须回头重算配额账", () => {
    // 变红条件：把任一个常量改掉。**这一格存在的全部理由就是逼人回到配额账。**
    expect(USAGE_WRITES_PER_DAY).toBe(13);
    expect(USAGE_FLUSH_MIN_INTERVAL_MS).toBe(7_200_000);
    expect(USAGE_SLOTS).toBe(2);
    expect(USAGE_DAY_RETAIN).toBe(30);
  });

  it("预算够覆盖一整天**并且**还剩一格给跨 UTC 零点那次多写的键 —— "
     + "差这一格的话每 24 小时恰好有一次落盘被预算拒绝，"
     + "『尾巴 ≤2 小时』那句对外承诺就变成假话（评审发现）", () => {
    // ⚠️ **式子里的 `- 1` 是这一格的全部要点。**
    // 第一版写的是 `I × B >= DAY`，它在 B=12 时通过，而真实需要的 put 数是 `DAY/I + 1 = 13`
    // ⇒ 用例名叫「至少覆盖一整天」，检查的式子却不足以保证覆盖一整天
    // —— 那正是第一版那条缺陷的形状（不变量数错了对象），小一号、同一个位置。
    // 变红条件（两条都要试）：
    //   ① 把 USAGE_WRITES_PER_DAY 改回 12；
    //   ② 把 USAGE_FLUSH_MIN_INTERVAL_MS 改成 3_600_000（预算会在半天时耗尽）。
    expect(USAGE_FLUSH_MIN_INTERVAL_MS * (USAGE_WRITES_PER_DAY - 1)).toBeGreaterThanOrEqual(86_400_000);
  });

  /**
   * ⚠️ **这一格守的是「模块之间的那道缝」，不是本模块自己的某个值。**
   *
   * `canWrite(b, at, perDay = EVENT_WRITES_PER_DAY)` 的第三个参数**有默认值，而那个
   * 默认值是事件板块的 12**。接线时漏传第三个参数**不会有类型错误、不会有
   * 任何编译期信号**，预算会静默按 12 计——而 12 恰好就是评审判定为
   * 「每 24 小时恰好有一次 put 被预算拒绝」的那个值。
   * ⇒ **上面两格全绿、两个模块的常量各自也都还是对的，而缺陷已经回来了。**
   * 这正是计划第 5 种假阳性（「覆盖的状态让被测的选择不可观测」）的成因结构：
   * 只测常量的话，「传了」与「没传」在数学上不可区分。
   */
  it("canWrite 的默认 perDay 是事件板块的 12，不是用量的 13 —— "
     + "漏传第三个参数不会有任何编译期信号，缺陷会从一个默认参数悄悄回来", () => {
    // 变红条件（两条都试过）：
    //   ① 把 event-ring.ts 的 EVENT_WRITES_PER_DAY 改成 13（缝合上了，第一条断言失效）；
    //   ② 把 canWrite 的默认参数改成 USAGE_WRITES_PER_DAY（同上）。
    // 期望值全是手写字面量：12 次已用是手写的，两个方向的布尔结果也是手写的。
    const used12: WriteBudget = { dayStart: 0, used: 12 };
    expect(canWrite(used12, 0)).toBe(false);                       // 漏传 ⇒ 按 12 算 ⇒ 已耗尽
    expect(canWrite(used12, 0, USAGE_WRITES_PER_DAY)).toBe(true);  // 显式传 ⇒ 还剩最后一格
    // 那「最后一格」正是跨 UTC 零点那次落盘要多写的那个键。
  });

  it("一次落盘最多写 2 个键 —— 预算数的是 put 不是 flush，键多写一个预算就要多扣一格", () => {
    // 这一格钉的是**键形状与预算口径的对应关系**（评审那条的正主）。
    // 判据：一次 flush 覆盖的时间跨度是一个间隔，落在几个 UTC 日里就写几个键。
    // 变红条件：把 USAGE_DAY_MS 改成 3_600_000（即退回按小时分键）⇒ 下面变成 3
    expect(Math.ceil(USAGE_FLUSH_MIN_INTERVAL_MS / USAGE_DAY_MS) + 1).toBe(2);
  });

  it("区间给一年也不会超过保留期 × 槽位数 —— 读扇出必须有硬上界，不能随入参涨", () => {
    const now = 1_700_000_000_000;
    const keys = usageCandidateKeys(now, now - 365 * 86_400_000, now);
    // 期望值手写字面量 60（30 天 × 2 槽位），不写成常量表达式（第 6 种假阳性）
    expect(keys.length).toBeLessThanOrEqual(60);
    // ⚠️ **光断言长度已经不够了**：加了结构性计数闸（`n < USAGE_DAY_RETAIN`）之后，
    // **把夹逼整个删掉长度也还是 60** —— 只是内容从「最近 30 天」悄悄变成「最老 30 天」，
    // 一个静默的错误答案。所以这里必须同时钉住**取的是哪一段**：
    expect(keys[0]).toBe("usage:19646:0");    // 手写字面量：19675 − 30 + 1
    expect(keys.at(-1)).toBe("usage:19675:1"); // 手写字面量：now 所在的那一天
  });

  /**
   * ⚠️ **这一格是「恒 ≤ 60」那句全称断言的另一半，缺了它那句话就是假的**
   * （被测函数注释里点名的、成对的那两条评审发现，说的就是这一格）。
   * 失效形态**不是「数字变大」而是「函数不返回」**：`nowMs = ±Infinity` 时
   * `oldest`/`newest` 都是 `±Infinity`，而 `d++` 对它们是恒等操作；
   * `nowMs` 有限但超过 `2**53`（`1e24` / `1e300`）时 `d++` 失去精度，同样原地打转。
   * 评审的第一次探针就是在这里把 v8 跑成了 OOM。
   * ⚠️ **`Number.isFinite(1e300) === true`**，所以只加 `isFinite` 那道闸**不够**，
   * 结构性的那道计数闸（`n < USAGE_DAY_RETAIN`）才是让上界与入参大小无关的东西。
   *
   * ⚠️ **下面两条极大值断言的 `fromMs` 必须是 `0`，不能改成 `nowMs`。**
   * `(1e24, 0, 1e24)` 时 `oldest = 11574074074074044`，那个浮点数上 `d + 1 === d`（会卡住）；
   * 而 `(1e24, 1e24, 1e24)` 时 `oldest = 11574074074074074`，`d + 1 === d` 为**假**、
   * 循环 1 步就结束 —— **换一组入参这一格就测不到那个卡死的分支了**（成因见被测函数的注释）。
   */
  it("nowMs 非有限时返回空数组、极大时也不转圈 —— 「恒 ≤ 60」是全称断言，"
     + "而它的失效形态是函数不返回（评审把 v8 跑成过 OOM），不是数字变大", () => {
    // 变红条件（两条分别试过）：
    //   ① 删掉 `if (!Number.isFinite(nowMs)) return [];` ⇒ 下面三个 toEqual([]) 变红；
    //   ② 删掉循环里的 `n < USAGE_DAY_RETAIN` 计数闸 ⇒ 下面两个极大值断言直接挂死（超时红）。
    for (const bad of [Infinity, -Infinity, NaN]) {
      expect(usageCandidateKeys(bad, 0, bad)).toEqual([]);   // 手写字面量：空数组
    }
    // 有限但大到 d++ 失去精度：不许转圈，也不许突破上界
    expect(usageCandidateKeys(1e24, 0, 1e24).length).toBeLessThanOrEqual(60);
    expect(usageCandidateKeys(1e300, 0, 1e300).length).toBeLessThanOrEqual(60);
  });

  /**
   * ⚠️ **这一格把「夹逼的理由是读扇出上界」那条订正变成可复现的真话**（那条订正来自评审）：注释里写着「三组 now
   * 实测过」，而在此之前仓里只有两组有用例（一年那格、30d 那格），
   * **第 100 天那一组一个字都没有被钉着**。
   */
  it("被夹逼排除掉的那一天其实还没过期 —— 夹逼的理由是读扇出上界，不是「反正过期了」；"
     + "照后者去把那天加回来会直接打破 60", () => {
    const now = 100 * 86_400_000;                     // 第 100 个 UTC 日的零点
    const keys = usageCandidateKeys(now, 0, now);
    expect(keys.length).toBe(60);                     // 手写字面量
    expect(keys[0]).toBe("usage:71:0");               // 手写字面量：最老只回看到第 71 天
    // 而第 70 天的键此刻**还活着**（TTL 多留了一整天余量），却永远不会被取到：
    expect(usageExpiresAt(70)).toBe(8_726_400_000);   // 手写字面量
    expect(usageExpiresAt(70)).toBeGreaterThan(now);
  });

  it("30d 那一档正好 60 或 62 个键 —— 这个数要与配额账读侧那张表逐字对上", () => {
    // 变红条件：把 USAGE_SLOTS 改成 1
    const now = 30 * 86_400_000;                  // 恰好落在某个 UTC 日的零点
    expect(usageCandidateKeys(now, now - 29 * 86_400_000, now).length).toBe(60);
  });

  it("TTL 精确到手算字面量 —— 过期时刻错一天就是少存或多存一整天", () => {
    // 变红条件：把 USAGE_TTL_MARGIN_MS 改成 0
    const at = 86_400_000 * 10 + 123;             // 第 10 个 UTC 日内
    expect(usageDayIndex(at)).toBe(10);
    expect(usageExpiresAt(10)).toBe((10 + 30) * 86_400_000 + 86_400_000);
  });

  /**
   * ⚠️ **这一格守的是 `USAGE_SLOTS` 那句「同一天里最多 2 个 isolate 能各写各的而不
   * 互相覆盖」——在此之前它一个字都没有被守着**（评审点过名）。
   * `USAGE_SLOTS = 2` 的手写锚只钉住了读扇出 `30 × 2 = 60`；**散布函数塌成常量之后
   * 写侧碰撞翻倍、槽位 1 永远不被写，而那个 60 照样绿、配额账照样对。**
   * 实测：把 `usageSlotOf` 整个写死成 `return 0` ⇒ 本文件当时 `11 passed (11)`，ESCAPED。
   */
  it("usageSlotOf 真的把不同 shardId 散到不同槽位 —— 散布塌成常量后写侧碰撞翻倍、"
     + "槽位 1 永不被写，而读扇出那个 60 照样绿", () => {
    // ⚠️ **不能只用 "s1" 当样本**：`usageSlotOf("s1")` 恰好就是 0，
    // 只断言它的话，把整个函数写死成 `return 0` 依然全绿——变异不可观测。
    // 这条纪律本仓已经用血写过一次，见 `tests/unit/logger-store.test.ts:268`
    // ——那是「评审 T1」那段说明**本身**所在的行（用例在它下面），
    // 那里踩的是同一个 `slotOf("s1") === 0`。
    expect(usageSlotOf("s1")).toBe(0);   // 手写字面量
    expect(usageSlotOf("s2")).toBe(1);   // 手写字面量：**这一格才是「没塌成常量」的证据**
    expect(usageSlotOf("s2")).not.toBe(usageSlotOf("s1"));
  });

  it("日键的格式钉到手写字面量 —— 键空间撞车是静默的：读写共用同一个函数，"
     + "格式错了它自己完全自洽，只有别的前缀被覆盖时才会发作", () => {
    // 变红条件（两条都试过）：把前缀改成 `stat:`；把 day/slot 两个参数颠倒。
    // 期望值是手写字面量，不由 `usage:${day}:${slot}` 反推（第 6 种假阳性）。
    // 与既有的两个键空间不许撞：事件是 `event:<窗口>:<槽位>`，设计 §7.4 里的旧形态是 `stat:`。
    expect(usageDayKey(19675, 1)).toBe("usage:19675:1");
    expect(usageDayKey(0, 0)).toBe("usage:0:0");
  });

  it("小时槽按 UTC 补零 —— 面板的单日下钻直接用它当键，格式错了整列取不到", () => {
    expect(usageHourOf(86_400_000 * 10)).toBe("00");
    expect(usageHourOf(86_400_000 * 10 + 3_600_000 * 7 + 59)).toBe("07");
    expect(usageHourOf(86_400_000 * 10 + 3_600_000 * 23)).toBe("23");
  });
});

describe("Tier-2 的合并", () => {
  it("畸形分片被数出来而不是被静默丢掉 —— 静默丢弃就是撒谎", () => {
    // 变红条件：把 mergeDayShards 里的 malformed++ 删掉
    const r = mergeDayShards([
      "evil-string",
      { day: 3, total: { requests: 3 } },
      { total: { requests: 9 } },        // 缺 day ⇒ 畸形
      null,
    ]);
    expect(r.malformed).toBe(2);         // 字符串 + 缺 day 的对象；null 不算畸形
    expect(r.shards).toBe(1);
    expect(r.total.requests).toBe(3);
    expect(r.byDay["3"]!.requests).toBe(3);
  });

  it("`total` 是数组的分片算畸形，不许伪装成合法分片 —— "
     + "`typeof [] === \"object\"` 会让它拿到一个全 0 桶并混进 shards，把那个数一起变假", () => {
    // 变红条件：把 narrowBucket 里的 `|| Array.isArray(v)` 去掉 ⇒ malformed 掉到 0、shards 涨到 1。
    const r = mergeDayShards([{ day: 5, total: [] }]);
    expect(r.malformed).toBe(1);   // 手写字面量
    expect(r.shards).toBe(0);      // 手写字面量：一个都不许被当成合法的
    expect(r.total.requests).toBe(0);
  });

  it("流式请求进 streamingRequests 但不进 token —— 让 token 的缺口可见", () => {
    // 变红条件：把 addToBucket 的 streamingRequests 改成恒 +0
    let b = emptyBucket();
    b = addToBucket(b, { ok: true, stream: true, latencyMs: 50, tokensIn: 0, tokensOut: 0 });
    b = addToBucket(b, { ok: true, stream: false, latencyMs: 30, tokensIn: 11, tokensOut: 22 });
    expect(b.requests).toBe(2);
    expect(b.streamingRequests).toBe(1);
    expect(b.tokensIn).toBe(11);
    expect(b.tokensOut).toBe(22);
  });

  it("失败请求不进平均延迟 —— 一个 8 秒超时和一个 30 毫秒的 401 混进去，"
     + "那个『平均延迟』就不是任何真实的东西（评审发现）", () => {
    // 变红条件：把 latencySum/latencyCount 的 `o.ok ?` 去掉
    let b = emptyBucket();
    b = addToBucket(b, { ok: true, stream: false, latencyMs: 30, tokensIn: 0, tokensOut: 0 });
    b = addToBucket(b, { ok: false, stream: false, latencyMs: 8000, tokensIn: 0, tokensOut: 0 });
    expect(b.requests).toBe(2);
    expect(b.errors).toBe(1);
    expect(b.latencyCount).toBe(1);      // 手写字面量
    expect(b.latencySum).toBe(30);       // 手写字面量：8000 那一笔一个毫秒都不许进来
  });
});
