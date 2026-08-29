import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { I18N } from "../../admin-ui/js/i18n-dict.js";
import { t, currentLang } from "../../admin-ui/js/i18n.js";
import { createFakeDom } from "../helpers/fake-dom.js";

/**
 * ⚠️ **订正**：这个文件曾经不 import `admin-ui/js/i18n.js`，理由写的是「它在模块
 * 顶层碰浏览器全局，在 node 环境里 import 就会炸」——**那句话经评审实测证伪**：
 * 模块顶层唯一的副作用是 `let lang = readLang()`，而 `readLang()` 内部已经把
 * `localStorage` 访问包在 try/catch 里（node 没有全局 `localStorage`，抛出的
 * `ReferenceError` 被吞掉、落回 `FALLBACK`）。`t()` 本身也不碰 `document`。
 * import 与调用都不会炸，已在 node 里实测确认。
 *
 * **真正会炸的只有 `apply()` / `setLang()`**——它们直接写 `document.documentElement`。
 * 设计文档 §13.1「不引 jsdom / happy-dom / playwright 进 CI」这条边界仍然成立，
 * 但边界只框住这两个函数，不是整个模块。这两个仍然只由人工冒烟覆盖。
 *
 * 之前的版本因为这句错误前提，`t()` 的插值替换 / 缺 key 兜底 / 语言回退三条真实
 * 逻辑只被下面这组「字典形状足以让 t() 正确工作」的**形状断言**间接担保——那是
 * 本项目登记的第 4 种假阳性（形状断言冒充行为断言）。下面新增一组直接调用
 * 真正的 `t()`，形状断言组保留（它守的是另一件事：字典本身的结构完整性，
 * 不因为 t() 现在能测了就失去意义）。
 */
describe("字典的形状足以让 t() 正确工作", () => {
  it("每个键的五种语言都是字符串（t() 不会拿到 undefined 去 split）", () => {
    for (const [k, row] of Object.entries(I18N)) {
      for (const v of Object.values(row as Record<string, unknown>)) {
        expect(typeof v, k).toBe("string");
      }
    }
  });
  it("含插值的键，占位符形如 {name}，不含嵌套或未闭合的花括号", () => {
    for (const [k, row] of Object.entries(I18N)) {
      for (const s of Object.values(row as Record<string, string>)) {
        const opens = (s.match(/\{/g) ?? []).length;
        const closes = (s.match(/\}/g) ?? []).length;
        expect(opens, `${k}: 花括号不配平`).toBe(closes);
        for (const m of s.matchAll(/\{([^}]*)\}/g)) {
          expect(m[1], `${k}: 占位符名必须是 \\w+`).toMatch(/^\w+$/);
        }
      }
    }
  });
});

/**
 * `t()` 的真实行为。**直接调用真正的函数**，不是复刻一份最小实现去跟它比对
 * （复刻件永远验证不了原件，是本项目已经踩过的坑）。
 */
describe("t() 的真实行为", () => {
  it("插值：单个占位符被真实替换成传入的值", () => {
    expect(t("gate.httpError", { status: 500 })).toBe("接口异常：500");
  });

  it("插值：同一个字符串里的多个不同占位符各自被对应的值替换", () => {
    const key = "__test.multi_token_probe";
    (I18N as Record<string, Record<string, string>>)[key] = {
      "zh-CN": "{a}和{b}", "zh-TW": "x", en: "x", ja: "x", ko: "x",
    };
    try {
      expect(t(key, { a: "甲", b: "乙" })).toBe("甲和乙");
    } finally {
      delete (I18N as Record<string, unknown>)[key];
    }
  });

  it("插值：同一个占位符在字符串里重复出现，两处都被替换", () => {
    const key = "__test.repeated_token_probe";
    (I18N as Record<string, Record<string, string>>)[key] = {
      "zh-CN": "{a}-{a}", "zh-TW": "x", en: "x", ja: "x", ko: "x",
    };
    try {
      expect(t(key, { a: "X" })).toBe("X-X");
    } finally {
      delete (I18N as Record<string, unknown>)[key];
    }
  });

  it("缺 key 时原样返回 key 本身——生产不该因为缺一句翻译就白屏", () => {
    expect(t("nonexistent.key.xyz")).toBe("nonexistent.key.xyz");
  });

  it("currentLang() 在没有 localStorage 的 node 环境里落回 FALLBACK（zh-CN），"
    + "这也是本文件能在 node 里裸测 t() 的前提", () => {
    expect(currentLang()).toBe("zh-CN");
  });
});

/**
 * `t()` 的语言回退（`row[lang] ?? row[FALLBACK]`）。
 *
 * 上面那组测试全程跑在 `currentLang() === "zh-CN" === FALLBACK` 下——node 里没有
 * `localStorage`，`lang` 与 `FALLBACK` 永远是同一个值，`row[lang]` 与 `row[FALLBACK]`
 * 读的是同一个属性，删掉 `?? row[FALLBACK]` 那一截不会让上面任何一条变红。
 * 要真的钉住这条回退逻辑，必须先让 `lang` 落在一个**非 FALLBACK** 的真实语言上。
 *
 * `setLang()` 能做到，但它会碰 `document`，属于上面订正过的那条边界（人工冒烟）。
 * 这里换一条不碰 `document` 的路：`readLang()` 在模块**顶层求值时**就会去读
 * `localStorage.getItem("agnes2api_lang")`——用 `vi.stubGlobal` 在 `vi.resetModules()`
 * 之后重新 import，让模块用一份「已经存过 ja」的 localStorage 重新走一遍真实的
 * 初始化路径，`lang` 就会是 `"ja"`，不需要碰 `document`。
 *
 * ⚠️ 已用变异验证过这组测试本身：把 `row[lang] ?? row[FALLBACK]` 改成裸的
 * `row[lang]`，下面第二条会变红（返回 key 本身而不是中文兜底文案）；改回来复测通过。
 */
describe("t() 的跨语言回退（不碰 document，用 vi.resetModules 重新走真实初始化）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("模块加载时从（模拟的）localStorage 读到 ja，currentLang() 与 t() 都按 ja 取值", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (k === "agnes2api_lang" ? "ja" : null),
      setItem: () => {},
    });
    vi.resetModules();
    const mod = await import("../../admin-ui/js/i18n.js");
    expect(mod.currentLang()).toBe("ja");
    // gate.submit 的 ja 翻译是「入る」——真实字典里的真实值，不是构造出来的 fixture。
    expect(mod.t("gate.submit")).toBe("入る");
  });

  it("当前语言（ja）缺该 key 的翻译时，退回 FALLBACK（zh-CN）的字符串，不是 undefined", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (k === "agnes2api_lang" ? "ja" : null),
      setItem: () => {},
    });
    vi.resetModules();
    const mod = await import("../../admin-ui/js/i18n.js");
    const dict = await import("../../admin-ui/js/i18n-dict.js");
    const key = "__test.lang_fallback_probe";
    (dict.I18N as Record<string, Record<string, string>>)[key] = {
      "zh-CN": "中文兜底文案", "zh-TW": "x", en: "x", ja: undefined as unknown as string, ko: "x",
    };
    try {
      expect(mod.t(key)).toBe("中文兜底文案");
    } finally {
      delete (dict.I18N as Record<string, unknown>)[key];
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * `<html lang>` 两处写入点（P3e 全分支评审 LOW）
 *
 * 面板在两处把语言写到根元素上：`admin-ui/js/boot.js`（首屏，经典脚本）与
 * `admin-ui/js/i18n.js` 的 `setLang()`（切换时）。两处都写**两样东西**：
 * `data-lang` 属性（CSS 钩子）与 `documentElement.lang`（**读屏器与浏览器唯一
 * 认得的那一样**）。
 *
 * ⚠️ **在这一组落地之前，`.lang` 那一半一个用例都没有钉着**：删掉两处的
 * `document.documentElement.lang = …` 之后全仓照样绿，而屏幕上一切正常——
 * 少掉的只是读屏器的发音语言与浏览器的断词/翻译提示，肉眼与 CSS 都看不出来。
 * 这正是本仓登记过的那一类：**没有人会发现的那种坏**。
 *
 * ⚠️ **两处都用真的那一份源码驱动，不复刻**：`setLang()` 直接 import 来调；
 * `boot.js` 是不能 import 的经典脚本（它是一个 IIFE，`<head>` 里同步执行），
 * 所以用 `new Function` 把**真文件的字节**当函数体跑一遍，`document` /
 * `localStorage` 从参数注入。复刻一份最小实现去跟它比对，验证不了原件。
 * ────────────────────────────────────────────────────────────────────────── */
describe("<html lang> 两处写入点：data-lang 与 documentElement.lang 必须一起写", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  /** 根元素替身：只提供两处代码真的会碰的那几样东西。 */
  function fakeRoot() {
    const attrs = new Map<string, string>();
    return {
      lang: "",
      setAttribute(k: string, v: string) { attrs.set(k, v); },
      getAttribute(k: string) { return attrs.get(k) ?? null; },
      attrs,
    };
  }

  it("boot.js（首屏，经典脚本）把 localStorage 里的语言同时写进 data-lang 和 documentElement.lang", () => {
    const src = readFileSync("admin-ui/js/boot.js", "utf8");
    const root = fakeRoot();
    const doc = { documentElement: root };
    const store: Record<string, string> = { agnes2api_lang: "ko" };
    new Function("document", "localStorage", src)(
      doc,
      { getItem: (k: string) => (k in store ? store[k]! : null) },
    );
    expect(root.getAttribute("data-lang"), "boot.js 没写 data-lang").toBe("ko");
    expect(
      root.lang,
      "boot.js 没写 documentElement.lang —— 首屏的读屏器会按浏览器默认语言念这一页，"
      + "而 data-lang 那一半照旧正确，屏幕上一个字都看不出来",
    ).toBe("ko");
  });

  it("boot.js：localStorage 里没有语言时两样东西都落到 zh-CN，不是空串", () => {
    const src = readFileSync("admin-ui/js/boot.js", "utf8");
    const root = fakeRoot();
    new Function("document", "localStorage", src)(
      { documentElement: root },
      { getItem: () => null },
    );
    expect(root.getAttribute("data-lang")).toBe("zh-CN");
    expect(root.lang, "没有存过语言时 documentElement.lang 落成了空串").toBe("zh-CN");
  });

  it("setLang() 切换语言时同时写 data-lang 和 documentElement.lang，并广播 langchange", async () => {
    const dom = createFakeDom();
    const root = dom.document.documentElement as unknown as { lang?: string };
    vi.stubGlobal("document", dom.document);
    vi.stubGlobal("CustomEvent", dom.CustomEvent);
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (k in store ? store[k]! : null),
      setItem: (k: string, v: string) => { store[k] = String(v); },
    });
    vi.resetModules();
    const mod = await import("../../admin-ui/js/i18n.js");

    const seen: string[] = [];
    dom.document.addEventListener("langchange", (ev) => {
      seen.push(String((ev as { detail?: { lang?: string } }).detail?.lang));
    });

    mod.setLang("ja");
    expect(dom.document.documentElement.getAttribute("data-lang"), "setLang 没写 data-lang").toBe("ja");
    expect(
      root.lang,
      "setLang 没写 documentElement.lang —— 切完语言之后读屏器还按上一种语言念，"
      + "而屏幕上的字全都换好了，肉眼与 CSS 都看不出来",
    ).toBe("ja");
    expect(seen, "langchange 没广播出去").toEqual(["ja"]);

    // 反向：不认识的语言一律早退，两样东西都不许被改成一个无效值。
    mod.setLang("fr");
    expect(dom.document.documentElement.getAttribute("data-lang"), "不认识的语言写进了 data-lang").toBe("ja");
    expect(root.lang, "不认识的语言写进了 documentElement.lang").toBe("ja");
    expect(seen, "不认识的语言也广播了一次 langchange").toEqual(["ja"]);
  });
});
