import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle, type Harness } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE, SECTION_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
// 期望值一律从**真源**现算：哪几格字段属于哪张卡由 pure 层那两张表说了算，
// 这里手抄一份的话，表改了这一族会指着自己的抄件说「对得上」。
import { CARD_AUTH, CARD_UPSTREAM } from "../../../admin-ui/js/pure/settings.mjs";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **设置页的排布**：每一格字段到底站在哪个盒子里。
 *
 * ⚠️⚠️ **这一族是补上来的，而它补的是一个真实的空白**：改这一版之前，设置页四张卡
 * 竖着摞成一列、每一格字段各占一整行，而全仓 4555 格测试**没有一格**能看见这件事
 *（本轮实测：把字段从整行改成网格，既有用例零红）。也就是说排布这一层此前
 * **完全没有判据**，任何人把它改回去都不会有东西吵。
 *
 * ⚠️ **本文件只断言「谁装在谁里面」，不断言像素**：本仓没有布局引擎（`fake-dom.ts`
 * 文件头逐字写着它不实现选择器引擎，更没有盒模型），一格写「宽 232px」的断言
 * 在这里测的是空气。真正的宽高与「窄屏会不会横向滚动」只有真浏览器量得到，
 * 量法与量到的数写在 CSS 那两条规则上方，**别把它们搬成这里的断言**。
 * 这一层能钉住的是结构：结构一退回去，多列就不可能成立。
 */
const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** 打开设置板块（登录态 + 上次停在 settings）。配置那条给空对象：这一族不看取值。 */
async function openSettings(): Promise<Harness> {
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000), [SECTION_STORE]: "settings" },
    respond: () => ({ status: 200, body: {} }),
  });
  await settle(12);
  return h;
}

function fieldNode(section: FakeElement, path: string): FakeElement {
  const node = section.walk().find((n) => n.getAttribute("data-field") === path);
  if (!node) throw new Error(`设置页上找不到字段 ${path} —— 先回来看是不是整张卡搬走了`);
  return node;
}

/** 从这个节点往上数，第一个带 `cls` 的祖先；没有就 `null`。 */
function ancestorWith(node: FakeElement, cls: string): FakeElement | null {
  let cur: FakeElement | null = node.parent;
  while (cur !== null) {
    if (cur.classList.contains(cls)) return cur;
    cur = cur.parent;
  }
  return null;
}

describe("设置页：四张卡分在两列里", () => {
  /**
   * ⚠️ **期望值是手写的，而且刻意手写。** 这张表说的是「哪张卡在左、哪张在右、
   * 读到的先后是什么」——那是一个**决定**，不是可以从别处派生出来的事实。
   * 添一张新卡时这一格会红，而它**该**红：新卡放哪一列必须有人决定一次。
   * 「设置页上一共有几张卡」那个数另有真源（`tests/unit/docs-parity.test.ts` 的
   * 「五份 ADMIN.md 里五张表的行数，逐张等于屏幕那边对应的那个计数」），
   * 那一格从 `settingsSection` 里 `card("…")` 的调用序列现算，不看这张表。
   */
  const READING_ORDER = [
    "set.card.auth", "set.card.upstream", "set.card.examples", "set.card.danger",
  ] as const;

  /** 这一列里那几张卡的标题 key，按 DOM 顺序。 */
  function cardKeysIn(col: FakeElement): string[] {
    return col.querySelectorAll(".card")
      .flatMap((c) => c.children.filter((n) => n.tagName === "h3"))
      .map((h) => h.getAttribute("data-i18n") ?? "")
      .filter((k) => k.startsWith("set.card."));
  }

  function columns(h: Harness): FakeElement[] {
    return h.section("settings").querySelectorAll(".cfg-col");
  }

  /**
   * ⚠️ **靶子写清楚：把 `colLeft/colRight.appendChild(卡)` 改回 `section.appendChild(卡)`。**
   * 那是这一版之前的写法，屏幕上的后果是四张卡竖着摞成一列、整页拉成一条长窄条。
   * 那次改动**没有打红过任何既有用例**，所以这一族是它唯一的绊线。
   */
  it("四张卡分在两列里，读序仍是卡 1→4", async () => {
    const h = await openSettings();
    const cols = columns(h);
    expect(cols.length, "设置页上的列数不是 2 —— 「左右两列」这件事不成立了").toBe(2);
    const left = cardKeysIn(cols[0]!);
    const right = cardKeysIn(cols[1]!);
    // 两列都得有卡：四张全塞进一列同样能让上面那格绿，而那就是分列之前的样子。
    expect(left.length, "左列一张卡都没有 —— 那不是两列，那是一列外面套了个空盒子").toBeGreaterThan(0);
    expect(right.length, "右列一张卡都没有 —— 同上").toBeGreaterThan(0);
    expect(
      [...left, ...right],
      "四张卡的分列或先后变了 —— 这是个决定，改之前先想清楚新的读序是什么",
    ).toEqual([...READING_ORDER]);
  });

  /**
   * **反向控制：没有一张设置卡漏在两列之外。**
   * 上面那格只看「列里有什么」，一张被 append 回 `section` 的卡它一眼都看不见
   * ——而那正好是要防的那次回退的形态（回退一半时更像）。
   */
  it("设置页上的每一张卡都在某一列里，一张都没漏在列外", async () => {
    const h = await openSettings();
    const section = h.section("settings");
    const stray = section.querySelectorAll(".card")
      .filter((c) => ancestorWith(c, "cfg-col") === null)
      .flatMap((c) => c.children.filter((n) => n.tagName === "h3"))
      .map((h3) => h3.getAttribute("data-i18n"));
    expect(stray, "这几张卡跑到两列外面去了 —— 它们会各自独占一整行").toEqual([]);
    // 上面那条在「一张卡都找不到」时同样成立 ⇒ 先证屏幕上真的有卡。
    expect(
      section.querySelectorAll(".card").length,
      "设置页上一张卡都没有 —— 上面那格比的是空集",
    ).toBeGreaterThan(0);
  });
});

describe("设置页：卡内字段排在网格里，不是一格占一整行", () => {
  /**
   * ⚠️ **靶子写清楚：把 `addField(grid, …)` 改回 `addField(card.body, …)`。**
   * 那是这一版之前的写法，屏幕上的后果是每一格独占一行、输入框只占其中 420px、
   * 右边整片空白（真机量到的数在 `admin-ui/css/sections.css` 的 `.cfg-grid` 上方）。
   * 那次改动**没有打红过任何既有用例**，所以这一格是它唯一的绊线。
   */
  it("两张卡的每一格字段都装在某个 .cfg-grid 里，一格都没漏在网格外", async () => {
    const h = await openSettings();
    const section = h.section("settings");
    const outside: string[] = [];
    for (const path of [...CARD_AUTH, ...CARD_UPSTREAM]) {
      if (ancestorWith(fieldNode(section, path), "cfg-grid") === null) outside.push(path);
    }
    expect(
      outside,
      "这几格字段没在 .cfg-grid 里 —— 它们会各占一整行，而输入框只占其中一段，"
      + "右边那片空白就是这么来的",
    ).toEqual([]);
  });

  /**
   * **反向控制：同一把尺子对着一个真的不在网格里的节点必须报「不在」。**
   * 卡级的整句说明（`set.adminTokenNote` / `set.card.upstreamNote`）是刻意留在网格
   * 外面的——它们说的是整张卡，不是某一格字段。尺子若退化成「恒返回一个祖先」，
   * 上面那格会永远绿，而这一格当场红。
   */
  it("反向控制：卡级的那两句说明确实不在网格里", async () => {
    const h = await openSettings();
    const section = h.section("settings");
    const inside = section.querySelectorAll("[data-i18n]")
      .filter((n) => ["set.adminTokenNote", "set.card.upstreamNote"].includes(n.getAttribute("data-i18n") ?? ""))
      .filter((n) => ancestorWith(n, "cfg-grid") !== null)
      .map((n) => n.getAttribute("data-i18n"));
    expect(
      inside.sort(),
      "卡级说明被塞进了网格 —— 它会被当成一格字段去排，而它说的是整张卡",
    ).toEqual([]);
    // 上面那条 `toEqual([])` 在「一句都没找到」时同样成立 ⇒ 先证这两句真的在屏幕上。
    expect(
      section.querySelectorAll("[data-i18n]")
        .map((n) => n.getAttribute("data-i18n"))
        .filter((k) => k === "set.adminTokenNote" || k === "set.card.upstreamNote")
        .sort(),
      "这两句卡级说明在设置页上一句都找不到 —— 上面那格比的是空集",
    ).toEqual(["set.adminTokenNote", "set.card.upstreamNote"]);
  });

  /**
   * 网格是**卡内**的东西，不是把四张卡拆散的东西：每个 `.cfg-grid` 都得住在某张卡里。
   * 少了这一条，把整页字段收进一个页面级大网格同样能让上面第一格全绿，
   * 而那会把「哪一格属于哪张卡」这件事从屏幕上抹掉。
   */
  it("每个 .cfg-grid 都住在某张卡里 —— 网格不许越过卡的边界", async () => {
    const h = await openSettings();
    const grids = h.section("settings").querySelectorAll(".cfg-grid");
    expect(grids.length, "设置页上一个 .cfg-grid 都没有").toBeGreaterThan(0);
    expect(
      grids.filter((g) => ancestorWith(g, "card") === null).length,
      "有网格跑到卡外面去了 —— 那样「哪一格属于哪张卡」在屏幕上就没了",
    ).toBe(0);
  });
});
