/**
 * 模型 × 协议可用性矩阵的取值。
 *
 * ⚠️ **判据全部来自 `GET /admin/api/models` 的响应，本模块一个端点路径都不硬编码。**
 * 这是核心设计决定（全局约束 15）的落点：四个消费者共用一份真源
 *（`src/core/admin/protocol-catalog.ts`），前端只做呈现。
 * **协议 id、协议展示名、端点的方法与路径，本模块一个都不认识**——它们全部以参数
 * 的形式从那份响应里进来，本文件里连一个协议 id 的字面量都没有。
 *
 * ⚠️ **那处差异 2026-09-10 消掉了，这一段随之改写**：从前 `geminiModelList()`
 * 对全部 12 个模型一律声明支持 generateContent，包括三个视频模型
 *（`src/core/protocol/gemini.ts`），当时这里写的是「刻意的、不是缺陷，
 * 那条对外契约的不实已另行登记」——**那是一笔待办债，不是裁定**。
 * 现在那条端点直接读协议目录的形态，两边说同一句话。理由全文在
 * `src/core/admin/protocol-catalog.ts` 的文件头。
 *
 * ⚠️ 顺带记一条本文件自己踩过的坑：**上面那一段原来把那条对外端点写成了行内代码
 *（反引号紧挨着路径），而 `tests/ui/no-hardcoded-endpoints.test.ts` 的
 * 「前端没有任何文件硬编码网关端点路径 —— 端点只许来自 /admin/api/models」
 * 扫的正是「引号紧挨着路径」这个形态、且不区分代码与注释 ⇒ 当场变红。
 * 注释里提到端点请写成散文，别加反引号。**
 *
 * ── 本模块不写什么 ──────────────────────────────────────────────────────────
 * · **不写第二份「怎么调这个网关」的知识**：端点、请求体形状、鉴权头，一个都不在这里。
 * · **不写 `fmtDash`**：破折号怎么画是 `admin-ui/js/pure/format.mjs` 的事
 *  （`tests/ui/pure-boundary.test.ts` 的「全部 pure 模块的导出函数名，一个都不许在 sec-*.js 里被重新声明」
 *   那一格扫的是「抄回板块文件」这个方向，改名抄它抓不住——所以这句话得写在这里）。
 * · **不判「这个模型该不该显示」以外的任何业务**：本模块只回答「取哪个值、那个值算哪一档」。
 */

/** 普通对象，否则 `null`。数组不算（`models` 的元素才是对象，`models` 自己是数组）。 */
function obj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
}

/** 一个数组里每一项都是字符串。 */
function allStrings(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * 一个模型在四条协议上各自可不可用。
 *
 * ⚠️⚠️ **四条协议恒返回四项，不可用的那几项 `available: false`，交给调用方画成灰徽章。**
 * **不许把不可用的过滤掉**：四个格子恒在，运维一眼就能看出「这个模型只在一条上可用」；
 * 过滤掉之后图片模型那一行会是空的，**与「读不出来」长得一模一样**——而那是两件事。
 * 由 `tests/ui/models.test.ts` 的
 * 「四个协议徽章恒在，不可用的画灰不隐藏 —— 隐藏之后『只在一条上可用』与『读不出来』长得一样」
 * 那一格钉着（夹具刻意用图片模型：对话模型四条全有，过滤与不过滤**数学上等价**，
 * 拿它做夹具的话这条不变量不可观测）。
 *
 * `protocols` 是 `catalogProtocols()` 交出来的那一份，**顺序即渲染顺序**。
 */
export function protocolBadges(model, protocols) {
  return protocols.map((p) => ({
    id: p.id,
    label: p.label,
    available: Array.isArray(model.protocols) && model.protocols.includes(p.id),
  }));
}

/**
 * 按协议筛选（设计 §10.7：工具栏放分段选择器而不是刷新按钮
 * ——agnes 的模型是硬编码的，没有「跨账号刷新」这个动作）。
 *
 * `protocolId` 为空（`""` / `null` / `undefined`）= 「全部」那一档，**原样返回**，
 * 不是「用一个恒真的判据筛一遍」：后者在 `protocols` 读不出来时会静默漏掉整张表。
 */
export function filterByProtocol(models, protocolId) {
  if (!protocolId) return models;
  return models.filter((m) => Array.isArray(m.protocols) && m.protocols.includes(protocolId));
}

/**
 * 响应里那份协议清单，窄化成 `[{ id, label }]`。**读不出来时是 `null`，不是空数组。**
 *
 * ⚠️ 「这个网关一条协议都没有」与「这份响应读不出来」是两句话，而一个空数组会让
 * 上面那张矩阵变成**零列**——在屏幕上与「读不出来」长得一样（全局约束 9 的同型）。
 *
 * ⚠️ **任何一条格式不对就整份判成读不出来**，不是把坏的那条跳过：跳过之后面板会
 * 少画一列而**看起来完全正常**，运维得不到任何信号。少画一列的后果是把一条真的
 * 能用的协议入口从文档里抹掉。
 */
export function catalogProtocols(payload) {
  const p = obj(payload);
  if (p === null || !Array.isArray(p.protocols)) return null;
  const out = [];
  for (const item of p.protocols) {
    const e = obj(item);
    if (e === null || typeof e.id !== "string" || typeof e.label !== "string") return null;
    out.push({ id: e.id, label: e.label });
  }
  return out;
}

/**
 * 响应里那份模型清单，逐条窄化。**读不出来时是 `null`，不是空数组**（同上）。
 *
 * 窄化到**每一条端点**为止：`endpoints` 是板块唯一原样搬运的东西，它里面混进一条
 * 缺字段的记录时，板块渲染出来的是一行 `undefined undefined`——那比整份判成
 * 读不出来更难被发现。
 *
 * ⚠️ **`modality` 只要求是字符串，不在这里限定成三个已知值**：限定成白名单等于
 * 「真源多一个形态 ⇒ 面板整张表读不出来」，那是让一个新增值把面板打死。
 * 表外的值怎么显示由 `modalityLabelKey()` 决定（照实显示原值）。
 */
export function catalogModels(payload) {
  const p = obj(payload);
  if (p === null || !Array.isArray(p.models)) return null;
  const out = [];
  for (const item of p.models) {
    const m = obj(item);
    if (m === null || typeof m.id !== "string" || typeof m.modality !== "string") return null;
    if (!allStrings(m.protocols)) return null;
    if (!Array.isArray(m.endpoints)) return null;
    const endpoints = [];
    for (const raw of m.endpoints) {
      const e = obj(raw);
      if (e === null || typeof e.method !== "string" || typeof e.path !== "string") return null;
      endpoints.push({ method: e.method, path: e.path });
    }
    out.push({ id: m.id, modality: m.modality, protocols: [...m.protocols], endpoints });
  }
  return out;
}

/**
 * 形态 → 那一列上的文案 key。**列的显示名叫「类型」，字段名一律 `modality`**
 *（评审 Minor 9：别在板块文件里给它另起一个名字）。
 *
 * ⚠️ **一律字面量，禁止把形态名拼进 key**（写成 `t(某个前缀 + modality)` 那种；
 * 全局约束 12）：`scripts/check-i18n.mjs` 的第 ① 条认不得 `+` 拼出来的 key
 *（那是它自己登记在案的三种漏报形态之一）⇒ 这三个 key 会整族落进「未被引用」。
 *
 * ⚠️⚠️ **后果档位翻过一次，别再照上一版读。** 上一版这里写着
 * 「那一条只报警告、从不 exit 1」——第 ④ 条**今天是硬错**：真写成 `+` 拼键，
 * `scripts/check-i18n.mjs` 这道门禁当场 exit 1 并点名三个**正在用**的 key，而顺着那条报文去
 * 「清理未被引用的 key」删掉的就是活文案（门禁为此在报文里带了处置指引）。
 * ⚠️ **同一段里另一句也已经作废了**：上一版写着「那道门禁只认双引号的
 * `t(…)` 与 `data-i18n=`，本仓主流的 `elI18n(tag, key, attrs)` 它一个都看不见」。
 * 第 ① 条换成「命名空间前缀锚定的引号对」广扫（先抠注释、单双引号都扫）之后，
 * `elI18n(tag, key)` 这一族它认得了——实测把 `admin-ui/js/sec-usage.js` 那句传给
 * `elI18n` 的用量主标题 key 拼错一个字母，**两种引号下门禁都 exit 1**。
 * ⇒ 这三个 key 今天有两层，别再写成「门禁看不见、只有测试在守」：门禁第 ①/④ 条是一层，
 * `tests/unit/i18n-dict.test.ts` 的
 * 「板块里当参数传的 i18n key（elI18n / labelKey 这类）同样必须在字典里」那一格是另一层
 *（**且后者的前提是 `models` 这个命名空间已经进了它的 `NAMESPACES` 表**）。
 *
 * ⚠️ **这三个字面量是本文件唯一一处「来自真源的词汇表」，它为什么不能也来自响应**：
 * 它们不是端点路径、不是请求体形状、也不是协议名，而是**要翻译的展示名**。
 * 协议的 `label` 之所以能直接从响应里取，是因为它是专名（`"OpenAI Chat Completions"`），
 * 翻译它只会制造歧义；「对话 / 图片 / 视频」不是专名，五种语言各不相同，
 * 而协议目录里没有、也不该有一份五语言表。
 * **代价明写**：真源新增一个 modality 时这张表不会自动跟上。所以它 **fail-open**
 * ——表外的值返回 `null`，调用方把原值照实画出来，绝不冒充任何一档已知形态。
 */
export function modalityLabelKey(modality) {
  if (modality === "chat") return "models.modality.chat";
  if (modality === "image") return "models.modality.image";
  if (modality === "video") return "models.modality.video";
  return null;
}

/* ── 上游那份清单（「上游模型」那张卡的取值决策）─────────────────────────────
 *
 * ⚠️⚠️ **它不替换上面那份目录，两者回答的是两个问题。**
 * 上面那份是「**本网关**支持哪些协议、哪些端点、拿哪个模型名去调」，
 * 这一族是「**上游账号**此刻回了哪些模型 id」。上游那份没有协议归属、没有端点，
 * 拿它替掉目录等于把整张矩阵与端点列一起抹掉。⇒ **并存，并且把差集画出来。**
 * 后端那一半的全文在 `src/core/admin/upstream-models.ts` 的文件头。
 */

/**
 * 响应里那个 `models` 对象 → 视图。**读不出来是 `null`，不是空清单**（同上面那两条）。
 *
 * 四个字段**一个都不许缺**：`ids` 缺了没什么可画，`truncated` 缺了会把
 * 「还有一截没给你看」说成「上游就这些」，两个差集缺了那张卡就只剩一份裸清单
 * ——而裸清单看起来完全正常，运维得不到任何信号。
 */
export function upstreamModelsView(models) {
  const m = obj(models);
  if (m === null || typeof m.truncated !== "boolean") return null;
  if (!allStrings(m.ids) || !allStrings(m.onlyUpstream) || !allStrings(m.onlyCatalog)) return null;
  return {
    ids: [...m.ids], truncated: m.truncated,
    onlyUpstream: [...m.onlyUpstream], onlyCatalog: [...m.onlyCatalog],
  };
}

/**
 * **200 响应体里那个 `reason`** 的已知取值 → 文案 code。表外一律 `null`。
 *
 * ⚠️⚠️ **这张表必须是显式的，不许写成「不认识就当上游出错」**——与
 * `js/pure/keys-write.mjs` 的 `verifyBodyReasonCode()` 同一条纪律：后端加一种
 * reason 是一行 diff，而落进一个错误档的后果是面板对运维说一件没发生的事。
 * 由 `tests/ui/models.test.ts`
 *「列模型那条 handler 的每一条 reason 面板都有一档 —— 认不得的会被说成「面板还不认识」，而这一格要求根本别走到那里」
 * 那一格直接读 handler 源码对表钉着。
 */
function upstreamBodyReasonCode(reason) {
  if (reason === "no_key") return "no_key";
  if (reason === "upstream_error") return "upstream_error";
  if (reason === "bad_payload") return "bad_payload";
  if (reason === "timeout") return "timeout";
  if (reason === "network_error") return "network_error";
  // ⚠️ **正文阶段那一档不许并进上面任何一条**：`timeout` / `network_error` 两句文案
  // 逐字是**响应头阶段**的话（「没有拿到响应头」/「没有拿到任何响应」），而这一档
  // 响应头已经带着状态码落地了；`bad_payload` 那句又说的是「那份内容看不懂」，
  // 而这一档我们压根没拿到那份内容。三句都不成立 ⇒ 它有自己的一档。
  if (reason === "body_incomplete") return "body_incomplete";
  return null;
}

/**
 * **200 响应体** → 文案 code（不是句子：面板是五语言的）。
 *
 * ⚠️ **它只吃 200 的响应体。** `admin-ui/js/api.js` 的 `json()` 对任何非 2xx 都抛
 * `ApiError` ⇒ 那一族走下面的 `upstreamTransportCode()`，两个函数各管一半。
 * 把 429 的 `ApiError` 塞进这里的后果是面板说「上游出错了」——**一次出站都没发生过**。
 *
 * ⚠️ **`ok: true` 但那份 `models` 读不出来时也落 `mismatch`，不是 `ok`**：
 * 那一档没有任何东西可画，而画一张空卡就是把「我们看不懂后端这次给的东西」
 * 说成「上游一个模型都没回」。`mismatch` 那句文案两种来源都涵盖（未知 reason /
 * 形状不认识），因为对运维来说处置是同一件事：核对两边版本。
 *
 * @returns {"ok"|"no_key"|"upstream_error"|"bad_payload"|"timeout"|"network_error"|"body_incomplete"|"mismatch"}
 */
export function upstreamResultCode(resp) {
  const r = obj(resp);
  if (r === null) return "mismatch";
  if (typeof r.reason === "string") {
    const mapped = upstreamBodyReasonCode(r.reason);
    return mapped === null ? "mismatch" : mapped;
  }
  if (r.ok !== true) return "mismatch";
  return upstreamModelsView(r.models) === null ? "mismatch" : "ok";
}

/**
 * **管理层传输错误**（`js/api.js` 的 `ApiError`）→ 文案 code。
 *
 * ⚠️⚠️ **判据是顶层 `reason` 而不是状态码**：护栏在同一个 **429** 下产出两种拒绝，
 * 处置完全不同（等它回来 / 稍后再试）。口径与 `verifyTransportCode()` 逐条一致
 * ——**两条端点共用同一把护栏**，两处的读法不一致就会出现「同一次拒绝、两张卡两种说法」。
 *
 * @returns {"probe_in_flight"|"probe_cooldown"|"unauthorized_admin"|"transport_error"}
 */
export function upstreamTransportCode(err) {
  const body = err && typeof err.body === "object" && err.body !== null ? err.body : null;
  const reason = body === null ? undefined : body.reason;
  if (reason === "probe_in_flight") return "probe_in_flight";
  if (reason === "probe_cooldown") return "probe_cooldown";
  if (err && err.status === 401) return "unauthorized_admin";
  return "transport_error";
}

/**
 * code → i18n key。**一律字面量，一个都不许拼**（全局约束 12；理由与后果的全文在
 * `js/pure/keys-write.mjs` 的 `verifyResultLabelKey()` 上方，那里已经写过一遍）。
 *
 * ⚠️ **默认支是 `mismatch` 而不是任何一档「上游怎么了」**：走到默认支说明面板拿到了
 * 一个自己不认识的 code，那是一句关于两边版本的话，不是关于上游的话。
 */
export function upstreamLabelKey(code) {
  if (code === "ok") return "models.up.ok";
  if (code === "no_key") return "models.up.noKey";
  if (code === "upstream_error") return "models.up.upstreamError";
  if (code === "bad_payload") return "models.up.badPayload";
  if (code === "timeout") return "models.up.timeout";
  if (code === "network_error") return "models.up.networkError";
  if (code === "body_incomplete") return "models.up.bodyIncomplete";
  if (code === "probe_in_flight") return "models.up.probeInFlight";
  if (code === "probe_cooldown") return "models.up.probeCooldown";
  if (code === "unauthorized_admin") return "models.up.unauthorizedAdmin";
  if (code === "transport_error") return "models.up.transportError";
  return "models.up.mismatch";
}
