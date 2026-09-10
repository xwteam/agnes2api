import { describe, it, expect, afterEach, vi } from "vitest";
import { bootPanel, settle } from "./harness.js";
import { KEY_STORE, SAVED_AT_STORE } from "../../../admin-ui/js/pure/storage-keys.mjs";
import { KEY_PLACEHOLDER } from "../../../admin-ui/js/pure/examples.mjs";
import { MASTER_KEY_PATH } from "../../../admin-ui/js/pure/settings.mjs";
import { I18N } from "../../../admin-ui/js/i18n-dict.js";
import type { FakeElement } from "../../helpers/fake-dom.js";

/**
 * **设置页卡 1 顶上那一行「主 API 密钥」。**
 *
 * `tests/ui/settings.test.ts` 的 `masterKeyView()` 那一族把取值测得很细，
 * 但**没有任何东西验证板块文件真的把那一行画了出来、真的把那颗按钮接上了**
 * ——把 `buildMasterRow()` 整个删掉，纯函数用例一条都不红。这一组补的就是那一半。
 *
 * ⚠️⚠️ **本组最要紧的那一格是「复制按钮到底复制了什么」。** 面板在结构上拿不到明文
 *（设计 §8.6：`GET /admin/api/config` 对凭据只交出「配没配」与末 4 位），
 * 照抄一颗「复制密钥」按钮的结果是点一下往剪贴板里塞一个**空串**，
 * 而那种失败在屏幕上完全看不出来——toast 照样说「已复制」。
 * ⇒ 这里逐字断言它送出去的是 `KEY_PLACEHOLDER`，**并且非空**。
 *
 * ── 替身能力核对（`tests/ui/dom/fake-dom-parity.test.ts` 那张权威表）────────────
 * 本组新增的发货代码（`buildMasterRow()` / `renderMaster()`）用到的 DOM 成员是
 * `createElement` / `setAttribute` / `textContent` / `appendChild` / `addEventListener`
 * ——`FAKE_ONLY_MEMBERS` 一条都没用到，`KNOWN_BLIND_SPOTS` 三条也一条都没踩
 *（这段不遍历子树、不碰表单、没有禁用态）。
 */

const TOKEN = "admin-token-0123456789-ok!";
const NOW = 1_700_000_000_000;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Resp = { status: number; body: unknown };
const ok = (body: unknown): Resp => ({ status: 200, body });

/**
 * 一份**只够这一组用**的 `GET /admin/api/config` 响应。
 *
 * ⚠️ **刻意不复用 `settings-save.test.ts` 里那份大夹具**：本组只读 `credentials`
 * 那一格，而那份夹具的 24 个 `fields` 会让「这一格为什么变了」难以定位。
 * `secrets` / `editable` / `resetBlocked` 这几格是真机恒有的，缺了它们板块会走进
 * 另一条分支（诊断态），那时本组测的就不是同一件事了。
 */
function body(cred: unknown): unknown {
  return {
    fields: {},
    credentials: cred,
    configDegraded: false,
    editable: [],
    secrets: [MASTER_KEY_PATH],
    resetBlocked: [],
    propagation: { configTtlMs: 30000, visibilityUpperBoundMs: 30000 },
  };
}

async function openSettings(respond: (url: string, method: string) => Resp) {
  const h = await bootPanel({
    now: NOW,
    store: { [KEY_STORE]: TOKEN, [SAVED_AT_STORE]: String(NOW - 1000) },
    respond,
  });
  await settle();
  h.dom.document.querySelectorAll(".nav-item")
    .find((b) => b.getAttribute("data-section") === "settings")!
    .click();
  await settle();
  return h;
}

/** 主密钥那一行的根节点。**按 `data-master-key` 找**，不按位置——插一张卡就会漂。 */
function masterRow(h: Awaited<ReturnType<typeof openSettings>>): FakeElement {
  const node = h.section("settings").walk()
    .find((n) => n.getAttribute("data-master-key") === MASTER_KEY_PATH);
  if (!node) throw new Error("设置页上找不到主 API 密钥那一行");
  return node;
}

function childText(row: FakeElement, cls: string): string {
  const node = row.children.find((c) => c.classList.contains(cls));
  if (!node) throw new Error(`主密钥那一行里没有 .${cls}`);
  return node.textContent;
}

/** 字典里这一条在**面板当前语言**下的原文。**不在用例里抄中文。** */
function say(h: Awaited<ReturnType<typeof openSettings>>, key: string): string {
  const lang = h.dom.byId("lang-select").value;
  const row = (I18N as unknown as Record<string, Record<string, string>>)[key];
  if (row === undefined) throw new Error(`字典里没有 ${key} —— 这一格比的是空串`);
  return row[lang]!;
}

describe("设置页卡 1：主 API 密钥那一行", () => {
  /**
   * 被守护的性质：**屏幕上那一行是掩码 + 末 4 位，逐字如此。**
   *
   * 变异验证（本任务实测）：把 `masterKeyView()` 的 `masked` 改成直接回 `v.hint`
   *（也就是"只画末 4 位、不加掩码"），这一格当场红并逐字点名两个串。
   */
  it("配了口令时，那一行印的是掩码加末 4 位，而且它就在卡 1 里", async () => {
    const h = await openSettings(() => ok(body({
      [MASTER_KEY_PATH]: { configured: true, hint: "wxyz", lockedBy: null },
    })));
    const row = masterRow(h);

    expect(childText(row, "cfg-master-value"), "掩码那一格不是「圆点 + 末 4 位」")
      .toBe("••••••••wxyz");
    expect(childText(row, "cfg-master-state")).toBe(say(h, "set.secretSet"));

    // **位置**：它必须在「认证密钥」那张卡里，而不是被顺手挂到别处。
    // 卡的形状是 `div.card.block` > `h3[data-i18n=set.card.auth]` + `div`（body）。
    const inAuthCard = row.parent?.parent?.children
      .some((c) => c.tagName === "h3" && c.getAttribute("data-i18n") === "set.card.auth");
    expect(inAuthCard, "主密钥那一行没挂在「认证密钥」那张卡里").toBe(true);
  });

  /**
   * 被守护的性质：**「没配」与「读不到」是两句话，一档都不许合并。**
   *
   * 把第三档并进「未配置」是当面说一句我们并不知道的话，而运维照着它去填一把新口令，
   * 会把一台其实配好了的网关的口令换掉。
   *
   * 变异验证（本任务实测）：把 `renderMaster()` 里那个三元的 `configured === null`
   * 分支删掉（读不到时落到「未配置」），第二个 case 当场红。
   */
  it.each([
    ["没配置", { [MASTER_KEY_PATH]: { configured: false, hint: null, lockedBy: null } }, "set.secretUnset"],
    ["整份凭据读不到", null, "set.meta.unreadable"],
  ])("%s：那一格画的是破折号，状态各说各的（合并成一句就是说了我们并不知道的话）", async (_name, cred, stateKey) => {
    const h = await openSettings(() => ok(body(cred)));
    const row = masterRow(h);

    // ⚠️ **破折号，不是一串光秃秃的圆点**：圆点会被读成「配了一把很短的口令」。
    expect(childText(row, "cfg-master-value"), "读不出末 4 位时画的不是破折号").toBe("—");
    expect(childText(row, "cfg-master-value")).not.toContain("•");
    expect(childText(row, "cfg-master-state")).toBe(say(h, stateKey));
  });

  /**
   * 被守护的性质：**那颗按钮送进剪贴板的是占位符常量本身，而且非空。**
   *
   * ⚠️ **`.not.toBe("")` 这一句不是废话**：本行要防的正是「照抄一颗复制密钥的按钮」
   * ——面板没有明文可复制，那种实现点一下写进去的就是空串，而 toast 照样说「已复制」。
   * `toBe(KEY_PLACEHOLDER)` 单独一条挡不住「占位符常量自己变成了空串」那种退化。
   */
  it("复制按钮送进剪贴板的，逐字是那份占位符常量（面板没有明文可复制）", async () => {
    const h = await openSettings(() => ok(body({
      [MASTER_KEY_PATH]: { configured: true, hint: "wxyz", lockedBy: null },
    })));
    const written: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async (s: string) => { written.push(s); } } });

    const btn = masterRow(h).children.find((c) => c.tagName === "button");
    expect(btn, "主密钥那一行上没有按钮").not.toBe(undefined);
    btn!.click();
    await settle(6);

    expect(written, "剪贴板一次都没被写").toHaveLength(1);
    expect(written[0], "送进剪贴板的不是那份占位符常量").toBe(KEY_PLACEHOLDER);
    expect(written[0], "送进剪贴板的是空串 —— 这正是「照抄一颗复制密钥按钮」的形态").not.toBe("");
  });

  /**
   * 被守护的性质：**明文一个字节都不许出现在这一行上。**
   *
   * 真机上后端根本不交出明文，所以这一格喂的是一份**被外部写坏的**响应
   *（`credentials` 里混进一格 `value`）——它模拟的是「哪天有人给后端加了明文回显」，
   * 而前端必须仍然只画掩码。由 `credentialView()` 只认 `configured` / `hint`
   * 这一条窄化保证，这一格是它在屏幕这一侧的兑现。
   */
  it("响应里混进明文时，屏幕上一个字节都不许出现它", async () => {
    const plain = "gw-secret-plaintext-must-not-render";
    const h = await openSettings(() => ok(body({
      [MASTER_KEY_PATH]: { configured: true, hint: "wxyz", value: plain, key: plain, lockedBy: null },
    })));

    expect(masterRow(h).textContent, "那一行把明文画出来了").not.toContain(plain);
    expect(h.dom.document.body.textContent, "整屏某处把明文画出来了").not.toContain(plain);
    // 反向自检：这一格不是因为整行空白才没命中。
    expect(childText(masterRow(h), "cfg-master-value")).toBe("••••••••wxyz");
  });
});
