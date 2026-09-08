import { describe, it, expect } from "vitest";
import { tendOnce, type TendDeps } from "../../src/core/registrar/tender.js";
import { KeyPoolRepo } from "../../src/core/keypool-repo.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";
import type { RegistrarConfig } from "../../src/core/registrar/config.js";
import type { Mailbox } from "../../src/core/registrar/types.js";
import { emptyDomainLedger, type DomainLedger } from "../../src/core/registrar/domain-ledger.js";
import type { BackoffState } from "../../src/core/registrar/backoff.js";

/**
 * 🔴 **承重判据：还在退避窗口里的那一轮，一次上游请求都不发、一个临时邮箱都不建。**
 *
 * 这一格**放在 `tests/contract/` 是有意的**（`vitest.workers.config.ts` 的 include
 * 只收这个目录）：它要在 **Node 与 workerd 两种运行时下各跑一遍**。
 * 「双运行时同一套代码」是硬约束，而这条闸门是本次唯一新增的、能整轮改变行为的
 * 早退分支——它在两种运行时上必须是同一个行为。
 *
 * ── 为什么每一条断言都不能省 ──────────────────────────────────────────────
 *
 * · **上游调用次数 === 0**：这是这道闸门存在的全部理由。上游那两层限流的惩罚窗口
 *   里，**每打一次请求就把窗口续一次** —— 打得越多，恢复得越晚。
 * · **`createMailbox` === 0**：光看「没打 Agnes」不够。每探一次都要先真建一个临时
 *   邮箱，而两条通道**各自**都有活跃邮箱上限。一个「只跳过发码、照常建邮箱」的实现
 *   在上一条断言下是绿的。
 * · **`skipped === false`**：`skipped` 有且只有一个含义（注册机被关掉了）。拿它表示
 *   「这一轮在退避里」就是伪造 —— 面板会说「注册机当时是关闭的」，而它开着。
 * · **归因是 `upstream_backoff`**：补池历史上这一行必须能自己说清发生了什么，
 *   而不是靠合读 `attempted === 0 && failures[0]` 去推。
 */

const NOW = 1_700_000_000_000;

const CFG: RegistrarConfig = {
  enabled: true, channel: "yyds",
  targetKeys: 5, mintBatch: 5, tendIntervalMs: 1_800_000, codeTimeoutMs: 5000,
  mintDelayMinMs: 0, mintDelayMaxMs: 0, maxDomainAttempts: 1,
  tokenName: "auto", agnesPlatformUrl: "https://platform.test",
  yyds: { baseUrl: "https://y.test", apiKey: "k" }, moemail: null,
  blocked: false,
};

/** 数「上游被打了几次」与「建了几个临时邮箱」。两条都要，理由见文件头。 */
function spies() {
  const calls = { agnes: 0, created: 0, listedDomains: 0 };
  const provider = {
    name: "yyds" as const,
    async listDomains(): Promise<string[]> { calls.listedDomains++; return ["a.test", "b.test"]; },
    async createMailbox(domain: string): Promise<Mailbox> {
      calls.created++;
      return { address: `u${calls.created}@${domain}`, handle: `id-${calls.created}` };
    },
    async pollCode(): Promise<string | null> { return "123456"; },
    async deleteMailbox(): Promise<void> {},
  };
  const agnes = {
    platformUrl: "https://platform.test",
    fetcher: {
      async fetch(url: string): Promise<Response> {
        calls.agnes++;
        if (url.includes("/api/user/login")) {
          return new Response(JSON.stringify({ data: { access_token: "tok" } }), { status: 200 });
        }
        if (url.includes("/api/token")) {
          return new Response(JSON.stringify({ data: { key: `sk-${calls.agnes}` } }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
    },
  };
  return { calls, provider, agnes };
}

function makeDeps(backoff: BackoffState | null) {
  const { calls, provider, agnes } = spies();
  const saved: DomainLedger[] = [];
  const deps: TendDeps = {
    repo: new KeyPoolRepo(new MemoryStorage(), { now: () => NOW, logger: NULL_LOGGER }),
    config: { ...CFG },
    providers: { yyds: provider },
    agnes,
    now: () => NOW,
    sleep: async () => {},
    rand: () => 0.5,
    logger: NULL_LOGGER,
    loadDomainLedger: async () => emptyDomainLedger(),
    saveDomainLedger: async (l) => { saved.push(l); },
    loadBackoff: async () => backoff,
    saveBackoff: async () => {},
  };
  return { deps, calls, saved };
}

describe("退避窗口内的那一轮", () => {
  it("一次上游请求都不发、一个临时邮箱都不建，而且不伪造成 skipped", async () => {
    const { deps, calls, saved } = makeDeps({
      until: NOW + 600_000, kind: "edge", since: NOW - 60_000, hits: 1,
    });

    const out = await tendOnce(deps);

    expect(calls.agnes, "退避窗口里还在打上游，每打一次都把惩罚窗口续一次").toBe(0);
    expect(calls.created, "退避窗口里还在真建临时邮箱（活跃邮箱名额是有限的）").toBe(0);
    expect(calls.listedDomains, "连列域名都不该发").toBe(0);
    expect(out.skipped, "`skipped` 有且只有一个含义：注册机被关掉了").toBe(false);
    expect(out.attempted).toBe(0);
    expect(out.minted).toBe(0);
    expect(out.failures).toEqual([{ reason: "upstream_backoff", channel: "yyds" }]);
    // 这一行在补池历史上照样占一格：时间、通道、耗时都要给齐。
    expect(out.at).toBe(NOW);
    expect(out.primaryChannel).toBe("yyds");
    // 什么都没学到 ⇒ 一次写都不发。
    expect(saved).toEqual([]);
  });

  /**
   * **反向控制。** 没有它的话，一个「无条件早退」的实现在上面那格也是绿的
   * —— 而那等于把注册机整个关掉。
   */
  it("退避已经到期时照常开跑（判据是 until > now 这一处值比较，陈旧的键拦不住任何人）", async () => {
    const { deps, calls } = makeDeps({
      until: NOW - 1, kind: "edge", since: NOW - 60_000, hits: 1,
    });
    const out = await tendOnce(deps);
    expect(out.attempted).toBe(5);
    expect(out.minted).toBe(5);
    expect(calls.created).toBeGreaterThan(0);
  });

  it("压根没有退避键时照常开跑", async () => {
    const { deps } = makeDeps(null);
    expect((await tendOnce(deps)).minted).toBe(5);
  });
});
