import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { registrarFromEnv } from "../../../src/core/registrar/config.js";
import { mintOne } from "../../../src/core/registrar/mint.js";
import { YydsProvider } from "../../../src/adapters/mailbox-yyds.js";
import { MoeMailProvider } from "../../../src/adapters/mailbox-moemail.js";
import { recordingLogger } from "../../helpers/recording-logger.js";
import type { Logger } from "../../../src/ports/logger.js";

/**
 * M4：五语言 REGISTRAR.md 的排障小节对外承诺「补池过程中的日志统一带 `[registrar]`
 * 前缀，可据此过滤」，而注册机内部此前一律打 `[agnes2api]`——按文档指定的姿势
 * （`docker logs … | grep '[registrar]'` / `wrangler tail --search '[registrar]'`）
 * 排障时，M1/M2 新增的那些诊断信号会被整段过滤掉，等于白修。
 *
 * 把裸 console.* 换成注入的 Logger 之后，前缀不再由每个调用点手写字符串，
 * 而是由 `ConsoleLogger` 按事件名的命名空间（`registrar.` 前缀）派生——这正是
 * 这条不变量此前会被漏掉 14 条的成因。守门方式也跟着换了两层：
 * - 源码层：这些文件里**一个 console 调用点都不许有**——新加一条 console.warn
 *   立刻变红（下面 LOGGER_ONLY_SOURCES / src/core 全目录扫描两条）。
 * - 行为层：真的触发几条代表性日志，注入 recordingLogger 断言**事件名**
 *   （而不是 console 输出的文案）——事件名才是这套日志唯一稳定的对外契约。
 */

/**
 * 已经把裸 console.* 换成注入 Logger 的源文件：这里**一个 console.(log|warn|error|
 * info|debug)( 调用点都不该有**。
 *
 * 注意正则要求调用点后面紧跟左括号——`grep "console\."` 这种不带括号的裸子串匹配
 * 会把「注释里提到 console.warn」这类散文也算进去（开工时的真实教训：
 * `config.ts` 曾有一行中文注释写「`console.warn`」，裸 grep 会把它误算成一个调用点，
 * 得到与这里断言的 0 不一致的数字）。下面两条断言用的正则始终是
 * `console\.(log|warn|error|info|debug)\(`，只匹配真实调用，不匹配注释里的提及。
 */
const LOGGER_ONLY_SOURCES = [
  "src/core/registrar/config.ts",
  "src/core/registrar/mint.ts",
  "src/core/registrar/tender.ts",
  "src/core/registrar/agnes.ts",
  "src/core/registrar/code.ts",
  "src/core/storage-health.ts",
  "src/adapters/mailbox-yyds.ts",
  "src/adapters/mailbox-moemail.ts",
];

const CONSOLE_CALL = /console\.(log|warn|error|info|debug)\(/g;

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

it("这些文件里一个 console 调用点都没有——core 零 IO 与「事件要能落库」都靠它", () => {
  for (const rel of LOGGER_ONLY_SOURCES) {
    const src = readFileSync(rel, "utf8");
    const calls = src.match(CONSOLE_CALL) ?? [];
    expect(calls, `${rel} 仍有 ${calls.length} 处裸 console 调用`).toEqual([]);
  }
});

/**
 * ⚠️ 这条只扫 `src/core`。后来新增的 `src/http/**`、`src/ui/**` 两棵树由
 * `tests/unit/source-guards.test.ts` 扫（那里还有 `src/core` 零 IO 的源码门禁）。
 * 分成两处不是遗漏：这一条的存在理由是五语言 REGISTRAR.md 的 `[registrar]` 前缀契约，
 * 与它下面那几条行为断言同源；那一条守的是「事件要能被面板消费」。
 */
it("src/core 全目录零 console——只列白名单会漏掉将来新增的文件", () => {
  const offenders: string[] = [];
  for (const rel of walkTs("src/core")) {
    const src = readFileSync(rel, "utf8");
    if (CONSOLE_CALL.test(src)) offenders.push(rel);
    CONSOLE_CALL.lastIndex = 0; // 全局正则 + .test() 有状态，用完必须复位，否则漏检下一个文件
  }
  expect(offenders).toEqual([]);
});

describe("注册机日志事件（文档对外承诺 [registrar] 前缀 + 稳定事件名）", () => {
  it("mintOne 列域名失败时记 registrar.list_domains_failed 事件", async () => {
    const logger = recordingLogger();
    const provider = {
      name: "yyds" as const,
      async listDomains(): Promise<string[]> { throw new Error("down"); },
      async createMailbox(): Promise<never> { throw new Error("unreachable"); },
      async pollCode() { return null; },
      async deleteMailbox() {},
    };
    await mintOne({
      provider,
      agnes: { platformUrl: "https://platform.test", fetcher: { async fetch() { return new Response("{}"); } } },
      tokenName: "auto", codeTimeoutMs: 5000, maxDomainAttempts: 8,
      sleep: async () => {}, rand: () => 0.5, logger,
    });
    expect(logger.events()).toContain("registrar.list_domains_failed");
  });

  it("两家适配器删邮箱失败时都记 registrar.delete_mailbox_failed，且带 provider 字段", async () => {
    const clock = { sleep: async () => {}, now: () => 0 };
    // 404 是「删除没生效」的真实形态（评审发现 RM1 实测过），stub 必须真的返回它而不是 200。
    const fetcher = { async fetch() { return new Response("{}", { status: 404 }); } };
    for (const [name, make] of [
      ["yyds", (l: Logger) => new YydsProvider({ fetcher, baseUrl: "https://y.test", apiKey: "k", ...clock, logger: l })],
      ["moemail", (l: Logger) => new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", ...clock, logger: l })],
    ] as const) {
      const logger = recordingLogger();
      await make(logger).deleteMailbox({ address: "u1@a.test", handle: "id-1" });
      const e = logger.entries.find((x) => x.event === "registrar.delete_mailbox_failed");
      expect(e, name).toBeTruthy();
      expect(e?.fields?.provider, name).toBe(name);
    }
  });

  it("config 忽略脏通道值时记 registrar.config_ignored，且 source 区分 env 与 stored", () => {
    const a = recordingLogger();
    registrarFromEnv({ REGISTRAR_PRIMARY: "typo-here" }, {}, a);
    expect(a.entries.find((x) => x.event === "registrar.config_ignored")?.fields?.source).toBe("env");

    const b = recordingLogger();
    registrarFromEnv({}, { primary: "garbage" as never }, b);
    expect(b.entries.find((x) => x.event === "registrar.config_ignored")?.fields?.source).toBe("stored");
  });
});
