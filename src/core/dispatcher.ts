/**
 * ── 硬约束 2（`src/core/` 零 IO）的既定豁免清单 ──────────────────────────────
 *
 * 本文件保留两处「看起来违反」的写法，各有理由，**清单不许再变长**。
 * 谁在守它，说准（此前这里含糊带过，而台账把它写成了「有源码断言钉着」——那句是假的）：
 *   · 第 1 条 `setTimeout`：**有源码断言**，`tests/unit/source-guards.test.ts` 的
 *     零 IO 扫描把 `src/core` 里**下列 8 类记号**的使用点与一份**手写**清单逐条比对，
 *     多一处（哪怕是同一个文件里的第二处）立刻变红：
 *       `setTimeout` / `setInterval` / `setImmediate`、`new Date`、`Date.*`、
 *       `performance.*`、`Math.random`、`crypto.*`、裸 `fetch(`、`process.*`
 *     （`globalThis.` / `self.` / `window.` 前缀与 `?.` 可选链都会先归一再扫）。
 *     **是「这 8 类」而不是「全部 IO」——别再把它读成后者。** 任何基于 grep 的门禁都
 *     不可能完备；它覆盖什么、抓不住什么，由那个文件里 `COVERED` / `BLIND_SPOTS`
 *     两张**可执行**的表钉着，不由这段注释宣称。本注释的第一版正是栽在这里：
 *     写成「全 src/core 的时间/随机/定时/网络/环境使用点」，而 `globalThis.setTimeout`、
 *     `new Date()`、`performance.now()` 三种最地道的写法当时全都隐身。
 *   · 第 2 条模块级 `let cursor`：**没有断言，只有这段注释 + 评审 checklist**。
 *     它是可变模块状态，不是某个可 grep 的全局 API，扫描抓不住它。
 *   · 裸 `console`：`tests/unit/registrar/log-prefix.test.ts` 扫 `src/core` 全目录，
 *     `tests/unit/source-guards.test.ts` 扫 `src/http` 与 `src/ui`。
 *
 * 1. `setTimeout(() => controller.abort(), timeoutMs)`
 *    改成注入的 timer 端口只有这一个消费者，纯增抽象；换成 `AbortSignal.timeout()`
 *    则会丢掉「首字节到达后立刻 clearTimeout 让响应体自由流动」这个语义——流式响应
 *    会在 8 秒时被拦腰 abort。**这是热路径上一次真实的行为退化，不划算。**
 *
 * 2. 模块级 `let cursor`
 *    Worker 上每个 isolate 各一份，轮询起点因此不全局一致。已登记 P4；
 *    在修掉之前，**面板不许展示「下一把 key / 轮换顺序」**——展示了就是给一个
 *    与实际不符的值。
 *
 * `crypto.subtle` 已随 keyId() 迁到 keypool-repo.ts，豁免理由见那里；
 * `KeyPoolRepo.add()` 里原来那个裸 `Date.now()` 也随之换成了注入的 `now`。
 */
import type { KeyRecord } from "./types.js";
import type { KeyPoolRepo } from "./keypool-repo.js";
import { selectKey, applySuccess, applyCooldown, applyStrike, applyEvict, poolHealth } from "./keypool.js";
import { withOutcome } from "./admin/stats.js";
import { classifyStatus, classifyThrown } from "./errors.js";
import type { Fetcher } from "../ports/fetcher.js";
import type { GatewayConfig } from "./config.js";
import { NULL_LOGGER, type Logger } from "../ports/logger.js";

export interface DispatchDeps {
  repo: KeyPoolRepo;
  fetcher: Fetcher;
  config: GatewayConfig;
  now: () => number;
  /**
   * 记账失败要留痕。**可选 + 默认静默**是刻意的：`DispatchDeps` 有三十多处测试构造点，
   * 改成必填只会换来一次机械 sed。代价（忘了在生产接线上传它）由
   * `tests/contract/wiring.test.ts` 那条「记账失败必须落一条可筛选的事件」
   * **行为**断言钉住——它走真 `createApp`，抄一份装配骗不过它。
   */
  logger?: Logger;
}

let cursor = 0;

/**
 * 出站响应头白名单。上游响应头一律**不**原样转发，只保留客户端解析响应必需的几个。
 *
 * 理由有三：①`set-cookie` / `www-authenticate` / `authorization` 这类头带的是上游的
 * 凭据语义，透传等于把它们落到网关自己的域上；②上游的 `x-*` 内部头是不受控的泄漏面
 * （实测 `x-upstream-internal` 会原封不动到达客户端）；③池子每次请求都可能换一把 key，
 * 逐 key 的限流/配额头对客户端只是误导。
 *
 * 不含 `content-length` / `content-encoding`：响应体在这里被重新包装（fetch 已解压），
 * 沿用上游的这两个头会与实际字节不符。
 *
 * 含 `content-disposition`：媒体路由（图片/视频）承诺「上游返回什么就原样转发响应体」，
 * 剥掉它会导致浏览器端下载丢失文件名。它不带凭据语义，也不像 `content-length` 那样
 * 可能与重新包装后的实际字节不一致，放行是安全的。
 *
 * 不含 `accept-ranges` / `content-range`：两者都是 range 请求的语义，网关目前不支持
 * range（不解析、不转发 `Range` 请求头），放行只会让客户端以为支持而发起注定失败的
 * range 请求，属于误导而非帮助。
 */
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "retry-after", "content-disposition"];

/**
 * 会被浏览器当成**同源可执行 / 可渲染文档**的 MIME。上游返回这些时改写成
 * `application/octet-stream`，让浏览器只能下载、不能渲染也不能执行。
 *
 * **为什么是 deny-list 而不是 allow-list**：媒体路由承诺「上游返回什么就原样转发」，
 * allow-list 会把没预料到的媒体类型（新的图片/视频容器）打成下载，那是真的功能退化。
 * **边界写清楚**：deny-list 永远列不全，这里的目标是把「同源文档」这一类关掉，
 * 不是做完备的 MIME 治理。剩下的由 CSP、`nosniff` 与两把钥匙的隔离一起兜。
 *
 * 为什么需要它：`script-src 'self'` 的隐含前提是「本源只有面板脚本」，
 * 而 `/v1/videos/:id` 是一条接受 `?key=` 的 GET 路由（见 src/http/middleware/auth.ts
 * 对查询参数的兼容），响应的 content-type 又是上游逐字透传的 —— 于是这个源上可以
 * 出现一个攻击者影响得了的同源文档，而 `ADMIN_TOKEN` 就存在这个 origin 的
 * localStorage 里（localStorage 的作用域是 **origin 而不是 path**）。
 *
 * ⚠️ **全局 `nosniff` 挡不住这一半。** `nosniff` 只否掉「按内容嗅探出一个更危险的
 * 类型」，它不阻止浏览器渲染一个**显式声明**为 `text/html` 的响应——直接导航过去
 * 就是一个同源文档，里面的 `<script>` / `on*` / `javascript:` 都会执行。
 */
const DOCUMENT_MIME = /^\s*(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript|application\/x-javascript|application\/ecmascript|text\/ecmascript)\b/i;

function clampContentType(v: string): string {
  return DOCUMENT_MIME.test(v) ? "application/octet-stream" : v;
}

function safeHeaders(res: Response): Headers {
  const headers = new Headers();
  for (const name of SAFE_RESPONSE_HEADERS) {
    const v = res.headers.get(name);
    if (v === null) continue;
    headers.set(name, name === "content-type" ? clampContentType(v) : v);
  }
  return headers;
}

/** 按白名单重建一个出站响应，响应体（含流式）原样搬运。 */
function sanitize(res: Response): Response {
  return new Response(res.body, { status: res.status, headers: safeHeaders(res) });
}

/**
 * 丢弃一个不再需要的上游响应。
 *
 * 换 key 重试时被覆盖的那个 Response 如果不取消，它的响应体就一直挂在连接上没人消费；
 * 上游 5xx 风暴时每个请求会泄漏「池大小 - 1」个响应体——恰恰是资源压力最大的时候。
 */
async function discard(res: Response | null): Promise<void> {
  if (!res || !res.body || res.bodyUsed) return;
  try {
    await res.body.cancel();
  } catch {
    // 已被关闭或已被取消，忽略即可。
  }
}

type FailReason = "pool_empty" | "all_cooling" | "all_evicted" | "upstream_error";

function fail(reason: FailReason, message: string, retryAfterSec?: number): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (retryAfterSec !== undefined) headers["retry-after"] = String(retryAfterSec);
  return new Response(JSON.stringify({ error: { reason, message } }), { status: 503, headers });
}

/**
 * 池子整体不可用时的 503。
 *
 * `reason` 必须让客户端能区分「会自愈」与「不会自愈」（设计 §7.2.1）：原实现把网络
 * 全失败也报成 `all_cooling`，而 message 却写「全部 key 均已尝试且失败」，自相矛盾，
 * 且暗示会自愈——在 strike 即永久剔除的旧语义下它永远不会自愈。
 */
function unavailable(records: KeyRecord[], now: number): Response {
  const h = poolHealth(records, now);
  if (h.total === 0) return fail("pool_empty", "key 池为空，请先导入 key");

  if (h.evicted === h.total) {
    return fail(
      "all_evicted",
      `全部 ${h.total} 把 key 均因凭据失效被永久剔除，不会自动恢复，请更换 key`,
    );
  }

  if (h.fresh === 0) {
    // 冷却是有期限的，把最早恢复的时刻折成 Retry-After，客户端就不必盲目轮询。
    const earliest = Math.min(
      ...records.filter((r) => !r.evicted).map((r) => r.cooldownUntil),
    );
    const retryAfterSec = Math.max(1, Math.ceil((earliest - now) / 1000));
    return fail(
      "all_cooling",
      `全部 key 暂不可用：${h.cooling} 把冷却中（到期自动恢复）、${h.evicted} 把已永久剔除`,
      retryAfterSec,
    );
  }

  return fail("upstream_error", "已尝试池中每一把 key，上游均返回失败；key 本身仍可用");
}

/**
 * 端点的**上游延迟语义**，决定用哪个超时预算、以及超时后如何处置这把 key。
 *
 * 判据是「上游的第一个字节什么时候才可能到达」，不是端点的名字：
 *
 * - `firstByte`：上游一开口就算首字节，用 `UPSTREAM_TIMEOUT_MS`（8 秒）。**流式**响应
 *   属于这一类，慢 key 在这里被快速甩掉（设计 §7.3）；视频轮询（`GET /videos/{id}`）
 *   虽然不是流式，但它只查一次任务状态，同样是快接口，也归这一类。
 * - `sync`：首字节要等上游把整个结果算完才到达，用 `UPSTREAM_SYNC_TIMEOUT_MS`
 *   （默认 2 分钟）。图片生成、视频建任务属于这一类，**非流式对话同样属于这一类**
 *   ——上游要把整段回答生成完才发响应头，与图片生成是同一种延迟语义。
 *
 * 因此路由层的判据是 `timeout: stream ? "firstByte" : "sync"`；档位仍由调用方显式传入
 * 而不在这里按 `stream` 自动推断，因为视频轮询是「非流式的快接口」这唯一的例外。
 */
export type TimeoutProfile = "firstByte" | "sync";

/**
 * 同步档下，单次尝试最多用掉整体预算的几分之一。
 *
 * 取 2 是为了同时满足两个互相拉扯的要求：①客户端最坏只等**一个**预算
 * （`UPSTREAM_SYNC_TIMEOUT_MS`），不能是「池大小 × 预算」；②一把挂起的 key
 * （TCP 连得上但永不响应）不能吃掉整个请求，必须还能换一把再试——否则 20 把 key
 * 的池子里只要有 1 把挂起，就有 5% 的请求硬失败，且没有任何自愈通路。
 * 两者只能靠切分预算调和：单次尝试 1/2 预算，超时后换下一把 key 再用剩下的 1/2。
 *
 * 默认配置下单次仍有 60 秒，是实测图片生成耗时（11.99 秒）的五倍。代价是：若单次调用
 * 真有可能超过预算的一半，就该把 `UPSTREAM_SYNC_TIMEOUT_MS` 设成「单次最坏耗时的两倍
 * 以上」——五份 DEPLOY.md 的环境变量表已写明这一点。
 */
const SYNC_ATTEMPT_SHARE = 2;

/**
 * 同步档把整体预算耗光仍未拿到任何上游响应：504。
 *
 * 只有「本次请求的每一次尝试都超时」才会走到这里——只要有任何一把 key 真的应答过
 * （哪怕是 500），返回的就是那把 key 的结果，而不是这个 504。
 *
 * 文案刻意**不**断言「这是超时预算问题而非 key 故障」：原实现这么写，而在「key 对应的
 * 上游会话被挂起」时它是一句假话，会把运维引向调大 `UPSTREAM_SYNC_TIMEOUT_MS`，只会让
 * 挂起挂得更久。这里只陈述事实——试了几把 key、总预算多少、本次没有惩罚任何 key——
 * 并把两种可能都摆出来。
 */
function syncBudgetExhausted(triedKeys: number, budgetMs: number): Response {
  return jsonBody(504, {
    error: {
      reason: "upstream_timeout",
      message: `同步端点用尽了 ${budgetMs} 毫秒的总预算：已尝试 ${triedKeys} 把 key，均未在各自的尝试预算内收到上游响应。可能是上游整体变慢或预算配小（可调大 UPSTREAM_SYNC_TIMEOUT_MS），也可能是这几把 key 对应的上游会话被挂起；本次未惩罚任何 key`,
    },
  });
}

export async function dispatch(args: {
  path: string;
  body: unknown;
  stream: boolean;
  method?: "GET" | "POST";
  /** 见 TimeoutProfile。缺省为 `firstByte`，即保持原有的 8 秒首字节语义。 */
  timeout?: TimeoutProfile;
  /**
   * 调用方随后会把响应体解析成 JSON 做协议转换时置为 true。
   *
   * 「上游 200 但响应体不是 JSON」是上游异常，不是客户端错误：若放任它冒泡到路由里
   * 的 `res.json()`，结果是一个纯文本 500，而且这把持续吐 HTML 错误页的 key 不会被
   * 记账，会被无限轮到。故在这里就地校验：解析失败即记 strike 并换下一把 key，
   * 全部失败时返回 502。响应体本来就要被完整读取，因此不产生额外开销。
   */
  expectJson?: boolean;
  deps: DispatchDeps;
}): Promise<Response> {
  const { repo, fetcher, config, now } = args.deps;
  const logger = args.deps.logger ?? NULL_LOGGER;
  const profile: TimeoutProfile = args.timeout ?? "firstByte";
  const records = await repo.all();
  if (records.length === 0) return fail("pool_empty", "key 池为空，请先导入 key");

  // 同步档的预算是**跨 key 共享**的：`deadline` 决定客户端的等待上界（始终是一个
  // `UPSTREAM_SYNC_TIMEOUT_MS`），`attemptBudget` 决定单次尝试最多占用其中多少，
  // 剩下的留给「换一把 key 再试」。见 SYNC_ATTEMPT_SHARE。
  const syncDeadline = now() + config.upstreamSyncTimeoutMs;
  const syncAttemptBudget = Math.max(
    1,
    Math.floor(config.upstreamSyncTimeoutMs / SYNC_ATTEMPT_SHARE),
  );

  let lastError: Response | null = null;
  const attempts = records.length;
  /** 本次请求里超时过的 key 槽位（同步档专用），见 attributeSyncTimeouts。 */
  const timedOutSlots: number[] = [];

  const commit = async (at: number, updated: KeyRecord) => {
    try {
      // 传上一份：save() 据此判断「这次改动是不是只动了 lastUsedAt」，只动了就不落盘。
      // 不传的话每次成功转发都要写一次 KV，而免费档写配额是 1,000/天。
      await repo.save(updated, records[at]);
    } catch (err) {
      // **必须吞掉。** 这里是成功分支上的最后一步，异常会一路冒到 app.onError，
      // 把一次已经成功的上游转发变成 500——客户端拿不到那份它本该拿到的响应体。
      // 「记账失败」的正确后果是「这次调度状态没记住」，下一次请求会重新观测到
      // 同样的上游行为并重试记账；把它升级成「请求失败」是拿一次成功去换一条日志。
      logger.log({
        level: "error", event: "pool.commit_failed",
        msg: "key 状态回写失败：本次请求的结果不受影响，但这一次调度记账丢了",
        fields: { id: updated.id, err: err instanceof Error ? err.message : String(err) },
      });
    }
    // **无论落盘成不成都要推进本请求内的视图**：同一个请求里换下一把 key 时
    // selectKey 读的就是这个数组，不推进会把刚判过冷却的那把再选一遍。
    records[at] = updated;
  };

  /**
   * 记一次终态并落盘。**记账与调度分两步叠加**：`apply*` 先算调度状态，再叠 Tier-1。
   *
   * 分两步而不是把计数并进 `apply*`：调度那套是「丢一次就是事故」的，
   * 而 Tier-1 是明说了会少计的近似值，两套语义混在一个函数里迟早互相拖累。
   */
  const commitOutcome = async (
    at: number, updated: KeyRecord,
    outcome: "success" | "failed" | "clientError", errKind: string | null,
  ) => { await commit(at, withOutcome(updated, outcome, now(), errKind)); };

  /**
   * 同步档超时的归因：只有当**同一次请求里**另一把 key 真的成功了，才把先前那些超时
   * 记到对应 key 头上。
   *
   * 这是能拿到的最强的对照：同一时刻、同一个上游、同一份预算，A 超时而 B 成功，
   * 说明上游当时是应答得了的，超时来自 A 自己（例如会话挂起）。反过来，如果整轮下来
   * 没有任何 key 成功，那更可能是预算配小了或上游整体变慢——那是配置/上游的问题，
   * 不该记到 key 头上（原实现正是在这里把一次图片请求变成「整池各记一次 strike」）。
   *
   * 记账复用既有的 strike 通路：累计到 `MAX_STRIKES` 进长冷却、成功即清零，与其他
   * 瞬时故障同一套语义，不额外引入一个需要迁移的计数字段。
   */
  const attributeSyncTimeouts = async (successSlot: number) => {
    for (const at of new Set(timedOutSlots)) {
      // 同一把 key 先超时后成功（第二次尝试变快了）时不惩罚它：它刚刚自证还活着。
      if (at === successSlot) continue;
      await commitOutcome(at, applyStrike(records[at]!, now(), config, "sync timeout"), "failed", "sync timeout");
    }
    timedOutSlots.length = 0;
  };

  /** 一把 key 都没应答时的兜底响应：同步档耗尽预算报 504，其余情形沿用池健康度的 503。 */
  const nothingAnswered = () =>
    timedOutSlots.length > 0
      ? syncBudgetExhausted(new Set(timedOutSlots).size, config.upstreamSyncTimeoutMs)
      : unavailable(records, now());

  // 任何一条 return 路径都要先把攒着的上一个上游错误响应体取消掉，否则它的
  // 响应体永远没人消费（见 discard 的说明）。
  const done = async (out: Response): Promise<Response> => {
    await discard(lastError);
    return out;
  };

  for (let i = 0; i < attempts; i++) {
    let timeoutMs = config.upstreamTimeoutMs;
    if (profile === "sync") {
      const remaining = syncDeadline - now();
      // 预算耗尽就别再发注定被立刻 abort 的请求了。
      if (remaining <= 0) break;
      timeoutMs = Math.min(syncAttemptBudget, remaining);
    }

    const picked = selectKey(records, cursor, now());
    if (!picked) {
      return lastError ?? nothingAnswered();
    }
    cursor = picked.nextCursor;
    const record = picked.record;
    const slot = records.indexOf(record);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const method = args.method ?? "POST";
    const init: RequestInit & { signal: AbortSignal } = {
      method,
      headers: {
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${record.key}`,
      },
      signal: controller.signal,
    };
    if (method === "POST") init.body = JSON.stringify(args.body);

    let res: Response;
    try {
      res = await fetcher.fetch(`${config.agnesBaseUrl}${args.path}`, init);
    } catch (err) {
      clearTimeout(timer);
      const action = classifyThrown(err);
      const reason = action.kind === "strike" ? action.reason : "unknown";

      // 同步档超时**先不记账**：此刻还分不清是「预算配小了」还是「这把 key 挂起了」。
      // 先记下它，继续用剩余预算换下一把 key；等本次请求有没有 key 成功之后再归因
      // （见 attributeSyncTimeouts）。
      if (profile === "sync" && reason === "timeout") {
        timedOutSlots.push(slot);
        continue;
      }

      await commitOutcome(slot, applyStrike(record, now(), config, reason), "failed", reason);
      continue;
    }
    // 首字节已到，解除超时，让响应体自由流动。
    clearTimeout(timer);

    const action = classifyStatus(res.status, config);

    if (action.kind === "success") {
      if (args.expectJson) {
        const text = await res.text().catch(() => null);
        if (text === null || !isJson(text)) {
          await commitOutcome(slot, applyStrike(record, now(), config, "upstream non-JSON body"), "failed", "upstream non-JSON body");
          await discard(lastError);
          lastError = jsonBody(502, {
            error: { reason: "upstream_bad_body", message: "上游返回了非 JSON 的成功响应" },
          });
          continue;
        }
        await attributeSyncTimeouts(slot);
        await commitOutcome(slot, applySuccess(record, now()), "success", null);
        return done(new Response(text, { status: res.status, headers: safeHeaders(res) }));
      }
      await attributeSyncTimeouts(slot);
      await commitOutcome(slot, applySuccess(record, now()), "success", null);
      return done(sanitize(res));
    }
    if (action.kind === "passthrough") {
      // 上游 4xx 直通。**这是 Tier-1 唯一新增的记账点，而它不按次数新增写**：
      // 它既不改调度字段也不动 `lastUsedAt` ⇒ `schedulingEqual` 为真且 `n - p === 0`
      // ⇒ 被写消除吃掉、只进 `pendingStats`，等攒满一个 `touchIntervalMs`
      // （默认 6 小时）才随那次强制落盘一起下去。
      //
      // 「不按次数新增写」这句是可证伪的，别当散文读：`tests/unit/pool-cache.test.ts`
      // 的「只有 4xx 直通……攒够一个触达间隔也会落盘」数着 put 次数——10 次 4xx 只落 2 次盘
      // （跨 2 个触达间隔），而不是 10 次。设计文档 §6.1 说要把它按次计进配额账的
      // 那半因此不成立，订正见计划的 F1。
      await commitOutcome(slot, record, "clientError", null);
      return done(sanitize(res));
    }

    if (action.kind === "evict") {
      // 上游 401/403 说的是「池里这把 key 失效了」，与客户端无关，绝不能把上游的
      // 错误体透传出去：凭据无效的错误体恰恰是各家 API 最爱回显 key 片段的地方，
      // 这是本项目唯一一条上游 key 可能触达客户端的通路。改为合成网关自己的错误体。
      // 注意只丢弃这次的 401 响应，不动 lastError：先前某把 key 的真实上游错误
      // （例如 500）仍然是更有信息量的回复，不该被一次凭据失效抹掉。
      await discard(res);
      await commitOutcome(slot, applyEvict(record, action.reason), "failed", action.reason);
      continue;
    }

    await discard(lastError);
    lastError = sanitize(res);

    if (action.kind === "cooldown") {
      await commitOutcome(slot, applyCooldown(record, now(), action.ms, action.reason), "failed", action.reason);
    } else {
      await commitOutcome(slot, applyStrike(record, now(), config, action.reason), "failed", action.reason);
    }
  }

  return lastError ?? nothingAnswered();
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function jsonBody(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
