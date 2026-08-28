# Security Policy

## Reporting a vulnerability

**Report it privately, through this repository's GitHub Security Advisories** — the
"Report a vulnerability" button under the repository's *Security* tab. That opens a private
thread visible only to the maintainer.

Please do **not** open a public issue for a suspected vulnerability, and please do not attach
real keys, tokens, hostnames or `IP:PORT` pairs to a report — a redacted reproduction is
always enough.

There is deliberately no contact address on this page. The repository ships with zero
credentials and zero private deployment details, and an address written into a public file is
one more thing that has to be kept true.

Expect an acknowledgement rather than a schedule: this is a personal project with no support
commitment (see the disclaimer in [LICENSE](LICENSE)).

## What this repository promises, and what it does not

**"No credentials in the repository" is a repository discipline. It is not a statement about
your deployment.** CI enforces it with `scripts/check-no-binary.mjs` (no tracked file may be
binary, because a binary file is a blind spot for the next step) and `scripts/scan-secrets.sh`
(tracked and untracked files are scanned for key-shaped strings and for `IP:PORT` pairs). A
build fails if either finds something. That is the entire claim.

Those steps run on every pull request and on pushes to the branches listed in the `on:` block
of [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — read that block rather than this
sentence if it matters to you. A push to a branch outside that list does not trigger CI;
opening a pull request from it does.

Whether a running gateway holds up is decided by things this repository cannot see: whether
you set a strong `GATEWAY_TOKEN` and a strong admin token, whether the panel is exposed to the
open internet, whether TLS terminates in front of it, who can read your Worker KV namespace or
the Docker volume that holds the key pool, and what the upstream service does with the traffic
you send it. **None of that is covered by any test in this repository.**

The project also offers no availability guarantee and no support. It is licensed under MIT,
which permits commercial use; the README explains why running it as a commercial service is
still a bad idea.

## Security-relevant behaviour that is actually implemented

The points below are worth knowing before you deploy. Each one is pinned to something outside
this page — a constant this file is checked against, or a name anchor (a file plus the exact
line or case title it refers to) that a test resolves. That catches a pointer rotting; it does
not prove the behaviour behind the pointer is still what the sentence says.

- **The admin session is a browser-side token with a fixed lifetime.** The admin token you
  type into the panel is kept in the browser's `localStorage`, and the session is treated as
  expired 12 hours after it was stored. A stored timestamp that lies in the future counts as
  expired too, so winding the clock back does not extend a session. Closing the tab does not
  clear it — on a shared machine, use the panel's sign-out.
  (`SESSION_MAX_AGE_MS` in `admin-ui/js/pure/session.mjs` is where that lifetime is defined;
  this page is checked against it.)
- **Stored upstream keys are not echoed back in full.** Key values are masked in admin
  responses, and there is no "reveal" endpoint. The contract case
  `tests/contract/admin-keys.test.ts`「响应体整段文本里都找不到明文 key」searches the entire
  response body for the plaintext and fails if it turns up anywhere in it.
- **Admin endpoints are authenticated as a group, not one at a time.** Everything under
  `/admin/api/` sits inside one authenticated window, and
  `tests/contract/admin-auth.test.ts`「每一条 /admin/api/* 都注册在 adminAuth 之后、静态兜底之前 —— 位置写错了它会恒 404 而没人拦」
  fails if a route drifts out of it. A route outside the window would not fail loudly; it would
  answer something plausible-looking, which is exactly why it is pinned.
- **There is no way to revoke an admin session from inside the product, and the panel's CSP
  does not stop a stolen token from being carried out by a navigation.** The value in
  `localStorage` is the admin token itself, so the only revocation is to change the secret and
  redeploy or rebuild the container — the source says so where the lifetime is decided
  (`admin-ui/js/pure/session.mjs`「产品内无撤销路径」). Separately, `connect-src 'self'` and
  `form-action 'none'` block `fetch` and form exfiltration, but nothing in CSP blocks
  `location.href = "https://…?k=" + token`; the navigation exits that exist today are pinned by
  `tests/ui/api-session.test.ts`「面板的导航出口清单（CSP 拦不住的那一族）」, which also keeps a
  registered list of the shapes that check cannot recognise. Treat the 12-hour lifetime as a
  cap on how long a leaked `localStorage` value stays usable, not as a revocation story.

## If you operate one

- Set `GATEWAY_TOKEN` and the admin token to values you generated, and never reuse them.
- Do not expose the admin panel to the open internet unless you meant to.
- Treat the storage behind the gateway (Worker KV namespace, or the Docker data volume) as
  credential material: it holds the upstream key pool in usable form.
- Keep upstream keys disposable. The pool cools down and evicts misbehaving keys by design;
  losing one should be an inconvenience, not an incident.
