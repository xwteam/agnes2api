import type { Fetcher } from "../../src/ports/fetcher.js";

type Outcome = { status: number; body?: string; headers?: Record<string, string> } | { throws: Error };

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
    return new Response(o.body ?? "{}", { status: o.status, headers: o.headers });
  }
}
