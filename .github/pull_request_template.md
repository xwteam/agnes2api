## What this changes

<!-- One paragraph. What is different afterwards, and why. -->

## Merge conditions

Tick every box, or strike it out and say why it does not apply. These are the house rules, not
a formality — see [CONTRIBUTING.md](https://github.com/xwteam/agnes2api/blob/main/CONTRIBUTING.md).

- [ ] Every check in
      [`.github/workflows/ci.yml`](https://github.com/xwteam/agnes2api/blob/main/.github/workflows/ci.yml) was run locally, in the
      order that file lists them, and each one exited 0.
- [ ] `pnpm test` and `pnpm test:workers` are both green, and the totals went **up**, not down.
- [ ] New contract tests live in `tests/contract/` and therefore run under **both** runtimes.
      A case that only runs under Node covers half the product.
- [ ] **Mutation evidence** is filled in below. Every new assertion was made to go red on
      purpose, and the message it printed names the thing that was broken.
- [ ] A **reverse control** is included: something genuinely different but not wrong, built out
      of strings that really exist in this repository, that the assertion stays green for.
- [ ] `admin-ui/` untouched, or `src/ui/assets.generated.ts` regenerated and committed with it.
- [ ] Documentation changes landed in all five languages.
- [ ] No credentials, hostnames or `IP:PORT` pairs were added anywhere, including tests and docs.
- [ ] Commit author is `xwteam`, the commit message carries **no AI co-author trailer**, and the
      work is on `main` (this repository has no other branch).

## Mutation evidence

| # | what was broken (file and line) | expected | observed |
|---|---|---|---|
|   |                                 | red      |          |
|   | reverse control                 | green    |          |

## Anything you decided not to do

<!-- Known gaps, deliberate omissions, things the new guards still cannot see. Writing "none"
     is fine; leaving it blank is not. -->
