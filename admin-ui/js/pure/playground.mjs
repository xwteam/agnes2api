/**
 * Playground 的**请求构造**：一份协议目录 → 一次请求所需的四样东西
 * （URL、方法、鉴权头的名字、请求体）。
 *
 * ⚠️ **本模块不知道任何端点路径、任何协议 id、任何请求体形状。** 路径模板、请求方法、
 * 鉴权头的名字、流式怎么开、最小请求体，全部来自 `GET /admin/api/models` 的响应
 * （真源 `src/core/admin/protocol-catalog.ts`）。这是设计文档订正 D1 的落点：
 * 集成示例卡与 Playground 是同一份知识，「做两遍必漂，而漂了没人会发现」。
 * **示例卡渲染的那份与这里发出去的这份必须同源。**
 *
 * ── **本模块自己知道的那四小件，逐条登记（别让它们悄悄长大）** ──────────────────
 * ① **`{model}` 这个占位符本身**。`pathTemplate` 交过来的是模板，展开它就必须认识
 *    那个 token；真源里 `endpointFor()` 做的是同一件事，`js/pure/examples.mjs` 也
 *    登记了同一条。**被钉住了**：`tests/ui/playground.test.ts` 的
 *    「真实目录跑出来的四条 URL 里没有一条还留着未展开的模型占位符」——真源哪天换了
 *    占位符写法，那一格当场红。
 * ② **`authorization` 这个头要带 `Bearer ` 前缀**。它是 HTTP 的惯例、不是这个网关的
 *    知识，所以它不在目录里、也不该在目录里；网关那一侧解析它的是
 *    `src/http/middleware/auth.ts` 里那条 bearer 正则。**头的名字仍然来自目录。**
 *    ⚠️ **`js/pure/examples.mjs` 里有同一条判据的第二份**（它的登记项 ②）——
 *    两处一漂，示例卡教出来的调法与 Playground 真发出去的那次就不是同一件事了。
 *    由 `tests/ui/playground.test.ts` 的
 *    「Bearer 前缀这条判据与集成示例卡逐字一致 —— 两处一漂，示例教的就不是面板发的」钉着。
 * ③ ~~**样例请求体里那句占位文本**~~ **——这一件已经不在了（P3d Task 11 消掉的）。**
 *    Task 10 在这里留过一个 `PROMPT_SLOT_SAMPLE = "ping"`，登记成「必然的副本」，
 *    理由是「这个目录下禁止 `import`，而它又不在 `GET /admin/api/models` 的响应里」。
 *    **后半句是可以被改掉的，Task 11 就把它改掉了**：真源的 `catalogPayload()` 多了一格
 *    `samplePrompt`，占位文本因此**跟着响应一起来**，本模块不再自己知道它是哪句话。
 *    ⇒ **登记项从四件减到三件。** 别再往回加：真源里那句话改一个字符，
 *    这边跟着变，没有任何东西需要同步。
 * ④ **请求体里那格模型名叫 `model`**。四条协议里三条把模型放请求体、一条放路径，
 *    而「放哪一格」这件事目录没有直接给。判据因此建在**响应自己的形状**上
 *    （`sampleBody` 有没有一格叫 `model` 的字符串），不是 `switch (proto.id)`。
 *    由 `tests/ui/playground.test.ts` 的
 *    「每条协议要么把模型放路径里、要么把模型放请求体里 —— 两头都没有就会静默发默认模型」钉着。
 *
 * ⚠️ **`origin` 是参数不是全局**：这个目录下禁止出现浏览器的那两个顶层全局
 * （`scripts/build-ui.mjs` 里 `js/pure/` 的三条静态校验，违反即 exit 1，含注释里的字样）。
 * 调用方 `admin-ui/js/sec-playground.js` 读一次再传进来。
 *
 * ⚠️⚠️ **本模块一个字节的网关口令都不碰，这不是巧合而是刻意的结构**（全局约束 11(b)）：
 * `buildRequest()` 只交出**鉴权头的名字**，值由 `admin-ui/js/gw-api.js` 在发请求那一刻
 * 现拼。口令因此进不了任何一个被渲染出来的对象——它没有机会漏进 `title`、
 * `data-*`、错误文案或者任何一次调试输出。
 * ⚠️ **唯一的例外是 `authHeaderValue()`**：它按定义要收口令。它**只**被 `gw-api.js`
 * 在拼请求头时调用，返回值一路走到 `fetch` 的 `headers` 里，**不许交给任何渲染代码**。
 * 这条由 `tests/ui/dom/playground-section.test.ts` 的
 * 「面板上任何一处都不出现网关口令 —— 输入框的值不许漏进标题、属性或任何一句错误文案」钉着。
 *
 * ⚠️ **注释里提到对外端点一律写成散文，别加引号或反引号**：
 * `tests/ui/no-hardcoded-endpoints.test.ts` 的
 * 「前端没有任何文件硬编码网关端点路径 —— 端点只许来自 /admin/api/models」
 * 扫的正是「引号紧挨着路径」这个形态，
 * **且不区分代码与注释**（`js/pure/models.mjs` 的文件头记着它当场被咬过一次）。
 */

/** 普通对象，否则 `null`。数组不算。 */
function obj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
}

/**
 * 响应里那份协议清单，窄化成 Playground 用得上的那几格。
 * **读不出来时是 `null`，不是空数组**——「这个网关一条协议都没有」与「这份响应读不出来」
 * 是两句话，而一个空的协议选择器在屏幕上跟后者长得一模一样（全局约束 9 的同型）。
 *
 * ⚠️ **任何一条格式不对就整份判成读不出来**，不是把坏的那条跳过：跳过之后左栏会少一个
 * 协议档位而**看起来完全正常**，后果是把一条真的能用的协议入口从工具里抹掉。
 *
 * ⚠️ **它与 `js/pure/models.mjs` 的 `catalogProtocols()`、`js/pure/examples.mjs` 的
 * `exampleProtocols()` 是同一份响应的三个视图，不是三份知识**：模型板块只要 id 与
 * 展示名（画徽章用），示例卡还要方法、路径模板、鉴权头与请求体（拼代码用），
 * 这边在示例卡那份之上再要 `streamMode` / `streamKey`（真发请求要决定流式怎么开）。
 * 并成一个函数的代价是模型板块从此要求响应里有 `sampleBody` ——一份它根本不看的字段
 * 缺了就整张表读不出来。
 *
 * ⚠️ **`streamMode` 这里不做白名单**：限定成两个已知值等于「真源多一个形态 ⇒ 整个
 * Playground 读不出来」。表外的形态由 `buildRequest()` 在**真的要开流式那一刻**才拒绝
 * （见那里的说明）——非流式这条路今天不受任何影响。
 *
 * ⚠️ **`samplePrompt` 是整份响应级别的一格，却挂在每一条协议上**（Task 11）。
 * 挂上去的理由是**下游只拿得到 `proto`**：`buildRequest(proto, opts)` 与 `withPrompt()`
 * 的入参里没有那份响应，而把它们的签名全改一遍去多传一个参数，只会让每一个调用点
 * 都有机会传错。**它对四条协议是同一个值**，由本函数一次窄化、一次分发。
 * ⚠️ **缺了它就整份读不出来**，与其余每一格同档：没有它 `withPrompt()` 一处都换不掉，
 * 而那正是「静默丢弃用户输入」那条失效路径的入口。
 */
export function playgroundProtocols(payload) {
  const p = obj(payload);
  if (p === null || !Array.isArray(p.protocols)) return null;
  if (typeof p.samplePrompt !== "string" || p.samplePrompt === "") return null;
  const out = [];
  for (const item of p.protocols) {
    const e = obj(item);
    if (e === null) return null;
    if (typeof e.id !== "string" || e.id === "") return null;
    if (typeof e.label !== "string" || e.label === "") return null;
    if (typeof e.method !== "string" || e.method === "") return null;
    if (typeof e.pathTemplate !== "string" || e.pathTemplate === "") return null;
    if (typeof e.authHeader !== "string" || e.authHeader === "") return null;
    if (typeof e.streamMode !== "string" || e.streamMode === "") return null;
    if (typeof e.streamKey !== "string" || e.streamKey === "") return null;
    // 每一段都得是非空字符串：一段空串会让 `deltaText()` 去读一格名字为空的属性，
    // 那一定取不到东西，而**取不到与「这一行不带正文」在下游长得一模一样** ⇒
    // 整条协议的正文会静默地永远为空。所以判在这里，不留到那时候。
    if (!Array.isArray(e.streamTextPath) || e.streamTextPath.length === 0) return null;
    if (!e.streamTextPath.every((s) => typeof s === "string" && s !== "")) return null;
    if (obj(e.sampleBody) === null) return null;
    out.push({
      id: e.id,
      label: e.label,
      method: e.method,
      pathTemplate: e.pathTemplate,
      authHeader: e.authHeader,
      streamMode: e.streamMode,
      streamKey: e.streamKey,
      streamTextPath: e.streamTextPath,
      sampleBody: e.sampleBody,
      samplePrompt: p.samplePrompt,
    });
  }
  return out;
}

/**
 * 这条协议上可用的模型 id，**按清单里的顺序**。一个都没有时是空数组。
 *
 * ⚠️ **不是「清单里的全部模型」**：媒体模型的 `protocols` 是空数组，把它填进一条对话
 * 协议的模型下拉里，运维选中之后拿到的是一次注定 4xx 的请求，而面板事先什么都没说。
 */
export function modelIdsForProtocol(protocol, models) {
  if (!Array.isArray(models)) return [];
  const id = protocol && typeof protocol.id === "string" ? protocol.id : null;
  if (id === null) return [];
  const out = [];
  for (const m of models) {
    const e = obj(m);
    if (e === null || typeof e.id !== "string") continue;
    if (Array.isArray(e.protocols) && e.protocols.includes(id)) out.push(e.id);
  }
  return out;
}

/** 深拷贝，顺路把每一个字符串叶子交给 `fn` 决定换不换。 */
function mapStrings(value, fn) {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((x) => mapStrings(x, fn));
  const o = obj(value);
  if (o === null) return value;
  const out = {};
  for (const k of Object.keys(o)) out[k] = mapStrings(o[k], fn);
  return out;
}

/**
 * 把用户输入塞进这条协议的请求体。**换不掉就返回 `null`，绝不退回样例。**
 *
 * ⚠️⚠️ **判据是 `sampleBody` 的形状，不是 `switch (proto.id)`。**
 * 后者是把协议 id 又当成一次知识用——四条协议「用户那句话放哪」各不相同
 * （两条在 messages、一条在 input、一条在 contents 里层层套下去的 text），
 * 把那张对照表抄进前端，就是在这里又维护了一次「四条协议长什么样」。
 * `sampleBody` 已经把形状带过来了：**在里面找到那句占位文本、把它换掉**，
 * 形状变了这里自动跟着变。
 *
 * ⚠️ **恰好一处，多一处少一处都判失败。** 真源那边由
 * `tests/unit/admin/protocol-catalog.test.ts` 的
 * 「每条 sample() 的 JSON 里 SAMPLE_PROMPT 恰好出现一次」钉着「恰好一次」这条性质，
 * 这里是它在消费侧的对应判据：找不到（占位文本被改了）与找到多处（样例里别的字段
 * 恰好也等于那句话）**都是「我不知道该往哪儿放」**，而在这两种情况下发出去的请求
 * 一定不是运维以为的那一条。
 *
 * ⚠️ **模型名走请求体那一格（登记项 ④）**：`sampleBody` 里有一格叫 `model` 的字符串时
 * 就把它换成选中的模型，没有那一格说明这条协议把模型放在路径里（`pathTemplate` 带
 * `{model}`）。**两头都没有的协议直接判失败**——那种协议下发出去的请求会用样例里那个
 * 模型，而面板上明明摆着一个模型下拉框，运维会以为自己选的那个生效了。
 */
export function withPrompt(proto, model, prompt) {
  const sample = obj(proto && proto.sampleBody);
  if (sample === null) return null;
  // 占位文本**跟着响应来**（`playgroundProtocols()` 分发的那一格），本模块不知道它是哪句话。
  const slot = proto && typeof proto.samplePrompt === "string" ? proto.samplePrompt : "";
  if (slot === "") return null;
  const text = typeof prompt === "string" ? prompt : "";
  let hits = 0;
  const body = mapStrings(sample, (s) => {
    if (s !== slot) return s;
    hits++;
    return text;
  });
  if (hits !== 1) return null;
  const wantsModel = typeof sample.model === "string";
  const hasModel = typeof model === "string" && model !== "";
  if (wantsModel) {
    if (!hasModel) return null;
    body.model = model;
  } else if (!String(proto.pathTemplate).includes("{model}")) {
    // 请求体里没有模型那一格、路径模板里也没有占位符 ⇒ 选中的模型无处可去。
    return null;
  }
  return body;
}

/**
 * 一次请求需要的四样东西。**构造不出来时返回 `null`。**
 *
 * `opts`: `{ model, prompt, stream, origin }`。
 *
 * ⚠️ **`headerName` 只是头的名字，不含值**（见文件头那段 ⚠️⚠️）：网关口令由
 * `admin-ui/js/gw-api.js` 在发请求那一刻现拼，不进这个返回值、也就进不了任何渲染路径。
 *
 * ⚠️ **网关口令为空时照常构造，由调用方拦。** 把「没填口令」这一判塞进本函数的话，
 * 它会和「口令填错了」一起变成同一个 `null` ——而这两件事在 UI 上必须分得开：
 * 前者要提示「先粘贴口令」，后者是上游回的 401。
 * 由 `tests/ui/playground.test.ts` 的
 * 「网关口令为空时 buildRequest 照常构造 —— 把拦截放进纯函数会让『没填口令』与『口令错』在 UI 上分不开」钉着。
 *
 * ⚠️ **流式怎么开是两条完全不同的路**：Gemini 换的是**路径**，其余三条换的是**请求体
 * 字段**。换错了的后果是**静默降级成非流式**——请求照样 200、内容照样对，只是一次性
 * 全回来了，而面板上没有任何东西会提到这件事。
 * ⚠️ 表外的 `streamMode` 在**要开流式时**判失败（返回 `null`），不是「当成 body 那一档」：
 * 猜错的代价正是上面那句静默降级。**非流式不受影响**——它压根不看这个字段。
 */
export function buildRequest(proto, opts) {
  const o = obj(opts);
  if (proto === null || proto === undefined || o === null) return null;
  const model = typeof o.model === "string" ? o.model : "";
  const origin = typeof o.origin === "string" ? o.origin : "";
  const stream = o.stream === true;
  const mode = String(proto.streamMode);
  if (stream && mode !== "path" && mode !== "body") return null;
  const template = stream && mode === "path" ? proto.streamKey : proto.pathTemplate;
  // **`split`/`join` 而不是 `replace`**：后者会把替换串里的 `$&` 之类当成引用展开。
  // 模型名今天由目录白名单限定，这是一道不要钱的保险。
  const path = String(template).split("{model}").join(model);
  const body = withPrompt(proto, model, o.prompt);
  if (body === null) return null;
  if (stream && mode === "body") body[proto.streamKey] = true;
  return {
    url: `${origin}${path}`,
    method: String(proto.method),
    headerName: String(proto.authHeader),
    body,
  };
}

/**
 * 这一条协议的鉴权头该带什么值（登记项 ②）。**头的名字来自目录，本函数只决定值要不要
 * 带 `Bearer ` 前缀。**
 *
 * ⚠️ **它是本模块唯一收口令的函数**，返回值只许交给 `fetch` 的请求头，
 * **不许交给任何渲染代码**。
 */
export function authHeaderValue(authHeader, token) {
  const value = typeof token === "string" ? token : "";
  return authHeader === "authorization" ? `Bearer ${value}` : value;
}

/**
 * 粘进来的这把口令与设置页那个 `hint` 对不对得上（设计 §10.5 的补偿设计）。
 *
 * 面板拿不到明文网关口令（设计 §8.6「凭据只写不读」），能拿到的只有末几位。
 * 于是这里做的是一次**即时的自查**：粘错口令时不必等一次 401 才发现。
 *
 * ⚠️⚠️ **返回值只有一个档位名，绝不含口令的任何一个字节**（全局约束 11(b)）：
 * 返回值会被渲染到屏幕上，把「你粘的是 …abcd，配置里是 …wxyz」这种话画出去，
 * 等于面板自己给出了一条口令末位的旁路。由 `tests/ui/playground.test.ts` 的
 * 「hint 校验的返回值里不含口令的任何片段 —— 它会被渲染出来」钉着。
 *
 * ⚠️ **末几位取几位由 `hint` 自己的长度决定，不写死 4**：真源那边
 * （`src/core/config-provenance.ts` 的 `hintOf`）今天取末 4 位、且短于 5 位时给 `null`。
 * 写死 4 就是在这里又抄了一次那条规则。
 *
 * 四档：`empty`（还没粘）/ `unknown`（设置页读不到 hint，比不了）/ `match` / `mismatch`。
 * ⚠️ **`unknown` 不许被折叠进 `mismatch`**：「比不了」与「比过了、不一样」是两句话，
 * 后者会让运维去改一把其实没错的口令。
 */
export function tokenHintState(token, hint) {
  const tk = typeof token === "string" ? token : "";
  if (tk === "") return "empty";
  if (typeof hint !== "string" || hint === "") return "unknown";
  return tk.slice(-hint.length) === hint ? "match" : "mismatch";
}

/**
 * 一条 SSE 帧流的切分。**入参是「到目前为止攒下的字节」，出参带着「还没凑齐的尾巴」。**
 *
 * ⚠️⚠️ **必须自己处理跨块切分，不许拿 chunk 边界当事件边界。**
 * 一条 `data:` 行完全可能被拆在两个 `read()` 之间——**这件事在本机的假上游下几乎
 * 永远不会发生**（一次 `write` 就是一块），而在真实网络上必然发生（MTU、TLS record、
 * 反代的缓冲刷新点都会切）。按 chunk 边界切的话，症状是**偶发地丢字 / 冒出半行 JSON**，
 * 而且只在生产上出现。⇒ 攒到 `\n\n` 再切，剩下的原样交回给调用方接着攒。
 * 由 `tests/ui/playground.test.ts` 的
 * 「一条 data 行被拆在两个 chunk 里仍被正确重组 —— 按 chunk 边界切的话生产上会偶发丢字」钉着。
 *
 * ⚠️ **这是本仓第二份 SSE 帧解析**（第一份是 `src/core/protocol/sse.ts` 的
 * `extractPayloads`，那是网关读**上游**用的）。**如实登记，但它不归全局约束 15 管**：
 * 那条约束管的是「怎么调**这个网关**」（端点路径、请求体形状、协议名），
 * 而 SSE 的帧格式是 W3C 那份 EventSource 规范，不是本网关的知识。
 * 两份实现共享同一套判据（`data:` 前缀、`\n\n` 分帧、`[DONE]` 终止），是刻意对齐的。
 *
 * @returns `{ payloads, rest, done }`：`payloads` 是这一批凑齐的 `data:` 负载（原始字符串，
 *   **不解析**），`rest` 是还没凑齐的尾巴，`done` = 见到了 `[DONE]`。
 */
export function sseFrames(buffer) {
  const payloads = [];
  let rest = typeof buffer === "string" ? buffer : "";
  let done = false;
  let idx;
  while ((idx = rest.indexOf("\n\n")) !== -1) {
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    for (const line of frame.split("\n")) {
      // `event:` / `id:` / `retry:` / 注释行（`:` 开头）一律跳过：本模块只要正文。
      if (!line.startsWith("data:")) continue;
      // `.trim()` 顺带吃掉 CRLF 换行下那个尾随的 `\r`（与网关那份逐字同做法）。
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { done = true; continue; }
      if (payload !== "") payloads.push(payload);
    }
  }
  return { payloads, rest, done };
}

/**
 * 一条 SSE 数据行里**这一块新增的回答文本**。
 *
 * ⚠️⚠️ **三态，不是两态**（与全局约束 9 同一条纪律）：
 * · `null` —— **这一行读不出来**（不是合法 JSON）。调用方要把它数进 `malformed` 并显示出来。
 * · `""`   —— 这一行读得出来，但**不带正文**。四条协议的流里都夹着这种行
 *   （`message_start` / `content_block_start` / `response.created` / `message_delta` …），
 *   它们是完全正常的。
 * · 非空串 —— 正文。
 * **把这两档折叠成同一个空串就是撒谎**：那样要么每条正常的事件行都被数成畸形
 * （malformed 恒等于事件数，那个计数就没有信息了），要么一条真的坏掉的数据被静默丢弃。
 *
 * ⚠️ **绝不抛。** 一块畸形增量不该让整个对话中断——运维正盯着的那半句话会当场消失，
 * 而面板上只剩一个 transport 错误，看不出是「上游断了」还是「有一块读不动」。
 *
 * ⚠️⚠️ **「正文在哪一格」不在本模块里，它来自协议目录**（`proto.streamTextPath`，
 * 真源 `src/core/admin/protocol-catalog.ts`）。**这是本任务的核心设计决定**：
 * 四条协议的增量各不相同（openai 在 `choices[0].delta.content`、anthropic 在
 * `delta.text`、responses 的 `delta` 就是字符串本身、gemini 在
 * `candidates[0].content.parts[0].text`），把这张四行的对照表写进浏览器，
 * 就是全局约束 15 明令禁止的第四份「四条协议长什么样」。
 *
 * **入参一律当 `unknown` 逐层窄化**：这些字节来自上游，运行期什么形状都可能是。
 * 数字段按数组下标走，其余按属性名走。
 */
export function deltaText(proto, dataLine) {
  const path = proto && Array.isArray(proto.streamTextPath) ? proto.streamTextPath : null;
  if (path === null || path.length === 0) return null;
  let node;
  try {
    node = JSON.parse(String(dataLine));
  } catch (e) {
    return null;
  }
  for (const seg of path) {
    if (Array.isArray(node)) {
      // 数组只认「非负整数下标」，`Number("")` 会给 0、`Number("1x")` 会给 NaN，
      // 两者都得挡掉，否则一条写错的路径会静默地取到第 0 项。
      const i = /^[0-9]+$/.test(String(seg)) ? Number(seg) : -1;
      if (i < 0 || i >= node.length) return "";
      node = node[i];
      continue;
    }
    const o = obj(node);
    if (o === null) return "";
    node = o[String(seg)];
  }
  // 走到底不是字符串 ⇒ 这一行不带正文（**不是畸形**：它 JSON 解得开）。
  return typeof node === "string" ? node : "";
}

/**
 * 一段响应体的可读形态。**读不出来时是 `null`，不是空串**——空串在屏幕上与
 * 「上游回了一个空响应」长得一样，而那是两件事。
 *
 * ⚠️ **非流式那一档仍然展示响应体原文，这不是遗留、是选择。** Task 10 把它记成
 * 「等真源加了『回答文本在哪』那一格再改成对话气泡」，而 Task 11 加的那一格
 * （`streamTextPath`）**只覆盖流式增量**，它答不了「非流式响应里那句话在哪」
 * ——那是另一条路径上的另一格（openai 在 `choices[0].message.content`、
 * anthropic 在 `content[0].text`、…）。**今天没有第二个消费者要它**，
 * 而这份真源自己就记着「别在那之前预先搬」（见它 `upstreamPath` 上方那段边界）。
 * ⇒ **登记 P3e**，判据与那一条完全相同：出现第二个消费者时再加。
 * 在那之前展示原文——对一个调试工具来说它本来就更有用，而且它不会说假话。
 */
export function prettyJson(value) {
  let out;
  try {
    out = JSON.stringify(value, null, 2);
  } catch (e) {
    return null;
  }
  return typeof out === "string" ? out : null;
}
