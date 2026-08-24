import { describe, it, expect } from "vitest";
import {
  protocolBadges, filterByProtocol, catalogProtocols, catalogModels, modalityLabelKey,
} from "../../admin-ui/js/pure/models.mjs";
import { catalogPayload } from "../../src/core/admin/protocol-catalog.js";

/**
 * **模型板块的取值判定（P3d Task 6 Step 2）。**
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
   * **变红条件（M1，已实测）**：把 `protocolBadges` 的 `protocols.map(...)` 改成
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
   *   **而那句是假的**（P3d Task 6 定向复评 F3，实测）。反例是一个**按下标写死可用性**
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
   * 不一致，**这是刻意的**：后者对全部 4 个模型一律声明支持 generateContent，
   * 包括那个视频模型。面板按真实可用性画，那条对外契约的不实登记给 P4。
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
    expect(models.map((m) => m.modality).sort()).toEqual(["chat", "image", "image", "video"]);
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
    expect(rows.map((m) => m.modality), "媒体模型混进了对话协议的筛选结果").toEqual(["chat"]);
    expect(rows.length).toBe(1);
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
    // 手写下界：真源今天四个模型，全部那一档一个都不许少。
    expect(models.length).toBe(4);
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
   * ⚠️ **一律字面量，禁止把形态名拼进 key**（P3d 全局约束 12）。
   *
   * ⚠️⚠️ **上一版这里两句都随 P3e 作废了，订正如下**（Task 4 复评 F1）：
   * 上一版写着「i18n 门禁只认 `t("…")` 与 `data-i18n` 属性两种形态，
   * `elI18n(tag, key)` 它一个都看不见」，用例名还写着「动态拼 key 会让三道 i18n 门禁一起哑」。
   * · P3e Task 3 起第 ① 条是**抠完注释的命名空间广扫**（单双引号都扫）
   *   ⇒ `elI18n(tag, key)` 那一族它认得，拼错一个字母当场 exit 1；
   * · P3e Task 4 起第 ④ 条是**硬错** ⇒ 真把形态名拼进 key，这三个 key 会落进
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
