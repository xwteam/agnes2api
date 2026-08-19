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
   * 生成器不转译、不打包、不压缩，产物字节与源文件逐字节相同，因此 admin-ui/index.html
   * 用浏览器直接打开仍然是一个完整可调试的面板——它是投递方式，不是构建管线。
   * 这句话必须由断言钉死，不能靠自觉。
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
   * **资产清单是显式快照，加一个文件就必须在这里表态。**
   *
   * 丢进 `admin-ui/` 的任何东西都会变成一条**免鉴权的公网端点**——白名单里有
   * `.json`，将来谁放一个 `config.json` 或一份调试笔记进去，它就静默地公开可取，
   * 而唯一的网只有 scan-secrets 那 5 条正则。这是公开 MIT 仓、卖点是「裸克隆即
   * deploy」，趁资产集合只有 5 个文件时钉住成本最低。
   *
   * 上面那条只保证「生成物 == 源目录」，两边一起长的时候它不会红；这条才拦得住。
   */
  it("资产清单与显式快照一致——admin-ui/ 里多一个文件就是多一个公网端点", () => {
    expect(Object.keys(UI_ASSETS).sort()).toEqual([
      "/admin",
      "/admin/css/base.css",
      "/admin/js/app.js",
      "/admin/js/boot.js",
      "/admin/js/pure/mask.mjs",
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
    const r = runWithMutation((ui) => append(join(ui, "js/pure/mask.mjs"), '\nimport x from "./y.mjs";\n'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("import");
  });

  it("js/pure 下碰 DOM 全局 ⇒ exit 1", () => {
    const r = runWithMutation((ui) => append(join(ui, "js/pure/mask.mjs"), "\nexport const q = document.title;\n"));
    expect(r.code).toBe(1);
  });

  it("js/pure 下碰 window 全局 ⇒ exit 1", () => {
    const r = runWithMutation((ui) => append(join(ui, "js/pure/mask.mjs"), "\nexport const w = window.name;\n"));
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
  ])("真的带 src 的外链脚本不误伤：%s", (_name, tag) => {
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
