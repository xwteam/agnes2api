/**
 * Tier-1 用量埋点。**近似值**，两条误差都写在面板的 `≈` 提示里：
 * 并发请求下会少计（KV 没有 CAS），且计数最多晚一个 `POOL_TOUCH_INTERVAL_MS` 落盘。
 */
export interface KeyStats {
  /** 终态归因到这把 key 的请求总数。**不变式：requests === success + failed + clientErrors。** */
  requests: number;
  /** 上游 2xx。 */
  success: number;
  /** 归因到**这把 key** 的失败：超时 / 5xx / 非 JSON 响应体 / 凭据失效 / 限流。 */
  failed: number;
  /** 上游 4xx 直通。**客户端的错，不是这把 key 的错**，所以单列，不并进 failed。 */
  clientErrors: number;
  lastErrorAt: number | null;
  lastErrorKind: string | null;
}

export interface KeyRecord {
  id: string;
  key: string;
  addedAt: number;
  lastUsedAt: number | null;
  cooldownUntil: number;
  /** 当前这段冷却是因何而起（限流 / 欠费 / 瞬时故障累计）。仅供排障，不参与调度。 */
  cooldownReason: string | null;
  strikes: number;
  evicted: boolean;
  evictedReason: string | null;
  /** Tier-1 用量埋点。**可选**：存量记录没有它，读取处统一走 normalizeStats 补默认值。 */
  stats?: KeyStats;
  /**
   * 管理员**手工**停用。与 `evicted`（系统按 401/403 判定的凭据失效）语义分离：
   * 前者是人的决定、随时可以撤销，后者是系统的判定、要换 key。两者混为一谈会让
   * 503 把运维指向一件完全没用的事（去换 key，而其实是他自己关的）。
   *
   * **可选**：存量记录没有它，读取处统一走 `isDisabled()` 补默认值（`keypool.ts`）。
   * 写成必填的话，存量记录读回来是 `undefined`，`c.json` 会把该字段整个丢掉 ⇒
   * 面板收到的是「字段不存在」而不是 `false`，分不清「没停用」和「读不出来」。
   */
  disabled?: boolean;
  /**
   * 运维备注。**可选**，同上。
   *
   * ⚠️ **这个字段建出来的那一刻既没有生产者也没有消费者**：写它的 `PATCH /admin/api/keys/:id`
   * 与渲染它的那一列都还没有。这里先建槽位，是因为 `FIELD_ROLE` 的类型
   * （`Record<keyof KeyRecord, …>`）要求每个字段都有一次显式表态，而这个表态
   * 放在「正在通盘看 scheduling / telemetry 划分」的这一期做，比放在只顾着写端点的
   * 那一期做更不容易出错。**它今天不进 `KeyView`**——一个没有生产者的响应字段
   * 恒为 `null`，正是本仓反复裁过的那个形态。
   */
  note?: string | null;
}
