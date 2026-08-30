# Registrar (auto-refill)

This page covers the registrar: what it does, how to pick between the two mailbox channels, which settings it takes, and how to read its logs and troubleshoot it once it runs.

> **Disabled by default.** `REGISTRAR_ENABLED` defaults to `false`. Installing the project does
> not start any account registration on its own — you must explicitly set it to `true`.

## What it is

The registrar is an optional component: when the number of usable keys in the pool drops below
`TARGET_KEYS`, it automatically registers a new Agnes account, logs in, and mints an API key into
the pool. Registration requires receiving a verification code by email, so it depends on one of
the mailbox channels below.

> [!WARNING]
> **Compliance notice**
>
> Bulk account registration is in tension with Agnes's terms of service. Whether to enable the
> registrar, and at what frequency, is a judgment call the operator has to make and take
> responsibility for — this project does not make that decision for you.

## Two mailbox channels: how to choose

The registrar supports two mailbox channels for receiving verification codes:

### The two channels side by side

| | YYDS Mail | MoeMail |
|----|---------|-------|
| Nature | A third-party temporary-mailbox service | A temporary-mailbox service you self-host |
| API base URL | Has a default (`YYDS_BASE_URL`, its public API endpoint) | No default (`MOEMAIL_BASE_URL`) — fill in the address of your own instance |
| Getting credentials | Apply for an API key from the service (`YYDS_API_KEY`) | Generate an API key inside your own instance (`MOEMAIL_API_KEY`) |

### Configuring the primary and the fallback

> [!IMPORTANT]
> **The two channels are fully equal — this project sets neither as primary and
> recommends neither.**

`REGISTRAR_PRIMARY` has no default; you must explicitly set it to `yyds` or `moemail` when
enabling the registrar. `REGISTRAR_FALLBACK` is optional: when the primary channel hits a
**channel-level failure** (listing domains fails, mailbox creation fails repeatedly, invalid
credentials, the verification code never arrives), the registrar falls back to it automatically
for that attempt. Leave it empty to disable fallback.

> "The verification code never arrives" counts as a channel-level failure: the code is delivered
> *through* that mailbox channel, so a broken MX record or a deleted mail-forwarding rule — every
> API call returns 2xx, the mail simply never shows up — likewise means "this channel cannot
> produce a key right now".

### How to pick your primary

What to base the choice on: the registrar works around Agnes blocking disposable-mailbox domains
by rotating domains, so the more usable domains you have, the longer it keeps working. Check how
many usable domains you actually have on each side and pick the one with more as your primary —
that depends only on your own account or self-hosted setup, not on which service it is.

## Zero built-in credentials — bring your own

This repository does not ship any real keys, accounts, or private domains. Before enabling the
registrar you need to prepare, on your own:

### What each channel needs

- **Using YYDS Mail**: apply for an API key from the service and set `YYDS_API_KEY`
  (`YYDS_BASE_URL` already has a default and usually doesn't need to change).
- **Using MoeMail**: self-host a MoeMail instance, put its address in `MOEMAIL_BASE_URL`, and put
  the API key generated inside that instance in `MOEMAIL_API_KEY` (neither has a default — both
  must be set explicitly).

### The minimum you have to prepare

At minimum, prepare credentials for whichever channel `REGISTRAR_PRIMARY` points to. If you also
set `REGISTRAR_FALLBACK`, prepare credentials for that channel as well.

## Configuration

```env
# ── Switch and channels ───────────────────────────────────────────
# Master switch. Must be true to enable the registrar. (optional, default false)
REGISTRAR_ENABLED=false
# Primary channel, yyds or moemail; the two are equal, no default.
# (required once the registrar is enabled)
REGISTRAR_PRIMARY=
# Fallback channel, yyds or moemail; used when the primary hits a channel-level
# failure. (optional, empty = no fallback)
REGISTRAR_FALLBACK=

# ── Refill pacing ─────────────────────────────────────────────────
# Target number of usable keys; a refill round only triggers below this.
# (optional, default 20)
TARGET_KEYS=20
# Maximum keys minted per round. (optional, default 5)
MINT_BATCH=5
# Node-side refill scheduling interval in ms; on the Worker this is instead
# governed by the Cron in wrangler.toml, see below.
# (optional, default 1800000 = 30 min, read by Node/Docker only)
TEND_INTERVAL_MS=1800000
# Timeout waiting for the verification code on a single mint attempt, in ms.
# (optional, default 120000 = 120s)
CODE_TIMEOUT_MS=120000
# Lower / upper bound of the random delay between mint attempts within a round,
# in ms. (optional, default 2000 / 5000)
MINT_DELAY_MIN_MS=2000
MINT_DELAY_MAX_MS=5000
# Maximum number of temp-mailbox domains tried per mint attempt.
# (optional, default 8)
MAX_DOMAIN_ATTEMPTS=8
# Display name given to the minted key in the Agnes dashboard.
# (optional, default auto)
REGISTRAR_TOKEN_NAME=auto

# ── Upstream and channel credentials ──────────────────────────────
# Agnes platform backend used for registration, login and key minting
# (the vendor's public endpoint). (optional)
AGNES_PLATFORM_URL=https://platform-backend.agnes-ai.com
# YYDS Mail API base URL (the vendor's public endpoint) and its API key.
# (base URL optional; the key is required if a channel is yyds — this
# repository ships no real credentials)
YYDS_BASE_URL=https://maliapi.215.im
YYDS_API_KEY=
# Address of your own MoeMail instance and its API key; neither has a default.
# (required if a channel is moemail)
MOEMAIL_BASE_URL=
MOEMAIL_API_KEY=
```

Every variable in the block above has its own line in `.env.example` (the defaults are usually
fine, so you rarely need to touch them), and both deployment targets read them. Every numeric
variable above must be a positive integer; the gateway refuses to start otherwise.

## Scheduling differences between the two runtimes

### Who triggers it, and where the interval comes from

| Deployment target | Trigger | What controls the interval |
|-----------------|-------|--------------------------|
| Cloudflare Worker | Cron under `[triggers]` in `wrangler.toml` (default `*/30 * * * *`, every 30 minutes) | Edit the cron expression in `wrangler.toml` |
| Node / Docker | An in-process timer | `TEND_INTERVAL_MS` (default `1800000` ms) |

Here is what each of the two settings looks like:

```toml
# wrangler.toml -- on the Worker the trigger interval comes only from here
[triggers]
crons = ["*/30 * * * *"]
```

```env
# .env -- the trigger interval on Node / Docker, in milliseconds
TEND_INTERVAL_MS=1800000
```

Both runtimes ultimately call **the same refill function**. The difference is **who is
responsible for triggering it on time**, and **where the trigger interval comes from**:

| | Trigger | Interval source | Effect of changing it |
|----|-------|---------------|---------------------|
| Node / Docker | An in-process self-rescheduling timer | `TEND_INTERVAL_MS` (env var > stored config > default `1800000`) | Takes effect **next round** (the current round finishes on the old interval first — up to 30 minutes by default). **No restart needed** |
| Cloudflare Worker | The platform's Cron Trigger | `[triggers].crons` in `wrangler.toml` | **Changing the config has no effect** — you must edit `wrangler.toml` and redeploy |

Every refill setting other than the trigger interval (`TARGET_KEYS`, `MINT_BATCH`, channel
credentials, …) really is identical between the two runtimes.

### Cloudflare Cron Trigger's wall-clock limit (read before tuning the numbers)

If you deploy to the Worker, refills are triggered by a Cron Trigger. Read this section before
touching any of the numbers.

#### The four hard limits the platform gives you

| Limit | Value | Notes |
|-----|-----|-----|
| Wall clock per invocation | **15 minutes (900 seconds)** | The Cron Trigger's hard limit; hitting it means the platform aborts the invocation. |
| `ctx.waitUntil()` | **Does not extend this limit** | That grace period only applies to HTTP requests, not to Cron-triggered invocations. |
| CPU time | 30 seconds | The `await`ed network calls during a refill (sending and polling for the verification code) don't count against CPU time, so the CPU limit isn't the real constraint. |
| Per-request timeout | 15 seconds | Carried by **every** HTTP request on the registrar's path; a fixed value, not configurable. |

**The per-request timeout is what makes the two estimates below meaningful**: without it, a
single hung connection can stretch a round indefinitely.

#### Two estimates for a single round

| Estimate | Formula | Result with the defaults |
|--------|-------|------------------------|
| **Typical duration** | `MINT_BATCH × CODE_TIMEOUT_MS` + the random delays within a round | 600 + 20 ≈ **600–620s**, leaving roughly **30% headroom** under the 900s wall-clock limit |
| **Theoretical worst case** (one mint) | `CODE_TIMEOUT_MS + (1 + 3 × MAX_DOMAIN_ATTEMPTS + 3) × 15s` | 120 + 420 = **540s**; multiplied by `MINT_BATCH` that is far beyond 900s |
| With `REGISTRAR_FALLBACK` set | the *worst case* × the number of channels (i.e. ×2) | the typical duration is unchanged |

- **Typical** means every request returns quickly and the first domain isn't blocked, so the time
  is dominated by waiting for the verification code: roughly `MINT_BATCH × CODE_TIMEOUT_MS` =
  5 × 120s = 600s, plus at most 4 random delays of up to 5s each, about 20s.
- **The request count in the worst case** comes from this: besides polling for the code, one mint
  issues "1 request to list domains + 3 per domain attempted (create mailbox, send code, delete
  mailbox) + 3 more (register, log in, create key)". In other words, **the default configuration
  can hit the wall-clock limit in pathological cases** — a deliberate trade-off: each key is
  persisted the moment it is minted, so being aborted only leaves the round incomplete. If you
  want even the pathological case to stay within the wall clock, set `MINT_BATCH` to 1–2, or
  lower `CODE_TIMEOUT_MS` / `MAX_DOMAIN_ATTEMPTS`.
- **The fallback raises the worst case only, never the typical one.** In the typical case the
  code arrives and the fallback is never engaged; only a channel-level failure such as "the
  verification code never arrives" makes the same refill slot wait out another `CODE_TIMEOUT_MS`
  on the fallback. The startup warning `TEND_INTERVAL_MS is below the worst-case round duration`
  uses exactly this model: `MINT_BATCH × CODE_TIMEOUT_MS × number of channels`.

#### On Worker the registrar stops on its own before the wall clock runs out

**This covers the "worst case" row above, but *not* the "theoretical worst case" one.** Before
starting each mint it checks whether the remaining wall clock can hold one complete mint
(`CODE_TIMEOUT_MS × number of channels`, plus the inter-attempt delay). If it cannot, that
attempt is **never started**: the round ends early, a `registrar.round_budget_exhausted` warning
is logged (something like "not enough wall-clock budget left to complete another mint, ending the
round early"), keys already minted are kept, and the remaining slots roll over to the next
scheduled round. If even the *first* attempt doesn't fit, a different event fires instead —
`registrar.round_budget_impossible`, at error level; see the next subsection.

Not starting is the whole point, as opposed to being cut off mid-flight: when the platform aborts
a round, the temporary mailbox in use at that moment is never deleted (it expires ~24h later on
YYDS via `expiresAt`, or after the 1h TTL on MoeMail). So on Worker **`MINT_BATCH` is a per-round
ceiling, not a guarantee**: the round may simply not fill it. Node/Docker has no platform wall
clock, so the **scheduled** round does not engage this mechanism and uses `MINT_BATCH` in full.

> [!IMPORTANT]
> **The panel's "Refill now" is the exception: both runtimes carry the same per-round budget.**
> How long a single click may run is a property of that button, not of the runtime, so a manual
> refill on Node/Docker can also mint fewer keys; the next scheduled round picks up the rest.

> [!WARNING]
> **The budget is not a blanket guarantee — a residual case remains.** The check only counts the
> dominant term, `CODE_TIMEOUT_MS × number of channels`. It deliberately does **not** include the
> 15-second per-request timeouts or the 403 back-offs: including them would mean no attempt ever
> dares to start, since the "theoretical worst case" above already exceeds 900s on its own. The
> budget is 87% of the wall clock, and the ~120s left over is what covers those tails:

| Where the slowness is | Does the budget cover it | Consequence |
|---------------------|------------------------|-----------|
| **The upstream isn't delivering the code** (the common slow case) | **Fully covered** | The round ends early; remaining slots roll over to the next scheduled round |
| **Nearly every HTTP request hangs for its full 15s** (pathological) | A single attempt can exceed the reserved headroom | It is still aborted by the platform, leaving that temporary mailbox behind |

If the second row worries you, work the "theoretical worst case" formula above and set
`MINT_BATCH` to 1–2, or lower `CODE_TIMEOUT_MS` / `MAX_DOMAIN_ATTEMPTS`.

#### Two log lines: grep them by event name when the limit is exceeded

**Do not set `CODE_TIMEOUT_MS` too high.** Once `CODE_TIMEOUT_MS × number of channels` exceeds the
per-round budget (87% of the wall clock), **no attempt can start at all** on Worker and the refill
produces nothing, round after round. Two log lines cover this — grep by **event name** (see
"Troubleshooting" below; more reliable than grepping prose, which can drift across wording
changes and is not translated into the language you are reading):

The two fences below are what the gateway prints **verbatim**: `msg` is hard-coded Simplified
Chinese in the source and is **not translated into the language of this page**; one entry is also
always a **single line** — `src/adapters/logger-console.ts` deliberately flattens newlines into
spaces, because a continuation line carries no `[registrar]` prefix and is therefore lost. So grep
by event name, never by the prose on this page.

**(1) At startup**, a **warning** (`console.warn`), event name
`registrar.attempt_exceeds_worker_budget` (`grep 'registrar.attempt_exceeds_worker_budget'`),
something like:

```text
[registrar] registrar.attempt_exceeds_worker_budget CODE_TIMEOUT_MS×通道数超过 Worker 单轮墙钟预算：Cloudflare Worker 形态下补池会一把 key 都铸不出来（每轮 attempted=0），请调小 CODE_TIMEOUT_MS 或去掉备通道。Node/Docker 的定时轮没有平台墙钟上限、不受此限制，但面板的「立即补池」在两种运行时上都带同一份轮级预算，Node/Docker 上同样铸不出来。 codeTimeoutMs=... chainLength=... worstAttemptMs=... workerRoundBudgetMs=...
```

It does **not** stop the gateway from starting — unlike "missing credentials fail at startup".
Node/Docker has no platform wall clock and the same configuration is perfectly valid there, so
both runtimes print this warning but only Worker is actually affected.

**(2) On every Worker refill round** where not even the first attempt fits, an **error**
(`console.error`), event name `registrar.round_budget_impossible`
(`grep 'registrar.round_budget_impossible'`), something like:

```text
[registrar] registrar.round_budget_impossible 单次铸 key 的最坏耗时已超过本轮墙钟预算，一次尝试都无法开始，补池将持续零产出——这是配置问题不是瞬时状况，请调小 CODE_TIMEOUT_MS 或去掉备通道 worstAttemptMs=... roundBudgetMs=...
```

It repeats every round, which is how you tell this is a standing condition rather than a one-off.

**Before raising `MINT_BATCH`, `CODE_TIMEOUT_MS` or `MAX_DOMAIN_ATTEMPTS`, work the numbers out
with both formulas above.** When the limit is hit, the platform aborts that Cron invocation.
Being aborted does not lose any key that was already minted — each key is written to storage as
soon as it's minted, so an interrupted round is simply incomplete; the next scheduled round picks
up where it left off.

## How the gap is computed (which keys occupy a `TARGET_KEYS` slot)

### Which of the four key states occupy a slot

Gap = `TARGET_KEYS` − **the number of keys that have not been evicted**. There is exactly one
criterion: **if `evicted` is false, it occupies a slot.**

| Key state | Occupies a `TARGET_KEYS` slot? | Usable for upstream calls? |
|---------|------------------------------|--------------------------|
| Fresh / available | Yes | Yes |
| **Cooling down** (rate-limited, consecutive failures) | **Yes** | No |
| **Disabled by an administrator** | **Yes** | No |
| Evicted (401/403, credentials dead) | No | No |

### Why a cooling key still occupies a slot

**"Cooling counts as occupied" is deliberate.** A cooldown is a state that **comes back on its
own**; treating it as a gap mints new accounts that **never go away** — one transient failure
buys you a permanent cost. Measured (`TARGET_KEYS=3`): if cooling did not occupy a slot, one
round in which the whole pool is rate-limited mints 3 more keys ⇒ pool becomes 6; once the
cooldown expires the gap goes negative and nothing is reclaimed ⇒ **it stays at 6 forever**;
the next storm makes it 9, then 12 — linear growth, and every single one of those is a real
Agnes sign-up plus a real temporary mailbox spent.

**The cost, stated plainly**: when the entire pool is cooling, the registrar will **not** mint
replacements, and the gateway keeps returning `503` for the duration of the cooldown (at most one
`COOLDOWN_PAYMENT_MS` / `COOLDOWN_STRIKE_MS`). To recover immediately, use "clear cooldown" on
those keys in the admin panel rather than expecting the registrar to do it.

## "Tend now" in the admin panel

That's the button in the admin panel (`POST /admin/api/registrar/tend`). A `202` means the round
**has started**; it keeps running after the response returns. Look at the "tend history" section
for the outcome — its `trigger` will read `manual`.

### The four guardrails

It has **four guardrails**; failing any one of them means the round never starts:

| Guardrail | Response when it fails | What it blocks |
|---------|----------------------|--------------|
| In-flight guard within the process / isolate | `409 tend_in_flight` | The scheduled round colliding with the button, and two concurrent clicks on one replica |
| Storage-level short lock (`registrar_tend_lock`) | `409 locked` | Overlap **across replicas** (several containers on a shared volume; the Worker's two isolates) |
| At least 10 minutes between two manual rounds | `429 manual_cooldown` | Click-spamming through your temporary-mailbox quota |
| At most **24** times per day | `429 write_budget_exhausted` | Click-spamming through your **storage write quota** (arithmetic in the "quota ledger" of [DEPLOY.md](DEPLOY.md)) |

The `429` body carries `remaining` (how many are left today), `resetAt` (recovers at UTC
midnight) and `retryAfterMs`. **The `202` body carries `remaining` too**, so the panel can state
the truth up front instead of waiting until the button stops working. When the registrar is off,
the endpoint answers `409 registrar_disabled`.

### The honest limits and the residual risk

> [!WARNING]
> **An honest limit — do not read this as "concurrency is solved".** KV is eventually
> consistent, so that storage lock is **best-effort, not a mutual-exclusion primitive**. What it
> blocks is the common case — "the previous round is clearly still running"; two clicks issued in
> the same millisecond can still both take it. The guard key and the tend history are read-modify-write
> as well, so updates can be lost inside a concurrency window — bounded by "the gate lets through at
> most (concurrency − 1) extra rounds, and the tend history misses at most (concurrency − 1) rows".

> [!WARNING]
> **Residual risk**: a manual round carries **the same per-round wall-clock budget as the
> Worker's Cron (780 s)**. Its job is "never start an attempt that is known not to fit"; it
> **does not eliminate leaks, it only lowers the probability** — the platform can still abort the
> call inside the budget window, and the temporary mailbox being minted at that moment is not
> deleted. Note this differs from the scheduled round: **the Node/Docker timer carries no such
> budget, while the manual round does**, so under the same configuration a manual round may mint
> fewer keys than a scheduled one; the remaining slots go to the next scheduled round.

### These three keys never expire on their own

`registrar_tend_lock`, `registrar_manual_guard` and `tend:history` **all carry no TTL**. Their
names are fixed literals and there is always exactly one of each; stale values are always decided
by **comparing values** (an expired lock blocks nobody, yesterday's counter does not count), so
leaving them behind is harmless.

**The cost, stated plainly**: if you turn the registrar off for good, or delete the deployment but
keep the KV namespace, they will not disappear. To clean up, delete the keys by hand:

- Worker: `wrangler kv key delete --binding=POOL registrar_manual_guard` (once per key)
- Node / Docker: edit `DATA_DIR/store.json` and remove those three top-level fields

**You usually want to keep `tend:history`**: it is exactly what you want during a post-mortem, and
"the tend history vanishes N days after the registrar was turned off" is the worst possible timing —
operators usually turn the registrar off **because** something went wrong.

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

### Startup and logging conventions

- **If credentials are missing while enabled, the process fails to start and tells you which
  variable is missing.** The registrar follows a fail-closed policy — missing credentials never
  degrade silently, they fail the gateway loudly so the problem is easy to spot.
- Refill logs are consistently prefixed with `[registrar]`, so you can filter for them. The
  second field on every log line is a stable, machine-readable **event name** (e.g.
  `registrar.round_budget_impossible`). Grepping by event name is more reliable than grepping
  the human-readable message: the message is prose and can change wording; the event name is
  the one part of this logging that's a stable public contract, and it doubles as a
  language-neutral anchor for operators who don't read Chinese.
### Reading the failure reasons in `reasons=`

- **When a round leaves slots unminted, the closing log adds a warning containing `reasons=`**,
  e.g. `reasons=yyds:register_failed×3 moemail:code_timeout×1`. Read that line first to tell
  which layer broke: `code_timeout` = this channel is not receiving Agnes' mail (MX record /
  forwarding rule); `register_failed` / `login_failed` / `key_failed` = Agnes changed its
  sign-up path; `provider_error` = the mailbox service itself (credentials, active-mailbox
  quota, outage); `provider_missing` = an internal wiring error; it should not appear
  under a normal configuration (missing credentials fail at startup, long before this).
- **`key_suspicious` shows up in `reasons=`**: the key material the upstream sent back contains
  non-printable characters or whitespace. **That round really did mint a key** (the Agnes account
  was really created and a temporary mailbox was really spent), so it **was stored in the pool
  anyway** — refusing it here would destroy a credential that can never be recovered. But it will
  most likely make forwarding fail every time it is selected, so disable or delete it from the
  admin panel. An error event `registrar.minted_key_suspicious` is emitted alongside it (it records
  only the channel and the length, **never the plaintext**).
### When a channel keeps failing

- If a channel keeps failing to register (for example, Agnes has tightened its verification-code
  or CAPTCHA policy), that's an upstream change no amount of code can work around. You can disable
  the registrar and switch to manually importing keys instead (see [DEPLOY.md](DEPLOY.md)).
