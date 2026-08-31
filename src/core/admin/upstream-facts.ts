/**
 * **上游事实登记表**：这一条我们**验证过**，还是**假设**的？
 *
 * 本仓对「真实 Agnes 上游」的形状知识，今天几乎全部来自**我们自己写的那份假上游**
 * （`tests/contract/media.test.ts` 的「POST /v1/videos 建任务后返回任务标识」那一格里，
 * 那个 `FakeFetcher` 吐出去的响应体是我们自己敲进去的字面量）。拿它当上游依据是
 * **循环取证**：我们先写下一句响应体，再回头把它当成「上游给的正是这一格」。
 * 这件事此前只散在注释里，而**注释不会红**——这张表就是那句话的机器形态。
 *
 * ⚠️⚠️ **这张表不许长成第三份端点知识。** 媒体端点的两半刚被合并进
 * `src/core/admin/protocol-catalog.ts`，再开一张能独立漂走的表是有代价的。要指向真源时
 * 写**符号名**（`anchor: "VIDEO_TASK_ID_RE"`），由锚断言绑住。
 *
 * ⚠️ **但「一个路径 / 字段值都不许复制、表里看不到任何一条路径任何一个字段名的副本」
 * 这句话本表做不到，也不该照字面立**——上一版这里逐字这么写着，而同一份文件里三处
 * `docSections` 逐字带着端点签名（**今天依然带着**，理由见 ①）、一处 `assumed` 逐字带着
 * 字段名（复评点名，**已按 ② 改成相对句**）。今天的口径是下面两条，各自都有东西钉着：
 * ① `docSections` 那一栏**是五份 API.md 的小节标题**（markdown 里的那一行），不是网关
 *    拿去发请求的路径 —— 这一栏与真源那份端点知识**没有共同的消费者**，它只被拿去在
 *    markdown 里定位。**它也不会静静漂**：写成别名、或者某一份文档的标题被改动，
 *    `tests/unit/docs-parity.test.ts` 的「该红时红：小节标题在某一份里对不上时会吵」
 *    背后那条判据当场报「找不到小节」（回填时两条真变异都跑过：把这一栏改成别名
 *    ⇒ 五种语言逐份点名；改 `docs/ja/API.md` 的小节标题 ⇒ 点名那一份）。
 * ② `assumed` 那一栏**只写相对句**（「与网关那条形状判据同一个字符集与长度上界」、
 *    「面板那张具名候选槽表的第一条」），**不复述被指向的那份真源的内容**。理由是
 *    实测出来的：上一版第一条事实的 `assumed` 逐字复述了真源那张槽表的第一格长什么样，
 *    把真源改掉之后本表这两个测试文件**一格都没红**——一份没有任何机器管的第二知识，
 *    真源一动它就静静变假。（那件事本身另有机器管着，本表只管别复述它：
 *    `tests/ui/playground-media.test.ts` 的
 *    「非空锚 + 顺序即语义：槽表至少两条，且第一条恒为顶层 id 那一格」。）
 *
 * ⚠️ **`status` 只许在有本仓之外的依据时才写 `verified`**：`source` 必须以
 * `https://` 或 `docs/` 开头，且不许以 `tests/` 开头。这条判据的存在理由是一句
 * 真实发生过的循环取证——`admin-ui/js/pure/playground.mjs` 曾逐字把我们自己写的
 * 那份假上游称作「上游给的」。
 *
 * ── **它能做到什么 / 做不到什么，明写** ────────────────────────────────────────
 * **能**：让「这条事实的依据强度」不再只是一句人写的散文——有人在没有真上游依据时
 * 把 `assumed` 改成 `verified`、或者把真源里那个锚名删掉、或者从五份 API.md 里
 * 抽掉那句限定，都会有一格当场变红并点名是哪一条事实。
 * **不能**：它一个字节都不知道上游到底长什么样。它验的是**登记的诚实**，
 * 不是**事实本身**——`assumed` 那一栏写得对不对，只有一次真上游能定案。
 *
 * ⚠️ **`docs/` 这一档有个明写的边界**：把假夹具的结论抄进一份自己写的文档、
 * 再拿那份文档当依据，这条判据认不出来。它挡的是「顺手把假设升格成事实」，
 * 不是「刻意编一条依据」——后者留给评审，与本仓其余几道门禁同一条口径。
 */

/** 五语言。与 `docs/` 下那五个目录同一批，由登记表的守卫逐条比对，不在这里另立真源。 */
type Lang = "zh-CN" | "zh-TW" | "en" | "ja" | "ko";

export interface UpstreamFact {
  /** 稳定标识。报文与用例名都用它点名，别改。 */
  readonly id: string;
  /** 这条事实说的是**哪件事**（不是答案，是问题）。 */
  readonly subject: string;
  /** 我们今天**假定**的答案。 */
  readonly assumed: string;
  /** 依据强度。`verified` 要过 `source` 那道判据。 */
  readonly status: "assumed" | "verified";
  /** 依据出处。**`assumed` 时这里要如实写「依据是什么」，包括「无」。** */
  readonly source: string;
  /** 真源侧那段锚注释所在的文件。 */
  readonly anchorFile: string;
  /** 真源侧的锚：优先写**符号名**，符号名绑不住那段登记时才写裁定原句。 */
  readonly anchor: string;
  /**
   * 这条限定该贴在五份 API.md 的**哪些小节**里。小节标题在五种语言里**逐字相同**
   * （它们是 markdown 里的端点签名），所以这一栏与语言无关。
   *
   * ⚠️ **它不是可有可无的一栏**：没有它的话判据只能在整份 API.md 里找那句话，
   * 于是「把限定句贴在一个毫不相干的端点下面」照样绿，而这句话的全部意义就是
   * **贴在读者正要照抄的那段示例旁边**。
   * ⚠️ **有了它也仍然挡不住「挪到文件末尾」，别把这两句读反了**：文件末尾属于**最后
   * 一个小节**，某条事实指名的小节恰好排在最后时（今天 `video.taskIdCharset` 就是），
   * 那种挪法一格都不会红（复评按这句话做真文件变异，实测**全绿 EXIT=0**）。
   * 完整说明与它的断言在 `tests/unit/docs-parity.test.ts` 的
   * 「该红时红：限定句被挪出指名小节」那一格。
   */
  readonly docSections: readonly string[];
  /**
   * 五语言文档里必须逐字出现的那句限定的锚 token，**每种语言各一个**。
   *
   * ⚠️ **不写成单个中文串再往五份里各塞一遍**——那是糊弄，ja / ko / en 的读者拿到的
   * 是一句看不懂的话，而这一格的全部意义是**让读者看见这条事实没被核实过**。
   * ⚠️ **跨事实也不许撞**：两条事实共用一个 token 的话，一条事实的限定句就能把
   * 另一条的断言喂饱，那条断言从此空转。
   */
  readonly docHints: Readonly<Record<Lang, string>>;
}

/**
 * 表体。**先写成一个带类型标注的常量，再逐条冻起来对外。**
 *
 * ⚠️ **钉住「`status` 只许是那两个字面量」的，是这里这条 `readonly UpstreamFact[]` 标注，
 * 不是「分两步写」这件事**：写错一个值时 `pnpm typecheck` 当场红。
 * 上一版这里写的是「直接给 `Object.freeze([...])` 标注返回类型的话，字面量联合会在
 * 推断里被拓宽成 `string`，于是这条约束在编译期就没了」——**后半句是假的**：复评拿
 * tsc 实测、回填时又亲手复现了一遍，那种写法**照样在编译期红**。分两步留着的唯一好处
 * 是报错点名得更准（回填实测：两步写法把错指到出错的**那一行**并给出「你是不是想写
 * `assumed`」，一表达式写法只指到整条赋值）——那是可读性，不是约束。
 * ⚠️ 这一句是**回填时一次性量出来的编译器行为**，本仓没有任何常跑的机器守着它；
 * 常跑的只有「写错一个值 ⇒ typecheck 红」那半句（回填时按真变异跑过一遍）。
 */
const FACTS: readonly UpstreamFact[] = [
  {
    id: "video.taskIdSlot",
    subject: "建任务响应把任务标识放在哪一格",
    // `assumed` 写成**相对句**（口径见文件头 ②）：那张槽表的第一条到底是哪一格，
    // 由真源与它自己的守卫说了算，本表复述一遍只会在真源改动时静静变假。
    assumed: "上游把它放在真源那张具名候选槽表的第一条槽位上（面板认的是一张表，不是单一格）",
    status: "assumed",
    source: "tests/contract/media.test.ts 里我们自己写的那份假上游 —— 这不是上游依据",
    anchorFile: "admin-ui/js/pure/playground.mjs",
    anchor: "VIDEO_TASK_ID_SLOTS",
    docSections: ["POST /v1/videos"],
    docHints: {
      "zh-CN": "下面这段响应体的形状未经真实上游核实",
      "zh-TW": "下面這段回應內容的形狀未經真實上游核實",
      en: "The response body below is not verified against the real upstream",
      ja: "以下のレスポンスボディの形は実際の上流では未検証です",
      ko: "아래 응답 본문의 형태는 실제 업스트림에서 검증되지 않았습니다",
    },
  },
  {
    id: "video.taskIdCharset",
    subject: "上游签发的任务标识落在哪个字符集里",
    assumed: "与网关那条形状判据同一个字符集与长度上界",
    status: "assumed",
    source: "tests/contract/media.test.ts 里我们自己写的那份假上游 —— 与上一条同源（同一句造出来的标识）",
    anchorFile: "src/core/admin/protocol-catalog.ts",
    anchor: "VIDEO_TASK_ID_RE",
    docSections: ["GET /v1/videos/{id}"],
    docHints: {
      "zh-CN": "任务标识的形状判据未经真实上游核实",
      "zh-TW": "任務識別碼的形狀判據未經真實上游核實",
      en: "The task-identifier shape check is not verified against the real upstream",
      ja: "タスク識別子の形状判定は実際の上流では未検証です",
      ko: "작업 식별자 형태 판정은 실제 업스트림에서 검증되지 않았습니다",
    },
  },
  {
    id: "openai.streamTrailingUsage",
    subject: "openai 协议的流式响应末帧带不带 usage",
    assumed: "不带（这条协议的字节网关原样透传，不解析也不改写）",
    status: "assumed",
    source: "无。真源侧那段登记已裁定「不猜着加解析分支」，至今零非自造依据",
    anchorFile: "src/core/admin/protocol-catalog.ts",
    /**
     * ⚠️ **这一条的锚是裁定原句，不是符号名，理由写在这里**：那段登记挂在
     * `streamTextPath` 名下，而那个符号名**挡不住「整段登记被删掉」**
     * （字段还在、登记没了，锚照样匹配得上）。裁定原句与那段登记同生共死。
     */
    anchor: "需要一次真上游才能定案",
    docSections: ["POST /v1/chat/completions"],
    docHints: {
      "zh-CN": "流式末帧带不带 usage 未经真实上游核实",
      "zh-TW": "串流末幀帶不帶 usage 未經真實上游核實",
      en: "Whether the final stream chunk carries usage is not verified against the real upstream",
      ja: "ストリーム最終チャンクに usage が付くかは実際の上流では未検証です",
      ko: "스트림 마지막 청크에 usage가 붙는지는 실제 업스트림에서 검증되지 않았습니다",
    },
  },
];

/**
 * 对外的那一份，**逐条冻住**：探针要从真实事实派生出变异体时，写法只能是
 * `{ ...fact, status: "verified" }`（新对象），冻住之后「就地改一格再跑」这条路直接抛，
 * 不会有人把真表改脏了还以为自己在测探针。
 */
export const UPSTREAM_FACTS: readonly UpstreamFact[] = Object.freeze(FACTS.map((f) => Object.freeze(f)));

/**
 * 锚在某个真源符号上的那条事实，**它的限定该贴在哪一节 API.md**。
 *
 * ⚠️ **这一栏后来多了一个运行期消费者**：`src/http/routes/media.ts`
 * 那条 400 要把读者指去 API.md 的某一节，而**小节名只许有这一份**。上一版那里手抄着
 * 同一个串：这一栏改个名字，**报文照旧指着旧名字**，而**盯着报文里那个名字的机器一格
 * 都没有**（那一栏改名本身另有 `docs-parity` 那一侧管，但它管的是文档，不是报文）。
 * 这不违反文件头 ⚠️⚠️ 那条「不许长成第三份端点知识」：交出去的是**markdown 里的一行
 * 标题**，仍然只被拿去定位一节文档，网关一个字节都不拿它去发请求。
 *
 * ⚠️ **不是恰好一条就抛，不返回一个「大概对」的值**：0 条 ⇒ 报文指向空气；
 * 2 条 ⇒ 它随这张表的排序漂。抛的时机是**建应用那一刻**（消费者在路由注册时取一次），
 * 不是等到某个读者踩中 400 的那一刻——后者会把一个 400 变成 500。
 * 由 `tests/contract/media.test.ts` 的
 * 「报文点名的那一节文档取自上游事实登记表 —— 报文里不许有第二份小节名」钉着；
 * 「这个标题在五份 API.md 里真的存在」另有 `tests/unit/docs-parity.test.ts` 的
 * 「该红时红：小节标题在某一份里对不上时会吵……」管着，本函数不重复那一层。
 */
export function upstreamDocSectionByAnchor(anchor: string): string {
  const hits = UPSTREAM_FACTS.filter((f) => f.anchor === anchor);
  const section = hits.length === 1 ? hits[0]!.docSections[0] : undefined;
  if (section === undefined || section === "") {
    throw new Error(
      `上游事实登记表里锚在「${anchor}」上的事实有 ${hits.length} 条（要恰好一条），`
      + `第一条 docSections 取到的是 ${JSON.stringify(section)}：`
      + "报文要据它把读者指去 API.md 的某一节，取不到就只能把人指向空气。",
    );
  }
  return section;
}
