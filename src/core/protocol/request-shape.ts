/**
 * 四条协议**共用**的请求体形状校验。
 *
 * ── 它解决的是一条实测缺陷（2026-09-10 新加坡 Docker 验收发现）─────────────
 *
 * 从前只有 `readJson()` 那一道，而它只管**JSON 语法**合不合法。语法过关之后，请求体
 * 被无条件当成目标协议的类型直接送进 `toInternalRequest()`——TypeScript 的
 * `readJson<T>` 只是**编译期**断言，运行期零校验。于是：
 *
 * | 请求体 | 从前 | 现在 |
 * |---|---|---|
 * | `{"model":"…"}`（漏写 `messages`） | **500「网关内部错误」** | 400 说清哪个字段 |
 * | `[]` / `"hello"` / `null`（合法 JSON、非对象） | **500** | 400 |
 *
 * 🔴 **「漏写 messages」不是构造出来的畸形输入，是真实客户端很容易犯的错。**
 * 用户看到「网关内部错误」会以为网关挂了来报障，而不是自己少传了字段——
 * 这正是 `src/http/errors.ts` 的 `readJson` 那段注释自己声明要消灭的那类问题，
 * 当时只解决了语法错那一半，结构错这一半一直没做。
 *
 * ── 为什么做成一个基类，而不是每条协议各写各的 ───────────────────────────
 *
 * `UnsupportedContentError`（非文本内容块）与 `UnsupportedParamError`（转达不了的生成参数）
 * 都从它继承，两个类也都住在本文件里（前者 2026-09-10 从 `anthropic.ts` 挪过来，
 * 理由写在它自己上方）。于是**路由层只需要一个 catch**——少一个 catch 就少一处会漏。
 * 上一版就是只 catch 了内容块那一种，结果同一条路由上「漏写 messages」照样 500。
 *
 * ⚠️ **本文件零 IO**（`src/core/` 的硬约束）：纯函数 + 纯类型判断，不碰任何端口。
 */

/**
 * **客户端把请求体写错了**——状态码类别是 4xx，不是 5xx。
 *
 * 为什么这个区分值得单独立一个类：OpenAI 官方 SDK 对 **5xx 默认自动重试**（默认 2 次），
 * 于是一个**永远修不好**的客户端错误会被放大成 3 倍请求。上游那层 CF 约 2 次快请求
 * 就回 1015，而限流额度是**整个网关共享**的——一个客户端的 bug 能把所有人的通道打死。
 */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

/**
 * 请求体必须是一个 **JSON 对象**。
 *
 * `null` 与数组都要挡：`typeof null === "object"`，而 `Array.isArray` 那一格挡的是
 * `[]`——两者都能通过「是 object 吗」这种朴素判断，然后在下一行属性访问上抛 TypeError。
 */
export function requireObject(req: unknown, what: string): Record<string, unknown> {
  if (typeof req !== "object" || req === null || Array.isArray(req)) {
    throw new InvalidRequestError(`${what}必须是一个 JSON 对象`);
  }
  return req as Record<string, unknown>;
}

/**
 * 某个字段必须是**非空数组**。
 *
 * 空数组也拒：`messages: []` 送到上游只会被上游以另一种措辞拒掉，白烧一次共享的限流额度
 * ——本地能判的就别送出去。这条是本次改动的直接动机之一。
 */
export function requireArray(v: unknown, field: string): unknown[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new InvalidRequestError(`${field} 必须是一个非空数组`);
  }
  return v;
}

/** 某个字段必须是**非空字符串**。 */
export function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || v === "") {
    throw new InvalidRequestError(`${field} 必须是一个非空字符串`);
  }
  return v;
}

/**
 * 请求里出现了本网关无法映射到 OpenAI chat 格式的**内容块**。
 *
 * 内部规范格式只有纯文本，`image` / `inlineData` / `input_image` / `tool_use` 这些块
 * 无法无损转换。原实现是静默过滤掉非文本块——客户端发了图片却得到一个只看了文字的
 * 回答，既无从察觉也无从排查。宁可明确报 400。
 *
 * ⚠️ **2026-09-10 从 `src/core/protocol/anthropic.ts` 挪到这里，因为它从来就不是
 * Anthropic 专有的**：实测同一张 8×8 的 PNG 走 `/v1beta/models/…:generateContent`
 * 与 `/v1/responses` 都是 **HTTP 200 + 一段模型没看见图编出来的答案**
 *（gemini 那条真打回来的正文逐字是 `NO_IMAGE_RECEIVED`），
 * 而走 `/v1/messages` 是 400。**同一台网关对同一件事给三种行为**，
 * 而那两条给的正是本仓在 Anthropic 那条上判定为「不可接受」的那一种。
 * 三条协议现在共用这一个类 ⇒ 三条路由的 `shapeGuard` 已经 catch 基类，一律 400。
 * `anthropic.ts` 仍然把它再导出一次，老的 import 路径不动（那是它的对外形状）。
 */
export class UnsupportedContentError extends InvalidRequestError {
  constructor(readonly blockType: string) {
    super(`不支持的内容块类型: ${blockType}（本网关仅支持 text）`);
    this.name = "UnsupportedContentError";
  }
}

/**
 * 请求里出现了本网关**无法如实转达给上游**的生成参数。
 *
 * ── 为什么不是「静默丢掉就算了」（2026-09-10 实测缺陷）─────────────────────────
 * 从前 `/v1/messages`、`/v1/responses`、`/v1beta/…:generateContent` 三条把
 * `tools` / `tool_choice` / `top_k` 这些格**一个字都不往下带**，而同一台网关的
 * `/v1/chat/completions` 是整包透传。实测最难看的一幕：同一份带 `tools` +
 * `tool_choice:"required"` 的请求，走 OpenAI 那条上游返回**真的工具调用**
 *（`finish_reason:"tool_calls"`、`arguments {"city":"Paris"}`），走 `/v1/messages`
 * 返回 **200**、正文是模型自己吐的 `<tool_call><tool_call>…` 乱码、
 * `stop_reason` 还写着 `end_turn` ——**网关一句提示都没有**。
 *
 * ⇒ 与 `UnsupportedContentError` 同一条纪律：**做不到就明说，别假装做到了。**
 * 报文点名是哪一格，客户端拿到 400 一眼就知道该删哪个字段。
 *
 * ── **裁定：哪些格透传、哪些格 400，三档**（三条协议共用这一张表）──────────────
 * 上游是 **OpenAI 兼容体**（四条路由最后都 `dispatch({ path: "/chat/completions" })`），
 * 所以判据是「这一格在 OpenAI chat 请求体里有没有**同名同义**的位置」：
 *
 * · **① 透传** —— 同名同义、语义一对一：`temperature`、`top_p`（Gemini 的 `topP`）、
 *   `stop`（Anthropic 的 `stop_sequences`、Gemini 的 `stopSequences`）。
 *   映射成本一行，Gemini 那条的 `temperature` 早就这么做了。
 *   ⚠️ **不做取值范围校验**：实测 `temperature:99` / `top_p:5` 上游照样 200，
 *   上游自己不判，网关这层替它判就是替上游说了一句它没说的话。
 *
 * · **② 400 —— 上游那份请求体里根本没有这一格**：Anthropic 的 `top_k`、
 *   Gemini 的 `topK`。透传上去是发一个上游不认的字段，丢掉则客户端毫无察觉。
 *
 * · **③ 400 —— 传得过去，但会让「响应」变成本网关转换不了的形状**：
 *   `tools` / `tool_choice`（三条协议的工具 schema 与 OpenAI 的不同构，而
 *   `toAnthropicResponse` / `toResponsesResponse` / `toGeminiResponse` 全都只读
 *   `choices[0].message.content`，上游真回 `tool_calls` 的话下游拿到的是空正文）；
 *   Gemini 的 `candidateCount > 1`（对应 OpenAI 的 `n`，而三条转换器只转第一条
 *   candidate ⇒ 客户端付了 n 份的钱只拿得到一份）。
 *   ⚠️ **`candidateCount: 1` 放行**：它与不传逐字等价，为它报 400 只是在骂人。
 *
 * ⚠️ **这张表是「今天做得到什么」，不是「客户端不该要什么」**：哪天本仓真的实现了
 * 工具调用的双向转换，`tools` 就该从 ③ 挪到 ①，**而不是**在这里悄悄放行。
 */
export class UnsupportedParamError extends InvalidRequestError {
  constructor(readonly field: string, why: string) {
    super(`不支持的生成参数: ${field}（${why}）`);
    this.name = "UnsupportedParamError";
  }
}
