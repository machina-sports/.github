# How `machina-sports/.github` Works

This document explains the architecture, mechanics, and trade-offs of the `machina-sports/.github` repository — the org-level automation custodian for all `machina-sports/*` repos.

## TL;DR

`machina-sports/.github` is a **public** repository at the org level that holds four categories of shared automation:

1. **GitHub-native propagation** — Files like `PULL_REQUEST_TEMPLATE.md` and `CODEOWNERS` are inherited automatically by every repo in the `machina-sports` org that doesn't define its own.
2. **Reusable workflows** — Generic CI/CD primitives (PR checks, deploys to AKS, secret scans) that any repo invokes via `uses: machina-sports/.github/.github/workflows/<name>.yml@v1`.
3. **Copyable config templates** — Files like `.gitignore.base`, `lefthook.yml`, `commitlint.config.mjs`, `gitleaks.toml`, `prettier.config.mjs`, `eslint.config.mjs`, `tsconfig.base.json` that the `apply-baseline.sh` script installs into each consumer repo.
4. **Claude Code skills (plugin `machina`)** — Slash-commands like `/machina:setup-branch-protection` that automate org-level operations.

Each repo opts in by running `apply-baseline.sh` once, then references reusable workflows from its own `.github/workflows/*.yml` files. Branch protection is then applied org-wide via the `setup-branch-protection` skill.

---

## Repository layout

```
machina-sports/.github
├── README.md                              ← entry point
├── .github/
│   ├── PULL_REQUEST_TEMPLATE.md           ← propagated org-wide
│   ├── CODEOWNERS                         ← default org-level owners
│   ├── workflows/
│   │   ├── reusable-pr-checks.yml         ← lint/typecheck/test/build/env-guard/secret-scan
│   │   ├── reusable-semantic-pr.yml       ← Conventional Commits PR title gate
│   │   ├── reusable-secret-scan.yml       ← gitleaks (also embedded in pr-checks)
│   │   ├── reusable-review-pr.yml         ← Truth Point platform-aware PR review
│   │   └── reusable-deploy-aks.yml        ← kubectl set image to AKS, optional gating
│   └── actions/
│       └── setup-and-build/               ← composite action used by callers' inline builds
├── .claude-plugin/
│   └── plugin.json                        ← Claude Code plugin metadata (namespace: machina)
├── .claude/
│   └── skills/
│       └── setup-branch-protection/
│           └── skill.md                   ← /machina:setup-branch-protection runbook
├── configs/                               ← templates copied into consumer repos
│   ├── .gitignore.base                    ← strict secret/build/IDE ignores
│   ├── lefthook.yml                       ← git hooks (pre-commit env-guard, commit-msg)
│   ├── commitlint.config.mjs              ← Conventional Commits rules
│   ├── prettier.config.mjs
│   ├── eslint.config.mjs                  ← Next/TS shared preset
│   ├── tsconfig.base.json                 ← TS strict baseline
│   ├── gitleaks.toml                      ← secret scan rules + public-key allowlist
│   └── actionlint.yaml                    ← workflow YAML lint config
├── docs/
│   ├── adoption-guide.md                  ← step-by-step for new repos
│   ├── deploy-flow.md                     ← canonical dev → staging → production lifecycle
│   └── how-it-works.md                    ← this file
└── scripts/
    └── apply-baseline.sh                  ← idempotent installer
```

---

## Why this repo must be public

GitHub Actions allows private repos in the same org to call each other's reusable workflows, but only after configuring `actions/permissions/access` on **both** the calling and the called repo. In practice, when we tested with the custodian as private, GitHub returned `error parsing called workflow ... workflow was not found` even with org-level access enabled.

Making the custodian **public** sidesteps this entire class of permission issue. The content is intentionally generic (workflows, configs, docs) and contains no secrets — secrets are always passed by the caller via the `secrets:` block. This matches the industry pattern: `vercel/.github`, `anthropic-ai/.github`, `github/.github` are all public for the same reason.

---

## How GitHub-native propagation works

When you create a repo in the `machina-sports` org without its own `.github/PULL_REQUEST_TEMPLATE.md` or `.github/CODEOWNERS`, GitHub automatically uses the ones from `machina-sports/.github`. There is **no caller-side configuration** for this — it is built into GitHub's behavior for the special `.github` repo name.

A repo can override either file by adding its own version locally; the org-level fallback only kicks in when the file is absent.

---

## Reusable workflows

Reusable workflows are GitHub Actions workflows that declare `on: workflow_call` and accept inputs/secrets. Caller repos invoke them via:

```yaml
jobs:
  my-job:
    uses: machina-sports/.github/.github/workflows/reusable-<name>.yml@v1
    with:
      input-name: value
    secrets:
      SECRET_NAME: ${{ secrets.SECRET_NAME }}
```

We pin to the `v1` tag so callers get a stable contract; non-breaking fixes are pushed by force-moving the tag (semantic-major-version-pinning, the same pattern as `actions/checkout@v4`).

### `reusable-pr-checks.yml`

The universal PR gate. Caller passes a runtime hint (`node` | `python` | `bun`) plus optional commands; jobs auto-skip when commands are empty.

It runs four jobs in parallel:

1. **`env-guard`** — Diffs the PR's base..head for filenames matching `(^|/)\.env(\.[^/]+)?$` and fails if any are found, except `.env.example` and `.env.<env>.example`. This blocks accidental commits of real `.env` files at CI time even if the local lefthook hook was skipped via `--no-verify`.

2. **`setup-node`** — For Node/Bun runtimes. Installs deps via `npm ci` / `pnpm install --frozen-lockfile` / `bun install --frozen-lockfile` based on `package-manager` input, then runs caller-supplied `lint-cmd`, `typecheck-cmd`, `test-cmd`, `build-cmd` (each gated by non-empty input).

3. **`setup-python`** — For Python runtimes. Installs `pdm install --no-self` or `poetry install --no-root` or `pip install -r requirements.txt` based on `package-manager` input, then runs the same lint/typecheck/test commands.

4. **`secret-scan`** — Downloads the `gitleaks` v8.21.2 binary directly (we don't use `gitleaks/gitleaks-action@v2` because it requires a paid license for org use as of 2024) and scans the PR diff. Fetches `.gitleaks.toml` from the org config if not present locally.

### `reusable-semantic-pr.yml`

Validates the PR title against Conventional Commits via `amannn/action-semantic-pull-request`. Allowed prefixes: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `build`, `ci`, `perf`, `revert`. The subject (text after `:`) must not start with an uppercase character.

### `reusable-review-pr.yml`

Asks Truth Point to review the calling PR. Fetches the PR title + unified diff via `gh`, POSTs to the `truth-point-review-pr` workflow, polls the execution endpoint until done, then posts a single PR comment with a structured verdict (`approve` / `approve-with-nits` / `request-changes` / `scope-mismatch`) and findings keyed to specific files/lines. Each finding can cite the `lesson_id` or `incident_id` it was grounded in, so the rubric is auditable.

Inputs:

- `pr-number` — defaults to `github.event.pull_request.number` when triggered by `pull_request`.
- `applies-to` — optional kind filter for lessons (e.g. `studio`, `agent-template`, `workflow`). Empty = all lessons.
- `poll-timeout-seconds` — how long to wait for the analyzer (default 120s).

Secrets:

- `TRUTH_POINT_REVIEW_PR_URL` — the workflow schedule URL for `truth-point-review-pr`.
- `TRUTH_POINT_API_TOKEN` — Truth Point API token.

Failure semantics: the job fails on Truth Point HTTP errors / polling timeout. A `request-changes` verdict is **information**, not a gate — set `continue-on-error: true` on the caller job if you don't want analyzer outages to block merge.

### `reusable-deploy-aks.yml`

Generic AKS deploy primitive. Inputs:

- `app-name`, `image-tag`, `namespace`, `deployment-name`, `container-name`
- `aks-cluster`, `aks-resource-group` (default to `mks-community-cluster` / `mks-community-group`)
- `environment` — when set (e.g., `production`), binds the job to a GitHub Environment. If that environment has required reviewers configured, the deploy waits for manual approval.
- `rollout-timeout` — passed to `kubectl rollout status`

Steps: resolve image tag → Azure login → AKS context → `kubectl set image` + rollout status → Slack notify (best-effort, `continue-on-error: true`) → Azure cleanup.

This workflow does **not** build images. Builds happen in the caller (see "Why builds stay in callers" below).

---

## Why builds stay in callers (not in a reusable)

GitHub Actions has a hard limitation: **`secrets.*` references are forbidden inside `with:` blocks of workflow_call inputs**. They are only valid inside `secrets:` blocks.

Most apps need secrets (API keys, tokens) inside Docker `--build-arg` values, which means the build configuration is application-specific and contains secret references. Trying to pass them through a reusable workflow fails at YAML parse time:

```
Unrecognized named-value: 'secrets'.
```

Workarounds (all worse):

- Pass each secret individually as a named secret to the reusable, then have the reusable assemble build-args with foreknowledge of every app's needs → not generic
- Use `secrets: inherit` and have the reusable enumerate secret names → still requires per-app coupling

Our resolution: each caller workflow has its own `build-and-push` job that inlines the `docker/login-action` + `docker/build-push-action` steps, then a second `deploy` job that uses `reusable-deploy-aks.yml` with `image-tag` passed via `needs.build-and-push.outputs.image-tag`. The reusable handles the deploy half; the build half stays per-app.

Example (from `machina-studio/.github/workflows/build-staging.yml`):

```yaml
jobs:
  build-and-push:
    runs-on: ubuntu-latest
    outputs:
      image-tag: ${{ steps.set-tag.outputs.tag }}
    steps:
      - uses: actions/checkout@v4
      - id: set-tag
        run: echo "tag=${GITHUB_REF#refs/tags/}" >> "$GITHUB_OUTPUT"
      - uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: ./Dockerfile.build-staging
          push: true
          build-args: |
            NEXT_PUBLIC_FOO=${{ vars.NEXT_PUBLIC_FOO }}
            NEXT_PUBLIC_API_KEY=${{ secrets.NEXT_PUBLIC_API_KEY }}
          tags: |
            ${{ secrets.REGISTRY_URL }}/machina-studio:${{ steps.set-tag.outputs.tag }}

  deploy:
    needs: build-and-push
    uses: machina-sports/.github/.github/workflows/reusable-deploy-aks.yml@v1
    with:
      app-name: machina-studio
      image-tag: ${{ needs.build-and-push.outputs.image-tag }}
      namespace: machina-workspace
      deployment-name: machina-workspace-client-services-staging
      container-name: machina-workspace-studio-staging
    secrets:
      REGISTRY_URL: ${{ secrets.REGISTRY_URL }}
      AZURE_CREDENTIALS: ${{ secrets.AZURE_CREDENTIALS }}
      SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK }}
```

For production deploys, add `environment: production` to the deploy job's `with:` block to bind it to the `production` GitHub Environment. The environment must be configured once in the repo's `Settings → Environments` with required reviewers; otherwise the gate auto-approves.

---

## Configs distributed via `apply-baseline.sh`

Unlike reusable workflows (referenced live from each repo), configs are **copied** into each repo. This trades ease-of-update for self-containment — each repo carries its own copy of `.gitignore`, `lefthook.yml`, `commitlint.config.mjs`, etc. The `--check` flag of `apply-baseline.sh` detects drift later.

The script lives at `scripts/apply-baseline.sh`. Two modes:

```bash
# Sibling-clone mode (recommended for local dev):
cd <consumer-repo>
../machina-sports-org-github/scripts/apply-baseline.sh

# Remote mode (one-shot from anywhere):
curl -sSL https://raw.githubusercontent.com/machina-sports/.github/main/scripts/apply-baseline.sh \
  | bash -s -- --remote
```

What it does:

1. Detects runtime (`node` if `package.json` exists, `python` if `pyproject.toml` / `requirements.txt`).
2. **Merges `.gitignore`** — writes `configs/.gitignore.base` at the top of the consumer's `.gitignore`, preserving everything below the `# --- end of baseline ---` marker as repo-specific local additions.
3. **Writes** `lefthook.yml`, `.gitleaks.toml`, `.github/actionlint.yaml` (always overwrites — these are managed centrally).
4. **Writes** runtime-specific configs (`prettier.config.mjs`, `commitlint.config.mjs` for Node).
5. **Writes only-if-missing** `eslint.config.mjs` and `tsconfig.base.json` to avoid clobbering repo-specific extensions.

Run with `--check` to detect drift without writing. Useful for monthly maintenance:

```bash
../machina-sports-org-github/scripts/apply-baseline.sh --check
# → "✅ No drift" or lists which files have changed since last sync
```

### `lefthook.yml`

Replaces husky. Hooks:

- **`pre-commit`**:
  - `no-env-files` — Refuses to commit files matching `\.env(\.[^/]+)?$` except `*.example` ones.
  - `lint` (Node only, gated by glob `*.{js,jsx,ts,tsx,mjs,cjs}`): runs `npm run lint` / `pnpm lint` / `bun run lint` based on lockfile.
  - `typecheck` (TS only, glob `*.{ts,tsx}`): runs `npm run typecheck` if the script exists.
  - `python-lint` (`*.py` glob): runs `ruff check` if installed, falls back to `flake8`.

- **`commit-msg`**: runs commitlint against the commit message if `commitlint.config.mjs` is present.

Each hook gates on file globs and skips silently when prerequisites are missing, so the same `lefthook.yml` works in Node, Python, and mixed repos.

### `gitleaks.toml`

Allowlist by **path** (e.g., `.env.example`, `docs/`) and by **secret value** (with `regexTarget = "secret"`). The value-based allowlist covers known-public credentials that gitleaks would otherwise flag as `generic-api-key`:

- PostHog public project keys: `phc_[A-Za-z0-9]{40,}`
- Google Analytics measurement IDs: `G-[A-Z0-9]{6,}`, `UA-[0-9]+-[0-9]+`
- Stripe publishable keys: `pk_(live|test)_[A-Za-z0-9]+`

These are by-design-public — they ship to the JS bundle that runs in users' browsers. Treating them as secrets creates noise without security benefit.

### Other configs

- **`commitlint.config.mjs`** — Mirrors the Conventional Commits rules enforced by `reusable-semantic-pr.yml`, so commits and PR titles follow the same contract.
- **`prettier.config.mjs`** — Single quotes, semis, 100-char width, LF line endings.
- **`eslint.config.mjs`** — Flat-config preset for Next/TS, with a `no-restricted-imports` rule that warns on deep relative imports of `components/` (encouraging consumption of `@machina-sports/ds`).
- **`tsconfig.base.json`** — Strict TS baseline (`strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`).

---

## Claude Code skills (plugin `machina`)

The custodian also exports a Claude Code plugin at `.claude-plugin/plugin.json` with org-level skills. Skills are markdown runbooks Claude Code follows when the user invokes them via slash command.

### `/machina:setup-branch-protection`

Configures branch protection on a repo via `gh api`, replacing the manual `Settings → Branches` UI workflow. Per repo it:

1. Detects the default branch (`main` / `master`) and whether `staging` exists.
2. Reads the repo's `.github/workflows/pr.yml` to detect the runtime (`node` vs `python`).
3. Builds the `required_status_checks.contexts` array to match what the repo's `pr.yml` actually emits — only the runtime-specific check, plus the three universal ones (`semantic-pr / Validate PR title`, `checks / Block .env in diff`, `checks / Secret scan (gitleaks)`).
4. Applies the rule via `PUT /repos/<owner>/<repo>/branches/<branch>/protection`.
5. Verifies via a read-back.

Standard rule shape applied:

```jsonc
{
  "required_status_checks": { "strict": true, "contexts": [...] },
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "enforce_admins": false,                    // never lock admins out
  "restrictions": null,                        // no push allowlist
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
```

### Guardrails the skill enforces

- **Never** sets `enforce_admins: true` (admin lockout risk).
- **Never** includes the legacy `notify` (Slack-only) check from `pull.yml` — it always passes vacuously and would defeat enforcement.
- **Never** sets `restrictions` (push allowlist) without explicit user confirmation.
- Verifies exact context-name strings against actual past runs (`gh api /repos/.../check-runs`) to avoid blocking all merges due to typos.

### Recovery

If a rule misconfigures and blocks merges, the skill documents the rollback:

```bash
gh api --method DELETE "/repos/<owner>/<repo>/branches/<branch>/protection"
```

---

## Adoption flow for a new repo

1. **Apply the baseline** (one-time):
   ```bash
   cd <repo>
   ../machina-sports-org-github/scripts/apply-baseline.sh
   ```

2. **Install hooks** (Node):
   ```bash
   npm i -D lefthook @commitlint/cli @commitlint/config-conventional prettier
   npx lefthook install
   ```
   (Python: `brew install lefthook && lefthook install`)

3. **Add `.github/workflows/pr.yml`**:
   ```yaml
   name: PR Checks
   on:
     pull_request:
       branches: [main, staging]
   permissions:
     contents: read
     pull-requests: read
   jobs:
     semantic-pr:
       uses: machina-sports/.github/.github/workflows/reusable-semantic-pr.yml@v1
     checks:
       uses: machina-sports/.github/.github/workflows/reusable-pr-checks.yml@v1
       with:
         runtime: node    # or python | bun
         package-manager: npm
         lint-cmd: 'npm run lint'      # leave '' to skip
         typecheck-cmd: 'npm run typecheck'
         build-cmd: 'npm run build'
         run-secret-scan: true
   ```

4. **Migrate deploy workflows** (separate PR, lower risk). Each becomes:
   - A `build-and-push` job (inline build + push to registry, with secrets in scope)
   - A `deploy` job that calls `reusable-deploy-aks.yml@v1` and passes `image-tag` from build outputs

5. **Configure branch protection** in the GitHub UI (`Settings → Branches`):
   - Require pull request + 1 approval
   - Required status checks: the four jobs from `reusable-pr-checks.yml` + `reusable-semantic-pr.yml`
   - Restrict force pushes / deletions

6. **(Optional) Configure `production` Environment** (`Settings → Environments`) with required reviewers. Without this, `environment: production` in a deploy job auto-approves.

---

## Versioning and releases

- The `v1` tag tracks the latest backwards-compatible state of `main`. Non-breaking changes (bug fixes, new optional inputs, config additions) force-move `v1` to the new HEAD.
- Breaking changes will introduce `v2` (and earlier `v1`-pinned callers continue to work).
- Internal commits and breaking changes use semantic prefixes (`feat:`, `fix:`, `refactor:`, `BREAKING CHANGE:`).

---

## Trade-offs and known limitations

| Trade-off | Why we chose this |
|---|---|
| Custodian is public | GitHub Actions cross-repo private workflow access has too many edge cases. Public sidesteps all of them. Content is generic. |
| Configs copied (not npm-published) | Lower setup cost. Drift is detectable via `apply-baseline.sh --check`. We can promote to npm packages later if sync pain emerges. |
| Builds stay in callers | `secrets.*` is forbidden in `with:` blocks of workflow_call. Splitting build (caller) and deploy (reusable) is the cleanest compromise. |
| `gitleaks` binary, not the action | The official `gitleaks-action@v2` requires a paid license for org use since 2024. The binary is unrestricted. |
| Lefthook, not husky | Husky 9+ requires Node setup before hooks run (slow). Lefthook is a single Go binary, faster, and language-agnostic. |
| `v1` tag force-moves | Industry-standard pattern (`actions/checkout@v4`, etc.). Callers get bug fixes automatically; breaking changes require a new major. |
| Branch protection via skill, not Terraform | Setting up Terraform for ~5 rules across ~10 repos costs more than it saves. The skill is idempotent, runnable on any repo in seconds, and version-controlled in the same custodian. |

### Pitfalls we hit (and resolved)

- **YAML quote-mixing in expressions** — Embedding `'staging'` inside a single-quoted YAML string broke the parser. Resolution: pre-compute the value in a bash step and read it via `env.X`.
- **Nested reusable workflows** — Calling `reusable-secret-scan.yml` from inside `reusable-pr-checks.yml` was rejected at parse time. Resolution: inline the secret-scan steps directly in the parent reusable.
- **`gitleaks` `regexTarget` default** — Allowlist regexes match the *full match line* by default, not the secret. Set `regexTarget = "secret"` to match against just the secret value.
- **`package-lock.json` out of sync** — Adding devdeps to `package.json` without running `npm install` locally breaks `npm ci` in CI. Always regenerate the lockfile alongside dep changes.
- **GitHub API rate limits** — Force-moving tags + many `gh` calls in a tight loop hits the 5000/hr core limit. Use `ScheduleWakeup` to cool off rather than retrying.

---

## Pilot rollout status

The first wave covers four representative repos chosen for breadth (frontend + BFF + Python APIs + multi-tenant frontend with no prior CI):

| Repo | Runtime | Baseline | Deploy migration | Branch protection |
|---|---|---|---|---|
| `machina-studio` | Node (Next.js / npm) | ✅ #229 | ✅ #230 | ✅ `main`, `staging` |
| `sportingbot-web` | Node (Next.js / npm) | ✅ #99 (combined) | ✅ #99 (4 envs: dev/stg/prd/prod) | ✅ `main` |
| `machina-client-api` | Python (Flask / pdm) | ✅ #207 | ⏳ pending | ✅ `master`, `staging` |
| `machina-core-api` | Python (Flask / pdm) | ✅ #155 | ⏳ pending | ✅ `master` |

Notable wins surfaced during the pilot:

- `machina-studio`'s `.eslintrc.json` had an **invalid trailing comma** that went unnoticed because `next lint` never ran in CI before this work.
- `sportingbot-web` had **zero PR-time CI** and a leftover `.env.local.staging` file in the working tree — exactly the class of risk the env-guard now catches.
- `gitleaks` raised real signal (PostHog public keys hardcoded in workflows) and led to a vetted public-key allowlist that benefits the whole org.

## Pending migrations (Python APIs)

Both Python repos have their PR enforcement layer in place. Their **deploy workflows** still need migration to the build-inline + `reusable-deploy-aks.yml` pattern.

### `machina-client-api` — build-only repo (no migration applied)

Investigation revealed that all 8 deploy-named workflows in client-api are actually **build-only**: they build Docker images and push them to the registry, but **none of them call `kubectl set image`**. AKS deploys for `machina-client-api` happen outside CI — manually via `kubectl` or through ad-hoc skills.

Because `reusable-deploy-aks.yml` has nothing to replace in build-only workflows, the migration was deliberately skipped. The existing workflows continue to work; if the team later decides to automate the deploy step, that becomes a separate architectural decision (with its own PR adding a `deploy` job per workflow, just like core-api now does).

What remains for client-api in this iteration:
- Baseline configs ✅ (#207)
- Branch protection ✅
- Deploy migration: **N/A** (build-only)
- Future: optionally modernize action versions (`actions/checkout@v2` → `v4`, etc.) to clear Node 20 deprecation warnings — low risk, separate PR.

### `machina-core-api` — 7 workflows to migrate

```
build-mcp-staging.yml             ← MCP server, staging
build-mcp-release-production.yml  ← MCP server, production (gated)
release-staging.yml               ← main API, staging
release-production.yml            ← main API, production (gated)
unit-tests-pr.yml                 ← stays as-is (already runs pytest on PR)
test-pr.yml                       ← review for overlap with unit-tests-pr
unit-test-mcp.yml                 ← MCP unit tests
pull.yml                          ← legacy Slack notify (will be removed)
```

Same pattern as client-api. Notable: `unit-tests-pr.yml` is left intact — it runs pytest on Python paths and is complementary to the `pdm install` validation that `pr.yml` does.

### Why the deploy migration is split from the baseline PR

Mixing PR enforcement (low-risk, no behavior change to deploys) with deploy refactors (risk: breaking real production tags) would have made review impossible and merge slow. Separating them means:

- Baseline PR is small, fast to review, and zero risk to existing deploys.
- Deploy PR is larger but each workflow is independently verifiable (push a `v.staging-test.<n>` tag, check AKS rollout, repeat).
- If something breaks after the deploy PR, the rollback is `git revert` of one PR, not a multi-purpose merge.

### Risk and verification plan for the deploy migration

For each workflow being migrated:

1. **Diff isolation** — Each workflow change is one commit. The PR diff lists exactly the trigger + build-args being preserved.
2. **Smoke test in staging** — Push a throw-away tag (e.g. `v.staging-baseline-test.1`), confirm the build completes and the deploy reaches AKS. The new pattern is identical to the studio migration that has been running in production since the previous PR.
3. **Production gate verification** — For prod workflows, the `production` Environment must be configured in the repo's `Settings → Environments` with required reviewers BEFORE merge. Without that, `environment: production` auto-approves and the gate is meaningless.
4. **Slack continuity** — All deploy workflows currently post to Slack; the reusable preserves this with `continue-on-error: true` so a missing `SLACK_WEBHOOK` doesn't break deploys.
5. **Rollback path** — `kubectl set image` is reversible: re-run the workflow with the previous good `image_tag` via the manual `workflow_dispatch` redeploy path.

Both Python repos retain their existing `pull.yml` (Slack-only notify on PR open) until branch protection is verified to require only the new checks. Once stable, `pull.yml` is removed in a third small PR.

---

## How a single PR moves through the system

1. **Developer opens PR** against `staging` or `main`.
2. GitHub auto-injects the org-level `PULL_REQUEST_TEMPLATE.md` (no per-repo file needed).
3. CI triggers `pr.yml` in the repo, which calls four reusable workflows in parallel:
   - `reusable-semantic-pr.yml` validates the title.
   - `reusable-pr-checks.yml` runs env-guard, runtime checks, and gitleaks.
4. **Locally**, every commit on the branch goes through `lefthook`:
   - `pre-commit`: refuses any `.env` file; runs lint/typecheck on staged files.
   - `commit-msg`: refuses non-Conventional-Commit messages.
5. Once checks pass and CODEOWNERS-required reviewers approve, the PR is merged (squash). Branch protection rules enforce that the merge can only happen with green checks.
6. **Tag-driven deploys** trigger separate workflows:
   - `v.staging-*` → `build-staging.yml` → `build-and-push` → `reusable-deploy-aks.yml@v1` → AKS staging.
   - `v.production-*` (or repo-specific equivalent like `v.release-*` for studio, `v.sbot-prod-*` for sportingbot) → production deploy with `environment: production` gate. Required reviewer approves; deploy proceeds.

The whole loop — from a developer typing `git commit` through merge to AKS — is enforced by the same baseline, regardless of repo or runtime.
