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

  it("js/pure 下禁止 import、禁止碰浏览器全局——保证 vitest 里 import 一定不炸", () => {
    const pure = walk(join(SRC_DIR, "js", "pure"));
    expect(pure.length, "js/pure 空了，下面的循环一格不跑").toBeGreaterThan(0);
    for (const p of pure) {
      const src = readFileSync(p, "utf8");
      expect(src, `${p} 不许有 import`).not.toMatch(/^\s*import\s/m);
      // 校验是纯文本匹配（生成器不解析注释），所以这几个词连注释里都不许出现。
      // 规则全文在 admin-ui/README.md，那里不受这条约束。
      expect(src, `${p} 不许出现 DOM 全局`).not.toMatch(/\bdocument\b/);
      expect(src, `${p} 不许出现浏览器窗口全局`).not.toMatch(/\bwindow\b/);
    }
  });

  it("零内联脚本——CSP 的 script-src 'self' 要求的", () => {
    const html = readFileSync(join(SRC_DIR, "index.html"), "utf8");
    // <script src=...></script> 允许；<script>…代码…</script> 不允许。
    const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
      .filter(([, attrs, body]) => !/\bsrc=/.test(attrs!) && body!.trim().length > 0);
    expect(inline).toEqual([]);
  });

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

  it("index.html 里出现内联脚本 ⇒ exit 1", () => {
    const r = runWithMutation((ui) => append(join(ui, "index.html"), "\n<script>alert(1)</script>\n"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("内联脚本");
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
