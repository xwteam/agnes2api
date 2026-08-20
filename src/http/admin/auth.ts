import type { MiddlewareHandler } from "hono";
import type { Logger } from "../../ports/logger.js";
import { clientIp } from "../client-ip.js";

/**
 * 常数时间比较：先比长度，再逐字节异或累加，**中途不提前 return**。
 *
 * 长度本身会泄漏（长度不同时立刻 false），这是标准取舍：口令是 ≥24 位的随机串，
 * 泄漏长度不构成可利用的信息，而为了藏长度去做定长填充只会让实现更容易写错。
 *
 * ⚠️ **常数时间这个性质无法用单元测试证明，原因是它根本不在返回值里**：
 * 被测的性质是「**耗时**不随输入而变」，而测试只能断言返回值。把整个函数换成
 * `a === b`、或把循环体改成 `if (a[i] !== b[i]) return false`，**返回值逐点相同**，
 * 变的只是耗时——所以任何基于返回值的断言都区分不了它们（已实测：两条变异全套测试
 * 照样绿，见 Task 5 报告的变异表 M5/M6）。
 *
 * 那为什么不写计时断言？因为在 CI 上测不准：几十个字节的逐字节差异是纳秒量级，
 * 而 JIT 预热、GC、共享 runner 的调度噪声是毫秒量级，信噪比根本不够，写出来的
 * 只会是一条随机红绿的用例——那比没有更糟。
 *
 * 所以这一条**明确不由测试保证，而由评审保证**：评审时逐字核对下面的循环体里
 * 没有任何提前 return / break / 短路运算（`&&` `||` `?:`），出现就是回归。
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const ADMIN_TOKEN_MIN_LENGTH = 24;

/**
 * 审计行里的 `path` 最多留这么长。
 *
 * `admin.use("/admin/api/*", adminAuth)` 对**任意** `/admin/api/` 子路径生效，全程
 * 零凭据、零限速，而 Node 的请求行上限约 8 KB ⇒ **每个未鉴权请求都能往日志里塞
 * 约 8 KB 攻击者文本**。`ConsoleLogger` 的 logfmt 引用已经保证这段文本撕不开字段，
 * 但撕不开不等于该让它无限长：日志按体积计费、按行读，而这个字段的用途只是
 * 「运维/面板看得出被扫的是哪条路径」，200 字符绰绰有余。
 */
export const AUDIT_PATH_MAX = 200;

/**
 * 管理口令的字符集：**可打印 ASCII `0x20–0x7E`**。
 *
 * 与前端 `admin-ui/js/pure/sendable.mjs` **逐码位行为等价**，由
 * `tests/ui/sendable-parity.test.ts` 对 `0x00–0xFF` 全码位 + 若干 >U+00FF 采样
 * 逐个断言 `sendable(c) === isSendable(c)`——**是行为断言，不是源码文本比对**。
 *
 * ── 理由分三段，性质不同，别再压成一句 ────────────────────────────────────
 *
 * 上一版把三段压成一句「浏览器发不出去的字符」。**那句话对第三段是假的**，
 * 而它当时在八处以上被复述。危害不是安全洞（方向仍是 fail closed），是**对运维说了
 * 一句他一试就能证伪的话**——他在浏览器里试一下发现送得出去，然后认定网关在骗人。
 *
 * **(a) 码点 > U+00FF，以及 NUL / LF / CR —— 物理，发生在浏览器。**
 *   `new Headers().set()` 直接抛 `TypeError`（Fetch 规范：头值是 ByteString，
 *   码点 > 255 转不过去；NUL/LF/CR 过不了头值校验）。本机实测（node v24 的 undici，
 *   与浏览器同一套规范实现）：CJK / emoji / 零宽空格 / NUL / LF / CR 全部 THROWS。
 *   这种口令会装出一棵 200 但永远进不去的面板：用户看到「网络错误」，
 *   而服务端**连一条 `login_failed` 都没有**（请求压根没发出来）。
 *
 * **(b) `0x01–0x08`、`0x0B`、`0x0C`、`0x0E–0x1F`、`0x7F`（共 29 个）—— 物理，
 *   但发生在服务端解析器。**
 *   浏览器**送得出去**（`Headers.set` ACCEPTED），HTTP 解析器才拒：本机实测
 *   （裸 `http.createServer` + 原始 socket 逐字节注入）一律 **400 Bad Request**，
 *   handler 收不到这次请求。
 *
 *   ⚠️⚠️ **TAB `0x09` 是这一段的例外，它不在这里，落在 (c)。** HTAB 是 RFC 9110 里
 *   合法的 field-value 字符：实测 `Headers.set` ACCEPTED、解析器 **200 OK**、
 *   handler 收到 U+0009。**这一条订正的是本注释自己**：上一版写的是「其余 C0
 *   控制字符与 `0x00–0x1F`」，而当时只实测过 BEL / ESC / DEL / NEL 四个——
 *   **抽样实测，却写下范围断言**，与 `é` 那条是同一个方法论错误换了个形状。
 *   现在这三段的边界是**全 256 字节穷举**量出来的，不是采样。
 *
 *   ⚠️ **workerd 侧没验**，如实标注——这是个双运行时项目，别把 Node 的实测
 *   当成两边的答案。
 *
 * **(c) TAB `0x09` 与整段 `0x80–0xFF`（`é` `£` 不间断空格 …）—— 送得出去，也真的能用；
 *   排除它们是我们的稳健性取舍，是口味，不是物理。**
 *   （上一版写「`0x80–0xFF` **可打印**字节」不准确：`0x80–0x9F` 是 C1 控制符、
 *   并不可打印，而它们同样落在这一段——NEL `0x85` 那句注只兜住了其中一个。）
 *   本机实测：浏览器侧 ACCEPTED；Node 解析器侧 **200 OK**，handler 收到的码点与发出的
 *   字节逐一对应（`0xE9` → U+00E9）；而 `process.env` 里 UTF-8 的 `é` 解出来同样是
 *   U+00E9 ⇒ 两者**逐码点相等**，`ADMIN_TOKEN="admin-token-café-0123456789"`
 *   端到端能用。（同一次实测顺带订正了一处分组：**NEL `0x85` 不被 Node 解析器拒**，
 *   200 OK 且如实交出 U+0085——它是 C1，结构上属于本段而不是 (b)。）
 *
 *   那为什么还是拦？两条，都写清楚：
 *     · **跨运行时编码口径不一致是真的**：环境变量按 UTF-8 解、HTTP 头值按 Latin-1 解，
 *       两边碰巧在 U+0080–U+00FF 这段对上是**实现细节**，不是规范承诺；
 *       **而 workerd 侧我们没验过**，双运行时项目里未验证的行为差异就是风险。
 *     · RFC 9110 已把 obs-text（`0x80–0xFF`）标为**弃用**，中间件/反代对它的处置不一。
 *   而非 ASCII 口令**不是一个有价值的形态**（不比同长度的 ASCII 更强），是个坑。
 *
 * ── 与「空格」那条的区别（本轮评审刚裁过，写下来免得下次又摇摆）─────────────
 *
 * 空格 `0x20` 也曾被排除，理由是「怕复制粘贴出错」——那条**已经被裁掉并放行**：
 * 空格是**纯 ASCII、跨运行时零编码歧义**，而带空格的 passphrase
 *（`correct horse battery staple`）是**有价值的常见形态**，拒它纯属替运维做主。
 * `0x80–0xFF` 两条都不成立：有真实的编码歧义、又不是有价值的形态。
 * **判据不是「是不是口味」，而是「这个限制换来的稳健性值不值它挡掉的形态」。**
 * (c) 仍然是口味，只是这一次收益 > 代价——所以它被**标成口味**保留，
 * 而不是被伪装成物理。
 *
 * ⚠️ 量词是 `*`：这条规则说的是「不含送不出去的字符」，**非空不是它的职责**
 *（后端归 `too_short`，前端归 `gate.empty`）。前端那份现在同样是 `*`——上一版
 * 前端 `+` / 后端 `*` 的不对称是多余的，它让「两边一致」这句话必须带一个空串例外，
 * 护栏也就只能做到「除空串以外一致」。统一之后等价关系对**全部输入**成立。
 */
const SENDABLE = /^[\x20-\x7e]*$/;

/**
 * 导出成函数（而不是导出那个正则）是为了让 `tests/ui/sendable-parity.test.ts`
 * 能拿它与前端那份做**行为**等价断言。导出正则的话，两边比的还是字面量。
 */
export function isSendable(token: string): boolean {
  return SENDABLE.test(token);
}

export interface AdminTokenCheck {
  ok: boolean;
  reason?: "whitespace_padded" | "not_sendable" | "too_short" | "same_as_gateway_token";
}

/**
 * 四条硬规则里**只看 `ADMIN_TOKEN` 自己**的那三条
 *（⓪ 首尾空白、① 字符集可送性、② 长度下限）。
 *
 * 单独拆出来是因为「装配期能查什么」这件事有一条硬判据：
 * **装配期的结论会被永久冻结（不注册就是永久 404，没法反注册回来），所以它只能建立在
 * 运行中不会变的输入上。** `ADMIN_TOKEN` 只从环境变量读，整个 isolate / 进程的生命周期
 * 里都是同一个值，因此这两条查一次就是永远的答案。
 *
 * 第三条（不得等于 `GATEWAY_TOKEN`）不满足这条判据——`gatewayToken` 是
 * `env.GATEWAY_TOKEN ?? stored.gatewayToken`，运行中会变——所以它**只**在
 * `adminAuth` 的每请求复查里生效，见 `adminRouter` 里那段说明。
 */
export function checkAdminTokenShape(token: string): AdminTokenCheck {
  // 空串不走这里（`"".trim() === ""`），它归 too_short，与 adminRouter 的 `!token` 一致。
  if (token.trim() !== token) return { ok: false, reason: "whitespace_padded" };
  // 顺序：空白 → 可送性 → 长度。可送性排在长度前面，因为「一串汉字口令」同时
  // 触发两条时，报「长度不足」会把人引向加长它——加长之后照样送不出去。
  if (!isSendable(token)) return { ok: false, reason: "not_sendable" };
  if (token.length < ADMIN_TOKEN_MIN_LENGTH) return { ok: false, reason: "too_short" };
  return { ok: true };
}

/**
 * 管理口令的四条硬规则。
 *
 * ⓪ 首尾不得有空白。**这条纯粹为了可诊断性，方向仍是 fail closed。** HTTP 请求头的值
 *    在传输层就被去掉首尾空白，而环境变量不会——于是 `.env` 里口令末尾多敲了一个空格
 *    时，客户端**永远送不出**那个值，结果是「口令明明是对的却一直 401」，日志里只有
 *    `login_failed`，运维查不到原因。极端情形是 24 个空格：长度够、也不等于
 *    GATEWAY_TOKEN，于是装出一棵**永远进不去**的树。在装配期就说清楚，比让人对着
 *    一串看不见的空格排查便宜得多。
 *
 * ① 字符集：只允许可打印 ASCII（0x20–0x7E）。三段理由（两段物理、一段稳健性取舍）见 SENDABLE。
 *
 * ② 长度下限 24：Worker 形态**没有分布式限速**（做它要拿 KV 当窗口，等于给攻击者
 *    一根消耗写配额的杠杆，能把 DoS 面从「猜口令」扩大到「打死 key 池的状态回写」）。
 *    因此口令熵就是唯一的防线，下限不是建议值。
 * ③ 不得等于 GATEWAY_TOKEN：后者是发给**每一个下游用户**的中转口令，复用它当面板
 *    口令 = 任何拿到中转口令的人都能读整池 key、关掉注册机、把 agnesPlatformUrl 改成
 *    自己的服务器从而收走每一次注册的邮箱 + 密码 + 验证码。
 *
 * **顺序有意义：空白 → 字符集 → 长度 → 相同性。**
 *
 * 空白最先：它是四条里**唯一在配置文件里看不见**的那条（长度、字符集、「是否与网关
 * 口令相同」运维自己一眼能核），先报它最省事。
 *
 * 字符集排在长度前面：一串汉字口令同时触发两条，报「长度不足」会把人引向加长它
 * ——加长之后照样送不出去。（`tests/contract/admin-auth.test.ts` 里「又短又含汉字」
 * 那一格把这句话变成可证伪的断言；把两条判断对调，只有那一格会红。）
 *
 * 相同性最后：反过来把它放在长度前面更糟——两条都不满足时报的是「与网关口令相同」，
 * 运维改完口令还是进不去。
 */
export function checkAdminToken(token: string, gatewayToken: string): AdminTokenCheck {
  const shape = checkAdminTokenShape(token);
  if (!shape.ok) return shape;
  if (token === gatewayToken) return { ok: false, reason: "same_as_gateway_token" };
  return { ok: true };
}

/** 审计字段不该原样承载请求数据，见 AUDIT_PATH_MAX。 */
function auditPath(path: string): string {
  if (path.length <= AUDIT_PATH_MAX) return path;
  const cut = path.slice(0, AUDIT_PATH_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  // 0xD800–0xDBFF 是高代理：按 UTF-16 码元截断会把一个代理对劈开，留下一个**孤代理**。
  //
  // ⚠️ **计划说「JSON 序列化之后是 U+FFFD」，实测不是那一步。** 本机 node v24 实测：
  //   · `JSON.stringify("abc" + 孤高代理)` → `"abc\ud83d"`（ES2019 的 well-formed
  //     JSON.stringify 把它转义掉了，这一步**无损**）；
  //   · `new TextEncoder().encode(...)` → 末尾三字节 `ef bf bd`，也就是 **U+FFFD**。
  // 也就是说替换字符是在**把响应体编成 UTF-8 字节**那一步产生的（事件下载的
  // `.txt` 与任何走 UTF-8 的日志采集都经过它），不是 JSON 序列化那一步。
  // 结论不变（面板要按这个字段做筛选与聚合，留一个孤代理迟早变成替换字符），
  // 但成因要说准。截掉它比留一个半个字符干净。
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * `currentGatewayToken` 是个 **getter，每请求现读**（与 `middleware/auth.ts` 的
 * `getToken: () => string` 同一套做法），不是装配时拷下来的值。理由见下面的运行期复查。
 */
export function adminAuth(
  token: string,
  currentGatewayToken: () => string,
  logger: Logger,
  trustProxy: boolean,
): MiddlewareHandler {
  return async (c, next) => {
    // ── 运行期复查，**每请求一次** ────────────────────────────────────────
    // 装配期那次 checkAdminToken 只挡得住「启动时就配错」。它挡不住**配置在运行中
    // 变成不安全状态**：`loadConfig` 是 `env.GATEWAY_TOKEN ?? stored.gatewayToken`，
    // 部署者没设环境变量、改由存储提供时，一次 `wrangler kv key put`、一次手工编辑
    // store.json（这两条恰恰是 DEPLOY.md 里教的操作），或将来 P3c 的面板，都能把
    // gatewayToken 改成等于 ADMIN_TOKEN——而中转口令是发给**每一个下游用户**的，
    // 届时任何下游用户都能开后台，直到重启 / isolate 回收为止。这是权限提升，
    // 不是配置洁癖；把它交给「写入路径上拒绝」不够，手工改存储绕得过写入路径。
    //
    // **fail closed**：管理端整个停用，而**网关转发不受影响**（与 ADMIN_TOKEN 没配
    // 时的语义一致）。复查刻意跑在验证凭据**之前**：没有任何一条路径能走到 next()。
    const state = checkAdminToken(token, currentGatewayToken());
    if (!state.ok) {
      logger.log({
        level: "error", event: "admin.token_conflict",
        msg: state.reason === "same_as_gateway_token"
          ? "ADMIN_TOKEN 与当前生效的 GATEWAY_TOKEN 相同，管理接口已停用（网关转发不受影响）。"
            + "中转口令是发给每一个下游用户的，复用它当面板口令等于把整池 key 交出去；"
            + "改掉其中一把即可恢复"
          : "ADMIN_TOKEN 不再满足管理口令的硬规则，管理接口已停用（网关转发不受影响）",
        fields: { reason: state.reason ?? null, path: auditPath(c.req.path) },
      });
      // **响应体不说原因**。这个分支跑在验证凭据之前，任何未鉴权的调用方都拿得到
      // 它；说出「两把口令相同」，等于告诉一个手里已经有中转口令的人「管理口令就是
      // 你手上那把」。原因只进日志，那是运维才看得到的地方。
      return c.json({ error: { type: "service_unavailable", message: "管理接口不可用" } }, 503);
    }

    // **只认请求头**。刻意不接受 `?key=`（`/v1` 接受它是为了 Gemini 协议兼容，
    // 管理端点不继承这个），也不接受 `Authorization: Bearer`（两把钥匙严格隔离）。
    // 口令进 URL 会落进浏览器历史、Referer、CF 访问日志、反代日志——
    // 这条禁令同时否掉了 EventSource（它设不了请求头），见设计文档 §7.2。
    const provided = c.req.header("x-admin-key") ?? "";
    if (!constantTimeEqual(provided, token)) {
      // **不记 provided 本身**：日志会被转发到第三方，猜错的口令里常常只差一位，
      // 而记下来的那一串就是攻击者字典的一部分——更别说运维自己打错时会把真口令
      // 记进日志。只记「带没带这个头」，够面板区分「扫描」与「猜口令」了。
      logger.log({
        level: "warn", event: "admin.login_failed", msg: "管理接口凭据无效",
        fields: { ip: clientIp(c, trustProxy), path: auditPath(c.req.path), hasHeader: provided.length > 0 },
      });
      return c.json({ error: { type: "unauthorized", message: "未授权" } }, 401);
    }
    await next();
  };
}
