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
 * `UnsupportedContentError`（Anthropic 的非 text 内容块）从它继承。于是**路由层只需要
 * 一个 catch**——少一个 catch 就少一处会漏。上一版就是只 catch 了内容块那一种，
 * 结果同一条路由上「漏写 messages」照样 500。
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
