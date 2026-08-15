import { describe, it, expect } from "vitest";
import worker, { type Env } from "../../src/entry/worker.js";

/**
 * 最小可用的 KVNamespace 假实现，专用于本文件：只实现 worker 入口路径
 * 会用到的 get/put/delete/list，并记录 get 调用次数——用它作为
 * “app 是否被重建”的可观测代理：buildApp -> loadConfig 每次都会
 * 恰好读一次 "config" 键，所以 get 调用次数 == app 被构建的次数。
 */
function fakeKv(): { kv: Env["POOL"]; getCalls: () => number } {
  const store = new Map<string, string>();
  let calls = 0;
  const kv = {
    async get(key: string) {
      calls++;
      const raw = store.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [], list_complete: true, cacheStatus: null };
    },
  };
  return { kv: kv as unknown as Env["POOL"], getCalls: () => calls };
}

describe("worker 入口: fail-closed", () => {
  it("缺少 GATEWAY_TOKEN 时拒绝服务（不是 200）", async () => {
    const { kv } = fakeKv();
    const req = new Request("http://localhost/health");
    const res = await worker.fetch(req, { POOL: kv } as Env);
    expect(res.status).not.toBe(200);
  });

  it("缺少 GATEWAY_TOKEN 时，带空 x-api-key 的受保护请求也不会被放行", async () => {
    const { kv } = fakeKv();
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "x-api-key": "", "content-type": "application/json" },
      body: "{}",
    });
    const res = await worker.fetch(req, { POOL: kv } as Env);
    expect(res.status).not.toBe(200);
  });
});

describe("worker 入口: app 按 token 缓存", () => {
  it("同一 token 连续两次请求，不重建 app（存储只被访问一次）", async () => {
    const { kv, getCalls } = fakeKv();
    const token = `same-${crypto.randomUUID()}`;
    const env = { GATEWAY_TOKEN: token, POOL: kv } as Env;

    await worker.fetch(new Request("http://localhost/health"), env);
    await worker.fetch(new Request("http://localhost/health"), env);

    expect(getCalls()).toBe(1);
  });

  it("token 变化时重建 app（存储被重新访问）", async () => {
    const { kv, getCalls } = fakeKv();
    const t1 = `t1-${crypto.randomUUID()}`;
    const t2 = `t2-${crypto.randomUUID()}`;

    await worker.fetch(new Request("http://localhost/health"), { GATEWAY_TOKEN: t1, POOL: kv } as Env);
    await worker.fetch(new Request("http://localhost/health"), { GATEWAY_TOKEN: t2, POOL: kv } as Env);

    expect(getCalls()).toBe(2);
  });
});
