import { describe, it, expect } from "vitest";
import { makeApp, TEST_ADMIN_TOKEN } from "../helpers/make-app.js";
import { CountingStorage } from "../helpers/counting-storage.js";
import { MAX_IMPORT_KEYS, MAX_NOTE_LENGTH, PATCH_FIELDS } from "../../src/http/admin/handlers/keys-write.js";
import { MAX_KEY_LENGTH } from "../../src/core/keypool-repo.js";
import type { KeyView } from "../../src/core/admin/key-view.js";
import type { KeyRecord, KeyStats } from "../../src/core/types.js";
import {
  ADMIN_ERROR_CODES, ADMIN_ERROR_PARAMS, type AdminErrorCode,
} from "../../src/core/admin/admin-errors.js";

/**
 * Key 池的四条写端点。
 *
 * **contract ⇒ node 与 workerd 各跑一遍**（两份 vitest 配置的 include 都收
 * `tests/contract`）。
 *
 * 本文件的三条主线，每一条都对应一个**今天没有任何其它自动化守着**的性质：
 *   · **重复导入**：不许静默重置状态（「重新导入即解封」是个后门）；
 *   · **`note` 的写消除**：一次「只改备注」的写会被整个丢掉，而
 *     `tests/unit/pool-cache.test.ts` 的
 *     「MAY_ELIDE 的每个字段变化都被消除——这才是写消除的全部收益」
 *     在「修对了」和「写错了」两种情况下**都是绿的**（评审实证）
 *     ——护栏只能长在这里；
 *   · **写端点看的是当前真值**，不是最多一个 `POOL_CACHE_TTL_MS` 前的快照。
 */
const NOW = 1000;
const AUTH_HEADERS = { "x-admin-key": TEST_ADMIN_TOKEN };
const AUTH = { headers: AUTH_HEADERS };
const JSON_AUTH = { ...AUTH_HEADERS, "content-type": "application/json" };

type App = Awaited<ReturnType<typeof makeApp>>["app"];

interface KeysBody {
  items: KeyView[];
  total: number;
  counts: { all: number; fresh: number; cooling: number; evicted: number; disabled: number };
}

async function send(app: App, method: string, path: string, body?: unknown): Promise<Response> {
  return await app.request(path, {
    method,
    headers: body === undefined ? AUTH_HEADERS : JSON_AUTH,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 读回列表。**写端点的每一条断言最后都落到这里**——读的是真正存下去的那份。 */
async function getKeys(app: App): Promise<KeysBody> {
  const res = await app.request("/admin/api/keys", AUTH);
  expect(res.status, "GET /admin/api/keys").toBe(200);
  return await res.json() as KeysBody;
}

async function viewOf(app: App, id: string): Promise<KeyView> {
  const v = (await getKeys(app)).items.find((x) => x.id === id);
  expect(v, `列表里找不到 ${id}`).toBeDefined();
  return v as KeyView;
}

/**
 * ⚠️ **`invalid` 是 `number[]` 不是 `string[]`，这不是笔误**：前两个数组装 id、
 * 它装的是**输入里的位置**（1 基）。三个都写成 `string[]` 时类型完全一样，
 * 前端没有任何东西能提醒它「这一个不是 id 数组」（评审发现）。
 * `reset` 是**被重置的把数**，与 `duplicated.length` 不是一回事，见下面那一格。
 */
interface ImportBody { added: string[]; duplicated: string[]; invalid: number[]; reset: number }

// ───────────────────────────────────────────────────────────────────────────
// POST /admin/api/keys —— 批量导入
// ───────────────────────────────────────────────────────────────────────────

/**
 * **三个边界常量本身就是策略，必须被独立钉住。**
 *
 * ⚠️ **评审实测：把 `MAX_IMPORT_KEYS` 改成 500、`MAX_NOTE_LENGTH` 改成 5000，
 * tsc=0，全量 1636 条一条不红。** 成因是三处边界用例当时都写成
 * `MAX_IMPORT_KEYS + 1` —— 输入从被测的那个常量推导出来，**改了常量输入跟着改**，
 * 于是永远测不到那个数字本身。本仓已有一条同名纪律：
 * `tests/ui/format.test.ts` 的「边界值写字面量，不写 THRESHOLD ± 1（第 6 种假阳性）」。
 *
 * 后果不是洁癖：五份 DEPLOY.md 白纸黑字写着「一次最多 **200** 把 ⇒ 单次点击上界
 * **201** 次 put，两成日写配额」，而 `docs-parity` 只校验**五份文档彼此一致**、
 * **不校验文档与代码一致** ⇒ 这三个数一旦改动，那批"实测读数"会在零信号下与代码脱钩。
 * **这一格就是那个 `201` 在代码这一端的锚。**
 */
describe("边界常量", () => {
  it("三个边界常量写字面量钉死 —— 五语言 DEPLOY.md 的 201 是它的另一端", () => {
    expect({ MAX_IMPORT_KEYS, MAX_NOTE_LENGTH, MAX_KEY_LENGTH }).toEqual({
      MAX_IMPORT_KEYS: 200, MAX_NOTE_LENGTH: 200, MAX_KEY_LENGTH: 1024,
    });
  });
});

describe("POST /admin/api/keys（批量导入）", () => {
  /**
   * **判据是 put 计数，不是结果正确性。**
   *
   * 循环调 `add()` 的那个实现**结果完全正确**（key 都进去了、索引也对），
   * 它只是贵 3 倍：`add()` 是「1 次记录 put + 1 次索引读 + 1 次索引 put」，
   * 20 把就是 40 次 put 打在一个每天 1,000 次的写桶上。所以任何基于响应体的断言
   * 都区分不了这两个实现，只有数次数能。
   *
   * **期望值一律手写字面量**：写成 `keys.length + 1` 就是从被测对象自己推导期望值
   * （本仓登记的第 6 种假阳性），循环版实现照样满足它。
   */
  it("一次导入 20 把 key 只产生 21 次 put（20 条记录 + 1 次索引），且零 list", async () => {
    const st = new CountingStorage();
    const { app } = await makeApp([], ["sk-seed-key-for-index-00"], {}, () => NOW, { storage: st });
    const base = { puts: st.puts, gets: st.gets, lists: st.lists };

    const keys = Array.from({ length: 20 }, (_, i) => `sk-bulk-import-${String(i).padStart(4, "0")}`);
    const res = await send(app, "POST", "/admin/api/keys", { keys });
    expect(res.status).toBe(200);
    expect((await res.json() as ImportBody).added).toHaveLength(20);

    expect(st.puts - base.puts, "20 条记录 + 1 次索引；循环调 add() 会是 40 次").toBe(21);
    expect(st.lists - base.lists, "导入路径出现了 list()——它与转发共用同一个每天 1,000 次的桶").toBe(0);
    // 读侧同样如实钉住：1 次索引读 + 每把 key 一次「这个 id 在不在」的存在性探测。
    // 那 20 次读正是那个后门的判据（见下面「索引缺失时」那一格），不是可以省掉的开销。
    expect(st.gets - base.gets, "1 次索引 + 20 次存在性探测").toBe(21);
  });

  /**
   * ── 那个后门本体 ───────────────────────────────────────────────────────
   *
   * `keyId` 是内容哈希，同一把 key 恒得同一个 id。重复粘贴若走覆盖，
   * `strikes` / `cooldownUntil` / `evicted` 会被一次性清零而**没有任何提示**
   * ——那就是一个「重新导入即可解封」的隐藏后门。
   *
   * 夹具刻意让**三个字段各自取不同的值**（`strikes: 7`、`cooldownUntil` 是个
   * 具体时刻、`evicted: true`）：三者同为「默认值 / 非默认值」的话，覆盖实现下
   * 谁被清零都分不出来（第 1 种假阳性）。
   */
  it("重复导入不许清零 strikes / cooldownUntil / evicted —— 那是「重新导入即解封」后门", async () => {
    const st = new CountingStorage();
    const KEY = "sk-duplicate-import-target";
    const { app, repo } = await makeApp([], [KEY], {}, () => NOW, { storage: st });
    const r = (await repo.all())[0] as KeyRecord;
    await repo.save({
      ...r,
      strikes: 7, cooldownUntil: NOW + 50_000, cooldownReason: "rate limited",
      evicted: true, evictedReason: "upstream 401",
    }, r);

    const base = { puts: st.puts, deletes: st.deletes };
    const res = await send(app, "POST", "/admin/api/keys", { keys: [KEY] });
    expect(res.status).toBe(200);
    const body = await res.json() as ImportBody;
    expect({ added: body.added, duplicated: body.duplicated, invalid: body.invalid })
      .toEqual({ added: [], duplicated: [r!.id], invalid: [] });

    const v = await viewOf(app, r!.id);
    expect(
      { strikes: v.strikes, cooldownUntil: v.cooldownUntil, bucket: v.bucket, reason: v.evictedReason },
      "重复导入把状态洗掉了 —— 这正是那个后门",
    ).toEqual({ strikes: 7, cooldownUntil: NOW + 50_000, bucket: "evicted", reason: "upstream 401" });

    // 重复项**一次盘都不落**：记录不写（跳过），索引集合没变（`sameIdSet` 短路）。
    expect({ puts: st.puts - base.puts, deletes: st.deletes - base.deletes }).toEqual({ puts: 0, deletes: 0 });
  });

  /**
   * **重复判定建在「记录在不在」上，不建在索引上。**
   *
   * 拿索引当判据的话，索引缺失/损坏时已知集合是空的 ⇒ **整池每一把都被当成新 key
   * 覆盖一遍** ⇒ 那个后门从另一扇门原样回来。而索引读不出来恰恰是写桶被打穿
   * 时的常态（`pool:index` 一直建不起来），也就是最可能有人去重新导入的时刻。
   */
  it("索引缺失时重复项照样被认出来 —— 判据是记录在不在，不是索引说什么", async () => {
    const KEY = "sk-index-missing-target-x";
    const { app, repo, storage } = await makeApp([], [KEY], {}, () => NOW);
    const r = (await repo.all())[0] as KeyRecord;
    await repo.save({ ...r, strikes: 5, evicted: true, evictedReason: "upstream 403" }, r);
    await storage.delete("pool:index");
    expect(await storage.get("pool:index"), "前置条件：索引真的没了").toBeNull();

    const res = await send(app, "POST", "/admin/api/keys", { keys: [KEY] });
    expect((await res.json() as ImportBody).duplicated, "索引没了就把老 key 当成新的").toEqual([r!.id]);
    const v = await viewOf(app, r!.id);
    expect({ strikes: v.strikes, bucket: v.bucket }).toEqual({ strikes: 5, bucket: "evicted" });
    // 顺带：索引被重建回来了，那把 key 没变成孤儿。
    expect(await storage.get("pool:index")).toEqual({ v: 1, ids: [r!.id] });
  });

  /**
   * `resetExisting: true` 是一条**正当**的「重新导入即解封」路径——它把后门变成了
   * 一个要显式勾选的知情动作。但它同时意味着**一个能调这个端点的人可以绕过
   * `evicted`**，所以它必须留痕：事件板块是运维唯一能看到「池子为什么变了」的地方。
   *
   * 同一格还钉住 `disabled` **不**被它清掉：那是运维自己按下的开关（当时的裁定），
   * 让一次粘贴顺手把它翻回去，等于把「停用一把可疑 key」这个安全动作静默撤销。
   */
  it("勾了 resetExisting 才重置，且必须留下 key.restored 事件；disabled 不在重置范围里", async () => {
    const st = new CountingStorage();
    const KEY = "sk-reset-existing-target-";
    const { app, repo, logger } = await makeApp([], [KEY], {}, () => NOW, { storage: st });
    const r = (await repo.all())[0] as KeyRecord;
    await repo.save({
      ...r, strikes: 4, cooldownUntil: NOW + 9_000, cooldownReason: "payment required",
      evicted: true, evictedReason: "upstream 401", disabled: true,
    }, r);
    logger.clear();
    const base = st.puts;

    const res = await send(app, "POST", "/admin/api/keys", { keys: [KEY], resetExisting: true });
    expect(res.status).toBe(200);
    // 五语言 DEPLOY.md 里「勾了重置之后每把已存在的 key 各 1 次 put」那一句的读数：
    // 1 条记录，索引集合没变 ⇒ 索引不写。
    expect(st.puts - base, "重置的写侧单价").toBe(1);
    expect((await res.json() as ImportBody).duplicated).toEqual([r!.id]);

    const v = await viewOf(app, r!.id);
    expect({ strikes: v.strikes, cooldownUntil: v.cooldownUntil, evictedReason: v.evictedReason })
      .toEqual({ strikes: 0, cooldownUntil: 0, evictedReason: null });
    expect(
      { disabled: v.disabled, bucket: v.bucket },
      "重置顺手把运维自己按下的停用开关也翻回去了",
    ).toEqual({ disabled: true, bucket: "disabled" });

    const e = logger.entries.find((x) => x.event === "key.restored");
    expect(e, "知情重置没有留痕：事件板块里看不出池子为什么变了").toBeDefined();
    expect(e?.fields?.reset).toBe(1);
  });

  /**
   * **`resetExisting` 那条分支「不传 prev」的理由，必须有一格会红的东西守着。**
   *
   * ⚠️ **评审发现：那句话第一版是写死在注释里、没人验过的断言，而且当时 ESCAPED**
   * ——把它改成 `save({...}, existing)`，tsc=0、全量**一条不红**；它自己又不含
   * `scripts/check-comment-refs.mjs` 那张词表里的任何一个词 ⇒ 门禁也看不见它。
   *
   * 夹具必须是「**干净** + `lastUsedAt` 近期有值」：干净 ⇒ 重置改不动任何 scheduling
   * 字段 ⇒ 写消除的白名单判据为真；近期用过 ⇒ `lastUsedAt` 没走远。**两条都满足才是
   * 写消除会咬的那个形态**，这也正是「勾了重置却什么都没落盘」在生产上的样子。
   */
  it("resetExisting 对一把干净的 key 也必须真的落盘 —— 传 prev 会被写消除吃掉", async () => {
    const st = new CountingStorage();
    const KEY = "sk-reset-clean-target-aa";
    const { app, repo } = await makeApp(
      [], [KEY],
      // 生产默认值。夹具默认的 0 会把写消除整个关掉，那样这一格两种写法都绿。
      { poolTouchIntervalMs: 21_600_000, poolCacheTtlMs: 0 }, () => NOW, { storage: st },
    );
    const r = (await repo.all())[0] as KeyRecord;
    await repo.save({ ...r, lastUsedAt: NOW }, r);   // 首次落 lastUsedAt 必写盘
    const base = st.puts;

    const res = await send(app, "POST", "/admin/api/keys", { keys: [KEY], resetExisting: true });
    expect(res.status).toBe(200);
    expect((await res.json() as ImportBody).reset, "前置：这一把确实走了重置那条分支").toBe(1);
    expect(
      st.puts - base,
      "重置一把干净的 key 被写消除整个吃掉了 —— 面板会说「已重置 1 把」而存储一个字节没动",
    ).toBe(1);
  });

  /**
   * **`resetExisting` 不许动 `stats`，这是「重新导入即解封」那个后门的收口结论
   * 在计数这一侧的另一半。**
   *
   * `src/core/keypool-repo.ts` 里 `resetExisting` 上方逐字写着「`stats`——用量是历史，
   * 不是失败态」，而在那之前**没有任何一格守着它**：真把
   * `stats: { ...EMPTY_STATS }` 加进那个字段集，全量一条不红。
   * Task 31A 新增的 `clearStats` 恰好让这条边界第一次有了被抹掉的动机
   * （「都是清零，顺手一起清了吧」）⇒ 它必须在这一侧留一条绊线。
   *
   * ⚠️ **同一格必须同时钉住「重置确实做了它该做的」**：只断言「`stats` 没动」的话，
   * 一个**什么都不重置**的实现照样满足它（第 1 种假阳性的镜像）。
   */
  it("resetExisting 只重置失败态，`stats` 一个数都不许动 —— 用量是历史，不是失败态", async () => {
    const KEY = "sk-reset-keeps-stats-key";
    const { app, repo, storage } = await makeApp([], [KEY], {}, () => NOW);
    const r = (await repo.all())[0] as KeyRecord;
    // 六个计数各取**互不相同**的非默认值：全取同一个数时，「把 stats 整块换成另一份」
    // 这种实现分不出来。
    const SEEDED: KeyStats = {
      requests: 41, success: 37, failed: 3, clientErrors: 1,
      lastErrorAt: NOW - 5, lastErrorKind: "upstream_5xx",
    };
    await storage.put(`key:${r.id}`, {
      ...r, strikes: 4, cooldownUntil: NOW + 9_000, cooldownReason: "payment required",
      evicted: true, evictedReason: "upstream 401", stats: SEEDED,
    });

    const res = await send(app, "POST", "/admin/api/keys", { keys: [KEY], resetExisting: true });
    expect(res.status).toBe(200);
    expect((await res.json() as ImportBody).reset, "前置：这一把确实走了重置那条分支").toBe(1);

    const after = await storage.get<KeyRecord>(`key:${r.id}`) as KeyRecord;
    expect(
      after.stats,
      "一次导入把这把 key 的用量历史抹掉了 —— 重置的是**系统判定的失败态**，"
      + "而用量是历史。要清计数请走 `PATCH /admin/api/keys/:id` 的 `clearStats`："
      + "那是一个知情的、单把的动作，不是粘一遍清单的副作用",
    ).toEqual(SEEDED);
    expect(
      { strikes: after.strikes, evicted: after.evicted, cooldownUntil: after.cooldownUntil },
      "前置条件塌了：重置压根没生效 ⇒ 上面那句「stats 没动」是靠「整条都没动」满足的",
    ).toEqual({ strikes: 0, evicted: false, cooldownUntil: 0 });
  });

  /**
   * **「被重置了几把」这个数字要说的是「本批之前就已经在池子里」的那些。**
   *
   * 本批刚新建的那把即使被粘了两遍也谈不上重置。夹具把两种重复都摆上：
   * 一把**已存在**的 key 粘 3 遍 + 一把**新** key 粘 2 遍 ⇒ `duplicated` 有 4 条，
   * 而 `reset` 只有 1。写成 `duplicated.length` 的话这里会读到 4。
   */
  it("reset 计数只算本批之前就在池子里的那些，不是 duplicated 的条数", async () => {
    const OLD = "sk-reset-count-old-key-aa";
    const NEW = "sk-reset-count-new-key-bb";
    const { app, repo, logger } = await makeApp([], [OLD], {}, () => NOW);
    const r = (await repo.all())[0] as KeyRecord;
    await repo.save({ ...r, evicted: true, evictedReason: "upstream 401" }, r);
    logger.clear();

    const res = await send(app, "POST", "/admin/api/keys", {
      keys: [OLD, OLD, OLD, NEW, NEW], resetExisting: true,
    });
    const body = await res.json() as ImportBody;
    expect(
      { added: body.added.length, duplicated: body.duplicated.length, invalid: body.invalid.length },
      "三个数组必须逐条对应输入：5 行进来，5 条出去",
    ).toEqual({ added: 1, duplicated: 4, invalid: 0 });
    expect(logger.entries.find((x) => x.event === "key.restored")?.fields?.reset).toBe(1);
    // **同一个数字必须同时出现在响应体里**（评审发现）：只写进事件的话，面板要么显示
    // `duplicated.length`（这里是 4，**撒谎**），要么在前端把这条判据再实现一遍。
    // 一个动作两个数字，正是面板开始撒谎的方式。
    expect(body.reset, "算出来的那个诚实数字没有交到面板手上").toBe(1);
    expect(body.duplicated.length, "前置：两个数字确实不相等，否则这一格证明不了什么").toBe(4);
  });

  /**
   * **约束 11(a)：请求体里必然有明文（导入就是干这个的），响应体里一次都不许有。**
   *
   * 断言的是**整段响应文本**，不是某个字段——后者对「顺手塞进 echo / raw / debug
   * 字段」这种实现完全无感。非法的那一条同样要检查：它是最容易被顺手原样回显的
   * 一条（「告诉用户是哪一行错了」听起来天经地义）。
   */
  it("响应体整段文本里都找不到明文 key —— 合法的那条与非法的那条都不许回显", async () => {
    const { app } = await makeApp([], ["sk-seed-key-for-index-00"], {}, () => NOW);
    const res = await send(app, "POST", "/admin/api/keys", {
      keys: ["sk-goodPROBEONEgood-tail", "sk-badPROBETWO bad-tail"],
    });
    const text = await res.text();
    expect(text, "新导入的明文 key 泄漏进了响应体").not.toContain("PROBEONE");
    expect(text, "非法的那一条被原样回显了").not.toContain("PROBETWO");
    // 反向自检：这条响应确实说了那两把 key 的事，不是因为整个是空的才「没泄漏」。
    const body = JSON.parse(text) as ImportBody;
    expect({ added: body.added.length, invalid: body.invalid.length }).toEqual({ added: 1, invalid: 1 });
    // 非法项回报的是**输入里的位置**（1 基）：面板的导入框是逐行粘贴的，
    // 「第 2 行不合法」比一段掩码更能让人直接去改那一行；而且这样一来
    // 「明文出不去」是 `addMany` 的结构性性质，不是响应拼装时的自觉。
    expect(body.invalid, "非法项要报出它在输入里的位置").toEqual([2]);
  });

  /**
   * 非法项的判据：**可打印 ASCII 且不含空白**。
   *
   * 物理理由是 key 只有一个用途——拼进 `authorization: Bearer <key>`，而码点
   * > U+00FF 与 NUL/CR/LF 在构造 `Headers` 时直接抛 TypeError ⇒ 那是一把**每次被
   * 选中都让转发炸掉**的 key，而它在面板上看起来完全正常。在门口拒掉，比让它进池子
   * 之后靠 strike 慢慢冷却下去诚实得多。
   *
   * ⚠️ **不可见字符一律 `String.fromCharCode` 拼**，不往源码里粘裸字符：本仓被
   * 「源文件里的裸 NUL 让整份文件对 git diff / grep / scan-secrets 隐身」咬过一次。
   */
  it("非法的 key 进 invalid：内含空格 / 换行 / NUL / 汉字 / 超长，一条都不许落盘", async () => {
    const st = new CountingStorage();
    const { app } = await makeApp([], ["sk-seed-key-for-index-00"], {}, () => NOW, { storage: st });
    const base = st.puts;
    const cases = [
      "sk-two keys-on-one-line",
      `sk-with${String.fromCharCode(0x0a)}newline`,
      `sk-with${String.fromCharCode(0x00)}nul`,
      "sk-含汉字的-key-aaaaaaaa",
      // 超长：字面量 1025，不写 `MAX_KEY_LENGTH + 1`（理由见「边界常量」那组）。
      "x".repeat(1025),
    ];
    const res = await send(app, "POST", "/admin/api/keys", { keys: cases });
    const body = await res.json() as ImportBody;
    expect({ added: body.added, duplicated: body.duplicated }).toEqual({ added: [], duplicated: [] });
    // 位置逐条对上：漏掉中间某一条时，只断言条数是发现不了的。
    expect(body.invalid).toEqual([1, 2, 3, 4, 5]);
    expect(st.puts - base, "一条都不该进池子，连索引都不该写").toBe(0);
    // 反向：正好 1024 是放行的那一侧（这一次会真的落盘，所以放在计数断言之后）。
    expect((await send(app, "POST", "/admin/api/keys", { keys: ["x".repeat(1024)] })).status).toBe(200);

    // 反向：首尾空白只是粘贴事故，去掉之后是一把好 key，不许被判成非法。
    const ok = await send(app, "POST", "/admin/api/keys", { keys: ["  sk-padded-but-fine-key  "] });
    expect((await ok.json() as ImportBody).added).toHaveLength(1);
  });

  /**
   * **空行整条跳过，不进任何一个数组——这一格把前端的口径定死在这里。**
   *
   * ⚠️ **评审发现：第一版把空行判成非法项，那让前端只剩两个都不对的选项**：
   * 原样发 ⇒ 文本框末尾那个换行被报成「第 N 行不合法」，一条**用户没犯过的错误**；
   * 先过滤空行 ⇒ 位置与运维眼里的行号**错位**，而位置正是它唯一的用途。
   * 现在两难没了：**前端原样发（一行一个元素，空行也发），位置就是行号。**
   */
  it("空行整条跳过：末尾换行不报错，而位置仍是原始行号", async () => {
    const st = new CountingStorage();
    const { app } = await makeApp([], ["sk-seed-key-for-index-00"], {}, () => NOW, { storage: st });
    const base = st.puts;
    // 这就是一个文本框按行拆出来的样子：中间有空行、末尾有一个换行留下的空元素。
    const res = await send(app, "POST", "/admin/api/keys", {
      keys: [
        "sk-blank-line-good-key-1",   // 1
        "",                            // 2  空行
        "sk-two words-bad-line",       // 3  非法
        "   ",                         // 4  只有空白，等同空行
        "sk-blank-line-good-key-2",    // 5
        "",                            // 6  末尾换行留下的
      ],
    });
    const body = await res.json() as ImportBody;
    expect(body.added, "两把好 key 都该进去").toHaveLength(2);
    expect(
      body.invalid,
      "空行被报成了非法项 ⇒ 面板会显示一条用户没犯过的错误；或者位置没按原始行号算",
    ).toEqual([3]);
    // 三个数组加起来 + 空行数 = 输入条数（2 + 0 + 1 + 3 = 6）。
    expect(body.added.length + body.duplicated.length + body.invalid.length).toBe(3);
    // 空行不落盘：2 条记录 + 1 次索引。
    expect(st.puts - base).toBe(3);
  });

  /** 边界值一律**字面量 200 / 201**，不写 `MAX_IMPORT_KEYS ± 1`（理由见「边界常量」那组）。 */
  it("正好 200 把放行、201 把一律 400，不静默截断（截断会让人以为全导进去了）", async () => {
    const st = new CountingStorage();
    const { app } = await makeApp([], ["sk-seed-key-for-index-00"], {}, () => NOW, { storage: st });
    const mk = (n: number) => Array.from({ length: n }, (_, i) => `sk-boundary-${i}`);

    const base = st.puts;
    expect((await send(app, "POST", "/admin/api/keys", { keys: mk(201) })).status).toBe(400);
    expect(st.puts - base, "拒绝之前先写了一半").toBe(0);
    // 反向那一格：正好 200 把必须放行，否则"上限是 200"这句话只被证了一半。
    expect((await send(app, "POST", "/admin/api/keys", { keys: mk(200) })).status).toBe(200);
  });

  it.each([
    ["请求体是数组", []],
    ["keys 缺席", {}],
    ["keys 不是数组", { keys: "sk-one-key" }],
    ["keys 里混着非字符串", { keys: ["sk-fine-key-aaaa", 42] }],
    ["resetExisting 不是布尔", { keys: [], resetExisting: "yes" }],
    ["多了不认识的字段", { keys: [], overwrite: true }],
  ])("请求体形状不对时 400：%s", async (_name, body) => {
    const { app } = await makeApp([], ["sk-seed-key-for-index-00"], {}, () => NOW);
    expect((await send(app, "POST", "/admin/api/keys", body)).status).toBe(400);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DELETE /admin/api/keys/:id
// ───────────────────────────────────────────────────────────────────────────

describe("DELETE /admin/api/keys/:id", () => {
  /**
   * 「必须先停用才能删」（设计 §11）。删除**不可撤销**——记录里那把 key 材料就此
   * 消失，没有任何地方还留着它；而停用随时可以撤销。
   *
   * **判据是 `!disabled && !evicted`，两条都不成立才拦。** 只看 `evicted` 的话，
   * 一把健康的 key 永远删不掉，运维只能去手工改存储，而那条路绕过整个面板。
   */
  it("健康的 key 直接删返回 409 must_disable_first，且一次盘都不落", async () => {
    const st = new CountingStorage();
    const { app, repo } = await makeApp([], ["sk-delete-guard-target-a"], {}, () => NOW, { storage: st });
    const r = (await repo.all())[0] as KeyRecord;
    const base = { puts: st.puts, deletes: st.deletes };

    const res = await send(app, "DELETE", `/admin/api/keys/${r!.id}`);
    expect(res.status).toBe(409);
    // `reason` 是设计 §11 逐字定死的机器可读判别字段：面板要靠它选五语言文案，
    // 靠解析 message 里的中文是不行的。
    expect((await res.json() as { reason: string }).reason).toBe("must_disable_first");
    expect(
      { puts: st.puts - base.puts, deletes: st.deletes - base.deletes },
      "只断言状态码抓不住「先删了再返回 409」",
    ).toEqual({ puts: 0, deletes: 0 });
    expect((await getKeys(app)).counts.all, "记录还在").toBe(1);
  });

  /**
   * 两条放行路径**各测一格**，且夹具刻意让两个字段取不同的值
   * （`disabled=true,evicted=false` 与 `disabled=false,evicted=true`）：
   * 两个都 true 那一格谁赢都通过，是本仓的第 1 种假阳性。
   */
  it.each([
    ["先停用", { disabled: true } as Partial<KeyRecord>],
    ["已被系统剔除（不必再停用一次）", { evicted: true, evictedReason: "upstream 401" } as Partial<KeyRecord>],
    ["既停用又剔除", { disabled: true, evicted: true, evictedReason: "upstream 401" } as Partial<KeyRecord>],
  ])("%s 之后删得掉：204、记录真的没了、索引也摘干净了", async (_name, patch) => {
    const { app, repo, storage, logger } = await makeApp([], ["sk-delete-ok-target-aaa"], {}, () => NOW);
    const r = (await repo.all())[0] as KeyRecord;
    await repo.save({ ...r, ...patch }, r);
    logger.clear();

    const res = await send(app, "DELETE", `/admin/api/keys/${r!.id}`);
    expect(res.status).toBe(204);
    expect(await res.text(), "204 不许带响应体").toBe("");
    expect(await storage.get(`key:${r!.id}`), "记录还在存储里").toBeNull();
    expect(await storage.get("pool:index")).toEqual({ v: 1, ids: [] });
    expect((await getKeys(app)).counts.all).toBe(0);
    const del = logger.entries.find((x) => x.event === "key.deleted");
    expect(del?.fields?.id).toBe(r!.id);
    // 删除不可撤销，运维事后问「池子怎么少了一把」时按 warn 筛也必须看得见。
    expect(del?.level, "删除记成了 info").toBe("warn");
  });

  /**
   * **单把写操作的存储开销，逐桶数清楚。**
   *
   * 全局约束 13 要求「凡是新增一个会写存储的代码路径，同一个提交里必须更新五语言
   * DEPLOY.md 的配额账」——而那份账里的每个数字都得是**某次实测的读数**。
   * 这一格就是那次实测：五份 DEPLOY.md 里「面板写操作」那一段的数字直接抄它。
   */
  it("单把写操作的存储开销：PATCH 的每个字段各 1 get + 1 put（逐个数过），DELETE = 2 get + 1 put + 1 delete", async () => {
    const st = new CountingStorage();
    const { app, repo } = await makeApp([], ["sk-single-op-cost-key-a"], {}, () => NOW, { storage: st });
    const r = (await repo.all())[0] as KeyRecord;
    const snap = () => ({ gets: st.gets, puts: st.puts, deletes: st.deletes, lists: st.lists });
    const since = (b: ReturnType<typeof snap>) => ({
      gets: st.gets - b.gets, puts: st.puts - b.puts,
      deletes: st.deletes - b.deletes, lists: st.lists - b.lists,
    });

    // **逐个字段各数一遍，而不是数一个推而广之。**
    // 五份 DEPLOY.md 那一行现在写的是「上面每一项都同价」——**每一项**，
    // 而"同一个 handler ⇒ 同价"只是个推论，推论要有读数背书：哪天某一支多读一次存储，
    // 那句话会在零信号下变假。
    // ⚠️ 这里原来只数 `disabled` 与 `clearStats` 两支，文档那半句却写着「六个动作同价」
    // ——一个手抄自 `PATCH_FIELDS` 今天长度的数，表长一格它就成假话而没有任何东西会红
    //（复评发现）。现在数的是 `PATCH_FIELDS` 本身，**表长一格这一格当场红**。
    const SAMPLE: Record<string, unknown> = {
      disabled: true, note: "配额账要数的那条备注", clearCooldown: true,
      clearStrikes: true, unevict: true, clearStats: true,
    };
    expect(
      PATCH_FIELDS.filter((f) => !(f in SAMPLE)),
      "`PATCH_FIELDS` 长了一格而这张样值表没跟上 —— 那一支的单价从此没人数过，"
      + "而五份 DEPLOY.md 那句「上面每一项都同价」是按整张表说的",
    ).toEqual([]);
    for (const field of PATCH_FIELDS) {
      const base = snap();
      expect(
        (await send(app, "PATCH", `/admin/api/keys/${r.id}`, { [field]: SAMPLE[field] })).status,
        `PATCH { ${field} } 没返回 200 —— 样值表里那个值对不上这个字段的类型？`,
      ).toBe(200);
      expect(
        since(base),
        `PATCH { ${field} }：应当是 1 次「读当前真值」+ 1 次落盘，与别的动作同价 —— `
        + "对不上就说明五份 DEPLOY.md「改一把 key」那一笔配额账里的「上面每一项都同价」不再成立",
      ).toEqual({ gets: 1, puts: 1, deletes: 0, lists: 0 });
    }
    let base = snap();

    base = snap();
    expect((await send(app, "DELETE", `/admin/api/keys/${r.id}`)).status).toBe(204);
    expect(since(base), "DELETE：1 次校验读 + 1 次索引读 + 1 条记录删 + 1 次索引写")
      .toEqual({ gets: 2, puts: 1, deletes: 1, lists: 0 });
  });

  /**
   * **同一条「读当前真值」的判据，落在更不可挽回的那条路上。**
   *
   * `DELETE` 的前置条件（必须先停用/已剔除）同样建在 `repo.get()` 上。读快照的话，
   * 存储里刚被系统判成 `evicted` 的那把 key，在陈旧快照里还是「健康的」⇒ 409，
   * 面板上显示着「已剔除」却删不掉，而运维完全看不出为什么。
   *
   * 只补 `PATCH` 那一格、不补这一格，就是「守住了罕见路径、放掉了常见路径」：
   * 两条路走的是同一个 `repo.get`，而删除是后果不可撤销的那一条。
   */
  it("DELETE 的前置条件也读当前真值：存储里已 evicted 就删得掉，哪怕快照还说它健康", async () => {
    const { app, repo, storage } = await makeApp(
      [], ["sk-delete-truth-vs-snap"], { poolCacheTtlMs: 60_000 }, () => NOW,
    );
    await getKeys(app);                       // 预热快照
    const r = (await repo.all())[0] as KeyRecord;
    await storage.put(`key:${r.id}`, { ...r, evicted: true, evictedReason: "upstream 401" });
    expect(
      (await repo.all())[0]!.evicted,
      "本 isolate 的快照没有保持陈旧 ⇒ 本格没有判别力",
    ).toBe(false);

    expect(
      (await send(app, "DELETE", `/admin/api/keys/${r.id}`)).status,
      "读的是快照 ⇒ 这把 key 看起来还很健康 ⇒ 409",
    ).toBe(204);
    expect(await storage.get(`key:${r.id}`)).toBeNull();
  });

  it("删一个不存在的 id 是 404（而不是 204 装作删掉了）", async () => {
    const { app } = await makeApp([], ["sk-delete-404-other-key"], {}, () => NOW);
    expect((await send(app, "DELETE", "/admin/api/keys/deadbeefdeadbeef")).status).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PATCH /admin/api/keys/:id
// ───────────────────────────────────────────────────────────────────────────

describe("PATCH /admin/api/keys/:id", () => {
  /**
   * ⚠️⚠️ **端到端那一半照留，但它守的东西后来换了个位置——两半都要写清楚。**
   *
   * **早期**：`note` 在写消除的黑名单式判据下与 `lastUsedAt` 同档，一次
   * 「只改备注」的写同时满足两条判据（scheduling 字段没变 + `lastUsedAt` 没走远）
   * ⇒ 传 `prev` 就被**整个丢掉**：面板显示保存成功，备注既不在存储也不在快照。
   * 那时这一格是全仓唯一能报警的地方，靠的是 `keyPatchHandler` **记得不传 `prev`**。
   *
   * **后来**：写消除的判据翻成白名单（`MAY_ELIDE_FIELDS = ["lastUsedAt","stats"]`），
   * `note` 不在里面 ⇒ **传不传 `prev` 都不会再丢备注**。所以下面那个对照组的期望
   * **反过来了**：同一个「写消除会咬」的夹具上，一次传 `prev` 的「只改备注」现在
   * 必须真的落 1 次盘。
   *
   * **本格的判别力来自三个前置条件，缺一它就是在测空气**：
   *   ① 夹具把 `poolTouchIntervalMs` 开成生产默认值（夹具默认是 `0` = 关掉写消除，
   *      那样每一次写都落盘，两个方向都测不出来）；
   *   ② 目标 key **最近被用过**（`lastUsedAt` 为 `null` 时差值是 `Infinity`，
   *      写消除根本不触发）——写消除只咬**正在服役**的那些 key；
   *   ③ **两个方向各一次**：只改 `note` 必须落盘（新机制），只推 `lastUsedAt`
   *      必须被消除（写消除的全部收益还在）。**只写前者的话，把写消除整个关掉
   *      也能让它变绿**——那正是"覆盖的状态让被测的选择不可观测"。
   */
  it("只改备注的 PATCH：改完之后 GET 真的读得回来（而只推 lastUsedAt 仍然被消除）", async () => {
    const st = new CountingStorage();
    const { app, repo } = await makeApp(
      [], ["sk-note-target-aaaaaaaa", "sk-note-control-bbbbbbb"],
      // 生产默认值。夹具默认的 0 会把写消除整个关掉，那样这一格在两种写法下都绿。
      { poolTouchIntervalMs: 21_600_000, poolCacheTtlMs: 0 }, () => NOW, { storage: st },
    );
    const [target, control] = await repo.all() as [KeyRecord, KeyRecord];
    // 前置条件②：两把都变成「最近用过」。首次落 `lastUsedAt` 一定会写盘（差值是
    // Infinity），这一步本身不受写消除影响。
    await repo.save({ ...target, lastUsedAt: NOW }, target);
    await repo.save({ ...control, lastUsedAt: NOW }, control);

    // 前置条件③之一（新机制）：同一个夹具上，**传 prev** 的「只改备注」真的落盘。
    const control2 = (await repo.all()).find((x) => x.id === control.id) as KeyRecord;
    const beforeNote = st.puts;
    await repo.save({ ...control2, note: "对照组：这次写从判据翻成白名单起不许被消除" }, control2);
    expect(
      st.puts - beforeNote,
      "只改备注的写又被写消除吃掉了 —— MAY_ELIDE_FIELDS 里混进了 note？",
    ).toBe(1);

    // 前置条件③之二（写消除的收益还在）：同一个夹具上，只推 `lastUsedAt` 仍然 0 次写。
    // **没有这一半，把写消除整个关掉上面那个 1 也照样成立。**
    const control3 = (await repo.all()).find((x) => x.id === control.id) as KeyRecord;
    const beforeTouch = st.puts;
    await repo.save({ ...control3, lastUsedAt: NOW + 1 }, control3);
    expect(
      st.puts - beforeTouch,
      "夹具没能触发写消除 ⇒ 上面那个 1 什么都没证明",
    ).toBe(0);

    const NOTE = "换了下游客户，先停着";
    const res = await send(app, "PATCH", `/admin/api/keys/${target.id}`, { note: NOTE });
    expect(res.status).toBe(200);

    expect((await viewOf(app, target.id)).note, "只改备注的写被写消除吃掉了").toBe(NOTE);
    // 对照组那条备注确实也落了盘（新机制的端到端一半）。
    expect((await viewOf(app, control.id)).note).toBe("对照组：这次写从判据翻成白名单起不许被消除");
  });

  it("note: null 清空备注；备注超长 400", async () => {
    const { app, repo } = await makeApp([], ["sk-note-clear-target-aa"], {}, () => NOW);
    const r = (await repo.all())[0] as KeyRecord;
    expect((await send(app, "PATCH", `/admin/api/keys/${r.id}`, { note: "先记一笔" })).status).toBe(200);
    expect((await viewOf(app, r!.id)).note).toBe("先记一笔");
    expect((await send(app, "PATCH", `/admin/api/keys/${r!.id}`, { note: null })).status).toBe(200);
    expect((await viewOf(app, r!.id)).note).toBeNull();
    // 边界值写字面量 200 / 201，不写 `MAX_NOTE_LENGTH ± 1`。
    expect((await send(app, "PATCH", `/admin/api/keys/${r.id}`, { note: "x".repeat(200) })).status).toBe(200);
    expect((await send(app, "PATCH", `/admin/api/keys/${r.id}`, { note: "x".repeat(201) })).status).toBe(400);
  });

  /**
   * **写操作必须看当前真值。** `repo.get(id)` 是直接读存储的（绕过 isolate 快照），
   * 这是对的，但它是一条**没有第二处实现**的选择——将来有人「顺手优化」成从
   * `all()` 的快照里找，写操作就会建立在一份最多一个 `POOL_CACHE_TTL_MS` 前的视图上。
   *
   * 夹具复现的正是生产上真会发生的那一幕：**别的 isolate（或运维手工）刚把这把 key
   * 判成 `evicted`，本 isolate 的快照还不知道**。此时一次「停用」若基于快照，
   * 就会把那条剔除判定原样覆盖回去 —— 一把上游已经拒绝的凭据被悄悄复活。
   */
  it("PATCH 读的是存储里的当前真值，不是最多一个 TTL 前的快照", async () => {
    const { app, repo, storage } = await makeApp(
      [], ["sk-truth-vs-snapshot-aa"], { poolCacheTtlMs: 60_000 }, () => NOW,
    );
    await getKeys(app);                       // 预热快照
    const [r] = await repo.all() as [KeyRecord];
    await storage.put(`key:${r.id}`, {
      ...r, evicted: true, evictedReason: "upstream 401", strikes: 7,
    });
    expect(
      (await repo.all())[0]!.evicted,
      "本 isolate 的快照没有保持陈旧 ⇒ 本格没有判别力",
    ).toBe(false);

    expect((await send(app, "PATCH", `/admin/api/keys/${r.id}`, { disabled: true })).status).toBe(200);

    const v = await viewOf(app, r.id);
    expect(
      { evictedReason: v.evictedReason, strikes: v.strikes, disabled: v.disabled },
      "写操作基于陈旧快照 ⇒ 别的 isolate 刚写下的 evicted / strikes 被覆盖掉了",
    ).toEqual({ evictedReason: "upstream 401", strikes: 7, disabled: true });
  });

  it("五个动作各自生效：停用 / 启用 / 清冷却 / 清 strikes / 解除剔除", async () => {
    const { app, repo } = await makeApp([], ["sk-patch-actions-target"], {}, () => NOW);
    const r = (await repo.all())[0] as KeyRecord;
    const path = `/admin/api/keys/${r.id}`;
    await repo.save({
      ...r, disabled: true, strikes: 6,
      cooldownUntil: NOW + 30_000, cooldownReason: "rate limited",
      evicted: true, evictedReason: "upstream 401",
    }, r);

    // 三个布尔开关传 false 时**等于没传**（它们是动作不是状态，不会反过来加冷却）。
    expect((await send(app, "PATCH", path, {
      clearCooldown: false, clearStrikes: false, unevict: false,
    })).status).toBe(200);
    let v = await viewOf(app, r!.id);
    expect({ strikes: v.strikes, cooldownUntil: v.cooldownUntil, disabled: v.disabled })
      .toEqual({ strikes: 6, cooldownUntil: NOW + 30_000, disabled: true });

    expect((await send(app, "PATCH", path, {
      disabled: false, clearCooldown: true, clearStrikes: true, unevict: true,
    })).status).toBe(200);
    v = await viewOf(app, r!.id);
    expect({
      strikes: v.strikes, cooldownUntil: v.cooldownUntil, cooldownReason: v.cooldownReason,
      disabled: v.disabled, evictedReason: v.evictedReason, bucket: v.bucket,
    }).toEqual({
      strikes: 0, cooldownUntil: 0, cooldownReason: null,
      disabled: false, evictedReason: null, bucket: "fresh",
    });
  });

  it("停用打 key.disabled、解除限制打 key.restored、只改备注不打事件", async () => {
    const { app, repo, logger } = await makeApp([], ["sk-patch-events-target-"], {}, () => NOW);
    const r = (await repo.all())[0] as KeyRecord;
    const path = `/admin/api/keys/${r.id}`;

    logger.clear();
    await send(app, "PATCH", path, { disabled: true });
    expect(logger.entries.find((x) => x.event === "key.disabled")?.fields?.id).toBe(r!.id);
    expect(logger.has("key.restored")).toBe(false);

    logger.clear();
    await send(app, "PATCH", path, { disabled: false });
    expect(logger.entries.find((x) => x.event === "key.restored")?.fields?.enabled).toBe(true);
    expect(logger.has("key.disabled")).toBe(false);

    logger.clear();
    await send(app, "PATCH", path, { note: "只改备注，池子没有任何变化" });
    expect(
      logger.entries.filter((x) => x.event.startsWith("key.")),
      "备注不改变池子的任何行为，事件板块说的是池子为什么变了",
    ).toEqual([]);
  });

  it.each([
    ["空 patch（什么都没改却回 200 就是一次假的「保存成功」）", {}],
    ["字段名打错", { disbaled: true }],
    ["disabled 不是布尔", { disabled: "true" }],
    ["note 不是字符串", { note: 42 }],
  ])("请求体形状不对时 400：%s", async (_name, body) => {
    const { app, repo } = await makeApp([], ["sk-patch-400-target-aaa"], {}, () => NOW);
    const r = (await repo.all())[0] as KeyRecord;
    expect((await send(app, "PATCH", `/admin/api/keys/${r.id}`, body)).status).toBe(400);
  });

  // ── clearStats：那条承诺过的「经过 repo 的正式重置路径」──
  //
  // 五份 DEPLOY.md 在 `POOL_TOUCH_INTERVAL_MS` 那一行同步承诺过它，面板完成时
  // `PATCH_FIELDS` 里却没有 stats ⇒ 五份齐说一句假话。裁定「做」与它的形态
  // （加一个字段，**不做**危险区第三颗按钮）写死在设计小节「第三颗按钮的去向」里。

  /** 六个计数全零，就是重置之后该有的样子。**写字面量**：从 `EMPTY_STATS` 派生等于拿实现当期望值。 */
  const ZEROED: KeyStats = {
    requests: 0, success: 0, failed: 0, clientErrors: 0, lastErrorAt: null, lastErrorKind: null,
  };

  /**
   * **① 逐字段比对，不是「只看 stats 归零」。**
   *
   * 只断言 `stats` 归零的话，一个把整条记录覆盖成新建态的实现照样满足它，
   * 而那样会顺手抹掉 `resetExisting` 明列刻意不动的那四样
   * （`disabled` / `addedAt` / `stats` / `note`）——那正是「重新导入即解封」
   * 那个后门的收口结论。所以这一格拿**整条记录**做等值比对：
   * 除 `stats` 之外任何一个字段被动了，它当场红并把那个字段指出来。
   *
   * 夹具让每个字段各取一个**非默认**值：全是默认值时，「整条记录被重建」与
   * 「只清了 stats」在断言上分不出来（本仓登记的第 1 种假阳性）。
   */
  it("clearStats：stats 归零，而 disabled / addedAt / note / cooldownUntil / evicted 逐字段不变", async () => {
    const { app, repo, storage } = await makeApp([], ["sk-clear-stats-target-a"], {}, () => NOW);
    const r0 = (await repo.all())[0] as KeyRecord;
    const SEEDED: KeyRecord = {
      ...r0,
      addedAt: NOW - 86_400_000,
      lastUsedAt: NOW - 1_000,
      disabled: true,
      note: "运维写给自己看的话，重置用量不该动它",
      cooldownUntil: NOW + 30_000,
      cooldownReason: "rate limited",
      evicted: true,
      evictedReason: "upstream 401",
      strikes: 5,
      stats: {
        requests: 41, success: 37, failed: 3, clientErrors: 1,
        lastErrorAt: NOW - 5, lastErrorKind: "upstream_5xx",
      },
    };
    await storage.put(`key:${r0.id}`, SEEDED);

    expect((await send(app, "PATCH", `/admin/api/keys/${r0.id}`, { clearStats: true })).status).toBe(200);

    const after = await storage.get<KeyRecord>(`key:${r0.id}`) as KeyRecord;
    expect(after.stats, "clearStats 之后计数没有归零 —— 这条路径压根没做事").toEqual(ZEROED);
    // 五个字段单独再点一次名：整条比对红的时候报文是一整条记录的 diff，
    // 而这一格的报文直接说出「是这五样里的哪一样被动了」。
    expect(
      {
        disabled: after.disabled, addedAt: after.addedAt, note: after.note,
        cooldownUntil: after.cooldownUntil, evicted: after.evicted,
      },
      "重置用量顺手动了别的字段 —— `resetExisting` 刻意不动的正是这几样，"
      + "把它们一起清掉就是把「重新导入即解封」那个后门从另一扇门放回来",
    ).toEqual({
      disabled: true, addedAt: NOW - 86_400_000, note: "运维写给自己看的话，重置用量不该动它",
      cooldownUntil: NOW + 30_000, evicted: true,
    });
    // 整条记录：上面那五样之外的字段（`key` / `id` / `strikes` / `lastUsedAt` /
    // `cooldownReason` / `evictedReason`）同样一个字节都不许动。
    expect(after, "除 stats 之外还有字段被动了").toEqual({ ...SEEDED, stats: ZEROED });
  });

  /**
   * **② 「经过 repo」那半句的绊线。**
   *
   * `src/core/keypool-repo.ts` 有一份 `pendingStats` 基线：被写消除吃掉的计数增量
   * 攒在里面，而**运行中的实例记着自己那份 `entry.base`**。绕过 repo 直接改存储
   * ⇒ 先看到清零、随后被下一次真落盘按基线顶回旧值——那正是五份 DEPLOY.md
   * 那一行描述的现象，也正是那句承诺要求「经过 repo」的原因。
   *
   * 走 PATCH 这条路时 `save()` **不传 `prev`**，而它的「新建」分支头一行就是
   * `pendingStats.delete(next.id)` ⇒ 基线与增量一并作废。
   *
   * ⚠️ **判别力全在最后那一格**：重置**当时**存储里是零，这一条在「基线没清」的
   * 实现下**也是绿的**（不传 prev 的分支直接把 `next` 原样 put 下去，根本不看基线）。
   * 会红的是重置之后**下一次本来就会发生的真落盘**：基线还在的话，那一次会写成
   * `base(1) + 攒着的(2) + 本次(1) = 4`。
   *
   * 三个前置条件缺一它就是在测空气，每一条都当场断言：
   *   ① `poolTouchIntervalMs` 开成生产默认值（夹具默认 `0` = 写消除整个关掉）；
   *   ② 目标 key **最近被用过**（`lastUsedAt` 为 `null` 时差值是 `Infinity`，不触发消除）；
   *   ③ 被消除的那两笔**真的没落盘**，且存储里确实还停在重置前的旧值。
   */
  it("clearStats 之后再来一次真落盘，不许把重置前攒着的增量补写回去", async () => {
    const st = new CountingStorage();
    const { app, repo, storage } = await makeApp(
      [], ["sk-clear-stats-pending-x"],
      // 前置条件①。夹具默认的 0 会把写消除整个关掉，那样这一格在两种实现下都绿。
      { poolTouchIntervalMs: 21_600_000, poolCacheTtlMs: 0 }, () => NOW, { storage: st },
    );
    const r0 = (await repo.all())[0] as KeyRecord;
    const path = `key:${r0.id}`;
    const counted = (n: number): KeyStats => ({
      requests: n, success: n, failed: 0, clientErrors: 0, lastErrorAt: null, lastErrorKind: null,
    });

    // 前置条件②：首次落 `lastUsedAt` 一定会写盘（差值是 Infinity），这一笔进存储。
    let cur: KeyRecord = { ...r0, lastUsedAt: NOW, stats: counted(1) };
    await repo.save(cur, r0);

    // 接着两笔「只推 lastUsedAt + 计数」的写：被写消除吃掉，增量攒进 pendingStats。
    const beforeElided = st.puts;
    for (const [tick, n] of [[1, 2], [2, 3]] as const) {
      const next: KeyRecord = { ...cur, lastUsedAt: NOW + tick, stats: counted(n) };
      await repo.save(next, cur);
      cur = next;
    }
    // 前置条件③：这两笔**真的**被吃掉了，且存储还停在 1。
    expect(st.puts - beforeElided, "夹具没能触发写消除 ⇒ 后面那一格什么都没证明").toBe(0);
    expect(
      (await storage.get<KeyRecord>(path))?.stats?.requests,
      "存储里已经是新值 ⇒ 那两笔没被攒起来，本格失去判别力",
    ).toBe(1);

    expect((await send(app, "PATCH", `/admin/api/keys/${r0.id}`, { clearStats: true })).status).toBe(200);
    const afterReset = await storage.get<KeyRecord>(path) as KeyRecord;
    // 这一条在两种实现下都绿（见上面那段 ⚠️），留着是因为它是下一步的前置条件。
    expect(afterReset.stats, "重置这一次自己就没落盘").toEqual(ZEROED);

    // 重置之后**下一次本来就会发生的真落盘**（改了 scheduling 字段 ⇒ 必写）。
    await repo.save({ ...afterReset, strikes: 1, lastUsedAt: NOW + 3, stats: counted(1) }, afterReset);
    expect(
      (await storage.get<KeyRecord>(path))?.stats?.requests,
      "重置前攒在 `pendingStats` 里的基线与增量被补写回来了 —— 面板会先显示 0、"
      + "随后被顶回旧值，那正是这条路径本来要修的那个 bug",
    ).toBe(1);
  });

  /**
   * **③ 它刻意不打事件——把这个选择钉下来，而不是让它悬着。**
   *
   * 事件白名单（设计 §7.2）里没有「用量被清零」这一条，而事件板块的口径是
   * 「池子为什么变了」：`stats` 在 `FIELD_ROLE` 里是 telemetry，清零不改变任何调度
   * 行为，这与「只改备注不打事件」是同一把尺子。
   * **代价明写**：面板上那把 key 的计数会突然掉到 0 而事件板块里没有痕迹。
   * 将来要改成打事件，先回设计 §7.2 把白名单加上，再来改这一格。
   */
  it("clearStats 不打事件 —— 与「只改备注不打事件」同一把尺子，代价登记在 handler 的注释里", async () => {
    const { app, repo, logger } = await makeApp([], ["sk-clear-stats-events-a"], {}, () => NOW);
    const r = (await repo.all())[0] as KeyRecord;
    logger.clear();
    expect((await send(app, "PATCH", `/admin/api/keys/${r.id}`, { clearStats: true })).status).toBe(200);
    expect(
      logger.entries.filter((x) => x.event.startsWith("key.")),
      "重置用量打了事件 —— 要么改这一格，要么先回设计 §7.2 把白名单加上",
    ).toEqual([]);
  });

  /**
   * **④ 「那个实例不会再把旧值顶回去」那半句的真实射程（复评实测订正）。**
   *
   * 改话之前五份 DEPLOY.md 与本文件对应的 handler 注释都写着「所以**那个实例**不会
   * 再把旧值顶回去」。**那是一句假话**：`dispatch` 开头 `repo.all()` 交出的是
   * **每请求一份的浅拷贝**（`src/core/keypool-repo.ts` 的 `all()` 末尾 `[...cur]`），
   * 重置不会回头改已经发出去的那一份；重置**之前**就取到 records 的那个请求收尾时走
   * `repo.save(updated, records[at])`，`save()` 同 id 分支第一行的 `trackBaseline`
   * 会拿**重置前的那份 `stats`** 重新建出 `entry.base` ⇒ 落盘 = 旧基线 + 本次增量。
   * 屏幕上那个 0 会在一个请求的时间里自己跳回去，**与「别的实例」无关，同一个进程内就够**。
   *
   * ⚠️ **这一格钉的是今天真实的行为，不是它「应该」的样子。** 它没有被修：要修得在 repo
   * 里给「刚重置过」立一个不吸收 `seen` 的标记，而 `trackBaseline` 恰恰靠吸收
   * `seen` 才不会把别的 isolate 写得更高的计数压回去——同一个旋钮的两个方向。
   * 这条代价现在五份 DEPLOY.md、handler 注释、设计文档三处逐份写着，
   * **哪天有人真把它修好了，这一格会红**——那时候要改的是这一格与那三处文字，别删了了事。
   */
  it("clearStats 之后，重置前就在飞的那个请求收尾时会把旧基线顶回来一次（登记在案的代价）", async () => {
    const { app, repo, storage } = await makeApp([], ["sk-clear-stats-inflight"], {}, () => NOW);
    const r0 = (await repo.all())[0] as KeyRecord;
    const path = `key:${r0.id}`;
    const counted = (n: number): KeyStats => ({
      requests: n, success: n, failed: 0, clientErrors: 0, lastErrorAt: null, lastErrorKind: null,
    });

    // 一次真落盘：存储 requests = 1，本实例的 `entry.base` 也推到 1。
    await repo.save({ ...r0, lastUsedAt: NOW, stats: counted(1) }, r0);
    expect(
      (await storage.get<KeyRecord>(path))?.stats?.requests,
      "前置条件：这一笔没落盘 ⇒ 后面几条什么都没证明",
    ).toBe(1);

    // **在飞请求手上的那一份**——就是 `dispatch` 里的 `records[at]`。
    const inFlight = (await repo.all())[0] as KeyRecord;
    expect(
      inFlight.stats?.requests,
      "夹具拿到的不是重置前的那一份 ⇒ 这一格测的就不是在飞窗口",
    ).toBe(1);

    expect((await send(app, "PATCH", `/admin/api/keys/${r0.id}`, { clearStats: true })).status).toBe(200);
    expect((await storage.get<KeyRecord>(path))?.stats?.requests, "重置这一次自己就没落盘").toBe(0);

    // 那个在飞请求收尾。prev 取自重置**之前**，这正是 commit 那一行的真实形态。
    await repo.save({ ...inFlight, strikes: 1, lastUsedAt: NOW + 1, stats: counted(2) }, inFlight);
    expect(
      (await storage.get<KeyRecord>(path))?.stats?.requests,
      "在飞窗口的回弹不见了 —— 要么是有人真把它修好了（那就回来改这一格、"
      + "并把五份 DEPLOY.md / handler 注释 / 设计文档里那条代价一起改掉），"
      + "要么是这个夹具不再打在那个窗口上",
    ).toBe(2);
  });

  /**
   * **⑤ ④ 的反向控制，也是改话之后那半句话的正面锚。**
   *
   * 五份 DEPLOY.md 现在写的是「**在这次重置之后才开始的请求**不会把旧值顶回去」。
   * 这一格就是那半句：同一条链路、同一个 repo 实例，唯一的差别是这个请求的 `prev`
   * 取自重置**之后**。没有它，④ 只证明了「会回弹」，而**改话之后那半句本身仍然没有锚**。
   */
  it("clearStats 之后新开始的请求收尾，落盘的就是重置后的真实计数（不回弹）", async () => {
    const { app, repo, storage } = await makeApp([], ["sk-clear-stats-after-x"], {}, () => NOW);
    const r0 = (await repo.all())[0] as KeyRecord;
    const path = `key:${r0.id}`;
    const counted = (n: number): KeyStats => ({
      requests: n, success: n, failed: 0, clientErrors: 0, lastErrorAt: null, lastErrorKind: null,
    });

    await repo.save({ ...r0, lastUsedAt: NOW, stats: counted(1) }, r0);
    expect((await storage.get<KeyRecord>(path))?.stats?.requests, "前置条件：这一笔没落盘").toBe(1);
    expect((await send(app, "PATCH", `/admin/api/keys/${r0.id}`, { clearStats: true })).status).toBe(200);

    // **重置之后才开始**的请求：它的 records 是重置之后读到的。
    const fresh = (await repo.all())[0] as KeyRecord;
    expect(fresh.stats?.requests, "夹具读到的还是重置前那份 ⇒ 这一格就退化成 ④ 了").toBe(0);
    await repo.save({ ...fresh, strikes: 1, lastUsedAt: NOW + 1, stats: counted(1) }, fresh);
    expect(
      (await storage.get<KeyRecord>(path))?.stats?.requests,
      "重置之后新开始的请求也被顶回了旧值 —— 那样五份 DEPLOY.md 现在那半句就又是假话了",
    ).toBe(1);
  });

  /**
   * **⑥ 屏幕上那两处「请求数」会当场对不上，这一格把那件事钉下来（复评发现）。**
   *
   * `clearStats` 清的是 `KeyRecord.stats`，而概览页的 Tier-1 池级聚合就是
   * `sumStats(records.map((r) => r.stats))`（`src/http/admin/handlers/overview.ts`）
   * ⇒ **重置一把 key，概览那四个计数当场跟着掉**。
   * 而「用量」板块的 Tier-2 时间序列住在 `usage:*` 键里、与 `KeyRecord.stats` 无关，
   * **一个数都不掉**——这一格用「这次 PATCH 到底写了哪几把键」把后半句钉住：
   * 只写 `key:<id>` 一把，`usage:*` 一个字节都没碰。
   * 两个数字在同一屏上从此对不上，这条代价写在设计文档「重置到底重置了什么」那一节的补记里。
   */
  it("clearStats 之后：概览的 Tier-1 计数当场跟着掉，而这次 PATCH 只写了 `key:<id>` 一把键", async () => {
    /** 只多记一件事：每次 `put` 写的是哪一把键。计数三个桶仍由 `CountingStorage` 管。 */
    class PutKeyRecordingStorage extends CountingStorage {
      readonly putKeys: string[] = [];
      override async put<T>(k: string, v: T, expiresAt?: number): Promise<void> {
        this.putKeys.push(k);
        return await super.put(k, v, expiresAt);
      }
    }
    const st = new PutKeyRecordingStorage();
    const { app, repo, storage } = await makeApp(
      [], ["sk-clear-stats-overview"], {}, () => NOW, { storage: st },
    );
    const r0 = (await repo.all())[0] as KeyRecord;
    await storage.put(`key:${r0.id}`, {
      ...r0,
      stats: {
        requests: 41, success: 37, failed: 3, clientErrors: 1,
        lastErrorAt: NOW - 5, lastErrorKind: "upstream_5xx",
      },
    });

    const poolRequests = async (): Promise<number | null | undefined> => {
      const res = await app.request("/admin/api/overview", AUTH);
      expect(res.status, "GET /admin/api/overview").toBe(200);
      const body = await res.json() as { poolStats: { requests: number } | null };
      return body.poolStats?.requests;
    };
    expect(await poolRequests(), "前置条件：概览没读到那把 key 的计数 ⇒ 下面什么都没证明").toBe(41);

    st.putKeys.length = 0;
    expect((await send(app, "PATCH", `/admin/api/keys/${r0.id}`, { clearStats: true })).status).toBe(200);
    expect(
      st.putKeys,
      "这次 PATCH 写了 `key:<id>` 之外的键 —— 它本该是**单把、1 次 put**的动作；"
      + "碰了 `usage:*` 就等于把 Tier-2 也一起动了，那与设计文档补记里写的正相反",
    ).toEqual([`key:${r0.id}`]);
    expect(
      await poolRequests(),
      "概览的 Tier-1 池级计数没跟着掉 —— 它就是逐条 `r.stats` 加出来的，"
      + "不跟着掉说明概览换了取数口径，设计文档那条补记要跟着改",
    ).toBe(0);
  });

  it("改一个不存在的 id 是 404", async () => {
    const { app } = await makeApp([], ["sk-patch-404-other-key-"], {}, () => NOW);
    expect((await send(app, "PATCH", "/admin/api/keys/deadbeefdeadbeef", { disabled: true })).status)
      .toBe(404);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /admin/api/keys/bulk
// ───────────────────────────────────────────────────────────────────────────

describe("POST /admin/api/keys/bulk", () => {
  /**
   * **逐项结果不是装饰。** 批量删除里混着一把没停用的 key 时：整批 409 会让运维不
   * 知道哪几把成功了、要不要重试；只回一个「成功」则把那一把的失败整个吞掉。
   *
   * 同一格还钉住「必须先停用才能删」在批量路径上**用的是同一个判据**——批量删除是
   * 后果最不可挽回的那条路，它上面另写一份判据就等于那条安全约束有两个版本。
   */
  it("批量删除里混着一把没停用的 key：逐项结果各自成败，安全约束在批量路径上照样生效", async () => {
    const { app, repo } = await makeApp(
      [], ["sk-bulk-a-disabled-key", "sk-bulk-b-healthy-key", "sk-bulk-c-evicted-key"], {}, () => NOW,
    );
    const [a, b, c] = await repo.all() as [KeyRecord, KeyRecord, KeyRecord];
    await repo.save({ ...a, disabled: true }, a);
    await repo.save({ ...c, evicted: true, evictedReason: "upstream 401" }, c);

    const res = await send(app, "POST", "/admin/api/keys/bulk", {
      op: "delete", ids: [a.id, b.id, c.id, "deadbeefdeadbeef"],
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { results: Array<{ id: string; ok: boolean; reason: string | null }> }).results)
      .toEqual([
        { id: a.id, ok: true, reason: null },
        { id: b.id, ok: false, reason: "must_disable_first" },
        { id: c.id, ok: true, reason: null },
        { id: "deadbeefdeadbeef", ok: false, reason: "not_found" },
      ]);
    expect((await getKeys(app)).items.map((v) => v.id), "该留的那把没留下，或该删的没删掉")
      .toEqual([b.id]);
  });

  /**
   * **判据是 put 计数，与导入那条逐字同源**：逐把调 `repo.delete()` 的实现**结果完全
   * 正确**，只是每一把都要重写一次索引 ⇒ 面板批量条一次最多勾 200 行 ⇒
   * **一次点击 200 次 put = 两成日配额**，而它换来的信息量与一次 put 完全相同。
   *
   * 这一格是「守住了罕见路径、放掉了常见路径」的正面对照：只给「一次导入 200 把」
   * 那条罕见路径做了合并、把**更常见**的批量删除留在循环里，等于只补了一半。
   */
  it("批量删除 5 把 key 只写 1 次索引 —— 循环调 delete() 会写 5 次", async () => {
    const st = new CountingStorage();
    const keys = Array.from({ length: 5 }, (_, i) => `sk-bulk-delete-cost-${i}`);
    const { app, repo } = await makeApp([], keys, {}, () => NOW, { storage: st });
    const ids = (await repo.all()).map((r) => r.id);
    const snap = () => ({ gets: st.gets, puts: st.puts, deletes: st.deletes, lists: st.lists });
    const since = (b: ReturnType<typeof snap>) => ({
      gets: st.gets - b.gets, puts: st.puts - b.puts,
      deletes: st.deletes - b.deletes, lists: st.lists - b.lists,
    });

    // 先批量停用（顺带把「必须先停用才能删」满足掉），同一格量出它的单价。
    let base = snap();
    expect((await send(app, "POST", "/admin/api/keys/bulk", { op: "disable", ids })).status).toBe(200);
    expect(since(base), "批量停用 N 把：N 次校验读 + N 条记录写").toEqual({
      gets: 5, puts: 5, deletes: 0, lists: 0,
    });

    base = snap();
    expect((await send(app, "POST", "/admin/api/keys/bulk", { op: "delete", ids })).status).toBe(200);
    expect(
      since(base),
      "1 次索引 put + 5 条记录 delete；循环调 delete() 会是 5 次 put",
    ).toEqual({ gets: 6, puts: 1, deletes: 5, lists: 0 });
    expect((await getKeys(app)).counts.all, "省下的那几次 put 是拿「没真删掉」换来的").toBe(0);
  });

  /**
   * **同一条「读当前真值」的判据，落在最常见的那条路上。**
   *
   * ⚠️ **评审发现：把 `bulk` 的 `repo.get(id)` 换成快照查找，全量只红 1 条，
   * 而且红的是「单把写操作的存储开销」那格计数** ⇒ 这条性质当时靠一条**不相干的
   * 计数断言偶然接住**，一旦那格计数被调整就彻底裸奔。
   * 而批量停用比单把 PATCH **更常见**（运维在面板上勾一整页），
   * 覆盖掉的又是别的 isolate 刚写下的 `evicted` —— **一把上游已经拒绝的凭据
   * 被一次「批量停用」悄悄复活。**
   */
  it("bulk 读的也是存储里的当前真值，不是最多一个 TTL 前的快照", async () => {
    const { app, repo, storage } = await makeApp(
      [], ["sk-bulk-truth-vs-snap-a"], { poolCacheTtlMs: 60_000 }, () => NOW,
    );
    await getKeys(app);                       // 预热快照
    const r = (await repo.all())[0] as KeyRecord;
    // 别的 isolate（或运维手工）刚把它判成 evicted，本 isolate 的快照还不知道。
    await storage.put(`key:${r.id}`, {
      ...r, evicted: true, evictedReason: "upstream 401", strikes: 7,
    });
    expect(
      (await repo.all())[0]!.evicted,
      "本 isolate 的快照没有保持陈旧 ⇒ 本格没有判别力",
    ).toBe(false);

    expect((await send(app, "POST", "/admin/api/keys/bulk", {
      op: "disable", ids: [r.id],
    })).status).toBe(200);

    const v = await viewOf(app, r.id);
    expect(
      { evictedReason: v.evictedReason, strikes: v.strikes, disabled: v.disabled },
      "批量停用基于陈旧快照 ⇒ 别的 isolate 刚写下的 evicted / strikes 被覆盖掉了",
    ).toEqual({ evictedReason: "upstream 401", strikes: 7, disabled: true });
  });

  /**
   * **批量事件要说得出「变的是哪几把」。**
   *
   * ⚠️ **评审发现：单条 `DELETE` 记 `{ id, wasEvicted, wasDisabled }`，而批量只记
   * `{ count }`** ⇒ 一次删 200 把之后，事件板块只能说「少了 200 把」，
   * 说不出是哪 200 把——而删除不可撤销，事后追查时那正是唯一要问的问题。
   * 逐条打 200 条事件会直接撞穿 `EVENT_WRITES_PER_DAY`，所以取中间：
   * **不超过 20 把（面板一页）就逐个列出，超了就明说自己没列**——
   * 「面板说不出自己缺了什么」在本仓是被单独裁过的一类缺陷。
   */
  it("批量事件列得出 id：不超过 20 把逐个列，超了明说 idsOmitted 而不是悄悄不提", async () => {
    const small = ["sk-bulk-ids-small-a-aa", "sk-bulk-ids-small-b-bb"];
    const { app, repo, logger } = await makeApp([], small, {}, () => NOW);
    const ids = (await repo.all()).map((x) => x.id);

    logger.clear();
    expect((await send(app, "POST", "/admin/api/keys/bulk", { op: "disable", ids })).status).toBe(200);
    const e = logger.entries.find((x) => x.event === "key.disabled");
    expect({ count: e?.fields?.count, ids: e?.fields?.ids, idsOmitted: e?.fields?.idsOmitted })
      .toEqual({ count: 2, ids: ids.join(","), idsOmitted: false });

    // 超过阈值：**不许静默变成只有 count**，要明确标出「我没列」。
    const many = Array.from({ length: 21 }, (_, i) => `sk-bulk-ids-many-${String(i).padStart(2, "0")}`);
    const big = await makeApp([], many, {}, () => NOW);
    const manyIds = (await big.repo.all()).map((x) => x.id);
    big.logger.clear();
    expect((await send(big.app, "POST", "/admin/api/keys/bulk", {
      op: "disable", ids: manyIds,
    })).status).toBe(200);
    const e2 = big.logger.entries.find((x) => x.event === "key.disabled");
    expect({ count: e2?.fields?.count, ids: e2?.fields?.ids, idsOmitted: e2?.fields?.idsOmitted })
      .toEqual({ count: 21, ids: null, idsOmitted: true });
  });

  it("批量停用 / 批量清冷却各自生效，并各打一条事件", async () => {
    const { app, repo, logger } = await makeApp([], ["sk-bulk-op-a-key-aaaa", "sk-bulk-op-b-key-bbbb"], {}, () => NOW);
    const [a, b] = await repo.all() as [KeyRecord, KeyRecord];
    await repo.save({ ...a, cooldownUntil: NOW + 60_000, cooldownReason: "rate limited" }, a);

    logger.clear();
    expect((await send(app, "POST", "/admin/api/keys/bulk", { op: "clearCooldown", ids: [a.id] })).status).toBe(200);
    expect((await viewOf(app, a.id)).cooldownUntil).toBe(0);
    expect(logger.entries.find((x) => x.event === "key.restored")?.fields?.count).toBe(1);

    logger.clear();
    expect((await send(app, "POST", "/admin/api/keys/bulk", { op: "disable", ids: [a.id, b.id] })).status).toBe(200);
    expect((await getKeys(app)).counts.disabled).toBe(2);
    expect(logger.entries.find((x) => x.event === "key.disabled")?.fields?.count).toBe(2);
  });

  it.each([
    ["op 不认识", { op: "nuke", ids: [] }],
    ["op 缺席", { ids: [] }],
    ["ids 不是数组", { op: "disable", ids: "abc" }],
    ["ids 里混着非字符串", { op: "disable", ids: [1] }],
  ])("请求体形状不对时 400：%s", async (_name, body) => {
    const { app } = await makeApp([], ["sk-bulk-400-target-aaaa"], {}, () => NOW);
    expect((await send(app, "POST", "/admin/api/keys/bulk", body)).status).toBe(400);
  });
});

/**
 * **面板会渲染的那一族 400/404/409：机器可读的码，而不是一句中文散文**。
 *
 * ⚠️⚠️ **这是那条「归属定死」的破口的后端半身。** 在它之前，这一族错误的
 * `error.message` 是中文散文（`note 最长 200 个字符` / `不认识的字段：…`），
 * 而 `admin-ui/js/sec-keys.js` 的 `errorMessage()` 把它**原样**画给 ja / en / ko 用户。
 * 前端半身（拿码查五语言字典、表外的码回落并带标记）在
 * `tests/ui/keys-write.test.ts`「已知 code ⇒ 渲染五语言字典里的那句，不是后端那句中文」
 * 与 `tests/ui/keys-write.test.ts`「表外的 code ⇒ 回落到后端原话，并且带一个看得见的标记」两格。
 *
 * ⚠️ **`message` 一个字都没删，这里也顺带钉住这件事**：它是给日志与 API 客户端的。
 * 契约是 `code`，**不是** `message`——后者的措辞随时可以改而不算破坏兼容。
 */
describe("写端点的错误体：码在闭集里，message 仍在", () => {
  /** 一次会失败的请求的响应体。 */
  async function readFailure(res: Response, label: string) {
    expect(res.status, `${label} 本该失败`).toBeGreaterThanOrEqual(400);
    const parsed = await res.json() as {
      error?: { type?: string; code?: string; message?: string; params?: Record<string, unknown> };
    };
    return { status: res.status, error: parsed.error ?? {} };
  }

  /** 打一条码要用到的现场：常规 app、一个管理端整个停用的 app、一把活着的 key 的 id。 */
  interface FailCtx { app: App; conflictApp: App; id: string }

  /**
   * 探针字段的**名**与**值**，刻意长得不一样。
   *
   * `src/http/admin/errors.ts` 关于 `params` 的那段口径要靠这两个串验：
   * 「字段的**值**永不进 `params`」拿 `PROBE_FIELD_VALUE` 验（它被塞进五条路径的值位），
   * 「`unknown_field` 的 `fields` **确实**逐字回显字段**名**」拿 `PROBE_FIELD_NAME` 验
   * ——后者同时是前者的反向控制：证明这条判据看得见 `params` 里的调用方原文。
   */
  const PROBE_FIELD_NAME = "probeFieldName<img src=x>";
  const PROBE_FIELD_VALUE = "probe-field-value-must-never-be-echoed";

  /** 送一个**不经 `JSON.stringify`** 的原始请求体——`bad_json` 只有这条路打得出来。 */
  function rawSend(app: App, method: string, path: string, body: string): Response | Promise<Response> {
    return app.request(path, { method, headers: JSON_AUTH, body });
  }

  /**
   * **一条码一次真 HTTP，以码为键，闭集里一条都不许缺。**
   *
   * ⚠️⚠️ **复评订正的就是这张表。** 上一版是一张手写的六条路径表，而用例名
   * 与 `src/core/admin/admin-errors.ts` 的两处注释写的是「**每条**错误响应……」
   * ——那两句全称句当时只对 6/16 成立。实测（复评发现）：
   * `handlers/keys-write.ts:77` 去掉 `{ field: name }`、`:381` 去掉
   * `{ max: MAX_IMPORT_KEYS }`，**全量 node 套件 EXIT=0**，而 ja 面板上画的是
   * `項目 {field} は…` 与 `1 回のバッチ操作は最大 {max} 件です` 两个裸占位符
   * ——`not_a_boolean` 与 `too_many_bulk_ids` 两条码当时一侧都没有。
   *
   * ⇒ 改成 `satisfies Record<AdminErrorCode, …>`：**新增一条码而不给它一次真请求
   * 就是 tsc 少属性**（与 `ADMIN_ERROR_PARAMS` 同一种牙），运行期还有下面那格
   * 「键集与闭集双向相等」。
   *
   * ⚠️ **没有「够不着的码」这一档，也就没有例外表。** 复评建议把
   * `admin_unavailable` / `admin_unauthorized` 登记成够不着的例外，**实测两条都够得着**：
   * 前者用「ADMIN_TOKEN 与 GATEWAY_TOKEN 相同 ⇒ 管理端整树 503」那个 app
   *（同一形态的现成用例在 `tests/contract/admin-auth.test.ts`），
   * 后者不带 `x-admin-key` 即可。**空的例外表会变成永久的洞**，所以一条都不留。
   */
  const FAILURE_RECIPES = {
    // ── 信封级：鉴权中间件，跑在路由之前 ─────────────────────────────────
    admin_unavailable: (c) => c.conflictApp.request(`/admin/api/keys/${c.id}`, {
      method: "PATCH", headers: JSON_AUTH, body: "{}",
    }),
    admin_unauthorized: (c) => c.app.request(`/admin/api/keys/${c.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: "{}",
    }),
    // ── 请求体解析 ──────────────────────────────────────────────────────
    bad_json: (c) => rawSend(c.app, "PATCH", `/admin/api/keys/${c.id}`, "{not-json"),
    body_not_an_object: (c) => send(c.app, "PATCH", `/admin/api/keys/${c.id}`, []),
    unknown_field: (c) => send(c.app, "PATCH", `/admin/api/keys/${c.id}`, {
      [PROBE_FIELD_NAME]: PROBE_FIELD_VALUE,
    }),
    // ── Key 池那四条写端点 ──────────────────────────────────────────────
    key_not_found: (c) => send(c.app, "DELETE", "/admin/api/keys/nope"),
    must_disable_first: (c) => send(c.app, "DELETE", `/admin/api/keys/${c.id}`),
    not_a_boolean: (c) => send(c.app, "PATCH", `/admin/api/keys/${c.id}`, { disabled: PROBE_FIELD_VALUE }),
    note_not_a_string: (c) => send(c.app, "PATCH", `/admin/api/keys/${c.id}`, { note: 12345 }),
    note_too_long: (c) => send(c.app, "PATCH", `/admin/api/keys/${c.id}`, {
      note: "x".repeat(MAX_NOTE_LENGTH + 1),
    }),
    empty_patch: (c) => send(c.app, "PATCH", `/admin/api/keys/${c.id}`, {}),
    keys_not_a_string_array: (c) => send(c.app, "POST", "/admin/api/keys", { keys: PROBE_FIELD_VALUE }),
    too_many_import_keys: (c) => send(c.app, "POST", "/admin/api/keys", {
      keys: Array.from({ length: MAX_IMPORT_KEYS + 1 }, (_, i) => `sk-code-scan-${i}`),
    }),
    not_a_bulk_op: (c) => send(c.app, "POST", "/admin/api/keys/bulk", { op: PROBE_FIELD_VALUE, ids: [] }),
    ids_not_a_string_array: (c) => send(c.app, "POST", "/admin/api/keys/bulk", {
      op: "disable", ids: PROBE_FIELD_VALUE,
    }),
    too_many_bulk_ids: (c) => send(c.app, "POST", "/admin/api/keys/bulk", {
      op: "disable", ids: Array.from({ length: MAX_IMPORT_KEYS + 1 }, (_, i) => `id-bulk-scan-${i}`),
    }),
  } satisfies Record<AdminErrorCode, (c: FailCtx) => Response | Promise<Response>>;

  type Failure = Awaited<ReturnType<typeof readFailure>>;

  /**
   * 闭集里每一条码各打一次真请求，按码归档。
   *
   * **全部是失败请求，一条都不改动存储**（`must_disable_first` 那条是 409 挡下的
   * 删除、`key_not_found` 那条打的是一个不存在的 id）⇒ 顺序无关，可以在同一个 app 上跑完。
   */
  async function allFailures(): Promise<Record<AdminErrorCode, Failure>> {
    const { app, repo } = await makeApp([], ["sk-err-code-target-aaaa"], {}, () => NOW);
    const [k] = await repo.all() as [KeyRecord];
    // 管理口令与网关口令相同 ⇒ `/admin` 树照常注册，但每条管理请求都是 503 `admin_unavailable`。
    const { app: conflictApp } = await makeApp(
      [], ["sk-err-conflict-target-a"], { gatewayToken: TEST_ADMIN_TOKEN }, () => NOW,
      { adminToken: TEST_ADMIN_TOKEN },
    );
    const ctx: FailCtx = { app, conflictApp, id: k.id };
    const out = {} as Record<AdminErrorCode, Failure>;
    for (const code of Object.keys(FAILURE_RECIPES) as AdminErrorCode[]) {
      out[code] = await readFailure(await FAILURE_RECIPES[code](ctx), code);
    }
    return out;
  }

  it("每一条失败都带 error.code，而且 code 在闭集里", async () => {
    const failures = await allFailures();
    expect(
      Object.keys(failures).sort(),
      "有码没有配一次真请求 —— 那条码一侧都没有（那两条就是这么逃掉的）",
    ).toEqual([...ADMIN_ERROR_CODES].sort());
    for (const [name, f] of Object.entries(failures)) {
      expect(f.error.code, `${name} 没有 error.code —— 面板只能回去解析中文`).toBeDefined();
      expect(ADMIN_ERROR_CODES as readonly string[], `${name} 的 code「${f.error.code}」不在闭集里`)
        .toContain(f.error.code);
    }
  });

  it("每条路径打出的正是它那一条码 —— 否则这一族码只是换个地方说「出错了」", async () => {
    // **这一格比「各个码互不相同」更强**：全部退化成同一个兜底值会红（复评发现），
    // 而「两条码互换」这种保持互异的错法也会红。
    const failures = await allFailures();
    for (const code of ADMIN_ERROR_CODES) {
      expect(failures[code].error.code, `${code} 那条路径打出来的是「${failures[code].error.code}」`).toBe(code);
    }
  });

  it("message 一个字都没删 —— 它是给日志与 API 客户端的，契约是 code 不是它", async () => {
    const failures = await allFailures();
    for (const [name, f] of Object.entries(failures)) {
      expect(typeof f.error.message, `${name} 的 message 没了`).toBe("string");
      expect((f.error.message ?? "").length, `${name} 的 message 是空串`).toBeGreaterThan(0);
      // `type` 同样保留：四协议信封的形状不因为多一格 `code` 而变。
      expect(typeof f.error.type).toBe("string");
    }
  });

  it("每条错误响应带的 params 与它那个 code 声明的逐字相等", async () => {
    // 两侧都是现取现比：一侧是真 HTTP 响应体，另一侧是 `ADMIN_ERROR_PARAMS`。
    // **没有任何一张手写的期望表**——改字典占位符或改后端实参，两边有一边会不相等。
    // ⚠️ 「每条」这个词现在是真的：上面那张表覆盖闭集里每一条码，键集由第一格双向钉住。
    const failures = await allFailures();
    for (const [name, f] of Object.entries(failures)) {
      const declared = ADMIN_ERROR_PARAMS[f.error.code as keyof typeof ADMIN_ERROR_PARAMS];
      expect(declared, `${name} 的 code 不在 ADMIN_ERROR_PARAMS 里`).toBeDefined();
      expect(Object.keys(f.error.params ?? {}).sort(), `${name} 的 params 与声明对不上`)
        .toEqual([...declared].sort());
    }
  });

  it("params 里一个中文字符都不许有 —— 插进 ja/ko 的句子里就是同一个破口", async () => {
    // `params` 会被 `t(key, params)` 原样插进五语言句子里。往里塞一句中文
    // （例如把 `${what}` 那个「请求体」传进来）等于把这次要关掉的破口缩小重演一遍。
    const failures = await allFailures();
    for (const [name, f] of Object.entries(failures)) {
      expect(JSON.stringify(f.error.params ?? {}), `${name} 的 params 里有汉字`).not.toMatch(/[一-鿿]/);
    }
  });

  it("反向控制：那条汉字判据在真的有汉字的 message 上确实说「有」", () => {
    // 少了这一格，上面那格在「params 恒为空」时也是绿的，而判据本身可能压根不认汉字。
    expect(JSON.stringify({ what: "请求体" })).toMatch(/[一-鿿]/);
  });

  /**
   * **`params` 里放什么、不放什么**（复评发现）。
   *
   * ⚠️⚠️ 上一版 `src/http/admin/errors.ts` 在这一格上写的是「`params` 只放数字与短标识，
   * **永不放用户输入**」——**那句话是假的，而且零测法**：`rejectUnknown()` 把调用方送来的
   * 字段**名**逐字塞进 `params.fields`（复评实测回显了 `sk-live-…` 与 `<img src=x>`）。
   * 现在那段注释改成了「不放字段的**值**；`unknown_field` 的 `fields` 是唯一一处逐字回显
   * 字段**名**的地方」，这一格就是它的测法。
   */
  it("params 永不回显请求体里字段的值，而 unknown_field 的 fields 确实逐字回显字段名", async () => {
    const failures = await allFailures();
    for (const [name, f] of Object.entries(failures)) {
      expect(
        JSON.stringify(f.error.params ?? {}),
        `${name} 的 params 里回显了请求体里那个字段的值 —— 注释说的是「只回显字段名」`,
      ).not.toContain(PROBE_FIELD_VALUE);
    }
    // **反向控制（用同一条判据、同一次真响应）**：这条判据看得见 `params` 里的调用方原文
    // ——否则上面那一圈在「params 恒为空」时也是绿的。
    expect(
      f_fields(failures.unknown_field),
      "unknown_field 的 params.fields 没有逐字回显字段名 —— errors.ts 里那句口径要跟着改",
    ).toContain(PROBE_FIELD_NAME);
    // 值那一侧在同一条响应上确实**没有**回显，两句话在同一格里各自成立。
    expect(f_fields(failures.unknown_field)).not.toContain(PROBE_FIELD_VALUE);
  });

  /** `unknown_field` 那条响应的 `params.fields`，取不到时给一个显眼的空串。 */
  function f_fields(f: Failure): string {
    const v = (f.error.params ?? {}).fields;
    return typeof v === "string" ? v : "";
  }

  it("单条 DELETE 的 409 同时带 code 与设计 §11 的顶层 reason —— 两个都不许少", async () => {
    const { app, repo } = await makeApp([], ["sk-err-409-live-key-aa"], {}, () => NOW);
    const [k] = await repo.all() as [KeyRecord];
    const res = await send(app, "DELETE", `/admin/api/keys/${k.id}`);
    expect(res.status).toBe(409);
    const body = await res.json() as { error?: { code?: string }; reason?: string };
    expect(body.error?.code).toBe("must_disable_first");
    // 顶层 `reason` 是设计 §11 逐字定死的那一格，`isMustDisableFirstConflict()` 读的是它。
    expect(body.reason).toBe("must_disable_first");
  });
});
