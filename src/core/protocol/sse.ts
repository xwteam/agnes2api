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

/**
 * 一帧的边界 = **一个空行**，`\n\n` 与 `\r\n\r\n` 两种都认。
 *
 * ⚠️ **为什么必须认 CRLF**：网关自己发的是 `\n\n`，但**上游不归我们管**——
 * 上游或中间任何一层反代把行尾改写成 CRLF 时，只认 `\n\n` 的话
 * `indexOf` 永远找不到边界，于是这条流会一路攒到上游关闭，
 * 由本函数收尾那次 flush 一次性交出全部负载。**失败形态是「退化成一次性 +
 * 全流无界缓冲」，不是「一条都读不出来」**（实测），而中途断流时收尾那次
 * flush 根本不跑 ⇒ **已经该交出去的负载 100% 丢失**。
 *
 * ⚠️ **只认这两种，不认裸 `\r`**（EventSource 规范里 CR 单独也算换行）：
 * 本仓至今没有见过只发裸 CR 的上游，而多认一种就要多一条没有真实样本
 * 支撑的分支。**如实登记，不假装它是完备的 SSE 实现。**
 *
 * ⚠️ **取两者里靠前的那一个**，不是「先找 LF 找不到再找 CRLF」：
 * 同一段缓冲里两种行尾混着出现（换代理、断点续传）时，
 * 后者会把中间整段当成一帧，帧边界就错位了。
 *
 * ⚠️ **行内那个 `\r` 由既有的 `.trim()` 吃掉，不许再加第二次 trim**——
 * 那会把负载正文里合法的前后空白也一起吃掉。
 */
function frameEnd(buf: string): { idx: number; len: number } | null {
  const lf = buf.indexOf("\n\n");
  const crlf = buf.indexOf("\r\n\r\n");
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { idx: crlf, len: 4 };
  return lf === -1 ? null : { idx: lf, len: 2 };
}

/**
 * @param signal 可选。用于带外中断一次正阻塞在 reader.read() 上、上游还没
 *   发下一个字节的读取。不能指望调用方对本函数返回的异步生成器调用
 *   `.return()` 来打断它：`.return()` 会排在已经在飞行中的 `.next()`
 *   请求后面（AsyncGenerator 内部按 FIFO 处理 next/return/throw 请求），
 *   而这次 `.next()` 内部的 `await reader.read()` 在上游没有更多数据、
 *   也没有关闭连接之前永远不会自己 resolve，于是 `.return()` 也永远轮
 *   不到执行——这不是本函数特有的 bug，是「只转发 .return() 然后指望
 *   for-await 的 IteratorClose」这个设计本身的结构性问题。
 *   这里改为直接对 reader 调 cancel()：按 Streams 规范，cancel() 会让
 *   所有当前挂起中的 read() 请求立即以 `{ done: true }` 结算，从而绕开
 *   生成器的迭代器请求队列。对真实 fetch() 的响应体而言，cancel() 还会
 *   进一步中止底层的 HTTP 请求，这才是真正释放上游连接的地方。
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const onAbort = () => { reader.cancel().catch(() => {}); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let end: { idx: number; len: number } | null;
      while ((end = frameEnd(buf)) !== null) {
        const block = buf.slice(0, end.idx);
        buf = buf.slice(end.idx + end.len);
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
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export function sseEvent(event: string | null, data: unknown): string {
  const body = `data: ${JSON.stringify(data)}\n\n`;
  return event === null ? body : `event: ${event}\n${body}`;
}

/**
 * @param onCancel 可选。客户端提前断开连接、这个函数返回的 ReadableStream
 *   被消费方 cancel 时，除了尝试 `gen.return()` 之外，会先同步调用它——
 *   给调用方一个不经过生成器迭代器请求队列、立即生效的带外取消入口。
 *   典型用法是翻转一个 AbortController，并把它的 signal 传给
 *   parseSseStream；若只依赖 `gen.return()`，一旦生成器正阻塞在一个不会
 *   自己 resolve 的 await（例如上游还没发下一个字节），取消会永远卡住。
 */
export function toSseStream(
  gen: AsyncGenerator<string>,
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await gen.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      onCancel?.();
      await gen.return(undefined).catch(() => {});
    },
  });
}
