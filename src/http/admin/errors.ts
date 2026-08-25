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
 * `params` 是给字典插值用的（`note 最长 {max} 个字符` 那一族）。**只放数字与短标识**，
 * 永不放用户输入、也永不放凭据：它会被原样画到屏幕上。
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
