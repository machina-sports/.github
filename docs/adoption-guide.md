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

  evidence:
    uses: machina-sports/.github/.github/workflows/reusable-evidence-gate.yml@v1
    with:
      mode: ${{ vars.EVIDENCE_GATE }}
```

**Put every branch this repo actually ships from in `branches:`.** The filter is
the most common way these checks end up guarding nothing: `machina-core-api`
listed `[master, main, staging, develop]` while every release since 2026-09-04
went through `release-staging` / `release-production`, so five production PRs
merged with no secret scan and no tests. `sportingbot-web` had the same shape with
`stg/integration`. Read the repo's build and release workflows, not its default
branch, before writing this list.

### Arming the evidence gate

It reports as the status-check context **`evidence / Evidence gate`**. It ships in
warn mode; making it blocking is two commands, both reversible:

```bash
gh variable set EVIDENCE_GATE --repo machina-sports/<repo> --body enforce

# Append it to whatever is already required — list first, never overwrite blind
gh api repos/machina-sports/<repo>/branches/<branch>/protection/required_status_checks --jq '.contexts'
gh api -X PATCH repos/machina-sports/<repo>/branches/<branch>/protection/required_status_checks \
  -f 'contexts[]=<each existing context>' \
  -f 'contexts[]=evidence / Evidence gate'
```

Do not make it required before the workflow is on the target branch: a required
check that never reports leaves every PR waiting on a status that cannot arrive.
Checking is cheap — open a throwaway PR from a commit that predates the workflow
and confirm the check still reports, which it will, because `pull_request`
workflows are read from the merge ref.

### `.github/workflows/build-staging.yml`

Build is inline (because secrets aren't allowed in reusable `with:` blocks). The reusable handles the deploy.

```yaml
name: Build & deploy staging

on:
  push:
    tags: ['v.staging-*']

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
            ${{ secrets.REGISTRY_URL }}/my-app:${{ steps.set-tag.outputs.tag }}

  deploy:
    needs: build-and-push
    uses: machina-sports/.github/.github/workflows/reusable-deploy-aks.yml@v1
    with:
      app-name: my-app
      image-tag: ${{ needs.build-and-push.outputs.image-tag }}
      namespace: my-namespace
      deployment-name: my-deployment-staging
      container-name: my-container-staging
    secrets:
      REGISTRY_URL: ${{ secrets.REGISTRY_URL }}
      AZURE_CREDENTIALS: ${{ secrets.AZURE_CREDENTIALS }}
      SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK }}
```

### `.github/workflows/release-production.yml`

Same shape, plus `environment: production` for manual approval gating.

```yaml
name: Release production

on:
  push:
    tags: ['v.production-*']  # or v.release-*.* — your repo's convention

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    outputs:
      image-tag: ${{ steps.set-tag.outputs.tag }}
    steps:
      - uses: actions/checkout@v4
      - id: set-tag
        run: echo "tag=${GITHUB_REF#refs/tags/}" >> "$GITHUB_OUTPUT"
      # ...build+push (same pattern as staging, with prod build-args)

  deploy:
    needs: build-and-push
    uses: machina-sports/.github/.github/workflows/reusable-deploy-aks.yml@v1
    with:
      app-name: my-app
      image-tag: ${{ needs.build-and-push.outputs.image-tag }}
      environment: production       # ← gates the deploy on manual approval
      namespace: my-namespace
      deployment-name: my-deployment
      container-name: my-container
      rollout-timeout: 10m
    secrets:
      REGISTRY_URL: ${{ secrets.REGISTRY_URL }}
      AZURE_CREDENTIALS: ${{ secrets.AZURE_CREDENTIALS }}
      SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK }}
```

> **One-time setup**: in the repo, go to Settings → Environments → New → `production` → Required reviewers → add your team. Without this, `environment: production` auto-approves.

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
