import { IS_WORKERD } from "./helpers/is-workerd.js";

/**
 * **只在 `vitest.workers.config.ts` 里注册**（`test.setupFiles`，不是
 * `globalSetup`——后者跑在外层 Node 宿主进程，看不到 workerd 的 `navigator`；
 * `setupFiles` 才在每个测试文件自己的 workerd 运行时环境内执行）。
 *
 * 见 `tests/helpers/is-workerd.ts` 的说明：`IS_WORKERD` 是好几个契约测试文件
 * 「跑真 KV 还是跑假实现」的唯一判据，判据失灵时那些分支会静默退化成
 * 两次都跑同一条代码路径、两次都绿。这里把判据自己钉成一条会先炸的断言——
 * 只要 `pnpm test:workers` 真的在跑，这个文件必然被执行，`IS_WORKERD` 必然为 true。
 */
if (!IS_WORKERD) {
  throw new Error(
    "tests/workers-setup.ts 只应当在 workerd 环境下执行，但 IS_WORKERD 判据未命中——"
    + "navigator.userAgent !== \"Cloudflare-Workers\"，workerd 的运行时探测本身可能已经失效",
  );
}
