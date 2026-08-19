/**
 * workerd 运行时探测。**唯一实现**，别的文件不许各自复制这行判据。
 *
 * `navigator.userAgent === "Cloudflare-Workers"` 是 workerd 官方约定的运行时
 * 标识（Hono 自身的 getRuntimeKey() 也用同一探测方式），在 Node 下 navigator
 * 要么不存在要么 userAgent 不是这个值，因此该判据互斥可靠。
 *
 * **这条判据本身值钱到需要一道反向防线**：它是硬约束 1「双运行时差异必须被
 * 断言」的**唯一载体**——本仓好几个契约测试文件用它来分流「跑真 KV 还是
 * 跑假实现」，一旦这行判据失灵（例如 workerd 未来改了 UA 字符串），
 * `pnpm test:workers` 会静默地把 workerd 那一侧的分支当成 node 分支跑，
 * 两次运行都走同一条代码路径、两次都绿，而任何专属 workerd 的断言
 * （例如 `admin-capabilities.test.ts` 里靠真实 `cf` 属性才能验证的那条）
 * 会从此再也没有跑过，且没有任何报错。
 *
 * 反向防线见 `tests/workers-setup.ts`：那个文件只在 `vitest.workers.config.ts`
 * 里注册为 `setupFiles`，会在每个 workerd 测试文件的运行时环境内断言
 * `IS_WORKERD === true`，判据失灵时它会先炸。
 */
export const IS_WORKERD =
  typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
