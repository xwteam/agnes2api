<div align="center">

<img src="../logo.png" width="128" height="128" alt="agnes2api">

<h1>agnes2api</h1>
<h3>Multi-protocol AI relay · Agnes backend</h3>
<p>One codebase that speaks all four mainstream AI SDK dialects — OpenAI / Anthropic / OpenAI-Responses / Gemini — backed by Agnes AI for chat plus image and video generation, with the Cloudflare Worker and Node runtimes sharing a single forwarding core and a one-command Docker deployment.</p>

<p>
  <img src="https://img.shields.io/badge/TypeScript-7.0-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Hono-4.13-E36002?style=flat-square&logo=hono&logoColor=white" alt="Hono">
  <img src="https://img.shields.io/badge/Cloudflare%20Workers-edge-F38020?style=flat-square&logo=cloudflareworkers&logoColor=white" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/Docker-20.10+-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/arch-amd64%20%7C%20arm64-4285F4?style=flat-square&logo=linux&logoColor=white" alt="Arch">
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/version-v0.1.0-success?style=flat-square" alt="Version">
</p>

<p>
  <a href="#-recent-updates">Recent Updates</a> &bull;
  <a href="#-core-features">Core Features</a> &bull;
  <a href="#-system-requirements">System Requirements</a> &bull;
  <a href="#-quick-deployment">Quick Deployment</a> &bull;
  <a href="#-integration-examples">Integration Examples</a> &bull;
  <a href="#-api-endpoints">API Endpoints</a> &bull;
  <a href="#-configuration">Configuration</a> &bull;
  <a href="#-important-notes">Important Notes</a> &bull;
  <a href="#-roadmap">Roadmap</a>
</p>

<p>
  📖 Documentation: <a href="../zh-CN/README.md">简体中文</a> | <a href="../zh-TW/README.md">繁體中文</a> | English | <a href="../ja/README.md">日本語</a> | <a href="../ko/README.md">한국어</a>
</p>

<br>

<a href="https://github.com/xwteam/agnes2api/issues"><img src="https://img.shields.io/github/issues/xwteam/agnes2api?style=flat-square" alt="Issues"></a>
<a href="https://github.com/xwteam/agnes2api/stargazers"><img src="https://img.shields.io/github/stars/xwteam/agnes2api?style=flat-square" alt="Stars"></a>

</div>

---

> [!NOTE]
> This project is for research and learning purposes only. Please use it responsibly; it is not recommended for any commercial use.

> [!WARNING]
> This project is neither affiliated with nor endorsed by Agnes AI. It wraps the Agnes AI service into a multi-protocol compatible API, and that usage may not comply with the upstream terms of service; acquiring free quota in bulk is in tension with those terms as well. Use it at your own risk — the author is not responsible for any account penalty or data loss.

> [!TIP]
> The upstream is served by a pool of Agnes API keys: chat runs on `agnes-2.0-flash`, images on `agnes-image-2.1-flash` and `agnes-image-2.0-flash`, video on `agnes-video-v2.0` (create a task, then poll it). The key pool heals itself — an upstream `429`/`402` puts that key into cooldown, `401`/`403` evicts it permanently, and repeated transient failures accumulate up to `MAX_STRIKES` and then put it into a long cooldown (`COOLDOWN_STRIKE_MS`, 30 minutes by default) rather than evicting it. The cases that recover on expiry need no manual intervention.

> [!IMPORTANT]
> **This gateway is fail-closed: there is no mode in which it serves traffic while no token is configured.** `GATEWAY_TOKEN` is mandatory, and when it is missing the gateway **refuses to start** (`src/core/config.ts` throws `缺少 GATEWAY_TOKEN，网关无法启动`); note that this startup path **only checks presence, never length**, so a short token still brings the gateway up and how strong it is remains your call. The admin panel does not exist by default: with no `ADMIN_TOKEN` set, the whole `/admin` tree is never registered at all and requests get a 404; set one shorter than 24 characters (`ADMIN_TOKEN_MIN_LENGTH`) and it stays disabled too, with a log line saying the panel is not enabled while gateway forwarding is unaffected; set one that is long enough but **identical** to `GATEWAY_TOKEN` and the admin API keeps returning 503 (forwarding still works). `ADMIN_TOKEN` is read from the environment only, never from storage, so the panel cannot rotate its own key.

---

## 📝 Recent Updates

| Date | What changed |
|------|--------------|
| 2026-08-31 | v0.1.0 - 🎉 **First release**: the four-protocol gateway, the registrar, and the admin panel all land at once, and one codebase runs on both the Cloudflare Worker and the Node / Docker runtime. The four inbound protocols share one upstream scheduler, one key pool, and one failure-attribution path; the registrar's two temporary-mailbox channels are strictly equal peers; the panel has eight sections and needs no build step; documentation ships as one copy per language, five in total |

> The full changelog lives in [CHANGELOG.md](../../CHANGELOG.md).

---

## 🌟 Core Features

> 📖 Detailed usage guide: [USAGE.md](USAGE.md)

### 🔌 Four protocol front ends, one upstream

- A single service speaks **OpenAI Chat**, **Anthropic Messages**, **OpenAI Responses** and **Gemini native** at the same time; each protocol's official SDK connects by changing nothing but the base URL
- The four inbound protocols share one upstream scheduler, one key pool and one failure-attribution path, and streaming (SSE) works on all four
- Beyond chat it also forwards **image generation** (`/v1/images/generations`) and **video generation** (create a task at `/v1/videos`, then poll `/v1/videos/{id}`)
- There is exactly one set of paths, the **bare prefixes**: OpenAI and Anthropic live under `/v1`, Gemini lives under `/v1beta`

### 🔐 Unified auth gate

- Four credential channels are accepted on equal footing: `Authorization: Bearer`, `x-api-key`, `x-goog-api-key` and the `?key=` query parameter — exactly the one each protocol's official SDK sends by default
- The gateway token `GATEWAY_TOKEN` is **mandatory** and the process will not start without it; the admin token `ADMIN_TOKEN` is a **second, different key**, and making the two identical disables the admin API
- The `/health` liveness endpoint is unauthenticated; everything else goes through the auth gate

### 🔄 Self-healing key pool with automatic refill

> 📖 Detailed registrar guide: [REGISTRAR.md](REGISTRAR.md)

- An upstream `429`/`402` puts that key into tiered cooldown, `401`/`403` evicts it permanently, and consecutive transient failures put it into a long cooldown (30 minutes by default, recovered automatically) once they reach `MAX_STRIKES`
- When not a single key is usable it honestly answers `503` with a distinguishable `reason` (nothing imported yet / all cooling / all disabled / all evicted / upstream keeps failing), and the cooling case carries `Retry-After`
- **Automatic refill is off by default**: turn on `REGISTRAR_ENABLED` and the gateway registers Agnes accounts to top the pool back up whenever usable keys fall below `TARGET_KEYS`
- The registrar's two temporary-mailbox channels (`yyds` / `moemail`) are **strictly equal peers**; which one is primary is your call, and no default preference is baked in

### 🔀 Two runtimes, one forwarding core

- The same TypeScript code runs on **Cloudflare Worker** (key pool in KV) and on **Node / Docker** (key pool in a single JSON file), and the request-handling logic is identical to the letter
- Storage access is decoupled from traffic: the key pool is cached per isolate/process and updates that touch only telemetry fields are dropped outright, so in steady state neither storage reads nor writes grow with request volume
- On the Worker the refill schedule runs on a Cron trigger and on Node it runs on an in-process timer, with the same refill semantics on both sides

### 🖥 Web admin panel

> 📖 Detailed panel guide: [ADMIN.md](ADMIN.md)

- **Off by default**: with no `ADMIN_TOKEN` set the whole `/admin` tree is never registered and requests get a 404, rather than an unauthenticated panel
- Eight sections: overview, key pool, registrar, events, usage, models, playground, settings
- **No build step**: `admin-ui/` served as-is under `/admin/` already is the debuggable panel, and the build script only burns it byte for byte into one generated artifact
- The token travels in the `x-admin-key` request header only — never in a cookie, never in the query string

### ⚡ High-performance architecture

- Built on **TypeScript + Hono**, with the Worker entry and the Node entry sharing one routing tree
- Upstream responses are forwarded as streams by default; a non-streaming request goes upstream with `stream:false` as-is, and the gateway parses that upstream JSON and translates it into the shape of the protocol you called
- Ports are separated from adapters (storage, fetch, logging and mailbox are all replaceable ports), and the contract tests run once on each runtime
- Multi-stage Docker build, non-root runtime, multi-architecture images (amd64 / arm64), health check

---

## 📋 System Requirements

| Dependency | Version | Notes |
|----------|-------|------|
| Node.js | 22.13+ | Only needed to build from source or to run under Node directly; a Docker deployment needs no local install |
| Docker | 20.10+ | The recommended way to deploy; the official image is multi-architecture |
| Agnes account | — | At least one valid Agnes API key (or let the registrar refill the pool for you) |
| Cloudflare account | wrangler 4+ | Only for the Cloudflare Worker form: one KV namespace plus one deploy |

> [!TIP]
> Deploying with Docker needs no local Node.js install — Docker plus a valid Agnes API key is enough. Deploying to a Cloudflare Worker needs no server at all, only a Cloudflare account and the wrangler command line.

---

## ⚡ Quick Deployment

> 📖 Full deployment guide: [DEPLOY.md](DEPLOY.md)

> **Prerequisites**: at least one valid Agnes API key, plus either a Cloudflare account (Worker form) or a machine that can run Docker.

### 1. Get an upstream key

Create an API key on the Agnes AI platform and keep it handy. If you would rather not prepare one by hand, bring the gateway up first and then turn on the registrar so it refills the pool for you — both routes are written out in full in the deployment guide.

### 2. Deploy

#### Cloudflare Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xwteam/agnes2api)

The one-click flow saves you the local clone, but there are two things it cannot do for you: the KV namespace id in `wrangler.toml` (the one in the repository is always a placeholder) and the `GATEWAY_TOKEN` secret — miss either and the gateway will not start. To walk every step yourself, or to fill those two in after deploying, use the commands below:

```bash
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api
pnpm install

# Create a KV namespace and put the returned id into wrangler.toml
npx wrangler kv namespace create POOL

# The gateway token is a mandatory secret; inject it, never commit it
npx wrangler secret put GATEWAY_TOKEN

npx wrangler deploy
```

#### Docker

```bash
# Clone the project
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api

# Create the environment file
cp .env.example .env
```

Edit `.env` and fill in at least a gateway token:

```env
GATEWAY_TOKEN=your-gateway-token
# Admin panel token; leave it empty and the whole /admin tree is never registered.
# Set it and it must differ from GATEWAY_TOKEN and be at least 24 characters long.
ADMIN_TOKEN=
```

Start the service:

```bash
mkdir -p data
docker compose up -d
```

Check the logs to confirm it came up:

```bash
docker compose logs -f
# Seeing the listening port means it started successfully
```

> **Before the first published image exists** (or in a fork), `docker compose up -d`
> falls back to building the image locally — that is what the `build:` block in
> `docker-compose.yml` is for.

### 3. Verify

```bash
# Health check (unauthenticated). On the Worker use your https://<name>.<sub>.workers.dev
curl http://localhost:8080/health
# {"status":"ok","version":"0.1.0"}

# List the available models
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer your-gateway-token"

# Send a test request
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-2.0-flash","messages":[{"role":"user","content":"hello"}]}'
```

Text coming back from the AI means the deployment succeeded. A 401 means the API key is wrong.

---

## 🧪 Integration Examples

> [!NOTE]
> Every request carries the gateway token. The auth gate treats the following four credential channels identically — no SDK needs any extra configuration:
> - `Authorization: Bearer <token>` (what the OpenAI SDK sends by default)
> - `x-api-key: <token>` (what the Anthropic SDK sends by default)
> - `x-goog-api-key: <token>` (what the Google GenAI SDK sends by default)
> - the `?key=<token>` query parameter (manual calls and browser scenarios)
>
> Replace `http://localhost:8080` below with wherever you actually deployed (the Worker's `*.workers.dev` domain, a custom domain, or the local address of a Docker deployment), and replace `your-gateway-token` with your real gateway token.

<details>
<summary><b>OpenAI SDK (Python)</b></summary>

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="your-gateway-token",
)

resp = client.chat.completions.create(
    model="agnes-2.0-flash",
    messages=[{"role": "user", "content": "hello"}],
)
print(resp.choices[0].message.content)
```

Streaming works exactly as it does against OpenAI itself — pass `stream=True` and iterate the generator you get back.

</details>

<details>
<summary><b>Anthropic SDK (Python)</b></summary>

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:8080",
    api_key="your-gateway-token",
)

msg = client.messages.create(
    model="agnes-2.0-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "hello"}],
)
print(msg.content[0].text)
```

Note that the SDK's `base_url` carries **no** `/v1` — the SDK appends `/v1/messages` itself.

</details>

<details>
<summary><b>Gemini SDK (Python)</b></summary>

```python
from google import genai

client = genai.Client(
    api_key="your-gateway-token",
    http_options={"base_url": "http://localhost:8080"},
)

resp = client.models.generate_content(
    model="agnes-2.0-flash",
    contents="hello",
)
print(resp.text)
```

Here too the SDK's `base_url` carries **no** `/v1beta` — the SDK appends `/v1beta/models/...` itself.

</details>

<details>
<summary><b>OpenAI-Responses (cURL)</b></summary>

```bash
curl -X POST http://localhost:8080/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-2.0-flash","input":"hello"}'
```

This protocol has no widely adopted dedicated SDK yet, so a plain HTTP call is the clearest demonstration. The full response shape and the streaming event sequence are in the API reference for each language.

</details>

<details>
<summary><b>Image generation</b></summary>

```bash
curl -X POST http://localhost:8080/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-image-2.1-flash","prompt":"a cat"}'
```

Synchronous forwarding: request and response bodies pass through from upstream untouched, and the gateway does not rewrite the shape. It runs on the synchronous timeout budget, not the streaming time-to-first-byte one.

</details>

<details>
<summary><b>Video generation (two steps)</b></summary>

```bash
# 1. Create the task; returns immediately
curl -X POST http://localhost:8080/v1/videos \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-gateway-token" \
  -d '{"model":"agnes-video-v2.0","prompt":"a cat running"}'

# 2. Poll with the id from the previous step
curl http://localhost:8080/v1/videos/task-1 \
  -H "Authorization: Bearer your-gateway-token"
```

The task runs asynchronously upstream; the gateway only forwards and polls, and both responses pass through untouched.

</details>

---

## 📡 API Endpoints

> 📖 Full API reference: [API.md](API.md)

### OpenAI compatible (`/v1`)

| Method | Endpoint | Purpose |
|------|--------|-------|
| GET | `/v1/models` | Model list |
| POST | `/v1/chat/completions` | Chat completions (streaming supported) |

### OpenAI Responses (`/v1`)

| Method | Endpoint | Purpose |
|------|--------|-------|
| POST | `/v1/responses` | Responses API (streaming supported) |

### Anthropic compatible (`/v1`)

| Method | Endpoint | Purpose |
|------|--------|-------|
| POST | `/v1/messages` | Messages (streaming supported) |

### Gemini native (`/v1beta`)

| Method | Endpoint | Purpose |
|------|--------|-------|
| GET | `/v1beta/models` | Model list |
| POST | `/v1beta/models/{model}:generateContent` | Content generation (non-streaming) |
| POST | `/v1beta/models/{model}:streamGenerateContent` | Streaming generation |

### Images and video

| Method | Endpoint | Purpose |
|------|--------|-------|
| POST | `/v1/images/generations` | Image generation (synchronous forwarding) |
| POST | `/v1/videos` | Create a video task |
| GET | `/v1/videos/{id}` | Poll a video task |

### Admin API

| Method | Endpoint | Purpose |
|------|--------|-------|
| GET | `/admin` | The admin panel itself (**with no `ADMIN_TOKEN` set the whole tree is never registered and requests get a 404**) |
| GET · POST · PUT · DELETE | `/admin/api/*` | Admin API: key pool / registrar / events / usage / models / configuration (via `x-admin-key`) |

### System

| Method | Endpoint | Purpose |
|------|--------|-------|
| GET | `/health` | Liveness (unauthenticated; returns the version and storage health) |

> The `localhost:8080` in these URLs is only an example: on Node the port comes from `PORT`, on the Worker it is your own `*.workers.dev` or custom domain — substitute whatever you deployed.
>
> The auth gate accepts four credential channels: `Authorization: Bearer`, `x-api-key`, `x-goog-api-key` and the `?key=` query parameter. Each vendor's native header and parameter are **accepted just the same**, so official SDKs connect by changing nothing but the base URL; what you do change is the **value** — whatever travels in any channel must be *this gateway's* token, not a real vendor key.

---

## ⚙ Configuration

Precedence: **environment variable > configuration in storage > built-in default**. The table below lists only the ones people reach for most often; the full set of variables, their ranges, and how each default is derived are in `.env.example` and in the deployment guide for each language.

| Variable | Required | Default | Description |
|--------|--------|--------|-----------|
| `GATEWAY_TOKEN` | ✅ | — | Gateway token; clients use it to call this gateway, and the gateway refuses to start without it |
| `ADMIN_TOKEN` | ❌ | — | Admin panel token; unset means the whole `/admin` tree is never registered, and if set it must differ from the gateway token and be at least 24 characters |
| `AGNES_BASE_URL` | ❌ | `https://apihub.agnes-ai.com/v1` | Agnes upstream base URL |
| `PORT` | ❌ | `8080` | Listening port on Node (unused on the Worker) |
| `DATA_DIR` | ❌ | `/app/data` | Directory the file storage writes to (unused on the Worker) |
| `UPSTREAM_TIMEOUT_MS` | ❌ | `8000` | Upstream time-to-first-byte budget for streaming responses and video polling (milliseconds) |
| `UPSTREAM_SYNC_TIMEOUT_MS` | ❌ | `120000` | Overall timeout budget for synchronous endpoints (milliseconds) |
| `MAX_STRIKES` | ❌ | `3` | Transient-failure ceiling; reaching it sends the key into a long cooldown |
| `POOL_CACHE_TTL_MS` | ❌ | `60000` | How long a key-pool snapshot lives inside one isolate/process (milliseconds) |
| `REGISTRAR_ENABLED` | ❌ | `false` | Registrar master switch; once on, usable keys below the target trigger an automatic refill |
| `TRUST_PROXY` | ❌ | — | Set it to 1 to trust forwarding headers; you should when running behind Cloudflare |
| `USAGE_STATS_ENABLED` | ❌ | `false` | Time series for the panel's usage section; off by default, and costs nothing while off |

**Cloudflare Worker settings do not go through `.env`**: non-sensitive entries live in the `[vars]` block of `wrangler.toml`, sensitive values are injected as secrets, and the KV namespace and the refill Cron are declared in that same file.

```bash
npx wrangler secret put GATEWAY_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

---

## ⚠ Important Notes

1. **A public deployment must set `GATEWAY_TOKEN`, and must also set `ADMIN_TOKEN` if you want the panel**: without the former the gateway **will not come up at all**, so there is no such thing as running it unconfigured; without the latter the whole `/admin` tree is **never registered** (404), and if you do set it, it must differ from the gateway token and be no shorter than 24 characters, otherwise the panel stays disabled (gateway forwarding is unaffected).

2. **Streaming**: all four protocols support streaming; with `stream:false` the gateway also asks upstream with `stream:false`, then translates that upstream JSON into the shape of the protocol you called and returns it in one piece (upstream answering `200` with a non-JSON body gives you a `502`). Upstream errors are passed through verbatim, except for `401`/`403` bodies, which may echo a key fragment; **when the upstream stream breaks midway the gateway inserts no error event** — the client sees a stream that ends looking perfectly normal, so rely on the upstream's own `finish_reason` to tell truncation apart.

3. **Key pool self-healing**: an upstream `429`/`402` cools the key down, and consecutive transient failures put it into a long cooldown (`COOLDOWN_STRIKE_MS`, 30 minutes by default) once they hit `MAX_STRIKES`, recovered automatically on expiry; **permanent eviction only happens on an upstream `401`/`403`**. When no usable key is left it returns `503` with a distinguishable reason; the synchronous path returns `504` for the case where the whole budget was spent and no key ever answered.

4. **Cloudflare's free KV quota**: the daily read count depends only on the refresh interval and the number of active isolates, not on request volume — but the defaults already sit close to the line at the recommended settings. Work through the "quota budget" in the deployment guide before going live, and raise `POOL_CACHE_TTL_MS` if you need to.

5. **Network access**: the deployment side needs to reach the Agnes upstream (`AGNES_BASE_URL`). With the registrar enabled it also needs to reach the temporary mailbox service you chose and the Agnes platform backend.

---

## 🗺 Roadmap

- [x] Four protocol front ends (OpenAI / Anthropic / OpenAI-Responses / Gemini)
- [x] One forwarding core plus an auth gate covering four credential channels
- [x] Streaming (SSE) and non-streaming behave alike across all four protocols
- [x] Image generation forwarding and two-step video generation forwarding
- [x] Key pool: checkout, tiered cooldown, permanent eviction, distinguishable exhaustion reasons
- [x] Two runtimes: Cloudflare Worker (KV) and Node / Docker (file storage) from one codebase
- [x] Registrar: two temporary-mailbox channels as equal peers, fully automatic from code retrieval to pool insertion
- [x] Eight-section web admin panel (no build step, off by default)
- [x] Admin API authentication: fail-closed, token in the request header only
- [x] Documentation in five languages and a panel in five languages
- [x] Thirteen CI gates plus contract tests on both runtimes
- [ ] Check the protocol catalogue against real upstream samples (every entry in today's upstream fact table is marked assumed)
- [ ] Publish the first public container image

---

## ☕ Support & Contribute

> The full version is in [SPONSORS.md](SPONSORS.md)

Found it useful? A Star on the project is the most direct support an open-source maintainer can get.

agnes2api is maintained mostly by one person, and contributions of code, documentation, fixes or PRs are all welcome.

**Contributing:**

1. Fork this project
2. Create a branch `git checkout -b feature/your-feature`
3. Commit your work `git commit -m "feat: add something"`
4. Push and open a Pull Request

Please read [CONTRIBUTING.md](../../CONTRIBUTING.md) before sending code. For a security issue, report it privately as described in [SECURITY.md](../../SECURITY.md) rather than opening a public issue.

---

## 🙏 Acknowledgments

Thanks to everyone willing to spend time trying this out. Bug reproductions, logs, compatibility reports and feature ideas are all welcome in [Issues](https://github.com/xwteam/agnes2api/issues) — this is the first release, and the key pool, the registrar, the dual runtime, the multi-protocol compatibility and the web panel are all still waiting for real-world scenarios to sharpen them.

---

## 📄 License

This project is released under the [MIT License](../../LICENSE):

- **Grants**: the right to use, copy, modify, merge, publish, distribute, sublicense and sell this software
- **Requires**: keeping the copyright notice and the license notice

This project is not affiliated with Agnes AI. It comes with no warranty and no support commitment, so use it at your own risk and comply with the applicable terms of service.

---

<div align="center">
  <sub>Built with TypeScript + Hono + Cloudflare Workers | Powered by Agnes AI</sub>
</div>
