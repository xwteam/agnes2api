import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { envLockedFields, loadConfigWithProvenance } from "../../src/core/config-provenance.js";
import { MemoryStorage } from "../helpers/fake-storage.js";

/**
 * `.env.example` 必须覆盖真源里全部可配环境变量，**并且照它 `cp` 出来的那份 `.env` 真的
 * 装得起来**，**并且与五语言文档两个方向都对得上**。
 *
 * ── 为什么这件事值一道守卫 ─────────────────────────────────────────────────
 *
 * 每一份 `README.md` 教陌生人的第一条命令都是 `cp .env.example .env`。**那份文件缺一个
 * 变量不是文档瑕疵，是部署事故**：本仓吃过一次真实的亏——`USAGE_FLUSH_INTERVAL_MS`
 * 留空（不是注释掉）时 `cp` 出来的 `.env` 会把**空字符串**（不是「未设置」）喂给
 * 「不小于 1 的整数」校验器，`Number("") = 0` 过不了那一关，全新 Docker 部署直接起不来。
 * 那一次的处置写在 `.env.example` 里那一行的上方，以及 `src/http/usage-sink.ts` 的
 * `resolveUsageFlushInterval` 里那条「空串等同没设」的分支。
 *
 * ⚠️ **本文件不是 `.env.example` 上唯一的活断言**（第一版这里写成「全仓提到它的地方
 * 全是注释」，实测为假）：`tests/unit/registrar/config.test.ts`
 * 的「M5 .env.example 的凭据注释按……两条通道对称」早就在读它并钉住**凭据注释的措辞**。
 * 两格射程不同——那一格管**某几句话怎么写**，本文件管**清单齐不齐、值能不能用、
 * 文档对不对得上**。改 `.env.example` 的人两格都要看。
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

/** `.env.example` 里「声明了一个变量」长什么样。**下面每一格共用这一份判据**——
 *  正向（某个名字在不在里面）、反向（里面都有哪些名字）、以及「`cp` 出来的那份 `.env`
 *  长什么样」各写一条正则就会漂。三段捕获：注释号（有就是「被注释掉的声明」）、名字、值。 */
const DECLARATION = String.raw`^(#?)[ \t]*([A-Z][A-Z0-9_]*)=(.*)$`;

const envExample = (): string => readFileSync(".env.example", "utf8");

const declarations = (): Array<{ commented: boolean; name: string; value: string; line: number }> => {
  const out: Array<{ commented: boolean; name: string; value: string; line: number }> = [];
  envExample().split("\n").forEach((text, i) => {
    const m = new RegExp(DECLARATION).exec(text);
    if (m) out.push({ commented: m[1] === "#", name: m[2]!, value: m[3]!, line: i + 1 });
  });
  return out;
};

/** `.env.example` 里声明过的全部变量名（含被注释掉的那一行）。 */
function declaredInEnvExample(): string[] {
  return declarations().map((d) => d.name);
}

/** 第一条声明**之前**的那段头部。指路那一格只看这里，见它的说明。 */
function envExampleHeader(): string {
  const lines = envExample().split("\n");
  const first = lines.findIndex((l) => new RegExp(DECLARATION).test(l));
  return lines.slice(0, first === -1 ? lines.length : first).join("\n");
}

/**
 * **陌生人 `cp .env.example .env` 之后，docker compose 的 `env_file:` 送进容器的那份环境。**
 *
 * 规则与 compose 一致：被注释掉的行不算，**留空的键以空字符串进环境**（不是「未设置」）
 * ——那正是本仓吃过亏的那条路径，也是 `.env.example` 头部那段警告讲的那件事。
 */
function envFromEnvExample(): Record<string, string> {
  return Object.fromEntries(declarations().filter((d) => !d.commented).map((d) => [d.name, d.value]));
}

/** 每个声明**上方连续的注释行**有多少行。头部那句「注释详略不一」就靠它守着。 */
function commentLinesAbove(): Array<{ name: string; lines: number }> {
  const src = envExample().split("\n");
  return declarations().map(({ name, line }) => {
    let n = 0;
    for (let i = line - 2; i >= 0 && src[i]!.startsWith("#"); i--) n++;
    return { name, lines: n };
  });
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

  /**
   * ⚠️ **第一版的判据是「前 800 字符里含子串 `DEPLOY.md`」，比用例名弱得多**：
   * 把整块指路删掉、随手在开头写一句「顺带一提：DEPLOY.md 里写了别的东西」照样绿
   *（复评实测 H1）。现在判据落在**指路本身**上——第一条声明之前的那段头部里，
   * 必须给得出带路径形态的去处（`docs/<你的语言>/DEPLOY.md`），注册机那一组还要点到
   * `REGISTRAR.md`。**射程仍然只到「指路存在」，指到的那一节写得对不对不在这里。**
   */
  it(".env.example 头部指路到 docs/<语言>/DEPLOY.md 与 REGISTRAR.md —— 陌生人 cp 完不至于以为这就是全集", () => {
    const header = envExampleHeader();
    expect(
      ["DEPLOY.md", "REGISTRAR.md", "docs/"].filter((needle) => !header.includes(needle)),
      "第一条声明之前的那段头部没有把人指到五语言文档 ⇒ 陌生人只能拿这份文件当全部说明。"
      + "指路要给得出路径形态（docs/<你的语言>/DEPLOY.md），光提一句文件名不算",
    ).toEqual([]);
  });

  /**
   * 头部那句「注释详略不一：多数变量只有一行，而踩过坑的那几个写满了十几行」**是一句
   * 会过期的全称句**——它的前身「每个变量最多只有一行注释」写下时就已经是假的
   *（复评 S1：同文件当时 10 个变量的注释超过一行，最长 20 行），而那句话还被逐字搬进了
   * 五语言 `DEPLOY.md`。**这一格就是那句话的机器守卫。**
   *
   * ⚠️ **刻意不点名「哪几个变量允许写长」**：那是一张只会长大的永久豁免名册（本仓已登记
   * 的形态）。判据只钉这句话本身的两个可证伪部分——「多数」与「有那么几个很长」——
   * 所以给某个变量补三行注释不会红，而把注释密度改到这句话不再成立才会红。
   */
  it("头部那句「多数变量只有一行、个别写满十几行」是真的 —— 它同时是五语言 DEPLOY.md 里的同一句", () => {
    const perVar = commentLinesAbove();
    const brief = perVar.filter((v) => v.lines <= 1);
    const long = perVar.filter((v) => v.lines >= 10);
    const advice = "这句话同时写在 .env.example 头部与五语言 docs/<语言>/DEPLOY.md 的环境变量表下方，"
      + "改注释密度就要回去把那几句一起改（本仓上一次正是让这句话在 6 个位置一起变假的）";
    expect(brief.length, `「多数变量只有一行」不再成立：${brief.length} 个变量注释不超过一行，`
      + `${perVar.length - brief.length} 个超过。${advice}`).toBeGreaterThan(perVar.length - brief.length);
    expect(long.map((v) => v.name), `「个别写满十几行」不再成立：没有任何一个变量的注释达到十行。${advice}`)
      .not.toEqual([]);
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

/**
 * **上面那些格只看名字，一个值都不看。**
 *
 * 复评实测：把任何一行数值改成留空（`MAX_STRIKES=`）——**正是本文件开头引用的那次真实
 * 部署事故的形态**——上面 9 格全绿，而照这份文件 `cp` 出来的新部署当场抛错起不来。
 * 「少一个名字」被挡住了，「名字在、值空了」这一族没有，而后者才是本仓真正吃过亏的那族。
 *
 * ⇒ 这一组不再读文本，而是**把 `.env.example` 按 compose `env_file:` 的规则解析成一份
 * 真环境，喂给真装配函数 `loadConfigWithProvenance`**。期望值不手写：一律拿「同一份环境
 * 去掉那个键」的装载结果当对照。
 *
 * **射程写明**：它覆盖的是走 `GatewayConfig` 那条路的变量。`PORT` / `DATA_DIR` 不是配置
 * 字段，看不见——它们的「空串视同没设」由 `tests/unit/entry-node.test.ts` 的
 * 「DATA_DIR= （空串）回落到 /app/data……」与「PORT= （空串）回落到 8080……」两格管着。
 */
describe("照 .env.example cp 出来的那份 .env 真的能起来", () => {
  /** README 教的最小动作就这一步：填一个 GATEWAY_TOKEN。 */
  const TOKEN = "unit-test-gateway-token";
  const baseEnv = (): Record<string, string> => ({ ...envFromEnvExample(), GATEWAY_TOKEN: TOKEN });

  /** 装载结果的**可比较形态**：抛错也是一种结果，两边都要能比。 */
  async function outcome(env: Record<string, string>): Promise<string> {
    try {
      const { config } = await loadConfigWithProvenance(env, new MemoryStorage());
      return JSON.stringify(config);
    } catch (err) {
      return `THROW ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  it("cp + 填一个 GATEWAY_TOKEN ⇒ 装得起来，而且不是降级起来的", async () => {
    const { config } = await loadConfigWithProvenance(baseEnv(), new MemoryStorage());
    expect(
      config.degraded,
      "照 .env.example cp 出来的配置只能干净地起来 —— degraded 说明有字段回落了，运维看不见",
    ).toBe(false);
  });

  /**
   * **留空的键必须与「没设」等价。** 这正是文件头那段警告承诺的事，也是唯一能把
   * 「值空了」这一族接住的判据：
   * · 数值旋钮被清空 ⇒ 一侧抛错、另一侧正常 ⇒ 两个结果不等 ⇒ 红；
   * · 下界是 0 的那两个池子旋钮被清空 ⇒ 悄悄变成 0（=关闭缓存）⇒ 与默认值不等 ⇒ 红。
   *
   * ⚠️ **只比 `config`，不比 `source`**：`envLockedFields` 的判据是「这个键在 env 里存在」，
   * 与值合不合法无关，所以一个留空的键**本来就**会让面板把那格显示成「被环境变量锁定」
   *（那是有意的，由 `tests/unit/config-provenance.test.ts` 的
   * 「空串的环境变量也算锁定 —— 判据是键存在，不是值合法」钉着）。把 `source` 也拉
   * 进来比，等于把一条**正确**的行为判成漂移。
   */
  it("留空的每个键都与「没设它」等价 —— 否则就是本仓吃过亏的那种静默（或起不来）", async () => {
    const base = baseEnv();
    const empties = Object.keys(base).filter((k) => base[k] === "");
    const reference = await outcome(base);
    const offenders: string[] = [];
    for (const k of empties) {
      const without = { ...base };
      delete without[k];
      if (await outcome(without) !== reference) offenders.push(k);
    }
    expect(
      offenders,
      "这些键在 .env.example 里留着空值，而空串与「没设」在代码里不是一回事 ⇒ 照这份文件 cp 的人"
      + "要么起不来（数值项过不了「不小于 1 的整数」那一关），要么拿到一个自己没设过的值"
      + "（下界是 0 的旋钮会静默变成「关闭」）。处置：那一行要么给回默认值，要么整行注释掉"
      + "（末尾 USAGE_FLUSH_INTERVAL_MS 就是这个写法）",
    ).toEqual([]);
  });

  it("反向控制：这一组真的在读值 —— 空的键确实存在，不是拿一张空表在空转", () => {
    const base = baseEnv();
    expect(
      Object.keys(base).filter((k) => base[k] === "").length,
      "一个留空的键都没解析出来 ⇒ 多半是解析器坏了（上面那格于是恒绿），先查 DECLARATION",
    ).toBeGreaterThan(0);
  });
});

// ── 文档侧：五语言 DEPLOY.md / REGISTRAR.md 的环境变量表 ─────────────────────

const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"] as const;

/**
 * 两份带环境变量表的文档，各配一个**必然在表里**的锚点变量。
 *
 * ⚠️ **分工（P3e Task 9 补漏评审登记的那条副作用）**：本仓有**两套**判据在看五语言
 * `DEPLOY.md`，两边此前互不知情，也没有任何一处写明谁管什么。改表之前先认准自己在哪一边：
 * · **这一份**的射程是「表里点名了哪些变量」与 `.env.example` 的**双向对等**——
 *   它看的是**名单**（谁在、谁不在），一行译文怎么写它不看。
 * · `tests/unit/docs-parity.test.ts` 那一组 R1–R6 的射程是**五份之间的结构骨架**
 *   （其中 R5 数的是以 `|` 开头的表格行数），它**不认识任何一个变量名**。
 * 两边的射程不重叠，谁也替不了谁；各自的边界说明写在各自文件里，别照着一边的结论
 * 去推另一边。
 *
 * 锚点是「认不出要吵」那条纪律的落地：下面的表格判据是一条正则，正则一旦与文档的
 * 真实排版脱节（改了表格样式、变量名不再包在反引号里），它会**一个名字都认不出**，
 * 而「空集 ⊆ 任何集合」「五份空集彼此相等」两条都会静静地成立。锚点让那种失效变成红。
 * 选它们的理由都是「这张表里唯一的必填项」：没有它这份文档就没在讲配置。
 */
const ENV_TABLE_DOCS = [
  { doc: "DEPLOY", anchor: "GATEWAY_TOKEN", why: "网关唯一的必填项" },
  { doc: "REGISTRAR", anchor: "REGISTRAR_PRIMARY", why: "注册机启用后唯一没有默认值的必填项" },
] as const;

/** 一份文档的环境变量表里点名的变量：表格第一格是一个反引号包住的全大写名字。 */
function tableVars(lang: string, doc: string): string[] {
  const md = readFileSync(`docs/${lang}/${doc}.md`, "utf8");
  return [...new Set([...md.matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/gm)].map((m) => m[1]!))].sort();
}

/**
 * **阶段 C 的那道对等守卫：`.env.example` 与五语言文档，两个方向都要对得上。**
 *
 * 起因是十句已发布的文档断言只守住了一个方向。五语言 `DEPLOY.md` / `REGISTRAR.md` 各写着
 * 「上表里的每个变量在 `.env.example` 里都有一行示例」——**今天为真，但往表里加一行
 * `.env.example` 里没有的变量，这十句会在五种语言里同时变假而零红**（复评实测 D1）。
 *
 * 三格覆盖三种漂移，各自的失败形态不同：
 * ① **某一种语言漂了**（漏翻一行、多翻一行）⇒ 集合对等那一格红。这是阶段 H 写
 *    `ADMIN.md × 5` 时唯一能自动发现「某语言漂了」的东西。
 * ② **文档长出网关不认得的变量** ⇒ 「表里的每个变量都声明过」那一格红。
 * ③ **网关长出新变量而某种语言没跟上** ⇒ 「每个声明都被五种语言提到」那一格红。
 *    它连带发现了一个真实缺口：`RESET_CONFIG`（存储写坏时的逃生口）此前**五种语言
 *    一份都没提**，本轮补进五份 `DEPLOY.md` 的表里。
 *
 * ⚠️ **边界**：③ 的判据是「正文里出现过这个名字」，不是「解释清楚了」——它挡的是漏写，
 * 不是敷衍。译文说得对不对、五份说的是不是同一件事，仍然只能靠评审
 *（与 `tests/unit/docs-parity.test.ts` 文件头那条边界同一条）。
 */
describe(".env.example 与五语言文档对等", () => {
  for (const { doc, anchor, why } of ENV_TABLE_DOCS) {
    it(`五语言 ${doc}.md 的环境变量表点名的变量集合完全相同 —— 某一种语言漏翻/多翻一行会红`, () => {
      const actual = Object.fromEntries(LANGS.map((lang) => [lang, tableVars(lang, doc).join(" ")]));
      const expected = Object.fromEntries(LANGS.map((lang) => [lang, actual[LANGS[0]]]));
      expect(
        actual,
        `五语言 ${doc}.md 的环境变量表对不上 —— 有语言漏翻了一行、多写了一行，或者表格排版被改成本判据认不出的样子`,
      ).toEqual(expected);
    });

    it(`五语言 ${doc}.md 的表里都认得出 ${anchor}（${why}）—— 一个名字都认不出时上面那格会平凡地全绿`, () => {
      expect(
        LANGS.filter((lang) => !tableVars(lang, doc).includes(anchor)),
        `这些语言的 ${doc}.md 里没认出 ${anchor} ⇒ 要么那一行真的没了，要么表格排版变了而本判据已经瞎了`,
      ).toEqual([]);
    });

    it(`五语言 ${doc}.md 表里的每个变量都在 .env.example 里声明过 —— 文档不许长出网关不认得的变量`, () => {
      const declared = new Set(declaredInEnvExample());
      const stray = LANGS.flatMap((lang) => tableVars(lang, doc).filter((k) => !declared.has(k)).map((k) => `${lang}:${k}`));
      expect(
        stray,
        "文档的环境变量表里有 .env.example 里查不到的变量 ⇒ 要么那一行是拼错/过期的，"
        + "要么它是真变量而 .env.example 漏了一行（那样陌生人 cp 完拿不到它）",
      ).toEqual([]);
    });
  }

  it(".env.example 里声明的每个变量，五种语言的 DEPLOY.md / REGISTRAR.md 都提到过", () => {
    const missing = LANGS.flatMap((lang) => {
      const text = ENV_TABLE_DOCS.map(({ doc }) => readFileSync(`docs/${lang}/${doc}.md`, "utf8")).join("\n");
      return declaredInEnvExample().filter((k) => !text.includes(k)).map((k) => `${lang}:${k}`);
    });
    expect(
      missing,
      "这些变量写进了陌生人要 cp 的那份文件，而这些语言的部署文档一个字都没提 ⇒ 要么在那份文档里补一行"
      + "（五种语言一起补，否则上面的集合对等会红），要么它压根不该出现在 .env.example 里",
    ).toEqual([]);
  });
});

/**
 * ## W125 —— `.env.example` 的「不回退」下限
 *
 * P3f 阶段 7 的射程铁律里有一条**否定项**：25 份非 README 文档要补层级、补 alert、
 * 补 ```env 围栏，而 **`.env.example` 本身一个字都不改**（ADJ ⑬ / 规格 C20）。
 * 那条裁定在规格里被写了三遍，**却在 W 清单、R 判官、W88 基线三处都没有承载点**——
 * 一条只写在文档里、没有任何判据兜着的「不许动」，等于没有。
 *
 * ⚠️ **这一格守的不是「不许改」，是「不许缩水」。**
 * 真正会发生的退化有两种，而且都长得很像「顺手整理了一下」：
 * ① 阶段 7 要把 DEPLOY.md 的长解释搬进 ```env 围栏，搬的时候顺手把
 *    `.env.example` 里那段同源的注释「去重」掉——那份文件是陌生人 `cp` 的**唯一**
 *    一份自带说明的配置模板，注释掉了就只剩一串裸变量名；
 * ② 有人拿它当「示例」而不是「模板」，把不常用的变量整段删掉图清爽。
 * 两种改法都不会让上面任何一格红：那些格子查的是**名字集合**与**能不能起来**，
 * 而删注释一个名字都不少、删整段变量也只是让集合两边一起变小（`ENV_LOCK_MAP`
 * 那半边是真源，但 `EXTRA_ENV` / `RUNTIME_ONLY_ENV` 是手写表，一起删就一起绿）。
 *
 * ⚠️ **这两个数是 2026-08-30 的实测值，不是拍脑袋的目标值**，口径逐字写在
 * `MIN_TOTAL_LINES` / `MIN_COMMENT_LINES` 上，与 `wc -l` / `grep -c '^#'` 一致。
 * **它是下限不是等式**：往里加变量、加注释都不该红，只有缩水才红。
 * 数字要往上调的唯一正当理由是「文件真的长大了，把新的实测值钉进来」——
 * **往下调没有正当理由**，那正是本格要拦的那件事。
 */
describe("W125 `.env.example` 不回退", () => {
  /** `wc -l .env.example` 的口径：数换行符，不是数 `split("\n")` 的段数。 */
  const totalLines = (src: string): number => (src.match(/\n/g) ?? []).length;
  /** `grep -c '^#' .env.example` 的口径：以 `#` 起头的行数（含分隔用的 `# ---`）。 */
  const commentLines = (src: string): number => src.split("\n").filter((l) => l.startsWith("#")).length;

  /** 2026-08-30 实测：`wc -l` = 197。 */
  const MIN_TOTAL_LINES = 197;
  /** 2026-08-30 实测：`grep -c '^#'` = 139。 */
  const MIN_COMMENT_LINES = 139;

  it("整份文件不短于实测下限（`wc -l` ≥ 197）", () => {
    expect(
      totalLines(envExample()),
      `.env.example 比 2026-08-30 的实测值（${MIN_TOTAL_LINES} 行）短了 —— 阶段 7 的裁定是**这份文件一个字都不改**，`
      + "缩水只有两种来源：整段变量被删，或者注释被「去重」掉。要么把删掉的加回来，要么先来推翻 ADJ ⑬",
    ).toBeGreaterThanOrEqual(MIN_TOTAL_LINES);
  });

  it("注释密度不低于实测下限（`grep -c '^#'` ≥ 139）—— 它是陌生人手里唯一一份带说明的模板", () => {
    expect(
      commentLines(envExample()),
      `.env.example 的注释行比 2026-08-30 的实测值（${MIN_COMMENT_LINES} 行）少了 —— `
      + "每个变量上方那几行 `#` 是 `cp` 出来之后唯一的说明，删掉它等于把这份模板降级成一串裸变量名",
    ).toBeGreaterThanOrEqual(MIN_COMMENT_LINES);
  });

  /**
   * **两条口径各自会红，而且红在自己那一半上。**
   *
   * 少了这两格，一对写反的口径（比如两条都去数总行数）也能全绿：删注释时总行数
   * 跟着掉，两条一起红，看上去像「判据有效」，实际上注释那一半从来没被单独守过。
   */
  it("该红时红：删掉 20 行 ⇒ 总行数那条红", () => {
    const src = envExample();
    const mutated = src.split("\n").slice(0, -21).join("\n") + "\n";
    expect(totalLines(mutated), "变异没落地 —— 删了 20 行而行数没变").toBeLessThan(totalLines(src));
    expect(totalLines(mutated)).toBeLessThan(MIN_TOTAL_LINES);
  });

  it("该红时红：只删注释、一个变量都不删 ⇒ 注释那条红，而名字集合完全不变", () => {
    const src = envExample();
    const kept = src.split("\n").filter((l) => !l.startsWith("#"));
    const mutated = kept.join("\n");
    // **没被注释掉的那些声明一个都没少** —— `cp` 出来的 `.env` 逐字节相同，
    // 上面那些格子（名字集合、能不能起来）对这种改法全都是绿的，这正是本格存在的理由。
    const liveNames = (s: string) => s.split("\n").flatMap((l) => {
      const m = new RegExp(DECLARATION).exec(l);
      return m && m[1] !== "#" ? [`${m[2]!}=${m[3]!}`] : [];
    });
    expect(liveNames(mutated), "变异不该动到没被注释掉的那些声明").toEqual(liveNames(src));
    expect(commentLines(mutated)).toBeLessThan(MIN_COMMENT_LINES);
  });

  /**
   * **认不出要吵**：文件读空 / 路径写错时，两条 `toBeGreaterThanOrEqual` 会一起红，
   * 但报文会指向「文件缩水了」这个**错误的方向**。这一格先把「真的读到东西了」钉下来。
   */
  it("认不出要吵：真的读到了一份非空的 .env.example", () => {
    const src = envExample();
    expect(src.length, ".env.example 读出来是空的 —— 判据的落点变了，别把它报成「文件缩水」").toBeGreaterThan(0);
    expect(src, ".env.example 里一条声明都没有 —— 读到的多半不是那份文件").toMatch(new RegExp(DECLARATION, "m"));
  });
});
