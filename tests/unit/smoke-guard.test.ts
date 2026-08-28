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
 * 本仓已经在同一个形态上栽过（Task 11 明令禁止「往单块表里加一行 CRLF 样本」）。
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
 * · G3 只查脚本里**写死的 URL**：一个从环境变量拼出来的地址它看不见。
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

/* ── G1：③ 的判据是到达间隔，不是块数 ─────────────────────────────────────── */

const REAL_G1 = "③ 的判据是「第一行到达 早于 上游最后一块发出」这两个时刻的比较";

/**
 * ⚠️ 三条一起查，缺一条这条判据就退化：
 * ① 真的有那一句时刻比较；
 * ② `first_ms` 取的是**探针输出的第一行**（`NR==1`）——取成别的行就不是「第一块到达」；
 * ③ `last_ms` 取的是**正文里那个上游时间戳**——假上游把每一块的发出时刻写进了正文，
 *    这是两侧不共享任何文件也能比时刻的支点。
 */
const intervalCriterionFailures = (read: Read): string[] => {
  const body = fnBody(read(SMOKE), "check_stream");
  const out: string[] = [];
  if (!body.includes("(( first_ms < last_ms ))")) {
    out.push("③ 的判据里没有那一句时刻比较 —— 换成「拿到了几块」是零鉴别力：整体缓冲最终也会把全部内容交出来");
  }
  if (!/first_ms=\$\(awk -F'\\t' 'NR==1/.test(body)) {
    out.push("first_ms 取的不再是探针输出的第一行 —— 那就不是「第一块到达」的时刻了");
  }
  if (!/last_ms=\$\(grep -oE '"text":"\[0-9\]\{10,\}"'/.test(body)) {
    out.push("last_ms 取的不再是正文里那个上游时间戳 —— 「上游最后一块发出」这个时刻就没有来源了");
  }
  return out;
};

/* ── G2：收尾无条件 ───────────────────────────────────────────────────────── */

const REAL_G2 = "收尾是无条件的：trap 挂在 EXIT 上，容器 / wrangler / 临时目录三样都收，最后比一遍工作树";

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

/* ── G3：零联网真上游 ─────────────────────────────────────────────────────── */

const REAL_G3 = "脚本里写死的每一个地址都指向本机或 compose 网络里那份 stub，没有一个真上游";

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

/* ── G4：④ 那一档的天数是现读的，不是手抄的 ──────────────────────────────── */

const REAL_G4 = "④ 那一格的天数与 admin-ui/js/pure/usage.mjs 的 rangeToQuery() 对得上，且窗口按 (N−1) 天算";

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

/* ── G5：干跑档与真跑的那几格是同一份表 ──────────────────────────────────── */

const REAL_G5 = "CELL_PLAN 里每一格的函数名都在脚本里真的定义了";

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

  it(REAL_G1, () => {
    const failures = intervalCriterionFailures(realRead);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  /** M3 的机器侧：把那句时刻比较换成一句数块数的 —— 判据必须点名。 */
  it("(G1) 该红时红：③ 的判据被换成「拿到了几块」—— 点名它是零鉴别力", () => {
    probeBase(intervalCriterionFailures(realRead), REAL_G1);
    const mutated = realRead(SMOKE).replace("(( first_ms < last_ms ))", "(( deltas >= 4 ))");
    expect(mutated, "变异没落地 —— 脚本里已经不是那句比较").not.toBe(realRead(SMOKE));
    const failures = intervalCriterionFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("零鉴别力");
  });

  it("(G1) 该红时红：first_ms 不再取探针输出的第一行 —— 那就不是「第一块到达」了", () => {
    probeBase(intervalCriterionFailures(realRead), REAL_G1);
    const mutated = realRead(SMOKE).replace("first_ms=$(awk -F'\\t' 'NR==1", "first_ms=$(awk -F'\\t' 'END");
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = intervalCriterionFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("第一块到达");
  });

  it("(G1) 认不出要吵：check_stream 整个不见了时当场抛，不静默当成「判据还在」", () => {
    const gutted = realRead(SMOKE).replace(/^check_stream\(\) \{/m, "check_stream_disabled() {");
    expect(() => intervalCriterionFailures(patchRead(realRead, SMOKE, gutted))).toThrow(/判据坏了/);
  });

  it(REAL_G2, () => {
    const failures = cleanupFailures(realRead);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("(G2) 该红时红：把 trap 那一行删掉 —— 点名容器与 wrangler 会留在机器上", () => {
    probeBase(cleanupFailures(realRead), REAL_G2);
    const mutated = realRead(SMOKE).replace(/^trap cleanup EXIT$/m, "# trap cleanup EXIT");
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = cleanupFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("留在机器上");
  });

  it("(G2) 该红时红：收尾不再拿工作树与开跑前比 —— 那条绊线没了，探针留在树里没人会发现", () => {
    probeBase(cleanupFailures(realRead), REAL_G2);
    const mutated = realRead(SMOKE)
      .replace('if [[ $after != "$GIT_BASELINE" ]]; then', "if false; then");
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = cleanupFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("探针留在树里");
  });

  it(REAL_G3, () => {
    const failures = realUpstreamFailures(realRead);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("(G3) 该红时红：把上游指回真的 Agnes —— 点名那个主机名", () => {
    probeBase(realUpstreamFailures(realRead), REAL_G3);
    const mutated = realRead(SMOKE)
      .replace("http://127.0.0.1:$STUB_PORT/worker/v1", "https://apihub.agnes-ai.com/v1");
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = realUpstreamFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("apihub.agnes-ai.com");
  });

  it("(G3) 认不出要吵：脚本里一个 URL 都扫不到时当场抛，不静默当成「没有真上游」", () => {
    const gutted = realRead(SMOKE).replaceAll("http://", "hxxp://");
    expect(() => realUpstreamFailures(patchRead(realRead, SMOKE, gutted))).toThrow(/判据坏了/);
  });

  it(REAL_G4, () => {
    const failures = usageDaysFailures(realRead);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("(G4) 该红时红：面板那个按钮改成别的天数而冒烟没跟上 —— 两边都点出来", () => {
    probeBase(usageDaysFailures(realRead), REAL_G4);
    const mutated = realRead(USAGE_PURE).replace('"30d": 30', '"30d": 60');
    expect(mutated, "变异没落地 —— rangeToQuery 里已经不是那张表").not.toBe(realRead(USAGE_PURE));
    const failures = usageDaysFailures(patchRead(realRead, USAGE_PURE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("而面板那个按钮今天是 60 天");
  });

  it("(G4) 该红时红：窗口从 (N−1) 天改成 N 天 —— clamped 会恒为真，判据得看得见", () => {
    probeBase(usageDaysFailures(realRead), REAL_G4);
    const mutated = realRead(SMOKE)
      .replace("from=$(( to - (USAGE_RANGE_DAYS - 1) * DAY_MS ))", "from=$(( to - USAGE_RANGE_DAYS * DAY_MS ))");
    expect(mutated, "变异没落地").not.toBe(realRead(SMOKE));
    const failures = usageDaysFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("clamped 恒为真");
  });

  it(REAL_G5, () => {
    const failures = cellFnFailures(realRead);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("(G5) 该红时红：CELL_PLAN 里的函数名打错 —— 点名它并说清失败形态", () => {
    probeBase(cellFnFailures(realRead), REAL_G5);
    const mutated = realRead(SMOKE).replace("\tcell_usage_30d\"", "\tcell_usage_30days\"");
    expect(mutated, "变异没落地 —— CELL_PLAN 里已经不是那个名字").not.toBe(realRead(SMOKE));
    const failures = cellFnFailures(patchRead(realRead, SMOKE, mutated));
    expect(failures).toHaveLength(1);
    expect(failures[0] ?? "").toContain("cell_usage_30days");
  });

  it("(G5) 认不出要吵：CELL_PLAN 整个读不出来时当场抛", () => {
    const gutted = realRead(SMOKE).replace(/^CELL_PLAN=\(/m, "CELL_PLAN_DISABLED=(");
    expect(() => cellFnFailures(patchRead(realRead, SMOKE, gutted))).toThrow(/判据坏了/);
  });
});
