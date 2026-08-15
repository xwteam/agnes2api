import { describe, it, expect } from "vitest";
import { makeApp } from "../helpers/make-app.js";

describe("GET /health", () => {
  it("返回 200 与版本号，且不需要鉴权", async () => {
    const { app } = await makeApp([]);
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "0.1.0" });
  });

  it("/health 不受鉴权影响", async () => {
    const { app } = await makeApp([]);
    expect((await app.request("/health")).status).toBe(200);
  });
});
