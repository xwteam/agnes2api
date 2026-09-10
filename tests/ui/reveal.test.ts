import { describe, it, expect } from "vitest";
import {
  REVEAL_KINDS, createRevealState, revealMessageKey, revealOutcome,
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
