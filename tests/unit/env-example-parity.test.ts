import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { envLockedFields } from "../../src/core/config-provenance.js";

/**
 * `.env.example` 必须覆盖真源里全部可配环境变量。
 *
 * ── 为什么这件事值一道守卫 ─────────────────────────────────────────────────
 *
 * 五份 `README.md` 教陌生人的第一条命令就是 `cp .env.example .env`。**那份文件缺一个
 * 变量不是文档瑕疵，是部署事故**：本仓吃过一次真实的亏——`USAGE_FLUSH_INTERVAL_MS`
 * 留空（不是注释掉）时 `cp` 出来的 `.env` 会把**空字符串**（不是「未设置」）喂给
 * 「不小于 1 的整数」校验器，`Number("") = 0` 过不了那一关，全新 Docker 部署直接起不来。
 * 那一次的处置写在 `.env.example` 里那一行的上方。
 *
 * 而在本文件出现之前，全仓提到 `.env.example` 的地方**全是注释**，没有一格断言它与
 * 真源对齐——又一张不会自己红的清单。
 *
 * ── 期望值从哪来：三张表，只有第一张是真源 ─────────────────────────────────
 *
 * ① `ENV_LOCK_MAP`（`src/core/config-provenance.ts`）——**唯一真源**，本文件不抄它。
 *    抄一份就是第三份变量名清单（那张表自己的注释已经写过「由它派生，不另写一份」）。
 *    它是**私有**的，而本仓已经裁定过「判据走 `envLockedFields`，不是去读私有的
 *    `ENV_LOCK_MAP`——后者是实现细节，前者是契约」（`tests/unit/config-provenance.test.ts`
 *    的「这 16 个名字每一个都能让 envLockedFields 报出一条锁定字段」）。
 *    ⇒ 这里用一个 **Proxy 探针**从那个契约函数身上把名字取回来，见 `envLockNames()`。
 * ② `EXTRA_ENV` / ③ `RUNTIME_ONLY_ENV`——**手写**，各自配了会红的断言，见各自的说明。
 *
 * **别为了「省事」把三张合成一张手写全集**：那就退回成一张不会自己红的清单。
 */

/** `.env.example` 里「声明了一个变量」长什么样。**正反两向共用这一份判据**——
 *  正向（某个名字在不在里面）与反向（里面都有哪些名字）各写一条正则就会漂。 */
const DECLARATION = String.raw`^#?[ \t]*([A-Z][A-Z0-9_]*)=`;

const envExample = (): string => readFileSync(".env.example", "utf8");

/** `.env.example` 里声明过的全部变量名（含被注释掉的那一行）。 */
function declaredInEnvExample(): string[] {
  return [...envExample().matchAll(new RegExp(DECLARATION, "gm"))].map((m) => m[1]!);
}

/**
 * `ENV_LOCK_MAP` 的键，**从 `envLockedFields` 身上取回来，不抄第二份**。
 *
 * `envLockedFields` 的判据是「这个键在 env 里存在」，实现上对表里每个键各做一次
 * `env[k]` ⇒ 传一个「问什么都答得上来」的 Proxy 进去，它问过的那些键就是整张表的键。
 *
 * ⚠️ **探针天生有一种失效方式：`envLockedFields` 改成不再逐键取值（例如改走
 * `Object.keys(env)`）时，这里会安静地返回空数组，而上面那几格会因为「没有一个
 * 变量缺席」全部变绿。** 那正是本仓最怕的形态，所以它配了一格独立的警报：
 * 下面「src/ 里读到的每个环境变量都得有个去处」拿**另一条完全不同的路径**
 *（扫 `src/` 里的 `env.XXX`）算出十几个配置类变量名，探针一旦返回空，
 * 那一格会逐个点名地红。
 */
function envLockNames(): string[] {
  const asked: string[] = [];
  const probe = new Proxy({} as Record<string, string | undefined>, {
    get(_target, key) {
      if (typeof key === "string") asked.push(key);
      return "probe";
    },
  });
  envLockedFields(probe);
  return [...new Set(asked)].sort();
}

/**
 * 手写例外。**只许有这一个**，由下面「手写例外恰好 1 项」那一格钉着。
 *
 * · `DATA_DIR` —— 它不进 `ENV_LOCK_MAP`（那张表是「哪些 `GatewayConfig` 字段被 env
 *   锁住」，而 `DATA_DIR` 不是配置字段），是 `src/entry/node.ts` 选存储实现时直接读的
 *   卷挂载路径；`docker-entrypoint.sh` 也读它来决定要不要改数据目录的属主。
 */
const EXTRA_ENV = ["DATA_DIR"];

/**
 * `.env.example` 里那些**不是配置字段**的名字：运行时开关，正当地不进 `ENV_LOCK_MAP`。
 *
 * ⚠️ **手写，所以每一个旁边都写清楚「它由哪个文件读」**——派生不出来的原因是它们
 * 散落在各自的消费点上、没有任何一张集中的表。两条断言接着它：
 * 「手写表里没有死名字」（每个名字都真的被 `src/` 里的 `env.X` 读到）与
 * 「`RUNTIME_ONLY_ENV` 里的每个变量也在 `.env.example` 里」。
 *
 * · `ADMIN_TOKEN` —— `src/http/wire.ts` 交给 `src/http/admin/router.ts`；只从环境变量读。
 * · `PORT` —— `src/entry/node.ts` 的监听端口，Worker 形态用不到。
 * · `RESET_CONFIG` —— `src/core/config-provenance.ts` 的逃生口，置 1 时忽略存储里的 config 键。
 * · `TRUST_PROXY` —— `src/http/wire.ts` 交给 `src/http/client-ip.ts` 决定信不信转发头。
 * · `USAGE_FLUSH_INTERVAL_MS` —— `src/http/wire.ts` 交给 `src/http/usage-sink.ts` 的落盘间隔。
 */
const RUNTIME_ONLY_ENV = ["ADMIN_TOKEN", "PORT", "RESET_CONFIG", "TRUST_PROXY", "USAGE_FLUSH_INTERVAL_MS"];

/**
 * `env` 上的名字里**根本不是环境变量**的那些：Cloudflare 的绑定。
 *
 * · `POOL` —— KV namespace 绑定，由 `wrangler.toml` 的 `[[kv_namespaces]]` 注入到
 *   Worker 的 `env` 上。**写进 `.env.example` 反而是误导**（Docker 形态设它什么也不会
 *   发生），所以它进的是这张表而不是上面两张。下面「wrangler.toml 里声明过」那一格
 *   不让这张表长出一个 `wrangler.toml` 里查不到的名字。
 */
const WORKER_BINDINGS = ["POOL"];

/** `.env.example` 该有的全部名字。绑定不在其中，理由见 `WORKER_BINDINGS`。 */
const expectedInEnvExample = (): string[] => [...envLockNames(), ...EXTRA_ENV, ...RUNTIME_ONLY_ENV];

// ── src/ 侧的独立扫描 ───────────────────────────────────────────────────────

function walkTs(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walkTs(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/**
 * `src/` 里所有形如 `env.FOO` / `env["FOO"]` 的读取点。
 *
 * ⚠️ **刻意不抠注释，这是一个有意选的方向，不是漏了。** 本仓的注释里到处写真代码
 * 片段，所以注释里出现一个 `env.FOO` 完全可能——那时这里会**多**扫出一个名字，
 * 后果是下面那一格**红**（吵），而不是漏。反过来，接上抠注释的实现就多一条
 * 「抠错 ⇒ 少扫 ⇒ 静默变绿」的路径，那才是本仓真正吃过亏的方向。
 * ⇒ **注释里被误伤时的处置是把那句注释改成不带 `env.` 前缀，不是把那个名字塞进
 * 上面任何一张名册**——塞进去会顺手要求 `.env.example` 里也长出一个死变量。
 * 这条处置指引写在下面那一格的报文里，不只写在这里。
 *
 * 它只覆盖「点号/方括号直接取」这一种写法：`num(env, "MAX_STRIKES", …)` 这类把名字
 * 当字符串参数传的读取点不在射程内，它们由 `ENV_LOCK_MAP` 那一侧管着
 *（`tests/unit/config-provenance.test.ts` 的「四种配置的并集恰好是手写的这 16 个名字」
 * 用 Proxy 追踪 `registrarFromEnv` 真实读过的键）。
 */
function envNamesReadInSrc(): string[] {
  const found = new Set<string>();
  for (const file of walkTs("src")) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]*)|\benv\["([A-Z][A-Z0-9_]*)"\]/g)) {
      found.add(m[1] ?? m[2]!);
    }
  }
  return [...found].sort();
}

describe(".env.example 与真源对齐", () => {
  it("ENV_LOCK_MAP 里的每个变量都在 .env.example 里出现过", () => {
    const declared = new Set(declaredInEnvExample());
    expect(
      envLockNames().filter((k) => !declared.has(k)),
      "这些变量真源里有、教陌生人 cp 的那份文件里没有 ⇒ 照着 .env.example 部署的人拿不到它们；"
      + "每个补一行，默认值与一行注释抄 docs/<语言>/DEPLOY.md 里那一格",
    ).toEqual([]);
  });

  it("手写例外恰好 1 项（DATA_DIR）—— 想加第二个例外必须先回来表态", () => {
    expect(EXTRA_ENV).toEqual(["DATA_DIR"]);
  });

  it("EXTRA_ENV 里的每个变量也在 .env.example 里", () => {
    const declared = new Set(declaredInEnvExample());
    expect(EXTRA_ENV.filter((k) => !declared.has(k))).toEqual([]);
  });

  it("RUNTIME_ONLY_ENV 里的每个变量也在 .env.example 里", () => {
    const declared = new Set(declaredInEnvExample());
    expect(
      RUNTIME_ONLY_ENV.filter((k) => !declared.has(k)),
      "这些运行时开关本来写在 .env.example 里，现在没了 ⇒ 要么把那一行找回来，要么把名字从这张表里删掉",
    ).toEqual([]);
  });

  it("反向控制：.env.example 里出现的变量不许是真源里没有的（防写错名字）", () => {
    const known = new Set(expectedInEnvExample());
    expect(
      declaredInEnvExample().filter((k) => !known.has(k)),
      "这些名字在 .env.example 里，真源里查不到 —— 多半是拼错了，或者那个变量已经被删掉而这一行留着",
    ).toEqual([]);
  });

  it(".env.example 头部指路到 DEPLOY.md —— 陌生人 cp 完不至于以为这就是全集", () => {
    expect(envExample().slice(0, 800)).toContain("DEPLOY.md");
  });

  /**
   * **这一格同时是上面那些格的警报器**：它算期望值的路径（扫 `src/` 里的 `env.X`）
   * 与 `envLockNames()` 那条 Proxy 探针**毫无关系**，所以探针一旦瞎掉（返回空数组），
   * 十几个配置类变量会在这里一个不落地被点名，而不是让上面那几格静静地全绿。
   *
   * 它的另一半作用是正向的：`src/` 里新长出一个 `env.NEW_THING` 却没人管时，
   * 这一格逼作者表态——进 `ENV_LOCK_MAP`（配置字段），还是进上面那两张手写表之一。
   */
  it("src/ 里读到的每个环境变量都得有个去处 —— 要么在锁定表里，要么在手写的那几张表里点名", () => {
    const known = new Set([...expectedInEnvExample(), ...WORKER_BINDINGS]);
    expect(
      envNamesReadInSrc().filter((k) => !known.has(k)),
      "src/ 里读了这些环境变量，而它们既不在 ENV_LOCK_MAP 里、也没在本文件的手写表里点名。"
      + "两种可能：① 真的新增了一个变量 ⇒ 按它的性质进 ENV_LOCK_MAP / EXTRA_ENV / RUNTIME_ONLY_ENV，"
      + "并在 .env.example 里补一行；② 只是某段注释里写了 env.XXX（本扫描刻意不抠注释）"
      + " ⇒ 把那句注释改成不带 env. 前缀，别把名字塞进任何一张表",
    ).toEqual([]);
  });

  it("手写表里没有死名字 —— EXTRA_ENV / RUNTIME_ONLY_ENV 的每个名字都真的被 src/ 读到", () => {
    const read = new Set(envNamesReadInSrc());
    expect(
      [...EXTRA_ENV, ...RUNTIME_ONLY_ENV].filter((k) => !read.has(k)),
      "这些名字在本文件的手写表里，但 src/ 里没有任何一处 env.X 读它们 ⇒ 要么变量真的没了"
      + "（连同 .env.example 里那一行一起删），要么读法变了（那时本扫描的射程要跟着改）",
    ).toEqual([]);
  });

  it("WORKER_BINDINGS 里的每个名字都在 wrangler.toml 里声明成 binding", () => {
    const toml = readFileSync("wrangler.toml", "utf8");
    expect(
      WORKER_BINDINGS.filter((k) => !new RegExp(String.raw`^\s*binding\s*=\s*"${k}"`, "m").test(toml)),
      "这些名字被当成 Cloudflare 绑定豁免掉了，而 wrangler.toml 里并没有这么一条绑定 ⇒ 豁免的理由不成立",
    ).toEqual([]);
  });
});
