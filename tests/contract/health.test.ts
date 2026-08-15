import { describe, it, expect } from "vitest";
import { createApp } from "../../src/http/app.js";

describe("GET /health", () => {
  it("返回 200 与版本号，且不需要鉴权", async () => {
    const app = createApp({ version: "0.1.0" });
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "0.1.0" });
  });
});
