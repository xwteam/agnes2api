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
| `UPSTREAM_TIMEOUT_MS` | no | `8000` | Abort an upstream call if no first byte arrives within this many milliseconds. |
| `MAX_STRIKES` | no | `3` | Consecutive transient failures (timeouts, network errors, upstream `5xx`) before a key is put into a long cooldown. |
| `COOLDOWN_RATE_LIMIT_MS` | no | `60000` | Cooldown duration applied to a key after an upstream `429`. |
| `COOLDOWN_PAYMENT_MS` | no | `3600000` | Cooldown duration applied to a key after an upstream `402`. |
| `COOLDOWN_STRIKE_MS` | no | `1800000` | Cooldown duration applied once a key reaches `MAX_STRIKES`. The key recovers automatically when it expires. |
| `PORT` | no (Node/Docker only) | `8080` | Listen port for the Node runtime. Not used by the Worker. |
| `DATA_DIR` | no (Node/Docker only) | `/app/data` | Directory the file-backed storage writes `store.json` into. Not used by the Worker. |

`COOLDOWN_RATE_LIMIT_MS` and `COOLDOWN_PAYMENT_MS` aren't listed in `.env.example` by
default, but both are read from the environment and can be set for either deployment target.
Every numeric variable above must be a positive integer; the gateway refuses to start otherwise.

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

   The image also ships a `HEALTHCHECK` that Docker uses to report container health.

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
