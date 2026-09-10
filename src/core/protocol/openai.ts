/**
 * `/v1/models` 与 `/v1beta/models` 两条列模型端点的**清单来源**。
 *
 * ⚠️ **它与 `src/core/admin/protocol-catalog.ts` 的 `MODEL_CATALOG` 必须逐条同序一致**
 * （`tests/unit/admin/protocol-catalog.test.ts`「模型 id 与 /v1/models 的来源逐条一致」
 * 用 `toEqual` 钉着）。这里只有 id，那边还带形态与端点归属——加模型要两边一起加。
 *
 * ⚠️ **这是一份写死的清单，不是运行时从上游拉回来的**，刻意如此：面板的模型表与
 * Playground 靠它做静态渲染，改成动态拉取要先回答「上游不可达时画什么、缓不缓存」
 * 两个问题。上游此刻真有哪些模型是另一个问题，走 `src/core/admin/upstream-models.ts`
 * 的差集呈现（那边的文件头写着两者为什么并存）。
 *
 * ⚠️ **顺序不是随手排的**：`MODEL_CATALOG[0]` 是验活 handler
 * （`src/http/admin/handlers/verify.ts`）与集成示例卡的默认模型，所以**对话模型排在最前**，
 * 媒体模型排在后面；同形态内部保持既有条目在前、新增条目在后，免得默认值随着补目录漂走。
 */
export const MODELS = [
  // 对话
  "agnes-2.0-flash",
  "agnes-2.5-flash",
  "agnes-2.5-pro",
  "agnes-2.5-pro-alpha",
  "agnes-2.5-pro-beta",
  "agnes-3.0-flash",
  // 图片
  "agnes-image-2.1-flash",
  "agnes-image-2.0-flash",
  "agnes-image-2.5-flash",
  // 视频
  "agnes-video-v2.0",
  "agnes-video-2.5",
  "agnes-video-2.5-flash",
];

export function modelListResponse(created: number) {
  return {
    object: "list",
    data: MODELS.map((id) => ({ id, object: "model", created, owned_by: "agnes2api" })),
  };
}
