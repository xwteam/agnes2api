import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { VERSION } from "../../src/version.js";

describe("版本号一致性", () => {
  it("VERSION 文件、package.json 与 src/version.ts 三处一致", () => {
    const fileVersion = readFileSync("VERSION", "utf8").trim();
    const pkgVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
    expect(VERSION).toBe(fileVersion);
    expect(pkgVersion).toBe(fileVersion);
  });
});
