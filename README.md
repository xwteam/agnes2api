# agnes2api

[![CI](https://github.com/xwteam/agnes2api/actions/workflows/ci.yml/badge.svg)](https://github.com/xwteam/agnes2api/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/version-v0.1.0-success)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Language:** English | [简体中文](docs/zh-CN/README.md) | [繁體中文](docs/zh-TW/README.md) | [日本語](docs/ja/README.md) | [한국어](docs/ko/README.md)

agnes2api is a lightweight API gateway that sits in front of the Agnes AI service and
re-exposes it through four mainstream LLM API protocols — OpenAI, Anthropic, Gemini, and
OpenAI-Responses — plus passthrough endpoints for image and video generation. It ships as
both a Cloudflare Worker and a Docker container, backed by a self-healing key pool that
automatically cools down or evicts misbehaving upstream keys.

> **On Commercial Use**
>
> This project is licensed under MIT, which **legally permits commercial use**. However, we
> **do not recommend** running it as a commercial service:
>
> 1. The project depends on free quotas from a third-party service. Their availability,
>    latency, and quota policy can change at any time, and none of that comes with the
>    stability guarantees a commercial service needs.
> 2. Acquiring free quota in bulk is in tension with the upstream service's terms, and that
>    risk is borne entirely by whoever does it.
> 3. The project offers no availability commitment and no technical support.
>
> (This is advice, not a legal restriction — it is not part of the license.)

## Features

- **Four protocols, one upstream** — OpenAI, Anthropic, Gemini, and OpenAI-Responses clients
  all work against the same gateway, streaming included.
- **Image & video passthrough** — image generation and a two-step (create + poll) video
  generation flow.
- **Two deployment targets, one codebase** — Cloudflare Worker (KV-backed storage) or Docker
  (file-backed storage); both run the exact same request-handling logic.
- **Self-healing key pool** — upstream `429`/`402` responses cool a key down, `401`/`403`
  evict it permanently, repeated transient failures accumulate strikes until eviction.
- **Storage access decoupled from traffic** — the key pool is cached per isolate/process and
  updates that only touch telemetry fields are elided, so in steady state neither storage reads
  nor writes grow with request volume. How much headroom that leaves on Cloudflare's free KV
  tier depends on how many isolates stay active — see the quota section in
  [DEPLOY.md](docs/en/DEPLOY.md) for the formula and the two tunables.
- **Four accepted credential formats** — `Authorization: Bearer`, `x-api-key`,
  `x-goog-api-key`, and the `?key=` query parameter are all accepted, matching what each
  protocol's official SDK sends by default.
- **Optional auto-refill (disabled by default)** — enable the registrar and it automatically
  registers Agnes accounts to top up the key pool whenever it drops below target, see
  [REGISTRAR.md](docs/en/REGISTRAR.md).
- **Optional admin panel (disabled by default)** — with no `ADMIN_TOKEN` set the whole
  `/admin` tree is never registered at all; set one and you get a browser view of the key
  pool, the registrar, events, usage, and a playground, see [ADMIN.md](docs/en/ADMIN.md).

## Endpoints at a glance

| Method | Path | Protocol | Notes |
|---|---|---|---|
| GET | `/health` | – | no auth required |
| GET | `/v1/models` | OpenAI | model list |
| POST | `/v1/chat/completions` | OpenAI | streaming supported |
| POST | `/v1/messages` | Anthropic | streaming supported |
| POST | `/v1/responses` | OpenAI-Responses | streaming supported |
| GET | `/v1beta/models` | Gemini | model list |
| POST | `/v1beta/models/{model}:generateContent` | Gemini | non-streaming |
| POST | `/v1beta/models/{model}:streamGenerateContent` | Gemini | streaming |
| POST | `/v1/images/generations` | – | image generation |
| POST | `/v1/videos` | – | create a video task |
| GET | `/v1/videos/{id}` | – | poll a video task |

## Models

| Model | Type |
|---|---|
| `agnes-2.0-flash` | chat |
| `agnes-image-2.1-flash` | image |
| `agnes-image-2.0-flash` | image |
| `agnes-video-v2.0` | video |

## Quick start

### Cloudflare Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/xwteam/agnes2api)

```bash
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api
pnpm install
npx wrangler kv namespace create POOL   # copy the returned id into wrangler.toml
npx wrangler secret put GATEWAY_TOKEN
npx wrangler deploy
```

### Docker

```bash
git clone https://github.com/xwteam/agnes2api.git
cd agnes2api
cp .env.example .env   # set GATEWAY_TOKEN
docker compose up -d
```

## Documentation

Each language directory below carries the full docs: endpoint reference with request/response
examples, deployment guide (env vars, KV setup, manual key import), the optional registrar,
SDK usage examples, and the admin panel.

| Language | README | API | Deploy | Registrar | Usage | Admin |
|---|---|---|---|---|---|---|
| English | [README](docs/en/README.md) | [API](docs/en/API.md) | [DEPLOY](docs/en/DEPLOY.md) | [REGISTRAR](docs/en/REGISTRAR.md) | [USAGE](docs/en/USAGE.md) | [ADMIN](docs/en/ADMIN.md) |
| 简体中文 | [README](docs/zh-CN/README.md) | [API](docs/zh-CN/API.md) | [DEPLOY](docs/zh-CN/DEPLOY.md) | [REGISTRAR](docs/zh-CN/REGISTRAR.md) | [USAGE](docs/zh-CN/USAGE.md) | [ADMIN](docs/zh-CN/ADMIN.md) |
| 繁體中文 | [README](docs/zh-TW/README.md) | [API](docs/zh-TW/API.md) | [DEPLOY](docs/zh-TW/DEPLOY.md) | [REGISTRAR](docs/zh-TW/REGISTRAR.md) | [USAGE](docs/zh-TW/USAGE.md) | [ADMIN](docs/zh-TW/ADMIN.md) |
| 日本語 | [README](docs/ja/README.md) | [API](docs/ja/API.md) | [DEPLOY](docs/ja/DEPLOY.md) | [REGISTRAR](docs/ja/REGISTRAR.md) | [USAGE](docs/ja/USAGE.md) | [ADMIN](docs/ja/ADMIN.md) |
| 한국어 | [README](docs/ko/README.md) | [API](docs/ko/API.md) | [DEPLOY](docs/ko/DEPLOY.md) | [REGISTRAR](docs/ko/REGISTRAR.md) | [USAGE](docs/ko/USAGE.md) | [ADMIN](docs/ko/ADMIN.md) |

## License

MIT — see [LICENSE](LICENSE). See also [SPONSORS.md](SPONSORS.md) if you'd like to support
or contribute to the project.

Sending code: [CONTRIBUTING.md](CONTRIBUTING.md). Found a vulnerability: report it privately,
see [SECURITY.md](SECURITY.md) — please don't open a public issue for it.
