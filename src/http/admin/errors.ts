import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { AdminErrorCode } from "../../core/admin/admin-errors.js";

/**
 * `/admin/api/*` 那一族错误的信封。
 *
 * ⚠️⚠️ **它与 `src/http/errors.ts` 的 `httpError()` 刻意是两个函数，别合并。**
 * 那一份是**四协议对外响应体**的形状，被五语言 API.md 逐字写死；这一份多一格
 * `code`，只服务于「面板拿码查五语言字典」。合成一个带可选 `code` 的函数之后，
 * 「顺手给网关那一族也传一个码」就只差一个参数——而那正是 P3e 明确不做的那一半，
 * 半做会造出「一半端点有码一半没有」的第三种状态。
 * 网关那一族一个码都没有，由 `tests/unit/admin/admin-errors.test.ts` 的
 * 「网关业务口那一族一个 code 都不许有 —— 半做会造出第三种状态」钉着。
 *
 * ⚠️⚠️ **`message` 一个字都不许删。** 它是**给日志与 API 客户端**的，删掉等于把
 * 排障信息一起扔了。`code` 是**并列**新增的一格，不是替换。
 * ⇒ 于是这里定死一条口径：**`message` 不是对外契约，`code` 才是。**
 * `message` 的措辞可以随时改而不算破坏兼容；面板不许解析它（只在遇到表外的码时
 * 原样回落展示，并且带一个看得见的标记，见 `admin-ui/js/pure/keys-write.mjs`
 * 的 `adminErrorText`）。
 *
 * `params` 是给字典插值用的（`note 最长 {max} 个字符` 那一族）。**它会被原样画到屏幕上**，
 * 所以有三条口径，**每条都有一格断言**：
 *
 * ① **一个汉字都不许有**——它会被插进 ja/ko 的句子里，那就是这次要关掉的破口的微缩版。由
 *   `tests/contract/admin-keys-write.test.ts`「params 里一个中文字符都不许有 —— 插进 ja/ko 的句子里就是同一个破口」
 *   钉着，自带反向控制那一格。
 * ② **永不放凭据，也永不放请求体里任何字段的值**。由
 *   `tests/contract/admin-keys-write.test.ts`「params 永不回显请求体里字段的值，而 unknown_field 的 fields 确实逐字回显字段名」
 *   钉着：一个探针值被塞进若干条路径的值位，**每一条码**的响应 `params` 里都不许回显它。
 * ③ ⚠️ **但它确实会逐字回显调用方送来的字段名**：`unknown_field` 的 `fields` 就是
 *   `handlers/keys-write.ts` 的 `rejectUnknown()` 把多余的键名 `join` 出来的
 *   ——送 `{"<img src=x>": 1}` 就会原样回到 `params.fields`。**这是这条码的用途，不是漏**：
 *   不说是哪几个字段的话，`unknown_field` 就退化成一句「有个字段不对」。上面那一格的后半段
 *   反过来要求这个回显**必须在**（它同时是 ② 那条判据的反向控制）。
 *   它落到屏幕上走 `admin-ui/js/ui.js` 的 `el()`（`textContent`，不是 `innerHTML`），而
 *   `tests/ui/api-session.test.ts`「admin-ui/js 下零处 innerHTML / insertAdjacentHTML / document.write —— 拼 HTML 那条盲点今天没有入口」
 *   钉着「`admin-ui/js` 下零处 `innerHTML`」这件事本身。
 *
 * ⚠️⚠️ **上一版这里写的是「只放数字与短标识，永不放用户输入」——那是一句假话**
 *（Task 22A 复评实测：`params.fields` 回显了调用方送进来的字段名逐字原文），
 * 而且当时零测法。**别再把 ③ 压回 ② 里去。**
 */
export type AdminErrorParams = Record<string, string | number>;

/** 管理接口错误的响应体。**`code` 与 `message` 并列**，两个都在。 */
export interface AdminErrorBody {
  error: {
    type: string;
    code: AdminErrorCode;
    message: string;
    params?: AdminErrorParams;
  };
}

export function adminErrorBody(
  type: string, code: AdminErrorCode, message: string, params?: AdminErrorParams,
): AdminErrorBody {
  return { error: params === undefined ? { type, code, message } : { type, code, message, params } };
}

/** 抛出后由 `app.onError` 原样返回，供 handler 里做提前返回。 */
export function adminError(
  status: number, type: string, code: AdminErrorCode, message: string, params?: AdminErrorParams,
): HTTPException {
  const res = new Response(JSON.stringify(adminErrorBody(type, code, message, params)), {
    status,
    headers: { "content-type": "application/json" },
  });
  return new HTTPException(status as never, { res });
}

/**
 * 管理树自己的请求体解析。
 *
 * ⚠️ **不能直接用 `src/http/errors.ts` 的 `readJson()`**：它抛的是不带 `code` 的
 * 网关信封，而畸形 JSON 这一档在面板上是**看得见**的（导入弹窗里粘错东西就会走到）
 * ⇒ 走那一份等于在这条最常见的路径上把破口原样留着，而「面不许增长」那道扫描
 * 只数 `src/http/admin/` 下的落点、**看不见一次跨文件的函数调用**——
 * 这正是「第二层替第一层挡住变异」的形状。
 * 「管理树不许再引用那一份」由 `tests/unit/admin/admin-errors.test.ts` 的
 * 「src/http/admin/ 下不许再 import 网关那份 readJson —— 它抛的信封没有 code」钉着。
 */
export async function readAdminJson<T>(c: Context): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw adminError(400, "invalid_request_error", "bad_json", "请求体不是合法的 JSON");
  }
}
