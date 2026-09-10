import {
  requireArray, requireObject,
  UnsupportedContentError, UnsupportedParamError,
} from "./request-shape.js";
import { parseSseStream, sseEvent, toSseStream } from "./sse.js";
import { MODEL_CATALOG } from "../admin/protocol-catalog.js";

/**
 * Gemini 的 `Part` 是**按键区分**的联合体（没有 `type` 判别符）：带正文的那一支是
 * `{ text }`，其余是 `{ inlineData }` / `{ fileData }` / `{ functionCall }` / …
 * 本网关只转得动前者。
 */
interface Part { text?: string; [k: string]: unknown }
export interface GeminiRequest {
  contents: { role?: string; parts: Part[] }[];
  systemInstruction?: { parts: Part[] };
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
    /** 见 `UnsupportedParamError` 上方那张三档表：①透传。 */
    topP?: number;
    stopSequences?: string[];
    /** ②上游没有这一格。 */
    topK?: number;
    /** ③>1 时响应转换不了（本网关只转第一条 candidate）。 */
    candidateCount?: number;
  };
  /** ③传得过去但响应转换不了。 */
  tools?: unknown;
  toolConfig?: unknown;
}

/**
 * ⚠️ **非文本 part 一律抛 `UnsupportedContentError`，不再求值成空串**（2026-09-10 实测缺陷）。
 * 从前这里是 `parts.map((p) => p.text ?? "").join("")`：`inlineData` / `fileData` /
 * `functionCall` 统统蒸发。线上真打过——带一张 8×8 红色 PNG 的 `inline_data`
 * 打 `:generateContent` 回 **200**，正文逐字是 `NO_IMAGE_RECEIVED`（提示词里让模型
 * 在没收到图时这么回）。理由全文在 `UnsupportedContentError` 上方。
 *
 * ⚠️ **块类型取的是「除 text 之外的第一个键」**：Gemini 的 part 没有 `type` 格，
 * 报文里要说得出是哪一种块，只能报键名（`inlineData` / `fileData` / …）。
 * 一个键都没有的空对象报 `unknown` —— 那也确实不是本网关认识的任何一种。
 */
const partsText = (parts: Part[]) => {
  let out = "";
  for (const p of parts) {
    if (typeof p.text === "string") { out += p.text; continue; }
    throw new UnsupportedContentError(Object.keys(p).find((k) => k !== "text") ?? "unknown");
  }
  return out;
};

const FINISH: Record<string, string> = { stop: "STOP", length: "MAX_TOKENS", content_filter: "SAFETY" };

export function toInternalRequest(req: GeminiRequest, model: string) {
  // 见 anthropic.ts 同位置：`req.contents` 的 for-of 在漏写时抛裸 TypeError ⇒ 500。
  const o = requireObject(req, "请求体");
  requireArray(o.contents, "contents");
  // 生成参数三档，表与理由在 `UnsupportedParamError` 上方（三条协议共用那一张）。
  if (o.tools !== undefined) throw new UnsupportedParamError("tools", "本网关不转换工具调用");
  if (o.toolConfig !== undefined) throw new UnsupportedParamError("toolConfig", "本网关不转换工具调用");
  const cfg = req.generationConfig;
  if (cfg?.topK !== undefined) {
    throw new UnsupportedParamError("generationConfig.topK", "上游的 OpenAI 兼容请求体里没有这一格");
  }
  // `candidateCount: 1` 与不传逐字等价，放行；>1 才是转换不了的那一档。
  if (cfg?.candidateCount !== undefined && cfg.candidateCount !== 1) {
    throw new UnsupportedParamError("generationConfig.candidateCount", "本网关只转换第一条 candidate");
  }
  const messages: { role: string; content: string }[] = [];
  if (req.systemInstruction) {
    messages.push({ role: "system", content: partsText(req.systemInstruction.parts) });
  }
  for (const c of req.contents) {
    messages.push({
      role: c.role === "model" ? "assistant" : (c.role ?? "user"),
      content: partsText(c.parts),
    });
  }
  return {
    model,
    messages,
    max_tokens: cfg?.maxOutputTokens,
    temperature: cfg?.temperature,
    top_p: cfg?.topP,
    stop: cfg?.stopSequences,
  };
}

export function toGeminiResponse(openai: any, model: string) {
  const choice = openai.choices?.[0];
  const prompt = openai.usage?.prompt_tokens ?? 0;
  const completion = openai.usage?.completion_tokens ?? 0;
  return {
    candidates: [{
      content: { role: "model", parts: [{ text: choice?.message?.content ?? "" }] },
      finishReason: FINISH[choice?.finish_reason ?? "stop"] ?? "STOP",
      index: 0,
    }],
    modelVersion: model,
    usageMetadata: {
      promptTokenCount: prompt,
      candidatesTokenCount: completion,
      totalTokenCount: prompt + completion,
    },
  };
}

export function toGeminiStream(upstream: ReadableStream<Uint8Array>, model: string) {
  // 客户端断连时用来带外中断一次正阻塞在 reader.read() 上的读取，见
  // parseSseStream 与 toSseStream 对 signal/onCancel 的说明——不能只靠
  // 生成器的 return()，那会排在已在飞行中的 next() 后面永远等不到执行。
  const controller = new AbortController();

  /**
   * 🔴 **这条流从前没有终帧：`finishReason` 与 `usageMetadata` 一次都不出现**
   * （2026-09-10 实测缺陷）。从前 `gen()` 只在有文本时 yield 一帧，循环结束后
   * **什么都不补**，流到此直接关闭。官方 `google-genai` 2.22.0 回放线上真吐的那串
   * 字节（零上游请求）：`text` 完整，而 `last.candidates[0].finish_reason` 与
   * `last.usage_metadata` **都是 `None`**。
   *
   * ⚠️ **`finishReason` 是客户端判断「说完了 / 撞了 MAX_TOKENS / 被 SAFETY 拦了」的
   * 唯一信号。** 少了它，一个被截断的半截回答和一个完整回答在客户端看来**逐字节
   * 不可区分**，做内容完整性校验的下游会把残缺内容当成品收下——与 `anthropic.ts`
   * 在 v0.3.0 修流式断流时写下的那句判断是同一条，那一轮只修了三条协议里的一条。
   *
   * ⚠️ **「上游没给」这条辩护是堵死的**：同一网关 `/v1/chat/completions` 原样透传的
   * 流式末尾真实字节里含 `"finish_reason":"length"` 与
   * `"usage":{"completion_tokens":…,"prompt_tokens":…}` ——上游在流里明确给了截断信号
   * 和 token 数，是这条协议自己丢的。累积做法照抄 `anthropic.ts` 的 `gen()`。
   *
   * ⚠️⚠️ **终帧带 `usageMetadata`，这一条推翻了从前的登记**：
   * `admin-ui/js/sec-playground.js` 那段「responses 与 gemini 那两条一个 usage 字段
   * 都不发」是把**当时的现状**如实登记下来，不是裁定这样才对（responses 那条另有
   * 裁定，见 `responses.ts` 同位置）。缺口在**下游客户端**那一侧：
   * 网关自己的 Tier-2 记账在流式档四条协议一律 `record(0, 0)`，那是另一条已裁定的
   * 取舍（见 `src/http/routes/anthropic.ts` 的记账那段），本轮一个字都没动它。
   */
  async function* gen(): AsyncGenerator<string> {
    let finish = "stop";
    // 上游把 usage 放在**末块**（与 anthropic.ts 同一份实测）。攒在这里，收尾时如实报出去。
    let inTok = 0;
    let outTok = 0;

    try {
      for await (const raw of parseSseStream(upstream, controller.signal)) {
        let chunk: any;
        try { chunk = JSON.parse(raw); } catch { continue; }
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) finish = choice.finish_reason;
        const u = chunk.usage;
        if (u && typeof u === "object") {
          if (typeof u.prompt_tokens === "number") inTok = u.prompt_tokens;
          if (typeof u.completion_tokens === "number") outTok = u.completion_tokens;
        }
        const text = choice?.delta?.content;
        if (typeof text !== "string" || text.length === 0) continue;
        yield sseEvent(null, {
          candidates: [{ content: { role: "model", parts: [{ text }] }, index: 0 }],
          modelVersion: model,
        });
      }
    } catch {
      // 上游中途断掉：发一帧 `finishReason: "OTHER"` 的终帧，别让断流退化成一次
      // 静默的正常收尾（同 `anthropic.ts` 的 `error` 事件、`responses.ts` 的
      // `response.failed`，三条协议各按自己的形状说同一句话）。
      //
      // ⚠️ **刻意不发 `promptFeedback.blockReason`**（原报建议里那一格）：
      // `promptFeedback` 说的是「**这条提示词**被拦了」，那是一句关于请求的断言，
      // 而这里发生的是响应中途断了。用它等于替上游说一句它没说过的话。
      // `OTHER` 是 Gemini 现行取值里「因为别的原因停下了」那一档，不多说也不少说。
      yield sseEvent(null, {
        candidates: [{ content: { role: "model", parts: [] }, finishReason: "OTHER", index: 0 }],
        modelVersion: model,
      });
      return;
    }

    yield sseEvent(null, {
      candidates: [{
        content: { role: "model", parts: [] },
        finishReason: FINISH[finish] ?? "STOP",
        index: 0,
      }],
      modelVersion: model,
      // 上游没给 usage 时仍是 0，那一档是「上游真没给」——与从前「拿得到也不给」不同。
      usageMetadata: {
        promptTokenCount: inTok,
        candidatesTokenCount: outTok,
        totalTokenCount: inTok + outTok,
      },
    });
  }
  return toSseStream(gen(), () => controller.abort());
}

/**
 * `GET /v1beta/models`。
 *
 * ⚠️ **`supportedGenerationMethods` 现在按形态给，不再对 12 个模型一律声明两条方法**
 * （2026-09-10 实测缺陷）。从前三个图片模型与三个视频模型也被声明成支持
 * `generateContent` / `streamGenerateContent`，而它们真正的端点是
 * `POST /v1/images/generations` 与 `POST /v1/videos` 的两段式。
 * `supportedGenerationMethods` 是 Gemini 协议里**机器可读**的「这个模型能干什么」，
 * 照着它渲染下拉框的客户端会把视频模型列成可对话模型；运维选中发一次对话，
 * 网关照常转发 ⇒ 白烧一把 key + 一次全网关共享的限流额度，最后拿回一个上游错误。
 *
 * ⇒ 真源换成 `MODEL_CATALOG`（`modality === "chat"` 才给那两条方法），
 * 它本来就在隔壁文件里逐条手写着每个模型的形态与端点。
 *
 * ⚠️ **媒体模型仍然列出来，只是方法为空数组**，不是从清单里删掉：
 * `/v1/models` 与 `/v1beta/models` 交的是同一份模型全集，做模型发现的客户端
 * 只认其中一条 —— 少列一个模型对那个客户端就是「这个模型不存在」
 * （`tests/contract/gemini.test.ts`「返回 models 数组」把 12 这个数字钉着）。
 * 空数组说的正是实话：**这个模型在 Gemini 这条协议上一个方法都不支持。**
 */
export function geminiModelList() {
  return {
    models: MODEL_CATALOG.map((m) => ({
      name: `models/${m.id}`,
      displayName: m.id,
      supportedGenerationMethods:
        m.modality === "chat" ? ["generateContent", "streamGenerateContent"] : [],
    })),
  };
}
