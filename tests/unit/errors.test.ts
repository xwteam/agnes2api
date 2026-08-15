import { describe, it, expect } from "vitest";
import { classifyStatus, classifyThrown } from "../../src/core/errors.js";

const CFG = { cooldownRateLimitMs: 60_000, cooldownPaymentMs: 3_600_000 };

describe("classifyStatus", () => {
  it("2xx 判为成功", () => {
    expect(classifyStatus(200, CFG)).toEqual({ kind: "success" });
    expect(classifyStatus(204, CFG)).toEqual({ kind: "success" });
  });

  it("429 冷却 60 秒", () => {
    expect(classifyStatus(429, CFG)).toEqual({ kind: "cooldown", ms: 60_000, reason: "rate limited" });
  });

  it("402 冷却 1 小时", () => {
    expect(classifyStatus(402, CFG)).toEqual({ kind: "cooldown", ms: 3_600_000, reason: "payment required" });
  });

  it("401 永久剔除", () => {
    expect(classifyStatus(401, CFG)).toEqual({ kind: "evict", reason: "upstream 401" });
  });

  it("403 永久剔除", () => {
    expect(classifyStatus(403, CFG)).toEqual({ kind: "evict", reason: "upstream 403" });
  });

  it("5xx 记 strike", () => {
    expect(classifyStatus(500, CFG)).toEqual({ kind: "strike", reason: "upstream 500" });
    expect(classifyStatus(503, CFG)).toEqual({ kind: "strike", reason: "upstream 503" });
  });

  it("其他 4xx 原样透传", () => {
    expect(classifyStatus(400, CFG)).toEqual({ kind: "passthrough" });
    expect(classifyStatus(404, CFG)).toEqual({ kind: "passthrough" });
    expect(classifyStatus(422, CFG)).toEqual({ kind: "passthrough" });
  });
});

describe("classifyThrown", () => {
  it("AbortError 判为超时并记 strike", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(classifyThrown(e)).toEqual({ kind: "strike", reason: "timeout" });
  });

  it("其他异常判为网络错误并记 strike", () => {
    expect(classifyThrown(new TypeError("fetch failed"))).toEqual({ kind: "strike", reason: "network error" });
  });
});
