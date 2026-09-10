import { describe, it, expect } from "vitest";
import { sendCode, register, login, createKey, randomPassword } from "../../../src/core/registrar/agnes.js";

const PLATFORM = "https://platform.test";

function recordingFetcher(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  return {
    calls,
    fetcher: {
      async fetch(url: string, init: RequestInit) {
        calls.push({ url, init });
        const r = responses[i++] ?? { status: 200, body: {} };
        return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
      },
    },
  };
}

describe("sendCode", () => {
  it("对邮箱做 URL 编码并带上 purpose=register", async () => {
    const { calls, fetcher } = recordingFetcher([{ status: 200 }]);
    const r = await sendCode({ fetcher, platformUrl: PLATFORM }, "a+b@x.test");
    expect(r.status).toBe(200);
    expect(calls[0]!.url).toBe(`${PLATFORM}/api/verification?email=a%2Bb%40x.test&purpose=register`);
  });

  /**
   * ⚠️ **这一格原来叫「原样返回状态码，不抛错（400 表示域名被屏蔽，调用方要据此换域名）」，
   * 括号里那句话只对了一半。** 上游用 `400` 同时表达「这个域名被屏蔽了」与「你这个出口
   * 发得太频繁了」，而**正文是唯一的区分线索**。把正文丢掉，代码层面就永远分不开这两件事
   * —— 一次出口级限流会被读成「这些域名被屏蔽了」，然后照着「换个域名就好」继续打。
   * 分辨在 `src/core/registrar/domain-ledger.ts` 的 `classifySendCode`，**而且是启发式**。
   */
  it("原样返回状态码**与正文**，不抛错 —— 正文是分辨两种 400 的唯一线索", async () => {
    const { fetcher } = recordingFetcher([{ status: 400, body: { code: 400, message: "nope" } }]);
    const r = await sendCode({ fetcher, platformUrl: PLATFORM }, "a@x.test");
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ code: 400, message: "nope" });
  });

  it("正文读不出来时按空正文处理，不让它把一次已经拿到状态码的请求变成异常", async () => {
    const fetcher = {
      async fetch(): Promise<Response> {
        // 状态码拿到了，读正文时连接断了 —— 与本文件 login/createKey 对非 JSON 正文的
        // 处置同一条：不抛，交给调用方去分类。
        return {
          status: 429,
          ok: false,
          async text(): Promise<string> { throw new Error("aborted"); },
        } as unknown as Response;
      },
    };
    const r = await sendCode({ fetcher, platformUrl: PLATFORM }, "a@x.test");
    expect(r).toEqual({ status: 429, body: "" });
  });
});

describe("register", () => {
  it("password_confirm 与 password 相同", async () => {
    const { calls, fetcher } = recordingFetcher([{ status: 200 }]);
    const r = await register({ fetcher, platformUrl: PLATFORM }, "a@x.test", "pw", "123456");
    expect(r.ok).toBe(true);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      email: "a@x.test", password: "pw", password_confirm: "pw", code: "123456",
    });
  });

  it("非 2xx 时 ok 为 false", async () => {
    const { fetcher } = recordingFetcher([{ status: 422 }]);
    expect((await register({ fetcher, platformUrl: PLATFORM }, "a@x.test", "pw", "000000")).ok).toBe(false);
  });
});

describe("login", () => {
  it("用 username 字段传邮箱，从 data.access_token 取令牌", async () => {
    const { calls, fetcher } = recordingFetcher([{ status: 200, body: { data: { access_token: "tok-1" } } }]);
    const r = await login({ fetcher, platformUrl: PLATFORM }, "a@x.test", "pw");
    expect(r.token).toBe("tok-1");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ username: "a@x.test", password: "pw" });
  });

  it("兼容 data.token / 顶层 access_token / 顶层 token 四种位置", async () => {
    for (const body of [
      { data: { token: "t" } }, { access_token: "t" }, { token: "t" },
    ]) {
      const { fetcher } = recordingFetcher([{ status: 200, body }]);
      expect((await login({ fetcher, platformUrl: PLATFORM }, "a@x.test", "pw")).token).toBe("t");
    }
  });

  it("取不到令牌时 token 为 null 而不是抛错", async () => {
    const { fetcher } = recordingFetcher([{ status: 200, body: { data: {} } }]);
    expect((await login({ fetcher, platformUrl: PLATFORM }, "a@x.test", "pw")).token).toBeNull();
  });

  it("响应体不是合法 JSON 时 token 为 null 而不是抛错（网关超时/维护页等可能以 200 返回非 JSON 正文）", async () => {
    const fetcher = {
      async fetch() {
        return new Response("<html>maintenance</html>", { status: 200 });
      },
    };
    const r = await login({ fetcher, platformUrl: PLATFORM }, "a@x.test", "pw");
    expect(r.token).toBeNull();
    // 正文照样交出来：`mint.ts` 在这一档要靠它说清「上游回的是一张维护页」。
    expect(r.body).toBe("<html>maintenance</html>");
  });
});

describe("createKey", () => {
  it("带 Bearer 令牌，从 data.key 取 key", async () => {
    const { calls, fetcher } = recordingFetcher([{ status: 200, body: { data: { key: "sk-x" } } }]);
    const r = await createKey({ fetcher, platformUrl: PLATFORM }, "tok-1", "auto");
    expect(r.key).toBe("sk-x");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer tok-1");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ name: "auto" });
  });

  it("非 2xx 时 key 为 null", async () => {
    const { fetcher } = recordingFetcher([{ status: 401 }]);
    expect((await createKey({ fetcher, platformUrl: PLATFORM }, "bad", "auto")).key).toBeNull();
  });

  it("响应体不是合法 JSON 时 key 为 null 而不是抛错（网关超时/维护页等可能以 200 返回非 JSON 正文）", async () => {
    const fetcher = {
      async fetch() {
        return new Response("<html>maintenance</html>", { status: 200 });
      },
    };
    const r = await createKey({ fetcher, platformUrl: PLATFORM }, "tok-1", "auto");
    expect(r.key).toBeNull();
    expect(r.body).toBe("<html>maintenance</html>");
  });
});

/**
 * 🔴 **承重格：注册链后三步必须把上游的状态码与正文交回给调用方。**
 *
 * 这一族此前是 `boolean` / `string | null` / `string | null` —— 状态码与正文在函数
 * 边界就被丢光了，`src/core/registrar/mint.ts` 因此只写得出「Agnes 注册被拒」这一句
 * 空话，而四种真因（注册这一步把域名拉黑了 / 验证码过期 / 上游改了字段名 / 这个出口的
 * 注册额度到顶）处置完全不同。`src/core/registrar/fetch.ts` 只包装**传输层**异常，
 * 非 2xx 压根不走它，所以别处补不回来 —— 只能在这里交出来。
 *
 * **断言的是「那两样真的能被读回来」，不是「函数返回了个对象」**：
 * 状态码逐值相等、正文逐字节相等。
 *
 * 变异实测（2026-09-10，逐条做过）：
 * · 把 `register` 的 `return` 改回 `r.ok`（并把返回类型改回 `boolean`）
 *   ⇒ 本格「注册」那三条断言里 `status` / `body` 两条红（`r.status` 是 undefined）；
 * · 把 `login` 的 `fail` 改回裸 `null`
 *   ⇒ 本格「登录」那一段在读 `.status` 时红；
 * · 把 `createKey` 的 `fail` 改回裸 `null` ⇒ 同上，在「建 key」那一段红。
 */
describe("注册链后三步把上游的状态码与正文原样交回调用方", () => {
  it("注册：非 2xx 的状态码与正文都读得回来", async () => {
    const { fetcher } = recordingFetcher([{ status: 429, body: { message: "too many registrations" } }]);
    const r = await register({ fetcher, platformUrl: PLATFORM }, "a@x.test", "pw", "123456");
    expect(r.ok).toBe(false);
    expect(r.status, "状态码丢了 ⇒ 面板上「注册被拒」与「这个出口被限流」长同一个样").toBe(429);
    expect(JSON.parse(r.body)).toEqual({ message: "too many registrations" });
  });

  it("登录：2xx 但字段改了名时，状态码是 200 且正文原样交出（归因靠的就是这两样）", async () => {
    const { fetcher } = recordingFetcher([{ status: 200, body: { data: { token_id: "eyJhbGciOi" } } }]);
    const r = await login({ fetcher, platformUrl: PLATFORM }, "a@x.test", "pw");
    expect(r.token).toBeNull();
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ data: { token_id: "eyJhbGciOi" } });
  });

  it("建 key：401 的状态码与正文都读得回来", async () => {
    const { fetcher } = recordingFetcher([{ status: 401, body: { message: "token expired" } }]);
    const r = await createKey({ fetcher, platformUrl: PLATFORM }, "tok-1", "auto");
    expect(r.key).toBeNull();
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)).toEqual({ message: "token expired" });
  });

  it("正文读不出来（连接中途断了）时按空正文处理，状态码照样交出，不抛错", async () => {
    const fetcher = {
      async fetch(): Promise<Response> {
        return {
          status: 500, ok: false,
          async text(): Promise<string> { throw new Error("aborted"); },
        } as unknown as Response;
      },
    };
    const r = await register({ fetcher, platformUrl: PLATFORM }, "a@x.test", "pw", "1");
    expect(r).toEqual({ ok: false, status: 500, body: "" });
  });
});

describe("单请求超时", () => {
  it("注册链四步的每个请求都带 AbortSignal：一个挂起的连接不该拖垮整轮补池", async () => {
    // 没有它，所有耗时预算（CODE_TIMEOUT_MS、Worker Cron 的 15 分钟墙钟）都建立在
    // "每个请求都会及时返回"这个未言明的前提上；一次挂起就能把单轮推过墙钟，
    // 正在铸的那个邮箱的清理（mintOne 的 finally）也就永远不会执行。
    const { calls, fetcher } = recordingFetcher([
      { status: 200 },
      { status: 200 },
      { status: 200, body: { data: { access_token: "tok" } } },
      { status: 200, body: { data: { key: "sk-1" } } },
    ]);
    const deps = { fetcher, platformUrl: PLATFORM };
    await sendCode(deps, "a@x.test");
    await register(deps, "a@x.test", "pw", "123456");
    await login(deps, "a@x.test", "pw");
    await createKey(deps, "tok", "auto");
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
      expect(c.init.signal!.aborted).toBe(false);
    }
  });
});

describe("randomPassword", () => {
  it("长度固定且注入的随机源决定结果（可复现）", () => {
    const a = randomPassword(() => 0.5);
    const b = randomPassword(() => 0.5);
    expect(a).toBe(b);
    expect(a.length).toBe(16);
  });

  it("不同随机源产出不同密码", () => {
    expect(randomPassword(() => 0.1)).not.toBe(randomPassword(() => 0.9));
  });
});
