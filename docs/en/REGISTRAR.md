# Registrar (auto-refill)

**Language:** English | [简体中文](../zh-CN/REGISTRAR.md) | [繁體中文](../zh-TW/REGISTRAR.md) | [日本語](../ja/REGISTRAR.md) | [한국어](../ko/REGISTRAR.md)

> **Disabled by default.** `REGISTRAR_ENABLED` defaults to `false`. Installing the project does
> not start any account registration on its own — you must explicitly set it to `true`.

## What it is

The registrar is an optional component: when the number of usable keys in the pool drops below
`TARGET_KEYS`, it automatically registers a new Agnes account, logs in, and mints an API key into
the pool. Registration requires receiving a verification code by email, so it depends on one of
the mailbox channels below.

> **Compliance notice**
>
> Bulk account registration is in tension with Agnes's terms of service. Whether to enable the
> registrar, and at what frequency, is a judgment call the operator has to make and take
> responsibility for — this project does not make that decision for you.

## Two mailbox channels: how to choose

The registrar supports two mailbox channels for receiving verification codes:

| | YYDS Mail | MoeMail |
|---|---|---|
| Nature | A third-party temporary-mailbox service | A temporary-mailbox service you self-host |
| API base URL | Has a default (`YYDS_BASE_URL`, its public API endpoint) | No default (`MOEMAIL_BASE_URL`) — fill in the address of your own instance |
| Getting credentials | Apply for an API key from the service (`YYDS_API_KEY`) | Generate an API key inside your own instance (`MOEMAIL_API_KEY`) |

**The two channels are fully equal — this project sets neither as primary and recommends
neither.** `REGISTRAR_PRIMARY` has no default; you must explicitly set it to `yyds` or `moemail`
when enabling the registrar. `REGISTRAR_FALLBACK` is optional: when the primary channel hits a
**channel-level failure** (listing domains fails, mailbox creation fails repeatedly, invalid
credentials, the verification code never arrives), the registrar falls back to it automatically
for that attempt. Leave it empty to disable fallback.

> "The verification code never arrives" counts as a channel-level failure: the code is delivered
> *through* that mailbox channel, so a broken MX record or a deleted mail-forwarding rule — every
> API call returns 2xx, the mail simply never shows up — likewise means "this channel cannot
> produce a key right now".

What to base the choice on: the registrar works around Agnes blocking disposable-mailbox domains
by rotating domains, so the more usable domains you have, the longer it keeps working. Check how
many usable domains you actually have on each side and pick the one with more as your primary —
that depends only on your own account or self-hosted setup, not on which service it is.

## Zero built-in credentials — bring your own

This repository does not ship any real keys, accounts, or private domains. Before enabling the
registrar you need to prepare, on your own:

- **Using YYDS Mail**: apply for an API key from the service and set `YYDS_API_KEY`
  (`YYDS_BASE_URL` already has a default and usually doesn't need to change).
- **Using MoeMail**: self-host a MoeMail instance, put its address in `MOEMAIL_BASE_URL`, and put
  the API key generated inside that instance in `MOEMAIL_API_KEY` (neither has a default — both
  must be set explicitly).

At minimum, prepare credentials for whichever channel `REGISTRAR_PRIMARY` points to. If you also
set `REGISTRAR_FALLBACK`, prepare credentials for that channel as well.

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `REGISTRAR_ENABLED` | no | `false` | Master switch; must be `true` to enable the registrar. |
| `REGISTRAR_PRIMARY` | required once enabled | none | Primary channel, `yyds` or `moemail`; the two are equal, no default. |
| `REGISTRAR_FALLBACK` | no | empty (no fallback) | Fallback channel, `yyds` or `moemail`; used when the primary hits a channel-level failure. |
| `TARGET_KEYS` | no | `20` | Target number of usable keys; a refill round only triggers below this. |
| `MINT_BATCH` | no | `5` | Maximum keys minted per round. |
| `TEND_INTERVAL_MS` | no (Node/Docker only) | `1800000` (30 min) | Node-side refill scheduling interval; on the Worker this is instead governed by the Cron in `wrangler.toml` — see below. |
| `CODE_TIMEOUT_MS` | no | `120000` (120s) | Timeout waiting for the verification code on a single mint attempt. |
| `MINT_DELAY_MIN_MS` | no | `2000` | Lower bound of the random delay between mint attempts within a round (ms). |
| `MINT_DELAY_MAX_MS` | no | `5000` | Upper bound of the random delay between mint attempts within a round (ms). |
| `MAX_DOMAIN_ATTEMPTS` | no | `8` | Maximum number of temp-mailbox domains tried per mint attempt. |
| `REGISTRAR_TOKEN_NAME` | no | `auto` | The display name given to the minted key in the Agnes dashboard. |
| `AGNES_PLATFORM_URL` | no | `https://platform-backend.agnes-ai.com` | Agnes platform backend used for registration, login, and key minting (vendor's public endpoint). |
| `YYDS_BASE_URL` | no | `https://maliapi.215.im` | YYDS Mail API base URL (vendor's public endpoint). |
| `YYDS_API_KEY` | required if a channel is `yyds` | empty | YYDS Mail API key. |
| `MOEMAIL_BASE_URL` | required if a channel is `moemail` | empty | Address of your own MoeMail instance, no default. |
| `MOEMAIL_API_KEY` | required if a channel is `moemail` | empty | API key for that MoeMail instance. |

`MINT_DELAY_MIN_MS`, `MINT_DELAY_MAX_MS`, `REGISTRAR_TOKEN_NAME`, and `AGNES_PLATFORM_URL` aren't listed
in `.env.example` by default (the defaults are usually fine), but both deployment targets read
them and you can set them if needed. Every numeric variable above must be a positive integer; the
gateway refuses to start otherwise.

## Scheduling differences between the two runtimes

| Deployment target | Trigger | What controls the interval |
|---|---|---|
| Cloudflare Worker | Cron under `[triggers]` in `wrangler.toml` (default `*/30 * * * *`, every 30 minutes) | Edit the cron expression in `wrangler.toml` |
| Node / Docker | An in-process timer | `TEND_INTERVAL_MS` (default `1800000` ms) |

Both runtimes ultimately call the same refill function with the exact same configuration — the
only difference is who is responsible for triggering it on time.

### Cloudflare Cron Trigger's wall-clock limit (read before tuning the numbers)

If you deploy to the Worker, refills are triggered by a Cron Trigger. Be aware of the following:

- A single Cron Trigger invocation has a wall-clock limit of **15 minutes (900 seconds)**.
- **`ctx.waitUntil()` does not extend this limit** — that grace period only applies to HTTP
  requests, not to Cron-triggered invocations.
- The CPU time limit is 30 seconds, but the `await`ed network calls during a refill (sending and
  polling for the verification code) don't count against CPU time, so the CPU limit isn't the
  real constraint.
- Every HTTP request on the registrar's path carries a **15-second per-request timeout**
  (a fixed value, not configurable). It is what makes the two estimates below meaningful:
  without it, a single hung connection can stretch a round indefinitely.
- **Typical duration** (every request returns quickly and the first domain isn't blocked) is
  dominated by waiting for the verification code: roughly `MINT_BATCH × CODE_TIMEOUT_MS` =
  5 × 120s = 600s, plus up to ~20s from the random delays between mint attempts within a round
  (at most 4 gaps, up to 5s each) — about **600–620s** total, leaving roughly **30% headroom**
  under the 900s wall-clock limit.
- **Theoretical worst case** has to include the per-request timeout. Besides polling for the
  code, one mint issues "1 request to list domains + 3 per domain attempted (create mailbox,
  send code, delete mailbox) + 3 more (register, log in, create key)", i.e.
  `CODE_TIMEOUT_MS + (1 + 3 × MAX_DOMAIN_ATTEMPTS + 3) × 15s`, which is about
  120 + 420 = **540s** with the defaults; multiplied by `MINT_BATCH` that is far beyond 900s.
  In other words, **the default configuration can hit the wall-clock limit in pathological
  cases** — a deliberate trade-off: each key is persisted the moment it is minted, so being
  aborted only leaves the round incomplete (see the next bullet). If you want even the
  pathological case to stay within the wall clock, set `MINT_BATCH` to 1–2, or lower
  `CODE_TIMEOUT_MS` / `MAX_DOMAIN_ATTEMPTS`.
- **With `REGISTRAR_FALLBACK` configured, multiply the *worst case* by the number of channels
  (i.e. ×2); the typical duration is unchanged.** In the typical case the code arrives and the
  fallback is never engaged; only a channel-level failure such as "the verification code never
  arrives" makes the same refill slot wait out another `CODE_TIMEOUT_MS` on the fallback. The
  startup warning `TEND_INTERVAL_MS is below the worst-case round duration` uses exactly this
  model: `MINT_BATCH × CODE_TIMEOUT_MS × number of channels`.
- **On Worker the registrar stops on its own before the wall clock runs out** — this covers the
  "worst case" bullet above, but *not* the "theoretical worst case" one. Before starting each
  mint it checks whether the remaining wall clock can hold one complete mint
  (`CODE_TIMEOUT_MS × number of channels`, plus the inter-attempt delay). If it cannot, that
  attempt is **never started**: the round ends early, a `registrar.round_budget_exhausted`
  warning is logged (something like "not enough wall-clock budget left to complete another
  mint, ending the round early"), keys already minted are kept, and the remaining slots roll
  over to the next scheduled round. (If even the *first* attempt doesn't fit, a different event
  fires instead — `registrar.round_budget_impossible`, at error level; see "Do not set
  `CODE_TIMEOUT_MS` too high" below.)
  Not starting is the whole point, as opposed to being cut off mid-flight: when the platform
  aborts a round, the temporary mailbox in use at that moment is never deleted (it expires ~24h
  later on YYDS via `expiresAt`, or after the 1h TTL on MoeMail).
  So on Worker **`MINT_BATCH` is a per-round ceiling, not a guarantee**: the round may simply not
  fill it. Node/Docker has no platform wall clock, does not engage this mechanism, and will use
  `MINT_BATCH` in full.
- **⚠️ The budget is not a blanket guarantee — a residual case remains.** The check only counts
  the dominant term, `CODE_TIMEOUT_MS × number of channels`. It deliberately does **not** include
  the 15-second per-request timeouts or the 403 back-offs: including them would mean no attempt
  ever dares to start, since the "theoretical worst case" above already exceeds 900s on its own.
  The budget is 87% of the wall clock, and the ~120s left over is what covers those tails. So:
  - **"the upstream simply isn't delivering the verification code"** — the common slow case in
    this section — **is fully covered**;
  - **"nearly every HTTP request hangs for its full 15s"** is pathological: a single attempt can
    exceed the reserved headroom and still be aborted by the platform, leaving that temporary
    mailbox behind. If that worries you, work the "theoretical worst case" formula above and set
    `MINT_BATCH` to 1–2, or lower `CODE_TIMEOUT_MS` / `MAX_DOMAIN_ATTEMPTS`.
- **Do not set `CODE_TIMEOUT_MS` too high.** Once `CODE_TIMEOUT_MS × number of channels` exceeds
  the per-round budget (87% of the wall clock), **no attempt can start at all** on Worker and the
  refill produces nothing, round after round. Two log lines cover this — grep by **event name**
  (see "Troubleshooting" below; more reliable than grepping prose, which can drift across
  wording changes, and — being Chinese in this doc's examples until now — was never greppable
  for non-Chinese-reading operators in the first place):
  - **At startup**, a **warning** (`console.warn`), event name
    `registrar.attempt_exceeds_worker_budget` (`grep 'registrar.attempt_exceeds_worker_budget'`),
    something like
    `[registrar] registrar.attempt_exceeds_worker_budget CODE_TIMEOUT_MS times the channel
    count exceeds the Worker per-round wall-clock budget codeTimeoutMs=... chainLength=...
    worstAttemptMs=... workerRoundBudgetMs=...`.
    It does **not** stop the gateway from starting — unlike "missing credentials fail at
    startup". Node/Docker has no platform wall clock and the same configuration is perfectly
    valid there, so both runtimes print this warning but only Worker is actually affected.
  - **On every Worker refill round** where not even the first attempt fits, an **error**
    (`console.error`), event name `registrar.round_budget_impossible`
    (`grep 'registrar.round_budget_impossible'`), something like
    `[registrar] registrar.round_budget_impossible the worst-case time for one mint already
    exceeds this round's wall-clock budget, not a single attempt can start
    worstAttemptMs=... roundBudgetMs=...`.
    It repeats every round, which is how you tell this is a standing condition rather than a
    one-off.
- **Before raising `MINT_BATCH`, `CODE_TIMEOUT_MS` or `MAX_DOMAIN_ATTEMPTS`, work the numbers
  out with both formulas above.** When the limit is hit, the platform aborts that Cron
  invocation.
- Being aborted does not lose any key that was already minted — each key is written to storage
  as soon as it's minted, so an interrupted round is simply incomplete; the next scheduled round
  picks up where it left off.

## How soon a freshly minted key reaches the forwarding path

**At most one `POOL_CACHE_TTL_MS` (60 seconds by default) — not "the next request".**

Top-up and forwarding use two independent key-pool repository instances. The top-up one really
reads storage every round (it has to see the true current availability, otherwise it would
re-mint and burn mailbox quota for nothing); the forwarding one holds an isolate/process-level
snapshot. Each keeps its own cache, so after top-up writes a key, the forwarding path only sees
it once **its own** snapshot expires. On the Worker this is per active isolate, each with its own
TTL.

**This is easiest to misread when the pool has been drained**: the log already says
`[registrar] … minted=1` while the gateway keeps returning `503 pool_empty` for up to one TTL.
That does not mean the top-up failed — wait one `POOL_CACHE_TTL_MS`. Lower the value to shorten
the window (see the quota budget in [DEPLOY.md](DEPLOY.md) for the cost).

## Why keys are minted sequentially, not concurrently

A refill round mints keys **sequentially** within the round, with a random delay between
attempts, rather than firing off several mint requests concurrently. This is not a performance
trade-off — it's a functional constraint: concurrency would trip both YYDS Mail's mailbox-creation
rate limit (returns `403` after roughly 10 creations in a short window) and Agnes's own
registration risk controls. Sequential execution with random delays is a prerequisite for the
registrar to keep working, not something you should "optimize away" with concurrency.

## Privacy

The email address, account, and password generated during registration only live in memory for
the duration of one mint attempt — **they are discarded once used and never persisted**. Storage
only ever contains the minted API key records. The temporary mailbox is deleted after every mint
attempt, whether it succeeded or failed.

## Troubleshooting

- **If credentials are missing while enabled, the process fails to start and tells you which
  variable is missing.** The registrar follows a fail-closed policy — missing credentials never
  degrade silently, they fail the gateway loudly so the problem is easy to spot.
- Refill logs are consistently prefixed with `[registrar]`, so you can filter for them. The
  second field on every log line is a stable, machine-readable **event name** (e.g.
  `registrar.round_budget_impossible`). Grepping by event name is more reliable than grepping
  the human-readable message: the message is prose and can change wording; the event name is
  the one part of this logging that's a stable public contract, and it doubles as a
  language-neutral anchor for operators who don't read Chinese.
- **When a round leaves slots unminted, the closing log adds a warning containing `reasons=`**,
  e.g. `reasons=yyds:register_failed×3 moemail:code_timeout×1`. Read that line first to tell
  which layer broke: `code_timeout` = this channel is not receiving Agnes' mail (MX record /
  forwarding rule); `register_failed` / `login_failed` / `key_failed` = Agnes changed its
  sign-up path; `provider_error` = the mailbox service itself (credentials, active-mailbox
  quota, outage); `provider_missing` = an internal wiring error; it should not appear
  under a normal configuration (missing credentials fail at startup, long before this).
- If a channel keeps failing to register (for example, Agnes has tightened its verification-code
  or CAPTCHA policy), that's an upstream change no amount of code can work around. You can disable
  the registrar and switch to manually importing keys instead (see [DEPLOY.md](DEPLOY.md)).
