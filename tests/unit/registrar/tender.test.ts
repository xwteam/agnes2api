import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { tendOnce, type TendFailureReason, type TendDeps } from "../../../src/core/registrar/tender.js";
import { KeyPoolRepo } from "../../../src/core/keypool-repo.js";
import { countsTowardTarget, isAvailable } from "../../../src/core/keypool.js";
import { KEY_PREFIX } from "../../../src/core/pool-index.js";
import { MemoryStorage } from "../../helpers/fake-storage.js";
import { FakeMailProvider } from "../../helpers/fake-mailbox.js";
import type { MailProvider } from "../../../src/ports/mailbox.js";
import type { Channel, RegistrarConfig } from "../../../src/core/registrar/config.js";
import { recordingLogger } from "../../helpers/recording-logger.js";
import { NULL_LOGGER } from "../../../src/ports/logger.js";

// 显式标注 RegistrarConfig：brief 给的字面量没有类型注解，`fallback: null` 会被
// 收窄成字面量类型 null 而非 Channel | null，下面按测试用例覆盖成 "moemail" 时
// 类型检查会报错（vitest 的 esbuild 转换不做类型检查，只有 tsc --noEmit 会揪出）。
const CFG: RegistrarConfig = {
  enabled: true, primary: "yyds", fallback: null,
  targetKeys: 3, mintBatch: 5, tendIntervalMs: 1000, codeTimeoutMs: 5000,
  mintDelayMinMs: 1, mintDelayMaxMs: 1, maxDomainAttempts: 8,
  tokenName: "auto", agnesPlatformUrl: "https://platform.test",
  yyds: { baseUrl: "https://y.test", apiKey: "k" }, moemail: null,
};

function agnesOk() {
  return {
    platformUrl: "https://platform.test",
    fetcher: {
      async fetch(url: string) {
        if (url.includes("/api/user/login")) {
          return new Response(JSON.stringify({ data: { access_token: "tok" } }), { status: 200 });
        }
        if (url.includes("/api/token")) {
          return new Response(JSON.stringify({ data: { key: `sk-${Math.random().toString(36).slice(2, 10)}` } }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
    },
  };
}

/** 与 `agnesOk()` 同形，但 `/api/token` 固定发回指定的那一串 key。 */
function agnesWithKey(key: string) {
  return {
    platformUrl: "https://platform.test",
    fetcher: {
      async fetch(url: string) {
        if (url.includes("/api/user/login")) {
          return new Response(JSON.stringify({ data: { access_token: "tok" } }), { status: 200 });
        }
        if (url.includes("/api/token")) {
          return new Response(JSON.stringify({ data: { key } }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
    },
  };
}

async function makeDeps(over: Partial<RegistrarConfig> = {}, provider: MailProvider = new FakeMailProvider()) {
  const repo = new KeyPoolRepo(new MemoryStorage(), { now: () => 1000, logger: NULL_LOGGER });
  const providers: Partial<Record<Channel, MailProvider>> = { yyds: provider };
  // 显式标注 TendDeps：不标的话推断出的是这个字面量的形状，用例里给可选字段
  // （roundBudgetMs）赋值会被 tsc 拒绝，而 vitest 的 esbuild 转换不做类型检查，
  // 只有 `pnpm typecheck` 会揪出来——这也是发版清单必须把 typecheck 与 test
  // 并列为必跑项的原因。
  // logger: NULL_LOGGER 而不是共享一个 recordingLogger() 实例——后者会在全文件所有用例
  // 间共享同一个 entries 数组，不检查日志内容的用例也会悄悄往里面塞条目。下面两条关心
  // 预算日志的用例会各自局部覆盖成一个新的 recordingLogger()。
  const deps: TendDeps = {
    repo, config: { ...CFG, ...over },
    providers,
    agnes: agnesOk(), now: () => 1000, sleep: async () => {}, rand: () => 0.5,
    logger: NULL_LOGGER,
  };
  return { repo, deps };
}

describe("tendOnce", () => {
  it("failures[].reason 是联合类型而不是裸 string（消费时要能拿到穷尽检查）", () => {
    // 这条断言真正生效的地方是 `tsc --noEmit`：把 reason 退回 string 之后，下面
    // 的 @ts-expect-error 会变成"未使用的指令"从而让类型检查失败。运行时断言只是
    // 顺带确认取值。
    const ok: TendFailureReason = "code_timeout";
    // @ts-expect-error 不在联合里的 reason 必须在类型层就被挡住
    const bad: TendFailureReason = "not_a_real_reason";
    expect(ok).toBe("code_timeout");
    expect(bad).toBe("not_a_real_reason");
  });

  it("未启用时立即返回且零副作用", async () => {
    const { repo, deps } = await makeDeps({ enabled: false });
    const out = await tendOnce(deps);
    expect(out.skipped).toBe(true);
    expect(out.minted).toBe(0);
    expect(await repo.all()).toHaveLength(0);
  });

  it("空池时补到目标数", async () => {
    const { repo, deps } = await makeDeps();
    const out = await tendOnce(deps);
    expect(out.minted).toBe(3);
    expect(await repo.all()).toHaveLength(3);
  });

  /**
   * **主通道铸出来时，`mintedByChannel` 记的是主通道名。**
   *
   * ⚠️ **成因如实登记**：上一轮只补了「备通道铸出时不记到主通道名下」那一半，
   * 变异「主通道铸出来的一律不记」（`if (ch !== primary) …`）**1541 全绿、ESCAPED**。
   * **而生产上绝大多数轮次就是主通道铸出来的**——那正是面板每天要渲染的那一栏。
   * 两格必须并排放：单独任何一格都留着一半可以随便改。
   */
  it("主通道铸出来时 mintedByChannel 记在主通道名下（不是空表）", async () => {
    const { deps } = await makeDeps();
    const out = await tendOnce(deps);
    // 手写字面量：三把全由主通道 yyds 铸出。
    expect(out.mintedByChannel).toEqual({ yyds: 3 });
    expect(out.primaryChannel).toBe("yyds");
  });

  it("已达目标数时不铸", async () => {
    const { repo, deps } = await makeDeps();
    for (const k of ["a", "b", "c"]) await repo.add(k);
    const out = await tendOnce(deps);
    expect(out.attempted).toBe(0);
    expect(out.minted).toBe(0);
  });

  it("单轮不超过 mintBatch", async () => {
    const { deps } = await makeDeps({ targetKeys: 10, mintBatch: 2 });
    expect((await tendOnce(deps)).attempted).toBe(2);
  });

  /**
   * 名额判据的**排除清单只有一项：`evicted`**（后来收窄，此前是三项里的两项）。
   * 三把 key **给的是不同的字段组合**，所以这一格能分辨「判据看错了字段」与
   * 「判据压根没生效」：只有被剔除的那把腾出名额 ⇒ `available` 2、缺口 1。
   */
  it("只有已剔除的 key 腾出名额，冷却中的与被停用的都**照样计入**", async () => {
    const { repo, deps } = await makeDeps();
    const a = await repo.add("a"); await repo.save({ ...a, evicted: true });
    const b = await repo.add("b"); await repo.save({ ...b, cooldownUntil: 999_999 });
    const c = await repo.add("c"); await repo.save({ ...c, disabled: true }, c);
    const out = await tendOnce(deps);
    expect(out.available).toBe(2);
    expect(out.minted).toBe(1);
  });

  /**
   * ⚠️ **评审发现：这一格守的是「停用一把 key 不许触发一次自动注册」。**
   *
   * `tendOnce` 拿 `targetKeys - available` 当缺口，**差多少就真的去注册多少个 Agnes 账号**。
   * 名额判据若用 `isAvailable`（它现在排除被停用的 key），后果实测为：
   * `available` 3→2、`minted` 0→1、池子 3→4 把。**而且永不自愈**——冷却会自己回来、
   * 下一轮缺口归零，停用不会，那把只要还停着，**每一轮 Cron 都把缺口重新填满**。
   * 「全停 20 把以暂停这个池子」就是 20 次注册。
   *
   * **变红条件**：`tender.ts` 的 `countsTowardTarget` 换回 `isAvailable`。
   * 断言分两半，缺一不可：`minted`（这一轮铸没铸）与**池子实际条数**（真落盘没有）。
   *
   * ✅ **这条保证后来从「有条件」变成无条件了**，用例名里原来那三个字
   *（「不在冷却」）已经去掉。判据现在是 `!r.evicted`，`disabled + cooling` 的组合
   * 由下面那一格正面钉着——那一格在此之前断言的是相反的行为。
   */
  it("停用一把 key 不触发补池——停用不是「这把死了」，别拿它当缺口", async () => {
    const { repo, deps } = await makeDeps();          // targetKeys: 3
    for (const k of ["a", "b", "c"]) await repo.add(k);
    const steady = await tendOnce(deps);
    expect(steady.available, "前置条件：稳态三把全占名额").toBe(3);
    expect(steady.minted, "前置条件：稳态一把都不铸").toBe(0);

    const one = (await repo.all())[0]!;
    await repo.save({ ...one, disabled: true }, one);

    const after = await tendOnce(deps);
    expect(after.available, "停用的 key 仍占 targetKeys 名额").toBe(3);
    expect(after.minted, "停用一把 = 自动注册一个新 Agnes 账号（建邮箱 + 注册 + 建 token）").toBe(0);
    expect(await repo.all(), "池子不许因为一次停用就长大").toHaveLength(3);
  });

  /**
   * **同一条不变量的另一半：停用一把**正在冷却**的 key 同样不触发补池。**
   *
   * ⚠️ **这一格早先断言的是相反的行为**（它当时叫「【已知残留】…仍会
   * 触发补池」，如实钉着一个错着的行为）。当时的判据是
   * `!evicted && cooldownUntil <= now`：`disabled + cooling` 落在冷却那一支上 ⇒
   * 不占名额 ⇒ 照样铸一把新的，而冷却到期之后 `need` 转负、**多铸的那一把再也不会
   * 退掉**。实测过的数字就是下面这几个，只是当时期望写的是 `available: 2 / minted: 1 /
   * 池子 4`。
   *
   * **它落在最常见的路径上**：运维最可能去停用一把 key 的起因，正是面板上显示它
   * 「冷却中」（被限流 / 异常）。上一格用的是 `repo.add()` 出来的 fresh key，
   * 四态等价那格的「已停用」也是 `cooldownUntil: 0`——**这个组合原来一格都没有**，
   * 于是上一格那条保证被写成了无条件的。
   *
   * **变红条件**：`countsTowardTarget` 加回 `&& r.cooldownUntil <= now`。
   */
  it("停用一把**正在冷却**的 key 同样不触发补池——两个方向合起来才是完整的那条保证", async () => {
    let t = 1000;
    const repo = new KeyPoolRepo(new MemoryStorage(), { now: () => t, logger: NULL_LOGGER });
    const deps: TendDeps = {
      repo, config: { ...CFG },
      providers: { yyds: new FakeMailProvider() },
      agnes: agnesOk(), now: () => t, sleep: async () => {}, rand: () => 0.5, logger: NULL_LOGGER,
    };
    for (const k of ["a", "b", "c"]) await repo.add(k);
    expect((await tendOnce(deps)).minted, "前置条件：稳态一把都不铸").toBe(0);

    // 先冷却，再停用——这正是运维在面板上会做的顺序。
    const one = (await repo.all())[0]!;
    await repo.save({ ...one, cooldownUntil: t + 60_000, cooldownReason: "rate limited" }, one);
    const cooled = (await repo.all()).find((r) => r.id === one.id)!;
    await repo.save({ ...cooled, disabled: true }, cooled);

    const out = await tendOnce(deps);
    expect(out.available, "冷却中的、被停用的，两种都占名额").toBe(3);
    expect(out.minted, "停用一把冷却中的 key = 自动注册一个新 Agnes 账号").toBe(0);
    expect(await repo.all(), "池子不许因为一次「停用冷却中的 key」就长大").toHaveLength(3);

    // 冷却到期之后同样不铸：`need` 从头到尾都是 0，不存在「先铸了再也退不掉」这回事。
    t += 120_000;
    const after = await tendOnce(deps);
    expect(after.minted).toBe(0);
    expect(await repo.all(), "池子在整个过程里一把都没多").toHaveLength(3);
  });

  /**
   * **全池限流风暴不再让池子永久变大。**
   *
   * ⚠️ **这一格钉的是当时修掉的第二条同族缺陷，实测数字如下**
   *（`targetKeys = 3`，修复前）：稳态 3 → 全池冷却那一轮 `minted = 3` ⇒ 池子 **6**；
   * 冷却到期 `need = -3` 不再铸 ⇒ **永久停在 6**；下一次风暴 **9**，再下一次 **12**。
   * **线性，每一次全池风暴永久 `+targetKeys`，不是翻倍，也不会自己退回去**——
   * 而每一把都是一次真实的 Agnes 建号 + 一个真实花掉的临时邮箱。
   *
   * 跑**两轮风暴**而不是一轮：只跑一轮的话「+3」与「+3 再 +3」区分不开，
   * 而"线性增长"这条性质恰恰要第二轮才看得出来。
   *
   * **变红条件**：`countsTowardTarget` 加回 `&& r.cooldownUntil <= now`
   *（则第一轮风暴后是 6、第二轮后是 9）。
   */
  it("整池被限流冷却时不铸替补——否则每一次风暴都让池子永久 +targetKeys（线性、不退回）", async () => {
    let t = 1000;
    const repo = new KeyPoolRepo(new MemoryStorage(), { now: () => t, logger: NULL_LOGGER });
    const deps: TendDeps = {
      repo, config: { ...CFG },
      providers: { yyds: new FakeMailProvider() },
      agnes: agnesOk(), now: () => t, sleep: async () => {}, rand: () => 0.5, logger: NULL_LOGGER,
    };
    for (const k of ["a", "b", "c"]) await repo.add(k);
    expect((await repo.all()).length, "前置条件：稳态三把").toBe(3);

    /** 把整池打进冷却，跑一轮补池，返回这一轮铸了几把。 */
    const storm = async (): Promise<number> => {
      for (const r of await repo.all()) {
        await repo.save({ ...r, cooldownUntil: t + 60_000, cooldownReason: "rate limited" }, r);
      }
      const out = await tendOnce(deps);
      t += 120_000;   // 冷却到期
      return out.minted;
    };

    expect(await storm(), "第一次全池风暴：不许铸替补").toBe(0);
    expect((await repo.all()).length, "第一次风暴后池子仍是 3（修复前实测 6）").toBe(3);
    expect(await storm(), "第二次全池风暴：同样不许铸").toBe(0);
    expect((await repo.all()).length, "第二次风暴后仍是 3（修复前实测 9 —— 线性增长）").toBe(3);
  });

  /**
   * **名额判据与「能不能打上游」是两个问题，逐格穷举它们的分歧。**
   *
   * ⚠️ **后来把判据收成 `!r.evicted`，分歧从一格变成三格**（这一格在那
   * 之前叫「…只在『已停用』这一项上分歧」，并且带着一行标了 🔴 的已知残留）。
   * 现在 `countsTowardTarget` **与时间无关**：占不占名额只看有没有被剔除。
   *
   * 拿**手写的期望表**比，不从 `isAvailable` 反推（那是同义反复，第 6 种假阳性）：
   * 五种状态各写一次字面量，两列各自独立写死。
   */
  it("名额判据只看 evicted：冷却中 / 已停用 / 两者兼有都占名额，而它们都不能打上游", () => {
    const NOW = 1000;
    const base = {
      id: "i", key: "k", addedAt: 0, lastUsedAt: null,
      cooldownReason: null, strikes: 0, evictedReason: null,
    };
    const CASES = [
      { name: "全新", rec: { ...base, cooldownUntil: 0, evicted: false }, counts: true, available: true },
      // 下面四格里有三格两列不同 —— **那三格正是这个函数存在的全部理由**。
      { name: "冷却中", rec: { ...base, cooldownUntil: NOW + 1, evicted: false }, counts: true, available: false },
      { name: "已剔除", rec: { ...base, cooldownUntil: 0, evicted: true }, counts: false, available: false },
      { name: "已停用", rec: { ...base, cooldownUntil: 0, evicted: false, disabled: true }, counts: true, available: false },
      { name: "已停用且冷却中", rec: { ...base, cooldownUntil: NOW + 1, evicted: false, disabled: true }, counts: true, available: false },
      // **已剔除 + 冷却中**：两条判据在这一格上不许互相盖过——`evicted` 说了算。
      { name: "已剔除且冷却中", rec: { ...base, cooldownUntil: NOW + 1, evicted: true }, counts: false, available: false },
    ];
    for (const { name, rec, counts, available } of CASES) {
      expect(countsTowardTarget(rec), `${name}：占不占名额`).toBe(counts);
      expect(isAvailable(rec, NOW), `${name}：能不能拿去打上游`).toBe(available);
    }
    // **反向：判据必须与时间无关。** 同一条冷却中的记录，把时钟拨到冷却到期之后，
    // 答案不许变——变了就说明 `cooldownUntil` 又爬回判据里去了。
    const cooling = { ...base, cooldownUntil: NOW + 1, evicted: false };
    expect(countsTowardTarget(cooling), "冷却期内").toBe(true);
    expect(isAvailable(cooling, NOW + 999), "前置条件：时钟真的走过了冷却").toBe(true);
    expect(countsTowardTarget(cooling), "冷却到期后：答案必须与冷却期内逐字相同").toBe(true);
  });

  /**
   * **铸号侧的可疑 key：照存不误 + 如实报可疑**（评审 m5 裁定，后来落地）。
   *
   * `isImportableKey` 此前**只挂在面板导入这条「人点一下」的路径上**，而稳态下 key
   * 进池子的主路径是 `tendOnce` 里那行 `repo.add(out.key)`——既不校验也不 trim。
   * **同一个判据在两条路上不能有同一种处置**：导入拒绝是免费的（东西还在剪贴板里），
   * 铸号拒绝是**销毁凭据**（账号已在上游真的建出来、key 只有手上这一份）。
   *
   * **两个方向同一格**：可疑的报出来、正常的一个字都不多说。只写前一半的话，
   * 一个「每一把都报可疑」的实现照样全绿（第 5 种假阳性）。
   * **变红条件**：把 `isImportableKey` 那个判断整个删掉（前半红）；
   * 或把它取反（后半红）。
   */
  it("上游发回可疑的 key 材料：照存不误，同时 failures 与事件各留一条", async () => {
    const SUSPICIOUS = "sk-坏掉的key 里面有空格和汉字";
    const logger = recordingLogger();
    const { repo, deps } = await makeDeps({ targetKeys: 1 });
    deps.logger = logger;
    deps.agnes = agnesWithKey(SUSPICIOUS);

    const out = await tendOnce(deps);
    expect(out.minted, "上游账号是真的建出来了，说 0 就是伪造").toBe(1);
    expect(out.mintedByChannel).toEqual({ yyds: 1 });
    expect(out.failures, "补池历史那一行必须说得出这一轮有什么不对劲")
      .toEqual([{ reason: "key_suspicious", channel: "yyds" }]);

    const stored = await repo.all();
    expect(stored, "照存不误：拒收 = 销毁凭据 = 数据丢失").toHaveLength(1);
    expect(stored[0]!.key, "存进去的必须是原样那一串，不许 trim、不许改写").toBe(SUSPICIOUS);

    const ev = logger.entries.find((e) => e.event === "registrar.minted_key_suspicious");
    expect(ev?.level, "运维必须看得见，且要 error 级").toBe("error");
    expect(ev?.fields?.channel).toBe("yyds");
    expect(ev?.fields?.keyLength).toBe(SUSPICIOUS.length);
    // 日志常被转发到第三方：只报长度与通道，够定位、不够泄漏（约束 11(a)）。
    expect(JSON.stringify(ev), "事件里带了明文 key").not.toContain(SUSPICIOUS);

    // ── 镜像另一半：正常的 key 一个字都不多说 ──────────────────────────────
    const clean = recordingLogger();
    const { deps: deps2 } = await makeDeps({ targetKeys: 1 });
    deps2.logger = clean;
    deps2.agnes = agnesWithKey("sk-perfectly-normal-key-0123456789");
    const ok = await tendOnce(deps2);
    expect(ok.minted).toBe(1);
    expect(ok.failures, "正常的 key 不许被报成可疑").toEqual([]);
    expect(clean.has("registrar.minted_key_suspicious")).toBe(false);
  });

  it("单次失败不中断整轮（域名全被拒 domain_blocked_all）", async () => {
    // 域名全被拒 → 每次 mintOne 都失败，但仍应尝试满 batch 次
    const provider = new FakeMailProvider({ domains: ["x.test"] });
    const { deps } = await makeDeps({ targetKeys: 3 }, provider);
    deps.agnes = {
      platformUrl: "https://platform.test",
      fetcher: { async fetch(url: string) {
        return new Response("{}", { status: url.includes("/api/verification") ? 400 : 200 });
      } },
    };
    const out = await tendOnce(deps);
    expect(out.attempted).toBe(3);
    expect(out.minted).toBe(0);
    expect(out.failures).toHaveLength(3);
    expect(out.failures.every((f) => f.reason === "domain_blocked_all")).toBe(true);
  });

  it("上游整体故障（upstream_error）时本轮立即回退，不把 mintBatch 耗完", async () => {
    // 与上一条对照：同样是「每次都失败」，但这次的非 2xx 不是 400（域名屏蔽）而是
    // 500（上游整体故障）。domain_blocked_all 换一轮还有机会，upstream_error
    // 换通道/换轮都打的是同一个瘫痪的后端，继续尝试没有意义，必须立刻停止本轮，
    // 而不是像上一条那样把 3 次名额都用掉。两条测试给的状态码不同、断言的
    // attempted 也不同，避免「谁赢都通过」的假阳性。
    const provider = new FakeMailProvider({ domains: ["x.test"] });
    const { deps } = await makeDeps({ targetKeys: 3 }, provider);
    deps.agnes = {
      platformUrl: "https://platform.test",
      fetcher: { async fetch(url: string) {
        return new Response("{}", { status: url.includes("/api/verification") ? 500 : 200 });
      } },
    };
    const out = await tendOnce(deps);
    expect(out.attempted).toBe(1);
    expect(out.minted).toBe(0);
    expect(out.failures).toEqual([{ reason: "upstream_error", channel: "yyds" }]);
  });

  it("主通道通道级失败时降级到备通道", async () => {
    // 注意：这条覆盖的是**列域名失败**那一种。下面 broken.createMailbox 那行永远
    // 走不到（listDomains 先抛错，mintOne 直接返回），另一种通道级失败——「所有
    // 域名上都建不出邮箱」——由紧随其后的那条用 failCreateOn 的用例覆盖。
    const broken: MailProvider = {
      name: "yyds" as const,
      async listDomains(): Promise<string[]> { throw new Error("down"); },
      async createMailbox() { throw new Error("x"); },
      async pollCode() { return null; },
      async deleteMailbox() {},
    };
    const backup = new FakeMailProvider();
    const { repo, deps } = await makeDeps({ fallback: "moemail", targetKeys: 1 });
    deps.providers = { yyds: broken, moemail: backup };
    const out = await tendOnce(deps);
    expect(out.minted).toBe(1);
    expect(backup.created.length).toBe(1);
    expect(await repo.all()).toHaveLength(1);
  });

  it("主通道在所有域名上都建不出邮箱时也降级到备通道（通道级失败的第二种形态）", async () => {
    // 这是 fake-mailbox 的 failCreateOn 选项存在的理由，此前全仓零使用：域名列得
    // 出来、但每个域名的 createMailbox 都失败（凭据失效、活跃邮箱配额耗尽、邮箱
    // 服务挂了）。设计 §4.5 与五语言用户文档都承诺这种情况会降级，此前它被归成
    // domain_blocked_all，备通道永不启用。
    const brokenCreate = new FakeMailProvider({
      domains: ["a.test", "b.test", "c.test"],
      failCreateOn: ["a.test", "b.test", "c.test"],
    });
    const backup = new FakeMailProvider();
    const { repo, deps } = await makeDeps({ fallback: "moemail", targetKeys: 1 });
    deps.providers = { yyds: brokenCreate, moemail: backup };
    const out = await tendOnce(deps);
    expect(out.minted).toBe(1);
    expect(brokenCreate.created).toEqual([]);
    // 备通道确实被调用了（不是"主通道恰好也成功了"这种殊途同归）。
    expect(backup.created).toHaveLength(1);
    expect(out.failures).toEqual([{ reason: "provider_error", channel: "yyds" }]);
    expect(await repo.all()).toHaveLength(1);
  });

  // === M1：主通道收不到验证码也是通道级失败，必须降级 ===

  it("主通道收不到验证码（code_timeout）时降级到备通道，且 key 真的进了池子", async () => {
    // 死亡链的新变体：邮箱通道的 API 全 2xx（建邮箱/删邮箱/列域名一切正常），
    // 只是验证码永远收不到——MX 记录失效、Cloudflare Email Routing 的 catch-all
    // 规则被删都是这个形态。此前 code_timeout 被归进「换通道也没用」，备通道
    // 配好了也一次都不会被调用，key 池耗尽后网关整体不可用。
    //
    // 断言的是**真实效果**而不是「mock 被调过」：池子里确实多了一把 key，且那把
    // key 是备通道那条链路铸出来的。
    const deadPrimary = new FakeMailProvider({ domains: ["a.test", "b.test"], code: null });
    const backup = new FakeMailProvider();
    const { repo, deps } = await makeDeps({ fallback: "moemail", targetKeys: 1 });
    deps.providers = { yyds: deadPrimary, moemail: backup };
    deps.agnes = {
      platformUrl: "https://platform.test",
      fetcher: {
        async fetch(url: string) {
          if (url.includes("/api/user/login")) {
            return new Response(JSON.stringify({ data: { access_token: "tok" } }), { status: 200 });
          }
          if (url.includes("/api/token")) {
            return new Response(JSON.stringify({ data: { key: "sk-from-fallback" } }), { status: 200 });
          }
          return new Response("{}", { status: 200 });
        },
      },
    };
    const out = await tendOnce(deps);
    expect(out.minted).toBe(1);
    // 备通道确实被走了一遍（建了邮箱），不是「主通道后来自己好了」。
    expect(backup.created).toHaveLength(1);
    expect(out.failures).toEqual([{ reason: "code_timeout", channel: "yyds" }]);
    const all = await repo.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.key).toBe("sk-from-fallback");

    // **战绩必须记在真正铸出来的那条通道名下**（评审发现）。
    // 防住的真实故障：`minted` 只有总数，而 `minted++` 发生在 `for (const ch of chain)`
    // 里——**一轮全靠备通道铸出来时，总数记在谁名下是看不出来的**。没有这个字段，
    // 面板只能拿 `primaryChannel` 去顶，于是备通道的战绩被持续记到主通道头上，
    // **与「两条邮箱通道完全平级」那条硬约束正面冲突**。
    // 变红条件：`mintedByChannel[ch]` 写成 `mintedByChannel[primary]`。
    expect(out.mintedByChannel, "备通道铸出来的 key 被记到主通道名下了")
      .toEqual({ moemail: 1 });
    expect(out.primaryChannel, "主通道字段照常是主通道 —— 它回答的是另一个问题")
      .toBe("yyds");
  });

  it("主通道收不到验证码时不会在通道内换域名死等（单次尝试只烧一份 codeTimeoutMs 的预算）", async () => {
    // 与上一条成对：降级是对的，但不能顺手把「逐个域名重试」也带进来——那会让
    // 单次铸 key 最坏耗时变成 MAX_DOMAIN_ATTEMPTS × CODE_TIMEOUT_MS，远超
    // Worker Cron 的 900 秒墙钟（详见 tender.ts 的 case "code_timeout" 注释）。
    // 主通道给 5 个域名、验证码永远收不到：pollCode 只该被调 1 次。
    let polls = 0;
    const deadPrimary = new FakeMailProvider({
      domains: ["a.test", "b.test", "c.test", "d.test", "e.test"], code: null,
    });
    deadPrimary.pollCode = async () => { polls++; return null; };
    const backup = new FakeMailProvider();
    const { deps } = await makeDeps({ fallback: "moemail", targetKeys: 1 });
    deps.providers = { yyds: deadPrimary, moemail: backup };
    const out = await tendOnce(deps);
    expect(polls).toBe(1);
    expect(out.minted).toBe(1);
  });

  it("无备通道时主通道收不到验证码：本次失败，但剩余名额继续尝试（不整轮中止）", async () => {
    // 单通道部署没有出口，但也不该把整轮砍掉——下一次尝试会重新洗牌域名，
    // 「个别域名 MX 坏了」这种情况靠重抽就能恢复。
    const deadPrimary = new FakeMailProvider({ domains: ["a.test", "b.test"], code: null });
    const { deps } = await makeDeps({ targetKeys: 3 }, deadPrimary);
    const out = await tendOnce(deps);
    expect(out.attempted).toBe(3);
    expect(out.minted).toBe(0);
    expect(out.failures.every((f) => f.reason === "code_timeout")).toBe(true);
  });

  it("无备通道时主通道失败即本次失败", async () => {
    const broken: MailProvider = {
      name: "yyds" as const,
      async listDomains(): Promise<string[]> { throw new Error("down"); },
      async createMailbox() { throw new Error("x"); },
      async pollCode() { return null; },
      async deleteMailbox() {},
    };
    const { deps } = await makeDeps({ targetKeys: 1 });
    deps.providers = { yyds: broken };
    const out = await tendOnce(deps);
    expect(out.minted).toBe(0);
    expect(out.failures[0]!.reason).toBe("provider_error");
  });

  it("撞上限流（rate_limited）时不中止整轮、也不换通道：与 upstream_error 的退避刻意不同", async () => {
    // 与上面 upstream_error 那条对照：同样是"每次都失败"，但 403 是限流——等一下
    // 再试是有用的，整轮中止只会把恢复拖到下一个调度周期。两条断言的 attempted
    // 不同（3 vs 1），避免"谁赢都通过"。
    const provider = new FakeMailProvider({ domains: ["x.test"] });
    const backup = new FakeMailProvider();
    const { deps } = await makeDeps({ targetKeys: 3, fallback: "moemail" }, provider);
    deps.providers = { yyds: provider, moemail: backup };
    deps.agnes = {
      platformUrl: "https://platform.test",
      fetcher: { async fetch(url: string) {
        return new Response("{}", { status: url.includes("/api/verification") ? 403 : 200 });
      } },
    };
    const out = await tendOnce(deps);
    expect(out.attempted).toBe(3);
    expect(out.minted).toBe(0);
    expect(out.failures.every((f) => f.reason === "rate_limited")).toBe(true);
    expect(backup.created).toEqual([]);
  });

  it("网络层错误不让整轮 reject：TendResult 照常返回，剩余名额继续尝试，且不换通道", async () => {
    // 五处 fetcher.fetch 任何一处 reject 此前都会穿透 mintOne → tendOnce 整轮
    // reject，剩余名额作废、TendResult（面板要展示的数据）也拿不到。
    const provider = new FakeMailProvider({ domains: ["x.test"] });
    const backup = new FakeMailProvider();
    const { repo, deps } = await makeDeps({ targetKeys: 3, fallback: "moemail" }, provider);
    deps.providers = { yyds: provider, moemail: backup };
    deps.agnes = {
      platformUrl: "https://platform.test",
      fetcher: { async fetch(): Promise<Response> { throw new Error("ECONNRESET"); } },
    };
    const out = await tendOnce(deps);
    expect(out.attempted).toBe(3);
    expect(out.minted).toBe(0);
    expect(out.failures).toEqual([
      { reason: "network_error", channel: "yyds" },
      { reason: "network_error", channel: "yyds" },
      { reason: "network_error", channel: "yyds" },
    ]);
    // 打的是同一个 Agnes 后端，换邮箱通道没有意义：备通道一次都不该被调用。
    expect(backup.created).toEqual([]);
    expect(await repo.all()).toHaveLength(0);
  });

  it("顺序铸 key，不并发：每一次的建邮箱/删邮箱必须成对完成才能进入下一次", async () => {
    // 守护「顺序执行不并发」这条业务硬约束：如果实现改成 Promise.all，三次
    // mintOne 的 createMailbox 会在任何一次的 deleteMailbox 之前就抢跑，
    // order 就不会是严格的 create/delete 交替，这条断言会先变红。
    const order: string[] = [];
    let n = 0;
    const provider: MailProvider = {
      name: "yyds" as const,
      async listDomains() { return ["a.test"]; },
      async createMailbox(domain: string) {
        const address = `u${n++}@${domain}`;
        order.push(`create:${address}`);
        return { address, handle: address };
      },
      async pollCode() { return "123456"; },
      async deleteMailbox(m) { order.push(`delete:${m.address}`); },
    };
    const { deps } = await makeDeps({ targetKeys: 3 }, provider);
    const out = await tendOnce(deps);
    expect(out.minted).toBe(3);
    expect(order).toEqual([
      "create:u0@a.test", "delete:u0@a.test",
      "create:u1@a.test", "delete:u1@a.test",
      "create:u2@a.test", "delete:u2@a.test",
    ]);
  });

  // === 轮级墙钟预算：永远不启动一次明知跑不完的尝试 ===
  //
  // 存在的理由是那条死亡链：Worker Cron 撞 15 分钟墙钟 → 平台**直接中止** →
  // 此刻在 mintOne try 块里的邮箱，它的 finally（deleteMailbox）不执行 → 邮箱泄漏
  // 且零日志 → 活跃邮箱配额被吃光 → 建邮箱一律失败。M1 把 code_timeout 改成通道级
  // 降级之后，「两条通道都收不到信」这个场景的单轮最坏耗时翻倍到 1200 秒，撞穿
  // 900 秒墙钟，所以必须在 tender 里主动收手，而不是靠文档让用户调 MINT_BATCH。
  //
  // 下面三条统一用**递进假时钟**：`pollCode` 每次推进 codeTimeoutMs（模拟等满验证码
  // 超时），`sleep` 推进它自己的毫秒数。这样 `deps.now()` 是真的在走，预算判据被
  // 真实地求值，而不是靠断言某个字段存在。
  function clockedProvider(name: Channel, tick: () => void, order: string[]): MailProvider {
    let n = 0;
    return {
      name: name as "yyds",
      async listDomains() { return ["a.test"]; },
      async createMailbox(domain: string) {
        const address = `${name}-u${n++}@${domain}`;
        order.push(`create:${address}`);
        return { address, handle: `id-${address}` };
      },
      async pollCode() { tick(); return "123456"; },
      async deleteMailbox(m) { order.push(`delete:${m.address}`); },
    };
  }

  it("预算只够 2 次尝试而 mintBatch=5 时：只尝试 2 次，且两次都完整跑完（邮箱都删了）", async () => {
    let t = 0;
    const order: string[] = [];
    const provider = clockedProvider("yyds", () => { t += 5000; }, order);
    const { repo, deps } = await makeDeps({ targetKeys: 5, mintBatch: 5, codeTimeoutMs: 5000 }, provider);
    deps.now = () => t;
    deps.sleep = async (ms: number) => { t += ms; };
    // 单次最坏 = codeTimeoutMs × chain 长度 = 5000 × 1。预算 12000 只装得下 2 次
    // （第 3 次开始前已用 10001ms，10001 + 1 + 5000 = 15002 > 12000）。
    deps.roundBudgetMs = 12_000;

    const out = await tendOnce(deps);

    // ① 少铸而不是被砍断：只开始了 2 次。
    expect(out.attempted).toBe(2);
    expect(out.minted).toBe(2);
    // ② 已经铸到的 key 正常返回并真的进了池子。
    expect(await repo.all()).toHaveLength(2);
    // ③ **没有任何一次尝试是被中途打断的**：每个建出来的邮箱都紧跟着一次删除，
    //    create/delete 严格成对交替。这条才是预算机制存在的全部意义——被平台从
    //    中间砍断时，最后那次的 delete 是不会出现的。
    expect(order).toEqual([
      "create:yyds-u0@a.test", "delete:yyds-u0@a.test",
      "create:yyds-u1@a.test", "delete:yyds-u1@a.test",
    ]);
  });

  it("不传 roundBudgetMs 时行为完全不变（Node/Docker 侧零回归）", async () => {
    // 与上一条**同一份时钟、同一个 provider、同一个 mintBatch**，唯一的差别是没有
    // 预算。断言 5 次全跑满——这条成对用例锁住「可选」这个语义，防止预算被写成
    // 无条件生效（那样 Node 会平白少铸 key）。
    let t = 0;
    const order: string[] = [];
    const provider = clockedProvider("yyds", () => { t += 5000; }, order);
    const { repo, deps } = await makeDeps({ targetKeys: 5, mintBatch: 5, codeTimeoutMs: 5000 }, provider);
    deps.now = () => t;
    deps.sleep = async (ms: number) => { t += ms; };

    const out = await tendOnce(deps);

    expect(out.attempted).toBe(5);
    expect(out.minted).toBe(5);
    expect(await repo.all()).toHaveLength(5);
    expect(order).toHaveLength(10);
  });

  it("配了备通道时预算按两条通道算，同样的预算装得下的尝试更少", async () => {
    // 单次最坏 = codeTimeoutMs × chain 长度，chain 长度随 fallback 变。与第一条
    // **预算、时钟、codeTimeoutMs 全部相同**，只多配一条备通道：装得下的次数从
    // 2 掉到 1。把 `× chain.length` 去掉（写成只乘 1）这条就会红。
    let t = 0;
    const order: string[] = [];
    const primary = clockedProvider("yyds", () => { t += 5000; }, order);
    const backup = clockedProvider("moemail", () => { t += 5000; }, order);
    const { deps } = await makeDeps({
      targetKeys: 5, mintBatch: 5, codeTimeoutMs: 5000, fallback: "moemail",
    }, primary);
    deps.providers = { yyds: primary, moemail: backup };
    deps.now = () => t;
    deps.sleep = async (ms: number) => { t += ms; };
    deps.roundBudgetMs = 12_000;

    const out = await tendOnce(deps);

    expect(out.attempted).toBe(1);
    expect(out.minted).toBe(1);
    // 主通道就成功了，备通道不该被碰（否则说明失败的是别的东西）。
    expect(order).toEqual(["create:yyds-u0@a.test", "delete:yyds-u0@a.test"]);
  });

  it("I-1 预算连一次尝试都装不下时，记 registrar.round_budget_impossible 且级别是 error（与「本轮提前收尾」区分开）", async () => {
    // 这是永久停摆而不是瞬时状况：每一轮都 attempted=0 / minted=0 / failures=[]，
    // 两个入口的归因日志走 `minted < attempted`（0<0 为假）一条都不打，这条 error
    // 是唯一能说破它的地方。断言的是**事件名与级别**——console.* 已经被换成注入的
    // Logger，spy console 只会看到空 mock，必须改成 recordingLogger 断言真实效果。
    const logger = recordingLogger();
    let t = 0;
    const order: string[] = [];
    const provider = clockedProvider("yyds", () => { t += 5000; }, order);
    const { repo, deps } = await makeDeps({ targetKeys: 5, mintBatch: 5, codeTimeoutMs: 5000 }, provider);
    deps.now = () => t;
    deps.sleep = async (ms: number) => { t += ms; };
    deps.roundBudgetMs = 4_000; // < 单次最坏 5000，第一次就开不了
    deps.logger = logger;

    const out = await tendOnce(deps);

    expect(out.attempted).toBe(0);
    expect(out.minted).toBe(0);
    // 零副作用：一个邮箱都不该建出来（不能"先建了再发现预算不够"）。
    expect(order).toEqual([]);
    expect(await repo.all()).toHaveLength(0);

    const e = logger.entries.find((x) => x.event === "registrar.round_budget_impossible");
    expect(e, `实际事件：${JSON.stringify(logger.events())}`).toBeDefined();
    expect(e?.level).toBe("error");
    expect(e?.fields?.worstAttemptMs).toBe(5000);
    expect(e?.fields?.roundBudgetMs).toBe(4_000);
    // 五语言排障小节按事件名给出可 grep 的锚点（旧的那条按中文文案 grep，英日韩用户
    // 永远搜不到；改成事件名之后措辞怎么调整都不会失配）。这里把事件名与文档钉在一起。
    for (const lang of ["zh-CN", "zh-TW", "en", "ja", "ko"]) {
      expect(readFileSync(`docs/${lang}/REGISTRAR.md`, "utf8"), `${lang} 没给这条 error 的可 grep 事件名`)
        .toContain("registrar.round_budget_impossible");
    }
    // 不能退化成「本轮提前收尾」那条 warn（那条是 registrar.round_budget_exhausted）。
    expect(logger.has("registrar.round_budget_exhausted")).toBe(false);
  });

  it("I-1 成对：预算装得下至少一次时记 registrar.round_budget_exhausted 且级别是 warn（别把正常收尾报成配置错误）", async () => {
    const logger = recordingLogger();
    let t = 0;
    const order: string[] = [];
    const provider = clockedProvider("yyds", () => { t += 5000; }, order);
    const { deps } = await makeDeps({ targetKeys: 5, mintBatch: 5, codeTimeoutMs: 5000 }, provider);
    deps.now = () => t;
    deps.sleep = async (ms: number) => { t += ms; };
    deps.roundBudgetMs = 12_000;
    deps.logger = logger;

    const out = await tendOnce(deps);

    expect(out.attempted).toBe(2);
    expect(logger.has("registrar.round_budget_impossible")).toBe(false);
    const e = logger.entries.find((x) => x.event === "registrar.round_budget_exhausted");
    expect(e).toBeDefined();
    expect(e?.level).toBe("warn");
  });

  it("通道缺 provider 时记录一条失败，而不是静默空转", async () => {
    // 主通道 yyds 在 chain 里，但 providers 里根本没构造它——这是接线错误
    // （最容易触发的那种），不是"这条通道没配"的正常状态。
    const { repo, deps } = await makeDeps({ targetKeys: 1, mintBatch: 1 });
    deps.providers = {};
    const out = await tendOnce(deps);
    expect(out.attempted).toBe(1);
    expect(out.minted).toBe(0);
    expect(out.failures).toEqual([{ reason: "provider_missing", channel: "yyds" }]);
    expect(await repo.all()).toHaveLength(0);
  });

  it("本轮先成功铸出一把 key，紧接着下一次尝试触发 upstream_error 整轮中止时，已铸成功的 key 仍完整写入池子", async () => {
    // 与现有的两条中止类测试对照：那两条都是"第一次就失败"，从未出现
    // minted>0 之后再中止的组合。这里第一次尝试完整走完注册链路拿到 key，
    // 第二次尝试的验证码请求才切到 500 触发 upstream_error 整轮中止，
    // 断言第一次已经 add 进池子的 key 不会因为后面中止而回滚。
    const provider = new FakeMailProvider({ domains: ["x.test"] });
    const { repo, deps } = await makeDeps({ targetKeys: 3, mintBatch: 3 }, provider);
    let verificationCalls = 0;
    deps.agnes = {
      platformUrl: "https://platform.test",
      fetcher: {
        async fetch(url: string) {
          if (url.includes("/api/verification")) {
            verificationCalls++;
            return new Response("{}", { status: verificationCalls === 1 ? 200 : 500 });
          }
          if (url.includes("/api/user/login")) {
            return new Response(JSON.stringify({ data: { access_token: "tok" } }), { status: 200 });
          }
          if (url.includes("/api/token")) {
            return new Response(JSON.stringify({ data: { key: "sk-first" } }), { status: 200 });
          }
          return new Response("{}", { status: 200 });
        },
      },
    };
    const out = await tendOnce(deps);
    expect(out.attempted).toBe(2);
    expect(out.minted).toBe(1);
    expect(out.failures).toEqual([{ reason: "upstream_error", channel: "yyds" }]);
    const all = await repo.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.key).toBe("sk-first");
  });
});

/**
 * 本轮有产出时的收尾对账。
 *
 * `indexAdd` 是没有 CAS 的读-改-写，KV 的边缘读缓存可能让它读到「对账刚修好之前」
 * 的索引并把修复覆盖回去；孤儿不被 `all()` 看到 ⇒ 可用数偏小 ⇒ 缺口高估 ⇒
 * **超额补铸**，而每一次补铸都是一次真实的 Agnes 建号。收尾再对一次账把窗口从
 * 「一整轮」压到「一轮之内」。
 */
describe("tendOnce 收尾对账", () => {
  /** 只数 list，用来区分「对账跑了」与「碰巧没跑」。 */
  class ListCountingStorage extends MemoryStorage {
    lists = 0;
    override async list(prefix: string): Promise<string[]> {
      this.lists++;
      return super.list(prefix);
    }
  }

  async function withStorage(s: MemoryStorage, over: Partial<RegistrarConfig> = {}) {
    const repo = new KeyPoolRepo(s, { now: () => 1000, logger: NULL_LOGGER, cacheTtlMs: 0 });
    const logger = recordingLogger();
    const deps: TendDeps = {
      repo, config: { ...CFG, ...over }, providers: { yyds: new FakeMailProvider() },
      agnes: agnesOk(), now: () => 1000, sleep: async () => {}, rand: () => 0.5, logger,
    };
    return { repo, deps, logger, s };
  }

  const ORPHAN_ID = "0123456789abcdef";

  /**
   * 造一条**真正隐身**的孤儿：记录在存储里，索引不知道它。
   *
   * 池子里必须先有一把正常的 key——孤儿只在「索引非空且至少读到一条活记录」时才
   * 隐身。池子空着的话 `all()` 会走「索引缺失回落」或「空结果兜底」，两条都会
   * `list()` 一次并把孤儿捞出来，于是「对账之前看不见」这个前提根本不成立，
   * 整条用例就在测一个空判据。
   */
  async function plantOrphan(s: MemoryStorage, repo: KeyPoolRepo) {
    await repo.add("sk-existing-key-aaaaaa");
    await s.put(KEY_PREFIX + ORPHAN_ID, {
      id: ORPHAN_ID, key: "sk-orphan-orphan-orph", addedAt: 1, lastUsedAt: null,
      cooldownUntil: 0, cooldownReason: null, strikes: 0, evicted: false, evictedReason: null,
    });
    expect((await repo.all()).map((r) => r.id), "前置条件：对账之前它必须是隐身的")
      .not.toContain(ORPHAN_ID);
  }

  it("铸出 key 之后，本轮里被覆盖掉的孤儿立刻被捡回来（而不是等 30 分钟后的下一轮）", async () => {
    const s = new ListCountingStorage();
    // targetKeys 2、池里已有 1 把 ⇒ 缺口 1 ⇒ 本轮真会铸出东西。
    const { repo, deps } = await withStorage(s, { targetKeys: 2, mintBatch: 1 });
    await plantOrphan(s, repo);

    const out = await tendOnce(deps);
    expect(out.minted).toBe(1);
    // 收尾对账把孤儿加回索引 ⇒ 现在是「原有的 + 刚铸的 + 捡回来的」三把。
    expect((await repo.all()).map((r) => r.id)).toContain(ORPHAN_ID);
    expect(await repo.all()).toHaveLength(3);
  });

  it("一把都没铸出来时不对账——没有产出就没有覆盖窗口，不该白付一次 list", async () => {
    const s = new ListCountingStorage();
    // 目标数已满 ⇒ need <= 0 ⇒ 直接返回，minted=0。
    const { repo, deps } = await withStorage(s, { targetKeys: 1, mintBatch: 1 });
    await repo.add("sk-already-enough-aaaa");
    s.lists = 0;

    const out = await tendOnce(deps);
    expect(out.minted).toBe(0);
    expect(s.lists, "零产出的那一轮一次 list 都不该有").toBe(0);
  });

  it("收尾对账失败只记一条 warn，不把一轮已经成功铸出 key 的 tend 变成异常", async () => {
    const s = new ListCountingStorage();
    const { repo, deps, logger } = await withStorage(s, { targetKeys: 2, mintBatch: 1 });
    // 先放一把正常 key：池子非空，`all()` 就不会走那两条会 list 的回落路径，
    // 于是下面那个 throw 只可能被**收尾对账**触发，归因才是干净的。
    await repo.add("sk-existing-key-aaaaaa");
    // stub 必须真的 throw——返回空数组测的是「池子是空的」，是另一回事。
    s.list = async () => { throw new Error("KV list 挂了"); };

    const out = await tendOnce(deps);
    expect(out.minted, "key 已经落盘了，不许因为对账失败就报补池失败").toBe(1);
    expect(logger.has("registrar.post_mint_reconcile_failed")).toBe(true);
  });
});
