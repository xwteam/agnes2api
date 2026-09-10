/**
 * 通道请求出错时，**把它实际打的那个地址说出来**——以及说出来之前先把凭据抹掉。
 *
 * ── 为什么需要脱敏（理由要写对，写错了下一个人会照着错的理由放松它）────────
 *
 * ⚠️ **要防的不是面板。** `registrar.yyds.baseUrl` 在 `src/core/config-provenance.ts`
 * 的 `FIELD_EXPOSURE` 里标的是 `"public"`，`GET /admin/api/config` 今天就把它明文
 * 返给已鉴权的管理员；事件板块同样在 `adminAuth` 之后。**「事件板块没鉴权」是假的，
 * 别把它写成理由。**
 *
 * 真正的理由有两条：
 * · `GET /admin/api/events/download`（`src/http/admin/router.ts`）的设计用途就是
 *   **被导出**——粘进 issue、贴进聊天窗口。导出的那一刻它就离开了鉴权边界。
 * · 事件同时进 `ConsoleLogger` ⇒ 容器 stdout，那是另一个信任域。
 *
 * ── 射程（**盲区在这里登记，文档里不许说成「已脱敏」**）──────────────────────
 *
 * 只挡三处：**userinfo（用户名/口令）、查询串、片段**。
 * **凭据写在路径段里挡不住**——形如 `https://host/t/<token>/v1` 的地址会**原样**
 * 打进日志。这是已知缺口，不是遗漏：路径段里哪一段是凭据没有可靠判据，而
 * `config-provenance.ts` 里那条禁令（「不要用关键词启发式去兜底，那是一张手写词表」）
 * 逐字管着这种场合。
 *
 * ⚠️ **本文件覆盖的是「我们自己写的那句话」和「运行时写的那句话」两半。**
 * `redactUrl` / `httpFailMessage` 管前一半（地址由我们拼进去）；
 * `redactInMessage` / `transportFailMessage` 管后一半（`fetch` 没发出去时，
 * **运行时**把完整 URL 写进了它自己的 message）。**只做前一半等于没做**：
 * baseUrl 带 userinfo 时前一半的代码路径压根不执行，理由见 `redactInMessage`。
 *
 * ── 零 IO ─────────────────────────────────────────────────────────────────
 * 本文件在 `src/core/` 下：纯字符串函数，没有时间、没有随机、没有网络、没有环境。
 */

/**
 * `new URL()` 解析不开时的固定占位串。
 *
 * ⚠️ **刻意不回落成原样输出。** 解析不开的串照样可能含凭据——env 侧的
 * `YYDS_BASE_URL` / `MOEMAIL_BASE_URL` 只过 `asNonEmpty`（`./config.ts`），
 * 一道 URL 校验都不走，运维粘错半截带口令的串是完全可能的。
 * 而「它压根不是一个 URL」本身就是一条**完整的**诊断结论：知道这一点，
 * 运维就该去看自己填的那一格，而不是去查上游。
 */
export const UNPARSEABLE_URL = "<不是一个可解析的 URL>";

/**
 * 把一个 URL 变成可以安全写进日志的形态。
 *
 * 四条行为：
 * · 解析失败 ⇒ 返回 `UNPARSEABLE_URL`（**不回落原串**，理由见上）。
 * · userinfo 任一非空 ⇒ 两者清空，主机名前留 `***@` 这个**可见标记**。
 *   留标记而不是静默删掉：运维如果真把凭据塞进了 baseUrl，他需要知道我们抹了它。
 * · 查询串非空 ⇒ 整段换成 `?<redacted>`。**不做逐参数白名单**（同一条禁令）。
 *   留占位而不是直接删：`…/domains?x=1` 与 `…/domains` 在日志里必须读得出区别。
 * · 片段非空 ⇒ 同样换成 `#<redacted>`。这条不是洁癖：baseUrl 带 `#` 时，
 *   适配器里 `${baseUrl}/v1/domains` 追加的那段路径整个掉进 fragment，
 *   `fetch` 实际打的是原来的 pathname —— 这个占位符是那条失败形态唯一的线索。
 *
 * **幂等**：`redactUrl(redactUrl(x)) === redactUrl(x)`。判据只看「非不非空」，
 * 所以第二遍看到的 `***` / 被百分号编码过的占位串照样落回同一个输出。
 */
export function redactUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return UNPARSEABLE_URL;
  }
  const hadCreds = u.username !== "" || u.password !== "";
  const hadSearch = u.search !== "";
  const hadHash = u.hash !== "";
  u.username = "";
  u.password = "";
  u.search = "";
  u.hash = "";
  // 先清空再写回 `***`：直接改 username 会把 password 留在原地。
  if (hadCreds) u.username = "***";
  return `${u.href}${hadSearch ? "?<redacted>" : ""}${hadHash ? "#<redacted>" : ""}`;
}

/**
 * `redactInMessage` 认不出、因而**整段丢弃**时的固定占位串。
 *
 * ⚠️ **丢的是别人写的那段文字，不是整条诊断。** 调用方（`channelFailMessage`）
 * 无论如何都会把 `(${method} ${redactUrl(url)})` 拼在后面，所以「打的是哪个地址」
 * 这条线索一直都在；被丢掉的只是运行时自己那句话。
 */
export const UNSAFE_MESSAGE = "<原始错误消息里仍有凭据成分，已整段丢弃>";

/** 把一个 URL 里**会带凭据的那几段**抠出来；解析不开时返回 `null`（= 认不出来）。 */
function urlSecrets(raw: string): string[] | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  // `search` / `hash` 去掉前导的 `?` / `#` 再比：运行时的消息里可能只嵌了值那一段。
  return [u.username, u.password, u.search.slice(1), u.hash.slice(1)].filter((s) => s !== "");
}

/**
 * 把**运行时自己写的**一句错误消息变成可以安全写进日志的形态。
 *
 * ── 它守的是哪个洞（实测出来的，不是推断）────────────────────────────────
 *
 * `redactUrl` / `httpFailMessage` 只覆盖「请求发出去了、上游回了个非 2xx」那一半。
 * **另一半是 `fetch` 压根没发出去**：baseUrl 带 userinfo 时，undici 在**构造
 * Request 的那一步**就抛 `TypeError`，而它的 message 里带着**完整的原始 URL**——
 * 本机 Node v24.15.0 实测逐字：
 *   `Request cannot be constructed from a URL that includes credentials: https://user:pass@…`
 * 这条 Error 一路穿到 `./mint.ts` 的 `fields: { err: errMsg(err) }` 与
 * `src/http/admin/handlers/registrar.ts` 的 `registrar.channel_test_failed`，
 * 于是口令原样进事件板块、进容器 stdout ——正是本文件头点名要防的那两个出口。
 * 适配器里 `if (!r.ok)` 那一支根本没跑到，脱敏被整个绕过。
 *
 * ── 它凭什么敢说自己挡住了 ────────────────────────────────────────────────
 *
 * **不是靠「把认识的形态替换掉」，是靠一条后置条件**：替换完之后再回头查一遍，
 * 只要还有任何一段凭据留在输出里，**整段丢掉**（`UNSAFE_MESSAGE`）。
 * ⇒ 「我们没想到的形态」的后果是**少说一句话**，不是**多漏一把口令**。
 * 反过来写（只做替换、不做回查）时，一个被运行时重新编码过的 URL 就能整串漏出去，
 * 而门禁全绿——那正是本文件上一版的形状。
 *
 * ⚠️ **代价明写**：URL 解析不开时 `urlSecrets` 返回 `null` ⇒ **无条件整段丢弃**。
 * 此时我们连「哪几段是凭据」都说不出来，任何放行都是在赌。诊断不会因此断掉：
 * `UNPARSEABLE_URL` 本身就是一条完整结论（见本文件头那段），调用方照样拼得出来。
 *
 * ⚠️ **另一半代价**：口令恰好是一个在别处也会自然出现的短串（`1`、`a=1`）时，
 * 回查会命中一句**本来无害**的消息并把它整段丢掉。这是刻意选的方向——
 * 假阳性只让人少看到一句话，假阴性会把口令贴进 issue。
 */
export function redactInMessage(msg: string, url: string): string {
  const secrets = urlSecrets(url);
  if (secrets === null) return UNSAFE_MESSAGE;
  // `split`/`join` 而不是 `replace`：后者只换第一处，而 undici 那句话里 URL 出现一次、
  // 别的运行时可能出现两次（「构造 X 失败」+「原始输入 X」）。
  const out = msg.split(url).join(redactUrl(url));
  return secrets.some((s) => out.includes(s)) ? UNSAFE_MESSAGE : out;
}

/**
 * 通道请求失败时**唯一**的消息模板：`<通道> <动作>失败: <原因> (<方法> <脱敏地址>)`。
 *
 * **两半失败共用它**是有意的：「发得出去但回了 404」与「压根没发出去」在日志里
 * 长同一个样，运维不必先分辨自己撞上的是哪一半才知道去哪儿看地址。
 * 上一版只有前一半有模板，后一半直接裸搬运行时的 message ——**脱敏因此只做了一半**。
 */
function channelFailMessage(p: {
  provider: string;
  action: string;
  method: string;
  url: string;
  reason: string;
}): string {
  return `${p.provider} ${p.action}失败: ${p.reason} (${p.method} ${redactUrl(p.url)})`;
}

/**
 * 通道请求非 2xx 时的统一错误消息模板，形如
 * `YYDS 列域名失败: HTTP 404 (GET https://maliapi.215.im/v1/v1/domains)`。
 *
 * **两条通道共用同一个模板**，与「两条邮箱通道完全平级」同源：只给一条通道带上
 * 地址，另一条的同类故障就没人守。
 *
 * ⚠️ **URL 拼进的是那条 Error 的 message，不是一个新的结构化字段**，代价明写：
 * · 收益 —— `src/core/registrar/mint.ts` 的 `registrar.list_domains_failed` 与
 *   `src/http/admin/handlers/registrar.ts` 的 `registrar.channel_test_failed`
 *   都只搬运 `err.message`，一个字都不用改就同时带上了地址；
 * · 代价 —— 地址因此是消息串的一部分，**面板不能按它筛选或聚合**。要结构化就得给
 *   Error 挂属性、再让 `mintOne` 把它读出来，那是 core 层的改动，为一条诊断信息
 *   不值当。这是有意取舍，不是遗漏。
 *
 * ⚠️ `method` 是一个**参数**而不是写死的 `GET`：`createMailbox` 打的是 POST，
 * 写死会让日志报一个它没发过的方法——那是新的一句假话。
 */
export function httpFailMessage(p: {
  provider: string;
  action: string;
  method: string;
  url: string;
  status: number;
}): string {
  return channelFailMessage({ ...p, reason: `HTTP ${p.status}` });
}

/**
 * 与 `httpFailMessage` **同一个工厂**：产出那条消息**逐字节不变**的 Error，
 * 另把上游那个状态码原样挂在它身上，让调用方**读得回来**。
 *
 * ── 为什么非要是同一个工厂 ──────────────────────────────────────────────────
 *
 * 「消息里写着 404、属性上挂着 403」是这类改动最容易长出来的假话，而它只会在
 * **两条路各产一半**时出现。这里只有一条路：消息由 `httpFailMessage` 产、
 * 状态码由同一次调用的同一个 `p.status` 挂。**下一个人不许只改一边**——
 * 要改消息模板就改 `httpFailMessage`，两边一起动。
 * 这条同构由 `tests/unit/registrar/url.test.ts`
 *「httpFail 与 httpFailMessage 同构：message 逐字节相等，且状态码取得回来」那一格钉着。
 *
 * ⚠️⚠️ **绝不许用正则从 `err.message` 里抠 `HTTP (\d+)`。** 那是一张手写启发式，
 * 与 `src/core/config-provenance.ts` 里那条禁令（「不要用关键词启发式去兜底」）
 * 是同一条：消息模板是给人看的、会被翻译会被改写，而它一改，抠数字的那一头
 * **静默地开始答错**，门禁全绿。状态码只从这里挂、只从 `httpFailStatus` 读。
 *
 * ⚠️ **只覆盖「发出去了、上游回了非 2xx」那一半。** 另一半（请求压根没发出去，
 * 走 `transportFailMessage`）**没有状态码，也不许伪造一个**：`0` / `502` 那种
 * 兜底值会让调用方把「没连上」读成「上游回了话」。没有就是没有。
 */
export function httpFail(p: {
  provider: string;
  action: string;
  method: string;
  url: string;
  status: number;
}): Error {
  return Object.assign(new Error(httpFailMessage(p)), { status: p.status });
}

/**
 * 把 `httpFail` 挂上去的那个状态码读回来；**读不到就是 `null`**。
 *
 * `null` 的含义是「这条错误没带状态码」，与「带了个 0」是两件事：前者的处置是
 * 「按『请求没走通』说话」，后者会被读成一次真实的上游应答。所以这里只认**有限整数**，
 * 别的一律 `null`——包括 `"403"` 这种字符串（它只可能来自某处的手写兜底）。
 */
export function httpFailStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const s = (err as { status?: unknown }).status;
  return typeof s === "number" && Number.isInteger(s) ? s : null;
}

/**
 * 通道请求**根本没发出去**时的统一错误消息模板，形如
 * `YYDS 列域名失败: Request cannot be constructed … https://***@h/v1 (GET https://***@h/v1)`。
 *
 * `cause` 是运行时抛出来的那个 Error，**它的 message 不可信**（见 `redactInMessage`），
 * 所以先过一遍脱敏再拼。原始 Error **不挂成 `cause`**：`errMsg()` 只读 `message`，
 * 挂上去谁都不会读，却让口令继续在进程里跟着这条 Error 走。
 */
export function transportFailMessage(p: {
  provider: string;
  action: string;
  method: string;
  url: string;
  cause: unknown;
}): string {
  const raw = p.cause instanceof Error ? p.cause.message : String(p.cause);
  return channelFailMessage({ ...p, reason: redactInMessage(raw, p.url) });
}

/**
 * 上游**答了 2xx、正文却读不出来**时的统一错误消息模板，形如
 * `YYDS 列域名失败: 响应正文不是 JSON: Unexpected token '<'… (GET https://h/v1/domains)`。
 *
 * ── 为什么它必须存在（一次实测出来的假话）────────────────────────────────────
 *
 * 上一版这条路径上**一个模板都没有**：适配器在 2xx 之后直接 `await r.json()`，
 * 抛出来的是运行时那个裸 `SyntaxError`，而它的 message 里**一个地址都没有**。
 * 实测逐字（上游 200 + HTML 正文，真装配）：
 *   `error="Unexpected token '<', \"<html><bod\"... is not valid JSON"`
 * 于是面板那句「事件里那条失败信息带着它实际请求的那个地址」在这一支上是假的。
 * ⇒ 处置不是把那句话删掉，而是**让这条路真的带上地址**——它本来就该带，
 * 「HTTP 404 却查不出为什么」那个故障的教训在 `mailbox-yyds.ts` 的 `listDomains`
 * 上方逐字写着，而这一支只是当时漏掉的另一半。
 *
 * ⚠️ **不挂 `status`，这一条是刻意的。** 上游确实回了 2xx，但把 `200` 挂上去会让
 * `httpFailStatus()` 的消费方把它读成「上游回了话、这是它的裁决」，进而走进
 * 「上游回了 HTTP 200 —— 连上了，但这一次没读到域名」那句话；而这一档真正要说的是
 * **正文读不出来**。没有裁决就是没有裁决，与 `transportFailMessage` 那一半同一条规矩
 *（`httpFail` 那段逐字写着「没有就是没有，不许伪造兜底值」）。
 *
 * `cause` 的 message **不可信**（它带着上游正文的片段），先过一遍 `redactInMessage`
 * 再拼——与 `transportFailMessage` 同一条理由、同一条实现路径。
 */
export function bodyFail(p: {
  provider: string;
  action: string;
  method: string;
  url: string;
  cause: unknown;
}): Error {
  const raw = p.cause instanceof Error ? p.cause.message : String(p.cause);
  return new Error(channelFailMessage({
    ...p, reason: `响应正文不是 JSON: ${redactInMessage(raw, p.url)}`,
  }));
}
