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
 * 做法与 `tests/unit/check-no-binary.test.ts` 同一套：不在真仓上做变异（那要往
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
 * **门槛：脚本第 ① 条要求至少扫到 15 处引用**，所以每个夹具都自动补足一批
 * `filler.N` 的 key 与对它们的引用——否则每个夹具都会额外撞上那一条，
 * 报出来的就不是被测的那一条了（"测的是别的东西"）。
 */
function run(fx: Fixture): { status: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "a2a-i18n-"));
  try {
    const dict: Record<string, Record<string, string>> = { ...fx.dict };
    const refs: string[] = [];
    for (let i = 0; i < 18; i++) {
      dict[`filler.${i}`] = row(`填充 ${i}`);
      refs.push(`t("filler.${i}");`);
    }
    const write = (rel: string, body: string) => {
      const full = join(dir, "admin-ui", rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body, "utf8");
    };
    write("js/i18n-dict.js", `export const I18N = ${JSON.stringify(dict, null, 2)};\n`);
    write("js/filler.js", `${refs.join("\n")}\n`);
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

  it("① 引用数掉到门槛以下（扫描本身坏了）：exit 1", () => {
    // 这一格刻意不走 `run()` 的填充：直接给一棵只有 3 处引用的树。
    const dir = mkdtempSync(join(tmpdir(), "a2a-i18n-floor-"));
    try {
      const dict = { "a.x": row("x"), "a.y": row("y"), "a.z": row("z") };
      mkdirSync(join(dir, "admin-ui", "js"), { recursive: true });
      writeFileSync(join(dir, "admin-ui/js/i18n-dict.js"), `export const I18N = ${JSON.stringify(dict)};\n`);
      writeFileSync(join(dir, "admin-ui/js/x.js"), 't("a.x");t("a.y");t("a.z");\n');
      const r = spawnSync("node", [SCRIPT, dir], { encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("扫描本身可能坏了");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it("⑥ 只管 reg.*：同样的词出现在别的命名空间不报错", () => {
    const r = run({
      dict: { "nav.x": { ...row("中性"), en: "recommended" } },
      files: { "js/x.js": 't("nav.x");\n' },
    });
    expect(r.status, "这条禁令的范围被扩大了").toBe(0);
  });

  it("⑦ 字典里出现 IP:PORT 形态（scan-secrets 会打红 CI）：exit 1", () => {
    const r = run({
      dict: { "nav.x": { ...row("正常"), en: "connect to <TESTNET3-ADDR-AND-PORT>" } },
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
