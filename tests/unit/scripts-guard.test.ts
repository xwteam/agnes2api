import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const PLACEHOLDER = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID";

describe("wrangler.toml 的 KV id 必须仍是占位符", () => {
  it("仓库里那份是占位符——真实 id 提交进公开仓等于泄漏部署细节", () => {
    expect(readFileSync("wrangler.toml", "utf8")).toContain(PLACEHOLDER);
  });

  it("门禁脚本本身在占位符被替换成真实 id 时会 exit 1", () => {
    // 把真实形态（32 位 hex）喂给它，断言它真的拒绝。
    // 只跑「当前仓库通过」是形状断言：脚本改成 `exit 0` 也会绿。
    const fake = readFileSync("wrangler.toml", "utf8")
      .replace(PLACEHOLDER, "0123456789abcdef0123456789abcdef");
    expect(() => execFileSync("node", ["scripts/check-wrangler-placeholder.mjs"], {
      input: fake, env: { ...process.env, WRANGLER_TOML_FROM_STDIN: "1" }, stdio: "pipe",
    })).toThrow();
  });
});

describe("体积预算门禁", () => {
  it("当前资源在预算内", () => {
    execFileSync("node", ["scripts/check-ui-budget.mjs"], { stdio: "pipe" });
  });

  it("把预算调到 0 时会 exit 1——证明它真的在比，而不是无条件 exit 0", () => {
    expect(() => execFileSync("node", ["scripts/check-ui-budget.mjs"], {
      env: { ...process.env, UI_MAX_RAW_BYTES: "0" }, stdio: "pipe",
    })).toThrow();
  });
});

describe("tests/ui 真的被 vitest 收集了", () => {
  it("vitest.config.ts 的 include 覆盖 tests/ui/——漏了它前端纯函数测试会静默消失", () => {
    expect(readFileSync("vitest.config.ts", "utf8")).toContain("tests/ui/");
  });
});

/**
 * CI 门禁的前提：`pnpm test` / `pnpm test:workers` 必须是**裸命令**，不带任何文件路径
 * 过滤器（如 `pnpm test tests/foo.test.ts`）。
 *
 * tests/global-setup.ts 里的收集门禁按「本次调用带没带显式文件过滤器」分档——带了就
 * 跳过，理由是单文件调试不该多背 5 秒摩擦。这个分档本身没问题，**但它依赖一个前提：
 * CI 跑的是全量、不带过滤器**。前提一旦被打破（比如为了分片把 CI 命令改成按文件名
 * 过滤），门禁在 CI 上就完全不生效，而且**不会有任何红色信号**——退出码照样是 0。
 *
 * 下面两组断言各自独立钉住这个前提的两半：
 * · package.json 里 `test` / `test:workers` 脚本本身不能预置过滤器；
 * · .github/workflows/ci.yml 调用它们时不能追加过滤器参数。
 * 两个期望值都是手写字面量，不是从被测文件里读出来再回填——避免第 6 种假阳性
 * （断言的期望值从被测对象自己推导出来，等于同义反复）。
 */
describe("CI 的测试命令不带文件过滤器（收集门禁分档的前提）", () => {
  it("package.json 的 test / test:workers 脚本是裸的 `vitest run --config ...`", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.test).toBe("vitest run --config vitest.config.ts");
    expect(pkg.scripts["test:workers"]).toBe("vitest run --config vitest.workers.config.ts");
  });

  it("ci.yml 用裸命令调用它们，没有追加任何文件路径过滤器", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain("pnpm test 2>&1");
    expect(ci).toContain("pnpm test:workers 2>&1");
  });

  /**
   * 光「命令是裸的」还不够——分档逻辑本身也可能因为别的原因（比如 vitest 升级后
   * `filenamePattern` 字段改名）而静默失效。CI 因此不能只信任退出码，还要 grep
   * 收集门禁自己打的成功横幅 `[collection-guard] ✅`（见 tests/global-setup.ts 文件尾）：
   * 横幅缺失就说明门禁没跑，即使测试全绿也要让那一步失败。
   * 这条断言钉住 ci.yml 里确实接了这个 grep，而不是只跑了 `pnpm test` 就完事。
   */
  it("ci.yml 会 grep 收集门禁的成功横幅，两个测试入口（node / workerd）各一次", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    // 数的是**真正执行的 grep 调用**，不是横幅字样在注释/echo 里出现的次数——
    // 那些文本提及不构成校验，混进计数会让这条断言对「删掉其中一次 grep」不敏感。
    const grepCalls = ci.match(/grep -qF '\[collection-guard\] ✅'/g) ?? [];
    expect(grepCalls.length).toBe(2);
  });
});

/**
 * `pnpm build` 必须在 CI 门禁里——它此前不在（现状：CI 只有 5 道，没有 build），
 * 与本地跑的六道门禁不一致，属于这个任务存在的理由之一。
 */
describe("pnpm build 在 CI 门禁列表里", () => {
  it("ci.yml 里有一步跑 `pnpm build`", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toMatch(/run:\s*pnpm build\s*$/m);
  });
});
