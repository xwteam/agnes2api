import { describe, it, expect } from "vitest";
import { createApp } from "../../src/http/app.js";
import { createConfigHolder, CONFIG_TTL_MS } from "../../src/http/config-holder.js";
import { KeyPoolRepo } from "../../src/core/keypool-repo.js";
import { createStorageHealth } from "../../src/core/storage-health.js";
import { MemoryStorage } from "../helpers/fake-storage.js";
import { FakeFetcher } from "../helpers/fake-fetcher.js";
import { NULL_LOGGER } from "../../src/ports/logger.js";

describe("网关口令能被撤销（没设 GATEWAY_TOKEN 环境变量的部署）", () => {
  it("改存储里的 gatewayToken，跨一个 TTL 之后旧口令 401、新口令 200", async () => {
    let t = 0;
    const now = () => t;
    const s = new MemoryStorage();
    await s.put("config", { gatewayToken: "old-token-aaaa" });
    const repo = new KeyPoolRepo(s, { now, logger: NULL_LOGGER });
    const configHolder = await createConfigHolder({ env: {}, storage: s, logger: NULL_LOGGER, now });
    const app = createApp({
      version: "0.1.0", configHolder, repo,
      fetcher: new FakeFetcher([]), now, storageHealth: createStorageHealth(), logger: NULL_LOGGER,
    });

    const call = (token: string) =>
      app.request("/v1/models", { headers: { authorization: `Bearer ${token}` } });

    expect((await call("old-token-aaaa")).status).toBe(200);

    await s.put("config", { gatewayToken: "new-token-bbbb" });
    // TTL 内：旧口令仍然有效，这是被承诺的上界，不是缺陷。
    expect((await call("old-token-aaaa")).status).toBe(200);

    t += CONFIG_TTL_MS;
    // **两条断言都要有**：只断言「新口令能用」的话，把 auth 改成放行一切也会绿。
    expect((await call("old-token-aaaa")).status, "旧口令必须失效").toBe(401);
    expect((await call("new-token-bbbb")).status, "新口令必须可用").toBe(200);
  });
});

// dispatch() 内部读取的配置也必须是最新的，不止 auth 中间件那一条路径。
// `/v1/models` 那条契约用例走的是 auth 中间件里直接持有的 `configHolder.current()`
// 闭包，完全不经过 `dispatchDeps()` 那个 getter；`dispatchDeps` 的 getter 若被改回
// 「建 app 时求值一次」，`/v1/models` 那条契约用例照样全绿——必须换一条真的会走
// `dispatch()` 的路由，才能钉住那个缺陷（config 在建 app 那一刻被闭包捕获冻结）不复发。
describe("dispatch() 内部读到的配置同样能被撤销（不止 gatewayToken）", () => {
  it("改存储里的 agnesBaseUrl，跨一个 TTL 之后新请求打到新地址", async () => {
    let t = 0;
    const now = () => t;
    const s = new MemoryStorage();
    await s.put("config", { gatewayToken: "t", agnesBaseUrl: "https://old.test/v1" });
    const repo = new KeyPoolRepo(s, { now, logger: NULL_LOGGER });
    await repo.add("k1");
    const configHolder = await createConfigHolder({ env: {}, storage: s, logger: NULL_LOGGER, now });
    const fetcher = new FakeFetcher([{ status: 200, body: "{}" }, { status: 200, body: "{}" }]);
    const app = createApp({
      version: "0.1.0", configHolder, repo,
      fetcher, now, storageHealth: createStorageHealth(), logger: NULL_LOGGER,
    });

    const send = () => app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });

    await send();
    expect(fetcher.sentUrls[0]).toContain("old.test");

    await s.put("config", { gatewayToken: "t", agnesBaseUrl: "https://new.test/v1" });
    t += CONFIG_TTL_MS;
    await send();
    // 只断言「新地址被用过」不够——若 dispatchDeps 把 config 求值一次冻结在旧值，
    // 两次请求会都打到 old.test，这条断言必须明确要求第二次是 new.test。
    expect(fetcher.sentUrls[1], "第二次请求必须用新配置").toContain("new.test");
  });
});
