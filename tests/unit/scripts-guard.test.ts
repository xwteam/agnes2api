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

/**
 * Task 8 复验登记的缺口：占位符门禁只查 id，不查 binding 名——把 `[[kv_namespaces]]`
 * 的 `binding = "POOL"` 改成别的名字，占位符检查照样通过，契约测试的 miniflare
 * `kvNamespaces: ["POOL"]` 也不读 wrangler.toml 所以照样通过，唯独真机部署时
 * `env.POOL`（`src/entry/worker.ts`）会是 `undefined`，运行时才炸。
 * 这里做真变异（改坏 binding 名喂给脚本），不是只读代码。
 */
describe("wrangler.toml 的 KV binding 名必须与代码期望的 env.POOL 一致", () => {
  it("当前仓库的 binding 是 \"POOL\"，与 src/entry/worker.ts 的 env.POOL 一致", () => {
    execFileSync("node", ["scripts/check-wrangler-placeholder.mjs"], { stdio: "pipe" });
  });

  it("binding 被改名后门禁 exit 1，而不是静默放行", () => {
    const renamed = readFileSync("wrangler.toml", "utf8")
      .replace('binding = "POOL"', 'binding = "KV_POOL"');
    expect(() => execFileSync("node", ["scripts/check-wrangler-placeholder.mjs"], {
      input: renamed, env: { ...process.env, WRANGLER_TOML_FROM_STDIN: "1" }, stdio: "pipe",
    })).toThrow();
  });

  it("缺少 binding 声明时也 exit 1（不是把 undefined 当成通过）", () => {
    const stripped = readFileSync("wrangler.toml", "utf8")
      .replace(/^\s*binding\s*=\s*"POOL"\s*$/m, "");
    expect(() => execFileSync("node", ["scripts/check-wrangler-placeholder.mjs"], {
      input: stripped, env: { ...process.env, WRANGLER_TOML_FROM_STDIN: "1" }, stdio: "pipe",
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
 * @refs-ignore（本段的 `tests/foo.test.ts` 是举例说明「带了过滤器」长什么样，不是真实指向）
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
 * **评审 F3 新增的第 11 道门禁**：`src/`/`tests/`/`admin-ui/`/`scripts/`/`docs/`
 * 下不许存在被 git 判为二进制的跟踪文件，理由与起因见
 * `scripts/check-no-binary.mjs` 文件头。这里只钉"CI 里确实跑了这一步"（与下面
 * "pnpm build 在门禁列表里"那条同一个模式），脚本自身的正确性由
 * `tests/unit/check-no-binary.test.ts` 的「空仓库（没有任何跟踪文件）：通过」一组单独验证。
 */
describe("check-no-binary 在 CI 门禁列表里", () => {
  it("ci.yml 里有一步跑 node scripts/check-no-binary.mjs", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toMatch(/run:\s*node scripts\/check-no-binary\.mjs\s*$/m);
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

/**
 * CI 步骤编号。**它不是装饰**：门禁靠人一眼数得清「跑了几道」来发现「少跑了一道」，
 * 而少跑一道的形态恰恰是静默的（那一步被删掉之后没有任何东西会红）。
 * 期望值是**手写字面量**，不是从 yml 里数出来再回填。
 */
it("CI 恰好十二道门，编号 1/12 到 12/12 各出现一次", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  for (let i = 1; i <= 12; i++) {
    const n = ci.split(`name: ${i}/12 `).length - 1;
    expect(n, `编号 ${i}/12 出现了 ${n} 次`).toBe(1);
  }
  // 反向：不许还剩下旧编号（评审 F3 从十道扩到十一道；全分支评审 B2 又插入
  // check-comment-refs 作第 8 道，原来的 8/11..11/11 全部跟着挪一位）。
  expect(ci, "还有步骤写着 N/10").not.toMatch(/name: \d+\/10 /);
  expect(ci, "还有步骤写着 N/11").not.toMatch(/name: \d+\/11 /);
});

/**
 * **第 12 道门禁（全分支评审 B2）在 CI 里**：注释里写「这条由某某用例钉着」时，
 * 那个指向必须解析得开。与上面 `check-no-binary` 那条同一个模式——这里只钉
 * 「CI 里确实跑了这一步」，脚本自身的正确性由
 * `tests/unit/check-comment-refs.test.ts` 的「干净的树：exit 0」一带单独验证。
 */
describe("check-comment-refs 在 CI 门禁列表里", () => {
  it("ci.yml 里有一步跑 node scripts/check-comment-refs.mjs", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toMatch(/run:\s*node scripts\/check-comment-refs\.mjs\s*$/m);
  });
});

/**
 * CI 第 10/12、11/12 两步的退出码**全靠 `shell: bash` 提供的 pipefail**：
 * 它们是 `pnpm test 2>&1 | tee ... ; grep ...`，没有 pipefail 时管道的退出码取最后一条命令，
 * **测试失败会被 tee/grep 的成功退出码吃掉，CI 全绿**。
 * 上面那组断言了这两步的裸命令、grep 次数、pnpm build——**唯独没断言它**。
 * 今天它在位（P3a Task 8 评审核过），所以这是「护栏的护栏」，不是现存缺陷。
 */
it("跑测试的两步显式声明 shell: bash（pipefail 的唯一来源）", () => {
  const yml = readFileSync(".github/workflows/ci.yml", "utf8");
  // 期望值手写字面量：断言这两步各自的 name 与**下一个 `- name:`（或文件末尾）
  // 之间**出现 `shell: bash`。
  //
  // ⚠️ **不能用固定长度的窗口**——已实测踩过：切成 400 字符的窗口会越界吃到
  // 紧挨着的下一步。把 8/10 那一行 `shell: bash` 真的删掉后，这条断言当时依旧
  // 全绿，因为窗口滑进了 9/10 自己的 `shell: bash`，「变异点与被守护的不变量」
  // 没对齐。判据必须锚在**这一步自己的 YAML 块**，用下一个 `- name:` 当右边界，
  // 而不是一个跟内容脱钩的字符数。
  for (const name of ["10/12 单元 / 契约 / 前端纯函数测试（Node 运行时）", "11/12 契约测试（workerd 运行时）"]) {
    const i = yml.indexOf(`name: ${name}`);
    expect(i, `找不到步骤 ${name}`).toBeGreaterThan(0);
    const nextStep = yml.indexOf("\n      - name:", i);
    const chunk = yml.slice(i, nextStep === -1 ? yml.length : nextStep);
    expect(chunk, `${name} 缺 shell: bash，管道里的失败会被 tee/grep 吃掉`).toContain("shell: bash");
  }
});
