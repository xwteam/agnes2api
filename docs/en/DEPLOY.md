# Deployment Guide

agnes2api ships as two deployment targets built from the same codebase and request-handling logic — pick whichever fits your infrastructure.

> [!NOTE]
> They differ only in storage backend: the Worker uses a Cloudflare KV namespace, Docker uses
> a JSON file on a mounted volume.

## System Requirements

The two forms have different prerequisites. Read the column for the path you picked;
you do not need both.

| Item | Cloudflare Worker | Docker |
|------|-------------------|--------|
| Local runtime | Node.js 20+ (only to run `wrangler` and the build) | Not needed |
| Command line | `npx wrangler` (installed by `pnpm install`) | Docker Engine 24+ and `docker compose` |
| Platform | A Cloudflare account; the free tier is enough | A machine that can run containers |
| Upstream | At least one Agnes API key, see the next section | At least one Agnes API key, see the next section |

> [!TIP]
> The Docker path needs nothing but a machine with Docker: `cp .env.example .env`, then a single
> `docker compose up -d` brings it up.
> The Worker path needs no server at all, but you must create a KV namespace in your own
> Cloudflare account first — there is no substitute for that step.

## Getting Agnes Credentials

The gateway does not mint keys. All it does is spread requests across the one or more Agnes
API keys you already hold. There are two ways to get one, and **they are equal peers** — this
document does not pick a primary for you.

### Getting one by hand

Sign up on the Agnes platform, create an API key in its console, and copy it out.
This gives you exactly one key at a time, which is what you want while getting the gateway
running and confirming all four protocols work.

### Letting the registrar refill the pool

The repository ships an optional registrar that refills the pool up to `TARGET_KEYS` on its own.
It is **off by default** (leave `REGISTRAR_ENABLED` unset and it stays off). How it works, how to
choose between the two mailbox channels, and the Cloudflare Cron wall-clock ceiling are all
documented in [REGISTRAR.md](REGISTRAR.md).

> [!IMPORTANT]
> Either way the key lands **in plain text** in KV / `store.json`. Treat the data directory and
> the KV namespace as credentials.

## Choosing a Deployment Form

Both forms are built from the same codebase: all four protocols, the admin panel and the
registrar exist on both sides. These are the only differences:

| Dimension | Cloudflare Worker | Docker |
|-----------|-------------------|--------|
| Where it runs | Your own Cloudflare account, at the edge | Your own server or laptop |
| Storage backend | A KV namespace (the `POOL` binding) | `store.json` on a mounted volume |
| Server required | No | Yes |
| Quota limits | Free-tier KV: 100,000 reads and 1,000 writes per day | Only your own machine |
| Scheduled refill | The Cron in `wrangler.toml` | `TEND_INTERVAL_MS` |
| Very long non-streaming requests | No platform wall-clock guarantee to lean on, see below | Only the budget you configure |

**Neither path is the primary one**: take Docker if you already have a server, take the Worker if
you would rather not run one. Running both is fine too, but **do not let them share one set of
keys while each keeps its own state** — cooldowns and evictions are written into storage, the two
stores know nothing about each other, and the same key ends up judged twice.

## Cloudflare Worker Deployment

### Prerequisites

> [!NOTE]
> **This repository ships no one-click Cloudflare deploy button** — that path cannot work
> here. The KV namespace id in `wrangler.toml` is always a placeholder (a public repo
> carries no real deployment details; `scripts/check-wrangler-placeholder.mjs` enforces
> that in CI), and `GATEWAY_TOKEN` is a mandatory sensitive value that can only be
> injected as a secret — miss either one and it will not start (`src/core/config.ts`
> throws the moment it cannot read it). A one-click flow can do neither for you, so the
> steps below have to be walked through by hand. For a command-only overview see the
> `## ⚡ Quick Deployment` section of the [README](README.md) in this directory;
> tag-triggered automatic deployment is covered further down.

Clone the repository and install dependencies:

```bash
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api
pnpm install
```

### Configuration

1. Create a KV namespace for the key pool and write it back into `wrangler.toml`:

   ```bash
   node scripts/setup-worker.mjs
   ```

   The `id` in the repo's `wrangler.toml` is always a placeholder (the public repo
   ships no real deployment details), so this step is mandatory. The script does the
   same thing as manually running `npx wrangler kv namespace create POOL` and then
   pasting the returned `id` into the `[[kv_namespaces]]` block in place of
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`. **Do not commit this change to
   `wrangler.toml`** afterward — the `check-wrangler-placeholder.mjs` CI gate blocks
   an accidentally committed real id.

2. Set the gateway token as a Worker secret (never commit it to `wrangler.toml`):

   ```bash
   npx wrangler secret put GATEWAY_TOKEN
   ```

#### Local development

```bash
pnpm dev:worker   # Worker shape: build the panel assets first, then wrangler dev
pnpm dev:node     # Node shape: build the panel assets, pnpm build, then run dist/entry/node.js
```

> [!IMPORTANT]
> **Both start with `node scripts/build-ui.mjs`, and that is not incidental**: the panel assets
> are a build product (`src/ui/assets.generated.ts`). A bare `npx wrangler dev` still starts, but the
> panel stays on whatever was generated last — if you changed `admin-ui/` and see nothing, this is
> usually why.

Put `GATEWAY_TOKEN` into a local `.dev.vars` file next to `wrangler.toml` (already
git-ignored) — do not put secrets directly in `wrangler.toml`.

> [!TIP]
> This file is read unconditionally into workerd's `env` by `pnpm test:workers`
> (`@cloudflare/vitest-pool-workers` does not pass `envFiles` when it calls wrangler),
> and CI has no such file ⇒ run `mv .dev.vars .dev.vars.off` before the tests. The
> repository has one assertion that turns red on the spot once the file brings **an extra
> binding name** into `env` — it compares the set of key names, so an empty file, or one
> that only sets `POOL` (the same name as the KV binding), stays green.

Put `GATEWAY_TOKEN` in that file, in the same format as `.env`:

```env
# Required: the token clients must present to call this gateway.
# Anything works for local development, but do not paste the production one in here.
GATEWAY_TOKEN=local-dev-token-change-me

# Optional: the admin panel token. Leave it out and the panel stays off locally too.
# Must differ from GATEWAY_TOKEN, at least 24 characters, printable ASCII only.
ADMIN_TOKEN=local-dev-admin-token-change-me
```

### Deploy

With both steps above done, run:

```bash
npx wrangler deploy
```

#### Automatic deploy on tag push

`.github/workflows/deploy-worker.yml` deploys the Worker automatically whenever a `v*` tag is
pushed, provided the repository secret `CLOUDFLARE_API_TOKEN` is configured under
**Settings → Secrets and variables → Actions**. If it isn't set, the workflow logs a warning
and skips the deploy step without failing the run.

### Verify

When the deploy finishes wrangler prints `https://{name}.{sub}.workers.dev`. Use that as the base
URL for one health check:

```bash
curl -s https://your-worker.your-subdomain.workers.dev/health
```

A `200` with `status` set to `ok` means it is up. The full three-command check is further down.

### Update

```bash
git pull
pnpm install
npx wrangler deploy
```

The key pool and the config in KV are **untouched**: a deploy replaces the code, the binding still
points at the same namespace. `wrangler.toml` is locally modified (the namespace id was written by
`setup-worker.mjs`), so when `git pull` reports a conflict there, keep your local id.

## Docker Deployment

### Prerequisites

Clone the repository and prepare the environment file:

```bash
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api
cp .env.example .env
```

### Configuration

Edit `.env` and set at least `GATEWAY_TOKEN`. See the [environment variables](#environment-variables)
table below for everything else.

The smallest usable `.env` is two lines; everything else has a default and can be added later:

```env
# Required: the token clients must present to call this gateway. This is what you hand downstream.
GATEWAY_TOKEN=replace-with-your-own-long-random-string

# Optional: the listen port of the Node runtime; the Worker ignores this variable.
# docker-compose.yml also uses it as the port published on the host.
PORT=8080
```

#### The data directory and its owner: the container rewrites `./data` (read this first)

The container **enters its entrypoint as root**, does two things, and only then drops
privileges:

- If `DATA_DIR` (default `/app/data`) is not owned by the in-container runtime user `app`
  (**uid 100 / gid 101**), it recursively `chown`s that directory. If ownership already
  matches, nothing is rewritten.
- It then re-executes the server through `su-exec`, so the **main process (PID 1) runs as
  `app`, not as root**.

This has to happen at runtime because with a bind mount the host directory's ownership
overrides the build-time `chown` baked into the image, leaving the in-container `app` user
unable to write `store.json` — a silent failure in which every API call returns `pool_empty`.

**Side effect:** with a bind mount those are *host* files. After `docker compose up -d`, your
`./data` and everything in it is owned by `100:101` instead of your own uid, and you will need
`sudo` to read, write, or back it up from the host. If you do not want that, run the container
as a non-root user with `--user` (or compose's `user:`): the entrypoint then skips the `chown`
entirely and you provide a directory your chosen uid can write.

For the same reason the image deliberately has **no `USER app`**, so its default user is root
(`docker inspect --format '{{.Config.User}}' <image>` prints nothing). This matters on
Kubernetes: with `runAsNonRoot: true` and no explicit `runAsUser`, the kubelet refuses to start
the container. Such deployments should set `runAsUser: 100` and `runAsGroup: 101` (or any uid of
your own) and prepare the volume ownership themselves — a non-root start takes the entrypoint's
"no chown, exec directly" branch.

Safety boundary: if `DATA_DIR` is set to `/` or to a top-level system directory (`/etc`, `/usr`,
…), the entrypoint refuses to recursively chown it (it only prints a warning and still starts),
so a stray value cannot make the whole container filesystem writable by `app`.

### Deploy

Start the container:

```bash
docker compose up -d
```

**Before the first published image exists** (or in a fork), this command falls back to
building the image locally — that is what the `build:` block in `docker-compose.yml` is for.

`docker-compose.yml` publishes port `8080` (override with `PORT` in `.env`) and mounts
`./data` into `/app/data` inside the container — that's where `store.json` (the key pool
and any persisted config) lives. Keep that directory around across restarts/upgrades; it's
your only copy of the imported key pool.

### Verify

Check it came up healthy:

```bash
curl http://localhost:8080/health
```

The image also ships a `HEALTHCHECK` that Docker uses to report container health. If the
data directory is not writable, `/health` answers `503` with `"status": "degraded"`, the
container is marked unhealthy, and the underlying reason is in the container logs.

### Update

```bash
docker compose pull
docker compose up -d
```

`./data` is left alone — the key pool and the config live there. **Back that directory up before
upgrading** (see "Backup and Restore" below): it is the only copy of the imported key pool, and
there is no second one.

## Environment Variables

| Variable | Required | Default | Notes |
|--------|--------|-------|-----|
| `GATEWAY_TOKEN` | **yes** | – | The token clients must present to call this gateway. |
| `RESET_CONFIG` | no | – | Escape hatch: set it to `1` and startup **ignores the stored `config` key entirely** (ignores it, does not delete it), using only environment variables and built-in defaults. When to reach for it, and what to do afterwards, is below. |
| `AGNES_BASE_URL` | no | `https://apihub.agnes-ai.com/v1` | Upstream Agnes API base URL. |
| `UPSTREAM_TIMEOUT_MS` | no | `8000` | First-byte timeout for **streaming** responses and video polling: abort the upstream call if no first byte arrives within this many milliseconds. |
| `UPSTREAM_SYNC_TIMEOUT_MS` | no | `120000` | Total timeout budget for **synchronous** endpoints — the ones whose first byte only arrives once the upstream has computed the whole result: image generation, video job creation, and every **non-streaming** chat request. See below. |
| `MAX_STRIKES` | no | `3` | Consecutive transient failures (timeouts, network errors, upstream `5xx`) before a key is put into a long cooldown. |
| `COOLDOWN_RATE_LIMIT_MS` | no | `60000` | Cooldown duration applied to a key after an upstream `429`. |
| `COOLDOWN_PAYMENT_MS` | no | `3600000` | Cooldown duration applied to a key after an upstream `402`. |
| `COOLDOWN_STRIKE_MS` | no | `1800000` | Cooldown duration applied once a key reaches `MAX_STRIKES`. The key recovers automatically when it expires. |
| `POOL_CACHE_TTL_MS` | no | `60000` | How long each isolate/process keeps its in-memory key-pool snapshot; `0` disables it. Formula and cost below. **Read once at instance build** (`src/http/wire.ts`): a container restart or an isolate recycle is required — **editing it in the admin panel does not take effect immediately**. |
| `POOL_TOUCH_INTERVAL_MS` | no | `21600000` | How often a key's "last used" timestamp is at most persisted; `0` = every successful request. Cost below. **Read once at instance build** (`src/http/wire.ts`): a container restart or an isolate recycle is required — **editing it in the admin panel does not take effect immediately**. |
| `USAGE_STATS_ENABLED` | no | `false` | Tier-2 time series behind the panel's "Usage" section (by day / hour / model / protocol). **The check is a literal `true`**; `1` or `yes` count as off. **Off by default, and "off" is zero-cost**. What it costs once on is below. Read once when the app is built. |
| `PORT` | no (Node/Docker only) | `8080` | Listen port for the Node runtime. Not used by the Worker. |
| `DATA_DIR` | no (Node/Docker only) | `/app/data` | Directory the file-backed storage writes `store.json` into. Not used by the Worker. |

### Accepted ranges, and the two "read once at construction" exceptions

Every variable in the table above has its own line in `.env.example`; run `cp .env.example .env`
and edit what you need. Comments in that file vary in depth — most variables get a single line,
a few carry a dozen lines or more — so treat this table as the complete reference for ranges and
trade-offs. Every numeric variable above must be an integer; all of them must be greater than `0` except
`POOL_CACHE_TTL_MS` and `POOL_TOUCH_INTERVAL_MS`, whose lower bound is `0` (meaning
"disabled"). The gateway refuses to start otherwise.

`POOL_CACHE_TTL_MS` and `POOL_TOUCH_INTERVAL_MS` are read **once, when the app is built**.
Changing them requires restarting the container or waiting for isolates to be recycled — unlike
every other setting, they do not take effect per request.

### `RESET_CONFIG`: when to reach for this escape hatch

> Use it to recover when the stored config has been corrupted badly enough to keep the gateway
> from starting; remove the line afterwards, or nothing you save in the panel will ever take
> effect.

### What `POOL_CACHE_TTL_MS` costs

**KV reads are independent of request count** — they depend only on the refresh rate; see the
quota section below for the formula.

> Cooldowns/evictions decided by another isolate take up to **this value + about 60 seconds** to
> become visible here (the extra 60s is KV's default edge-cache `cacheTtl`) — with the default
> 60000 that ceiling is about **120 seconds**.

And it isn't just "seen late": any scheduling write made against a stale snapshot overwrites the
whole record, **erasing** whatever `evicted` / `cooldownUntil` another isolate had just written
within that window — that decision has to happen all over again.

### What `POOL_TOUCH_INTERVAL_MS` costs, and how to clear the counters

It is a display-only field that no scheduling logic reads.
Writing it per request would burn the free tier's 1,000 writes/day and leave no budget for
cooldowns and evictions. Cost: "last used" is only accurate to within this interval. The same
interval also governs the panel's usage counters (request count / success rate).

> [!WARNING]
> **After you shrink `stats` by hand in storage (zeroing it, say), the panel may briefly show the
> reset value and then flip back to the old one**: the snapshot picks up the zeroed record after
> one TTL, but a running instance remembers its own persisted baseline and writes it back on its
> next real persist. They agree for good once that instance is recycled, at the latest.

**To clear the counters, take the proper path that goes through the repo**:
`PATCH /admin/api/keys/:id` with `clearStats`. It discards the persisted baseline and the
not-yet-persisted delta held by **the instance that served this request**, so **requests that
start after this reset** will not push the old value back. But a request that was **already in
flight when the reset happened** holds a record taken from before the reset and rebuilds the
baseline from that old value when it finishes; other instances running at the same time (another
isolate, or another container on the same volume) each keep their own baseline too. Either way
they may push an old value back once.
**Today it is API only — the panel has no button for it.**

### What `USAGE_STATS_ENABLED` costs once you turn it on

"Off" is zero-cost: no in-memory accumulator is created and not a single storage write happens.
Once on, each instance writes at most 13 puts per day (about 10.4% of the write quota; 104 per
day across 8 isolates); once exhausted nothing more is written that day and it recovers on the
next UTC day. The unflushed tail is at most 2 hours. See the Tier-2 part of "Quota accounting"
below. Changing it takes effect after a container restart / isolate recycle.

### Quota budget: how many requests a Worker on the free KV tier can serve

The free KV tier allows 100,000 reads and 1,000 writes per day. Neither the gateway's reads nor
its writes grow with request count, so the budget is "so many per day", not "so many per request":

- **With the defaults, KV is no longer the bottleneck** — the ceiling becomes the Cloudflare
  Workers free tier itself, at **100,000 requests/day**. This conclusion is **conditional, not
  unconditional**: the KV read quota now constrains the *number of concurrently active isolates*
  instead, and that varies with how your traffic is distributed geographically — it is not
  something you set. Each active isolate consumes

      (86400 ÷ POOL_CACHE_TTL_MS in seconds) × (1 + pool size)  +  2880

  reads per day. That trailing 2880 is the config holder refreshing every 30 seconds, drawing on
  the same bucket. With the defaults and 20 keys that is **33,120 reads per isolate**; adding the
  48–96 daily index reconciliations, **3 active isolates already consume ~99.4%**. In other words
  the default is already marginal at the recommended settings — if you expect more isolates, raise
  `POOL_CACHE_TTL_MS` (20 keys across 5 isolates needs roughly `120000`).
- **With the cache disabled** (`POOL_CACHE_TTL_MS=0`, the escape hatch) reads grow linearly with
  requests, giving a floor of about `100,000 ÷ (1 + pool size)` ⇒ roughly **4,700 requests/day**
  with 20 keys.
- **Writes**: in steady state about `pool size × 4` per day (`lastUsedAt` is touched every 6
  hours) — 80 with 20 keys, 8% of the write quota, leaving the rest for cooldown and eviction
  bookkeeping. Each key also costs one one-off write the first time it is used.
- **Events board (Task 6) writes**: each isolate persists at most `EVENT_WRITES_PER_DAY`
  (**12**) times per day; past that, `budgetExhausted` is reported honestly, with no silent
  drop and no retry. **This gate only holds within a single isolate** — whether it's globally
  safe depends on whether "concurrent isolate count × this value" still fits the budget, since
  one isolate has no way to know how much budget the others have used (no CAS, no
  cross-isolate coordination). Estimating with **8 concurrent isolates** (more conservative
  than the 3 used elsewhere in this section — even a lightly-trafficked personal gateway can
  land on many different Cloudflare edge locations, and you don't fully control how many
  concurrent isolates that produces): `12 × 8 = 96` writes/day, **9.6%** of the write quota.
  Added to the key-pool write side above (80/day, 8%), the total is about 176/day
  (**17.6%**), leaving roughly 82% headroom.

  **This accounting exists because review caught a real problem**: an earlier version budgeted per hour with each isolate counting
  independently up to 12/hour, so 4 isolates alone could blow through the write quota
  (`4 × 12 × 24 = 1,152`, over 1,000). The fix was to switch the budget window from
  "per hour" to "per day" and write this account down here; the same round also closed a gap
  where a cold-started isolate's first flush bypassed throttling entirely — every isolate
  cold start used to send one zero-gate write, and now the first flush after cold start goes
  through the same minimum-interval gate as every other flush.
- **Registrar write side (new in P3c Task 1) — this entire section only exists when
  `registrar.enabled` is true.** On a default deployment (the registrar is off), the writes
  added by this section are **0/day**, not "a few less". When it is on, every tend round pays
  three items, **all hanging off one axis: the tend frequency** (on Worker that is the Cron in
  `wrangler.toml`, `*/30 * * * *` by default = 48 rounds/day; on Node it is `TEND_INTERVAL_MS`):
  - **Tend lock**: one put + one delete per round. This item already existed before this
    change; it had simply never been written into this account.
  - **Tend event persistence**: at most one put per round. **What decides whether a write
    happens is whether this round's event buffer is empty** — not what the events are
    named. A round that is healthy *and* whose configuration is healthy emits no events at
    all, so it costs 0.

    > [!IMPORTANT]
    > **"0 when healthy" has a precondition that must be stated**:
    > `loadConfig` emits one configuration warning **on every single round** when
    > `TEND_INTERVAL_MS` is below `MINT_BATCH × CODE_TIMEOUT_MS × channel count`
    > (by default `5 × 120000 × 1 = 600000`, i.e. 10 minutes). Under that setting **every
    > round writes once**, even a round that mints nothing.

  - **Tend history (`tend:history`)**: one get + one put per round, **unconditionally**.
    Single key, no fan-out.

  > [!IMPORTANT]
  > **Do not read these three through `EVENT_WRITES_PER_DAY` (12 per isolate per day).**
  > That gate is built for the `fetch` path, where the premise is "one isolate serves many
  > requests, so the budget is consumed repeatedly on a long-lived instance". On the tend path
  > each round is very likely a **brand-new isolate** (Worker's `scheduled()`) that flushes once
  > in its life and carries a fresh budget every time ⇒ **on this axis that gate neither stops
  > anything nor constitutes any upper bound**. The real bound is the tend frequency itself:
  > **tightening the Cron or lowering `TEND_INTERVAL_MS` scales all three items proportionally.**

#### What each panel write operation costs — "only when a human clicks"

- **Write side of the panel's write operations (new in P3c) — these only happen when a human
  clicks, so they are not part of the steady-state accounts above.** There is no frequency
  bound to speak of (the bound is the operator's hand), so what follows is the **unit price of
  each operation**; every number below is a measured reading, **counted cell by cell**:
  the key write operations in `tests/contract/admin-keys-write.test.ts`, "tend now" in
  `tests/contract/manual-tend.test.ts`, and the two settings-page endpoints in
  `tests/contract/admin-config.test.ts`.
  (This sentence used to name only the first file, while the "tend now" row has nothing to do
  with it and no cell counted it at all back then — full-branch review I4. The fix is to add
  that missing cell, not to soften this sentence.)
  - **Importing M new keys**: `M + 1` puts (M records + 1 index), `M + 1` gets, **0 lists**.
    At most 200 per import (over that it is a 400, **never a silent truncation**) ⇒ the upper
    bound for a single click is **201 puts**, i.e. 20% of the daily write quota. Splitting the
    import into several batches is not cheaper (each batch still pays for the index write).
  - **Re-importing** (pasting the same key again without ticking "reset the state of existing
    keys"): **0 puts**. Duplicates are skipped, never overwritten, so re-pasting your whole
    list is cheap and safe.
  - With "reset the state of existing keys" ticked: 1 put for each key **already in the pool**.
  - **Changing one key** (disable / enable / note / clear cooldown / clear strikes / un-evict /
    reset usage counters): 1 get + 1 put. **Every action above costs the same**: they go through the
    same handler and the same single persist, and resetting the counters reads or writes nothing
    extra (what it clears is the in-memory persist baseline).

    > [!IMPORTANT]
    > **The last item in those parentheses is the one thing in this section you cannot click**:
    > resetting the usage counters is **API only today — the panel has no button
    > for it** (same as the `POOL_TOUCH_INTERVAL_MS` row above). That list enumerates every action
    > the handler understands, not the buttons on the panel; it is written up here because the
    > unit price is identical to all the others, so that nobody assumes the other route costs more.

  - **Deleting one key**: 2 gets + 1 put (index) + 1 delete.
  - **Bulk disable / bulk clear-cooldown of N keys**: N gets + N puts.
  - **Bulk delete of N keys**: `N + 1` gets + **1** put (the index is written once) + N deletes.
  - **One click on "tend now"**: a fixed **3 puts** (guard key + lock acquisition + tend
    history) plus 1 delete (releasing the lock, which lives in a different bucket), plus
    **2 more puts per key actually minted** (record + index). It is the **only panel action
    with a daily cap**: at most **24** per day (the fourth guardrail, see
    [REGISTRAR.md](REGISTRAR.md)) ⇒ a sustainable `24 × 3 = 72` puts/day, which on top of
    the 320 in the third row below gives **392/day (39.2%)**; minting the default
    `MINT_BATCH = 5` every single time gives an upper bound of `24 × 13 = 312` ⇒
    **632/day (63.2%)**, and that row is not sustainable — your temporary-mailbox quota and
    `TARGET_KEYS` hit their limits first. **The reason for this gate is not "it would blow the
    budget", it is "there is no headroom"**: with only the 10-minute cooldown the bound is
    `24 × 6 = 144` rounds/day = 432 puts, which on top of 320 is already 75% — and 96 of that
    320 equals `12 × concurrent isolate count`, a number **you cannot tune yourself**.
  - **Saving the settings once** (`PUT /admin/api/config`): **1 put** + 3–4 gets (one
    `readAll` plus one raw read before the write, then one `readAll` to read back; when you
    save again right afterwards the previous `invalidate()` makes the config-refresh
    middleware read once more, and the diagnostic branch likewise costs one extra).
    **A save that fails validation is 0 puts + 2–3 gets** — not a single byte is written
    (right after a successful save it likewise costs one extra read, same reason as above).
  - **Clearing one credential** (`POST /admin/api/config/secrets/clear`): **1 put** + 2 gets;
    clearing `gatewayToken` (after which the config no longer loads) costs 3 gets.
  - **Dry-run validation** (`POST /admin/api/config/validate`): **0 puts** + 1 get.
  - **Resetting the configuration** (`/admin/api/config/reset`, the first danger-zone button
    on the settings page): **1 put** + 2 gets (one read-back before the write, one after).
    It wipes the single stored configuration entry, and **it spends the put bucket, not the
    delete bucket** — writing an empty value instead of deleting the key avoids the KV
    delete-tombstone family of problems.
  - **Purging the key pool** (`/admin/api/keys/purge`, the second danger-zone button):
    **N deletes (N = pool size) + 1 put** (the index is written exactly once, the same rule as
    bulk delete).

    > [!WARNING]
    > **The free tier's delete bucket is 1,000 per day** (independent of read, write and
    > list) ⇒ **with N approaching 1,000 this one button blows the day's delete quota on its
    > own**, and the bigger the pool the more it costs. On the read side it is one pool snapshot
    > (0 gets when the isolate cache is warm) plus one read-back; clicking again on an empty
    > pool is 0 deletes and 0 puts.

  > [!CAUTION]
  > **"Saving the settings" and "clearing one credential" have no daily cap. That is
  > deliberate, not an oversight.** Both require the admin token and both only happen when a human
  > clicks; no automatic path can trigger them. Putting a storage guardrail on them would itself
  > add a read-modify-write (the guard key) — paying an extra write in order to save one.
  > **The cost is spelled out here rather than left to silence, so nobody assumes some budget is
  > minding them**: a single tuning session running to a few dozen saves is entirely normal
  > operations, a few dozen puts is a few percent of the daily write quota, and the 24-per-day
  > gate on "tend now" **does not cover these two**. Plan your headroom accordingly.

  > [!IMPORTANT]
  > These do **not** add up with the three columns below: those say "how many times a day with
  > nobody touching anything", this section says "what each click costs you". The only shape worth
  > watching is **importing several hundred keys at once** — it is the most expensive single click
  > in the panel.

#### Write-side totals, keyed on `registrar.enabled`

- **Write-side totals, in three columns keyed on `registrar.enabled`** (20 keys, 8 concurrent
  isolates):

  | Scenario | puts/day | share of the write quota |
  |--------|--------|------------------------|
  | **Registrar off (default)**, nobody operating | **176** | **17.6%** |
  | Registrar on, **every round healthy**, nobody operating | **272** | **27.2%** |
  | Registrar on, **every round producing failure events**, nobody operating | **320** | **32.0%** |

  > [!WARNING]
  > **None of these three is an upper bound; each is a current value.** The 96/day item equals
  > `12 × concurrent isolate count`, and that count varies with the geographic distribution of
  > your traffic — **you cannot set it yourself**. Plan headroom accordingly; do not treat 272 or
  > 320 as a ceiling.
  > The **`delete` bucket** is counted separately: the tend lock releases 48 times a day, and
  > that bucket is nearly idle today.

  > [!IMPORTANT]
  > **All three items are billed per round, and "rounds per day" has two independent axes.
  > Do not conflate them:**

  - **Frequency axis**: tightening the tend frequency scales all three **proportionally**
    (that is the sentence above). **On Worker the knob is the Cron in `wrangler.toml`**;
    on Node it is `TEND_INTERVAL_MS`. `TEND_INTERVAL_MS` is **consumed only by the Node
    scheduler** — changing it on Worker adds **not a single round**. Conversely the
    `registrar_tend_lock` put/delete pair **exists in both runtimes** (as of P3c Task 5 the
    Node side takes the same lock — an in-process boolean is worthless when several
    containers share one volume).
  - **Threshold axis**: when `TEND_INTERVAL_MS` drops below
    `MINT_BATCH × CODE_TIMEOUT_MS × channel count`, the event item **jumps from "0 on a
    healthy round" to "1 every round"** — that jump is independent of frequency and is
    caused by the per-round configuration warning described above.
  **The worst case is both axes at once.** This section is about Worker + the free KV tier,
  so here is an example that is **perfectly legal in that shape**: change the Cron to
  `*/5 * * * *` ⇒ 288 rounds/day, each producing events ⇒
  `80 + 96 + 288 + 288 + 288 = 1,040` writes/day — **already past the write quota**.
  The three rows above all assume the default Cron (one round every 30 minutes); **do not
  read them as constants independent of the frequency**.

#### Write side of Tier-2 usage statistics (off by default)

- **Write side of Tier-2 usage statistics (new in P3d, `USAGE_STATS_ENABLED`, **off by default**)
  — it is the only new writer this phase.**

  **While it is off, this line contributes exactly zero writes**: no in-memory accumulator is
  created and not a single `storage.put` happens. That is not a minor saving: it competes with
  the 80/day of the key pool above for the **same** bucket of 1,000 writes per day, and letting
  statistics eat the write quota also kills the key pool's cooldown and eviction bookkeeping.

  Once on: **at most 13 puts per day per instance**, which at 8 concurrent isolates is
  `13 × 8` = **104** per day, roughly 10.4% of the write quota. Totals for four scenarios:

  | Scenario | puts/day | share of the write quota |
  |--------|--------|------------------------|
  | **Tier-2 off (default)**, registrar off | **176** | 17.6% |
  | Tier-2 on, registrar off | **280** | 28.0% |
  | Tier-2 on, registrar on and every round producing failure events | **424** | 42.4% |
  | Previous row + "Tend now" clicked until the 24-per-day gate is spent | **496** | 49.6% |

  > [!WARNING]
  > **Like the three columns above, this table is not an upper bound.** Read it this way:
  > **two items in this table carry a hard gate** — the 104 from Tier-2 (13 puts per instance
  > per day, point ③ below) and the 72 from "Tend now" (24 per day, see the "clicking Tend now
  > once" bullet above). None of the others has a gate, and what they cost depends on whoever
  > is operating the panel. The last row assumes **no new keys are minted** (a flat 3 puts per
  > click); minting on every click costs more, but that column hits the temporary-mailbox quota
  > first and is not sustainable — the arithmetic is in that same bullet.

<details>
<summary><b>Click to expand: where those 13 come from (all six points matter)</b></summary>

Those 13 come from the following, and all six points matter:

① **12 flushes + 1.** The minimum flush interval is **2 hours**, so a full day holds at most
   12 of them; the `+1` is not slack, it is the fact that **the flush that crosses UTC
   midnight writes two keys** (one for the previous day, one for the current day). With 12,
   exactly one write per 24 hours would be refused by the budget — no data is lost (that day
   stays marked as pending and is picked up on the next round), but the "at most 2 hours"
   promise in point ② would become 4 hours.

② **The unflushed tail is at most 2 hours, and its two symptoms are one fact, not two**: the
   "today" figures on the panel can be up to 2 hours stale, and **any instance that lives
   less than 2 hours** (a short-lived Worker isolate, a fast Docker restart) **loses the
   counts it accumulated along with itself**. The clock starts when the instance starts, so
   an isolate that lived 10 minutes stores nothing at all. This is one of the reasons usage
   figures carry an "≈" throughout; it is not a defect.

③ **The 13 puts per day per instance is a hard gate**: once exhausted, nothing more is
   written that day, it **recovers automatically on the next UTC day**, and the days it owed
   are written out after recovery (the in-memory accumulator is never cleared) —
   **provided the instance is still alive**.

   > [!IMPORTANT]
   > **That half-sentence is structurally out of reach on Workers**: those accumulators live
   > only in memory, and a Worker isolate usually does not survive into the next UTC day (see
   > point ② above: an isolate that lived 10 minutes stores nothing at all). So on Workers
   > "written out after recovery" requires **the same isolate to have crossed UTC midnight**,
   > which is the exception, not the rule; when it does not, those days' counts **vanish with
   > the instance — they are not merely posted late**.

   > [!CAUTION]
   > **On Docker this gate does not exist at all**, so the promise simply does not apply
   > on that side: whether there is a daily write budget depends only on **whether your storage
   > has a write quota** (the criterion is in point ④ below), and file storage does not ⇒ the
   > budget is empty (`budgetPerDay = null`), nothing is ever exhausted, and there is no
   > "recovery" or "catch-up" to speak of. **Do not read it as "on Docker you hit the 13-put
   > gate and lose nothing" — on Docker there is no such gate**; what you do lose there is the
   > tail from point ② above (up to 2 hours not yet flushed when the process stops).

   > [!IMPORTANT]
   > This gate **only applies inside a single instance** — 8 isolates means 8 independent
   > allowances of 13, exactly like the events gate above, with no cross-instance coordination.

④ **Both runtimes behave identically; no runtime sniffing is done.** The **default** flush
   interval is the same on both sides, along the same code path (the request tail **waits for
   the write to finish**, it is not a background task — a background task on Workers gets
   silently truncated when the isolate stops after the response returns).
   `USAGE_FLUSH_INTERVAL_MS` can override it, and **the criterion is "does your storage have a
   write quota", not "which runtime are you on"**:
   · **File storage (Docker) has no write quota** ⇒ any positive integer is accepted, **and
     there is no longer a per-day write budget**; the interval itself is the bound. Turning it
     back down to 300000 (5 minutes) is entirely reasonable.
   · **KV (Workers) has a write quota** ⇒ the budget stays at 13 per instance per day, and the
     interval must satisfy `interval × (13 − 1) >= one day`. Violating it **fails at startup**
     and tells you the smallest usable value (7200000). Refusing silently is deliberate: with
     such a value the write volume still looks fine **while the data goes wrong from midday
     onward**, which is harder to notice than a failure to start.

⑤ **At most 2 instances' data survives for a given day; anything beyond that overwrites.**
   Usage shards are stored as `usage:<UTC day>:<slot>` and **there are only 2 slots**;
   each instance hashes into one stably by its shard id. ⇒ the 104/day computed above for 8
   isolates is a **write volume**, not "all 8 sets of data were kept" — within a slot it is
   last-write-wins. **This is one of the reasons usage figures carry an "≈"** (the other is
   the tail in point ②). It does not affect the write quota, only how complete the numbers
   are; that is exactly what the "≈" means.

⑥ **The three media endpoints (image generation, video creation, video polling) are not
   counted.** They burn the **same** pool of upstream keys as the four chat protocols but
   record nothing ⇒ the panel's "total requests" is systematically lower than the real
   forwarded volume. This is a known boundary of this phase, not a defect; judge key
   consumption from the key-pool side instead.

</details>

#### Three read-side accounts of their own

- **Tier-2 usage reads — what they burn is not the daily read quota but "how many subrequests
  one invocation may issue".** The `30d` range of `/admin/api/usage` issues
  `USAGE_DAY_RETAIN × USAGE_SLOTS` = `30 × 2` = 60 KV gets **in a single request**
  (`src/core/admin/usage-stats.ts`). Against 100,000 reads per day those 60 are negligible;
  **what has no platform guarantee is the subrequest count of a single invocation**:
  Cloudflare's Workers limits page splits it into two rows — "Subrequests per invocation",
  **50** on the free plan, and "Subrequests to internal services", **1,000** on the free plan —
  yet that page never defines what "internal services" means, nor which row a KV binding call
  falls under; KV's own limits page separately states "Operations/Worker invocation" **1,000**
  (identical on free and paid). **The two pages disagree, and we have not settled it on real
  hardware** ⇒ read against the KV page, 60 is 6%; read against the 50 row, **60 is over**.

  So the `30d` range may behave differently on Workers than on Node, and the gateway only
  guarantees that it **fails honestly**: when the read fan-out fails part way through, **the
  whole `days` series comes back as `null`** (the panel shows `—`) with `note` set to
  `read_failed`; it never returns 500 and never passes off the shards it did read as the full
  picture.

  > [!WARNING]
  > **Do not cite the events board's 48 cold gets below as evidence** — 48 is within limits
  > under both readings, so it says nothing at all about whether 60 is fine. To rely on this
  > range on the free plan, measure it on real hardware first.

- **Playground video runs: at most `1 + 60` upstream requests per task** (1 create + at most
  60 polls, `VIDEO_POLL_MAX_ATTEMPTS`).

  > [!IMPORTANT]
  > **That 61× multiplies the upstream quota and the
  > keys' use counts only; it does not multiply the KV daily write quota**: `lastUsedAt` and the
  > usage counters are gated by `POOL_TOUCH_INTERVAL_MS` (6 hours by default), and one polling
  > run cannot fill a single flush interval; cooldown and eviction are still counted per failure.
  > **Do not read the two as one** — what gets exhausted first is the upstream side, not KV.

- **Events board reads (post-C4/C4b-fix figures, more conservative than the earlier draft)**:
  polling no longer depends on an index, so the number of candidate keys is **hard-bounded** —
  no matter how stale `after` is or how many days the deployment has been running, a single
  request scans at most 24 time windows × 2 slots = **48** gets (before the C4 fix, a stale or
  hostile `after` could push a single request to nearly 1 million gets; see the regression
  cases in `tests/contract/quota-panel.test.ts`). When `after` falls within a recent time
  window it's a "warm read", usually needing only 2 gets (4 at the moment a poll crosses a
  time-window boundary).
  **"Bounded" does not mean "independent of activity level"** — evaluation C4b surfaced a
  counter-intuitive result:
  - **An "active" deployment with a steady stream of new events**: new events keep pushing
    the poll interval back down to the 15-second minimum, and most polls hit a warm read.
    Assuming the worst case of 4 gets/poll throughout: `(86400 ÷ 15) × 4 = 23,040` gets/day
    (about 23% of the read quota; in practice far lower since only a small fraction of polls
    happen to cross a window boundary).
  - **A "quiet" deployment with no new events for a long stretch** (including a
    freshly-deployed instance that hasn't triggered any diagnostic event yet): the `after`
    cursor never advances, and once the frozen cursor falls out of the 24-hour retention
    window, **every subsequent poll costs the full 48 gets**; at the same time, with no new
    content, exponential backoff pushes the poll interval up to the 60-second cap. The
    steady state is `(86400 ÷ 60) × (48 + 1) = 70,560` gets/day (about **71%** of the read
    quota).

    > [!WARNING]
    > **That figure is a steady-state *idle* envelope, not an upper bound.** It assumes the
    > board is simply left open with nobody touching it. Interactive paths are not in it: every
    > click on a level filter is a full cold read, and returning to this board or making the tab
    > visible again also triggers a round immediately — **none of these are throttled today**.

    The `+1` is **the configuration read each poll round triggers on its own**: the
    config-refresh middleware runs ahead of every route and the config cache TTL is 30
    seconds, shorter than the 60-second poll interval, so every round costs exactly one
    extra read. It draws on **the same bucket** as the `86400 ÷ config TTL seconds` term in
    the key-pool account below (that term states the 2,880/day upper bound; an isolate
    driven only by the panel actually spends 1,440), so **do not count it twice** when you
    add the two accounts together. **A deployment healthy enough to produce almost no
    diagnostic events ends up costing more read quota from a single open panel tab than an
    "active" one does**. Plan your read-quota headroom around this larger number, not the
    smaller "active" one, especially when adding it to the key-pool read side above (see
    the "3 active isolates already use about 99.4%" scenario above).
  - **The download endpoint** (`GET /admin/api/events/download`) costs a flat 48 gets per
    click (`readEvents(null)` always does a cold read, no cursor) — this only happens on a
    manual click and is negligible at that scale; noted here purely for completeness.
  Both scenarios' ceilings stay **flat regardless of how many days the deployment has been
  running** — that part of the original claim still holds after the C4 fix.
#### The `list` and `delete` buckets

- **`list` and `delete` are two further buckets, 1,000/day each**, separate from the read and
  write buckets. Steady-state forwarding never issues a `list` — that is exactly why the
  `pool:index` key exists. **Four** things consume it: the 48–96 daily index reconciliations
  (one at the start of every tending round); **the panel's "tend now" button** (since P3c: when
  a round actually mints a key, the wrap-up reconciles once more ⇒ at most 24 more per day, the
  bound being that guardrail itself — this consumer used to be missing from the list, and the
  sentence used to describe reconciliation as "a separate, independently scheduled job", which
  since P3c also has an **operator-triggered** consumer; full-branch review I2); the
  **empty-pool rescan** (when the index parses
  fine yet not a single live record can be read, the gateway issues one `list` to check whether
  a hand-imported record is missing from the index); and the **missing-index fallback** (when
  `pool:index` itself cannot be read or fails to parse, the gateway likewise issues one `list`
  and tries to rebuild the index — usually because the write bucket got exhausted and the index
  could never be built).

  The latter two **share the same** built-in **10-minute** backoff (a
  fixed constant, not an environment variable) — they draw on the same `list` bucket, so opening
  a separate window for each would be pointless — so an empty or broken-index pool costs at most
  144 `list` calls per isolate per day, with headroom left over the 48–96 from reconciliation
  plus the at most 24 from the panel.
- **Exhausting the `list` bucket disables the gateway rather than degrading it.** When the pool
  is empty and `list` fails, the gateway returns `500` with the real reason in the log; it does
  **not** disguise the failure as `503 pool_empty`, because reconciliation draws on the same
  bucket and is failing too — both self-healing paths described in this document are gone until
  the quota resets at UTC midnight.

**The read formula above assumes "an isolate outlives the TTL."** At low traffic, or once
traffic is spread across enough Cloudflare edge locations, isolates are often recycled before a
single TTL elapses; each isolate then loads the pool at least once in its lifetime, so the read
count is driven by **cold-start count**, not the TTL, with a ceiling around
`100000 ÷ (keys in the pool + 2)` cold starts/day (the `+2` accounts for one read each for the
index and the config). **Raising `POOL_CACHE_TTL_MS` saves zero reads in this regime** — it only
saves repeated loads within the same isolate.

By the same logic, the `list` backoff for the empty-pool and missing-index states is also
**per instance**: every cold isolate pays its own cost, and the total scales linearly with the
number of isolates.

### Admin panel variables (P3, disabled by default)

| Variable | Required | Default | Notes |
|--------|--------|-------|-----|
| `ADMIN_TOKEN` | no | none (panel disabled) | Token for the admin endpoints. **Must differ from `GATEWAY_TOKEN`**, at least 24 characters, **no leading/trailing whitespace**, **printable ASCII (0x20–0x7E)** only. The reasoning for these rules, and what each kind of non-compliance costs you, are below. |
| `TRUST_PROXY` | no | unset (**no** forwarded header is trusted) | Set to `1` **only** if the gateway really sits behind a proxy — that includes the Cloudflare Worker form, where you should set it. It decides where the client IP in login-failure events comes from; see below. |

**Not set ⇒ the panel is simply unavailable, and the gateway keeps forwarding.** Requests to
`/admin/...` then get **`404`, not `401`**: the tree is never registered, so nothing leaks the
fact that there is a panel here. This mirrors the registrar being disabled by default — a missing
or bad `ADMIN_TOKEN` must never stop the gateway from forwarding.

#### The three hard rules on `ADMIN_TOKEN`

**"Non-compliant" comes in two flavours with completely different consequences — do not fold
them into one sentence.** Unset, or non-compliant on its own terms (leading/trailing whitespace,
non-printable ASCII, shorter than 24) ⇒ the whole `/admin` tree is never registered and the log
says `admin.token_rejected`. Compliant but equal to the effective `GATEWAY_TOKEN` ⇒ the tree is
registered **as usual** and the panel itself opens; only the admin endpoints keep answering
`503`, and the log says `admin.token_conflict` (that rule is rechecked on every admin request,
never at startup).

**No leading or trailing whitespace**: HTTP strips whitespace from header values but environment
variables keep it, so a padded token can never be sent by any client.

##### Why only printable ASCII is accepted

The token must also consist solely of **printable ASCII (0x20–0x7E)**. This restriction has three
parts with different natures:

1. Characters above U+00FF (CJK, emoji, zero-width spaces) plus newlines and NUL make `fetch`
   **throw** when setting the header — the request is never sent, so you would get a panel that
   returns 200 yet can never be entered, and the server would not even get one
   `admin.login_failed`.
2. Control characters **other than TAB** (`0x01–0x08`, `0x0B`, `0x0C`, `0x0E–0x1F`, `0x7F` — 29 in
   total) can be sent by the browser but are rejected as `400` by the HTTP parser.
3. **TAB (`0x09`)** and `0x80–0xFF` bytes such as `é`, `£` or a non-breaking space **can actually
   be sent and would work** — rejecting them is a **robustness trade-off on our side**, not a
   physical limit, and **the two have different reasons**. TAB is an **invisible character**:
   pasted into a `.env` file or a secret, nobody can see it (the same diagnosability problem as
   leading/trailing whitespace, except that rule is physical and this one is a trade-off).
   `0x80–0xFF` is an encoding question instead: environment variables are decoded as UTF-8 while
   header values are decoded as Latin-1, and nothing in the specs guarantees those two agree in
   that range (we have only verified this on Node; the Cloudflare Workers side is unverified),
   while RFC 9110 already marks that range as deprecated.

Please use an ASCII-only token. **Interior spaces are allowed**: a passphrase like
`correct horse battery staple` is perfectly sendable and, under a 24-character minimum, is often
easier to get right than a random string. Leading/trailing whitespace is covered by the rule
above.

##### Why the 24-character minimum

**Why the 24-character minimum.** The Worker form has no distributed login rate limiting.
Building one would mean using KV as the counting window, which hands an attacker a lever to burn
your write quota — widening the attack from "guess the password" to "kill the key pool's state
writes". Token entropy is therefore the only defense here, and the minimum is not a suggestion.
Below it the panel is not enabled and an `admin.token_rejected` line goes to the container log.

##### Why it must differ from `GATEWAY_TOKEN`

**Why it must differ from `GATEWAY_TOKEN`.** `GATEWAY_TOKEN` is the relay token you hand to
**every downstream user**. Reusing it as the panel token means anyone holding it can read your
entire key pool, switch the registrar off, and repoint the registration backend at their own
server — harvesting the mailbox, password and verification code of every account minted from then on.

##### How a conflict surfaces, and how to deal with it

This rule is **re-checked on every admin request, and deliberately not enforced at startup**. If
the two are equal — for example because `gatewayToken` was written into storage by hand with
`wrangler kv key put`, or by editing `store.json` — the admin endpoints return **`503`**, and an
`admin.token_conflict` line is logged at error level (if the conflict is already present at boot,
the same line appears in the startup log so you see the reason immediately). **Gateway forwarding
is unaffected.**

**Once the conflict has happened, treat `ADMIN_TOKEN` as leaked — there is exactly one way to
recover: rotate it to a brand-new value.** On Workers run `npx wrangler secret put ADMIN_TOKEN`
and redeploy; on Docker edit `.env` and recreate the container. **Do not just change the stored
`gatewayToken` back.** That does bring the admin endpoints back immediately (it takes effect once
the configuration cache next refreshes, with **no restart needed**), but it restores availability,
not security: while the conflict lasted, the admin token and the gateway token were the same
value, and the gateway token is the one you hand to **every downstream user** — anyone who already
has it (or is about to be given it) can simply open your admin panel. Changing `gatewayToken` back
is a fine way to restore availability first, but you **still have to rotate `ADMIN_TOKEN`**
afterwards; the incident is only handled once both steps are done.

##### Why this one deliberately does not fail at startup

**Why this one rule is not enforced at startup.** `gatewayToken` can change while the gateway
runs, and a startup decision never gets a second evaluation: if the whole `/admin` tree were
withheld there, every isolate that cold-starts during the conflict — and every Docker container
started during it — would be **permanently `404`**, unrecoverable by fixing the configuration and
only curable by a restart, while isolates built before the conflict merely return `503` and
recover as soon as you change the value back. Same configuration, same instant, two different
answers — and the "no restart needed" sentence above would be half a lie. The two rules that
concern `ADMIN_TOKEN` alone (leading/trailing whitespace, unsendable characters, minimum
length) do not have this
problem: their only input is an environment variable that cannot change at runtime, so they are
still enforced at startup and their failure mode remains `404`.

##### How to rotate it, and what to do if it leaks

`ADMIN_TOKEN` is read **from environment variables only, never from storage**: the panel cannot
rotate its own key. To rotate it, run `npx wrangler secret put ADMIN_TOKEN` and redeploy on the
Worker, or edit `.env` and recreate the container on Docker.

**Leaking the admin token means leaking `ADMIN_TOKEN` itself.** The panel stores it verbatim in
the browser's localStorage. There is no derived token and no in-product revocation path. The only
way to revoke it is to change the secret and redeploy (Worker) or recreate the container (Docker).
The panel asks for the token again after 12 hours, but that only shortens how long that
localStorage value stays usable — it is **not** revocation. Put the panel behind TLS and open it
only on machines you trust.

**What that cap cannot do, stated plainly.** The panel's CSP uses `connect-src 'self'` to stop the
token from being `fetch`ed to an external domain and `form-action 'none'` to stop form-based
exfiltration; it cannot stop navigation-based exfiltration such as
`location.href = "https://…?k=" + token` — CSP no longer has a directive for that
(`navigate-to` was removed from the spec). The real fix is server-issued **revocable derived
tokens**, which requires the server to store sessions and therefore conflicts with the design rule
that `ADMIN_TOKEN` is read from environment variables only, never from storage. Left for a later
release.

#### `TRUST_PROXY` decides where the client IP comes from

When set, the client IP recorded in login-failure events comes from `CF-Connecting-IP`, falling
back to the first segment of `X-Forwarded-For`.

**`TRUST_PROXY` is a security switch, which is why it defaults to off.** The client IP it decides
ends up in the `admin.login_failed` event, so trusting a client-supplied header blindly would let
anyone pin brute-force traces on an arbitrary IP.

**With it off, no forwarded header is trusted and the field is recorded as `null` — including
`CF-Connecting-IP`.** That header is often described as unforgeable, but the property only holds
*while the request really goes through Cloudflare*. On a directly exposed Node/Docker deployment
nothing overwrites it, so a client can simply send `CF-Connecting-IP: 1.2.3.4` and be believed —
and direct exposure is the default Docker shape.

**With it on, `CF-Connecting-IP` wins and `X-Forwarded-For` is only the fallback.** The two are
not equally forgeable:

- `CF-Connecting-IP` is written by the Cloudflare edge, which **overwrites** any same-named header
  the client sent — so it cannot be forged as long as the request really goes through Cloudflare.
- `X-Forwarded-For` is a chain any middlebox can append to, and a client can send a fake one, so
  how much of it you can believe depends entirely on what your proxy chain looks like.

##### How to configure it in each of the two topologies

**On the Worker, set `TRUST_PROXY=1`.** Cloudflare is by definition in front there, which makes
`CF-Connecting-IP` the authoritative value; preferring `X-Forwarded-For` in that shape would be
wrong, because the chain may carry whatever the client stuffed into it. Without the switch the
field is simply recorded as `null`.

**Behind a generic reverse proxy (nginx / Caddy / Traefik), strip `CF-Connecting-IP` at the proxy
when you turn `TRUST_PROXY=1` on.** In that topology nothing overwrites the header, yet the gateway
prefers it on the assumption that Cloudflare is in front — so an attacker who sends one **outranks**
the `X-Forwarded-For` your proxy just wrote. One line for nginx:

```nginx
proxy_set_header CF-Connecting-IP "";
```

Caddy uses `header_up CF-Connecting-IP ""`; Traefik uses a middleware's `customRequestHeaders`.

##### Shape checking, and recording `null` honestly when nothing is available

**Both headers are shape-checked first**: only dotted-quad IPv4 and IPv6 shapes (hex digits, colons,
and the dots inside `::ffff:` mappings) reach the event; anything else is recorded as `null`. This
is not an authentication boundary — the value has exactly one consumer in the whole repo, the
login-failure event — it exists so that an unauthenticated caller cannot write arbitrary text into
an audit field that the admin panel's events view will filter and display.

If nothing usable is available the field is recorded as `null` — never a fabricated `"unknown"`,
which would read as a real source.

### What the settings page can change (P3c)

The panel's **Settings** page has three cards: **Credentials**, **Upstream & cooldowns**, and
**Registrar** (which holds the two fully equal mailbox-channel sub-cards plus an *Advanced*
disclosure). It writes to the `config` key **in storage**, never to environment variables.

**Every field shows three values, not one.** The line "stored X · env Y · effective Z" separates
"what you saved", "what the deployment supplies", and "what the gateway is actually using".
The precedence is always **environment variable > storage > built-in value**.

#### Fields locked by environment variables cannot be edited at all

**Fields locked by an environment variable cannot take effect from the panel, so the panel
refuses to edit them.** The input is greyed out and a note names the variable and says the change
has to happen on the deployment side. `PUT /admin/api/config` answers `400 locked_by_env` for those
fields and **writes nothing**: writing would produce "saved successfully, effective value unchanged",
and the operator would blame a stale cache and wait for two refresh cycles for nothing.

> [!IMPORTANT]
> **From P3c the registrar family is in that lock table too** (`REGISTRAR_ENABLED`,
> `REGISTRAR_PRIMARY`, `REGISTRAR_FALLBACK`, `TARGET_KEYS`, `MINT_BATCH`, `TEND_INTERVAL_MS`,
> `CODE_TIMEOUT_MS`, `MINT_DELAY_MIN_MS`, `MINT_DELAY_MAX_MS`, `MAX_DOMAIN_ATTEMPTS`,
> `REGISTRAR_TOKEN_NAME`, `AGNES_PLATFORM_URL`, `YYDS_BASE_URL`, `YYDS_API_KEY`,
> `MOEMAIL_BASE_URL`, `MOEMAIL_API_KEY`). Before that they were not: with `TARGET_KEYS=30` in
> `docker-compose.yml`, changing it to 20 in the panel saved fine while the effective value stayed 30
> **even across restarts**, and the panel said nothing about it.

#### Credentials are write-only

**Credentials are write-only.** The gateway token and both channel API keys are **never returned in
plaintext**; the API returns only "configured or not" and the **last 4 characters** (and not even
those if the secret is shorter than 5 — showing them would be showing all of it). Therefore:

- the inputs are always empty and the placeholder reads **leave blank to keep unchanged**;
- on save, an absent or blank credential field **means "do not change"**, not "clear". Implementing
  blank as "clear" would wipe the gateway token the first time an operator saves the settings page —
  and **the running process would keep going on its last good snapshot**, so nothing would look wrong
  until the next restart;
- clearing is only possible through the dedicated "Clear" button, which asks for confirmation.

##### How credentials written from the panel are persisted

> [!WARNING]
> **Credentials written from the panel are stored in plaintext** in KV / `store.json`, at the same
> level as P1's "keys are stored in plaintext". Do not assume what you type here is an encrypted
> secret. Treat the data directory / KV namespace as credential material.

> [!WARNING]
> **If you clear the gateway token while `GATEWAY_TOKEN` is not in the environment either**, the
> current process keeps running, but **the next restart or isolate recycle will fail to start**. The
> panel says so in a red notice at that moment; recover by setting a new gateway token on the same page
> right away. **Clearing is safe when the environment does supply the value**: only the stored copy goes away and the effective value falls back to the environment variable, unchanged. The panel says two different things in these two states rather than leaving you to guess.

#### The registration backend URL in the "Advanced" area

> [!WARNING]
> **The registration backend URL (`AGNES_PLATFORM_URL`) inside the *Advanced* disclosure is not an
> ordinary setting.** It is **where every automated registration goes**: point it elsewhere and that
> server receives the mailbox, password and verification code used for each registration. That is why
> it lives behind a disclosure, carries a red warning, and has its own confirmation button instead of
> riding along with the main Save.

#### The save receipt and how long propagation takes

**After saving, the panel does not claim "saved and in effect".** It **reads the effective values
back**, highlights the fields that actually changed, and states **how long other replicas/isolates
may take to see the change**: the config holder's TTL is 30 seconds and the KV edge cache defaults to
60 seconds, so the upper bound is about **90 seconds**. This instance is immediate (saving
invalidates its local cache); other instances are not. **Panel copy must never say "takes effect
immediately".**

### Registrar variables (optional, disabled by default)

The registrar is an optional auto-refill component, disabled by default, and does not affect
the gateway's core forwarding behavior. This is a quick-reference table only — for how it works,
how to choose between the two mailbox channels, the Cloudflare Cron wall-clock limit, and more,
see [REGISTRAR.md](REGISTRAR.md).

| Variable | Required | Default | Notes |
|--------|--------|-------|-----|
| `REGISTRAR_ENABLED` | no | `false` | Master switch; must be `true` to enable the registrar. |
| `REGISTRAR_PRIMARY` | required once enabled | none | Primary channel, `yyds` or `moemail`; the two are equal, no default. |
| `REGISTRAR_FALLBACK` | no | empty (no fallback) | Fallback channel, `yyds` or `moemail`. |
| `TARGET_KEYS` | no | `20` | Target number of usable keys. |
| `MINT_BATCH` | no | `5` | Maximum keys minted per round. |
| `TEND_INTERVAL_MS` | no (Node/Docker only) | `1800000` | Node-side refill interval; on the Worker this is governed by the Cron in `wrangler.toml` instead. |
| `CODE_TIMEOUT_MS` | no | `120000` | Timeout waiting for the verification code. |
| `MINT_DELAY_MIN_MS` / `MINT_DELAY_MAX_MS` | no | `2000` / `5000` | Random delay between mint attempts. |
| `MAX_DOMAIN_ATTEMPTS` | no | `8` | Maximum domains tried per mint attempt. |
| `REGISTRAR_TOKEN_NAME` | no | `auto` | Display name given to the minted key in the Agnes dashboard. |
| `AGNES_PLATFORM_URL` | no | `https://platform-backend.agnes-ai.com` | Agnes platform backend used for registration. |
| `YYDS_BASE_URL` / `YYDS_API_KEY` | no / required if a channel is yyds | `https://maliapi.215.im` / empty | YYDS Mail channel credentials. |
| `MOEMAIL_BASE_URL` / `MOEMAIL_API_KEY` | required if a channel is moemail | empty / empty | MoeMail channel credentials (self-hosted, no default address). |

### What each of the two timeout budgets covers

The criterion is *when the upstream's first byte can possibly arrive*, not the name of the
endpoint:

| Budget | Endpoints | Variable |
|------|---------|--------|
| First-byte | **Streaming** chat (`stream: true`), video polling `GET /v1/videos/{id}` | `UPSTREAM_TIMEOUT_MS` |
| Synchronous | Image generation, video job creation, and **every non-streaming chat request** (all four protocols) | `UPSTREAM_SYNC_TIMEOUT_MS` |

A non-streaming request only gets its response headers once the upstream has generated the
entire answer — exactly the same latency shape as image generation. Holding it to the 8-second
first-byte budget fails perfectly normal requests and drags the key pool down with them.

`UPSTREAM_SYNC_TIMEOUT_MS` is the **total budget for one request**, i.e. the worst case a client
ever waits — not "pool size × budget". Within that budget the gateway spends at most half on a
single key and keeps the rest for retrying with another key, so one hung key (connects but never
answers) cannot swallow the request. Set it to **at least twice the worst-case duration of a
single call**.

A synchronous timeout does not punish the key right away: only if another key succeeds *within
the same request* does the gateway charge the timeout to the key that timed out (reaching
`MAX_STRIKES` puts it into cooldown). If every key in that request timed out, none is punished —
that is far more likely to be an undersized budget or a slow upstream.

Eviction and cooldown are deliberately different things. An upstream `401`/`403` evicts the key
**permanently** regardless of any of the settings above — those mean "this key is no longer
valid," and retrying is pointless. Transient failures never evict: once a key reaches
`MAX_STRIKES` it only goes into a `COOLDOWN_STRIKE_MS` cooldown and comes back on its own, so a
spell of upstream flakiness cannot permanently destroy your pool.

When no key can serve a request the gateway answers `503` with a machine-readable
`error.reason`: `pool_empty` (no keys imported), `all_cooling` (every key is cooling down —
this recovers by itself, and a `Retry-After` header tells you when), `all_evicted` (every key
was permanently evicted for invalid credentials — this does **not** recover; import new keys),
or `upstream_error` (keys are fine, the upstream failed on every attempt).

### Can a very long non-streaming request be severed mid-flight? (the two deployments may differ)

**Bottom line: there is no platform promise we can rely on for the Worker side, so this
document makes no promise, and neither does the admin panel.**

Two statements from the official Cloudflare Workers limits page have been verified:
HTTP-triggered Workers have **no** wall-clock duration limit ("There is no hard limit on
duration for HTTP-triggered Workers"), and individual outbound subrequests have **no**
time limit either ("There is no set time limit on individual subrequests"). Both are
conditioned on the client staying connected.

**Those two do not cover everything.** Spelled out:

- The documented **125-second Proxy Read Timeout (error 524)** appears only in the context
  of zone traffic reverse-proxied through Cloudflare. The docs **never state whether it
  applies to a Worker's own outbound subrequest** — when it cannot be found, treat it as
  "no platform promise" rather than guessing.
- The same page notes the runtime is updated a few times per week, and in-flight requests
  get a **30-second** grace period before being terminated. Low probability, but it exists.
- The **15 minutes (900 s)** figure in `wrangler.toml` is the wall-clock limit for
  **Cron Triggers (`scheduled()`)**, **not for `fetch()`**. Do not carry it over.

⇒ **Two practical consequences:**
1. A non-streaming request in the `UPSTREAM_SYNC_TIMEOUT_MS` range (120000 by default)
   **may behave differently** on Worker versus Docker. The Node/Docker side has no platform
   wall clock and is bounded only by the budget you configure.
2. **The admin panel (Playground) never claims the two deployments behave the same**, and
   gives no "guaranteed to survive N seconds" number. If you need long requests, set
   `UPSTREAM_SYNC_TIMEOUT_MS` to a value you have measured, or switch to a streaming
   endpoint (the first-byte budget).

## Multi-Account Configuration

The normal way to import keys is the admin panel, or `POST /admin/api/keys` directly (at
most 200 per call — see [API.md](API.md) and [ADMIN.md](ADMIN.md)). The **write-straight-
into-the-storage-backend** recipe below is for two situations only: `ADMIN_TOKEN` is not
set yet (the whole panel tree is unregistered), or the panel is down and you need an
emergency recovery path. It does **not** update `pool:index`, so a new record is not
necessarily visible right away; the cost is in "The index and how
long changes take to show up" below.
Each entry is a JSON object keyed as
`key:<id>`, where `<id>` can be any string unique within the pool (the gateway derives one
from a hash of the key when it creates records itself, but nothing validates that on read,
so any unique identifier works for a manual import):

```json
{
  "id": "1a2b3c4d5e6f7a8b",
  "key": "your-real-agnes-api-key",
  "addedAt": 1735689600000,
  "lastUsedAt": null,
  "cooldownUntil": 0,
  "strikes": 0,
  "evicted": false,
  "evictedReason": null
}
```

### Importing into Docker

Stop the container first to avoid a write race with the running process, edit
`./data/store.json` on the host to add an entry like the one above under the key
`"key:1a2b3c4d5e6f7a8b"`, then start the container again:

```bash
docker compose stop
# edit ./data/store.json
docker compose start
```

If `./data/store.json` doesn't exist yet, create it containing a single JSON object whose
keys are the `key:<id>` strings.

### Importing into Cloudflare Worker

Write the record straight into the `POOL` KV namespace with wrangler:

```bash
npx wrangler kv key put --binding=POOL "key:1a2b3c4d5e6f7a8b" \
  '{"id":"1a2b3c4d5e6f7a8b","key":"your-real-agnes-api-key","addedAt":1735689600000,"lastUsedAt":null,"cooldownUntil":0,"strikes":0,"evicted":false,"evictedReason":null}' \
  --remote
```

Omit `--remote` to write into the local namespace used by `wrangler dev` instead of
production.

### The index and how long changes take to show up

The gateway keeps a `pool:index` key listing the pool's ids so that forwarding never spends a
KV `list` operation (the free-tier `list` quota is only 1,000/day and is a separate bucket from
reads and writes). **Writing a record by hand does not touch that index**, so how soon the new
key gets used depends on the state of the pool at that moment:

- **When the pool is empty**: the index says the pool is empty and indeed not a single record can
  be read, so the gateway falls back to one `list` scan that discovers the hand-imported record
  and back-fills it into the index. That scan has a built-in 10-minute backoff (see the quota
  budget above), so the visibility bound is **≤10 minutes + one `POOL_CACHE_TTL_MS`**.
- **When the pool is not empty**: the forwarding path only fetches records the index knows about,
  so a record the index has never heard of is **completely invisible** — with no error anywhere.
  It has to wait for the next cron reconciliation to repair the index (30 minutes by default, and
  **the trigger timing carries no official guarantee**, see below), then for up to one more
  `POOL_CACHE_TTL_MS`.

**To make a hand import take effect immediately, add the id to `pool:index` at the same time:**

```bash
npx wrangler kv key get --binding=POOL "pool:index" --remote
# append the new id to the ids array and write the whole value back (v is always 1)
npx wrangler kv key put --binding=POOL "pool:index" \
  '{"v":1,"ids":["existing-id","1a2b3c4d5e6f7a8b"]}' --remote
```

Once the index is written, every isolate picks the key up after at most one `POOL_CACHE_TTL_MS`.

Do not delete the `[triggers]` block in `wrangler.toml`, even if you never enable the
registrar: that cron is the only path that reconciles `pool:index` against the actual
`key:` records, and it runs regardless of `REGISTRAR_ENABLED`.

**This cron's trigger timing is not officially guaranteed.** Cloudflare does not
document any reliability commitment for Cron Triggers firing on the `crons`
schedule (no guarantee against skipped runs, no documented delay bound). This is
safe for the quota accounting — fewer reconciliation runs only ever reduce actual
KV read/write usage, never increase it — but it means **there is no guarantee on
how long an orphaned record or ghost index entry takes to be reclaimed**; in the
worst case it can take longer than the expected "up to 30 minutes". During that
wait the affected key is simply unusable, not lost or corrupted.

### Revoking a key

**Delete the record, then remove its id from `pool:index` — do both steps.** Deleting only the
record is not an error (unreadable records are simply filtered out), but the id stays in the
index, costing one wasted read on every refresh until the next reconciliation prunes it.

```bash
npx wrangler kv key delete --binding=POOL "key:1a2b3c4d5e6f7a8b" --remote
# drop that id from the ids array and write the whole value back
npx wrangler kv key put --binding=POOL "pool:index" '{"v":1,"ids":["remaining-id"]}' --remote
```

On Docker this means deleting the `"key:<id>"` entry from `./data/store.json` and fixing the
`ids` array under `"pool:index"`; stopping the container first (`docker compose stop`) is
recommended.

Isolates and processes that already loaded an older snapshot stop selecting the key after at most
one `POOL_CACHE_TTL_MS`; on the Worker, add one KV propagation window (about 60 seconds) on top,
since that is how long a delete takes to become visible in every colo.

**It will not be written back during that window either**: before persisting any state change the
gateway first confirms the record still exists, and drops the write — refreshing its own snapshot
immediately — when it does not. The one exception is that same propagation window: if the
confirming read is served by KV's edge cache, this colo still believes the record is there.
Docker (file storage) has no such cache, so there the guarantee is exact.

## Verification

Three commands, cheapest first. Replace `$BASE` with your own address (the Worker's is
`https://{name}.{sub}.workers.dev`, Docker's is `http://localhost:8080`) and `$TOKEN` with the
`GATEWAY_TOKEN` you set.

### Health check

```bash
curl -s "$BASE/health"
```

`status` of `ok` means storage is readable and writable; `degraded` means something is wrong on
the storage side and the reason is in the logs. **This one needs no token**, which also makes it
the only endpoint that still answers when the token is wrong.

### Model list

```bash
curl -s "$BASE/v1/models" -H "Authorization: Bearer $TOKEN"
```

You get back the list of models this gateway serves. If this passes, the token is right; a `401`
means it is not.

### One real conversation

```bash
curl -s "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"agnes-2.0-flash","messages":[{"role":"user","content":"ping"}]}'
```

This is the one that actually reaches upstream. A `503` whose `error.reason` is `pool_empty` means
the pool has no key yet — go back to the section above and import one.

## Troubleshooting

Six of them, ordered by when you are likely to hit them. Each is "symptom → fix", and the
numbered steps are meant to be worked through in order.

### The gateway will not start and the log has one line about a missing token

**Symptom**: The container or the Worker exits right after startup and the log contains nothing but `缺少 GATEWAY_TOKEN，网关无法启动`.

**Fix**:

1. Docker: check that `.env` has a `GATEWAY_TOKEN=` line and that **there is something after the equals sign**.
2. Worker: run `npx wrangler secret put GATEWAY_TOKEN` once, then `npx wrangler deploy`.
3. A corrupted stored config also fails to load. Boot once with `RESET_CONFIG=1` to recover, and **remove that line once you have**.

### Every request answers 503 because the pool is empty

**Symptom**: Every forwarding endpoint answers `503` with `error.reason` set to `pool_empty`.

**Fix**:

1. Import at least one key from the key-pool page of the admin panel, or call `POST /admin/api/keys` (see [API.md](API.md)); with no `ADMIN_TOKEN` set, follow the "Multi-Account Configuration" section and write into the storage backend directly.
2. Already imported and still empty: a hand-written record **does not touch `pool:index`**, so either wait for one reconciliation (30 minutes by default) or add the id to the index by hand.
3. The registrar is on but the pool never grows: check the panel's events board, or follow [REGISTRAR.md](REGISTRAR.md) to debug the two mailbox channels.

### The panel will not open and `/admin` answers 404

**Symptom**: Opening `/admin` in a browser gives a `404` — not a login page, and not a `401` either.

**Fix**:

1. That is exactly what **no `ADMIN_TOKEN`** looks like: the whole tree is never registered, so nothing leaks the fact that there is a panel here.
2. Set and still 404: the token is non-compliant (under 24 characters / leading or trailing whitespace / non-printable ASCII), and the container log has an `admin.token_rejected` line.
3. The panel opens but its endpoints answer `503`: `ADMIN_TOKEN` collides with the stored `gatewayToken`; the log says `admin.token_conflict`, and the section above tells you how to handle it.

### A setting saved in the panel takes ages to reach the other replicas

**Symptom**: You saved a setting in the panel, this instance changed immediately, and another replica or isolate still serves the old value.

**Fix**:

1. That is **normal**: the config holder's TTL is 30 seconds and KV's edge cache defaults to 60, so the ceiling is about **90 seconds**. Wait and look again.
2. Still unchanged after two minutes: check that the field is not locked by an environment variable — locked fields are greyed out in the panel and the endpoint answers `400 locked_by_env`.
3. You changed `POOL_CACHE_TTL_MS` or `POOL_TOUCH_INTERVAL_MS`: those two are **read once when the instance is built**, so only a container restart or an isolate recycle will do it.

### Non-streaming requests time out in bulk and the key pool goes red

**Symptom**: Image generation, video job creation or non-streaming chat time out in batches, and a group of keys enters cooldown in the panel.

**Fix**:

1. Raise `UPSTREAM_SYNC_TIMEOUT_MS` to **more than twice the worst-case duration of a single call**: the default `120000` is tight for slow models.
2. Do not use `UPSTREAM_TIMEOUT_MS` (the first-byte budget, default `8000`) to bound non-streaming requests — that budget is for streaming and video polling.
3. Rule out a general upstream slowdown: when every key in one request times out, the gateway **penalises none of them**; a cooldown is only recorded once a different key in the same request actually succeeds.

### The Docker container is up but `/health` says degraded

**Symptom**: `docker compose ps` shows unhealthy, `/health` answers `503`, and `status` is `degraded`.

**Fix**:

1. Nine times out of ten the data directory is not writable. Read the entrypoint lines in the container log and check whether `./data` is owned by `100:101`.
2. If you pinned a non-root user with `--user` or compose's `user:`, the entrypoint **does not** chown anything and you have to prepare ownership and writability yourself.
3. When `DATA_DIR` points at `/` or a top-level system directory the entrypoint refuses to chown recursively and only prints a warning — point it somewhere sane.

## Performance Tips

First, get one thing straight: **the gateway itself costs almost no time**. The cost sits in two
places — upstream response time, and the read/write quota of your storage. So only three knobs in
this section are worth touching.

```env
# Optional: how long each isolate/process keeps its key-pool snapshot, in ms; 0 disables the cache.
# Raising it saves KV reads; the cost is that cooldowns/evictions decided elsewhere show up later.
POOL_CACHE_TTL_MS=120000

# Optional: how often "last used" is persisted, in ms; 0 persists on every successful request.
# It is a display-only field — lowering it only multiplies KV writes and buys no scheduling gain.
POOL_TOUCH_INTERVAL_MS=21600000

# Optional: total timeout budget for synchronous endpoints (images, video jobs, all non-streaming
# chat), in ms. Set it above twice the worst-case single call, or healthy requests get killed.
UPSTREAM_SYNC_TIMEOUT_MS=180000
```

Three rules of thumb, most valuable first:

1. **On Worker + free-tier KV with more than 20 keys in the pool, raise `POOL_CACHE_TTL_MS` first.**
   At the default, "20 keys and 3 active isolates" already burns about 99.4% of the read quota;
   the arithmetic is in the quota section above.
2. **Do not lower `POOL_TOUCH_INTERVAL_MS` just to make the panel's "last used" more precise.**
   That is a display-only field, the write quota is only 1,000 per day, and cooldown/eviction
   bookkeeping competes for the same bucket.
3. **Move long requests to the streaming endpoints.** The first-byte budget only bounds the first
   byte; however long generation takes afterwards is not counted. The non-streaming budget has to
   cover the upstream computing the whole answer, and the two forms may not even behave the same
   way at the platform level.

## Monitoring and Maintenance

### The health endpoint

`/health` is the only endpoint that needs no token, and both forms have it:

```bash
curl -s "$BASE/health"
```

`status` of `ok` means storage is readable and writable; `degraded` means something is wrong there
(on Docker it is usually a data directory that cannot be written). On Docker the image's built-in
`HEALTHCHECK` calls exactly this, and healthy/unhealthy in `docker compose ps` comes from it.

### The panel's events board

Once `ADMIN_TOKEN` is set, the panel's events board lists the diagnostic events the gateway
records for itself, by level (failed logins, token conflicts, failed refills, exhausted
budgets, and so on). It is **not a replacement for logs**: it keeps 24 hours, and a single poll
looks back at most 48 keys. For long-term retention, ship the container logs somewhere.

### Usage statistics (off by default)

The by-day / by-hour / by-model / by-protocol time series is **off by default**, and "off" is
zero-cost — no accumulator is built and not one storage write happens. To turn it on:

```env
# Optional: the Tier-2 time series behind the panel's "Usage" section. The check is a literal
# true; 1 or yes count as off. Once on, each instance writes at most 13 puts per day (~10.4% of
# the write quota) and the unflushed tail is at most 2 hours.
USAGE_STATS_ENABLED=true
```

Read the Tier-2 part of the quota section above before switching it on: it competes for the same
write bucket as the key pool's cooldown and eviction bookkeeping.

## Upgrading the Service

The upgrade command for each form lives in the "Update" part of its own section
([Cloudflare Worker](#cloudflare-worker-deployment) / [Docker](#docker-deployment)). This section
is about everything around those two commands that is the same on both sides.

### Before you upgrade

1. **Back the storage up first.** There is exactly one copy of the key pool and the config; see
   "Backup and Restore" below.
2. **Glance at the CHANGELOG.** Breaking changes are recorded there; the version badge in all six
   READMEs points at it.
3. **An upgrade never requires wiping storage.** Stored records are backward compatible, and the
   `v` field of `pool:index` is always `1` today.

### What to check afterwards

1. `/health` answers `200` with `status` set to `ok`.
2. The panel (if you run one) still logs in and the key pool has the same number of entries as
   before.
3. Run the third command from "Verification" above to confirm requests really reach upstream.

Rolling back: on Docker, pin the image tag to the previous version and run `docker compose up -d`
again; on the Worker, roll back from Deployments in the Cloudflare dashboard, or `git checkout`
the previous tag and run `npx wrangler deploy` again.

## Backup and Restore

There is one copy of the key pool and the config, and no second one.
**Backing up means backing up the storage itself.**

### Docker

```bash
docker compose stop
cp -a ./data ./data.bak
docker compose start
```

Stopping first avoids a write race. `./data/store.json` holds everything: the key records,
`pool:index`, and the storage-side config. Restoring is copying the directory back and running
`docker compose up -d`.

### Cloudflare Worker

```bash
npx wrangler kv key list --binding=POOL --remote
npx wrangler kv key get --binding=POOL "pool:index" --remote
```

Pull each `key:<id>` out into a file; restoring goes through `npx wrangler kv key put`, exactly
like importing a key below.

> [!WARNING]
> A backup file contains **keys and credentials in plain text** (the gateway token and both
> mailbox channels' API keys live in the storage-side config). Treat it as a credential: not in a
> repository, not in a public object store.

## Security Recommendations

- **`GATEWAY_TOKEN` and `ADMIN_TOKEN` must be two different tokens.** The former is the relay
  token you hand to **every downstream user**; reusing it for the panel hands over the whole key
  pool, the registrar switch and the registration backend URL along with it.
- **Put the panel behind TLS and only open it on machines you trust.** The panel keeps
  `ADMIN_TOKEN` verbatim in the browser's localStorage; there is no derived token and no in-product
  revocation path. Asking for it again after 12 hours shortens the window, **it is not revocation**.
- **Only turn `TRUST_PROXY` on when the gateway really sits behind a proxy.** Behind a generic
  reverse proxy, strip `CF-Connecting-IP` there as well, or an attacker who supplies one outranks
  the `X-Forwarded-For` your proxy just wrote.
- **Treat the data directory, the KV namespace and every backup as credentials.** Keys and the
  credentials written through the panel are all stored in plain text, at the same level as the
  keys themselves.

A minimal security baseline:

```env
# Required: the token clients must present to call this gateway. This is what you hand downstream.
GATEWAY_TOKEN=replace-with-your-own-long-random-string

# Optional: the admin panel token. Unset means the whole /admin tree is never registered, so
# visiting it gives 404 rather than 401. Must differ from GATEWAY_TOKEN, at least 24 characters,
# printable ASCII only.
ADMIN_TOKEN=replace-with-another-long-random-string

# Optional: set to 1 only when the gateway really sits behind a proxy. The Worker form is one of
# those cases and should have it set.
TRUST_PROXY=1
```

## Next Steps

- Usage and SDK wiring for all four protocols: [USAGE.md](USAGE.md)
- The web admin panel: [ADMIN.md](ADMIN.md)
- The registrar (automatic pool refill): [REGISTRAR.md](REGISTRAR.md)
- Endpoints and request / response shapes for all four protocols: [API.md](API.md)
- What this project is, and how to get started: [README.md](../../README.md)
- Bug reports and questions: [GitHub Issues](https://github.com/xwteam/agnes2api/issues)
