import { describe, it, expect } from "vitest";
import { parseSseStream, sseEvent, toSseStream } from "../../src/core/protocol/sse.js";

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
  });
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("parseSseStream", () => {
  it("逐条产出 data 负载", async () => {
    const s = streamOf('data: {"a":1}\n\ndata: {"a":2}\n\n');
    expect(await collect(parseSseStream(s))).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("遇到 [DONE] 结束且不产出它", async () => {
    const s = streamOf('data: {"a":1}\n\ndata: [DONE]\n\n');
    expect(await collect(parseSseStream(s))).toEqual(['{"a":1}']);
  });

  it("能拼回被切断在块边界中间的事件", async () => {
    const s = new ReadableStream<Uint8Array>({
      start(c) {
        const e = new TextEncoder();
        c.enqueue(e.encode('data: {"a"'));
        c.enqueue(e.encode(':1}\n\n'));
        c.close();
      },
    });
    expect(await collect(parseSseStream(s))).toEqual(['{"a":1}']);
  });

  it("忽略注释行与空行", async () => {
    const s = streamOf(': ping\n\ndata: {"a":1}\n\n');
    expect(await collect(parseSseStream(s))).toEqual(['{"a":1}']);
  });

  it("流结尾没有收尾的空行也要产出最后一个事件", async () => {
    const s = streamOf('data: {"a":1}\n\ndata: {"a":2}');
    expect(await collect(parseSseStream(s))).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("流结尾只有单个换行也要产出最后一个事件", async () => {
    const s = streamOf('data: {"a":1}\n\ndata: {"a":2}\n');
    expect(await collect(parseSseStream(s))).toEqual(['{"a":1}', '{"a":2}']);
  });
});

describe("sseEvent", () => {
  it("带事件名时输出 event 与 data 两行", () => {
    expect(sseEvent("message_start", { type: "x" })).toBe('event: message_start\ndata: {"type":"x"}\n\n');
  });

  it("不带事件名时只输出 data 行", () => {
    expect(sseEvent(null, { a: 1 })).toBe('data: {"a":1}\n\n');
  });
});

describe("toSseStream", () => {
  it("把生成器逐条编码为字节流", async () => {
    async function* gen() { yield "data: 1\n\n"; yield "data: 2\n\n"; }
    const text = await new Response(toSseStream(gen())).text();
    expect(text).toBe("data: 1\n\ndata: 2\n\n");
  });

  it("取消流后会调用生成器的 return()，令其 finally 块执行到", async () => {
    let cleaned = false;
    async function* gen() {
      try {
        yield "data: 1\n\n";
        await new Promise(() => {}); // 模拟卡在等待上游下一条数据
        yield "data: 2\n\n"; // 不应该被执行到
      } finally {
        cleaned = true;
      }
    }
    const reader = toSseStream(gen()).getReader();
    await reader.read(); // 消费第一条，生成器此时挂起在 await new Promise 处
    await reader.cancel();
    expect(cleaned).toBe(true);
  });

  // 上面那条测试只证明了「生成器刚 yield 完、没有 pending next()」这种协作式
  // 场景下 gen.return() 能生效——它不代表安全。真正会发生连接泄漏的场景是：
  // parseSseStream 内部正阻塞在一次不会自己 resolve 的 reader.read() 上（上游
  // 还没发下一个字节，也没关闭）。这时 gen.return() 会排在那个已经在飞行中的
  // .next() 后面，永远等不到执行。必须靠带外的 AbortSignal 直接 reader.cancel()
  // 才能解除阻塞——这条测试把流真正驱动到那个状态再取消，钉死这个真实场景。
  it("upstream 正阻塞在 read() 上时取消：借助 signal/onCancel 能及时 resolve 并真正取消 upstream", async () => {
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: 1\n\n"));
        // 之后既不再 enqueue，也不 close。
      },
      cancel() { upstreamCancelled = true; },
    });

    const controller = new AbortController();
    async function* gen() {
      for await (const raw of parseSseStream(upstream, controller.signal)) {
        yield `data: ${raw}\n\n`;
      }
    }
    const stream = toSseStream(gen(), () => controller.abort());
    const reader = stream.getReader();

    await reader.read(); // 消费第一条
    const pendingRead = reader.read(); // 故意不 await：这次真正卡在 upstream 的第二次 read() 上
    await new Promise((r) => setTimeout(r, 20));

    await Promise.race([
      reader.cancel(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("cancel() 超过 500ms 未 resolve")), 500);
      }),
    ]);
    await pendingRead.catch(() => {});

    expect(upstreamCancelled).toBe(true);
  });
});
