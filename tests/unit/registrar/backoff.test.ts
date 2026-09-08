import { describe, it, expect } from "vitest";
import {
  EDGE_BACKOFF_MS, APP_BACKOFF_MS, CLUSTER_BACKOFF_MS, BACKOFF_MAX_MS,
  inBackoff, retryAfterMs, narrowBackoff, nextBackoff, mergeBackoff,
  type BackoffState,
} from "../../../src/core/registrar/backoff.js";

/**
 * 跨轮退避那把键的**纯函数**判据。
 *
 * ⚠️ **这个文件是评审回填时新建的：在它之前 `nextBackoff` / `mergeBackoff` /
 * `narrowBackoff` 一格直接判据都没有**，全靠
 * `tests/unit/registrar/domain-ledger-io.test.ts` 那几格从 `tendOnce` 外面间接量。
 * 间接量漏掉的正是本文件下半段那件事：`tendOnce` 那一侧「重新起一串」写回去的
 * `hits: 1`，会不会在**落盘那一层**（`mergeBackoff`）被原地撤销。
 */

const NOW = 1_700_000_000_000;

const streak = (over: Partial<BackoffState> = {}): BackoffState =>
  ({ until: NOW + 1000, kind: "edge", since: NOW - 5000, hits: 1, ...over });

describe("inBackoff / retryAfterMs：唯一判据是 until 与 now 的值比较", () => {
  it("until 还在前面就是在窗口里；正好相等算过去了（与抢锁同一形态）", () => {
    expect(inBackoff(streak({ until: NOW + 1 }), NOW)).toBe(true);
    expect(inBackoff(streak({ until: NOW }), NOW)).toBe(false);
    expect(inBackoff(null, NOW)).toBe(false);
  });

  it("不在窗口里时倒计时是 null，不是 0（面板不许渲染一个恒为 0 的假倒计时）", () => {
    expect(retryAfterMs(streak({ until: NOW + 60_000 }), NOW)).toBe(60_000);
    expect(retryAfterMs(streak({ until: NOW - 1 }), NOW)).toBeNull();
    expect(retryAfterMs(null, NOW)).toBeNull();
  });
});

describe("narrowBackoff：读坏了当成「没有退避」放行，方向与台账刻意相反", () => {
  it("任一字段读不得 ⇒ 整条 null（多打一轮，而不是静默停摆）", () => {
    for (const raw of [
      null, undefined, 42, "x", [], {},
      { kind: "edge", until: 1, since: 1 },
      { kind: "nope", until: 1, since: 1, hits: 1 },
      { kind: "edge", until: "x", since: 1, hits: 1 },
      { kind: "edge", until: 1, since: 1, hits: null },
    ]) {
      expect(narrowBackoff(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  /**
   * ⚠️ **三档 kind 都要单独试一次读回来。** 只试 `app` 的话，`narrowBackoff` 里那串
   * `kind !== ...` 少写一档就是**写得进去、读不回来**：注册机把窗口写进存储，下一轮
   * 读到 `null` 照打不误 —— 而按本仓登记的上游行为（窗口里每打一次就把窗口续一次），
   * 那比不写还糟。`cluster` 这一档是评审回填新增的，它正是最容易被漏掉的那一个。
   *
   * 变异：把 `narrowBackoff` 里 `o.kind !== "cluster"` 那一段删掉 ⇒ 红。
   */
  it("三档 kind 都读得回来，四个字段齐全就照收", () => {
    for (const kind of ["edge", "app", "cluster"] as const) {
      expect(narrowBackoff({ until: 7, kind, since: 3, hits: 2 }), kind)
        .toEqual({ until: 7, kind, since: 3, hits: 2 });
    }
  });
});

describe("nextBackoff：指数、封顶、以及「一串」是怎么算的", () => {
  /**
   * ⚠️ **三档各有自己的基数，逐档手写字面量。** `cluster` 那一档是评审回填新增的
   *（同一轮里 ≥2 个域名被判屏蔽 + 这一轮零产出，见 `src/core/registrar/tender.ts`
   * 的 `finishRound`），取值刻意与 `app` 相同 —— 但**取值相同不等于可以共用一个常量**：
   * 两者的依据不同（app 那条是「一个补池周期」，cluster 那条是「我们对它零观测」），
   * 将来只会改一个。这一格钉的是「哪一档用哪个常量」。
   *
   * 变异：把 `nextBackoff` 里 `BASE.cluster` 改成 `EDGE_BACKOFF_MS` ⇒ 红。
   */
  it("第一次撞：边缘 15 分钟、应用 30 分钟、成批判死那一档 30 分钟，since 就是此刻", () => {
    expect(nextBackoff(null, "edge", NOW)).toEqual({
      until: NOW + 900_000, kind: "edge", since: NOW, hits: 1,
    });
    expect(nextBackoff(null, "app", NOW)).toEqual({
      until: NOW + 1_800_000, kind: "app", since: NOW, hits: 1,
    });
    expect(nextBackoff(null, "cluster", NOW)).toEqual({
      until: NOW + 1_800_000, kind: "cluster", since: NOW, hits: 1,
    });
    expect(EDGE_BACKOFF_MS).toBe(900_000);
    expect(APP_BACKOFF_MS).toBe(1_800_000);
    expect(CLUSTER_BACKOFF_MS).toBe(1_800_000);
  });

  it("同一串里连着撞按 2 的幂拉长，since 取旧的那个（面板要说「已经限了多久」）", () => {
    const prev = { until: NOW - 1, kind: "edge" as const, since: NOW - 100_000, hits: 3 };
    // 手写字面量：15 分钟 × 2³ = 2 小时。
    expect(nextBackoff(prev, "edge", NOW)).toEqual({
      until: NOW + 7_200_000, kind: "edge", since: NOW - 100_000, hits: 4,
    });
  });

  it("封顶 4 小时，且 hits 很大时不许溢出成 Infinity", () => {
    const huge = { until: NOW - 1, kind: "edge" as const, since: NOW - 1, hits: 900 };
    const got = nextBackoff(huge, "edge", NOW);
    expect(got.until).toBe(NOW + BACKOFF_MAX_MS);
    expect(Number.isFinite(got.until)).toBe(true);
  });

  /**
   * 🔴 **承重格（评审回填）：调用方传 `null` 就是「重新起一串」。**
   *
   * `src/core/registrar/tender.ts` 在「这一轮铸出过 key」时就是这么调的 ——
   * 五语言 REGISTRAR.md 与 CHANGELOG 逐字承诺的那句「一次成功铸号把指数从头数起」
   * 落在这里。变异：把那一行改回无条件传 `backoff` ⇒
   * `tests/unit/registrar/domain-ledger-io.test.ts` 的
   * 「同一轮里既铸出了 key 又撞上限流：退避重新起一串（hits 回到 1），不接着翻倍」当场红。
   */
  it("传 null ⇒ hits 回到 1、since 推到此刻（指数从头数）", () => {
    expect(nextBackoff(null, "edge", NOW)).toEqual({
      until: NOW + 900_000, kind: "edge", since: NOW, hits: 1,
    });
  });

  /**
   * 🔴 **承重格（评审回填）：上一串早就过完了就不再是「连续」的证据。**
   *
   * 它治的是一条真实的驻留路径：池子满着的那些轮次在 `need <= 0` 那里就 return 了，
   * **走不到收尾**，于是一把 `hits` 很高的退避键会一直留在存储里；等池子再耗干时
   * 第一次撞限流就直接跳到封顶那一档。
   *
   * 变异：删掉 `streakBroken` ⇒ 下面这条拿到的是 4 小时（`hits: 6`）⇒ 红。
   */
  it("上一段窗口过完之后隔了比封顶还久 ⇒ 重新起一串（陈旧的 hits 不许接着滚）", () => {
    const stale = {
      until: NOW - BACKOFF_MAX_MS - 1, kind: "edge" as const, since: NOW - 999_999_999, hits: 5,
    };
    expect(nextBackoff(stale, "edge", NOW)).toEqual({
      until: NOW + 900_000, kind: "edge", since: NOW, hits: 1,
    });
    // 边界的另一侧：刚过完不久的那一串照常接着数（真正连续的那些一个都不许被误伤）。
    const fresh = { until: NOW - 1000, kind: "edge" as const, since: NOW - 100_000, hits: 5 };
    expect(nextBackoff(fresh, "edge", NOW).hits).toBe(6);
  });
});

describe("mergeBackoff：KV 没有 CAS，写回一律先 get 再 merge", () => {
  it("存储里没有就是新写的那一份", () => {
    expect(mergeBackoff(null, streak())).toEqual(streak());
  });

  it("同一串（since 相同）里取更保守的那个：until 与 hits 都取大的", () => {
    const cur = { until: NOW + 5000, kind: "edge" as const, since: NOW - 5000, hits: 4 };
    const next = { until: NOW + 1000, kind: "app" as const, since: NOW - 5000, hits: 2 };
    expect(mergeBackoff(cur, next)).toEqual({
      until: NOW + 5000, kind: "edge", since: NOW - 5000, hits: 4,
    });
  });

  /**
   * 🔴 **承重格（评审回填）：重新起一串必须活着穿过落盘这一层。**
   *
   * `hits` 从前无脑取大 ⇒ `nextBackoff` 重新起一串写回来的 `hits: 1` 会被存储里那份
   * 旧的 `hits: 5` 顶掉 ⇒ **「一次成功铸号把指数从头数起」在真接线上原地失效**，
   * 而 `tendOnce` 那一侧的判据（注入的假 `saveBackoff`）照样全绿 —— 一份行为在两个
   * 地方各说各话。判据是 `since`：它只在重新起一串时才前进。
   *
   * 变异：把 `hits` 改回 `Math.max(cur.hits, next.hits)` ⇒ 这一格与
   * `tests/unit/registrar/domain-ledger-io.test.ts` 的
   * 「真接线：同一轮里既铸出了 key 又撞上限流，落盘的 hits 是 1 不是接着翻倍」一起红。
   */
  it("since 更大的那一份是更新的一串：hits 跟着它走，不取大的", () => {
    const cur = { until: NOW - 1, kind: "edge" as const, since: NOW - 100_000, hits: 5 };
    const restart = { until: NOW + 900_000, kind: "edge" as const, since: NOW, hits: 1 };
    expect(mergeBackoff(cur, restart)).toEqual({
      until: NOW + 900_000, kind: "edge", since: NOW, hits: 1,
    });
    // 反向：存储里那份才是更新的一串时，写回来的旧串同样吞不掉它。
    expect(mergeBackoff(restart, cur)).toEqual({
      until: NOW + 900_000, kind: "edge", since: NOW, hits: 1,
    });
  });

  it("窗口本身永远取更保守的：丢掉 until 等于退避凭空消失", () => {
    const cur = { until: NOW + 7_200_000, kind: "app" as const, since: NOW - 10, hits: 3 };
    const next = { until: NOW + 900_000, kind: "edge" as const, since: NOW, hits: 1 };
    const got = mergeBackoff(cur, next);
    expect(got.until).toBe(NOW + 7_200_000);
    // kind 跟着胜出的 until 走（面板文案与处置分层靠它）。
    expect(got.kind).toBe("app");
    // 而 hits/since 仍然跟着更新的那一串 —— 两件事各走各的判据。
    expect(got.hits).toBe(1);
    expect(got.since).toBe(NOW);
  });
});
