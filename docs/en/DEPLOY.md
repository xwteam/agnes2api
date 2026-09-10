# Deployment Guide

agnes2api ships as one deployment target: a Docker image built from this codebase, run with `docker compose`.

> [!NOTE]
> All state lives in one place — a JSON file on a mounted volume (`store.json`). Back that
> directory up and you have backed up everything.

## System Requirements

One column, because there is one path.

| Item | Requirement |
|------|-------------|
| Command line | Docker Engine 24+ and `docker compose` |
| Platform | Any machine that can run containers |
| Upstream | At least one Agnes API key, see the next section |

> [!TIP]
> Nothing else is needed — no local Node.js, no build toolchain: `cp .env.example .env`, then a
> single `docker compose up -d` brings it up.
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
choose between the two mailbox channels, and how often a round runs are all documented in
[REGISTRAR.md](REGISTRAR.md).

> [!IMPORTANT]
> Either way the key lands **in plain text** in `store.json`. Treat the data directory as
> credential material.

## Docker Deployment

### Prerequisites

> [!NOTE]
> The `## ⚡ Quick Deployment` section of the [README](README.md) in this directory gives the
> same three commands in short form. This section is the long form: it spells out what each one
> leaves you to decide, starting with the token you must set before the first start.

Clone the repository and prepare the environment file:

```bash
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api
cp .env.example .env
```

**Running it from source instead of the image**: `pnpm dev:node` starts with
`node scripts/build-ui.mjs`, then builds and runs `dist/entry/node.js`. A bare
`node dist/entry/node.js` starts too, but the panel stays on whatever was generated last — if
you changed `admin-ui/` and see nothing, that is usually why.

### Configuration

Edit `.env` and set at least `GATEWAY_TOKEN`. See the [environment variables](#environment-variables)
table below for everything else.

The smallest usable `.env` is two lines; everything else has a default and can be added later:

```env
# Required: the token clients must present to call this gateway. This is what you hand downstream.
GATEWAY_TOKEN=replace-with-your-own-long-random-string

# Optional: the listen port inside the container.
# docker-compose.yml also uses it as the port published on the host.
PORT=8080
```

> [!CAUTION]
> **`DATA_DIR` is welded to the volume mount in docker-compose.yml — under Docker, never
> change it on its own.** That line, `./data:/app/data`, is hard-coded and the `DATA_DIR`
> in `.env` takes no part in it. Point `DATA_DIR` elsewhere without editing that line and
> nothing stops you: the container starts, `/health` answers `ok`, the panel and key pool
> work — while store.json lands in the **container's writable layer**. One upgrade later
> the container is recreated and the whole key pool, every issued outbound API key and the
> panel config go with it, while the `./data` you kept backing up was empty all along.
> To move where the data lives, change the **left** half of that mount line; to change the
> right half, set `DATA_DIR` to the same path — both together. The entrypoint checks this
> at startup and logs a "not on any mount point" warning. That line is the only signal in
> this chain: `/health` never says where the data landed.

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

These two commands come up over and over while troubleshooting, so here they are up front —
every later "see the container logs" in this document means the second one:

```bash
docker compose ps                     # is the container up, is it healthy
docker compose logs -f --tail=100     # container logs: entrypoint warnings, admin.token_rejected
```

### Update

```bash
docker compose pull
docker compose up -d
```

`docker compose pull` pulls the tag named by `IMAGE_TAG` in `.env` (unset means `latest`). The
full image name is `ghcr.io/xwteam/agnes2api`; the available tags are listed on the
[GHCR packages page](https://github.com/xwteam/agnes2api/pkgs/container/agnes2api).
**Upgrading = set `IMAGE_TAG` to the version you want and run `docker compose up -d`; rolling
back = set it back.** Once the tag is pinned, this `.env` can answer "which version is running
right now"; `:latest` cannot.

> [!IMPORTANT]
> **After editing `.env`, run `docker compose up -d`, not `docker compose restart`.** The
> latter only restarts the same container, and a container's environment is frozen at
> **creation** time — nothing in it changes when `.env` does. `up -d` notices the changed
> config and recreates the container. Adding `ADMIN_TOKEN` and rotating a token hit the same
> trap; the second one is worse, because you believe the rotation happened while the old
> token is still live.

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
| `POOL_CACHE_TTL_MS` | no | `60000` | How long each process keeps its in-memory key-pool snapshot; `0` disables it. What it costs is below. **Read once at instance build** (`src/http/wire.ts`): a container restart is required — **editing it in the admin panel does not take effect immediately**. |
| `POOL_TOUCH_INTERVAL_MS` | no | `21600000` | How often a key's "last used" timestamp is at most persisted; `0` = every successful request. Cost below. **Read once at instance build** (`src/http/wire.ts`): a container restart is required — **editing it in the admin panel does not take effect immediately**. |
| `USAGE_STATS_ENABLED` | no | `false` | Tier-2 time series in the panel's "Usage" section (by day / hour / model / protocol). **The check is a literal `true`**; `1` / `yes` count as off. **Off by default, and "off" is zero-cost**. What it costs, and how short-lived instances **lose** counts, is below. Read once when the app is built. |
| `PORT` | no | `8080` | Listen port inside the container; `docker-compose.yml` publishes the same number on the host. |
| `DATA_DIR` | no | `/app/data` | Directory the file-backed storage writes `store.json` into. **Welded to the compose mount — never change it alone.** |
| `APIKEY_CACHE_TTL_MS` | no | `300000` | How long each instance caches the outbound API key table; `0` disables it. It also sets how long a disabled key lives on in another container sharing the same volume. See below. |

### Accepted ranges, and the two "read once at construction" exceptions

Every variable in the table above has its own line in `.env.example`; run `cp .env.example .env`
and edit what you need. Comments in that file vary in depth — most variables get a single line,
a few carry a dozen lines or more — so treat this table as the complete reference for ranges and
trade-offs. Every numeric variable above must be an integer; all of them must be greater than `0` except
`POOL_CACHE_TTL_MS` and `POOL_TOUCH_INTERVAL_MS`, whose lower bound is `0` (meaning
"disabled"). The gateway refuses to start otherwise.

`POOL_CACHE_TTL_MS` and `POOL_TOUCH_INTERVAL_MS` are read **once, when the app is built**.
Changing them requires recreating the container — unlike every other setting, they do not take
effect per request.

### `RESET_CONFIG`: when to reach for this escape hatch

> What it is actually for is **bypassing the panel-stored configuration wholesale**: boot once with
> environment variables and built-in defaults only, so you are back in a known-clean state. Remove the
> line afterwards, or nothing you save in the panel will ever take effect.

> [!WARNING]
> **Do not treat it as "the config got corrupted, use this to recover".** Stored values can hardly be
> corrupted badly enough to stop the gateway any more: an invalid number **falls back to the default**
> (the panel reports the degradation), and registrar problems only stop **the registrar** from starting
> this time while the gateway keeps forwarding. The one remaining way to keep the gateway from starting
> is **having no gateway token on either side** — and `RESET_CONFIG=1` would ignore the stored token too,
> so **following that advice makes things worse**.

### What `POOL_CACHE_TTL_MS` costs

**Storage reads are independent of request count** — while the snapshot is warm the forwarding
path reads nothing at all, so what this knob buys is fewer `store.json` reads per process, and
what it costs is how stale that snapshot is allowed to get.

> **This only matters when more than one process shares the volume** — several containers behind
> a load balancer, or a rolling restart with the old and new container both up. Cooldowns and
> evictions decided by another process take up to this value to become visible here — with the
> default 60000 that ceiling is **60** seconds. A single-container deployment has no such window:
> the process that decided the cooldown is the one holding the snapshot.

And it isn't just "seen late": any scheduling write made against a stale snapshot overwrites the
whole record, **erasing** whatever `evicted` / `cooldownUntil` another process had just written
within that window — that decision has to happen all over again.

### What `POOL_TOUCH_INTERVAL_MS` costs, and how to clear the counters

It is a display-only field that no scheduling logic reads.
Persisting it on every successful request would rewrite `store.json` once per request — the
whole file, for a timestamp nothing schedules on. Cost of not doing that: "last used" is only
accurate to within this interval. The same interval also governs the panel's usage counters
(request count / success rate).

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
baseline from that old value when it finishes; another container running against the same volume
keeps its own baseline too. Either way they may push an old value back once.
**Today it is API only — the panel has no button for it.**

### What `USAGE_STATS_ENABLED` costs once you turn it on

"Off" is zero-cost: no in-memory accumulator is created and not a single storage write happens.
Once on, each instance rewrites one shard of `store.json` per flush interval — **at most 13 per
day at the default two-hour interval**, and nothing at all during an interval with no traffic.
The unflushed tail is at most 2 hours. Changing the switch takes effect once the container is
recreated.

> [!WARNING]
> **A "tail" is not the same as "late"**: counts accumulate in the instance's memory, and an
> instance that does not live through one flush interval takes them along —
> **losing them outright rather than posting them late**.
> **Restarts are where this bites**: recreate the container to change one environment variable
> and up to two hours of counts go with the old process, which on the panel looks exactly like
> "nobody used it". Shorten `USAGE_FLUSH_INTERVAL_MS` if that matters to you; the section below
> says what that costs.

### `USAGE_FLUSH_INTERVAL_MS`: what you can buy back, and what stays

Seeing "the tail is at most 2 hours", the first instinct is to shrink the flush interval, and
here you can: `USAGE_FLUSH_INTERVAL_MS` accepts **any positive integer**, so 300000 (5 minutes)
is a perfectly reasonable setting. What you pay is one shard rewrite per interval per instance;
what you buy is a shorter window of counts that a dying process would take with it.

> [!WARNING]
> **A wrong value here is refused while the app is wired up, not at the first request**
> (`src/http/usage-sink.ts`): a non-integer, or anything below 1, makes the process print the
> reason and exit. **The check runs whether or not `USAGE_STATS_ENABLED` is on**
> (`src/http/wire.ts` resolves it unconditionally), so turning statistics off **does not clear
> it** — fix the value or delete the line. A container that will not stay up is the intended
> symptom: it is far easier to notice than statistics that quietly go wrong.

<details>
<summary><b>Click to expand: what "the tail is at most 2 hours" does and does not promise (four points)</b></summary>

① **The tail is not the same as "late", and it has two faces that are one fact**: the "today"
   figures on the panel can be up to one flush interval stale, and **any instance that stops
   before its next flush loses the counts it accumulated**. The clock starts when the instance
   starts, so a container that ran ten minutes and was then recreated stores nothing at all.
   This is one of the reasons usage figures carry an "≈" throughout; it is not a defect.

② **There is no daily write budget on this deployment form.** The gate exists in the code
   (`budgetPerDay`), but file storage has no write quota to protect, so the gateway leaves it
   empty: nothing is ever exhausted, and there is no "recovery" or "catch-up" to speak of.
   **Do not read this as "you cannot lose counts"** — what you lose is the tail in ①.

③ **At most 2 instances' data survives for a given day; anything beyond that overwrites.**
   Usage shards are stored as `usage:<UTC day>:<slot>` and **there are only 2 slots**; each
   instance hashes into one stably by its shard id. So running three or more containers against
   one volume is last-write-wins within a slot. **This is the other reason usage figures carry
   an "≈"**; it affects how complete the numbers are, never whether the gateway forwards.

④ **The three media endpoints (image generation, video creation, video polling) are not
   counted.** They burn the **same** pool of upstream keys as the four chat protocols but record
   nothing ⇒ the panel's "total requests" is systematically lower than the real forwarded
   volume. This is a known boundary, not a defect; judge key consumption from the key-pool side
   instead.

</details>

### What each stored key costs to keep in sync

File storage has no read, write, `list` or delete quota — the cost of a rewrite is one file
write on your own disk. What is still worth knowing is **how long a change takes to be seen by
someone else**, because that is a security property for two of these keys and a debugging trap
for the rest.

#### The key pool and its index

The gateway keeps a `pool:index` key listing the pool's ids, so the forwarding path never has to
scan the whole store. **Two self-healing paths depend on a `list` instead**, and both share the
same built-in **10-minute** backoff (a fixed constant, not an environment variable):

- the **empty-pool rescan** — the index parses fine yet not a single live record can be read, so
  the gateway scans once to find a record that was written by hand and never indexed;
- the **missing-index fallback** — `pool:index` itself cannot be read or fails to parse, so the
  gateway scans once and tries to rebuild the index.

When the pool is empty **and** that scan also fails, the gateway returns `500` with the real
reason in the log; it does **not** disguise the failure as `503 pool_empty`, because both
self-healing paths described in this document are gone at that point and saying "the pool is
empty" would send you looking in the wrong place.

#### Outbound API keys: revocation is not instant

Verifying a key issued from the panel's "API keys" section reads one table, and each instance
caches it for `APIKEY_CACHE_TTL_MS` (default 5 minutes).

- **Deployments where every client uses `GATEWAY_TOKEN` never read it at all.** That zero is
  **structural**, not a switch: the master token is compared in the first stage of
  authentication, and that path has no call site that reads the table. Requests carrying no
  credential at all read nothing either — a scanner cannot lever it.
- **Issuing, renaming, disabling, deleting and purging each rewrite the whole table once**, and
  only when a human clicks. How many keys the table holds makes no difference.

> [!IMPORTANT]
> **Disabling and deleting are not instantaneous. This one is security-relevant; do not read it
> as "takes effect shortly".** The instance that handled the request applies it at once; any
> other container sharing the volume keeps serving the key for up to `APIKEY_CACHE_TTL_MS`
> ⇒ about **5 minutes** by default. The only way to make it faster is to lower that value, and
> the only cost is one more table read per instance per interval.

#### What a click in the panel writes

None of this is metered, but two shapes are worth knowing before you click:

- **Importing M new keys** writes M records plus the index, at most **200 per call** — over that
  it is a `400`, **never a silent truncation**. Splitting a big import into batches is not
  cheaper, since each batch still rewrites the index.
- **Re-importing the same keys** (without ticking "reset the state of existing keys") writes
  **nothing**: duplicates are skipped, never overwritten, so re-pasting your whole list is safe.
- **Bulk delete of N keys** rewrites the index **once**, not N times; **purging the pool** is the
  same rule.
- **Changing one key** (disable / enable / note / clear cooldown / clear strikes / un-evict /
  reset usage counters) is **one read plus one write, whichever action it is**: they all go
  through the same handler and the same single persist, and resetting the counters reads or
  writes nothing extra (what it clears is the in-memory persist baseline).

  > [!IMPORTANT]
  > **The last item in those parentheses is the one thing here you cannot click**: resetting the
  > usage counters is **API only today — the panel has no button for it** (same as the
  > `POOL_TOUCH_INTERVAL_MS` row above). That list enumerates every action the handler
  > understands, not the buttons on the panel; it is written up here so that nobody assumes the
  > other route costs more.
- **"Tend now"** is the one panel action with a daily cap — at most **24** per day (the fourth
  guardrail, see [REGISTRAR.md](REGISTRAR.md)). That cap exists to protect your temporary-mailbox
  quota and the upstream platform, not a storage budget.
- **Saving the settings** rewrites the single `config` entry, and **a save that fails validation
  writes nothing at all** — not a single byte.
- **The two danger-zone buttons**: resetting the configuration (`/admin/api/config/reset`)
  rewrites that same single entry; purging the key pool (`/admin/api/keys/purge`) deletes every
  record and rewrites the index **once**.

Two read fan-outs are worth knowing about for the same reason:

- **The `30d` range of the panel's "Usage" board** reads `30 × 2` shards
  (`USAGE_DAY_RETAIN × USAGE_SLOTS`) in a single request. **This repository has never measured
  that fan-out on real hardware**, so the only thing promised here is that it **fails honestly**:
  when it fails part way, the whole `days` series comes back as `null` with `note` set to
  `read_failed` — it never passes off the shards it did read as the full picture.
- **A Playground video run costs at most `1 + 60` upstream requests per task** (1 create plus at
  most `VIDEO_POLL_MAX_ATTEMPTS` polls). That multiplies the **upstream** quota and the keys' use
  counts, not anything on your own disk.

### Admin panel variables (disabled by default)

| Variable | Required | Default | Notes |
|--------|--------|-------|-----|
| `ADMIN_TOKEN` | no | none (panel disabled) | Token for the admin endpoints. **Must differ from `GATEWAY_TOKEN`**, at least 24 characters, **no leading/trailing whitespace**, **printable ASCII (0x20–0x7E)** only. The reasoning for these rules, and what each kind of non-compliance costs you, are below. |
| `TRUST_PROXY` | no | unset (**no** forwarded header is trusted) | Set to `1` **only** if the gateway really sits behind a proxy (a CDN, or an nginx / Caddy / Traefik in front of the container). It decides where the client IP in login-failure events comes from; see below. |

**Not set ⇒ the panel is simply unavailable, and the gateway keeps forwarding.** Requests to
`/admin/...` then get **`404`, not `401`**: the tree is never registered, so nothing leaks the
fact that there is a panel here. This mirrors the registrar being disabled by default — a missing
or bad `ADMIN_TOKEN` must never stop the gateway from forwarding.

Both lines go into the same `.env` as everything else:

```env
# Optional: the admin panel token. Unset means the whole /admin tree is never registered.
# Must differ from GATEWAY_TOKEN, at least 24 characters, printable ASCII only.
ADMIN_TOKEN=replace-with-another-long-random-string

# Optional: set to 1 only when the container really sits behind a proxy that
# rewrites the client address. Leave it out on a directly exposed deployment.
TRUST_PROXY=1
```

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
   that range, while RFC 9110 already marks that range as deprecated.

Please use an ASCII-only token. **Interior spaces are allowed**: a passphrase like
`correct horse battery staple` is perfectly sendable and, under a 24-character minimum, is often
easier to get right than a random string. Leading/trailing whitespace is covered by the rule
above.

##### Why the 24-character minimum

**Why the 24-character minimum.** The gateway has **no login rate limiting of any kind** — not
per IP, not per token, not per instance. Building one would mean a counting window in storage,
which hands an unauthenticated caller a lever to make the gateway write on demand: the attack
widens from "guess the password" to "make it rewrite `store.json` in a loop". Token entropy is
therefore the only defense here, and the minimum is not a suggestion. Below it the panel is not
enabled and an `admin.token_rejected` line goes to the container log.

##### Why it must differ from `GATEWAY_TOKEN`

**Why it must differ from `GATEWAY_TOKEN`.** `GATEWAY_TOKEN` is the relay token you hand to
**every downstream user**. Reusing it as the panel token means anyone holding it can read your
entire key pool, switch the registrar off, and repoint the registration backend at their own
server — harvesting the mailbox, password and verification code of every account minted from then on.

##### How a conflict surfaces, and how to deal with it

This rule is **re-checked on every admin request, and deliberately not enforced at startup**. If
the two are equal — for example because `gatewayToken` was written into storage by hand by
editing `store.json` — the admin endpoints return **`503`**, and an
`admin.token_conflict` line is logged at error level (if the conflict is already present at boot,
the same line appears in the startup log so you see the reason immediately). **Gateway forwarding
is unaffected.**

**Once the conflict has happened, treat `ADMIN_TOKEN` as leaked — there is exactly one way to
recover: rotate it to a brand-new value.** Edit `.env` and run `docker compose up -d` so the
container is recreated with the new value. **Do not just change the stored
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
withheld there, every container started during the conflict would be **permanently `404`**,
unrecoverable by fixing the configuration and only curable by another restart, while a container
started before the conflict merely returns `503` and recovers as soon as you change the value
back. Same configuration, same instant, two different
answers — and the "no restart needed" sentence above would be half a lie. The two rules that
concern `ADMIN_TOKEN` alone (leading/trailing whitespace, unsendable characters, minimum
length) do not have this
problem: their only input is an environment variable that cannot change at runtime, so they are
still enforced at startup and their failure mode remains `404`.

##### How to rotate it, and what to do if it leaks

`ADMIN_TOKEN` is read **from environment variables only, never from storage**: the panel cannot
rotate its own key. To rotate it, edit `.env` and run `docker compose up -d` — `docker compose
restart` will not do, because a container's environment is frozen at creation time.

**Leaking the admin token means leaking `ADMIN_TOKEN` itself.** The panel stores it verbatim in
the browser's localStorage. There is no derived token and no in-product revocation path. The only
way to revoke it is to change the value in `.env` and recreate the container.
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
*while the request really goes through Cloudflare*. On a directly exposed container nothing
overwrites it, so a client can simply send `CF-Connecting-IP: 1.2.3.4` and be believed — and
direct exposure is the default shape of `docker compose up -d`.

**With it on, `CF-Connecting-IP` wins and `X-Forwarded-For` is only the fallback.** The two are
not equally forgeable:

- `CF-Connecting-IP` is written by the Cloudflare edge, which **overwrites** any same-named header
  the client sent — so it cannot be forged as long as the request really goes through Cloudflare.
- `X-Forwarded-For` is a chain any middlebox can append to, and a client can send a fake one, so
  how much of it you can believe depends entirely on what your proxy chain looks like.

##### How to configure it in each of the two topologies

**With Cloudflare in front of your origin, set `TRUST_PROXY=1`.** Cloudflare rewrites
`CF-Connecting-IP` on every request, which makes it the authoritative value; preferring
`X-Forwarded-For` in that shape would be wrong, because the chain may carry whatever the client
stuffed into it. Without the switch the field is simply recorded as `null`. **Only turn it on
once the origin can no longer be reached directly** — otherwise a client that bypasses the CDN
supplies the header itself.

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

### What the settings page can change

These fields live on three cards: **Credentials** and **Upstream & cooldowns** sit on the
**Settings** page, while **Registrar** (which holds the two fully equal mailbox-channel
sub-cards plus an *Advanced* disclosure) sits on the **Settings** tab of the **Registrar**
board. All three write to the `config` key **in storage**, never to environment variables.

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
> **The registrar family is in that lock table too** (`REGISTRAR_ENABLED`,
> `REGISTRAR_CHANNEL` (and its compatibility alias), `TARGET_KEYS`, `MINT_BATCH`, `TEND_INTERVAL_MS`,
> `CODE_TIMEOUT_MS`, `MINT_DELAY_MIN_MS`, `MINT_DELAY_MAX_MS`, `MAX_DOMAIN_ATTEMPTS`,
> `REGISTRAR_TOKEN_NAME`, `AGNES_PLATFORM_URL`, `YYDS_BASE_URL`, `YYDS_API_KEY`,
> `MOEMAIL_BASE_URL`, `MOEMAIL_API_KEY`). That was not always so: with `TARGET_KEYS=30` in
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
> **Credentials written from the panel are stored in plaintext** in `store.json`, at the same
> level as the "keys are stored in plaintext" caveat. Do not assume what you type here is an encrypted
> secret. Treat the data directory as credential material.

> [!WARNING]
> **If you clear the gateway token while `GATEWAY_TOKEN` is not in the environment either**, the
> current process keeps running, but **the next restart will fail to start**. The
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
back**, highlights the fields that actually changed, and states **how long other replicas may take
to see the change**: the config holder refreshes at most every **30** seconds, so that is the
upper bound. This instance is immediate (saving invalidates its local cache); another container
sharing the same volume is not. **Panel copy must never say "takes effect immediately".**

### Registrar variables (optional, disabled by default)

The registrar is an optional auto-refill component, disabled by default, and does not affect
the gateway's core forwarding behavior. This is a quick-reference table only — for how it works,
how to choose between the two mailbox channels, how long one round may take, and more,
see [REGISTRAR.md](REGISTRAR.md).

| Variable | Required | Default | Notes |
|--------|--------|-------|-----|
| `REGISTRAR_ENABLED` | no | `false` | Master switch; must be `true` to enable the registrar. |
| `REGISTRAR_CHANNEL` | required once enabled | none | Which channel the registrar uses, `yyds` or `moemail`; pick one of the two, no default. |
| `TARGET_KEYS` | no | `20` | Target number of usable keys. |
| `MINT_BATCH` | no | `5` | Maximum keys minted per round. |
| `TEND_INTERVAL_MS` | no | `1800000` | How often a refill round runs. The same timer also reconciles `pool:index`, so it keeps ticking even with the registrar off. |
| `CODE_TIMEOUT_MS` | no | `120000` | Timeout waiting for the verification code. |
| `MINT_DELAY_MIN_MS` / `MINT_DELAY_MAX_MS` | no | `60000` / `90000` | Random delay between mint attempts. The lower bound is measured; the upper is jitter headroom. |
| `MAX_DOMAIN_ATTEMPTS` | no | `1` | Maximum domains tried per mint attempt. Domain verdicts are remembered and reused, so one suffices; **raising it burns more rate-limit allowance**. |
| `REGISTRAR_TOKEN_NAME` | no | `auto` | Display name given to the minted key in the Agnes dashboard. |
| `AGNES_PLATFORM_URL` | no | `https://platform-backend.agnes-ai.com` | Agnes platform backend used for registration. |
| `YYDS_BASE_URL` / `YYDS_API_KEY` | no / required if a channel is yyds | `https://maliapi.215.im` / empty | YYDS Mail channel credentials. |
| `MOEMAIL_BASE_URL` / `MOEMAIL_API_KEY` | required if a channel is moemail | empty / empty | MoeMail channel credentials (self-hosted, no default address). |

> [!NOTE]
> **Two deprecated legacy names are deliberately not in the table above.**
> `REGISTRAR_PRIMARY` is a **compatibility alias** for `REGISTRAR_CHANNEL` (lower precedence; a
> notice appears at the top of the panel when it is in use, and the field is greyed out just the
> same). `REGISTRAR_FALLBACK` **no longer takes part in routing**; it is read once, only so the
> panel can name the channel that was dropped. Neither legacy name stops an upgrading deployment
> from running, but `.env.example` no longer declares them — new deployments use the new name.

#### What happens when one of these 15 variables has a wrong value

> [!WARNING]
> **A wrong value in these 15 variables no longer keeps the container from starting.**
> Numeric ones (`TARGET_KEYS=abc`, `MINT_BATCH=0`, and the like) **fall back to the default in the
> table above**, report a degradation in the panel and log one `config.invalid` event; channel and
> credential mistakes (a misspelled channel name, the registrar on with no channel selected, the
> selected channel missing its API key) only stop **the registrar** from starting this time, while
> the gateway keeps forwarding.
>
> **This is a capability loss, stated plainly**: a deployment typo used to crash the container, so you
> knew immediately; now it runs quietly and you have to go look at the panel banner or the events section.
> The walkthrough is the Troubleshooting entry "The registrar is on but mints nothing" below.

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

### Can a very long non-streaming request be severed mid-flight? (whatever sits in front decides)

**Bottom line: the gateway itself imposes no wall clock beyond `UPSTREAM_SYNC_TIMEOUT_MS`, so
the only thing that can cut a healthy long request short is something in front of it.**

The Node process running in the container has **no platform duration limit at all**: a
non-streaming request is bounded by the budget you configure and by nothing else. That is the
whole promise this document makes, and the admin panel makes no larger one either.

**What is in front of you is yours to check.** Spelled out:

- A reverse proxy has its own read timeout, and the defaults are short: nginx's
  `proxy_read_timeout` is 60 s, Caddy's is unlimited but its upstream may not be. Raise it on
  the same axis as `UPSTREAM_SYNC_TIMEOUT_MS` or the proxy will cut first.
- A CDN in front of the origin adds one more: Cloudflare's documented **Proxy Read Timeout is
  100 seconds (error 524)** for zone traffic, which no gateway setting can extend.
- A load balancer's idle timeout counts the same way, and its symptom is identical from the
  client's side: the connection simply ends, with no `error.reason` to look at.

⇒ **Two practical consequences:**
1. Set `UPSTREAM_SYNC_TIMEOUT_MS` (120000 by default) **below** the tightest timeout in the
   chain in front of you, or a request that the gateway would have completed gets severed by
   somebody else and the reason never reaches the log.
2. **If you need genuinely long requests, use a streaming endpoint.** The first-byte budget
   bounds only the first byte; whatever the generation costs afterwards is not counted, and a
   stream that keeps producing bytes does not look idle to anything in the chain.

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

### The index and how long changes take to show up

The gateway keeps a `pool:index` key listing the pool's ids so that forwarding never has to scan
the whole store. **Writing a record by hand does not touch that index**, so how soon the new key
gets used depends on the state of the pool at that moment:

- **When the pool is empty**: the index says the pool is empty and indeed not a single record can
  be read, so the gateway falls back to one scan that discovers the hand-imported record and
  back-fills it into the index. That scan has a built-in 10-minute backoff (see "The key pool and
  its index" above), so the visibility bound is **≤10 minutes + one `POOL_CACHE_TTL_MS`**.
- **When the pool is not empty**: the forwarding path only fetches records the index knows about,
  so a record the index has never heard of is **completely invisible** — with no error anywhere.
  It has to wait for the next reconciliation to repair the index (`TEND_INTERVAL_MS`, 30 minutes
  by default), then for up to one more `POOL_CACHE_TTL_MS`.

**To make a hand import take effect immediately, add the id to `pool:index` in the same edit:**

```json
{"v":1,"ids":["existing-id","1a2b3c4d5e6f7a8b"]}
```

Once the index is written, the pool picks the key up after at most one `POOL_CACHE_TTL_MS`.

**Reconciliation runs whether or not the registrar is enabled**, on the same `TEND_INTERVAL_MS`
timer: it is the only path that repairs `pool:index` against the actual `key:` records, so an
orphaned record or a ghost index entry is reclaimed within one interval. Set that interval to
something absurd and you extend that wait by exactly as much; during the wait the affected key
is simply unusable, not lost or corrupted.

### Revoking a key

**Delete the record, then remove its id from `pool:index` — do both steps.** Deleting only the
record is not an error (unreadable records are simply filtered out), but the id stays in the
index, costing one wasted read on every refresh until the next reconciliation prunes it.

Delete the `"key:<id>"` entry from `./data/store.json` and fix the `ids` array under
`"pool:index"`; stop the container first (`docker compose stop`) so the running process cannot
overwrite your edit:

```json
{"v":1,"ids":["remaining-id"]}
```

A process that already loaded an older snapshot stops selecting the key after at most one
`POOL_CACHE_TTL_MS`.

**It will not be written back during that window either**: before persisting any state change the
gateway first confirms the record still exists, and drops the write — refreshing its own snapshot
immediately — when it does not. File storage serves that confirming read from the file itself,
with no cache in between, so this guarantee is exact.

## Verification

Three commands, cheapest first. Replace `$BASE` with your own address (`http://localhost:8080`
unless you changed `PORT` or put a domain in front) and `$TOKEN` with the `GATEWAY_TOKEN` you
set.

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

Seven of them, ordered by when you are likely to hit them. Each is "symptom → fix", and the
numbered steps are meant to be worked through in order.

### The gateway will not start and the log has one line about a missing token

**Symptom**: the container **exits right after startup**, `docker compose ps` shows it restarting
or exited, and the log contains nothing but `缺少 GATEWAY_TOKEN，网关无法启动`. **There is no
half-working state here**: the gateway refuses to assemble rather than answering `503` to every
request, so the failure is visible in `docker compose ps` without anyone calling an endpoint.

**Fix**:

1. Check that `.env` has a `GATEWAY_TOKEN=` line and that **there is something after the equals sign**.
2. Run `docker compose up -d` afterwards, **not `docker compose restart`** — a container's
   environment is frozen at creation time, so a restart re-reads nothing.

> [!WARNING]
> **Do not reach for `RESET_CONFIG=1` here.** It means "**ignore the stored `config` key entirely**" — and if
> your gateway token lives exactly there (the one you saved in the panel), ignoring it removes the only token
> you have. Only the two steps above fix this failure.

### Every request answers 503 because the pool is empty

**Symptom**: Every forwarding endpoint answers `503` with `error.reason` set to `pool_empty`.

**Fix**:

1. Import at least one key from the key-pool page of the admin panel, or call `POST /admin/api/keys` (see [API.md](API.md)); with no `ADMIN_TOKEN` set, follow the "Multi-Account Configuration" section and write into the storage backend directly.
2. Already imported and still empty: a hand-written record **does not touch `pool:index`**, so either wait for one reconciliation (`TEND_INTERVAL_MS`, 30 minutes by default) or add the id to the index by hand.
3. The registrar is on but the pool never grows: check the panel's events board, or follow [REGISTRAR.md](REGISTRAR.md) to debug the two mailbox channels.

### The registrar is on but mints nothing (the panel says enabled, the pool never grows)

**Symptom**: the registrar toggle is on, yet no tending round runs. Keys only leave the pool, and it
eventually surfaces as the previous entry — several layers away from the real cause by then.

This is a **quiet feature outage**: the registrar is optional, so when its configuration cannot be loaded,
**the gateway keeps forwarding** and only the refilling stops. Nothing crashes, so you have to go and look.

**Where to look** (four places, all saying the same thing):

1. A banner at the top of the **Settings** page, listing the missing fields.
2. The **Registrar** section reads "Enabled · not started this time" instead of "Enabled".
3. The **Overview** config summary says the same on the registrar row.
4. An `error`-level `registrar.blocked` in the events section, every round.

**Fix**: fill in the fields listed in the banner on the Settings page — most often the selected mailbox
channel is missing its API key, or no channel has been selected at all.
**Saving is enough to recover; no container restart and no redeploy.**

### The panel will not open and `/admin` answers 404

**Symptom**: Opening `/admin` in a browser gives a `404` — not a login page, and not a `401` either.

**Fix**:

1. That is exactly what **no `ADMIN_TOKEN`** looks like: the whole tree is never registered, so nothing leaks the fact that there is a panel here.
2. Set and still 404 — **first confirm the container was really recreated**: under Docker, editing `.env` has to be followed by `docker compose up -d`; `docker compose restart` does not re-read it. Skip this step and item 3 below will send you down the wrong path.
3. Recreated and still 404: the token is non-compliant (under 24 characters / leading or trailing whitespace / non-printable ASCII), and the container log has an `admin.token_rejected` line.
4. The panel opens but its endpoints answer `503`: `ADMIN_TOKEN` collides with the stored `gatewayToken`; the log says `admin.token_conflict`, and the section above tells you how to handle it.

### A setting saved in the panel takes ages to reach the other replicas

**Symptom**: You saved a setting in the panel, this instance changed immediately, and another container sharing the same volume still serves the old value.

**Fix**:

1. That is **normal**: the config holder refreshes at most every **30** seconds, so that is the ceiling. Wait and look again.
2. Still unchanged after two minutes: check that the field is not locked by an environment variable — locked fields are greyed out in the panel and the endpoint answers `400 locked_by_env`.
3. You changed `POOL_CACHE_TTL_MS` or `POOL_TOUCH_INTERVAL_MS`: those two are **read once when the instance is built**, so only recreating the container will do it.

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
4. **Ownership checks out three times over and it is still degraded**: most likely `store.json` cannot be parsed. The first three items are permissions; this one is not — when the storage layer cannot read valid JSON every read and write throws, so the startup probe records "writable" as false and `/health` answers the same `503` degraded. Stop the container and run `python3 -m json.tool
   ./data/store.json`: the hand-editing taught above is the most common way to break it (one comma too many is enough). Restore from a backup; the real reason is on the first line of the container log.

## Performance Tips

First, get one thing straight: **the gateway itself costs almost no time**. The cost sits in two
places — upstream response time, and how often the process rewrites `store.json`. So only three
knobs in this section are worth touching.

```env
# Optional: how long each process keeps its key-pool snapshot, in ms; 0 disables the cache.
# Raising it saves file reads; the cost is that state written by another container shows up later.
POOL_CACHE_TTL_MS=120000

# Optional: how often "last used" is persisted, in ms; 0 persists on every successful request.
# It is a display-only field — lowering it only multiplies file writes and buys no scheduling gain.
POOL_TOUCH_INTERVAL_MS=21600000

# Optional: total timeout budget for synchronous endpoints (images, video jobs, all non-streaming
# chat), in ms. Set it above twice the worst-case single call, or healthy requests get killed.
UPSTREAM_SYNC_TIMEOUT_MS=180000
```

Three rules of thumb, most valuable first:

1. **Leave `POOL_CACHE_TTL_MS` alone unless several containers share one volume.** With a single
   container the snapshot is authoritative, so raising it buys nothing and only delays how fast a
   hand edit to `store.json` is noticed. Raise it when you actually run replicas and see the same
   key being judged twice.
2. **Do not lower `POOL_TOUCH_INTERVAL_MS` just to make the panel's "last used" more precise.**
   That is a display-only field, `0` means "rewrite the whole store on every successful request",
   and nothing schedules on the value you would be buying.
3. **Move long requests to the streaming endpoints.** The first-byte budget only bounds the first
   byte; however long generation takes afterwards is not counted. The non-streaming budget has to
   cover the upstream computing the whole answer, and a proxy in front of you may cut it before
   your budget does.

## Monitoring and Maintenance

### The health endpoint

`/health` is the only endpoint that needs no token:

```bash
curl -s "$BASE/health"
```

`status` of `ok` means storage is readable and writable; `degraded` means something is wrong there
— usually a data directory that cannot be written. The image's built-in `HEALTHCHECK` calls
exactly this, and healthy/unhealthy in `docker compose ps` comes from it.

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
# true; 1 or yes count as off. Once on, each instance rewrites one shard per flush interval;
# the tail is at most 2 hours, and a process that stops inside that window takes those counts with it — loss, not late posting.
USAGE_STATS_ENABLED=true
```

**Read the two alerts above before switching it on.** The counts you lose are the ones the
process was still holding when it stopped, and recreating the container to change one variable
is enough to trigger that. `USAGE_FLUSH_INTERVAL_MS` shortens that window as far as you like on
this deployment form — that trade is yours to make, not a limit imposed from outside.

## Upgrading the Service

The two upgrade commands live in the "Update" part of [Docker Deployment](#docker-deployment).
This section is about everything around them.

### Before you upgrade

1. **Back the storage up first.** There is exactly one copy of the key pool and the config; see
   "Backup and Restore" below.
2. **Write down the baseline: the current `version` and the size of the key pool.** The former is
   the field `curl -s "$BASE/health"` returns, the latter is on the panel's overview page. Without
   a baseline the three checks below cannot tell "upgraded" from "never upgraded at all".
3. **Glance at the CHANGELOG.** Breaking changes are recorded there; the version badge in all six
   READMEs points at it.
4. **An upgrade never requires wiping storage.** Stored records are backward compatible, and the
   `v` field of `pool:index` is always `1` today.

### What to check afterwards

1. `/health` answers `200` with `status` `ok`, **and `version` equals the version you just
   upgraded to**. Only that last clause tells "upgraded" from "never upgraded": `version` is a
   compile-time constant baked into the image, while the other two pass word for word on the old
   one. If the image was never published (a build cancelled after the release was cut — this repo
   has lived through it), `docker compose pull` is a silently successful no-op.
2. The panel (if you run one) still logs in, the key pool has the same number of entries as
   before, and the overview page's runtime tile shows the same version.
3. Run the third command from "Verification" above to confirm requests reach upstream.

Rolling back: on Docker, set `IMAGE_TAG` in `.env` back to the previous version and run
`docker compose up -d` (image name and tag list: "Update" under Docker Deployment above).
**Confirm that tag exists in the registry first**: if it cannot be pulled compose does not fail,
it builds one from your **current working tree**, so the rollback "succeeds" and the fault stays.

## Backup and Restore

There is one copy of the key pool and the config, and no second one.
**Backing up means backing up the storage itself.**

### Taking one

```bash
docker compose stop
cp -a ./data ./data.bak
docker compose start
```

Stopping first avoids a write race. Restoring is copying the directory back and running
`docker compose up -d`.

### What is inside, and why a hand-picked copy is a trap

`./data/store.json` holds everything — not just the key records and `pool:index`, but also
`apikeys` (the table of issued outbound API keys), `config` (the configuration saved from the
panel), `registrar:domains` and `registrar:backoff` (the registrar's domain-availability and
backoff ledgers), `tend:history` (the refill history) and the event ring.

> [!CAUTION]
> **Copying only the `key:<id>` entries and `pool:index` out of that file misses four families,
> and missing them is invisible at restore time.** Restore a hand-picked file like that and the
> upstream key pool is back, `/health` answers `ok`, your own smoke test with `GATEWAY_TOKEN`
> passes — while every sub-key in your downstream users' hands answers `401`. The four families:
> `apikeys` (not restoring it revokes every sub-key at once, and the plaintext was shown exactly
> once at issue time, so it cannot be recovered — every key has to be reissued),
> `config` (including the gateway token and both mailbox channels' credentials),
> `registrar:domains` and `registrar:backoff` (lose them and the registrar
> turns into "enabled - did not start this time"), and `tend:history` (the refill history).
> **`cp -a ./data` above has none of this problem** — that is the reason it is the recipe.

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
- **Treat the data directory and every backup as credentials.** Keys and the credentials
  written through the panel are all stored in plain text, at the same level as the keys
  themselves.
### Outbound API keys are the opposite of the upstream key pool

- **The plaintext of an outbound API key appears exactly once.** It is in the response to the
  request that issued it and nowhere else — the gateway stores only its SHA-256 digest. If you
  lose it, it cannot be recovered; delete the key and issue a new one. **This is the opposite
  of the upstream key pool** (those must be stored in the clear, because they get used).
- **Hand each downstream consumer its own sub-key instead of sharing `GATEWAY_TOKEN`.** A
  sub-key can be disabled, given an expiry and revoked individually; once the master token has
  been shared, the only way to revoke it is to rotate it and break every consumer at once.

A minimal security baseline:

```env
# Required: the token clients must present to call this gateway. This is what you hand downstream.
GATEWAY_TOKEN=replace-with-your-own-long-random-string

# Optional: the admin panel token. Unset means the whole /admin tree is never registered, so
# visiting it gives 404 rather than 401. Must differ from GATEWAY_TOKEN, at least 24 characters,
# printable ASCII only.
ADMIN_TOKEN=replace-with-another-long-random-string

# Optional: set to 1 only when the container really sits behind a proxy or a CDN that
# rewrites the client address. Leave it out on a directly exposed deployment.
TRUST_PROXY=1
```

## Next Steps

- Usage and SDK wiring for all four protocols: [USAGE.md](USAGE.md)
- The web admin panel: [ADMIN.md](ADMIN.md)
- The registrar (automatic pool refill): [REGISTRAR.md](REGISTRAR.md)
- Endpoints and request / response shapes for all four protocols: [API.md](API.md)
- What this project is, and how to get started: [README.md](../../README.md)
- Bug reports and questions: [GitHub Issues](https://github.com/xwteam/agnes2api/issues)
