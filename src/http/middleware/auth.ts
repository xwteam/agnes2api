import type { MiddlewareHandler } from "hono";
import type { Logger } from "../../ports/logger.js";
import { constantTimeEqual } from "../../core/admin/constant-time.js";
import { digest, findByDigest, isApiKeyUsable, apiKeyBucket } from "../../core/admin/api-keys.js";
import type { ApiKeyHolder } from "../apikey-holder.js";

function extract(c: Parameters<MiddlewareHandler>[0]): string | null {
  const authz = c.req.header("authorization");
  if (authz) {
    const trimmed = authz.trim();
    const m = /^bearer\s+(.+)$/i.exec(trimmed);
    if (m) return m[1]!;
    // Authorization 头存在但不是 Bearer 格式，返回原值或 null（取决于是否为空）
    return trimmed.length > 0 ? trimmed : null;
  }
  const extracted =
    c.req.header("x-api-key") ??
    c.req.header("x-goog-api-key") ??
    new URL(c.req.url).searchParams.get("key");

  // 空字符串、null、undefined 都视同无凭据
  if (extracted === null || extracted === undefined) {
    return null;
  }
  const trimmed = extracted.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 子密钥那一段的接线。**`null` / 缺席 = 这个 app 没接**，鉴权退化成「只认主口令」
 * ——也就是本期之前的行为，一个字节都没变。
 *
 * 与 `AdminRouterDeps.config` 那种「没接就回 503」刻意**不同**：这里没接不是装配不全，
 * 而是**一个正常且默认的部署形态**（一把子密钥都没签发过时它什么也不做）。
 */
export interface ApiKeyAuthWiring {
  holder: ApiKeyHolder;
  now: () => number;
  /**
   * 事件 sink。**只在「认出了是哪一条记录、但那条记录不可用」时打一条**，
   * 见下面 `auth()` 里那段。
   */
  logger: Logger;
}

/**
 * 网关侧的鉴权。**两段，顺序不可交换。**
 *
 * ① **主口令**（`GATEWAY_TOKEN` / 存储里的 `gatewayToken`）：常数时间比对，
 *    命中即放行，**一次 `Storage` 调用都没有**；
 * ② 没命中才去算摘要、查子密钥表。
 *
 * ⚠️⚠️ **这个顺序不是性能优化，它就是逃生口本身。** `apikeys` 那个键被写坏、
 * KV 读不出来、持有者第一次装载就失败——①这一支一个字节都不受影响。
 * 把顺序反过来（先查表、再回落主口令）在功能上等价，**在逃生口上是完全不同的东西**。
 * 由 `tests/contract/admin-apikeys.test.ts` 的
 * 「密钥表是坏值时主口令仍然通 —— 这一条就是逃生口本身」钉着。
 *
 * ⚠️ **主口令不是子密钥表里的一行**，四条理由（真相源是 `env > 存储 config` 两级、
 * 面板上它必须不可删不可停用、它没有 `expiresAt` / `hash` 这两格、
 * 「`ADMIN_TOKEN` ≠ `GATEWAY_TOKEN`」那条既有运行期规则读的是 config 不是这张表）
 * 写在五份 ADMIN.md 的「API 密钥」一节里。
 *
 * ⚠️ **口令每请求现取**（`getToken` 是 getter）。原来是 `auth(token: string)`，
 * 口令在建 app 那一刻被闭包捕获，于是面板改／吊销口令对已经建好的 app 完全无效
 * ——这不是「没生效」，是「撤销不掉的凭据」。
 *
 * ⚠️ **比较改成常数时间了**（这里原来写着「仍用朴素 `!==`，改它另行登记」）：
 * 那笔账随本期一起销了，因为第②段本来就要用同一份 `constantTimeEqual` 去比摘要，
 * 而在同一个函数里让两把钥匙用两种比较方式没有任何道理。实现只有一份，
 * 真源在 `src/core/admin/constant-time.ts`。
 *
 * ⚠️ **401 响应体不区分**「没这把密钥」/「停用了」/「过期了」——那是给攻击者的
 * 枚举信号。**事件日志里区分**（下面那条 `apikey.rejected`），
 * 这是本仓既有的「诚实但不泄漏」体例（同 `admin.login_failed` 只记 `hasHeader`）。
 */
export function auth(getToken: () => string, apiKeys?: ApiKeyAuthWiring | null): MiddlewareHandler {
  return async (c, next) => {
    const presented = extract(c);
    // **没带凭据的请求在这里就结束了，一次存储读都不产生。**
    // 扫描器打 `/v1/chat/completions` 不带任何头是最常见的形态，让它撬不动存储。
    if (presented !== null) {
      if (constantTimeEqual(presented, getToken())) {
        await next();
        return;
      }
      if (apiKeys) {
        // **只有到这里才碰存储**（而且被持有者的 TTL 摊平），见 `apikey-holder.ts`。
        await apiKeys.holder.ensureFresh();
        const table = apiKeys.holder.current();
        if (table !== null) {
          const rec = findByDigest(table.keys, await digest(presented));
          if (rec !== null) {
            const now = apiKeys.now();
            if (isApiKeyUsable(rec, now)) {
              await next();
              return;
            }
            // **认出来了、但不可用**：只有这一档打事件。
            // ⚠️ **「没有这把密钥」那一档刻意不打**：那条路径零凭据、零限速，
            // 给它打事件等于把事件缓冲交给任何一个扫描器去灌
            //（同 `src/http/admin/auth.ts` 文件头担心的那根杠杆）。
            // 打得出这条事件的人手里必须已经有一把**真的被签发过**的密钥。
            apiKeys.logger.log({
              level: "warn", event: "apikey.rejected",
              msg: "一把已签发的对外 API 密钥被拒绝（它已停用或已过期）",
              // **只记 id 与档位，不记明文、不记摘要**：日志常被转发到第三方。
              fields: { id: rec.id, bucket: apiKeyBucket(rec, now) },
            });
          }
        }
      }
    }
    return c.json({ error: { message: "未授权：缺少或无效的凭据", type: "unauthorized" } }, 401);
  };
}
