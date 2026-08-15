export const MODELS = [
  "agnes-2.0-flash",
  "agnes-image-2.1-flash",
  "agnes-image-2.0-flash",
  "agnes-video-v2.0",
];

export function modelListResponse(created: number) {
  return {
    object: "list",
    data: MODELS.map((id) => ({ id, object: "model", created, owned_by: "agnes2api" })),
  };
}
