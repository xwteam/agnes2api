import type { Context } from "hono";
import type { Logger } from "../../../ports/logger.js";
import type { Storage } from "../../../ports/storage.js";
import type { RuntimeInfo, BackgroundCtx } from "../../../ports/runtime.js";
import type { KeyPoolRepo } from "../../../core/keypool-repo.js";
import type { ConfigHolder } from "../../config-holder.js";
import type { Channel } from "../../../core/registrar/config.js";
import { countsTowardTarget, poolHealth } from "../../../core/keypool.js";
import {
  MANUAL_GUARD_KEY, checkManualTend, manualTendQuota, narrowManualGuard,
} from "../../../core/admin/tend-guard.js";
import { TEND_HISTORY_KEY, narrowTendHistory } from "../../../core/admin/tend-history.js";
import {
  acquireTendLock, releaseTendLock, narrowTendLock, TEND_LOCK_KEY, type TendGate,
} from "../tend-lock.js";
import type { ProbeGuard } from "../probe-guard.js";
import { httpError } from "../../errors.js";

/**
 * 注册机的三条管理端点（设计 §10.2 / §10.3 / §11）：
 *
 * | 方法 | 路径 | 干什么 | 写存储吗 |
 * |---|---|---|---|
 * | POST | `/admin/api/registrar/tend` | 「立即补池」，四条护栏 | **是**（护栏键 + 锁 + 历史） |
 * | GET | `/admin/api/registrar/status` | 补池历史 / 名额 / 锁 / 两条通道的接入状态 | **稳态否**（见 ⚠️①） |
 * | POST | `/admin/api/registrar/channels/:channel/test` | 通道连通性（可用域名数 + 延迟） | **成功支否**（见 ⚠️②） |
 *
 * 后两条在**稳态 + 成功支**上一次存储写都不产生，这条性质由
 * `tests/contract/admin-registrar.test.ts` 的
 * 「status 与通道测试在稳态下都不写存储、也不 list」数着 put/delete/list 计数钉住。
 * 它不是「碰巧现在这样」：配额账（计划「配额账」一节）把面板轮询算成零写，
 * 多一次写就要回去改五语言 DEPLOY.md。
 *
 * ⚠️ **上面那两个限定词是通读评审的订正，原来两格都写着「否，一次都不写」**：
 * ① `status` 的 `repo.all()` 在**索引缺失或空池兜底**时会 1 次 `list` + 1 次索引 `put`；
 * ② 通道测试的**失败支**会打一条事件，那条事件最终要落盘。
 * 两条的完整量测与代价各自写在下面对应 handler 的说明里，**这里不复述数字**
 *（同一个数字抄两份，改的时候必然只改一份）。
 *
 * ── 「立即补池」的四条护栏，逐条落在这个文件里 ──────────────────────────────
 *
 * | # | 护栏 | 落点 | 挡什么 |
 * |---|---|---|---|
 * | 1a | 进程/isolate 内在途守卫 | `deps.gate.tryEnter()` | 同副本内的重入（定时轮 × 按钮、两个并发请求） |
 * | 1b | 存储级短锁 | `acquireTendLock()` | **跨副本**的重叠（多容器共卷 / Worker 两个 isolate） |
 * | 2 | 10 分钟手动冷却 | `checkManualTend()` 的 `cooldownUntil` | 连点烧邮箱名额 |
 * | 4 | 每天 K 次写预算闸 | `checkManualTend()` 的 `day` / `used` | 连点烧 **KV 写配额**（三重护栏挡不住这一条） |
 *
 * 第 3 条护栏（确认弹窗明示消耗）在**面板**上，后端做不了；它要的那两个数字
 *（本次最多铸几把 key / 最多消耗几个临时邮箱）由 `status` 的 `pool` 块给出
 *（`gap` 与 `mintBatch`），面板取 `min(gap, mintBatch)`。
 *
 * ⚠️⚠️ **两个外部邮箱配额数字（YYDS 15 / MoeMail 30）不进面板文案，也不进响应体。**
 * 理由**不是**「本仓没核实过」——那句话上一版写错了（评审发现）：设计文档的邮箱
 * 通道对照表里，MoeMail 那 30 追溯得到上游默认 `MAX_ACTIVE_EMAILS`，YYDS 那 15
 * 追溯得到免费档档位。**真正的理由是它们都不是常数**：MoeMail 那个是**上游默认值、
 * 实例可用 `SITE_CONFIG.MAX_EMAILS` 覆盖**，YYDS 那个**与账号档位绑定**。
 * **把一个「当前默认值」印在面板上，运维会把它当成自己这套部署的事实。**
 *
 * ⇒ 取舍是二选一里的第 ②「改成不写具体数字」：
 * 面板的确认弹窗只说「本次最多铸 N 把 key，将消耗最多 N 个临时邮箱；两条通道各自的
 * 活跃邮箱上限请查各自服务商的文档」——N 是本仓自己算得出的数，上限交给出处。
 * 同一次收口也把源码里那几处**当事实用**的注释统一改成「上游默认值 / 与档位绑定」，
 * 出处集中记在 `src/adapters/mailbox-moemail.ts` 与 `src/adapters/mailbox-yyds.ts`
 * 各自的文件头（谁的上游谁记），别处一律只引用、不复述数字。
 *
 * ── 顺序有意义：先读护栏（不写）→ 抢锁 → 才写护栏 ─────────────────────────
 *
 * 反过来（先消费护栏再抢锁）时，一次抢锁失败会白白吃掉一格日预算与一次 10 分钟冷却
 * ——**明明什么都没跑，按钮却被锁住十分钟**。现在抢锁失败那一支一次写都不产生。
 *
 * ── 诚实限定，不许被改写成「并发已解决」─────────────────────────────────
 *
 * KV 是最终一致的，存储锁与护栏键都是**读改写**，两者都会丢更新：
 *
 * | 处 | 丢更新的后果 | 上界 |
 * |---|---|---|
 * | `registrar_manual_guard` | 两副本同时点，各读到 `used=K-1`、各写回 `used=K` ⇒ 闸门多放行一次 | 每次并发窗口最多多放行 (并发数−1) 次 |
 * | `registrar_tend_lock` | 两个都抢到 ⇒ 两轮补池并发跑 | 同上 |
 * | `tend:history`（`wire.ts` 的 `appendHistory`） | 丢一轮记录 ⇒「每轮汇总」缺一行 | 每次并发窗口最多丢 (并发数−1) 轮 |
 *
 * **这三处是尽力而为，不是原子操作**；存储锁把并发窗口压到很小，但压不到零。
 * 为什么不做成无读改写：`tend:history` 改成一轮一键就要付 `list`（红线 1 直接禁止），
 * 护栏键改成一天一键则跨天时仍要读旧键。**两条路都更差，代价明写比消除更诚实。**
 */

/**
 * 注册机这条路的执行体与它的存储，**三样成套给或者一个都不给**。
 *
 * 成套是刻意的：只给存储不给执行体，「立即补池」会写下护栏与锁然后什么都不跑；
 * 只给执行体不给存储，四条护栏一条都不成立；给了前两样却不给 `probeChannel`，
 * 两颗「测试连接」按钮就得各自有一种「这条通道能不能测」的中间态。
 * 拆成三个各自可选的字段，就等于允许 2³ 种半装配状态存在，而其中每一种都会让
 * 面板说一句假话。**只有 `wire.ts` 装配得出来**（三样都要 `env`），直接调
 * `createApp` 的调用方一律拿不到，端点因此如实回 `503 not_wired`。
 *
 * ⚠️ 这个接口原来叫 `ManualTendWiring`（只有 `storage` + `run`）。
 * 加通道测试时**改名而不是新加一个并列的接线**：两者用的是同一个存储、
 * 同一份 `env`、同一条「这个部署接没接注册机」的判据，分成两个可选字段只会
 * 制造出「补池接了、测试没接」这种没有任何人想要的状态。
 */
export interface RegistrarWiring {
  /** 护栏键、补池锁、补池历史都落在这里。**与 key 池同一个存储**，不新增依赖。 */
  storage: Storage;
  /**
   * 真的跑一轮**手动**补池（装配依赖 → `tendOnce` → 写 `tend:history` → 落盘事件）。
   * 由 `wire.ts` 提供，因为只有它手上有 `env`。
   *
   * `channel` 为 `null` 时按配置里的主/备通道链跑；给了通道名则**只用那一条**
   *（面板「添加 Key」菜单里【自动注册】那两项，设计 §10.2）。
   *
   * **允许抛错**：抛出来由本文件接住并记一条事件，**而锁一定在 `finally` 里释放**。
   */
  tend: (channel: Channel | null) => Promise<void>;
  /**
   * 探一条通道的连通性：**只调 `listDomains()`，不建邮箱、不注册账号**。
   * 返回可用域名数，由本文件加上耗时一起交给面板（设计 §10.3 第 6 条：
   * 用数据代替推荐）。上游报错时**抛出**，由本文件转成 `ok: false`。
   */
  probeChannel: (channel: Channel) => Promise<ChannelProbe>;
}

/**
 * `probeChannel` 的返回形状。**「探到了」与「这条通道压根没接上」是两件事**，
 * 不能都用抛错表示：前者是运维要看的数据，后者是一句「你还没配它」。
 */
export type ChannelProbe =
  | { ok: true; domains: number }
  /** 注册机在「端点查过 enabled」与「真去探」之间被关掉了。 */
  | { ok: false; reason: "registrar_disabled" }
  /** 这条通道没有凭据 ⇒ `buildTendDeps` 压根没给它造 provider。 */
  | { ok: false; reason: "provider_missing" };

export interface RegistrarDeps {
  /**
   * 注册机的接线。**`null` = 这个部署压根没接**（只有直接调 `createApp`
   * 而不经 `wire.ts` 的装配才会这样），此时三条端点如实回 `503`，不假装。
   */
  wiring: RegistrarWiring | null;
  now: () => number;
  /**
   * 事件 sink。**用 app 那一个（fan-out 到 `StoreLogger`）**：手动补池是"池子为什么变了"
   * 的一个原因，漏在事件板块外面，那个板块就只说了一半真话。
   */
  logger: Logger;
  /** 后台任务的载体（Worker 的 `ctx.waitUntil` / Node 的 fire-and-forget），见 `RuntimeInfo`。 */
  runtime: RuntimeInfo;
  /** 判「注册机开没开」用它，零额外 IO（`configRefresh` 中间件本请求已经刷过一次）。 */
  configHolder: ConfigHolder;
  /** 进程/isolate 内的在途守卫。**与定时轮共用同一把**，见 `tend-lock.ts` 的对照表。 */
  gate: TendGate;
  /**
   * 出站探测的护栏。**与单把 key 验活共用同一份实现、同一个实例**，
   * 见 `../probe-guard.ts`。只有 `channelTestHandler` 用它——「立即补池」有它自己
   * 那四条更重的护栏（存储锁 + 10 分钟冷却 + 每日写预算），两套不叠加。
   */
  probeGuard: ProbeGuard;
  /**
   * **与转发路径同一个实例**（见 `AdminRouterDeps.repo`）。`status` 用它数
   * 「占名额数」，走的是共用的 isolate 快照 ⇒ 面板刷新不额外读存储。
   */
  repo: KeyPoolRepo;
}

/**
 * Hono 的 `c.executionCtx` 在**没有** `ExecutionContext` 时抛错，不是返回 `undefined`
 *（Node 形态、以及 `app.request(url)` 这种不带 ctx 的调用都会走到）。
 *
 * 这里 `try/catch` 问的是「Hono 这次请求有没有带载体」，**不是在嗅探运行时**——
 * 拿到之后做什么完全由注入的 `runtime.background` 决定（Node 侧那份连看都不看它）。
 */
function backgroundCtx(c: Context): BackgroundCtx | null {
  try {
    return c.executionCtx;
  } catch {
    return null;
  }
}

/**
 * 每一条拒绝都带一个**顶层 `reason`**：面板靠它选五语言文案，**不解析中文 `message`**
 *（与 Key 池写端点那条 `must_disable_first` 同一条口径）。
 *
 * ⚠️⚠️ **`409` 有三种、`429` 有两种、`503` 与 `400` 各一种——状态码不是判据。**
 * 拿状态码当唯一判据的前端会把「另一个副本在跑」（`locked`：你是多副本部署，
 * 等对面跑完）和「注册机压根没开」（`registrar_disabled`：去设置里打开它）
 * 当成同一件事，而两者的处置毫无共同之处。这与那条 `must_disable_first`
 * 在批量路径上「200 一路走过去」是**同一个形状**。
 * 面板侧的映射在 `admin-ui/js/pure/registrar.mjs` 的 `refuseReasonKey()`，
 * 那里是一张逐条列出的表，表外的 `reason` 返回 `null` 而不是冒充任何一档。
 */
const REASON_IN_FLIGHT = "tend_in_flight";
const REASON_LOCKED = "locked";
const REASON_DISABLED = "registrar_disabled";
const REASON_NOT_WIRED = "not_wired";
const REASON_UNKNOWN_CHANNEL = "unknown_channel";
const REASON_CHANNEL_NOT_CONFIGURED = "channel_not_configured";

/** 两条邮箱通道。**字母序**，理由见 `admin-ui/js/pure/registrar.mjs` 的 `CHANNELS`。 */
const CHANNELS: readonly Channel[] = ["moemail", "yyds"];

function isChannel(v: unknown): v is Channel {
  return v === "moemail" || v === "yyds";
}

/**
 * 请求体**可以整个缺席**。
 *
 * `readJson()`（`src/http/errors.ts`）对空体一律 400，而 `POST /registrar/tend`
 * 从一开始就是**不带体**调用的（面板与既有用例都这样），给它加一个必填体
 * 等于把一条已经上线的端点契约改掉。这里的语义定死：**没有体 ⇒ `{}`**，
 * 有体但不是 JSON 对象 ⇒ 400（不是静默当成 `{}`——那会让 `{"chanel":"yyds"}`
 * 这种拼错变成一次「点了、按默认链跑了」的静默误操作）。
 */
async function optionalObjectBody(c: Context): Promise<Record<string, unknown>> {
  const raw = await c.req.text();
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw httpError(400, "invalid_request_error", "请求体不是合法的 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw httpError(400, "invalid_request_error", "请求体必须是一个 JSON 对象");
  }
  const o = parsed as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== "channel");
  if (extra.length > 0) {
    // 与 Key 写端点同一条纪律：拼错的字段名在宽松实现下是一次「点了、什么都没按你
    // 想的那样发生」，而面板会如实显示「已开始」。
    throw httpError(400, "invalid_request_error", `不认识的字段：${extra.join(", ")}`);
  }
  return o;
}

/**
 * 这条通道现在有没有凭据。
 *
 * 判据取 `RegistrarConfig` 里那两个 `ChannelCreds | null` 字段——它们**只对
 * 主/备通道解析**（见 `registrarFromEnv` 末尾那个循环），所以「非 null」正好等于
 * 「这条通道真的接进了本次部署」，不需要再去比一遍 primary/fallback。
 */
function channelConfigured(
  cfg: { yyds: unknown; moemail: unknown },
  channel: Channel,
): boolean {
  return (channel === "yyds" ? cfg.yyds : cfg.moemail) !== null;
}

export function manualTendHandler(deps: RegistrarDeps) {
  return async (c: Context) => {
    const now = deps.now();
    const reg = deps.configHolder.current().registrar;

    // 注册机关着时一次写都不产生（配额账那根轴：**默认部署下本任务新增的写是 0**）。
    // 判据取 `configHolder`（本请求已经刷新过）而不是再读一次存储：面板显示的
    // 「注册机：已关闭」用的就是这一份，两处必须是同一个答案。
    if (!reg.enabled) {
      return c.json({
        error: {
          type: "conflict",
          message: "注册机未启用，没有可补的池；请先在设置里打开注册机并配好至少一条邮箱通道",
        },
        reason: REASON_DISABLED,
      }, 409);
    }

    // ── 通道参数：**在动任何护栏之前校验完**（校验失败一次写都不产生）──────────
    //
    // 给了通道名 = 「只用这一条」（面板「添加 Key」菜单里【自动注册】那两项）。
    // 不给 = 按配置里的主/备通道链跑，与加通道参数之前的行为逐字相同。
    const body = await optionalObjectBody(c);
    let channel: Channel | null = null;
    if (body.channel !== undefined && body.channel !== null) {
      if (!isChannel(body.channel)) {
        return c.json({
          error: { type: "invalid_request_error", message: "channel 只能是 moemail 或 yyds" },
          reason: REASON_UNKNOWN_CHANNEL,
        }, 400);
      }
      // **没配凭据的通道当场拒绝，不放进去让它跑成一轮 `provider_missing`。**
      // 那一轮会真的消费一格日预算、起算一次 10 分钟冷却，然后在补池历史里留下
      // 一行「这一轮什么都没铸出来」——运维付了全部代价，换来的信息还不如这一句。
      if (!channelConfigured(reg, body.channel)) {
        return c.json({
          error: {
            type: "conflict",
            message: "这条通道在本次部署里没有配好凭据，没法用它补池；请先在设置里把它配上",
          },
          reason: REASON_CHANNEL_NOT_CONFIGURED,
          channel: body.channel,
        }, 409);
      }
      channel = body.channel;
    }

    // 注册机开着、执行体却没接上：这是**装配错误**，不是运行状态。如实回 503 并留一条
    // error 事件——返回 202 会让面板显示「已开始」，而实际上什么都不会发生，
    // 那正是本仓反复裁过的「面板说保存成功、其实没落盘」的同一形状。
    const wiring = deps.wiring;
    if (wiring === null) {
      deps.logger.log({
        level: "error", event: "registrar.manual_tend_not_wired",
        msg: "注册机已启用，但这个 app 没有接手动补池的执行体（装配没走 wire.ts 的 buildApp）",
      });
      return c.json({
        error: { type: "internal_error", message: "这个部署没有接上手动补池的执行体" },
        reason: REASON_NOT_WIRED,
      }, 503);
    }

    // **同步获取，之后才允许出现 `await`。** 写成「先问一句 busy() 再去 run()」就把
    // 检查与占用之间的窗口造回来了，那个形态下第二个并发请求会拿到 202 却什么都没跑。
    const leave = deps.gate.tryEnter();
    if (leave === null) {
      return c.json({
        error: { type: "conflict", message: "这个副本上已经有一轮补池在跑，请等它结束" },
        reason: REASON_IN_FLIGHT,
      }, 409);
    }

    let started = false;
    try {
      const verdict = checkManualTend(narrowManualGuard(await wiring.storage.get(MANUAL_GUARD_KEY)), now);
      if (!verdict.ok) {
        // 429 的两种 reason 措辞必须分得开：一种是「再等几分钟」，
        // 另一种是「今天的额度用完了，到 UTC 零点恢复」，处置完全不同。
        return c.json({
          error: {
            type: "rate_limit_error",
            message: verdict.reason === "write_budget_exhausted"
              ? "今天的手动补池次数已用完（这道闸挡的是存储写配额，不是邮箱名额），到期后自动恢复"
              : "两次手动补池之间至少要隔一段冷却时间，请稍后再试",
          },
          reason: verdict.reason,
          remaining: verdict.remaining,
          resetAt: verdict.resetAt,
          retryAfterMs: verdict.retryAfterMs,
          // **绝对时刻与相对时长成对给**（评审 m3）：面板拿相对量做倒计时、拿绝对时刻
          // 显示「几点恢复」，绝不让客户端自己拿本地时钟去减。冷却那一支的绝对时刻是
          // `cooldownUntil`，预算那一支的是上面那个 `resetAt`（当日 24:00）。
          ...(verdict.reason === "manual_cooldown" ? { cooldownUntil: verdict.cooldownUntil } : {}),
        }, 429);
      }

      const lock = await acquireTendLock(wiring.storage, now);
      if (!lock.ok) {
        // **抢锁失败这一支一次写都不产生**：护栏还没消费，冷却也没起算。
        return c.json({
          error: {
            type: "conflict",
            message: "另一个副本正在补池，本次没有启动（补池是顺序执行的，并发会同时撞邮箱建号限流与上游注册风控）",
          },
          reason: REASON_LOCKED,
          until: lock.until,
        }, 409);
      }

      // 护栏**在这里才落盘**，且**不传 `expiresAt`**——传了就是评审点过的那个失效读法
      //（键跟着冷却蒸发 ⇒ `used` 每 10 分钟归零 ⇒ 日预算闸永远走不到耗尽）。
      await wiring.storage.put(MANUAL_GUARD_KEY, verdict.next);

      const task = (async () => {
        try {
          await wiring.tend(channel);
        } catch (err) {
          deps.logger.log({
            level: "error", event: "registrar.manual_tend_failed",
            msg: "手动补池整轮抛错中断；面板已经回过 202，所以这条事件是运维唯一能看到它失败的地方",
            fields: { error: err instanceof Error ? err.message : String(err) },
          });
        } finally {
          // **必须在 `finally` 里。** 放进 `try` 的末尾时，一次抛错的补池会让锁留到
          // 自然过期（最长 `TEND_LOCK_TTL_MS`）才肯放下一轮进来——一次失败换一段停摆。
          try {
            await releaseTendLock(wiring.storage);
          } catch (err) {
            deps.logger.log({
              level: "warn", event: "registrar.lock_release_failed",
              msg: "释放补池锁失败，最坏情况下要等锁自然过期（期间补池会被跳过）",
              fields: { error: err instanceof Error ? err.message : String(err) },
            });
          }
          leave();
        }
      })();
      started = true;

      // 载体由注入的运行时决定：Worker 交给 `ctx.waitUntil`（不交就会被从中间砍断、
      // 临时邮箱漏删），Node 直接 fire-and-forget。差异是**被断言的**，不是被容忍的。
      deps.runtime.background(task, backgroundCtx(c));

      deps.logger.log({
        level: "info", event: "registrar.manual_tend_started",
        msg: "面板触发了一轮手动补池",
        fields: { remaining: verdict.remaining, cooldownUntil: verdict.next.cooldownUntil, channel },
      });

      // ⚠️ **`remaining` 必须在这一支也给。** 只在耗尽那一支给它，等于让运维毫不知情地
      // 撞上一堵墙——面板要**如实显示还剩几次**，而不是等到点不动了才说。
      return c.json({
        started: true,
        trigger: "manual",
        /** 这一轮**实际用哪条通道**：`null` = 按配置的主/备链。面板照实回显。 */
        channel,
        remaining: verdict.remaining,
        resetAt: verdict.resetAt,
        // 成对给，理由见 `ManualTendVerdict` 上面那段（评审 m3）。
        cooldownUntil: verdict.cooldownUntil,
        retryAfterMs: verdict.retryAfterMs,
      }, 202);
    } finally {
      // 任何一条提前返回（429 / 409 / 抛错）都要把守卫还回去，否则这个副本上的
      // 补池会被一次被拒的点击永久堵死。真的起跑之后由上面那个 `finally` 负责。
      if (!started) leave();
    }
  };
}

/**
 * `GET /admin/api/registrar/status` —— 注册机板块的唯一取数端点（设计 §11）。
 *
 * **稳态下一次存储写都不产生**，读侧是 3 次 `get`（补池历史 + 锁 + 护栏键）加一次
 * 共用 isolate 快照的 `repo.all()`，**没有 `list()`**（红线 1）。
 *
 * ⚠️ **「稳态」这个限定词是订正，不是修饰（通读评审）**：上面那句话原来是无条件的，
 * 而 `repo.all()` 有两条会 `list()` **并写索引**的支路——`bootstrapFromListThrottled()`
 *（`pool:index` 读不出来/结构损坏）与 `rescanEmptyResult()`（索引合法却一条活记录都
 * 读不到，`writeIndexBestEffort`）。**复现**：KV 里有 `key:` 记录但 `pool:index` 缺失
 *（DEPLOY.md 里「手工写记录不会自动进索引」那个场景）⇒ 冷 isolate 上第一次
 * `GET /admin/api/registrar/status` = **1 次 list + 1 次索引 put**。
 * 两条支路都有 10 分钟退避窗、都是自愈的，且这是 `repo.all()` 一直就有的固有性质，
 * 不是本端点引入的——**所以订正的是措辞，不是处置**。钉住上面那句零写的用例
 *（`tests/contract/admin-registrar.test.ts` 的「status 与通道测试在稳态下都不写存储、
 * 也不 list」）夹具是 `keys: ["sk-a"]`：索引存在且非空 ⇒ 两条支路都走不到，它量的正是稳态。
 *
 * ⚠️ **注册机关着时它照常回 200，不回 409。** 「关着」是这个端点要**报告**的状态，
 * 不是拒绝它的理由：面板要能显示「注册机：已关闭」，还要能显示关掉之前那些轮次的
 * 补池历史。这与 `tend` 那条相反的处置是刻意的——那一条会产生真实副作用。
 *
 * ⚠️ **没接线时回 `503 not_wired`，与 `tend` 同一条口径。** 补池历史、锁、护栏键
 * 全都住在 `wiring.storage` 上，没有它这个端点只能编造一份空数据——而「从来没补过池」
 * 与「这个 app 压根读不到补池记录」在面板上会长得一模一样。生产的两个入口都经
 * `wire.ts`，走不到这一支。
 */
export function registrarStatusHandler(deps: RegistrarDeps) {
  return async (c: Context) => {
    const wiring = deps.wiring;
    if (wiring === null) {
      return c.json({
        error: { type: "internal_error", message: "这个部署没有接上注册机的执行体，读不到补池记录" },
        reason: REASON_NOT_WIRED,
      }, 503);
    }

    const now = deps.now();
    const reg = deps.configHolder.current().registrar;

    /**
     * 逐块取数，**某块失败就该块返回 `null`**（与 `overviewHandler` 的 `block()` 同一条
     * 降级纪律）：补池历史读不出来时，「注册机开没开」「还剩几次」不该跟着一起消失。
     */
    const block = async <T>(fn: () => Promise<T> | T): Promise<T | null> => {
      try { return await fn(); } catch { return null; }
    };

    /**
     * ⚠️ **两处窄化的结果本身就可能是 `null`（「还没有这把键」），而 `block()` 用
     * `null` 表示「读失败」——直接混用就是把「今天一次都没点过」与「读不出护栏键」
     * 渲染成同一句话。** 前者该显示「还剩 24 次」，后者该显示 `—`。
     * 所以这两块装进一层壳：**壳是 `null` ⇒ 读失败；壳里的值是 `null` ⇒ 真的没有。**
     */
    const history = await block(async () => narrowTendHistory(await wiring.storage.get(TEND_HISTORY_KEY)));
    const lock = await block(async () => ({ v: narrowTendLock(await wiring.storage.get(TEND_LOCK_KEY)) }));
    const guard = await block(async () => ({ v: narrowManualGuard(await wiring.storage.get(MANUAL_GUARD_KEY)) }));
    const records = await block(() => deps.repo.all());

    /**
     * ⚠️ **`counted` 不叫 `available`，这是订正不是重命名洁癖。**
     *
     * 设计 §11 那一行写的是 `available`，而 `src/core/registrar/tender.ts` 的
     * `TendResult.available` 上有一整段警告：判据是 `countsTowardTarget`（`!evicted`），
     * **被停用的与正在冷却的 key 都算在里面**，而这两种恰恰都不能打上游。
     * 那段警告逐字点名了「给建补池历史板块的人：这一栏**不许按「可用」渲染**」。
     * 叫它 `available` 就是在把那条警告作废——所以这里叫 `counted`（占名额数），
     * 并**另外**给一个真正的可用数 `fresh`（`poolHealth` 的那一格，判据是
     * 「没被停用、没被剔除、不在冷却中」）。两个数字都在，各自的标签各说各的口径。
     */
    const counted = records === null ? null : records.filter((r) => countsTowardTarget(r)).length;
    const fresh = records === null ? null : poolHealth(records, now).fresh;

    return c.json({
      serverTime: now,
      enabled: reg.enabled,
      primary: reg.primary ?? null,
      fallback: reg.fallback ?? null,
      /**
       * 两条通道**各自**的接入状态。顺序在这里没有意义（JSON 对象），
       * **渲染顺序由面板的 `CHANNELS` 常量定死成字母序**，见那里的理由。
       *
       * `configured` 只说「有没有凭据」，不说「哪条更好」——设计 §10.3 第 6 条：
       * 用数据代替推荐，而「能不能用」是事实，不是偏好。
       */
      channels: Object.fromEntries(CHANNELS.map((ch) => [ch, {
        configured: channelConfigured(reg, ch),
        /**
         * 这条通道在**本次配置**里的角色。`null` = 既不是主也不是备。
         * 面板照实渲染，不做任何加权。
         */
        role: reg.primary === ch ? "primary" : (reg.fallback === ch ? "fallback" : null),
      }])),
      pool: records === null ? null : {
        target: reg.targetKeys,
        counted,
        /** 缺口 = `tendOnce` 用的那个 `need`，负数夹到 0（池子满了就是 0，不是负几把）。 */
        gap: Math.max(0, reg.targetKeys - (counted ?? 0)),
        fresh,
        /** 面板算「本次最多铸几把」要它：`rounds = min(need, mintBatch)`（`tendOnce`）。 */
        mintBatch: reg.mintBatch,
      },
      /**
       * 当前持锁方声明的到期时刻。**`null` 有两个含义，面板分不出来也不需要分**：
       * 没有锁、或者锁已经过期（判据是 `until > now` 这一处值比较，与
       * `acquireTendLock` 用的是同一条——陈旧的锁拦不住任何人，也不该在面板上
       * 显示成「正在补池」）。读失败那一支走的是下面的 `undefined ⇒ null`，
       * 与前两者渲染成同一格 `—`，代价明写在这里。
       */
      lockedUntil: lock !== null && lock.v !== null && lock.v.until > now ? lock.v.until : null,
      /**
       * 手动补池的名额视图。**只读，一格都不消费**，见 `manualTendQuota()`。
       * 面板拿 `remaining`/`perDay` 渲染「今天还可以点几次」，拿
       * `cooldownUntil`（绝对）+ `retryAfterMs`（相对）渲染倒计时。
       */
      manual: guard === null ? null : manualTendQuota(guard.v, now),
      history: history === null ? null : { entries: history.entries, malformed: history.malformed },
    });
  };
}

/**
 * `POST /admin/api/registrar/channels/:channel/test` —— 通道连通性（设计 §10.3 第 6 条）。
 *
 * **两条通道用同一个 handler、同一套返回形状、同一段文案模板**——「完全等权」这件事
 * 在这里是**结构上的**，不是靠两处代码写得一样来维持的。
 *
 * **成功那一支一次存储写都不产生**；它在那一支上唯一的副作用是一次**上游 GET**
 *（`listDomains()`），不建邮箱、不注册账号、不消耗任何活跃邮箱名额。
 *
 * ⚠️⚠️ **失败那一支不是零写，这句话原来是无条件的（通读评审）。**
 * 下面那个 `catch` 会打一条 `registrar.channel_test_failed`，而生产装配里
 * `deps.logger` 是 `multiLogger(ConsoleLogger, StoreLogger)`（`src/http/wire.ts`），
 * 事件最终要落盘。**逐格量出来的形状**（`tests/contract/admin-registrar.test.ts`
 * 的「通道测试失败那一支不是无条件零写」，假时钟 + `CountingStorage`）：
 * · 失败请求**自己**这一次：**0 次 put** —— 事件只进内存缓冲，`logFlush` 收尾的
 *   `maybeFlush()` 被 `EVENT_FLUSH_MIN_INTERVAL_MS`（60 秒）挡住；
 * · 60 秒内连续失败 9 次：**还是 0 次** —— 这一段是**批量**的，不是每次一写；
 * · 跨过 60 秒之后的下一个非 `/health` 请求：**1 次 put + 1 次 get**；
 * · 之后每次都跨 60 秒再失败 100 次：**只多 11 次**，合计 12 ——
 *   撞上 `EVENT_WRITES_PER_DAY`（每 isolate 每天 12 次）。
 * ⇒ **它吃的不是一笔新账，是事件 sink 那笔已经在配额账里记过的旧账**；
 * 这也是为什么五语言 DEPLOY.md 的「面板写操作的写侧」清单里没有这两条端点。
 *
 * ⚠️ **真正没有上界的是可观测性，不是写配额**：`EVENT_RING_SIZE = 100`，
 * 连点失败的连通性测试会把事件板块里别的诊断挤出环 —— 而运维去点这颗按钮的时候，
 * 恰恰是他最需要那些事件的时候。
 *
 * ── 那处已知缺口已经补上，护栏与单把 key 验活**共用一套** ──────────────────────
 *
 * 更早那一轮收口时这里登记着「本端点没有自己的冷却/预算护栏，这是一处已知缺口，不是
 * 『已经防住了』；真要上护栏，该与验活一起做一套共用的」。**后来就是那一次。**
 *
 * 现在两道闸落在 `deps.probeGuard` 上（`../probe-guard.ts`）：在途去重挡「连点」，
 * 最小间隔挡「按住不放」。**它是进程/isolate 内的，刻意不是存储级的**——
 * 当时不上护栏的第 ② 条理由（存储护栏要给一条零写端点新增一次无条件的写，
 * 并且要回去改五语言 DEPLOY.md 的配额账）**今天仍然成立，所以那条路仍然没走**。
 * ⇒ **配额账一个字都不用改：本次新增的写是 0。**（全局约束 13 只管「会写存储的
 * 代码路径」，而这把护栏一次都不写。）
 *
 * ⚠️ **这是一次行为变更，明写**：本端点此前连点必成功，现在同一条通道
 * 在 `PROBE_MIN_INTERVAL_MS` 内的第二次点击会拿到 **429**（顶层
 * `reason: "probe_cooldown"` / `"probe_in_flight"`）。
 * 面板侧在飞期间禁用按钮（`admin-ui/js/sec-registrar.js`）挡的是手滑连点、
 * **挡不住脚本**，那一条没变——护栏补的正是它挡不住的那一半。
 *
 * ⚠️ **它挡不住的，同样明写**：跨副本无效（N 个副本各自允许一次），
 * 与 `createTendGate()` 单独存在时挡不住另一个副本是同一句话。
 */
export function channelTestHandler(deps: RegistrarDeps) {
  return async (c: Context) => {
    const raw = c.req.param("channel");
    if (!isChannel(raw)) {
      return c.json({
        error: { type: "invalid_request_error", message: "通道只能是 moemail 或 yyds" },
        reason: REASON_UNKNOWN_CHANNEL,
      }, 400);
    }

    const reg = deps.configHolder.current().registrar;
    if (!reg.enabled) {
      return c.json({
        error: { type: "conflict", message: "注册机未启用，两条通道都没有装配，无法测试连通性" },
        reason: REASON_DISABLED,
        channel: raw,
      }, 409);
    }
    if (!channelConfigured(reg, raw)) {
      return c.json({
        error: { type: "conflict", message: "这条通道在本次部署里没有配好凭据，无法测试连通性" },
        reason: REASON_CHANNEL_NOT_CONFIGURED,
        channel: raw,
      }, 409);
    }

    const wiring = deps.wiring;
    if (wiring === null) {
      return c.json({
        error: { type: "internal_error", message: "这个部署没有接上注册机的执行体" },
        reason: REASON_NOT_WIRED,
        channel: raw,
      }, 503);
    }

    // ── 出站探测护栏（与单把 key 验活共用）─────────────────────────────────────
    //
    // **必须排在上面那四条校验之后、`probeChannel` 之前**，两个方向各有理由：
    // · 排在校验之前 ⇒ 一次拼错通道名的 400 会把这条通道锁住一个最小间隔
    //   （**明明什么都没发出去，按钮却点不动了**——与 `manualTendHandler` 里
    //   「先读护栏再抢锁」那段避开的是同一种形态）；
    // · 排在 `probeChannel` 之后 ⇒ 护栏就成了摆设，连点照样每次都真打一次外网，
    //   只是返回值被换成了 429。**判据因此是执行体被调了几次，不是状态码**，见
    //   `tests/contract/admin-verify.test.ts` 的
    //   「被 429 挡住的通道测试一次上游探测都不发 —— 判据是执行体被调了几次，不是状态码」。
    const kind = `channel:${raw}`;
    const g = deps.probeGuard.tryAcquire(kind, deps.now());
    if (!g.ok) {
      return c.json({
        error: { type: "rate_limit_error", message: g.message },
        reason: g.reason,
        channel: raw,
      }, 429);
    }

    // 计时从这里起：**只包住那一次上游调用**，不含上面几条本地判断。
    // ⚠️ **`tryAcquire` 与 `try` 之间只许剩这一行**（与 `handlers/verify.ts` 里
    // 「从这里到 `finally` 之间不许再有任何会抛的语句」那段是同一条纪律）：
    // 护栏已经占住而 `release` 在 `finally` 里，中间任何一次抛错都会把这条通道
    // 永久卡在「在飞」。`deps.now()` 是注入的取数函数、不会抛，往这里加别的之前先想一遍。
    const startedAt = deps.now();
    try {
      const probe = await wiring.probeChannel(raw);
      const latencyMs = deps.now() - startedAt;
      if (!probe.ok) {
        // 配置在这两步之间被改掉了（注册机被关、或这条通道的凭据被清空）。
        return c.json({
          error: { type: "conflict", message: "注册机的配置在这次测试期间被改掉了，本次没有测成" },
          reason: probe.reason === "registrar_disabled" ? REASON_DISABLED : REASON_CHANNEL_NOT_CONFIGURED,
          channel: raw,
        }, 409);
      }
      return c.json({ ok: true, channel: raw, domains: probe.domains, latencyMs });
    } catch (err) {
      /**
       * **上游报错不是 HTTP 错误**：`{ ok: false }` + 200。
       *
       * 两条理由：① 「测出来不通」正是这颗按钮要回答的问题，把它做成 5xx 会让面板
       * 的通用错误处理把它当成「面板自己坏了」；② 两条通道必须**同一套返回形状**，
       * 一条通的、一条不通的时候，两张卡片不该一张走成功分支一张走异常分支。
       *
       * ⚠️ **不回显上游的错误文本**：`err.message` 里可能带着请求 URL（含 baseUrl）
       * 甚至上游原样返回的响应体。面板拿 `reason` 选一句自己的文案，
       * 详情留在事件里（运维在事件板块看得到，而事件板块是鉴权后的）。
       */
      const latencyMs = deps.now() - startedAt;
      deps.logger.log({
        level: "warn", event: "registrar.channel_test_failed",
        msg: "通道连通性测试失败（只调了 listDomains，没有建邮箱也没有注册账号）",
        fields: { channel: raw, latencyMs, error: err instanceof Error ? err.message : String(err) },
      });
      return c.json({ ok: false, channel: raw, reason: "upstream_error", latencyMs });
    } finally {
      // **必须在 `finally` 里**，与 `handlers/verify.ts` 同一条理由（见
      // `../probe-guard.ts` 的 `ProbeGuard.release`）：放在成功支末尾时，
      // 一次抛错的探测会让这条通道永久卡在「在飞」——而这个 `catch` 恰恰是
      // 「上游不可达」的常态支路。
      deps.probeGuard.release(kind);
    }
  };
}
