# Adoption guide

How to bring a `machina-sports/*` repo into compliance with the org-level baseline.

## Step 1 — Apply the baseline

From the repo root:

```bash
# Option A: sibling clone (recommended for monorepo dev workflow)
cd ../  # parent of all machina repos
git clone git@github.com:machina-sports/.github.git machina-sports-org-github
cd <your-repo>
../machina-sports-org-github/scripts/apply-baseline.sh

# Option B: fetch latest from main
curl -sSL https://raw.githubusercontent.com/machina-sports/.github/main/scripts/apply-baseline.sh \
  | bash -s -- --remote
```

The script:
- Merges baseline into `.gitignore` (preserves local additions below the marker)
- Writes `lefthook.yml`, `.gitleaks.toml`, `.github/actionlint.yaml`
- For Node repos: `prettier.config.mjs`, `commitlint.config.mjs`; only writes `eslint.config.mjs` / `tsconfig.base.json` if absent

Run `apply-baseline.sh --check` later to detect drift.

## Step 2 — Install hooks

### Node repo

```bash
npm i -D lefthook @commitlint/cli @commitlint/config-conventional
npx lefthook install
# Remove obsolete husky if present:
npm rm husky && rm -rf .husky
```

### Python repo

```bash
brew install lefthook   # or: npm i -g lefthook
lefthook install
```

## Step 3 — Wire reusable workflows

Replace per-repo CI workflows with thin callers that invoke the shared workflows.

### `.github/workflows/pr.yml`

```yaml
name: PR

on:
  pull_request:
    branches: [main, staging]

jobs:
  semantic-pr:
    uses: machina-sports/.github/.github/workflows/reusable-semantic-pr.yml@v1

  checks:
    uses: machina-sports/.github/.github/workflows/reusable-pr-checks.yml@v1
    with:
      runtime: node              # or python
      package-manager: npm       # or pnpm | bun | pdm | poetry
      lint-cmd: 'npm run lint'
      typecheck-cmd: 'npx tsc --noEmit'
      test-cmd: ''               # leave blank if no tests yet
      build-cmd: 'npm run build'
```

### `.github/workflows/build-staging.yml`

```yaml
name: Build & deploy staging

on:
  push:
    tags: ['v.staging-*']

jobs:
  build:
    uses: machina-sports/.github/.github/workflows/reusable-build-staging.yml@v1
    with:
      app-name: machina-studio
      dockerfile: ./Dockerfile.build-staging
      namespace: machina-workspace
      deployment-name: machina-workspace-client-services-staging
      container-name: machina-workspace-studio-staging
      build-args: |
        NEXT_PUBLIC_FOO=${{ vars.NEXT_PUBLIC_FOO }}
    secrets:
      DOCKER_USERNAME: ${{ secrets.DOCKER_USERNAME }}
      DOCKER_PASSWORD: ${{ secrets.DOCKER_PASSWORD }}
      REGISTRY_URL: ${{ secrets.REGISTRY_URL }}
      AZURE_CREDENTIALS: ${{ secrets.AZURE_CREDENTIALS }}
      SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK }}
```

### `.github/workflows/release-production.yml`

```yaml
name: Release production

on:
  push:
    tags: ['v.production-*']

jobs:
  release:
    uses: machina-sports/.github/.github/workflows/reusable-release-production.yml@v1
    with:
      app-name: machina-studio
      namespace: machina-workspace
      deployment-name: machina-workspace-client-services-production
      container-name: machina-workspace-studio-production
    secrets:
      REGISTRY_URL: ${{ secrets.REGISTRY_URL }}
      AZURE_CREDENTIALS: ${{ secrets.AZURE_CREDENTIALS }}
      SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK }}
```

## Step 4 — Configure branch protection (manual, GitHub UI)

For both `main` and `staging`:

- ✅ Require pull request before merging
- ✅ Require approvals: 1
- ✅ Require status checks: `validate` (semantic-pr), `setup-node` (or `setup-python`), `env-guard`, `secret-scan`
- ✅ Require branches up to date
- ✅ Restrict force pushes
- ✅ Restrict deletions

## Step 5 — Verify

1. Open a draft PR with a trivial change. Confirm:
   - PR template appears (inherited from `.github` org repo)
   - All required checks run and pass
   - PR title `chore: foo` passes; `bad title` fails
2. Try `git commit -m "wip"` locally — lefthook commit-msg should reject.
3. Try staging a `.env` file — lefthook pre-commit should refuse.
4. Push tag `v.staging-main.<N+1>` — confirm AKS deploy via shared workflow.

## Drift check (recurring)

Add to monthly maintenance:

```bash
../machina-sports-org-github/scripts/apply-baseline.sh --check
```

If drift, open a PR titled `chore: re-sync baseline configs`.
