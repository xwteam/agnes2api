function extractPayloads(block: string): { payloads: string[]; done: boolean } {
  const payloads: string[] = [];
  for (const line of block.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return { payloads, done: true };
    if (payload) payloads.push(payload);
  }
  return { payloads, done: false };
}

export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const found = extractPayloads(block);
      for (const p of found.payloads) yield p;
      if (found.done) return;
    }
  }

  // 流可能不以完整的空行结尾结束（连接中断、非 [DONE] 式终止、代理截断
  // 都可能发生）。flush 解码器里滞留的字节，把缓冲区剩下的内容当作最后
  // 一个（可能不完整）块处理，否则最后一个事件会被静默丢弃。
  buf += decoder.decode();
  const tail = extractPayloads(buf);
  for (const p of tail.payloads) yield p;
}

export function sseEvent(event: string | null, data: unknown): string {
  const body = `data: ${JSON.stringify(data)}\n\n`;
  return event === null ? body : `event: ${event}\n${body}`;
}

export function toSseStream(gen: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await gen.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      // 客户端提前断开连接时 ReadableStream 会调用这里。把取消信号转发
      // 给生成器的 return()，让它有机会走到自己的 finally 块，进而释放
      // 它持有的上游读取器——否则上游连接会一直挂着，直到被动超时或 GC。
      await gen.return(undefined);
    },
  });
}
