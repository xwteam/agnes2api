import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SESSION_MAX_AGE_MS, sessionExpired } from "../../admin-ui/js/pure/session.mjs";

/**
 * 会话绝对上限（K6 的可做部分）。
 *
 * 计划把这条整个归给人工冒烟，理由是「`SESSION_MAX_AGE_MS` 与 `sessionExpired()`
 * 碰 localStorage 与 Date，在 node 环境里 import 就会炸」。**执行时订正**：
 * 那句话对**读取**成立，对**判定**不成立——把「存下的时刻」与「现在」都变成参数
 * 之后，判定是纯函数。admin-ui/README.md 硬规则 1 要求「所有需要测试的逻辑必须放
 * `js/pure/*.mjs`」，所以判定搬进了 `js/pure/session.mjs`，由本文件覆盖；
 * 真正碰浏览器全局的那一小段留在 `app.js`，由冒烟第 15/16 条覆盖。
 */
describe("sessionExpired：一份 localStorage 里的口令还能用多久", () => {
  /**
   * ⚠️ **12 小时这个数字本身是策略，用手写字面量独立钉死。**
   *
   * 下面所有边界用例都会引用 `SESSION_MAX_AGE_MS`——那是**合法的关系断言**，
   * 前提是这个常量自己被一条手写字面量锚住。少了这一条，把上限改成 100 年
   * 那些边界用例照样全绿（本项目登记的第 6 种假阳性：期望值从被测对象自己推导）。
   * 12 小时同时写进了五语言 DEPLOY.md，改这里就要改那五份。
   */
  it("上限是 12 小时这个数字本身就是策略，独立钉死", () => {
    expect(SESSION_MAX_AGE_MS).toBe(43_200_000);
    expect(SESSION_MAX_AGE_MS).toBe(12 * 60 * 60 * 1000);
  });

  const SAVED = 1_700_000_000_000;

  it("刚存下来的会话没过期——否则「一律 true」也能骗过下面全部用例", () => {
    expect(sessionExpired(SAVED, SAVED)).toBe(false);
  });

  it("差一毫秒到上限：还没过期", () => {
    expect(sessionExpired(SAVED, SAVED + SESSION_MAX_AGE_MS - 1)).toBe(false);
  });

  /** 判据是 `>=`：正好到点就算过期，不是「超过才算」。 */
  it("正好到上限：已过期（边界是闭的）", () => {
    expect(sessionExpired(SAVED, SAVED + SESSION_MAX_AGE_MS)).toBe(true);
  });

  it("超过上限：已过期", () => {
    expect(sessionExpired(SAVED, SAVED + SESSION_MAX_AGE_MS + 1)).toBe(true);
    // 13 小时——冒烟第 16 条手工改 localStorage 用的就是这个量。
    expect(sessionExpired(SAVED, SAVED + 13 * 3600_000)).toBe(true);
  });

  /**
   * **时钟回拨按过期处理（fail closed）。**
   *
   * 这条与后端三处「回拨立刻恢复」方向**相反**，是刻意的：那三处回拨的代价是多刷新
   * 一次，这里回拨的代价是一份凭据多活一阵子。把 `age < 0` 那半去掉时只有这一格会红。
   */
  it("时钟回拨（now 早于存下的时刻）按过期处理，与后端三处的方向相反是刻意的", () => {
    expect(sessionExpired(SAVED, SAVED - 1)).toBe(true);
    expect(sessionExpired(SAVED, SAVED - 10 * 3600_000)).toBe(true);
  });

  /**
   * 拿不到有效时刻一律按过期处理。`null` 那一格对应的是**旧版本存下的会话**
   *（那时还没有 `agnes2api_admin_key_at` 这个键）：`Number(null) === 0`。
   * 代价只是多输一次口令。
   *
   * ⚠️ **这五格里只有 NaN 那一格真的在观测 `savedAt` 那句守卫，其余四格观测不到它
   * ——实测，不是推测。** 变异「删掉 `if (!Number.isFinite(savedAt) || savedAt <= 0)`」
   * 之后只有 NaN 那格变红（`1 failed | 26 passed`），原因是别的取值会被后面两句
   * 顺带接住：`0` / `-1` ⇒ `age` 巨大 ⇒ 命中 `age >= 上限`；`Infinity` ⇒
   * `age = -Infinity` ⇒ 命中 `age < 0`。
   * 也就是说另外四格在**这条变异**下属于本项目登记的第 5 种假阳性形态
   *（覆盖的状态让被测的选择不可观测）。留着它们不是凑数：它们钉的是「这些输入的
   * **结论**必须是过期」这条对外语义（换一条把三句一起改坏的变异时它们会红），
   * 但**别把它们读成「`savedAt` 守卫有五重保险」**。
   */
  it.each([
    ["旧版本存的（没有时刻键，Number(null) === 0）", Number(null)],
    ["空串（Number(\"\") === 0）", Number("")],
    ["被改成非数字（NaN）", Number("nonsense")],
    ["负数", -1],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("savedAt 无效时按过期处理：%s", (_name, savedAt) => {
    expect(sessionExpired(savedAt, SAVED)).toBe(true);
  });

  /**
   * **`now` 不是有限数时也必须 fail closed，这一格不是凑数的。**
   *
   * `now - savedAt` 会是 NaN，而 `NaN < 0` 与 `NaN >= 上限` **都是 false**
   * ⇒ 不显式挡住的话结论会变成「没过期」，方向正好反了。
   * ⚠️ **实测：去掉那句 `if (!Number.isFinite(now)) return true;` 之后，
   * 只有 NaN 那一格变红（`1 failed | 26 passed`），Infinity 那格不变红**——
   * `age = Infinity` 会命中 `age >= 上限` 被顺带接住。Infinity 那格因此**不**在
   * 观测这句守卫，它只在钉「结论必须是过期」。别把两格都算成这句守卫的护栏。
   */
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("now 不是有限数时按过期处理（否则 NaN 比较会静默 fail open）：%s", (_name, now) => {
    expect(sessionExpired(SAVED, now)).toBe(true);
  });
});

/**
 * 五语言 DEPLOY.md 必须写着同一个上限，且必须写着「它做不到什么」。
 *
 * 计划对这条的要求是逐字的：「**这段话同时写进五语言 DEPLOY.md，别只留在注释里**」。
 * 一句只写在注释里的承诺，运维永远看不到；而五份文档里有一份说 24 小时，
 * 照着它做部署决策的人就会被骗。
 *
 * **小时数从 `SESSION_MAX_AGE_MS` 算出来**，各语言的句式是**手写字面量**：
 * 于是「改了常量忘了改文档」与「某一种语言抄错了数字」都会红。
 * 这不是「期望值从被测对象推导」——被测对象是那五份文档，期望里的每一个句式
 * 都是独立手写的，而那个数字本身由上面那条 `toBe(43_200_000)` 独立锚着。
 */
describe("12 小时这个上限，五语言 DEPLOY.md 与代码必须说同一件事", () => {
  const HOURS = SESSION_MAX_AGE_MS / 3600_000;

  /** 每种语言写下这句承诺的实际句式，逐条手写，不从文档 grep 回填。 */
  const PROMISE: ReadonlyArray<readonly [string, string]> = [
    ["zh-CN", "面板会在 {h} 小时后要求重新输入口令"],
    ["zh-TW", "面板會在 {h} 小時後要求重新輸入口令"],
    ["en", "The panel asks for the token again after {h} hours"],
    ["ja", "パネルは {h} 時間後にトークンの再入力を求めます"],
    ["ko", "패널은 {h}시간 뒤에 토큰을 다시 입력하도록 요구하지만"],
  ];

  for (const [lang, template] of PROMISE) {
    it(`docs/${lang}/DEPLOY.md 写着「${HOURS} 小时后要重新输入」这条承诺`, () => {
      const src = readFileSync(
        fileURLToPath(new URL(`../../docs/${lang}/DEPLOY.md`, import.meta.url)),
        "utf8",
      );
      expect(src).toContain(template.replace("{h}", String(HOURS)));
    });
  }

  /**
   * **做不到的那一半也必须在文档里。** 只写「12 小时后要重新输入」是一句会被误读成
   * 「会话安全了」的话：CSP 挡得住 `fetch` 与表单外传，**挡不住 `location.href` 导航式
   * 外传**，而 `navigate-to` 这条指令已被规范移除，没有替代。这一格拦的是
   * 「把免责那段删掉、只留下让人安心的那半句」。
   */
  it.each(["zh-CN", "zh-TW", "en", "ja", "ko"])(
    "docs/%s/DEPLOY.md 同时写明了这个上限**做不到**导航式外传的防护",
    (lang) => {
      const src = readFileSync(
        fileURLToPath(new URL(`../../docs/${lang}/DEPLOY.md`, import.meta.url)),
        "utf8",
      );
      // `navigate-to` 被 CSP 规范移除，是「没有可用指令」这个结论的唯一依据。
      expect(src).toContain("navigate-to");
      expect(src).toContain("location.href");
      // 「不等于撤销」那半：撤销的唯一路径仍然是改 secret 重新部署 / 重建容器。
      expect(src).toContain("connect-src 'self'");
    },
  );
});

/**
 * ── 接线绊线：**这是源码文本断言，不是行为断言，边界写在这里** ──────────────
 *
 * 上面那组只证明「判定本身对」。它证明不了 `app.js` 真的调了这个判定——而
 * `admin-ui/js/app.js` 碰 `localStorage` / `fetch` / DOM，按设计文档 §13.1 不进 CI，
 * 整份文件今天**零行为覆盖**。本仓刚栽过同型的一次：跨轮决策留在板块文件里，
 * 把生产接线整行删掉都不会红。
 *
 * 所以这里加一道**很弱但方向正确**的绊线：只拦「整段接线被删掉/改名」，
 * **拦不住**「调了但用错参数」「顺序写反」「异常被吞掉」。那一档仍然只有
 * 冒烟第 15/16 条覆盖，别把这几行读成「前端接线有自动化保障」。
 */
describe("会话上限的生产接线还在（源码文本级绊线，不是行为断言）", () => {
  const APP_JS = readFileSync(
    fileURLToPath(new URL("../../admin-ui/js/app.js", import.meta.url)),
    "utf8",
  );

  it("app.js 从 js/pure/session.mjs 引入 sessionExpired", () => {
    expect(APP_JS).toMatch(/import\s*\{\s*sessionExpired\s*\}\s*from\s*"\.\/pure\/session\.mjs"/);
  });

  it("启动那次 probe 之前先调了 sessionExpired，并把两个时刻都喂给它", () => {
    expect(APP_JS).toContain('sessionExpired(Number(store("getAt")), Date.now())');
  });

  /**
   * 两个键必须一起写、一起清——只清一个的话下一次登录前那个时刻还是旧的。
   *
   * ⚠️ **这里原来还有一行 `toContain('const SAVED_AT_STORE = "agnes2api_admin_key_at"')`**，
   * 也就是把键名的字面量在**第三个地方**又抄了一遍。评审之后键名收进
   * `js/pure/storage-keys.mjs` 单一真源，那一行随之变成"这个文件确实从真源拿键名"
   * 这一句——**名字本身长什么样不再是这里的事**，由
   * `tests/ui/storage-keys.test.ts:52` 那格（除 boot.js 外不许再出现字面量）负责。
   */
  it("口令与时刻两个键一起写、一起清", () => {
    expect(APP_JS).toMatch(
      /import\s*\{[^}]*\bSAVED_AT_STORE\b[^}]*\}\s*from\s*"\.\/pure\/storage-keys\.mjs"/,
    );
    expect(APP_JS).toContain("localStorage.setItem(SAVED_AT_STORE, String(Date.now()))");
    expect(APP_JS).toContain("localStorage.removeItem(SAVED_AT_STORE)");
    expect(APP_JS).toContain("localStorage.removeItem(KEY_STORE)");
  });

  /**
   * 退出登录复用 `store("del")`，因此两个键跟着一起清。
   * 这一格拦的是「有人把 leave() 里的 store("del") 换成只删口令那一句」。
   */
  it("leave() 走 store(\"del\")，两个键跟着一起清", () => {
    expect(APP_JS).toMatch(/function leave\(reason\)[\s\S]{0,400}?store\("del"\)/);
  });
});
