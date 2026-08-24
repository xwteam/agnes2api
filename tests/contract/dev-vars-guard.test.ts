import { it, expect } from "vitest";
import { IS_WORKERD } from "../helpers/is-workerd.js";

/**
 * **`.dev.vars` 存在时，`pnpm test:workers` 必须当场红。**
 *
 * 成因逐层是这样的：`@cloudflare/vitest-pool-workers` 起 workerd 之前会调
 * `wrangler.unstable_getMiniflareWorkerOptions(...)` 把 `wrangler.toml` 翻译成
 * miniflare 选项，**调用时不传 `envFiles`**，于是 wrangler 走它自己的默认路径，
 * 把仓库根目录的 `.dev.vars` 一并读进来当 `vars`。这条通路**没有开关**：
 * pool 没有暴露任何配置去关掉它，`vitest.workers.config.ts` 里也无处表态。
 *
 * 而 `docs/{zh-CN,zh-TW,en,ja,ko}/DEPLOY.md` 的「本地开发」一节**正在教开发者建这个文件**
 *（`GATEWAY_TOKEN` 不该写进 `wrangler.toml`，所以只能落在 `.dev.vars`），
 * CI 的 checkout 里则永远没有它（`.gitignore` 里就有一行 `.dev.vars`）。
 * ⇒ **本地跑的 env 与 CI 跑的 env 不是同一个，而且没有任何提示。**
 *
 * ── 为什么今天就要装，而不是等它咬人 ────────────────────────────────────────
 * 今天全仓只有三个契约测试读 `cloudflare:test` 的 `env`，且都只取 `env.POOL`，
 * 其余一律走 `tests/helpers/make-app.ts` 的显式 env ⇒ 这颗雷**今天没有消费者**。
 * 但它引爆的条件极低：下一个用 `SELF.fetch` 或读 `env.X` 的契约测试落地那天，
 * 本地绿 / CI 红（或者更糟：本地红 / CI 绿）就成了一个**没有线索**的谜题——
 * 现场看到的两次运行，代码、依赖、命令全都一样。
 * 与其等那一天，不如现在让「文件存在」这件事**自己变成一条会响的失败**。
 *
 * ── 它能做什么 ──────────────────────────────────────────────────────────────
 * 它把「本地与 CI 的 env 静默分叉」换成一条当场就响、且**报文里带出路**的失败。
 *
 * ── 它做不到什么（明写，别读成「双运行时 env 从此对齐了」）──────────────────
 * 它只看 `env` 的**键名集合**，不看值：`.dev.vars` 里写 `POOL=x`（撞名覆盖）它看不见，
 * 生产 `wrangler.toml` 与 CI 之间别的差异（compatibility flags、KV 命名空间 id、
 * secrets）它一概不管。**它也不阻止你建 `.dev.vars`**——`wrangler dev` 要用它，
 * 出路是跑测试前改名，不是不要这个文件。
 */

/**
 * pool 自己往 workerd 的 `env` 里塞的内部绑定的**前缀**。
 *
 * ⚠️ **写成前缀，不许退化成写死那几个名字。** 那几个名字是 pool 的实现细节，
 * 升一次 pool 版本就可能增删——写死名字等于给这道守卫排了一个必然到期的日子，
 * 而到期那天的表现是「一条与 `.dev.vars` 毫无关系的红」，读的人多半会顺手把
 * 断言改宽（本仓登记过的「过不了三轮就被放宽」）。
 */
const POOL_INTERNAL_PREFIX = "__VITEST_POOL_WORKERS_";

/**
 * ⚠️ **写法照仓里既有的 workerd-only 先例**：`IS_WORKERD` 闸 + 动态 `await import`。
 * 判据的唯一实现在 `tests/helpers/is-workerd.ts`，反向防线在 `tests/workers-setup.ts`；
 * 同款分流的三处先例是 `tests/contract/storage.test.ts`、
 * `tests/contract/pool-delete-durability.test.ts`、`tests/contract/pool-index-corrupt.test.ts`。
 *
 * ⚠️ **不能写成顶层静态 `import { env } from "cloudflare:test"` + `it.runIf`**：
 * 静态 import 在 node 侧是**加载期**失败，文件还没跑到 `it()` 就已经炸了，
 * 而 `runIf` 是运行期的开关，救不了加载期。全仓没有一处把它写在 `tests/contract/` 的顶层。
 */
if (IS_WORKERD) {
  const { env } = await import("cloudflare:test");

  it("workerd 的 env 里只该有 POOL —— .dev.vars 被 pnpm test:workers 读进来了", () => {
    const all = Object.keys(env as Record<string, unknown>).sort();
    const names = all.filter((k) => !k.startsWith(POOL_INTERNAL_PREFIX));
    expect(
      names,
      "多出来的绑定来自仓库根目录的 `.dev.vars`：@cloudflare/vitest-pool-workers 调 wrangler 时"
      + "不传 envFiles，那个文件会被无退出口地读进 workerd 的 env，而 CI 上没有这个文件"
      + " ⇒ 本地绿 / CI 红。出路：跑测试前 `mv .dev.vars .dev.vars.off`。"
      + "\n⚠️ 别把这条断言放宽成「不含某几个名字就行」——那样它就只剩下今天这一个已知形态，"
      + "明天多写一个变量名它照样静默。少掉 POOL 则是另一回事：wrangler.toml 的 KV 绑定被改了名，"
      + "改名是合法动作，回来同步这份期望即可。",
    ).toEqual(["POOL"]);
  });

  /**
   * 上面那条豁免**不许变成一条没人再看的死条款**。
   *
   * 它是本文件里唯一一处「主动放行」，而放行项一旦与现实脱节就是一个永久的洞：
   * 假如某个 pool 版本干脆不再注入这批内部绑定，上面那格**照样绿**（过滤器匹配到
   * 零项，剩下的正好是 `["POOL"]`），豁免就此死掉而没有任何信号——
   * 直到有人照着它去写第二条豁免。所以这里把「豁免确实还在干活」也钉成一格：
   * 它红了不代表 `.dev.vars` 有问题，代表**该回来重新看这条豁免了**。
   */
  it("前缀豁免不是死条款：pool 确实往 env 里注入了带这个前缀的内部绑定", () => {
    const internals = Object.keys(env as Record<string, unknown>).filter((k) =>
      k.startsWith(POOL_INTERNAL_PREFIX));
    expect(
      internals.length,
      `env 里一个 ${POOL_INTERNAL_PREFIX}* 绑定都没有了。这不是 .dev.vars 的问题：`
      + "多半是 @cloudflare/vitest-pool-workers 升级后换了内部绑定的命名。"
      + "去核对新的命名，要么改这个前缀，要么连同上面那条过滤器一起删掉——"
      + "别留着一条匹配不到任何东西的豁免。",
    ).toBeGreaterThan(0);
  });
} else {
  it("本文件按设计只在 node 下不跑真断言 —— node 侧读不到 cloudflare:test 的 env", () => {
    // 这一格不是凑数：没有它，`IS_WORKERD` 写坏时本文件在**两份配置下都一格不跑**，
    // 而两条 EXIT 都是 0（本仓 `--reporter=basic` 空跑那一族的同型）。
    // 判据本身的正向防线在 `tests/workers-setup.ts`，那边只在 workerd 侧生效；
    // 这一格是它在 node 侧的对偶。
    expect(IS_WORKERD).toBe(false);
  });
}
