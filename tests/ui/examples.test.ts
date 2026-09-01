import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  EXAMPLE_LANGS, KEY_PLACEHOLDER, exampleProtocols, modelForProtocol, exampleFor, allExamples, langLabel,
} from "../../admin-ui/js/pure/examples.mjs";
import { catalogPayload, SAMPLE_PROMPT } from "../../src/core/admin/protocol-catalog.js";

/**
 * **集成示例卡的取值判定。**
 *
 * ⚠️ **这一整个文件守的是同一条产品性质**：设计文档那条订正把集成示例卡与 Playground
 * 合进同一期，逐字理由是「它们是同一份知识，做两遍必漂，而漂了没人会发现」。
 * ⇒ 下面每一格「换一个假目录，示例里那一处必须跟着换」的用例，都是在把那句话变成
 * 会变红的断言：**只要有人把路径 / 方法 / 鉴权头 / 请求体里的任何一样改成前端自己的
 * 字面量，对应那一格立刻红。**
 *
 * ⚠️ **夹具分两类，刻意的**（形态与模型板块那份纯函数用例相同）：
 * · 「这个函数在不在看真源交过来的那个字段」这类**行为**断言用**手写的假目录**——
 *   手写才控得住「真源说 A，前端如果写死就会说 B」这个必须分叉的状态；
 * · 「面板教出去的那条 URL 对不对」这类**契约**断言直接用 `catalogPayload()` 的真实内容，
 *   **不手抄一份**（第 7 种假阳性：测的是抄件不是原件）。
 *
 * ⚠️ **期望值一律手写字面量**（第 6 种假阳性）：`toHaveLength(12)` 里那个 12 是手写的，
 * 不是 `payload.protocols.length * EXAMPLE_LANGS.length`——那种写法在「某条协议整个
 * 掉了」的时候两边一起变小，一声不吭。
 */

/** 本文件给 `.mjs` 的返回值加的一层**局部形状标注**（`pure/*.mjs` 不做类型检查）。
 *  它们只标形状，不改任何判据。 */
type Row = { protocol: string; label: string; lang: string; model: string | null; code: string | null };
type Proto = {
  id: string; label: string; method: string; pathTemplate: string;
  authHeader: string; sampleBody: Record<string, unknown>;
};

const payload = catalogPayload();

/** 用例里那个「面板部署在哪」。**刻意是探针，不是任何真实地址。** */
const ORIGIN = "https://origin-probe.invalid";

/**
 * 一条**与真源无关**的假协议。字段全部取成探针值：
 * 前端若把其中任何一样换成自己的字面量，拿它一喂就会显出来。
 */
function fakeProto(over: Partial<Proto> = {}): Proto {
  return {
    id: "probe-proto",
    label: "Probe Protocol",
    method: "POST",
    pathTemplate: "/probe/xyz",
    authHeader: "x-probe-key",
    sampleBody: { probeField: "PROBE-INPUT-9" },
    ...over,
  };
}

describe("集成示例：12 段的构成", () => {
  it("12 段，四协议 × 三语言，一段不多一段不少 —— 少一段就是某个协议的用户没有示例", () => {
    const all = allExamples(payload.protocols, payload.models, ORIGIN) as Row[];
    // **手写 12**，不写 `protocols.length * EXAMPLE_LANGS.length`（第 6 种假阳性）。
    expect(all, "四协议 × 三语言").toHaveLength(12);
    // 归属也手写：光数 12 的话，「三条协议各出四段」同样是 12。
    expect([...new Set(all.map((e) => e.protocol))].sort())
      .toEqual(["anthropic", "gemini", "openai", "responses"]);
    expect([...new Set(all.map((e) => e.lang))].sort()).toEqual(["curl", "node", "python"]);
  });

  it("三种语言给出三段不同的代码 —— 塌成同一段的话，语言选择器就是个摆设", () => {
    const p = fakeProto();
    const curl = exampleFor(p, ORIGIN, "curl", "m") as string;
    const python = exampleFor(p, ORIGIN, "python", "m") as string;
    const node = exampleFor(p, ORIGIN, "node", "m") as string;
    // 两两不同（夹具 A/B 同值是第 1 种假阳性；这里三条互不相同才谈得上「三档」）。
    expect(new Set([curl, python, node]).size, "三种语言给出了同一段代码").toBe(3);
    // 而且每一段确实是那门语言：手写字面量，不从被测对象推导。
    expect(curl).toContain("curl -X POST");
    expect(python).toContain("import requests");
    expect(node).toContain("await fetch(");
  });

  it("EXAMPLE_LANGS 恰好是这三档 —— 加一档而 exampleFor 没跟上，那一档会静默落回 Node", () => {
    // `exampleFor()` 的最后一个分支是兜底的 Node，**加档不改它 = 新语言画出 Node 代码**。
    expect(EXAMPLE_LANGS).toEqual(["curl", "python", "node"]);
  });
});

describe("集成示例：一处端点知识都不许在前端再写一遍", () => {
  it("URL 由 origin 加真源的 pathTemplate 拼出来 —— 换一条路径，示例里那条必须跟着换", () => {
    // 变红条件：把 `exampleFor()` 里的 `proto.pathTemplate` 换成任何一条字面量路径。
    const p = fakeProto({ pathTemplate: "/probe/xyz" });
    expect(exampleFor(p, ORIGIN, "curl", "m")).toContain("https://origin-probe.invalid/probe/xyz");
    // 反向：改一条**别的**路径进去，输出必须跟着变（同一条判据的另一半，
    // 防「恰好包含」而不是「真的取自那里」）。
    const q = fakeProto({ pathTemplate: "/probe/zzz" });
    expect(exampleFor(q, ORIGIN, "curl", "m")).toContain("https://origin-probe.invalid/probe/zzz");
    expect(exampleFor(q, ORIGIN, "curl", "m")).not.toContain("/probe/xyz");
  });

  it("换一个 origin，整段代码里的地址跟着换 —— 写死任何一个 base URL 都是错的", () => {
    const p = fakeProto();
    const a = exampleFor(p, "https://alpha-probe.invalid", "node", "m") as string;
    const b = exampleFor(p, "https://beta-probe.invalid", "node", "m") as string;
    // 两个 origin **给出不同的值**（第 1 种假阳性：夹具 A/B 同值时谁赢都通过）。
    expect(a).toContain("https://alpha-probe.invalid/probe/xyz");
    expect(b).toContain("https://beta-probe.invalid/probe/xyz");
    expect(a).not.toContain("beta-probe");
  });

  it("请求方法来自真源，不是写死的 POST —— 目录改了方法，示例照旧就是教错", () => {
    // 变红条件：把 `exampleFor()` 里的 `proto.method` 换回字面量 POST。
    const p = fakeProto({ method: "PUT" });
    expect(exampleFor(p, ORIGIN, "curl", "m")).toContain("curl -X PUT");
    expect(exampleFor(p, ORIGIN, "node", "m")).toContain('method: "PUT"');
    expect(exampleFor(p, ORIGIN, "curl", "m")).not.toContain("POST");
  });

  it("鉴权头的名字来自真源，只有 Bearer 前缀是本地决定的", () => {
    // ⚠️ 两条协议在**同一格里**分叉（第 5 种假阳性：分开写的话，两个候选实现
    //    在各自那一格里数学上等价——「一律加前缀」和「按头名分档」都能过）。
    const bearer = fakeProto({ authHeader: "authorization" });
    const raw = fakeProto({ authHeader: "x-probe-key" });
    expect(exampleFor(bearer, ORIGIN, "curl", "m")).toContain("authorization: Bearer YOUR_GATEWAY_TOKEN");
    expect(exampleFor(raw, ORIGIN, "curl", "m")).toContain("x-probe-key: YOUR_GATEWAY_TOKEN");
    // 名字真的取自目录：本地映射表写不出 `x-probe-key` 这一档。
    expect(exampleFor(raw, ORIGIN, "curl", "m")).not.toContain("authorization");
    expect(exampleFor(raw, ORIGIN, "curl", "m")).not.toContain("Bearer");
  });

  it("请求体原样来自真源的 sampleBody —— 用户输入那句话不许在前端再写一次", () => {
    // 变红条件：把 `exampleFor()` 里的 `proto.sampleBody` 换成本地拼的一份请求体。
    const p = fakeProto({ sampleBody: { probeField: "PROBE-INPUT-9" } });
    const code = exampleFor(p, ORIGIN, "python", "m") as string;
    expect(code).toContain('"probeField": "PROBE-INPUT-9"');
    // 真源那句用户输入（`SAMPLE_PROMPT`）确实是**经 sampleBody 带过来的**：
    // 12 段里每一段都有它。前端若自己写一遍 "ping"，改真源那一刻这一格才会红。
    const all = allExamples(payload.protocols, payload.models, ORIGIN) as Row[];
    for (const e of all) {
      expect(e.code, `${e.protocol}/${e.lang} 里没有真源那句用户输入`)
        .toContain(`"${SAMPLE_PROMPT}"`);
    }
  });

  /**
   * **这张卡上有两条选模规则，而今天没有任何东西绑住它们**（评审发现 F-4）。
   *
   * · **路径**那一侧走前端的 `modelForProtocol()`（「第一个真的支持这条协议的模型」）；
   * · **请求体**那一侧走后端：`src/core/admin/protocol-catalog.ts` 的 `catalogPayload()`
   *   用 `MODEL_CATALOG[0]!.id` 展开 `sample(model)`，模型名早就烤进 `sampleBody` 了，
   *   前端一个字都改不了。
   *
   * ⚠️ **我改签名时的论证只拆掉了一半危害，这一格补另一半**：我当时说
   * 「`MODEL_CATALOG[0]` 哪天不是对话模型，面板就会教出一条打不通的 Gemini 地址」，
   * 于是把**路径**那一侧改成逐协议取模型——**而请求体那一侧仍然是 `MODEL_CATALOG[0]`**。
   * 两条规则今天恰好给出同一个答案，**这正是全局约束 15 要防的形状**：
   * 同一个问题两处各答一遍，靠巧合一致。
   *
   * 观测点落在**真源交出来的 `sampleBody` 里那个 model 字段**上（不是前端自报），
   * 判据是它必须逐字等于同一段示例路径里用的那个模型。
   * **变红条件（实测）**：把 `catalogPayload()` 的 `defaultModel` 换成
   * `MODEL_CATALOG[1]!.id`（一个图片模型）——那正是我论证里假设的那次改动。
   */
  it("路径里那个模型与请求体里那个模型必须是同一个 —— 两条选模规则今天只是恰好相等", () => {
    const all = allExamples(payload.protocols, payload.models, ORIGIN) as Row[];
    let checked = 0;
    for (const e of all) {
      const proto = payload.protocols.find((p) => p.id === e.protocol)!;
      const inBody = (proto.sampleBody as Record<string, unknown>).model;
      // Gemini 的 sampleBody 不带 model（它把模型拼进路径），那三段跳过。
      if (typeof inBody !== "string") continue;
      checked += 1;
      expect(inBody, `${e.protocol}/${e.lang}：请求体里的模型与路径里的模型对不上`).toBe(e.model);
    }
    // 反向自检：一条都没检到时上面那个循环恒绿。**手写 9**：三条协议 × 三种语言
    //（四条里只有 Gemini 的 sampleBody 不带 model），不写 `all.length - 3`。
    expect(checked, "一条带 model 的 sampleBody 都没检到，这一格什么都没证明").toBe(9);
  });

  it("Gemini 那三段的路径里带着模型名和 :generateContent —— 它是四条里唯一把模型拼进路径的", () => {
    const g = payload.protocols.find((p) => p.id === "gemini")!;
    const code = exampleFor(g, ORIGIN, "curl", "agnes-2.0-flash") as string;
    // 手写字面量，不从 `g.pathTemplate` 推导。
    expect(code).toContain("https://origin-probe.invalid/v1beta/models/agnes-2.0-flash:generateContent");
  });

  it("真实目录跑出来的 12 段里，没有一段还留着未展开的模型占位符", () => {
    // **本模块唯一认识的那一小件端点知识就是这个占位符本身**（`examples.mjs` 文件头
    // 登记的第 ① 件）。真源哪天换了写法（`endpointFor()` 与它是同一个约定），
    // 这一格当场红——那正是它存在的理由。
    const all = allExamples(payload.protocols, payload.models, ORIGIN) as Row[];
    for (const e of all) {
      expect(e.code, `${e.protocol}/${e.lang} 里还留着没展开的占位符`).not.toContain("{model}");
    }
    // 反向自检：上面那个循环在 `all` 是空数组时恒绿。
    expect(all.length, "一段都没生成，上面那个循环什么都没证明").toBe(12);
  });

  it("本模块源码里一个 URL 字面量都没有 —— base URL 只能从运行期的 origin 来", () => {
    // ⚠️ **边界写清楚**：这一格只扫**这一个文件**，它不是一道全仓护栏。全仓那道是
    // `tests/ui/no-hardcoded-endpoints.test.ts`「前端没有任何文件硬编码网关端点路径 —— 端点只许来自 /admin/api/models」，
    // 而它扫的是网关对外端点路径，**扫不到 base URL**。本任务是「写死一个 base URL」
    // 风险最高的一处，所以在这里就地钉一格。
    const src = readFileSync("admin-ui/js/pure/examples.mjs", "utf8");
    expect(src, "示例模块里出现了地址字面量（含 scheme）").not.toContain("://");
    // 反向自检：文件读空了的话上面那条恒绿。
    expect(src.length, "源文件读空了，上面那条什么都没证明").toBeGreaterThan(2000);
  });
});

describe("集成示例：凭据占位与「没有模型」那一档", () => {
  it("每一段里的凭据只有 YOUR_GATEWAY_TOKEN —— 面板拿不到明文网关口令（设计 §8.6）", () => {
    const all = allExamples(payload.protocols, payload.models, ORIGIN) as Row[];
    for (const e of all) {
      expect(e.code, `${e.protocol}/${e.lang} 里没有占位口令`).toContain("YOUR_GATEWAY_TOKEN");
    }
    // 占位符本身也手写一次：它是产品承诺的一部分，改掉它要有人回来表态。
    expect(KEY_PLACEHOLDER).toBe("YOUR_GATEWAY_TOKEN");
    expect(all.length, "一段都没生成，上面那个循环什么都没证明").toBe(12);
  });

  it("模型取的是这条协议真的支持的那一个，不是清单里的第一个", () => {
    // 第一条模型**不支持**这条协议（媒体模型就是这个形状：protocols 是空数组），
    // 第二条才支持。两条给的是**不同的值**，取错哪一条都看得出来（第 1 种假阳性）。
    const models = [
      { id: "probe-image", modality: "image", protocols: [] as string[], endpoints: [] },
      { id: "probe-chat", modality: "chat", protocols: ["probe-proto"], endpoints: [] },
    ];
    expect(modelForProtocol(fakeProto(), models)).toBe("probe-chat");
    // 一个都不支持时是 null，不是「随便挑一个」。
    expect(modelForProtocol(fakeProto({ id: "nobody" }), models)).toBe(null);
  });

  it("路径需要模型而一个模型都没有时，那几段是 null，不是把 null 拼进 URL", () => {
    // ⚠️ **两种状态放在同一格里**（第 5 种假阳性）：
    //    · 路径里带占位符 ⇒ 没有模型就没有示例；
    //    · 路径里不带占位符 ⇒ 没有模型照样给得出示例。
    //    分开写的话，「一律返回 null」与「按需返回 null」两种实现各自都能过。
    const needs = fakeProto({ id: "needs", pathTemplate: "/probe/{model}/go" });
    const plain = fakeProto({ id: "plain", pathTemplate: "/probe/xyz" });
    const rows = allExamples([needs, plain], [], ORIGIN) as Row[];
    const byProto = (id: string) => rows.filter((r) => r.protocol === id);
    expect(byProto("needs").every((r) => r.code === null), "没有模型却拼出了一条 URL").toBe(true);
    expect(byProto("plain").every((r) => typeof r.code === "string"), "不需要模型的那条也被判成没示例").toBe(true);
    // 而且**绝不能**把 null 拼进地址里交出去。
    expect(rows.map((r) => r.code).join("\n")).not.toContain("/probe/null/go");
  });
});

describe("集成示例：响应窄化", () => {
  it("真实响应窄化之后，拼代码要用的每一格都在 —— 少一格就得回来改这份清单", () => {
    const out = exampleProtocols(payload) as Proto[] | null;
    expect(out).not.toBe(null);
    expect(out!).toHaveLength(4);
    // 字段名手写，不从 `out[0]` 推导。
    expect(Object.keys(out![0]!).sort())
      .toEqual(["authHeader", "id", "label", "method", "pathTemplate", "sampleBody"]);
  });

  it("少一个字段就整份判成读不出来，不是把坏的那条跳过", () => {
    // 跳过坏的那条 ⇒ 卡上少一个协议标签页而看起来完全正常，
    // 后果是把一条真的能用的协议入口从文档里抹掉。
    const good = { id: "a", label: "A", method: "POST", pathTemplate: "/p", authHeader: "x-k", sampleBody: {} };
    expect(exampleProtocols({ protocols: [good] }), "前置条件：这一条本来就该过").toHaveLength(1);
    for (const missing of ["id", "label", "method", "pathTemplate", "authHeader", "sampleBody"]) {
      const bad: Record<string, unknown> = { ...good };
      delete bad[missing];
      expect(exampleProtocols({ protocols: [good, bad] }), `少了 ${missing} 却没判成读不出来`).toBe(null);
    }
    // 整份读不出来（不是 `protocols` 数组）时同样是 null，不是空数组。
    expect(exampleProtocols({}), "响应里根本没有 protocols").toBe(null);
    expect(exampleProtocols(null), "响应整个读不出来").toBe(null);
  });

  /**
   * ⚠️ **用例名不许替它宣称「由调用方照实显示」**（评审发现 F-9）：
   * `admin-ui/js/sec-settings.js` 只拿 `EXAMPLE_LANGS` 里的三档去调它，
   * **`null` 那一支今天没有任何调用方走得到** ⇒ 「调用方会照实显示原值」这句话
   * 在本轮是**不可观测**的，写进用例名就是又一句没有观测点的断言。
   * 这一格担保的只有：三档专名逐字正确，表外的值不冒充任何一档已知语言。
   */
  it("语言展示名是专名，三档逐字正确；表外的值交回 null，不冒充任何一档已知语言", () => {
    expect(langLabel("curl")).toBe("cURL");
    expect(langLabel("python")).toBe("Python");
    expect(langLabel("node")).toBe("Node.js");
    expect(langLabel("rust"), "表外的值不许冒充任何一档已知语言").toBe(null);
  });
});
