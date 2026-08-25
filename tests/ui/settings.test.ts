import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  CARD_AUTH, CARD_UPSTREAM, CARD_REGISTRAR, ADVANCED_FIELDS,
  channelFields, fieldLabelKey, errorMessageKey, fieldView, credentialView,
  buildPatch, localErrors, changedFields, propagationView, errorRows, displayValue, clearWarning,
  BUILD_TIME_FIELDS, touchesBuildTimeField, touchesLiveField, isSaveReceipt,
} from "../../admin-ui/js/pure/settings.mjs";
import { CHANNELS } from "../../admin-ui/js/pure/registrar.mjs";
import { I18N } from "../../admin-ui/js/i18n-dict.js";
import { EDITABLE_FIELDS, CONFIG_ERROR_CODES, envNameOf } from "../../src/core/admin/config-validate.js";
import { blankComments } from "../helpers/strip-comments.js";

/**
 * 设置页的纯函数（`admin-ui/js/pure/settings.mjs`）。
 *
 * ⚠️ **本文件补的是静态判据看不出真假的那一族。**
 * `fieldLabelKey()` 返回的是**模板字面量**（`` `set.field.${path}` ``），
 * 而静态判据只能看出「有一条模板可能拼出这个前缀底下的 key」，看不出到底拼出了哪几个。
 *
 * ⚠️⚠️ **这一段的机制在 P3e 改过两次，别照上一版读。** 上一版写的是
 * 「那一族今天全部被报成「未被引用」的**警告**，而那道门禁在警告上从不 exit 1」——
 * 两句今天都不成立：
 * · P3e Task 3 起 `scripts/check-i18n.mjs` 把 `` `set.field.${…}` `` 收成一条**拼键前缀**，
 *   那一族因此落进横幅的「拼键覆盖」桶，**根本不进「未被引用」**；
 * · P3e Task 4 起第 ④ 条是**硬错**，不再有「警告」这一档（`warnings` 数组已删）。
 * ⇒ 换来的代价要说清楚：「拼键覆盖」这一桶等于**永久豁免死 key 检查**——
 * 那一族里真有一条没人用的 key，门禁永远不会红。
 * 下面「后端 EDITABLE_FIELDS 的每条路径都有一条 set.field.* 文案」补的正是这一半：
 * 它从后端那份编译期强制的清单出发反查字典，加字段不补文案当场红。
 */

const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"] as const;
const dict = I18N as Record<string, Record<string, string>>;

describe("字段清单：设计 §10.4 的三张卡 + 高级折叠区", () => {
  /**
   * ⚠️⚠️ **设计 §8.6 第二行：`agnesPlatformUrl` 是注册凭据的去向**
   *（改成自己的服务器就能收走每次注册的邮箱 + 密码 + 验证码）
   * ⇒ 折进「高级」折叠区 + 红色警告 + 二次确认，**不放主表单**。
   *
   * **变异 M10 的靶子**：把它挪回主表单。
   */
  it("agnesPlatformUrl 只在高级区，主表单三张卡一格都不许有它", () => {
    const main = [...CARD_AUTH, ...CARD_UPSTREAM, ...CARD_REGISTRAR];
    expect(main, "注册去向被挪回主表单了 —— 它会跟着一次普通的「调个超时」被顺手改掉")
      .not.toContain("registrar.agnesPlatformUrl");
    expect([...ADVANCED_FIELDS]).toEqual(["registrar.agnesPlatformUrl"]);
  });

  /**
   * **两条通道的字段清单逐字同构**（设计 §10.3 第 2 条：两张卡片布局完全对称，
   * 同字段数、同控件类型）。
   *
   * 判据是「把通道名换掉之后两份清单完全相等」——加一行给某一条通道就当场红。
   */
  it("两条通道的字段清单同构：同字段数、同顺序、同后缀", () => {
    const shapes = CHANNELS.map((c: string) =>
      channelFields(c).map((f: string) => f.replace(`registrar.${c}.`, "")));
    expect(shapes[0]).toEqual(shapes[1]);
    // 手写字面量：清单本身也钉住，免得两边一起被改成空数组也算「同构」。
    expect(shapes[0]).toEqual(["baseUrl", "apiKey"]);
  });

  /**
   * **两条通道的标签共用同一对 key。**
   *
   * 这是「完全对称」在文案层面的落点，而且它比禁用词表**更强**：想给某一条通道
   * 多写半句话，得先造出第二个 key，而那一步在评审里看得见。
   * （`set.*` 命名空间不在 `check-i18n` 第 ⑥ 条的禁用词作用域里，这一格与
   * `reg.channel.*` 那几条一起构成本任务在这条硬约束上的全部护栏。）
   */
  it("两条通道的字段标签是同一对 i18n key —— 不许各写一套", () => {
    const keys = CHANNELS.map((c: string) => channelFields(c).map(fieldLabelKey));
    expect(keys[0]).toEqual(keys[1]);
    expect(keys[0]).toEqual(["set.field.channel.baseUrl", "set.field.channel.apiKey"]);
  });

  /**
   * **后端说能改的每一格，面板上都得有一个入口。**
   *
   * `EDITABLE_FIELDS` 是后端那份（它与 `FIELD_EXPOSURE` 有编译期强制的对账）。
   * 不写这一格的话，加一个配置字段之后 `GET /admin/api/config` 会返回一份
   * 「说能改、却没有任何地方能改」的清单——那正是本仓反复裁过的
   * 「面板说一件事、实际是另一件事」。
   */
  it("后端 EDITABLE_FIELDS 的每条路径都在面板的某张卡里", () => {
    const shown = new Set<string>([
      ...CARD_AUTH, ...CARD_UPSTREAM, ...CARD_REGISTRAR, ...ADVANCED_FIELDS,
      ...CHANNELS.flatMap((c: string) => channelFields(c)),
    ]);
    expect([...EDITABLE_FIELDS].filter((f) => !shown.has(f)).sort()).toEqual([]);
    // 反向：面板上不许有后端不认识的格子（那一格保存时会吃 `unknown_field`）。
    expect([...shown].filter((f) => !EDITABLE_FIELDS.includes(f)).sort()).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// P3e Task 23：「建实例时读一次」那两个旋钮，三处说法一起守
// ───────────────────────────────────────────────────────────────────────────

const WIRE = "src/http/wire.ts";
/** 建 app 时那份**只读一次**的配置快照是从这一行来的。 */
const SNAPSHOT_DECL = "const cfg = configHolder.current()";
/** `.env.example` 里那句话的判据串——与 `POOL_CACHE_TTL_MS` 那格原有的写法逐字相同。 */
const PANEL_CAVEAT = "面板改它不会立刻生效";

/**
 * **五语言 DEPLOY.md 那两格里，「面板改它不会立刻生效」那句正文的本地化写法。**
 *
 * ⚠️ **这张表是补 Task 23 复评发现 2 才有的，它守的是一个实测过的盲点**：
 * 那一半原来只被 `tests/unit/docs-parity.test.ts` 的
 * 「五语言 DEPLOY.md 里……的出现次数彼此一致」那条**路径 token 计数**守着，
 * 而复评的 R8 实测（回填时复跑过一次）——五份**同步**把那句正文删掉、只留
 * `src/http/wire.ts` 这个路径—— docs-parity 那份 66 格全绿、`check-comment-refs` EXIT=0，
 * 而 `src/http/wire.ts` 注释里
 * 那句「五语言 DEPLOY.md 的那两格逐格写明了」当场变假。计数锚挡得住「某一份漏改」
 * 与「五份连锚一起删」，**挡不住「五份同步改写正文、保留锚」**。
 *
 * ⚠️ **这是一张手抄的译文表，它会因为「有人把译文重写了一遍」而变红，那是有意的**：
 * 变红时的正确动作是回来核对新译文说的是不是同一件事，然后改这张表——
 * 而不是把这条判据放宽。**放宽它就等于回到 R8 那个盲点。**
 * 边界同样写清楚：它只证明那句话**出现在那一格里**，不证明整行说得对、
 * 也不证明五份逐句同义（句子层面仍然留给评审，与 docs-parity 文件头那条边界同源）。
 *
 * ⚠️ zh-CN 那一档**直接复用 `PANEL_CAVEAT`**，不另抄一份：`.env.example` 与
 * zh-CN DEPLOY.md 用的本来就是同一句话，抄两份就是两份会分叉的判据。
 */
const PANEL_CAVEAT_BY_LANG: Record<(typeof LANGS)[number], string> = {
  "zh-CN": PANEL_CAVEAT,
  "zh-TW": "面板改它不會立刻生效",
  en: "editing it in the admin panel does not take effect immediately",
  ja: "パネルで変更しても即座には反映されません",
  ko: "패널에서 바꿔도 즉시 반영되지 않습니다",
};

/**
 * 某份 DEPLOY.md 的环境变量表里，某个变量**那一行**。
 *
 * ⚠️ **认不出要吵，不许静默返回空串**：空串会让下面每一条 `includes()` 判据
 * 静静地失去判别力（`"".includes(x)` 恒假 ⇒ 正题红，但反向控制会绿得毫无意义），
 * 而表格排版是最容易被顺手改掉的东西。
 */
function deployRow(src: string, envName: string): string {
  const rows = src.split("\n").filter((l) => l.startsWith(`| \`${envName}\``));
  if (rows.length !== 1) {
    throw new Error(`环境变量表里 \`${envName}\` 那一行找到 ${rows.length} 条 —— 判据的落点变了，先回来改判据`);
  }
  return rows[0]!;
}

/**
 * `src/http/wire.ts` 里那份**建 app 时读一次**的快照被读到的字段名。
 *
 * ⚠️ **先抠注释再扫**：本仓的注释里成片地写着真代码片段（`cacheTtlMs: cfg.poolCacheTtlMs`
 * 这一行在同一个文件的说明里就被复述过），裸 `grep` 会把散文当成事实。
 * 抠注释走 `scripts/lib/strip-comments.mjs` 那一份真源，不在这里手写第二份。
 *
 * ⚠️ **认不出要吵，不许静静地回空数组**：那一行被改名之后静默返回 `[]` 的话，
 * 下面那条交集恒空 ⇒ 判据整个作废，而它会一直打绿。
 */
function buildTimeCfgReads(src: string): string[] {
  const code = blankComments(src);
  const at = code.indexOf(SNAPSHOT_DECL);
  if (at < 0) throw new Error(`扫不到 \`${SNAPSHOT_DECL}\` —— 判据的落点变了，先回来改判据，别让它静静地放行`);
  return [...new Set(
    [...code.slice(at).matchAll(/\bcfg\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!),
  )].sort();
}

/** `.env.example` 里某个环境变量**紧邻上方**那一段 `#` 注释。 */
function envExampleBlock(src: string, envName: string): string {
  const lines = src.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`${envName}=`));
  if (at < 0) throw new Error(`.env.example 里没有 ${envName}= 这一行`);
  const out: string[] = [];
  for (let i = at - 1; i >= 0 && lines[i]!.startsWith("#"); i -= 1) out.unshift(lines[i]!);
  return out.join("\n");
}

function envNameFor(field: string): string {
  const name = envNameOf(field);
  if (name === null) throw new Error(`${field} 没有对应的环境变量名`);
  return name;
}

/**
 * **一份不会自己红的清单不是守卫，是待办。**
 *
 * `BUILD_TIME_FIELDS` 长得像一份手写的字段名清单，而它必须是一条**性质**的产物：
 * 「`src/http/wire.ts` 建 app 时读一次」∩「后端 `EDITABLE` 说面板能改」。
 * 下面这一组就是那条性质本身，逐条从真源反查——手写那两个名字的地方只剩一处，
 * 而它一漂就红。
 *
 * ⚠️ **这一组是 `admin-ui/js/pure/settings.mjs` 里 `BUILD_TIME_FIELDS` 那段注释
 * 点名的那一格**，两边别只改一边。
 */
describe("建实例时读一次的那两个旋钮（P3e Task 23）", () => {
  it("BUILD_TIME_FIELDS 就是 wire.ts 建 app 时读的那份快照里、面板又能改的那几格", () => {
    const reads = buildTimeCfgReads(readFileSync(WIRE, "utf8"));

    // ① **我认得出**：那三格真的被扫出来了。少了这一条，判据哪天认不出任何东西时
    //    下面那个交集会变成 `[] === []`——**只有反向控制红，真扫描全绿**。
    expect(reads, `${WIRE} 里那份建 app 时读一次的快照没被扫出该有的字段 —— 判据瞎了`)
      .toEqual(expect.arrayContaining(["poolCacheTtlMs", "poolTouchIntervalMs", "usageStatsEnabled"]));

    // ② **我不乱红**：`usageStatsEnabled` 同样是建实例时读一次的，但它不在后端的
    //    `EDITABLE` 里 ⇒ 面板改不到它 ⇒ 它不该进 `BUILD_TIME_FIELDS`。
    //    这一条钉的是「交集」那一半真的在起作用：去掉它，判据就退化成「凡是被读到的都算」。
    expect([...EDITABLE_FIELDS], "usageStatsEnabled 变成面板能改的了 —— 那它得进 BUILD_TIME_FIELDS，回来改这一格")
      .not.toContain("usageStatsEnabled");
    expect([...BUILD_TIME_FIELDS]).not.toContain("usageStatsEnabled");

    // ③ 正题：两边逐字相等。删一项、多一项、或者 wire.ts 又多读一个面板改得动的
    //    字段而没人回来补表，这一行当场红。
    expect(
      reads.filter((f) => EDITABLE_FIELDS.includes(f)).sort(),
      "BUILD_TIME_FIELDS 与 wire.ts 建 app 时读的那份快照对不上了 —— 面板会对某一格谎称「本实例已经生效」",
    ).toEqual([...BUILD_TIME_FIELDS].sort());
  });

  /**
   * **判据的探针，与真扫描共用同一个 `buildTimeCfgReads()`。**
   * 夹具里那一行**逐字取自真源**，不在这里手抄——手抄的那份会漂，而漂了之后
   * 探针测的是一个仓里并不存在的世界。
   */
  it("判据认得出真源那一行，而同一行躺在注释里时不算数", () => {
    const real = blankComments(readFileSync(WIRE, "utf8"))
      .split("\n").map((l) => l.trim()).find((l) => l.includes("cfg.poolCacheTtlMs"));
    expect(real, `${WIRE} 里找不到读 cfg.poolCacheTtlMs 的那一行`).toBeDefined();

    expect(buildTimeCfgReads(`${SNAPSHOT_DECL};\n${real}\n`)).toEqual(["poolCacheTtlMs"]);
    // **注释里的同一行不算数**：本仓的注释里成片地写真代码片段，
    // 不抠注释的话「散文里提过」就会被当成「代码里读了」。
    expect(
      buildTimeCfgReads(`${SNAPSHOT_DECL};\n// ${real}\n`),
      "注释里的那一行被当成了真的读取 —— 抠注释那一步没生效",
    ).toEqual([]);
  });

  it(".env.example 里这两个旋钮各自都写明了改了要重启、面板改它不会立刻生效", () => {
    const src = readFileSync(".env.example", "utf8");
    const missing = [...BUILD_TIME_FIELDS].filter(
      (f: string) => !envExampleBlock(src, envNameFor(f)).includes(PANEL_CAVEAT),
    );
    expect(
      missing,
      "这几格的 .env.example 注释里没写「面板改它不会立刻生效」—— 而 src/http/wire.ts 的注释正声称写了",
    ).toEqual([]);
  });

  /**
   * **反向控制：逐次生效的那些格不许写这句话。**
   * 少了这一格，一个「整份文件里出现过就算」的判据也能让上面那格全绿，
   * 而那种判据对「某一格漏写」结构性地看不见。
   */
  it("反向控制：逐次生效的字段那一格不许写这句话（拿 maxStrikes 那格核对）", () => {
    const block = envExampleBlock(readFileSync(".env.example", "utf8"), envNameFor("maxStrikes"));
    // 先确认判据真的读到了东西——不是因为那一段是空的才没命中。
    expect(block.length, "maxStrikes 那格上面一行注释都没有 —— 判据没读到东西，下面那句不成立")
      .toBeGreaterThan(0);
    expect(block, "maxStrikes 是逐次生效的，那格写「面板改它不会立刻生效」就是一句新的假话")
      .not.toContain(PANEL_CAVEAT);
  });

  /**
   * **整份 `.env.example` 里写着这句话的，恰好就是 `BUILD_TIME_FIELDS` 那几格。**
   *
   * 上面两格是「点名的那格写了」+「点名的那格没写」，**逐格点名的清单挡不住第三格**——
   * Task 23 复评发现 5 就是这么冒出来的：`USAGE_STATS_ENABLED` 那块注释里也写着这句话，
   * 而 `usageStatsEnabled` 压根不在后端的 `EDITABLE` 里（面板上根本没有这一格）。
   * 「面板改它不会立刻生效」这句话**预设了面板能改它**，写在一个面板改不到的旋钮上
   * 就是一句会把人引去面板里找的假话。
   *
   * 判据整份文件扫、期望值从 `BUILD_TIME_FIELDS` 派生，所以它对**第三格**是睁着眼的。
   */
  it("整份 .env.example 里写这句话的，恰好就是 BUILD_TIME_FIELDS 那几格（不多不少）", () => {
    const lines = readFileSync(".env.example", "utf8").split("\n");
    const withCaveat: string[] = [];
    for (const [i, line] of lines.entries()) {
      const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
      if (m === null) continue;
      const block: string[] = [];
      for (let j = i - 1; j >= 0 && lines[j]!.startsWith("#"); j -= 1) block.unshift(lines[j]!);
      if (block.join("\n").includes(PANEL_CAVEAT)) withCaveat.push(m[1]!);
    }
    // **认得出**：扫描器真的解析出了一批变量名，不是因为正则瞎了才「一个都没匹配」。
    expect(lines.filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).length, ".env.example 里一个 KEY= 都没扫到 —— 判据瞎了")
      .toBeGreaterThan(10);
    expect(
      withCaveat.sort(),
      "写着「面板改它不会立刻生效」的那几格与 BUILD_TIME_FIELDS 对不上 —— 要么某一格漏写，要么某个面板改不到的旋钮上多写了这句预设「面板能改它」的话",
    ).toEqual([...BUILD_TIME_FIELDS].map((f: string) => envNameFor(f)).sort());
  });

  /**
   * ⚠️⚠️ **五语言那一半：查的是正文，不是路径锚。**
   *
   * `src/http/wire.ts` 的注释声称「`.env.example` 与五语言 DEPLOY.md 的环境变量表
   * 那两格逐格写明了」。上面三格管 `.env.example` 那一半；这一格管五语言那一半。
   *
   * **它存在的全部理由是一个实测过的盲点**（Task 23 复评发现 2 / R8）：
   * 那一半原来只有 `tests/unit/docs-parity.test.ts` 的
   * 「五语言 DEPLOY.md 里……的出现次数彼此一致」那条**路径 token 计数**守着，
   * 而「五份同步删掉正文、只留 `src/http/wire.ts` 这个路径」那种改法**全绿**。
   * 计数锚管的是「五份彼此对等」，管不了「那句话到底还在不在」——**那是两件事**。
   *
   * ⚠️ 两条都查：正文（本地化）+ 路径锚。少了后者，把出处删掉也不会红；
   * 少了前者就是回到 R8。
   */
  it("五语言 DEPLOY.md 的那两格里，正文逐格写着「面板改它不会立刻生效」，而且指着出处", () => {
    const missing: string[] = [];
    for (const lang of LANGS) {
      const src = readFileSync(`docs/${lang}/DEPLOY.md`, "utf8");
      for (const field of BUILD_TIME_FIELDS as readonly string[]) {
        const row = deployRow(src, envNameFor(field));
        if (!row.includes(PANEL_CAVEAT_BY_LANG[lang])) missing.push(`${lang}/${envNameFor(field)}: 正文`);
        if (!row.includes(WIRE)) missing.push(`${lang}/${envNameFor(field)}: 出处`);
      }
    }
    expect(
      missing,
      "五语言 DEPLOY.md 的这几格里那句话没了 —— 而 src/http/wire.ts 的注释正声称五份都逐格写明了",
    ).toEqual([]);
  });

  /**
   * **反向控制：逐次生效的那一格，五份都不许写这句话。**
   *
   * 少了它，一张**全是空串**的 `PANEL_CAVEAT_BY_LANG`（或者一条「整份文档里出现过就算」
   * 的判据）也能让上面那格全绿——`"".includes("")` 恒真，而那种判据对
   * 「某一格漏写」结构性地看不见。形状与 `.env.example` 那条反向控制同源。
   */
  it("反向控制：五语言 DEPLOY.md 里逐次生效的那一格不许写这句话（拿 MAX_STRIKES 那格核对）", () => {
    for (const lang of LANGS) {
      const row = deployRow(readFileSync(`docs/${lang}/DEPLOY.md`, "utf8"), envNameFor("maxStrikes"));
      // 先确认判据真的读到了一整行 —— 不是因为那一行是空的才没命中。
      expect(row.length, `${lang} 的 MAX_STRIKES 那一行几乎是空的 —— 判据没读到东西，下面那句不成立`)
        .toBeGreaterThan(40);
      expect(row, `${lang}：maxStrikes 是逐次生效的，那格写这句话就是一句新的假话`)
        .not.toContain(PANEL_CAVEAT_BY_LANG[lang]);
    }
  });

  /**
   * 两条判据的取值本身。**`touchesLiveField()` 不是 `touchesBuildTimeField()` 的取反**，
   * 混合保存时两者同时为真——DOM 那一半由 `tests/ui/dom/settings-save.test.ts` 的
   * 「③ 混合保存：同时改一个逐次生效的字段和一个旋钮 ⇒ 两句都出现」钉着。
   */
  it("两条判据在混合保存时同时为真，在空回执上同时为假", () => {
    expect(touchesBuildTimeField(["poolCacheTtlMs"])).toBe(true);
    expect(touchesLiveField(["poolCacheTtlMs"])).toBe(false);
    expect(touchesBuildTimeField(["maxStrikes"])).toBe(false);
    expect(touchesLiveField(["maxStrikes"])).toBe(true);
    expect(touchesBuildTimeField(["maxStrikes", "poolTouchIntervalMs"])).toBe(true);
    expect(touchesLiveField(["maxStrikes", "poolTouchIntervalMs"])).toBe(true);
    // 一次「什么都没变」的回读：两句话都不该说。
    expect(touchesBuildTimeField([])).toBe(false);
    expect(touchesLiveField([])).toBe(false);
  });

  /**
   * **「这是不是一次保存的回执」判的是 `changed` 在不在，不是它空不空。**
   * 判成「空数组 = 不是回执」的话，一次「什么都没改」的保存会被当成读取态，
   * 于是面板对着它说「本实例已经生效」——又一句无中生有的回执。
   */
  it("isSaveReceipt：GET / 清空那两种响应不是回执，空 changed 的 PUT 响应是", () => {
    expect(isSaveReceipt({ fields: {}, editable: [], secrets: [] })).toBe(false);
    expect(isSaveReceipt({ cleared: "gatewayToken", stillConfigured: false })).toBe(false);
    expect(isSaveReceipt({ fields: {}, changed: [], credentialsChanged: [] })).toBe(true);
    expect(isSaveReceipt({ fields: {}, changed: ["maxStrikes"] })).toBe(true);
    // 形状不对的一律不算（`changed` 是个字符串 / 整份响应是 null）。
    expect(isSaveReceipt({ changed: "maxStrikes" })).toBe(false);
    expect(isSaveReceipt(null)).toBe(false);
  });
});

describe("i18n：门禁看不见的那两族，在这里补上", () => {
  /**
   * **`set.field.*` 这一族落进 `scripts/check-i18n.mjs` 那个「拼键覆盖」桶 = 永久豁免死 key 检查**
   *（见文件头；上一版这里写的是「对三道 i18n 门禁是隐身的」，机制换了、代价没换）。
   * 判据从**后端那份编译期强制的清单**出发反查字典 ⇒ 加字段不补文案当场红。
   */
  it("后端 EDITABLE_FIELDS 的每条路径都有一条 set.field.* 文案，且五语言齐备", () => {
    const missing: string[] = [];
    for (const field of EDITABLE_FIELDS) {
      const key = fieldLabelKey(field);
      const row = dict[key];
      if (row === undefined) { missing.push(`${field} → ${key}（字典里没有）`); continue; }
      for (const lang of LANGS) {
        if (typeof row[lang] !== "string" || row[lang]!.trim() === "") missing.push(`${key}/${lang}`);
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * **设计 §10.4 点名要求的那条 CI 断言：后端产出的每一个错误码都有对应的 i18n 键。**
   *
   * ⚠️⚠️ **第一版这里是一份手写镜像 + `as const satisfies readonly ConfigErrorCode[]`，
   * 那条护栏实测是假的**（评审 C4，我自己复现过）：`satisfies` 只做**单向可赋值检查**
   * ——它保证镜像里每一项都是合法的码，**不保证每一个码都在镜像里**。
   * 给联合加一个码而不补 `ERROR_KEYS`、不补五语言 ⇒
   * `tsc exit=0` / 本文件 `34 passed` / `check-i18n exit=0` / `check-comment-refs exit=0`，
   * **零信号**；而反向（从联合里删一个）确实 `TS2322 ×2`。**删得住、加不住。**
   *
   * ⇒ 后端改成「数组是真源、类型从它派生」（`CONFIG_ERROR_CODES`），
   * 这里**直接遍历那个数组**，不再有第二份清单可以漂。
   */
  it("后端产出的每一个错误码都有对应的 i18n 键 —— 加一个码不补文案就变红", () => {
    const missing: string[] = [];
    for (const code of CONFIG_ERROR_CODES) {
      const key = errorMessageKey(code);
      if (key === null) { missing.push(`${code}（errorMessageKey 表里没有）`); continue; }
      const row = dict[key];
      if (row === undefined) { missing.push(`${code} → ${key}（字典里没有）`); continue; }
      for (const lang of LANGS) {
        if (typeof row[lang] !== "string" || row[lang]!.trim() === "") missing.push(`${key}/${lang}`);
      }
    }
    expect(missing).toEqual([]);
    // 反向自检：表本身不是空的。**这个数字是手写的**，加码时必须回来表态。
    expect(CONFIG_ERROR_CODES.length, "错误码表规模变了，请确认文案与映射都跟上了").toBe(20);
  });

  /**
   * **表外的码返回 `null`，不冒充任何一档已知原因。**
   * `null` 让调用方把那个码原样显示出来（`set.err.unknown`），而一句写死的
   * 「保存失败」会把一条本来能被运维 grep 到的线索抹掉。
   */
  it("表外的错误码返回 null —— 让调用方把它原样显示出来", () => {
    expect(errorMessageKey("brand_new_code_from_the_future")).toBeNull();
    expect(errorMessageKey(undefined)).toBeNull();
    expect(dict["set.err.unknown"], "兜底那句文案得存在").toBeDefined();
  });
});

describe("四元组与凭据的读法", () => {
  const body = {
    fields: {
      maxStrikes: { stored: 4, env: "9", effective: 9, lockedBy: "env:MAX_STRIKES" },
      "registrar.targetKeys": { stored: 20, env: null, effective: 20, lockedBy: null },
    },
    credentials: {
      gatewayToken: { configured: true, hint: "wxyz", lockedBy: null },
    },
    secrets: ["gatewayToken"],
    changed: ["maxStrikes"],
    propagation: { configTtlMs: 30_000, kvEdgeCacheMs: 60_000, visibilityUpperBoundMs: 90_000 },
  };

  it("锁定字段：locked 为真，且带着是哪个环境变量", () => {
    expect(fieldView(body, "maxStrikes")).toEqual({
      present: true, stored: 4, env: "9", effective: 9, lockedBy: "env:MAX_STRIKES", locked: true,
    });
    expect(fieldView(body, "registrar.targetKeys").locked).toBe(false);
  });

  /** 「这一格是空的」与「没读到」必须分得开。 */
  it("读不到的字段 present 为 false，而不是伪造一格空值", () => {
    expect(fieldView(body, "nope").present).toBe(false);
    expect(fieldView(null, "maxStrikes").present).toBe(false);
  });

  it("凭据视图永远没有明文，只有配没配与末 4 位", () => {
    expect(credentialView(body, "gatewayToken")).toEqual({
      present: true, configured: true, hint: "wxyz", lockedBy: null, locked: false,
    });
  });

  it("changed 从响应里取，不是前端自己 diff 出来的", () => {
    expect(changedFields(body)).toEqual(["maxStrikes"]);
    expect(changedFields({}), "没有这一格时是空数组，不是 null").toEqual([]);
  });

  /** **不许写「立即生效」**（设计 §5.2）：读不到就不渲染那一行，不伪造 0。 */
  it("传播上界读不到时逐格 null，不伪造 0", () => {
    expect(propagationView(body).visibilityUpperBoundMs).toBe(90_000);
    expect(propagationView({}).visibilityUpperBoundMs).toBeNull();
  });

  it("displayValue：null 显示成 —，布尔显示成 true/false，不留空白", () => {
    expect(displayValue(null)).toBe("—");
    expect(displayValue(false)).toBe("false");
    expect(displayValue(0)).toBe("0");
  });
});

describe("buildPatch：三条规则", () => {
  const body = {
    fields: {
      maxStrikes: { stored: 4, env: "9", effective: 9, lockedBy: "env:MAX_STRIKES" },
      "registrar.targetKeys": { stored: 20, env: null, effective: 20, lockedBy: null },
      "registrar.enabled": { stored: false, env: null, effective: false, lockedBy: null },
      agnesBaseUrl: { stored: "https://a.example.com", env: null, effective: "https://a.example.com", lockedBy: null },
    },
    credentials: {
      gatewayToken: { configured: true, hint: "wxyz", lockedBy: null },
      "registrar.yyds.apiKey": { configured: false, hint: null, lockedBy: "env:YYDS_API_KEY" },
    },
    secrets: ["gatewayToken", "registrar.yyds.apiKey"],
  };

  it("锁定的字段一律不送 —— 送了会把整份 patch 一起打回来", () => {
    expect(buildPatch({ maxStrikes: "5", "registrar.targetKeys": "25" }, body))
      .toEqual({ "registrar.targetKeys": 25 });
  });

  it("凭据留空 = 不送（设计 §8.6：缺席或空串 = 不改）", () => {
    expect(buildPatch({ gatewayToken: "" }, body)).toEqual({});
    expect(buildPatch({ gatewayToken: "new-one" }, body)).toEqual({ gatewayToken: "new-one" });
    // 锁定的凭据同样不送。
    expect(buildPatch({ "registrar.yyds.apiKey": "k" }, body)).toEqual({});
  });

  /**
   * ⚠️⚠️ **真机冒烟抓出来的两条缺陷之一（P3b 说的「把验收当一等交付物」）。**
   *
   * 输入框回填的是**存储层**那个值，而全新部署下存储层是空的 ⇒ 一整页空框。
   * 第一版对**字符串格**没有任何处置：`agnesBaseUrl` / `registrar.tokenName` 会被
   * 原样当成 `""` 送出去，运维**一个字都没改、点一次保存收到两条「不能留空」**。
   * 数值格那一半由 `coerce()` 挡着（空串 ⇒ `undefined`），这一格补的是另一半。
   */
  it("空框 + 存储里本来就没有 ⇒ 这次不改它（字符串格与数值格两边都要）", () => {
    const fresh = {
      fields: {
        agnesBaseUrl: { stored: null, env: null, effective: "https://built-in.example.com/v1", lockedBy: null },
        "registrar.tokenName": { stored: null, env: null, effective: "auto", lockedBy: null },
        maxStrikes: { stored: null, env: null, effective: 3, lockedBy: null },
      },
      credentials: {}, secrets: [],
    };
    expect(
      buildPatch({ agnesBaseUrl: "", "registrar.tokenName": "", maxStrikes: "" }, fresh),
      "空框被当成一次「把它改成空串」送了出去 —— 运维一个字都没改却被后端拒",
    ).toEqual({});
    // **另一半：用户把一个原本有值的格清空了，那是一次真实的意图，照常送出去。**
    const hasStored = {
      ...fresh,
      fields: { ...fresh.fields, agnesBaseUrl: { stored: "https://old.example.com", env: null, effective: "https://old.example.com", lockedBy: null } },
    };
    expect(buildPatch({ agnesBaseUrl: "" }, hasStored)).toEqual({ agnesBaseUrl: "" });
  });

  it("值没变的字段不送", () => {
    expect(buildPatch({ "registrar.targetKeys": "20", agnesBaseUrl: "https://a.example.com" }, body))
      .toEqual({});
  });

  /**
   * ⚠️⚠️ **真机冒烟抓出来的两条缺陷之二。**
   *
   * 全新部署下存储层是空的，而注册机那个开关（checkbox）读出来恒是 `false`
   * ⇒ 只比 `stored` 的话 `sameScalar(null, false)` 为假 ⇒ **每一次保存都会把
   * `registrar.enabled: false` 写进存储**，哪怕运维一个字都没改：一次白花的写配额，
   * 外加把一个内置取值**固化**进存储（以后改内置默认值再也传播不到这个部署）。
   */
  it("存储里没有、而当前值就等于生效值 ⇒ 不送（否则每次保存都白写一次）", () => {
    const fresh = {
      fields: {
        "registrar.enabled": { stored: null, env: null, effective: false, lockedBy: null },
        maxStrikes: { stored: null, env: null, effective: 3, lockedBy: null },
      },
      credentials: {}, secrets: [],
    };
    expect(
      buildPatch({ "registrar.enabled": false, maxStrikes: "3" }, fresh),
      "一次「什么都没改」的保存把内置取值固化进了存储",
    ).toEqual({});
    // 反向：真的改了当然要送。
    expect(buildPatch({ "registrar.enabled": true, maxStrikes: "9" }, fresh))
      .toEqual({ "registrar.enabled": true, maxStrikes: 9 });
  });

  it("数值按当前那一格的类型归一，布尔按开关归一", () => {
    expect(buildPatch({ "registrar.targetKeys": "25", "registrar.enabled": true }, body))
      .toEqual({ "registrar.targetKeys": 25, "registrar.enabled": true });
    // `NaN` 不送：前端本来就有「是数字」那条即时提示，送过去只会多一条后端错误。
    expect(buildPatch({ "registrar.targetKeys": "abc" }, body)).toEqual({});
  });
});

describe("前端只做四条最轻量的即时提示（设计 §10.4）", () => {
  const body = {
    fields: {
      maxStrikes: { stored: 3, env: null, effective: 3, lockedBy: null },
      "registrar.enabled": { stored: true, env: null, effective: true, lockedBy: null },
      "registrar.primary": { stored: "yyds", env: null, effective: "yyds", lockedBy: null },
      "registrar.fallback": { stored: null, env: null, effective: null, lockedBy: null },
    },
    credentials: {}, secrets: [],
  };

  it("必填 / 是数字 / 非负，三条各一格", () => {
    // 「必填」的判据是**用户把一个原本有值的格清空了**（`body` 里 `maxStrikes.stored` 是 3）。
    expect(localErrors({ maxStrikes: "" }, body)).toEqual([{ field: "maxStrikes", code: "empty" }]);
    expect(localErrors({ maxStrikes: "abc" }, body)).toEqual([{ field: "maxStrikes", code: "not_an_integer" }]);
    expect(localErrors({ maxStrikes: "-1" }, body)).toEqual([{ field: "maxStrikes", code: "below_min" }]);
    expect(localErrors({ maxStrikes: "9" }, body)).toEqual([]);
  });

  /**
   * ⚠️ **只到「非负」为止。** 具体下界（1 还是 0）是后端的事；在这里复刻一份会与
   * 后端的 `EDITABLE` 漂移，而那正是设计 §10.4 那个取舍要避免的东西。
   * `poolCacheTtlMs` 的 0 是合法的「关闭」，`maxStrikes` 的 0 不是——
   * **前端两者都放行**，后端各自判。
   */
  it("下界不在前端判：maxStrikes 填 0 前端放行，交给后端的 below_min", () => {
    expect(localErrors({ maxStrikes: "0" }, body)).toEqual([]);
  });

  /**
   * ⚠️ **「空」不等于「必填没填」**——同一次真机冒烟抓出来的那条（见 `buildPatch`
   * 那一族的说明）：全新部署下每个数值格的输入框都是空的（框里回填的是存储层，
   * 而存储层是空的），第一版让运维点一次保存**收到 12 条「这一格不能留空」**。
   */
  it("空框 + 存储里本来就没有 ⇒ 不报「不能留空」（与 buildPatch 同源）", () => {
    const fresh = {
      ...body,
      fields: { ...body.fields, maxStrikes: { stored: null, env: null, effective: 3, lockedBy: null } },
    };
    expect(localErrors({ maxStrikes: "" }, fresh)).toEqual([]);
  });

  it("注册机开着时，fallback === primary 前端就拦（设计 §10.3 第 7 条）", () => {
    expect(localErrors({ "registrar.fallback": "yyds" }, body))
      .toEqual([{ field: "registrar.fallback", code: "fallback_equals_primary" }]);
  });

  /**
   * ⚠️⚠️ **变异 M9 的靶子：把第四条改成无条件拦截。**
   *
   * 后端 `registrarFromEnv` 里那条抛错写在 `if (enabled && …)` 里（V21），
   * 关着的注册机它一条都不抛 ⇒ 前端无条件拦的后果是**「关着注册机时连下拉框都
   * 改不了」**，而后端明明会收下。**两边判据必须同源。**
   * 后端那一半在 `tests/unit/admin/config-validate.test.ts` 的
   * 「注册机关着时，fallback === primary 完全合法 —— 后端不抛，前端也不许拦」。
   */
  it("注册机关着时前端不拦 fallback === primary —— 与后端同源", () => {
    const off = {
      ...body,
      fields: { ...body.fields, "registrar.enabled": { stored: false, env: null, effective: false, lockedBy: null } },
    };
    expect(
      localErrors({ "registrar.fallback": "yyds" }, off),
      "前端无条件拦截了 —— 关着注册机时运维连下拉框都改不了，而后端会收下",
    ).toEqual([]);
    // 表单里现改的 `enabled` 同样算数（还没保存就该按新状态判）。
    expect(localErrors({ "registrar.enabled": false, "registrar.fallback": "yyds" }, body)).toEqual([]);
  });

  it("凭据不进即时提示 —— 它们留空是正当的（「留空则不修改」）", () => {
    const withSecret = { ...body, credentials: { gatewayToken: { configured: true, hint: "x", lockedBy: null } }, secrets: ["gatewayToken"] };
    expect(localErrors({ gatewayToken: "" }, withSecret)).toEqual([]);
  });
});

describe("errorRows：表外的码原样带出来", () => {
  it("认识的码给 key，不认识的给 null 并保留原码", () => {
    const rows = errorRows({
      errors: [
        { field: "maxStrikes", code: "below_min", params: { min: 1 } },
        { field: "x", code: "brand_new" },
      ],
    });
    expect(rows).toEqual([
      { field: "maxStrikes", code: "below_min", key: "set.err.below_min", params: { min: 1 } },
      { field: "x", code: "brand_new", key: null, params: {} },
    ]);
  });

  it("响应体不是那个形状时返回空数组，不抛", () => {
    expect(errorRows(null)).toEqual([]);
    expect(errorRows({ errors: "nope" })).toEqual([]);
  });
});

describe("清空凭据前那句警告：按状态分岔，每一条都是确定句", () => {
  /**
   * ⚠️⚠️ **同一句通用红字，在这几种状态下有的是救命、有的是吓人。**
   *
   * 面板手上有分辨它们的全部数据（`lockedBy` 说 env 里有没有；注册机开没开、
   * 这条通道在不在主/备链上都在四元组里）——**所以不许让运维自己猜**。
   * 第一版给的是一句带「如果……」的条件句，那等于把判断推回给读的人，
   * 而他手上恰恰没有比面板更多的信息。
   *
   * ⚠️ **判据不是「有没有警告」，是「四种状态给出四条互不相同的文案」。**
   * 只断「有警告」的话，退回那句通用条件句照样全绿。
   */
  const base = (over: Record<string, unknown> = {}) => ({
    fields: {
      "registrar.enabled": { stored: null, env: null, effective: false, lockedBy: null },
      "registrar.primary": { stored: null, env: null, effective: null, lockedBy: null },
      "registrar.fallback": { stored: null, env: null, effective: null, lockedBy: null },
      ...(over.fields as Record<string, unknown> ?? {}),
    },
    credentials: {
      gatewayToken: { configured: true, hint: "wxyz", lockedBy: null },
      "registrar.yyds.apiKey": { configured: true, hint: "9900", lockedBy: null },
      ...(over.credentials as Record<string, unknown> ?? {}),
    },
    secrets: ["gatewayToken", "registrar.yyds.apiKey"],
  });

  const ON_CHAIN = base({
    fields: {
      "registrar.enabled": { stored: true, env: null, effective: true, lockedBy: null },
      "registrar.primary": { stored: "yyds", env: null, effective: "yyds", lockedBy: null },
      "registrar.fallback": { stored: null, env: null, effective: null, lockedBy: null },
    },
  });

  const CASES: ReadonlyArray<{ name: string; body: unknown; path: string; key: string; kind: string }> = [
    {
      name: "env 里也有 ⇒ 回落到环境变量，生效值不变",
      body: base({ credentials: { gatewayToken: { configured: true, hint: "wxyz", lockedBy: "env:GATEWAY_TOKEN" } } }),
      path: "gatewayToken", key: "set.clear.effect.env", kind: "info",
    },
    {
      name: "gatewayToken 且 env 里没有 ⇒ 下一次冷启动会失败",
      body: base(), path: "gatewayToken", key: "set.clear.effect.gatewayMissing", kind: "danger",
    },
    {
      name: "通道 key、env 里没有、注册机开着且这条通道在链上 ⇒ 同样是冷启动失败",
      body: ON_CHAIN, path: "registrar.yyds.apiKey", key: "set.clear.effect.channelBreaks", kind: "danger",
    },
    {
      name: "通道 key、env 里没有、但这条通道不在链上 ⇒ 现在什么都不影响",
      body: base(), path: "registrar.yyds.apiKey", key: "set.clear.effect.channelIdle", kind: "info",
    },
  ];

  for (const c of CASES) {
    it(c.name, () => {
      expect(clearWarning(c.body, c.path)).toEqual({ key: c.key, kind: c.kind });
    });
  }

  /**
   * **四条互不相同**——退回一句通用文案时这一格立刻红。
   * 顺带把「红不红」也钉住：两条 danger、两条 info，全都不许是同一个值。
   */
  it("四种状态给出四条互不相同的 key，且轻重分成两档", () => {
    const keys = CASES.map((c) => clearWarning(c.body, c.path).key);
    expect(new Set(keys).size, "有两种状态给出了同一句话 —— 那就是在让运维自己猜").toBe(4);
    const kinds = CASES.map((c) => clearWarning(c.body, c.path).kind);
    expect(new Set(kinds).size, "轻重没有分档 —— 救命的那句与不影响的那句一样红").toBe(2);
  });

  /**
   * ⚠️ **`registrar.enabled` 与链上判定必须都参与**：只看 `enabled`（不看这条通道
   * 在不在链上）会把「开着注册机、但用的是另一条通道」误报成冷启动会失败——
   * 那正是「吓人」的那一半。
   */
  it("注册机开着、但这条通道不在链上 ⇒ 仍然是「现在不影响」", () => {
    const other = base({
      fields: {
        "registrar.enabled": { stored: true, env: null, effective: true, lockedBy: null },
        "registrar.primary": { stored: "moemail", env: null, effective: "moemail", lockedBy: null },
        "registrar.fallback": { stored: null, env: null, effective: null, lockedBy: null },
      },
    });
    expect(clearWarning(other, "registrar.yyds.apiKey").key).toBe("set.clear.effect.channelIdle");
    // 反向：把它设成备通道 ⇒ 立刻升级成 danger。
    const asFallback = base({
      fields: {
        "registrar.enabled": { stored: true, env: null, effective: true, lockedBy: null },
        "registrar.primary": { stored: "moemail", env: null, effective: "moemail", lockedBy: null },
        "registrar.fallback": { stored: "yyds", env: null, effective: "yyds", lockedBy: null },
      },
    });
    expect(clearWarning(asFallback, "registrar.yyds.apiKey").key).toBe("set.clear.effect.channelBreaks");
  });

  it("四条文案五语言齐备（这一族同样是三道 i18n 门禁看不见的）", () => {
    for (const c of CASES) {
      const row = dict[c.key];
      expect(row, `${c.key} 不在字典里`).toBeDefined();
      for (const lang of LANGS) {
        expect(typeof row![lang], `${c.key}/${lang}`).toBe("string");
        expect(row![lang]!.trim(), `${c.key}/${lang} 是空的`).not.toBe("");
      }
    }
  });
});
