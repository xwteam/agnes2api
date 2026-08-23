import { describe, it, expect } from "vitest";
import {
  playgroundProtocols, modelIdsForProtocol, withPrompt, buildRequest,
  authHeaderValue, tokenHintState, prettyJson, deltaText, sseFrames,
} from "../../admin-ui/js/pure/playground.mjs";
import { exampleFor, KEY_PLACEHOLDER } from "../../admin-ui/js/pure/examples.mjs";
import { catalogPayload, SAMPLE_PROMPT } from "../../src/core/admin/protocol-catalog.js";
import { parseSseStream } from "../../src/core/protocol/sse.js";

/**
 * **Playground 的请求构造（P3d Task 10 Step 5）。**
 *
 * 被守护的核心性质只有一条，它就是 P3d 的核心设计决定（全局约束 15）：
 * **四个消费者只许有一份「怎么调这个网关」的知识。**
 * 集成示例卡（Task 7）教运维怎么调，Playground 真的去调一次——
 * 设计文档订正 D1 把这两件事挪进同一期的逐字理由是
 * 「它们是同一份知识，做两遍必漂，而漂了没人会发现」。
 * 下面每一格都对着「漂了」的某一种具体形态。
 *
 * ⚠️ **真实目录一律用 `catalogPayload()`，不手抄一份**（第 7 种假阳性：测的是抄件不是原件）。
 * ⚠️ **合成目录里的路径、协议 id 全是编的**（`/probe/...`、`alpha`）：
 * 被测模块按定义不认识任何真实协议 id，编一个反而更能说明这一点。
 */
const ORIGIN = "https://gw-probe.invalid";

/**
 * 合成目录里那句占位文本。**故意不是真源那个 `"ping"`**（P3d Task 11）。
 *
 * Task 10 时面板自己存着一份 `PROMPT_SLOT_SAMPLE = "ping"` 的副本，那份副本
 * 只能靠一格逐字比对兜着。**Task 11 把它消掉了**：占位文本现在跟着
 * `GET /admin/api/models` 的响应一起来（真源多了一格 `samplePrompt`）。
 * ⇒ 合成夹具在这里给一个**真源里根本不存在**的值，被测模块照样得工作——
 * 那是「它真的从数据里取，而不是内置了那个词」最直接的证据。
 */
const SLOT = "PROBE-SLOT-7";

/** 合成目录里那条「正文在哪一格」。同样是编的（真源里没有这条路径）。 */
const PROBE_TEXT_PATH = ["out", "0", "say"];

/** 真实目录窄化之后那四条协议。**前置条件自己先断言一次**，否则下面每一格都是空的。 */
function realProtocols() {
  const list = playgroundProtocols(catalogPayload());
  expect(list, "前置条件：真实目录必须窄化得出来").not.toBe(null);
  return list!;
}

describe("协议目录窄化：读不出来 ≠ 一条协议都没有", () => {
  it("真实目录窄化出四条协议，字段逐个手写钉死 —— 少一格就有一条真的能用的协议入口被抹掉", () => {
    const list = realProtocols();
    // 期望值手写字面量，**不从 `catalogPayload()` 推导**（第 6 种假阳性）。
    expect(list.map((p) => p.id)).toEqual(["openai", "anthropic", "responses", "gemini"]);
    expect(list.map((p) => p.authHeader)).toEqual([
      "authorization", "x-api-key", "authorization", "x-goog-api-key",
    ]);
    expect(list.map((p) => p.streamMode)).toEqual(["body", "body", "body", "path"]);
    expect(list.map((p) => p.method)).toEqual(["POST", "POST", "POST", "POST"]);
  });

  /**
   * **任何一条格式不对就整份判成读不出来，不是把坏的那条跳过。**
   * 跳过之后左栏会少一个协议档位而看起来完全正常——后果是把一条真的能用的协议入口
   * 从工具里抹掉，而运维得不到任何信号。
   *
   * **变红条件**：把 `playgroundProtocols()` 里任何一条 `return null` 改成 `continue`。
   */
  it.each([
    ["id", { id: 1 }],
    ["label", { label: "" }],
    ["method", { method: "" }],
    ["pathTemplate", { pathTemplate: "" }],
    ["authHeader", { authHeader: "" }],
    ["streamMode", { streamMode: "" }],
    ["streamKey", { streamKey: "" }],
    ["sampleBody", { sampleBody: "not an object" }],
    // ── P3d Task 11 加的那一格（`streamTextPath`），四种坏法各一条 ──────────────
    // **每一段都得是非空字符串**：一段空串会让 `deltaText()` 去读一格名字为空的属性，
    // 那一定取不到东西，而「取不到」与「这一行不带正文」在下游长得一模一样
    // ⇒ 整条协议的正文会**静默地永远为空**。
    ["streamTextPath 不是数组", { streamTextPath: "delta.text" }],
    ["streamTextPath 是空数组", { streamTextPath: [] }],
    ["streamTextPath 里有空串", { streamTextPath: ["delta", ""] }],
    ["streamTextPath 里有非字符串", { streamTextPath: ["delta", 0] }],
  ])("这一格坏掉就整份读不出来（不是少画一档）：%s", (_name, patch) => {
    const good = {
      id: "alpha", label: "Alpha", method: "POST", pathTemplate: "/probe/alpha",
      authHeader: "authorization", streamMode: "body", streamKey: "stream",
      streamTextPath: PROBE_TEXT_PATH, sampleBody: { q: SLOT },
    };
    // 前置条件：不打补丁时它必须是读得出来的，否则这一格证不了「是补丁让它坏的」。
    expect(playgroundProtocols({ protocols: [good], samplePrompt: SLOT })).not.toBe(null);
    expect(playgroundProtocols({ protocols: [{ ...good, ...(patch as object) }], samplePrompt: SLOT })).toBe(null);
  });

  /**
   * **`samplePrompt` 缺席同样是「整份读不出来」，不是「少一格」**（P3d Task 11）。
   *
   * 拿不到它 `withPrompt()` 一处都换不掉 ⇒ 每一次发送都判构造失败。
   * **让它退化成一个静默的空串更糟**：空串在任何一份请求体里都能匹配上无数次，
   * 那会把「注入用户输入」变成一次随机替换。
   *
   * **变红条件**：把 `playgroundProtocols()` 里那句 `p.samplePrompt` 的窄化删掉。
   */
  it.each([
    ["缺席", {}],
    ["是空串", { samplePrompt: "" }],
    ["不是字符串", { samplePrompt: 7 }],
  ])("占位文本这一格 %s 时整份读不出来 —— 拿不到它，用户输入就无处可放", (_name, patch) => {
    const good = {
      id: "alpha", label: "Alpha", method: "POST", pathTemplate: "/probe/alpha",
      authHeader: "authorization", streamMode: "body", streamKey: "stream",
      streamTextPath: PROBE_TEXT_PATH, sampleBody: { q: SLOT },
    };
    expect(playgroundProtocols({ protocols: [good], samplePrompt: SLOT })).not.toBe(null);
    expect(playgroundProtocols({ protocols: [good], ...(patch as object) })).toBe(null);
  });

  it("目录真的是空的时候交出空数组，不是 null —— 「一条协议都没有」与「读不出来」是两句话", () => {
    expect(playgroundProtocols({ protocols: [], samplePrompt: SLOT })).toEqual([]);
    expect(playgroundProtocols({ protocols: "nope", samplePrompt: SLOT })).toBe(null);
    expect(playgroundProtocols(null)).toBe(null);
  });
});

describe("模型下拉：只列这条协议上真的可用的", () => {
  /**
   * **变红条件**：把 `modelIdsForProtocol()` 里的 `e.protocols.includes(id)` 改成 `true`。
   * 媒体模型的 `protocols` 是空数组——把它填进一条对话协议的下拉里，运维选中之后拿到的是
   * 一次注定 4xx 的请求，而面板事先什么都没说。
   */
  it("媒体模型不出现在对话协议的模型下拉里 —— 选中它只会换来一次注定失败的请求", () => {
    const proto = realProtocols()[0]!;
    // 期望值手写字面量：真实目录里今天只有这一个对话模型。
    expect(modelIdsForProtocol(proto, catalogPayload().models)).toEqual(["agnes-2.0-flash"]);
  });

  it("这条协议上一个模型都没有时是空数组 —— 调用方按「这一档没得选」画", () => {
    const proto = { id: "delta" };
    const models = [{ id: "m1", protocols: ["alpha"] }, { id: "m2", protocols: [] }];
    expect(modelIdsForProtocol(proto, models)).toEqual([]);
    expect(modelIdsForProtocol(proto, null)).toEqual([]);
  });
});

describe("withPrompt：判据是形状，不是协议 id", () => {
  /**
   * **这是本任务最容易写成第二份知识的地方。**
   *
   * 写成 `switch (proto.id) { case "openai": … }` 的话，就是在前端又维护了一次
   * 「四条协议长什么样」。判据必须来自 `sampleBody` 的形状。
   *
   * **变红条件**：把 `withPrompt()` 改成按 `proto.id` 分支 —— 这个 id 它不认识，
   * 于是要么抛错、要么走 default 分支交出一份没有用户输入的请求体。
   */
  it("withPrompt 不认协议 id，只认 sampleBody 的形状 —— 写成 switch(proto.id) 就是在前端又维护了一次『四条协议长什么样』", () => {
    const fake = {
      id: "unknown-xyz",
      pathTemplate: "/probe/unknown",
      samplePrompt: SLOT,
      // OpenAI 形状，但 id 是编的。
      sampleBody: { model: "m0", messages: [{ role: "user", content: SLOT }] },
    };
    const body = withPrompt(fake, "m9", "你好");
    expect(body, "认了 id 就交不出来").not.toBe(null);
    expect(body.messages[0].content).toBe("你好");
    expect(body.model, "模型那一格没跟着换").toBe("m9");
    // 反向：样例那句话一个字都不许留下。
    expect(JSON.stringify(body)).not.toContain(SLOT);
  });

  it("四条真实协议各自把用户输入放进自己那一格 —— 四种形状全不一样，一条都不许漏", () => {
    const [openai, anthropic, responses, gemini] = realProtocols();
    // 期望值逐条手写：这四条路径就是「四条协议长什么样」这份知识的全部内容，
    // 从 `sampleBody` 推导出来的期望值是同义反复。
    expect(withPrompt(openai, "agnes-2.0-flash", "甲").messages[0].content).toBe("甲");
    expect(withPrompt(anthropic, "agnes-2.0-flash", "乙").messages[0].content).toBe("乙");
    expect(withPrompt(anthropic, "agnes-2.0-flash", "乙").max_tokens, "Anthropic 的必填项被抹掉了").toBe(64);
    expect(withPrompt(responses, "agnes-2.0-flash", "丙").input).toBe("丙");
    expect(withPrompt(gemini, "agnes-2.0-flash", "丁").contents[0].parts[0].text).toBe("丁");
    // Gemini 的请求体里没有模型那一格（它在路径里），**不许凭空塞一个进去**。
    expect(
      Object.prototype.hasOwnProperty.call(withPrompt(gemini, "agnes-2.0-flash", "丁"), "model"),
      "往 Gemini 的请求体里塞了一格它不认的 model",
    ).toBe(false);
  });

  /**
   * **占位文本对不上时返回 `null`，绝不退回样例。**
   *
   * 这是 Task 1 在真源文件头点名的那个失效：谁把某条协议的样例文本改成别的，
   * Playground 对那条协议**静默丢弃用户输入、恒发样例那句话**，面板上完全看不出来。
   *
   * **变红条件**：把 `withPrompt()` 的 `if (hits !== 1) return null;` 删掉。
   */
  it("样例里找不到那句占位文本时返回 null —— 退回样例会让用户输入被静默丢弃", () => {
    const drifted = {
      id: "x", pathTemplate: "/probe/x", samplePrompt: SLOT,
      sampleBody: { model: "m", input: "pong" },
    };
    expect(withPrompt(drifted, "m", "你好"), "占位文本漂了却照样交出一份请求体").toBe(null);
  });

  it("占位文本在样例里出现两次时同样返回 null —— 「我不知道该往哪儿放」也是一种不知道", () => {
    const twice = {
      id: "x", pathTemplate: "/probe/x", samplePrompt: SLOT,
      sampleBody: { model: "m", a: SLOT, b: SLOT },
    };
    expect(withPrompt(twice, "m", "你好")).toBe(null);
  });

  /**
   * **登记项 ③ 已经不存在了（P3d Task 11 消掉的），这一格是它的替代品。**
   *
   * Task 10 在面板侧存着一份 `PROMPT_SLOT_SAMPLE = "ping"` 的副本，靠一格逐字比对
   * 兜着两边不漂。**现在占位文本跟着响应一起来**，面板这一侧不再知道它是哪句话。
   * ⇒ 这一格验的不再是「两个常量相等」，而是**「它真的从数据里取」**：
   * 喂一个真源里根本不存在的占位文本，被测模块照样得换对地方。
   *
   * **变红条件**：把 `withPrompt()` 里那句 `proto.samplePrompt` 换回任何一个字面量
   * （例如写死 `"ping"`）——那一刻这一格立刻红，因为合成夹具里那句话不是 "ping"。
   */
  it("占位文本来自数据，不是内置常量 —— 喂一个真源里没有的占位文本，照样得换对地方", () => {
    // 手写字面量锚（第 6 种假阳性）：真源今天那句话是它，而合成夹具**刻意不是**它。
    expect(SAMPLE_PROMPT, "真源那一侧变了").toBe("ping");
    expect(SLOT, "夹具那句占位文本不许等于真源那句，否则这一格证不了任何事").not.toBe(SAMPLE_PROMPT);

    const p = {
      id: "x", pathTemplate: "/probe/x", samplePrompt: SLOT,
      sampleBody: { model: "m", input: SLOT },
    };
    const body = withPrompt(p, "m9", "你好")!;
    expect(body, "占位文本没从数据里取").not.toBe(null);
    expect(body.input).toBe("你好");

    // 反向：**面板不许还认得真源那个 "ping"**。喂一份「占位文本是 SLOT、
    // 但正文里写着 ping」的样例，它应当判失败（找不到那句占位文本），
    // 而不是自作聪明地把 ping 换掉。
    const stale = {
      id: "x", pathTemplate: "/probe/x", samplePrompt: SLOT,
      sampleBody: { model: "m", input: SAMPLE_PROMPT },
    };
    expect(withPrompt(stale, "m9", "你好"), "面板还认得真源那个占位文本").toBe(null);
  });

  /**
   * **登记项 ④。** 四条协议里三条把模型放请求体、一条放路径。
   * 两头都没有的协议进来时 `withPrompt()` 判失败——**不许退回去发样例里那个模型**：
   * 面板上明明摆着一个模型下拉框，运维会以为自己选的那个生效了。
   *
   * **变红条件**：给真源加一条既没有 `model` 字段、`pathTemplate` 里也没有占位符的协议；
   * 或者把 `withPrompt()` 里那条 `else if (!…includes("{model}")) return null;` 删掉。
   */
  it("每条协议要么把模型放路径里、要么把模型放请求体里 —— 两头都没有就会静默发默认模型", () => {
    for (const p of realProtocols()) {
      const inBody = typeof p.sampleBody.model === "string";
      const inPath = p.pathTemplate.includes("{model}");
      expect(inBody || inPath, `${p.id} 两头都没有模型那一格`).toBe(true);
      // 反向：**不许两头都有**——那样改一个不改另一个就会发出一条自相矛盾的请求。
      expect(inBody && inPath, `${p.id} 两头都有模型那一格`).toBe(false);
    }
    const neither = { id: "x", pathTemplate: "/probe/x", samplePrompt: SLOT, sampleBody: { input: SLOT } };
    expect(withPrompt(neither, "m9", "你好"), "两头都没有还照样交出了请求体").toBe(null);
  });
});

describe("buildRequest：URL 全部由 origin + 真源路径拼出", () => {
  /**
   * **一个硬编码路径都没有。**
   *
   * 判据与 Task 7 的集成示例卡是同一条：喂一份**改过 `pathTemplate` 的**假目录，
   * 断言输出跟着变。写死路径的实现在这一格上会交出真实的那四条路径。
   *
   * **变红条件**：把 `buildRequest()` 里的 `proto.pathTemplate` 换成任何一条字面量路径。
   */
  it("四条协议各构造一次请求，URL 全部由 origin + 真源路径拼出 —— 一个硬编码路径都没有", () => {
    const synthetic = {
      protocols: ["alpha", "beta"].map((id) => ({
        id, label: `${id} proto`, method: "POST",
        pathTemplate: `/probe/${id}/talk`,
        authHeader: "authorization", streamMode: "body", streamKey: "stream",
        streamTextPath: PROBE_TEXT_PATH,
        sampleBody: { model: "m0", input: SLOT },
      })),
      samplePrompt: SLOT,
    };
    const list = playgroundProtocols(synthetic)!;
    const urls = list.map((p) => buildRequest(p, { model: "m9", prompt: "你好", stream: false, origin: ORIGIN })!.url);
    // 期望值手写字面量：假目录给的路径是什么，出来的就必须是什么。
    expect(urls).toEqual([
      "https://gw-probe.invalid/probe/alpha/talk",
      "https://gw-probe.invalid/probe/beta/talk",
    ]);
  });

  it("真实目录跑出来的四条 URL 逐条手写钉死 —— 面板承诺的就是这四条地址", () => {
    const urls = realProtocols().map(
      (p) => buildRequest(p, { model: "agnes-2.0-flash", prompt: "你好", stream: false, origin: ORIGIN })!.url,
    );
    expect(urls).toEqual([
      "https://gw-probe.invalid/v1/chat/completions",
      "https://gw-probe.invalid/v1/messages",
      "https://gw-probe.invalid/v1/responses",
      "https://gw-probe.invalid/v1beta/models/agnes-2.0-flash:generateContent",
    ]);
  });

  /**
   * **登记项 ① 的钉子。** `{model}` 这个占位符是本模块自己认识的第二份知识，
   * 真源那边 `endpointFor()` 做的是同一件事。真源哪天换了占位符写法（比如换成
   * `:model` 或 `%MODEL%`），这一格当场红——否则面板会照着一条**带着未展开占位符**的
   * 地址发请求，而那条地址一定 404。
   *
   * 形态照抄 `tests/ui/examples.test.ts` 的
   * 「真实目录跑出来的 12 段里，没有一段还留着未展开的模型占位符」（集成示例卡那一侧）。
   */
  it("真实目录跑出来的四条 URL 里没有一条还留着未展开的模型占位符", () => {
    for (const p of realProtocols()) {
      const req = buildRequest(p, { model: "agnes-2.0-flash", prompt: "你好", stream: false, origin: ORIGIN });
      expect(req, `${p.id} 构造不出来`).not.toBe(null);
      expect(req!.url, `${p.id} 的 URL 里还留着未展开的占位符：${req!.url}`).not.toContain("{");
      expect(req!.url).not.toContain("}");
    }
  });

  /**
   * **请求头的名字只来自目录，四条各不相同。**
   * 写死任何一个的后果是：那条协议要么根本认不出这把口令（401），要么把口令送进了
   * 一个网关不查的头里——而后者更阴，它看起来像「口令错了」。
   *
   * ⚠️ **`buildRequest()` 只交出头的名字、不交出值**（`js/pure/playground.mjs` 文件头
   * 那段 ⚠️⚠️）：口令因此进不了任何一个被渲染出来的对象。这一格顺带钉住这条结构。
   */
  it("请求头的名字逐条来自目录，且 buildRequest 的返回值里一个凭据字节都没有", () => {
    const reqs = realProtocols().map(
      (p) => buildRequest(p, { model: "agnes-2.0-flash", prompt: "你好", stream: false, origin: ORIGIN }),
    );
    expect(reqs.map((r) => r!.headerName)).toEqual([
      "authorization", "x-api-key", "authorization", "x-goog-api-key",
    ]);
    // 返回值的键集合手写钉死：多一个 `headerValue` / `token` 之类的字段，这一格当场红。
    for (const r of reqs) {
      expect(Object.keys(r!).sort(), "buildRequest 的返回值里多了一格").toEqual(
        ["body", "headerName", "method", "url"],
      );
    }
  });

  /**
   * **Gemini 换路径，其余三条换请求体字段。**
   * 换错了的后果是**静默降级成非流式**：请求照样 200、内容照样对，只是一次性全回来了，
   * 而面板上没有任何东西会提到这件事。
   *
   * **变红条件**：把 `buildRequest()` 里的 `mode === "path"` 改成 `mode === "body"`（或反过来）。
   */
  it("Gemini 开流式换的是路径，其余三条换的是请求体字段 —— 换错了流式会静默降级成非流式", () => {
    const [openai, anthropic, responses, gemini] = realProtocols();
    const opts = { model: "agnes-2.0-flash", prompt: "你好", stream: true, origin: ORIGIN };

    for (const p of [openai!, anthropic!, responses!]) {
      const streamed = buildRequest(p, opts)!;
      const plain = buildRequest(p, { ...opts, stream: false })!;
      expect(streamed.url, `${p.id} 开流式时不该换路径`).toBe(plain.url);
      expect(streamed.body.stream, `${p.id} 开流式时请求体里没有那个字段`).toBe(true);
      expect(plain.body.stream, `${p.id} 不开流式时请求体里凭空多了那个字段`).toBe(undefined);
    }

    const g = buildRequest(gemini!, opts)!;
    // 期望值手写字面量。
    expect(g.url).toBe("https://gw-probe.invalid/v1beta/models/agnes-2.0-flash:streamGenerateContent");
    expect(g.body.stream, "往 Gemini 的请求体里塞了一个它不认的流式字段").toBe(undefined);
  });

  /**
   * **表外的 `streamMode` 在要开流式时判失败，而不是「当成 body 那一档」。**
   * 猜错的代价正是上面那句静默降级。**非流式不受影响**——它压根不看这个字段。
   *
   * **变红条件**：把那条 `if (stream && mode !== "path" && mode !== "body") return null;` 删掉。
   */
  it("streamMode 是个没见过的值时：非流式照常构造，开流式则拒绝 —— 猜一个默认档就是静默降级", () => {
    const odd = {
      id: "x", label: "X", method: "POST", pathTemplate: "/probe/x",
      authHeader: "authorization", streamMode: "sse-v2", streamKey: "flow",
      streamTextPath: PROBE_TEXT_PATH,
      sampleBody: { model: "m0", input: SLOT },
    };
    const list = playgroundProtocols({ protocols: [odd], samplePrompt: SLOT })!;
    expect(list.length, "前置条件：窄化不许因为表外形态整份判失败").toBe(1);
    expect(buildRequest(list[0], { model: "m9", prompt: "你好", stream: false, origin: ORIGIN }))
      .not.toBe(null);
    expect(buildRequest(list[0], { model: "m9", prompt: "你好", stream: true, origin: ORIGIN }))
      .toBe(null);
  });

  /**
   * **拦「没填口令」的活不归纯函数。**
   * 把它塞进来的话，「没填口令」会和「构造不出请求」一起变成同一个 `null`，
   * 而这两件事在 UI 上必须分得开：前者要提示「先粘贴口令」，后者是版本对不上。
   */
  it("网关口令为空时 buildRequest 照常构造 —— 把拦截放进纯函数会让『没填口令』与『口令错』在 UI 上分不开", () => {
    const p = realProtocols()[0]!;
    // 本函数的入参里**根本没有口令这一格**，这就是最强的那条保证。
    const req = buildRequest(p, { model: "agnes-2.0-flash", prompt: "你好", stream: false, origin: ORIGIN });
    expect(req).not.toBe(null);
    expect(req!.url).toBe("https://gw-probe.invalid/v1/chat/completions");
  });
});

describe("鉴权头的值：Bearer 前缀这一件事只许有一份", () => {
  /**
   * **登记项 ②。** `authorization` 要带 `Bearer ` 前缀这条判据在本仓有两份：
   * `js/pure/examples.mjs`（示例卡渲染出来给运维照抄的那份）与
   * `js/pure/playground.mjs`（面板真发出去的那份）。
   * 两处一漂，**示例卡教的调法与面板实际发出去的那次就不是同一件事了**——
   * 而运维会拿着示例卡去排查一个面板自己造出来的 401。
   *
   * 判据不是「两个函数的源码长得一样」（那是形状断言），
   * 而是**把同一条协议同时喂给两边，比它们各自产出的那个头值**。
   *
   * **变红条件**：把任一侧的 `Bearer ` 去掉、改大小写、或去掉那个空格。
   */
  it("Bearer 前缀这条判据与集成示例卡逐字一致 —— 两处一漂，示例教的就不是面板发的", () => {
    for (const p of realProtocols()) {
      const mine = authHeaderValue(p.authHeader, KEY_PLACEHOLDER);
      // 示例卡那一侧：curl 那一段里逐字写着 `-H '<头名>: <头值>'`。
      const curl = exampleFor(p, ORIGIN, "curl", "agnes-2.0-flash");
      expect(curl, `${p.id} 的示例里找不到这个头`).toContain(`-H '${p.authHeader}: ${mine}'`);
    }
    // 前置条件：两条分支必须真的产出**不同**的值，否则「一致」在任何实现下都成立
    // （第 1 种假阳性：夹具 A/B 同值时谁赢都通过）。
    expect(authHeaderValue("authorization", "T0KEN")).toBe("Bearer T0KEN");
    expect(authHeaderValue("x-api-key", "T0KEN")).toBe("T0KEN");
    expect(authHeaderValue("x-goog-api-key", "T0KEN")).toBe("T0KEN");
  });
});

describe("网关口令与设置页 hint 的即时校验", () => {
  /** 四个档位名，**手写闭集**。返回值只许从这里面取。 */
  const STATES = ["empty", "unknown", "match", "mismatch"];

  it("四档各自成立，且「比不了」绝不折叠进「对不上」 —— 后者会让运维去改一把其实没错的口令", () => {
    expect(tokenHintState("", "wxyz")).toBe("empty");
    expect(tokenHintState("abc-wxyz", null)).toBe("unknown");
    expect(tokenHintState("abc-wxyz", "")).toBe("unknown");
    expect(tokenHintState("abc-wxyz", "wxyz")).toBe("match");
    expect(tokenHintState("abc-nope", "wxyz")).toBe("mismatch");
    // 口令比 hint 还短：末几位对不上，**不是「比不了」**。
    expect(tokenHintState("yz", "wxyz")).toBe("mismatch");
  });

  it("末几位取几位由 hint 自己的长度决定，不写死 4 —— 写死就是又抄了一次后端那条规则", () => {
    // 后端 `hintOf()` 今天取末 4 位，但判据不许建在这个数字上。
    expect(tokenHintState("token-abcdef", "cdef")).toBe("match");
    expect(tokenHintState("token-abcdef", "abcdef")).toBe("match");
    expect(tokenHintState("token-abcdef", "ef")).toBe("match");
    expect(tokenHintState("token-abcdef", "bcde")).toBe("mismatch");
  });

  /**
   * **返回值会被渲染到屏幕上**，所以它一个口令字节都不许带（全局约束 11(b)）。
   * 把「你粘的是 …abcd，配置里是 …wxyz」这种话画出去，等于面板自己给出了一条
   * 口令末位的旁路。
   *
   * **变红条件**：把 `tokenHintState()` 改成返回 `` `mismatch:${tk.slice(-4)}` `` 之类。
   */
  it("hint 校验的返回值里不含口令的任何片段 —— 它会被渲染出来", () => {
    const token = "SUPER-SECRET-GATEWAY-TOKEN-7Q2X";
    for (const hint of [null, "", "7Q2X", "ZZZZ"]) {
      const state = tokenHintState(token, hint);
      expect(STATES, `返回了一个闭集之外的值：${state}`).toContain(state);
      // 逐段扫：口令里任何一段长度 >= 2 的子串都不许出现在返回值里。
      for (let i = 0; i + 2 <= token.length; i++) {
        expect(state, `返回值里带上了口令的片段：${token.slice(i, i + 2)}`)
          .not.toContain(token.slice(i, i + 2));
      }
    }
  });
});

describe("响应体的可读形态", () => {
  it("读得出来时是缩进过的 JSON 原文，读不出来时是 null —— 空串会与「空响应」长得一样", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyJson(null)).toBe("null");
    // `JSON.stringify(undefined)` 交出的是 `undefined`，不是字符串 ⇒ 归到「读不出来」。
    expect(prettyJson(undefined)).toBe(null);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(prettyJson(circular), "循环引用会抛，抛出去就把整块渲染打断了").toBe(null);
  });
});

/**
 * **P3d Task 11：SSE 帧切分。**
 *
 * ⚠️⚠️ **这一段的正确性在本机的假上游下几乎不可能自己暴露。** 假上游一次 `write`
 * 就是一块，一条 `data:` 行永远不会被切开；而在真实网络上（MTU、TLS record、
 * 反代的缓冲刷新点）它必然会被切开。⇒ **必须有一格故意把一条 data 行拆在两个
 * chunk 中间**，否则「按 chunk 边界切」这个写法在本仓所有测试下都是绿的。
 */
describe("SSE 帧切分：跨 chunk 的那条 data 行", () => {
  /**
   * **防住的真实故障**：把 `\n\n` 分帧写成「每个 chunk 各自 split」。
   * 症状是生产上**偶发地丢字 / 冒出半行 JSON**，本机永远复现不了。
   *
   * **变红条件**：把 `sseFrames()` 改成不返回 `rest`（每次从空缓冲开始切）。
   */
  it("一条 data 行被拆在两个 chunk 里仍被正确重组 —— 按 chunk 边界切的话生产上会偶发丢字", () => {
    const whole = 'data: {"say":"完整的一句话"}\n\n';
    // 切点故意落在 JSON 中间（第 18 个字符），两半各自都不是合法的一帧。
    const first = whole.slice(0, 18);
    const second = whole.slice(18);
    expect(first, "前置条件：前半段不许自己就构成一帧").not.toContain("\n\n");

    // 第一次：只喂前半段 —— **一帧都不许交出来**，全部留在 `rest` 里。
    const a = sseFrames(first);
    expect(a.payloads, "半条 data 行被当成一帧交出去了").toEqual([]);
    expect(a.rest).toBe(first);

    // 第二次：把 `rest` 与后半段接上再喂 —— 这时候才该交出完整的那一条。
    const b = sseFrames(a.rest + second);
    expect(b.payloads).toEqual(['{"say":"完整的一句话"}']);
    expect(b.rest, "凑齐之后缓冲区没被清空，下一轮会重复交出同一条").toBe("");
  });

  it("一个 chunk 里有好几帧时全部交出来，顺序不变 —— 掉一帧就是掉一段回答", () => {
    const { payloads, rest, done } = sseFrames('data: {"i":1}\n\ndata: {"i":2}\n\ndata: {"i":3}\n\n');
    expect(payloads).toEqual(['{"i":1}', '{"i":2}', '{"i":3}']);
    expect(rest).toBe("");
    expect(done, "没有 [DONE] 却报了 done").toBe(false);
  });

  it("event: 行与 [DONE] 各归各位 —— 把 event 行当成正文会让协议内部的词进对话框", () => {
    // 真实字节：网关对 anthropic / responses 两条协议发的正是这个形状
    //（`event: X` 与 `data: {...}` 同处一帧）。
    const wire = 'event: content_block_delta\ndata: {"x":1}\n\ndata: [DONE]\n\n';
    const { payloads, done } = sseFrames(wire);
    expect(payloads, "event: 那一行不许被当成负载").toEqual(['{"x":1}']);
    expect(done).toBe(true);
  });

  it("非字符串入参当空缓冲处理，绝不抛 —— 一次坏读不该让整条流断掉", () => {
    expect(sseFrames(null)).toEqual({ payloads: [], rest: "", done: false });
    expect(sseFrames(undefined)).toEqual({ payloads: [], rest: "", done: false });
  });
});

/**
 * ── **P3d 全分支评审 F-1：两份 SSE 帧解析在 `[DONE]` 上到底对不对齐** ─────────────
 *
 * `js/pure/playground.mjs` 的 `sseFrames()` 文件头一直写着「两份实现共享同一套判据
 *（`data:` 前缀、`\n\n` 分帧、**`[DONE]` 终止**），是刻意对齐的」，而 Task 11 登记的
 * 遗留是「**没有任何机器绑住这个对齐**」——**登记的是「没有机器绑住」，没有人去核过
 * 它们今天到底对不对齐**。全分支评审核了：`[DONE]` 之后那一帧，网关丢掉、面板照收。
 *
 * ⚠️⚠️ **这一格 import 的是两份真实现，不是把判据抄一份过来对**（第 7 种假阳性）：
 * `sseFrames` 来自 `admin-ui/js/pure/playground.mjs`，`parseSseStream` 来自
 * `src/core/protocol/sse.ts`。**抄件对齐证明不了原件对齐**，而这一整格要守的
 * 恰恰是原件之间的那条等式。
 *
 * ⚠️ **它守的是「同一串负载」，不是「同一份实现」**：两边的形状本来就不同
 *（一个是同步切缓冲、一个是异步读流），能对账的只有「同一段字节喂进去，
 * 交出来的负载序列逐字相等」。
 *
 * **变红条件（都实测过）**：把 `sseFrames()` 里那句 `return { payloads, rest: "", done: true }`
 * 改回 `{ done = true; continue; }` ⇒ 第 3、4 条样本当场红
 *（面板多交出 `[DONE]` 之后那一条）。
 */
describe("两份 SSE 帧解析在 [DONE] 上逐字对齐", () => {
  /** 网关那一份：把一段完整字节喂给 `parseSseStream()`，收集它 yield 出来的负载。 */
  async function gatewayPayloads(wire: string): Promise<string[]> {
    const bytes = new TextEncoder().encode(wire);
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes); c.close(); },
    });
    const out: string[] = [];
    for await (const p of parseSseStream(body)) out.push(p);
    return out;
  }

  /**
   * 面板那一份：把整段字节**一次**喂给 `sseFrames()`，再照 `js/gw-api.js` 的
   * `streamFromGateway()` 收尾那一句把 `rest` 当最后一帧再切一次。
   *
   * ⚠️⚠️ **上一版这里写的是「逐字照抄 `streamFromGateway()` 那个循环（含 break 之后
   * 那句尾巴处理）」——措辞过头，复评点名**：下面这段**没有循环、也没有 break**，
   * 它是一次单块归约。⇒ **「一帧被拆在两个 chunk 里送达」那一族不由这一组覆盖**，
   * 它由 `tests/ui/gw-api.test.ts` 的「一条 data 行被真的拆在两个 chunk 里送达」钉着
   *（那一格走的是真的 `ReadableStream` 多块吐法）。
   * ⚠️ 覆盖缺口有限，如实说清：复评实测**跨 chunk 到达时 `[DONE]` 那条分叉修前修后
   * 本来就无差别**（`found.done` 为真 ⇒ `streamFromGateway()` 当场 break，
   * 第二块根本没被读），所以这一组要守的那条等式落在单块那一档上是够的。
   * ⚠️ 少了最后那一句尾巴处理的话，这一格会漏掉一条真实的收法：
   * `sseFrames()` 就算在 `[DONE]` 处收了尾，调用方那一句仍会拿 `rest` 再切一次
   * ——`rest` 交不空的话，`[DONE]` 之后那一帧会从**那里**被捡回来。
   */
  function panelPayloads(wire: string): string[] {
    const out: string[] = [];
    let buf = wire;
    const found = sseFrames(buf);
    buf = found.rest;
    for (const p of found.payloads) out.push(p);
    // ⚠️ **`found.done` 为真时 `streamFromGateway()` 只是 break，这一句照样跑。**
    //    所以这里也无条件跑——只跑「没 done」那一半的话，这一格就守不住
    //    「`rest` 必须交空」那一半，而那正是 F-1 能从后门被捡回来的路径。
    for (const p of sseFrames(`${buf}\n\n`).payloads) out.push(p);
    return out;
  }

  it.each([
    // ── 反向控制：没有 `[DONE]` 的那几种形态，两边本来就该给同一串（少了它，
    //    「两边都恒返回空」也能让下面几格全绿）。
    ['data: {"a":1}\n\ndata: {"b":2}\n\n', ['{"a":1}', '{"b":2}'], "没有 [DONE]：两条都收"],
    ['event: x\ndata: {"a":1}\n\n', ['{"a":1}'], "event: 行不是负载，两边都不收"],
    // ── F-1 那一条：`[DONE]` 之后还有一帧带正文的 data。
    [
      'data: {"a":1}\n\ndata: [DONE]\n\ndata: {"post":"DONE"}\n\n',
      ['{"a":1}'],
      "[DONE] 之后那一帧：网关丢掉，面板从此也丢掉（F-1 修前面板会多收一条）",
    ],
    // ── 同一帧里 `[DONE]` 之后还有 data 行（`\n\n` 还没到）。
    [
      'data: {"a":1}\n\ndata: [DONE]\ndata: {"same":"frame"}\n\n',
      ['{"a":1}'],
      "同一帧里 [DONE] 之后的 data 行同样不收 —— 网关那份是 return，不是 continue",
    ],
    // ── `[DONE]` 就是第一帧：两边都一条不收。
    ['data: [DONE]\n\ndata: {"a":1}\n\n', [], "[DONE] 打头：其后整段一律不收"],
  ])("同一段字节喂进去必须给出同一串负载：%s", async (wire, expected) => {
    const gw = await gatewayPayloads(wire as string);
    const pg = panelPayloads(wire as string);
    // 期望值手写字面量（第 6 种假阳性：不许拿一边的输出当另一边的期望）。
    expect(gw, "网关那份变了").toEqual(expected as string[]);
    expect(pg, "面板那份变了 —— 两份实现又分叉了").toEqual(expected as string[]);
  });
});

/**
 * **P3d Task 11：正文在哪一格 —— 这份知识来自协议目录，不在本模块里。**
 *
 * ⚠️ **样本全部来自真源 + 本仓协议转换模块真正吐出去的形状**，不是另编一份：
 * 另编的那份与网关真吐的字节可能不一样，而那正是第 7 种假阳性。
 * 「这四行确实等于网关真吐出去的字节」由 `tests/contract/stream-parity.test.ts` 的
 * 「一条真的流式请求，按 streamTextPath 逐块取出来的正是上游那三个字」跑真 app 钉着
 *（那边的观测点在真实 SSE 字节上）；这边验的是**取值函数本身**。
 */
describe("deltaText：三态（读不出来 / 不带正文 / 正文）", () => {
  /** 四条协议各一条真实增量行。**逐条手写字面量**，不从任何地方推导。 */
  const REAL_DELTA_LINE: Record<string, string> = {
    openai: '{"id":"c1","choices":[{"delta":{"content":"a"}}]}',
    anthropic: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}',
    responses: '{"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"a"}',
    gemini: '{"candidates":[{"content":{"role":"model","parts":[{"text":"a"}]},"index":0}],"modelVersion":"agnes-2.0-flash"}',
  };

  /**
   * **防住的真实故障**：取错格 ⇒ **对话框永远是空的**。请求 200、字节也一块块到了，
   * 只是每一块都取不出正文，而面板上没有任何东西会提到这件事。
   *
   * **变红条件**：把真源里任意一条 `streamTextPath` 改一格
   * （例如 anthropic 那条改成 `["delta","content"]`）。
   */
  it("四条协议各喂一条真实的增量行，各自取出 'a' —— 取错字段的话对话框永远是空的", () => {
    for (const p of realProtocols()) {
      const line = REAL_DELTA_LINE[p.id];
      expect(line, `${p.id} 没有对应的真实样本，这一格会空转`).toBeTypeOf("string");
      expect(deltaText(p, line), `${p.id} 的正文没取出来`).toBe("a");
    }
    // 四条都覆盖到了（手写字面量，不是 `realProtocols().length`）。
    expect(Object.keys(REAL_DELTA_LINE).length).toBe(4);
  });

  /**
   * **「这一行不带正文」不是畸形。** 四条协议的流里都夹着纯事件行，
   * 把它们数进 `malformed` 的话那个计数就等于事件数、彻底没有信息。
   *
   * **变红条件**：把 `deltaText()` 里最后那句 `typeof node === "string" ? node : ""`
   * 改成返回 `null`（即把「走到了但不是字符串」也算成读不出来）。
   */
  it("读得出来但不带正文的事件行返回空串，不是 null —— 把它算成畸形会让那个计数彻底没有信息", () => {
    const [openai, anthropic, responses, gemini] = realProtocols();
    // 真实字节，逐条手写：这些行在每一条真实的流里都出现。
    expect(deltaText(anthropic, '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}'))
      .toBe("");
    expect(deltaText(anthropic, '{"type":"message_stop"}')).toBe("");
    expect(deltaText(responses, '{"type":"response.completed","response":{"id":"resp_1","status":"completed"}}'))
      .toBe("");
    expect(deltaText(openai, '{"id":"c1","choices":[{"delta":{"role":"assistant"}}]}')).toBe("");
    expect(deltaText(gemini, '{"modelVersion":"agnes-2.0-flash"}')).toBe("");
  });

  /**
   * **防住的真实故障**：一块读不出来的数据让整轮对话中断——运维正盯着的那半句话
   * 会当场消失，而面板上只剩一个 transport 错误，看不出是「上游断了」还是
   * 「有一块读不动」。
   *
   * **变红条件**：把 `deltaText()` 里那个 `try/catch` 去掉（让 `JSON.parse` 直接抛）。
   */
  it("畸形增量行返回 null 且绝不抛 —— 一块坏数据不该让整个对话中断，但也不许静默丢", () => {
    const p = realProtocols()[0]!;
    for (const bad of ["{不是 JSON", "", "undefined", '{"choices":[', "[1,2,3"]) {
      expect(deltaText(p, bad), `畸形行 ${JSON.stringify(bad)} 没被判成读不出来`).toBe(null);
    }
    // 反向：**合法 JSON 但结构不对**是「不带正文」，不是「读不出来」——
    // 这两档折叠在一起就等于「每一条正常事件行都被数成畸形」。
    expect(deltaText(p, '{"choices":[]}')).toBe("");
    expect(deltaText(p, "[1,2,3]")).toBe("");
  });

  /**
   * **数组那一段只认非负整数下标。** `Number("")` 会给 0、`Number("1x")` 会给 NaN，
   * 两者都得挡掉——否则一条写错的路径会**静默地取到第 0 项**，看起来完全正常。
   *
   * **变红条件**：把 `deltaText()` 里那个 `/^[0-9]+$/` 的判据换成 `Number(seg)`。
   */
  it("数组下标只认十进制整数 —— 裸 Number() 会把 \" 1\" / \"0x2\" / \"1e0\" 静默解析成别的下标", () => {
    const line = '{"out":[{"say":"甲"},{"say":"乙"},{"say":"丙"}]}';
    // 正向：正经的十进制下标照常走。
    expect(deltaText({ streamTextPath: ["out", "0", "say"] }, line)).toBe("甲");
    expect(deltaText({ streamTextPath: ["out", "1", "say"] }, line)).toBe("乙");
    expect(deltaText({ streamTextPath: ["out", "9", "say"] }, line), "越界下标没被挡住").toBe("");

    /**
     * ⚠️⚠️ **这一组输入是变异实测挑出来的，不是想出来的（M13 第一版 ESCAPED）。**
     *
     * 第一版只喂了 `"x"`：`Number("x")` 是 `NaN`，而 `NaN < 0` 与 `NaN >= len` **都是 false**，
     * 于是它落到 `node[NaN]` = `undefined`，**与正则挡下来的结果一模一样** ⇒
     * 把判据换成裸 `Number(seg)` 这一格照样全绿（第 5 种假阳性：**覆盖的状态让两种实现
     * 在数学上等价**）。
     *
     * 下面这四个才真的把两种实现分开——每一个在裸 `Number()` 下都会**静默取到另一项**：
     * `" 1"`→1、`"0x2"`→2、`"1e0"`→1、`""`→0。**后果是面板从一条流里读出别人的那半句话。**
     */
    for (const [seg, whatNumberWouldGive] of [[" 1", "乙"], ["0x2", "丙"], ["1e0", "乙"], ["", "甲"]] as const) {
      expect(
        deltaText({ streamTextPath: ["out", seg, "say"] }, line),
        `下标 ${JSON.stringify(seg)} 被静默解析成了一个真下标（裸 Number() 会给 ${whatNumberWouldGive}）`,
      ).toBe("");
    }
  });

  it("协议本身没有那一格时返回 null —— 「我不知道去哪儿取」不是「这一行没有正文」", () => {
    expect(deltaText({}, '{"a":1}')).toBe(null);
    expect(deltaText(null, '{"a":1}')).toBe(null);
    expect(deltaText({ streamTextPath: [] }, '{"a":1}')).toBe(null);
  });
});
