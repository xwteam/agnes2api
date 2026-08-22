import type { Context } from "hono";
import type { Fetcher } from "../../../ports/fetcher.js";
import type { KeyPoolRepo } from "../../../core/keypool-repo.js";
import type { GatewayConfig } from "../../../core/config.js";
import type { ProbeGuard } from "../probe-guard.js";
import { httpError } from "../../errors.js";
// ⚠️ **只 import 真的会用到的**：验活用的是 `upstreamPath`，**不是 `endpointFor`**（见下面约束 6）。
// ⚠️ **本仓没有任何东西会拦住一个没用上的 import**（实测：`grep -n "noUnusedLocals\|noUnusedParameters"
// tsconfig*.json` 零命中，十二道门禁里也没有 lint）。上一版这里写着「`noUnusedLocals` 一开
// 就是编译失败」——**那是一句没核过的话**。多 import 一个只会被评审看见，别指望机器。
import { protocolById, MODEL_CATALOG } from "../../../core/admin/protocol-catalog.js";

/**
 * `POST /admin/api/keys/:id/verify` —— 单把 key 的验活（设计 §10.2 / §11，订正 D1）。
 *
 * **这是本仓第一次让后端拿着某一把具体的明文 key 去打上游。**
 *
 * ── 六条约束，一条都不许省 ──────────────────────────────────────────────────
 *
 * 1. **写零个存储字段**（计划订正 F8）。设计文档给了一行端点，**全文没有一句说它对
 *    这把 key 的状态做什么**，而两个「显然」的答案各自是一颗自毁按钮：
 *    · **失败记 strike** ⇒ 面板上连点几次就能把一把好 key 打进长冷却甚至剔除；
 *    · **成功清 strike / 解除 evicted** ⇒ **L4「重新导入即解封」后门的同型复发**，
 *      入口从「重新导入」换成「点一下验活」，而 P3c 已经为 L4 专门设计过知情勾选框。
 *    连 Tier-1 的 `stats` 也不写——`stats` 是「真实流量的证据」（设计订正 D1 原话），
 *    掺进人造探测就不再是证据了。
 *    **代价，明写**：刷新面板后看不到「上次验活结果」。这是对的：面板已有的
 *    `bucket` / `strikes` / `lastErrorKind` 才是那个问题更可信的答案。
 *    由 `tests/contract/admin-verify.test.ts` 的
 *    「验活之后 storage 的 put / delete 计数都是 0 —— 失败记 strike 与成功清 strike 各自是一颗自毁按钮」
 *    钉着。
 *
 * 2. **一个字节的上游正文都不许回给面板。** 上游 401/403 的错误体恰恰是各家 API
 *    最爱回显 key 片段的地方——`src/core/dispatcher.ts` 的 evict 分支为这件事专门
 *    丢弃了那个响应体，注释里写着「这是本项目唯一一条上游 key 可能触达客户端的通路」。
 *    **这里是第二条。** 只回结构化结果：`{ ok, status, latencyMs, reason }`。
 *    由 `tests/contract/admin-verify.test.ts` 的
 *    「上游 401 的响应正文一个字节都不回给面板 —— 凭据无效的错误体正是各家 API 最爱回显 key 片段的地方」
 *    钉着，而那一格断言的是**整段响应体文本**的 `not.toContain`，不是逐字段查：
 *    handler 将来多回一个字段时，逐字段查的那种写法会静默漏掉。
 *    ⚠️ **响应体不是唯一的出口，第二条是事件环**：事件板块不但能在面板上读，
 *    还能整份下载（`GET /admin/api/events/download`）。所以 `VerifyDeps` 里
 *    **刻意一格 `Logger` 都没有**——这条端点在结构上就打不出日志，不是靠"记得别写"。
 *    往这个 deps 里加 logger 之前，先想清楚要打的那条事件里有没有 `rec.key`
 *    或上游正文。
 *
 * 3. **走注入的 `Fetcher` 端口，不许裸 `fetch`**（`src/ports/fetcher.ts`）。
 *    没有它这个端点在测试里根本桩不掉、每跑一次就真打一次外网。
 *    ⚠️ **如实登记：`tests/unit/source-guards.test.ts`「扫描到的使用点恰好等于手写的豁免清单」
 *    那道零 IO 扫描接不住这一条**——它 `walkTs("src/core")`，只扫 `src/core`，
 *    而本文件在 `src/http`（本任务变异 M7 实测：改成裸 `fetch` 之后那道门禁一格都不红）。
 *    真正接住它的是
 *    `tests/contract/admin-verify.test.ts` 里所有观测桩 fetcher 的格子——裸 `fetch`
 *    之后桩上一次调用都收不到，它们当场变红。**别把那道门禁当成这条的护栏。**
 *
 * 4. **自带 AbortController + 超时**。它不经 `dispatch()`（那个函数会自己选 key，
 *    而验活要指定某一把），所以 `dispatch` 里那套超时/中止**一样都没有**，必须自己带。
 *    档位取 `config.upstreamTimeoutMs`（首字节档，默认 8 秒）：验活只要一个响应头
 *    就够了，给它同步档（默认 2 分钟）等于让面板挂两分钟。
 *
 * 5. **`repo.get(id)` 直读存储，不读 isolate 快照**。`repo.all()` 交出来的最多是一个
 *    `POOL_CACHE_TTL_MS` 之前的视图，拿它去验一把刚被改过的 key 是在验旧值——
 *    而「刚改过就想验一下」正是运维点这颗按钮的主要场景。
 *
 * 6. **上游路径从协议目录的 `upstreamPath` 取，不许硬编码**（评审 C3）。
 *    目录的 `pathTemplate` 是**网关对外**的路径（`/v1/chat/completions`），
 *    `upstreamPath` 才是**网关对上游**的那一条（`/chat/completions`，与
 *    `src/core/dispatcher.ts` 里 `${config.agnesBaseUrl}${args.path}` 那一句同源）。
 *    **两者混用的后果**：上游路径一变，验活对所有 key 一律报失败，
 *    而面板会显示「整池 key 都死了」——这正是设计 D1 说的「漂了没人会发现」。
 *
 * ── ⚠️ 出站的鉴权头**刻意不取** `proto.authHeader` ──────────────────────────
 *
 * `ProtocolEntry.authHeader` 回答的是「**客户端**用哪个头调这个网关」
 *（四种网关都收，见 `src/http/middleware/auth.ts`），而这里是「**网关**用哪个头调上游」
 * ——上游只认 `Authorization: Bearer`，`src/core/dispatcher.ts` 里那一句
 * `authorization: \`Bearer ${record.key}\`` 是无条件的、与协议无关。
 * **这与 `pathTemplate` / `upstreamPath` 是同一个坑的第二个字段**：目录里同时住着
 * 「对外」和「对上游」两种知识，取错一个不会有编译错误。
 *
 * ⚠️ **但别把危害写大了**：本 handler 固定用 `openai` 那一条，而它的
 * `authHeader` 恰好就是 `"authorization"` ⇒ **今天改成 `proto.authHeader`，出站行为
 * 逐字节相同、一格用例都不会红**（上一版这里写「只会让所有 key 一律验失败」，那是假的）。
 * 它今天是一条**没有变红条件**的纪律：只有当探测换成别的协议、或者某条协议的
 * `authHeader` 变了，它才会真的咬人。**明写这一点，别让下一个人以为有护栏。**
 */
export interface VerifyDeps {
  repo: KeyPoolRepo;
  fetcher: Fetcher;
  now: () => number;
  /** **getter 而不是值**：超时档与上游 base URL 都能在运行中被面板改掉。 */
  config: () => GatewayConfig;
  /** 与通道连通性测试**共用的那一把**，见 `../probe-guard.ts`。 */
  guard: ProbeGuard;
}

export function verifyHandler(deps: VerifyDeps) {
  return async (c: Context) => {
    // ── 请求体：**这条端点不收任何选项**（全局约束 8 点名的解析点）────────────
    //
    // 校验放在最前面：**一次存储读都不产生、一格护栏都不消费**。
    //
    // ⚠️ **不静默忽略请求体。** `{"model":"agnes-2.0-flash"}` 这种"我以为能指定模型"
    // 的写法在宽松实现下是一次「点了、但完全没按你想的那样发生」的静默误操作，
    // 而面板会如实显示成功——与 `handlers/registrar.ts` 里
    // `optionalObjectBody` 拒绝拼错字段名是同一条纪律，那里的原话是
    // 「拼错的字段名在宽松实现下是一次『点了、什么都没按你想的那样发生』的静默误操作」。
    // ⚠️ **空体必须放行**：面板与鉴权矩阵都是不带体调这条 POST 的。
    await rejectAnyBody(c);

    // `?? ""` 与 `handlers/keys-write.ts` 的 `paramId` 同一条理由：`c.req.param()` 的
    // 静态类型是 `string | undefined`，**刻意不写 `as string`**——落到空串时下面那次
    // `repo.get("")` 如实 404。
    const id = c.req.param("id") ?? "";
    // 约束 5：直读存储，不读 isolate 快照。
    const rec = await deps.repo.get(id);
    if (rec === null) throw httpError(404, "not_found", "没有这把 key");

    // ── 护栏（全局约束 14：按一下就打上游的按钮必须连同护栏一起交付）──────────
    //
    // ⚠️ **粒度是 `verify:<id>`，不是全局的 `"verify"`**（评审 I11）：
    // 全局粒度下「验 A 把手」会把「验 B 把手」一起挡掉一个 PROBE_MIN_INTERVAL_MS，
    // 20 把 key 逐个验要串行等 60 秒，而在飞去重让它连并行都不行。
    // 通道测试那边用的是 `channel:<name>`，**同样带标识**，两处口径必须一致。
    //
    // ⚠️ **它必须排在上面那次 404 之后**，理由见 `../probe-guard.ts` 里
    // 「kind 的空间由调用方限界」那一段：挪到前面去，任何一个拿到管理口令的人
    // 都能用随机 id 往护栏的 Map 里无限灌键。
    const kind = `verify:${id}`;
    const g = deps.guard.tryAcquire(kind, deps.now());
    if (!g.ok) {
      return c.json({
        error: { type: "rate_limit_error", message: g.message },
        // 顶层 `reason`，面板据它选五语言文案、不解析中文 `message`
        //（与 `handlers/registrar.ts` 那批 `REASON_*` 同一条口径）。
        reason: g.reason,
      }, 429);
    }

    // ── 从这里到 `finally` 之间不许再有任何会抛的语句 ──────────────────────────
    //
    // 护栏已经占住了，而 `release` 在 `finally` 里。**`tryAcquire` 与 `try` 之间的
    // 每一行都是一段没有 `finally` 覆盖的窗口**：在那里抛一次，这个 kind 就永久卡在
    // 「在飞」，那颗按钮从此再也点不动。所以取协议、取配置、装超时闸**全都挪进 `try`**。
    // ⚠️ **诚实限定**：`new AbortController()` 与 `deps.now()` 仍在 `try` 之外。
    // 两者都不会抛（前者是标准全局构造器，后者是注入的取数函数，生产装配是 `Date.now`），
    // 但**这是「今天不会」而不是「不可能」**——往那两行之间加任何东西之前先想一遍。
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 计时起点。**只读这一次**，`latencyMs` 因此恰好是「这一次读」到「收尾那一次读」
    // 之间的一步，见 `tests/contract/admin-verify.test.ts`
    // 「latencyMs 恰好是一次注入时钟的步长 —— 用真 Date.now 的话它会是 0，把计时挪到护栏之前会是两步」。
    const startedAt = deps.now();
    try {
      // 探测固定用 openai 那一条。**四条协议的 upstreamPath 今天完全相同 ⇒ 选哪条对
      // 出站毫无差别**，选它只因为它是四条的参照系（对外 `/v1/chat/completions` 是
      // 这台网关的门面）。**仍然经目录取**——「今天一样」不是硬编码的理由（评审 C3，约束 6）。
      // ⚠️ 上一版这里写的是「最短的一条协议」，**实测为假**：四条 `sample()` 序列化之后
      // 是 responses 42 < gemini 56 < openai 73 < anthropic 89 字节，**openai 是第三短**。
      const proto = protocolById("openai")!;
      const model = MODEL_CATALOG[0]!.id;
      const cfg = deps.config();
      // 约束 4：它不经 `dispatch()`，那套超时/中止一样都没有，必须自己带。
      timer = setTimeout(() => controller.abort(), cfg.upstreamTimeoutMs);
      const res = await deps.fetcher.fetch(`${cfg.agnesBaseUrl}${proto.upstreamPath}`, {
        method: proto.method,
        headers: { "content-type": "application/json", authorization: `Bearer ${rec.key}` },
        body: JSON.stringify(proto.sample(model)),
        signal: controller.signal,
      });
      // ⚠️ **必须把响应体取消掉**：不消费的话它一直挂在连接上（与 `src/core/dispatcher.ts`
      // 的 `discard()` 同理，那里的原话是「上游 5xx 风暴时每个请求会泄漏『池大小 - 1』
      // 个响应体」）。**顺带也是约束 2 的物理保证**：正文从来没有被读进来过。
      if (res.body && !res.bodyUsed) {
        try { await res.body.cancel(); } catch { /* 已被关闭或已被取消，忽略即可 */ }
      }
      return c.json({
        ok: res.status >= 200 && res.status < 300,
        status: res.status,              // **只回状态码，不回正文**（约束 2）
        latencyMs: deps.now() - startedAt,
        reason: null,
      });
    } catch {
      return c.json({
        ok: false,
        status: null,
        latencyMs: deps.now() - startedAt,
        // **`reason` 是机器可读的 code，不是异常消息**：异常消息里可能带上游 URL
        // 与栈帧，与 `createApp` 的 `app.onError` 刻意不回显 `err.message` 是同一条策略。
        reason: controller.signal.aborted ? "timeout" : "network_error",
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // **必须在 `finally` 里**，理由见 `ProbeGuard.release` 上方那段：放在 `try` 末尾时
      // 一次抛错的探测会让这个 kind 永久卡在「在飞」。
      // ⚠️ **同样不许把上面那条 429 的提前返回挪进这个 `try`**：那样被挡住的那一次
      // 会在 `finally` 里替**正在飞的那一次**把在途标记放掉，于是第三次点击在最小间隔
      // 之后被放行、上游被并发打第二次。见 `tests/contract/admin-verify.test.ts`
      // 「上一次还在飞时，即使已经过了最小间隔，第三次仍然被挡 —— 被 429 的那一次绝不许替在飞的那一次 release」。
      deps.guard.release(kind);
    }
  };
}

/**
 * 这条端点不收任何选项：**空体放行，`{}` 放行，其余一律 400。**
 *
 * ⚠️ **不能用 `readJson()`**（`src/http/errors.ts`）：它对空体一律 400，而面板与
 * `tests/contract/admin-auth.test.ts` 的枚举式鉴权矩阵都是**不带体**调这条 POST 的。
 * 同一个理由让 `handlers/registrar.ts` 写了 `optionalObjectBody`；这里比它更严
 * （那边有一个 `channel` 字段可收，这边一个都没有）。
 */
async function rejectAnyBody(c: Context): Promise<void> {
  const raw = await c.req.text();
  if (raw.trim() === "") return;
  // 全局约束 8：解析结果一律先落到 `unknown`，再窄化。**不写 `Record<string, any>`。**
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw httpError(400, "invalid_request_error", "请求体不是合法的 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw httpError(400, "invalid_request_error", "请求体必须是一个 JSON 对象");
  }
  const extra = Object.keys(parsed as Record<string, unknown>);
  if (extra.length > 0) {
    throw httpError(
      400,
      "invalid_request_error",
      `验活不接受任何参数，不认识的字段：${extra.join(", ")}`,
    );
  }
}
