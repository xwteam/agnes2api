import { describe, it, expect } from "vitest";
import { MODELS } from "../../../src/core/protocol/openai.js";
import {
  PROTOCOLS, MODEL_CATALOG, protocolById, endpointFor, catalogPayload, SAMPLE_PROMPT,
  MEDIA_ENDPOINTS,
} from "../../../src/core/admin/protocol-catalog.js";

describe("协议目录", () => {
  it("模型 id 与 /v1/models 的来源逐条一致 —— 面板不许承诺一个网关不认的 id", () => {
    // 变红条件：给 MODEL_CATALOG 加一条 MODELS 里没有的 id，或删掉一条
    expect(MODEL_CATALOG.map((m) => m.id)).toEqual([...MODELS]);
  });

  it("四条协议 id 互不重复且恰好四条 —— 少一条就是某个消费者会静默漏掉一个协议", () => {
    // 期望值手写字面量，不写 PROTOCOLS.length（第 6 种假阳性）
    expect(PROTOCOLS.map((p) => p.id).sort()).toEqual(["anthropic", "gemini", "openai", "responses"]);
  });

  it("Gemini 的流式换的是路径不是请求体字段 —— 换错了流式请求会静默返回非流式结果", () => {
    const g = protocolById("gemini")!;
    expect(endpointFor(g, "agnes-2.0-flash", false))
      .toBe("/v1beta/models/agnes-2.0-flash:generateContent");
    expect(endpointFor(g, "agnes-2.0-flash", true))
      .toBe("/v1beta/models/agnes-2.0-flash:streamGenerateContent");
    // 另外三条协议换的是请求体字段，路径不随 stream 变
    const o = protocolById("openai")!;
    expect(endpointFor(o, "agnes-2.0-flash", true)).toBe("/v1/chat/completions");
  });

  it("过网络那一份不含函数 —— sample 是函数，JSON.stringify 会把它整个丢掉", () => {
    // 变红条件：catalogPayload 改成直接返回 PROTOCOLS
    const payload = JSON.parse(JSON.stringify(catalogPayload()));
    for (const p of payload.protocols) {
      expect(p.sample).toBeUndefined();
      expect(typeof p.sampleBody).toBe("object");
    }
  });

  // ── `"ping"` 不许是散在四处的魔法字符串 ─────────────────────────────────
  it("每条 sample() 的 JSON 里 SAMPLE_PROMPT 恰好出现一次 —— "
     + "Playground 靠替换它来注入用户输入，改掉它会让那条协议静默丢弃用户输入", () => {
    // 变红条件：把 responses 那条的 `input: SAMPLE_PROMPT` 改回字面量 "pong"
    expect(SAMPLE_PROMPT).toBe("ping");            // 手写字面量锚（第 6 种假阳性）
    for (const p of PROTOCOLS) {
      const json = JSON.stringify(p.sample("agnes-2.0-flash"));
      expect(json.split(SAMPLE_PROMPT).length - 1, `${p.id} 的样例文本`).toBe(1);
    }
  });

  // ── 评审 Minor 2：authHeader / usagePath 被归为"机器事实"却零覆盖 ────────
  it("四条协议的鉴权头恰好是这四个 —— 网关四种都收，但示例里写错一条就教错了用法", () => {
    // 变红条件：把 gemini 的 authHeader 改成 "authorization"
    // 期望值逐条手写，不从 PROTOCOLS 推
    expect(PROTOCOLS.map((p) => [p.id, p.authHeader])).toEqual([
      ["openai", "authorization"],
      ["anthropic", "x-api-key"],
      ["responses", "authorization"],
      ["gemini", "x-goog-api-key"],
    ]);
  });

  it("只有 openai 那条的 usagePath 是 null —— 它是四条里唯一不传 expectJson 的（订正）", () => {
    // 变红条件：给 openai 填上 usagePath: ["usage"]
    expect(PROTOCOLS.filter((p) => p.usagePath === null).map((p) => p.id)).toEqual(["openai"]);
  });

  it("upstreamPath 四条都是 /chat/completions，且与对外路径不是同一个东西（评审发现）", () => {
    // 变红条件：把任一条 upstreamPath 写成它自己的 pathTemplate
    expect(PROTOCOLS.map((p) => p.upstreamPath)).toEqual([
      "/chat/completions", "/chat/completions", "/chat/completions", "/chat/completions",
    ]);
    // ⚠️ 这一格只钉住"值是什么"。**"它真的是网关发出去的那一条"由契约用例钉**，
    // 见 tests/contract/protocol-catalog.test.ts
    // 「出站 URL 逐字等于 agnesBaseUrl + upstreamPath」——比对本文件自己的两个字段是同义反复。
    for (const p of PROTOCOLS) expect(p.upstreamPath).not.toBe(p.pathTemplate);
  });

  /**
   * `modality` 与 `protocols` 是模型表那个消费者唯一要读的两个字段，
   * 而上面那格只比对 id、Step 5 的契约用例只比对 `endpoints`
   * ⇒ **这两个字段原本一格都没有**：把 `agnes-video-v2.0` 的 `modality` 写成 `"chat"`
   * 或给某个图片模型填上四条对话协议，模型表就会请用户去 `/v1/chat/completions`
   * 调一个只有两段式视频接口的模型，而全套用例照绿。
   *
   * 期望值逐条手写字面量，不从 `MODEL_CATALOG` 或 `CHAT_PROTOCOLS` 推（第 6 种假阳性）。
   */
  it("每个模型的形态与可用协议逐条手写钉死 —— 媒体模型一条对话协议都不该有", () => {
    expect(MODEL_CATALOG.map((m) => [m.id, m.modality, [...m.protocols]])).toEqual([
      ["agnes-2.0-flash", "chat", ["openai", "anthropic", "responses", "gemini"]],
      ["agnes-image-2.1-flash", "image", []],
      ["agnes-image-2.0-flash", "image", []],
      ["agnes-video-v2.0", "video", []],
    ]);
  });

  /**
   * ── 评审 Important 1：**真源自己内部有一处「做两遍必漂」** ────────────────────
   *
   * `MODEL_CATALOG[].endpoints` 与 `PROTOCOLS[].pathTemplate` 是**同一份知识在同一个
   * 文件里的两份拷贝**，而在这一格出现之前**没有任何东西绑住它们**。三条变异实测全逃：
   * · 删掉 `agnes-2.0-flash` 的 `{ method:"POST", path:"/v1/messages" }` ⇒ 2130 全绿；
   * · 把那条 `generateContent` 的模型名改成 `totally-bogus-model` ⇒ 2130 全绿；
   * · 删掉 `agnes-video-v2.0` 的 `GET /v1/videos/:id` ⇒ 2130 全绿。
   *
   * 成因两条，都在契约那一侧：`tests/contract/protocol-catalog.test.ts`
   * 「模型目录里的媒体端点同样是真路由」把带 `generateContent` 的条目整条跳过，
   * 而 `toContain` 只抓**新增**、抓不到**删除**（少一条只是少循环一次）。
   * ⇒ 后果正是那条订正「做两遍必漂，而漂了没人会发现」的原形态，**而且漂在真源自己身上**：
   * 模型表可以静默少告诉用户一条协议入口、或指向一个网关不认的模型名。
   *
   * **这一格是关系断言不是同义反复**，两个输入各自被独立锚死。
   * ⚠️ **锚在哪儿，四条协议不是同一个答案——我原来写成同一个，那两句对 gemini 是假的**
   *（评审 HIGH 2，逐条实测订正）：
   *
   * · **`m.id` 那一端** —— 由上面「模型 id 与 /v1/models 的来源逐条一致」拿 `MODELS` 钉着。
   * · **`pathTemplate` 那一端，分两种：**
   *   - **openai / anthropic / responses（静态路径）** —— 由
   *     `tests/contract/protocol-catalog.test.ts`
   *     「每条协议端点都在 app 上真的注册着」拿 `app.routes` **逐字比对**钉着，改一个字符就红。
   *   - **gemini（通配路径）** —— **那一格钉不住它**：它的注册路径是
   *     `/v1beta/models/:rest{.+}`，那格对 `streamMode === "path"` 走的是**常量分支**
   *     （断言字面量 `"POST /v1beta/models/:rest{.+}"`），**从头到尾不读 `p.pathTemplate`**。
   *     实测：只把 gemini 的 `pathTemplate` 改一个字符（`models`→`modelZ`），
   *     **被点名的那格照绿**；红的是本格 + 单测「Gemini 的流式换的是路径不是请求体字段」
   *     + 契约「gemini 的 sample() 经真 app 发出去拿到 200」。
   *     ⇒ **gemini 的 `pathTemplate` 真正的锚是后两格**：前者手写字面量、后者真发一次请求。
   *
   * ⇒ 「两端同时改成一致的错值」也逃不掉，但**杀它的不是我原来点名的那两格**：
   * 实测两端一致改错（`pathTemplate` + 本目录的 endpoints 一起改），
   * 那两格**全绿**，红的是「Gemini 的流式换的是路径不是请求体字段」与
   * 契约「gemini 的 sample() 经真 app 发出去拿到 200」。
   *
   * ⚠️ **给下一个重构的人：别把「Gemini 的流式换的是路径不是请求体字段」那格的期望值
   * 改成从 `pathTemplate` 推导。** 那看着像消重，实际是拆掉 gemini 这一端**两个锚里的一个**。
   *
   * **拆掉之后到底会怎样，是实测的，不是推的**（评审 HIGH 订正；我原来写的
   * 「本格当场退化成真正的同义反复，而全树照绿」**两半都是假的**）：
   * · 拆掉它，gemini 的 `pathTemplate` 就只剩契约「gemini 的 sample() 经真 app 发出去拿到 200」
   *   这**一个独立**锚（本格仍在，但它比的是 `endpoints` 对 `pathTemplate` 的派生值
   *   ⇒ 两端一致改错时它绿）。**「全树照绿」与上面那句「真正的锚是后两格」自相矛盾**
   *   ——同一段注释里前三行刚说完是两个锚，**拆掉前者，后者当然还在**；
   * · 实测（真做了那个 de-dup 改动）：只改 `pathTemplate` ⇒ **2 红**
   *   （契约那格 + **本格**）；两端一致改错 ⇒ **仍 1 红**，
   *   `AssertionError: expected 404 to be 200`（模板错了，真发那一次请求打到了一条不存在的路由）。
   * · **归因也错了**：本格比的是 `MODEL_CATALOG[].endpoints`
   *   （`src/core/admin/protocol-catalog.ts:172` 的手写字面量）对 `PROTOCOLS` 的推导值，
   *   **它自己那一端本来就是独立的手写锚** ⇒ 本格不会因为别处 de-dup 而退化，
   *   而且**在 de-dup 前后行为完全一致**（两端一致改错时它都是绿的）。
   *
   * ⇒ **本格对 gemini 的真实能力，一句话**：抓得住**单端**改动（`pathTemplate` 与
   * `endpoints` 只改一个），抓不住**两端一致**改动——后者归契约那格。
   */
  it("对话模型的 endpoints 与 PROTOCOLS 逐条一致 —— "
     + "endpoints 是 pathTemplate 在真源内的第二份拷贝，没东西绑住就必漂", () => {
    const chat = MODEL_CATALOG.filter((m) => m.modality === "chat");
    // 手写字面量锚：今天只有一个对话模型。多一个而没人在这里表态，这一格先红。
    expect(chat.map((m) => m.id)).toEqual(["agnes-2.0-flash"]);
    for (const m of chat) {
      expect(m.endpoints.map((e) => `${e.method} ${e.path}`), `${m.id} 的 endpoints`).toEqual(
        PROTOCOLS.map((p) => `${p.method} ${endpointFor(p, m.id, false)}`),
      );
    }
  });

  /**
   * ── **媒体端点表本身（后来搬进来的三条）** ──────────────────────────────────
   *
   * 逐条手写字面量，**不从 `MEDIA_ENDPOINTS` 自己推**（第 6 种假阳性）。
   * 这一格钉的是「这三条端点是哪三条」；它们**真的通**由
   * `tests/contract/protocol-catalog.test.ts` 的
   * 「媒体端点 %s：对外那条真的注册着、上游那条打到了手写表上那一条」
   * 与「媒体轮询那条：对外带任务标识、上游那条同样带着它」两格钉。
   */
  it("媒体端点表三条逐条手写字面量 —— 对外与上游两半各写一遍，漏改一半就是一条部署完才发现的 404", () => {
    expect(
      MEDIA_ENDPOINTS.map((m) => [m.id, m.method, m.pathTemplate, m.upstreamPath, m.taskSlot]),
    ).toEqual([
      ["image.generate", "POST", "/v1/images/generations", "/images/generations", null],
      ["video.create", "POST", "/v1/videos", "/videos", null],
      ["video.poll", "GET", "/v1/videos/:id", "/videos/:id", ":id"],
    ]);
  });

  /**
   * **两张表是同一批路径的两个视图，会漂。**
   * `MODEL_CATALOG[].endpoints` 按模型分组画给人看，`MEDIA_ENDPOINTS` 按端点分组给机器用。
   * 一边加了端点另一边没加的后果：模型表上列着一条路径，而面板的媒体模式打不到它
   * （或者反过来，面板打得到的那条从来没被教给用户）。
   *
   * ⚠️ **两侧都从各自的数据推，没有一侧是从另一侧推导出来的**（反同义反复）：
   * 左边是「媒体模型身上挂的全部端点」，右边是「媒体端点表里的全部条目」。
   */
  it("媒体端点表与媒体模型的 endpoints 是同一批路径 —— "
     + "两张表一漂，面板教的调法与它真发的那条就不是一回事", () => {
    const fromModels = [...new Set(
      MODEL_CATALOG.filter((m) => m.modality !== "chat")
        .flatMap((m) => m.endpoints.map((e) => `${e.method} ${e.path}`)),
    )].sort();
    const fromEndpoints = [...new Set(
      MEDIA_ENDPOINTS.map((m) => `${m.method} ${m.pathTemplate}`),
    )].sort();
    expect(fromEndpoints).toEqual(fromModels);
    // 非空锚：两侧同时变成空数组时上面那句会空洞地通过（第 5 种假阳性）。
    expect(fromEndpoints.length, "两张表同时空了，上面那句什么都没证明").toBe(3);
  });

  /**
   * 媒体的样例请求体与四条对话协议守同一条：**那句占位文本恰好出现一次**。
   * 少一次 ⇒ Playground 的媒体模式**静默丢弃运维输入的提示词、恒发样例那句话**；
   * 多一次 ⇒ `withPrompt()` 判失败，媒体模式一次请求都发不出去。
   *
   * ⚠️ **轮询那条的 `sample()` 必须是 `null` 而不是 `{}`**：GET 没有请求体，
   * 而一个空对象会让消费侧去里面找那句占位文本、找不到、把**整份目录**判成读不出来。
   */
  it("媒体样例体里 SAMPLE_PROMPT 恰好一次，轮询那条没有请求体 —— "
     + "少一次就是静默丢弃运维输入的提示词", () => {
    expect(SAMPLE_PROMPT).toBe("ping");                 // 手写字面量锚
    for (const m of MEDIA_ENDPOINTS.filter((x) => x.op === "generate")) {
      const json = JSON.stringify(m.sample("agnes-image-2.1-flash"));
      expect(json.split(SAMPLE_PROMPT).length - 1, `${m.id} 的样例文本`).toBe(1);
    }
    expect(MEDIA_ENDPOINTS.find((m) => m.op === "poll")!.sample("x")).toBeNull();
  });

  /**
   * 过网络那一份里，**每条媒体端点的样例模型与这条端点的形态对得上**。
   * 变红条件：把 `catalogPayload()` 里那个 `modelFor(rest.modality)` 换回 `defaultModel`
   * ⇒ 图片端点的样例体里出现一个**对话**模型 ⇒ 面板照着它教一条注定 4xx 的调法。
   *
   * 期望值手写字面量，不从 `MODEL_CATALOG` 里 find 出来再回填（第 6 种假阳性）。
   */
  it("过网络那一份里媒体样例体配的是同形态的模型 —— 配错形态就是教一条注定 4xx 的调法", () => {
    const payload = JSON.parse(JSON.stringify(catalogPayload()));
    const byId = new Map(payload.media.map((m: { id: string; sampleBody: unknown }) => [m.id, m.sampleBody]));
    expect(byId.get("image.generate")).toEqual({ model: "agnes-image-2.1-flash", prompt: "ping" });
    expect(byId.get("video.create")).toEqual({ model: "agnes-video-v2.0", prompt: "ping" });
    expect(byId.get("video.poll")).toBeNull();
    // 函数不过网络（与协议那一组同一条）。
    for (const m of payload.media) expect(m.sample).toBeUndefined();
  });

  /**
   * 媒体模型的 `endpoints` **派生不了**（它们不在 `PROTOCOLS` 里，见 `upstreamPath`
   * 字段注释里那条边界），所以只能逐条手写字面量钉住。
   * 漏掉视频那条 `GET` 的后果是面板把一个两段式接口教成一次性接口——
   * 用户建完任务拿不到成片，而面板上什么异常都看不出来。
   */
  it("媒体模型的 endpoints 逐条手写字面量 —— 视频是两段式，漏一条就把用法教错了", () => {
    expect(
      MODEL_CATALOG.filter((m) => m.modality !== "chat")
        .map((m) => [m.id, m.endpoints.map((e) => `${e.method} ${e.path}`)]),
    ).toEqual([
      ["agnes-image-2.1-flash", ["POST /v1/images/generations"]],
      ["agnes-image-2.0-flash", ["POST /v1/images/generations"]],
      ["agnes-video-v2.0", ["POST /v1/videos", "GET /v1/videos/:id"]],
    ]);
  });
});
