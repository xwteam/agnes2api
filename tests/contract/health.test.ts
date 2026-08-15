import { describe, it, expect } from "vitest";
import { makeApp } from "../helpers/make-app.js";

describe("GET /health", () => {
  it("返回 200 与版本号，且不需要鉴权", async () => {
    const { app } = await makeApp([]);
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok", version: "0.1.0", storage: { writable: true },
    });
  });

  it("/health 不受鉴权影响", async () => {
    const { app } = await makeApp([]);
    expect((await app.request("/health")).status).toBe(200);
  });

  // ── C-RM1：存储写不进去的容器不许再报 healthy ───────────────────────────────
  //
  // 真机实测：绑定挂载的宿主 data 目录属主是 uid 1000，容器内运行用户是 uid 100，
  // 于是 store.json 写入 EACCES；但 /health 压根不碰存储，容器一路 healthy，
  // 而每一次 API 调用都返回 pool_empty。健康检查必须能反映这件事。
  it("存储不可写时报 degraded 且 HTTP 503（HEALTHCHECK 据此判定 unhealthy）", async () => {
    const { app, storageHealth } = await makeApp([]);
    storageHealth.record(false, 1000);

    const res = await app.request("/health");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; storage: { writable: boolean } };
    expect(body.status).toBe("degraded");
    expect(body.storage.writable).toBe(false);
  });

  it("degraded 的响应体不回显底层异常与内部路径（/health 不鉴权）", async () => {
    const { app, storageHealth } = await makeApp([]);
    storageHealth.record(false, 1000);

    const text = await (await app.request("/health")).text();
    expect(text).not.toContain("EACCES");
    expect(text).not.toContain("/app/data");
  });

  it("存储恢复可写后 /health 自动转回 200", async () => {
    const { app, storageHealth } = await makeApp([]);
    storageHealth.record(false, 1000);
    expect((await app.request("/health")).status).toBe(503);

    storageHealth.record(true, 2000);
    expect((await app.request("/health")).status).toBe(200);
  });
});
