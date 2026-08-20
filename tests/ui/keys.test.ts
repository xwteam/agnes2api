import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  CARDS, AUTO_SECONDS, cardCounts, badgeClass, bucketLabelKey, autoLabelKey,
  keysQuery, cooldownRemaining, lastErrorParts, usageParts, lastUsedParts,
  pagerState, listMessageKey, itemsOf,
} from "../../admin-ui/js/pure/keys.mjs";
import { I18N } from "../../admin-ui/js/i18n-dict.js";

/** 一份"正常"的响应，各条用例在它上面改一处。 */
const view = {
  id: "abc123", masked: "sk-ab…wxyz", seq: 1, bucket: "fresh",
  addedAt: 1000, lastUsedAt: 2000, cooldownUntil: 0,
  cooldownReason: null, evictedReason: null, strikes: 0,
  stats: { requests: 10, success: 9, failed: 1, clientErrors: 0, lastErrorAt: 1500, lastErrorKind: "upstream 500" },
};
const body = {
  items: [view], total: 1, page: 1, size: 20, pages: 1,
  counts: { all: 4, fresh: 1, cooling: 1, evicted: 1, disabled: 1 },
  approximate: true, generatedAt: 3000,
};

/**
 * **产品不变式：绝不伪造 0。**（评审 C1）
 *
 * 接口读失败时四张汇总卡与筛选下拉都必须显示 `—`。显示 `0/0/0/0` 的后果不是"不好看"：
 * 运维看到「可用 0」的第一反应是整池死了，而真相可能只是面板自己的一次请求失败。
 * 字典里 `common.loadFailed` 逐字写着「读取失败，显示为 —」，面板不能一边这么说一边显示 0。
 */
describe("cardCounts：没有数据就是没有数据", () => {
  it("读失败 / 还没加载时五项全是 null，不是 0", () => {
    for (const empty of [null, undefined, {}, { counts: null }]) {
      expect(cardCounts(empty), String(empty))
        .toEqual({ all: null, fresh: null, cooling: null, evicted: null, disabled: null });
    }
  });
  it("有数据时逐项透传（**真的取到了数字**，否则上面那条在恒 null 的实现下也绿）", () => {
    expect(cardCounts(body)).toEqual({ all: 4, fresh: 1, cooling: 1, evicted: 1, disabled: 1 });
  });
  it("counts 里某一项坏掉（非数字）只让那一项变 null，不整块丢弃", () => {
    const broken = { counts: { all: 3, fresh: "1", cooling: null, evicted: 1, disabled: 1 } };
    expect(cardCounts(broken)).toEqual({ all: 3, fresh: null, cooling: null, evicted: 1, disabled: 1 });
  });
  it("真实的 0 照样是 0——「没有数据」与「数出来是零」必须分得开", () => {
    expect(cardCounts({ counts: { all: 0, fresh: 0, cooling: 0, evicted: 0, disabled: 0 } }))
      .toEqual({ all: 0, fresh: 0, cooling: 0, evicted: 0, disabled: 0 });
  });
  /**
   * 后端加了第四档、前端 `CARDS` 忘了跟上时，这一档的条数在面板上**根本不存在**
   * ——不是显示成 `—`，而是那张卡压根没有，运维看不出 `all` 与另外几格为什么对不上。
   * **变红条件**：从 `CARDS` 里删掉 `"disabled"`。
   */
  it("后端给了 disabled 这一档，前端就必须取得到它", () => {
    expect(cardCounts({ counts: { all: 5, fresh: 1, cooling: 1, evicted: 1, disabled: 2 } }))
      .toEqual({ all: 5, fresh: 1, cooling: 1, evicted: 1, disabled: 2 });
  });
});

describe("分档与档位的映射", () => {
  it("四档各自的徽章样式互不相同", () => {
    const classes = ["fresh", "cooling", "evicted", "disabled"].map(badgeClass);
    // `disabled` 刻意只有底样式（中性灰），不带颜色修饰类——理由见 keys.mjs。
    expect(classes).toEqual(["badge badge-ok", "badge badge-warn", "badge badge-danger", "badge"]);
    expect(new Set(classes).size, "两档共用一个样式就等于面板分不出它们").toBe(4);
  });

  /**
   * ⚠️ **上面那格只比字符串**：四个不同的字符串完全可能在屏幕上长得一模一样
   *（评审 M-a：`badge-muted` 曾经就是一条取值与 `.badge` 逐字相同的死规则，
   * 而那格照绿）。这一格补上它够得着的那一半——**每一个修饰类都得真的在
   * `admin-ui/css/sections.css` 里定义过**，拼错一个字母、或删了 CSS 却留着类名，
   * 都会在这里变红。
   *
   * **边界写清楚**：它证明"这个类有定义"，**不证明"这四个定义长得不一样"**——
   * 后者需要一个 CSS 引擎，本仓没有，留给评审看 diff。
   */
  it("badgeClass 返回的每一个修饰类都真的在 sections.css 里定义过", () => {
    const css = readFileSync("admin-ui/css/sections.css", "utf8");
    const modifiers = ["fresh", "cooling", "evicted", "disabled"]
      .flatMap((b) => badgeClass(b).split(" "))
      .filter((c) => c !== "badge");
    // 反向自检：真的收集到了修饰类，不是空数组让下面的 for 一格都不跑。
    expect(modifiers.sort()).toEqual(["badge-danger", "badge-ok", "badge-warn"]);
    for (const c of modifiers) {
      expect(css, `badgeClass 返回了 .${c}，而 sections.css 里没有这条规则`).toContain(`.${c} {`);
    }
  });
  it("i18n key 逐档手写，且每一个都真的在字典里", () => {
    expect(CARDS.map(bucketLabelKey)).toEqual([
      "keys.bucket.all", "keys.bucket.fresh", "keys.bucket.cooling", "keys.bucket.evicted",
      "keys.bucket.disabled",
    ]);
    for (const k of CARDS.map(bucketLabelKey)) expect(I18N, k).toHaveProperty(k);
  });
  it("自动刷新三档的 key 同样落在字典里，且默认那档是「关」", () => {
    expect(AUTO_SECONDS).toEqual([0, 30, 60]);
    expect(AUTO_SECONDS.map(autoLabelKey)).toEqual(["keys.auto.off", "keys.auto.30", "keys.auto.60"]);
    for (const k of AUTO_SECONDS.map(autoLabelKey)) expect(I18N, k).toHaveProperty(k);
  });
});

describe("keysQuery", () => {
  it("all 档不发 bucket 参数，空查询不发 q", () => {
    expect(keysQuery({ page: 1, size: 20, bucket: "all", q: "" })).toBe("page=1&size=20");
  });
  it("带上筛选与搜索", () => {
    expect(keysQuery({ page: 2, size: 20, bucket: "evicted", q: "abc" }))
      .toBe("page=2&size=20&bucket=evicted&q=abc");
  });
  /**
   * 不转义的后果不是"URL 难看"：`?q=a&bucket=evicted` 会被解析成**两个参数**，
   * 于是用户在搜索框里敲一个 `&` 就能让列表与筛选器显示的档位不符。
   */
  it("q 里的 & = # 空格全部转义", () => {
    expect(keysQuery({ page: 1, size: 20, bucket: "all", q: "a&bucket=evicted" }))
      .toBe("page=1&size=20&q=a%26bucket%3Devicted");
    expect(keysQuery({ page: 1, size: 20, bucket: "all", q: "a b#c" }))
      .toBe("page=1&size=20&q=a%20b%23c");
  });
});

describe("行内每个格子的取值决策", () => {
  it("冷却剩余：只有 cooling 档才有值，其余是 null（渲染成 —）", () => {
    expect(cooldownRemaining({ ...view, bucket: "cooling", cooldownUntil: 5000 }, 3000)).toBe(2000);
    expect(cooldownRemaining({ ...view, bucket: "fresh", cooldownUntil: 5000 }, 3000)).toBeNull();
    expect(cooldownRemaining({ ...view, bucket: "evicted", cooldownUntil: 5000 }, 3000)).toBeNull();
  });
  it("冷却剩余用**服务端**那一刻算——参照时刻是参数，不是浏览器时钟", () => {
    const v = { ...view, bucket: "cooling", cooldownUntil: 5000 };
    expect(cooldownRemaining(v, 4000), "同一条记录、不同参照时刻必须给出不同答案").toBe(1000);
  });
  it("最近错误：没有就是 null，不是空串（空串会渲染成一个空格子而不是 —）", () => {
    expect(lastErrorParts(view)).toEqual({ kind: "upstream 500", at: 1500 });
    expect(lastErrorParts({ ...view, stats: { ...view.stats, lastErrorKind: null } })).toBeNull();
    expect(lastErrorParts({ ...view, stats: { ...view.stats, lastErrorKind: "" } })).toBeNull();
    expect(lastErrorParts({})).toBeNull();
  });
});

/**
 * **`≈` 必须由后端那个诚实标记驱动**（评审 I4）。
 *
 * 板块第一版无条件拼 `≈`，于是契约测试里那句"面板要靠 approximate 决定打不打 ≈"
 * 是假的——后端改成 `false`，面板照样打。一个没有消费者的响应字段迟早会漂。
 */
describe("≈ 由 approximate 驱动", () => {
  it("approximate: true ⇒ 打 ≈", () => {
    expect(usageParts(view, true)).toEqual({ approx: true, requests: 10, success: 9 });
  });
  it("approximate: false ⇒ **不打** ≈，但数字照常显示", () => {
    expect(usageParts(view, false)).toEqual({ approx: false, requests: 10, success: 9 });
  });
  it("响应里没带这个字段时按近似处理——保守方向是宁可多打一个 ≈", () => {
    expect(usageParts(view, undefined).approx).toBe(true);
  });
  it("条目缺 stats 时两个数都是 null（渲染成 ≈ —），不是 0", () => {
    // 存量记录没有 stats（P1 时期写下的）。后端投影会补零，但**前端不许自己假设**：
    // 拿不到就是拿不到，伪造 0 会让运维以为这把 key 一次都没成功过。
    expect(usageParts({}, true)).toEqual({ approx: true, requests: null, success: null });
    expect(usageParts({ stats: {} }, true)).toEqual({ approx: true, requests: null, success: null });
  });
  it("「最后使用」与计数是同一份不确定性，同样跟着 approximate 打 ≈", () => {
    expect(lastUsedParts(view, true)).toEqual({ at: 2000, approx: true });
    expect(lastUsedParts(view, false)).toEqual({ at: 2000, approx: false });
  });
  it("从未使用过时不打 ≈——那不是「不准」，那是确定的「没用过」", () => {
    expect(lastUsedParts({ ...view, lastUsedAt: null }, true)).toEqual({ at: null, approx: false });
  });
});

describe("pagerState：两条早退分支都要复位", () => {
  it("有数据时按 page/pages 决定两个按钮", () => {
    expect(pagerState({ ...body, page: 1, pages: 3, total: 5 }))
      .toEqual({ prevDisabled: true, nextDisabled: false, info: { page: 1, pages: 3, total: 5 } });
    expect(pagerState({ ...body, page: 2, pages: 3, total: 5 }))
      .toEqual({ prevDisabled: false, nextDisabled: false, info: { page: 2, pages: 3, total: 5 } });
    expect(pagerState({ ...body, page: 3, pages: 3, total: 5 }))
      .toEqual({ prevDisabled: false, nextDisabled: true, info: { page: 3, pages: 3, total: 5 } });
  });
  it("读失败 / 空列表时两个按钮都禁用，且 info 是 null（不留着上一次的页码）", () => {
    for (const empty of [null, undefined, { ...body, items: [] }]) {
      expect(pagerState(empty), String(empty))
        .toEqual({ prevDisabled: true, nextDisabled: true, info: null });
    }
  });
});

/**
 * **三处判据统一到 `itemsOf`**（评审 N4）：畸形响应（`items` 不是数组）以前一处当空列表、
 * 一处放行去建表，板块就会走到 `for (const v of data.items)` 抛异常。
 */
describe("itemsOf：全模块唯一的「有没有条目」判据", () => {
  it("items 不是数组时一律 null——分页、列表消息、要不要建表三处共用这一个答案", () => {
    for (const bad of [null, undefined, {}, { items: null }, { items: "oops" }, { items: 3 }]) {
      expect(itemsOf(bad), String(bad)).toBeNull();
      expect(pagerState(bad), String(bad)).toEqual({ prevDisabled: true, nextDisabled: true, info: null });
      expect(listMessageKey(bad, false), String(bad)).toBeNull();
    }
  });
  it("正常响应里原样交出那个数组", () => {
    expect(itemsOf(body)).toBe(body.items);
    expect(itemsOf({ ...body, items: [] })).toEqual([]);
  });
});

describe("listMessageKey：空池与筛没了是两回事", () => {
  it("读失败优先——它盖过一切", () => {
    expect(listMessageKey(body, true)).toBe("common.loadFailed");
    expect(listMessageKey(null, true)).toBe("common.loadFailed");
  });
  it("有条目时不显示任何消息", () => {
    expect(listMessageKey(body, false)).toBeNull();
  });
  it("整池为空 ⇒ 「去导入」；筛完为空 ⇒ 「放宽条件」", () => {
    const emptyPool = { ...body, items: [], total: 0, counts: { all: 0, fresh: 0, cooling: 0, evicted: 0 } };
    expect(listMessageKey(emptyPool, false)).toBe("keys.empty");
    const filteredOut = { ...body, items: [], total: 0, counts: { all: 3, fresh: 1, cooling: 1, evicted: 1 } };
    expect(listMessageKey(filteredOut, false)).toBe("keys.noMatch");
  });
  it("这两个 key 都在字典里", () => {
    for (const k of ["keys.empty", "keys.noMatch", "common.loadFailed"]) expect(I18N, k).toHaveProperty(k);
  });
});
