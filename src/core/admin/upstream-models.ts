import { MODEL_CATALOG } from "./protocol-catalog.js";

/**
 * 「上游此刻有哪些模型」这件事的**取值决策**。零 IO —— 真正发请求的是
 * `src/http/admin/handlers/upstream-models.ts`（`src/core` 的零 IO 由
 * `tests/unit/source-guards.test.ts`「扫描到的使用点恰好等于手写的豁免清单」守着）。
 *
 * ⚠️⚠️ **它不是 `protocol-catalog.ts` 的替代品，两者回答的是两个问题。**
 * 协议目录回答「**本网关**支持哪些协议、哪些端点、拿哪个模型名去调」，
 * 它是集成示例卡 / Playground / 模型表 / 单把 key 验活四个消费者的单一真源；
 * 这里回答的是「**上游账号**此刻的模型清单长什么样」。
 * 拿上游的返回去替换目录，那四个消费者会立刻拿到一份**没有端点、没有协议归属**的清单
 * ——那四个消费者从此教不出任何一条能照抄的调用。⇒ **并存，并且把差集明确标出来。**
 */

/**
 * 一次拉取最多认多少个 id。
 *
 * ⚠️ **这不是"防御性编程"的装饰，它有具体的失败形态**：上游是别人家的服务，
 * 一份几万条的清单会被原样塞进 `c.json()`、原样交给调用方去画。截断的那一半由
 * `truncated` 如实交代，**不静默丢**——静默丢会让运维以为上游就这些模型。
 */
export const UPSTREAM_MODELS_MAX = 500;

export interface UpstreamModels {
  readonly ids: readonly string[];
  readonly truncated: boolean;
}

/**
 * 上游 `/models` 的响应体 → id 清单。**读不出来是 `null`，不是空数组。**
 *
 * 「上游一个模型都没有」与「这份响应我们看不懂」是两句话，而一个空数组在屏幕上
 * 与前者长得一模一样（全局约束 9 的同型，`admin-ui/js/pure/models.mjs` 的
 * `catalogModels()` 上方记着同一条）。
 *
 * ⚠️ **只认 OpenAI 那个形状**（`{ data: [{ id }] }`）。
 * ⚠️⚠️ **这个形状是推断出来的，不是实测出来的，写清楚**：手上没有一把有效的
 * Agnes key，**上游 200 的真实报文一次都没验过**；`{ object: "list", data: [{ id }] }`
 * 是按 new-api 一系的 OpenAI 兼容实现推断的。上一版这里写着「实测上游走的就是它」
 * ——那句话没有任何观测支撑。⇒ 真跑通一次之后回来把这段改成实测结论；
 * 在那之前，形状不对的那一档由下面的 `null` 兜住（`bad_payload`），
 * **它说的是「我们看不懂」，不是「上游没有模型」**。
 *
 * `data` 里混进的非对象 / 没有 `id` / `id` 不是字符串的那些**逐条跳过**——
 * 这一条与 `catalogModels()` 的「一条坏的就整份判成读不出来」**刻意相反**：
 * 那份是本仓自己的目录（坏了就是本仓的缺陷，必须整份报警），这份是别人家的清单
 * （多一条我们不认识的记录，不该让整个功能失效）。
 *
 * ⚠️⚠️ **但「逐条跳过」有一个必须堵住的尽头：一条都没抽出来。**
 * `data` 非空而 `ids` 为空时，逐条跳过的终局是一个空数组，而空数组在屏幕上
 * 说的是「上游这次一个模型都没回」——**那是一句关于上游的事实**，
 * 可我们手上只有一句关于自己的话（「这些记录我们一条都读不懂」）。
 * ⇒ 这一档回 `null`，走 `bad_payload`。**判据是「一条都没抽出来」而不是
 * 「跳过了几条」**：跳掉两条还留下三条时那三条是真的，那一档不该整份报废。
 */
export function parseUpstreamModels(payload: unknown): UpstreamModels | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const item of data) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    if (ids.length >= UPSTREAM_MODELS_MAX) { truncated = true; break; }
    seen.add(id);
    ids.push(id);
  }
  // 见上方最后一段：`data` 非空而一条 id 都没抽出来 ⇒ 这是「我们看不懂」，不是
  // 「上游没有模型」。**`data` 为空数组时不走这里**——那一档才是真的一句上游事实。
  if (data.length > 0 && ids.length === 0) return null;
  return { ids, truncated };
}

export interface CatalogDiff {
  /** 上游回了、本仓目录里没有的。 */
  readonly onlyUpstream: readonly string[];
  /** 本仓目录里有、这次上游没回的。 */
  readonly onlyCatalog: readonly string[];
}

/**
 * 与本仓协议目录的差集。**两个方向都要给**：
 * · 只有上游有 ⇒ 目录该不该补一条（补之前得先给它填协议归属与端点）；
 * · 只有目录有 ⇒ 本仓正在承诺一个上游此刻不认的模型名，那是运维照着目录会踩空的那一半。
 *
 * ⚠️ **`onlyCatalog` 不许被读成「目录写错了」**：上游按账号发模型，一把权限较窄的 key
 * 拉回来的清单本来就会短。所以呈现那一侧的措辞该是「这次上游没回」，不是「不存在」。
 */
export function diffAgainstCatalog(ids: readonly string[]): CatalogDiff {
  const upstream = new Set(ids);
  const catalog = MODEL_CATALOG.map((m) => m.id);
  return {
    onlyUpstream: ids.filter((id) => !catalog.includes(id)),
    onlyCatalog: catalog.filter((id) => !upstream.has(id)),
  };
}
