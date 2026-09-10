## What this changes

<!-- One paragraph. What is different afterwards, and why. -->

## Merge conditions

> [!IMPORTANT]
> Tick every box, or strike it out and say why it does not apply. These are the house rules,
> not a formality — see
> [CONTRIBUTING.md](https://github.com/xwteam/agnes2api/blob/main/CONTRIBUTING.md).

- [ ] Every check in
      [`.github/workflows/ci.yml`](https://github.com/xwteam/agnes2api/blob/main/.github/workflows/ci.yml) was run locally, in the
      order that file lists them, and each one exited 0.
- [ ] `pnpm test` is green, and the totals went **up**, not down.
- [ ] New contract tests live in `tests/contract/`, next to the other end-to-end-shaped cases.
      This box used to also demand that they run under **both** runtimes; the Cloudflare Worker
      shape and its `workerd` test entry point were removed in v0.4.0, so nothing checks
      two-runtime agreement today — there is no second runtime left to disagree.
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

---

> [!WARNING]
> A checklist that cannot go red is not a guard, it is a to-do list. The mutation evidence
> above is the only thing that tells a reviewer which of these boxes was actually earned.
