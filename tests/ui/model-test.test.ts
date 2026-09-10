import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  testableModels, initTestRows, withRowActive, withRowResult, testProgress,
  rowStatusLabelKey, modelTestBodyReasonCode, modelTestResultCode,
  modelTestTransportCode, modelTestLabelKey,
  TEST_MIN_INTERVAL_MS, nextTestDelayMs, testRoundMinSec,
} from "../../admin-ui/js/pure/model-test.mjs";
import { VERIFY_MIN_INTERVAL_MS } from "../../admin-ui/js/pure/keys-write.mjs";
import { PROBE_MIN_INTERVAL_MS } from "../../src/http/admin/probe-guard.js";
import { MODEL_CATALOG } from "../../src/core/admin/protocol-catalog.js";
import { I18N } from "../../admin-ui/js/i18n-dict.js";
import { stripComments } from "../helpers/strip-comments.js";

/**
 * **「模型测试」那张卡的取值判定与状态机**（`admin-ui/js/pure/model-test.mjs`）。
 *
 * ⚠️ **夹具分两类，与 `tests/ui/models.test.ts` 同一条纪律**：
 * · 「这个函数在不在看那个字段」这类**行为**断言用**手写**的最小夹具
 *   （手写才控得住「三种形态同时在场」这种必须同时出现的状态）；
 * · 「哪些真模型进得了这一轮」这类**契约**断言直接用真的 `MODEL_CATALOG`，
 *   **不手抄一份**（第 7 种假阳性：测的是抄件不是原件）。
 *
 * ⚠️ **期望值一律手写字面量**（第 6 种假阳性）：下面每一个数、每一个 id 都是手写的，
 * 不是从被测对象自己推导出来的——两边一起错时那种写法一声不吭。
 */

/** 本文件给 `.mjs` 返回值加的一层**局部形状标注**（`js/pure/*.mjs` 不做类型检查）。 */
type Row = {
  id: string;
  state: string;
  code: string | null;
  status: number | null;
  latencyMs: number | null;
};

/** 三种形态同时在场的最小夹具：**一个都不许少**，理由见下面第一格。 */
const MIXED_MODELS = [
  { id: "probe-chat-a", modality: "chat" },
  { id: "probe-image", modality: "image" },
  { id: "probe-chat-b", modality: "chat" },
  { id: "probe-video", modality: "video" },
];

describe("这一轮该测哪些模型", () => {
  /**
   * 🔴 **这一格守的是那条硬边界本身**：图片 / 视频模型一个都不许进这一轮。
   *
   * **变红条件（已实测）**：把 `testableModels` 的白名单
   *（`m.modality !== "chat"` 跳过）换成黑名单
   *（`m.modality === "image" || m.modality === "video"` 跳过）时这一格**仍然绿**
   * ——所以下面单独有一格喂一个表外形态，那一格才是白名单与黑名单的分水岭。
   * 本格挡的是「压根没筛」与「筛错了边」。
   *
   * ⚠️ **夹具必须三种形态都在**：只放对话模型的话，「筛」与「不筛」在数学上等价，
   * 这条不变量不可观测（本仓登记的第 5 种假阳性）。
   */
  it("只有对话模型进这一轮 —— 测一次图片模型会真的生成一张图，测一次视频模型会建任务并反复轮询", () => {
    // 手写 2：没筛的实现会交出 4 条，而那两条多出来的每一条都会真的花掉生成额度。
    expect(testableModels(MIXED_MODELS)).toEqual(["probe-chat-a", "probe-chat-b"]);
  });

  /**
   * **白名单与黑名单的分水岭。** 真源新增一个形态时：
   * · 白名单 ⇒ 那个新形态**暂时测不了**（代价已知，且是可见的一行都不出现）；
   * · 黑名单 ⇒ 那个新形态被**默认放行**，而放行的代价是未知的。
   */
  it("表外的形态不进这一轮 —— 白名单的代价是「暂时测不了」，黑名单的代价是「默认放行一个没人评估过的形态」", () => {
    expect(testableModels([{ id: "probe-new", modality: "audio" }])).toEqual([]);
  });

  it("形状读不出来的条目直接跳过，不会变成一行没有 id 的空行", () => {
    expect(testableModels([
      null, 42, { modality: "chat" }, { id: "", modality: "chat" }, { id: "ok", modality: "chat" },
    ])).toEqual(["ok"]);
    expect(testableModels("not-an-array"), "不是数组时交出空清单，不是抛").toEqual([]);
  });

  /**
   * **契约档：夹具直接用真源。** 目录里今天真有图片与视频模型
   *（`agnes-image-*` 三个、`agnes-video-*` 三个），它们一个都不许出现在这一轮里。
   */
  it("拿真的模型目录跑一遍：六个对话模型全进，三个图片与三个视频模型一个都不进", () => {
    const ids = testableModels(MODEL_CATALOG as unknown as Array<Record<string, unknown>>);
    // 手写期望值，**不是从 MODEL_CATALOG 推导的**。
    expect(ids).toEqual([
      "agnes-2.0-flash", "agnes-2.5-flash", "agnes-2.5-pro",
      "agnes-2.5-pro-alpha", "agnes-2.5-pro-beta", "agnes-3.0-flash",
    ]);
    expect(ids.filter((x) => x.includes("image") || x.includes("video")),
      "一个媒体模型都不许混进来 —— 每一个都会真的花掉生成额度").toEqual([]);
  });
});

describe("一轮测试的状态机", () => {
  const ids = ["m1", "m2", "m3"];

  it("初始三行全是 pending，两个数都是 null —— 「还没测过」不许被伪造成 0 毫秒", () => {
    const rows = initTestRows(ids) as Row[];
    expect(rows.map((r) => r.state)).toEqual(["pending", "pending", "pending"]);
    expect(rows.map((r) => r.latencyMs)).toEqual([null, null, null]);
    expect(rows.map((r) => r.status)).toEqual([null, null, null]);
    expect(rows.map((r) => r.code)).toEqual([null, null, null]);
  });

  /**
   * ⚠️ **一次调用里同时有「被改的那一行」与「没被改的那两行」**（第 5 种假阳性的对策）：
   * 「把所有行都标成 active」这种坏实现在只放一行的夹具下看不出来。
   */
  it("标成 active 只动那一行，别的行原样不动", () => {
    const rows = withRowActive(initTestRows(ids), "m2") as Row[];
    expect(rows.map((r) => r.state)).toEqual(["pending", "active", "pending"]);
  });

  it("找不到那个 id 时原样返回 —— 凭空插一行进去是把一个 bug 画成一条数据", () => {
    const rows = withRowActive(initTestRows(ids), "nope") as Row[];
    expect(rows.map((r) => r.id)).toEqual(["m1", "m2", "m3"]);
    expect(rows.map((r) => r.state)).toEqual(["pending", "pending", "pending"]);
  });

  it("回来了那一行收下 code / status / latencyMs，别的行还是 pending", () => {
    const rows = withRowResult(initTestRows(ids), "m1", "ok", 200, 412) as Row[];
    expect(rows[0]).toEqual({ id: "m1", state: "done", code: "ok", status: 200, latencyMs: 412 });
    expect(rows.slice(1).map((r) => r.state)).toEqual(["pending", "pending"]);
  });

  /**
   * ⚠️ **`latencyMs` 不许兜底成 0**：0 毫秒是一句关于链路的话（「快到没有耗时」），
   * 而「后端没给这个数」是一句关于我们自己的话。两者在屏幕上必须分得开
   *（`fmtCount(null)` 是破折号，`fmtCount(0)` 是 `0`）。
   */
  it("后端没给 latencyMs / status 时它们保持 null，不兜底成 0", () => {
    const rows = withRowResult(initTestRows(ids), "m1", "network_error", null, undefined) as Row[];
    expect(rows[0]!.latencyMs).toBe(null);
    expect(rows[0]!.status).toBe(null);
  });

  /**
   * **进度只数真回来了的那些。** 把在飞的那一行算进去，进度会在最后一次请求
   * 还没回来时就显示「全跑完了」，而那正是运维最需要知道「还在跑」的一刻。
   */
  it("进度只数 done，active 不算 —— 算上在飞的那一行，进度会提前显示成跑完了", () => {
    let rows = initTestRows(ids);
    expect(testProgress(rows)).toEqual({ done: 0, total: 3 });
    rows = withRowResult(rows, "m1", "ok", 200, 10);
    rows = withRowActive(rows, "m2");
    expect(testProgress(rows)).toEqual({ done: 1, total: 3 });
    rows = withRowResult(rows, "m2", "timeout", null, 8000);
    rows = withRowResult(rows, "m3", "ok", 200, 20);
    expect(testProgress(rows)).toEqual({ done: 3, total: 3 });
  });
});

describe("一行「结果」那一格说什么", () => {
  /**
   * ⚠️⚠️ **「还没测」「正在测」「测过了、没通」是三句话，一句都不许合并。**
   * 把没测过的说成没通，运维会去查一条根本没发生过的故障。
   */
  it.each([
    ["还没轮到它", { id: "m", state: "pending", code: null }, "models.test.pending"],
    ["正在打", { id: "m", state: "active", code: null }, "models.test.active"],
    ["回来了、通了", { id: "m", state: "done", code: "ok" }, "models.test.ok"],
    ["回来了、上游没正常回", { id: "m", state: "done", code: "upstream_error" }, "models.test.upstreamError"],
  ])("%s ⇒ %s", (_name, row, expected) => {
    expect(rowStatusLabelKey(row)).toBe(expected);
  });

  /**
   * ⚠️ **表外的状态落 `mismatch`，不冒充 `pending`**：走到那里说明这一行的状态是
   * 本面板不认识的东西，那是一句关于两边版本的话，不是「还没轮到它」。
   */
  it.each([
    ["面板不认识的行状态", { id: "m", state: "queued", code: null }],
    ["压根不是一行", null],
  ])("%s ⇒ models.test.mismatch（不冒充「还没轮到它」）", (_name, row) => {
    expect(rowStatusLabelKey(row)).toBe("models.test.mismatch");
  });
});

describe("200 响应体 → 文案 code", () => {
  /**
   * **四种结局各自一档**，一档都不许合并：
   * · 通了 —— 上游用这个模型正常回了一次；
   * · 上游没正常回 —— 连上了，但这个模型没给出一次正常响应；
   * · 超时 —— 在超时档内没拿到响应头；
   * · 连不上 —— 这次请求没拿到任何响应。
   * ⚠️ 外加 `no_key` 那一档：它与上面三种失败**不是一族**——那一次
   * **一个出站请求都没有发生过**，说成「上游出错了」会让运维去查一条不存在的故障。
   */
  it.each([
    ["通了", { ok: true, status: 200, latencyMs: 412, reason: null }, "ok", "models.test.ok"],
    ["上游没正常回", { ok: false, status: 502, latencyMs: 88, reason: "upstream_error" }, "upstream_error", "models.test.upstreamError"],
    ["超时", { ok: false, status: null, latencyMs: 8000, reason: "timeout" }, "timeout", "models.test.timeout"],
    ["连不上", { ok: false, status: null, latencyMs: 12, reason: "network_error" }, "network_error", "models.test.networkError"],
    ["池里没有能用的 key", { ok: false, status: null, latencyMs: 0, reason: "no_key" }, "no_key", "models.test.noKey"],
  ])("%s ⇒ %s", (_name, resp, code, key) => {
    expect(modelTestResultCode(resp)).toBe(code);
    expect(modelTestLabelKey(code)).toBe(key);
  });

  /**
   * 🔴 **表外的 reason 交出 `null`，不兜底成任何一档「上游怎么了」。**
   *
   * 这张表必须是显式的：后端加一种 reason 是一行 diff，而落进一个错误档的后果是
   * 面板对运维说一件没发生的事。`null` 由 `modelTestResultCode()` 翻成 `mismatch`
   * ——那是一句**关于两边版本**的话，不是关于上游的话。
   *
   * ⚠️ **这一格直接测那张表本身，不只测外面那层**：只测外层的话，一个
   *「不认识就当 network_error」的坏实现在这里同样交不出 `mismatch`，但错因完全不同。
   */
  it.each([
    ["后端新加的一种 reason", "body_incomplete"],
    ["压根不是这条端点的 reason", "bad_payload"],
    ["空串", ""],
  ])("表外的 reason「%s」⇒ modelTestBodyReasonCode 返回 null，不兜底", (_name, reason) => {
    expect(modelTestBodyReasonCode(reason)).toBe(null);
    expect(modelTestResultCode({ ok: false, status: null, latencyMs: 0, reason }))
      .toBe("mismatch");
  });

  it("表内的五条一条都没漏 —— 否则上面那格「表外返回 null」什么都没证明", () => {
    // 手写清单，**不是从被测函数推导的**。
    for (const r of ["no_key", "upstream_error", "timeout", "network_error"]) {
      expect(modelTestBodyReasonCode(r), `${r} 掉出表了`).toBe(r);
    }
  });

  it.each([
    ["压根不是对象", "nope"],
    ["ok 不是 true 而且没有 reason", { ok: false, status: null, latencyMs: 0, reason: null }],
  ])("%s ⇒ mismatch（这是一句关于两边版本的话，不是关于上游的话）", (_name, resp) => {
    expect(modelTestResultCode(resp)).toBe("mismatch");
  });
});

describe("管理层传输错误 → 文案 code", () => {
  /**
   * ⚠️⚠️ **判据是顶层 `reason` 而不是状态码**：护栏在同一个 **429** 下产出两种拒绝，
   * 处置完全不同（等它回来 / 稍后再试）。只看 429 会把两者合成一句话，
   * 而这两句话与「这个模型不通」更是三件事——那一次一个出站请求都没有发生过。
   */
  it.each([
    ["护栏说上一次还在飞", { status: 429, body: { reason: "probe_in_flight" } }, "probe_in_flight", "models.test.probeInFlight"],
    ["护栏说间隔没过", { status: 429, body: { reason: "probe_cooldown" } }, "probe_cooldown", "models.test.probeCooldown"],
    ["这个模型不能这么测", { status: 400, body: { reason: "modality_not_testable" } }, "modality_not_testable", "models.test.modalityNotTestable"],
    ["目录里没有这个模型", { status: 404, body: null }, "model_not_found", "models.test.modelNotFound"],
    ["管理会话没了", { status: 401, body: null }, "unauthorized_admin", "models.test.unauthorizedAdmin"],
    ["别的 429（表外）", { status: 429, body: { reason: "something_else" } }, "transport_error", "models.test.transportError"],
  ])("%s ⇒ %s", (_name, err, code, key) => {
    expect(modelTestTransportCode(err)).toBe(code);
    expect(modelTestLabelKey(code)).toBe(key);
  });

  /**
   * **护栏那两条与验活、上游模型两张卡共用同一把护栏**，所以三处的读法必须一致
   * ——不一致就会出现「同一次拒绝、几张卡几种说法」。这一格从 `probe-guard.ts`
   * 的源码里把它会产出的 reason 读出来对表，不手抄一份清单。
   */
  it("护栏那两条 reason 面板也都有一档 —— 它们与验活、上游模型共用同一把护栏", () => {
    const sites = reasonSites(readFileSync("src/http/admin/probe-guard.ts", "utf8"));
    expect(sites.literals).toEqual(["probe_cooldown", "probe_in_flight"]);
    const unmapped = sites.literals
      .filter((r) => modelTestTransportCode({ status: 429, body: { reason: r } }) === "transport_error");
    expect(unmapped, "护栏会产出这些 reason，而面板把它们当成了一次说不出所以然的失败").toEqual([]);
  });
});

/**
 * **后端会产出的每一条 reason，面板都得认得。**
 *
 * ⚠️ 这一组扫的是后端源码，不是一份手抄的清单：后端加一种 reason 是一行 diff，
 * 而「面板没跟上」在本仓的出站探测护栏那一轮真实发生过一次。
 * 实现照搬 `tests/ui/models.test.ts` 里那一个（同一个问题、同一种写法）。
 */
function reasonSites(src: string): { literals: string[]; dynamic: string[] } {
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
  /**
   * ⚠️ **这条 handler 的 reason 分属两半，所以清单也手写成两半**：
   * · 200 响应体里的那几条走 `modelTestResultCode()`；
   * · `modality_not_testable` 是 **400** ⇒ `js/api.js` 会把它抛成 `ApiError`，
   *   走 `modelTestTransportCode()` 那一半。
   * 把它塞进前一半去查的话，这一格会红在一件不成立的事上。
   * **两半的并集**与源码扫出来的集合逐字相等，所以后端多一条 / 少一条照样当场红。
   */
  it("模型测试那条 handler 的每一条 reason 面板都有一档 —— 认不得的会被说成「面板还不认识」，而这一格要求根本别走到那里", () => {
    const sites = reasonSites(readFileSync("src/http/admin/handlers/model-test.ts", "utf8"));
    // 手写的两半，**不是从被测函数推导的**。
    const bodyReasons = ["network_error", "no_key", "timeout", "upstream_error"];
    const non2xxReasons = ["modality_not_testable"];
    expect(sites.literals, "后端多一条 / 少一条 reason 都在这里当场红")
      .toEqual([...bodyReasons, ...non2xxReasons].sort());
    // 唯一动态的那一处是护栏那条 429，它走 `modelTestTransportCode()` 那一半（上一组）。
    expect(sites.dynamic).toEqual(["g.reason"]);

    const unmappedBody = bodyReasons
      .filter((r) => modelTestResultCode({ ok: false, status: null, latencyMs: 0, reason: r }) === "mismatch");
    expect(unmappedBody, "后端会在 200 里产出这些 reason，而面板还没给它们文案").toEqual([]);

    const unmappedNon2xx = non2xxReasons
      .filter((r) => modelTestTransportCode({ status: 400, body: { reason: r } }) === "transport_error");
    expect(unmappedNon2xx, "后端会在非 2xx 里产出这些 reason，而面板把它们说成了一次说不出所以然的失败").toEqual([]);

    const keys = [
      ...bodyReasons.map((r) => modelTestLabelKey(modelTestResultCode({ ok: false, status: null, latencyMs: 0, reason: r }))),
      ...non2xxReasons.map((r) => modelTestLabelKey(modelTestTransportCode({ status: 400, body: { reason: r } }))),
    ];
    expect(new Set(keys).size, "两条 reason 共用了同一句文案").toBe(sites.literals.length);
  });

  /**
   * **反向自检：这个扫描器真的会看见东西。** 少了它，扫描本身瞎掉时上面那一格
   * 会对着一个空集合报绿（第 1 类假阳性）。
   */
  it("反向自检：扫描器在一段手写的坏文本上认得出字面量与动态表达式", () => {
    const sites = reasonSites([
      'return c.json({ reason: "alpha" });',
      "// reason: \"in_a_comment\"",
      "return c.json({ reason: g.reason });",
      'return c.json({ reason: flag ? "beta" : "gamma" });',
    ].join("\n"));
    expect(sites.literals).toEqual(["alpha", "beta", "gamma"]);
    expect(sites.dynamic).toEqual(["g.reason"]);
  });
});

describe("i18n key 这一族", () => {
  /** 这一族全部的 code。**手写清单**，不是从被测函数推导的。 */
  const CODES = [
    "ok", "no_key", "upstream_error", "timeout", "network_error",
    "probe_in_flight", "probe_cooldown", "modality_not_testable", "model_not_found",
    "unauthorized_admin", "transport_error", "mismatch",
  ];

  /**
   * ⚠️ **按名字锚扫源码，不是行为断言**：拼出来的 key 与写死的 key 在行为上可以
   * 逐字节相同，而三道 i18n 门禁里有两道只认字面量（全局约束 12）。
   */
  it("每一个 code 的 i18n key 都以字面量出现在源码里，并且都在字典里", () => {
    const src = readFileSync("admin-ui/js/pure/model-test.mjs", "utf8");
    const keys = CODES.map((c) => modelTestLabelKey(c));
    expect(new Set(keys).size, "两个 code 共用了同一个 key").toBe(CODES.length);
    for (const k of keys) {
      expect(src.includes(`"${k}"`), `${k} 不是以字面量出现的`).toBe(true);
      expect(k in I18N, `${k} 不在字典里`).toBe(true);
    }
  });

  it("三种行状态的 key 同样是字面量、同样在字典里", () => {
    const src = readFileSync("admin-ui/js/pure/model-test.mjs", "utf8");
    for (const k of ["models.test.pending", "models.test.active"]) {
      expect(src.includes(`"${k}"`), `${k} 不是以字面量出现的`).toBe(true);
      expect(k in I18N, `${k} 不在字典里`).toBe(true);
    }
  });

  /**
   * ⚠️ **`modelTestLabelKey()` 与 `rowStatusLabelKey()` 交出来的 key 一个都不许带
   * `{占位符}`。** 它们在源码里的形态是 `return "…";`（后面跟的是 `;` 不是 `,`），
   * 而 `scripts/check-i18n.mjs` 第 ⑧ 条正是拿「后面紧跟着什么」当判据 ⇒ 真带了占位符，
   * 那道门禁当场 exit 1。这一格把那条约束钉在字典这一侧，别等门禁去发现。
   */
  it("这一族 key 五种语言里一个 {占位符} 都没有 —— 它们是不带参数的裸标签", () => {
    const dict = I18N as unknown as Record<string, Record<string, string>>;
    const bad: string[] = [];
    for (const k of [...CODES.map((c) => modelTestLabelKey(c)), "models.test.pending", "models.test.active"]) {
      for (const [lang, s] of Object.entries(dict[k]!)) if (/\{\w+\}/.test(s)) bad.push(`${k}/${lang}`);
    }
    expect(bad).toEqual([]);
    // 反向自检：判据不瞎 —— 这张卡里带占位符的那两个 key 确实被它认出来。
    for (const k of ["models.test.progress", "models.test.status"]) {
      expect(Object.values(dict[k]!).some((s) => /\{\w+\}/.test(s)), `${k} 应当带占位符`).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 整轮的节奏：两条之间隔满最小间隔（v0.3.0 缺陷，线上实测修正）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 🔴 **这一组守的是「这颗按钮真的回答得了它承诺回答的那个问题」。**
 *
 * v0.3.0 的板块循环里**一个间隔都没有**，而后端那把护栏最小间隔 3 秒、kind 是常量
 *（整轮互相挡）⇒ 线上实测整轮 824ms 跑完，6 行里 **5 行 `probe_cooldown`**：
 * 1 行「通了」+ 5 行「被节流挡下了，请稍后再测」，而「稍后再测」是死路
 *（再点一次连第一行都在冷却窗口里）。那 5 行盖住的可能是真的不通的模型。
 *
 * ⚠️ **纯函数这一层只钉「等多久」，钉不住「有没有真的等」**：真的停顿那一半在
 * `admin-ui/js/sec-models.js` 的 `runTests()` 里，由
 * `tests/ui/dom/models-test-card.test.ts` 的
 * 「两条请求之间真的隔满了最小间隔 —— 零间隔时后面每一条都被我们自己的护栏挡成节流」
 * 那一格钉着。两格分工不同，缺哪一格都留着一整条路没人守。
 */
describe("两条之间的最小间隔", () => {
  /**
   * **三个数必须相等。** 直接 import 那两个真常量比对，任何一处漂了这一格就红。
   *
   * ⚠️ 边界值下面那几格**手写字面量**（第 6 种假阳性：拿被测常量去算期望值，
   * 两边一起错时一声不吭），与 `tests/ui/keys-write.test.ts` 的
   *「前端这个最小间隔与后端 PROBE_MIN_INTERVAL_MS 是同一个数」那一格同一条纪律。
   *
   * **变红条件**：把 `TEST_MIN_INTERVAL_MS` 改成别的数（比如「反正快一点也没事」的 1000）。
   */
  it("整轮的最小间隔与后端 PROBE_MIN_INTERVAL_MS、与 Key 池验活那一份是同一个数", () => {
    expect(TEST_MIN_INTERVAL_MS).toBe(PROBE_MIN_INTERVAL_MS);
    expect(TEST_MIN_INTERVAL_MS, "与 Key 池验活那一份漂了 —— 同一把护栏，前端两处两个数")
      .toBe(VERIFY_MIN_INTERVAL_MS);
    // 反向自检：常量本身没了 / 被改成 0（那等于把这条不变量删掉，而上面两条会跟着一起变）。
    expect(TEST_MIN_INTERVAL_MS).toBe(3_000);
  });

  /** 这一轮的第一条前面没有任何一条，**不等**——凭空多等 3 秒是白等的。 */
  it("这一轮的第一条不等：参照点是 null ⇒ 0", () => {
    expect(nextTestDelayMs(null, 1_700_000_000_000)).toBe(0);
  });

  /**
   * 🔴 **本组最要紧的一格：上一条刚落定 ⇒ 必须等满一整个间隔。**
   * 这里回 0 的实现就是 v0.3.0 那一版（零间隔），线上后果见本组文件头。
   */
  it("上一条刚落定就要发下一条 ⇒ 等满 3000 毫秒", () => {
    expect(nextTestDelayMs(1_700_000_000_000, 1_700_000_000_000)).toBe(3_000);
  });

  /** 已经等掉的那部分要扣掉：只等剩下的。手写 1000 / 2000，不写成常量减法。 */
  it("已经过去 1000 毫秒 ⇒ 只等剩下的 2000", () => {
    expect(nextTestDelayMs(1_700_000_000_000, 1_700_000_001_000)).toBe(2_000);
  });

  /**
   * **边界两侧各一格**：差 1 毫秒还要等 1 毫秒，整好到点就不等了。
   * 只测一侧的话，`>` 与 `>=` 写反在任何一格上都不可观测。
   */
  it("差 1 毫秒仍然要等，整好到点就不等了", () => {
    expect(nextTestDelayMs(1_700_000_000_000, 1_700_000_002_999)).toBe(1);
    expect(nextTestDelayMs(1_700_000_000_000, 1_700_000_003_000)).toBe(0);
    expect(nextTestDelayMs(1_700_000_000_000, 1_700_000_009_999)).toBe(0);
  });

  /**
   * ⚠️ **时钟回拨按「等满一整个间隔」处置，绝不许当成「已经等够了」。**
   * 把负的已等时长当成已等够，会在系统对时的那一刻把整轮打回零间隔
   * ——也就是这条缺陷本身，而且只在真机上偶发。
   *
   * **变红条件**：把 `waited < 0` 那一支删掉 ⇒ 这一格拿到 `3_000 - (-5_000) = 8_000`
   * 那种更长的等待还算好的；换成先判 `waited >= TEST_MIN_INTERVAL_MS` 的写法就会回 0。
   */
  it("本地时钟被拨回去了 ⇒ 等满一整个间隔，不许判成「已经等够了」", () => {
    expect(nextTestDelayMs(1_700_000_005_000, 1_700_000_000_000)).toBe(3_000);
  });

  /** 参照点不是有限数（`NaN` / `Infinity` / 缺字段）时按「没有参照点」处置。 */
  it("参照点不是有限数 ⇒ 当成这一轮的第一条", () => {
    for (const bad of [undefined, NaN, Infinity, "1700000000000", {}]) {
      expect(nextTestDelayMs(bad as never, 1_700_000_000_000), `${String(bad)} 没被当成没有参照点`).toBe(0);
    }
  });

  /** `now` 读不出来时**宁可等满**：那一档下「已等多久」这个问题根本没有答案。 */
  it("now 不是有限数 ⇒ 等满一整个间隔，不许当成 0", () => {
    expect(nextTestDelayMs(1_700_000_000_000, NaN)).toBe(3_000);
  });
});

describe("整轮至少要多少秒", () => {
  /**
   * ⚠️ **`n` 条请求之间只有 `n−1` 段间隔。** 写成 `n` 段的话，卡上那句话会对运维
   * 多报一段它其实不会等的时间；而这句话是运维在第一段间隔里判断「它是不是卡住了」
   * 的唯一依据。真源目录里今天有 6 个对话模型 ⇒ 5 段 × 3 秒 = 15 秒。
   */
  it("六个对话模型 ⇒ 至少 15 秒（五段间隔，不是六段）", () => {
    expect(testRoundMinSec(6)).toBe(15);
    expect(testRoundMinSec(2)).toBe(3);
    // 契约侧：真源目录里的对话模型条数就是面板上那句话用的那个 n。
    expect(testRoundMinSec(testableModels(MODEL_CATALOG).length)).toBe(15);
  });

  /**
   * **少于两个模型时是 0，调用方据它决定这句话画不画。**
   * 一条请求前后一段间隔都没有，写成一句「至少 3 秒」是假话。
   */
  it("零个 / 一个模型 ⇒ 0，那句话不该出现在屏幕上", () => {
    expect(testRoundMinSec(0)).toBe(0);
    expect(testRoundMinSec(1)).toBe(0);
    expect(testRoundMinSec(NaN)).toBe(0);
  });
});
