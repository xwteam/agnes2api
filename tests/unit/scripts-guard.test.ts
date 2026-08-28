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
 * **评审 F3 新增的那道门禁**（`scripts/check-no-binary.mjs`）：`src/`/`tests/`/`admin-ui/`/`scripts/`/`docs/`
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
 * ── i18n 门禁在 CI 上是**自己一步**（P3e Task 15 复评的配套）──────────────────
 *
 * `scripts/check-i18n.mjs` 与 `tests/unit/i18n-dict.test.ts` 是**故意的两份独立实现**，
 * 两边的文件头都写着这件事。上一版那句话是靠**序号**说的（「CI 第 N 道跑这个脚本、
 * 第 M 道跑那份测试」），序号被删掉之后一度改写成了同义反复
 * （「CI 里跑这个脚本那一步跑本脚本」）——**信息量为零，而且照样没人守**。
 *
 * 现在两边改写成「本脚本在 CI 上是单独一步、那份测试跟着 `pnpm test` 跑」，
 * 这一格就是那句话的测法：**合成一步的话，`pnpm test` 里任何一格红都会把
 * i18n 门禁自己的红盖过去**，而两份独立实现的全部价值就在于两个信号分得开。
 */
describe("check-i18n 在 CI 门禁列表里，且是自己一步", () => {
  it("ci.yml 里有一步跑 node scripts/check-i18n.mjs", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toMatch(/run:\s*node scripts\/check-i18n\.mjs\s*$/m);
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
 * ── 历史凭据扫描进了 CI，而它的前提也必须在场 ────────────────────────────────
 *
 * `scripts/scan-secrets.sh` 的历史那一档（`--history`）扫的是**可达对象**，而
 * `actions/checkout` 默认拉的是浅仓；那一档在浅仓上**按失败处理**（fail closed，
 * 不是静默放行）。于是这两件事只做一件都等于没做：
 * · 只加 `--history`、不给 checkout 全克隆 ⇒ CI 天天红在「拿不到全部历史」上；
 * · 只给 checkout 全克隆、不加 `--history` ⇒ 白拉一个全克隆，历史一个对象都没扫过。
 * 两个方向都是「装了一半」，所以两条断言写在同一格里。
 *
 * ⚠️ **下面第二格不是重复第一格**：第一格对**整个文件**做 `toContain`，
 * 而这个文件里有 `#` 注释——**注释里提一句就能把它喂饱**。本仓踩过同形的坑
 *（`tests/unit/check-comment-refs.test.ts` 那格夹具：第二层替第一层挡住了变异）。
 * 所以第二格先把 `#` 注释行剥掉，再把判据锚到**那一步自己的 YAML 块**里。
 * 这不是假想：本轮实测把凭据扫描那一步的第二条命令换成一行提到它的 `#` 注释，
 * **第一格照样绿，只有第二格红**。
 */
describe("历史凭据扫描进了 CI，且它的前提也在场", () => {
  it("ci.yml 里 fetch-depth: 0 与 scan-secrets.sh --history 必须同时在场 —— 少一个另一个就没用", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci, "缺 fetch-depth: 0 ⇒ 浅仓上 --history 会 fail closed（不是静默放行）").toContain("fetch-depth: 0");
    expect(ci, "缺 --history ⇒ 历史扫描没进 CI").toContain("scan-secrets.sh --history");
  });

  it("两者都长在各自那一步的 YAML 块里，不是只在 # 注释里被提过一句", () => {
    const yml = readFileSync(".github/workflows/ci.yml", "utf8");
    const stripHashComments = (s: string) =>
      s.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

    // **反向控制：剥注释这一步必须真的剥掉内容。** 它要是个 no-op（或者写成了只删空行），
    // 下面三条就退化成上面那一格的同义反复，而「注释里写一句就算数」那个洞会原样留着。
    // 锚的是 checkout 那一步注释里**实有的一句话**——那句话被改写时这一格会红，
    // 那是提醒不是事故：它同时也钉住「那一行为什么必须在」的说明没被人顺手删掉。
    const CHECKOUT_NOTE = "删了它历史扫描会 fail closed";
    expect(yml, "checkout 那一步的注释没了：它是那一行为什么必须在的唯一说明").toContain(CHECKOUT_NOTE);
    expect(
      stripHashComments(yml),
      "剥 # 注释这一步是个 no-op，下面三条等于白写",
    ).not.toContain(CHECKOUT_NOTE);

    // 期望值都是手写字面量。右边界用「下一个同缩进的 `- `」，**不是固定长度的窗口**
    // ——本文件最后那一格记着固定窗口越界吃到下一步的实测。
    const blockOf = (startNeedle: string) => {
      const i = yml.indexOf(startNeedle);
      expect(i, `ci.yml 里找不到「${startNeedle}」`).toBeGreaterThan(-1);
      const end = yml.indexOf("\n      - ", i + 1);
      return stripHashComments(yml.slice(i, end === -1 ? yml.length : end));
    };

    expect(
      blockOf("- uses: actions/checkout@v4"),
      "fetch-depth: 0 不在 checkout 那一步自己的块里 ⇒ 拉到的还是浅仓，历史那一档只会 fail closed",
    ).toContain("fetch-depth: 0");

    const scan = blockOf("name: 2/12 凭据扫描");
    expect(scan, "历史那一档不在凭据扫描那一步自己的块里 ⇒ 它根本没被跑到").toContain(
      "bash scripts/scan-secrets.sh --history",
    );
    expect(scan, "凭据扫描那一步缺 shell: bash ⇒ 两条命令的中断行为要去赌 runner 的默认 shell").toContain(
      "shell: bash",
    );
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
  // check-comment-refs 又插了一步进去，原来的 8/11..11/11 全部跟着挪一位）。
  expect(ci, "还有步骤写着 N/10").not.toMatch(/name: \d+\/10 /);
  expect(ci, "还有步骤写着 N/11").not.toMatch(/name: \d+\/11 /);
});

/**
 * ── ci.yml 自己的注释行里不许写门禁序号（P3e Task 15 复评 MED-5）──────────────
 *
 * `scripts/check-comment-refs.mjs` 的规则 E 把「注释里写门禁的绝对序号」判成错，
 * 理由是 CI 里增删或重排一步、全仓序号一次性变假。**但那道门禁的 `walk()`
 * 只收 `.ts` / `.js` / `.mjs`，`.yml` 一行都扫不到**——而 ci.yml 的注释离真源最近、
 * 最容易顺手写一个序号，上一版就逐字写着「新增的第 N 道」「N/M、N/M 的这两处」。
 *
 * ⚠️ **这不是重复上面那一格**：上面判的是 `name:` 那些**真源**行还在不在、编号齐不齐；
 * 这一格判的是**注释行**里有没有把真源抄一份。真源被重排时，上面那格会红（好），
 * 而抄在注释里的那一份**只会静静变假**——实测过一次：把 ci.yml 整体重编号成十三道，
 * 上面那格红了两次，注释里那两处序号一声不吭地成了假话。
 *
 * ⚠️ **判据只看 `#` 注释行**：`name: N/12` 是这个文件作为真源该有的样子，不许误伤。
 * 想在注释里指认某一步，写它的**脚本名或裸命令**（`node scripts/check-i18n.mjs`、
 * `pnpm test`）——那正是规则 E 给全仓其余部分的同一条出路。
 *
 * ⚠️ **判据刻意不去区分「步骤编号」和「别的斜杠数字」，代价明写在这里**：
 * `2026/08/24` 这种写法会一起被打红。**没有把判据收窄成「分母等于今天的步数」，
 * 是因为那样会漏掉最要命的一种**——CI 重排成十三道之后，注释里那句陈旧的
 * `10/12` 分母不再等于步数，收窄过的判据会当场对它闭眼，而它正是那句变假了的话。
 * 宁可让 ci.yml 的注释里把日期写成 `2026-08-24`（报文里给了这条出路），
 * 也不要一条「重排之后自动失明」的判据。
 */
it("ci.yml 的注释行里不许写门禁的绝对序号（这道门禁的射程够不着 .yml）", () => {
  const lines = readFileSync(".github/workflows/ci.yml", "utf8").split("\n");
  const bad: string[] = [];
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (!t.startsWith("#")) return;
    // 两族都要抓：分数形态（`10/12`）与序数形态（`第 8 道` / `第八道`）。
    if (/\d+\s*\/\s*\d+/.test(t) || /第\s*(?:\d+|[一二三四五六七八九十两]+)\s*道/.test(t)) {
      bad.push(`${i + 1}: ${t}`);
    }
  });
  expect(
    bad,
    "ci.yml 的注释里写了门禁的绝对序号。重排一步之后它会静静变假，而"
    + "`scripts/check-comment-refs.mjs` 扫不到 .yml——改写成脚本名或裸命令"
    + "（`node scripts/某个脚本.mjs` / `pnpm test`）。写日期撞上来的话，改成 2026-08-24 那种连字符写法",
  ).toEqual([]);
});

/**
 * **注释指向门禁（`scripts/check-comment-refs.mjs`，全分支评审 B2）在 CI 里**：注释里写「这条由某某用例钉着」时，
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
