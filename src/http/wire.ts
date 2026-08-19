import type { Hono } from "hono";
import { createApp } from "./app.js";
import { createConfigHolder, type ConfigHolder } from "./config-holder.js";
import { loadConfig } from "../core/config.js";
import { KeyPoolRepo } from "../core/keypool-repo.js";
import { NativeFetcher } from "../adapters/fetcher-native.js";
import { createStorageHealth, probeWritable, watchStorage } from "../core/storage-health.js";
import { VERSION } from "../version.js";
import type { Storage } from "../ports/storage.js";
import type { Channel } from "../core/registrar/config.js";
import type { MailProvider } from "../ports/mailbox.js";
import type { TendDeps } from "../core/registrar/tender.js";
import { YydsProvider } from "../adapters/mailbox-yyds.js";
import { MoeMailProvider } from "../adapters/mailbox-moemail.js";
import { ConsoleLogger } from "../adapters/logger-console.js";
import type { Logger } from "../ports/logger.js";

export interface BuildOptions {
  /**
   * 装配时探一次存储可写性（写一个探针键再删掉）。
   *
   * 只有 Node/Docker 形态该开：那里的数据目录是绑定挂载，属主不匹配就整个网关不可用，
   * 必须在启动那一刻就发现。Worker/KV 形态没有这个失败模式，而 worker 入口在每个隔离体
   * 冷启动时都会重新装配一次 app，开着它等于把 KV 的写配额消耗在健康检查上。
   */
  probeStorage?: boolean;
}

/** buildApp 的返回值。两个入口都需要 configHolder：node.ts 用它取 registrar.tendIntervalMs
 * 建定时器，不必为此再单独读一次存储（见下面 buildApp 的说明）。 */
export interface BuiltApp {
  app: Hono;
  configHolder: ConfigHolder;
  /**
   * app 实际在用的那个 key 池仓储。
   *
   * 交出来的理由有两个，都不是「为了测试方便」：
   * ① P3c 的面板写完 key 之后要调 `repo.invalidate()`，而它必须是**这一个**实例
   *    ——另建一个实例调 invalidate 是纯粹的空操作，快照仍然是旧的。
   * ② 不交出来的话，「两个池子旋钮有没有真的接到 app 的 repo 上」就只能靠在测试里
   *    照抄一遍 wire.ts 的装配来验证，而照抄的那份永远验证不了原件（变异实测：
   *    把这两行删掉，全套测试逃逸）。
   */
  repo: KeyPoolRepo;
}

/**
 * 从环境变量与存储装配出完整的 app。两个入口（worker/node）都调用它，
 * 只在“用哪种 Storage 实现”上有区别，其余装配逻辑完全共用。
 *
 * 用 loadConfig 而不是 configFromEnv：buildApp 的调用方（两个入口）手上
 * 总是已经有一个 Storage 实例，loadConfig 能在 env 未显式设置时回退到
 * storage 中持久化的配置（例如未来的管理接口写入的覆盖值），是 configFromEnv
 * 的严格超集；没有理由在有 storage 可用时退化成只读 env 的版本。
 *
 * 返回值带上 `configHolder`（而不只是 `app`）：调用方若还需要读一次配置
 * （目前只有 node.ts 的定时器要取 `registrar.tendIntervalMs`），复用这一份
 * 而不是自己再调一次 loadConfig——那样会产生第二次独立的存储读取，且很容易
 * 忘记传 logger，导致配置告警在生产里静默消失（P3a Task 1 评审登记的隐患）。
 */
export async function buildApp(
  env: Record<string, string | undefined>,
  storage: Storage,
  options: BuildOptions = {},
): Promise<BuiltApp> {
  const storageHealth = createStorageHealth();
  const logger: Logger = new ConsoleLogger();
  // 包一层之后，后续所有写操作（key 池状态回写、启动探测）的成败都会自动反映到
  // /health 上，健康检查自身不需要再写盘。
  const watched = watchStorage(storage, storageHealth, () => Date.now());

  if (options.probeStorage) {
    const err = await probeWritable(watched, storageHealth, () => Date.now(), logger);
    if (err) {
      console.error(
        `[agnes2api] 数据目录不可写，key 池无法持久化，/health 将报告 degraded：${err.message}`,
      );
      console.error(
        "[agnes2api] Docker 绑定挂载常见原因：宿主 ./data 的属主与容器内运行用户不一致。" +
          "本镜像的 entrypoint 会以 root 启动并 chown 数据目录后再降权，若仍不可写，请检查该目录是否只读或位于不支持 chown 的文件系统。",
      );
    }
  }

  const configHolder = await createConfigHolder({ env, storage: watched, logger, now: () => Date.now() });
  // **这两个旋钮是建 app 时读一次的**，不随 ConfigHolder 每次刷新而变：它们绑定的是
  // 部署形态（活跃 isolate 数 × 池大小），不是逐次生效的策略。改了要重启容器 /
  // 等 isolate 回收——`.env.example` 与五语言 DEPLOY.md 都写明了，面板文案同样不许
  // 写「立即生效」。
  const cfg = configHolder.current();
  const repo = new KeyPoolRepo(watched, {
    now: () => Date.now(), logger,
    cacheTtlMs: cfg.poolCacheTtlMs,
    touchIntervalMs: cfg.poolTouchIntervalMs,
  });
  const app = createApp({
    version: VERSION,
    configHolder,
    repo,
    fetcher: new NativeFetcher(),
    now: () => Date.now(),
    storageHealth,
    logger,
    // **只从环境变量读、不从存储读**：面板不该能改自己的钥匙。没配就整棵 /admin
    // 树不注册（404），但网关照常转发——注册机默认关闭时不让网关起不来是同一条规矩。
    adminToken: env.ADMIN_TOKEN,
    // 只有部署者显式声明自己在反代后面才信 X-Forwarded-For：这个值会写进登录失败
    // 事件，无脑信任等于允许任何人把爆破痕迹嫁祸给别人。
    trustProxy: env.TRUST_PROXY === "1",
  });
  return { app, configHolder, repo };
}

/**
 * 为 `tendOnce` 装配依赖。注册机未启用（`registrar.enabled=false`，默认状态）时
 * 在构造任何 provider 之前就返回 `null`——两个入口据此判断要不要起调度
 * （Worker 的 `scheduled` 导出 / Node 的定时器），未启用时不会产生触达邮箱/Agnes
 * 侧的网络请求（`loadConfig` 本身仍会读一次存储，对 Worker/KV 形态而言是一次
 * 真实的 KV 读取，不在此列）。
 *
 * 不复用 `buildApp` 内部 watchStorage 包过的存储：补池失败已经由调用方各自
 * 的 try/catch 兜底并打日志（见两个入口），不需要接入 `/health` 的可写性
 * 探测——那是网关转发能力的信号，与补池能力相互独立。
 */
export async function buildTendDeps(
  env: Record<string, string | undefined>,
  storage: Storage,
): Promise<TendDeps | null> {
  const logger: Logger = new ConsoleLogger();
  const config = await loadConfig(env, storage, logger);
  const reg = config.registrar;
  if (!reg.enabled) return null;

  const fetcher = new NativeFetcher();
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const now = () => Date.now();

  const providers: Partial<Record<Channel, MailProvider>> = {};
  if (reg.yyds) providers.yyds = new YydsProvider({ fetcher, ...reg.yyds, sleep, now, logger });
  if (reg.moemail) providers.moemail = new MoeMailProvider({ fetcher, ...reg.moemail, sleep, now, logger });

  return {
    repo: new KeyPoolRepo(storage, {
      now, logger,
      // **补池必须看当前真实的可用数**：读一份最多一个 TTL 前的快照会把缺口算错，
      // 别的实例（或面板）刚加进去的 key 还没进本进程的快照 ⇒ 重复补池 ⇒ 白烧邮箱
      // 配额（YYDS 15 个 / MoeMail 30 个上限），而每一次补池都是一次真实的 Agnes
      // 建号，同时撞注册风控与建号限流。它每 30 分钟才跑一次，多付 1+N 次读完全
      // 不是问题。
      cacheTtlMs: 0,
    }),
    config: reg,
    providers,
    agnes: { fetcher, platformUrl: reg.agnesPlatformUrl },
    now,
    sleep,
    rand: Math.random,
    logger,
  };
}
