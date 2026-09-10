import {
  requireArray, requireObject, requireString,
  UnsupportedContentError, UnsupportedParamError,
} from "./request-shape.js";
import { parseSseStream, sseEvent, toSseStream } from "./sse.js";

interface InputPart { type: string; text?: string }
export interface ResponsesRequest {
  model: string;
  input: string | { role: string; content: string | InputPart[] }[];
  instructions?: string;
  max_output_tokens?: number;
  stream?: boolean;
  /** 见 `UnsupportedParamError` 上方那张三档表：①透传。 */
  temperature?: number;
  top_p?: number;
  /** ③传得过去但响应转换不了。 */
  tools?: unknown;
  tool_choice?: unknown;
}

/**
 * Responses 的 `content` 数组里**只有这两种块带正文**：`input_text`（用户侧）与
 * `output_text`（把上一轮回答原样喂回去时用的那种）。其余（`input_image` /
 * `input_file` / `refusal` / …）本网关都转不成内部纯文本。
 */
const TEXT_PARTS = new Set(["input_text", "output_text"]);

/**
 * ⚠️ **非文本块一律抛 `UnsupportedContentError`，不再求值成空串**（2026-09-10 实测缺陷）。
 * 从前这里是 `c.map((p) => p.text ?? "").join("")` —— 与 `gemini.ts` 那个 `partsText`
 * 逐字同构的写法，`input_image` / `input_file` **直接蒸发**，网关照回 200，
 * 客户端拿到的是一段模型在**完全没看到图**的前提下编出来的答案。
 * 这正是本仓在 `anthropic.ts` 那条上判定为「不可接受、宁可 400」的失败形态，
 * 当时那句承诺只覆盖了三条协议里的一条。理由全文在 `UnsupportedContentError` 上方。
 */
const flat = (c: string | InputPart[]) => {
  if (typeof c === "string") return c;
  let out = "";
  for (const p of c) {
    if (!TEXT_PARTS.has(p.type)) throw new UnsupportedContentError(p.type);
    out += p.text ?? "";
  }
  return out;
};

export function toInternalRequest(req: ResponsesRequest) {
  // 见 anthropic.ts 同位置。`input` 两种合法形态（字符串 / 非空数组）都要放行，
  // 所以这里不能直接 `requireArray` —— 只在它不是字符串时才要求是非空数组。
  const o = requireObject(req, "请求体");
  requireString(o.model, "model");
  if (typeof o.input !== "string") requireArray(o.input, "input");
  // 生成参数三档，表与理由在 `UnsupportedParamError` 上方（三条协议共用那一张）。
  if (o.tools !== undefined) throw new UnsupportedParamError("tools", "本网关不转换工具调用");
  if (o.tool_choice !== undefined) throw new UnsupportedParamError("tool_choice", "本网关不转换工具调用");
  const messages: { role: string; content: string }[] = [];
  if (req.instructions) messages.push({ role: "system", content: req.instructions });
  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input });
  } else {
    for (const m of req.input) messages.push({ role: m.role, content: flat(m.content) });
  }
  return {
    model: req.model, messages, max_tokens: req.max_output_tokens, stream: req.stream === true,
    temperature: req.temperature, top_p: req.top_p,
  };
}

export function toResponsesResponse(openai: any, model: string) {
  const choice = openai.choices?.[0];
  const input = openai.usage?.prompt_tokens ?? 0;
  const output = openai.usage?.completion_tokens ?? 0;
  return {
    id: `resp_${openai.id ?? "unknown"}`,
    object: "response",
    model,
    status: choice?.finish_reason === "length" ? "incomplete" : "completed",
    output: [{
      type: "message",
      id: `msg_${openai.id ?? "unknown"}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: choice?.message?.content ?? "", annotations: [] }],
    }],
    usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
  };
}

export function toResponsesStream(upstream: ReadableStream<Uint8Array>, model: string) {
  // 本地合成一个 id，在读上游之前就能产出，且每个流式响应互不相同——
  // 理由与 anthropic.ts 的 messageId 一致：不依赖上游 chunk 里的 id，
  // 对首字节延迟零代价，也避免下游按 response id 做的日志/追踪/去重撞车。
  const responseId = `resp_${crypto.randomUUID()}`;
  // 那条 message 输出项自己的 id。**它与 responseId 不是一个东西**：官方事件里
  // `item_id` 指的是这一项，下游按它把增量归到某一项上。
  const itemId = `msg_${crypto.randomUUID()}`;
  // 客户端断连时用来带外中断一次正阻塞在 reader.read() 上的读取，见
  // parseSseStream 与 toSseStream 对 signal/onCancel 的说明——不能只靠
  // 生成器的 return()，那会排在已在飞行中的 next() 后面永远等不到执行。
  const controller = new AbortController();

  /**
   * 🔴 **这条流从前发不出官方 SDK 能用的形状，`responses.stream()` 当场崩**
   * （2026-09-10 实测缺陷，本地回放定案，零上游请求）。
   *
   * 从前 `gen()` 只发三类事件：`response.created` / 若干 `response.output_text.delta` /
   * `response.completed`，delta 上没有 `item_id`，`completed.response` 里
   * **没有 `output`**。把线上真吐的那串字节原样喂给官方 `openai` 3.11.0：
   *
   * · `client.responses.stream(...)` ⇒ **IndexError: list index out of range**，
   *   抛在 `openai/lib/streaming/responses/_responses.py` 的
   *   `output = snapshot.output[event.output_index]` 那一行，**栈里全是 openai 包的文件**
   *   ——用户第一反应是「我 SDK 装坏了」，排查方向整个被带偏；
   * · 对照组 `client.responses.create(stream=True)` 裸迭代**是通的**。
   *
   * ⇒ 缺陷精确定位：**SDK 的累积器靠 `response.output_item.added` 建出
   * `snapshot.output[0]`、靠 `response.content_part.added` 建出
   * `output.content[0]`，而网关一条都不发。** 而 `stream()` 正是 OpenAI 文档里
   * Responses 流式的推荐写法，也是 Agents SDK 一类框架的底座。
   *
   * 现在按官方最小事件序列发全（顺序即下方代码的顺序）：
   * `created` → `output_item.added` → `content_part.added` → `output_text.delta`×N
   * → `output_text.done` → `content_part.done` → `output_item.done` → `completed`。
   *
   * ⚠️ **`sequence_number` / `item_id` / `logprobs` 三格不是装饰**：SDK 的
   * `handle_event()` 在 delta 与 done 两档上**直接读这三个属性**去重建它自己的事件，
   * 缺一个就是一次 AttributeError（同一次回放里实测过）。
   *
   * ⚠️ **`response.completed.response` 现在带 `output[]`（把攒到的文本填进去）。**
   * 「最终对象」是 `get_final_response()` 的返回值本身，缺了它下游拿到的是空。
   *
   * ⚠️⚠️ **`completed` 里仍然不带 `usage`，这是一条被裁定过的取舍、不是漏的**：
   * 论证全文在 `admin-ui/js/sec-playground.js` 的「流式那一轮为什么不显示 token 用量」
   * 那一段，由 `tests/unit/responses.test.ts`
   * 「toResponsesStream() 吐出去的字节里一个 usage 字段都没有」钉着。
   * 官方 `Response.usage` 本来就是可选格，缺它不会让 SDK 崩。
   * **要动它得先动那一段裁定，别在这里顺手加。**
   */
  async function* gen(): AsyncGenerator<string> {
    // 官方事件带的是一个**全流单调递增**的序号。本地自己数，不依赖上游。
    let seq = 0;
    let text = "";
    const part = (t: string) => ({ type: "output_text", text: t, annotations: [] });
    const item = (status: string, content: unknown[]) =>
      ({ type: "message", id: itemId, status, role: "assistant", content });

    // 前三条必须在读取上游之前产出，否则客户端要等到上游有数据才能看到第一个
    // 字节，这条流就退化成了「攒完再吐」。它们也都不依赖上游的任何内容。
    yield sseEvent("response.created", {
      type: "response.created", sequence_number: seq++,
      response: { id: responseId, object: "response", model, status: "in_progress", output: [] },
    });
    yield sseEvent("response.output_item.added", {
      type: "response.output_item.added", sequence_number: seq++,
      output_index: 0, item: item("in_progress", []),
    });
    yield sseEvent("response.content_part.added", {
      type: "response.content_part.added", sequence_number: seq++,
      item_id: itemId, output_index: 0, content_index: 0, part: part(""),
    });

    try {
      for await (const raw of parseSseStream(upstream, controller.signal)) {
        let chunk: any;
        try { chunk = JSON.parse(raw); } catch { continue; }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta !== "string" || delta.length === 0) continue;
        text += delta;
        yield sseEvent("response.output_text.delta", {
          type: "response.output_text.delta", sequence_number: seq++,
          item_id: itemId, output_index: 0, content_index: 0, delta, logprobs: [],
        });
      }
    } catch {
      // 🔴 **上游中途断掉必须说出来**，与 `anthropic.ts` 同位置那段是同一条：
      // 响应头一旦发出（`res.ok` 已为 true），从前这里静默退出、照常补一个
      // `response.completed` 并声称 `status: "completed"` ⇒ **客户端把「被截断」
      // 当成「正常说完」**。`response.failed` 之后不再发 `completed`，官方 SDK 的
      // `get_final_response()` 会明确抛「没收到 completed」——一次响亮的失败，
      // 好过一份看起来完整的残缺回答。
      //
      // ⚠️ 只报「上游流中断」这一句，**不回显异常的 message**：它可能带上游 URL 与栈帧。
      yield sseEvent("response.failed", {
        type: "response.failed", sequence_number: seq++,
        response: {
          id: responseId, object: "response", model, status: "failed",
          output: [item("incomplete", [part(text)])],
          error: { code: "upstream_error", message: "上游流式响应中断，本次回答不完整" },
        },
      });
      return;
    }

    yield sseEvent("response.output_text.done", {
      type: "response.output_text.done", sequence_number: seq++,
      item_id: itemId, output_index: 0, content_index: 0, text, logprobs: [],
    });
    yield sseEvent("response.content_part.done", {
      type: "response.content_part.done", sequence_number: seq++,
      item_id: itemId, output_index: 0, content_index: 0, part: part(text),
    });
    yield sseEvent("response.output_item.done", {
      type: "response.output_item.done", sequence_number: seq++,
      output_index: 0, item: item("completed", [part(text)]),
    });
    yield sseEvent("response.completed", {
      type: "response.completed", sequence_number: seq++,
      response: {
        id: responseId, object: "response", model, status: "completed",
        output: [item("completed", [part(text)])],
      },
    });
  }

  return toSseStream(gen(), () => controller.abort());
}
