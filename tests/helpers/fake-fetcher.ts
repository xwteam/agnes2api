import type { Fetcher } from "../../src/ports/fetcher.js";

/**
 * `delayMs`：模拟「上游要花这么久才吐出首字节」。它是超时相关用例唯一的支点——
 * 原来的 FakeFetcher 永远瞬时返回，任何超时配置都测不出差别，真机上 8 秒超时套用到
 * 同步端点导致图片生成 100% 失败的缺陷，正是因此在全部单测里都看不见。
 */
/**
 * ⚠️ **`body` 收 `ReadableStream`，不只是 `string`**（后来补的）。
 *
 * 原来只吃字符串 ⇒ 上游是「一次性给完整段文本」，**缓冲与不缓冲在观测上完全等价**
 * ——那是第 8 种假阳性（瞬时替身让时序性质不可观测）。要断言「网关没有把整条流攒完
 * 再吐」，上游必须有一个**由测试控制的、真的挂在那里的挂起点**：
 * 给一个 `ReadableStream`，第二块卡在测试自己的 deferred 上。
 * `tests/contract/stream-parity.test.ts` 用的正是这条。
 */
type Outcome =
  | {
    status: number;
    body?: string | ReadableStream<Uint8Array>;
    headers?: Record<string, string>;
    delayMs?: number;
  }
  | { throws: Error };

export class FakeFetcher implements Fetcher {
  readonly usedKeys: string[] = [];
  // 记录每次调用实际发出的请求体（原始字符串），供测试断言协议转换
  // 是否在转发给上游之前真正生效，而不只是断言「确实发出了一次请求」。
  readonly sentBodies: string[] = [];
  // 记录实际请求的完整 URL，供路径拼接类的用例（如路径穿越防护）断言。
  readonly sentUrls: string[] = [];
  private i = 0;

  constructor(private readonly outcomes: Outcome[]) {}

  async fetch(url: string, init: RequestInit & { signal?: AbortSignal }): Promise<Response> {
    this.sentUrls.push(url);
    const auth = new Headers(init.headers).get("authorization") ?? "";
    this.usedKeys.push(auth.replace(/^Bearer /, ""));
    this.sentBodies.push(typeof init.body === "string" ? init.body : "");
    const o = this.outcomes[this.i++] ?? { status: 200, body: "{}" };
    if ("throws" in o) throw o.throws;
    if (o.delayMs !== undefined) await waitOrAbort(o.delayMs, init.signal);
    return new Response(o.body ?? "{}", { status: o.status, headers: o.headers });
  }
}

/** 等待期间若调用方的超时触发了 abort，就像真实 fetch 那样抛 AbortError。 */
function waitOrAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}
