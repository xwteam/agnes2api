import { describe, it, expect } from "vitest";
import { makeApp, TEST_CONFIG } from "../helpers/make-app.js";
import {
  PROTOCOLS, MODEL_CATALOG, endpointFor, SAMPLE_PROMPT,
} from "../../src/core/admin/protocol-catalog.js";

/**
 * ⚠️ **必须过滤掉 `method === "ALL"` 的条目。** 设计 §13.2 已实测：Hono 4.13.2 的
 * `app.routes` 会把用 `use()` 注册的中间件也列成条目，朴素循环会把中间件当路由，
 * 造出一条「覆盖了但什么都没证明」的断言。
 */
// ⚠️ **`makeApp` 是 `async`**（`tests/helpers/make-app.ts:121`），所以要 `Awaited<>`。
// 不加的话 `ReturnType` 拿到的是 Promise，`["app"]` 直接是类型错误。
function realRoutes(app: Awaited<ReturnType<typeof makeApp>>["app"]) {
  return app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`);
}

describe("协议目录与真实路由表对账", () => {
  it("每条协议端点都在 app 上真的注册着 —— 改一个字符就是面板给出一条 404 的示例", async () => {
    // 变红条件：把 PROTOCOLS 里任一条 pathTemplate 改一个字符
    const { app } = await makeApp([], []);
    const routes = realRoutes(app);
    for (const p of PROTOCOLS) {
      // Gemini 的注册路径是通配段 `/v1beta/models/:rest{.+}`，模板替换后不能直接比对，
      // 所以按前缀判定；另外三条是静态路径，逐字比对。
      if (p.streamMode === "path") {
        expect(routes).toContain("POST /v1beta/models/:rest{.+}");
      } else {
        expect(routes).toContain(`${p.method} ${p.pathTemplate}`);
      }
    }
  });

  it("模型目录里的媒体端点同样是真路由 —— 视频那两条是两段式，漏一条面板就教错用法", async () => {
    // 变红条件：把 agnes-video-v2.0 的 GET /v1/videos/:id 删掉
    const { app } = await makeApp([], []);
    const routes = realRoutes(app);
    for (const m of MODEL_CATALOG) {
      for (const e of m.endpoints) {
        if (e.path.includes("{model}") || e.path.includes("generateContent")) continue;
        expect(routes).toContain(`${e.method} ${e.path}`);
      }
    }
  });
});

/**
 * ⚠️ **上面那两格只证明「路由存在」，不证明那个请求体调得通**——那是下面这一组的事。
 * 而下面这一组证明的也只是「**目录里的端点在这份 app 上存在且接受这个请求体**」，
 * **不**证明「上游 Agnes 真的接受这个请求体」：上游是 `FakeFetcher` 桩掉的。
 * 后者只有真机能验，属于 P3e 的双形态真机验收。
 */
describe("协议目录的示例请求真的调得通", () => {
  it.each(PROTOCOLS.map((p) => [p.id, p] as const))(
    "%s 的 sample() 经真 app 发出去拿到 200，且出站 URL 逐字等于 agnesBaseUrl + upstreamPath，"
    + "上游收到的 body 里带着那个 model —— "
    + "这一格是 D1『漂了没人会发现』的唯一护栏，也是 upstreamPath 的唯一护栏（评审 C3）",
    async (_id, p) => {
      const model = MODEL_CATALOG[0]!.id;
      // makeApp 的第 5 参是选项对象。⚠️ 位置参数别传错：签名是
      // (outcomes, keys, configOverride, now, options)，把选项当第 1 参传会静默用另一份默认
      // 存储（P3c 计划在这上面栽过一次，结论从「无缺陷」翻成 Critical）。
      // ⚠️ **`makeApp` 是 async，必须 await**：仓里的调用点全部带 await，0 处不带。
      const { app, fetcher } = await makeApp(
        [{ status: 200, body: JSON.stringify({ id: "x", object: "chat.completion", model,
          choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) }],
        ["sk-catalog-probe-key-0001"],
        {}, () => 1_000,
      );
      const res = await app.request(endpointFor(p, model, false), {
        method: p.method,
        // ⚠️ 网关口令取 `TEST_CONFIG.gatewayToken`（夹具值 `"t"`），**不是随手写一个字符串**：
        // 写错的话四条全部 401，而 `expect(res.status).toBe(200)` 会红成「示例调不通」，
        // 把一个夹具问题误报成目录缺陷。
        headers: {
          authorization: `Bearer ${TEST_CONFIG.gatewayToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(p.sample(model)),
      });
      expect(res.status).toBe(200);
      // `FakeFetcher` 自己就记着出站的 body 与 URL（`sentBodies` / `sentUrls`，
      // `tests/helpers/fake-fetcher.ts:13-18`），**用它现成的，别新造一个钩子。**
      expect(fetcher.sentBodies.join("")).toContain(model);
      // 样例里那句用户输入必须活着穿过协议转换。四条协议里有三条要被转成内部格式
      // （Gemini 的 `contents[].parts[].text`、Responses 的 `input` 都在转换里换了形状），
      // 转丢了的话示例发出去是一条空请求，而面板照样把它印出来教用户怎么调。
      expect(fetcher.sentBodies.join(""), `${p.id} 的样例文本没活着到上游`)
        .toContain(SAMPLE_PROMPT);
      // ★ 评审 C3 的落点：观测点在**真实出站 URL**上，不是比对目录自己的两个字段。
      expect(fetcher.sentUrls.at(-1)).toBe(`${TEST_CONFIG.agnesBaseUrl}${p.upstreamPath}`);
    },
  );

  /**
   * ── 变异 M2 的落点（**本任务实测之后补的一格，计划里没有**）────────────────
   *
   * 变异表里 M2 是「把 anthropic 的 `sample()` 去掉 `max_tokens`，期望
   * 『anthropic 的 sample() 经真 app 发出去拿到 200』那一格变红」。**实测 ESCAPED**：
   * 上游是 `FakeFetcher`，它无条件回 200；而网关自己**不校验** `max_tokens`
   *（`src/core/protocol/anthropic.ts:46` 只是原样透传，缺了就是 `undefined`，
   * `JSON.stringify` 把这个键整个丢掉）⇒ 只有真实的上游才会 400。
   *
   * 「示例请求真的能被上游接受」在假上游下按定义就不可观测（见上面那段边界，
   * 它归 P3e 的真机验收）。**但它可观测的那一半在这里**：目录声称必填的那个字段，
   * 有没有活着穿过网关的协议转换、真的到达上游。掉了它，示例在生产上就是一条 400，
   * 而面板照样把它印出来教用户怎么调——这正是 D1「漂了没人会发现」的形态。
   *
   * 期望值 `64` 手写字面量，不从 `PROTOCOLS` 推（第 6 种假阳性）。
   * **两个方向都能分辨**：目录去掉 `max_tokens` 会红；网关的协议转换不再透传它同样会红。
   */
  it("anthropic 声称必填的 max_tokens 真的到得了上游 —— 假上游看不出 400，但看得出这个键没了", async () => {
    const p = PROTOCOLS.find((x) => x.id === "anthropic")!;
    const model = MODEL_CATALOG[0]!.id;
    const { app, fetcher } = await makeApp(
      [{ status: 200, body: JSON.stringify({ id: "x", object: "chat.completion", model,
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }] }) }],
      ["sk-catalog-probe-key-0003"],
      {}, () => 1_000,
    );
    const res = await app.request(endpointFor(p, model, false), {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_CONFIG.gatewayToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(p.sample(model)),
    });
    expect(res.status).toBe(200);
    // 先钉住「真的发出去了一次」——否则下面那条断言在零次出站时会红成另一种病因。
    expect(fetcher.sentBodies.length, "上游应当恰好被打了一次").toBe(1);
    expect(JSON.parse(fetcher.sentBodies[0]!)).toMatchObject({ max_tokens: 64 });
  });

  /**
   * 反向自检：上面那格断言的 `sentUrls.at(-1)` 若是因为**根本没发出去任何一次出站请求**
   * 而恰好为 `undefined`，`toBe()` 会红——所以那一格不会静默通过。
   * 但反过来「出站 URL 与对外路径长得不一样」这件事本身也要被看见一次，
   * 否则读的人分不清这一组到底证没证明「两条路径是两个东西」。
   */
  it("同一次真请求里，出站 URL 与客户端打的对外路径确实不是同一个 —— 两端各自可分辨", async () => {
    const p = PROTOCOLS.find((x) => x.id === "anthropic")!;
    const model = MODEL_CATALOG[0]!.id;
    const { app, fetcher } = await makeApp(
      [{ status: 200, body: JSON.stringify({ id: "x", object: "chat.completion", model,
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }] }) }],
      ["sk-catalog-probe-key-0002"],
      {}, () => 1_000,
    );
    const outward = endpointFor(p, model, false);
    expect(outward).toBe("/v1/messages");                    // 手写字面量锚
    const res = await app.request(outward, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_CONFIG.gatewayToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(p.sample(model)),
    });
    expect(res.status).toBe(200);
    expect(fetcher.sentUrls.at(-1)).toBe("https://upstream.test/v1/chat/completions");  // 手写字面量锚
    expect(fetcher.sentUrls.at(-1)).not.toContain(outward);
  });
});
