# Contributing

Thanks for looking. This is a small project with an unusually heavy testing culture, and the
rules below are enforced by CI rather than by reviewer goodwill. Reading this page first will
save you a round trip.

> Want to support the project rather than send code? See [SPONSORS.md](SPONSORS.md).
> (That file is Chinese-only today. Translating it is a separate piece of work, not part of
> this guide.)

## Ground rules

| Rule | What it means in practice |
|------|---------------------------|
| **There is exactly one branch: `main`.** | No feature branches, no release branches. |
| **Commits are authored as `xwteam`.** | And they carry no AI co-author trailer. |
| **The repository holds zero credentials.** | No keys, no tokens, no private hostnames, no `IP:PORT` pairs — not in code, not in tests, not in docs, not in an issue you file. See [SECURITY.md](SECURITY.md) for what that rule does and does not mean. |
| **Five languages.** | The translated documentation lives in `docs/<lang>/`, one directory per language. A new i18n key must exist in all five languages, and a new section must appear in all five. |

## Setting up

Install dependencies with pnpm. Neither the pnpm version nor the Node version is repeated
here: both are pinned in `package.json` (`packageManager` and `engines`), and the same Node
major is pinned in `Dockerfile` and in the CI workflow. Those three are kept in step by a test,
so trust them and not this paragraph.

## Running the checks

> [!IMPORTANT]
> **This page deliberately does not keep a second copy of the check list.** The gates, their
> order and their exact commands live in [`.github/workflows/ci.yml`](.github/workflows/ci.yml);
> the script names they call live in `package.json`. Run what that file runs, in that order —
> the same knowledge written down twice will drift.

### The two you will run most often

- `pnpm test` — unit, contract and front-end pure-function tests, on the Node runtime.
- `pnpm test:workers` — the contract tests again, this time inside `workerd`.

Contract tests are expected to run under **both** runtimes; that is the point of having them
in `tests/contract/`. A new case that only runs under Node covers half the product.

### Nothing checks that a case is in the right directory

**No machine will tell you that you put a case in the wrong directory.** The collection guard
in `tests/global-setup.ts` checks that every file *already in* `tests/contract/` is collected
by both vitest configs — it does not judge where a case belongs. Its own note says so in as
many words: `tests/global-setup.ts`「不校验目录归属本身是否合理」. Write a contract-shaped case
into `tests/unit/` and it legitimately runs on Node only, with a green run and an unchanged
banner. Catching that is a reviewer's job, and it is one of the things the pull request
template asks about.

### If you touch the panel

If you touch `admin-ui/`, the generated bundle `src/ui/assets.generated.ts` has to be
regenerated and committed in the same change. CI regenerates it and fails on any difference,
so a forgotten regeneration is a red build, not a silent drift.

## Mutation evidence is a merge condition

> [!IMPORTANT]
> The house rule: **a checklist that cannot go red is not a guard, it is a to-do list.**

So for every assertion you add, do this before opening the pull request:

1. Break the exact thing the assertion claims to protect — one line, in the real file.
2. Confirm the assertion goes red, **and that its message names the thing you broke**. A guard
   that goes red without saying what happened is how people get led into the wrong fix.
3. Put it back, confirm green again.
4. Add a **reverse control**: something that is genuinely different but not wrong, and show the
   assertion stays green for it. Use strings that really exist in this repository — a control
   built out of invented content proves nothing.

Paste the result as a table in the pull request. The template asks for it.

## Documentation changes

Structural parity across the five languages is machine-checked: section skeletons, link sets,
identifier code spans, and the absence of untranslated leakage.

> [!WARNING]
> **Translation accuracy is not machine-checked here.** Five files can be wrong in the same
> way, or one of them can say the opposite of the other four without moving a single `#`, and
> every guard stays green. The guards compare structure; none of them compares meaning. If you
> change the meaning of a sentence, change it in all five, and say so in the pull request so a
> human reads them.

## Replacing `docs/logo.png`

### Why a binary needs its own gate

`docs/logo.png` is the **only binary file allowed anywhere under `src/`, `tests/`,
`admin-ui/`, `scripts/` or `docs/`**. `scripts/check-no-binary.mjs` rejects binaries in those
directories on purpose — a binary file is invisible to the text tool chain the rest of this
project is built on (review diffs, `grep` audits, the credential scan). The logo gets in
through a **named allowlist holding exactly one literal path**, and the hole that allowlist
opens is closed by a second gate, `scripts/check-png.mjs`, which reads the file byte by byte:
signature, per-chunk CRC, chunk-type allow/deny lists, **a size bound on every chunk type
except `IDAT`**, **an at-most-once bound on every chunk type except `IDAT`**, **chunk
ordering** (one `IHDR` first, everything but `IDAT` ahead of the pixels, `IEND` last),
**zero trailing bytes after `IEND`**, sha256 against a registered value, plus dimensions,
byte budget and transparent-pixel ratio.

### The one property all of that adds up to

Taken together those checks add up to one property:
**`IDAT` is the only place in the file where a byte is free, and `IDAT` is audited on both
sides of its decompression — the output must be exactly `width × height × 4 + one byte per
row`, and the zlib stream must consume every byte the chunk declared.**

### Every version of this gate so far claimed a property it did not have

That property is worth stating precisely, because no version of this gate has yet had it on
the first try, and every version so far claimed it did. Round one: the allowlist included
`iCCP`, `PLTE` and `tRNS` — all variable-length, and `iCCP` is by definition "a name, a NUL,
a compression byte, then a zlib stream of any length". No chunk had a length bound either,
so even a `gAMA` (fixed at 4 bytes by the spec) could declare 20 000.

### Round two found the same hole in two more windows

Round two found it in two more windows: a length bound is decided **per chunk**, so it cannot answer
"how many times may this type appear" — 1000 perfectly legal 4-byte `gAMA` chunks carry
4 KB of payload and used to pass; and `inflateSync` **silently ignores every input byte after
the zlib stream ends**, so checking how much came *out* of `IDAT` never checked how much went
*in* — 20 KB of plaintext appended inside the `IDAT` chunk used to pass with a green tick and
a `IHDR IDAT IEND` chunk list. Payload inside a binary is exactly what the credential scan
cannot read. Each time, the hole the allowlist opens had not been closed; it had been moved.
If you ever need to widen `ALLOWED_CHUNKS`, the entry bar is **"its length is pinned by the
spec, and the spec allows it at most once"**, not "the spec knows this chunk".

### The registry itself is locked

The word **only** at the top of this section is not asking to be trusted either — it has a
test that goes red. `tests/unit/check-png.test.ts`「名册整份恰好是 [docs/logo.png] —— 往里加一行就等于把放行扩到别处」
compares the whole registry against a one-element list, so a second path fails and gets named.
Before that assertion existed the registry had no lock at all: a second PNG dropped under
`src/`, plus one line in `REGISTERED_BINARIES`, made the binary gate print a green tick and
left every other check quiet.

### Swapping the image is four steps, not one

Swapping the image is therefore four steps, not one:

1. Overwrite `docs/logo.png` (128×128, 8-bit RGBA, non-interlaced).
2. Update the registered sha256 in `scripts/check-png.mjs` (`sha256sum docs/logo.png`).
   The gate goes red until you do, and that is the point: the registered digest is the only
   evidence that a human ever looked at these bytes.
3. Re-run the credential scan — **both archives**: `bash scripts/scan-secrets.sh` and
   `bash scripts/scan-secrets.sh --history`.
4. Re-run `node scripts/check-png.mjs`.

### Why step 3 is not a formality

Step 3 is not a formality. Five of the six rules in that scanner decide on `git grep`'s exit
code, so a credential-shaped string inside a binary is caught. **The sixth rule — the bare-IP
one — needs the matched line's content, which `git grep` refuses to print for a binary file,
so it fails closed.** Concretely: if the compressed bytes of your new logo happen to contain
an ASCII run that looks like a dotted quad, the credential scan goes red and its message
points at `scripts/check-no-binary.mjs` asking why that file was let in. That is designed
behaviour, not a broken gate — but you want to learn it from this page rather than from a red
CI run. The other side of the same coin: anything that is *not* one of those six shapes
(a private hostname, an e-mail address, a password, anything compressed) is invisible to the
scanner inside a binary. That is exactly the hole `scripts/check-png.mjs` exists to close, and
it is why "just widen the allowlist" is never the fix.

## Cutting a release

### The version string is written by a script, never by hand

Releases come off `main`; there is no release branch. The version string lives in four places
and none of them is edited by hand — `scripts/set-version.sh` writes all four in one go:

```bash
bash scripts/set-version.sh 0.1.1
```

That rewrites `VERSION`, the `version` field in `package.json`, the constant in
`src/version.ts`, and the version badge at the top of the root README **and** of every
translated README.

### Then, in this order

1. Refresh the lockfile. The script prints the exact command as its last line; run it, because
   `package.json` and `pnpm-lock.yaml` disagreeing is a red build, not a warning.
2. Write the entry in `CHANGELOG.md`.
3. Run the pre-push checklist — `bash scripts/prepush.sh` — and make it green. It re-runs the
   CI gates in CI's own order, plus the few things CI structurally cannot see (a dirty working
   tree, the branch, the author identity, the test counts, and a real two-runtime smoke test).
4. Commit, tag `vX.Y.Z`, and push **both the commit and the tag**. Pushing a `v*` tag is what
   triggers [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) to
   publish the image; that workflow can also be run by hand from the Actions tab. The version
   badges are not computed at render time — they ship inside the commit the tag points at, so
   the tag must come after the version bump, never before.
5. Write the GitHub Release body from the skeleton below.

### The Release body is five languages, in this order

Same rule as the documentation: whatever the release notes say, they say it five times. The
skeleton — heading level, flags, and order — is copied from the sibling repository's published
releases, so anyone reading both sees the same shape:

```markdown
## 🇨🇳 中文

## 🇺🇸 English

## 🇯🇵 日本語

## 🇰🇷 한국어

## 🇹🇼 繁體中文
```

Three details in that block are deliberate and are the ones people get wrong: the headings are
`##` (not `###`), every language carries its flag emoji, and **Traditional Chinese comes last**
— it is not paired next to Simplified Chinese, and its flag is 🇹🇼.

> [!WARNING]
> Nothing machine-checks the Release body: it lives on GitHub, not in this repository, so no
> gate in `.github/workflows/ci.yml` can reach it. This section is the whole of the enforcement.

## Reporting a security issue

> [!WARNING]
> Do not open a public issue for it. See [SECURITY.md](SECURITY.md).

---

- What the credential gates do and do not promise: [SECURITY.md](SECURITY.md)
- What the gateway exposes and how it is deployed: [README.md](README.md)
