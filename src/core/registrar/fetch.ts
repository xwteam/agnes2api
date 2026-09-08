import type { Fetcher } from "../../ports/fetcher.js";
import { transportFailMessage } from "./url.js";

/**
 * 注册机所有出站请求的**唯一出口**。
 *
 * ── 为什么要有这么一层 ────────────────────────────────────────────────────
 *
 * `fetch` 有两种失败，它们此前的待遇完全不同：
 * · **发得出去、上游回非 2xx** —— 调用方自己拼 `httpFailMessage`，地址是脱敏的；
 * · **压根没发出去**（URL 带 userinfo、DNS 失败、TLS 错误、超时中止）——
 *   运行时抛的那个 Error 直接穿出去，**它的 message 里可能带着完整的原始 URL**，
 *   一路进事件板块与容器 stdout。实测形态与理由见 `./url.ts` 的 `redactInMessage`。
 *
 * ⇒ 脱敏必须落在**发请求这件事**上，而不是落在「非 2xx」那一支上。把它做成一个
 * 出口而不是在每个调用点各写一次 try/catch，是因为后者的失败形态是**下一个人新加的
 * 那一处忘了包**，而那种遗漏不会有任何东西变红。
 *
 * ── 零 IO ─────────────────────────────────────────────────────────────────
 * 本文件在 `src/core/` 下：不碰 `globalThis.fetch`、不碰时间/随机/环境，
 * 只调注入进来的 `Fetcher` 端口（与同目录的 `./agnes.ts` 同一形态）。
 *
 * ⚠️ **`method` 从 `init` 里取，不另开一个参数**：另开一个就多了一处能与真正发出去的
 * 方法对不上的地方，而那正是 `./url.ts` 里 `httpFailMessage` 那段点名不许出现的
 *「日志报了一个它没发过的方法」。
 */
export async function fetchChannel(p: {
  fetcher: Fetcher;
  /** 日志里的通道/服务名，例如 `YYDS` / `MoeMail` / `Agnes`。 */
  provider: string;
  /** 日志里的动作名，例如 `列域名`。与 `httpFailMessage` 的同名参数取值同一套。 */
  action: string;
  url: string;
  /** 与 `Fetcher.fetch` 的第二参**逐字同型**：收窄一格就等于悄悄禁掉一种调用方式。 */
  init: RequestInit & { signal?: AbortSignal };
}): Promise<Response> {
  try {
    return await p.fetcher.fetch(p.url, p.init);
  } catch (err) {
    throw new Error(transportFailMessage({
      provider: p.provider,
      action: p.action,
      method: p.init.method ?? "GET",
      url: p.url,
      cause: err,
    }));
  }
}
