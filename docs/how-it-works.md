# How `machina-sports/.github` Works

This document explains the architecture, mechanics, and trade-offs of the `machina-sports/.github` repository — the org-level automation custodian for all `machina-sports/*` repos.

## TL;DR

`machina-sports/.github` is a **public** repository at the org level that holds three categories of shared automation:

1. **GitHub-native propagation** — Files like `PULL_REQUEST_TEMPLATE.md` and `CODEOWNERS` are inherited automatically by every repo in the `machina-sports` org that doesn't define its own.
2. **Reusable workflows** — Generic CI/CD primitives (PR checks, deploys to AKS, secret scans) that any repo invokes via `uses: machina-sports/.github/.github/workflows/<name>.yml@v1`.
3. **Copyable config templates** — Files like `.gitignore.base`, `lefthook.yml`, `commitlint.config.mjs`, `gitleaks.toml`, `prettier.config.mjs`, `eslint.config.mjs`, `tsconfig.base.json` that the `apply-baseline.sh` script installs into each consumer repo.

Each repo opts in by running `apply-baseline.sh` once, then references reusable workflows from its own `.github/workflows/*.yml` files.

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
│   │   └── reusable-deploy-aks.yml        ← kubectl set image to AKS, optional gating
│   └── actions/
│       └── setup-and-build/               ← composite action used by callers' inline builds
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

### Pitfalls we hit (and resolved)

- **YAML quote-mixing in expressions** — Embedding `'staging'` inside a single-quoted YAML string broke the parser. Resolution: pre-compute the value in a bash step and read it via `env.X`.
- **Nested reusable workflows** — Calling `reusable-secret-scan.yml` from inside `reusable-pr-checks.yml` was rejected at parse time. Resolution: inline the secret-scan steps directly in the parent reusable.
- **`gitleaks` `regexTarget` default** — Allowlist regexes match the *full match line* by default, not the secret. Set `regexTarget = "secret"` to match against just the secret value.
- **`package-lock.json` out of sync** — Adding devdeps to `package.json` without running `npm install` locally breaks `npm ci` in CI. Always regenerate the lockfile alongside dep changes.
- **GitHub API rate limits** — Force-moving tags + many `gh` calls in a tight loop hits the 5000/hr core limit. Use `ScheduleWakeup` to cool off rather than retrying.

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
