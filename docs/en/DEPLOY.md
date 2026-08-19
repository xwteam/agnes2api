# Deployment Guide

**Language:** English | [简体中文](../zh-CN/DEPLOY.md) | [繁體中文](../zh-TW/DEPLOY.md) | [日本語](../ja/DEPLOY.md) | [한국어](../ko/DEPLOY.md)

agnes2api ships as two deployment targets built from the same codebase and request-handling
logic — pick whichever fits your infrastructure. They differ only in storage backend: the
Worker uses a Cloudflare KV namespace, Docker uses a JSON file on a mounted volume.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GATEWAY_TOKEN` | **yes** | – | The token clients must present to call this gateway. |
| `AGNES_BASE_URL` | no | `https://apihub.agnes-ai.com/v1` | Upstream Agnes API base URL. |
| `UPSTREAM_TIMEOUT_MS` | no | `8000` | First-byte timeout for **streaming** responses and video polling: abort the upstream call if no first byte arrives within this many milliseconds. |
| `UPSTREAM_SYNC_TIMEOUT_MS` | no | `120000` | Total timeout budget for **synchronous** endpoints — the ones whose first byte only arrives once the upstream has computed the whole result: image generation, video job creation, and every **non-streaming** chat request. See below. |
| `MAX_STRIKES` | no | `3` | Consecutive transient failures (timeouts, network errors, upstream `5xx`) before a key is put into a long cooldown. |
| `COOLDOWN_RATE_LIMIT_MS` | no | `60000` | Cooldown duration applied to a key after an upstream `429`. |
| `COOLDOWN_PAYMENT_MS` | no | `3600000` | Cooldown duration applied to a key after an upstream `402`. |
| `COOLDOWN_STRIKE_MS` | no | `1800000` | Cooldown duration applied once a key reaches `MAX_STRIKES`. The key recovers automatically when it expires. |
| `POOL_CACHE_TTL_MS` | no | `60000` | Each isolate/process keeps an in-memory snapshot of the key pool; this is how long that snapshot lives. `0` disables the cache. **KV reads are independent of request count** — they depend only on the refresh rate; see the quota section below for the formula. Cost: cooldowns/evictions decided by another isolate take up to this long to become visible here. |
| `POOL_TOUCH_INTERVAL_MS` | no | `21600000` | How often a key's "last used" timestamp is at most persisted. `0` persists it on every successful request. It is a display-only field that no scheduling logic reads; writing it per request would burn the free tier's 1,000 writes/day and leave no budget for cooldowns and evictions. Cost: "last used" is only accurate to within this interval. |
| `PORT` | no (Node/Docker only) | `8080` | Listen port for the Node runtime. Not used by the Worker. |
| `DATA_DIR` | no (Node/Docker only) | `/app/data` | Directory the file-backed storage writes `store.json` into. Not used by the Worker. |

`COOLDOWN_RATE_LIMIT_MS` and `COOLDOWN_PAYMENT_MS` aren't listed in `.env.example` by
default, but both are read from the environment and can be set for either deployment target.
Every numeric variable above must be an integer; all of them must be greater than `0` except
`POOL_CACHE_TTL_MS` and `POOL_TOUCH_INTERVAL_MS`, whose lower bound is `0` (meaning
"disabled"). The gateway refuses to start otherwise.

`POOL_CACHE_TTL_MS` and `POOL_TOUCH_INTERVAL_MS` are read **once, when the app is built**.
Changing them requires restarting the container or waiting for isolates to be recycled — unlike
every other setting, they do not take effect per request.

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
  48–96 daily index reconciliations, **3 active isolates already consume ~99.5%**. In other words
  the default is already marginal at the recommended settings — if you expect more isolates, raise
  `POOL_CACHE_TTL_MS` (20 keys across 5 isolates needs roughly `120000`).
- **With the cache disabled** (`POOL_CACHE_TTL_MS=0`, the escape hatch) reads grow linearly with
  requests, giving a floor of about `100,000 ÷ (1 + pool size)` ⇒ roughly **4,700 requests/day**
  with 20 keys.
- **Writes**: in steady state about `pool size × 4` per day (`lastUsedAt` is touched every 6
  hours) — 80 with 20 keys, 8% of the write quota, leaving the rest for cooldown and eviction
  bookkeeping. Each key also costs one one-off write the first time it is used.

### Registrar variables (optional, disabled by default)

The registrar is an optional auto-refill component, disabled by default, and does not affect
the gateway's core forwarding behavior. This is a quick-reference table only — for how it works,
how to choose between the two mailbox channels, the Cloudflare Cron wall-clock limit, and more,
see [REGISTRAR.md](REGISTRAR.md).

| Variable | Required | Default | Notes |
|---|---|---|---|
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
|---|---|---|
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

## Cloudflare Worker

### Option A — Deploy to Cloudflare button

Click the button in the root [README](../../README.md), authorize Cloudflare, and it will
fork/clone the repository and deploy it for you. You still need to complete the **secret**
and **KV namespace** steps below afterward — the button does not set those up.

### Option B — Manual deploy

1. Clone the repository and install dependencies:

   ```bash
   git clone https://github.com/xwteam/agnes2api.git
   cd agnes2api
   pnpm install
   ```

2. Create a KV namespace for the key pool and bind it as `POOL`:

   ```bash
   npx wrangler kv namespace create POOL
   ```

   Copy the returned namespace `id` into `wrangler.toml`, replacing
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`:

   ```toml
   [[kv_namespaces]]
   binding = "POOL"
   id = "your-namespace-id"
   ```

3. Set the gateway token as a Worker secret (never commit it to `wrangler.toml`):

   ```bash
   npx wrangler secret put GATEWAY_TOKEN
   ```

4. Deploy:

   ```bash
   npx wrangler deploy
   ```

### Automatic deploy on tag push

`.github/workflows/deploy-worker.yml` deploys the Worker automatically whenever a `v*` tag is
pushed, provided the repository secret `CLOUDFLARE_API_TOKEN` is configured under
**Settings → Secrets and variables → Actions**. If it isn't set, the workflow logs a warning
and skips the deploy step without failing the run.

### Local development

```bash
npx wrangler dev
```

Put `GATEWAY_TOKEN` into a local `.dev.vars` file next to `wrangler.toml` (already
git-ignored) — do not put secrets directly in `wrangler.toml`.

## Docker

1. Clone the repository and prepare the environment file:

   ```bash
   git clone https://github.com/xwteam/agnes2api.git
   cd agnes2api
   cp .env.example .env
   ```

2. Edit `.env` and set at least `GATEWAY_TOKEN`. See the [environment variables](#environment-variables)
   table above for everything else.

3. Start the container:

   ```bash
   docker compose up -d
   ```

   `docker-compose.yml` publishes port `8080` (override with `PORT` in `.env`) and mounts
   `./data` into `/app/data` inside the container — that's where `store.json` (the key pool
   and any persisted config) lives. Keep that directory around across restarts/upgrades; it's
   your only copy of the imported key pool.

4. Check it came up healthy:

   ```bash
   curl http://localhost:8080/health
   ```

   The image also ships a `HEALTHCHECK` that Docker uses to report container health. If the
   data directory is not writable, `/health` answers `503` with `"status": "degraded"`, the
   container is marked unhealthy, and the underlying reason is in the container logs.

### The container rewrites the ownership of `./data` (read this first)

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

## Importing an upstream Agnes key

This version of the gateway does not expose an HTTP endpoint for adding keys to the pool —
you write directly into the storage backend. Each entry is a JSON object keyed as
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

### Docker

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

### Cloudflare Worker

Write the record straight into the `POOL` KV namespace with wrangler:

```bash
npx wrangler kv key put --binding=POOL "key:1a2b3c4d5e6f7a8b" \
  '{"id":"1a2b3c4d5e6f7a8b","key":"your-real-agnes-api-key","addedAt":1735689600000,"lastUsedAt":null,"cooldownUntil":0,"strikes":0,"evicted":false,"evictedReason":null}' \
  --remote
```

Omit `--remote` to write into the local namespace used by `wrangler dev` instead of
production.

Keys imported this way take effect on the very next request — the gateway keeps a
`pool:index` key listing the pool's ids (so that forwarding never spends a KV `list`
operation, whose free-tier quota is only 1,000/day), and a manually imported record
that the index does not know about is picked up and back-filled automatically.

Do not delete the `[triggers]` block in `wrangler.toml`, even if you never enable the
registrar: that cron is the only path that reconciles `pool:index` against the actual
`key:` records, and it runs regardless of `REGISTRAR_ENABLED`.
