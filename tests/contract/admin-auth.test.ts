import { describe, it, expect } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN, TEST_CONFIG } from "../helpers/make-app.js";
import {
  constantTimeEqual, checkAdminToken, ADMIN_TOKEN_MIN_LENGTH, AUDIT_PATH_MAX,
} from "../../src/http/admin/auth.js";
import { createApp } from "../../src/http/app.js";
import { createConfigHolder, CONFIG_TTL_MS } from "../../src/http/config-holder.js";
import { KeyPoolRepo } from "../../src/core/keypool-repo.js";
import { createStorageHealth } from "../../src/core/storage-health.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { FakeFetcher } from "../helpers/fake-fetcher.js";
import { recordingLogger } from "../helpers/recording-logger.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";

describe("constantTimeEqual", () => {
  it("相等返回 true，任一位不同返回 false", () => {
    expect(constantTimeEqual("abcdef", "abcdef")).toBe(true);
    expect(constantTimeEqual("abcdef", "abcdeg")).toBe(false);
    expect(constantTimeEqual("abcdef", "Abcdef")).toBe(false);
  });
  it("长度不同返回 false，且不抛错", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "a")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
  it("非 ASCII 也逐码元比较", () => {
    expect(constantTimeEqual("口令令", "口令令")).toBe(true);
    expect(constantTimeEqual("口令令", "口令另")).toBe(false);
  });
});

describe("checkAdminToken", () => {
  /**
   * ⚠️ 边界值一律写**字面量 23 / 24**，不许写 `ADMIN_TOKEN_MIN_LENGTH - 1`。
   *
   * 后者是同义反复：输入从被测的那个常量推导出来，于是把下限改成 8 也照样全绿
   *（已实测：计划给的那版用例正是这么写的，变异 M9 完整逃逸）。24 是**策略**
   * ——`.env.example` 与设计文档 §8.1 对外承诺的那个数字——所以它必须被独立钉住。
   */
  it("下限是 24 位这个数字本身就是策略，独立钉死", () => {
    expect(ADMIN_TOKEN_MIN_LENGTH).toBe(24);
  });
  it("短于 24 位被拒，正好 24 位放行", () => {
    expect(checkAdminToken("x".repeat(23), "g")).toEqual({ ok: false, reason: "too_short" });
    expect(checkAdminToken("x".repeat(24), "g").ok).toBe(true);
  });
  it("空串也走 too_short 这条，绝不会被判成合规口令", () => {
    expect(checkAdminToken("", "g")).toEqual({ ok: false, reason: "too_short" });
  });

  /**
   * HTTP 请求头的值在传输层会被去掉首尾空白，环境变量不会——带空白的口令客户端
   * **永远送不出来**。方向仍是 fail closed，但不在装配期说清楚的话，运维看到的是
   * 「口令明明对却一直 401」，日志里只有 login_failed，查不出原因。
   */
  it("首尾带空白的口令被拒——否则会装出一棵永远进不去的面板", () => {
    const good = "x".repeat(24);
    expect(checkAdminToken(`${good} `, "g")).toEqual({ ok: false, reason: "whitespace_padded" });
    expect(checkAdminToken(` ${good}`, "g")).toEqual({ ok: false, reason: "whitespace_padded" });
    expect(checkAdminToken(`\t${good}\n`, "g")).toEqual({ ok: false, reason: "whitespace_padded" });
    // 全空白：长度够、也不等于 GATEWAY_TOKEN，正是最容易漏过去的那一格。
    expect(checkAdminToken(" ".repeat(24), "g")).toEqual({ ok: false, reason: "whitespace_padded" });
    // 中间的空白不管：那是口令自己的一部分，客户端送得出来。
    //
    // ⚠️ **这一格在 Task 7 期间被改成过 `not_sendable`，评审裁定后改了回来，
    // 记在这里免得下一个人再走一遍。** 当时的理由是「中间带空格只会让人在复制粘贴
    // 时出错」——那是替运维做主，不是物理。判据是**留物理、去口味**：
    // 送不出去的字符（非 Latin-1 / 控制字符）拦，送得出去的空格放行。
    // passphrase 是更强的密钥形态，拒掉它不划算。完整理由见 auth.ts 的 SENDABLE。
    expect(checkAdminToken("xxxxxxxxxxxx xxxxxxxxxxxx", "g").ok).toBe(true);
  });

  /**
   * ── K7：放行「客户端根本送不出去」的口令 ────────────────────────────────
   *
   * 浏览器的 `fetch` 在设置含非 Latin-1 或控制字符的请求头值时**直接抛
   * TypeError**，于是一个含汉字 / emoji / 零宽空格的 `ADMIN_TOKEN` 会装出一棵
   * 200 但永远进不去的面板：用户看到「网络错误」，而服务端**连一条 `login_failed`
   * 都没有**（请求压根没发出来），比 401 难诊断得多。
   *
   * ⚠️ **每一格都要长度够 24**，否则测的是 `too_short` 而不是 `not_sendable`
   *（本项目第 1 种假阳性：夹具无冲突数据，两条规则分不开）。
   *
   * ⚠️ **不可见字符一律用 `String.fromCharCode` 拼**，不往源码里粘裸字符：
   * 本仓刚被「源文件里的裸 NUL 让整份文件对 git diff / grep / scan-secrets 隐身」
   * 咬过一次（Task 6），审计工具看不见的字符不该出现在源码里。
   */
  describe("送不出去的字符：checkAdminTokenShape 只查空白与长度会装出一棵进不去的面板", () => {
    const ZWSP = String.fromCharCode(0x200b);
    const NBSP = String.fromCharCode(0x00a0);
    const NUL = String.fromCharCode(0x00);
    const CASES: ReadonlyArray<{ name: string; token: string }> = [
      { name: "汉字", token: "管理口令管理口令管理口令管理口令管理口令管理口令" },
      { name: "emoji", token: "admin-token-0123456789-🔑" },
      { name: "零宽空格", token: `admin-token-0123456789${ZWSP}xx` },
      // 这一格不在计划的四格里，是执行时补的：裸 NUL 既是控制字符，又正是本仓刚被
      // 咬过一次的那个字符（Task 6：源文件里的裸 NUL 让整份文件对 git diff / grep /
      // scan-secrets 隐身）。它同样是浏览器发不出去的。
      { name: "内含裸 NUL", token: `admin-token${NUL}0123456789abcd` },
    ];

    for (const { name, token } of CASES) {
      it(`${name}：长度够（${token.length} ≥ 24）也要被拒，且报 not_sendable`, () => {
        expect(token.length, `${name} 的夹具长度不足 24，测的会是 too_short`).toBeGreaterThanOrEqual(24);
        expect(checkAdminToken(token, "g")).toEqual({ ok: false, reason: "not_sendable" });
      });
    }

    /**
     * **反向**：正则收得太紧，把合法的随机口令也拒了同样是回归。
     * 随机口令生成器（`openssl rand -base64` / 密码管理器）会吐出 `!`、`-`、`+`、
     * `/`、`=`、`~` 这类符号，全都是可打印 ASCII，必须放行。
     */
    it.each([
      ["含 ! 与 -", "admin-token-0123456789-ok!"],
      ["base64 风格（含 + / =）", "YWRtaW4rdG9rZW4vMDEyMzQ1Njc4OQ=="],
      // 两个**端点**都要出现在同一个夹具里：0x20（空格）与 0x7e（`~`）。
      // 只测中间的字符时，把区间写成 `[\x21-\x7d]` 这类「差一位」的错误看不见。
      ["字符集两端（0x20 空格 与 0x7e ~）", "admin token 0123456789 abc~"],
      // **passphrase**：中间带空格是允许的。空格送得出去，而 `correct horse battery
      // staple` 那种形态在 24 位下限下比随机串更容易被运维用对。拒掉它是替人做主。
      ["passphrase（中间带空格）", "correct horse battery staple"],
      ["中间多处空格", "xxxxxxxxxxxx xxxxxxxxxxxx"],
    ])("合法的随机口令不许被误拒：%s", (_name, token) => {
      expect(token.length).toBeGreaterThanOrEqual(24);
      expect(checkAdminToken(token, "g").ok, token).toBe(true);
    });

    /**
     * **顺序：可送性排在长度之前。**
     *
     * 计划点名这条「今天没有用例」——一个「又短又含汉字」的口令同时触发两条，
     * 报「长度不足」会把人引向加长它，而加长之后照样送不出去。
     * 把两条判断对调时，只有这一格会红。
     */
    it("又短又含汉字时报 not_sendable 而不是 too_short——报长度会把人引向加长它", () => {
      expect("口令".length).toBeLessThan(24);
      expect(checkAdminToken("口令", "g")).toEqual({ ok: false, reason: "not_sendable" });
    });

    /**
     * **空串仍然归 too_short**，这是刻意的，不是漏网。
     *
     * 「不含送不出去的字符」这条性质对空串平凡成立——非空是长度那条的职责，
     * 所以 `SENDABLE` 的量词写的是 `*` 而不是 `+`（理由写在 auth.ts）。
     * 对一个空口令，「长度不足 24 位」才是能照着改的那句话。
     * 上面那条「空串也走 too_short」的用例是同一件事的另一半，两条一起钉住这个取舍。
     */
    it("空串不因为新规则改判——它归 too_short（那才是能照着改的那句话）", () => {
      expect(checkAdminToken("", "g")).toEqual({ ok: false, reason: "too_short" });
    });

    /**
     * **不间断空格（U+00A0）归 `whitespace_padded`，不是 `not_sendable`。**
     *
     * 这一格是订正：本文件初稿的注释断言过反话——「NBSP 不被 `trim()` 认作空白」。
     * 实测（node 一次性脚本）`(NBSP + "x" + NBSP).trim() === "x"`：JS 的 `trim()`
     * 认的是 ECMAScript 的 WhiteSpace 产生式，**U+00A0 在里面**，所以首尾带 NBSP 的
     * 口令先命中空白那条。两条原因都拒得住它，但对运维说的话不一样，别再写反。
     */
    it("首尾不间断空格归 whitespace_padded——trim() 认得 U+00A0（已实测）", () => {
      const padded = `${NBSP}admin-token-0123456789${NBSP}`;
      expect(padded.trim()).toBe("admin-token-0123456789");
      expect(checkAdminToken(padded, "g")).toEqual({ ok: false, reason: "whitespace_padded" });
    });
  });

  it("既带空白又太短时先报空白——空白是三条里唯一在配置文件里看不见的那条", () => {
    // 这一条把 checkAdminToken 里那句「顺序有意义」从注释变成可证伪的断言：
    // 不写它的话，把两条判断对调没有任何测试会红，而注释仍然写着顺序有意义。
    expect(checkAdminToken(" x ", "g")).toEqual({ ok: false, reason: "whitespace_padded" });
  });
  it("等于 GATEWAY_TOKEN 被拒——复用中转口令等于把整池 key 交给每个下游用户", () => {
    const t = "x".repeat(30);
    expect(checkAdminToken(t, t)).toEqual({ ok: false, reason: "same_as_gateway_token" });
  });
});

describe("ADMIN_TOKEN 未设置时 /admin 整棵树 404（不泄漏「这里有个后台」）", () => {
  it("不带凭据是 404 而不是 401", async () => {
    const { app } = await makeApp([], ["k1"], {}, undefined, { adminToken: undefined });
    expect((await app.request("/admin/api/session")).status).toBe(404);
  });
  it("带正确凭据也还是 404", async () => {
    const { app } = await makeApp([], ["k1"], {}, undefined, { adminToken: undefined });
    const res = await app.request("/admin/api/session", { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });
    expect(res.status).toBe(404);
  });
  it("空字符串的 ADMIN_TOKEN 等同未设置——**绝不能**变成「空口令就能进」", async () => {
    const { app } = await makeApp([], ["k1"], {}, undefined, { adminToken: "" });
    expect((await app.request("/admin/api/session")).status).toBe(404);
    const res = await app.request("/admin/api/session", { headers: { "x-admin-key": "" } });
    expect(res.status).toBe(404);
  });
});

describe("ADMIN_TOKEN 不合规时同样整棵树 404，但网关照常转发", () => {
  // 「与网关口令相同」这一格必须用一个**够长**的口令：checkAdminToken 先查长度，
  // 拿夹具那个一位的 "t" 来试，命中的其实是 too_short，两条规则就分不开了。
  // 长度一律写字面量（理由见 checkAdminToken 那组用例的说明）。
  const LONG = "x".repeat(30);
  // 不可见字符一律拼出来，不往源码里粘裸字符（理由见上面那组的说明）。
  const ZWSP = String.fromCharCode(0x200b);
  const CASES: Array<{
    name: string; token: string; gatewayToken: string; reason: string;
    /** 说明里必须出现的字样：四条原因的**文案要能被区分开**，只说「未启用」等于让运维猜。 */
    msgContains: string;
  }> = [
    {
      name: "太短（23 位）", token: "x".repeat(23),
      gatewayToken: TEST_CONFIG.gatewayToken, reason: "too_short", msgContains: "长度",
    },
    {
      name: "全是空白（24 个空格，长度够也不等于网关口令）", token: " ".repeat(24),
      gatewayToken: TEST_CONFIG.gatewayToken, reason: "whitespace_padded", msgContains: "空白",
    },
    // ── K7：送不出去的字符（四格，每格长度都 ≥ 24）───────────────
    // 长度不够的话测的是 too_short，两条规则就分不开了（第 1 种假阳性）。
    {
      name: "汉字（24 位，长度够）", token: "管理口令管理口令管理口令管理口令管理口令管理口令",
      gatewayToken: TEST_CONFIG.gatewayToken, reason: "not_sendable", msgContains: "发不出去",
    },
    {
      name: "emoji", token: "admin-token-0123456789-🔑",
      gatewayToken: TEST_CONFIG.gatewayToken, reason: "not_sendable", msgContains: "发不出去",
    },
    {
      name: "零宽空格", token: `admin-token-0123456789${ZWSP}xx`,
      gatewayToken: TEST_CONFIG.gatewayToken, reason: "not_sendable", msgContains: "发不出去",
    },
  ];

  for (const { name, token, gatewayToken, reason, msgContains } of CASES) {
    it(`${name}：/admin 404，/v1/models 仍然 200，事件记 reason=${reason}`, async () => {
      const { app, logger } = await makeApp([], ["k1"], { gatewayToken }, undefined, { adminToken: token });
      expect((await app.request("/admin/api/session")).status).toBe(404);
      const ok = await app.request("/v1/models", { headers: { authorization: `Bearer ${gatewayToken}` } });
      // 转发能力与管理能力相互独立：管理口令配错不该让网关停摆。
      expect(ok.status).toBe(200);
      // 静默地不启用面板，运维会以为「后台坏了」而查不到原因，故必须留下事件，
      // 且两种不合规要能被区分开。
      const e = logger.entries.find((x) => x.event === "admin.token_rejected");
      expect(e?.fields?.reason).toBe(reason);
      // 只断言 reason 的话，把说明文案换成查表之前那个二元三元式（新原因落进 else
      // 分支、被**误报成**另一条）不会有任何测试变红，而运维照着错的原因改是查不出来的。
      expect(String(e?.msg), `${name} 的说明要点明原因`).toContain(msgContains);
      // 事件会进容器日志与将来的事件板块，不许把口令本身带出去。
      expect(JSON.stringify(e)).not.toContain(token);
    });
  }

  /**
   * **反向那格：正则收得太紧，把合法的随机口令也拒了，是同一个方向的回归。**
   *
   * 上面那张表只证明「不合规的会被拒」；把 `SENDABLE` 收成 `/^[a-z0-9]+$/`
   * （不许符号）时那张表**照样全绿**，而这一格会红——面板从此拒绝一切
   * `openssl rand -base64` 风格的口令，运维只会看到一棵莫名其妙的 404 树。
   */
  it("含 ! 与 - 的合法口令：/admin 树照常注册，带对口令能进，且不打 token_rejected", async () => {
    const OK_TOKEN = "admin-token-0123456789-ok!";
    const { app, logger } = await makeApp([], ["k1"], {}, undefined, { adminToken: OK_TOKEN });
    const res = await app.request("/admin/api/session", { headers: { "x-admin-key": OK_TOKEN } });
    expect(res.status, "合法的随机口令被误拒了").toBe(200);
    expect(logger.has("admin.token_rejected")).toBe(false);
  });

  /**
   * **带空格的 passphrase 必须能真的登录进去，不只是通过形状校验。**
   *
   * 形状校验通过不等于口令送得到：HTTP 头值里的内部空格是合法的，但这件事得由一条
   * **真的把它放进 `x-admin-key` 发一遍**的用例来证明——只断言 `checkAdminToken(...).ok`
   * 属于形状断言，证明不了「送得出去也送得到」这半（而那正是放行它的全部理由）。
   *
   * 这一格同时是「字符集收紧到 0x21」这个回归的护栏：那样改之后这里会 404
   *（整棵树不注册），而不是 401。
   */
  it("passphrase（中间带空格）能真的登录进去——空格送得出去也送得到", async () => {
    const PASSPHRASE = "correct horse battery staple";
    expect(PASSPHRASE.length, "夹具长度不足 24，测的会是 too_short").toBeGreaterThanOrEqual(24);
    const { app, logger } = await makeApp([], ["k1"], {}, undefined, { adminToken: PASSPHRASE });
    const res = await app.request("/admin/api/session", { headers: { "x-admin-key": PASSPHRASE } });
    expect(res.status, "带空格的 passphrase 进不去").toBe(200);
    expect(logger.has("admin.token_rejected")).toBe(false);
    // 反向：错的口令还是 401（别让「放行空格」顺手放行了别的东西）。
    const bad = await app.request("/admin/api/session", { headers: { "x-admin-key": "correct horse battery stapl" } });
    expect(bad.status).toBe(401);
  });

  /**
   * ⚠️ **「与网关口令相同」刻意不在上面那张表里，它的失效形态是 503 而不是 404。**
   *
   * 上面两条只取决于 `ADMIN_TOKEN` 这一个环境变量，整个进程/isolate 生命周期里都是
   * 同一个答案，所以在装配期把整棵树反注册掉（永久 404）是安全的。第三条的另一个
   * 输入 `gatewayToken` 运行中会变（`env.GATEWAY_TOKEN ?? stored.gatewayToken`），
   * 在装配期拦它 = 把结论永久冻结 = 分裂脑（见本文件末尾那组用例）。
   */
  it("与网关口令相同：/admin 树照常注册，管理接口 503（不是 404），且启动日志里就有原因", async () => {
    const { app, logger } = await makeApp(
      [], ["k1"], { gatewayToken: LONG }, undefined, { adminToken: LONG },
    );
    expect((await app.request("/admin/api/session")).status).toBe(503);
    const ok = await app.request("/v1/models", { headers: { authorization: `Bearer ${LONG}` } });
    expect(ok.status, "转发能力与管理能力相互独立").toBe(200);

    // 装配期这一条**只报不拦**：不打这条日志的话，启动时就撞上冲突的部署者要等到
    // 第一个管理请求才拿到一个不说原因的 503。
    const e = logger.entries.find((x) => x.event === "admin.token_conflict");
    expect(e?.level).toBe("error");
    expect(e?.fields?.reason).toBe("same_as_gateway_token");
    expect(String(e?.msg)).toContain("GATEWAY_TOKEN");
    // **处置建议必须是「轮换 ADMIN_TOKEN」，不许是「改掉任一把」**（全分支评审 C1）。
    // 改 gatewayToken 只恢复可用性：冲突期间这把管理口令与中转口令是同一个值，
    // 而中转口令是发给每一个下游用户的。这一格断言的是**运维实际读到的那句话**。
    expect(String(e?.msg), "没告诉运维要轮换 ADMIN_TOKEN").toContain("轮换");
    for (const wrong of ["任一把", "其中一把"]) {
      expect(String(e?.msg), `又把「${wrong}」这种只恢复可用性的说法写回去了`).not.toContain(wrong);
    }
    expect(JSON.stringify(e)).not.toContain(LONG);
    // 装配期不该再报 token_rejected：那个事件的语义是「面板没注册」。
    expect(logger.has("admin.token_rejected")).toBe(false);
  });
});

describe("adminAuth", () => {
  it("正确的 x-admin-key 放行", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin/api/session", { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });
    expect(res.status).toBe(200);
  });

  it("缺凭据 / 错凭据都是 401", async () => {
    const { app } = await makeApp();
    expect((await app.request("/admin/api/session")).status).toBe(401);
    expect((await app.request("/admin/api/session", { headers: { "x-admin-key": "wrong" } })).status).toBe(401);
  });

  it("**不接受 ?key= 查询参数**——口令进 URL 会落进浏览器历史、Referer 与各级访问日志", async () => {
    const { app } = await makeApp();
    const res = await app.request(`/admin/api/session?key=${TEST_ADMIN_TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("**不接受 Authorization: Bearer**——两把钥匙必须严格隔离，网关口令不该能开后台", async () => {
    const { app } = await makeApp();
    const res = await app.request("/admin/api/session", {
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it("网关口令开不了后台，管理口令也调不动 /v1", async () => {
    const { app } = await makeApp();
    const asAdmin = await app.request("/admin/api/session", {
      headers: { "x-admin-key": TEST_CONFIG.gatewayToken },
    });
    expect(asAdmin.status).toBe(401);
    const asGateway = await app.request("/v1/models", {
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(asGateway.status).toBe(401);
  });

  it("失败时记 admin.login_failed 事件（面板将来靠它看爆破痕迹）", async () => {
    const { app, logger } = await makeApp();
    await app.request("/admin/api/session", { headers: { "x-admin-key": "wrong" } });
    const e = logger.entries.find((x) => x.event === "admin.login_failed");
    expect(e?.fields?.path).toBe("/admin/api/session");
    expect(e?.fields?.hasHeader).toBe(true);
  });

  it("完全没带请求头时 hasHeader=false——「带了但打错」与「压根没带」是两种痕迹", async () => {
    const { app, logger } = await makeApp();
    await app.request("/admin/api/session");
    expect(logger.entries.find((x) => x.event === "admin.login_failed")?.fields?.hasHeader).toBe(false);
  });

  it("成功时**不**记 login_failed——记了的话爆破痕迹就淹没在正常流量里", async () => {
    const { app, logger } = await makeApp();
    await app.request("/admin/api/session", { headers: { "x-admin-key": TEST_ADMIN_TOKEN } });
    expect(logger.has("admin.login_failed")).toBe(false);
  });

  it("**事件里不带口令本身**——日志会被转发到第三方，泄漏它等于泄漏后台", async () => {
    const { app, logger } = await makeApp();
    await app.request("/admin/api/session", { headers: { "x-admin-key": "guessed-secret-value" } });
    const e = logger.entries.find((x) => x.event === "admin.login_failed");
    const dump = JSON.stringify(e);
    expect(dump).not.toContain("guessed-secret-value");
    expect(dump).not.toContain(TEST_ADMIN_TOKEN);
  });
});

describe("客户端 IP", () => {
  /** 打一次失败登录，把事件里记下来的 ip 取出来。 */
  async function loggedIp(
    headers: Record<string, string>,
    options: Parameters<typeof makeApp>[4] = {},
  ) {
    const { app, logger } = await makeApp([], ["k1"], {}, undefined, options);
    await app.request("/admin/api/session", { headers: { "x-admin-key": "wrong", ...headers } });
    return logger.entries.find((x) => x.event === "admin.login_failed")?.fields?.ip;
  }

  // ── 门控之外：两个头**都**不可信 ────────────────────────────────────────
  // 这个值会写进爆破痕迹，信错了等于允许任何人把痕迹嫁祸给任意 IP。

  it("默认不信 X-Forwarded-For", async () => {
    expect(await loggedIp({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })).toBeNull();
  });

  it("默认**也不信 CF-Connecting-IP**——Node 直连形态下没人覆盖它，客户端自己发一个就成立", async () => {
    expect(await loggedIp({ "cf-connecting-ip": "198.51.100.9" })).toBeNull();
  });

  it("什么都拿不到时如实记 null，不伪造一个 \"unknown\" 冒充 IP", async () => {
    expect(await loggedIp({})).toBeNull();
  });

  // ── 门控之内：CF-Connecting-IP 优先，XFF 只作兜底 ────────────────────────
  // 两个头的**可伪造性根本不同**：CF-Connecting-IP 由 Cloudflare 边缘写入，且会覆盖
  // 客户端传来的同名头，请求真的经过 CF 时伪造不了；XFF 是任何中间件都能追加的链，
  // 客户端可以自己发一个假的。Worker 形态下 CF 定义上就在前面，那里优先 XFF 是错的。

  it("TRUST_PROXY=1 且两个头同时在场时取 CF-Connecting-IP，**不**取伪造的 XFF", async () => {
    // 两个头刻意给**不同的值**：给同一个值的话谁赢都通过，是这个项目的第 1 种假阳性。
    const ip = await loggedIp(
      { "cf-connecting-ip": "198.51.100.9", "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
      { trustProxy: true },
    );
    expect(ip).toBe("198.51.100.9");
  });

  it("TRUST_PROXY=1 且只有 CF-Connecting-IP 时用它", async () => {
    expect(await loggedIp({ "cf-connecting-ip": "198.51.100.9" }, { trustProxy: true }))
      .toBe("198.51.100.9");
  });

  it("TRUST_PROXY=1 且 CF-Connecting-IP 缺席时，退到 XFF 首段", async () => {
    expect(await loggedIp({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }, { trustProxy: true }))
      .toBe("203.0.113.7");
  });

  it("TRUST_PROXY=1 但两个头都没有时仍是 null", async () => {
    expect(await loggedIp({}, { trustProxy: true })).toBeNull();
  });

  // ── 门控之内也要过形态校验 ──────────────────────────────────────────────
  //
  // 「门控之内 ⇒ 值一定干净」是错的。`TRUST_PROXY=1` 的另一种常见形态是网关挂在
  // 自建 nginx / Caddy 后面，那里**没有任何人会覆盖 `CF-Connecting-IP`**，攻击者
  // 自己带一个就会优先于反代写的 XFF 胜出，而这个值原样进 `admin.login_failed`
  // 的 `ip=` 字段——P3b 的事件板块正要按它做筛选、聚合、展示。

  it("形态不合法的 CF-Connecting-IP 一律记 null，而不是把任意文本写进审计行", async () => {
    for (const bogus of [
      "not-an-ip-at-all <img src=x>",
      "8.8.8.8 evil=1",
      "1.2.3.4.5",
      "999.1.1.1",
      "'; DROP TABLE",
      // 「拿不到就记 null，绝不伪造一个 unknown 冒充 IP」——反代自己写的这种也要挡。
      "unknown",
    ]) {
      expect(await loggedIp({ "cf-connecting-ip": bogus }, { trustProxy: true }), bogus).toBeNull();
    }
  });

  it("CF-Connecting-IP 形态不合法时**退到 XFF**，而不是整条放弃", async () => {
    expect(await loggedIp(
      { "cf-connecting-ip": "garbage", "x-forwarded-for": "203.0.113.7" },
      { trustProxy: true },
    )).toBe("203.0.113.7");
  });

  it("XFF 首段形态不合法时同样记 null", async () => {
    expect(await loggedIp({ "x-forwarded-for": "garbage, 203.0.113.7" }, { trustProxy: true }))
      .toBeNull();
  });

  it("合法 IPv6（含 ::ffff: 映射形态）照常记下来——校验的是形态，不是「只认 IPv4」", async () => {
    for (const ip of ["2001:db8::1", "::1", "::ffff:192.0.2.1"]) {
      expect(await loggedIp({ "cf-connecting-ip": ip }, { trustProxy: true }), ip).toBe(ip);
    }
  });
});

describe("审计字段不原样承载请求数据", () => {
  /** 串里有没有落单的代理码元（被劈开的代理对的一半）。 */
  function hasLoneSurrogate(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) { i++; continue; }
        return true;
      }
      if (c >= 0xdc00 && c <= 0xdfff) return true;
    }
    return false;
  }

  /** 未鉴权打一发，把落进 `admin.login_failed` 的 `path` 字段取回来。 */
  async function loggedPath(suffix: string): Promise<string> {
    const { app, logger } = await makeApp();
    await app.request(`/admin/api/${suffix}`);
    const path = logger.entries.find((x) => x.event === "admin.login_failed")?.fields?.path;
    expect(typeof path).toBe("string");
    return path as string;
  }

  it("path 被截断到 200 字符——未鉴权请求能往日志里塞约 8 KB 攻击者文本", async () => {
    const path = await loggedPath("a".repeat(4000));
    expect(path.length).toBe(AUDIT_PATH_MAX);
    // 这一格同时是孤代理那条的**反向**：截断点落在普通字符上时**不许**多砍一个。
    expect(hasLoneSurrogate(path)).toBe(false);
  });

  /**
   * ── Minor ⑥：截断点正好落在一个代理对中间 ──────────────────────────────
   *
   * `slice()` 按 UTF-16 码元切，正好切在代理对中间就留下一个**孤代理**。
   * 实测（node v24）：`JSON.stringify` 会把它转义成 `\ud83d`（这一步无损），
   * 而 `TextEncoder` 把它编成 `ef bf bd`（U+FFFD）——事件下载的 `.txt` 与任何
   * 走 UTF-8 的日志采集都经过那一步。面板要按这个字段做筛选与聚合，
   * 留半个字符迟早变成一个替换字符。
   *
   * 夹具算过：`/admin/api/` 是 11 个码元，再补 188 个 `a` 正好 199 个，
   * 于是那个 emoji 的**高代理**落在下标 199——切 200 个码元的最后一个就是它。
   */
  it("截断点落在代理对中间时，把孤代理一起截掉（不留半个字符）", async () => {
    const emoji = String.fromCodePoint(0x1f511);
    const prefixLen = "/admin/api/".length;
    const fill = AUDIT_PATH_MAX - 1 - prefixLen;
    expect(fill, "夹具算错了，emoji 的高代理没落在截断点上").toBe(188);

    const path = await loggedPath(`${"a".repeat(fill)}${emoji}${"b".repeat(50)}`);
    // 孤代理被砍掉 ⇒ 比上限短一个码元。
    expect(path.length).toBe(AUDIT_PATH_MAX - 1);
    expect(hasLoneSurrogate(path), "留下了半个代理对").toBe(false);
    // 而且砍掉的确实是 emoji 那一半，不是把一个正常字符也带走了。
    expect(path.endsWith("a")).toBe(true);
    expect(path).not.toContain(emoji);
  });
});

// ── 运行期复查：两把钥匙在**运行中**变成同一把 ─────────────────────────────
//
// 装配期那次 checkAdminToken 挡不住这个：`loadConfig` 是
// `env.GATEWAY_TOKEN ?? stored.gatewayToken`，部署者**没设**环境变量、改由存储提供时
// （文档里教的 `wrangler kv key put` / 直接编辑 store.json，以及将来 P3c 的面板，
// 都能写这个键），gatewayToken 可以在运行中被改成等于 ADMIN_TOKEN——而中转口令是发给
// **每一个下游用户**的，届时任何下游用户都能开后台，直到重启 / isolate 回收为止。
//
// 这不是「留给 P3c 在写入路径上拒绝」能解决的：手工改存储绕得过写入路径校验。
describe("运行期复查：gatewayToken 在运行中变成 ADMIN_TOKEN 时管理端 fail closed", () => {
  /** 配置**只从存储来**（env 不设 GATEWAY_TOKEN）——这正是这个洞可达的部署形态。 */
  async function appWithStoredConfig(gatewayToken: string) {
    let t = 0;
    const now = () => t;
    const storage = new MemoryStorage();
    await storage.put("config", { gatewayToken });
    const logger = recordingLogger();
    const configHolder = await createConfigHolder({ env: {}, storage, logger, now });
    const repo = new KeyPoolRepo(storage, { now, logger: NULL_LOGGER, cacheTtlMs: 0 });
    await repo.add("k1");
    const app = createApp({
      version: "0.1.0", configHolder, repo,
      fetcher: new FakeFetcher([]), now,
      storageHealth: createStorageHealth(), logger,
      adminToken: TEST_ADMIN_TOKEN, trustProxy: false,
    });
    return {
      app, logger,
      /** 改存储 + 把假时钟拨过 TTL，下一个请求的 configRefresh 就会真的重载。 */
      async setStoredGatewayToken(v: string) {
        await storage.put("config", { gatewayToken: v });
        t += CONFIG_TTL_MS * 2;
      },
    };
  }

  const withKey = { headers: { "x-admin-key": TEST_ADMIN_TOKEN } };

  it("装配时两把钥匙不同 ⇒ 管理端正常可用（前置条件）", async () => {
    const { app } = await appWithStoredConfig("gateway-token-differs-from-admin");
    expect((await app.request("/admin/api/session", withKey)).status).toBe(200);
  });

  it("运行中把 gatewayToken 改成等于 ADMIN_TOKEN ⇒ 管理端从 200 变成 503", async () => {
    const h = await appWithStoredConfig("gateway-token-differs-from-admin");
    expect((await h.app.request("/admin/api/session", withKey)).status, "变更前应当可用").toBe(200);

    await h.setStoredGatewayToken(TEST_ADMIN_TOKEN);

    // 拿着**正确的**管理口令也进不去：fail closed 不是「换个凭据就行」。
    expect((await h.app.request("/admin/api/session", withKey)).status).toBe(503);
    // 缺凭据同样是 503 而不是 401——复查跑在验证凭据之前。
    expect((await h.app.request("/admin/api/session")).status).toBe(503);
  });

  it("停用管理端的同时，/v1 转发照常——转发能力与管理能力相互独立", async () => {
    const h = await appWithStoredConfig("gateway-token-differs-from-admin");
    await h.setStoredGatewayToken(TEST_ADMIN_TOKEN);

    expect((await h.app.request("/admin/api/session", withKey)).status).toBe(503);
    const fwd = await h.app.request("/v1/models", {
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
    });
    expect(fwd.status, "网关不该因为管理口令配错而停摆").toBe(200);
  });

  it("原因只进日志，**响应体一个字都不说**", async () => {
    const h = await appWithStoredConfig("gateway-token-differs-from-admin");
    await h.setStoredGatewayToken(TEST_ADMIN_TOKEN);
    const res = await h.app.request("/admin/api/session");
    const body = await res.text();

    // 这个检查跑在验证凭据之前，任何未鉴权的调用方都能拿到这个响应。说出原因，
    // 等于告诉一个手里已经有中转口令的人「管理口令就是你手上那把」。
    for (const leak of ["GATEWAY_TOKEN", "ADMIN_TOKEN", TEST_ADMIN_TOKEN, "相同"]) {
      expect(body, `响应体不该出现 ${leak}`).not.toContain(leak);
    }

    const e = h.logger.entries.find((x) => x.event === "admin.token_conflict");
    expect(e?.level, "运维必须看得见，且要 error 级").toBe("error");
    expect(e?.fields?.reason).toBe("same_as_gateway_token");
    expect(String(e?.msg), "日志里要讲清楚怎么修").toContain("GATEWAY_TOKEN");
    // 与装配期那条同一条纪律（全分支评审 C1）：怎么修必须说准。
    expect(String(e?.msg), "没告诉运维要轮换 ADMIN_TOKEN").toContain("轮换");
    for (const wrong of ["任一把", "其中一把"]) {
      expect(String(e?.msg), `又把「${wrong}」这种只恢复可用性的说法写回去了`).not.toContain(wrong);
    }
    // 日志常被转发到第三方，同样不许带口令本身。
    expect(JSON.stringify(e)).not.toContain(TEST_ADMIN_TOKEN);
  });

  /**
   * ⚠️ **这一格证明的是可用性恢复，不是处置完成。** 冲突一旦发生过，`ADMIN_TOKEN`
   * 就等于一把发给每个下游用户的中转口令，必须轮换（全分支评审 C1，五语言
   * DEPLOY.md 与上面两格断言的日志文案都这么写）。这里断言的仅仅是「复查是每请求
   * 做的、不是一次性锁死」这条机制性质——别把它读成「改回 gatewayToken 就完事了」。
   */
  it("把 gatewayToken 改回去，管理端立刻恢复——复查是每请求的，不是一次性锁死", async () => {
    const h = await appWithStoredConfig("gateway-token-differs-from-admin");
    await h.setStoredGatewayToken(TEST_ADMIN_TOKEN);
    expect((await h.app.request("/admin/api/session", withKey)).status).toBe(503);

    await h.setStoredGatewayToken("gateway-token-differs-again");
    expect((await h.app.request("/admin/api/session", withKey)).status).toBe(200);
  });

  it("冲突期间不记 admin.login_failed——那是爆破痕迹，配置问题别往里掺", async () => {
    const h = await appWithStoredConfig("gateway-token-differs-from-admin");
    await h.setStoredGatewayToken(TEST_ADMIN_TOKEN);
    h.logger.clear();
    await h.app.request("/admin/api/session", { headers: { "x-admin-key": "wrong" } });
    expect(h.logger.has("admin.login_failed")).toBe(false);
    expect(h.logger.has("admin.token_conflict")).toBe(true);
  });
});

// ── 分裂脑：装配时机不许改变管理端的可达性 ─────────────────────────────────
//
// 上面那组只建**一个**在冲突之前装配好的 app，因此对「冲突期间冷启动的那一批」
// 完全不可观测——正是台账里第 5 类假阳性（测试覆盖的状态让被测的选择不可观测）。
// 生产上这两批同时存在：Worker 的 isolate 是逐请求随机回收/新建的，Docker 那边
// DEPLOY.md 教的恰恰是「停容器 → 编辑 store.json → 起容器」，最容易撞上装配期冲突。
//
// 装配期若拦「两把钥匙相同」，冲突期间冷启动的 isolate 会**永久 404**（装配期检查
// 没有第二次求值的机会），而冲突之前建好的只是 503、改回去立刻恢复：同一份配置、
// 同一时刻两种结果，且 DEPLOY.md 承诺的「改回去不需要重启」对前一半是假话。
describe("同一份配置下，装配时机不改变管理端返回的状态码", () => {
  /** 同一个存储上按当前配置现建一个 app —— 相当于一次 isolate 冷启动。 */
  function coldStart(storage: MemoryStorage, now: () => number) {
    return (async () => {
      const logger = recordingLogger();
      const configHolder = await createConfigHolder({ env: {}, storage, logger, now });
      const repo = new KeyPoolRepo(storage, { now, logger: NULL_LOGGER, cacheTtlMs: 0 });
      await repo.add("k1");
      return createApp({
        version: "0.1.0", configHolder, repo,
        fetcher: new FakeFetcher([]), now,
        storageHealth: createStorageHealth(), logger,
        adminToken: TEST_ADMIN_TOKEN, trustProxy: false,
      });
    })();
  }

  const withKey = { headers: { "x-admin-key": TEST_ADMIN_TOKEN } };

  it("冲突前冷启动的与冲突中冷启动的，冲突期间同为 503、改回去之后同为 200", async () => {
    let t = 0;
    const now = () => t;
    const storage = new MemoryStorage();
    await storage.put("config", { gatewayToken: "gateway-token-differs-from-admin" });

    const before = await coldStart(storage, now);            // 冲突之前建好的 isolate

    await storage.put("config", { gatewayToken: TEST_ADMIN_TOKEN });   // 运维手滑
    t += CONFIG_TTL_MS * 2;
    const during = await coldStart(storage, now);            // 冲突期间冷启动的 isolate

    expect(
      [(await before.request("/admin/api/session", withKey)).status,
       (await during.request("/admin/api/session", withKey)).status],
      "冲突期间两批 isolate 必须给出同一个状态码",
    ).toEqual([503, 503]);

    await storage.put("config", { gatewayToken: "gateway-token-differs-again" });   // 按文档改回去
    t += CONFIG_TTL_MS * 2;

    expect(
      [(await before.request("/admin/api/session", withKey)).status,
       (await during.request("/admin/api/session", withKey)).status],
      "DEPLOY.md 承诺「改回去不需要重启」，那就必须对两批都成立",
    ).toEqual([200, 200]);
  });
});

// ── 枚举式鉴权矩阵 ────────────────────────────────────────────────────────
//
// 这个项目最怕的失效形态是「加了鉴权，实际没有」，而它的表现是**某一条路由被漏掉**
// ——抽样天然抽不到被漏掉的那条。所以这里跑的是笛卡尔积：
//     实际注册的每一条路由 × 每一种凭据状态，每一格都有明确期望，没有空格。
//
// 期望值**独立于实现**这一条是本块的命门（同义反复是这个项目已发现的第 6 种假阳性）：
//   · 路由清单：从 `app.routes` 动态取（手写清单会和代码漂移，而漂移方向恰恰是
//     「新加的路由忘了加进清单」），另配一份双向快照强制新端点被评审看见。
//   · 安全域：从**路径前缀**这个外部事实推导（URL 命名空间是设计先于实现的约定），
//     **不看代码里挂没挂中间件**——从「挂没挂」推「该不该挂」就是同义反复。
//   · 哪套凭据开哪个域的门：手写的策略表 `opens`，是规格，不是从被测对象读出来的。
describe("枚举式鉴权矩阵（路由 × 凭据状态，笛卡尔积）", () => {
  type Domain = "public" | "gateway" | "admin";

  /**
   * 免鉴权路径。**显式常量**，改动它必须在评审里被看见。
   *
   * `/admin` 与 `/admin/*` 是 Task 6 加的静态资源：登录闸得先能打开，否则没法登录。
   * 它们只投递编译期常量表 `UI_ASSETS`（src/ui/serve.ts），**不读任何运行时状态**
   *（`tests/contract/ui-serve.test.ts` 的「GET /admin 免鉴权返回 index.html，字节与生成物一致」
   *  守着它——那里断言的是逐字节相等，比「页面里大概没有敏感内容」强得多）。
   * 除此之外这张表不许再长。
   *
   * **关于 `/admin/`（尾斜杠 301 跳 `/admin`）的表态：三张表都不增长。**
   * 它不是一条新注册的路由，而是 `GET /admin/*` 这个 handler 内部的一个分支
   *（`app.routes` 里查不到它），安全域已经由 `/admin/*` 这条表过了态。
   * 刻意**不**把它写进 `PUBLIC_PATHS`：下面那条「免鉴权路径不带凭据也是 200」
   * 断言的是 200，而它返回 301——为了塞进一个条目就把那条断言放宽成「不是 401」，
   * 是拿整张表的强度换一格覆盖，不划算。它的免鉴权与 301 由
   * `tests/contract/ui-serve.test.ts` 的「200 / 304 / 301 / 404 四个分支都带 cache-control: no-cache」
   * 一带的三条专门用例守着。
   *
   * **Task 3（P3c）的表态：这张表不增长。** 新增的四条 Key 写端点全在
   * `/admin/api/` 下 ⇒ `domainOf` 判它们进 `admin` 域 ⇒ 除管理口令外每一种凭据
   * 状态都必须 401。**免鉴权白名单里永远不该出现任何一条写端点**，这句话在这里
   * 是有护栏的：往这张表里塞一条 `/admin/api/keys`，下面
   * 「免鉴权路径不带任何凭据也是 200」会立刻红（它拿不到 200，只会拿到 401/400）。
   */
  const PUBLIC_PATHS: readonly string[] = ["/health", "/admin", "/admin/*"];

  /**
   * 路径 → 安全域。**总函数**：分不出来就抛，逼新端点在这里表态，
   * 不允许出现「这条不用测」的空格。
   */
  function domainOf(path: string): Domain {
    if (PUBLIC_PATHS.includes(path)) return "public";
    if (path === "/admin" || path.startsWith("/admin/")) return "admin";
    if (path.startsWith("/v1/") || path.startsWith("/v1beta/")) return "gateway";
    throw new Error(
      `路由 ${path} 未登记安全域：请在 domainOf 里明确它属于 public / gateway / admin 哪一个`,
    );
  }

  /**
   * 全量路由快照。**双向比对**：少一条说明路由被误删，多一条说明有人加了新端点
   * 而没有在这里表态它该不该鉴权。
   */
  const EXPECTED = [
    "GET /health",
    "GET /v1/models",
    "POST /v1/chat/completions",
    "POST /v1/messages",
    "GET /v1beta/models",
    "POST /v1beta/models/:rest{.+}",
    "POST /v1/responses",
    "POST /v1/images/generations",
    "POST /v1/videos",
    "GET /v1/videos/:id",
    "GET /admin/api/session",
    // Task 4（P3b）的 Key 池只读列表。同样用 `admin.get()` 注册，**不产生 ALL 条目**
    // ——这正是下面 EXPECTED_MIDDLEWARE 那张快照存在的理由，它因此保持不变。
    "GET /admin/api/keys",
    // Task 5（P3b）的 capabilities + overview。同样用 `admin.get()` 注册，
    // 不产生 ALL 条目——EXPECTED_MIDDLEWARE 因此仍然不变。
    "GET /admin/api/capabilities",
    "GET /admin/api/overview",
    // Task 6（P3b）的事件。同样用 `admin.get()` 注册，不产生 ALL 条目——
    // 这两条不影响 EXPECTED_MIDDLEWARE，真正让那张表变化的是 logFlush（见下）。
    "GET /admin/api/events",
    "GET /admin/api/events/download",
    // Task 6 的静态资源。**刻意用 get() 而不是 use()**，见 EXPECTED_MIDDLEWARE 的说明。
    "GET /admin",
    "GET /admin/*",
    // ── Task 3（P3c）的 Key 写端点：这张表**第一次**出现非 GET 条目 ──────────
    //
    // 在它们出现之前，`/admin/api/*` 六条全是 `admin.get()`，于是「鉴权挂没挂上」
    // 这件事唯一的可观测差异是「读得到 / 401」。现在它变成了「**删得掉** / 401」
    // ——**一个鉴权失效的 GET 泄露数据，一个鉴权失效的 DELETE 销毁数据**。
    // 矩阵因此多了一维，见本文件末尾
    // 「鉴权失败的非幂等请求必须零副作用 —— 只断言 401 抓不住『先删了再返回 401』」。
    //
    // 四条同样是 `admin.post/delete/patch()` 注册的**具名方法**，不是 `use()`
    // ⇒ **不产生 ALL 条目，`EXPECTED_MIDDLEWARE` 保持不变**（那张表存在的全部理由
    // 就是让「有人拿 use() 挂了个通配 handler」变红，所以每一次新增端点都要在这里
    // 明确表一次态，而不是默认它不变）。
    "POST /admin/api/keys",
    "POST /admin/api/keys/bulk",
    "DELETE /admin/api/keys/:id",
    "PATCH /admin/api/keys/:id",
    // ── Task 5（P3c）的「立即补池」──────────────────────────────────────────
    //
    // **这张表上第一条会产生真实上游副作用的端点**：上面四条只动本地存储，这一条会
    // 去建临时邮箱、注册 Agnes 账号、领 key。一个鉴权失效的 GET 泄露数据、一个鉴权
    // 失效的 DELETE 销毁数据，而**一个鉴权失效的这条会替你花掉外部服务的配额**，
    // 且花掉的东西收不回来。
    //
    // 它同样用 `admin.post()` 注册（不是 `use()`）⇒ 不产生 ALL 条目，
    // `EXPECTED_MIDDLEWARE` 保持不变。
    //
    // ⚠️ **路由注册没有任何条件**：`adminRouter` 不看「注册机开没开」就注册它。
    // 做成条件注册的话，这张快照会随夹具配置变化——而默认夹具恰好关着注册机，
    // 于是这条端点会**静默地从整个鉴权矩阵里消失**。「注册机没开」是 handler 里的
    // 一条 409，不是"这条路由不存在"。
    "POST /admin/api/registrar/tend",
  ] as const;

  /** 路由模式 → 一条能真的打到那个 handler 的具体路径。 */
  const PROBE: Record<string, string> = {
    "/v1beta/models/:rest{.+}": "/v1beta/models/agnes-2.0-flash:generateContent",
    "/v1/videos/:id": "/v1/videos/abc123",
    // 静态兜底：拿 `/admin/*` 当字面路径请求只会得到 404（查表命中制），
    // 那样这一格什么都没验到，必须换成一条真的在 UI_ASSETS 里的路径。
    "/admin/*": "/admin/css/base.css",
    // Task 3 的 `DELETE` / `PATCH` 共用这条模式。**用一个不存在的 id，是为了不让这一格
    // 依赖夹具状态**：矩阵会拿正确的管理口令把每条路由真的打一遍（那些格子断言的是
    // 「不该被判 401」），而 `DELETE` 是有副作用的。
    //
    // ⚠️ **这里原来写的理由是「一个存在的 id 会让这里真的删掉夹具里的 key」——
    // 那句话今天是假的**（评审 m2，我复核属实）：默认夹具只播一把健康的 `k1`，
    // 拿正确口令删它只会得到 `409 must_disable_first`，删不掉。
    // 选择本身保留（换一个夹具、或「必须先停用」那条判据一旦被改坏，它立刻变真），
    // 但**理由要写成真的**：判据是"不依赖夹具状态"，不是"否则会被删掉"。
    "/admin/api/keys/:id": "/admin/api/keys/deadbeefdeadbeef",
  };

  const GATEWAY = TEST_CONFIG.gatewayToken;
  const ADMIN = TEST_ADMIN_TOKEN;

  interface CredState {
    name: string;
    headers: Record<string, string>;
    query?: string;
    /**
     * 这套凭据**应当**能开哪些安全域的门。手写的策略声明：
     * 网关信道 = Authorization: Bearer / x-api-key / x-goog-api-key / ?key=（Gemini 协议兼容，
     * 见 `tests/contract/auth.test.ts` 的「接受查询参数 key」一带钉住的既有契约）；
     * 管理信道 = **仅** x-admin-key。
     * 两把钥匙严格隔离，任何一把都不该开另一边的门。
     */
    opens: readonly Domain[];
  }

  const STATES: readonly CredState[] = [
    { name: "无凭据", headers: {}, opens: [] },
    { name: "错凭据（网关信道 Bearer）", headers: { authorization: "Bearer wrong-value" }, opens: [] },
    { name: "错凭据（管理信道）", headers: { "x-admin-key": "wrong-value" }, opens: [] },
    { name: "空字符串凭据（网关信道 x-api-key）", headers: { "x-api-key": "" }, opens: [] },
    { name: "空字符串凭据（管理信道）", headers: { "x-admin-key": "" }, opens: [] },
    { name: "网关口令（Bearer）", headers: { authorization: `Bearer ${GATEWAY}` }, opens: ["gateway"] },
    { name: "网关口令（x-api-key）", headers: { "x-api-key": GATEWAY }, opens: ["gateway"] },
    { name: "网关口令（x-goog-api-key）", headers: { "x-goog-api-key": GATEWAY }, opens: ["gateway"] },
    { name: "网关口令（?key= 查询参数）", headers: {}, query: `key=${GATEWAY}`, opens: ["gateway"] },
    { name: "网关口令用在管理信道", headers: { "x-admin-key": GATEWAY }, opens: [] },
    { name: "管理口令（x-admin-key）", headers: { "x-admin-key": ADMIN }, opens: ["admin"] },
    { name: "管理口令用在网关信道（Bearer）", headers: { authorization: `Bearer ${ADMIN}` }, opens: [] },
    { name: "管理口令用在网关信道（x-api-key）", headers: { "x-api-key": ADMIN }, opens: [] },
    { name: "管理口令用在网关信道（x-goog-api-key）", headers: { "x-goog-api-key": ADMIN }, opens: [] },
    { name: "管理口令走 ?key= 查询参数", headers: {}, query: `key=${ADMIN}`, opens: [] },
    {
      name: "两把口令各就各位（网关信道给网关口令 + 管理信道给管理口令）",
      headers: { authorization: `Bearer ${GATEWAY}`, "x-admin-key": ADMIN },
      opens: ["gateway", "admin"],
    },
  ];

  /** 免鉴权域永不 401；其余域看这套凭据有没有被登记为能开它。 */
  function must401(domain: Domain, state: CredState): boolean {
    if (domain === "public") return false;
    return !state.opens.includes(domain);
  }

  /**
   * 全部 `ALL` 条目的快照。**双向钉死，且这一条不能省。**
   *
   * `realRoutes` 把 `method === "ALL"` 的条目滤掉，是为了避开「拿中间件条目当路径去
   * 请求、轻易得到 401」那种什么都没证明的断言。但 **`ALL` 条目里混得进真 handler**：
   * Hono 的 serveStatic 惯用注册法就是 `app.use("/admin/*", serveStatic(...))`，产生的
   * 条目同样是 `ALL /admin/*`。**只断言「路径以 * 结尾」区分不了中间件和通配 handler**
   * ——实测：在鉴权 use 之前插一行 `admin.use("/admin/assets/*", (c) => c.text("..."))`，
   * 就得到一个无鉴权、能读出内容的 /admin 端点，而这个文件当时 40 条全绿。
   *
   * 所以改为**把 ALL 条目也列成显式快照**：任何新增的 use()（无论中间件还是通配
   * handler）都会让这条变红，必须在评审里表态。
   *
   * **Task 6（P3a）的表态：这张表不增长。** 静态资源用 `app.get("/admin", h)` +
   * `app.get("/admin/*", h)` 注册（src/ui/serve.ts），产生的是两条 `GET` 条目，
   * 已列进上面的 `EXPECTED`、并逐格跑过矩阵。刻意不用 Hono 那个
   * `app.use("/admin/*", serveStatic(...))` 的惯用写法——那会产生一条 `ALL /admin/*`
   * 通配 handler，正是这张快照存在的理由。将来谁改回 use()，这条会立刻变红。
   *
   * **Task 6（P3b）的表态：这张表加一条。** `src/http/log-flush.ts` 的 `logFlush`
   * 中间件挂在 `app.use("*", ...)`（挂在 `configRefresh` 之后、其余中间件之前，
   * 见 `app.ts` 的注释），产生第三条 `ALL /*`。**这张快照红了正是它在起作用**——
   * 事件要能在响应返回前落盘，这条中间件必须真的挂上；别把它改绿了事。
   *
   * **Task 3（P3c）的表态：这张表同样不增长。** 四条 Key 写端点用
   * `admin.post/delete/patch()` 注册，产生的是四条具名方法条目（已列进 `EXPECTED`、
   * 并逐格跑过矩阵）。**这一次的表态比前几次值钱**：写端点是第一次出现，而
   * `app.use("/admin/api/keys/*", handler)` 这种写法能造出一个**免鉴权的写端点**
   * ——鉴权 `use` 挂的是 `/admin/api/*`，顺序在它之前的任何 `use` 都跑在鉴权之前。
   *
   * **Task 5（P3c）的表态：这张表同样不增长。** `POST /admin/api/registrar/tend`
   * 用 `admin.post()` 注册，产生的是一条具名方法条目（已列进 `EXPECTED`、并逐格跑过
   * 矩阵）。这一次的表态比 Task 3 那次更值钱：一个免鉴权的「立即补池」不是泄露数据、
   * 也不是销毁数据，而是**让任何人都能远程消耗你在外部服务上的配额**。
   */
  const EXPECTED_MIDDLEWARE = [
    "ALL /*",              // configRefresh
    "ALL /*",              // logFlush（事件落盘，Task 6/P3b）
    "ALL /*",              // 全局 nosniff（三条同名条目；少一条这里立刻变红）
    "ALL /v1/*",           // 网关鉴权
    "ALL /v1beta/*",       // 网关鉴权
    "ALL /admin/api/*",    // 管理鉴权
  ] as const;

  /** `app.routes` 里的真实端点（滤掉上面那些 ALL 条目，它们由快照单独钉住）。 */
  function realRoutes(app: Awaited<ReturnType<typeof makeApp>>["app"]) {
    return app.routes.filter((r) => r.method !== "ALL");
  }

  it("路由集合与快照双向一致", async () => {
    const { app } = await makeApp();
    const actual = realRoutes(app).map((r) => `${r.method} ${r.path}`).sort();
    expect([...new Set(actual)]).toEqual([...EXPECTED].sort());
  });

  it("通配中间件条目也双向钉死——use() 注册的通配 handler 不许悄悄绕过枚举", async () => {
    const { app } = await makeApp();
    const actual = app.routes
      .filter((r) => r.method === "ALL")
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(actual).toEqual([...EXPECTED_MIDDLEWARE].sort());
  });

  it("三个安全域在矩阵里都真的出现了（否则矩阵是残缺的）", async () => {
    const { app } = await makeApp();
    const domains = new Set(realRoutes(app).map((r) => domainOf(r.path)));
    expect([...domains].sort()).toEqual(["admin", "gateway", "public"]);
  });

  it("每一条路由 × 每一种凭据状态，逐格断言", async () => {
    const { app } = await makeApp();
    const routes = realRoutes(app);
    let cells = 0;
    let denied = 0;
    let allowed = 0;

    for (const r of routes) {
      const domain = domainOf(r.path);
      const base = PROBE[r.path] ?? r.path;
      for (const state of STATES) {
        const url = state.query ? `${base}?${state.query}` : base;
        const res = await app.request(url, { method: r.method, headers: state.headers });
        const label = `${r.method} ${base} × ${state.name}`;
        if (must401(domain, state)) {
          expect(res.status, `${label}：必须 401`).toBe(401);
          denied++;
        } else {
          // 鉴权边界唯一的可观测量就是「有没有被判 401」。放行之后 handler 因为
          // 缺请求体返回 400 之类是另一回事，不在本矩阵的断言范围内。
          expect(res.status, `${label}：不该被判 401`).not.toBe(401);
          allowed++;
        }
        cells++;
      }
    }

    // 逐条断言全都「通过」但其实一格没跑，是这个循环最容易出的假阳性。
    expect(cells, "枚举的格子数必须等于 路由数 × 凭据状态数").toBe(routes.length * STATES.length);
    expect(routes.length).toBe(EXPECTED.length);
    // 状态表的规模也钉住。删掉一种凭据状态**不会**让别的断言变红（cells 是从这张表
    // 自己算出来的），只有这条能拦住「悄悄少测一条信道」。它是评审绊线，不是行为断言。
    expect(STATES.length, "凭据状态表被改过，请在评审里确认这是有意的").toBe(16);
    expect(denied, "必须真的有该拒的格子").toBeGreaterThan(0);
    expect(allowed, "必须真的有该放行的格子").toBeGreaterThan(0);
  });

  it("免鉴权路径不带任何凭据也是 200（否则白名单本身就是错的）", async () => {
    const { app } = await makeApp();
    for (const p of PUBLIC_PATHS) {
      // 通配条目要换成一条真的存在的路径，否则拿到的 404 什么都没证明。
      expect((await app.request(PROBE[p] ?? p)).status, p).toBe(200);
    }
  });

  /**
   * ── F9：写端点比读端点多一维 ────────────────────────────────────────────
   *
   * **一个鉴权失效的 GET 泄露数据，一个鉴权失效的 DELETE 销毁数据。**
   * 上面那张笛卡尔积只断言状态码，而状态码抓不住「**先删了再返回 401**」这种顺序
   * 错误——它在 Hono 上不是假想：`app.route("/", sub)` 写在 `app.use(path, mw)`
   * 之前时，中间件**静默失效且不报错**（`src/http/admin/router.ts` 那段 ★ 已实测）。
   * 那种形态下 handler 先跑完、鉴权再"生效"，状态码可能仍然是 401 而副作用已经发生。
   *
   * ⇒ 判据换成**存储的 put / delete 计数逐字段相等**。
   *
   * ⚠️ **夹具刻意用「鉴权若不存在就一定会成功」的请求**，这是本格判别力的全部来源：
   *   · `DELETE` 打的是一把**已经停用**的 key（健康的 key 会被 409 拦住，
   *     那样即使鉴权失效也是 0 次写，本格照绿）；
   *   · `POST` 带的是一份**合法的导入体**（畸形体会被 400 拦住，同上）；
   *   · `PATCH` / `bulk` 同理。
   * 每一条都先断言 401，再断言计数不动——**两条都要**：只断言计数不动的话，
   * 一个把整棵树 404 掉的改动也能让它通过。
   */
  it("鉴权失败的非幂等请求必须零副作用 —— 只断言 401 抓不住『先删了再返回 401』", async () => {
    const st = new CountingStorage();
    const { app, repo } = await makeApp(
      [], ["sk-side-effect-probe-key"], {}, () => 1000, { storage: st },
    );
    const target = (await repo.all())[0]!;
    // 停用它：**这样那次无口令的 DELETE 在鉴权失效时会真的删掉一条记录**。
    await repo.save({ ...target, disabled: true }, target);

    const snapshot = () => ({ puts: st.puts, deletes: st.deletes });
    const CASES: ReadonlyArray<{ name: string; path: string; method: string; body?: unknown }> = [
      { name: "DELETE 一把已停用的 key", path: `/admin/api/keys/${target.id}`, method: "DELETE" },
      { name: "PATCH 停用", path: `/admin/api/keys/${target.id}`, method: "PATCH", body: { disabled: true } },
      { name: "POST 导入一把新 key", path: "/admin/api/keys", method: "POST", body: { keys: ["sk-injected-by-attacker"] } },
      {
        name: "POST 批量删除", path: "/admin/api/keys/bulk", method: "POST",
        body: { op: "delete", ids: [target.id] },
      },
    ];

    for (const c of CASES) {
      const before = snapshot();
      const res = await app.request(c.path, {
        method: c.method,
        headers: c.body === undefined ? {} : { "content-type": "application/json" },
        body: c.body === undefined ? undefined : JSON.stringify(c.body),
      });
      expect(res.status, `${c.name}：无口令必须 401`).toBe(401);
      expect(snapshot(), `${c.name}：鉴权失败了，但存储被动过`).toEqual(before);
    }

    // 反向自检：这些请求**带上口令就真的会写**——否则上面四个 0 什么都没证明。
    const ok = await app.request(`/admin/api/keys/${target.id}`, {
      method: "DELETE", headers: { "x-admin-key": TEST_ADMIN_TOKEN },
    });
    expect(ok.status, "夹具本身删不掉 ⇒ 上面那四个「零副作用」是空的").toBe(204);
    expect(st.deletes, "带对口令的那次 DELETE 也没碰存储").toBeGreaterThan(0);
  });

  it("矩阵里「不该 401」的格子不是空口白话：两条路由用对口令确实 200", async () => {
    const { app } = await makeApp();
    expect((await app.request("/v1/models", {
      headers: { authorization: `Bearer ${GATEWAY}` },
    })).status).toBe(200);
    expect((await app.request("/admin/api/session", {
      headers: { "x-admin-key": ADMIN },
    })).status).toBe(200);
  });
});
