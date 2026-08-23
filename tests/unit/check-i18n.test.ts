import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

const SCRIPT = resolve("scripts/check-i18n.mjs");

/**
 * **第 6 道门禁（`scripts/check-i18n.mjs`）自己的元测试**（全分支评审 I2）。
 *
 * ⚠️ **在这份文件出现之前，这道门禁零覆盖。** 八条判据里任何一条被写坏——正则打错
 * 一个字符、`continue` 少一层、`errors.push` 那行被删掉——它都会安静地 exit 0，
 * 而"门禁绿了"恰恰是所有人赖以放心的那个信号。本仓已经栽过一次同型的：第 ⑧ 条
 * 判据第一版只认双引号，把它存在的全部理由要防的那个缺陷换成单引号原样重放，
 * 它 exit 0、零报错。**门禁不测自己，等于没有门禁。**
 *
 * 做法与 `tests/unit/check-no-binary.test.ts` 的「空仓库（没有任何跟踪文件）：通过」
 * 那一套同构：不在真仓上做变异（那要往
 * `admin-ui/` 里塞坏文件），改用临时目录 + 脚本的根目录入参。
 *
 * **两条如实登记的逃逸边界**（下面 `describe("第 ⑧ 条判据的两条已知边界")`）：
 * 脚本自己的注释写着"把这种 key 塞进数组时后面也是 `,`，会漏过去；放在数组末尾
 * 则会误报"。那两句话此前**从没有被验证过**——它们完全可能与实现不符（本仓已经
 * 记了二十余次"注释里写下一句假断言"）。这里把两者都变成会变红的断言：
 * 一条钉住"确实漏"，一条钉住"确实误报"。哪天有人改进了判据，这两格会变红，
 * 那正是提醒他回去改注释的地方。
 */

/** 五语言齐全的一行字典。 */
function row(text: string): Record<string, string> {
  return { "zh-CN": text, "zh-TW": text, en: text, ja: text, ko: text };
}

interface Fixture {
  /** key -> 五语言（或故意残缺的）行。 */
  dict: Record<string, Record<string, string>>;
  /** 额外文件：相对 admin-ui/ 的路径 -> 内容。 */
  files?: Record<string, string>;
}

/**
 * 造一棵最小的 `admin-ui/` 树并跑门禁。
 *
 * ⚠️ **夹具里曾经自动补 18 条 `filler.N` 的 key 与引用**，理由是「脚本第 ① 条要求至少
 * 扫到 15 处引用」。P3e Task 3 复评之后那道门槛已经删掉（死区 97%，且它给自己写的
 * 耦合理由早就不成立），填充也随之删掉：**夹具里每一条 key 都该是被测的那一条**，
 * 多出来的十八条只会让「三个分桶加起来等于总数」这类断言里出现一个与被测行为无关的常数。
 */
function run(fx: Fixture): { status: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "a2a-i18n-"));
  try {
    const dict: Record<string, Record<string, string>> = { ...fx.dict };
    const write = (rel: string, body: string) => {
      const full = join(dir, "admin-ui", rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body, "utf8");
    };
    write("js/i18n-dict.js", `export const I18N = ${JSON.stringify(dict, null, 2)};\n`);
    for (const [rel, body] of Object.entries(fx.files ?? {})) write(rel, body);

    // **`spawnSync` 而不是 `execFileSync`**：后者成功时只交出 stdout，把 stderr 扔掉，
    // 而第 ④ 条（未被引用的 key）恰恰是"exit 0 + 一条 stderr 警告"——用 execFileSync
    // 的话那一格永远看不见警告，"只警告不报错"这半条就不可观测了。
    const r = spawnSync("node", [SCRIPT, dir], { encoding: "utf8" });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 横幅上那三个分桶（P3e Task 3 新增）。**逐字解析，不许各处自己 `toContain` 一个数字**：
 * 分桶的行文改了，这里一处红，比十处 `toContain` 各自漂过去好。
 */
const BUCKET_RE = /\[check-i18n\] 引用判据：直接引用 (\d+) \/ 拼键覆盖 (\d+) \/ 未被引用 (\d+)；字典共 (\d+) 个 key/;

function buckets(r: { stdout: string }): { direct: number; covered: number; unref: number; total: number } {
  const m = BUCKET_RE.exec(r.stdout);
  if (m === null) throw new Error(`横幅里没有逐字打印三个分桶：\n${r.stdout}`);
  return { direct: Number(m[1]), covered: Number(m[2]), unref: Number(m[3]), total: Number(m[4]) };
}

/** 横幅上「未被引用」那一行列出的 key（`（无）` ⇒ 空数组）。 */
function unrefList(r: { stdout: string }): string[] {
  const m = /\[check-i18n\] 未被引用: (.*)/.exec(r.stdout);
  if (m === null) throw new Error(`横幅里没有「未被引用」那一行：\n${r.stdout}`);
  return m[1] === "（无）" ? [] : m[1]!.split(", ");
}

/** 横幅上「拼键前缀」那一行列出的前缀（`（无）` ⇒ 空数组）。 */
function tplPrefixList(r: { stdout: string }): string[] {
  const m = /\[check-i18n\] 拼键前缀: (.*)/.exec(r.stdout);
  if (m === null) throw new Error(`横幅里没有「拼键前缀」那一行：\n${r.stdout}`);
  return m[1] === "（无）" ? [] : m[1]!.split(", ");
}

describe("scripts/check-i18n.mjs 元测试：干净的树", () => {
  /**
   * **反向自检，必须在最前。** 少了它，"一律 exit 1"也能让下面每一格全绿——
   * 而那样的门禁在真仓上永远红着，第一时间就会被人加 `|| true` 绕过去。
   */
  it("五语言齐全、引用都在字典里：exit 0", () => {
    const r = run({ dict: { "nav.overview": row("概览") }, files: { "js/x.js": 't("nav.overview");\n' } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("全部对得上");
  });
});

describe("scripts/check-i18n.mjs 元测试：八条判据逐条", () => {
  it("① 源码引用了字典里没有的 key：exit 1", () => {
    const r = run({ dict: { "nav.overview": row("概览") }, files: { "js/x.js": 't("nav.typo");\n' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("nav.typo");
  });

  it("① 属性形态（data-i18n）同样被扫到", () => {
    const r = run({
      dict: { "nav.overview": row("概览") },
      files: { "index.html": '<h2 data-i18n="nav.missing">x</h2>\n' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("nav.missing");
  });

  // ⚠️ **这里曾经有一格「① 引用数掉到门槛以下（扫描本身坏了）：exit 1」，P3e Task 3
  // 复评之后连同被测的那道门槛一起删了，别加回来。** 那道门槛在真仓上的死区实测 97%
  //（判据瞎掉九成七它仍然一声不吭），而它给自己写的理由——「与
  // `tests/unit/i18n-dict.test.ts`「admin-ui 里引用的每个 key 都在字典里」是同一个量的
  // 两份实现、必须同边界」——两侧量的根本不是同一个量、那个边界两侧都不可达。
  // 删门槛的同时删这一格是必须的：留着它会红，而它红的时候指的是一件已经不存在的事。

  it("② 某个 key 缺一种语言：exit 1，且报出是哪个 key 缺哪种语言", () => {
    const bad = row("概览");
    delete bad.ko;
    const r = run({ dict: { "nav.overview": bad }, files: { "js/x.js": 't("nav.overview");\n' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("nav.overview 缺 ko");
  });

  it("② 空串 / 纯空白也算缺（不是「有这个键就行」）", () => {
    const r = run({
      dict: { "nav.overview": { ...row("概览"), ja: "   " } },
      files: { "js/x.js": 't("nav.overview");\n' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("nav.overview 缺 ja");
  });

  it("③ 多余的语言码（拼错的语言码永远取不到）：exit 1", () => {
    const r = run({
      dict: { "nav.overview": { ...row("概览"), "zh-Hans": "概览" } },
      files: { "js/x.js": 't("nav.overview");\n' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("zh-Hans");
  });

  it("④ 字典里有没被引用的 key：**只警告不报错**（动态拼的 key 抓不到，报错会误伤）", () => {
    const r = run({
      dict: { "nav.overview": row("概览"), "nav.unused": row("没人用") },
      files: { "js/x.js": 't("nav.overview");\n' },
    });
    expect(r.status, "这一条必须是警告，不是错误").toBe(0);
    expect(r.stderr + r.stdout).toContain("nav.unused");
  });

  it("⑤ 插值占位符在各语言间不一致：exit 1", () => {
    const r = run({
      dict: { "ov.n": { ...row("共 {count} 条"), en: "total items" } },
      files: { "js/x.js": 't("ov.n", { count: 1 });\n' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("插值占位符在各语言间不一致");
  });

  it("⑥ reg.* 出现偏好词（含繁体与外语变体）：exit 1", () => {
    for (const [lang, word] of [["zh-TW", "推薦"], ["en", "recommended"], ["ko", "권장"]] as const) {
      const r = run({
        dict: { "reg.x": { ...row("中性说法"), [lang]: word } },
        files: { "js/x.js": 't("reg.x");\n' },
      });
      expect(r.status, `${lang}/${word} 没被拦住`).toBe(1);
      expect(r.stderr).toContain("偏好词");
    }
  });

  /**
   * ⚠️⚠️ **复评实测的真缺口，这里补一条正向用例**：`keys.addMenu.auto*`
   * （P3c Task 4 「添加 Key」下拉里【自动注册】两条占位）原来完全不在扫描
   * 范围内——给 `keys.addMenu.autoMoemail` 塞一句「推荐使用」，门禁 exit 0。
   * 下面这格钉住扩展之后的范围：这个命名空间也要被拦住。
   */
  it("⑥ keys.addMenu.auto* 现在也在扫描范围内（复评追加）", () => {
    for (const [lang, word] of [["zh-TW", "推薦"], ["en", "recommended"], ["ko", "권장"]] as const) {
      const r = run({
        dict: { "keys.addMenu.autoMoemail": { ...row("中性说法"), [lang]: word } },
        files: { "js/x.js": 't("keys.addMenu.autoMoemail");\n' },
      });
      expect(r.status, `${lang}/${word} 没被拦住`).toBe(1);
      expect(r.stderr).toContain("偏好词");
    }
  });

  it("⑥ 只管 reg.* 与 keys.addMenu.auto*：同样的词出现在别的命名空间不报错", () => {
    const r = run({
      dict: { "nav.x": { ...row("中性"), en: "recommended" } },
      files: { "js/x.js": 't("nav.x");\n' },
    });
    expect(r.status, "这条禁令的范围被扩大了").toBe(0);
  });

  /**
   * 反向自检：`keys.addMenu` 命名空间下**不带 `auto` 前缀**的 key（比如
   * 【手动】那两项 `keys.addMenu.pasteSingle`）不该被误伤——扩展的前缀是
   * `keys.addMenu.auto`，不是整个 `keys.addMenu.*`。
   */
  it("⑥ keys.addMenu.pasteSingle（非 auto 前缀）不在扩展范围内，不报错", () => {
    const r = run({
      dict: { "keys.addMenu.pasteSingle": { ...row("中性"), en: "recommended" } },
      files: { "js/x.js": 't("keys.addMenu.pasteSingle");\n' },
    });
    expect(r.status, "扩展前缀不该把整个 keys.addMenu.* 都纳入进来").toBe(0);
  });

  it("⑦ 字典里出现 IP:PORT 形态（scan-secrets 会打红 CI）：exit 1", () => {
    const r = run({
      // ⚠️ **字面量要拆开拼**：写成一整串的话，`scripts/scan-secrets.sh`（CI 第 2 道）
      // 会在**这份源码**里命中同一条 IP:PORT 正则，把 CI 打红——夹具与它要触发的
      // 那道门禁用的是同一条判据。已实测踩过一次。
      dict: { "nav.x": { ...row("正常"), en: `connect to 203.0.113.7${":"}8080` } },
      files: { "js/x.js": 't("nav.x");\n' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("IP:PORT");
  });

  /**
   * ⑧ 是这道门禁里**唯一没有第二份独立实现**的一条（脚本自己的文件头写着这件事），
   * 所以它最需要元测试。两种引号都要拦得住——第一版只认双引号，把当初那个已上线
   * 缺陷换成单引号原样重放，门禁 exit 0、零报错。
   */
  it.each(['"', "'"])("⑧ 带占位符的 key 被当成不带参数的标签用（%s 引号）：exit 1", (q) => {
    const r = run({
      dict: { "ov.n": row("共 {count} 条") },
      files: { "js/x.js": `row(${q}ov.n${q});\n` },
    });
    expect(r.status, `${q} 引号形态没被拦住`).toBe(1);
    expect(r.stderr).toContain("裸的 {占位符}");
  });

  it("⑧ data-i18n 属性形态同样被拦下（apply() 走的也是不带参数的 t()）", () => {
    const r = run({
      dict: { "ov.n": row("共 {count} 条") },
      files: { "index.html": '<p data-i18n="ov.n"></p>\n' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("裸的 {占位符}");
  });

  it("⑧ 正常带参数用时不报错（否则这条门禁在真仓上永远红着）", () => {
    const r = run({
      dict: { "ov.n": row("共 {count} 条") },
      files: { "js/x.js": 't("ov.n", { count: 1 });\n' },
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it("⑧ 字典自己是定义处，不算调用点", () => {
    // `run()` 已经把这个 key 写进 i18n-dict.js（`"ov.n": {…}`，后面跟的是 `:`）。
    // 不豁免字典文件的话，每一个带占位符的 key 都会在这里被误报一次。
    const r = run({
      dict: { "ov.n": row("共 {count} 条") },
      files: { "js/x.js": 't("ov.n", { count: 1 });\n' },
    });
    expect(r.status, "字典的定义处被当成了调用点").toBe(0);
  });
});

/**
 * **第 ① 条判据换形状之后的那一族（P3e Task 3）。**
 *
 * 旧判据是两条只认双引号的正则（`data-i18n(?:-ph|-title)?="…"` 与 `t("…"`）。
 * 真仓实测：字典 521 个 key，它只看得见 125 处引用、报 396 条「未被引用」，
 * 其中 371 条是**假警报**——那些 key 明明有字面量，只是写法不在那两种里。
 * **396 条噪音把 3 条真的埋了**，而这正是本仓那条「一个诚实标记出现得太密就不再传递信息」。
 *
 * ⚠️⚠️ **下面这一族里「放宽方向」的每一格，都配了一条反向控制。**
 * 把判据放宽天生会**减少**报警 ⇒ 「警报变少」本身既可能是「认对了」也可能是
 * 「判据瞎了」的症状，两者在计数上长得一模一样。分辨它们靠的是**正向探针**：
 * (a)/(b) 往里塞一个拼错的 key，判据必须**吵**；瞎掉的判据什么都不吵。
 */
describe("scripts/check-i18n.mjs 元测试：第 ① 条判据换形状之后（P3e Task 3）", () => {
  /**
   * (a)(b) **这是整条判据的存在理由**：`elI18n('h2', 'usage.titel')` 实测能让六道
   * 脚本门禁 + 全量用例一起全绿，而用量板块主标题在五种语言下显示裸串。
   * 旧判据两种引号都逃逸（它只认 `t("` 与 `data-i18n="`），所以两种引号各钉一格。
   */
  it.each([["'", "单引号"], ['"', "双引号"]])(
    "(a)(b) elI18n(%s…) 里拼错的 key 被抓住（%s 形态）：exit 1",
    (q) => {
      const r = run({
        dict: { "usage.title": row("用量") },
        files: { "js/sec-usage.js": `elI18n(${q}h2${q}, ${q}usage.titel${q});\n` },
      });
      expect(r.status, `${q} 引号形态没被抓住`).toBe(1);
      expect(r.stderr).toContain("usage.titel");
    },
  );

  /**
   * **(a)(b) 的反向控制。** 少了它，「一律 exit 1」也能让上面两格全绿。
   * 拼对时必须安静——否则这道门禁在真仓上永远红着，第一时间会被人加 `|| true` 绕开。
   */
  it.each([["'", "单引号"], ['"', "双引号"]])(
    "(a)(b) 反向控制：同样的写法拼对时不报错（%s ⇒ %s 形态）：exit 0",
    (q) => {
      const r = run({
        dict: { "usage.title": row("用量") },
        files: { "js/sec-usage.js": `elI18n(${q}h2${q}, ${q}usage.title${q});\n` },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(unrefList(r), "拼对的 key 不许落进「未被引用」").not.toContain("usage.title");
    },
  );

  /**
   * (c) **「先抠注释」是广扫的前置，不是可选项。**
   * 不抠就广扫会当场自绊：真仓实测多出一条硬错，来自
   * `admin-ui/js/pure/usage.mjs` 里刻意留着的 `"usage.titel"` 变异样例——
   * 那是散文，不是引用点。
   */
  it("(c) JS 注释里的 data-i18n 不算引用（否则广扫会被注释自绊）：exit 0", () => {
    const r = run({
      dict: { "nav.overview": row("概览") },
      files: { "js/theme.js": '// data-i18n="nav.usageZZZ"\nt("nav.overview");\n' },
    });
    expect(r.status, r.stderr).toBe(0);
  });

  /**
   * **(c) 的反向控制：它没变成「见什么都不报」。** 同一行去掉 `//` 就必须红。
   * ⚠️ 只做 (c) 那一半等于没做——那一半单独看，「判据整个瞎了」也能让它绿。
   */
  it("(c) 反向控制：同一行不在注释里时必须报（差别只在那两个斜杠）：exit 1", () => {
    const r = run({
      dict: { "nav.overview": row("概览") },
      files: { "js/theme.js": '<p data-i18n="nav.usageZZZ"></p>\nt("nav.overview");\n' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("nav.usageZZZ");
  });

  /**
   * **HTML 是第三种注释语义。** 广扫要扫 `admin-ui/index.html` 里那 16 处 `data-i18n=`，
   * 而那份文件的注释是 `<!-- -->`，抠它走真源的第四个出口 `stripHtmlComments`。
   * ⚠️ 拿 JS 方言去抠这份 HTML 实测当场抛（`</title>` 里那个斜杠被判成正则开头）。
   */
  it("(c-html) HTML 注释里的 data-i18n 不算引用：exit 0", () => {
    const r = run({
      dict: { "nav.overview": row("概览") },
      files: { "index.html": '<!-- <h2 data-i18n="nav.usageZZZ"></h2> -->\n<p data-i18n="nav.overview"></p>\n' },
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it("(c-html) 反向控制：同一段不在 HTML 注释里时必须报：exit 1", () => {
    const r = run({
      dict: { "nav.overview": row("概览") },
      files: { "index.html": '<h2 data-i18n="nav.usageZZZ"></h2>\n<p data-i18n="nav.overview"></p>\n' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("nav.usageZZZ");
  });

  /**
   * (d) **本任务仍不改第 ④ 条的严重级别**（那是 Task 4）：没人引用的 key 还是警告。
   * 但它必须**出现在「未被引用」分桶里**——那是 Task 4 升硬错时的观测点。
   */
  it("(d) 谁都不引用的 key：本任务仍 exit 0，但必须出现在「未被引用」分桶里", () => {
    const r = run({
      dict: { "nav.overview": row("概览"), "nav.lonely": row("没人用") },
      files: { "js/x.js": 't("nav.overview");\n' },
    });
    expect(r.status, "本任务不改第 ④ 条的严重级别").toBe(0);
    expect(unrefList(r)).toContain("nav.lonely");
    expect(unrefList(r), "被引用的那个不许也落进来").not.toContain("nav.overview");
  });

  /**
   * (e) ⚠️⚠️ **这一格钉住的是那条正则的形状，不是它的结果**（CRITICAL）。
   *
   * 命名空间前缀必须**写进正则里去锚定引号对**，不许「先通用配对引号、再回头看是不是 key」。
   * 两者在有空串字面量 `""` 的行上会分叉：`"([^"\n]+)"` 要求引号里至少一个字符，
   * 遇到 `""` 时第一个引号匹配失败、引擎前进一格，从**第二个引号**重新开配，
   * **后面那个真 key 整个被吃掉**。真仓实测这一族有 11 条假阳性，
   * 而 Task 4 紧接着要把「未被引用」升成硬错 ⇒ 会 exit 1 在 11 个正在用的 key 上。
   *
   * 下面三行取自真仓的三种形态（`sec-registrar.js` / `sec-models.js` / `sec-playground.js`）。
   */
  it("(e) 同一行上的空串字面量不许把后面那个 key 吃掉 —— 通用配对引号版会在这里错位", () => {
    const r = run({
      dict: {
        "reg.zzzChannelAny": row("任意"),
        "models.zzzEmpty": row("空"),
        "models.zzzFilterEmpty": row("筛完是空"),
        "nav.zzzA": row("甲"),
        "nav.zzzB": row("乙"),
      },
      files: {
        "js/x.js": [
          'el("option", { value: "" }, t("reg.zzzChannelAny"));',
          'const k = filter === "" ? "models.zzzEmpty" : "models.zzzFilterEmpty";',
          "const q = x === '' ? 'nav.zzzA' : 'nav.zzzB';",
          "",
        ].join("\n"),
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(
      unrefList(r),
      "有 key 被空串字面量吃掉了 ⇒ 那条正则写成了「通用配对引号」版，回去把命名空间前缀写进正则本身",
    ).toEqual([]);
    expect(buckets(r).direct, "夹具里那五个 key，一个都不许丢").toBe(5);
  });

  /**
   * **横幅上的三个分桶必须是字典 key 的一个划分**——三个数加起来恒等于字典 key 总数。
   *
   * ⚠️ 这一格刻意**带一条引用了字典里没有的 key 的坏行**：那条 bogus 引用会让
   * 「直接引用」这个数按写法分叉——把它算进「直接引用」的实现（`directlyUsed.size`）
   * 在这里三个数会加出比字典总数**多一个**。**不带 bogus 的话这一格是恒真的**，
   * 恒真的断言是待办不是守卫。
   */
  it("横幅逐字打印三个分桶，且三个数加起来等于字典 key 总数（有 bogus 引用时也必须成立）", () => {
    const r = run({
      dict: { "nav.overview": row("概览"), "nav.unused": row("没人用") },
      files: { "js/x.js": 't("nav.overview");\nt("nav.typo");\n' },
    });
    expect(r.stdout).toMatch(/直接引用 \d+/);
    expect(r.stdout).toMatch(/拼键覆盖 \d+/);
    expect(r.stdout).toMatch(/未被引用 \d+/);
    const b = buckets(r);
    expect(b.total, "夹具里那 2 个 key").toBe(2);
    expect(
      b.direct + b.covered + b.unref,
      "三个分桶不是字典 key 的一个划分 ⇒ 「直接引用」里混进了字典里没有的 key",
    ).toBe(b.total);
    expect(r.status, "bogus 引用本身仍然是第 ① 条的硬错").toBe(1);
    expect(r.stdout, "红的时候也必须先把分桶打出来 —— 那是 Task 4 的观测点").toMatch(BUCKET_RE);
  });

  /**
   * **广扫必须跳过字典自己**（搬运风险 ④）。旧判据没跳它，因为旧判据只认 `t("…"` 与
   * `data-i18n=`，字典里都没有；换成命名空间广扫之后不跳，字典里每一行
   * `"key": { … }` 都会让那个 key **自证被引用** ⇒ 第 ④ 条恒绿、判据整个作废。
   */
  it("只在字典里出现的 key 必须落进「未被引用」—— 字典自己是定义处，不是引用点", () => {
    const r = run({
      dict: { "nav.overview": row("概览"), "nav.onlyInDict": row("只在字典里") },
      files: { "js/x.js": 't("nav.overview");\n' },
    });
    expect(
      unrefList(r),
      "字典文件被当成了引用点 ⇒ 每个 key 都自证被引用，第 ④ 条从此恒绿",
    ).toContain("nav.onlyInDict");
  });

  /**
   * **拼键前缀那张表**（`fieldLabelKey()` 返回的 `` `set.field.${path}` `` 这一族）。
   * 真仓有 22 个 key 只经由模板拼键被引用，静态判据天生看不见它们的完整名字。
   */
  it("拼键前缀：模板字面量的前缀认得出，前缀底下的 key 落进「拼键覆盖」", () => {
    const r = run({
      dict: { "set.field.a": row("甲"), "set.field.b": row("乙") },
      files: { "js/x.js": 'const k = `set.field.${path}`;\n' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(tplPrefixList(r)).toEqual(["set.field."]);
    expect(buckets(r).covered, "两个 key 都该被前缀覆盖").toBe(2);
    expect(unrefList(r)).toEqual([]);
  });

  /**
   * ⚠️⚠️ **这一格是拼键前缀表的绊线**（P3e 计划点名 Task 3 owns）。
   * 前缀是 `set.field.`，**不是 `set.`**：把 `TPL_PREFIX` 放宽成只取第一段、
   * 或者把 `startsWith` 换成命名空间比对，`set.card.x` 会被凭空喂活，
   * 而它正是 Task 4 要处置的那一族 ⇒ 一条真的死 key 从此永远看不见。
   */
  it("拼键前缀的绊线：前缀是整段 `set.field.`，不许放宽成命名空间 `set.`", () => {
    const r = run({
      dict: { "set.field.a": row("甲"), "set.card.x": row("卡片说明") },
      files: { "js/x.js": 'const k = `set.field.${path}`;\n' },
    });
    expect(tplPrefixList(r)).toEqual(["set.field."]);
    expect(
      unrefList(r),
      "`set.card.x` 被拼键前缀凭空喂活了 ⇒ 前缀被放宽到了命名空间那一档",
    ).toEqual(["set.card.x"]);
    expect(buckets(r).covered).toBe(1);
  });

  /**
   * **拼键前缀的反向控制：它不乱收。** 不在字典命名空间里的模板前缀不许进表——
   * 否则 `` `${base}/admin/api/` `` 这种拼路径的模板也会变成一条「前缀」，
   * 而一条足够短的前缀能把整本字典一并喂活。
   */
  it("拼键前缀的反向控制：不在字典命名空间里的模板前缀不许进表", () => {
    const r = run({
      dict: { "set.field.a": row("甲"), "nav.overview": row("概览") },
      files: { "js/x.js": 'const u = `zzz.${path}`;\nt("nav.overview");\n' },
    });
    expect(tplPrefixList(r), "`zzz` 不是字典命名空间，不许进前缀表").toEqual([]);
    expect(unrefList(r)).toEqual(["set.field.a"]);
  });

  /**
   * **广扫的「不乱红」那一半。** 命名空间锚定意味着：第一段不是字典命名空间的字符串
   * 一律不算 key。少了这一格，把正则放宽成「任何带点的字符串」也能让上面每一格全绿，
   * 而真仓里会冒出一堆「引用了字典里没有的 key」的假硬错。
   */
  it("不乱红：第一段不是字典命名空间的字符串字面量不许被当成 key", () => {
    const r = run({
      dict: { "nav.overview": row("概览") },
      files: {
        "js/x.js": [
          't("nav.overview");',
          'const u = "https://example.com/a.b";',
          'const m = "not.a.namespace";',
          "const n = 'a.b';",
          'const f = "sec-usage.js";',
          "",
        ].join("\n"),
      },
    });
    expect(r.status, r.stderr).toBe(0);
  });

  /**
   * **射程绊线：HTML 里出现内联脚本 / 样式。**
   * 抠 HTML 注释走的是只认 `<!-- -->` 的那个出口，它**看不见内联 `<script>` 里的
   * JS 注释**——那一段里被注释掉的 `data-i18n=` 会当成真引用混进来。
   * 今天 `admin-ui/index.html` 的两个 `<script>` 都只有 `src=`，零内联内容；
   * 哪天真写了内联，这条判据必须在第一时间把门禁打红，而不是静静地放行。
   */
  it("HTML 里出现内联脚本 / 样式：exit 1（本门禁对 HTML 只抠 `<!-- -->`）", () => {
    const r = run({
      dict: { "nav.overview": row("概览") },
      files: { "index.html": '<p data-i18n="nav.overview"></p>\n<script>\nconsole.log(1);\n</script>\n' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("内联");
  });

  it("HTML 里只有外链脚本时不报错（否则这条判据在真仓上永远红着）", () => {
    const r = run({
      dict: { "nav.overview": row("概览") },
      files: { "index.html": '<script src="/admin/js/boot.js"></script>\n<p data-i18n="nav.overview"></p>\n' },
    });
    expect(r.status, r.stderr).toBe(0);
  });

  /**
   * ⚠️ **上面那条绊线扫的必须是抠完注释的源码，不是原文**（P3e Task 3 复评 F1）。
   * 扫原文的话，一段**被 HTML 注释掉的**内联 `<script>` 会把第 6 道门禁打成假红，
   * 而报文还劝人「把它挪进外链文件」——那段脚本本来就是死的，挪它是一件没有意义的活。
   * 这一格与上面那格「HTML 里出现内联脚本 / 样式」是一对：一格钉住「真内联必须红」，
   * 一格钉住「死内联不许红」。**只做前一半，判据扫 raw 还是扫 src 就分辨不出来。**
   */
  it("被 HTML 注释掉的内联 <script> 不算内联内容（否则门禁假红）", () => {
    const r = run({
      dict: { "nav.overview": row("概览") },
      files: {
        "index.html": '<p data-i18n="nav.overview"></p>\n<!-- <script>console.log(1);</script> 旧写法 -->\n',
      },
    });
    expect(
      r.status,
      "被注释掉的内联脚本把门禁打红了 ⇒ 那条绊线扫的是 raw，请改成扫抠完注释的 src",
    ).toBe(0);
  });

  /**
   * ⚠️⚠️ **少一个 `-->` 不许静默吞掉文件尾**（P3e Task 3 复评 F2，这是本轮最要命的一条）。
   *
   * 复评在真 `admin-ui/index.html` 上实测：删掉第 8 行那个 `-->` ⇒ 引用数 496 掉到 480
   *（整份文件尾的 `data-i18n=` 全部消失）、门禁**打着 ✅ 横幅 exit 0**。
   * 也就是说，一个漏写的闭合记号能让一批活着的 key 凭空「变死」，而 Task 4 正要把
   *「未被引用」升成硬错并据此删 key ⇒ 删掉的是活文案。
   * 修在真源（`scripts/lib/strip-comments.mjs` 的 `stripHtmlComments`：未闭合就抛），
   * 这一格从门禁这一侧钉住那个后果：**差别只在那三个字符。**
   */
  it("index.html 少一个 `-->`：门禁必须吵，不许静默吞掉文件尾的引用", () => {
    const tail = '<p data-i18n="nav.overview"></p>\n';
    // 反向控制先跑：闭合的注释 + 注释之后的引用 ⇒ 安静，且那个 key 认得出。
    const closed = run({
      dict: { "nav.overview": row("概览") },
      files: { "index.html": `<!-- 说明 -->\n${tail}` },
    });
    expect(closed.status, closed.stderr).toBe(0);
    expect(unrefList(closed), "闭合时那个 key 必须被认出来").toEqual([]);
    // 同一份文件，只删掉那三个字符。
    const unclosed = run({
      dict: { "nav.overview": row("概览") },
      files: { "index.html": `<!-- 说明\n${tail}` },
    });
    expect(
      unclosed.status,
      "少一个 `-->` 之后门禁仍然 exit 0 ⇒ 文件尾被静默吞掉了，"
      + "去 scripts/lib/strip-comments.mjs 的 stripHtmlComments 看「未闭合就抛」那一支",
    ).not.toBe(0);
    expect(unclosed.stderr).toContain("HTML 注释开了没有闭合记号");
  });

  /**
   * ⚠️⚠️ **「首段是不是字典命名空间」回答不了「这个模板在不在拼 i18n key」**
   *（P3e Task 3 复评 F4；落点逐字取自 `admin-ui/js/pure/settings.mjs` 那两条配置路径模板）。
   *
   * 这一格自带两半，**两半缺一不可**：
   * · ① 字典里没有那个命名空间时**必须静默**——今天的真仓就是这一格，
   *   少了它，「一律吵」也能让 ② 全绿，而那样的门禁在真仓上永远红着。
   * · ② 字典一新增那个命名空间，同一条模板立刻变成「分不清」⇒ **必须吵**。
   *   静默当成拼键的代价不是「多一条前缀」：那个前缀底下**所有** key 会被一并喂活，
   *   其中的真死 key 从此不出现在 Task 4「处置真 0 命中 key」的输入里 ⇒ **漏删，
   *   而漏删的表现是「看起来什么事都没有」。**
   */
  it("拼键前缀：插值之后还跟着别的东西 ⇒ 分不清就吵，不许静默当成拼键", () => {
    const files = { "js/x.js": 'const p = `registrar.${channel}.baseUrl`;\nt("nav.overview");\n' };
    const quiet = run({ dict: { "nav.overview": row("概览") }, files });
    expect(quiet.status, quiet.stderr).toBe(0);
    expect(tplPrefixList(quiet), "`registrar` 不是字典命名空间 ⇒ 与 i18n 无关，不许进表也不许吵").toEqual([]);
    const loud = run({ dict: { "nav.overview": row("概览"), "registrar.dead": row("没人用") }, files });
    expect(
      loud.status,
      "一条配置路径模板被静默当成了拼键前缀 ⇒ `registrar.*` 底下的真死 key 从此永远看不见",
    ).toBe(1);
    expect(loud.stderr).toContain("分不清");
    expect(
      unrefList(loud),
      "既然没被当成拼键，那条真死 key 必须仍然留在「未被引用」里",
    ).toContain("registrar.dead");
  });
});

/**
 * **第 ① 条判据的三条已知漏报形态。**
 *
 * `scripts/check-i18n.mjs` 第 ① 条上面那段「边界」里逐条写着这三种写法不被支持。
 * 那三句话此前**只是散文**（复评 F7：两条今天零实例、也没有任何东西钉着它们）。
 * 这里把它们各变成一条会变红的断言，每一格都配一条**反向控制**：
 * 同一个 key 换成判据认得的形态时必须被认出来——少了反向控制，
 * 「夹具本身就坏了」与「这条形态确实看不见」在证据上分辨不出来。
 *
 * ⚠️ **这三格断言的是「今天就是这样」，不是「这样是对的」。**
 * 三条**全部是漏报方向**（key 明明有人用却落进「未被引用」），而 Task 4 要把
 * 「未被引用」升成硬错并据此删 key ⇒ 到那时它们就是「删掉活着的文案」。
 * 哪天判据扩到某一条，这里会红，而红的地方正是该回去改那段边界的地方。
 */
describe("scripts/check-i18n.mjs 元测试：第 ① 条判据的三条已知漏报形态", () => {
  it("漏报一：按 `+` 拼的 key 看不见 —— 它会落进「未被引用」", () => {
    const r = run({
      dict: { "nav.overview": row("概览") },
      files: { "js/x.js": 'const k = "nav." + name;\n' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(
      unrefList(r),
      "判据认得 `+` 拼键了 —— 请回去改 check-i18n.mjs 第 ① 条那段边界说明",
    ).toEqual(["nav.overview"]);
  });

  it("漏报二：反引号里的纯 key 字面量看不见（反引号那一路只走拼键前缀）", () => {
    const r = run({
      dict: { "nav.overview": row("概览") },
      files: { "js/x.js": "elI18n('h2', `nav.overview`);\n" },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(
      unrefList(r),
      "判据认得反引号里的纯 key 了 —— 请回去改 check-i18n.mjs 第 ① 条那段边界说明",
    ).toEqual(["nav.overview"]);
    // 反向控制：同一处换成引号形态就必须被认出来（证明夹具本身没坏）。
    const ok = run({
      dict: { "nav.overview": row("概览") },
      files: { "js/x.js": "elI18n('h2', 'nav.overview');\n" },
    });
    expect(unrefList(ok), "换成引号形态仍然看不见 ⇒ 上面那格红的原因不是反引号").toEqual([]);
  });

  it("漏报三：HTML 里不带引号的属性值看不见（KEYLIKE 锚的是引号对）", () => {
    const r = run({
      dict: { "nav.overview": row("概览") },
      files: { "index.html": "<p data-i18n=nav.overview></p>\n" },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(
      unrefList(r),
      "判据认得不带引号的属性值了 —— 请回去改 check-i18n.mjs 第 ① 条那段边界说明",
    ).toEqual(["nav.overview"]);
    // 反向控制：单引号与双引号两种都必须认得出。
    for (const q of ['"', "'"]) {
      const ok = run({
        dict: { "nav.overview": row("概览") },
        files: { "index.html": `<p data-i18n=${q}nav.overview${q}></p>\n` },
      });
      expect(unrefList(ok), `带 ${q} 引号的属性值没被认出来 ⇒ 上面那格红的原因不是缺引号`).toEqual([]);
    }
  });
});

/**
 * **第 ⑧ 条判据的两条已知边界。**
 *
 * `scripts/check-i18n.mjs` 的第 ⑧ 段注释里写着这两句话：
 *   「把这种 key 塞进数组（`["ev.timeline", …]`）时后面也是 `,`，会漏过去；
 *     放在数组末尾则会误报。」
 * 那两句此前**没有任何东西验证过**。下面两格把它们各自变成一条会变红的断言：
 * 判据哪天被改进（或被改坏），这里就会红，而红的地方正是该回去改注释的地方。
 *
 * **这两格断言的是"当前实现就是这样"，不是"这样是对的"。** 别把它们读成
 * "数组写法被支持了"。
 */
describe("scripts/check-i18n.mjs 元测试：第 ⑧ 条判据的两条已知边界", () => {
  it("边界一：数组里非末尾的位置**会漏过去**（后面跟着 `,`，判据看不出区别）", () => {
    const r = run({
      dict: { "ov.n": row("共 {count} 条"), "ov.m": row("其它") },
      files: { "js/x.js": 'const COLS = ["ov.n", "ov.m"];\n' },
    });
    expect(
      r.status,
      "第 ⑧ 条判据被改进了（数组里的裸用现在拦得住）—— 请回去改 check-i18n.mjs 里那段"
      + "「会漏过去」的边界说明，别让注释继续说一件不再成立的事",
    ).toBe(0);
  });

  it("边界二：数组**末尾**会误报（后面跟着 `]`，被当成不带参数的标签）", () => {
    const r = run({
      dict: { "ov.m": row("其它"), "ov.n": row("共 {count} 条") },
      files: { "js/x.js": 'const COLS = ["ov.m", "ov.n"];\n' },
    });
    expect(
      r.status,
      "第 ⑧ 条判据被改进了（数组末尾不再误报）—— 请回去改 check-i18n.mjs 里那段边界说明",
    ).toBe(1);
    expect(r.stderr).toContain("裸的 {占位符}");
  });
});
