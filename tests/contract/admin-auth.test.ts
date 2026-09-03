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
   *（已实测：计划给的那版用例正是这么写的，变异完整逃逸）。24 是**策略**
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
    // ⚠️ **这一格一度被改成过 `not_sendable`，评审裁定后改了回来，
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
   * 咬过一次，审计工具看不见的字符不该出现在源码里。
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
      // 咬过一次的那个字符（源文件里的裸 NUL 让整份文件对 git diff / grep /
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
    // **处置建议必须是「轮换 ADMIN_TOKEN」，不许是「改掉任一把」**（评审发现）。
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
  // 的 `ip=` 字段——事件板块正要按它做筛选、聚合、展示。

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
// （文档里教的 `wrangler kv key put` / 直接编辑 store.json，以及将来的面板，
// 都能写这个键），gatewayToken 可以在运行中被改成等于 ADMIN_TOKEN——而中转口令是发给
// **每一个下游用户**的，届时任何下游用户都能开后台，直到重启 / isolate 回收为止。
//
// 这不是「留给写入路径去拒绝」能解决的：手工改存储绕得过写入路径校验。
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
    // 与装配期那条同一条纪律（评审发现）：怎么修必须说准。
    expect(String(e?.msg), "没告诉运维要轮换 ADMIN_TOKEN").toContain("轮换");
    for (const wrong of ["任一把", "其中一把"]) {
      expect(String(e?.msg), `又把「${wrong}」这种只恢复可用性的说法写回去了`).not.toContain(wrong);
    }
    // 日志常被转发到第三方，同样不许带口令本身。
    expect(JSON.stringify(e)).not.toContain(TEST_ADMIN_TOKEN);
  });

  /**
   * ⚠️ **这一格证明的是可用性恢复，不是处置完成。** 冲突一旦发生过，`ADMIN_TOKEN`
   * 就等于一把发给每个下游用户的中转口令，必须轮换（评审发现，五语言
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
   * `/admin` 与 `/admin/*` 是静态资源：登录闸得先能打开，否则没法登录。
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
   * **Key 写那一轮的表态：这张表不增长。** 新增的四条 Key 写端点全在
   * `/admin/api/` 下 ⇒ `domainOf` 判它们进 `admin` 域 ⇒ 除管理口令外每一种凭据
   * 状态都必须 401。**免鉴权白名单里永远不该出现任何一条写端点**，这句话在这里
   * 是有护栏的：往这张表里塞一条 `/admin/api/keys`，下面
   * 「免鉴权路径不带任何凭据也是 200」会立刻红（它拿不到 200，只会拿到 401/400）。
   *
   * **用量那一轮的表态：这张表同样不增长。** 新增的三条用量端点全在
   * `/admin/api/` 下 ⇒ `domainOf` 判它们进 `admin` 域。三条**都**是 GET，
   * 其中两条在 Tier-2 关着时连存储都不读，看上去比协议目录那条更像
   * 「反正没什么可泄漏的」——**仍然不许**：
   * ① `keys/:id/usage` 吐的是某一把 key 的请求数 / 成功数 / 失败数 / 最近一次错误的
   *    类型与时刻，那是一份「这台网关的哪把凭据在被怎么用」的画像；
   * ② `usage` / `usage/:date` 吐的是整台网关的流量曲线与按模型、按协议的分解
   *    ——一份现成的「这个部署有多大、在跑什么模型」的情报；
   * ③ 结构上的理由与协议目录那条完全相同：`adminAuth` 挂在 `/admin/api/*` 上，
   *    要让它们免鉴权就得挪到那行 `use` 之前，而**那个位置上的任何后续新增端点
   *    都会跟着免鉴权**。
   *
   * **站点图标那一轮的表态：这张表长一条 `/favicon.ico`。**
   * 它与 `/admin` / `/admin/*` 同源同理由 —— 同样注册在 `src/ui/serve.ts` 的
   * `uiRoutes()` 里、同样只投递编译期常量（那串字节就住在 `UI_ASSETS["/admin"]` 的
   * HTML 里）、同样跟着 `ADMIN_TOKEN` 一起存在或消失。**它必须免鉴权**：浏览器取
   * 图标时不带任何自定义头，鉴权一挂上就是一个永远 401 的图标。
   * 逐字节等于那份 HTML 里内联的那一串这件事由
   * `tests/contract/ui-serve.test.ts` 的
   * 「200 + image/png，字节与 /admin 那份 HTML 里内联的那一串逐字节相同」守着。
   */
  const PUBLIC_PATHS: readonly string[] = ["/health", "/admin", "/admin/*", "/favicon.ico"];

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
    // Key 池只读列表。同样用 `admin.get()` 注册，**不产生 ALL 条目**
    // ——这正是下面 EXPECTED_MIDDLEWARE 那张快照存在的理由，它因此保持不变。
    "GET /admin/api/keys",
    // capabilities + overview。同样用 `admin.get()` 注册，
    // 不产生 ALL 条目——EXPECTED_MIDDLEWARE 因此仍然不变。
    "GET /admin/api/capabilities",
    "GET /admin/api/overview",
    // 事件。同样用 `admin.get()` 注册，不产生 ALL 条目——
    // 这两条不影响 EXPECTED_MIDDLEWARE，真正让那张表变化的是 logFlush（见下）。
    "GET /admin/api/events",
    "GET /admin/api/events/download",
    // 静态资源。**刻意用 get() 而不是 use()**，见 EXPECTED_MIDDLEWARE 的说明。
    "GET /admin",
    "GET /admin/*",
    // 站点图标。**这是 `uiRoutes()` 里唯一一条不在 /admin 前缀下的路由**，
    // 也是这张表上第一条不带 /health、/v1、/admin 三种前缀的条目 ——
    // 它同样用 `admin.get()` 那一族（`app.get()`）注册，不产生 ALL 条目
    // ⇒ `EXPECTED_MIDDLEWARE` 保持不变。免鉴权的表态写在 `PUBLIC_PATHS` 上方。
    "GET /favicon.ico",
    // ── Key 写端点：这张表**第一次**出现非 GET 条目 ──────────────────────────
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
    // ── 危险区第二颗按钮：清空整个 Key 池 ─────────────────────────────────────
    //
    // 它用 `admin.post()` 注册（**不是 `use()`**）⇒ 不产生 ALL 条目，
    // `EXPECTED_MIDDLEWARE` 保持不变。**每一次新增端点都要在这里明确表一次态**，
    // 而不是默认它不变。
    //
    // ⚠️ **这是这张表上后果最不可挽回的一条**：上面那条 `DELETE /admin/api/keys/:id`
    // 一次删一把、而且要求先停用；这一条一次删**整池**，且 key 明文只在存储里有一份。
    // 一个鉴权失效的它 = 任何人一次请求就把这台网关的全部上游凭据抹掉，
    // 连带每把 key 的用量历史（`stats` 住在记录的值里面）。`PUBLIC_PATHS` 当然不增长。
    //
    // ⚠️ **矩阵会拿正确的管理口令把每条路由真的打一遍，而这一条打通了就是清空整池**
    // ——它安全的唯一理由是 `expect` 必填：矩阵发的是不带请求体的 POST，
    // 在 `readAdminJson` 那一步就 400，一把都删不掉。400 不是 401，那一格断言的
    // 「不该被判 401」照样成立。**别把 `expect` 改成可选**，那会让这张矩阵开始
    // 清自己的夹具（`src/http/admin/handlers/keys-write.ts` 里那段 ⚠️ 记的是同一件事）。
    "POST /admin/api/keys/purge",
    "DELETE /admin/api/keys/:id",
    "PATCH /admin/api/keys/:id",
    // ── 「立即补池」─────────────────────────────────────────────────────────
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
    // ── 注册机板块取数与通道连通性测试 ────────────────────────────────────────
    //
    // 两条都用 `admin.get()` / `admin.post()` 注册（不是 `use()`）⇒ 不产生 ALL 条目，
    // `EXPECTED_MIDDLEWARE` 保持不变。**每一次新增端点都要在这里明确表一次态**，
    // 而不是默认它不变——那张表存在的全部理由就是让「有人拿 use() 挂了个通配
    // handler」变红。
    //
    // ⚠️ **`status` 是一条 GET，但它绝不属于免鉴权白名单**：它吐的是补池历史、
    // 当天还剩几次手动补池、以及两条邮箱通道各自配没配凭据——**一份关于这个部署
    // 接了哪些外部服务的完整清单**。往 `PUBLIC_PATHS` 里塞它的话，下面
    // 「免鉴权路径不带任何凭据也是 200」那一格拿到的会是 401，当场变红。
    //
    // ⚠️ **`channels/:channel/test` 是这张表上第二条会打到外部服务的端点**：
    // 它向邮箱服务发一次只读 GET（`listDomains()`），不建邮箱、不注册账号。
    // 一个鉴权失效的它不销毁数据也不消耗名额，但**会把本网关的出口 IP 变成
    // 一个任何人都能驱动的探测器**，所以它同样只能待在 admin 域里。
    "GET /admin/api/registrar/status",
    "POST /admin/api/registrar/channels/:channel/test",
    // ── 配置读写 ───────────────────────────────────────────────────────────────
    //
    // **这四条是这张表上第一次出现「能改网关自己怎么跑」的端点**，而且第一次出现
    // `PUT`。前面的分级还可以接着往下排：一个鉴权失效的 GET 泄露数据、一个鉴权失效
    // 的 DELETE 销毁数据、一个鉴权失效的 `registrar/tend` 花掉外部配额，
    // 而**一个鉴权失效的 `PUT /admin/api/config` 直接把整台网关交出去**——
    // 它能改掉 `gatewayToken`（改完之后原来那把中转口令全部失效、新的那把在攻击者
    // 手里）、能打开注册机、能把 `agnesPlatformUrl` 指向攻击者自己的服务器
    // （那样每一次自动注册的邮箱 + 密码 + 验证码都会送过去）。
    //
    // 四条都用 `admin.get/put/post()` 注册（**不是 `use()`**）⇒ 不产生 ALL 条目，
    // `EXPECTED_MIDDLEWARE` 保持不变。**每一次新增端点都要在这里明确表一次态**，
    // 而不是默认它不变——那张表存在的全部理由就是让「有人拿 use() 挂了个通配
    // handler」变红。
    //
    // ⚠️ **`GET /admin/api/config` 绝不属于免鉴权白名单**：它吐的是全部配置字段的
    // 四元组（含 `agnesBaseUrl`、注册机开没开、两条通道各自配没配凭据）。
    // 明文凭据不在里面（`{ configured, hint }`，见设计 §8.6），但**末 4 位在**，
    // 而那正好是一份「这个部署接了哪些外部服务、口令长什么样」的清单。
    // 往 `PUBLIC_PATHS` 里塞它的话，下面「免鉴权路径不带任何凭据也是 200」
    // 那一格拿到的会是 401，当场变红。
    "GET /admin/api/config",
    "PUT /admin/api/config",
    "POST /admin/api/config/validate",
    "POST /admin/api/config/secrets/clear",
    // ── 危险区第一颗按钮：`config` 整把写回 `{}` ────────────────────────────────
    //
    // 它用 `admin.post()` 注册（**不是 `use()`**）⇒ 不产生 ALL 条目，
    // `EXPECTED_MIDDLEWARE` 保持不变。**每一次新增端点都要在这里明确表一次态。**
    //
    // ⚠️ **它比上面那条 `PUT /admin/api/config` 的爆炸半径更大，而不是更小**：
    // `PUT` 至少是逐字段的，这一条是整把写回 `{}` —— 网关口令、两条通道的凭据、
    // 注册机的全部旋钮一次全清。一个鉴权失效的它 = 任何人一次请求就让这台网关的
    // 下一次冷启动起不来（env 里没有兜底时）。`PUBLIC_PATHS` 同样不增长。
    //
    // ⚠️ **它在矩阵里安全的唯一理由是 `confirm: true` 必填**，与
    // `POST /admin/api/keys/purge` 那段逐字同源：矩阵发的是不带请求体的 POST，
    // 在 `readAdminJson` 那一步就 400，一个字节都不写。
    "POST /admin/api/config/reset",
    // ── 协议与模型目录 ────────────────────────────────────────────────────────
    //
    // 它用 `admin.get()` 注册（**不是 `use()`**）⇒ 不产生 ALL 条目，
    // `EXPECTED_MIDDLEWARE` 保持不变。**每一次新增端点都要在这里明确表一次态**，
    // 而不是默认它不变。
    //
    // ⚠️ **`PUBLIC_PATHS` 同样不增长，而这一次「不增长」是要论证的**：这条端点吐的是
    // 一份**纯静态**的目录（协议名、对外路径、最小请求体骨架），里面没有任何这个部署
    // 的运行时状态，看上去像是可以免鉴权的第一条 `/admin/api/*`。**仍然不许**：
    // ① 它是一张「这台网关支持哪些协议、怎么调」的完整地图，配上 `/admin` 页面本身
    //    就是一份现成的攻击面清单，而免鉴权意味着任何人都能拿；
    // ② 更要紧的是**结构**——`adminAuth` 挂在 `/admin/api/*` 上，要让这一条免鉴权
    //    就得把它挪到那行 `use` 之前，而**那个位置上的任何后续新增端点都会跟着免鉴权**。
    //    为一条静态目录去打开那个位置，是拿整棵树的结构性保证换一次往返。
    // 往 `PUBLIC_PATHS` 里塞它的话，下面「免鉴权路径不带任何凭据也是 200」
    // 那一格拿到的会是 401，当场变红。
    "GET /admin/api/models",
    // ── 用量三条 ──────────────────────────────────────────────────────────────
    //
    // 三条都用 `admin.get()` 注册（**不是 `use()`**）⇒ 不产生 ALL 条目，
    // `EXPECTED_MIDDLEWARE` 保持不变。**每一次新增端点都要在这里明确表一次态**，
    // 而不是默认它不变。
    //
    // ⚠️ **三条的注册都没有任何条件，不看 Tier-2 开没开**——理由与
    // `POST /admin/api/registrar/tend` 那条逐字相同：做成条件注册的话这张快照会随
    // 夹具配置变化，而**默认夹具恰好关着 Tier-2**，于是这两条 `usage` 端点会
    // 静默地从整个鉴权矩阵里消失。「Tier-2 没开」是响应体里的 `tier: "off"`，
    // 不是"这条路由不存在"。
    //
    // ⚠️ **`GET /admin/api/keys/:id/usage` 挂在 `DELETE` / `PATCH /admin/api/keys/:id`
    // 之后**：今天段数不同（四段 vs 三段）碰不上，但顺序反了之后加一条更宽的
    // `/admin/api/keys/:id/:something` 就会静默把它吃掉——与 `bulk` vs `:id`
    // 是同一个坑（见 `src/http/admin/router.ts` 里那两段注释）。
    "GET /admin/api/keys/:id/usage",
    "GET /admin/api/usage",
    "GET /admin/api/usage/:date",
    // ── 单把 key 验活 ──────────────────────────────────────────────────────────
    //
    // 它用 `admin.post()` 注册（**不是 `use()`**）⇒ 不产生 ALL 条目，
    // `EXPECTED_MIDDLEWARE` 保持不变。**每一次新增端点都要在这里明确表一次态**，
    // 而不是默认它不变。
    //
    // ⚠️ **这是这张表上第三条会打到网关之外的端点，而它比前两条都更贴身**：
    // `registrar/tend` 花的是外部服务的配额、`channels/:c/test` 借的是本网关的出口 IP，
    // 而这一条是**本仓第一次让后端拿着某一把具体的明文上游 key 去打上游**——
    // 请求头里有它，上游 401 的错误体里可能有它的片段。
    // 一个鉴权失效的它 = 任何人都能拿这台网关逐把探测池子里每一把 key 的死活。
    // ⇒ 它当然只能待在 admin 域里，`PUBLIC_PATHS` 同样不增长。
    //
    // ⚠️ **它挂在 `DELETE` / `PATCH /admin/api/keys/:id` 与 `GET /admin/api/keys/:id/usage`
    // 之后**：今天段数与方法都对不上（四段 POST vs 三段 DELETE/PATCH vs 四段 GET），
    // 碰不上；但顺序反了之后加一条更宽的 `/admin/api/keys/:id/:something` 就会静默把它
    // 吃掉——与 `bulk` vs `:id` 是同一个坑（见 `src/http/admin/router.ts` 里那几段注释）。
    "POST /admin/api/keys/:id/verify",
  ] as const;

  /** 路由模式 → 一条能真的打到那个 handler 的具体路径。 */
  const PROBE: Record<string, string> = {
    "/v1beta/models/:rest{.+}": "/v1beta/models/agnes-2.0-flash:generateContent",
    "/v1/videos/:id": "/v1/videos/abc123",
    // 静态兜底：拿 `/admin/*` 当字面路径请求只会得到 404（查表命中制），
    // 那样这一格什么都没验到，必须换成一条真的在 UI_ASSETS 里的路径。
    "/admin/*": "/admin/css/base.css",
    // Key 写的 `DELETE` / `PATCH` 共用这条模式。**用一个不存在的 id，是为了不让这一格
    // 依赖夹具状态**：矩阵会拿正确的管理口令把每条路由真的打一遍（那些格子断言的是
    // 「不该被判 401」），而 `DELETE` 是有副作用的。
    //
    // ⚠️ **这里原来写的理由是「一个存在的 id 会让这里真的删掉夹具里的 key」——
    // 那句话今天是假的**（评审 m2，我复核属实）：默认夹具只播一把健康的 `k1`，
    // 拿正确口令删它只会得到 `409 must_disable_first`，删不掉。
    // 选择本身保留（换一个夹具、或「必须先停用」那条判据一旦被改坏，它立刻变真），
    // 但**理由要写成真的**：判据是"不依赖夹具状态"，不是"否则会被删掉"。
    "/admin/api/keys/:id": "/admin/api/keys/deadbeefdeadbeef",
    // 通道测试。**用一条真的存在的通道名**（`moemail`），不用占位串：
    // 矩阵那一格断言的是「拿对口令时不该被判 401」，而一个不认识的通道名会在
    // handler 第一行就被 400 挡掉——那样这一格验的是参数校验，不是鉴权。
    //
    // ⚠️ **这一格不会真的打到上游**：默认夹具的注册机是关着的，handler 在
    // 构造任何 provider 之前就返回 `409 registrar_disabled`。矩阵里那 16 次请求
    // 因此一次外部调用都不产生（否则整个鉴权矩阵会变成一个会打网络的测试）。
    "/admin/api/registrar/channels/:channel/test": "/admin/api/registrar/channels/moemail/test",
    // 逐 key 用量。**用一个不存在的 id**，与上面 `keys/:id` 同一条
    // 理由：矩阵那一格断言的是「拿对口令时不该被判 401」，而它会如实 404。
    "/admin/api/keys/:id/usage": "/admin/api/keys/deadbeefdeadbeef/usage",
    // 单日下钻。**必须用一个真的解析得开的 UTC 日期串**：
    // 占位串会在 handler 第一行就被 400 挡掉——那样这一格验的是参数校验，不是鉴权。
    "/admin/api/usage/:date": "/admin/api/usage/2024-10-04",
    // 验活。**必须用一个不存在的 id**，理由比上面那两条更硬：
    // 矩阵会拿正确的管理口令把每条路由真的打一遍，而这一条打通了就是**一次真的
    // 出站请求**（默认夹具的 `FakeFetcher` 会收下它，但整个鉴权矩阵不该是一个
    // 会发出站请求的测试——`channels/:channel/test` 那一格上面记的是同一句话）。
    // 用不存在的 id ⇒ handler 在 `repo.get()` 那一步就 404，护栏都不会被占。
    // 404 不是 401，矩阵那一格断言的「不该被判 401」照样成立。
    "/admin/api/keys/:id/verify": "/admin/api/keys/deadbeefdeadbeef/verify",
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
   * **静态资源那一轮的表态：这张表不增长。** 静态资源用 `app.get("/admin", h)` +
   * `app.get("/admin/*", h)` 注册（src/ui/serve.ts），产生的是两条 `GET` 条目，
   * 已列进上面的 `EXPECTED`、并逐格跑过矩阵。刻意不用 Hono 那个
   * `app.use("/admin/*", serveStatic(...))` 的惯用写法——那会产生一条 `ALL /admin/*`
   * 通配 handler，正是这张快照存在的理由。将来谁改回 use()，这条会立刻变红。
   *
   * **事件落盘那一轮的表态：这张表加一条。** `src/http/log-flush.ts` 的 `logFlush`
   * 中间件挂在 `app.use("*", ...)`（挂在 `configRefresh` 之后、其余中间件之前，
   * 见 `app.ts` 的注释），产生第三条 `ALL /*`。**这张快照红了正是它在起作用**——
   * 事件要能在响应返回前落盘，这条中间件必须真的挂上；别把它改绿了事。
   *
   * **Key 写那一轮的表态：这张表同样不增长。** 四条 Key 写端点用
   * `admin.post/delete/patch()` 注册，产生的是四条具名方法条目（已列进 `EXPECTED`、
   * 并逐格跑过矩阵）。**这一次的表态比前几次值钱**：写端点是第一次出现，而
   * `app.use("/admin/api/keys/*", handler)` 这种写法能造出一个**免鉴权的写端点**
   * ——鉴权 `use` 挂的是 `/admin/api/*`，顺序在它之前的任何 `use` 都跑在鉴权之前。
   *
   * **「立即补池」那一轮的表态：这张表同样不增长。** `POST /admin/api/registrar/tend`
   * 用 `admin.post()` 注册，产生的是一条具名方法条目（已列进 `EXPECTED`、并逐格跑过
   * 矩阵）。这一次的表态比 Key 写那次更值钱：一个免鉴权的「立即补池」不是泄露数据、
   * 也不是销毁数据，而是**让任何人都能远程消耗你在外部服务上的配额**。
   *
   * **协议与模型目录那一轮的表态：这张表同样不增长。** `GET /admin/api/models` 用
   * `admin.get()` 注册，产生的是一条具名方法条目（已列进 `EXPECTED`、并逐格跑过矩阵）。
   *
   * **用量那一轮的表态：这张表同样不增长。** 用量三条同样用 `admin.get()` 注册，
   * 产生的是三条具名方法条目（已列进 `EXPECTED`、并逐格跑过矩阵）。
   * ⚠️ **这里有一个真实的诱惑要点名**：`/admin/api/usage` 与 `/admin/api/usage/:date`
   * 是同一个前缀下的两条，写成 `admin.use("/admin/api/usage/*", handler)` 一条通配
   * 看上去更省事——而那正是这张快照存在的理由：`use()` 挂的通配 handler 会跑在
   * `/admin/api/*` 那行鉴权**之前**（顺序在它之前的话），造出一个**免鉴权的**用量端点。
   *
   * ⚠️ **`usageFlush` 中间件不在这张表里，这一条要说清楚免得下一个人以为漏了**：
   * `src/http/app.ts` 只在 `deps.usageSink !== undefined` 时才挂它，而**默认夹具
   * 关着 Tier-2** ⇒ 它在这张快照上不出现。那是刻意的（全局约束 16：「关」不是一个
   * `if`，是这条路径压根不存在），由 `tests/contract/usage-tier2.test.ts` 的
   * 「USAGE_STATS_ENABLED 不为 true 时：连打 50 次 /v1，usage: 前缀的 put 计数一次都不涨……」
   * 数着 put 计数守着，不由这张表守。
   */
  const EXPECTED_MIDDLEWARE = [
    "ALL /*",              // configRefresh
    "ALL /*",              // logFlush（事件落盘）
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

  /**
   * ── 注册位置：`app.routes` 的下标不变式 ────────────────────────────────────
   *
   * **判据只许从 `app.routes` 的下标算，禁止出现第二份手写路由名单。**
   * 顺手再写一张 `/admin/api/*` 路径清单的话，那张清单就是上面 `EXPECTED` 的第二份
   * 拷贝，加端点时两处要同步改，迟早分叉。
   *
   * 为什么不是「遍历全量端点打 HTTP 看非 404」：好几条端点对不存在的资源**合法地**
   * 回 404（`DELETE /admin/api/keys/:id`、`GET /admin/api/keys/:id/usage` —— 上面那张
   * `PROBE` 表 `:974` 里刻意用不存在的 id 正是这个原因），「非 404」不能当判据。
   *
   * ⚠️ **上一版这里把 `GET /admin/api/usage/:date` 举成 404 的例子，那是假话，
   * 阶段 D 回填时实测订正**：`src/http/admin/handlers/usage.ts` 的 `usageDateHandler`
   * 根本没有 404 这条路——日期解析不开是 **400**，解析得开但没数据/超出保留期是
   * **200 + `note`**。而且它与上面 `PROBE` 表 `:975-976` 自己写的
   * 「**必须用一个真的解析得开的 UTC 日期串**：占位串会在 handler 第一行就被 400 挡掉」
   * 正好说反。该文件里真的会 404 的是 `keyUsageHandler`（「没有这把 key」），
   * 也就是 `GET /admin/api/keys/:id/usage` 这条。
   *
   * 为什么下标算得准：实测 Hono 4.13.2 的 `app.routes` **保序**，下标与注册顺序
   * 逐条对应（本任务把整张表打印出来，与 `src/http/admin/router.ts` 里那串
   * `admin.get/post/put/delete/patch(...)` 逐行核对过，顺序一模一样）。
   *
   * 它与 `EXPECTED` / `EXPECTED_MIDDLEWARE` 是**互补不是重复**：那两张管「有没有」，
   * 这一格管「排第几」。**不许合并**——那两张都在比对前 `.sort()` 过，
   * 下标信息在那一步就已经没了。
   *
   * ⚠️ **它接不住的那一半，明写**：判据只看非 `ALL` 条目，而 `use()` 注册出来的
   * 通配 handler 一律是 `ALL`。一条挂在静态兜底之后的
   * `admin.use("/admin/api/x/*", handler)` 这一格看不见 —— 那个方向由上面
   * `EXPECTED_MIDDLEWARE` 那张快照接（它把全部 `ALL` 条目双向钉死）。
   * 两格合起来才是完整的，各自都不是。
   *
   * ⚠️ **filter 的前缀写的是 `" /admin/api"`，没有尾斜杠，这是订正过的**（阶段 D 回填）：
   * 上一版写成 `" /admin/api/"`，于是一条 `admin.get("/admin/api", …)`（无尾斜杠、
   * 形状完全合法）**整格不可见**——实测把它挂在静态兜底之后并补进 `EXPECTED`，
   * 本文件 69 格全绿。去掉尾斜杠之后干净树上的条目数一个都没变，
   * 覆盖面只增不减。**「它接不住的那一半」上一版只写了 `ALL` 那个方向，漏了这个。**
   *
   * ⚠️ **三条断言的次序与需求书给的相反，理由是实测出来的报文差异，不是口味**：
   * 需求书把「条目数 = 22」那格放在最前。需求书点名的那个失效形态是「在静态兜底
   * 之后**新注册**一条 `/admin/api/*`」，而那时计数格与位置格**会同时红**——计数格
   * 在前的话先失败的是它，而它的报文写着「有人加/删了端点没回来改这个数」，
   * 照着把 22 改成 23 就绿了一半，那条端点仍然恒 404，要再跑一遍才撞上真正的那一格。
   * 位置格在前则第一眼就是「有 /admin/api/* 端点注册在静态兜底之后」并点名是哪一条。
   * **两种次序的鉴别力完全相同**（filter 写坏时仍然只有计数格会红，本任务变异
   * 两种次序各跑过一遍），差的只是运维/评审读到的那句话。
   */
  it("每一条 /admin/api/* 都注册在 adminAuth 之后、静态兜底之前 —— 位置写错了它会恒 404 而没人拦", async () => {
    const { app } = await makeApp([], [], {}, () => 1_000);
    const routes = app.routes;
    const authIdx = routes.findIndex((r) => r.method === "ALL" && r.path === "/admin/api/*");
    const staticIdx = routes.findIndex((r) => r.method === "GET" && r.path === "/admin/*");
    expect(authIdx, "找不到 adminAuth 中间件").toBeGreaterThanOrEqual(0);
    expect(staticIdx, "找不到静态兜底").toBeGreaterThanOrEqual(0);

    const apis = routes
      .map((r, i) => ({ i, label: `${r.method} ${r.path}` }))
      .filter((r) => r.label.includes(" /admin/api") && !r.label.startsWith("ALL "));

    expect(apis.filter((r) => r.i > staticIdx).map((r) => r.label),
      "有 /admin/api/* 端点注册在静态兜底之后 —— 它恒 404").toEqual([]);
    expect(apis.filter((r) => r.i < authIdx).map((r) => r.label),
      "tooEarly：这些端点排在 adminAuth 之前 —— 它们免鉴权").toEqual([]);

    // 反向控制：filter 写坏后上面那两格会恒绿（空数组 `toEqual([])` 恒真）。
    //
    // ⚠️ **手写字面量等号，不许写成 `toBeGreaterThanOrEqual`**（回填，评审「可执行性」）：
    // 第一版写的是 `toBeGreaterThanOrEqual(20)` 而今天实测正好 **22** 条
    // ⇒ **静默丢掉 2 条路由这一格仍然绿**，而这一格存在的全部理由就是「filter 写坏后会恒绿」，
    // 留 2 条余量把它自己削掉了一半。这正是本计划 §通用纪律「禁止的断言形态」里逐字点名的那一条
    // （`tests/unit/docs-parity.test.ts「第一版在这里又踩了一次同类的坑」` 那段记着它为什么不行）。
    // ⚠️ **危险区那两条端点已经新增了，所以这个数从 22 改成了 24。
    // 改数字不是削弱，是它在按设计工作。**
    // 它排在上面两格之后的理由见本格上方的 docblock 最后一段。
    //
    // ⚠️⚠️ **报文里那句「先确认没被前面更宽的模式吃掉」不是客套话，它是一条实测出来的
    // 死路的出口**（阶段 D 回填时实测的那条变异）：在 `src/http/admin/router.ts` 的
    // `usage/:date` **之后**追加 `admin.get("/admin/api/usage/summary", …)`（往一节末尾
    // 追加是最自然的写法），照本格的两条报文补 `EXPECTED`、把 22 改成 23
    // ⇒ **本文件当时 69 格全绿**，而那条端点恒回 400
    //（`date 必须是 UTC 的 YYYY-MM-DD，收到的是：summary`）。三层同时瞎：位置格看的是
    // 「相对 adminAuth / 静态兜底」，窗口**内部**它无话可说；本格只说「改这个数」；
    // 鉴权矩阵逐字写着「400 之类不在本矩阵的断言范围内」。
    // ⇒ 下面新增的那一格（窗口内更宽的模式不许排在更窄的之前）才是真正接住它的网，
    // 本格的报文只**把人指过去**。
    //（⚠️ 原文这里多两个字，用的是**归属式**那个动词——后来把那一族补进了
    // `scripts/check-comment-refs.mjs` 的注释断言词表。而**命中是按整段算的**：
    // 那两个字说的是报文，却会连坐同一段里上面那条指向 `tests/unit/docs-parity.test.ts`
    // 的**纯描述性**引用——它指的是那份测试文件头里的一段说明、不是一条用例，
    // 被收紧之后就成了假红。删掉那两个字，比给一条描述性引用硬安一个用例锚诚实；
    // 理由与那道门禁 `CLAIM_MARKERS` 上方那段「按整段连坐」逐字同源。
    // 这段说明自己刻意不复写那个动词，写下去这一段会当场把自己打红。）
    expect(apis.length,
      "扫到的 /admin/api/* 条目数不对。**先确认新端点没有被前面更宽的模式吃掉**"
      + "（下面那格「窗口内更宽的模式不许排在更窄的之前」会逐条点名），"
      + "再改这个数：filter 写坏了、或者有人加/删了端点没回来改它，都会落到这一句上",
    ).toBe(24);
  });

  /**
   * ── 窗口**内部**的相对顺序：更宽的模式不许排在更窄的之前 ──────────────────────
   *
   * **防住的真实故障（实测，不是推的）**：往 `src/http/admin/router.ts` 某一节的末尾
   * 追加一条形状完全合法的新端点，而那一节前面已经有一条更宽的单段通配把它盖住。
   * Hono 按注册顺序匹配，于是新端点**永远轮不到**——请求落在前面那条 handler 上，
   * 表现是一个**看起来合理的 400/200**，不是 404，没有任何一层会说「你放错位置了」。
   *
   * **上面那一格接不住这个方向**：它的两个锚点是 `adminAuth` 与静态兜底，
   * 判的是「有没有落在窗口外」；窗口内部谁先谁后，它一个字都没说。
   * 鉴权矩阵也接不住：它只断言「不该被判 401」，被吃掉之后拿到的 400 **照过**
   *（那句边界就写在矩阵那一格的循环里，是有意的，不是漏）。
   *
   * **判据同样只从 `app.routes` 派生，不写第二份路由清单**：
   * 对每一条端点，把它的 `:param` 段换成一个不会与任何字面段相等的探针串，得到一条
   * 「只有它自己该匹配」的具体路径；再看**排在它前面**的同方法端点里有没有谁的模式
   * 也能匹配这条路径。有 ⇒ 后者恒不可达。加端点、删端点、改路径都自动跟得上。
   *
   * ⚠️ **它接不住的那一半，明写**：
   * · 只比**同一个方法**的两条。Hono 先按方法分流，`GET` 不会吃掉 `POST`。
   * · 只看 `/admin/api` 这一族（与上面那格同一个 filter）；网关侧 `/v1/*` 不在射程。
   * · 只认 `:param` 与 `*` 这两种通配。Hono 还支持正则参数（`:id{[0-9]+}`）与可选段，
   *   本仓今天一条都没有——真加了，探针串可能凑巧匹配得上而这一格静静放行。
   * · 它说的是「**不可达**」，不是「顺序不合理」。两条都能被打到、只是优先级不同的
   *   情形（例如同一条路径注册两次）不在这里判。
   */
  it("窗口内更宽的模式不许排在更窄的之前 —— 被吃掉的那一条恒不可达，而它只会回一个看起来合理的 400", async () => {
    const { app } = await makeApp([], [], {}, () => 1_000);
    const apis = app.routes
      .map((r, i) => ({ i, method: r.method, path: r.path, label: `${r.method} ${r.path}` }))
      .filter((r) => r.label.includes(" /admin/api") && !r.label.startsWith("ALL "));

    // 探针串：一个**不可能**与任何字面段相等的段。用它替换 `:param`，得到的路径
    // 「除了这条端点自己，谁都不该匹配」——除非前面真有一条更宽的通配。
    const PROBE_SEG = "__wider_probe__";
    const concrete = (path: string) =>
      path.split("/").map((s) => (s.startsWith(":") || s === "*" ? PROBE_SEG : s)).join("/");
    /** 把注册模式编译成正则：`:param` / `*` 各吃一段，其余按字面。 */
    const matcher = (path: string) => new RegExp(
      "^" + path.split("/")
        .map((s) => (s.startsWith(":") || s === "*" ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("/") + "$",
    );

    const shadowed = apis.flatMap((later, n) =>
      apis.slice(0, n)
        .filter((earlier) => earlier.method === later.method
          && earlier.path !== later.path
          && matcher(earlier.path).test(concrete(later.path)))
        .map((earlier) => `${later.label} 被前面的 ${earlier.label} 吃掉`));

    expect(shadowed,
      "这些端点排在一条更宽的模式之后，Hono 永远轮不到它们 —— 现场表现是"
      + "「拿对口令、返回一个看起来合理的 400/200」，不是 404，四条现有的护栏一格都不会红。"
      + "出路：把更窄的那条挪到更宽的那条**之前**（`src/http/admin/router.ts` 里"
      + "`bulk` vs `:id`、`channels/:c/test` vs `tend` 都是照这个规矩排的）",
    ).toEqual([]);

    // 自检：探针本身必须真的在干活。窗口里今天就有带 `:param` 的端点，
    // 少了这一行，`concrete()` 哪天退化成恒等函数、上面那格会静静恒绿。
    expect(apis.filter((r) => r.path.includes("/:")).length,
      "窗口里一条带 :param 的端点都没有了 —— 上面那格已经无事可做，回来重新看它").toBeGreaterThan(0);
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
   * ── 写端点比读端点多一维 ────────────────────────────────────────────────
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
      [], ["sk-side-effect-probe-key"], {}, () => 1000,
      // **配置接线必须给**（危险区那两条）：不给的话 `POST /admin/api/config/reset`
      // 在带对口令时是 `503 not_wired`，下面那条「它真的会写」的反向自检就成了空转
      // ——而「零副作用」的四个 0 全靠反向自检才有意义。
      { storage: st, config: { storage: st, env: {}, adminToken: TEST_ADMIN_TOKEN } },
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
      // ── 危险区那两条 ─────────────────────────────────────────────────────────
      // **两条的请求体都是「鉴权若不存在就一定会成功」的那一份**，与上面四条同一条
      // 判据：`confirm: true` / `expect: 1`（此刻池里恰好一把）都带齐了 ⇒ 鉴权失效
      // 时它们会真的清掉整份配置、真的删掉整池。它们各自的反向自检在本格末尾。
      { name: "POST 重置配置", path: "/admin/api/config/reset", method: "POST", body: { confirm: true } },
      { name: "POST 清空 Key 池", path: "/admin/api/keys/purge", method: "POST", body: { expect: 1 } },
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

    // ── 危险区那两条的反向自检 ───────────────────────────────────────────────────
    // **顺序是有讲究的**：上面那次 DELETE 已经把池子清空了，所以清空 Key 池这一条
    // 必须先补一把 key 回去，否则 `expect: 0` 打过去也是 200 而一次 delete 都不发
    // ——那样它就成了一个「永远绿」的自检，正是本仓反复裁过的形态。
    const putsBeforeReset = st.puts;
    const reset = await app.request("/admin/api/config/reset", {
      method: "POST",
      headers: { "x-admin-key": TEST_ADMIN_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(reset.status, "夹具本身重置不了 ⇒ 上面那条「零副作用」是空的").toBe(200);
    expect(st.puts, "带对口令的那次重置也没写存储").toBeGreaterThan(putsBeforeReset);

    await repo.add("sk-purge-reverse-control-key");
    const deletesBeforePurge = st.deletes;
    const purge = await app.request("/admin/api/keys/purge", {
      method: "POST",
      headers: { "x-admin-key": TEST_ADMIN_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ expect: 1 }),
    });
    expect(purge.status, "夹具本身清不掉 ⇒ 上面那条「零副作用」是空的").toBe(200);
    expect(st.deletes, "带对口令的那次清空也没碰存储").toBeGreaterThan(deletesBeforePurge);
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
