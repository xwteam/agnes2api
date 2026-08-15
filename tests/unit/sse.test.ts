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
});
