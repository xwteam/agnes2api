import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/http/wire.js";
import { MemoryStorage } from "../helpers/fake-storage.js";

describe("buildApp", () => {
  it("从环境变量与存储装配出可用的 app", async () => {
    const app = await buildApp({ GATEWAY_TOKEN: "t" }, new MemoryStorage());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("缺少 GATEWAY_TOKEN 时装配失败并给出明确错误", async () => {
    await expect(buildApp({}, new MemoryStorage())).rejects.toThrow(/GATEWAY_TOKEN/);
  });
});
