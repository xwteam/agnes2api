import { describe, it, expect } from "vitest";
import { MODELS } from "../../../src/core/protocol/openai.js";
import {
  PROTOCOLS, MODEL_CATALOG, protocolById, endpointFor, catalogPayload, SAMPLE_PROMPT,
} from "../../../src/core/admin/protocol-catalog.js";

describe("协议目录", () => {
  it("模型 id 与 /v1/models 的来源逐条一致 —— 面板不许承诺一个网关不认的 id", () => {
    // 变红条件：给 MODEL_CATALOG 加一条 MODELS 里没有的 id，或删掉一条
    expect(MODEL_CATALOG.map((m) => m.id)).toEqual([...MODELS]);
  });

  it("四条协议 id 互不重复且恰好四条 —— 少一条就是某个消费者会静默漏掉一个协议", () => {
    // 期望值手写字面量，不写 PROTOCOLS.length（第 6 种假阳性）
    expect(PROTOCOLS.map((p) => p.id).sort()).toEqual(["anthropic", "gemini", "openai", "responses"]);
  });

  it("Gemini 的流式换的是路径不是请求体字段 —— 换错了流式请求会静默返回非流式结果", () => {
    const g = protocolById("gemini")!;
    expect(endpointFor(g, "agnes-2.0-flash", false))
      .toBe("/v1beta/models/agnes-2.0-flash:generateContent");
    expect(endpointFor(g, "agnes-2.0-flash", true))
      .toBe("/v1beta/models/agnes-2.0-flash:streamGenerateContent");
    // 另外三条协议换的是请求体字段，路径不随 stream 变
    const o = protocolById("openai")!;
    expect(endpointFor(o, "agnes-2.0-flash", true)).toBe("/v1/chat/completions");
  });

  it("过网络那一份不含函数 —— sample 是函数，JSON.stringify 会把它整个丢掉", () => {
    // 变红条件：catalogPayload 改成直接返回 PROTOCOLS
    const payload = JSON.parse(JSON.stringify(catalogPayload()));
    for (const p of payload.protocols) {
      expect(p.sample).toBeUndefined();
      expect(typeof p.sampleBody).toBe("object");
    }
  });

  // ── 评审 I7：`"ping"` 不许是散在四处的魔法字符串 ────────────────────────
  it("每条 sample() 的 JSON 里 SAMPLE_PROMPT 恰好出现一次 —— "
     + "Playground 靠替换它来注入用户输入，改掉它会让那条协议静默丢弃用户输入", () => {
    // 变红条件：把 responses 那条的 `input: SAMPLE_PROMPT` 改回字面量 "pong"
    expect(SAMPLE_PROMPT).toBe("ping");            // 手写字面量锚（第 6 种假阳性）
    for (const p of PROTOCOLS) {
      const json = JSON.stringify(p.sample("agnes-2.0-flash"));
      expect(json.split(SAMPLE_PROMPT).length - 1, `${p.id} 的样例文本`).toBe(1);
    }
  });

  // ── 评审 Minor 2：authHeader / usagePath 被归为"机器事实"却零覆盖 ────────
  it("四条协议的鉴权头恰好是这四个 —— 网关四种都收，但示例里写错一条就教错了用法", () => {
    // 变红条件：把 gemini 的 authHeader 改成 "authorization"
    // 期望值逐条手写，不从 PROTOCOLS 推
    expect(PROTOCOLS.map((p) => [p.id, p.authHeader])).toEqual([
      ["openai", "authorization"],
      ["anthropic", "x-api-key"],
      ["responses", "authorization"],
      ["gemini", "x-goog-api-key"],
    ]);
  });

  it("只有 openai 那条的 usagePath 是 null —— 它是四条里唯一不传 expectJson 的（订正 F1）", () => {
    // 变红条件：给 openai 填上 usagePath: ["usage"]
    expect(PROTOCOLS.filter((p) => p.usagePath === null).map((p) => p.id)).toEqual(["openai"]);
  });

  it("upstreamPath 四条都是 /chat/completions，且与对外路径不是同一个东西（评审 C3）", () => {
    // 变红条件：把任一条 upstreamPath 写成它自己的 pathTemplate
    expect(PROTOCOLS.map((p) => p.upstreamPath)).toEqual([
      "/chat/completions", "/chat/completions", "/chat/completions", "/chat/completions",
    ]);
    // ⚠️ 这一格只钉住"值是什么"。**"它真的是网关发出去的那一条"由契约用例钉**，
    // 见 tests/contract/protocol-catalog.test.ts
    // 「出站 URL 逐字等于 agnesBaseUrl + upstreamPath」——比对本文件自己的两个字段是同义反复。
    for (const p of PROTOCOLS) expect(p.upstreamPath).not.toBe(p.pathTemplate);
  });

  /**
   * `modality` 与 `protocols` 是模型表那个消费者唯一要读的两个字段，
   * 而上面那格只比对 id、Step 5 的契约用例只比对 `endpoints`
   * ⇒ **这两个字段原本一格都没有**：把 `agnes-video-v2.0` 的 `modality` 写成 `"chat"`
   * 或给某个图片模型填上四条对话协议，模型表就会请用户去 `/v1/chat/completions`
   * 调一个只有两段式视频接口的模型，而全套用例照绿。
   *
   * 期望值逐条手写字面量，不从 `MODEL_CATALOG` 或 `CHAT_PROTOCOLS` 推（第 6 种假阳性）。
   */
  it("每个模型的形态与可用协议逐条手写钉死 —— 媒体模型一条对话协议都不该有", () => {
    expect(MODEL_CATALOG.map((m) => [m.id, m.modality, [...m.protocols]])).toEqual([
      ["agnes-2.0-flash", "chat", ["openai", "anthropic", "responses", "gemini"]],
      ["agnes-image-2.1-flash", "image", []],
      ["agnes-image-2.0-flash", "image", []],
      ["agnes-video-v2.0", "video", []],
    ]);
  });
});
