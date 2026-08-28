# Contributing

Thanks for looking. This is a small project with an unusually heavy testing culture, and the
rules below are enforced by CI rather than by reviewer goodwill. Reading this page first will
save you a round trip.

> Want to support the project rather than send code? See [SPONSORS.md](SPONSORS.md).
> (That file is Chinese-only today. Translating it is a separate piece of work, not part of
> this guide.)

## Ground rules

- **There is exactly one branch: `main`.** No feature branches, no release branches.
- **Commits are authored as `xwteam`, and carry no AI co-author trailer.**
- **The repository holds zero credentials.** No keys, no tokens, no private hostnames, no
  `IP:PORT` pairs — not in code, not in tests, not in docs, not in an issue you file.
  See [SECURITY.md](SECURITY.md) for what that rule does and does not mean.
- **Five languages.** The translated documentation lives in `docs/<lang>/`, one directory per
  language. (`docs/` also holds `docs/design/`, which is a working record and not a translation
  target.) A new i18n key must exist in all five languages, and a new section must appear in
  all five.

## Setting up

Install dependencies with pnpm. Neither the pnpm version nor the Node version is repeated
here: both are pinned in `package.json` (`packageManager` and `engines`), and the same Node
major is pinned in `Dockerfile` and in the CI workflow. Those three are kept in step by a test,
so trust them and not this paragraph.

## Running the checks

**This page deliberately does not keep a second copy of the check list.** The gates, their
order and their exact commands live in [`.github/workflows/ci.yml`](.github/workflows/ci.yml);
the script names they call live in `package.json`. Run what that file runs, in that order —
the same knowledge written down twice will drift.

The two you will run most often:

- `pnpm test` — unit, contract and front-end pure-function tests, on the Node runtime.
- `pnpm test:workers` — the contract tests again, this time inside `workerd`.

Contract tests are expected to run under **both** runtimes; that is the point of having them
in `tests/contract/`. A new case that only runs under Node covers half the product.

**No machine will tell you that you put a case in the wrong directory.** The collection guard
in `tests/global-setup.ts` checks that every file *already in* `tests/contract/` is collected
by both vitest configs — it does not judge where a case belongs. Its own note says so in as
many words: `tests/global-setup.ts`「不校验目录归属本身是否合理」. Write a contract-shaped case
into `tests/unit/` and it legitimately runs on Node only, with a green run and an unchanged
banner. Catching that is a reviewer's job, and it is one of the things the pull request
template asks about.

If you touch `admin-ui/`, the generated bundle `src/ui/assets.generated.ts` has to be
regenerated and committed in the same change. CI regenerates it and fails on any difference,
so a forgotten regeneration is a red build, not a silent drift.

## Mutation evidence is a merge condition

The house rule: **a checklist that cannot go red is not a guard, it is a to-do list.**

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
identifier code spans, and the absence of untranslated leakage. **Translation accuracy is not
machine-checked here** — five files can be wrong in the same way, or one of them can say the
opposite of the other four without moving a single `#`, and every guard stays green. The
guards listed above compare structure; none of them compares meaning. If you change the
meaning of a sentence, change it in all
five, and say so in the pull request so a human reads them.

## Reporting a security issue

Do not open a public issue for it. See [SECURITY.md](SECURITY.md).
