import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tests/ui：前端纯函数（直接 import admin-ui/js/pure/*.mjs）。**只在 node 侧跑**，
    // 不进 vitest.workers.config.ts——它们不碰 Worker 运行时，跑两遍只是浪费。
    include: ["tests/unit/**/*.test.ts", "tests/contract/**/*.test.ts", "tests/ui/**/*.test.ts"],
    // 收集门禁。**必须是 globalSetup 而不是一个 *.test.ts**：它先于且独立于测试文件
    // 的收集运行，所以删掉上面 include 里的任何一条它都还在、且会让本次运行退出 1。
    // 理由与实测见 tests/global-setup.ts 的文件头。
    globalSetup: ["tests/global-setup.ts"],
    environment: "node",
  },
});
