import type { Context } from "hono";
import type { Fetcher } from "../../../ports/fetcher.js";
import type { KeyPoolRepo } from "../../../core/keypool-repo.js";
import type { GatewayConfig } from "../../../core/config.js";
import type { ProbeGuard } from "../probe-guard.js";
import { httpError } from "../../errors.js";
import { selectKey } from "../../../core/keypool.js";
// ⚠️ **只 import 真的会用到的**：这条端点打的是上游，用的是 `upstreamPath`，
// **不是 `endpointFor`**（同 `./verify.ts` 的约束 6）。本仓没有任何东西会拦住一个
// 没用上的 import（`noUnusedLocals` 没开、CI 门禁里没有 lint 那一步），多带一个
// 只会被评审看见，别指望机器。
import { protocolById, MODEL_CATALOG } from "../../../core/admin/protocol-catalog.js";

/**
 * `POST /admin/api/models/:id/test` —— **逐模型连通性矩阵**里的一格：
 * 拿池里的一把 key，用这一个模型 id 向上游真发一次最小对话请求，只看它通不通。
 *
 * **骨架几乎逐字取自 `./verify.ts`**，那六条约束在这里原样成立（写零个存储字段、
 * 上游正文一个字节都不回、走注入的 `Fetcher`、自带 AbortController + 超时、
 * 上游路径经协议目录取）。下面只写**与那条端点不同的三处**，其余不再抄一遍
 * ——那份原文在 `./verify.ts` 的文件头，是唯一一份。
 *
 * ── 不同点 ①：**选谁的 key**：随便一把能用的，不是指定的那一把 ─────────────────
 *
 * 验活回答的是「**这一把** key 好不好用」，所以它 `repo.get(id)` 直读存储；
 * 这一条回答的是「**这个模型**通不通」，key 只是达成它的手段 ⇒ 与
 * `./upstream-models.ts` 用同一句 `selectKey(await deps.repo.all(), 0, deps.now())`。
 * ⚠️ 代价与那边逐字相同：`repo.all()` 交出来的可能是一个 `POOL_CACHE_TTL_MS` 之前的
 * 快照，刚加进池子的那一把在快照过期前选不中，于是刚加完 key 就点这颗按钮仍可能
 * 落到 `no_key`。**这里可以**——我们只需要「随便一把能用的」。
 * 空池不是错误，是一句要说清的话：`{ ok: false, reason: "no_key" }`，不是 500、
 * 也不是转圈。**判据是 `selectKey()` 而不是「池子长度为 0」**：一池全在冷却 /
 * 全被停用时长度不为 0 而一把都用不了，那两种状态在这条端点上是同一件事。
 *
 * ── 不同点 ②：**模型参数化，而且只接受对话模型** ──────────────────────────────
 *
 * 模型 id 从 `c.req.param("id")` 取，**必须先在 `MODEL_CATALOG` 里查到**，查不到 404。
 * ⚠️ 这一步与下面那道护栏的先后是硬的，理由见 `../probe-guard.ts` 里
 * 「kind 的空间由调用方限界」那一段：调用方必须先把「这个东西真的存在」判掉。
 * **今天这条端点的 kind 是常量（见不同点 ③），那一段的原话按字面对它不成立**
 * ——常量 kind 灌不进第二个键。但顺序仍然照它排：护栏排在校验之后，
 * 一次注定 404 / 400 的调用**不该消费一次最小间隔**（那等于「点了一下、什么都没打，
 * 但接下来几秒不许再点」，与 `./upstream-models.ts` 里护栏排在选 key 之后同一条）。
 *
 * 🔴 **只接受 `modality === "chat"` 的模型，image / video 一律 400
 * `{ reason: "modality_not_testable" }`。这是硬边界，不是保守。**
 * · 测一次图片模型 = **真生成一张图**（`/v1/images/generations` 是同步出图的）；
 * · 测一次视频模型 = **建一个任务 + 最多 60 次轮询**（两段式，见
 *   `src/core/admin/protocol-catalog.ts` 的 `MEDIA_ENDPOINTS`）。
 * 把这两样塞进一颗「全部测一遍」的按钮，就是把一颗按钮做成自毁按钮：运维按下去
 * 的时候以为自己在做一次连通性检查，实际是在替这个账号烧一串生成额度，
 * 而**那笔消耗按下去之后就收不回来了**。⇒ 那两种形态在这条端点上不存在，
 * 由 400 当场说清楚是「这个模型不能这么测」，而不是含糊地 404 成「没有这个模型」。
 * ⚠️ **面板那一侧也不发它们**（`admin-ui/js/pure/model-test.mjs` 先按 `modality` 筛过
 * 一遍），但**两处不是一条判据的两半**：这一条是端点的契约，curl / 脚本同样是它的
 * 调用方，面板筛掉了不等于这里可以放宽。
 *
 * 协议**经目录取**（`protocolById("openai")`），请求体用 `proto.sample(model)`
 * ——**不硬编码**，理由与 `./verify.ts` 的约束 6 同源：目录里同时住着「对外」与
 * 「对上游」两种知识，取错一个不会有编译错误，而漂了没人会发现。
 * ⚠️ 出站的鉴权头**刻意不取** `proto.authHeader`：那个字段回答的是「客户端用哪个头调
 * 这个网关」，而上游只认 `Authorization: Bearer`（`src/core/dispatcher.ts` 里那一句
 * 是无条件的、与协议无关）。这条纪律今天没有变红条件，明写出来别让下一个人以为有护栏。
 *
 * ── 不同点 ③：🔴 **护栏的 kind 是常量 `"model-test"`，不是 `model-test:<id>`** ──
 *
 * **这一条与 `./verify.ts` 刻意相反，理由必须写清楚，否则下一个人会「顺手改对」。**
 *
 * 验活用带 id 的 kind（`verify:<id>`）是因为那 20 把 key 是 20 个**互不相干**的对象，
 * 「验 A 把」不该把「验 B 把」挡掉一个 `PROBE_MIN_INTERVAL_MS`。
 * 而这里恰恰**要**它们互相挡：**逐模型测试串起来的每一次，打的都是同一个上游账号**。
 * 共用一个 kind ⇒ 整轮测试自动被摊到最小间隔上，那就是**扛上游 CF 1015 的那道闸**
 *（上游大约 2 次快请求就会被边缘限流，一片红回来之后运维分不清是模型不通还是被限流了）。
 * 换成 `model-test:<id>` 的后果不是「粒度更细」，是**整道闸消失**：十几个模型各自
 * 一个 kind、彼此不挡，前端一停顿就能把十几发请求打进同一个 3 秒里。
 * ⚠️ **面板那一侧的串行发送不是这条的替代品**，它是同一件事的另一半：
 * 前端串行只管住「本面板这一个标签页」，护栏管的是「这台网关」——两个标签页、
 * 一条 curl 循环都绕得过前者，绕不过后者。
 *
 * ── 响应体：与验活同族 ──────────────────────────────────────────────────────
 * `{ ok, status, latencyMs, reason }`。**上游正文一个字节都不读**（`res.body.cancel()`），
 * **不写任何存储**，`ModelTestDeps` 里**刻意一格 `Logger` 都没有**——理由与
 * `./verify.ts` 的约束 1 / 2 逐字相同：事件环不但能在面板上读还能整份下载，
 * 而这条端点手里握着一把明文 key 与一份上游错误体。
 * ⚠️ 非 2xx 时 `reason` 是 `"upstream_error"` 且 `status` 带真实状态码
 * ——**这一处随 `./upstream-models.ts` 而不是 `./verify.ts`**：那边由面板拿 `status`
 * 自己分档（401/403 → 换 key、429 → 等一会儿），而这张矩阵的每一行只有一格结果，
 * 「上游没正常回」本身就是那一格要说的话，`status` 另起一句补充。
 */
export interface ModelTestDeps {
  repo: KeyPoolRepo;
  fetcher: Fetcher;
  now: () => number;
  /** **getter 而不是值**：超时档与上游 base URL 都能在运行中被面板改掉。 */
  config: () => GatewayConfig;
  /** 与验活、通道测试、列上游模型**共用的那一把**，见 `../probe-guard.ts`。 */
  guard: ProbeGuard;
}

/**
 * 护栏的 kind。**具名常量**：契约用例要拿它去构造「上一次还在飞」那一格，
 * 在那边抄一份字面量的话，改了这里不会有任何东西红（与 `./upstream-models.ts`
 * 的 `KIND` 同一条理由）。**它是常量而不是带 id 的**，理由见文件头不同点 ③。
 */
export const KIND = "model-test";

export function modelTestHandler(deps: ModelTestDeps) {
  return async (c: Context) => {
    // ── 请求体：**这条端点不收任何选项**（全局约束 8 点名的解析点）────────────
    // 校验放在最前面：**一次存储读都不产生、一格护栏都不消费**。
    // 不静默忽略请求体的理由与 `./verify.ts` 的 `rejectAnyBody` 逐字相同
    //（拼错的字段名在宽松实现下是一次「点了、什么都没按你想的那样发生」的静默误操作）。
    // ⚠️ **空体必须放行**：面板与鉴权矩阵都是不带体调这条 POST 的。
    await rejectAnyBody(c);

    // `?? ""` 与 `./verify.ts` 同一条理由：`c.req.param()` 的静态类型是
    // `string | undefined`，**刻意不写 `as string`**——落到空串时下面那次查表如实 404。
    const id = c.req.param("id") ?? "";
    const entry = MODEL_CATALOG.find((m) => m.id === id) ?? null;
    if (entry === null) throw httpError(404, "not_found", "这个网关的模型目录里没有这个模型");

    // 🔴 硬边界，理由见文件头不同点 ②：这颗按钮不许把生成额度花掉。
    if (entry.modality !== "chat") {
      return c.json({
        error: {
          type: "invalid_request_error",
          message: "只有对话模型能做连通性测试：测一次图片模型会真的生成一张图，"
            + "测一次视频模型会建一个任务并反复轮询，两者都会真的花掉这个账号的生成额度",
        },
        // 顶层 `reason`，调用方据它选文案、不解析中文 `message`
        //（与 `./registrar.ts` 那批 `REASON_*`、与下面那条 429 同一条口径）。
        reason: "modality_not_testable",
      }, 400);
    }

    // ⚠️ **护栏排在选 key 之后**：空池那一档一个上游请求都不会发，让它去消费一次
    // 最小间隔，等于「点了一下、什么都没打，但接下来几秒不许再点」
    //（与 `./upstream-models.ts` 里那一段同一条）。
    const picked = selectKey(await deps.repo.all(), 0, deps.now());
    if (picked === null) {
      return c.json({ ok: false, status: null, latencyMs: 0, reason: "no_key" });
    }

    const g = deps.guard.tryAcquire(KIND, deps.now());
    if (!g.ok) {
      return c.json({
        error: { type: "rate_limit_error", message: g.message },
        // 顶层 `reason`，面板据它选五语言文案、不解析中文 `message`。
        // ⚠️ 同一个 429 下有两种拒绝（在飞 / 冷却），处置完全不同，只给状态码分不开。
        reason: g.reason,
      }, 429);
    }

    // ── 从这里到 `finally` 之间不许再有任何会抛的语句 ──────────────────────────
    // 护栏已经占住了而 `release` 在 `finally` 里：这中间抛一次，这个 kind 就永久卡在
    // 「在飞」，那颗按钮从此再也点不动（与 `./verify.ts` 里那段同一条）。
    // ⚠️ **它在这里比在验活那边更疼**：那边卡住的只是「这一把 key」，
    // 这边的 kind 是常量 ⇒ 卡住的是**整颗「全部测一遍」按钮**。
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 计时起点。**只读这一次**，`latencyMs` 因此恰好是「这一次读」到「收尾那一次读」
    // 之间的一步。
    const startedAt = deps.now();
    try {
      // 探测固定用 openai 那一条。**四条协议的 upstreamPath 今天完全相同 ⇒ 选哪条对
      // 出站毫无差别**，选它只因为它是四条的参照系。**仍然经目录取**——「今天一样」
      // 不是硬编码的理由。
      const proto = protocolById("openai")!;
      const cfg = deps.config();
      // 它不经 `dispatch()`，那套超时/中止一样都没有，必须自己带。档位取
      // `config.upstreamTimeoutMs`（首字节档）：这条端点只要一个响应头就够了，
      // 拿到就把正文取消掉，给它同步档等于让面板挂两分钟。
      timer = setTimeout(() => controller.abort(), cfg.upstreamTimeoutMs);
      const res = await deps.fetcher.fetch(`${cfg.agnesBaseUrl}${proto.upstreamPath}`, {
        method: proto.method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${picked.record.key}`,
        },
        // **这就是「逐模型」那一半**：同一份最小请求体，只有 `model` 这一格在变。
        body: JSON.stringify(proto.sample(entry.id)),
        signal: controller.signal,
      });
      // ⚠️ **必须把响应体取消掉**：不消费的话它一直挂在连接上（与
      // `src/core/dispatcher.ts` 的 `discard()` 同理）。**顺带也是「一个字节都不回」
      // 的物理保证**：正文从来没有被读进来过。
      if (res.body && !res.bodyUsed) {
        try { await res.body.cancel(); } catch { /* 已被关闭或已被取消，忽略即可 */ }
      }
      const ok = res.status >= 200 && res.status < 300;
      return c.json({
        ok,
        status: res.status,              // **只回状态码，不回正文**
        latencyMs: deps.now() - startedAt,
        reason: ok ? null : "upstream_error",
      });
    } catch {
      return c.json({
        ok: false,
        status: null,
        latencyMs: deps.now() - startedAt,
        // **`reason` 是机器可读的 code，不是异常消息**：异常消息里可能带上游 URL
        // 与栈帧，与 `createApp` 的 `app.onError` 刻意不回显 `err.message` 同一条策略。
        // ⚠️ 代价与 `./verify.ts` 那段逐字相同：把取协议 / 取配置挪进 `try` 是为了堵住
        // 护栏那段没有 `finally` 覆盖的窗口，但它同时把这个裸 `catch` 的覆盖面扩大了
        // ——网关自己的内部错误会被吞成 `network_error` + HTTP 200。今天走不到，
        // 但这是「今天不会」而不是「不可能」。
        reason: controller.signal.aborted ? "timeout" : "network_error",
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // **必须在 `finally` 里**，理由见 `ProbeGuard.release` 上方那段。
      // ⚠️ **同样不许把上面那条 429 的提前返回挪进这个 `try`**：那样被挡住的那一次
      // 会在 `finally` 里替**正在飞的那一次**把在途标记放掉。
      deps.guard.release(KIND);
    }
  };
}

/**
 * 这条端点不收任何选项：**空体放行，`{}` 放行，其余一律 400。**
 *
 * ⚠️ **不能用 `readJson()`**（`src/http/errors.ts`）：它对空体一律 400，而面板与
 * `tests/contract/admin-auth.test.ts` 的枚举式鉴权矩阵都是**不带体**调这条 POST 的。
 * 同一个理由让 `./registrar.ts` 写了 `optionalObjectBody`、`./verify.ts` 写了同名的
 * 这一个。**三处各一份不是漂移**：三条端点收的选项集合各不相同（那边有一个 `channel`
 * 可收，这两条一个都没有），合并成一个公用件要先把「允许哪些字段」参数化，
 * 而那正是这条纪律最不该被参数化的部分。
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
      `模型测试不接受任何参数，不认识的字段：${extra.join(", ")}`,
    );
  }
}
