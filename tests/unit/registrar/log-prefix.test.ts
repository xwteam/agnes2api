import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { registrarFromEnv } from "../../../src/core/registrar/config.js";
import { mintOne } from "../../../src/core/registrar/mint.js";
import { YydsProvider } from "../../../src/adapters/mailbox-yyds.js";
import { MoeMailProvider } from "../../../src/adapters/mailbox-moemail.js";

/**
 * M4：五语言 REGISTRAR.md 的排障小节对外承诺「补池过程中的日志统一带 `[registrar]`
 * 前缀，可据此过滤」，而注册机内部此前一律打 `[agnes2api]`——按文档指定的姿势
 * （`docker logs … | grep '[registrar]'` / `wrangler tail --search '[registrar]'`）
 * 排障时，M1/M2 新增的那些诊断信号会被整段过滤掉，等于白修。
 *
 * 这里两层守护：
 * - 行为层：真的触发几条代表性日志，断言运维 grep 得到的那个字符串确实以
 *   `[registrar]` 开头（下面每条用例都对应一个具体的失败场景）。
 * - 源码层：注册机自有文件里逐个 console 调用点都必须带这个前缀。行为层只能覆盖
 *   被单测触达的那几条，而承诺是对**全部**日志给的；漏掉一条就等于漏掉一条运维
 *   看不见的信号，所以这一层按调用点数量对齐，新增一条无前缀日志也会变红。
 */

/**
 * 注册机自有的源文件：文件里的每一条日志都是注册机日志，因此可以按「console 调用点
 * 数 == [registrar] 出现次数」对齐。
 */
const REGISTRAR_ONLY_SOURCES = [
  "src/core/registrar/config.ts",
  "src/core/registrar/mint.ts",
  "src/core/registrar/tender.ts",
  "src/core/registrar/agnes.ts",
  "src/core/registrar/code.ts",
  "src/adapters/mailbox-yyds.ts",
  "src/adapters/mailbox-moemail.ts",
];

/**
 * 两个入口既有注册机日志也有网关自身的日志（监听端口、启动失败），不能按数量对齐，
 * 只守「不许再出现 [agnes2api] 前缀的注册机日志」。
 */
const MIXED_SOURCES = ["src/entry/node.ts", "src/entry/worker.ts"];

/**
 * 每条用例都自己装一次 console.warn 的间谍。刻意不在用例里手写 `mockRestore()`：
 * 断言一旦失败就会抛出，写在后面的 restore 根本执行不到，于是间谍泄漏到下一条
 * 用例，把「一条真失败」放大成「四条全红」，掩盖真正出问题的那一条。统一交给
 * afterEach 兜底。
 */
function spyWarn() {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  spy.mockClear();
  return spy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function firstWarnArg(spy: ReturnType<typeof spyWarn>): string {
  return String((spy.mock.calls[0] as unknown[] | undefined)?.[0] ?? "");
}

describe("注册机日志前缀（文档对外承诺 [registrar]）", () => {
  it("注册机自有源文件里没有残留的 [agnes2api]，且每个 console 调用点都带 [registrar]", () => {
    for (const rel of REGISTRAR_ONLY_SOURCES) {
      const src = readFileSync(rel, "utf8");
      expect(src, `${rel} 仍有 [agnes2api] 前缀`).not.toContain("[agnes2api]");
      const consoleCalls = src.match(/console\.(log|warn|error)\(/g)?.length ?? 0;
      const prefixed = src.match(/\[registrar\]/g)?.length ?? 0;
      expect(prefixed, `${rel} 的 console 调用点数与 [registrar] 前缀数不一致`).toBe(consoleCalls);
    }
    for (const rel of MIXED_SOURCES) {
      expect(readFileSync(rel, "utf8"), `${rel} 仍有 [agnes2api] 前缀`).not.toContain("[agnes2api]");
    }
  });

  it("mintOne 列域名失败时打出的那条 warn 以 [registrar] 开头", async () => {
    const warnSpy = spyWarn();
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
      sleep: async () => {}, rand: () => 0.5,
    });
    expect(firstWarnArg(warnSpy).startsWith("[registrar]")).toBe(true);
  });

  it("两家适配器删邮箱失败时打出的那条 warn 都以 [registrar] 开头", async () => {
    const clock = { sleep: async () => {}, now: () => 0 };
    const fetcher = { async fetch() { return new Response("{}", { status: 404 }); } };

    for (const p of [
      new YydsProvider({ fetcher, baseUrl: "https://y.test", apiKey: "k", ...clock }),
      new MoeMailProvider({ fetcher, baseUrl: "https://m.test", apiKey: "k", ...clock }),
    ]) {
      const warnSpy = spyWarn();
      await p.deleteMailbox({ address: "u1@a.test", handle: "id-1" });
      expect(firstWarnArg(warnSpy).startsWith("[registrar]"), p.name).toBe(true);
    }
  });

  it("config 忽略脏通道值时打出的那条 warn 以 [registrar] 开头", () => {
    const warnSpy = spyWarn();
    registrarFromEnv({ REGISTRAR_PRIMARY: "typo-here" }, {});
    expect(firstWarnArg(warnSpy).startsWith("[registrar]")).toBe(true);
  });
});
