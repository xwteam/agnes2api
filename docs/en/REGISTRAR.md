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
credentials), the registrar falls back to it automatically for that attempt. Leave it empty to
disable fallback.

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
| `TOKEN_NAME` | no | `auto` | The display name given to the minted key in the Agnes dashboard. |
| `AGNES_PLATFORM_URL` | no | `https://platform-backend.agnes-ai.com` | Agnes platform backend used for registration, login, and key minting (vendor's public endpoint). |
| `YYDS_BASE_URL` | no | `https://maliapi.215.im` | YYDS Mail API base URL (vendor's public endpoint). |
| `YYDS_API_KEY` | required if a channel is `yyds` | empty | YYDS Mail API key. |
| `MOEMAIL_BASE_URL` | required if a channel is `moemail` | empty | Address of your own MoeMail instance, no default. |
| `MOEMAIL_API_KEY` | required if a channel is `moemail` | empty | API key for that MoeMail instance. |

`MINT_DELAY_MIN_MS`, `MINT_DELAY_MAX_MS`, `TOKEN_NAME`, and `AGNES_PLATFORM_URL` aren't listed
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
- With the default configuration, the worst-case duration is roughly
  `MINT_BATCH × CODE_TIMEOUT_MS` = 5 × 120s = 600s, plus up to ~20s from the random delays
  between mint attempts within a round (at most 4 gaps, up to 5s each) — about **600–620s**
  total, leaving roughly **30% headroom** under the 900s wall-clock limit.
- **Before raising `MINT_BATCH` or `CODE_TIMEOUT_MS`, work out the new worst case with the
  formula above and confirm it won't hit the 15-minute wall-clock limit.** If it does, the
  platform will abort that Cron invocation.
- Being aborted does not lose any key that was already minted — each key is written to storage
  as soon as it's minted, so an interrupted round is simply incomplete; the next scheduled round
  picks up where it left off.

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
- Refill logs are consistently prefixed with `[registrar]`, so you can filter for them.
- If a channel keeps failing to register (for example, Agnes has tightened its verification-code
  or CAPTCHA policy), that's an upstream change no amount of code can work around. You can disable
  the registrar and switch to manually importing keys instead (see [DEPLOY.md](DEPLOY.md)).
