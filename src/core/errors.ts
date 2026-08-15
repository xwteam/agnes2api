export type UpstreamAction =
  | { kind: "success" }
  | { kind: "cooldown"; ms: number; reason: string }
  | { kind: "evict"; reason: string }
  | { kind: "strike"; reason: string }
  | { kind: "passthrough" };

export function classifyStatus(
  status: number,
  cfg: { cooldownRateLimitMs: number; cooldownPaymentMs: number },
): UpstreamAction {
  if (status >= 200 && status < 300) return { kind: "success" };
  if (status === 429) return { kind: "cooldown", ms: cfg.cooldownRateLimitMs, reason: "rate limited" };
  if (status === 402) return { kind: "cooldown", ms: cfg.cooldownPaymentMs, reason: "payment required" };
  if (status === 401 || status === 403) return { kind: "evict", reason: `upstream ${status}` };
  if (status >= 500) return { kind: "strike", reason: `upstream ${status}` };
  return { kind: "passthrough" };
}

export function classifyThrown(err: unknown): UpstreamAction {
  const name = err instanceof Error ? err.name : "";
  return name === "AbortError"
    ? { kind: "strike", reason: "timeout" }
    : { kind: "strike", reason: "network error" };
}
