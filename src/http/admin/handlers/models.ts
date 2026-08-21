import type { Context } from "hono";
import { catalogPayload } from "../../../core/admin/protocol-catalog.js";

/**
 * 四协议 × 模型的静态目录（设计 §11）。
 *
 * **零存储读**：全部来自模块级常量。它和 `capabilities` 一样是面板启动必调的静态数据，
 * 让它读一次存储就等于给每次刷新加一次 KV 读（设计 §2.4 第 1 条）。
 * 这条由 `tests/contract/admin-models.test.ts`
 * 「连打 20 次 /admin/api/models —— get / list / put / delete 计数一次都不增加」
 * 数着计数钉住。
 */
export function modelsHandler() {
  return (c: Context) => c.json(catalogPayload());
}
