import { describe, it, expect } from "vitest";
import {
  REVEAL_KINDS, createRevealState, revealMessageKey, revealOutcome, revealErrorOutcome,
} from "../../admin-ui/js/pure/reveal.mjs";

/**
 * 「掩码 / 点击显示明文 / 复制」的状态机。
 *
 * 这一族的由来：用户要求面板能显示与复制凭据明文（2026-09-10 拍板），
 * 而**对外 API 密钥从前只存 SHA-256**，为此把明文一并存了下来 ——
 * 那是一次以安全性换便利性的取舍，代价登记在
 * `src/core/admin/api-keys.ts` 的 `ApiKeyRecord.secret`。
 * 本文件钉的是**取回之后 UI 怎么表态**，尤其是三态不许被并成一句话。
 */
describe("revealOutcome：三态必须分得开", () => {
  it("拿到明文 ⇒ ok，两族的字段名各认各的", () => {
    expect(revealOutcome({ key: "sk-pool-plain" })).toEqual({ state: "ok", secret: "sk-pool-plain" });
    expect(revealOutcome({ secret: "sk-gateway-plain" })).toEqual({ state: "ok", secret: "sk-gateway-plain" });
  });

  /**
   * 🔴 **这一格是本组的立身之本。**
   * `unavailable`（签发在明文落盘之前，服务端从来就没有过它的明文 —— 一个**永远不会变**
   * 的事实，处置是重发一把）与 `failed`（这一次没拿到，重试可能就好）是两种不同的处置。
   * 并成「取不到」会让人对着一把**永远**取不回的密钥反复点。
   *
   * **变红条件**：把 `revealOutcome` 里 `issued_before_plaintext` 那一支删掉，
   * 让它和别的失败一样落进 `failed`。
   */
  it("签发于明文落盘之前 ⇒ unavailable，不许并进 failed", () => {
    const out = revealOutcome({ secret: null, reason: "issued_before_plaintext" });
    expect(out).toEqual({ state: "unavailable", reason: "issued_before_plaintext" });
    expect(revealMessageKey(out)).toBe("reveal.unavailable");
    expect(revealMessageKey({ state: "failed" }), "两态共用一句文案就等于没分开")
      .not.toBe(revealMessageKey(out));
  });

  it("坏形状一律 failed", () => {
    for (const bad of [null, undefined, "sk-x", 42, {}, { secret: null }, { key: 1 }]) {
      expect(revealOutcome(bad as never).state, `${JSON.stringify(bad)} 应当是 failed`).toBe("failed");
    }
  });

  /**
   * **空串不许被当成明文。**
   * 后端约定 `secret: null` 才是「没有」，空串既不是 null 也不是可用明文 ——
   * 真出现只可能是坏数据。把它当明文会往剪贴板里塞一个空串，
   * 而运维会以为自己复制到了东西。
   */
  it("空串按失败处置，绝不当明文", () => {
    expect(revealOutcome({ secret: "" }).state).toBe("failed");
    expect(revealOutcome({ key: "" }).state).toBe("failed");
  });

  it("ok 那一档没有文案键 —— 表外不兜底", () => {
    expect(revealMessageKey({ state: "ok", secret: "x" })).toBeNull();
  });
});

/**
 * **抛出来的那一族**（`js/api.js` 的 `ApiError`）怎么归档。
 *
 * 🔴 **这一组存在的理由是一条真缺陷**：`revealControls()` 的 `load()` 从前没有
 * `try/catch`，而 `json()` 对任何非 2xx 一律抛 ⇒ 那两颗按钮在**任何** HTTP 错误下
 * 静默无反应（只有控制台里一条无人接的 promise 拒绝）。于是 `revealOutcome()` 上方
 * 那句「`failed` 治的是网络断了 / 401 / 500」**在真实错误路径上到不了**：
 * 只有「200 但响应体畸形」走得进 `revealOutcome()`。
 *
 * ⚠️ **纯函数这一层只钉「怎么归档」，钉不住「有没有人去接」**：真的接住那一半在
 * `admin-ui/js/ui.js` 的 `load()` 里，由 `tests/ui/dom/reveal-controls.test.ts` 的
 * 「reveal 回 404：屏幕上必须出现一句话 —— 静默是本仓明令禁止的那一种坏法」那一格钉着。
 * 两格分工不同，缺哪一格都留着一整条路没人守。
 */
describe("revealErrorOutcome：抛出来的那一族也得有一句话", () => {
  /**
   * 🔴 **404 与「这一次没成」是两种处置，不许并档。**
   * 这两张表都是轮询刷新的：一条记录在别处被删掉之后屏幕上那一行还在，点下去必是 404。
   * 那一档的处置是「刷新列表」，`failed` 那一档是「等一会儿再点」。
   *
   * **变红条件**：把 `revealErrorOutcome()` 里那句 `status === 404` 删掉
   *（本任务变异实测：这一格与 DOM 那三格一起红）。
   */
  it("404 ⇒ gone（这一条已经不在了），不许并进 failed", () => {
    expect(revealErrorOutcome({ status: 404, body: { error: { code: "key_not_found" } } }))
      .toEqual({ state: "gone" });
    expect(revealMessageKey({ state: "gone" })).toBe("reveal.gone");
    expect(revealMessageKey({ state: "gone" }), "与「这一次没成」共用一句文案就等于没分开")
      .not.toBe(revealMessageKey({ state: "failed" }));
  });

  /**
   * **其余一律 failed，包括 401。**
   * 401 刻意不另起一档：`js/api.js` 对它已经先清凭据 + 弹登录闸了，那一屏本身就是
   * 最强的反馈；而「这一次没取到，稍后再试」对它也是真话。
   */
  it.each([
    ["服务端内部错", { status: 500 }],
    ["网关挂了", { status: 502 }],
    ["管理会话失效", { status: 401 }],
    ["被拒绝", { status: 403 }],
    ["fetch 自己抛的 TypeError（连请求都没发出去）", new TypeError("Failed to fetch")],
    ["压根不是个错误对象", null],
    ["状态码不是数", { status: "404" }],
  ])("%s ⇒ failed（重试可能就好了）", (_name, err) => {
    expect(revealErrorOutcome(err as never)).toEqual({ state: "failed" });
  });

  /** 四态各有各的一句话，且都在字典里 —— 少一句就是 `t()` 拿到 `null`。 */
  it("四态的文案键互不相同，一个都不许缺", () => {
    const keys = [
      revealMessageKey({ state: "unavailable" }),
      revealMessageKey({ state: "gone" }),
      revealMessageKey({ state: "failed" }),
      revealMessageKey({ state: "ok", secret: "x" }),
    ];
    expect(keys).toEqual(["reveal.unavailable", "reveal.gone", "reveal.failed", null]);
  });
});

describe("两族的端点各走各的", () => {
  it("路径按族区分，且 id 会被转义", () => {
    expect(REVEAL_KINDS.pool.path("9f2c")).toBe("/keys/9f2c/reveal");
    expect(REVEAL_KINDS.apikey.path("9f2c")).toBe("/apikeys/9f2c/reveal");
    // id 进 URL，**必须转义**：它虽然由后端生成，但拼 URL 时的转义是调用点的责任，
    // 不是「反正后端给的都是十六进制」这种对别处行为的假设。
    expect(REVEAL_KINDS.pool.path("a/b?c")).toBe("/keys/a%2Fb%3Fc/reveal");
  });

  it("两族的字段名不同 —— 这是刻意的，不是笔误", () => {
    expect(REVEAL_KINDS.pool.field).toBe("key");
    expect(REVEAL_KINDS.apikey.field).toBe("secret");
  });
});

describe("createRevealState：明文不跨渲染存活", () => {
  it("记住、隐藏、清空", () => {
    const st = createRevealState();
    expect(st.isShown("a")).toBe(false);
    expect(st.secretOf("a")).toBeNull();

    st.remember("a", "sk-aaa");
    expect(st.isShown("a")).toBe(true);
    expect(st.secretOf("a")).toBe("sk-aaa");

    st.hide("a");
    expect(st.isShown("a"), "隐藏之后不该还是明文态").toBe(false);
  });

  /**
   * **整表重建 / 切板块时必须清空。**
   * 列表随轮询整份重建；明文若跨渲染存活，它会跟着进下一次渲染、进任何对列表做的
   * 序列化。这一格钉住 `clear()` 真的把两条都清掉，而不是只清了第一条。
   */
  it("clear() 把所有条目一起清掉", () => {
    const st = createRevealState();
    st.remember("a", "sk-aaa");
    st.remember("b", "sk-bbb");
    st.clear();
    expect([st.isShown("a"), st.isShown("b")]).toEqual([false, false]);
  });
});
