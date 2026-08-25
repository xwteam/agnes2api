# Admin panel

**Language:** English | [简体中文](../zh-CN/ADMIN.md) | [繁體中文](../zh-TW/ADMIN.md) | [日本語](../ja/ADMIN.md) | [한국어](../ko/ADMIN.md)

The admin panel is **optional**: with no `ADMIN_TOKEN` set, the whole `/admin` tree is never
registered at all, and the gateway keeps forwarding as usual. This page covers the half you
can see on screen — what question each board answers, what the numbers on it actually mean,
and which actions write. **Every variable itself (default, accepted range, cost) is defined
in exactly one place, the environment-variable table in [DEPLOY.md](DEPLOY.md)**; this page
only points at it and never keeps a second copy.

Covered here: how to get in, plus the Overview, Key pool, Registrar, Events and Usage boards.

## Getting in

- **Address**: `https://<your-gateway>/admin` — replace `<your-gateway>` with your own
  gateway address. A trailing slash (`/admin/`) redirects to `/admin`, so either of the two
  ways people type it by hand works.
- **There is exactly one prerequisite**: set `ADMIN_TOKEN` at deploy time. It has to be at
  least 24 characters, consist only of printable ASCII, and differ from `GATEWAY_TOKEN`. The
  reasoning behind each of those three rules, their boundaries, and which event is recorded
  when a token is rejected are all in the "Admin panel variables" section of
  [DEPLOY.md](DEPLOY.md).
- **When it is unset or rejected, `/admin` answers `404`, not `401`**: the tree is simply
  never registered, so it does not announce "there is a back office here" on the way out. A
  panel you cannot open **does not affect gateway forwarding**.
- **The token is kept verbatim in the browser's localStorage**, and the panel asks you to
  type it again after 12 hours.
- That limit only shortens the window in which the stored value is usable; it is **not a
  revocation**. The only way to revoke is to change `ADMIN_TOKEN` and redeploy / rebuild the
  container. Put the panel behind TLS and open it only on machines you trust — the full
  argument is in the "Leaked admin token" part of [DEPLOY.md](DEPLOY.md).

## The eight boards at a glance

| Board | The question it answers | Read-only or writes | Which switch it needs |
|---|---|---|---|
| Overview | What shape is this deployment in, how many usable keys are left | Read-only | – |
| Key pool | What state is each key in, and why is it unusable | Writes | – |
| Registrar | Is auto-refill running, what did the last few rounds mint | Writes | `REGISTRAR_ENABLED` |
| Events | Which operational-level things happened recently | Read-only | – |
| Usage | How request volume, success rate and latency move over time | Read-only | `USAGE_STATS_ENABLED` (second tier only) |
| Models | Which models the gateway admits, with their modalities and protocols | Read-only | – |
| Playground | Check one protocol end to end with a real request | Calls upstream | – |
| Settings | What the runtime configuration is now, and which items the environment locked | Writes | – |

"Writes" means **writes to storage**; "calls upstream" means it writes nothing but really
does send one request to the upstream.

## Overview

Overview answers one question: **what shape is this deployment in, and how many usable keys
are left in the pool.**

- **Five pool buckets**: total / usable / cooling / evicted / disabled. All five are always
  shown, because a real `0` is a true statement; **when a number cannot be read, that cell
  shows `—` and never fabricates a `0`** — those two things must not look alike on screen.
- **Runtime and storage self-report**: runtime name, version, server time, storage backend,
  whether it is writable, plus the memory / uptime / PID that only the Node shape has. All of
  it comes from what the API returned; the panel never sniffs which runtime it is running on.
  The Worker shape has no long-lived process, so those three cells read "no long-lived
  process" — not `0`, and not blank.
- **Two freshness lines**: the pool snapshot and the configuration each have their own "read
  N seconds ago". They are not the same timeline, so they are displayed separately. The lag
  on the pool line is governed by `POOL_CACHE_TTL_MS` plus another layer of edge caching; the
  upper bound and its cost are written out in that cell of [DEPLOY.md](DEPLOY.md).
- **First-tier cumulative usage**: requests / succeeded / failed / client errors / success
  rate. It is a pool-wide aggregate over every key, which is why it is marked `≈`: per-key
  counters undercount under concurrency (KV has no CAS), and they are persisted up to one
  `POOL_TOUCH_INTERVAL_MS` late.
- **Configuration summary**: the registrar switch, the primary/fallback channels and
  `TARGET_KEYS`, as they are in effect right now. Fields locked by the environment carry a
  lock marker — editing those on the settings page changes nothing, because the environment
  variable takes priority.

## Key pool

- **The bucket badge is one projection through a priority order**, not four independent
  flags: when a key satisfies several conditions at once, the first of disabled > evicted >
  cooling > usable wins. So a key that is "disabled and still cooling" shows a "disabled"
  badge — its cooldown has not gone anywhere, it is just not visible on the badge.
- **Eight single-key actions**: disable, enable, clear cooldown, clear strike count, un-evict,
  edit note, verify, delete.
- **Three bulk actions**: bulk disable, bulk clear cooldown, bulk delete.
- **At most 200 keys per import.** Going over that is a straight `400`, **never a silent
  truncation** — truncation means you believe you imported them when you did not.
- **What the "reset the state of keys that already exist" checkbox actually resets**: the
  **failure state the system decided on** — strike count, cooldown deadline, cooldown reason,
  evicted flag, evicted reason. It **deliberately leaves four other things alone**: the
  disabled flag (that is a switch you flipped yourself, and one paste should not silently
  flip it back), the time it was added (provenance is not failure state), usage counters
  (history is not failure state), and the note (that one is what you wrote to yourself).
- **Delete requires disabling first**: deleting a key that is still in service is refused. On
  the bulk path this constraint does not fail the whole batch; it reports a reason per item.
- **Verifying a single key** really does send one request upstream with it. "Last used" in
  the list and the usage counters are batched before being persisted, so their resolution is
  no finer than the `POOL_TOUCH_INTERVAL_MS` interval.

## Registrar

The registrar board is an **index, not a manual**: all the refill rules, how to pick a
channel, which credentials you have to bring, and how to troubleshoot live in
[REGISTRAR.md](REGISTRAR.md), and this page keeps no second copy. What the board shows is:

- **The two mailbox channels are peers** and have no default: the primary must be named
  explicitly, the fallback may be left unset. The board shows each one's role
  (primary / fallback) and whether its credentials are configured.
- **Refill history**: when each round ran, which channel it took, whether a timer or a person
  triggered it, and how long it took.
- **A channel test only reads that channel's list of usable domains** — no mailbox is created,
  no account is registered, no quota is consumed.
- **"Tend now" has four guardrails**, and it will not start unless every one of them holds:
  the in-flight guard within one replica, the short storage lock across replicas, the minimum
  interval between two manual refills, and the daily cap on manual runs. The error code,
  arithmetic and residual risk of each are in the "Tend now in the admin panel" section of
  [REGISTRAR.md](REGISTRAR.md).
- When the registrar is off (`REGISTRAR_ENABLED` is not `true`) the board is still visible,
  only with its state shown as off, and "Tend now" is refused by the backend.

## Events

- Only **low-frequency structured events** land here: operational diagnostics such as a
  configuration read failing, the pool index being rebuilt or an admin login failing, plus
  the registrar's refill events and the panel's own write operations. **A key being put into
  cooldown or evicted automatically by the forwarding path currently produces no event** —
  for that, go back to the Key pool board and look at the key's own state.
- **The toolbar**: filter by level, search by text, pause auto-refresh, clear, download.
  "Clear" only clears the list on your screen and **does not touch events already persisted
  server-side**; to see them again, hit "download" or reload the page.
- **Events are stored in hourly windows and 24 windows are kept** — a full day. Anything
  older expires on its own and can no longer be found from the panel.
- Each of the four warning bars is saying something different:

| Warning bar | What it is saying | What to do about it |
|---|---|---|
| Dropped | This replica's event buffer pushed out its oldest entries before they were persisted | Events are produced faster than they persist; look for that stretch in container logs / Workers Logs |
| Budget | This replica's event-write budget for today is used up | Same as above: what was not persisted is still in the logs |
| Truncated | This page is not showing every matching event | Narrow the filter, or shorten the time range you are looking at |
| Cursor | The fetch position violates the contract, or is ahead of the server clock | The panel already re-fetched; if it keeps happening, something other than this gateway has written to the event store |

## Usage

- **Usage comes in two tiers, and the first one is always there.** The first tier is the
  pool-wide cumulative set of numbers (the card at the top of Overview uses exactly it) and
  needs no switch. The second tier is a time series broken down by day / hour / model /
  protocol, governed by `USAGE_STATS_ENABLED`, and it is **off by default**.
- **While it is off, this page draws no empty chart**: a chart of `0`s reads as "nobody used
  it during this period", whereas the truth is "this deployment is not keeping the books at
  all". Those two must not look alike.
- **Four time ranges**: `24h`, `3d`, `7d`, `30d`.
- **At most 30 days are retained**; anything older has expired. The longest range reads every
  shard in the whole interval in one go, and whether that always completes on a Cloudflare
  Worker has never been measured on real infrastructure by this repo — on failure this page
  says so plainly instead of handing you numbers that look complete.
- **The numbers here are marked `≈`, and the three sources are each different**: (1) the
  unpersisted tail — counters accumulate in an instance's memory and are flushed in batches,
  and the panel itself tells you how long that window is; (2) short-lived instances — if such
  an instance is recycled before the flush, that stretch is gone; (3) a day's shards have only
  2 slots, so when more replicas than that write at once, the same slot is last-write-wins.
- **When a value cannot be read the cell shows `—`, not `0`**: "there really were 0 requests
  today", "the second tier is off" and "this read failed" are three different things, and the
  panel is not allowed to draw them the same way.
