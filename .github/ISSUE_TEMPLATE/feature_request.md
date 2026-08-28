---
name: Feature request
about: Something the gateway should do and does not
title: ''
labels: ''
assignees: ''
---

**What you are trying to do** — the actual goal, not the feature you have already designed in
your head. The best requests are the ones that turn out to have a smaller answer.

**What you do today instead**, and why it is not good enough.

**Which surface it touches** — one of the four protocols, the passthrough endpoints, the key
pool, the registrar, or the admin panel.

**Does it have to work on both runtimes?** Cloudflare Workers and Docker/Node run the same
request-handling code, and anything that only works on one of them is a much harder sell.

**Would you be willing to send a pull request?** See
[CONTRIBUTING.md](https://github.com/xwteam/agnes2api/blob/main/CONTRIBUTING.md) first — the bar on tests here is higher than usual, and it is better to know that up front.
