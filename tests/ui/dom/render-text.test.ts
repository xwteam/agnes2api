import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE, LANG_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import { I18N } from "../../../admin-ui/js/i18n-dict.js";
import { catalogPayload } from "../../../src/core/admin/protocol-catalog.js";
import { EDITABLE_FIELDS, SECRET_FIELDS } from "../../../src/core/admin/config-validate.js";
import { emptyBucket } from "../../../src/core/admin/usage-stats.js";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **B1 目标 ⑤：五种语言 × 七个板块，渲染出来的字里零裸 key、零未替换的 `{}`。**
 *
 * ⚠️ **「七个板块 × 字典全部命名空间」是后来扩出来的，扩之前是「三个板块 ×
 * 手写 8 个命名空间」。** 扩容的直接理由是一次实测：`elI18n('h2','usage.titel')`
 * 这种拼写错误在当时**全仓用例 + 六道脚本门禁下一格都不红**，而同一个错误换成
 * `ov.titel` 当场红 5 格——差别只在于命名空间在不在那张手写表里、板块在不在那三个里。
 * 于是这里两头都改成从真源派生 / 逐个板块列全（见 `BARE_KEY` 与 `SECTIONS` 两段）。
 *
 * ⚠️ **这一组正是"输出层预言机"那条论据的落点。** 本仓已经栽过两次同型：
 * · 已上线的 `{count}` 泄漏：面板上出现「被环境变量锁定的字段数：{count}: …：1」。
 *   `scripts/check-i18n.mjs` 为它补了第 ⑧ 条**源码文本**判据，而那条判据第一版
 *   只认双引号——把同一个缺陷换成单引号原样重放，门禁 exit 0、零报错。
 * · `elI18n("h2", "ov.title")` 打成 `"ov.titel"`：**当时三道 i18n 门禁全部沉默**，
 *   概览页主标题在五种语言下原样显示 `ov.titel`。
 *   ⚠️ **这一条记的是当时的状况，别当现状读**（复评补登记）：
 *   `scripts/check-i18n.mjs` 的第 ① 条后来换成了抠完注释的命名空间广扫
 *   ⇒ 同一个变异今天当场 exit 1。**但它证明的那件事没有变**——那次补救靠的是
 *   又一条源码文本判据，而源码文本判据每一次都要先猜对缺陷的语法。
 *
 * **源码文本门禁必须猜缺陷长成什么语法；渲染文本断言不用猜。** 不管 key 是拼错的、
 * 是动态拼出来的、还是参数忘了传，只要屏幕上出现了运维读不懂的字，这里就红。
 *
 * 边界（明写）：它证明的是"没有明显是给机器看的记号漏到屏幕上"，
 * **不证明译文准确、也不证明句子通顺**——那两层留给评审。
 */
const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;
const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"] as const;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/**
 * 一个**有数据**的用量桶。形状从后端真源 `emptyBucket()` 派生、只覆盖数字，
 * 不手抄第二份字段清单（`catalogPayload()` 那条纪律）：后端往 `UsageBucket` 里
 * 加一栏时这份夹具自动补 0，不会出现「板块多渲染了一栏、而夹具里根本没有那一栏」。
 */
function usageBucket() {
  return {
    ...emptyBucket(),
    requests: 100, success: 90, errors: 10, tokensIn: 4000, tokensOut: 2500,
    streamingRequests: 30, latencySum: 24_000, latencyCount: 80,
  };
}

/**
 * `GET /admin/api/config` 的一份应答。
 *
 * **字段清单从后端真源 `EDITABLE_FIELDS` / `SECRET_FIELDS` 派生，不手抄第二份。**
 * 手抄那份（`tests/ui/dom/settings-save.test.ts` 里有一份 24 行的）会与后端悄悄漂：
 * 后端新增一个可编辑字段时，设置页多出一格、而这道预言机还在拿旧清单渲染，
 * 于是新那一格的文案**在这里天然不可观测**。
 *
 * `effective` 一律给 `null`（渲染成 EM DASH）：这道预言机看的是**标签与说明文字**，
 * 不是值本身；给值反而要在这里复刻一份「每个字段是什么类型」的知识（第二份判据）。
 */
function configBody(): unknown {
  const fields: Record<string, unknown> = {};
  for (const path of EDITABLE_FIELDS) {
    if (SECRET_FIELDS.includes(path)) continue;
    fields[path] = { stored: null, env: null, effective: null, lockedBy: null };
  }
  const credentials: Record<string, unknown> = {};
  for (const path of SECRET_FIELDS) {
    credentials[path] = { configured: true, hint: "wxyz", lockedBy: null };
  }
  return {
    fields, credentials, configDegraded: false,
    editable: EDITABLE_FIELDS, secrets: SECRET_FIELDS,
    propagation: { configTtlMs: 30_000, kvEdgeCacheMs: 60_000, visibilityUpperBoundMs: 90_000 },
  };
}

/** 一份"什么都齐全"的后端响应：让每个板块都走到有数据的分支。 */
function respond(url: string): { status: number; body: unknown } {
  if (url.startsWith("/admin/api/overview")) {
    return {
      status: 200,
      body: {
        version: "0.1.0",
        serverTime: NOW,
        runtime: { name: "node" },
        process: { rssBytes: 42_000_000, uptimeMs: 3_600_000, pid: 7 },
        pool: { total: 4, fresh: 2, cooling: 1, evicted: 1 },
        poolStats: { requests: 100, success: 90, failed: 7, clientErrors: 3, approximate: true },
        storage: { backend: "file", writable: true, checkedAt: NOW },
        freshness: {
          poolCacheTtlMs: 60_000, poolVisibilityUpperBoundMs: 120_000,
          poolTouchIntervalMs: 21_600_000, configTtlMs: 30_000,
          configVisibilityUpperBoundMs: 90_000, kvEdgeCacheMs: 60_000,
        },
        config: {
          registrarEnabled: true, primary: "a.example.com", fallback: "b.example.com",
          targetKeys: 20, envLocked: ["maxStrikes"], degraded: true,
        },
      },
    };
  }
  if (url.startsWith("/admin/api/capabilities")) {
    return {
      status: 200,
      body: {
        version: "0.1.0",
        runtime: { name: "node", colo: null },
        storage: { writable: true },
        // 用量板块靠它决定走「二档统计」那条有内容的分支；缺了它整页只剩一句提示。
        stats: { tier2Enabled: true, flushIntervalMs: 60_000, tokensCoverage: ["anthropic", "responses"] },
      },
    };
  }
  // 协议目录：**交出真源那一份**（第 7 种假阳性：测的是抄件不是原件）。
  // 模型 / Playground / 设置页第 4 张卡 / 用量的协议名都从这一支来。
  if (url.startsWith("/admin/api/models")) return { status: 200, body: catalogPayload() };
  if (url.startsWith("/admin/api/config")) return { status: 200, body: configBody() };
  if (url.startsWith("/admin/api/usage")) {
    return {
      status: 200,
      body: {
        tier: "tier2", timezone: "UTC", approximate: true, generatedAt: NOW,
        range: { from: NOW - 86_399_999, to: NOW, clamped: false },
        days: [{ date: "2026-08-21", total: usageBucket() }],
        total: usageBucket(),
        shards: 3, malformed: 0,
        pending: { count: 0, ms: 0, budgetExhausted: false },
        note: null,
      },
    };
  }
  if (url.startsWith("/admin/api/keys")) {
    return {
      status: 200,
      body: {
        items: [{
          id: "abc12345", masked: "sk-ab…mnop", seq: 1, bucket: "cooling",
          addedAt: NOW - 86_400_000, lastUsedAt: NOW - 3_600_000,
          cooldownUntil: NOW + 60_000, cooldownReason: "429", evictedReason: null, strikes: 2,
          stats: { requests: 10, success: 8, failed: 1, clientErrors: 1, lastErrorAt: NOW, lastErrorKind: "429" },
        }],
        counts: { all: 1, fresh: 0, cooling: 1, evicted: 0 },
        page: 1, pages: 1, size: 20, total: 1, generatedAt: NOW, approximate: true,
      },
    };
  }
  if (url.startsWith("/admin/api/events")) {
    return {
      status: 200,
      body: {
        items: [
          { ts: NOW, level: "warn", event: "pool.cooldown", msg: "一把 key 进冷却", fields: { id: "abc" }, corr: null },
          { ts: NOW - 1, level: "bogus", event: "x.y", msg: "", fields: null, corr: null },
        ],
        cursor: NOW, cursorAhead: true, dropped: 3, budgetExhausted: true,
        truncated: true, buffered: 2, shardId: "shard-1", generatedAt: NOW,
      },
    };
  }
  return { status: 200, body: {} };
}

/**
 * 一棵子树里所有**真正显示给人看**的文本片段。
 *
 * ⚠️ **射程登记（实测，别读成「`data-i18n-ph` / `data-i18n-title` 有人守了」）**：
 * 下面确实收 `title` / `aria-label` / `placeholder` 三个属性，所以那两个标记**渲染出来的值**
 * 在这七个板块里是被看着的——把 `pg.prompt.placeholder` 两处一起打错成
 * `pg.prompt.placeholdr`，这里当场红 5 格（落点 `playground <textarea placeholder>`）。
 * **但只打错 `data-i18n-ph=` 那一处、留着紧跟其后的 `setAttribute("placeholder", t(…))`
 * 不动，这里一格都不红**（`admin-ui/js/sec-playground.js` 504/505 就是这个形状，
 * `sec-events.js` 312/313 同形）：首屏走的是那句直调 `t()`，属性上的那份只在**切语言**
 * 时才被读到，而本文件只在概览板块切过一次语言。
 * ⇒ 那一半今天**仍然无人守**，处置在交接清单里（给两个变体各加正向探针）。
 */
function visibleTexts(root: FakeElement): Array<{ text: string; where: string }> {
  const out: Array<{ text: string; where: string }> = [];
  for (const el of root.walk()) {
    // 只取叶子节点自己的那段文本（父节点的 textContent 是子节点拼起来的，重复计）。
    if (el.children.length === 0 && el.textContent.trim() !== "") {
      out.push({ text: el.textContent, where: `<${el.tagName}>` });
    }
    // tooltip / aria-label 同样是给人读的字。
    for (const attr of ["title", "aria-label", "placeholder"]) {
      const v = el.getAttribute(attr);
      if (v !== null && v.trim() !== "") out.push({ text: v, where: `<${el.tagName} ${attr}>` });
    }
  }
  return out;
}

/**
 * 一段文本看起来像不像"没被翻译的 i18n key"。
 *
 * ⚠️ **命名空间从字典派生，不再手写。** 手写那版只有 8 个前缀（漏了 set / usage / models / pg），
 * 于是 `elI18n('h2','usage.titel')` 这种拼写错误在全仓用例 + 六道脚本门禁下
 * **一格都不红**，而用量板块主标题会在五种语言下原样显示 `usage.titel`。
 * 派生之后「加了新板块忘了回来表态」这个失效形态从源头消失，
 * 而**它有没有真的消失**由本文件那条反向自检（从字典出发逐个 ns 取样）钉着。
 *
 * ⚠️ **边界，扩容后原样保留、不许升格**（**与文件头末尾那条是同一条，不是两条**——
 * 改一处必须改另一处）：这道预言机证明的只是
 * **「没有给机器看的记号漏到屏幕上」**——它**不证明**译文准确、不证明句子通顺。
 * 任何文档 / 报告里把它写成「措辞现在有机器核了」，就是本仓登记了二十余次的那类假话。
 */
const NS = [...new Set(Object.keys(I18N).map((k) => k.split(".")[0]!))].sort().join("|");
const BARE_KEY = new RegExp(`(?:^|\\s)(${NS})\\.[A-Za-z][A-Za-z0-9.]*(?:\\s|$)`);
/** 没被替换掉的插值记号。 */
const LEFTOVER_PLACEHOLDER = /\{[A-Za-z_][A-Za-z0-9_]*\}/;

/**
 * 逐个走一遍的板块，以及每个板块**至少**要渲染出多少段可见文字。
 *
 * ⚠️ **阈值逐板块单独给，不许共用一个数。** 共用时最松的那个会赢：某个板块的后端夹具
 * 写错、整块渲染不出来，它照样在别人的富文本掩护下过关——下面那个 `for` 循环对空板块
 * 恒绿，于是「这个板块被验过了」是假的（覆盖假象）。
 *
 * ⚠️ **每个数都是当场量出来再手写下来的字面量，不许写成 `texts.length - 1`**
 *（第 6 种假阳性：期望值从被测对象推导出来，于是永远成立）。
 * 实测值（zh-CN / zh-TW / en / ja / ko **五种语言逐一量过，同值**）：
 * overview 72 · keys 76 · events 30 · settings 117 · usage 52 · models 61 · playground 27。
 * 下面写的是略低于实测的整数——留一点余量给正常的文案增删，但离「渲染不出来」很远。
 *
 * ⚠️ **射程明写：它抓的是「整块没渲染出来」，不是「少了一张卡」。**
 * 实测：把 `/admin/api/models` 那一支改成返 500，底层数据是 `models` 从 61 掉到 7、
 * `playground` 从 27 掉到 7 两块一起掉，而 `settings` 只从 117 掉到 106 ——
 * **仍在 100 之上、这里不红**。
 * ⚠️ **但测试实际报出来的只有一格，不是两格**：下面这个 `for` 循环里 `expect(...)
 * .toBeGreaterThan(...)` 一失败就同步抛错，当场打断整个循环——`SECTIONS` 数组里
 * `models` 排在 `playground` 前面，于是 `models` 那次 `expect` 一红就把循环截断，
 * `playground` 那一轮的 `expect` 从未被跑到、五种语言各自只报出 `models` 一条失败
 * （已用不经过 `expect` 的独立探针核实过底层两块确实都掉到了 7，「数据两块都掉」和
 * 「测试报几格」是两件事，别混着读）。那次故障是被 `models` 这一格单独抓住的——
 * 顺着 `SECTIONS` 排在它后面的板块，只要它先红，一律没机会真正被断言到。
 *
 * ⚠️ **`registrar` 不在这里**：它是第八个板块，这一轮只扩到七个。
 * 少的那一个不是被判定为不需要，而是还没有做——别把这份清单读成「全部板块都覆盖了」。
 */
const SECTIONS = [
  { name: "overview", minTexts: 60 },
  { name: "keys", minTexts: 64 },
  { name: "events", minTexts: 24 },
  { name: "settings", minTexts: 100 },
  { name: "usage", minTexts: 44 },
  { name: "models", minTexts: 52 },
  { name: "playground", minTexts: 22 },
] as const;

describe("五语言 × 七板块：渲染出来的字里没有给机器看的记号", () => {
  for (const lang of LANGS) {
    it(`${lang}：七个板块渲染出的每一段文字都不是裸 key、也没有未替换的 {占位符}`, async () => {
      const h = await bootPanel({
        now: NOW,
        store: {
          [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [LANG_STORE]: lang,
        },
        respond,
      });
      await settle();

      // 逐个板块点进去，让七棵子树都真的被渲染过一遍。
      // ⚠️ **深度用缺省的 6，没有调大。** 扩到七个板块时先写成了 `settle(30)`，
      //    理由写的是「Playground 要串起 /models + /config 两条请求」——**实测是假的**：
      //    退回缺省 `settle()` 之后七个板块的可见文字数一段不少（72/76/30/117/52/61/27，
      //    与 30 那一版逐个相同、五种语言均如此）。既然那个数不承担任何东西就删掉它，
      //    留着只会让下一个人以为「这里有个时序问题，别动」。
      //    真有一天不够深了，`SECTIONS` 那张阈值表会当场红，不会静静放行。
      for (const { name } of SECTIONS) {
        h.dom.document.querySelectorAll(".nav-item")
          .find((b) => b.getAttribute("data-section") === name)!
          .click();
        await settle();
      }

      const offenders: string[] = [];
      for (const { name, minTexts } of SECTIONS) {
        const texts = visibleTexts(h.section(name));
        // 反向自检：某个板块一个字都没渲染出来时，下面的循环恒绿。阈值逐板块单独给，
        // 理由与实测值见 `SECTIONS` 上面那段。
        expect(
          texts.length,
          `${name} 板块只渲染出 ${texts.length} 段文字（低于实测下限 ${minTexts}）——` +
          `多半是这个板块的后端夹具写错、渲染走进了空分支，这一格什么都没验到`,
        ).toBeGreaterThan(minTexts);
        for (const { text, where } of texts) {
          if (BARE_KEY.test(text)) offenders.push(`${name} ${where} 裸 key: ${text}`);
          if (LEFTOVER_PLACEHOLDER.test(text)) offenders.push(`${name} ${where} 未替换的占位符: ${text}`);
        }
      }
      expect(
        offenders,
        `${lang} 下面板上出现了给机器看的记号。\n` +
        `处置①（绝大多数情况）：这是漏翻或 key 拼错 —— 去改被测源码，别改这道判据。\n` +
        `处置②：如果那一段确认是**上游 / 后端的字段名**被原样上屏（本仓真实存在的形态：` +
        `\`usage.output_tokens\` —— 它今天只出现在注释里，一旦以可见文本身份上屏就会落进这里），` +
        `处置是给那一处上屏文本包一层不可能被误认的外壳（加冒号、加空格分隔、或标成代码），\n` +
        `**不许往 BARE_KEY 里加豁免名单** —— 开一本豁免名册比没有这条规则更糟。`,
      ).toEqual([]);
    });
  }

  /**
   * **量具自检**：把一个真实的 key 打错一个字，上面那组必须变红。
   *
   * 没有这一格的话，`BARE_KEY` 正则写错（比如漏了一个命名空间）会让整组恒绿，
   * 而它恰恰是本仓「判据建在缺陷没采取的那个形态上」踩过两次的地方。
   * 这里直接对判据本身取样，不去改被测源码。
   */
  it("量具自检：判据认得出裸 key 与未替换的占位符", () => {
    expect(BARE_KEY.test("ov.titel")).toBe(true);
    expect(BARE_KEY.test("ev.level.debug")).toBe(true);
    // 这四条不是凑数：勘察实测 `usage.titel` 能躲过全仓用例 + 六道脚本门禁，
    // 而 `ov.titel` 当场红 5 格 —— 差别只在于命名空间在不在这张表里。
    expect(BARE_KEY.test(" usage.titel ")).toBe(true);
    expect(BARE_KEY.test(" pg.titel ")).toBe(true);
    expect(BARE_KEY.test(" set.titel ")).toBe(true);
    expect(BARE_KEY.test(" models.titel ")).toBe(true);
    expect(BARE_KEY.test("被环境变量锁定的字段数：{count}")).toBe(false);
    expect(LEFTOVER_PLACEHOLDER.test("被环境变量锁定的字段数：{count}")).toBe(true);
    // 反向：正常译文不许被误判。
    for (const key of ["ov.title", "ev.title", "keys.title"]) {
      for (const lang of LANGS) {
        const s = (I18N as Record<string, Record<string, string>>)[key]![lang]!;
        expect(BARE_KEY.test(s), `${key}/${lang} 被误判成裸 key`).toBe(false);
        expect(LEFTOVER_PLACEHOLDER.test(s), `${key}/${lang} 被误判成占位符残留`).toBe(false);
      }
    }
  });

  /**
   * **反向控制：判据放宽了，但它对仓里真实存在的译文不许乱红。**
   *
   * 命名空间从手写 8 个扩到字典全部 12 个（多了 `models` / `pg` / `set` / `usage`）
   * 是把判据**放宽**，而放宽的代价就是误伤。这一格拿**仓里真实存在的串**去问
   * 「你会不会把正常译文当成裸 key」——字典的每一条 × 每一种语言，一条不漏。
   * ⚠️ 自造样本挑不出这类缺陷：自造的容易挑「明显不像 key」的，
   * 真正会误伤的是**长得像 key 的合法串**，而合法串的全集恰恰就是字典本身。
   *
   * ⚠️ **这里只控 `BARE_KEY`，不控 `LEFTOVER_PLACEHOLDER`**：`{count}` / `{env}` 这类
   * 插值记号在字典里**本来就该有**（渲染时才被替换），拿它去扫字典是量错了东西——
   * 上面那一格里那三条 `LEFTOVER_PLACEHOLDER` 反向断言之所以只挑不带插值的标题，
   * 原因就在这。
   */
  it("反向控制：字典里每一条真实译文 × 五种语言，都不会被 BARE_KEY 误判成裸 key", () => {
    const dict = I18N as Record<string, Record<string, string>>;
    const offenders: string[] = [];
    for (const key of Object.keys(dict)) {
      for (const lang of LANGS) {
        const s = dict[key]![lang];
        if (typeof s === "string" && BARE_KEY.test(s)) offenders.push(`${key}/${lang}: ${s}`);
      }
    }
    expect(
      offenders,
      "这些是仓里真实存在的译文，却被这道预言机当成了漏翻的裸 key —— " +
      "判据放得太宽了，去改判据，别去改译文迁就它",
    ).toEqual([]);
  });

  /**
   * **反向自检：从字典出发，不是从表出发。**
   *
   * 上面那一格问的是「这四个命名空间认不认得」，它只覆盖**今天已知**的四个；
   * 这一格问的是「字典里的每一个命名空间认不认得」——**加了新板块没回来表态就红**。
   * 写法照 `tests/unit/i18n-dict.test.ts` 的**反向自检 ②**（那一条守的是
   * 那份手写 `NAMESPACES` 登记表；这一条守的是本文件这道渲染预言机的判据，
   * **两处各守各的，不是一处的抄件**）。
   */
  it("反向自检：字典里出现的每个命名空间都被 BARE_KEY 认得 —— 加了新板块没回来表态就红", () => {
    const offenders = [...new Set(Object.keys(I18N).map((k) => k.split(".")[0]!))]
      .filter((ns) => !BARE_KEY.test(` ${ns}.titel `));
    expect(offenders, "这些命名空间在字典里真的存在，却不在这道渲染预言机的判据里").toEqual([]);
  });

  /**
   * **切语言之后整页真的重绘。**
   *
   * `app.js` 的 `langchange` 处理器是「`apply(document)` + 重跑当前板块的
   * `onShow()`」。删掉其中任何一半，面板都会有一半文字停在旧语言上——
   * 而在这一格出现之前**没有任何东西会红**。
   */
  it("切语言之后当前板块的文字真的跟着换（两半接线都在）", async () => {
    const h = await bootPanel({
      now: NOW,
      store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [LANG_STORE]: "zh-CN" },
      respond,
    });
    await settle();
    const before = h.section("overview").textContent;
    expect(before, "前置条件：概览板块得先渲染出内容").not.toBe("");

    const sel = h.dom.byId("lang-select");
    sel.value = "en";
    sel.change();
    await settle();

    const after = h.section("overview").textContent;
    expect(after, "切语言之后概览板块的文字一点都没变").not.toBe(before);
    // 具体锚一句：英文标题必须真的出现。
    expect(after).toContain((I18N as Record<string, Record<string, string>>)["ov.title"]!.en!);
  });
});
