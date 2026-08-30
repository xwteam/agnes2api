---
name: Bug report
about: Something the gateway does that it should not
title: ''
labels: ''
assignees: ''
---

> [!WARNING]
> **Never paste real API keys, tokens, hostnames or `IP:PORT` pairs.** Redact them before
> you hit submit. For a suspected *vulnerability*, do not use this template at all — see
> [SECURITY.md](https://github.com/xwteam/agnes2api/blob/main/SECURITY.md).

**Runtime** — Cloudflare Worker, or Docker / Node? (say which; they share one codebase but
not one storage layer)

**Version** — the value in `VERSION`, or the tag of the image you ran.

**Surface** — OpenAI, Anthropic, Gemini, OpenAI-Responses, image/video passthrough, or the
admin panel?

**What happened**

**What you expected instead**

**Smallest reproduction** — the request you sent (redacted) and the response you got back,
including the status code. If it is a streaming problem, say so; streaming and non-streaming
go down different paths.

**Anything in the logs?** The gateway records upstream failures and key-pool decisions; the
relevant lines usually say more than the client-side error does.

---

> [!IMPORTANT]
> Read the filled-in report once more before you submit it, and check that nothing above is a
> real key, token, hostname or `IP:PORT` pair. Redaction is not reversible once the issue is
> public.
