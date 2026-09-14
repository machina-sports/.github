## What

<!-- Short description of what this PR does. -->

## Why

<!-- The problem it solves. Link the ticket. -->

## How

<!-- Approach, key decisions, trade-offs. -->

<!-- evidence-gate:v1 -->
## Evidence

The `Evidence gate` check reads the five lines below. Tick a box only when the
evidence next to it is true; a step that genuinely does not apply is waived with
`n/a — <why>`, which is recorded rather than hidden. `task:` cannot be waived.

- [ ] `task:` <ClickUp URL — https://app.clickup.com/t/...>
- [ ] `repro:` <what you saw BEFORE the change, on the version actually deployed>
- [ ] `test:` <automated test added + command + result — or `n/a — <why>`>
- [ ] `staging:` <deployed version (v.staging-main.N or SHA) + URL + what you exercised + result — or `n/a — <why>`>
- [ ] `rollback:` <the exact way back: image tag to redeploy, revert, or flag to flip>
<!-- /evidence-gate -->

<details>
<summary>Filled-in example</summary>

```
- [x] `task:` https://app.clickup.com/t/86ae393wg
- [x] `repro:` on v.staging-main.299 an execution with a 3000-char unbroken value pushed body.scrollWidth to 19995px against a 1200px viewport
- [x] `test:` npm run test:unit -- executions → 14 passed; new case asserts scrollWidth === clientWidth
- [x] `staging:` v.staging-main.301 · https://studio-staging.machina.gg · opened execution 8f2a on Timeline and Inputs/Outputs, no horizontal scroll at 1280px and 390px
- [x] `rollback:` redeploy v.staging-main.299 via Release Staging, or revert the merge commit — no schema or data touched
```

Why the `staging:` line insists on a version: staging routinely runs a different
commit than the branch you just pushed, and we have lost verification rounds to
exactly that. "Verified on staging" with no version is not a verifiable claim.

</details>

## Checklist

- [ ] PR title follows [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `build:`, `ci:`, `perf:`, `revert:`)
- [ ] No `.env` / secrets / credentials committed (gitleaks will block)
- [ ] Targeting the branch this repo actually ships from
- [ ] Updated `CHANGELOG.md` / docs if user-facing behavior changed

## Deploy notes

<!-- Env vars, migrations, feature flags, ordering constraints. -->

## Screenshots / videos

<!-- For UI changes. -->
