import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: { kvNamespaces: ["POOL"] },
    }),
  ],
  test: {
    include: ["tests/contract/**/*.test.ts"],
    // 与 vitest.config.ts 挂同一道门禁。不挂的话单独跑 `pnpm test:workers` 时它
    // 完全不生效——而「workers 的 include 被收窄」恰恰是只有从这个入口才最容易
    // 被察觉的那类改动。（globalSetup 跑在主 node 进程里，不进 workerd，
    // 所以它用 node:fs / child_process 没问题。已实测。）
    globalSetup: ["tests/global-setup.ts"],
  },
});
