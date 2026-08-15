import { createApp } from "./app.js";
import { loadConfig } from "../core/config.js";
import { KeyPoolRepo } from "../core/dispatcher.js";
import { NativeFetcher } from "../adapters/fetcher-native.js";
import { createStorageHealth, probeWritable, watchStorage } from "../core/storage-health.js";
import { VERSION } from "../version.js";
import type { Storage } from "../ports/storage.js";
import type { Channel } from "../core/registrar/config.js";
import type { MailProvider } from "../ports/mailbox.js";
import type { TendDeps } from "../core/registrar/tender.js";
import { YydsProvider } from "../adapters/mailbox-yyds.js";
import { MoeMailProvider } from "../adapters/mailbox-moemail.js";

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

/**
 * 从环境变量与存储装配出完整的 app。两个入口（worker/node）都调用它，
 * 只在“用哪种 Storage 实现”上有区别，其余装配逻辑完全共用。
 *
 * 用 loadConfig 而不是 configFromEnv：buildApp 的调用方（两个入口）手上
 * 总是已经有一个 Storage 实例，loadConfig 能在 env 未显式设置时回退到
 * storage 中持久化的配置（例如未来的管理接口写入的覆盖值），是 configFromEnv
 * 的严格超集；没有理由在有 storage 可用时退化成只读 env 的版本。
 */
export async function buildApp(
  env: Record<string, string | undefined>,
  storage: Storage,
  options: BuildOptions = {},
) {
  const storageHealth = createStorageHealth();
  // 包一层之后，后续所有写操作（key 池状态回写、启动探测）的成败都会自动反映到
  // /health 上，健康检查自身不需要再写盘。
  const watched = watchStorage(storage, storageHealth, () => Date.now());

  if (options.probeStorage) {
    const err = await probeWritable(watched, storageHealth, () => Date.now());
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

  const config = await loadConfig(env, watched);
  return createApp({
    version: VERSION,
    config,
    repo: new KeyPoolRepo(watched),
    fetcher: new NativeFetcher(),
    now: () => Date.now(),
    storageHealth,
  });
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
  const config = await loadConfig(env, storage);
  const reg = config.registrar;
  if (!reg.enabled) return null;

  const fetcher = new NativeFetcher();
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const now = () => Date.now();

  const providers: Partial<Record<Channel, MailProvider>> = {};
  if (reg.yyds) providers.yyds = new YydsProvider({ fetcher, ...reg.yyds, sleep, now });
  if (reg.moemail) providers.moemail = new MoeMailProvider({ fetcher, ...reg.moemail, sleep, now });

  return {
    repo: new KeyPoolRepo(storage),
    config: reg,
    providers,
    agnes: { fetcher, platformUrl: reg.agnesPlatformUrl },
    now,
    sleep,
    rand: Math.random,
  };
}
