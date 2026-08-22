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
 * 的两段式（`src/http/routes/media.ts:28-42`）。本目录按**真实可用性**填，
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
   * 媒体那三条的上游路径（`/images/generations` / `/videos` / `/videos/{id}`，
   * 见 `src/http/routes/media.ts:28-42`）**仍然只住在那个文件里，不在这份真源内**。
   * **今天不算缺陷**：本期没有任何消费者需要媒体的上游路径——验活固定用对话协议，
   * Playground 的媒体模式走的是**对外**路径（浏览器发的，用 `pathTemplate`）。
   * ⇒ **哪天出现第二个需要「网关怎么调上游」的媒体消费者，那三条就必须搬进来**，
   * 判据与本字段的立项理由完全相同。**别在那之前预先搬**——
   * 一份没有第二个消费者的真源，本仓已经裁过三次「迟早会漂」。
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

export function protocolById(id: string): ProtocolEntry | null {
  return PROTOCOLS.find((p) => p.id === id) ?? null;
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
  models: readonly ModelEntry[];
  samplePrompt: string;
} {
  const defaultModel = MODEL_CATALOG[0]!.id;
  return {
    protocols: PROTOCOLS.map(({ sample, ...rest }) => ({ ...rest, sampleBody: sample(defaultModel) })),
    models: MODEL_CATALOG,
    samplePrompt: SAMPLE_PROMPT,
  };
}
