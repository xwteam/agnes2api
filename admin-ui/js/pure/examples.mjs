/**
 * 集成示例：**四协议 × 三语言 = 12 段**（设计 §10.4 第 4 张卡）。
 *
 * ⚠️ **本模块不知道任何端点路径。** 路径、请求方法、鉴权头的名字、最小请求体
 * 全部来自 `GET /admin/api/models` 的响应（真源 `src/core/admin/protocol-catalog.ts`）。
 * 这是设计文档那条订正的落点：集成示例卡与 Playground 是同一份知识，
 * 「做两遍必漂，而漂了没人会发现」。
 *
 * ── **本模块自己知道的那三小件，逐条登记（别让它们悄悄长大）** ────────────────
 * ① **`{model}` 这个占位符本身**。`pathTemplate` 交过来的是模板，展开它就必须认识
 *    那个 token；真源里 `endpointFor()` 做的是同一件事。**这是第二份知识，如实登记**，
 *    并且它被钉住了：`tests/ui/examples.test.ts` 的
 *    「真实目录跑出来的 12 段里，没有一段还留着未展开的模型占位符」
 *    ——真源哪天换了占位符写法，那一格当场红。
 * ② **`authorization` 这个头要带 `Bearer ` 前缀**。这条不在目录里、也不该在目录里
 *    （它是 HTTP 的惯例，不是这个网关的知识），网关那一侧解析它的是
 *    `src/http/middleware/auth.ts` 里那条 bearer 正则。**头的名字仍然来自目录**，
 *    本模块只决定值要不要加前缀。
 * ③ **三种客户端语言的代码骨架**（curl / Python / Node）。它们是语言，不是端点。
 *
 * ⚠️ **`origin` 是参数不是全局**：这个目录下禁止出现浏览器的那两个顶层全局
 *（`scripts/build-ui.mjs` 里 `js/pure/` 的三条静态校验，违反即 exit 1，含注释里的字样）。
 * 调用方 `admin-ui/js/sec-settings.js` 读一次再传进来。
 *
 * ⚠️ **key 恒是 `KEY_PLACEHOLDER` 占位**：面板拿不到明文网关口令
 *（设计 §8.6「凭据只写不读」，`GET /admin/api/config` 对它只回 configured 与 hint 两格），
 * 所以「一键填入我的口令」这个选项在这里根本不存在。
 *
 * ⚠️ **本文件里一个 URL 字面量都没有**（连 scheme 都没有）：base URL 写死任何一个
 * 都是错的。由 `tests/ui/examples.test.ts` 的
 * 「本模块源码里一个 URL 字面量都没有 —— base URL 只能从运行期的 origin 来」扫着。
 */

/** 三种客户端语言。**顺序即渲染顺序。** */
export const EXAMPLE_LANGS = ["curl", "python", "node"];

/** 示例里那把 key 的占位符。**面板永远填不进真值，也不该填得进。** */
export const KEY_PLACEHOLDER = "YOUR_GATEWAY_TOKEN";

/** 普通对象，否则 `null`。数组不算。 */
function obj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
}

/**
 * 响应里那份协议清单，窄化成集成示例卡用得上的那几格。
 * **读不出来时是 `null`，不是空数组**——「这个网关一条协议都没有」与「这份响应读不出来」
 * 是两句话，而一张空的示例卡在屏幕上跟后者长得一模一样（全局约束 9 的同型）。
 *
 * ⚠️ **任何一条格式不对就整份判成读不出来**，不是把坏的那条跳过：跳过之后卡上会少一个
 * 协议标签页而**看起来完全正常**，后果是把一条真的能用的协议入口从文档里抹掉。
 *
 * ⚠️ **它与 `admin-ui/js/pure/models.mjs` 的 `catalogProtocols()` 是同一份响应的两个视图，
 * 不是两份知识**：那边只要 id 与展示名（画徽章用），这边还要方法、路径模板、鉴权头与
 * 请求体（拼代码用）。把两者并成一个函数的代价是模型板块从此要求响应里有 `sampleBody`
 * ——一份它根本不看的字段缺了就整张表读不出来。
 * ⚠️ **同一份响应的模型清单这边不再窄化一遍**：调用方直接复用 `models.mjs` 的
 * `catalogModels()`，本模块只接它交出来的结果。
 */
export function exampleProtocols(payload) {
  const p = obj(payload);
  if (p === null || !Array.isArray(p.protocols)) return null;
  const out = [];
  for (const item of p.protocols) {
    const e = obj(item);
    if (e === null) return null;
    if (typeof e.id !== "string" || typeof e.label !== "string") return null;
    if (typeof e.method !== "string" || e.method === "") return null;
    if (typeof e.pathTemplate !== "string" || e.pathTemplate === "") return null;
    if (typeof e.authHeader !== "string" || e.authHeader === "") return null;
    if (obj(e.sampleBody) === null) return null;
    out.push({
      id: e.id,
      label: e.label,
      method: e.method,
      pathTemplate: e.pathTemplate,
      authHeader: e.authHeader,
      sampleBody: e.sampleBody,
    });
  }
  return out;
}

/**
 * 这条协议的示例该用哪个模型：**清单里第一个真的支持这条协议的**，没有就是 `null`。
 *
 * ⚠️ **不是「清单里的第一个」**：媒体模型的 `protocols` 是空数组，拿它去拼一条对话协议的
 * 路径会教出一条打不通的 URL。
 * ⚠️ **也不是全卡共用一个模型**：只有把模型拼进路径的那条协议需要它，而「这个模型支持
 * 这条协议吗」这个问题只有逐协议问才有正确答案。
 */
export function modelForProtocol(protocol, models) {
  if (!Array.isArray(models)) return null;
  for (const m of models) {
    const e = obj(m);
    if (e === null || typeof e.id !== "string") continue;
    if (Array.isArray(e.protocols) && e.protocols.includes(protocol.id)) return e.id;
  }
  return null;
}

/**
 * 这一条协议要发的头。**头的名字一律来自目录**，本模块只决定值要不要带 `Bearer ` 前缀
 *（见文件头登记的第 ② 件）。`content-type` 是 HTTP，不是这个网关的知识。
 */
function headerLines(proto) {
  const value = proto.authHeader === "authorization" ? `Bearer ${KEY_PLACEHOLDER}` : KEY_PLACEHOLDER;
  return [[proto.authHeader, value], ["content-type", "application/json"]];
}

/**
 * 一段代码。`lang` 必须是 `EXAMPLE_LANGS` 里的一档——三个分支对那三档是穷尽的，
 * 而 `allExamples()` 只按 `EXAMPLE_LANGS` 迭代。
 *
 * `model` 只在 `pathTemplate` 里带着占位符时才用得上（四条里只有一条这样）。
 */
export function exampleFor(proto, origin, lang, model) {
  const path = String(proto.pathTemplate).replace("{model}", String(model));
  const url = `${origin}${path}`;
  const method = String(proto.method);
  const body = JSON.stringify(proto.sampleBody, null, 2);
  const headers = headerLines(proto);
  if (lang === "curl") {
    const h = headers.map(([k, v]) => ` \\\n  -H '${k}: ${v}'`).join("");
    return `curl -X ${method} '${url}'${h} \\\n  -d '${body}'`;
  }
  if (lang === "python") {
    const h = headers.map(([k, v]) => `        "${k}": "${v}",`).join("\n");
    return `import requests\n\nr = requests.request(\n    "${method}",\n    "${url}",\n    headers={\n${h}\n    },\n    json=${body},\n)\nprint(r.json())`;
  }
  const h = headers.map(([k, v]) => `    "${k}": "${v}",`).join("\n");
  return `const r = await fetch("${url}", {\n  method: "${method}",\n  headers: {\n${h}\n  },\n  body: JSON.stringify(${body}),\n});\nconsole.log(await r.json());`;
}

/**
 * 12 段。**协议顺序照真源给的顺序，不在这里重排**——重排就是又一份知识。
 *
 * ⚠️ **`code` 为 `null` 是一档真状态，不是失败**：这条协议的路径需要一个模型，
 * 而清单里没有任何模型支持它。这时候**绝不能把 `null` 拼进 URL 交出去**——
 * 那是一条长得像真的、按着抄一定打不通的地址。调用方按「这一档没有示例」画。
 */
export function allExamples(protocols, models, origin) {
  const out = [];
  for (const p of protocols) {
    const model = modelForProtocol(p, models);
    const needsModel = String(p.pathTemplate).includes("{model}");
    for (const lang of EXAMPLE_LANGS) {
      out.push({
        protocol: p.id,
        label: p.label,
        lang,
        model,
        code: needsModel && model === null ? null : exampleFor(p, origin, lang, model),
      });
    }
  }
  return out;
}

/**
 * 语言那一档的展示名。**专名，刻意不进 i18n**——理由与协议的 `label` 一样
 *（见 `src/core/admin/protocol-catalog.ts` 里 `label` 字段上方那一行）：
 * 翻译一个专名只会制造歧义。
 * **表外的值返回 `null`，调用方把原值照实画出来**，不冒充任何一档已知语言。
 */
export function langLabel(lang) {
  if (lang === "curl") return "cURL";
  if (lang === "python") return "Python";
  if (lang === "node") return "Node.js";
  return null;
}
