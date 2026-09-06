import type { Context } from "hono";
import type { Fetcher } from "../../../ports/fetcher.js";
import type { KeyPoolRepo } from "../../../core/keypool-repo.js";
import type { GatewayConfig } from "../../../core/config.js";
import type { ProbeGuard } from "../probe-guard.js";
import { selectKey } from "../../../core/keypool.js";
import { UPSTREAM_MODELS_PATH } from "../../../core/admin/protocol-catalog.js";
import { parseUpstreamModels, diffAgainstCatalog } from "../../../core/admin/upstream-models.js";

/**
 * `GET /admin/api/upstream/models` —— 拿池里的一把 key 去问上游「你现在有哪些模型」。
 *
 * **它与 `handlers/models.ts` 并存，不替换它**：那一条零存储读、零网络，交出去的是本仓
 * 写死的协议目录（「怎么调这个网关」）；这一条是一次真实的出站请求，交出去的是
 * 「上游账号此刻的清单」。理由全文在 `src/core/admin/upstream-models.ts` 的文件头。
 *
 * 面板这一侧的消费者是模型板块那张「上游模型」卡（`admin-ui/js/sec-models.js`
 * 的 `upstreamCard()`），取值判定在 `admin-ui/js/pure/models.mjs` 的 `upstream*` 一族。
 * ⚠️ 下面凡是描述「拿到这份响应之后该怎么显示」的段落，说的都是**对调用方的契约**
 * ——那张卡照它接，但契约不因为它而收窄：curl / 脚本同样是这条端点的调用方。
 *
 * ── 约束，逐条抄自 `handlers/verify.ts` 那六条里仍然适用的几条 ─────────────────
 *
 * 1. **写零个存储字段。** 拉一次清单不是「这把 key 好不好用」的证据，失败记 strike /
 *    成功清 strike 那两颗自毁按钮的理由与验活那边逐字相同（见那个文件的约束 1）。
 *    连 Tier-1 的 `stats` 也不写——`stats` 是真实流量的证据，掺进人造探测就不再是证据。
 *
 * 2. ⚠️⚠️ **非 2xx 的正文一个字节都不许读，更不许回给调用方。**
 *    上游 401/403 的错误体恰恰是各家 API 最爱回显 key 片段的地方
 *    （`src/core/dispatcher.ts` 的 evict 分支为这件事专门丢弃过一个响应体）。
 *    **这条端点比验活多了一步**：2xx 时它**必须**读正文，否则拿不到模型 id。
 *    ⇒ 边界画在这里：**只有 2xx 才读**，读到之后**只交出窄化出来的 id 字符串**
 *    （`parseUpstreamModels()`，它一个别的字段都不搬运），原始正文一个字符都不进响应。
 *    非 2xx 一律 `body.cancel()`，与验活那边同一句。
 *
 * 3. **走注入的 `Fetcher` 端口，不许裸 `fetch`**（`src/ports/fetcher.ts`）——
 *    没有它这个端点在测试里桩不掉、每跑一次就真打一次外网。
 *    ⚠️ 与验活那边同一条如实登记：`tests/unit/source-guards.test.ts` 的零 IO 扫描只扫
 *    `src/core`，接不住 `src/http` 里的裸 `fetch`；真正接住它的是本端点的契约用例里
 *    那些观测桩 fetcher 的格子。
 *
 * 4. **自带 AbortController + 超时**，档位取 `config.upstreamTimeoutMs`（首字节档）：
 *    它不经 `dispatch()`，那套超时/中止一样都没有。
 *
 * 5. **护栏与验活共用同一把 `ProbeGuard`**（全局约束 14：按一下就打上游的按钮必须连同
 *    护栏一起交付）。kind 是**常量** `"upstream-models"` 而不是带标识的——这条端点
 *    没有「对哪一个资源」这个维度（验活是 `verify:<id>`，通道测试是 `channel:<name>`），
 *    整台网关只有一份上游清单可拉。
 *
 * ── 为什么是 GET 而不是 POST（与验活 / 通道测试刻意不同）────────────────────────
 * 那两条是**对运维选中的某一个资源**做一次动作（验哪一把 key、测哪一条通道），
 * 而这一条是**读一份清单**：它对本仓与上游都零副作用，语义上就是 GET，
 * 调用方也因此能像别的只读端点一样直接 GET。
 * ⚠️ **别把「有护栏」读成「所以该是 POST」**：护栏管的是「多久能再打一次上游」，
 * 与这次请求是不是安全方法无关。
 *
 * ── 空池不是错误，是一句要说清的话 ───────────────────────────────────────────
 * 池里一把可用的 key 都没有时（今天线上就是），**没有任何东西可以拿去问上游**。
 * 这一档回 `{ ok: false, reason: "no_key" }` 而不是 500，也不是转圈：
 * 调用方据 `reason` 选一句文案，告诉运维先去 Key 池里加一把。
 * ⚠️ **判据是 `selectKey()` 而不是「池子长度为 0」**：一池全在冷却 / 全被停用时
 * 长度不为 0 而一把都用不了，那两种状态在这条端点上是同一件事。
 */
export interface UpstreamModelsDeps {
  repo: KeyPoolRepo;
  fetcher: Fetcher;
  now: () => number;
  /** **getter 而不是值**：超时档与上游 base URL 都能在运行中被面板改掉。 */
  config: () => GatewayConfig;
  /** 与验活、通道测试**共用的那一把**，见 `../probe-guard.ts`。 */
  guard: ProbeGuard;
}

export function upstreamModelsHandler(deps: UpstreamModelsDeps) {
  return async (c: Context) => {
    // ⚠️ **护栏排在选 key 之后**：空池那一档一个上游请求都不会发，让它去消费一次
    // 最小间隔，等于「点了一下、什么都没打，但接下来 30 秒不许再点」。
    //
    // `repo.all()` 交出来的可能是一个 `POOL_CACHE_TTL_MS` 之前的快照——**这里可以**，
    // 与验活那条「直读存储」的理由不同：验活要验**运维刚改过的那一把**，而这里只需要
    // 「随便一把能用的」。⚠️ 代价如实登记：刚加进池子的那一把在快照过期前选不中，
    // 于是刚加完 key 就点这颗按钮仍可能落到 `no_key`。
    const rec = selectKey(await deps.repo.all(), 0, deps.now());
    if (rec === null) {
      return c.json({ ok: false, status: null, latencyMs: 0, reason: "no_key", models: null });
    }

    const g = deps.guard.tryAcquire(KIND, deps.now());
    if (!g.ok) {
      return c.json({
        error: { type: "rate_limit_error", message: g.message },
        // 顶层 `reason` 是**机器可读的码**，与 200 那几档的 `reason` 同一族。
        // ⚠️ 调用方据它选文案，**不许解析 `message`**：那一句是给人看的中文，措辞会变。
        // 面板那一侧读它的是 `admin-ui/js/pure/models.mjs` 的 `upstreamTransportCode()`
        //（判据是这个字段，不是 429 那个状态码——同一个状态码下这里有两种拒绝）。
        reason: g.reason,
      }, 429);
    }

    // ── 从这里到 `finally` 之间不许再有任何会抛的语句 ──────────────────────────
    // 护栏已经占住了而 `release` 在 `finally` 里：这中间抛一次，这个 kind 就永久卡在
    // 「在飞」，那颗按钮从此再也点不动（与 `handlers/verify.ts` 里那段同一条）。
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = deps.now();
    try {
      const cfg = deps.config();
      timer = setTimeout(() => controller.abort(), cfg.upstreamTimeoutMs);
      const res = await deps.fetcher.fetch(`${cfg.agnesBaseUrl}${UPSTREAM_MODELS_PATH}`, {
        method: "GET",
        // 上游只认 `Authorization: Bearer`，与 `src/core/dispatcher.ts` 里那一句同源
        //（**刻意不取 `proto.authHeader`**：那个字段回答的是「客户端用哪个头调本网关」）。
        headers: { authorization: `Bearer ${rec.record.key}` },
        signal: controller.signal,
      });
      if (res.status < 200 || res.status >= 300) {
        // 约束 2：**非 2xx 的正文一个字节都不读**，连同「不消费的响应体会挂在连接上」
        // 那一半（`src/core/dispatcher.ts` 的 `discard()` 同理）。
        if (res.body && !res.bodyUsed) {
          try { await res.body.cancel(); } catch { /* 已被关闭或已被取消，忽略即可 */ }
        }
        return c.json({
          ok: false, status: res.status, latencyMs: deps.now() - startedAt,
          reason: "upstream_error", models: null,
        });
      }
      // 2xx：这里**必须**读正文，否则拿不到模型 id——读进来之后立刻窄化，交出去的只有
      // id 字符串。⚠️ **别把这句写成「本仓唯一一处读上游正文的路径」**（本轮评审逐条现算
      // 反驳过一次）：三条协议路由与两条邮箱适配器都在读上游正文。这里成立的只有
      // 「**这条端点上**，只有 2xx 才读」这一条边界，见上方约束 2。
      const parsed = parseUpstreamModels(await res.json().catch(() => null));
      if (parsed === null) {
        return c.json({
          ok: false, status: res.status, latencyMs: deps.now() - startedAt,
          reason: "bad_payload", models: null,
        });
      }
      return c.json({
        ok: true, status: res.status, latencyMs: deps.now() - startedAt, reason: null,
        models: {
          ids: parsed.ids,
          truncated: parsed.truncated,
          ...diffAgainstCatalog(parsed.ids),
        },
      });
    } catch {
      return c.json({
        ok: false, status: null, latencyMs: deps.now() - startedAt,
        // **机器可读的 code，不是异常消息**：异常消息里可能带上游 URL 与栈帧。
        reason: controller.signal.aborted ? "timeout" : "network_error",
        models: null,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      deps.guard.release(KIND);
    }
  };
}

/**
 * 护栏的 kind。**具名常量**：契约用例要拿它去构造「上一次还在飞」那一格，
 * 在那边抄一份字面量的话，改了这里不会有任何东西红。
 */
export const KIND = "upstream-models";
