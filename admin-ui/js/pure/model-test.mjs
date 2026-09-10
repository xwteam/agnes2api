/**
 * 「模型测试」那张卡的取值决策与状态机（模型板块的第三张卡）。
 *
 * ⚠️ **它与同板块的另外两张卡回答的是三个不同的问题，谁也不替代谁**：
 * 目录卡说「本网关认得哪些模型、拿什么端点去调」，上游卡说「上游账号此刻回了哪些 id」，
 * 这一张说「**拿这一个模型 id 真发一次请求，它通不通、多快**」。
 * 一个模型出现在上游清单里、与它此刻真的能出话，是两件事——前者是账号的权限表，
 * 后者是这一刻的链路。
 *
 * ── 本模块不写什么 ──────────────────────────────────────────────────────────
 * · **不写任何端点路径、协议 id、请求体形状**：那份知识的单一真源在
 *   `src/core/admin/protocol-catalog.ts`，前端只做呈现（全局约束 15）。
 *   这里唯一认识的词汇是 `chat` 这个形态名，理由与 `./models.mjs` 的
 *   `modalityLabelKey()` 上方那段逐字相同（它是要翻译的展示语义，不是端点知识）。
 * · **不写 `fmtDash`**：破折号怎么画是 `./format.mjs` 的事。
 * · **一个字节的 DOM 都不碰**：串行怎么发、逐行怎么重画在
 *   `admin-ui/js/sec-models.js` 里（`admin-ui/README.md` 硬规则 1）。
 *
 * ── 状态机为什么是「三态 + 一格 code」而不是「布尔 + 文案」 ────────────────────
 * 一行有三种状态：`pending`（还没轮到它）/ `active`（正在打）/ `done`（回来了）。
 * ⚠️⚠️ **`pending` 与 `done` 且失败必须是两档，不许合并成「还没成功」**：
 * 前者是「我们还没测过它」，后者是「测过了，没通」——把没测过的画成失败，
 * 运维会去查一条根本没发生过的故障（与 `./models.mjs` 里
 * 「`idle` 与 `ok` 且清单为空不共用一档」是同一条纪律）。
 * `done` 那一档的具体说法全在 `code` 里，**存 code 不存句子**：面板是五语言的。
 */

/** 普通对象，否则 `null`。数组不算。 */
function obj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
}

/**
 * 这一轮该测哪些模型：**只有对话模型**，按目录里的顺序。
 *
 * 🔴 **图片 / 视频模型一个都不进来，这是硬边界不是保守**：测一次图片模型 =
 * 真生成一张图，测一次视频模型 = 建一个任务再反复轮询，两者都会真的花掉这个账号的
 * 生成额度，而**花出去就收不回来**。把它们塞进一颗「全部测一遍」的按钮，
 * 那颗按钮就是自毁按钮。端点那一侧同样拒绝（400 `modality_not_testable`），
 * **两处不是一条判据的两半**：那边是端点对所有调用方的契约（curl / 脚本也算），
 * 这边只是让面板不去发一次注定 400 的请求。
 *
 * ⚠️ **判据是 `modality === "chat"` 这一档白名单，不是「不是 image 也不是 video」**：
 * 后者在真源新增一个形态时会把那个新形态**默认放行**，而放行的代价是未知的
 * ——白名单的代价只是「新形态暂时测不了」，两边的坏法差着一整个数量级。
 */
export function testableModels(models) {
  if (!Array.isArray(models)) return [];
  const out = [];
  for (const raw of models) {
    const m = obj(raw);
    if (m === null || typeof m.id !== "string" || m.id === "") continue;
    if (m.modality !== "chat") continue;
    out.push(m.id);
  }
  return out;
}

/**
 * 一轮测试的初始行。**`pending` 是显式的一档，不是「缺了结果」。**
 *
 * `latencyMs` 与 `status` 都是 `null`：调用方据它画破折号，
 * **绝不许伪造成 0**（`./format.mjs` 那条产品不变式在这一族上同样成立）。
 */
export function initTestRows(ids) {
  if (!Array.isArray(ids)) return [];
  return ids
    .filter((id) => typeof id === "string" && id !== "")
    .map((id) => ({ id, state: "pending", code: null, status: null, latencyMs: null }));
}

/**
 * 把某一行标成「正在打」。**返回新数组，不原地改**：板块那一侧每一步都要重画，
 * 原地改会让「这一步到底变了什么」在渲染层不可观测。
 * 找不到那个 id 时原样返回——凭空插一行进去是把一个 bug 画成一条数据。
 */
export function withRowActive(rows, id) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => (obj(r) !== null && r.id === id
    ? { ...r, state: "active", code: null, status: null, latencyMs: null }
    : r));
}

/**
 * 把某一行标成「回来了」。`code` 由下面那两个归一化函数产出，
 * `status` / `latencyMs` **原样收下响应里的那两个数，读不出来就是 `null`**。
 *
 * ⚠️ **`latencyMs` 不许在这里兜底成 0**：0 毫秒是一句关于链路的话
 *（「快到没有耗时」），而「后端没给这个数」是一句关于我们自己的话。
 */
export function withRowResult(rows, id, code, status, latencyMs) {
  if (!Array.isArray(rows)) return [];
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return rows.map((r) => (obj(r) !== null && r.id === id
    ? { ...r, state: "done", code, status: num(status), latencyMs: num(latencyMs) }
    : r));
}

/**
 * 这一轮跑到哪儿了。`done` 只数**真回来了**的那些，`active` 不算——
 * 把在飞的那一行算进进度，进度条会在最后一次请求还没回来时就显示「全跑完了」。
 */
export function testProgress(rows) {
  if (!Array.isArray(rows)) return { done: 0, total: 0 };
  let done = 0;
  for (const raw of rows) {
    const r = obj(raw);
    if (r !== null && r.state === "done") done += 1;
  }
  return { done, total: rows.length };
}

/**
 * 一行「结果」那一格的文案 key。三种状态各一档，**`done` 那档转交给
 * `modelTestLabelKey()`**。
 *
 * ⚠️ **表外的状态落 `mismatch`，不冒充 `pending`**：走到那里说明这一行的状态是
 * 本面板不认识的东西，那是一句关于两边版本的话，不是「还没轮到它」。
 */
export function rowStatusLabelKey(row) {
  const r = obj(row);
  if (r === null) return "models.test.mismatch";
  if (r.state === "pending") return "models.test.pending";
  if (r.state === "active") return "models.test.active";
  if (r.state === "done") return modelTestLabelKey(r.code);
  return "models.test.mismatch";
}

/**
 * **200 响应体里那个 `reason`** 的已知取值 → 文案 code。**表外一律 `null`，不兜底。**
 *
 * ⚠️⚠️ **这张表必须是显式的，不许写成「不认识就当上游出错」**——与
 * `./models.mjs` 的 `upstreamBodyReasonCode()`、`./keys-write.mjs` 的
 * `verifyBodyReasonCode()` 是同一条纪律：后端加一种 reason 是一行 diff，
 * 而落进一个错误档的后果是面板对运维说一件没发生的事
 *（`no_key` 那一档尤其：那一次**一个出站请求都没有发生过**，说成「上游出错了」
 * 会让运维去查一条根本不存在的上游故障）。
 * 由 `tests/ui/model-test.test.ts` 的
 * 「模型测试那条 handler 的每一条 reason 面板都有一档 —— 认不得的会被说成「面板还不认识」，而这一格要求根本别走到那里」
 * 那一格直接读 handler 源码对表钉着。
 */
export function modelTestBodyReasonCode(reason) {
  if (reason === "no_key") return "no_key";
  if (reason === "upstream_error") return "upstream_error";
  if (reason === "timeout") return "timeout";
  if (reason === "network_error") return "network_error";
  return null;
}

/**
 * **200 响应体** → 文案 code（不是句子：面板是五语言的）。
 *
 * ⚠️ **它只吃 200 的响应体。** `admin-ui/js/api.js` 的 `json()` 对任何非 2xx 都抛
 * `ApiError` ⇒ 那一族走下面的 `modelTestTransportCode()`，两个函数各管一半。
 * 把 429 的 `ApiError` 塞进这里的后果是面板说「上游出错了」——**一次出站都没发生过**。
 *
 * ⚠️ **`ok: true` 与 `reason: null` 是同一件事的两半，先判 `reason`**：
 * 后端在非 2xx 那一档同时给 `ok: false` 与 `reason: "upstream_error"`，
 * 先判 `ok` 的写法会把它读成「不成功」而丢掉是哪一种不成功。
 *
 * @returns {"ok"|"no_key"|"upstream_error"|"timeout"|"network_error"|"mismatch"}
 */
export function modelTestResultCode(resp) {
  const r = obj(resp);
  if (r === null) return "mismatch";
  if (typeof r.reason === "string") {
    const mapped = modelTestBodyReasonCode(r.reason);
    return mapped === null ? "mismatch" : mapped;
  }
  if (r.ok !== true) return "mismatch";
  return "ok";
}

/**
 * **管理层传输错误**（`js/api.js` 的 `ApiError`）→ 文案 code。
 *
 * ⚠️⚠️ **判据是顶层 `reason` 而不是状态码**：护栏在同一个 **429** 下产出两种拒绝，
 * 处置完全不同（等它回来 / 稍后再试）。口径与 `./models.mjs` 的
 * `upstreamTransportCode()`、`./keys-write.mjs` 的 `verifyTransportCode()` 逐条一致
 * ——**三条端点共用同一把护栏**，几处的读法不一致就会出现「同一次拒绝、几张卡几种说法」。
 *
 * ⚠️ `modality_not_testable` 也走顶层 `reason`：它是 400 不是 429，但同样是
 * 「这次请求根本没发到上游」这一族。面板今天先按 `modality` 筛过一遍、发不出它，
 * **这一档仍然要有**：那条筛子哪天松了，运维该看见「这个模型不能这么测」，
 * 而不是一句说不出所以然的 `transport_error`。
 *
 * @returns {"probe_in_flight"|"probe_cooldown"|"modality_not_testable"|"model_not_found"|"unauthorized_admin"|"transport_error"}
 */
export function modelTestTransportCode(err) {
  const body = err && typeof err.body === "object" && err.body !== null ? err.body : null;
  const reason = body === null ? undefined : body.reason;
  if (reason === "probe_in_flight") return "probe_in_flight";
  if (reason === "probe_cooldown") return "probe_cooldown";
  if (reason === "modality_not_testable") return "modality_not_testable";
  const s = err && typeof err.status === "number" ? err.status : 0;
  if (s === 404) return "model_not_found";
  if (s === 401) return "unauthorized_admin";
  return "transport_error";
}

/**
 * code → i18n key。**一律字面量，一个都不许拼**（全局约束 12；理由与后果的全文在
 * `./keys-write.mjs` 的 `verifyResultLabelKey()` 上方，那里已经写过一遍）。
 *
 * ⚠️ **默认支是 `mismatch` 而不是任何一档「上游怎么了」**：走到默认支说明面板拿到了
 * 一个自己不认识的 code，那是一句关于两边版本的话，不是关于上游的话。
 */
export function modelTestLabelKey(code) {
  if (code === "ok") return "models.test.ok";
  if (code === "no_key") return "models.test.noKey";
  if (code === "upstream_error") return "models.test.upstreamError";
  if (code === "timeout") return "models.test.timeout";
  if (code === "network_error") return "models.test.networkError";
  if (code === "probe_in_flight") return "models.test.probeInFlight";
  if (code === "probe_cooldown") return "models.test.probeCooldown";
  if (code === "modality_not_testable") return "models.test.modalityNotTestable";
  if (code === "model_not_found") return "models.test.modelNotFound";
  if (code === "unauthorized_admin") return "models.test.unauthorizedAdmin";
  if (code === "transport_error") return "models.test.transportError";
  return "models.test.mismatch";
}
