import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  protocolBadges, filterByProtocol, catalogProtocols, catalogModels, modalityLabelKey,
  upstreamModelsView, upstreamResultCode, upstreamTransportCode, upstreamLabelKey,
} from "../../admin-ui/js/pure/models.mjs";
import { catalogPayload } from "../../src/core/admin/protocol-catalog.js";
import { I18N } from "../../admin-ui/js/i18n-dict.js";
import { stripComments } from "../helpers/strip-comments.js";

/**
 * **模型板块的取值判定。**
 *
 * ⚠️ **夹具分两类，刻意的**：
 * · 「这个函数在不在看 `model`」这类**行为**断言用**手写**的最小夹具
 *   （手写才控得住「四条全有」与「一条都没有」这两个必须同时出现的状态）；
 * · 「面板显示的可用性对不对」这类**契约**断言直接用 `catalogPayload()` 的真实内容，
 *   **不手抄一份**（第 7 种假阳性：测的是抄件不是原件）。
 *
 * ⚠️ **期望值一律手写字面量**（第 6 种假阳性）：`toBe(4)` 里那个 4 是手写的，
 * 不是 `PROTOCOLS.length`；协议 id 也是手写的，不是从 `catalogPayload()` 推导出来的。
 * 从被测对象自己推导出来的期望值，两边一起错时它一声不吭。
 */

/**
 * 本文件给 `.mjs` 的返回值加的一层**局部形状标注**。
 * `admin-ui/js/pure/*.mjs` 不做类型检查（`tsconfig.json` 只开 `allowJs` 不开 `checkJs`），
 * 于是 `protocolBadges()` / `filterByProtocol()` 的返回值是 `any`，
 * 下面 `.map((b) => …)` 的形参会触发 TS7006。
 * **它们只标形状，不改任何判据**——形状本身仍由下面每一格的断言正面钉着。
 */
type Badge = { id: string; label: string; available: boolean };
type ModelRow = {
  id: string;
  modality: string;
  protocols: string[];
  endpoints: Array<{ method: string; path: string }>;
};

/** 图片模型的最小形状：**四条对话协议一条都不占**。 */
const IMAGE_MODEL = {
  id: "probe-image",
  modality: "image",
  protocols: [] as string[],
  endpoints: [{ method: "POST", path: "/probe/images" }],
};

/** 对话模型的最小形状：**四条协议全占**。 */
const CHAT_MODEL = {
  id: "probe-chat",
  modality: "chat",
  protocols: ["alpha", "beta", "gamma", "delta"],
  endpoints: [{ method: "POST", path: "/probe/chat" }],
};

/** 四条协议的最小形状。**id 与真源无关**：本模块不该认识任何一个真实协议 id。 */
const FOUR_PROTOCOLS = [
  { id: "alpha", label: "Alpha Protocol" },
  { id: "beta", label: "Beta Protocol" },
  { id: "gamma", label: "Gamma Protocol" },
  { id: "delta", label: "Delta Protocol" },
];

describe("协议可用性矩阵", () => {
  /**
   * **变红条件（已实测）**：把 `protocolBadges` 的 `protocols.map(...)` 改成
   * `protocols.filter((p) => model.protocols.includes(p.id)).map(...)`。
   *
   * ⚠️⚠️ **夹具必须是图片模型（`protocols: []`），不许用四条全有的对话模型**：
   * 后者在两种实现下**都**返回 4 条 ⇒ 那条变异是绿的。这正是第 5 种假阳性
   *「覆盖的状态让被测的选择不可观测」。
   */
  it("四个协议徽章恒在，不可用的画灰不隐藏 —— 隐藏之后『只在一条上可用』与『读不出来』长得一样", () => {
    const badges = protocolBadges(IMAGE_MODEL, FOUR_PROTOCOLS) as Badge[];
    // 手写 4：过滤掉不可用的那种实现会交出 0 条，而 0 条在屏幕上就是一格空白。
    expect(badges.length, "不可用的被过滤掉了 —— 空白的一行与「读不出来」长得一样").toBe(4);
    expect(badges.map((b) => b.id)).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(badges.map((b) => b.available)).toEqual([false, false, false, false]);
    // 展示名照搬响应里的 `label`，**不是 id**：面板上写 id 等于让运维自己去猜。
    expect(badges.map((b) => b.label)).toEqual([
      "Alpha Protocol", "Beta Protocol", "Gamma Protocol", "Delta Protocol",
    ]);
  });

  /**
   * **它与下面「只占一条协议」那一格的捕获集是「部分重叠」，不是包含关系。**
   *
   * ⚠️⚠️ **这段说明被订正过两次，两次都是我照抄了一句没有自己验的话。**
   * · 第一版写「与上一格合起来才说明这个函数真的在看 model」——在纯函数这一侧偏强；
   * · 第二版按评审 m5 改成「**冗余格：捕获集是下面那格的真子集**」，
   *   **而那句是假的**（定向复评，实测）。反例是一个**按下标写死可用性**
   *   的坏实现 `available: (i === 2)`：`FOUR_PROTOCOLS[2]` 正好是 `gamma`，
   *   于是下面那格的期望 `[false, false, true, false]` **原样通过（绿）**，
   *   而这一格当场红。
   * ⇒ **它单独挡住的是「按位置写死可用性」这一类**，下面那格挡的是恒真 / 恒假 / 过滤三类。
   * 两边都不是对方的子集。
   * ⚠️ **上一版还把那句假话写进了用例名**——那是下一个人 `grep -F` 会捞到的东西，
   * 比写在注释里更糟。用例名已去掉「冗余格 / 真子集」。
   */
  it("对话模型的四个徽章 available 全 true —— 它单独挡住「按位置写死可用性」那一类坏实现", () => {
    const badges = protocolBadges(CHAT_MODEL, FOUR_PROTOCOLS) as Badge[];
    expect(badges.length).toBe(4);
    expect(badges.map((b) => b.available)).toEqual([true, true, true, true]);
  });

  /**
   * **一条用例里同时放进两种状态**（第 5 种假阳性的对策）：只占一条协议的模型
   * 在同一次调用里既有 `true` 又有 `false`，恒真 / 恒假 / 过滤三种坏实现一次全挡。
   */
  it("只占一条协议的模型：那一格 true、另外三格 false，四格全在 —— 一次挡住恒真、恒假与过滤三种坏实现", () => {
    const badges = protocolBadges({ ...IMAGE_MODEL, protocols: ["gamma"] }, FOUR_PROTOCOLS) as Badge[];
    expect(badges.map((b) => b.available)).toEqual([false, false, true, false]);
  });

  /**
   * **契约档：夹具直接用真源。**
   *
   * 面板显示的可用性与 `geminiModelList()` 交出去的 `supportedGenerationMethods`
   * 不一致，**这是刻意的**：后者对全部 12 个模型一律声明支持 generateContent，
   * 包括那个视频模型。面板按真实可用性画，那条对外契约的不实登记另行处置。
   * 这一格钉的就是「面板不许照抄那份不实」。
   */
  it("图片模型与视频模型在四条对话协议上全不可用 —— 面板不许照抄 gemini 模型列表那份不实", () => {
    const payload = catalogPayload();
    const protocols = catalogProtocols(payload)!;
    const models = catalogModels(payload)! as ModelRow[];
    // 前置条件：真源里确实有这三类模型，否则下面这一格什么都没验到。
    expect(protocols.length, "前置条件：真源里得有四条协议").toBe(4);

    for (const m of models) {
      const badges = protocolBadges(m, protocols) as Badge[];
      // 四格恒在，**每一个模型都是**——不是只有那几个被点名的。
      expect(badges.length, `${m.id} 的徽章不是四个`).toBe(4);
      const availableCount = badges.filter((b) => b.available).length;
      // 手写字面量：对话模型 4，媒体模型 0。**没有第三种答案**。
      expect(availableCount, `${m.id} 的可用协议数不对`).toBe(m.modality === "chat" ? 4 : 0);
    }
    // 反向自检：上面那个循环在 `models` 是空数组时恒绿。
    expect(models.map((m) => m.modality).sort()).toEqual([
      "chat", "chat", "chat", "chat", "chat", "chat",
      "image", "image", "image", "video", "video", "video",
    ]);
  });
});

describe("按协议筛选", () => {
  /**
   * **变红条件**：把 `filterByProtocol` 的 `m.protocols.includes(protocolId)` 改成
   * `true` ⇒ 媒体模型也会出现在筛选结果里。
   */
  it("按协议筛选时图片/视频模型一个都不出现 —— 它们的 protocols 是空数组", () => {
    const payload = catalogPayload();
    const models = catalogModels(payload)! as ModelRow[];
    // 协议 id 手写字面量（**不从 `catalogProtocols()` 取第一个**：那样写的话
    // 真源改掉协议 id 时这一格会跟着改，等于没有锚）。
    const rows = filterByProtocol(models, "anthropic") as ModelRow[];
    // 手写字面量：真源今天六个对话模型，筛出来的必须全是 chat，一个媒体模型都不许有。
    expect(rows.map((m) => m.modality), "媒体模型混进了对话协议的筛选结果")
      .toEqual(["chat", "chat", "chat", "chat", "chat", "chat"]);
    expect(rows.length).toBe(6);
  });

  /**
   * 「全部」那一档**原样返回**，不是「用一个恒真的判据筛一遍」。
   * **变红条件**：把 `if (!protocolId) return models;` 删掉 ⇒ 空串会走进
   * `includes("")` ⇒ 一行都不剩，整张表在默认档下就是空的。
   */
  it("不传 protocolId 时原样返回全部模型 —— 「全部」那一档不是一次筛选", () => {
    const models = catalogModels(catalogPayload())! as ModelRow[];
    expect(filterByProtocol(models, ""), "空串被当成了一个协议 id").toBe(models);
    expect(filterByProtocol(models, null), "null 被当成了一个协议 id").toBe(models);
    // 手写下界：真源今天十二个模型，全部那一档一个都不许少。
    expect(models.length).toBe(12);
  });

  it("表外的协议 id 筛出空清单 —— 不是悄悄退回「全部」", () => {
    const models = catalogModels(catalogPayload())! as ModelRow[];
    expect(filterByProtocol(models, "no-such-protocol")).toEqual([]);
  });
});

describe("响应窄化：读不出来 ≠ 空清单", () => {
  /**
   * ⚠️ 「这个网关一条协议都没有」与「这份响应读不出来」是两句话，而空数组会让
   * 矩阵变成**零列**——在屏幕上与「读不出来」长得一样。
   * **变红条件**：把 `catalogProtocols` 里两处 `return null` 改成 `continue`。
   */
  it("protocols 不是数组时判成读不出来，不是空清单 —— 零列的矩阵与读不出来长得一样", () => {
    expect(catalogProtocols({ protocols: null, models: [] })).toBe(null);
    expect(catalogProtocols({ models: [] })).toBe(null);
    expect(catalogProtocols(null)).toBe(null);
    expect(catalogProtocols("not an object")).toBe(null);
    // 数组本身不是一份响应体。
    expect(catalogProtocols([])).toBe(null);
  });

  it("协议清单里混进一条缺 label 的记录 ⇒ 整份判成读不出来，不是把那条跳过", () => {
    const bad = { protocols: [{ id: "alpha", label: "Alpha" }, { id: "beta" }], models: [] };
    // 跳过坏的那条之后面板会**少画一列而看起来完全正常**——运维得不到任何信号，
    // 而少的那一列是一条真的能用的协议入口。
    expect(catalogProtocols(bad), "坏记录被跳过了 —— 少画一列不会有任何信号").toBe(null);
  });

  it("模型清单里混进一条缺 endpoints 的记录 ⇒ 整份判成读不出来", () => {
    const good = { method: "POST", path: "/probe/x" };
    expect(catalogModels({ models: [{ id: "a", modality: "chat", protocols: [], endpoints: [good] }] }))
      .toEqual([{ id: "a", modality: "chat", protocols: [], endpoints: [good] }]);
    expect(catalogModels({ models: [{ id: "a", modality: "chat", protocols: [] }] })).toBe(null);
    expect(catalogModels({ models: [{ id: "a", modality: "chat", protocols: [], endpoints: [{ method: "POST" }] }] }))
      .toBe(null);
    expect(catalogModels({ models: [{ modality: "chat", protocols: [], endpoints: [] }] })).toBe(null);
    expect(catalogModels({ models: [{ id: "a", modality: "chat", protocols: [1], endpoints: [] }] })).toBe(null);
  });

  /**
   * ⚠️ **`modality` 只要求是字符串，不许限定成三个已知值**：限定成白名单等于
   * 「真源多一个形态 ⇒ 面板整张表读不出来」，那是让一个新增值把面板打死。
   * 表外的值怎么显示由 `modalityLabelKey()` 决定（照实显示原值）。
   */
  it("没见过的 modality 不会让整份目录判成读不出来 —— 一个新增值不该把面板打死", () => {
    const rows = catalogModels({ models: [{ id: "a", modality: "audio", protocols: [], endpoints: [] }] });
    expect(rows).toEqual([{ id: "a", modality: "audio", protocols: [], endpoints: [] }]);
  });

  /**
   * 窄化交出来的是**拷贝**，不是响应里那个对象本身：板块改了它不该影响别处。
   * **变红条件**：把 `out.push({ id: m.id, … })` 改成 `out.push(m)`。
   */
  it("窄化交出来的 protocols 是拷贝 —— 板块拿到的东西不该和响应体共用一个数组", () => {
    const body = { models: [{ id: "a", modality: "chat", protocols: ["x"], endpoints: [] }] };
    const rows = catalogModels(body)!;
    expect(rows[0]!.protocols).toEqual(["x"]);
    expect(rows[0]!.protocols).not.toBe(body.models[0]!.protocols);
  });

  it("真源那份响应体能被完整窄化 —— 窄化判据与真源的形状对不上时它会静默判成读不出来", () => {
    const payload = catalogPayload();
    expect(catalogProtocols(payload), "真源的 protocols 被自己的窄化判据拒了").not.toBe(null);
    expect(catalogModels(payload), "真源的 models 被自己的窄化判据拒了").not.toBe(null);
  });
});

describe("形态 → 文案 key", () => {
  /**
   * ⚠️ **一律字面量，禁止把形态名拼进 key**（全局约束 12）。
   *
   * ⚠️⚠️ **上一版这里两句都作废了，订正如下**（复评发现）：
   * 上一版写着「i18n 门禁只认 `t("…")` 与 `data-i18n` 属性两种形态，
   * `elI18n(tag, key)` 它一个都看不见」，用例名还写着「动态拼 key 会让三道 i18n 门禁一起哑」。
   * · 后来第 ① 条是**抠完注释的命名空间广扫**（单双引号都扫）
   *   ⇒ `elI18n(tag, key)` 那一族它认得，拼错一个字母当场 exit 1；
   * · 再后来第 ④ 条是**硬错** ⇒ 真把形态名拼进 key，这三个 key 会落进
   *   「未被引用」并把 CI 打红，**而红的是三个正在用的 key** ——
   *   顺着报文去「清理未被引用的 key」删掉的就是活文案。
   * ⇒ **别拼的理由今天比当初更硬，不是更软。** 另一层是
   * `tests/unit/i18n-dict.test.ts` 的
   * 「板块里当参数传的 i18n key（elI18n / labelKey 这类）同样必须在字典里」那一格。
   */
  it("三个已知形态各自映射到一个手写字面量 key —— 动态拼 key 会把这三个活 key 打成硬错", () => {
    expect(modalityLabelKey("chat")).toBe("models.modality.chat");
    expect(modalityLabelKey("image")).toBe("models.modality.image");
    expect(modalityLabelKey("video")).toBe("models.modality.video");
  });

  /**
   * **fail-open**：表外的值返回 `null`，调用方照实显示原值。
   * 真源哪天多一个 modality，面板会把那个生词原样画出来，
   * **而不是把它说成「对话」**。
   */
  it("形态表外的值返回 null —— 调用方照实显示原值，不冒充任何一档已知形态", () => {
    expect(modalityLabelKey("audio")).toBe(null);
    expect(modalityLabelKey("")).toBe(null);
    expect(modalityLabelKey(undefined)).toBe(null);
  });

  /**
   * **真源里今天的每一个 modality 都在表里。**
   * 少了这一格的话，上面两格在「真源新增了一个形态」时**一条都不会红**，
   * 而面板会在类型那一列上画出一个裸的英文词。
   * 这一格红了不是坏事：把新形态的五语言补进字典、在 `modalityLabelKey` 里加一行。
   */
  it("真源里出现过的每一个 modality 都在表里 —— 少一个的话面板会画出一个裸英文词", () => {
    const models = catalogModels(catalogPayload())! as ModelRow[];
    const missing = models.filter((m) => modalityLabelKey(m.modality) === null).map((m) => m.modality);
    expect(missing, "真源里有这些形态，而 modalityLabelKey 不认识它们").toEqual([]);
  });
});

/**
 * **上游那份清单的取值判定**（`admin-ui/js/pure/models.mjs` 的 `upstream*` 一族）。
 *
 * ⚠️ 这一族与上面那几格测的是两件事：上面是「本网关支持什么」，这里是
 * 「上游账号此刻回了什么」。**两份并存**，理由全文在
 * `src/core/admin/upstream-models.ts` 的文件头。
 */
type UpView = { ids: string[]; truncated: boolean; onlyUpstream: string[]; onlyCatalog: string[] };

const FULL: UpView = { ids: ["a"], truncated: false, onlyUpstream: [], onlyCatalog: ["b"] };

describe("upstreamModelsView：四个字段一个都不许缺", () => {
  /**
   * ⚠️ **缺字段一律 `null`，不是「补一个默认值」。**
   * `truncated` 缺了补 `false` 会把「还有一截没给你看」说成「上游就这些」；
   * 两个差集缺了补 `[]` 会把「我们没算」说成「两边一致」——**都是凭空造出来的事实**。
   */
  it.each([
    ["不是对象", 42],
    ["是数组", [FULL]],
    ["truncated 不是布尔", { ...FULL, truncated: "no" }],
    ["ids 不是字符串数组", { ...FULL, ids: [1] }],
    ["缺 onlyUpstream", { ids: FULL.ids, truncated: false, onlyCatalog: [] }],
    ["缺 onlyCatalog", { ids: FULL.ids, truncated: false, onlyUpstream: [] }],
  ])("%s ⇒ null", (_name, models) => {
    expect(upstreamModelsView(models)).toBeNull();
  });

  it("四个字段齐全时逐条窄化，且不与入参共享数组", () => {
    const src = { ids: ["a"], truncated: true, onlyUpstream: ["a"], onlyCatalog: ["b"], extra: 1 };
    const v = upstreamModelsView(src) as UpView;
    expect(v).toEqual({ ids: ["a"], truncated: true, onlyUpstream: ["a"], onlyCatalog: ["b"] });
    src.ids.push("mutated");
    expect(v.ids, "窄化结果与入参共享了同一个数组").toEqual(["a"]);
  });
});

describe("upstreamResultCode / upstreamTransportCode：两个函数各管一半", () => {
  it.each([
    ["no_key"], ["upstream_error"], ["bad_payload"], ["timeout"], ["network_error"],
    // 正文阶段那一档：响应头已经落地、正文没有。它与上面四条各是各的一句话。
    ["body_incomplete"],
  ])("200 响应体里的 reason「%s」有自己的一档", (reason) => {
    expect(upstreamResultCode({ ok: false, status: null, reason })).toBe(reason);
  });

  /**
   * ⚠️ **表外的 reason 落 `mismatch`，不许落进任何一档「上游怎么了」。**
   * 落进 `upstream_error` 的后果是面板对运维说「上游出错了」，
   * 而真相可能是后端换了个我们还没跟上的结果码。
   */
  it("面板不认识的 reason ⇒ mismatch，而不是冒充一档已知原因", () => {
    expect(upstreamResultCode({ ok: false, status: null, reason: "brand_new_reason" })).toBe("mismatch");
  });

  /**
   * ⚠️⚠️ **`ok: true` 但那份清单读不出来时也是 `mismatch`，不是 `ok`。**
   * 判成 `ok` 的话，板块会拿着一个 `null` 去画卡片——终局要么整屏崩，
   * 要么画出一张空卡，而空卡说的是「上游一个模型都没回」。
   */
  it("ok 为真但 models 形状不认识 ⇒ mismatch，不是 ok", () => {
    expect(upstreamResultCode({ ok: true, status: 200, reason: null, models: { ids: ["a"] } }))
      .toBe("mismatch");
  });

  it("ok 为真且形状对得上 ⇒ ok", () => {
    expect(upstreamResultCode({ ok: true, status: 200, reason: null, models: FULL })).toBe("ok");
  });

  /**
   * ⚠️ **判据是顶层 `reason` 而不是状态码**：护栏在同一个 429 下产出两种拒绝，
   * 处置完全不同（等它回来 / 稍后再试）。只看 429 会把两者合成一句话。
   */
  it.each([
    ["护栏说上一次还在飞", { status: 429, body: { reason: "probe_in_flight" } }, "probe_in_flight"],
    ["护栏说间隔没过", { status: 429, body: { reason: "probe_cooldown" } }, "probe_cooldown"],
    ["管理会话没了", { status: 401, body: null }, "unauthorized_admin"],
    ["别的 429（表外）", { status: 429, body: { reason: "something_else" } }, "transport_error"],
  ])("%s ⇒ %s", (_name, err, expected) => {
    expect(upstreamTransportCode(err)).toBe(expected);
  });
});

/**
 * **后端会产出的每一条 reason，面板都得认得。**
 *
 * ⚠️ 这一组扫的是后端源码，不是一份手抄的清单：后端加一种 reason 是一行 diff，
 * 而「面板没跟上」在本仓的出站探测护栏那一轮真实发生过一次。
 *
 * ⚠️ **这个扫描器与 `tests/ui/keys-write.test.ts`
 *「扫描器先在真文件上对得上；它读不懂的两种书写形态一律不许出现 —— 探针不许探在会过的那一侧」
 * 里那个不是同一个，刻意的**：那一份还带着「读不懂的书写形态一律不许出现」的反向表
 *（它守的是验活那两个文件），这里只需要「literals 与 dynamic 各是什么」，
 * 并且把两者都**钉到手写的期望值上**
 * ——后端换一种写法时这里会当场红，而不是静默漏扫。
 */
function upstreamReasonSites(src: string): { literals: string[]; dynamic: string[] } {
  const literals = new Set<string>();
  const dynamic: string[] = [];
  for (const m of stripComments(src).matchAll(/\breason:\s*([^,\n}]*)/g)) {
    const expr = m[1]!.trim();
    if (expr === "" || expr === "null") continue;
    const found = [...expr.matchAll(/"([A-Za-z0-9_]+)"/g)].map((x) => x[1]!);
    if (found.length === 0) { dynamic.push(expr); continue; }
    for (const f of found) literals.add(f);
  }
  return { literals: [...literals].sort(), dynamic };
}

describe("后端产出的 reason × 面板认得的 reason", () => {
  it("列模型那条 handler 的每一条 reason 面板都有一档 —— 认不得的会被说成「面板还不认识」，而这一格要求根本别走到那里", () => {
    const sites = upstreamReasonSites(readFileSync("src/http/admin/handlers/upstream-models.ts", "utf8"));
    // 手写期望值：后端多一条 / 少一条都在这里当场红。
    expect(sites.literals).toEqual(
      ["bad_payload", "body_incomplete", "network_error", "no_key", "timeout", "upstream_error"],
    );
    // 唯一动态的那一处是护栏那条 429，它走的是 `upstreamTransportCode()` 那一半（下一格）。
    expect(sites.dynamic).toEqual(["g.reason"]);

    const unmapped = sites.literals.filter((r) => upstreamResultCode({ ok: false, reason: r }) === "mismatch");
    expect(unmapped, "后端会产出这些 reason，而面板还没给它们文案").toEqual([]);

    const keys = sites.literals.map((r) => upstreamLabelKey(upstreamResultCode({ ok: false, reason: r })));
    expect(new Set(keys).size, "两条 reason 共用了同一句文案").toBe(sites.literals.length);
  });

  it("护栏那两条 reason 面板也都有一档 —— 它们与验活共用同一把护栏", () => {
    const sites = upstreamReasonSites(readFileSync("src/http/admin/probe-guard.ts", "utf8"));
    expect(sites.literals).toEqual(["probe_cooldown", "probe_in_flight"]);
    const unmapped = sites.literals
      .filter((r) => upstreamTransportCode({ status: 429, body: { reason: r } }) === "transport_error");
    expect(unmapped, "护栏会产出这些 reason，而面板把它们当成了一次说不出所以然的失败").toEqual([]);
  });

  /**
   * ⚠️ **按名字锚扫源码，不是行为断言**：拼出来的 key 与写死的 key 在行为上可以
   * 逐字节相同，而三道 i18n 门禁里有两道只认字面量（全局约束 12）。
   */
  it("每一个 code 的 i18n key 都以字面量出现在源码里，并且都在字典里", () => {
    const src = readFileSync("admin-ui/js/pure/models.mjs", "utf8");
    const codes = [
      "ok", "no_key", "upstream_error", "bad_payload", "timeout", "network_error",
      "mismatch", "probe_in_flight", "probe_cooldown", "unauthorized_admin", "transport_error",
    ];
    const keys = codes.map((c) => upstreamLabelKey(c));
    expect(new Set(keys).size, "两个 code 共用了同一个 key").toBe(codes.length);
    for (const k of keys) {
      expect(src.includes(`"${k}"`), `${k} 不是以字面量出现的`).toBe(true);
      expect(k in I18N, `${k} 不在字典里`).toBe(true);
    }
  });

  /**
   * ⚠️ **`upstreamLabelKey()` 交出来的 key 一个都不许带 `{占位符}`。**
   * 它们在源码里的形态是 `return "…";`（后面跟的是 `;` 不是 `,`），而
   * `scripts/check-i18n.mjs` 第 ⑧ 条正是拿「后面紧跟着什么」当判据 ⇒ 真带了占位符，
   * 那道门禁当场 exit 1。这一格把那条约束钉在字典这一侧，别等门禁去发现。
   */
  it("这一族 key 五种语言里一个 {占位符} 都没有 —— 它们是不带参数的裸标签", () => {
    const codes = ["ok", "no_key", "upstream_error", "bad_payload", "timeout", "network_error",
      "mismatch", "probe_in_flight", "probe_cooldown", "unauthorized_admin", "transport_error"];
    const dict = I18N as unknown as Record<string, Record<string, string>>;
    const bad: string[] = [];
    for (const c of codes) {
      const k = upstreamLabelKey(c);
      for (const [lang, s] of Object.entries(dict[k]!)) if (/\{\w+\}/.test(s)) bad.push(`${k}/${lang}`);
    }
    expect(bad).toEqual([]);
    // 反向自检：判据不瞎 —— 带占位符的那三个 key 确实被它认出来。
    for (const k of ["models.up.listLabel", "models.up.truncated", "models.up.status"]) {
      expect(Object.values(dict[k]!).some((s) => /\{\w+\}/.test(s)), `${k} 应当带占位符`).toBe(true);
    }
  });
});
