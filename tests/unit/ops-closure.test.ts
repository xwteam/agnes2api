import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APIKEY_KEY } from "../../src/http/apikey-store.js";
import { CONFIG_KEY } from "../../src/core/config-provenance.js";
import { POOL_INDEX_KEY } from "../../src/core/pool-index.js";
import { TEND_HISTORY_KEY } from "../../src/core/admin/tend-history.js";
import { DOMAIN_LEDGER_KEY } from "../../src/core/registrar/domain-ledger.js";
import { REGISTRAR_BACKOFF_KEY } from "../../src/core/registrar/backoff.js";

/**
 * # 运维闭环：从「改一行配置」到「升级、回滚、排障、恢复」这一整条路上的判据
 *
 * 本组守的是**部署形态的活文件**（`docker-compose.yml` / `docker-entrypoint.sh` /
 * `.env.example`）与**五语言 `docs/<语言>/DEPLOY.md`** 之间那几条对得上才成立的话。
 * 它不重复实现别处已经有的东西：五份文档的结构对等（标题层级、围栏序列、链接多重集、
 * 表格行数、标识符 code span）在 `tests/unit/docs-parity.test.ts` 的
 * 「五语言文档的派生结构对等」那一组里跑着；长度棘轮在
 * `tests/unit/docs-typography.test.ts` 的「A（棘轮）：>1200 字符的区间数不许比登记值多」；
 * `.env.example` 的清单齐不齐在 `tests/unit/env-example-parity.test.ts` 的
 * 「.env.example 与真源对齐」那一组。**本组只管「这几句话在不在、指的是不是同一件事」。**
 *
 * ── 每一格背后的那条失效链（写清楚，别只留一个用例名）────────────────────────
 *
 * ① **`DATA_DIR` 与卷挂载**。`src/entry/node.ts` 只把**空串**归一成 `/app/data`；
 *    `DATA_DIR=/app/store` 这种「非空但底下没挂卷」的值一路畅通，`/health` 回 ok、
 *    面板与 key 池一切正常，而 store.json 落在容器可写层 ⇒ 容器一重建整池 key 静默蒸发。
 *    处置分两半：`docker-entrypoint.sh` 在启动时把它喊出来（这条链上唯一的信号），
 *    五份 `DEPLOY.md` 的 Docker「配置」节把它写下来。两半各有判据，见下面 A / H 两组。
 *
 * ② **回滚**。`docker-compose.yml` 此前把镜像写死成 `:latest`，而文档里一句
 *    「把 tag 钉回上一版」既没说镜像叫什么、也没说钉在哪个文件。现在镜像 tag 走
 *    `${IMAGE_TAG:-latest}` 插值，五份文档写全镜像名与 tag 列表的位置。见 B 组。
 *
 * ③ **「升级压根没发生」**。升级后的三条确认在旧版本上一字不差地全绿，而 `/health`
 *    早就带着 `version`。见 E 组。
 *
 * ④ **备份清单**。此前只列 `pool:index` 与 `key:<id>` 两族，照它恢复会静默
 *    吊销全部已签发的对外 API 密钥、丢掉面板配置与注册机状态。见 F 组——那几个键名
 *    **一律从真源常量 import**，不在本文件手抄字符串。
 *    ⚠️ 这一条原来点的是「**Worker 的**备份清单」，v0.4.0 之后那条部署路没了；
 *    F 组因此从四格收成两格，逐格交代写在那一组头上。
 *
 * ── 它验不了什么（明写）──────────────────────────────────────────────────
 * · 「`docker compose restart` 不重读 `.env`」这句话**本身**是 compose 的行为，本仓的
 *   判据够不着它（跑一次真 compose 才验得了；复核那一轮实测过：`restart` 之后容器 ID
 *   不变、`printenv` 还是旧值，`up -d` 则打出 `Recreated`）。C 组钉的只是**这句话在不在
 *   五份文档里**——话说错了要靠评审，话没了要靠这一格。
 * · 译文说得对不对、五份说的是不是同一件事，同样只能靠评审（与
 *   `tests/unit/docs-parity.test.ts` 文件头那条边界同一条）。
 */

const LANGS = ["zh-CN", "zh-TW", "en", "ja", "ko"] as const;
type Lang = (typeof LANGS)[number];

const ENTRYPOINT = "docker-entrypoint.sh";
const COMPOSE = "docker-compose.yml";
const ENV_EXAMPLE = ".env.example";

const read = (p: string): string => readFileSync(p, "utf8");
const deploy = (lang: Lang): string => read(join("docs", lang, "DEPLOY.md"));

/* ══ 小节切片：靠**下标**对齐五种语言，不靠一张 5×N 译名表 ═══════════════════
 *
 * 标题文本逐语言不同，但**标题层级序列**逐语言相同——那是
 * `tests/unit/docs-typography.test.ts` 的「C：七类文档的标题**层级序列**五语言逐份相等
 *（只比层级，不比文本）」钉着的性质。⇒ 「第 k 个 `##`」在五份里指的必然是同一节，
 * 于是本组用下标切片，一个译名表都不用手写。
 *
 * ⚠️ **这个便利建立在那一格之上**：那一格哪天被删掉或放宽，本组的切片会静静地开始
 * 指向别的小节。所以下面第一格拿 zh-CN 的那几个下标标题**逐字对**一次期望值：
 * 文档被重排时它先红，报文直说「先看这里」，而不是让后面几格报出一堆看不懂的缺句。
 */

/**
 * 每一行 + 它在不在围栏里。
 *
 * ⚠️ **切片保留围栏里的行，只有「找标题」那一步剥。** 本组要查的东西一半住在
 * ```bash 围栏里（`docker compose ps` / `docker compose logs` / `kv key get` 那几条），
 * 剥掉围栏再切片的话，那几格会因为「这一节里什么都没有」而**平凡地红**，
 * 报文还会指着一个错误的方向（说文档没写，其实是判据看不见）。
 * 反过来，标题判定必须剥围栏：本仓的 ```bash 注释就以 `# ` 开头。
 */
const lines = (text: string): ReadonlyArray<{ line: string; fenced: boolean }> => {
  let inFence = false;
  return text.split("\n").map((line) => {
    if (/^[ \t]*```/.test(line)) { inFence = !inFence; return { line, fenced: true }; }
    return { line, fenced: inFence };
  });
};

/** 第 `h2` 个 `##` 小节（含它下面全部 `###` 与围栏原文）。 */
const h2Section = (text: string, h2: number): string[] => {
  const rows = lines(text);
  const starts = rows.flatMap((r, i) => (!r.fenced && /^## /.test(r.line) ? [i] : []));
  const from = starts[h2];
  if (from === undefined) throw new Error(`这份文档没有第 ${h2} 个 \`##\` —— 切片坏了，不许静默返回空`);
  return rows.slice(from, starts[h2 + 1] ?? rows.length).map((r) => r.line);
};

/** 第 `h2` 个 `##` 下的第 `h3` 个 `###` 小节。 */
const h3Section = (text: string, h2: number, h3: number): string[] => {
  const rows = lines(h2Section(text, h2).join("\n"));
  const starts = rows.flatMap((r, i) => (!r.fenced && /^### /.test(r.line) ? [i] : []));
  const from = starts[h3];
  if (from === undefined) {
    throw new Error(`第 ${h2} 个 \`##\` 下没有第 ${h3} 个 \`###\` —— 切片坏了，不许静默返回空`);
  }
  return rows.slice(from, starts[h3 + 1] ?? rows.length).map((r) => r.line);
};

/**
 * 本组用到的那几个下标。名字是给读的人用的，判据只认下标。
 *
 * ⚠️ **v0.4.0 摘掉 Cloudflare Worker 形态之后这张表整体前移过一次**：五份 DEPLOY.md
 * 少了两个 `##`（「选哪种形态」与 Worker 部署那一节），`backupWorker` 那一行连同
 * 它那一格用例一起删（下面 F 组有交代）。下标是**当场从 `docs/zh-CN/DEPLOY.md` 数出来
 * 再逐份核过五语言的**，不是推算的；下面那格「小节切片自守」就是它的绊线。
 */
const AT = {
  dockerConfig: [2, 1],
  dockerVerify: [2, 3],
  dockerUpdate: [2, 4],
  faq: 6,
  faqDegraded: [6, 6],
  upgradeBefore: [9, 0],
  upgradeAfter: [9, 1],
} as const;
const backupDocker: readonly [number, number] = [10, 0];
/** 「里面有什么」那一节：备份清单逐族点名住在这里。 */
const backupContents: readonly [number, number] = [10, 1];

/** 「这些语言的那一节里没有这个锚」——五种语言一起报，缺一份就点名一份。 */
const langsMissing = (needle: string, pick: (lang: Lang) => string): Lang[] =>
  LANGS.filter((lang) => !pick(lang).includes(needle));

describe("小节切片自守：下标指到的还是那几节", () => {
  /**
   * 拿 zh-CN 逐字对一次。**只对 zh-CN 一份**：其余四份由层级序列那一格保证同构，
   * 在这里再抄四份译名就又造出一张会发霉的手写表。
   */
  it("zh-CN/DEPLOY.md 的那几个下标，指到的还是「Docker 部署 / 常见问题 / 升级服务 / 备份和恢复」那几节", () => {
    const t = deploy("zh-CN");
    const title = (rows: readonly string[]): string => rows[0]?.trim() ?? "";
    expect({
      dockerConfig: title(h3Section(t, ...AT.dockerConfig)),
      dockerVerify: title(h3Section(t, ...AT.dockerVerify)),
      dockerUpdate: title(h3Section(t, ...AT.dockerUpdate)),
      faqDegraded: title(h3Section(t, ...AT.faqDegraded)),
      upgradeAfter: title(h3Section(t, ...AT.upgradeAfter)),
      upgradeBefore: title(h3Section(t, ...AT.upgradeBefore)),
      backupDocker: title(h3Section(t, ...backupDocker)),
      backupContents: title(h3Section(t, ...backupContents)),
    }, "DEPLOY.md 被重排了，本组的下标切片已经指到别的小节上 —— 先在这里把下标改对，"
      + "再去看下面那些格的报文；否则它们会报出一堆看不懂的「这一节里没这句话」").toEqual({
      dockerConfig: "### 配置",
      dockerVerify: "### 验证",
      dockerUpdate: "### 更新",
      faqDegraded: "### Docker 容器起来了，但 `/health` 是 degraded",
      upgradeAfter: "### 升级之后确认什么",
      upgradeBefore: "### 升级前",
      backupDocker: "### 怎么备份",
      backupContents: "### 里面有什么，以及为什么挑着抄是个坑",
    });
  });

  it("认不出要吵：下标越界时当场抛，不静默返回空正文（空正文会让下面每一格都平凡地绿）", () => {
    expect(() => h2Section(deploy("zh-CN"), 99)).toThrow(/切片坏了/);
    expect(() => h3Section(deploy("zh-CN"), 2, 99)).toThrow(/切片坏了/);
  });
});

/* ══ A —— entrypoint 的挂载点探测 ═════════════════════════════════════════ */

/**
 * 把 `docker-entrypoint.sh` 跑起来，`DATA_DIR` 与挂载表都由本函数喂。
 *
 * 三个桩：`id`（让脚本走 root 那条完整分支，并给出镜像里 app 的 uid/gid）、
 * `chown`、`su-exec`（脚本最后一行是 `exec su-exec app:app "$@"`，桩直接退出 0）。
 * `AGNES_MOUNTINFO` 是真源里为这件事留的口子——`/proc/self/mountinfo` 在测试进程里
 * 伪造不了，而这段逻辑恰恰只能拿伪造的挂载表去验，理由逐字写在真源那段注释里。
 */
const runEntrypoint = (dataDir: string, mountLines: readonly string[]): { code: number; err: string } => {
  const dir = mkdtempSync(join(tmpdir(), "ops-entrypoint-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const stub = (name: string, body: string): void => {
      const p = join(bin, name);
      writeFileSync(p, body);
      chmodSync(p, 0o755);
    };
    stub("id", "#!/bin/sh\ncase \"$*\" in\n  '-u app') echo 100 ;;\n  '-g app') echo 101 ;;\n  *) echo 0 ;;\nesac\n");
    stub("chown", "#!/bin/sh\nexit 0\n");
    stub("su-exec", "#!/bin/sh\nexit 0\n");
    const mi = join(dir, "mountinfo");
    writeFileSync(mi, `${mountLines.join("\n")}\n`);
    const r = spawnSync("sh", [ENTRYPOINT, "/bin/true"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, DATA_DIR: dataDir, AGNES_MOUNTINFO: mi },
    });
    return { code: r.status ?? -1, err: r.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** mountinfo 的一行：判据只看第 5 个字段（挂载点路径），其余字段照真实格式填。 */
const mountLine = (at: string): string => `36 35 0:32 / ${at} rw,relatime shared:1 - ext4 /dev/sda1 rw`;

/** 警告文案里那个不许漂的锚。真源与本文件共用这一个串。 */
const NOT_ON_MOUNT = "没有落在任何挂载点上";

describe("A entrypoint：DATA_DIR 没落在挂载点上时必须喊出来", () => {
  it("射程自守：真源里确实有这段探测，而且它在**非 root 早退之前**（两条分支都要被它管住）", () => {
    const src = read(ENTRYPOINT);
    const probe = src.indexOf("data_dir_on_mount() {");
    const call = src.indexOf(`if ! data_dir_on_mount "$DATA_DIR"; then`);
    const nonRootExit = src.indexOf('if [ "$(id -u)" != "0" ]; then');
    expect(probe, `${ENTRYPOINT} 里没有 data_dir_on_mount —— 探测整段没了`).toBeGreaterThan(-1);
    expect(call, `${ENTRYPOINT} 里没有调用 data_dir_on_mount —— 函数定义着没人用，等于没有`).toBeGreaterThan(call - 1);
    expect(call, "探测定义了却没被调用").toBeGreaterThan(probe);
    expect(
      call,
      "挂载点警告被挪到了非 root 早退（`exec \"$@\"`）之后 ⇒ `--user` / compose 的 `user:` "
      + "那条分支上一个字都看不到。那条分支恰恰是「属主与可写性你自己准备」的部署，更需要这条警告",
    ).toBeLessThan(nonRootExit);
  });

  it("DATA_DIR 就是挂载点 ⇒ 不吭声", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-data-"));
    try {
      const r = runEntrypoint(dir, [mountLine(dir), mountLine("/etc/hosts")]);
      expect(r.err, `挂载好好的却报了警告 —— 这条警告会被训练成噪声：\n${r.err}`).not.toContain(NOT_ON_MOUNT);
      expect(r.code, "脚本没能正常走完").toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("DATA_DIR 非空、底下没挂任何卷 ⇒ 警告里点名 DATA_DIR，并说清「容器一重建就没了」", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-data-"));
    try {
      // 这正是那条失效链的形态：卷挂在别处（`<tmp>/mounted`），DATA_DIR 指向没挂载的地方。
      const r = runEntrypoint(join(dir, "store"), [mountLine(join(dir, "mounted"))]);
      expect(r.err, "非空但没挂载的 DATA_DIR 一声不吭 —— 那条链上就再也没有信号了").toContain(NOT_ON_MOUNT);
      expect(r.err, "警告里没写是哪个路径").toContain(join(dir, "store"));
      expect(r.err, "警告只说「没挂载」而不说后果，读的人不会当回事").toContain("重建");
      expect(r.code, "警告不该影响启动：探测只报，不拦").toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("不乱红：祖先目录被整个挂出来（`-v vol:/app` 那种）⇒ 数据是持久的，不许报", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-data-"));
    try {
      // 只挂 `<tmp>`，DATA_DIR 是 `<tmp>/data`：它自己不是挂载点，数据却在卷上。
      const r = runEntrypoint(join(dir, "data"), [mountLine(dir)]);
      expect(
        r.err,
        "祖先挂载被判成「没挂载」⇒ 把整个 /app 挂出来的部署每次启动都吃一条假警告。"
        + "判据要走到 `/` 才罢休（`/` 是 overlay 可写层，它不算数）",
      ).not.toContain(NOT_ON_MOUNT);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("读不到挂载表就闭嘴：判不了的时候不许报（一条判不准的警告只会训练人忽略警告）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-data-"));
    try {
      const r = spawnSync("sh", [ENTRYPOINT, "/bin/true"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(dir, "nope")}:${process.env.PATH ?? ""}`,
          DATA_DIR: dir,
          AGNES_MOUNTINFO: join(dir, "there-is-no-such-file"),
        },
      });
      expect(r.stderr ?? "", "挂载表读不到时报了警告 —— 非 Linux / 没挂 /proc 的环境上会天天见到它")
        .not.toContain(NOT_ON_MOUNT);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/* ══ B —— 回滚的抓手：IMAGE_TAG 与镜像全名 ════════════════════════════════ */

/** `docker-compose.yml` 里那行 `image:` 的取值，**从真源现读**，不在本文件手抄镜像名。 */
const composeImage = (): string => {
  const m = /^\s{4}image:\s*(\S+)\s*$/m.exec(read(COMPOSE));
  if (m === null) throw new Error(`${COMPOSE} 里读不出 image: 那一行 —— 判据坏了，不许静默跳过`);
  return m[1] as string;
};

describe("B 回滚有抓手：镜像 tag 可钉、镜像名文档里查得到", () => {
  it("compose 的镜像 tag 走 `${IMAGE_TAG}` 插值，且不设时回落 `latest`（不是破坏性变更）", () => {
    expect(
      composeImage(),
      "镜像 tag 又被写死了 ⇒ `docker compose ps` 与这份文件都答不出「现在跑的是哪一版」，"
      + "而文档里那句「把 tag 钉回上一版」重新变成一句没有落点的话",
    ).toBe("ghcr.io/xwteam/agnes2api:${IMAGE_TAG:-latest}");
  });

  it("镜像全名（从 compose 现算）在五份 DEPLOY.md 里逐份写着 —— 此前 `ghcr` 在文档里零命中", () => {
    // 去掉 tag 那一段（`:latest` 与 `:${IMAGE_TAG:-latest}` 两种形态都要去干净）：
    // 本格查的是**镜像名**在不在文档里，tag 长什么样是上一组「镜像 tag 走插值」那几格的事。两格混在一起的话，
    // 有人把 tag 写死回去时这一格会跟着红，报文却在说「文档里没有镜像名」——指错方向。
    const name = composeImage().replace(/:[^/]*$/, "");
    expect(name, "从 compose 抠出来的镜像名不像个镜像名 —— 判据坏了").toMatch(/^ghcr\.io\//);
    expect(
      langsMissing(name, deploy),
      `这些语言的 DEPLOY.md 里查不到镜像全名 ${name} ⇒ 运维回滚时只能现去 GHCR 翻`,
    ).toEqual([]);
  });

  it("`IMAGE_TAG` 这个名字五份 DEPLOY.md 逐份点到（不点名就等于没给抓手）", () => {
    expect(langsMissing("IMAGE_TAG", deploy), "这些语言没提 IMAGE_TAG").toEqual([]);
  });

  it("tag 列表去哪儿看，五份逐份给了地址", () => {
    expect(
      langsMissing("/pkgs/container/agnes2api", deploy),
      "这些语言没给 GHCR 的 packages 页 ⇒ 「钉回上一版」里的「上一版」是多少，文档答不出",
    ).toEqual([]);
  });

  it("「回滚前先确认那个 tag 在 registry 上存在」五份逐份写着 —— 敲错 tag 会静默变成本地构建", () => {
    // 实测（compose 干跑）：写已发布的 `:0.2.2` ⇒ `Pulling`/`Pulled`；写不存在的 `:0.2.9`
    // ⇒ `not found` ⇒ `Building` ⇒ `naming to ghcr.io/xwteam/agnes2api:0.2.9`。
    // 也就是说回滚会「成功」而故障照旧——这句话是那次实测的文档侧落点。
    expect(langsMissing("registry", deploy), "这些语言没写「先确认 tag 真的存在」那一句").toEqual([]);
  });

  it("`IMAGE_TAG` 刻意不进 `.env.example` —— 这条裁定写在 compose 注释里，得有判据钉着", () => {
    // 那份文件的头一句是「列出网关认得的**每一个**环境变量」，而网关根本不读 IMAGE_TAG。
    // 塞进去要么让那句话当场变假，要么逼 `tests/unit/env-example-parity.test.ts` 的
    // 「反向控制：.env.example 里出现的变量不许是真源里没有的（防写错名字）」长出第二张
    // 手写豁免表。哪天有人决定要塞，这一格逼他先回到 compose 那段注释上表态。
    expect(
      read(ENV_EXAMPLE).includes("IMAGE_TAG"),
      `${ENV_EXAMPLE} 里出现了 IMAGE_TAG。它是 compose 自己插值用的、网关不读 —— `
      + `要么把它删掉（教人在哪儿写它是 DEPLOY.md 的活），要么先去改 ${COMPOSE} 里那段说明`
      + "并给 env-example-parity 那张豁免表加一类",
    ).toBe(false);
    expect(read(COMPOSE), "compose 那段说明没了，这一格就成了没有出处的洁癖")
      .toContain(`刻意不进 \`${ENV_EXAMPLE}\``);
  });
});

/* ══ C —— 改完 .env 要重建，不是 restart ══════════════════════════════════ */

describe("C 五份 DEPLOY.md 都写着「`docker compose restart` 不重读 .env」这条反例", () => {
  it("五份逐份出现 `docker compose restart`（写下这一格之前，全仓这个词零命中）", () => {
    expect(
      langsMissing("docker compose restart", deploy),
      "这些语言没写那条反例 ⇒ 用户按 FAQ 补完 ADMIN_TOKEN、直觉地 restart 一下、仍然 404，"
      + "于是被 FAQ 的下一条引到「口令不合规」这个错误分支上去",
    ).toEqual([]);
  });

  it("那条反例住在 Docker 的「更新」小节里，而不是散落在文档某处", () => {
    expect(
      LANGS.filter((l) => !h3Section(deploy(l), ...AT.dockerUpdate).join("\n").includes("docker compose restart")),
      "这些语言把那条反例挪出了「更新」小节 —— 改 `.env` 之后该跑哪条命令，读者正是在这一节找",
    ).toEqual([]);
  });

  it("`.env.example` 里教口令轮换的那一段也把命令给全了 —— 轮换是这条坑最贵的那次踩法", () => {
    // 那一段原文只写「Docker 重建容器」。轮换时踩这个坑的后果不是「白忙一场」，
    // 是**你以为旧口令失效了而它还在生效**——按已泄漏处置的安全流程会因此静默失败。
    const src = read(ENV_EXAMPLE);
    // 🔴 **v0.4.0 换了落点**：上一版锚的是那一段里的 `wrangler secret put ADMIN_TOKEN`
    // （Worker 那一半的轮换命令），摘掉形态之后那半句删了。锚改成这一段自己的开头，
    // **这一格守的两件事一个字没变**：给出 `docker compose up -d`，并写出
    // `docker compose restart` 不重读 `.env` 这条反例。
    const at = src.indexOf("面板不能自助轮换自己的钥匙");
    expect(at, `${ENV_EXAMPLE} 里找不到讲口令轮换的那一段 —— 判据落点变了`).toBeGreaterThan(-1);
    const para = src.slice(at, at + 400);
    expect(para, "轮换那一段只说「重建容器」而没给命令").toContain("docker compose up -d");
    expect(para, "轮换那一段没写 `docker compose restart` 不重读 .env 这条反例")
      .toContain("docker compose restart");
  });

  it("面板 404 那条 FAQ 先问「容器真的重建过吗」，再谈口令合不合规（顺序反了等于没写）", () => {
    const faq = (l: Lang): string[] => {
      const rows = h2Section(deploy(l), AT.faq);
      const at = rows.findIndex((x) => x.includes("`/admin`"));
      return rows.slice(at, at + 20);
    };
    const wrong = LANGS.filter((l) => {
      const rows = faq(l);
      const recreate = rows.findIndex((x) => x.includes("docker compose up -d"));
      const token = rows.findIndex((x) => x.includes("admin.token_rejected"));
      return recreate < 0 || token < 0 || recreate > token;
    });
    expect(wrong, "这些语言的 404 FAQ 里，「先确认容器重建过」不在「口令不合规」之前").toEqual([]);
  });
});

/* ══ D —— 排障反复引用的那两条命令 ════════════════════════════════════════ */

describe("D 「见容器日志」终于有命令了", () => {
  for (const cmd of ["docker compose logs", "docker compose ps"]) {
    it(`五份 DEPLOY.md 逐份给出 \`${cmd}\``, () => {
      expect(
        langsMissing(cmd, deploy),
        `这些语言的 DEPLOY.md 里没有 ${cmd} ⇒ 排障章节把人指向一个没给命令的地方`,
      ).toEqual([]);
    });
  }

  it("那两条落在 Docker 的「验证」小节里 —— 后面的 FAQ 才引得动它们", () => {
    const wrong = LANGS.flatMap((l) => {
      const sec = h3Section(deploy(l), ...AT.dockerVerify).join("\n");
      return ["docker compose logs", "docker compose ps"].filter((c) => !sec.includes(c)).map((c) => `${l}:${c}`);
    });
    expect(wrong, "这些语言的「验证」小节里没有那两条命令").toEqual([]);
  });
});

/* ══ E —— 升级之后确认什么 ════════════════════════════════════════════════ */

describe("E 升级后的确认清单里有 `version`，不再是三条与版本无关的检查", () => {
  it("五份的「升级之后确认什么」里都出现 `version` —— 它是唯一分得开新旧构建的东西", () => {
    expect(
      LANGS.filter((l) => !h3Section(deploy(l), ...AT.upgradeAfter).join("\n").includes("version")),
      "这些语言的升级确认清单一个字没提 `version` ⇒ 三条确认在「镜像压根没换」时全部通过，"
      + "运维会写下「已升级到 x.y.z」而线上还是旧版",
    ).toEqual([]);
  });

  it("「升级前」记基线那一条也在（没有基线，E1 那半句无从比对）", () => {
    expect(
      LANGS.filter((l) => !h3Section(deploy(l), ...AT.upgradeBefore).join("\n").includes("version")),
      "这些语言的「升级前」没让人记下当前 version",
    ).toEqual([]);
  });

  it("`/health` 回的 version 就是编译期常量本身 —— 前两格教人去比的字段真的分得开新旧构建", async () => {
    // 走**真装配**（`buildApp`）而不是测试夹具：夹具注入的是一个固定的假版本号，
    // 拿它当判据只能证明「有这么个字段」，证明不了「它等于这次构建烧进去的那个值」。
    const { buildApp } = await import("../../src/http/wire.js");
    const { nodeRuntime } = await import("../../src/adapters/runtime-node.js");
    const { MemoryStorage } = await import("../helpers/fake-storage.js");
    const { VERSION } = await import("../../src/version.js");
    const { app } = await buildApp({ GATEWAY_TOKEN: "ops-closure-token" }, new MemoryStorage());
    const body = await (await app.request("/health")).json() as { version?: string };
    expect(
      body.version,
      "/health 回的 version 不再是 src/version.ts 那个编译期常量 ⇒ 升级清单里「version 等于"
      + "你这次升的版本号」那半句失去落点，三条确认又回到「旧版本上全绿」的老样子",
    ).toBe(VERSION);
  });
});

/* ══ F —— 备份清单 ═══════════════════════════════════════════════════════ */

/**
 * 备份漏掉就会静默出事的那几族键。**键名一律从真源常量 import**——手抄一份字符串，
 * 常量哪天改名这一格会安安静静地继续绿着，而文档里那几个名字已经指不到任何东西。
 */
const BACKUP_KEYS: ReadonlyArray<readonly [key: string, why: string]> = [
  [APIKEY_KEY, "已签发的对外 API 密钥表：不恢复它 = 把所有子密钥一次吊销，而明文只在签发那一次给过"],
  [CONFIG_KEY, "面板保存的配置，含网关口令与两条邮箱通道的凭据"],
  [DOMAIN_LEDGER_KEY, "注册机的域名可用性台账"],
  [REGISTRAR_BACKOFF_KEY, "注册机的退避账"],
  [TEND_HISTORY_KEY, "补池历史"],
  [POOL_INDEX_KEY, "key 池索引 —— 它本来就在清单上，留着当**非空锚**：连它都查不到就是判据瞎了"],
];

describe("F 备份清单不再只有两族键", () => {
  it("非空锚：这张表上的键名都不是空串（常量拿错会让下面几格平凡地全绿）", () => {
    expect(BACKUP_KEYS.filter(([k]) => k.trim() === "").map(([, why]) => why)).toEqual([]);
    expect(BACKUP_KEYS.length, "表被清空了").toBeGreaterThan(5);
  });

  /*
   * ⚠️⚠️ **这一组原来是四格，v0.4.0 删掉两格，逐格交代：**
   * · 「Worker 备份那一节里，每一族键都被点名（五语言逐份）」——**整格的被测对象是
   *   五份 DEPLOY.md 里的 `### Cloudflare Worker` 备份小节**，那一节随 Worker 形态一起
   *   从文档里删了。**它守的那条不变量没有消失**，由下面那一格接着守：备份清单漏掉
   *   `apikeys` 的后果（照它恢复之后每个下游用户的子密钥全部 401、而运维在恢复现场
   *   完全看不到）与走哪条部署路无关。
   * · 「`kv key list` 那句收口在」——它钉的是「Worker 侧那段 `wrangler kv key list`
   *   的措辞不许退回『逐个 key:<id> 取出来即可』」。**那一段整段没了。**
   *   同一条纪律（备份就是备份存储本身，不许挑着抄）今天由 Docker 侧的
   *   `cp -a ./data` 与下面那一格一起承担。
   *
   * 🟡 **如实登记一处判别力下降**：删掉的第一格是**逐族点名**（`BACKUP_KEYS` 每一族
   * 都要在那一节里出现），而留下的这一格只点名 `apikeys` 一族。要补的话是把
   * `BACKUP_KEYS` 整张表挂到「里面有什么」那一节上；这次没做，因为口径是
   * 「摘形态、不新增覆盖」。
   */

  it("备份「里面有什么」那一节点名 `apikeys` —— 漏了它，照清单恢复会静默吊销全部已签发的子密钥", () => {
    expect(
      LANGS.filter((l) => !h3Section(deploy(l), ...backupContents).join("\n").includes(APIKEY_KEY)),
      "这些语言在备份那一节仍然断言「就是全部」却漏了对外 API 密钥表 ⇒ "
      + "照它恢复：上游 key 池回来了、/health 回 ok、自己拿 GATEWAY_TOKEN 一测也通，"
      + "而每一个下游用户手上的子密钥全部 401 —— 运维在恢复现场完全看不到这件事发生",
    ).toEqual([]);
  });
});

/* ══ G —— degraded 的第四档 ═══════════════════════════════════════════════ */

describe("G `/health` degraded 的排障不再只有权限一族", () => {
  it("五份的 degraded FAQ 至少有四条处置，第四条落在「store.json 解析不了」上", () => {
    const wrong = LANGS.filter((l) => {
      const sec = h3Section(deploy(l), ...AT.faqDegraded).join("\n");
      return !sec.includes("json.tool") || !/^4\. /m.test(sec);
    });
    expect(
      wrong,
      "这些语言的 degraded FAQ 还是三条清一色的属主/权限 ⇒ store.json 被手工编辑写坏时"
      + "（`stat` 每次都对、故障却不动），排障会卡在反复 chown 上。"
      + "⚠️ 注意这一档**不含**「磁盘写满导致截断」：`src/adapters/storage-file.ts` 的写路径是"
      + "临时文件 + rename 原子替换、失败即 unlink，ENOSPC 不会留下半截文件",
    ).toEqual([]);
  });
});

/* ══ H —— DATA_DIR 与卷挂载的文档侧 ═══════════════════════════════════════ */

describe("H DATA_DIR 与卷挂载绑死这件事，文档里写着", () => {
  /** compose 里那条绑定挂载，**从真源现读**：它改了，下面这几格要求文档跟着改。 */
  const mountSpec = (): string => {
    const m = /^\s{6}-\s*(\.\/data:\S+)\s*$/m.exec(read(COMPOSE));
    if (m === null) throw new Error(`${COMPOSE} 里读不出 ./data 那条绑定挂载 —— 判据坏了`);
    return m[1] as string;
  };

  it("五份 DEPLOY.md 的 Docker「配置」节里都有一条 alert 写着这件事", () => {
    const spec = mountSpec();
    const wrong = LANGS.filter((l) => {
      const sec = h3Section(deploy(l), ...AT.dockerConfig).join("\n");
      // ⚠️ **判据是「住在 alert 块里」，不是「用的是哪个 alert 关键字」**：
      // GitHub 的 alert 有 NOTE/TIP/IMPORTANT/WARNING/CAUTION 五种，这一条用
      // WARNING 还是 CAUTION 是文档那一面的编辑取舍（v0.4.0 那一轮从 WARNING 改成了
      // CAUTION），而这一格要守的是「它没有退回一段普通散文」。
      const alert = sec.includes("> [!WARNING]") || sec.includes("> [!CAUTION]");
      return !alert || !sec.includes(spec) || !sec.includes("DATA_DIR");
    });
    expect(
      wrong,
      `这些语言的 Docker「配置」节里没有那条警示（要点名 ${spec} 与 DATA_DIR，且住在 alert 块里）⇒ `
      + "运维改一行 .env、一切看起来都对，几周后升级时整池 key 静默蒸发",
    ).toEqual([]);
  });

  it("`.env.example` 头部也写着（那份文件是陌生人手里唯一一份带说明的模板）", () => {
    const header = read(ENV_EXAMPLE).split("\nGATEWAY_TOKEN=")[0] ?? "";
    expect(header, ".env.example 的头部没提 DATA_DIR 与卷挂载绑死这件事").toContain("DATA_DIR");
    expect(header, "头部提了 DATA_DIR 却没说它与 docker-compose 的卷绑死").toContain("docker-compose.yml");
  });

  it("`DATA_DIR` 那一行的表格说明里也留了钩子 —— 只看表的人同样要被拦一下", () => {
    const wrong = LANGS.filter((l) => {
      const row = deploy(l).split("\n").find((x) => x.startsWith("| `DATA_DIR`")) ?? "";
      return !/compose/i.test(row);
    });
    expect(wrong, "这些语言的 DATA_DIR 表格行没提 compose 的卷挂载").toEqual([]);
  });
});
