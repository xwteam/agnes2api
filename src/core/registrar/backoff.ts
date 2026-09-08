/**
 * **注册机的跨轮退避**：撞上上游限流之后，下一轮开跑前先看一眼这把键，
 * 在窗口里就**一次上游请求都不发、一个临时邮箱都不建**。
 *
 * **零 IO 纯函数**（硬约束 2）。读写存储在 `src/http/wire.ts` 的 `buildTendDeps`。
 *
 * ── 为什么非有它不可 ──────────────────────────────────────────────────────
 *
 * 上游那两层限流的惩罚窗口都比「一轮补池」长得多，而**窗口里每打一次请求就把窗口
 * 续一次**。从前撞上限流之后只在一次尝试内换个域名接着打，于是一轮里的每一次请求
 * 都还在窗口里、每一次都把窗口续上——**打得越多，恢复得越晚**。
 *
 * 光靠「本轮立刻中止」还不够：Cron 是雷打不动地每 `TEND_INTERVAL_MS` 来一轮，
 * 窗口比补池间隔长的时候，每一轮都会去续一次窗口，正是同一个缺陷换了个尺度重演。
 * ⇒ 退避必须**跨轮**，而且必须**指数**。
 */

/**
 * 退避键。**单一固定键，数量恒为 1。**
 *
 * ⚠️ **写它的时候一律不传 `expiresAt`**：读侧的判据是 `until > now` 这一处**值比较**，
 * 陈旧的值拦不住任何人。给它配 TTL 就是让 TTL 兼任 `until` 的职责——理由与
 * `src/core/admin/tend-guard.ts` 的 `MANUAL_GUARD_KEY` 那段同源。
 * 代价明写：这把键会在存储里长期驻留（1 把），清理靠手工删键。
 */
export const REGISTRAR_BACKOFF_KEY = "registrar:backoff";

/** 撞的是哪一层限流。**只影响面板文案与事件字段，不影响处置**（两层都是整轮停手）。 */
export type BackoffKind = "edge" | "app";

export interface BackoffState {
  /** 退避到期时刻（epoch ms）。判据是 `until > now` 这一处值比较。 */
  until: number;
  kind: BackoffKind;
  /**
   * 这一串连续退避是从什么时候开始的。面板拿它说「已经限了多久」。
   *
   * ⚠️ **它同时是「这是哪一串」的身份**：`nextBackoff` 只在**重新起一串**时把它推到
   * 当前时刻，`mergeBackoff` 靠比它大小分辨两份状态说的是不是同一串（见那里）。
   */
  since: number;
  /**
   * **这一串里撞了几次。** 指数退避的指数就是它。
   *
   * ⚠️ **「连续」指的是「连续几轮零产出」，不是「连续几次请求」**：一轮里既铸出了 key
   * 又撞了限流时，`./tender.ts` 会**重新起一串**（`hits` 回到 1），因为那一轮上游明明
   * 还在给我们发号 —— 它不是「越限越死」的那种形态。判据在
   * `tests/unit/registrar/domain-ledger-io.test.ts` 的
   * 「同一轮里既铸出了 key 又撞上限流：退避重新起一串（hits 回到 1），不接着翻倍」。
   */
  hits: number;
}

/**
 * 边缘层退避的基数：15 分钟。
 *
 * 🟢 **实测 + 余量**：实测那一层的惩罚窗口约 14 分钟才退净，且窗口内每打一次就续
 * 一次。向上取整再加 1 分钟余量。
 *
 * ⚠️ **这个数是观测不是承诺**：它来自单一出口、单日样本，换出口或换时段可能完全
 * 不同。所以间隔那两个旋钮留在可配那一侧，而这个基数是常量（见文件末尾那段）。
 */
export const EDGE_BACKOFF_MS = 900_000;

/**
 * 应用层退避的基数：30 分钟。
 *
 * 🔴 **没有任何实测支撑，是猜的，不许在别处被写成实测结论。**
 * 我们只知道「≥60 秒间隔下第 7 次会触发」，**窗口有多长我们没量过**。
 * 取一个补池周期（默认 `TEND_INTERVAL_MS` = 30 分钟），依据只有一条：
 * **我们不知道它多长，所以至少跳过下一轮。**
 */
export const APP_BACKOFF_MS = 1_800_000;

/**
 * 指数退避的封顶：4 小时（默认基数下约 8 轮）。
 *
 * 🟡 取舍：超过这个长度基本可以确定是**出口 IP 被长期限了**，那该让运维在面板上
 * 看见并去换出口，而不是让程序无限等下去。
 */
export const BACKOFF_MAX_MS = 14_400_000;

/**
 * 从存储读回来的退避状态。**逐字段窄化**：任一字段读不得就整条返回 `null`。
 *
 * ⚠️ **方向与 `narrowDomainLedger` 相反，这是刻意的**：台账读坏了当成「什么都没
 * 记住」是安全的（多探几次），而退避读坏了当成「还在退避中」会让注册机静默停摆。
 * 这里的 fail-safe 方向是**放行**，代价明写：一把被写坏的退避键 = 多打一轮，
 * 而那一轮撞上限流会立刻把退避重新写上。
 */
export function narrowBackoff(raw: unknown): BackoffState | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== "edge" && o.kind !== "app") return null;
  if (!Number.isFinite(o.until) || !Number.isFinite(o.since) || !Number.isFinite(o.hits)) return null;
  return { until: o.until as number, kind: o.kind, since: o.since as number, hits: o.hits as number };
}

/** 现在还在退避窗口里吗。**唯一判据是这一处值比较**，与 `acquireTendLock` 同一形态。 */
export function inBackoff(state: BackoffState | null, now: number): boolean {
  return state !== null && state.until > now;
}

/** 还要等多久（毫秒）。不在窗口里时是 `null`——给一个已经过去的时刻会让面板渲染出
 * 一个恒为 0 的假倒计时（口径逐字照 `manualTendQuota()`）。 */
export function retryAfterMs(state: BackoffState | null, now: number): number | null {
  return state !== null && state.until > now ? state.until - now : null;
}

/**
 * 上一串还算不算数。**为真时 `nextBackoff` 重新起一串**（`hits` 回到 1）。
 *
 * 判据只有一条：**上一段退避窗口过完之后，隔了比封顶那一档还久都没再撞过。**
 * 那时旧的 `hits` 已经不是「连续」的证据了 —— 它是几小时前那一串的残留。
 *
 * ⚠️ **刻意复用 `BACKOFF_MAX_MS` 当阈值，不新增第四个常量**：合法的一串里，两次撞之间
 * 最多隔一个「上一段窗口 + 一个补池间隔」，而窗口本身封顶就是它 ⇒ 真正连续的那些串
 * 一个都不会被这条误伤；能被它判断的只有「中间隔了半天以上」那种。加一个旋钮要付的
 * 一整圈门禁写在文件末尾那段。
 *
 * **它治的是一条真实的驻留路径**：池子填满之后 `tendOnce` 在 `need <= 0` 那里就 return 了，
 * **根本走不到收尾**（`./tender.ts` 的 `finishRound`），于是一把 `hits` 很高的退避键会
 * 一直留在存储里；等池子再耗干时第一次撞限流就直接跳到封顶那一档。
 */
function streakBroken(prev: BackoffState | null, now: number): boolean {
  return prev === null || now - prev.until > BACKOFF_MAX_MS;
}

/**
 * 撞上限流之后的下一个退避窗口。
 *
 * `hits` 数的是**这一串**里撞了几次。**两种情况会重新起一串**（`hits` 回到 1）：
 * ① 调用方传 `null` —— `./tender.ts` 的 `finishRound` 上方那一段逐字写着它什么时候传：
 *    **这一轮铸出了 key**（那一轮上游明明还在给我们发号，不是「越限越死」那种形态）；
 * ② 上一串早就过完了（`streakBroken`）。
 *
 * ⚠️ **「清掉整把键」是另一回事，不在本函数里**：那是 `./tender.ts` 的
 * `finishRound` 调 `deps.saveBackoff(null)`（一轮之内一次限流都没撞到时走这一支）。
 *
 * ⚠️ **`since` 取旧的那个**：它说的是「这一串连续限流是从什么时候开始的」，
 * 每次都刷新就等于把它变成 `until - 一个窗口`，那样面板上「已经限了多久」永远只会
 * 显示一个窗口长。重新起一串时它才推到当前时刻 —— `mergeBackoff` 靠这一点分辨串。
 */
export function nextBackoff(prev: BackoffState | null, kind: BackoffKind, now: number): BackoffState {
  const streak = streakBroken(prev, now) ? null : prev;
  const hits = (streak?.hits ?? 0) + 1;
  const base = kind === "edge" ? EDGE_BACKOFF_MS : APP_BACKOFF_MS;
  // `2 ** (hits - 1)` 在 hits 很大时会溢出成 Infinity，先夹后乘。
  const factor = Math.min(2 ** Math.min(hits - 1, 30), Number.MAX_SAFE_INTEGER);
  const span = Math.min(base * factor, BACKOFF_MAX_MS);
  return { until: now + span, kind, since: streak?.since ?? now, hits };
}

/**
 * 两份退避状态合一份。**KV 没有 CAS，这把键也是读-改-写。**
 *
 * 🔴 **丢更新在这把键上最疼**：丢掉 `until` 等于退避窗口凭空消失 ⇒ 继续打 ⇒
 * 每打一次续一次窗口 ⇒ 正好回到本次要修的那个缺陷。所以**窗口本身一律取更保守的那个**：
 * `until` 取大的，`kind` 跟着胜出的 `until` 走。
 * 这把丢更新的后果从「覆盖」降到「取更保守的那个」，但**消灭不了它**（没有 CAS 就
 * 消灭不了），与 `pool:index` 是同一句诚实限定。
 *
 * ⚠️⚠️ **`hits` 不能照着 `until` 那条「取大的」办，这是一条实测出来的坑**：
 * `nextBackoff` 重新起一串时写回来的 `hits` 是 1，而存储里那份旧的可能是 5 ——
 * 无脑取大就把「重新起一串」在**落盘这一层**原地撤销掉，而 `tendOnce` 那一侧的判据
 * （注入的假 `saveBackoff`）照样全绿：一份行为在两个地方各说各话。
 * ⇒ 判据是 `since`：**它只在重新起一串时才前进**，所以 `since` 更大的那一份说的就是
 * 更新的那一串，`hits` / `since` 整对跟着它走；两份 `since` 相同才是同一串，
 * 那时才取 `hits` 更大的（同一串里的丢更新，仍按更保守处理）。
 */
export function mergeBackoff(cur: BackoffState | null, next: BackoffState): BackoffState {
  if (cur === null) return next;
  const streak = cur.since === next.since
    ? { since: cur.since, hits: Math.max(cur.hits, next.hits) }
    : (next.since > cur.since ? { since: next.since, hits: next.hits } : { since: cur.since, hits: cur.hits });
  const winner = cur.until >= next.until ? cur : next;
  return {
    until: Math.max(cur.until, next.until),
    kind: winner.kind,
    since: streak.since,
    hits: streak.hits,
  };
}

/*
 * ⚠️ **退避时长刻意做成常量、不加 env 旋钮**（与 `MANUAL_TEND_COOLDOWN_MS` 同形态）。
 *
 * 加一个旋钮要连带 `.env.example` + `config-provenance` + `EDITABLE` + `ENV_ALIASES`
 * + 面板一格 + 五语言文档表 + `tests/helpers/registrar-grid.ts` 的网格，
 * 而它的可调需求远低于间隔那两个（`MINT_DELAY_MIN_MS` / `MINT_DELAY_MAX_MS`
 * 本来就在可配那一侧，因为 4~6 次/窗口、≥60 秒间隔那些数全部来自单一出口、单日样本）。
 *
 * ⚠️ **同样没有加的：跨轮令牌桶。** 它确实能挡住「Cron 一轮 + 两次手动补池在半小时
 * 里叠出十几次发码请求」这种叠加，但要付一整圈门禁，而退避键 + 整轮中止已经把主
 * 路径堵死了。**如实登记为已知缺口，不是「已经防住了」。**
 */
