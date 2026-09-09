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
| Shape of the address | The service root address, without an API path prefix such as `/v1` | The instance root address, likewise without an API path prefix |

That last row deserves a note of its own: the gateway's own `AGNES_BASE_URL` **does** carry
`/v1`, the two are not the same thing, and copying one into the other is the most common way
to get this wrong. Set it to `…/v1` and the registrar builds `…/v1/v1/domains`, which the
upstream answers with a 404. Failures like that now record **the address actually requested**
in the event (any username/password, query string and fragment inside it are replaced with
placeholder markers), so one look at the events is enough to recognise this trap.

### Choosing the channel

> [!IMPORTANT]
> **Pick one of the two channels. There is no primary/fallback pair and no automatic failover.**
> The two channels are fully equal — this project picks neither for you and recommends neither.

`REGISTRAR_CHANNEL` has no default; you must explicitly set it to `yyds` or `moemail` when
enabling the registrar. The selected channel receives the verification codes; the other one is
**never used even if you fill it in**, though you can set it up ahead of time and switch over
whenever you want.

> [!WARNING]
> **When the selected channel fails, the registrar does not switch to the other one.**
> If the code never arrives (a broken MX record, a deleted mail-forwarding rule — every API call
> returns 2xx, the mail simply never shows up), that means "this channel cannot produce a key
> right now", and this round — possibly this whole day — mints nothing until you switch channels
> yourself. See "What happens after a channel fails" below for the exact behaviour.

#### What about the legacy names

> This setting used to be called `REGISTRAR_PRIMARY`, with a `REGISTRAR_FALLBACK`
> beside it. The old primary name is **kept indefinitely as a compatibility alias** (lower
> precedence than the new name; a notice appears at the top of the panel when it is in use).
> The old fallback variable **no longer takes part in routing**, but it is still read once, only
> so the panel can name the channel that was dropped. Neither legacy name stops an upgrading
> deployment from running.

### How to pick that one channel

What to base the choice on: the registrar works around Agnes blocking disposable-mailbox domains
by rotating domains, so the more usable domains you have, the longer it keeps working. Check how
many usable domains you actually have on each side; the one with more lasts longer —
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

At minimum, prepare credentials for whichever channel `REGISTRAR_CHANNEL` points to. The other
channel's credentials may be filled in or left empty: they do not affect whether the registrar
starts. Filling them in makes that channel's "configured" flag and its "Test connection" button
work in the panel, which is handy for comparing the two before switching.

## Configuration

```env
# ── Switch and channels ───────────────────────────────────────────
# Master switch. Must be true to enable the registrar. (optional, default false)
REGISTRAR_ENABLED=false
# Which channel the registrar uses, yyds or moemail; pick one of the two, no default.
# (required once the registrar is enabled)
# The legacy name REGISTRAR_PRIMARY is kept indefinitely as a compatibility alias;
# the legacy fallback variable no longer takes part in routing.
REGISTRAR_CHANNEL=

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
# in ms. (optional, default 60000 / 90000)
# The lower bound was measured: from one egress address, spacing requests 60s apart
# kept succeeding, while firing them back to back got blocked on the third one by the
# rate limit in front of the upstream, with a penalty window of ten-odd minutes.
# The upper bound is only jitter headroom, not a measured value.
MINT_DELAY_MIN_MS=60000
MINT_DELAY_MAX_MS=90000
# Maximum number of temp-mailbox domains tried per mint attempt.
# (optional, default 1)
# The registrar now remembers which mail domains the upstream accepts and reuses them,
# so in steady state one successful mint costs exactly one send-code request.
# Raising this scales up how much of the rate-limit allowance each round burns
# (measured allowance: roughly 4-6 per window).
MAX_DOMAIN_ATTEMPTS=1
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
| **Typical duration** | `MINT_BATCH × CODE_TIMEOUT_MS` + `(MINT_BATCH − 1) × MINT_DELAY_MAX_MS` | 600 + 360 = **960s**, **already past the 900s wall clock** — see the round budget below |
| **Theoretical worst case** (one mint) | `CODE_TIMEOUT_MS + (3 × MAX_DOMAIN_ATTEMPTS + 3) × 15s + (MAX_DOMAIN_ATTEMPTS − 1) × MINT_DELAY_MAX_MS` | 120 + 90 = **210s** at cap 1 |

- **Typical** means every request returns quickly and the first domain isn't blocked, so the time
  is dominated by waiting for the verification code plus the gaps between slots:
  `MINT_BATCH × CODE_TIMEOUT_MS` = 5 × 120s = 600s, plus 4 gaps of up to 90s each = 360s.
- **That gap term used to be negligible; it no longer is.** After `MINT_DELAY_MAX_MS` went
  from 5s to 90s it grew from 20s to 360s, putting the worst round at 960s > 900s.
  **This is not a new defect** — the round budget below exists precisely for it: on Worker the
  worst case still completes 4 slots and leaves the 5th to the next round.
- **The request count in the worst case** comes from this: besides polling for the code, one mint
  issues "3 per domain attempted (create mailbox, send code, delete mailbox) + 3 more (register,
  log in, create key)"; listing domains moved up to **round level** (once per round, no longer
  once per slot). If you want even the pathological case to stay within the wall clock, set
  `MINT_BATCH` to 1–2, or lower `CODE_TIMEOUT_MS` / `MAX_DOMAIN_ATTEMPTS`.
- **There used to be a "number of channels" factor here.** The two channels were once a
  primary/fallback pair, so "the verification code never arrives" fell back and made the same
  refill slot wait out `CODE_TIMEOUT_MS` on each channel. Now that you pick one of the two,
  there is no second wait and the factor is gone entirely. The startup warning
  `TEND_INTERVAL_MS is below the worst-case round duration` uses exactly this model:
  `MINT_BATCH × CODE_TIMEOUT_MS + (MINT_BATCH − 1) × MINT_DELAY_MAX_MS`.

#### On Worker the registrar stops on its own before the wall clock runs out

**This covers the "worst case" row above, but *not* the "theoretical worst case" one.** Before
starting each mint it checks whether the remaining wall clock can hold one complete mint
(`CODE_TIMEOUT_MS`, plus the inter-attempt delay). If it cannot, that
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
> **The budget is not a blanket guarantee — a residual case remains.** The check counts
> `CODE_TIMEOUT_MS + (MAX_DOMAIN_ATTEMPTS − 1) × MINT_DELAY_MAX_MS`. It deliberately does
> **not** include the 15-second per-request timeouts: including them would mean no attempt ever
> dares to start. The budget is 87% of the wall clock, and the ~120s left over covers those tails:
>
> **This paragraph used to say "or the 403 back-offs", which pointed at a dead branch.**
> Hitting a rate limit now **ends the whole round on the spot and records a cross-round backoff
> window**; there is no "wait a moment and keep hammering" any more (see "What happens when the
> upstream rate-limits you" below).

| Where the slowness is | Does the budget cover it | Consequence |
|---------------------|------------------------|-----------|
| **The upstream isn't delivering the code** (the common slow case) | **Fully covered** | The round ends early; remaining slots roll over to the next scheduled round |
| **Nearly every HTTP request hangs for its full 15s** (pathological) | A single attempt can exceed the reserved headroom | It is still aborted by the platform, leaving that temporary mailbox behind |

If the second row worries you, work the "theoretical worst case" formula above and set
`MINT_BATCH` to 1–2, or lower `CODE_TIMEOUT_MS` / `MAX_DOMAIN_ATTEMPTS`.

#### Two log lines: grep them by event name when the limit is exceeded

**Do not set `CODE_TIMEOUT_MS` too high.** Once `CODE_TIMEOUT_MS` exceeds the
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
[registrar] registrar.attempt_exceeds_worker_budget CODE_TIMEOUT_MS 超过 Worker 单轮墙钟预算：Cloudflare Worker 形态下补池会一把 key 都铸不出来（每轮 attempted=0），请调小 CODE_TIMEOUT_MS。Node/Docker 的定时轮没有平台墙钟上限、不受此限制，但面板的「立即补池」在两种运行时上都带同一份轮级预算，Node/Docker 上同样铸不出来。 codeTimeoutMs=... worstAttemptMs=... workerRoundBudgetMs=...
```

It does **not** stop the gateway from starting — unlike "missing credentials fail at startup".
Node/Docker has no platform wall clock and the same configuration is perfectly valid there, so
both runtimes print this warning but only Worker is actually affected.

**(2) On every Worker refill round** where not even the first attempt fits, an **error**
(`console.error`), event name `registrar.round_budget_impossible`
(`grep 'registrar.round_budget_impossible'`), something like:

```text
[registrar] registrar.round_budget_impossible 单次铸 key 的最坏耗时已超过本轮墙钟预算，一次尝试都无法开始，补池将持续零产出——这是配置问题不是瞬时状况，请调小 CODE_TIMEOUT_MS worstAttemptMs=... roundBudgetMs=...
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

### These keys do not disappear on their own

`registrar_tend_lock`, `registrar_manual_guard`, `tend:history`, `registrar:domains` and
`registrar:backoff` — all five **carry no TTL**. Their names are fixed literals and there is always
exactly one of each; stale values are always decided by **comparing values**, so leaving them
behind is harmless.

**The cost, stated plainly**: if you turn the registrar off for good, or delete the deployment but
keep the KV namespace, they will not disappear. To clean up, delete the keys by hand:

- Worker: `wrangler kv key delete --binding=POOL registrar_manual_guard` (once per key)
- Node / Docker: edit `DATA_DIR/store.json` and remove those five top-level fields

**`registrar:domains` is also the only manual escape hatch when the domain ledger got something
wrong**: deleting it sends the registrar back to a cold start.

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

### The registrar has three states

The registrar is not simply on or off — there are **three** states.

- **Disabled**: `REGISTRAR_ENABLED` is unset, or the panel toggle is off. Nothing runs, nothing is sent.
- **Enabled**: on, and this configuration loads. Tending runs on `TEND_INTERVAL_MS` (or the Worker Cron).
- **Enabled · not started this time**: the toggle is on, but this configuration could not be loaded
  (no channel selected, the selected channel is missing its credentials, …), so it was not
  started. **Gateway forwarding is entirely unaffected** — only the refilling stops.

The third one is the easy state to misread, so it shows up in four places: the Settings banner (listing
the missing fields), the Registrar status row, the Overview config summary, and an `error`-level
`registrar.blocked` every round. **To recover**: fill in those fields and save — no restart, no redeploy.

> [!WARNING]
> **What this costs**: it turns a loud failure into a quiet one. Once refilling stops, the pool drains
> slowly and surfaces as `pool_empty` hours or days later, far from the real cause. The four signals
> above exist precisely for that — **you have to go look**.

### Startup and logging conventions

- **If credentials are missing while enabled, the registrar does not start this round, but the
  gateway keeps forwarding.**
  This **changed**: it used to fail the whole gateway closed. The registrar is an optional
  subsystem, and one missing mailbox key should not take down forwarding, `/health` and the admin
  panel with it. The missing fields are now listed one by one in the panel, and an `error`-level
  `registrar.blocked` is logged every round. See "The registrar has three states" below.
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
### The registrar remembers which mail domains work

The upstream only accepts some disposable-mailbox domains. **That verdict is now persisted and
reused**:

- In steady state **one successful mint costs exactly one `/api/verification` request** — it picks
  a domain already known to work. That is why the built-in `MAX_DOMAIN_ATTEMPTS` could drop to 1.
- The registrar section of the panel shows a line like "Domain ledger: N usable · N ruled out ·
  N to re-check · N never probed (updated …)".
- A domain has to be rejected in **two separate rounds** before it sinks to the bottom of the
  candidate list (**however many rejections happen inside one round, they count as one**); after
  one such round it is still picked, just later. One success flips it back to "usable".

#### Why that verdict can be wrong

> [!WARNING]
> **"Ruled out" is our verdict, not the upstream's statement.** The upstream uses the same `400`
> both for "this domain is blocked" and for "your egress address is sending too fast", and the
> only clue that separates them is the response body — which we match against a **word list**.
> One wording change upstream and we get it wrong. Three layers hold that down: a verdict takes
> two hits, at most one domain is ruled out per round, and **the ordering never excludes any
> domain outright**. But all three guard one direction only: a good domain being ruled out.
> The opposite direction — the ledger still says "usable" while the upstream has blacklisted the
> domain — rests on another rule: **whatever the classifier decides gets recorded; no verdict may
> be swallowed**. That rule was once broken by a safety net ("a known-good domain that gets
> rejected is re-read as a rate limit"), and the cost was not slowness but refills **dropping to
> zero** for up to seven days; that safety net has been removed.
> At worst refills get slower; they do **not** drop to zero — **in that direction**.
> A real rate limit read as "domain blocked" costs something else: see "The third tier" below.

#### If you believe the domain ledger got something wrong

There is no per-domain listing in the panel (hundreds of
upstream domains would inflate an endpoint that is polled every few seconds by an order of
magnitude). Three options: wait for the verdict to expire (24h for ruled out, 7 days for usable),
wait for the two-hit rule to correct itself, or delete the storage key by hand (see "These keys do
not disappear on their own" below).

### What happens when the upstream rate-limits you

There is an edge rate limit in front of the upstream (`429`), and the upstream's own registration
rate limit on top of that (`400` plus a "too many requests" style message). **Both penalty windows
outlast a single refill round, and every request made inside the window extends it.**

So after hitting either layer:

- **The round ends on the spot** — no switching domains, no moving on to the next slot.
- A **backoff window** is recorded and consulted before the next round starts. **Inside the window
  not a single upstream request is sent and not a single temp mailbox is created.** The refill
  history row for it reads "Still inside the backoff window; this round never started".
- Repeated hits stretch the backoff **exponentially** (capped at 4 hours). "Repeated" counts
  **consecutive rounds that minted nothing**: once a round mints a key the exponent starts over —
  if that round also hit a limit, the backoff returns to its starting step instead of doubling;
  if it hit no limit at all, the key is cleared outright.
- More than 4 hours after a window ended with no new hit, the exponent starts over too (the pool
  stayed full and the registrar never really ran for several rounds, say).

#### The third tier: our word list matched nothing, but the round's domains failed in a cluster

One rewording upstream and
a real rate limit gets read as "domain blocked" one reply at a time — neither tier above ever
fires, the round no longer stops early, and up to `MINT_BATCH` doomed verification requests go
out per round. The only evidence still standing is **the shape of
the round**, and it has two forms; either one counts:

- more than one domain ruled blocked within the same round;
- **or every domain the upstream lists ruled blocked in that round** (this is the one that carries
  deployments with a single mailbox domain — they can never reach the "more than one" above).

Both require that **the round minted no keys at all**. The registrar records a backoff window on
that basis (starting at 30 minutes, same exponent, same 4-hour cap), **but it does not abort the
round and it swallows no domain verdict** — the domains due to be tried that round still get
tried, and the keys due to come out still come out. If the round minted even one key, this tier
records nothing at all.

#### When this tier lights up, both readings stay open

> [!WARNING]
> **Both readings are still open and the banner will not pick one for you**: the upstream
> reworded its rate-limit message and our word list missed it, or the upstream really did
> swap those domains into its blocklist. **Do not read it as "the upstream said nothing
> about rate limiting"** — the headline case this tier exists for is precisely the one where the
> upstream did say something and we failed to recognise it.

#### Where to find the upstream's own wording: the two branches differ

**Do not follow "go read `registrar.domain_blocked`" all the way down — on one of the two
branches that event is never emitted at all. The price is recorded here honestly:**

- **Several domains ruled «blocked» within the same round**: once the clamp fires, **every**
  «blocked» verdict of that round is discarded wholesale ⇒ the ledger learns no `blocked` ⇒
  **not a single `registrar.domain_blocked` event is emitted that round**. All this branch
  leaves you is the `registrar.known_good_domain_rejected` entries, and those **only cover
  domains the ledger already knew were good** — a cold start, or a domain the upstream listed
  for the first time this round, leaves no wording at all. The
  `registrar.domain_verdicts_discarded` event emitted in the same round carries only the count
  of discarded verdicts, the round's output and the backoff deadline — **no upstream wording**.
- **Every domain the upstream lists ruled «blocked»** (this is the branch a single-mail-domain
  deployment takes): the clamp never reaches its threshold ⇒ the ledger learns the verdict as
  usual, and on the second strike `registrar.domain_blocked` goes out carrying the upstream's
  own wording.

#### How much request volume the third tier leaves behind

In numbers (built-in values, measured against test doubles): past the exponential cap it fires
**once every 8 rounds, at `MINT_BATCH` = 5 verification requests each**. At one Cron round every 30 minutes that is
48 rounds/day ÷ 8 × 5 = **about 30 per day**.
Two figures to compare against: **before this tier caught it, every round went out in full ⇒ about
240 per day**; and the second tier (where the upstream's wording does land in our word list) aborts
the whole round on impact (1 per round) ⇒ **about 6 per day**.
⇒ **30 is not 6**: this tier costs more than the second one because it does not abort the round —
the keys due out that round still come out, and the price is the rest of that round's attempts.

#### The backoff banner: the three tiers call for different actions

The registrar section shows a backoff banner:

| Which tier | What the panel says | What you can do |
|-----------|-------------------|---------------|
| Edge rate limit | "refills are spaced too tightly" | Raise `MINT_DELAY_MIN_MS`, or lower `MINT_BATCH` |
| The upstream's own registration limit | "matched by our word list, not stated by the upstream" | Raise `MINT_DELAY_MIN_MS`, lower `MINT_BATCH`; change egress only once confirmed |
| Domains blocked in a cluster, nothing minted | "nothing matched our word list; both readings stay open" | See above — evidence differs; `registrar.domain_blocked` may be empty |

> [!IMPORTANT]
> **Switching mailbox channel does not get you out of this.** The limit lives on the edge between
> your egress address and the upstream; which mailbox channel you use is irrelevant. Switching
> channels when you see the backoff banner is wasted effort.

**Filling an empty pool is now noticeably slower**: a target of 20 keys goes from "a few minutes"
to roughly 4–5 rounds. At one Cron round every 30 minutes that is **about 2–2.5 hours**. This is
the direct price of trading "burn the allowance and keep hammering for nothing" for "slow but
actually produces keys".

### What happens after a channel fails

**You pick one of the two channels, so "switch to the other one" is something only you can do.**
When the selected channel fails:

- **The current slot is written off and the next slot in this round starts as usual** (after the
  random `MINT_DELAY_MIN_MS`–`MINT_DELAY_MAX_MS` pause). Listing domains fails, invalid
  credentials, no mailbox can be created on any candidate domain, the code never arrives,
  a network blip, every domain blocked, registration / login / key creation failing —
  all of these land in this bucket.
- **There are exactly two exceptions, and both end the round immediately**:
  - an overall Agnes backend failure (`upstream_error`) — carrying on would only produce more
    doomed requests during the outage;
  - **hitting an upstream rate limit (`rate_limited`)** — see "What happens when the upstream
    rate-limits you" below.
- **Apart from rate limiting there is no cross-round backoff and no exponential retry.** An
  ordinary failure does not change when the next round runs: Node/Docker uses the fixed
  `TEND_INTERVAL_MS` timer, Worker uses the Cron in `wrangler.toml`. Throttling within a round
  already has two layers (the random pause between attempts and, on Worker, the per-round
  wall-clock budget).

#### The price, and how to notice it

> [!WARNING]
> **This is a capability regression, stated plainly.** A channel that could not receive codes used
> to get one automatic switch to the other channel: refills slowed down but keys still came out.
> Now the same failure means this round — possibly this whole day — mints nothing until you go and
> switch channels yourself. The failure mode changes from "refills get slower" to "refills produce
> nothing, the pool drains, and hours or days later it surfaces as a `pool_empty` 503" — **a
> self-healing failure has been traded for one that needs a human**. That is the inherent price of
> picking one of the two, not a defect.

**How to notice it**: every round's failure reasons in the refill history carry the channel name
(the `reasons=` line), the four pool numbers in the registrar board, and — when a channel request
fails — the event that now carries **the address actually requested**. If you see zero output,
click "Test connection" on the other channel: it only says that channel is reachable and lists
domains, **not that its credentials work** — that step does not check them. After switching, read
the next round's failure reasons; only a minted key settles it.

### When a channel keeps failing

- If a channel keeps failing to register (for example, Agnes has tightened its verification-code
  or CAPTCHA policy), that's an upstream change no amount of code can work around. You can disable
  the registrar and switch to manually importing keys instead (see [DEPLOY.md](DEPLOY.md)).

## Next Steps

- Usage and SDK wiring for all four protocols: [USAGE.md](USAGE.md)
- Both deployment forms and every environment variable: [DEPLOY.md](DEPLOY.md)
- The web admin panel: [ADMIN.md](ADMIN.md)
- Endpoints and request / response shapes for all four protocols: [API.md](API.md)
- What this project is, and how to get started: [README.md](../../README.md)
- Bug reports and questions: [GitHub Issues](https://github.com/xwteam/agnes2api/issues)
