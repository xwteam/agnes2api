import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tests/ui：前端纯函数（直接 import admin-ui/js/pure/*.mjs）。**只在 node 侧跑**，
    // 不进 vitest.workers.config.ts——它们不碰 Worker 运行时，跑两遍只是浪费。
    include: ["tests/unit/**/*.test.ts", "tests/contract/**/*.test.ts", "tests/ui/**/*.test.ts"],
    environment: "node",
  },
});
