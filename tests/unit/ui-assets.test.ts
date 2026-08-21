import { describe, it, expect } from "vitest";
import {
  readFileSync, readdirSync, statSync, mkdtempSync, rmSync,
  cpSync, mkdirSync, appendFileSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { UI_ASSETS, UI_BUILD_HASH } from "../../src/ui/assets.generated.js";

/**
 * **只放 node 侧**（vitest.workers.config.ts 的 include 只有 tests/contract）：
 * 这一组要用 `node:fs` 读 admin-ui/ 源文件、还要 spawn 一次生成器，workerd 里两样都没有。
 *
 * 路径一律从 `import.meta.url` 解析，不用相对 cwd。cwd 依赖会让「换个目录跑测试」
 * 变成静默的空遍历——而空遍历下这一整组断言全绿，正是本项目第 1 类假阳性的形态。
 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_DIR = join(ROOT, "admin-ui");
const GENERATOR = join(ROOT, "scripts", "build-ui.mjs");
const GENERATED = join(ROOT, "src", "ui", "assets.generated.ts");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** 绝对路径 → 生成物里的路由键。这是**约定**（策略），不是从 UI_ASSETS 读出来的。 */
function routeOf(absPath: string): string {
  const rel = absPath.slice(SRC_DIR.length + 1).split(sep).join("/");
  return rel === "index.html" ? "/admin" : `/admin/${rel}`;
}

/** 参与生成的源文件（README 只给人看，不投递）。 */
const SOURCES = walk(SRC_DIR).filter((p) => !p.endsWith("README.md"));

describe("生成物与 admin-ui/ 源逐字节相同", () => {
  /**
   * 设计文档 §4.2 守住硬约束 4（不引入需要构建步骤的前端框架）的**全部依据**是这一句：
   * 生成器不转译、不打包、不压缩，产物字节与源文件逐字节相同，因此把 admin-ui/ 原样当
   * 静态文件挂出去就是一个完整可调试的面板——它是投递方式，不是构建管线。
   * 这句话必须由断言钉死，不能靠自觉。
   *
   * ⚠️ **这段原来的措辞是「admin-ui/index.html 用浏览器直接打开（file://）仍然是一个
   * 完整可调试的面板」，那句是假的**（P3b Task 7 的阶段验收实测推翻；同一句假话在三处
   * 出现，本文件、scripts/build-ui.mjs 的文件头、admin-ui/README.md，一起订正）。
   * index.html 的资源引用是绝对路径（`/admin/js/app.js` 等），file:// 下解析成
   * `file:///admin/...` 而全部 404；且现代浏览器把 file:// 文档的源当成 null，
   * `type="module"` 的脚本会被 CORS 挡下。**「逐字节相同」这条性质本身没变，
   * 变的只是「怎么打开它」**——可执行的验收步骤写在 admin-ui/README.md。
   */
  it("源目录里每个文件都在生成物里，且内容一字不差", () => {
    expect(SOURCES.length, "源目录空了，下面的循环会一格不跑却全绿").toBeGreaterThan(0);
    for (const p of SOURCES) {
      const key = routeOf(p);
      const asset = UI_ASSETS[key];
      expect(asset, `${p} 没有对应的路由 ${key}`).toBeTruthy();
      expect(asset!.body, `${p} 与生成物不一致`).toBe(readFileSync(p, "utf8"));
    }
  });

  it("生成物里没有源目录之外的多余条目", () => {
    expect(Object.keys(UI_ASSETS).sort()).toEqual(SOURCES.map(routeOf).sort());
  });

  /**
   * 下限绊线：防「walk 扫了个空目录也全绿」。上面那条「源目录 == 生成物」在两边
   * 一起变空时同样成立，是这个项目第 1 类假阳性的经典形态——所以单独钉一个
   * 与磁盘扫描无关的下限。17 是本期（Task 3）落地后源文件的实际数量，手写字面量。
   */
  it("源文件数量不低于 17——防扫描本身坏成空目录", () => {
    expect(SOURCES.length, "扫描本身坏了").toBeGreaterThanOrEqual(17);
  });

  /**
   * **资产清单是显式快照，加一个文件就必须在这里表态。**
   *
   * 丢进 `admin-ui/` 的任何东西都会变成一条**免鉴权的公网端点**——白名单里有
   * `.json`，将来谁放一个 `config.json` 或一份调试笔记进去，它就静默地公开可取，
   * 而唯一的网只有 scan-secrets 那 5 条正则。这是公开 MIT 仓、卖点是「裸克隆即
   * deploy」，趁资产集合还没长大时钉住成本最低。
   *
   * 上面那条只保证「生成物 == 源目录」，两边一起长的时候它不会红；这条才拦得住。
   *
   * ⚠️ **这条锁的是键集合，不是已有文件的内容——边界写在这里，别让后人以为
   * 「往面板里塞恶意代码」这件事被自动化覆盖了。** 已实测：往 `admin-ui/js/app.js`
   * 追加一行把 localStorage 里的管理口令 `fetch` 到外部域名，重新跑一次生成器之后
   * 全套测试照绿、漂移门禁也不红（因为确实重新生成过，产物与源是一致的）。
   *
   * 这**不是遗漏，是有意的分工**：这一层留给**代码评审**。同一轮里
   * `.gitattributes` 特意不加 `-diff`，理由正是「手工往生成物里塞脚本恰恰最该被
   * 评审看见」——两处是同一个决定的两半。想把它自动化，需要的是别的东西
   * （出网域名白名单 / CSP 的 connect-src 收紧到自身），不是把这条快照写得更长。
   *
   * Task 3（前端基础设施 + i18n 门禁）一次加了 12 个文件：`css/shell.css`、
   * `css/sections.css`、`js/api.js`、`js/i18n-dict.js`、`js/i18n.js`、`js/theme.js`、
   * `js/ui.js`、`js/pure/format.mjs`，以及三个空板块桩
   * `js/sec-overview.js` / `js/sec-keys.js` / `js/sec-events.js`。逐个确认过：
   *（Task 3 当时还加了 `js/pure/bucket.mjs`，它与 `js/pure/mask.mjs` 已在全分支
   *  评审 B3 一并删除——两者在 `admin-ui/js/` 里零导入者，后端的
   *  `src/core/admin/key-view.ts` 早就把 `masked`/`bucket` 算好放进响应了。）
   * 全部是面板自己的 HTML/CSS/JS，没有配置、没有笔记、没有任何含数据的文件，
   * 都该是公开可取的。清单**手写**，不是从测试跑出来的实际值粘回去的
   * （那是本项目登记的第 6 种假阳性：期望值从被测对象自己推导出来）。
   */
  it("资产清单与显式快照一致——admin-ui/ 里多一个文件就是多一个公网端点", () => {
    expect(Object.keys(UI_ASSETS).sort()).toEqual([
      "/admin",
      "/admin/css/base.css",
      "/admin/css/sections.css",
      "/admin/css/shell.css",
      "/admin/js/api.js",
      "/admin/js/app.js",
      "/admin/js/boot.js",
      "/admin/js/i18n-dict.js",
      "/admin/js/i18n.js",
      // Task 6（P3b）新增：事件板块的取值决策（查询串拼装、分组、轮询退避等），
      // 同一条硬规则、同一份理由，由 tests/ui/events.test.ts 跑着。纯函数、无配置、无数据。
      "/admin/js/pure/events.mjs",
      "/admin/js/pure/format.mjs",
      // Task 4（P3c）新增：Key 池板块**写操作**的取值决策（按钮可用性、确认文案、
      // 批量选择边界、导入行拆分、bulk 结果汇总）。同一条硬规则、同一份理由，
      // 由 tests/ui/keys-write.test.ts 跑着。纯函数、无配置、无数据。
      // `-` 的字符码比 `.` 小，字典序排在 keys.mjs 之前。
      "/admin/js/pure/keys-write.mjs",
      // Task 4（P3b）新增：Key 池板块的取值决策。admin-ui/README.md 硬规则 1 要求
      // 需要测试的逻辑必须落在 js/pure/ 下，它由 tests/ui/keys.test.ts 跑着。
      // 逐条确认过：纯函数、无配置、无数据，公开可取没有问题。
      "/admin/js/pure/keys.mjs",
      // Task 5（P3b）新增：概览板块的取值决策，同一条硬规则、同一份理由，
      // 由 tests/ui/overview.test.ts 跑着。纯函数、无配置、无数据。
      "/admin/js/pure/overview.mjs",
      // Task 6（P3c）新增：注册机板块的取值决策（通道顺序与两条通道的标签/事实键、
      // 失败归因与拒绝原因的穷尽映射、补池历史的倒序与逐行归因、确认弹窗要明示的
      // 消耗、名额与冷却的成对时间字段）。同一条硬规则、同一份理由，由
      // tests/ui/registrar.test.ts 跑着。**逐条确认过：纯函数、无配置、无数据**
      // ——它一个字节的部署信息都不带（通道名 `moemail`/`yyds` 是本仓写死的两个
      // 枚举值，不是这套部署配了什么），公开可取没有问题。
      "/admin/js/pure/registrar.mjs",
      // Task 7（P3b）新增：会话绝对上限的判定（`sessionExpired`）。计划原本把它
      // 归给人工冒烟（理由是「碰 localStorage 与 Date」），执行时订正：把两个时刻
      // 都变成参数之后判定是纯函数，于是照硬规则 1 落在这里，由
      // tests/ui/session.test.ts 跑着。纯函数、无配置、无数据。
      // Task 7（P3b）评审必修 ④ 新增：口令字符集判定。它原本留在
      // `admin-ui/js/app.js` 里——那违反硬规则 1（纯函数必须落在 js/pure/），
      // 而直接后果是 `sendable-parity` 只能做源码文本比对、拦不住语义分叉。
      // 搬过来之后那条用例升级成了逐码位行为等价断言。纯函数、无配置、无数据。
      "/admin/js/pure/sendable.mjs",
      "/admin/js/pure/session.mjs",
      "/admin/js/pure/settings.mjs",
      // 全分支评审 C4 新增：浏览器存储键名的单一真源。原来两个凭据键的名字在
      // `js/app.js`（写入方）与 `js/api.js`（读取方）各声明一遍，改一处就能让面板
      // 登录成功之后每请求送空口令头、进登出循环，而全套用例照绿。
      // 只有六个字符串常量，纯文本、无配置、无数据，公开可取没有问题。
      "/admin/js/pure/storage-keys.mjs",
      "/admin/js/sec-events.js",
      "/admin/js/sec-keys.js",
      "/admin/js/sec-overview.js",
      // Task 6（P3c）新增：注册机板块本体（DOM 拼装 + 三条端点的网络调用）。
      // 与其余三个板块文件同一性质：**没有任何机密**，它拿到的每一个数字都来自
      // 一次鉴权后的接口调用，文件自身只有结构与 i18n 键。
      "/admin/js/sec-registrar.js",
      "/admin/js/sec-settings.js",
      "/admin/js/theme.js",
      "/admin/js/ui.js",
    ]);
  });

  /**
   * etag 必须是**内容**的哈希。
   *
   * 这一条单靠「互不相同 + 304 能工作」区分不出来：把 etag 改成路径的哈希，
   * 那两条照样绿、生成物也照样确定性（漂移门禁也绿），但**改了文件内容 etag 不变**
   * ⇒ 所有已缓存的浏览器永远收到 304，面板停在旧版本上，而且没有任何报错。
   */
  it("etag 是 body 的强 ETag（内容哈希），不是路径或构建时刻的哈希", () => {
    for (const [key, a] of Object.entries(UI_ASSETS)) {
      const expected = `"${createHash("sha256").update(a.body).digest("hex").slice(0, 16)}"`;
      expect(a.etag, `${key} 的 etag 不是 body 的内容哈希`).toBe(expected);
    }
  });

  it("每个资源的 etag 互不相同（内容不同的资源共用 etag 会让 304 返回错内容）", () => {
    const tags = Object.values(UI_ASSETS).map((a) => a.etag);
    expect(tags.length).toBeGreaterThan(1);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("UI_BUILD_HASH 是 16 位十六进制（不是时间戳/随机值，否则每次构建都会变）", () => {
    expect(UI_BUILD_HASH).toMatch(/^[0-9a-f]{16}$/);
  });

  /**
   * 键必须按字典序排列。守的**不是**「产物确定」——那条 `reverse()` 也满足
   *（已实测：把渲染那步的 `.sort()` 换成 `.reverse()`，产物照样确定，
   * 漂移门禁与逐字节断言全绿）——守的是**这份入仓生成物的 diff 保持可评审**。
   *
   * 它同 `.gitattributes` 里「不加 `-diff`」是同一件事的两半：这个文件会被直接
   * 部署，手工往里塞一段脚本正是最该被评审看见的改动。排序一旦翻转，整份文件在
   * diff 里全变，真正的那一行就淹掉了。
   */
  it("键按字典序排列——排序翻转会让整份生成物在 diff 里全变，真改动就淹了", () => {
    const keys = Object.keys(UI_ASSETS);
    expect(keys).toEqual([...keys].sort());
  });
});

/**
 * 漂移门禁。**这条不能只靠「记得跑 pnpm ui:build」的约定**：
 * 生成物入仓，有人改了 admin-ui/ 忘了重跑生成器，仓库里就是一份陈旧的界面而 CI 全绿。
 *
 * 上面那组「逐字节相同」只守 body；type / etag / 排序 / 文件头注释 / UI_BUILD_HASH
 * 全在它的视野之外。这里改为**重新生成一遍再整文件比对**，覆盖生成物的每一个字节，
 * 且不复制生成器里的任何公式（比对的是两份产物，不是两份实现）。
 */
describe("生成物没有和源漂移", () => {
  it("重新生成一遍，与仓库里那份逐字节相同", () => {
    const dir = mkdtempSync(join(tmpdir(), "agnes-ui-"));
    try {
      const out = join(dir, "assets.generated.ts");
      // cwd 刻意设成别处：生成器必须按自身位置解析 admin-ui/，否则 CI、
      // git hook、编辑器任务这些从别的目录发起的调用会生成一份空的/报错的产物。
      execFileSync(process.execPath, [GENERATOR, out], { cwd: dir, stdio: "pipe" });
      expect(readFileSync(out, "utf8")).toBe(readFileSync(GENERATED, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("生成器的硬规则", () => {
  it("零二进制资源——保证生成器是纯文本拼接，也让 CSP 能收得很紧", () => {
    const bad = walk(SRC_DIR).filter((p) => /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i.test(p));
    expect(bad).toEqual([]);
  });

  /**
   * ⚠️ 这里**刻意不再复述生成器的那几条正则**。
   *
   * 原先这一组把 `/\bsrc=/`、`/^\s*import\s/m`、`/\bdocument\b/` 原样抄了一遍，
   * 于是期望侧与实际侧**共享同一个盲区，永远不可能不一致**——`\b` 在 `data-src=`
   * 的 `-` 与 `s` 之间是成立的，`<script data-src="x">alert(1)</script>` 同时骗过
   * 生成器和这条测试（已复现：EXIT=0 且 payload 入包）。这是第 6 种假阳性的新形态。
   *
   * 「当前的源合规」由漂移门禁隐含保证（生成器一旦拒绝当前源就 exit 1，
   * 那条重跑生成器的用例会直接抛）。「生成器拦得住违规」由下面那组**真的跑一遍
   * 生成器**的用例保证。两件事都不需要在这里复制一份正则。
   */
  it("文案里不出现「数字IP:端口」——scan-secrets.sh 的第五条正则会把 CI 打红", () => {
    const all = walk(SRC_DIR);
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) {
      expect(readFileSync(p, "utf8"), p)
        .not.toMatch(/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}:[0-9]{2,5}/);
    }
  });

  it("体积预算：原始总字节 < 1 MiB", () => {
    const total = Object.values(UI_ASSETS).reduce((n, a) => n + Buffer.byteLength(a.body, "utf8"), 0);
    expect(total).toBeLessThan(1024 * 1024);
  });
});

/**
 * 违规输入必须让生成器 `exit 1`。**不是形状断言**：把源文件复制到临时目录、注入一处
 * 违规、再真的跑一遍生成器，看它退不退出 1。
 *
 * 不这么做的话，「生成器会拦」这句话在四条规则上全是空口白话——上面那些静态断言
 * 只证明**当前的源**合规，完全不证明**生成器**拦得住新的违规。
 */
describe("生成器对违规输入 exit 1", () => {
  /** 把 admin-ui/ 与生成器复制到临时目录（保持相对位置），改一处，跑一遍。 */
  function runWithMutation(mutate: (adminUi: string) => void): { code: number; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), "agnes-ui-mut-"));
    try {
      cpSync(SRC_DIR, join(dir, "admin-ui"), { recursive: true });
      mkdirSync(join(dir, "scripts"), { recursive: true });
      cpSync(GENERATOR, join(dir, "scripts", "build-ui.mjs"));
      mutate(join(dir, "admin-ui"));
      try {
        execFileSync(process.execPath, [join(dir, "scripts", "build-ui.mjs"), join(dir, "out.ts")], {
          cwd: dir, stdio: "pipe",
        });
        return { code: 0, stderr: "" };
      } catch (e) {
        const err = e as { status?: number; stderr?: Buffer };
        return { code: err.status ?? -1, stderr: String(err.stderr ?? "") };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const append = (p: string, text: string) => appendFileSync(p, text, "utf8");

  it("未改动的副本能正常生成（前置条件：夹具本身是好的，下面的红不是复制坏了）", () => {
    expect(runWithMutation(() => {})).toEqual({ code: 0, stderr: "" });
  });

  it("js/pure 下出现 import ⇒ exit 1", () => {
    const r = runWithMutation((ui) => append(join(ui, "js/pure/session.mjs"), '\nimport x from "./y.mjs";\n'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("import");
  });

  it("js/pure 下碰 DOM 全局 ⇒ exit 1", () => {
    const r = runWithMutation((ui) => append(join(ui, "js/pure/session.mjs"), "\nexport const q = document.title;\n"));
    expect(r.code).toBe(1);
  });

  it("js/pure 下碰 window 全局 ⇒ exit 1", () => {
    const r = runWithMutation((ui) => append(join(ui, "js/pure/session.mjs"), "\nexport const w = window.name;\n"));
    expect(r.code).toBe(1);
  });

  it("index.html 里出现内联脚本 ⇒ exit 1", () => {
    const r = runWithMutation((ui) => append(join(ui, "index.html"), "\n<script>alert(1)</script>\n"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("内联脚本");
  });

  /**
   * `data-src=` / `x-src=` 这类**假 src** 必须照样被拦。
   * 判据写成 `/\bsrc=/` 时它们能骗过门禁（`\b` 在 `-` 与 `s` 之间成立），
   * **而浏览器只在真的有 `src` 属性时才忽略内联体** ⇒ payload 照常执行。
   */
  it.each(["data-src", "x-src", "SRC-fake", "datasrc"])(
    "用假属性 %s= 伪装成外链脚本 ⇒ 仍然 exit 1",
    (attr) => {
      const r = runWithMutation((ui) =>
        append(join(ui, "index.html"), `\n<script ${attr}="x">alert(1)</script>\n`));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("内联脚本");
    },
  );

  /**
   * **HTML 分词器认得的写法，门禁也必须认得。**
   *
   * 上一版的外层正则是 `/<script\b…<\/script>/g`：没有 `i`、结束标签写死成字面量
   * `</script>`。而分词器在 `</script` 之后遇到空白 / `/` / `>` 都判定为结束标签，
   * 标签名本身也大小写不敏感。任何一处不匹配 ⇒ 整个块根本不进循环 ⇒ **exit 0 且
   * payload 入包**（五种写法逐个实测过，在浏览器里全部会执行）。
   *
   * 上一版的夹具全是「小写 `<script` + 标准 `</script>`」，另一组「不许误伤」倒是
   * 覆盖了大写**属性**——正是这个不对称暴露了盲区：被测的维度（标签名大小写、
   * 结束标签形态）在夹具里根本不出现。
   */
  it.each([
    ["大写标签名", "<SCRIPT>alert(1)</SCRIPT>"],
    ["混合大小写标签名", "<Script>alert(1)</Script>"],
    ["结束标签带空格", "<script>alert(1)</script >"],
    ["结束标签带换行", "<script>alert(1)</script\n>"],
    ["结束标签自闭合斜杠", "<script>alert(1)</script/>"],
  ])("HTML 合法但非标准的写法照样被拦，且诊断成「内联脚本」：%s", (_name, tag) => {
    const r = runWithMutation((ui) => append(join(ui, "index.html"), `\n${tag}\n`));
    expect(r.code, `${tag}\n${r.stderr}`).toBe(1);
    // **必须断言原因。** 只断言 exit 1 的话，把正则退回「无 `i` + 结束标签写死」
    // 这条变异**照样绿**——下面那道计数守卫会把它们当成「解析不出来的 <script>」
    // 兜住。两道防线合起来确实拦得住，但那样这一组用例守的就不是它自称守的那件事了。
    // 判据钉在「解析器认得它，并认出里面是内联体」上，退回旧正则时这里报的是
    // 「拒绝生成」而不是「内联脚本」，立刻变红。
    expect(r.stderr, tag).toContain("内联脚本");
  });

  /**
   * **计数守卫：解析不了的 `<script` 一律硬失败。**
   *
   * 上面那条链的要害不是「哪几种写法漏了」——列举永远列不全，下一种照样静默放过。
   * 要害是**「没匹配上」被当成「没问题」**。所以门禁的默认答案必须是「拒绝生成」：
   * 数一遍 `<script` 开标签，与真正解析出来的块数对不上就 exit 1。
   *
   * 夹具用一个**根本没有结束标签**的开标签：它匹配不上任何一种结束形态，
   * 因此只有计数守卫拦得住它。放宽正则那一步救不了这一条。
   */
  it("有 <script 开标签却解析不出脚本块 ⇒ exit 1（不是静默放过）", () => {
    const r = runWithMutation((ui) => append(join(ui, "index.html"), "\n<script>alert(1)\n"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("拒绝生成");
  });

  /**
   * 反方向：真的带 `src` 的外链脚本**不许误伤**。
   *
   * ⚠️ 每个夹具的 `<script>` 体**必须非空**。第一版全写成 `<script src="x"></script>`
   * 空体，而判定是 `!hasSrc && body.trim().length > 0` ——空体那半边先短路，
   * **`src` 认没认出来根本不可观测**，于是把判据收紧成 `/^ src=/`（漏掉大小写与
   * 空格形态）时这条照样绿。这正是本项目第 5 种假阳性：被测的那个选择，
   * 在测试覆盖的状态下看不见。
   */
  it.each([
    ['小写紧贴', '<script src="/admin/js/x.js">ignored</script>'],
    ['大写 SRC（HTML 属性名大小写不敏感）', '<script SRC="/admin/js/x.js">ignored</script>'],
    ['等号两侧带空格', '<script type="module" src = "/admin/js/x.js">ignored</script>'],
    ['属性换行', '<script\n  src="/admin/js/x.js">ignored</script>'],
    // 下面两格是**放宽正则**买到的东西：判据严回去时它们会被计数守卫误杀成 exit 1。
    ['大写标签名', '<SCRIPT src="/admin/js/x.js">ignored</SCRIPT>'],
    ['结束标签带空格', '<script src="/admin/js/x.js">ignored</script >'],
  ])("真的带 src 的外链脚本不误伤：%s", (_name, tag) => {
    const r = runWithMutation((ui) => append(join(ui, "index.html"), `\n${tag}\n`));
    expect(r.code, `${tag}\n${r.stderr}`).toBe(0);
  });

  /**
   * **M5 的第四类绕过：`src=` 藏在引号包裹的属性值内部。**
   *
   *   <script data-x="foo src=bar">payload</script>
   *
   * `/(^|\s)src\s*=/i` 在整个属性串上找 `src=`，而这里的 `src=` 出现在**属性值
   * 内部**（被 `"..."` 包着）——浏览器只认真正的 `src` 属性，会执行 payload，
   * 门禁却因为正则看到了 `src=` 就把它归类成外链脚本放行（评审实测 exit 0 + payload
   * 入包）。修法是先把引号包裹的属性值抠掉再判 `src` 的位置。
   *
   * **必须断言原因，不是只断言 exit 1**：只断言 exit 1 的话，把判据改回「看到 src=
   * 就放行」这个旧版本在这四格上依旧是 exit 0（旧版本本身就会放行），但如果换一种
   * 退化——比如让 `stripQuoted` 变成误伤一切从而 exit 1——诊断信息不对时这条测试
   * 也该能分辨出来（诊断必须是「禁止内联脚本」，不是别的失败原因）。
   */
  it.each([
    ["属性值里藏 src=", '<script data-x="foo src=bar">alert(1)</script>'],
    ["单引号属性值里藏 src=", "<script data-x='foo src=bar'>alert(1)</script>"],
    ["大写标签名 + 属性值里藏 src=", '<SCRIPT DATA-X="src=bar">alert(1)</SCRIPT>'],
    ["属性值里藏 src= 且结束标签放宽", '<script data-x="src=bar">alert(1)</script >'],
  ])("引号包裹的属性值里藏 src= 仍然拦得住：%s", (_name, tag) => {
    const r = runWithMutation((ui) => append(join(ui, "index.html"), `\n${tag}\n`));
    expect(r.code, `${tag}\n${r.stderr}`).toBe(1);
    expect(r.stderr, tag).toContain("内联脚本");
  });

  /**
   * 反方向：**这两格才是「抠掉引号」单独买到的东西**——真外链脚本即便带着别的
   * 引号属性也不许被误伤。判据严回去（不抠引号）时它们照样是 exit 0，所以这组
   * 本身不区分新旧判据；真正区分新旧判据的是上面那组 BYPASS 用例。这两格防的是
   * 「抠引号」这个修法本身矫枉过正——比如把 `stripQuoted` 写成整串清空。
   */
  it.each([
    ["普通外链", '<script src="/admin/js/app.js"></script>'],
    ["外链 + 别的带引号属性", '<script type="module" src="/admin/js/app.js"></script>'],
  ])("真外链脚本不因为带别的引号属性被误伤：%s", (_name, tag) => {
    const r = runWithMutation((ui) => append(join(ui, "index.html"), `\n${tag}\n`));
    expect(r.code, `${tag}\n${r.stderr}`).toBe(0);
  });

  /**
   * 独立 `.svg` 会以 `image/svg+xml` 挂出去，**直接导航过去就是一个同源文档**，
   * 里面的 `<script>` 会执行——而脚本校验只对 `.html` 生效。扩展名白名单里
   * 因此没有 `.svg`（与 README「图标一律内联 SVG」一致），这条守着它别被加回来。
   */
  it("独立 .svg ⇒ exit 1（它是能执行脚本的同源文档，不是图片）", () => {
    const r = runWithMutation((ui) =>
      writeFileSync(join(ui, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(".svg");
  });

  it("出现「数字IP:端口」形态 ⇒ exit 1", () => {
    // 字面量拼出来，免得这个测试文件自己被 scan-secrets.sh 打红。
    const ipPort = `${[10, 0, 0, 1].join(".")}:${8080}`;
    const r = runWithMutation((ui) => append(join(ui, "css/base.css"), `\n/* ${ipPort} */\n`));
    expect(r.code).toBe(1);
  });

  it("放进二进制资源 ⇒ exit 1", () => {
    const r = runWithMutation((ui) => writeFileSync(join(ui, "logo.png"), "x"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(".png");
  });
});

/**
 * ⚠️⚠️ **本仓在 CSS 上栽过一次，而那次「没有护栏」是我自己登记的、且登记得过头。**
 *
 * P3c Task 7 的真机冒烟量到：`.card + .card { margin-top: … }` 是给**竖排卡**用的，
 * 而 `.card-row` 是 flex 行 ⇒ 第二张及以后的卡拿到一个上边距，被拉伸后**矮 8px、
 * 整体下沉 8px**（实测 moemail 367px/top 2766，yyds 359px/top 2774）。
 * 两张「完全对称」的通道卡因此不等高、不对齐——**而面板在视觉上暗示一个层级，
 * 正是硬约束「两条邮箱通道完全平级」存在的全部理由**。这条缺陷从 P3b 就已上线。
 *
 * 我当时把它登记成「CSS 层零自动化护栏（假 DOM 不做布局），修法只写进注释」。
 * **那个登记过头了**：布局正确性确实验不了（真），但**「这条修法还在不在」是纯文本
 * 就能钉住的**（假）——本文件早就有读 CSS 源文件的先例。两句话必须分开说。
 *
 * ⇒ 下面这一格守的是**后者**：删掉那条规则立刻红。
 * **它不保证布局是对的**，只保证「有人把这条修法删掉时会被拦下」。
 */
describe("CSS：横排卡片行里不许继承竖排卡的上边距", () => {
  const css = () => readFileSync("admin-ui/css/sections.css", "utf8");

  it("`.card-row > .card + .card` 的 margin-top 归零这条规则还在", () => {
    const src = css().replace(/\/\*[\s\S]*?\*\//g, "");
    // 判据：存在一条把 `.card-row` 里相邻卡的 `margin-top` 置零的规则。
    const rule = /\.card-row\s*>\s*\.card\s*\+\s*\.card\s*\{[^}]*margin-top:\s*0[^}]*\}/;
    expect(
      rule.test(src),
      "`.card-row > .card + .card { margin-top: 0 }` 没了 —— 两张通道卡会重新变成"
      + "不等高、不对齐，而那是硬约束「两条通道完全平级」在视觉层的破口（P3b 上线过一次）",
    ).toBe(true);
  });

  it("反向自检：竖排那条规则确实存在（否则上面那条归零是在归一个空气）", () => {
    const src = css().replace(/\/\*[\s\S]*?\*\//g, "");
    expect(/\.card\s*\+\s*\.card\s*\{[^}]*margin-top:\s*var\(--gap-sm\)/.test(src)).toBe(true);
  });

  /**
   * **边界写成会变红的探针，而不是一句散文——更不是断言用例自己刚定义的字面量。**
   *
   * ⚠️ 第一版这里是 `expect(BLIND_SPOTS.length).toBeGreaterThan(0)`，
   * 而 `BLIND_SPOTS` 就在上一行由用例自己定义 ⇒ **被测代码怎么改都不会红**，
   * 它是一段穿了用例外衣的散文，还白占一格绿数（评审 LOW）。
   * 做法改成抄 `tests/unit/source-guards.test.ts` 的
   * 「已知抓不住的写法确实抓不住（边界是断言，不是散文）」那一族：
   * **每一条盲点都给一份探针，断言这道扫描确实抓不住它**。
   * 哪天有人把某个盲点补上了，对应那格会红——提醒他把这一条删掉。
   */
  /**
   * 每一条盲点都给一份探针，**断言这道扫描对它给出的那个（错的）答案**。
   * 哪天有人把某个盲点补上了，对应那格会红——提醒他把这一条删掉。
   */
  it.each([
    [
      "被后面更具体的选择器覆盖：规则在，但层叠结果被推翻，扫描照样说「在」",
      ".card-row > .card + .card { margin-top: 0; }\n.channel-card + .channel-card { margin-top: 8px; }",
      true,
    ],
    [
      "语义等价但写法不同（margin: 0）：布局其实是对的，扫描却说「不在」",
      ".card-row > .card + .card { margin: 0; }",
      false,
    ],
  ])("已知盲点：「%s」", (_why, css, scanSays) => {
    const rule = /\.card-row\s*>\s*\.card\s*\+\s*\.card\s*\{[^}]*margin-top:\s*0[^}]*\}/;
    expect(
      rule.test(css),
      "这道扫描对这份 CSS 的判断变了 —— 说明盲点被补上了（好事），"
      + "请把这一行连同上面的边界说明一起删掉",
    ).toBe(scanSays);
  });
});
