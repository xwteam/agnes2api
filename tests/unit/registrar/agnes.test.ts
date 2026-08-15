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
    const status = await sendCode({ fetcher, platformUrl: PLATFORM }, "a+b@x.test");
    expect(status).toBe(200);
    expect(calls[0]!.url).toBe(`${PLATFORM}/api/verification?email=a%2Bb%40x.test&purpose=register`);
  });

  it("原样返回状态码，不抛错（400 表示域名被屏蔽，调用方要据此换域名）", async () => {
    const { fetcher } = recordingFetcher([{ status: 400 }]);
    expect(await sendCode({ fetcher, platformUrl: PLATFORM }, "a@x.test")).toBe(400);
  });
});

describe("register", () => {
  it("password_confirm 与 password 相同", async () => {
    const { calls, fetcher } = recordingFetcher([{ status: 200 }]);
    const ok = await register({ fetcher, platformUrl: PLATFORM }, "a@x.test", "pw", "123456");
    expect(ok).toBe(true);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      email: "a@x.test", password: "pw", password_confirm: "pw", code: "123456",
    });
  });

  it("非 2xx 返回 false", async () => {
    const { fetcher } = recordingFetcher([{ status: 422 }]);
    expect(await register({ fetcher, platformUrl: PLATFORM }, "a@x.test", "pw", "000000")).toBe(false);
  });
});

describe("login", () => {
  it("用 username 字段传邮箱，从 data.access_token 取令牌", async () => {
    const { calls, fetcher } = recordingFetcher([{ status: 200, body: { data: { access_token: "tok-1" } } }]);
    const t = await login({ fetcher, platformUrl: PLATFORM }, "a@x.test", "pw");
    expect(t).toBe("tok-1");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ username: "a@x.test", password: "pw" });
  });

  it("兼容 data.token / 顶层 access_token / 顶层 token 四种位置", async () => {
    for (const body of [
      { data: { token: "t" } }, { access_token: "t" }, { token: "t" },
    ]) {
      const { fetcher } = recordingFetcher([{ status: 200, body }]);
      expect(await login({ fetcher, platformUrl: PLATFORM }, "a@x.test", "pw")).toBe("t");
    }
  });

  it("取不到令牌时返回 null 而不是抛错", async () => {
    const { fetcher } = recordingFetcher([{ status: 200, body: { data: {} } }]);
    expect(await login({ fetcher, platformUrl: PLATFORM }, "a@x.test", "pw")).toBeNull();
  });

  it("响应体不是合法 JSON 时返回 null 而不是抛错（网关超时/维护页等可能以 200 返回非 JSON 正文）", async () => {
    const fetcher = {
      async fetch() {
        return new Response("<html>maintenance</html>", { status: 200 });
      },
    };
    await expect(login({ fetcher, platformUrl: PLATFORM }, "a@x.test", "pw")).resolves.toBeNull();
  });
});

describe("createKey", () => {
  it("带 Bearer 令牌，从 data.key 取 key", async () => {
    const { calls, fetcher } = recordingFetcher([{ status: 200, body: { data: { key: "sk-x" } } }]);
    const k = await createKey({ fetcher, platformUrl: PLATFORM }, "tok-1", "auto");
    expect(k).toBe("sk-x");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer tok-1");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ name: "auto" });
  });

  it("非 2xx 返回 null", async () => {
    const { fetcher } = recordingFetcher([{ status: 401 }]);
    expect(await createKey({ fetcher, platformUrl: PLATFORM }, "bad", "auto")).toBeNull();
  });

  it("响应体不是合法 JSON 时返回 null 而不是抛错（网关超时/维护页等可能以 200 返回非 JSON 正文）", async () => {
    const fetcher = {
      async fetch() {
        return new Response("<html>maintenance</html>", { status: 200 });
      },
    };
    await expect(createKey({ fetcher, platformUrl: PLATFORM }, "tok-1", "auto")).resolves.toBeNull();
  });
});

describe("单请求超时（I2）", () => {
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
