/**
 * 「怎么调这个网关」的**单一真源**。
 *
 * 本期有四个消费者要回答同一个问题：集成示例卡、Playground、模型表、单把 key 验活。
 * 设计文档订正 D1 把前两件事合进同一期，逐字理由是「它们是同一份知识，做两遍必漂，
 * 而漂了没人会发现」。这个文件是那条裁定的落点。
 *
 * ⚠️ **真源放在 `src/` 而不是 `admin-ui/js/pure/`，是构建物理决定的，不是偏好**：
 * Dockerfile 的 builder 阶段只 `COPY` `package.json` / `pnpm-lock.yaml` /
 * `tsconfig*.json` / `src`（`Dockerfile:4-7`），**没有 `admin-ui`**
 * ⇒ `src/**` 一旦 import `admin-ui/**` 的任何文件，镜像构建立刻断。
 *
 * ⚠️ **零 IO**：纯数据 + 纯函数。真正发请求的是本期 Task 8 的验活 handler（还没建）
 * 与浏览器。这条由 `tests/unit/source-guards.test.ts`「硬约束：src/core 零 IO」
 * 的全目录扫描守着。
 *
 * ⚠️ **它与 `geminiModelList()` 存在一处已知分歧，是刻意的**：
 * `src/core/protocol/gemini.ts:73-81` 对全部 4 个模型一律声明
 * `supportedGenerationMethods: ["generateContent","streamGenerateContent"]`，
 * **包括那个视频模型**——而视频真正的路径是 `POST /v1/videos` + `GET /v1/videos/:id`
 * 的两段式（见下面的 `MEDIA_ENDPOINTS`）。本目录按**真实可用性**填，
 * 那条对外契约的不实登记给 P4（同一期里既改契约又建面板，出问题时分不清是哪一半）。
 * 别把面板与 `/v1beta/models` 的差异当成本目录算错了。
 */
export type ProtocolId = "openai" | "anthropic" | "responses" | "gemini";
export type Modality = "chat" | "image" | "video";

/**
 * 四条协议的样例请求里那句用户输入。**具名导出，不是散在四个 `sample()` 里的魔法字符串。**
 *
 * ⚠️ Playground 的 `withPrompt()` 靠「在 `sampleBody` 里找到这句话并替换掉」来注入用户输入
 *（见 Task 10）。第一版把它留成四个字面量 `"ping"`，**没有具名导出、没有任何断言钉住**
 * ⇒ 谁把某条协议的样例文本改成别的，Playground 对那条协议**静默丢弃用户输入、恒发 "ping"**，
 * 面板上完全看不出来。那是把「第二份知识」从一张表挪成一个魔法字符串，形态没变。
 * 由 `tests/unit/admin/protocol-catalog.test.ts`
 * 「每条 sample() 的 JSON 里 SAMPLE_PROMPT 恰好出现一次」钉着。
 */
export const SAMPLE_PROMPT = "ping";

export interface ProtocolEntry {
  readonly id: ProtocolId;
  /** 展示名。**不进 i18n**：它是协议的专名（"OpenAI Chat Completions"），翻译它只会制造歧义。 */
  readonly label: string;
  readonly method: "POST";
  /**
   * **网关对外**的路径模板（客户端打这一条）。`{model}` 是唯一允许的占位符，
   * 由 `endpointFor()` 替换。只有 Gemini 用得上它（它把模型名与方法名拼进路径）。
   */
  readonly pathTemplate: string;
  /**
   * **网关对上游**的路径（网关转手打这一条，拼在 `config.agnesBaseUrl` 之后）。
   *
   * ⚠️ **它与 `pathTemplate` 是两个问题，第一版把两者混为一谈**（评审 C3）：
   * 前者回答「客户端怎么调这个网关」，后者回答「网关怎么调上游」。
   * 今天四条协议的上游路径**全部**是 `/chat/completions`——四条对话协议在网关内被转成同一份
   * 内部格式再转发（四条路由文件各自把字面量 `"/chat/completions"` 传给 `dispatch()`，
   * 而 `dispatch` 在 `src/core/dispatcher.ts:430` 拼 `${config.agnesBaseUrl}${args.path}`）。
   *
   * **「今天四条都一样」不是省掉这个字段的理由**：单把 key 验活是这条知识的第二个消费者，
   * 而没有这个字段它就只能自己再抄一份，与 `dispatcher` 之间没有任何东西绑住。
   * 绑住它的是 `tests/contract/protocol-catalog.test.ts`
   * 「出站 URL 逐字等于 agnesBaseUrl + upstreamPath」——**观测点在真实出站 URL 上，
   * 不是比对本文件自己的两个字段**（那是同义反复）。
   *
   * ⚠️ **边界，明写（评审 R3-m3）**：这个字段**只覆盖四条对话协议**。
   * 媒体那三条住在下面的 `MEDIA_ENDPOINTS` 里，**不在本表内**——两张表的分界不是
   * 「对话 vs 媒体」这个分类癖，而是**形状真的不同**：对话四条有 `streamMode` /
   * `streamTextPath` / `usagePath` 三格媒体一格都用不上，媒体那三条有 `op` / `taskSlot`
   * 两格对话一格都用不上。合成一张表的代价是每一条都带着一半恒为 `null` 的字段，
   * 而**恒为 null 的字段与「这一条没填」在消费侧长得一模一样**（全局约束 9 的同型）。
   * ⚠️ **P3d Task 12 之前那三条还只住在 `src/http/routes/media.ts` 里**，
   * 当时登记的裁定是「哪天出现第二个需要『网关怎么调上游』的媒体消费者就必须搬进来，
   * 别在那之前预先搬」。**Task 12 就是那一天**：Playground 的媒体模式要拿**对外**路径
   * 发请求，而那条对外路径与上游路径是同一条路由的两半——把对外那半搬进真源、
   * 把上游那半留在路由文件里，等于让下一个改动的人只看见一半。
   */
  readonly upstreamPath: string;
  /** 这条协议惯用的鉴权头。四种网关都收（`src/http/middleware/auth.ts:3-22`）。 */
  readonly authHeader: "authorization" | "x-api-key" | "x-goog-api-key";
  /** 流式怎么开：`body` = 请求体加一个字段；`path` = 换一条路径（Gemini）。 */
  readonly streamMode: "body" | "path";
  /** `streamMode === "body"` 时是那个字段名；`"path"` 时是流式的路径模板。 */
  readonly streamKey: string;
  /** 非流式响应里 usage 的位置。`null` = 这条协议的 usage 网关看不到（见 F1）。 */
  readonly usagePath: readonly string[] | null;
  /**
   * **流式响应里「这一块新增的回答文本」在一条 SSE 数据行的哪一格。**
   * 数字段视为数组下标（`"0"` = 第 0 项），逐层往下走；走不到 / 走到的不是字符串
   * 就表示**这一行不带正文**（`message_start`、`response.completed` 这类事件行都属于这一档），
   * 消费方按空串处理。
   *
   * ── **这一格为什么在这里，而不是在前端** ──────────────────────────────────────
   * P3d Task 10 收口时登记过一条：Playground 的右栏只能展示响应体原文，因为
   * 「这条协议的回答那句话在哪一格」是**第四份「四条协议长什么样」的知识**，而当时
   * 这份目录没有它。**流式把这件事顶到了台面上**——流式天然没有「原文」可展示，
   * 它必须一块一块地把正文取出来拼。那一刻只有两条路：往这份真源加一格，
   * 或者在浏览器里再写一张四行的对照表。**后者正是全局约束 15 禁止的那件事**
   *（订正 D1 的原话：「它们是同一份知识，做两遍必漂，而漂了没人会发现」）。
   *
   * ⚠️⚠️ **这四条路径不是照着协议规范抄的，是照着本网关真正吐出去的字节填的。**
   * 四条协议里三条的流式事件由本仓自己合成（`src/core/protocol/{anthropic,responses,gemini}.ts`
   * 的 `to*Stream()`），只有 openai 那条是上游字节原样透传（`src/http/routes/openai.ts`
   * 不传 `expectJson`，见 `usagePath` 上面那段 F1）。**照规范抄会在合成那三条上漂**。
   * 绑住它的是 `tests/contract/stream-parity.test.ts` 的
   * 「一条真的流式请求，按 streamTextPath 逐块取出来的正是上游那三个字」
   * ——**观测点落在真 app 吐出去的 SSE 字节上**，不是比对本文件自己的两个字段
   *（那是同义反复，与 `upstreamPath` 那一条守的是同一条纪律）。
   *
   * ⚠️ **`readonly string[]`，不是 `| null`**：四条协议全都有正文增量，没有「这条协议
   * 流式没有正文」这一档。哪天真出现了，加的是一个新档位、不是往这里塞 `null`
   * ——`null` 会和「路径写错了、取不到」在消费侧长成同一个空串。
   *
   * ⚠️⚠️ **一条今天定不了案的边界，登记在这里**（P3d Task 11 评审提出）：
   * **openai 是四条里唯一网关不解析响应体的一条**（不传 `expectJson`，原样透传）。
   * 真实 Agnes 上游若在流末发一块 usage（不少 OpenAI 兼容实现会发，或客户端带了
   * `stream_options.include_usage` 时），**那些字节会原样到达浏览器**——
   * 本字段对它们取不到正文、按「不带正文」静默跳过。
   * 假上游下量不到（我们自己的假上游不发那一块），**需要一次真上游才能定案** ⇒
   * **不猜着加解析分支**：本目录今天不新增任何「流末 usage 在哪一格」的字段。
   *
   * ⚠️ **这条边界今天仍未定案，但它已经不再让面板说假话了（P3e Task 22）。**
   * 上一版这里接着写的是「而 Playground 仍会无条件画那句『流式响应不带 token 用量』
   * ⇒ 那一刻那句话对 openai 就不再为真」，并据此裁定「**定案之前不改文案**」。
   * 那条裁定被执行成了「一句可能为假的全称句一直挂在屏幕上」，而它真正要防的只是
   * **猜着加解析分支**。⇒ 面板那句话已改成只讲本面板自己的行为
   *（`admin-ui/js/i18n-dict.js` 的 `pg.turn.noTokens`：「本面板在流式这一档不读
   * token 用量……」），**与上游有没有 usage 无关、恒为真**；解析逻辑一个字节都没动。
   * ⚠️ **别把这段读成「这条边界结案了」**：它仍然只有一次真上游能定案，
   * 状态仍是「未核实」。今天定案能改变的只有一件事——面板要不要**开始读**那块 usage。
   */
  readonly streamTextPath: readonly string[];
  /** 最小可跑请求体。**必须真的能跑通**，由 Step 6 的契约用例发一遍验证。 */
  sample(model: string): Record<string, unknown>;
}

export const PROTOCOLS: readonly ProtocolEntry[] = [
  {
    id: "openai",
    label: "OpenAI Chat Completions",
    method: "POST",
    pathTemplate: "/v1/chat/completions",
    upstreamPath: "/chat/completions",
    authHeader: "authorization",
    streamMode: "body",
    streamKey: "stream",
    // ⚠️ **null 不是「这条协议没有 usage」，是「网关这条路径不解析响应体」**（订正 F1）：
    // `src/http/routes/openai.ts` 是四条协议路由里唯一**不传 `expectJson`** 的一条，
    // 于是 `dispatch()` 走 `sanitize(res)` 原样搬运（`src/core/dispatcher.ts:469`），
    // 从头到尾没有 `JSON.parse` 过。usage 确实在响应里、确实到得了客户端（本计划 W7 实测），
    // 只是网关没读它。给它加 `expectJson` 是热路径改动，本期不做。
    usagePath: null,
    // 上游字节原样透传（本条不传 `expectJson`）⇒ 这里填的是**上游 chat 增量块**的形状。
    // 真机实测到达客户端的那一行：`{"id":"c1","choices":[{"delta":{"content":"a"}}]}`
    streamTextPath: ["choices", "0", "delta", "content"],
    sample: (model) => ({ model, messages: [{ role: "user", content: SAMPLE_PROMPT }] }),
  },
  {
    id: "anthropic",
    label: "Anthropic Messages",
    method: "POST",
    pathTemplate: "/v1/messages",
    upstreamPath: "/chat/completions",
    authHeader: "x-api-key",
    streamMode: "body",
    streamKey: "stream",
    usagePath: ["usage"],
    // 由 `src/core/protocol/anthropic.ts` 的 `toAnthropicStream()` 合成。真机实测那一行：
    // `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}`
    // ⚠️ 同一条流里的 `message_delta` 事件也有一格 `delta`（装的是 `stop_reason`），
    //    它没有 `text` ⇒ 走到底取不到字符串 ⇒ 按「这一行不带正文」处理，正是想要的。
    streamTextPath: ["delta", "text"],
    // `max_tokens` 是 Anthropic 协议的必填项，少了它上游会 400。
    sample: (model) => ({ model, max_tokens: 64, messages: [{ role: "user", content: SAMPLE_PROMPT }] }),
  },
  {
    id: "responses",
    label: "OpenAI Responses",
    method: "POST",
    pathTemplate: "/v1/responses",
    upstreamPath: "/chat/completions",
    authHeader: "authorization",
    streamMode: "body",
    streamKey: "stream",
    usagePath: ["usage"],
    // 由 `src/core/protocol/responses.ts` 的 `toResponsesStream()` 合成。真机实测那一行：
    // `{"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"a"}`
    // ⚠️ **这一条的 `delta` 是字符串本身，不是一个对象**——与 anthropic 那条同名不同形。
    //    这正是「照协议规范抄」会翻车的地方，也是这四行必须由真机字节钉住的理由。
    streamTextPath: ["delta"],
    sample: (model) => ({ model, input: SAMPLE_PROMPT }),
  },
  {
    id: "gemini",
    label: "Google Gemini generateContent",
    method: "POST",
    // Gemini 把方法名以**最后一个冒号**后缀附在模型名之后，路由是通配段自己切
    // （`src/http/routes/gemini.ts:15-21`）。模型名本身可能含冒号，所以是最后一个。
    pathTemplate: "/v1beta/models/{model}:generateContent",
    upstreamPath: "/chat/completions",
    authHeader: "x-goog-api-key",
    streamMode: "path",
    streamKey: "/v1beta/models/{model}:streamGenerateContent",
    usagePath: ["usageMetadata"],
    // 由 `src/core/protocol/gemini.ts` 的 `toGeminiStream()` 合成。真机实测那一行：
    // `{"candidates":[{"content":{"role":"model","parts":[{"text":"a"}]},"index":0}],"modelVersion":"agnes-2.0-flash"}`
    // 两个数字段都是数组下标（第 0 个候选、第 0 个 part）。
    streamTextPath: ["candidates", "0", "content", "parts", "0", "text"],
    sample: () => ({ contents: [{ role: "user", parts: [{ text: SAMPLE_PROMPT }] }] }),
  },
];

export interface ModelEntry {
  readonly id: string;
  readonly modality: Modality;
  /** 这个模型在哪几条对话协议上可用。图片/视频模型是空数组。 */
  readonly protocols: readonly ProtocolId[];
  /** 这个模型真正要打的端点（对话模型 = 四条协议各一条；媒体模型 = 它自己那条）。 */
  readonly endpoints: readonly { readonly method: "POST" | "GET"; readonly path: string }[];
}

const CHAT_PROTOCOLS: readonly ProtocolId[] = ["openai", "anthropic", "responses", "gemini"];

/**
 * ⚠️ **id 必须与 `src/core/protocol/openai.ts` 的 `MODELS` 逐条一致**，
 * 由 `tests/unit/admin/protocol-catalog.test.ts`
 * 「模型 id 与 /v1/models 的来源逐条一致」`toEqual` 钉着（**不是 `toContain`**：
 * 少一个、多一个、顺序不同都要红）。
 * 那份 `MODELS` 是 `/v1/models` 与 `/v1beta/models` 两条对外端点的来源，
 * 本目录多写一个模型就是在面板上承诺一个网关不认的 id。
 */
export const MODEL_CATALOG: readonly ModelEntry[] = [
  {
    id: "agnes-2.0-flash", modality: "chat", protocols: CHAT_PROTOCOLS,
    endpoints: [
      { method: "POST", path: "/v1/chat/completions" },
      { method: "POST", path: "/v1/messages" },
      { method: "POST", path: "/v1/responses" },
      { method: "POST", path: "/v1beta/models/agnes-2.0-flash:generateContent" },
    ],
  },
  {
    id: "agnes-image-2.1-flash", modality: "image", protocols: [],
    endpoints: [{ method: "POST", path: "/v1/images/generations" }],
  },
  {
    id: "agnes-image-2.0-flash", modality: "image", protocols: [],
    endpoints: [{ method: "POST", path: "/v1/images/generations" }],
  },
  {
    id: "agnes-video-v2.0", modality: "video", protocols: [],
    endpoints: [
      { method: "POST", path: "/v1/videos" },
      { method: "GET", path: "/v1/videos/:id" },
    ],
  },
];

/**
 * 视频任务标识的合法形状。**真源在这里，路由文件 import 它。**
 *
 * 原实现把 `:id` 直接拼进上游路径，已鉴权的客户端因此可以拿池中的真实上游 key 打上游
 * 的任意路径（`..%2F..%2Fadmin` 规范化后落到 `/admin`；`x%3Fsecret%3D1` 是查询参数注入）。
 * 故先按白名单校验形状（不匹配直接 400），再 `encodeURIComponent` 做纵深防御。
 *
 * ⚠️ **它从 `src/http/routes/media.ts` 搬到这里，是因为出现了第二个判它的地方**
 * （P3d Task 12：面板在发那次轮询之前先自己判一遍，否则运维只会看到一个 400 而不知道
 * 为什么）。两处各写一份的话，**收紧的那一侧会让另一侧发出注定 400 的请求、
 * 放宽的那一侧会让面板拦下一个网关其实收的 id**——两个方向都无声。
 * ⚠️ **它刻意不进 `catalogPayload()`。** 浏览器那一份是
 * `admin-ui/js/pure/playground.mjs` 里的一条字面量（那里登记成「登记项 ⑤」），
 * 由 `tests/ui/playground-media.test.ts` 的
 * 「面板那条任务标识判据与网关那条逐个探针同判」
 * 逐个探针钉着。**走网络送一条正则过去、在浏览器里 `new RegExp()` 出来**是另一条路，
 * 否掉的理由是那等于让一份运行期数据决定客户端的一段控制流（正则的回溯代价由发送方决定）。
 */
export const VIDEO_TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** 媒体那两种形态。`chat` 不在其中——它走 `PROTOCOLS`。 */
export type MediaModality = Exclude<Modality, "chat">;
/** `generate` = 发一次生成请求；`poll` = 拿着任务标识查一次结果。 */
export type MediaOp = "generate" | "poll";

/**
 * **媒体那三条端点**（图片一条同步、视频两段式）。
 *
 * ⚠️ **两半都在这里：`pathTemplate` 是客户端打的，`upstreamPath` 是网关转手打的。**
 * 与 `ProtocolEntry` 的那两个字段是同一对概念、同一条理由（见那里）。
 * 消费者今天有三个：`src/http/routes/media.ts`（**两半都用**：注册路由用前者、
 * 调 `dispatch()` 用后者）、面板的 Playground 媒体模式（**只用前者**，浏览器发的）、
 * 以及模型表里那份 `MODEL_CATALOG[].endpoints`（**只用前者**，画给人看的）。
 *
 * ⚠️ **`pathTemplate` 里的占位符写成 Hono 的参数语法（`:id`），这是刻意的**：
 * 同一个字符串因此**既是路由的注册模式、又是浏览器要替换的模板**，
 * 两者不可能分叉。要替换的那个 token 由 `taskSlot` 交出去，**浏览器不必自己认识它**
 * ——这与 `pathTemplate` 里 `{model}` 那条的处置刚好相反，理由是那个占位符有
 * `endpointFor()` 这个真源侧的展开函数兜着，而这一条没有（浏览器是唯一的展开方）。
 * 由 `tests/ui/playground-media.test.ts` 的
 * 「轮询 URL 由真实目录拼出来，逐字等于手写的那一条 —— 占位符残留在 URL 里的话网关只会 404」钉着。
 *
 * ⚠️ **它与 `MODEL_CATALOG[].endpoints` 是同一批路径的两个视图，会漂。**
 * 后者按模型分组画给人看，这里按端点分组给机器用。两者的一致由
 * `tests/unit/admin/protocol-catalog.test.ts` 的
 * 「媒体端点表与媒体模型的 endpoints 是同一批路径」钉着。
 */
export interface MediaEndpointEntry {
  readonly id: string;
  readonly modality: MediaModality;
  readonly op: MediaOp;
  readonly method: "POST" | "GET";
  /** **网关对外**的路径。带任务标识的那一条用 `taskSlot` 里那个 token 占位。 */
  readonly pathTemplate: string;
  /** **网关对上游**的路径，拼在 `config.agnesBaseUrl` 之后。占位符与上面同一个。 */
  readonly upstreamPath: string;
  readonly authHeader: "authorization";
  /** 两条路径里那个任务标识占位符。`null` = 这一条不带任务标识。 */
  readonly taskSlot: string | null;
  /** 最小可跑请求体；`null` = 这一条没有请求体（GET）。 */
  sample(model: string): Record<string, unknown> | null;
}

export const MEDIA_ENDPOINTS: readonly MediaEndpointEntry[] = [
  {
    id: "image.generate", modality: "image", op: "generate", method: "POST",
    pathTemplate: "/v1/images/generations", upstreamPath: "/images/generations",
    authHeader: "authorization", taskSlot: null,
    sample: (model) => ({ model, prompt: SAMPLE_PROMPT }),
  },
  {
    id: "video.create", modality: "video", op: "generate", method: "POST",
    pathTemplate: "/v1/videos", upstreamPath: "/videos",
    authHeader: "authorization", taskSlot: null,
    sample: (model) => ({ model, prompt: SAMPLE_PROMPT }),
  },
  {
    id: "video.poll", modality: "video", op: "poll", method: "GET",
    pathTemplate: "/v1/videos/:id", upstreamPath: "/videos/:id",
    authHeader: "authorization", taskSlot: ":id",
    // GET 没有请求体。**`null` 不是「忘了填」**：narrow 那一侧据它决定这一条不走
    // `withPrompt()`，而一个空对象会让它去找那句占位文本、找不到、判成整份读不出来。
    sample: () => null,
  },
];

export function protocolById(id: string): ProtocolEntry | null {
  return PROTOCOLS.find((p) => p.id === id) ?? null;
}

/**
 * 媒体端点表里的一条。**找不到就抛**，不是返回 `null`：调用方（路由注册）拿到 `null`
 * 只能少注册一条路由，而那是一条**部署完才发现的** 404。
 */
export function mediaEndpointById(id: string): MediaEndpointEntry {
  const e = MEDIA_ENDPOINTS.find((x) => x.id === id);
  if (e === undefined) throw new Error(`媒体端点目录里没有 ${id}`);
  return e;
}

/**
 * 把带任务标识的那条路径展开。**`split`/`join` 而不是 `replace`**：后者会把替换串里的
 * `$&` 之类当成引用展开（与 `endpointFor()` 那条同一理由，只是这里的替换串来自上游）。
 */
export function withTaskId(template: string, slot: string, id: string): string {
  return template.split(slot).join(id);
}

/** 把路径模板里的 `{model}` 换掉。**模型名不做 encode**：它已被 `MODEL_CATALOG` 限定成白名单。 */
export function endpointFor(p: ProtocolEntry, model: string, stream: boolean): string {
  const tpl = stream && p.streamMode === "path" ? p.streamKey : p.pathTemplate;
  return tpl.replace("{model}", model);
}

/**
 * 序列化给面板的那一份。**函数（`sample`）不能过网络，这里替换成算好的请求体。**
 *
 * ⚠️ **`samplePrompt` 是 Task 11 补上的一格，它消掉的是一份已登记的副本。**
 * P3d Task 10 在 `admin-ui/js/pure/playground.mjs` 里留了一个 `PROMPT_SLOT_SAMPLE = "ping"`，
 * 并把它登记成「必然的副本」——理由是「`js/pure/` 禁 `import`，而它不在这份响应里」。
 * **那个理由的后半句是可以被改掉的，改法就是这一行。** Task 10 报告自己也写了
 *「下一次有人碰那份真源时，这是该顺手做掉的事」。
 *
 * ⚠️ **它必须与 `sampleBody` 里那句话是同一个来源**（都从 `SAMPLE_PROMPT` 来）：
 * 面板靠「在 `sampleBody` 里找到这句话并把它换成用户输入」注入提示词，两边一旦分叉，
 * Playground 会**静默丢弃用户输入、恒发样例那句话**。由
 * `tests/contract/stream-parity.test.ts` 的
 * 「交出来的 samplePrompt，在每一条 sampleBody 的 JSON 里恰好出现一次」钉着
 * ——**观测点在端点真吐出去的那份 JSON 上**，不是比对本文件的两个常量。
 */
export function catalogPayload(): {
  protocols: Array<Omit<ProtocolEntry, "sample"> & { sampleBody: Record<string, unknown> }>;
  media: Array<Omit<MediaEndpointEntry, "sample"> & { sampleBody: Record<string, unknown> | null }>;
  models: readonly ModelEntry[];
  samplePrompt: string;
} {
  const defaultModel = MODEL_CATALOG[0]!.id;
  /**
   * 这一条媒体端点的样例请求体拿哪个模型算。
   *
   * ⚠️ **不能沿用 `defaultModel`（那是第一个**对话**模型）**：样例体里那格 `model`
   * 会被面板换成运维选中的那个，所以它今天不影响真发出去的请求；但示例值本身是
   * **画给人看的**，写一个图片端点配对话模型的组合就是在教一条注定 4xx 的调法。
   * 找不到对应形态的模型时给空串——**不是抛**：模型清单少一个形态是一条运营事实，
   * 让整个面板的目录请求 500 是把它放大成一次故障。
   */
  const modelFor = (modality: MediaModality): string =>
    MODEL_CATALOG.find((m) => m.modality === modality)?.id ?? "";
  return {
    protocols: PROTOCOLS.map(({ sample, ...rest }) => ({ ...rest, sampleBody: sample(defaultModel) })),
    media: MEDIA_ENDPOINTS.map(({ sample, ...rest }) => ({
      ...rest, sampleBody: sample(modelFor(rest.modality)),
    })),
    models: MODEL_CATALOG,
    samplePrompt: SAMPLE_PROMPT,
  };
}
