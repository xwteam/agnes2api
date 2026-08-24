import { describe, it, expect } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { PROTOCOLS, endpointFor, SAMPLE_PROMPT } from "../../src/core/admin/protocol-catalog.js";
import { toSseStream } from "../../src/core/protocol/sse.js";
import { deltaText, sseFrames, playgroundProtocols } from "../../admin-ui/js/pure/playground.mjs";

/**
 * **P3d Task 11：流式那条路的双运行时契约。**
 *
 * ── **这一组能给 U-A 结案吗：不能，而且这句话必须写在最前面** ──────────────────
 * U-A 问的是「**workerd 的 HTTP 服务层**会不会把一条 SSE 响应整体缓冲」。
 * 本文件走的是 `app.request()`，**它根本没有经过任何 HTTP 服务层**——请求对象直接
 * 交给 Hono，响应对象直接拿回来。它能证明的是「Hono / dispatcher / 四条协议转换
 * 这一段不缓冲」，**证明不了 workerd 那一段**。拿它给 U-A 结案就是本仓登记的
 * **第 7 种假阳性（测的是抄件不是原件）**，而且踩在本期自评的头号风险上。
 *
 * ⇒ **U-A 由真机仪器结案，不由本文件结案**：`wrangler dev` 起真 workerd，
 * 假上游 1 秒/块 × 4 块，`curl -N` 逐块打时间戳。实测结论（两种运行时各一行，
 * 到达间隔都约 1 秒 ⇒ 都是逐块透传）写在 Task 11 报告里。
 * **本文件是那条结论的回归网**，不是它的证据。
 *
 * ── **第 8 种假阳性：不许用零延迟替身** ────────────────────────────────────────
 * 上游若是「一次性 enqueue 完再 close」，**缓冲与不缓冲在观测上完全等价**——
 * 两种实现都会在同一时刻把全部内容交出来。所以下面那一格用一个由测试控制的
 * deferred 把第二块**真的卡住**，让「第一块已经到了，而第二块还没被 enqueue」
 * 成为一个可观测的状态。这条挂起点是那一格全部的支点。
 */

const encoder = new TextEncoder();

/** 一条上游 SSE 增量行（内部规范格式 = OpenAI chat 增量块）。 */
function upstreamChunk(text: string): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: text } }] })}\n\n`);
}

/**
 * 一次性给完的上游流（用于**非时序**断言；时序断言一律用上面那个带闸的）。
 *
 * ⚠️ **末尾那一块 `finish_reason` 不是装饰**（评审 F6）：没有它，
 * **openai 那条协议的「带正文的行恰好三条」是空转的**（3 条 payload、3 条都带正文）。
 * openai 是唯一一条**原样透传上游字节**的协议，所以只有让**上游**发一块不带
 * `delta.content` 的块，它下游才会出现一条真正的非正文行。
 * 真实上游在流末发的正是这个形状（本仓 `tests/unit/anthropic.test.ts` 等的夹具同款）。
 * 另三条协议会把它跳过（`toAnthropicStream()` 那几个只在有 content 时才 yield），
 * 它们的非正文行来自各自合成的事件（`message_start` / `response.created` / …）。
 */
function upstreamStream(texts: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const t of texts) c.enqueue(upstreamChunk(t));
      c.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "c1", choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`));
      c.enqueue(encoder.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

/** 把一条响应体整个读成字符串。 */
async function readAll(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/** 这条协议开着流式时，客户端该往哪儿发、带什么头、发什么请求体。**全部来自真源。** */
function streamCall(p: (typeof PROTOCOLS)[number]) {
  const model = "agnes-2.0-flash";
  const body: Record<string, unknown> = { ...p.sample(model) };
  if (p.streamMode === "body") body[p.streamKey] = true;
  return {
    path: endpointFor(p, model, true),
    headers: {
      [p.authHeader]: p.authHeader === "authorization" ? "Bearer t" : "t",
      "content-type": "application/json",
    } as Record<string, string>,
    body: JSON.stringify(body),
  };
}

describe("流式：网关不整体缓冲（U-A 的回归网，不是它的证据）", () => {
  /**
   * **防住的真实故障**：网关把整条上游流攒完再一次性吐出去。那样 Playground 的
   * 「流式」开关就是一句假话——屏幕上仍然是等很久、然后整段一次出现，
   * 而面板会声称自己在流式渲染。
   *
   * **变红条件**：把 `src/core/dispatcher.ts` 的 `sanitize(res)` 改成
   * 先 `await res.text()` 再用那段文本重建一个 Response。
   *
   * ── **这一格的射程，三句话（P3e Task 12 改真）** ─────────────────────────────
   * ① **它只覆盖 openai 纯透传那条路**（`/v1/chat/completions`）。openai 是唯一
   *    原样透传上游字节的协议，这一格连着的就是那条路。**实测**：把
   *    `src/core/protocol/sse.ts` 的 `toSseStream` 从逐块 `pull` 改成 `start` 里
   *    整段缓冲，本仓另有十几格当场红，**这一格纹丝不动**——透传那条路
   *    根本不经过它（**具体几格不写死**：写死的计数会随任何一次加用例而漂）。
   * ② **另三条协议的逐块性由各自 unit 那格守**，逐条点名：
   *    `tests/unit/anthropic.test.ts「首个事件在上游尚未结束时就已产出（真流式）」`、
   *    `tests/unit/responses.test.ts「首个事件在上游尚未结束时就已产出（真流式）」`、
   *    `tests/unit/gemini.test.ts「首个事件在上游尚未结束时就已产出（真流式）」`
   *    （gemini 那格 P3e Task 12 才补上——在那之前它在 unit 侧只有取消那一格）。
   *    本文件下方 CRLF 那一组另外各带一行，同一个缓冲式变异下那三条协议的
   *    CRLF / LF 六行全红；**四条协议共用的那个原语**由
   *    `tests/contract/stream-parity.test.ts`
   *    「toSseStream 在生成器仍未结束时就已把第一块交给下游」直接盯着
   *    （**本文件自己，但路径要写全**：`scripts/check-comment-refs.mjs` 这道门禁只认 `路径「用例名」` 这个形态，
   *    上一版写成「由**本文件**「…」盯着」⇒ 那个锚没有任何机器在校验，
   *    被指向的用例改名不红，阶段 D 回填时实测订正）。
   * ③ **`app.request()` 不经过 workerd 的 HTTP 服务层，也不经过
   *    `src/entry/worker.ts` 的 `fetch()` 导出**（真机上请求先落在那儿，再由它
   *    转交 `app.fetch`）。那一层仍然只能靠真机结案（`wrangler dev` 起真 workerd +
   *    `curl -N` 逐块打时间戳，结论在 P3d Task 11 的报告里），本文件是那条结论的
   *    回归网、不是它的证据。
   */
  it("上游第二块还没 enqueue 时客户端已经读到了第一块 —— 被整体缓冲的话 Playground 的流式开关就是假话", async () => {
    let releaseSecond: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseSecond = r; });
    // ⚠️ 第二块**真的**卡在 `gate` 上（第 8 种假阳性的对策）：
    //    `start` 是 async 的，`await gate` 之前 enqueue 的那一块已经进了队列。
    const upstream = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(upstreamChunk("a"));
        await gate;
        c.enqueue(encoder.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    // ⚠️ **`makeApp` 是 async，必须 await**（`tests/helpers/make-app.ts` 的 `export async function`）。
    // ⚠️ `Outcome.body` 收 `ReadableStream` 是 Task 11 给 `tests/helpers/fake-fetcher.ts` 扩的：
    //    在那之前它只吃 `string`，于是上游只能一次性给完 ⇒ 本格的挂起点根本不存在。
    const { app } = await makeApp([{ status: 200, body: upstream }], ["sk-stream-probe-0001"]);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-2.0-flash", stream: true, messages: [{ role: "user", content: "ping" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.body, "流式响应必须有一个可读的 body").not.toBe(null);

    const reader = res.body!.getReader();
    // **赛跑，而不是干等**：被整体缓冲时 `read()` 会一直挂着（闸永远不放），
    // 干等的话这一格以「超时」形式失败，报错信息说不清是哪条性质坏了。
    // 让它输给一个计时器，断言就变成一句能读的话。
    const timer = new Promise<string>((r) => { setTimeout(() => r("整条流被攒完了才吐"), 3000); });
    const winner = await Promise.race([
      reader.read().then((step) => new TextDecoder().decode(step.value)),
      timer,
    ]);
    expect(winner, "第二块还没 enqueue，第一块就该已经到了客户端").toContain('"a"');

    releaseSecond();
    await reader.cancel();
  });
});

/**
 * ── **P3e Task 12：四条协议共用的那个原语本身，逐块性上装一个观测点** ──────────
 *
 * 上面那一格与下面 CRLF 那一组都是**整条路**的观测：它们要起 app、要过路由、
 * 要挂闸，红起来的报文说的是「哪条协议的哪一头坏了」。而 anthropic / responses /
 * gemini 三条协议的逐块性**全部经由同一个原语** `toSseStream` ——
 * 它一旦从逐块 `pull` 退化成整段缓冲，那三条协议一起坏，报文却分散在六七个地方。
 * 这里给那个原语本身留一格**说得出根因**的观测。
 *
 * **为什么写在 `tests/contract/` 而不是 `tests/unit/sse.test.ts`**：与上面那一组
 * 同一个理由——「不整体缓冲」是**双运行时**性质，`tests/unit/**` 只有 node 那份
 * 配置收集，只写在 unit 里等于只装一半网。这一格在 workerd 下同样要跑得过。
 *
 * ⚠️ **纯行为观测，不许改 `toSseStream` 的签名**：不注入时钟、不加回调、不加
 * 「测试专用」的状态——那会在热路径上留下一份只有测试用得到的东西。这里全部的
 * 装置就是**一个由用例握着的闸**：生成器 yield 完第一块就卡在闸上不结束，
 * 于是「第一块已经到了下游、而生成器还没跑完」成为一个可观测的状态。
 *
 * ⚠️⚠️ **不许用「数 `next()` 调用次数」那把尺子**（P3e Task 12 实测撞掉的一版）：
 * 派发单原本写的是「第一块交出来时生成器只被 `next()` 过 1 次」。**node 下它是 1，
 * workerd 下它是 2 —— 而 `toSseStream` 是同一份逐块实现、一个字没改。**
 * 两个运行时对「交付第一块之后什么时候再 pull 一次」的调度本来就不一样，
 * 那把尺子量的是**运行时的 pull 调度**，不是「第一块什么时候交给下游」
 * ⇒ 它在 workerd 下对**正确实现**恒红（报告变异表 M0）。**判据用错工具，
 * 这次是恒红；上一次（Task 9 的 M1）是恒绿——两种都得靠实测才看得见。**
 */
describe("流式：toSseStream 这个原语自己是逐块的（P3e Task 12）", () => {
  const TIMED_OUT = "__闸还没放，下游一块都没拿到__";
  const CLOSED_EARLY = "__流提前结束了，这一格的挂起点没建起来__";

  /**
   * 起一条生成器，yield 完第一块后（`gatedTail` 为真时）卡在闸上不结束，
   * 返回下游在**闸放开之前**拿到的第一块，以及那一刻生成器有没有跑完。
   *
   * **两格共用同一份观测**（不是各写一遍：用例自己再实现一遍，验的就是抄件）。
   *
   * ⚠️ **赛跑而不是干等**：被整段缓冲时 `read()` 会一直挂着（闸永远不放），
   * 干等的话这一格以「超时」形式失败，报错信息说不清是哪条性质坏了。
   */
  async function firstChunkBeforeGate(gatedTail: boolean): Promise<{ chunk: string; ended: boolean }> {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let ended = false;
    async function* gen(): AsyncGenerator<string> {
      yield "data: 甲\n\n";
      if (gatedTail) {
        await gate;          // 生成器卡在这儿：它**还没有结束**
        yield "data: 乙\n\n";
      }
      ended = true;
    }
    const reader = toSseStream(gen()).getReader();
    const timer = new Promise<string>((r) => { setTimeout(() => r(TIMED_OUT), 2000); });
    try {
      const chunk = await Promise.race([
        reader.read().then((s) => (s.done ? CLOSED_EARLY : new TextDecoder().decode(s.value))),
        timer,
      ]);
      return { chunk, ended };
    } finally {
      release();
      await reader.cancel().catch(() => {});
    }
  }

  /**
   * **防住的真实故障**：`toSseStream` 改成「先把生成器跑干、再一次性 enqueue」。
   * 那样 anthropic / responses / gemini 三条协议一起退化成非流式。
   *
   * ⚠️ **上一版这里写着「而那三条协议的『取消』用例照样全绿」——那句话是假的，
   * 被同一段注释下面两行自己指定的那个变异当场证伪**（阶段 D 回填，实测）：
   * 整段缓冲把生成器抽干在 `start` 里，上游卡在闸上永不结束，于是 `reader.cancel()`
   * 也一起挂住 ⇒ anthropic / responses / gemini 三份 unit 的「取消」格**全部红**，例如
   * `tests/unit/gemini.test.ts`
   * 「upstream 正阻塞在 read() 上等下一个 token 时取消：cancel() 必须及时 resolve 且真的释放 upstream（真实断连场景）」。
   * 而同一个提交里 `tests/unit/gemini.test.ts` 那格上方写的是「本文件当时**只有**取消那一格会红」
   * ——**那一句才是对的**（它限定了「本文件」），两句在同一轮里互相打架。
   * ⇒ **这一格的价值不是「别处都不红」**（缓冲式变异下本仓红一大片，射程①里就写着
   * 「本仓另有十几格当场红」）；**是它红得最准**：它红的时候说的是
   * 「第一块没在生成器结束前交出来」，而取消那一族红的时候说的是
   * 「上游没被释放」——同一个变异，两句诊断，只有前一句指着真正坏掉的那条性质。
   *
   * **变红条件（实测，报告变异表 M1）**：`src/core/protocol/sse.ts` 的
   * `toSseStream` 里那个 `async pull(controller)` 改成 `async start(controller)`
   * 加整段缓冲。缓冲式实现要等生成器跑完，而生成器卡在闸上永不结束
   * ⇒ 下面拿到的是 `TIMED_OUT`。
   */
  it("toSseStream 在生成器仍未结束时就已把第一块交给下游", async () => {
    const { chunk, ended } = await firstChunkBeforeGate(true);
    expect(chunk, "第一块要等生成器跑完才交出来 —— 那是整段缓冲，不是逐块").toBe("data: 甲\n\n");
    // 自检：闸没放，生成器就**不可能**已经跑完。这一行红 = 这一格的挂起点没建起来
    //（比如有人把闸删了），那时上面那句断言就成了一句空话。
    expect(ended, "生成器居然已经跑完了 —— 闸没起作用，上面那句断言是空转的").toBe(false);
  });

  /**
   * **反向控制**：生成器一共只产出一块、随后立刻结束时，「跑完」与「交出第一块」
   * 在观测上本来就重合，这一格今天必须绿。少了它，上面那格红了分不出是
   * 「真的退化成缓冲了」还是「这套闸本身让谁都过不去」。
   *
   * ⚠️ 它在**缓冲式变异下也必须保持绿**——那正是它的用处：同一次变异里
   * 上面那格红、这格绿，才说明红的是「逐块性」这一条性质本身。
   */
  it("反向控制：生成器只产出一块时也不许误红", async () => {
    const { chunk } = await firstChunkBeforeGate(false);
    expect(chunk, "单块生成器上第一块本来就该原样交出来 —— 它红了说明这套闸对谁都红").toBe("data: 甲\n\n");
  });
});

/**
 * ── **P3e Task 11：上游把行尾改写成 CRLF 时，流式还是不是流式** ────────────────
 *
 * **为什么必须写在 `tests/contract/` 而不是只写 `tests/unit/sse.test.ts`**：
 * 「网关不整体缓冲」是一条**双运行时**性质，而 `tests/unit/**` 只有 node 那份配置
 * 收集（`vitest.workers.config.ts` 的 `include` 只有 `tests/contract/**`）。
 * 只写在 unit 里等于给这条性质**只装了一半网**。
 *
 * ⚠️ **这一组同样不给 U-A 结案**（理由见本文件开头那段）：`app.request()` 不经过
 * 任何 HTTP 服务层。它守的是「Hono / 四条协议转换这一段在 CRLF 上游下仍然逐块交付」。
 *
 * ⚠️⚠️ **四条协议的观测对象不是同一个，如实写清**：
 * · **anthropic / responses / gemini**：网关**解析**上游（`parseSseStream`）再合成
 *   自己的事件，吐出去的字节恒为 LF ⇒ 这三行验的是**网关那份分帧**；
 * · **openai**：`src/http/routes/openai.ts` 的 `if (stream && res.ok)` 那条**原样透传
 *   上游字节**，CRLF 会一路穿到客户端 ⇒ 这一行验的是**面板那份分帧**
 *  （`sseFrames`，也就是这一格用来观测的那把尺子本身）。
 *   两份实现在这个任务里一起改，所以这一行照样有鉴别力——**红的时候看协议名就知道
 *   是哪一份坏了**。
 */
describe("流式：上游换成 CRLF 换行时，第一个正文字仍然要在上游第二块之前到达", () => {
  const TIMED_OUT = "__上游第二块还没来，客户端一个正文字都没拿到__";
  const CLOSED_EARLY = "__流提前结束了，这一格的挂起点没建起来__";

  /**
   * 起一条「第一块已到、第二块**真的**卡在闸上、上游也不 close」的上游流，
   * 返回客户端在**闸放开之前**拿到的第一段正文。
   *
   * ⚠️ **上游的行尾由 `nl` 决定，网关自己吐出去的永远是 LF**（`sseEvent()` 写死）。
   * ⚠️ **赛跑而不是干等**：被整体缓冲时 `read()` 会一直挂着（闸永远不放），
   * 干等的话这一格以「超时」形式失败，报错信息说不清是哪条性质坏了。
   */
  async function firstTextBeforeGate(p: (typeof PROTOCOLS)[number], nl: string): Promise<string> {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const upstream = new ReadableStream<Uint8Array>({
      async start(c) {
        // `start` 是 async 的：`await gate` 之前 enqueue 的这一块已经进了队列。
        c.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "甲" } }] })}${nl}${nl}`));
        await gate;
        c.enqueue(encoder.encode(`data: [DONE]${nl}${nl}`));
        c.close();
      },
    });
    const { app } = await makeApp([{ status: 200, body: upstream }], ["sk-stream-probe-0001"]);
    const call = streamCall(p);
    const res = await app.request(call.path, { method: "POST", headers: call.headers, body: call.body });
    expect(res.status, `${p.id} 的流式请求没到 200`).toBe(200);
    expect(res.body, `${p.id} 的流式响应必须有一个可读的 body`).not.toBe(null);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const timer = new Promise<string>((r) => { setTimeout(() => r(TIMED_OUT), 2000); });
    let acc = "";
    try {
      for (;;) {
        const step = await Promise.race([
          reader.read().then((s) => (s.done ? CLOSED_EARLY : decoder.decode(s.value, { stream: true }))),
          timer,
        ]);
        if (step === TIMED_OUT || step === CLOSED_EARLY) return step;
        acc += step;
        // **用面板那一份分帧 + 取值**（第 7 种假阳性：用例自己再写一遍，验的就是抄件）。
        const { payloads } = sseFrames(acc);
        const texts = payloads.map((line) => deltaText(p, line)).filter((t) => t !== null && t !== "");
        if (texts.length > 0) return texts.join("");
      }
    } finally {
      release();
      await reader.cancel().catch(() => {});
    }
  }

  /**
   * **防住的真实故障**：上游或中间某一层（反代）把行尾改写成 CRLF，四条协议
   * **全部 200、字节也全都到得了**，只是全都攒到上游关闭那一刻才一次性出现
   * ——面板上「流式」开关仍然显示开着，而**在上游关闭之前**屏幕一直是空的；
   * 中途断流（上游没走到关闭那一步）才是 100% 丢失。
   * ⚠️ **那两个时间限定词不是修辞**：上一版写的是「而屏幕是空的」，
   * 读起来像「一个字都不会出现」，而实测的形态是「等很久、然后整段蹦出来」
   * ——`admin-ui/js/gw-api.js` 收尾那句会把整个缓冲当最后一帧再切一次，
   * **负载一条都不少**。缺了限定词，下一个人会照着「屏幕空白」去找一条根本不存在的
   * 「解析不出来」的缺陷（P3e Task 11 就是这么被上一版的措辞带偏过一次的）。
   *
   * **变红条件（逐条实测过，见报告变异表 M1 / M2）**：把
   * `src/core/protocol/sse.ts` 或 `admin-ui/js/pure/playground.mjs` 里认
   * `\r\n\r\n` 的那一支撤掉。
   */
  it.each(
    PROTOCOLS.flatMap((p) => [
      [`${p.id} · CRLF`, p, "\r\n"] as const,
      // **反向控制**：同一套闸喂 LF 今天就必须绿。少了它，CRLF 那一行红了
      // 分不出是「CRLF 真的坏了」还是「这套闸本身让谁都过不去」。
      [`${p.id} · LF（反向控制）`, p, "\n"] as const,
    ]),
  )("%s：上游第二块还没 enqueue，第一个正文字就该已经到了客户端", async (_label, p, nl) => {
    expect(await firstTextBeforeGate(p, nl)).toBe("甲");
  });
});

describe("流式：协议目录的 streamTextPath 与网关真吐出去的字节对得上", () => {
  /**
   * ⚠️⚠️ **这一格是新增那一格真源（`streamTextPath`）的立身之本。**
   *
   * 观测点落在 **真 app 经真路由吐出去的 SSE 字节**上，**不是**比对
   * `protocol-catalog.ts` 自己的两个字段（那是同义反复：拿一份数据验它自己）。
   * 与 `upstreamPath` 那一条守的是同一条纪律，理由写在那个字段上方。
   *
   * **防住的真实故障**：四条协议的增量长得都不一样，而三条是本仓自己合成的。
   * 路径填错的后果是 **Playground 的对话框永远是空的**——请求 200、字节也确实
   * 一块块到了，只是每一块都取不出正文，面板上没有任何东西会提到这件事。
   *
   * **变红条件（逐条实测过，见报告变异表 M3）**：把任意一条协议的
   * `streamTextPath` 改一格，例如 anthropic 那条改成 `["delta", "content"]`。
   */
  it.each(PROTOCOLS.map((p) => [p.id, p] as const))(
    "%s：一条真的流式请求，按 streamTextPath 逐块取出来的正是上游那三个字",
    async (_id, p) => {
      // 手写字面量，**不从上游夹具推导**（第 6 种假阳性）。三个字符各不相同，
      // 顺序错了、丢了一块、重复了一块都要红。
      const sent = ["甲", "乙", "丙"];
      const { app } = await makeApp(
        [{ status: 200, body: upstreamStream(sent) }],
        ["sk-stream-probe-0001"],
      );
      const call = streamCall(p);
      const res = await app.request(call.path, { method: "POST", headers: call.headers, body: call.body });
      expect(res.status, `${p.id} 的流式请求没到 200`).toBe(200);

      const wire = await readAll(res.body);
      // **用面板那一份 SSE 切分**（`js/pure/playground.mjs` 的 `sseFrames`）——
      // 用例自己再写一遍分帧，验的就是抄件不是原件。
      const { payloads } = sseFrames(wire);
      expect(payloads.length, `${p.id} 一条 data 负载都没有`).toBeGreaterThan(0);

      // **用面板那一份取值**（`deltaText`），入参是真源里那条协议本身。
      const got = payloads.map((line) => deltaText(p, line));
      expect(got, `${p.id} 有读不出来的数据行`).not.toContain(null);
      expect(got.join(""), `${p.id} 的 streamTextPath 取错了格`).toBe(sent.join(""));
    },
  );

  /**
   * **防住的真实故障**：路径「碰巧在事件行上也取得到东西」。
   *
   * 上面那格只断言正文拼起来对，**它挡不住一条把非正文事件也算成正文的路径**——
   * 那种路径会让对话框里混进 `in_progress`、`end_turn` 这类协议内部的词。
   * ⇒ 这里逐行分档：**取到正文的行数必须恰好等于上游给的块数**，其余行必须是空串
   * （读得出来、不带正文），**一行都不许是 `null`（读不出来）**。
   *
   * ⚠️ **哪几条协议上这一格不是空转，逐条写清（评审 F6 实测订正）**：
   * · **anthropic / responses**：流里夹着自己合成的事件行（`message_start` /
   *   `content_block_start` / `message_delta` / `message_stop`、`response.created` /
   *   `response.completed`）——**天然不空转**；
   * · **openai**：它原样透传上游字节，所以只有当**上游**发一块不带 `delta.content`
   *   的块时才有非正文行。**`upstreamStream()` 末尾那块 `finish_reason` 就是为它加的**
   *   ——在那之前这一格对 openai 是 3/3 的空转（我原来的注释只点了 gemini，**漏了它**）；
   * · **gemini**：`toGeminiStream()` 只在有 content 时 yield，一行都不夹
   *   ⇒ **这一格对 gemini 至今仍是空转**，如实登记。
   */
  it.each(PROTOCOLS.map((p) => [p.id, p] as const))(
    "%s：带正文的行恰好三条，其余事件行读得出来但不带正文 —— 混进协议内部的词就是对话框在撒谎",
    async (_id, p) => {
      const sent = ["甲", "乙", "丙"];
      const { app } = await makeApp(
        [{ status: 200, body: upstreamStream(sent) }],
        ["sk-stream-probe-0001"],
      );
      const call = streamCall(p);
      const res = await app.request(call.path, { method: "POST", headers: call.headers, body: call.body });
      const { payloads } = sseFrames(await readAll(res.body));
      const got = payloads.map((line) => deltaText(p, line));

      expect(got.filter((x) => x === null).length, `${p.id} 有读不出来的行`).toBe(0);
      // 期望值手写字面量 3，**不是 `sent.length`**：从被测数据推导出来的期望值
      // 在两边同时改错时照样绿（第 6 种假阳性）。
      expect(got.filter((x) => x !== "").length, `${p.id} 带正文的行数不对`).toBe(3);

      /**
       * **每条协议的行构成逐条钉死**（评审 F6 的落点）。
       *
       * 上面那条「带正文恰好 3」**说不出这一格对谁是空转的**——一条协议如果压根
       * 不发非正文行，那它就只是在重复上一格。这张表把「这条流里有几行、其中几行
       * 不带正文」写成手写字面量，**顺带把「gemini 至今仍是空转」这件事变成可见的 0**。
       * 数字全部实测得来（同一装置跑一遍打出来的），不是从被测数据推导的。
       */
      const COMPOSITION: Record<string, { payloads: number; blank: number }> = {
        openai: { payloads: 4, blank: 1 },      // 3 块正文 + 上游那块 finish_reason（原样透传）
        anthropic: { payloads: 8, blank: 5 },   // + message_start / content_block_start / _stop / message_delta / message_stop
        responses: { payloads: 5, blank: 2 },   // + response.created / response.completed
        gemini: { payloads: 3, blank: 0 },      // **一行都不夹 ⇒ 这一格对 gemini 是空转，如实登记**
      };
      const want = COMPOSITION[p.id]!;
      expect(payloads.length, `${p.id} 这条流的行数变了`).toBe(want.payloads);
      expect(got.filter((x) => x === "").length, `${p.id} 不带正文的行数变了`).toBe(want.blank);
    },
  );
});

describe("协议目录：samplePrompt 这一格（Task 11 加，消掉前端那份副本）", () => {
  /**
   * **防住的真实故障**：面板靠「在 `sampleBody` 里找到这句话并把它换成用户输入」
   * 注入提示词。端点交出来的 `samplePrompt` 与 `sampleBody` 里那句话一旦不是同一个，
   * 面板**一处都换不掉** ⇒ 它要么整轮判失败，要么（如果哪天有人给它加了退路）
   * **恒发样例那句话、静默丢弃用户真正输入的内容**。
   *
   * ⚠️ 观测点在**端点真吐出去的那份 JSON** 上，不是比对 `protocol-catalog.ts`
   * 里的两个常量——后者是拿一份数据验它自己。
   *
   * **变红条件**：把 `catalogPayload()` 里的 `samplePrompt: SAMPLE_PROMPT`
   * 改成任何别的字面量（报告变异表 M7）。
   */
  it("GET /admin/api/models 交出来的 samplePrompt，在每一条 sampleBody 的 JSON 里恰好出现一次", async () => {
    const { app } = await makeApp([], []);
    const res = await app.request("/admin/api/models", { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });
    expect(res.status).toBe(200);
    const body = await res.json() as { samplePrompt?: unknown; protocols: Array<{ id: string; sampleBody: unknown }> };

    expect(typeof body.samplePrompt, "端点没有交出 samplePrompt 这一格").toBe("string");
    const slot = body.samplePrompt as string;
    expect(slot, "占位文本不许是空串 —— 空串在每份请求体里都能匹配上无数次").not.toBe("");

    // 手写字面量 4：协议少一条的话上面那些 `it.each` 会跟着少跑，而不会红。
    expect(body.protocols.length, "协议条数变了").toBe(4);
    for (const proto of body.protocols) {
      const hits = JSON.stringify(proto.sampleBody).split(JSON.stringify(slot).slice(1, -1)).length - 1;
      expect(hits, `${proto.id} 的 sampleBody 里那句占位文本出现了 ${hits} 次，不是恰好一次`).toBe(1);
    }
  });

  /**
   * **防住的真实故障**：这一格进不了面板那一侧的窄化 ⇒ `withPrompt()` 拿不到占位文本
   * ⇒ **整个 Playground 判成「目录读不出来」**，左栏画的是错误横幅。
   * 这一格与上一格是两件事：上一格验端点给了什么，这一格验面板认不认。
   *
   * **变红条件**：把 `playgroundProtocols()` 里那句 `p.samplePrompt` 的窄化删掉
   * （它会退化成 `undefined`，四条协议的 `samplePrompt` 全成 `undefined`）。
   */
  it("面板那一侧窄化之后，四条协议各自带着同一句占位文本 —— 拿不到它 withPrompt 一处都换不掉", async () => {
    const { app } = await makeApp([], []);
    const res = await app.request("/admin/api/models", { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });
    const list = playgroundProtocols(await res.json()) as Array<{ id: string; samplePrompt: string }> | null;
    expect(list, "真实响应必须窄化得出来").not.toBe(null);
    expect(list!.length).toBe(4);
    for (const proto of list!) {
      expect(proto.samplePrompt, `${proto.id} 没带上占位文本`).toBe(SAMPLE_PROMPT);
    }
  });
});
