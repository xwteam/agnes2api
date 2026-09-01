import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * ── `scripts/smoke-dual-runtime.sh` 的元测试 ─────────────────────────────────
 *
 * 那份脚本是**双形态真机验收**的仪器：仓里有一批注释把自己的了结条件写成「等真机验收」，
 * 而它是那批注释唯一的了结方式。它跑一次要构建镜像、起容器、起真 workerd，
 * **这里一格都不跑它**——这里钉的是「它的判据没有被悄悄换成一个没有鉴别力的东西」。
 *
 * ⚠️ **这一族最要防的那件事有名字：把 ③ 的判据从「到达间隔」换成「拿到了几块」。**
 * 整体缓冲的实现**最终也会把全部内容交出来** ⇒ 只看总量是零鉴别力，而屏幕上照样全绿。
 * 本仓已经在同一个形态上栽过（CRLF 那一组明令禁止「往单块表里加一行 CRLF 样本」）。
 *
 * ── 判据只有一份，反向控制从同一份进 ────────────────────────────────────────
 * 每条判据都写成 `(read) => 失败报文[]` 的纯函数：真扫描传真 `read`，反向控制传打过补丁的
 * `read`。**没有第二份判据**，所以「探针绿了而真扫描是另一套逻辑」在这里不成立。
 * 每一格变异之前先跑一遍**基**（`probeBase`）：基本身就红的话，报文会直说去看真扫描那一格。
 *
 * ── 它做不到什么（明写）──────────────────────────────────────────────────────
 * · 它**只看脚本文本**：那五格在真机上跑出来是什么结果，这里一个字都不知道。
 *   ⑦ 真的跑起来是 `scripts/prepush.sh` 的事，而那份清单不是 CI 的一道门禁
 *   ⇒ **这份冒烟今天仍然没有自动回归网，只有「有人跑它的时候会红」**。
 * · 「零联网真上游」那一组只查脚本里**写死的 URL**：一个从环境变量拼出来的地址它看不见。
 *   本脚本今天没有那种写法，这条边界如实登记，没有护栏。
 */

const SMOKE = "scripts/smoke-dual-runtime.sh";
const USAGE_PURE = "admin-ui/js/pure/usage.mjs";

type Read = (p: string) => string;
const realRead: Read = (p) => readFileSync(p, "utf8");
const patchRead = (base: Read, at: string, body: string): Read => (p) => (p === at ? body : base(p));

/** 抠一个顶层函数体：从 `名字() {` 那一行到第一行顶格的 `}`。**抠不到要当场抛。** */
function fnBody(src: string, name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{[^\\n]*\\n([\\s\\S]*?)^\\}$`, "m").exec(src);
  if (!m) throw new Error(`${SMOKE} 里抠不出 ${name}() —— 判据坏了，不许静默跳过`);
  return m[1]!;
}

function probeBase(failures: string[], realCase: string): void {
  if (failures.length > 0) {
    throw new Error(
      "本格是探针，它的基取自真仓，而真仓今天本身就不过这条判据 —— "
      + `真因在「${realCase}」那一格：\n${failures.join("\n")}`,
    );
  }
}

const run = (...args: string[]) => {
  const r = spawnSync("bash", [SMOKE, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
};

/* ── ③ 的判据是到达间隔，不是块数 ─────────────────────────────────────────── */

const REAL_INTERVAL = "③ 的判据是「正文首末两块的到达间隔」，三个时刻一律只从带上游时间戳的正文行里取";

/**
 * ⚠️⚠️ **这一条被实测推翻过一次，推翻它的正是本文件顶上写的那种死法。**
 * 上一版查的是「`first_ms` 取探针输出的第一行（`NR==1`）」，而 `/v1/messages` 的第一行是
 * `event: message_start` —— `src/core/protocol/anthropic.ts` 的 `toAnthropicStream()` 里
 * 逐字写着它「**必须在读取上游之前产出**」⇒ 它的到达时刻与「正文有没有逐块流出来」
 * **在构造上无关**。实测（把正文增量攒完再一次性吐、preamble 保持早发）：
 * 那一格照样 PASS，屏幕上还打出一句「⇒ 都是逐块透传」。
 *
 * ⚠️ 五条一起查，缺一条这条判据就退化：
 * ① 三个时刻的来源行是**按上游时间戳挑出来的正文行**，不是探针输出的任意一行；
 * ② `first_ms` / `last_ms` 取的是那几行里的**首行 / 末行**的到达时刻；
 * ③ **不许再出现 `NR==1`** —— 那是被实测推翻的那种取法（否定式，见方法论「CLAIM_MARKERS 一族」）；
 * ④ 真的有那一句**铺开量与门槛**的比较（这是鉴别力所在）；
 * ⑤ 还有那一句**首块领先上游末块**的佐证比较。
 */
const intervalCriterionFailures = (read: Read): string[] => {
  const body = fnBody(read(SMOKE), "check_stream");
  const out: string[] = [];
  if (!body.includes(`body=$(grep -E '"text":"[0-9]{10,}"' "$out"`)) {
    out.push("三个时刻的来源行不再是「按上游时间戳挑出来的正文行」—— preamble 那两行会混进来，而它们在读上游之前就产出了");
  }
  if (!body.includes(`first_ms=$(printf '%s\\n' "$body" | head -n 1 | cut -f1)`)) {
    out.push("first_ms 取的不再是正文首块的到达时刻 —— 那就不是「第一块正文到达」了");
  }
  if (!body.includes(`last_ms=$(printf '%s\\n' "$body" | tail -n 1 | cut -f1)`)) {
    out.push("last_ms 取的不再是正文末块的到达时刻 —— 铺开量就没有来源了");
  }
  if (body.includes("NR==1")) {
    out.push("check_stream 里又出现了 NR==1（探针输出的第一行）—— 那是被实测推翻的取法：第一行是 message_start，它在读上游之前就产出，对正文缓冲零鉴别力");
  }
  if (!body.includes("(( spread < STREAM_SPREAD_MIN_MS ))")) {
    out.push("③ 的判据里没有那一句「铺开量 vs 门槛」的比较 —— 换成「拿到了几块」是零鉴别力：整体缓冲最终也会把全部内容交出来");
  }
  if (!body.includes("(( lead <= 0 ))")) {
    out.push("③ 少了「正文首块早于上游末块发出」那一句佐证比较");
  }
  return out;
};

/* ── ③ 的结论真的被那一格采纳 ────────────────────────────────────────────── */

const REAL_VERDICT_ADOPTED = "cell_stream_interval 真的把 check_stream 的返回值当成这一格的成败，两个形态各一处";

/**
 * ⚠️ **一个不会自己红的清单不是守卫，是待办。** 到达间隔那一组只看 `check_stream` 的函数体文本，
 * 而「函数写得再对，调用方把返回值吞掉」这一种死法它一个字都看不见 ——
 * 实测：把两处 `if ! check_stream …; then bad=1; fi` 换成 `check_stream … || true`，
 * 这份守卫 20 格全绿。这条判据补的就是那一格。
 */
const streamVerdictAdoptedFailures = (read: Read): string[] => {
  const body = fnBody(read(SMOKE), "cell_stream_interval");
  const out: string[] = [];
  for (const label of ["Docker", "Worker"]) {
    if (!new RegExp(`if ! check_stream "${label}" "[^"]+"; then bad=1; fi`).test(body)) {
      out.push(`cell_stream_interval 没把 ${label} 那次 check_stream 的返回值接进 bad —— ③ 可以被静默阉割而这份清单全绿`);
    }
  }
  if (!body.includes("if (( bad != 0 )); then return 1; fi")) {
    out.push("cell_stream_interval 不再按 bad 决定这一格的成败 —— 红了也会算 PASS");
  }
  return out;
};

/* ── 块数与门槛只有一份真源 ──────────────────────────────────────────────── */

const REAL_CHUNK_SOURCE = "stub 发几块、判据期望几块、铺开门槛多少 —— 三者同出 STUB_CHUNKS / STUB_GAP_MS 这一份定义";

/**
 * ⚠️ 上一版是**两个手抄数**：stub 里 `const CHUNKS = 4`，判据里 `(( deltas < 4 ))`。
 * 实测把 stub 那个改成 6 ⇒ 这份守卫 20 格全绿，而真跑时报文会说
 * 「少于上游发的 4 块」，**把人指去查网关，真因却在 stub** —— 「报文亲手把人引进坑」那一族。
 */
const chunkSourceFailures = (read: Read): string[] => {
  const src = read(SMOKE);
  const out: string[] = [];
  if (!/^STUB_CHUNKS=(\d+)$/m.test(src)) {
    throw new Error(`${SMOKE} 里读不出 STUB_CHUNKS —— 判据坏了，不许静默跳过`);
  }
  const chunks = Number(/^STUB_CHUNKS=(\d+)$/m.exec(src)![1]);
  if (chunks < 2) {
    out.push(`STUB_CHUNKS=${chunks} —— 少于 2 块时「首末两块的到达间隔」这个观测量不存在，③ 会变成零鉴别力`);
  }
  if (!src.includes("STREAM_SPREAD_MIN_MS=$(( (STUB_CHUNKS - 1) * STUB_GAP_MS / 2 ))")) {
    out.push("铺开门槛不再由 STUB_CHUNKS / STUB_GAP_MS 算出来 —— 那是个手抄的阈值，改了块数或间隔它不会跟着动");
  }
  // stub 的块数必须从命令行来：写死在 stub 里 ⇒ 与判据那一侧各自漂。
  if (!src.includes("const CHUNKS = Number(process.argv[4]);")) {
    out.push("stub 的块数不再从命令行来 —— 它会与判据那一侧的期望值各自漂，而报文会把人指错方向");
  }
  if (/const CHUNKS = \d/.test(src)) {
    out.push("stub 里又把块数写成了字面量 —— 这正是上一版那两个手抄数的死法");
  }
  // 两处起 stub 的地方都要把它传进去：宿主机那份 + compose 网络里那份。
  if (!src.includes('node "$TMP/upstream-stub.mjs" "$STUB_PORT" "$STUB_GAP_MS" "$STUB_CHUNKS"')) {
    out.push("宿主机那份 stub 起的时候没把 STUB_CHUNKS 传进去");
  }
  if (!src.includes('"${STUB_PORT_IN_NET}", "${STUB_GAP_MS}", "${STUB_CHUNKS}"')) {
    out.push("compose 网络里那份 stub 起的时候没把 STUB_CHUNKS 传进去 —— 两份 stub 会发不一样多的块");
  }
  const body = fnBody(src, "check_stream");
  if (!body.includes("(( deltas != STUB_CHUNKS ))")) {
    out.push("判据里期望的块数不是 STUB_CHUNKS —— 又变回手抄");
  }
  // `(( deltas == 0 ))` 那句是「一块都没到」的分流，允许；**除它之外**任何拿 deltas
  // 与字面量比的写法都是手抄回潮。
  const literals = [...body.matchAll(/\(\( deltas [^)]*?(\d+)/g)].map((m) => m[1]!);
  if (literals.some((n) => n !== "0")) {
    out.push(`判据里又出现了写死的块数（${literals.filter((n) => n !== "0").join(", ")}）—— 改 stub 的块数时它不会跟着动`);
  }
  return out;
};

/* ── override 不碰开发者的 ./data 与 .env ────────────────────────────────── */

const COMPOSE_FILE = "docker-compose.yml";
const REAL_DATA_ISOLATION = "override 把 /app/data 那条挂载改指临时目录、把 env_file 整条 !reset 掉，并在 up 之前回读核对";

/**
 * ⚠️ 实测过的后果（不是推的）：预置一份真 `data/store.json` 再整跑一次冒烟 ⇒
 * 假 key `sk-smoke-upstream-stub` 与它的用量统计被写进那份真 store.json，
 * 目录属主从 `ubuntu:ubuntu` 变成容器里那个 uid，**而屏幕上照样打
 * 「✅ 收尾完成，工作树与开跑前逐字一致」**（`data/` 在 `.gitignore` 里 ⇒
 * 那句话对 git 是真的、对机器是假的）。
 * ⚠️ 容器内那条目标路径**从基文件现读**：手抄一份 `/app/data` 的话，基文件哪天改了目标，
 * compose 就会合出**两条**挂载（它按目标路径认同一条），开发者的 `./data` 悄悄回来。
 */
const dataIsolationFailures = (read: Read): string[] => {
  const src = read(SMOKE);
  const compose = read(COMPOSE_FILE);
  const target = /^\s*-\s*\.\/data:(\/\S+)\s*$/m.exec(compose);
  if (target === null) {
    throw new Error(`${COMPOSE_FILE} 里认不出 ./data 那条绑定挂载 —— 判据坏了，不许静默跳过`);
  }
  // ⚠️ **只认真正写进 override 的那几行**：整份脚本里搜 `env_file: !reset []` 会搜到
  //   上面那段注释，于是「把 override 里那一行删掉」这条变异会**静静地绿**
  //   —— 本轮回填第一版就是这么写的，被自己的变异当场打红。
  const yml = /^  cat >"\$OVERRIDE" <<YML\n([\s\S]*?)^YML$/m.exec(src);
  if (yml === null) {
    throw new Error(`${SMOKE} 里读不出那段 compose override —— 判据坏了，不许静默跳过`);
  }
  const override = yml[1]!;
  const out: string[] = [];
  if (!src.includes('SMOKE_DATA_DIR="$TMP/data"')) {
    out.push("冒烟的 DATA_DIR 不再落在临时目录 —— 它会往开发者那份 store.json 里写假 key 并把目录 chown 走");
  }
  if (!override.includes('- "${SMOKE_DATA_DIR}:${COMPOSE_DATA_TARGET}"')) {
    out.push("override 里没有把那条绑定挂载改指临时目录（容器内那条路径必须现读，不许手抄）");
  }
  if (!src.includes("COMPOSE_DATA_TARGET=$(grep -oE '^[[:space:]]*-[[:space:]]*\\./data:/[^[:space:]\":]+' docker-compose.yml")) {
    out.push("容器内那条路径不再从 docker-compose.yml 现读 —— 基文件改了目标路径时会合出两条挂载，开发者的 ./data 又回来了");
  }
  if (!override.includes("env_file: !reset []")) {
    out.push("override 没把 env_file 整条 !reset 掉 —— 开发者的真 .env 会被整份灌进冒烟容器（实测 `env_file: []` 清不掉）");
  }
  if (!src.includes("if ! assert_override_took; then return 1; fi")) {
    out.push("up 之前不再回读 compose config 核对 —— 合并语义假定错了不会报错，会静静地放行");
  }
  const probe = fnBody(src, "assert_override_took");
  for (const [needle, why] of [
    ["hits.length !== 1", "回读里不再查「挂到那条目标路径的挂载恰好 1 条」"],
    ["hits[0].source !== src", "回读里不再查那条挂载的宿主侧就是本次的临时目录"],
    ["extra.length > 0", "回读里不再查「多出来的环境变量键」—— env_file 没被抹掉时它是唯一会说话的地方"],
  ] as const) {
    if (!probe.includes(needle)) out.push(why);
  }
  // 收尾不许再去动仓库根下的 ./data。
  const cleanup = fnBody(src, "cleanup");
  if (/rmdir data|\$PWD\/data/.test(cleanup)) {
    out.push("收尾里还在动仓库根下的 ./data —— 这一版根本不该碰它");
  }
  if (!cleanup.includes('rm -rf /t/data')) {
    out.push("收尾不再以 root 身份删临时 DATA_DIR —— 它被容器 chown 走之后宿主删不动，临时目录会一次次攒下来");
  }
  return out;
};

/* ── 收尾无条件 ───────────────────────────────────────────────────────────── */

const REAL_CLEANUP = "收尾是无条件的：trap 挂在 EXIT 上，容器 / wrangler / 临时目录三样都收，最后比一遍工作树";

const cleanupFailures = (read: Read): string[] => {
  const src = read(SMOKE);
  const out: string[] = [];
  if (!/^trap cleanup EXIT$/m.test(src)) {
    out.push("没有 `trap cleanup EXIT` ⇒ 中途失败时容器与 wrangler 会留在机器上");
  }
  const body = fnBody(src, "cleanup");
  const need: readonly (readonly [string, string])[] = [
    ["compose down -v", "收尾不关容器"],
    ["kill -TERM", "收尾不杀 wrangler"],
    ['rm -rf "$TMP"', "收尾不删临时目录"],
    ['if [[ $after != "$GIT_BASELINE" ]]; then', "收尾不再拿工作树与开跑前比 —— 探针留在树里就没人会发现"],
  ];
  for (const [needle, why] of need) if (!body.includes(needle)) out.push(why);
  return out;
};

/* ── 零联网真上游 ─────────────────────────────────────────────────────────── */

const REAL_UPSTREAM = "脚本里写死的每一个地址都指向本机或 compose 网络里那份 stub，没有一个真上游";

/** 允许出现的主机名。**这是一张白名单，不是黑名单**：多一个陌生主机就该红。 */
const LOCAL_HOSTS: readonly string[] = ["127.0.0.1", "smoke-upstream"];

const realUpstreamFailures = (read: Read): string[] => {
  const src = read(SMOKE);
  const urls = [...src.matchAll(/https?:\/\/([A-Za-z0-9._-]+)/g)].map((m) => m[1]!);
  if (urls.length === 0) {
    throw new Error(`${SMOKE} 里一个 URL 都没扫到 —— 判据坏了，不许静默当成「没有真上游」`);
  }
  return [...new Set(urls)]
    .filter((h) => !LOCAL_HOSTS.includes(h))
    .map((h) => `脚本里写着一个不是本机也不是 compose 网络内的地址：${h} —— 本期硬约束是「一个字节的真上游都不联网」`);
};

/* ── ④ 那一档的天数是现读的，不是手抄的 ──────────────────────────────────── */

const REAL_USAGE_DAYS = "④ 那一格的天数与 admin-ui/js/pure/usage.mjs 的 rangeToQuery() 对得上，且窗口按 (N−1) 天算";

const usageDaysFailures = (read: Read): string[] => {
  const pure = read(USAGE_PURE);
  const table = /"30d":\s*(\d+)/.exec(pure);
  if (table === null) {
    throw new Error(`${USAGE_PURE} 的 rangeToQuery() 里读不出 30d 那一档的天数 —— 判据坏了，不许静默跳过`);
  }
  const want = Number(table[1]);
  const src = read(SMOKE);
  const got = /^USAGE_RANGE_DAYS=(\d+)$/m.exec(src);
  if (got === null) {
    throw new Error(`${SMOKE} 里读不出 USAGE_RANGE_DAYS —— 判据坏了，不许静默跳过`);
  }
  const out: string[] = [];
  if (Number(got[1]) !== want) {
    out.push(`${SMOKE} 问的是 ${got[1]} 天，而面板那个按钮今天是 ${want} 天 —— 冒烟验的就不是那一档了`);
  }
  if (!src.includes("from=$(( to - (USAGE_RANGE_DAYS - 1) * DAY_MS ))")) {
    out.push("窗口不再按 `to − (N−1) 天` 算 —— 差一天的后果不是「多一天数据」，是 clamped 恒为真（真源那个函数上方写着全文）");
  }
  return out;
};

/* ── 干跑档与真跑的那几格是同一份表 ──────────────────────────────────────── */

const REAL_CELL_FN = "CELL_PLAN 里每一格的函数名都在脚本里真的定义了";

const cellFnFailures = (read: Read): string[] => {
  const src = read(SMOKE);
  const plan = /^CELL_PLAN=\(\n([\s\S]*?)^\)$/m.exec(src);
  if (plan === null) throw new Error(`${SMOKE} 里读不出 CELL_PLAN —— 判据坏了，不许静默跳过`);
  // ⚠️ **字符集里必须带数字**（本任务实测踩过）：写成 `[a-z_]+` 时 `cell_usage_30d`
  //   那一行根本匹配不上，判据于是**静静地少扫一格**——而它正是这一族要防的那种死法。
  //   下面那条条数自检就是为它加的：抠出来的名字数必须等于 CELL_PLAN 的行数。
  const fns = [...plan[1]!.matchAll(/\t([a-z0-9_]+)"$/gm)].map((m) => m[1]!);
  const lines = plan[1]!.split("\n").filter((l) => l.trim().length > 0);
  if (fns.length !== lines.length) {
    throw new Error(
      `CELL_PLAN 有 ${lines.length} 行，却只抠出 ${fns.length} 个函数名 —— 判据漏扫了，不许静默放行`,
    );
  }
  if (fns.length === 0) throw new Error("CELL_PLAN 里一个函数名都没抠出来 —— 判据坏了");
  return fns
    .filter((fn) => !new RegExp(`^${fn}\\(\\) \\{`, "m").test(src))
    .map((fn) => `CELL_PLAN 里写着 ${fn}，而脚本里没有这个函数 —— 那一格会以 exit 127 红在一个说不清真因的报文上`);
};

describe("scripts/smoke-dual-runtime.sh：判据不许被换成没有鉴别力的东西", () => {
  it("脚本自身语法过得去（它要被推送前复跑清单的 ⑦ 直接跑）", () => {
    const r = spawnSync("bash", ["-n", SMOKE], { encoding: "utf8" });
    expect(r.status, `bash -n 没过：\n${r.stderr}`).toBe(0);
  });

  it("认不出的参数要吵，不许静静跑成默认档（默认档会真去起容器）", () => {
    const r = run("--nope");
    expect(r.code, "认不出的参数没被拦住 —— 手滑打错一个开关就会真去构建镜像").toBe(2);
    expect(r.stderr).toContain("认不出的参数");
  });

  it("--print-plan 是干跑档：五格逐格打出来，一格都不执行，stderr 恰好 0 字节", () => {
    const r = run("--print-plan");
    expect(r.code).toBe(0);
    expect(r.stderr.length, `干跑档不该往 stderr 写东西：${r.stderr}`).toBe(0);
    const ids = [...r.stdout.matchAll(/^### CELL (\S+) \| /gm)].map((m) => m[1]!);
    expect(ids).toEqual(["①", "②", "③", "④", "⑤"]);
  });

  /**
   * 与推送前复跑脚本同一条：整跑档合并两股流，但**必须在参数分派之后**——
   * 合到前面去，上面那格「干跑档 stderr 恰好 0 字节」就会因为另一个原因变绿。
   */
  it("整跑档把 stderr 并进 stdout，且这一步在参数分派之后", () => {
    const src = realRead(SMOKE);
    const iExec = src.indexOf("\nexec 2>&1\n");
    const iEsac = src.indexOf("\nesac\n");
    expect(iExec, "整跑档没合并两股流 ⇒ 留档的日志里会只剩一张不说理由的表").toBeGreaterThan(-1);
    expect(iEsac, "参数分派那个 case 块没找到").toBeGreaterThan(-1);
    expect(iExec, "合并写在了参数分派之前 ⇒ 干跑档的 stderr 也被并走").toBeGreaterThan(iEsac);
  });

  it(REAL_INTERVAL, () => {
    const failures = intervalCriterionFailures(realRead);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  /** 那条发现的机器侧：把那句铺开量比较换成一句数块数的 —— 判据必须点名。 */
  it("(到达间隔) 该红时红：③ 的判据被换成「拿到了几块」—— 点名它是零鉴别力", () => {
    probeBase(intervalCriterionFailures(realRead), REAL_INTERVAL);
    const mutated = realRead(SMOKE)
      .replace("(( spread < STREAM_SPREAD_MIN_MS ))", "(( deltas < STUB_CHUNKS ))");
    expect(mutated, "变异没落地 —— 脚本里已经不是那句比较").not.toBe(realRead(SMOKE));
    const failures = intervalCriterionFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("零鉴别力");
  });

  /**
   * ⚠️ **这一格钉的是被实测推翻的那个上一版**：`first_ms` 取探针输出的第一行。
   * 变异写的就是上一版那两行的原文 —— 它今天必须让判据红，而且要点名 message_start。
   */
  it("(到达间隔) 该红时红：first_ms 退回「探针输出的第一行」—— 点名那是 message_start，对正文缓冲零鉴别力", () => {
    probeBase(intervalCriterionFailures(realRead), REAL_INTERVAL);
    const mutated = realRead(SMOKE)
      .replace(`first_ms=$(printf '%s\\n' "$body" | head -n 1 | cut -f1)`,
               `first_ms=$(awk -F'\\t' 'NR==1 { print $1; exit }' "$out")`);
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = intervalCriterionFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(2);
    expect(failures.join("\n")).toContain("正文首块的到达时刻");
    expect(failures.join("\n")).toContain("message_start");
  });

  it("(到达间隔) 该红时红：把「首块领先上游末块」那句佐证删掉 —— 判据得点名它少了", () => {
    probeBase(intervalCriterionFailures(realRead), REAL_INTERVAL);
    const mutated = realRead(SMOKE).replace("(( lead <= 0 ))", "(( lead <= -999999999 ))");
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = intervalCriterionFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("佐证比较");
  });

  it("(到达间隔) 认不出要吵：check_stream 整个不见了时当场抛，不静默当成「判据还在」", () => {
    const gutted = realRead(SMOKE).replace(/^check_stream\(\) \{/m, "check_stream_disabled() {");
    expect(() => intervalCriterionFailures(patchRead(realRead, SMOKE, gutted))).toThrow(/判据坏了/);
  });

  it(REAL_CLEANUP, () => {
    const failures = cleanupFailures(realRead);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("(收尾) 该红时红：把 trap 那一行删掉 —— 点名容器与 wrangler 会留在机器上", () => {
    probeBase(cleanupFailures(realRead), REAL_CLEANUP);
    const mutated = realRead(SMOKE).replace(/^trap cleanup EXIT$/m, "# trap cleanup EXIT");
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = cleanupFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("留在机器上");
  });

  it("(收尾) 该红时红：收尾不再拿工作树与开跑前比 —— 那条绊线没了，探针留在树里没人会发现", () => {
    probeBase(cleanupFailures(realRead), REAL_CLEANUP);
    const mutated = realRead(SMOKE)
      .replace('if [[ $after != "$GIT_BASELINE" ]]; then', "if false; then");
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = cleanupFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("探针留在树里");
  });

  it(REAL_UPSTREAM, () => {
    const failures = realUpstreamFailures(realRead);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("(零联网) 该红时红：把上游指回真的 Agnes —— 点名那个主机名", () => {
    probeBase(realUpstreamFailures(realRead), REAL_UPSTREAM);
    const mutated = realRead(SMOKE)
      .replace("http://127.0.0.1:$STUB_PORT/worker/v1", "https://apihub.agnes-ai.com/v1");
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = realUpstreamFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("apihub.agnes-ai.com");
  });

  it("(零联网) 认不出要吵：脚本里一个 URL 都扫不到时当场抛，不静默当成「没有真上游」", () => {
    const gutted = realRead(SMOKE).replaceAll("http://", "hxxp://");
    expect(() => realUpstreamFailures(patchRead(realRead, SMOKE, gutted))).toThrow(/判据坏了/);
  });

  it(REAL_USAGE_DAYS, () => {
    const failures = usageDaysFailures(realRead);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("(天数) 该红时红：面板那个按钮改成别的天数而冒烟没跟上 —— 两边都点出来", () => {
    probeBase(usageDaysFailures(realRead), REAL_USAGE_DAYS);
    const mutated = realRead(USAGE_PURE).replace('"30d": 30', '"30d": 60');
    expect(mutated, "变异没落地 —— rangeToQuery 里已经不是那张表").not.toBe(realRead(USAGE_PURE));
    const failures = usageDaysFailures(patchRead(realRead, USAGE_PURE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("而面板那个按钮今天是 60 天");
  });

  it("(天数) 该红时红：窗口从 (N−1) 天改成 N 天 —— clamped 会恒为真，判据得看得见", () => {
    probeBase(usageDaysFailures(realRead), REAL_USAGE_DAYS);
    const mutated = realRead(SMOKE)
      .replace("from=$(( to - (USAGE_RANGE_DAYS - 1) * DAY_MS ))", "from=$(( to - USAGE_RANGE_DAYS * DAY_MS ))");
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = usageDaysFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("clamped 恒为真");
  });

  it(REAL_CELL_FN, () => {
    const failures = cellFnFailures(realRead);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("(逐格表) 该红时红：CELL_PLAN 里的函数名打错 —— 点名它并说清失败形态", () => {
    probeBase(cellFnFailures(realRead), REAL_CELL_FN);
    const mutated = realRead(SMOKE).replace("\tcell_usage_30d\"", "\tcell_usage_30days\"");
    expect(mutated, "变异没落地 —— CELL_PLAN 里已经不是那个名字").not.toBe(realRead(SMOKE));
    const failures = cellFnFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("cell_usage_30days");
  });

  it("(逐格表) 认不出要吵：CELL_PLAN 整个读不出来时当场抛", () => {
    const gutted = realRead(SMOKE).replace(/^CELL_PLAN=\(/m, "CELL_PLAN_DISABLED=(");
    expect(() => cellFnFailures(patchRead(realRead, SMOKE, gutted))).toThrow(/判据坏了/);
  });

  it(REAL_VERDICT_ADOPTED, () => {
    const failures = streamVerdictAdoptedFailures(realRead);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("(结论采纳) 该红时红：check_stream 的返回值被 `|| true` 吞掉 —— 点名 ③ 可以被静默阉割", () => {
    probeBase(streamVerdictAdoptedFailures(realRead), REAL_VERDICT_ADOPTED);
    const mutated = realRead(SMOKE)
      .replace('if ! check_stream "Docker" "$TMP/stream-docker.txt"; then bad=1; fi',
               'check_stream "Docker" "$TMP/stream-docker.txt" || true');
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = streamVerdictAdoptedFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("Docker");
    expect(failures[0] ?? "").toContain("静默阉割");
  });

  it("(结论采纳) 该红时红：那一格不再按 bad 决定成败 —— 红了也会算 PASS", () => {
    probeBase(streamVerdictAdoptedFailures(realRead), REAL_VERDICT_ADOPTED);
    // `replace` 只换第一处，而 cell_stream_interval 在 cell_admin_html 之前 —— 打中的是它。
    const mutated = realRead(SMOKE)
      .replace("if (( bad != 0 )); then return 1; fi", "if false; then return 1; fi");
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    expect(fnBody(mutated, "cell_stream_interval"), "变异打到了别的函数上")
      .not.toContain("if (( bad != 0 )); then return 1; fi");
    const failures = streamVerdictAdoptedFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("红了也会算 PASS");
  });

  it("(结论采纳) 认不出要吵：cell_stream_interval 整个不见了时当场抛", () => {
    const gutted = realRead(SMOKE).replace(/^cell_stream_interval\(\) \{/m, "cell_stream_gone() {");
    expect(() => streamVerdictAdoptedFailures(patchRead(realRead, SMOKE, gutted))).toThrow(/判据坏了/);
  });

  it(REAL_CHUNK_SOURCE, () => {
    const failures = chunkSourceFailures(realRead);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("(块数真源) 该红时红：stub 的块数写回字面量 —— 两侧会各自漂，报文把人指错方向", () => {
    probeBase(chunkSourceFailures(realRead), REAL_CHUNK_SOURCE);
    const mutated = realRead(SMOKE).replace("const CHUNKS = Number(process.argv[4]);", "const CHUNKS = 6;");
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = chunkSourceFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(2);
    expect(failures.join("\n")).toContain("不再从命令行来");
    expect(failures.join("\n")).toContain("字面量");
  });

  it("(块数真源) 该红时红：判据里把期望块数写死成 4 —— 点名那个数", () => {
    probeBase(chunkSourceFailures(realRead), REAL_CHUNK_SOURCE);
    const mutated = realRead(SMOKE).replace("(( deltas != STUB_CHUNKS ))", "(( deltas < 4 ))");
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = chunkSourceFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(2);
    expect(failures.join("\n")).toContain("写死的块数（4）");
  });

  it("(块数真源) 该红时红：compose 那份 stub 没拿到块数 —— 两份 stub 会发不一样多的块", () => {
    probeBase(chunkSourceFailures(realRead), REAL_CHUNK_SOURCE);
    const mutated = realRead(SMOKE)
      .replace('"${STUB_PORT_IN_NET}", "${STUB_GAP_MS}", "${STUB_CHUNKS}"', '"${STUB_PORT_IN_NET}", "${STUB_GAP_MS}"');
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = chunkSourceFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("两份 stub 会发不一样多的块");
  });

  it("(块数真源) 认不出要吵：STUB_CHUNKS 整个读不出来时当场抛", () => {
    const gutted = realRead(SMOKE).replace(/^STUB_CHUNKS=\d+$/m, "STUB_CHUNKS_DISABLED=4");
    expect(() => chunkSourceFailures(patchRead(realRead, SMOKE, gutted))).toThrow(/判据坏了/);
  });

  it(REAL_DATA_ISOLATION, () => {
    const failures = dataIsolationFailures(realRead);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("(数据隔离) 该红时红：override 把挂载指回仓库根下的 ./data —— 点名开发者那份 store.json", () => {
    probeBase(dataIsolationFailures(realRead), REAL_DATA_ISOLATION);
    const mutated = realRead(SMOKE)
      .replace('- "${SMOKE_DATA_DIR}:${COMPOSE_DATA_TARGET}"', '- "./data:/app/data"');
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = dataIsolationFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("改指临时目录");
  });

  it("(数据隔离) 该红时红：env_file 那条 !reset 没了 —— 点名开发者的真 .env 会被整份灌进去", () => {
    probeBase(dataIsolationFailures(realRead), REAL_DATA_ISOLATION);
    const mutated = realRead(SMOKE).replace("    env_file: !reset []\n", "");
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = dataIsolationFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("整份灌进冒烟容器");
  });

  it("(数据隔离) 该红时红：up 之前不再回读 compose config —— 点名合并语义的假定会静静地放行", () => {
    probeBase(dataIsolationFailures(realRead), REAL_DATA_ISOLATION);
    const mutated = realRead(SMOKE).replace("  if ! assert_override_took; then return 1; fi\n", "");
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = dataIsolationFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("静静地放行");
  });

  it("(数据隔离) 该红时红：回读里不再查多出来的环境变量键 —— env_file 没抹掉时它是唯一会说话的地方", () => {
    probeBase(dataIsolationFailures(realRead), REAL_DATA_ISOLATION);
    const mutated = realRead(SMOKE).replace("if (extra.length > 0) {", "if (false) {");
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = dataIsolationFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("多出来的环境变量键");
  });

  it("(数据隔离) 认不出要吵：override 那段整个读不出来时当场抛，不静默当成「它还在」", () => {
    const gutted = realRead(SMOKE).replace('  cat >"$OVERRIDE" <<YML', '  cat >"$OVERRIDE" <<NOPE');
    expect(gutted, "变异没落地").not.toBe(realRead(SMOKE));
    expect(() => dataIsolationFailures(patchRead(realRead, SMOKE, gutted))).toThrow(/判据坏了/);
  });

  it("(数据隔离) 认不出要吵：docker-compose.yml 里认不出 ./data 那条挂载时当场抛", () => {
    const gutted = realRead(COMPOSE_FILE).replace(/^\s*-\s*\.\/data:\/\S+\s*$/m, "      - agnes-data:/app/data");
    expect(gutted, "变异没落地").not.toBe(realRead(COMPOSE_FILE));
    expect(() => dataIsolationFailures(patchRead(realRead, COMPOSE_FILE, gutted))).toThrow(/判据坏了/);
  });
});
