import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { I18N } from "../../admin-ui/js/i18n-dict.js";
import {
  UNVERIFIED_KEYS, UNVERIFIED_BANNED, UNVERIFIED_CONCEPTS,
} from "../../scripts/lib/unverified-claims.mjs";
import { tableFromSource } from "../helpers/gate-tables.js";

const SCRIPT = resolve("scripts/check-i18n.mjs");
const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"] as const;

/**
 * **i18n 门禁（`scripts/check-i18n.mjs`）自己的元测试**（全分支评审 I2）。
 *
 * ⚠️ **在这份文件出现之前，这道门禁零覆盖。** 十条判据里任何一条被写坏——正则打错
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

/**
 * 五语言齐全的一行字典。
 *
 * ⚠️⚠️ **`en` / `ko` 两侧不能是同一段中文，这是 P3e Task 8 之后的硬要求。**
 * 这个 helper 原来把同一段中文塞进全部五种语言，而第 ⑩ 条判据给「整段没翻译、
 * 直接把中文抄进别的语言」这一档立了硬错 ⇒ **helper 造出来的每一行本身就是被测的那个缺陷**，
 * 实测让本文件 25 格断言 `exit 0` 的夹具当场变红。
 * 修的是 helper，**不是给夹具开豁免**：真要开豁免名册，那册名单第一条就会是「本仓的元测试」。
 *
 * · `en` 侧把 CJK 段换成 ASCII（⑩A 查的是「`en` 里有没有 CJK」）；
 * · `ko` 侧把 CJK 段换成谚文（⑩B 查的是「`ko` 里至少有一个谚文」）；
 * · **`{占位符}` 原样留着**——第 ⑤ 条要求五种语言的占位符集合逐字相同，
 *   顺手替换掉的话第 ⑤ 条会抢在被测的那一条前面把夹具打红；
 * · `text` 本来就不含 CJK 时（`row("Key")` 那类专有名词）**五种语言原样相同**，
 *   而那正是真仓里 `ov.storage.kv` / `keys.col.key` 那一族的形状。
 *
 * ⚠️ 反过来说，本文件里每一格断言 `exit 0` 的夹具**都是第 ⑩ 条的反向控制**：
 * 判据要是写成「一律红」，那 25 格会一起红。
 */
const CJK_RUN = /[㐀-䶿一-鿿぀-ヿ가-힯]+/g;

function row(text: string): Record<string, string> {
  return {
    "zh-CN": text,
    "zh-TW": text,
    en: text.replace(CJK_RUN, "x"),
    ja: text,
    ko: text.replace(CJK_RUN, "가"),
  };
}

interface Fixture {
  /** key -> 五语言（或故意残缺的）行。 */
  dict: Record<string, Record<string, string>>;
  /** 额外文件：相对 admin-ui/ 的路径 -> 内容。 */
  files?: Record<string, string>;
  /**
   * 这棵树**登记**的拼键前缀表（脚本的第三个入参，P3e Task 4）。
   *
   * ⚠️ **缺省 `[]` 的意思是「这棵树不该有任何拼键前缀」，不是「这一项不检查」。**
   * 真仓那份登记表（`set.err.` / `set.field.`）写死在脚本里，元测试这一侧必须自己
   * 带一份——夹具树里根本没有 `pure/settings.mjs`，套用真仓那张表的话每一格都会红。
   * 于是这个字段本身就是双向断言的一半：夹具里出现了没登记的前缀 ⇒ 那一格会红。
   */
  tplPrefixes?: string[];
  /**
   * 这棵树上规则⑨（未核实红线）的 key 白名单（脚本的第四个入参，P3e Task 7）。
   *
   * ⚠️ **理由与 `tplPrefixes` 那一条逐字同源**：真仓那张白名单
   *（`scripts/lib/unverified-claims.mjs` 的 `UNVERIFIED_KEYS`）点的是 `usage.*` / `pg.*` 里
   * 三个真实存在的 key，而夹具树的字典只有被测的那一两条 ⇒ 套用真仓那张表的话，
   * 每一格夹具都会被「白名单里有字典中不存在的 key」那条硬错打红。
   * ⚠️ **缺省 `[]` 的意思是「这棵树上规则⑨ 无事可管」，不是「这一条不检查」**：
   * 词表仍在，只是交集为空——那正是这条判据「白名单 × 词表」的定义。
   */
  unverifiedKeys?: string[];
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

    // **`spawnSync` 而不是 `execFileSync`**：后者非零退出时直接抛，而本文件几乎每一格
    // 断言的都是"它必须 exit 1、且报文点名了那一条"——`status` 与 `stderr` 都要拿在手里
    // 才问得出话。（P3e Task 4 之前这里写的理由是"第 ④ 条是 exit 0 + 一条 stderr 警告"，
    // 那条理由随第 ④ 条升成硬错一起作废，`warnings` 数组本身也已删掉。）
    const r = spawnSync(
      "node",
      [SCRIPT, dir, (fx.tplPrefixes ?? []).join(","), (fx.unverifiedKeys ?? []).join(",")],
      { encoding: "utf8" },
    );
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 「某个 key 的某种语言被写成了某段文案」这一档的最小夹具（P3e Task 7）。
 *
 * 其余四种语言给一句中性文案，并在源码里留**一处直接引用**——否则第 ④ 条
 *（字典里未被引用的 key 是硬错）会抢在被测的那一条前面把这一格打红，
 * 于是 `exit 1` 就不再说明任何事情（本仓那条「判据用错工具时不会报错，会静静地放行」
 * 的镜像：**红得对不对，和红不红是两件事**）。
 */
function fixtureWith(key: string, lang: string, text: string, extra: Partial<Fixture> = {}): Fixture {
  return {
    dict: { [key]: { ...row("中性说法"), [lang]: text } },
    files: { "js/x.js": `t("${key}");\n` },
    ...extra,
  };
}

/**
 * 偏好词门禁（规则⑥）的**正向格表**：每一行 = 一条真作用域前缀 × 一种语言 × 一段中招文案。
 *
 * ⚠️ **它同时是「作用域覆盖」那条断言的取数一侧**（见「⑥ 前缀表与正向格双向咬合…」那一格），
 * 所以**别把它拆回各个用例体里**：拆回去之后「门禁那张表里多了一条而没人证明它生效」
 * 这件事就再也没有机器看得见了——那正是本轮补上的那个缺口。
 * `reg.` 与 `keys.addMenu.auto` 两条另有各自的多语言循环用例，这里各留一行是为了让
 * 覆盖断言问得出话，**不是重复**：那两格问的是「三种语言都拦得住」，这张表问的是
 *「这条前缀在作用域里」。
 */
const BANNED_PREFIX_CASES: ReadonlyArray<readonly [string, string, string]> = [
  ["reg.x", "zh-TW", "主通道（推薦）"],
  ["keys.addMenu.autoMoemail", "en", "Auto-register (recommended)"],
  ["set.field.registrar.primary", "zh-TW", "主通道（推薦）"],
  ["set.field.registrar.fallback", "en", "Fallback channel (recommended)"],
  ["set.field.channel.baseUrl", "ko", "서비스 URL (권장)"],
  ["set.card.registrar", "zh-CN", "注册机（推荐先配这条）"],
  ["ov.config.primary", "ko", "주 채널(권장)"],
  ["ov.config.fallback", "ja", "フォールバックチャネル（推奨）"],
  // P3e 全分支评审 MEDIUM-2：阶段 I 新写的那两个区（重置配置 / 高级）逐字提到
  // 「两条邮箱通道」却在射程外，起因与测法见门禁那张表上方那段。
  ["set.danger.reset.warn", "zh-CN", "这一步会抹掉两条邮箱通道的凭据，推荐先备份 MoeMail 那一条。"],
  ["set.advanced.warn", "en", "Change it only if you run an equivalent backend (the recommended one)."],
];

/** 门禁源码里那张 `BANNED_PREFIXES`，逐字抠出来。认不出会抛，不会静默当成空表。 */
const gateBannedPrefixes = (): string[] => tableFromSource(SCRIPT, "const BANNED_PREFIXES = [");

/**
 * 上面那个的**两语言**版（P3e Task 8）。第 ⑩ 条判据问的是 `zh-CN` 与 `ko` 的**关系**
 *（「中文侧是含汉字的句子，韩文侧却一个谚文都没有」），一次只覆盖一种语言问不出这个问题。
 */
function fixtureWithPair(
  key: string,
  langs: Record<string, string>,
  extra: Partial<Fixture> = {},
): Fixture {
  return {
    dict: { [key]: { ...row("中性说法"), ...langs } },
    files: { "js/x.js": `t("${key}");\n` },
    ...extra,
  };
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

describe("scripts/check-i18n.mjs 元测试：十条判据逐条", () => {
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

  it("④ 字典里谁都不引用的 key ⇒ 当场红（P3e Task 4 翻转：从警告升成硬错）", () => {
    // ⚠️⚠️ **这一格的语义在 P3e Task 4 被刻意翻转过，翻转理由必须留在这里。**
    // 旧断言是「④ 必须是警告，不是错误」，旧理由是「动态拼接的 key 抓不到，报错会误伤」。
    // 那条理由在 Task 3 之后**不再成立**：模板拼键现在由「模板拼键前缀」这条路认得出来，
    // 而那张前缀表与实扫做**双向**相等比较 ⇒「未被引用」这个集合第一次变得可信。
    // ⚠️ **这里刻意不写「今天全仓有几处拼键」**（上一版写的是「三处」，那是 Task 3 复评
    // 已经判假的数，本任务把它复制了过来）：同一条正则在「抠不抠注释」「跳不跳字典文件」
    // 上分叉，数过的每一轮答案都不同，而这一格的语义与那个数无关。
    // 不翻转的话它永远是一张不会自己红的清单 —— 本仓对那种东西的裁定是「待办，不是守卫」。
    const r = run({
      dict: { "nav.overview": row("概览"), "nav.unused": row("没人用") },
      files: { "js/x.js": 't("nav.overview");\n' },
    });
    expect(r.status, "未被引用的 key 又变回警告了 —— 那是一张不会自己红的清单").toBe(1);
    expect(r.stderr).toContain("nav.unused");
  });

  /**
   * **④ 的反向控制。** 少了它，「一律 exit 1」也能让上面那格全绿，而升成硬错之后
   * 判据一旦把拼键那一路看丢，整族 `set.field.*` 会当场被报成死 key ——
   * 而 Task 4 同时做了「处置真 0 命中 key（删 / 改）」，那条处置套上去删掉的是活文案。
   */
  it("④ 反向控制：模板拼键 + 同前缀 key ⇒ 不许红（防止升级后把整族误杀）", () => {
    const r = run({
      dict: { "set.field.a": row("甲"), "set.field.b": row("乙") },
      files: { "js/x.js": "const k = `set.field.${path}`;\n" },
      tplPrefixes: ["set.field."],
    });
    expect(r.status, r.stderr).toBe(0);
  });

  /**
   * ⚠️⚠️ **④ 的报文必须自带处置指引**（P3e Task 4 复评 F2）。
   *
   * 复评实测的形态：`set.card.upstreamNote` 唯一那处引用被改写成
   * `"set" + ".card.upstreamNote"`（登记在案的三种漏报形态之一）⇒ 门禁 exit 1，
   * 而运维在 CI 里看到的**全部**输出就是一行「字典里有未被引用的 key: <一个正在用的 key>」。
   * 「别顺手删 key」当时只活在 `scripts/check-i18n.mjs` 的源码注释里，
   * **而读 CI 输出的人不会回头去读源码注释** —— 顺着那一行去清理，删掉的是活着的界面文案。
   *
   * 这一格断言的是**报文本身**说得出三件事：这可能是活 key、三条漏报形态是什么、
   * 先确认再决定删不删。指引挪回注释里的那一天，这一格会红。
   */
  it("④ 的硬错报文自带处置指引 —— 读 CI 输出的人不会回头读源码注释", () => {
    const r = run({
      dict: { "nav.overview": row("概览"), "nav.unused": row("没人用") },
      files: { "js/x.js": 't("nav.overview");\n' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr, "报文没说「这可能是一个正在用的 key」").toContain("可能混着");
    expect(r.stderr, "报文没说「别顺手删」").toContain("别顺手删 key");
    for (const form of ["`+` 拼的 key", "反引号里的纯 key 字面量", "不带引号的属性值"]) {
      expect(r.stderr, `报文没列出漏报形态「${form}」`).toContain(form);
    }
  });

  /**
   * **上面那格的反向控制。** 少了它，「无条件把那段指引打出来」也能让它全绿 ——
   * 而那样一来，一次全绿的运行也会印一段「你可能删错了活 key」的警告，
   * 那正是本仓那条「一个诚实标记出现得太密就不再传递信息」要防的东西。
   */
  it("④ 处置指引的反向控制：没有未被引用的 key 时不许出现", () => {
    const r = run({
      dict: { "nav.overview": row("概览") },
      files: { "js/x.js": 't("nav.overview");\n' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr + r.stdout, "干净的树上也印处置指引 ⇒ 那段话是无条件打的").not.toContain("别顺手删 key");
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

  /**
   * ⚠️⚠️ **P3e Task 7：作用域扩到「两条通道平级」直接相关的那几个 `set.*` 前缀。**
   *
   * 用户那条硬约束是「YYDS 与 MoeMail 严格同级，不替人选主备」，而在这之前规则⑥ 的
   * 作用域只有 `reg.*` 与 `keys.addMenu.auto*` —— 两条通道**共用的那对凭据 key**
   *（`set.field.channel.*`）和主 / 备两个选择器标签（`set.field.registrar.primary`
   * / `fallback`）**全在门外**，夹具实跑 EXIT=0。
   *
   * 下面逐个前缀各钉一种语言变体：**新纳入的每一条前缀都要有自己的正向格**，
   * 少哪一条，那一条就是「登记在表里但没有任何东西证明它生效」的那一档——
   * 本仓对这种东西的裁定是「一个不会自己红的清单不是守卫，是待办」。
   * ⚠️ **这句话本轮才真正变成机器**：它以前只是一句写在这里的话，而
   * `ov.config.primary` / `ov.config.fallback` 两条追加进去之后**没有跟上**，
   * 一整轮都没人发现。下面那格「⑥ 前缀表与正向格双向咬合…」把它钉住了。
   */
  it.each(BANNED_PREFIX_CASES)("⑥ %s/%s 出现偏好词 ⇒ 当场红", (key, lang, text) => {
    const r = run(fixtureWith(key, lang, text));
    expect(r.status, `${key}/${lang} 没被拦住`).toBe(1);
    expect(r.stderr).toContain("偏好词");
  });

  /**
   * ⚠️⚠️ **上面那张表与门禁那张前缀表的双向咬合，本轮补上（Task 7 补漏评审 H3）。**
   *
   * 上面每一格只证明「**我登记的这条**前缀今天有牙」，**一个字也没说反过来那件事**：
   * 门禁那张 `BANNED_PREFIXES` 里多出一条而这里没跟上时，那一条就是
   * 「登记在表里但没有任何东西证明它生效」的那一档。实测的那一次：
   * 韩文实测追加 `ov.config.primary` / `ov.config.fallback` 两条整 key 之后没有补正向格，
   * **把那两行从门禁里删掉，门禁 EXIT=0、这份元测试全绿**——而这段说明的正上方
   * 逐字写着「新纳入的每一条前缀都要有自己的正向格」。
   *
   * ⇒ 这一格把那句话变成机器：**从门禁源码里逐字抠出那张表**，两个方向各断言一次。
   * 抠表判据（认不出就抛，不许静默当成空表）在 `tests/helpers/gate-tables.ts`。
   */
  it("⑥ 前缀表与正向格双向咬合：门禁里每条前缀都有正向格，正向格里每条 key 都真在作用域内", () => {
    const prefixes = gateBannedPrefixes();
    expect(prefixes, "抠到的不是那张前缀表").toContain("reg.");
    const uncovered = prefixes.filter((p) => !BANNED_PREFIX_CASES.some(([k]) => k.startsWith(p)));
    expect(
      uncovered,
      "门禁的作用域里有这几条前缀，而上面那张正向格表里没有任何一条 key 命中它们"
      + " ⇒ 它们是「登记在表里但没有任何东西证明它生效」的那一档，请各补一格",
    ).toEqual([]);
    const orphan = BANNED_PREFIX_CASES
      .map(([k]) => k)
      .filter((k) => !prefixes.some((p) => k.startsWith(p)));
    expect(
      orphan,
      "上面那张正向格表里这几条 key 已经不在门禁的作用域里了"
      + " ⇒ 要么门禁那张前缀表被人删了一条，要么这里的 key 写错了",
    ).toEqual([]);
  });

  /**
   * **上面那一族的反向控制：钉住「范围没有被扩大」。**
   *
   * 少了它，把作用域写成整个 `set.*` 也能让那几格全绿——而 `set.*` 里有与通道无关、
   * 却**正当地**含着表内词的运维文案。⚠️ **这里刻意只说这一句，不再写
   * 「大量（超时、冷却、口令）」那种全称句**：本轮实测放宽成 `set.` 之后全字典
   * **只命中 `set.field.agnesBaseUrl` 的 ko 值一条**（「업스트림 기본 URL」里的 `기본`
   * 是 base URL 的「基」），超时 / 冷却 / 口令三族一条都没中 ⇒ 上一版那句话当时就是假的。
   * 真仓那一条反例由 `tests/unit/i18n-dict.test.ts` 的
   * 「作用域刻意不是整个 set.：真仓里那条正当用词的反例还在」那一格钉着，
   * 本格用的仍是夹具（夹具与真仓各守一半：夹具证明判据形状，真仓证明反例还在）。
   */
  it("⑥ 反向控制：与通道无关的 set.field.upstreamTimeoutMs 里出现同样的词 ⇒ 不红", () => {
    const r = run(fixtureWith("set.field.upstreamTimeoutMs", "zh-CN", "上游超时（推荐 30 秒）"));
    expect(r.status, `作用域被扩宽成了整个 set.*：\n${r.stderr}`).toBe(0);
  });

  /**
   * **上面那条反向控制的第二条腿（P3e 全分支评审 MEDIUM-2）。**
   *
   * MEDIUM-2 的修法是把作用域扩到 `set.danger.reset.` 与 `set.advanced.` 两个**区**
   * （而不是那三条整 key，理由见门禁那张表上方那段）。扩到「区」就带来一条新的
   * 扩宽风险：顺手写成 `set.danger.` 的话，**清空 Key 池那一区会一起被收进来**——
   * 而它讲的是 key 池，与两条通道毫无关系。
   * ⇒ 这一格从反面钉住那条边界：`set.danger.purge.*` 里出现同样的词**不许红**。
   * 少了它，把作用域写成 `set.danger.` 甚至整个 `set.` 也能让上面那两格正向格全绿。
   */
  it("⑥ 反向控制：与通道无关的 set.danger.purge.* 里出现同样的词 ⇒ 不红", () => {
    const r = run(fixtureWith("set.danger.purge.desc", "zh-CN", "清空 Key 池（推荐先导出一份）"));
    expect(r.status, `作用域被扩宽成了整个 set.danger.（清空 Key 池那一区被一起收进来了）：\n${r.stderr}`)
      .toBe(0);
  });

  it("⑦ 字典里出现 IP:PORT 形态（scan-secrets 会打红 CI）：exit 1", () => {
    const r = run({
      // ⚠️ **字面量要拆开拼**：写成一整串的话，凭据扫描门禁（`scripts/scan-secrets.sh`）
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

  /**
   * ⚠️⚠️ **第 ⑨ 条：未核实事项的红线（P3e Task 7 新增）。**
   *
   * 用户点名的一条红线是：真机了结之前，任何文案都不许把「上限是 60 次」写成
   * 「60 次是安全的」。在这之前这条红线**完全靠人守**——规则⑥ 的作用域不含
   * `usage.*` / `pg.*`，谁把 `usage.range.retention` 改成「30 天这一档的 60 次子请求
   * 在 Worker 上没问题」，**十二道门禁一道都不会红**。
   */
  it("⑨ usage.range.retention 被软化成「这些子请求是安全的」⇒ 当场红", () => {
    const r = run(fixtureWith("usage.range.retention", "zh-CN", "这些子请求是安全的", {
      unverifiedKeys: ["usage.range.retention"],
    }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("里出现了软化词");
    // **报文里必须带处置指引**（P3e Task 4 复评 F2 的裁定：读 CI 输出的人不会回头读源码注释）。
    // 少了这一句，撞上误报的人手里只有一句指控，而他唯一想得到的做法是把那句文案改坏。
    expect(r.stderr, "报文没说表在哪儿 ⇒ 撞上它的人无从下手").toContain("scripts/lib/unverified-claims.mjs");
    expect(r.stderr, "报文没给出路 ⇒ 报文会亲手把人引进坑").toContain("尚未在真机上核实");
  });

  /**
   * ⚠️⚠️ **逐概念 × 逐语言：每一种语言在每一条概念上都要真的被门禁认出来**
   *（Task 7 补漏评审 H1/H2）。
   *
   * **这一族存在的全部理由**：上一版的词表是拉平的一维表，繁体形态一个都没有，
   * 于是同义的一句话简体当场红、繁体一路绿；韩文的 `안전`、日文的 `大丈夫` 同样漏网。
   * 那时守着词表的只有一句 `length` 断言——**把日韩三个词整族删掉，门禁 EXIT=0、
   * 这两份测试全绿**。`length` 那种断言证明的是「表还有几行」，不是「每种语言都有牙」。
   *
   * ⇒ 这里拿真门禁把矩阵里**每一格的第一个说法**各跑一遍。
   * 词表是从 `scripts/lib/unverified-claims.mjs` 那份真源现算的，**不是这里手抄一份**：
   * 手抄的那份漂了没人会发现，而漂了之后这一族仍然会全绿。
   */
  it.each(
    (UNVERIFIED_CONCEPTS as Array<{ id: string; words: Record<string, string[]> }>).flatMap(
      (c) => LANGS.map((lang) => [c.id, lang, (c.words[lang] ?? [])[0] ?? ""] as const),
    ),
  )("⑨ 概念 %s 的 %s 说法「%s」要被真门禁认出来", (id, lang, word) => {
    // 空说法 = 那种语言在这条概念上是瞎的。这里当场说出来，不许拿一个空串去跑出一格假绿。
    expect(word, `概念 ${id} 在 ${lang} 下一个说法都没有`).not.toBe("");
    const r = run(fixtureWith("usage.range.retention", lang, `……${word}……`, {
      unverifiedKeys: ["usage.range.retention"],
    }));
    expect(r.status, `${id}/${lang}「${word}」没被拦住：\n${r.stderr}`).toBe(1);
    expect(r.stderr).toContain(word);
  });

  /**
   * **两条反向控制：钉住「命中口径没有退回裸 `includes`」**（Task 7 补漏评审 M1 / L4）。
   *
   * 两条都是实测抓到的真误报，不是假想：
   * · 英文 `defined` / `refined` 里含着 `fine`，上一版当场把一句纯技术描述判成软化；
   * · 中文「十分钟」里含着「十分」，同上。「十分」已经从词表里删掉，
   *   「十分安全 / 十分够用」那一档由 `safe` / `enough` 两条概念自己接住。
   * 少了这两格，把命中口径改回裸 `includes`（或者把「十分」加回词表）不会有任何东西红。
   */
  it("⑨ 反向控制：英文 defined 里的 fine 不许被当成软化词", () => {
    const r = run(fixtureWith("usage.range.retention", "en", "The window is defined by the shard layout.", {
      unverifiedKeys: ["usage.range.retention"],
    }));
    expect(r.status, `ASCII 词没按词边界匹配 ⇒ defined 里的 fine 被误伤：\n${r.stderr}`).toBe(0);
  });

  it("⑨ 反向控制：中文「十分钟」不许被当成软化词", () => {
    const r = run(fixtureWith("usage.range.retention", "zh-CN", "十分钟之后这一档就会超时。", {
      unverifiedKeys: ["usage.range.retention"],
    }));
    expect(r.status, `「十分」又回到词表里了 ⇒ 它是一台稳定的误报机：\n${r.stderr}`).toBe(0);
  });

  /**
   * ⚠️⚠️ **登记在案的误报边界：这一格断言的是「今天它就是会红」，不是「它做对了」。**
   *
   * 判据是子串匹配，它分辨不出「60 次是安全的」（要拦的）与「是否安全尚未核实」
   *（完全正确的存疑句）。**为什么不给它加否定式处理**、替代方案在这个仓里为什么
   * 会带一个语言形状的洞，理由整段写在 `scripts/check-i18n.mjs` 规则⑨ 上方，
   * 不在这里复述一遍（复述两份，改的时候只会改一份）。
   *
   * 这一格要钉住的是**报文**：撞上这一档的人手里唯一的东西就是那几行 stderr，
   * 报文必须告诉他正确的出路是「把这句话改写成不含这个词的说法」，
   * 而不是让他把「尚未核实」这层意思删掉——**报文可以亲手把人引进坑**，本仓栽过。
   * 哪天真有人给它加了否定式处理，这一格会变红，那正是提醒他回去改那段说明的地方。
   */
  it("⑨ 已登记的误报边界：诚实的存疑句里出现「安全」照样红（报文必须给出正确的出路）", () => {
    const r = run(fixtureWith("usage.range.retention", "zh-CN", "这一档是否安全尚未核实。", {
      unverifiedKeys: ["usage.range.retention"],
    }));
    expect(r.status, "误报边界变了 ⇒ 回去改 scripts/check-i18n.mjs 规则⑨ 上方那段说明").toBe(1);
    expect(r.stderr, "报文没给出路，撞上误报的人只会去改那句本来正确的文案")
      .toContain("不是把「尚未核实」这层意思删掉");
  });

  /**
   * **反向控制：它是白名单 × 词表的交集，不是全字典扫。**
   *
   * 夹具里两个 key 同时在场：白名单里那个是干净的，白名单**外**那个带着同一个词。
   * 少了这一格，把规则⑨ 写成「拿词表扫整本字典」也能让上面那格全绿——
   * 而「安全 / 够用 / 没问题」在别的命名空间里是完全正当的用词，
   * 全字典扫会当场制造第二个「警报淹掉信号」现场（这个仓刚把 396 条噪音降到 0）。
   */
  it("⑨ 反向控制：白名单外的 key 出现同样的词 ⇒ 不红（它是白名单×词表的交集，不是全字典扫）", () => {
    const r = run({
      dict: {
        "usage.range.retention": row("最多保留 30 天，是否总能读完尚未在真机上验证过"),
        "ov.title": { ...row("概览"), "zh-CN": "这些子请求是安全的" },
      },
      files: { "js/x.js": 't("usage.range.retention");\nt("ov.title");\n' },
      unverifiedKeys: ["usage.range.retention"],
    });
    expect(r.status, `词表被套到了白名单以外的 key 上 ⇒ 那是全字典扫：\n${r.stderr}`).toBe(0);
  });

  /**
   * **白名单里写了一个字典里没有的 key ⇒ 当场红，不许静静地跳过。**
   *
   * 这是整条规则空转的那一档：key 被改个名（或者被删掉）之后，静默跳过意味着
   * 那条红线从此再也没人守，而门禁照样打 ✅ 横幅——本仓对「静默放行」的裁定
   * 见第 ④ 条那一段。反向控制先跑：同一棵树上白名单指着一个真存在的 key 时必须安静。
   */
  it("⑨ 白名单里有字典中不存在的 key ⇒ 当场红（自带反向控制）", () => {
    const dict = { "nav.overview": row("概览") };
    const files = { "js/x.js": 't("nav.overview");\n' };
    const ok = run({ dict, files, unverifiedKeys: ["nav.overview"] });
    expect(ok.status, `白名单指着一个真存在的 key 时不许红：\n${ok.stderr}`).toBe(0);
    const bad = run({ dict, files, unverifiedKeys: ["nav.ghost"] });
    expect(bad.status, "白名单里那个 key 已经不在字典里了，门禁却一声不吭 ⇒ 规则⑨ 在空转").toBe(1);
    expect(bad.stderr).toContain("⑨ 的白名单里有字典中不存在的 key");
  });

  /**
   * ⚠️⚠️ **这一格守的是真仓那两张表本身，不是夹具**（P3e 计划：本期新增的每一张
   * 手写清单都必须在同一个任务里配一条会让它变红的断言）。
   *
   * 上面几格全部跑在临时目录上、白名单由夹具喂进去 ⇒ 它们证明的是「判据的形状对」，
   * **一个字也没说真仓那张白名单还指着真东西**。把 `UNVERIFIED_KEYS` 里的 key 改个名
   * （或者把词表清空），上面每一格照样全绿、门禁照样 EXIT=0，而红线已经无人再守。
   * 这里直接对 `scripts/lib/unverified-claims.mjs` 那份真源发问——**三个消费者共用它，
   * 所以这一格问的就是真扫描用的那一份**。
   */
  it("⑨ 反向自检：白名单非空、词表非空、且白名单里每个 key 都真的在字典里", () => {
    // 没有这一格的话，把 key 改个名就能让整条规则空转 —— 本仓已栽过 `--reporter=basic` 空跑那一族。
    expect(UNVERIFIED_KEYS.length).toBeGreaterThan(2);
    // ⚠️ **词表这一半只问「非空」，射程那一半在下面那一格**：上一版这里写的是
    // `length > 5`，而那张表当时有十来条 —— 一个松到能整族删词的魔法数，
    // 与它同一行的 `UNVERIFIED_KEYS` 那一半（`> 2` 对三条表是紧的）恰好相反。
    // **一个不会自己红的清单不是守卫，是待办**：词表的守卫是矩阵完备性，不是行数。
    expect(UNVERIFIED_BANNED.length, "词表空了 ⇒ 规则⑨ 的交集恒为空").toBeGreaterThan(0);
    expect(
      UNVERIFIED_KEYS.filter((k: string) => !(k in I18N)),
      "白名单里这些 key 已经不在字典里了 ⇒ 规则⑨ 对它们空转（改了名就把名字改过来，别删条目）",
    ).toEqual([]);
  });

  /**
   * ⚠️⚠️ **词表的真守卫：「概念 × 语言」的完备性**（Task 7 补漏评审 H1/H2）。
   *
   * 实测的那一次：把日 / 韩三个词整族从表里删掉 ⇒ 门禁 EXIT=0、两份测试全绿，
   * 因为当时守着这张表的只有一句 `length` 断言，而那个数比表短得多。
   * 一张能整族删空还全绿的表，不是守卫，是待办。
   *
   * 这一格问的是**结构**：每条概念的语言集必须与 `LANGS` 逐条对齐，
   * 而且每种语言下至少要有一个非空说法。缺一格 = 那种语言在那条概念上是瞎的。
   * 形态照抄 `tests/unit/i18n-dict.test.ts` 的
   * 「词表是「概念 × 语言」的矩阵：每条概念五种语言都得有说法，缺一种就是那种语言的盲区」。
   */
  it("⑨ 词表是「概念 × 语言」的矩阵：每条概念五种语言都得有说法，缺一种就是那种语言的盲区", () => {
    expect(UNVERIFIED_CONCEPTS.length, "概念表空了——上面那一族会一格都不跑").toBeGreaterThan(0);
    const holes: string[] = [];
    for (const c of UNVERIFIED_CONCEPTS as Array<{ id: string; words: Record<string, string[]> }>) {
      expect(Object.keys(c.words).sort(), `${c.id} 的语言集与 LANGS 对不上`).toEqual([...LANGS].sort());
      for (const lang of LANGS) {
        if ((c.words[lang] ?? []).filter((w) => w.trim() !== "").length === 0) {
          holes.push(`概念 ${c.id} 在 ${lang} 下一个说法都没有——那种语言在这条概念上是瞎的`);
        }
      }
    }
    expect(holes, holes.join("\n")).toEqual([]);
  });

  /**
   * ⚠️⚠️ **第 ⑩ 条：未翻译泄漏（P3e Task 8 新增）。**
   *
   * 它拦的是**整段没翻译、直接把中文抄进别的语言**这一档，而且**只拦这一档**：
   * 它证明「没漏翻」，**一个字也没说译文准不准、句子通不通顺**。
   * 别在任何文档里把它读成「`pg.*` 的措辞现在有机器核了」——那是本仓登记过二十余次的那类假话。
   *
   * ⚠️ **两条反向控制不是可选的，而且它们要防的是一个很具体的写法。**
   * ⑩A / ⑩B 查的都是**字符集**，而字符集判据天生有两种「扩宽一格」的写法：
   * 把 ⑩A 写成「`en` 不许有非 ASCII」、把 ⑩B 写成「`ko` 不许有汉字」。
   * 这两种写法能让上面两格正向全绿，却会在真仓上当场逼出一份豁免名册
   *（`en` 侧成片的 `—` `…` `·` `“` `”`；韩语正式文书里汉字本来就不罕见）。
   * **拿真字典条目问的那一族反向控制在文件末尾单独一个 describe 里**——
   * 自造样本（`"node"` / `"—"`）里根本不出现那两族真正会被误伤的串。
   */
  it("⑩A en 值里出现 CJK ⇒ 当场红（整段没翻译直接抄中文）", () => {
    const r = run(fixtureWith("ov.title", "en", "概览"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("出现了 CJK 字符");
  });

  it("⑩A 反向控制：纯 ASCII 的 en 值不许被误伤", () => {
    // `ov.runtime.node` 的 en 值就是 `node`，`common.dash` 那类符号 key 同理。
    const r = run(fixtureWith("ov.runtime.node", "en", "node"));
    expect(r.status, r.stderr).toBe(0);
  });

  it("⑩B zh-CN 含汉字而 ko 不含谚文 ⇒ 当场红", () => {
    const r = run(fixtureWithPair("ev.title", { "zh-CN": "事件", ko: "事件" }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("一个谚文都没有");
  });

  /**
   * **⑩B 的反向控制，同时是那条 `HAN.test(zh)` 前置的绊线。**
   * 把前置删掉，这一格立刻红——而它红的是一个完全正当的符号 key。
   * 真仓里同型的一族（`ov.storage.kv` / `keys.col.key` 那批专有名词）在末尾那个 describe 里。
   */
  it("⑩B 反向控制：zh-CN 不含汉字时不判 ko（符号 / 纯数字 key 不许被误伤）", () => {
    const r = run(fixtureWithPair("common.dash", { "zh-CN": "—", ko: "—" }));
    expect(r.status, r.stderr).toBe(0);
  });

  /**
   * **⑩B 的第二条反向控制：判据是「`ko` 至少有一个谚文」，不是「`ko` 不许有汉字」。**
   *
   * ⚠️ **这一格钉的是判据的形状，不是某条真条目**，理由如实写在这里：
   * 今天真仓的 `ko` 侧**一个汉字都没有**（实测），所以把 ⑩B 写成「`ko` 不许有汉字」
   * 在今天的真仓上**分辨不出来** —— 真仓照样 EXIT=0。少了这一格，那种写法
   * 要等到第一次有人在韩文里用汉字（韩语正式文书里并不罕见）时才会暴露，
   * 而那时它表现成「一条正当的译文被门禁打红」，第一反应是去开豁免名册。
   */
  it("⑩B 反向控制：ko 里正当地夹着汉字（谚文仍在）⇒ 不许红", () => {
    const r = run(fixtureWithPair("ov.title", { "zh-CN": "主通道概览", ko: "主 채널 개요" }));
    expect(r.status, `⑩B 被写成了「ko 不许有汉字」：\n${r.stderr}`).toBe(0);
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
   * (d) **分桶本身要分得对**：没人引用的那个落进「未被引用」、被引用的那个不许也落进来。
   *
   * ⚠️ 严重级别那一半在上面「④ 字典里谁都不引用的 key ⇒ 当场红」那一格
   *（P3e Task 4 把它从警告升成了硬错）。这里只盯**分桶的内容**，
   * 因为分桶是那条硬错的输入：分错了，红的就是无辜的那个 key。
   */
  it("(d) 谁都不引用的 key 必须出现在「未被引用」分桶里，被引用的那个不许", () => {
    const r = run({
      dict: { "nav.overview": row("概览"), "nav.lonely": row("没人用") },
      files: { "js/x.js": 't("nav.overview");\n' },
    });
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
   * 而 P3e Task 4 紧接着就把「未被引用」升成了硬错 ⇒ 会 exit 1 在 11 个正在用的 key 上。
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
    expect(r.stdout, "红的时候也必须先把分桶打出来 —— 那是第 ④ 条那条硬错的观测点").toMatch(BUCKET_RE);
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
   * 真仓有整整一族 key 只经由模板拼键被引用（`set.field.*`），静态判据天生看不见
   * 它们的完整名字。**这一桶今天有几条不写在这里**——那个数每加一个字段就变，
   * 要读就读横幅第一行的「拼键覆盖」。
   */
  it("拼键前缀：模板字面量的前缀认得出，前缀底下的 key 落进「拼键覆盖」", () => {
    const r = run({
      dict: { "set.field.a": row("甲"), "set.field.b": row("乙") },
      files: { "js/x.js": 'const k = `set.field.${path}`;\n' },
      tplPrefixes: ["set.field."],
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
   * 而它正是 P3e Task 4 处置过的那一族 ⇒ 一条真的死 key 从此永远看不见。
   */
  it("拼键前缀的绊线：前缀是整段 `set.field.`，不许放宽成命名空间 `set.`", () => {
    const r = run({
      dict: { "set.field.a": row("甲"), "set.card.x": row("卡片说明") },
      files: { "js/x.js": 'const k = `set.field.${path}`;\n' },
      tplPrefixes: ["set.field."],
    });
    expect(tplPrefixList(r)).toEqual(["set.field."]);
    expect(
      unrefList(r),
      "`set.card.x` 被拼键前缀凭空喂活了 ⇒ 前缀被放宽到了命名空间那一档",
    ).toEqual(["set.card.x"]);
    expect(buckets(r).covered).toBe(1);
  });

  /**
   * ⚠️⚠️ **登记表与实扫做双向相等比较**（P3e 计划点名 Task 4 owns 这张表）。
   *
   * 前缀覆盖天生有「吞掉」风险：前缀写宽一格，那一族 key 就再也不会被报未被引用。
   * 真仓的落点是 `admin-ui/js/pure/settings.mjs` 里 `fieldLabelKey()` 那条模板——
   * 它写成 `` `set.${path}` `` 的话，`set.*` 底下整族 key 一口气全进「拼键覆盖」桶，
   * 而第 ④ 条刚在本任务升成硬错 ⇒ **那一族里的真死 key 从此永远不会红**。
   * 「前缀变宽」在计数上表现为**警报变少**，与「判据认对了」长得一模一样。
   * 横幅第二行的「拼键前缀:」确实会跟着变、**肉眼是看得见的**，
   * 但**没有任何断言看得见它** —— 分辨这两者靠的就是下面这一格与那张登记表。
   */
  it("拼键前缀：实扫结果与登记表不符 ⇒ exit 1，且报文点名前缀变了", () => {
    const r = run({
      dict: { "set.field.a": row("甲"), "set.card.x": row("卡片说明") },
      // 登记的是 `set.field.`，源码里却只拼到 `set.` —— 真仓那条变异的最小复现。
      files: { "js/x.js": 'const k = `set.${path}`;\n' },
      tplPrefixes: ["set.field."],
    });
    expect(r.status, "前缀被放宽了一格，门禁却一声不吭").toBe(1);
    expect(r.stderr).toContain("模板拼键前缀变了");
    expect(r.stderr, "报文得同时说出登记的是什么、实扫的是什么").toContain("set.field.");
  });

  /**
   * **上面那格的反向控制。** 少了它，「登记表一律判不相等」也能让它全绿，
   * 而那样的门禁在真仓上永远红着，第一时间会被人加 `|| true` 绕开。
   */
  it("拼键前缀的反向控制：实扫与登记表一致时不许红", () => {
    const r = run({
      dict: { "set.field.a": row("甲"), "set.card.x": row("卡片说明") },
      files: { "js/x.js": 'const k = `set.field.${path}`;\nt("set.card.x");\n' },
      tplPrefixes: ["set.field."],
    });
    expect(r.status, r.stderr).toBe(0);
  });

  /**
   * **登记表的另一头：登记了、实扫却扫不到。** 那是「拼键那处代码被删掉或改了名」的形态。
   * 它同样必须吵——登记表若只查「实扫 ⊆ 登记」，一张越写越长的表会静静地把
   * 「这条前缀早就不存在了」变成一条永久豁免，而永久豁免正是第 ④ 条最怕的东西。
   */
  it("拼键前缀：登记了但实扫扫不到 ⇒ 同样 exit 1（双向相等，不是单向包含）", () => {
    const r = run({
      dict: { "nav.overview": row("概览") },
      files: { "js/x.js": 't("nav.overview");\n' },
      tplPrefixes: ["set.field."],
    });
    expect(r.status, "登记表只做了单向包含 ⇒ 过期的登记会变成永久豁免").toBe(1);
    expect(r.stderr).toContain("模板拼键前缀变了");
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
   * 扫原文的话，一段**被 HTML 注释掉的**内联 `<script>` 会把这道门禁打成假红，
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
   * 也就是说，一个漏写的闭合记号能让一批活着的 key 凭空「变死」，而 P3e Task 4 紧接着就把
   *「未被引用」升成了硬错并据此删过 key ⇒ 删掉的会是活文案。
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
   *   其中的真死 key 从此不出现在第 ④ 条那份硬错清单里 ⇒ **漏报，
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
 * 三条**全部是漏报方向**（key 明明有人用却落进「未被引用」），而 P3e Task 4 已经把
 * 「未被引用」升成了硬错 ⇒ **今天真写出这三种形态，这道门禁当场打红**，
 * 而顺着报文去「处置未被引用的 key」删掉的就是活着的文案。
 * 三格的断言随之从「exit 0 + 落进未被引用」改成「exit 1 + 报文点名那个 key」，
 * 那正是它们今天的真实后果。哪天判据扩到某一条，这里会红，
 * 而红的地方正是该回去改 `scripts/check-i18n.mjs` 第 ① 条那段边界说明的地方。
 */
describe("scripts/check-i18n.mjs 元测试：第 ① 条判据的三条已知漏报形态", () => {
  it("漏报一：按 `+` 拼的 key 看不见 —— 它会落进「未被引用」并当场打红", () => {
    const r = run({
      dict: { "nav.overview": row("概览") },
      files: { "js/x.js": 'const k = "nav." + name;\n' },
    });
    expect(
      unrefList(r),
      "判据认得 `+` 拼键了 —— 请回去改 check-i18n.mjs 第 ① 条那段边界说明",
    ).toEqual(["nav.overview"]);
    expect(r.status, "第 ④ 条已升成硬错，漏报的后果就是打红").toBe(1);
  });

  it("漏报二：反引号里的纯 key 字面量看不见（反引号那一路只走拼键前缀）", () => {
    const r = run({
      dict: { "nav.overview": row("概览") },
      files: { "js/x.js": "elI18n('h2', `nav.overview`);\n" },
    });
    expect(
      unrefList(r),
      "判据认得反引号里的纯 key 了 —— 请回去改 check-i18n.mjs 第 ① 条那段边界说明",
    ).toEqual(["nav.overview"]);
    expect(r.status, "第 ④ 条已升成硬错，漏报的后果就是打红").toBe(1);
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
    expect(
      unrefList(r),
      "判据认得不带引号的属性值了 —— 请回去改 check-i18n.mjs 第 ① 条那段边界说明",
    ).toEqual(["nav.overview"]);
    expect(r.status, "第 ④ 条已升成硬错，漏报的后果就是打红").toBe(1);
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

/**
 * **第 ⑩ 条的反向控制取自真字典**（P3e Task 8）。
 *
 * ⚠️⚠️ **上面那两格反向控制跑的是自造样本（`"node"` / `"—"`），那不够。**
 * ⑩A / ⑩B 查的都是**字符集**，而字符集判据真正会误伤的两族，在自造样本里根本不出现：
 *
 * · **专有名词 / 代码串**在五种语言里原样相同（`KV` / `Cloudflare Workers` / `Key` / `PID`）。
 *   它们的 `ko` **一个谚文都没有**，而这完全正当 —— ⑩B 不打红它们**只因为**那条
 *   `HAN.test(zh)` 前置（`zh-CN` 侧同样是 `KV`）。把前置删掉，红的就是这一族真条目。
 * · **`en` 侧正当的非 ASCII 标点**：`—`（U+2014）`…` `·`（U+00B7）`“` `”` `–` `é` `£`
 *   在英文文案里成片出现。⑩A 写成「`en` 不许有非 ASCII」会当场把它们全部打红 ——
 *   所以它查的是 **CJK**，不是非 ASCII。
 *   ⚠️ 顺带记一条真的近失：全角中点 `・`（U+30FB）落在片假名区里、**会**被 ⑩A 判成 CJK，
 *   而今天 `en` 侧用的是 U+00B7。哪天有人把它换成 U+30FB，这条判据会红，而它红得对。
 * · **⑩B 那半同构的一条近失**（P3e Task 8 复评时找到，与上面 `・` 同一种形状）：
 *   `scripts/check-i18n.mjs` 里的 `HANGUL` 正则只圈住谚文**音节**区块（`가`–`힯`），
 *   没圈住谚文**兼容字母**（U+3131–318E，`ㄱ`–`ㆎ`）——正则按 Unicode 区块画线，
 *   而「这门语言算不算数」不完全等于「落在哪个区块」，两条近失同一个成因。
 *   测法：造一个只用兼容字母拼、一个音节都不含的 `ko` 夹具（例如整句换成
 *   `ㅇㅋㄱㄱ` 这类独体字母缩写当译文），跑一遍 ⑩B —— `HANGUL.test(ko)` 判它
 *   「没有谚文」，把一句本来正当的韩文错判成「整段没翻译」。**真仓 0 命中、纯理论**：
 *   字典里没有任何 `ko` 条目只用兼容字母拼成，这条洞今天在真仓上验不出来。
 *
 * ⚠️ **夹具值直接取自 `admin-ui/js/i18n-dict.js`，不复制字面量**：抄一份出来的话，
 * 真字典改了这里不会红，守的是它自己那份副本 ——
 * 与 P3e Task 1 收编抠注释器、Task 7 共用 `unverified-claims.mjs` 是同一条裁定。
 */
describe("scripts/check-i18n.mjs 元测试：第 ⑩ 条的反向控制取自真字典", () => {
  const DICT = I18N as unknown as Record<string, Record<string, string> | undefined>;

  it.each([
    ["ov.storage.kv", "zh-CN / ko 都是 `KV`：ko 一个谚文都没有，而这完全正当"],
    ["ov.runtime.worker", "`Cloudflare Workers` 在五种语言里逐字相同"],
    ["ov.runtime.pid", "`PID` 同上，且中文侧也没有汉字"],
    ["keys.col.key", "`Key` 这类列名在中韩两侧都原样保留"],
    ["gate.badShape", "en 里有 `–` / `é` / `£`，还逐字写着 CJK characters 这个词"],
    ["usage.note.clockUnavailable", "en 里有成对的 “ ”"],
    ["keys.col.usage", "en 里有 `·`（U+00B7）"],
    ["common.loadFailed", "en 里有 `—`（U+2014）"],
  ])("⑩ 反向控制（真字典 %s）：%s ⇒ 不许红", (key) => {
    const real = DICT[key];
    expect(
      real,
      `字典里已经没有 ${key} 了 ⇒ 这一格的反向控制从此空转，请换一条同型的真 key，别删掉这一格`,
    ).toBeDefined();
    const r = run({
      dict: { [key]: { ...real } },
      // 末尾那个 `, {}` 是给第 ⑧ 条的：带占位符的 key 后面必须紧跟一个逗号。
      files: { "js/x.js": `t("${key}", {});\n` },
    });
    expect(r.status, r.stderr).toBe(0);
  });
});
