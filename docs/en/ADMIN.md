# Admin panel

This page covers the half you can see on screen — what question each board answers, what the numbers on it actually mean, and which actions write.

> [!NOTE]
> The admin panel is **optional**: with no `ADMIN_TOKEN` set, the whole `/admin` tree is never
> registered at all, and the gateway keeps forwarding as usual.
> Covered here: how to get in, every board one by one, and finally what the panel does not
> do plus troubleshooting.

> [!IMPORTANT]
> **Every variable itself (default, accepted range, cost) is defined
> in exactly one place, the environment-variable table in [DEPLOY.md](DEPLOY.md)**; this page
> only points at it and never keeps a second copy.

## Getting in

### Panel address

The panel lives under the gateway's own domain. It opens no extra port and starts no extra
service:

```text
https://<your-gateway>/admin
```

Replace `<your-gateway>` with your own gateway address. A trailing slash (`/admin/`)
redirects to `/admin`, so either of the two ways people type it by hand works.

### Prerequisites

- **There is exactly one prerequisite**: set `ADMIN_TOKEN` at deploy time. It has to be at
  least 24 characters, consist only of printable ASCII, and differ from `GATEWAY_TOKEN`. The
  reasoning behind each of those three rules, their boundaries, and which event is recorded
  when a token is rejected are all in the "Admin panel variables" section of
  [DEPLOY.md](DEPLOY.md).
- **When it is unset or rejected, `/admin` answers `404`, not `401`**: the tree is simply
  never registered, so it does not announce "there is a back office here" on the way out. A
  panel you cannot open **does not affect gateway forwarding**.

### Where the token lives, and how to revoke it

- **The token is kept verbatim in the browser's localStorage**, and the panel asks you to
  type it again after 12 hours.
- That limit only shortens the window in which the stored value is usable; it is **not a
  revocation**. The only way to revoke is to change `ADMIN_TOKEN` and redeploy / rebuild the
  container. Put the panel behind TLS and open it only on machines you trust — the full
  argument is in the "Leaking the admin token" part of [DEPLOY.md](DEPLOY.md).

## The eight boards at a glance

| Board | The question it answers | Read-only or writes | Which switch it needs |
|-----|-----------------------|-------------------|---------------------|
| Overview | What shape is this deployment in, how many usable keys are left | Read-only | – |
| Key pool | What state is each key in, and why is it unusable | Writes | – |
| Registrar | Is auto-refill running, what did the last few rounds mint | Writes | `REGISTRAR_ENABLED` |
| Events | Which operational-level things happened recently | Read-only | – |
| Usage | How request volume, success rate and latency move over time | Read-only | `USAGE_STATS_ENABLED` (second tier only) |
| Models | Which models the gateway admits, with their modalities and protocols | Read-only | – |
| Playground | Check one protocol end to end with a real request | Calls upstream | – |
| Settings | What the runtime configuration is now, and which items the environment locked | Writes | – |

"Writes" means **the actions you press on that page write to storage**; "calls upstream" means
it really does send one request to the upstream. ⚠️ **"Calls upstream" does not mean "writes
nothing"**: the playground sends a real request at this gateway's own forwarding endpoint and
travels the very same path any forwarded request does — the key that served it is accounted for
just the same, persisted on exactly the forwarding path's terms (batched the same way), plus one
more usage record when the second tier is on.

## Overview

Overview answers one question: **what shape is this deployment in, and how many usable keys
are left in the pool.**

### Pool buckets and the runtime self-report

- **Five pool buckets**: total / usable / cooling / evicted / disabled. All five are always
  shown, because a real `0` is a true statement; **when a number cannot be read, that cell
  shows `—` and never fabricates a `0`** — those two things must not look alike on screen.
- **Runtime and storage self-report**: runtime name, version, server time, storage backend,
  whether it is writable, plus the memory / uptime / PID that only the Node shape has. All of
  it comes from what the API returned; the panel never sniffs which runtime it is running on.
  The Worker shape has no long-lived process, so those three cells read "no long-lived
  process" — not `0`, and not blank.

### Two freshness lines and first-tier usage

- **Two freshness lines**: the pool snapshot and the configuration each have their own "read
  N seconds ago". They are not the same timeline, so they are displayed separately. The lag
  on the pool line is governed by `POOL_CACHE_TTL_MS` plus another layer of edge caching; the
  upper bound and its cost are written out in that cell of [DEPLOY.md](DEPLOY.md).
- **First-tier cumulative usage**: requests / succeeded / failed / client errors / success
  rate. It is a pool-wide aggregate over every key, which is why it is marked `≈`: per-key
  counters undercount under concurrency (KV has no CAS), and they are persisted up to one
  `POOL_TOUCH_INTERVAL_MS` late.

### Configuration summary

- **Configuration summary**: the registrar switch, the primary/fallback channels and
  `TARGET_KEYS`, as they are in effect right now. Fields locked by the environment carry a
  lock marker — editing those on the settings page changes nothing, because the environment
  variable takes priority.

## Key pool

### The bucket badge is one priority projection

- **The bucket badge is one projection through a priority order**, not four independent
  flags: when a key satisfies several conditions at once, the first of disabled > evicted >
  cooling > usable wins. So a key that is "disabled and still cooling" shows a "disabled"
  badge — its cooldown has not gone anywhere, it is just not visible on the badge.

### Actions on the board

#### Single-key actions

- **Eight single-key actions**: disable, enable, clear cooldown, clear strike count, un-evict,
  edit note, verify, delete.

#### Bulk actions

- **Three bulk actions**: bulk disable, bulk clear cooldown, bulk delete.

### Importing, and resetting state

- **At most 200 keys per import.** Going over that is a straight `400`, **never a silent
  truncation** — truncation means you believe you imported them when you did not.
- **What the "reset the state of keys that already exist" checkbox actually resets**: the
  **failure state the system decided on** — strike count, cooldown deadline, cooldown reason,
  evicted flag, evicted reason. It **deliberately leaves four other things alone**: the
  disabled flag (that is a switch you flipped yourself, and one paste should not silently
  flip it back), the time it was added (provenance is not failure state), usage counters
  (history is not failure state), and the note (that one is what you wrote to yourself).

### Delete preconditions, and verifying one key

- **To delete a key it has to be disabled or evicted** — either one on its own will do, so a
  key the system already evicted need not be disabled by hand first. Deleting a key that is
  still in service is refused. On the bulk path this constraint does not fail the whole batch;
  it reports a reason per item.
- **Verifying a single key** really does send one request upstream with it. "Last used" in
  the list and the usage counters are batched before being persisted, so their resolution is
  no finer than the `POOL_TOUCH_INTERVAL_MS` interval.

### Changing one key: the request and the receipt

Those single-key actions all travel one endpoint, `PATCH /admin/api/keys/{id}`, and a single
request may carry several of them at once — here, enable plus clear cooldown. The header
carries the **admin token**, not the gateway token.

```bash
curl -X PATCH http://localhost:8080/admin/api/keys/9f2c \
  -H "x-admin-key: your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{ "disabled": false, "clearCooldown": true }'
```

The receipt only says whether the write landed; it does not read the whole record back — for
the resulting state, go back to the list:

```json
{ "ok": true }
```

The type and meaning of every field in that request body are in [API.md](API.md), and this
page keeps no second copy.

## Registrar

The registrar board is an **index, not a manual**: all the refill rules, how to pick a
channel, which credentials you have to bring, and how to troubleshoot live in
[REGISTRAR.md](REGISTRAR.md), and this page keeps no second copy. What the board shows is:

### The two mailbox channels

- **The two mailbox channels are peers** and have no default: the primary must be named
  explicitly, the fallback may be left unset. The board shows each one's role
  (primary / fallback) and whether its credentials are configured.

### Refill history and channel tests

- **Refill history**: when each round ran, which channel it took, whether a timer or a person
  triggered it, and how long it took.
- **A channel test only reads that channel's list of usable domains** — no mailbox is created,
  no account is registered, no quota is consumed.

### The four guardrails on Tend now

- **"Tend now" has four guardrails**, and it will not start unless every one of them holds:
  the in-flight guard within one replica, the short storage lock across replicas, the minimum
  interval between two manual refills, and the daily cap on manual runs. The error code,
  arithmetic and residual risk of each are in the "Tend now" section of
  [REGISTRAR.md](REGISTRAR.md).
- When the registrar is off (`REGISTRAR_ENABLED` is not `true`) the board is still visible,
  only with its state shown as off, and "Tend now" is refused by the backend.

## Events

### What gets recorded here

- Only **low-frequency structured events** land here: operational diagnostics such as a
  configuration read failing, the pool index being rebuilt or an admin login failing, plus
  the registrar's refill events and the panel's own write operations. **A key being put into
  cooldown or evicted automatically by the forwarding path currently produces no event** —
  for that, go back to the Key pool board and look at the key's own state.

### The toolbar and the retention windows

- **The toolbar**: filter by level, search by text, pause auto-refresh, clear, download.
  "Clear" only clears the list on your screen and **does not touch events already persisted
  server-side**; to see them again, hit "download" or reload the page.
- **Events are stored in hourly windows and 24 windows are kept** — a full day. Anything
  older expires on its own and can no longer be found from the panel.

### The five warning bars

- Each warning bar is saying something different, and **they are independent bars that can be
  lit at the same time**:

| Warning bar | What it is saying | What to do about it |
|-----------|-----------------|-------------------|
| Dropped | This replica's event buffer pushed out its oldest entries before they were persisted | Events are produced faster than they persist; look for that stretch in container logs / Workers Logs |
| Budget | This replica's event-write budget for today is used up | Same as above: what was not persisted is still in the logs |
| Truncated | This page is not showing every matching event | Narrow the filter, or shorten the time range you are looking at |
| Cursor ahead | The fetch position is ahead of the server clock: a clock rollback, or skew between replicas | The panel already re-fetched from a fresh position; this one heals itself |
| Cursor broken | The cursor the API returned is neither a number nor null, so the panel kept the previous one — **from here on it may never show new events** | Check whether something other than this gateway has written to the event store |

### What one event looks like

After the panel disables a key, the Events board and the download both carry the same
structured record. The event name is a stable machine-readable string; filtering and grouping
go by it and never parse `msg`:

```json
{
  "ts": 1735689600000,
  "level": "warn",
  "event": "key.disabled",
  "msg": "面板停用了一把 key（它仍然占着 targetKeys 的名额，不会触发补池）",
  "fields": { "id": "9f2c" }
}
```

## Usage

### Two tiers

- **Usage comes in two tiers, and the first one is always there.** The first tier is the
  pool-wide cumulative set of numbers (the card at the top of Overview uses exactly it) and
  needs no switch. The second tier is a time series broken down by day / hour / model /
  protocol, governed by `USAGE_STATS_ENABLED`, and it is **off by default**.
- **While it is off, this page draws no empty chart**: a chart of `0`s reads as "nobody used
  it during this period", whereas the truth is "this deployment is not keeping the books at
  all". Those two must not look alike.

### Time ranges and retention

- **Four time ranges**: `24h`, `3d`, `7d`, `30d`.
- **At most 30 days are retained**; anything older has expired. The longest range reads every
  shard in the whole interval in one go, and whether that always completes on a Cloudflare
  Worker has never been measured on real infrastructure by this repo — on failure this page
  says so plainly instead of handing you numbers that look complete.

### Why these numbers are approximate

- **The numbers here are marked `≈`, and the three sources are each different**: (1) the
  unpersisted tail — counters accumulate in an instance's memory and are flushed in batches,
  and the panel itself tells you how long that window is; (2) short-lived instances — if such
  an instance is recycled before the flush, that stretch is gone; (3) a day's shards have only
  2 slots, so when more replicas than that write at once, the same slot is last-write-wins.
- **When a value cannot be read the cell shows `—`, not `0`**: "there really were 0 requests
  today", "the second tier is off" and "this read failed" are three different things, and the
  panel is not allowed to draw them the same way.

## Models

### What this page answers

- **This page answers one question**: which models this gateway admits, what type each one is,
  which protocols it is really available on, and which endpoint to call.

### Three types, and protocol availability

- **Three types**: chat, image, video. Chat models hang off the four chat protocols; the
  protocol column of image and video models is empty — they belong to no chat protocol and go
  through their own media endpoints.
- **Protocol availability is a badge per cell**, not one blanket "supported" or "unsupported":
  the column is filled in model by model. ⚠️ **No model in today's catalog is available on one
  protocol and unavailable on another**: the one chat model is available on all four, and the
  three media models have an empty column. You can filter by protocol; when the filter matches
  nothing, this page says "no models are available on this protocol" instead of drawing an
  empty table.

### The endpoint column, and read failures

- **The endpoint column says which path a client should call**, from the same single source as
  [API.md](API.md), and this page keeps no second copy.
- **When the catalog cannot be read this page shows a dash**, next to a load-failure banner and
  a retry button. ⚠️ **"cannot be read" and "there are no models" are two different things, and
  today the sentence that spells that out lives only in the dash's hover tooltip** (`title=`):
  visible with a mouse, out of reach on a touch screen.
- ⚠️ **One known divergence in the public contract, recorded as it is**: the Gemini model-list
  endpoint declares `generateContent` for **every** model, **including the video one**, while
  the real path for video is the two-step "create the job, then poll". This page is filled in
  by real availability; when the two disagree, this page is the one to believe.

## Playground

### The two keys are strictly isolated

- **The two keys are strictly isolated, and that is the most important thing on this page.**
  The admin token travels in `x-admin-key` and only ever hits the `/admin/api` tree; the
  playground uses the **gateway token** (`GATEWAY_TOKEN`) and travels in each protocol's usual
  auth header to the public tree. The two are stored separately in the browser and are
  **cleared together when you log out** — on a shared or screen-shared machine, whichever one
  is not cleared is handed to the next person as it was.
- **You paste the gateway token by hand; there is no auto-fill**: the panel cannot read its
  plaintext (credentials are write-only), so all it can do is compare the last 4 characters
  stored on the settings page with the one you pasted and tell you "matches", "does not match",
  or "cannot be read, no comparison this time".

### Three modes

- **Three modes, each with a different set of controls**:

| Mode | Endpoint it calls | What you can configure here |
|----|-----------------|---------------------------|
| Chat | The public path of each of the four chat protocols | Pick a protocol and a model; streaming can be turned on |
| Image | The single image-generation endpoint | Model only; no protocol picker and no streaming toggle |
| Video | The create-job and fetch-result endpoints | Model only; the result is polled automatically once the job exists |

**The protocol picker and the streaming toggle only exist in chat mode**, and they are not
merely hidden: in the protocol catalog those two media endpoints belong to no chat protocol,
and a row of buttons nobody can press would only suggest that images can pick a protocol or
stream too.

### Streaming, and the video mode

- **Streaming mode shows no token counts**: the panel does not read usage while streaming, and
  writing a `0` there would be a lie, so that cell simply carries no number.
- **Video is a two-step flow**: create the job, take the task ID, then poll for the result.
  Polling runs **every 5 seconds, capped at 60 attempts / 5 minutes**, whichever comes first —
  today the two caps coincide exactly (60 attempts × 5 seconds is exactly 5 minutes); if the
  page has been hidden, ticking pauses while the wall clock keeps going, and then the duration
  cap is the one that fires.
- ⚠️ **How long a real upstream takes to generate a video has never been measured by this
  repo.** These two caps exist to shut down "a forgotten tab turns into a perpetual polling
  machine"; they were not derived from real generation times, and this page draws no conclusion
  about how they relate to those times. On reaching a cap the panel says plainly that polling
  stopped at its limit and leaves the task ID on screen — the job itself may still be running,
  and you can come back later and query that ID yourself.

### Every Send really hits upstream

- **When the create-job response carries no usable task ID, the panel does not guess one**: it
  reads only a fixed set of fields as the ID, polls nothing when none of them works, and shows
  the raw response as it came.
- **Every press of Send really does hit upstream**: that request travels the same path any
  forwarded request does, and the key that served it is accounted for just the same (see the
  note under the board table). One video run is 1 create request plus up to 60 polling
  requests.
- **At most 20 turns are kept on screen**; older ones are removed from this page and the panel
  tells you how many were removed. You can also clear them yourself with "clear conversation".
  That only clears this copy on your screen; nothing server-side is touched.

## Settings

### The five cards

The settings page has five cards today:

| Card | What it covers | Worth knowing |
|----|--------------|-------------|
| Credentials | The gateway token and nothing else; the admin token is shown read-only on this card, because the panel cannot change its own key | Credentials are write-only: a blank input means this field is left alone |
| Upstream & cooldowns | Upstream address, timeouts, and the cooldown / eviction knobs | Two of them are read once when the instance is built, see the end of this section |
| Registrar | Every refill knob, **each mailbox channel's own credentials** (two symmetric sub-cards), plus an "advanced" collapsed area | The field in that area changes where every automatic registration goes |
| Integration examples | Ready-to-run call examples | The address comes from the origin you opened the panel on, and the token is a placeholder |
| Danger zone | Two buttons whose effects cannot be undone: reset configuration, purge the key pool | Both ask for a second confirmation; purging also makes you type the current pool size by hand |

### The quadruple and the priority order

- **Every field lays out a quadruple**: what is in storage, what is in the environment, which
  one is in effect now, and who locked it. The priority is **environment variable > stored
  value > built-in default**; a field locked by the environment changes nothing when edited
  here, and the panel names the deployment-side variable you should change instead.

### Credentials are write-only

- **Credentials are write-only**: the panel never gets the plaintext, and the screen only shows
  "configured / not configured" plus the last 4 characters. Blank means unchanged; to really
  delete one you press "clear", and that step first tells you what clearing will do — fall back
  to the environment value, fail on the next restart, or change nothing right now.

### What a save returns

- **After saving, the panel answers with more than a bare "saved"**: it reads the effective
  values back, highlights the fields that really changed, and then splits on what kind of field
  you touched. For ordinary fields the sentence on screen **opens, word for word, with "this
  instance already picked it up"**, and only then states how long other replicas / isolates may
  take to see the change — it says this instance is already using the new value, not that
  nothing is live yet. That bound is the sum of the configuration cache and the KV edge cache.
  ⚠️ **Neither number is in the environment-variable table**: both are hard-coded constants in
  `src/http/config-holder.ts` that nobody can tune; the values are written out in the **prose** of
  [DEPLOY.md](DEPLOY.md), in the part about what the settings page returns after a save.

### The two exception fields

- ⚠️ **Two fields are the exception**: the pool snapshot cache and the write-coalescing interval
  (`POOL_CACHE_TTL_MS` and `POOL_TOUCH_INTERVAL_MS`) are **read once when the instance is
  built** ⇒ after saving, **not even this instance has picked them up**; the container has to
  restart or the isolate has to be recycled. When a save touches **only** those two, the
  "already picked it up + upper bound" sentence **is not shown at all** and is replaced by
  "persisted, but this instance has not picked it up either"; when a save touches both kinds,
  both sentences appear.

### The panel cannot rotate its own key

- **The panel cannot rotate its own key**: `ADMIN_TOKEN` is read from the environment only. To
  rotate it, change the deployment-side environment variable and restart.
- **When the configuration in storage cannot be loaded this page turns into a diagnostic view**:
  it lists what is missing item by item, and **the form stays editable** — that is the only way
  out.

## Danger zone

The last card on the settings page. Neither button here can be undone, and there is no undo path.

| Button | What it touches | What it leaves alone | Second confirmation |
|------|---------------|--------------------|-------------------|
| Reset configuration | The one stored configuration entry, wiped in a single write, including the gateway token and both mailbox channel credentials | The key pool, per-key usage, event records and refill history | The dialog spells out what will be missing after the reset, then asks you to confirm |
| Purge the key pool | The record of every key in the pool, plus the id index | Configuration, event records and refill history | Besides confirming, you must type the current pool size by hand |

### Resetting is not a factory reset

- **Resetting the configuration is not a factory reset.** Effective values come from three
  layers — environment variable, then storage, then built-in value — and this button only wipes
  the middle one; fields locked by the environment do not move by a single bit. For some fields
  it therefore does nothing at all, and the screen highlights the ones that really changed.

### Purging takes the usage history with it

- **Purging the key pool takes the usage history with it.** Each key's request count, success
  count and last error live inside the value of that record: deleting the record deletes the
  history, and there is no second copy to recover from. The key material likewise exists only
  in storage.

### Finishing on screen is not every replica

- **Finishing on screen does not mean every replica has caught up.** After a reset, other
  replicas or isolates only see it once the config cache and the edge cache have expired; after
  a purge, the forwarding path can keep selecting those keys for up to one pool-snapshot TTL
  plus the edge cache. The knob behind the pool-snapshot bound (`POOL_CACHE_TTL_MS`) is in the
  environment table of [DEPLOY.md](DEPLOY.md); ⚠️ **the config bound is not in that table** — it is
  the sum of two hard-coded constants in `src/http/config-holder.ts` that nobody can tune, and its
  value is written out in the prose of the same document. On this page, the config one is also
  mentioned in the settings card notes above, and the pool-snapshot one in the overview bullet
  about the two freshness clocks.

### Quota and credentials

- **What each button costs in quota is written in the quota account of [DEPLOY.md](DEPLOY.md)**:
  a reset is one write; a purge is one delete per key plus the single index write — the bigger
  the pool, the more expensive that button gets.
- **Neither button echoes a credential.** The reset receipt carries the read-back quadruples,
  "configured or not", and the short last-four hint (`hint`, the same thing the credential fields
  on the settings page show) — **exactly the same rule as the rest of this page: the last four
  characters, yes; not a single character of the plaintext.**

## What the panel does not do

### It does not rotate its own key

`ADMIN_TOKEN` is read from the environment only, so the panel can neither change it nor offer
any "invalidate every session already handed out" path. Rotating means changing the
deployment-side variable and redeploying or rebuilding the container.

### It never echoes a credential in the clear

The backend answers only "configured or not" plus the last 4 characters, so no "fill in my
token" button can exist — that would need a plaintext read-back hole in the backend, and the
moment such a hole is open the whole write-only rule is gone.

### It is not a replacement for wrangler secret or .env

This page edits the copy of the configuration in storage, while environment variables take
priority. When the two disagree the screen carries a lock marker, but changing the environment
variable itself can only be done on the deployment side.

### It does not fetch remote media for you

Result addresses in the playground are listed as they came and are always ready to copy;
**only the ones starting with `http` / `https` also get an "open" link** — `javascript:` /
`blob:` / `file:` never do, even when the upstream really returned one, because following such
a link yields a top-level document decided by upstream content; only `data:` images are
embedded inline, and that path issues no request to any third party.

## Troubleshooting

### It will not open, and the answer is `404`

**Cause**: this deployment has no `ADMIN_TOKEN`, or it has one that was rejected. The tree is
not registered, so nothing outside can tell whether there is a back office here at all.

**Fix**: go back to the deployment side and set an acceptable `ADMIN_TOKEN` (the three rules
are listed at the top of this page), then redeploy or rebuild the container.

### It will not open, and the answer is `401`

**Cause**: the token itself is wrong, most likely because it has been rotated.

**Fix**: type the current `ADMIN_TOKEN` in again. ⚠️ **Do not lump this together with the panel
bouncing you back to the login box**: the 12 hours window is decided by the panel itself, and
when it runs out no request leaves the browser at all, so the server has nothing on record.
Either way, typing the token again is the fix.

### It will not open, and the answer is `503`

**Cause**: `ADMIN_TOKEN` collides with the gateway token in storage. That rule is rechecked on
every admin request, and the Events board and the logs carry an `admin.token_conflict` entry.

**Fix**: change the stored gateway token to a value that differs from `ADMIN_TOKEN`.
⚠️ **That step only restores availability**: the admin token has to be treated as leaked, the
full procedure is in [DEPLOY.md](DEPLOY.md), and both steps have to be done before it counts as
handled.

### You paste the token and the login box rejects the characters

**Cause**: the panel checks the character set before sending anything, and accepts printable
ASCII only (`0x20–0x7E`). Code points above `U+00FF` — CJK, emoji, zero-width space — plus
NUL / LF / CR cannot be sent by the browser at all; `é` / `£` can be sent, yet this gateway
declines them too, as a cross-runtime encoding decision. On this path **no request leaves the
browser**, so the server does not even have a failed login to show.

**Fix**: use a token made of printable ASCII only and paste it again. ⚠️ **You never see this
message when the deployment side is the one carrying such a token**: the whole tree is then
never registered, and what you get is the `404` above.

### The screen is showing stale values

**Cause**: the configuration and the pool snapshot each have their own cache window, with a
layer of KV edge caching on top. The pool-snapshot bound and its cost are in the
environment-variable table of [DEPLOY.md](DEPLOY.md); the config bound is a pair of hard-coded
constants and is **not in that table** — its value is written out in the prose of the same
document. Neither is copied here.

**Fix**: wait for both cache layers to expire, or restart the container / let the isolate be
recycled; the two "read N seconds ago" lines on Overview are there for exactly this.

### The error text is the backend's own words, not your language

**Cause**: for error codes **it recognises** the panel shows its own localized text; for a code
it does not recognise it puts the backend's sentence on screen and marks it with "raw text from
the backend; this panel has no translation for that error code yet".

**Fix**: take the backend's sentence to the logs and the Events board. ⚠️ **Do not read that as
"every error appears in your language"** — the unrecognised ones do not, and the panel would
rather mark the fact than pass the text off as a translation.

## Next Steps

- Endpoints of all four protocols, with request / response shapes: [API.md](API.md)
- Both deployment forms and every environment variable: [DEPLOY.md](DEPLOY.md)
- Usage and SDK wiring for all four protocols: [USAGE.md](USAGE.md)
- The registrar (automatic pool refill): [REGISTRAR.md](REGISTRAR.md)
