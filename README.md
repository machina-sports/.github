# `.github` — Machina Sports org-level automation

Single source of truth for shared automation across `machina-sports/*` repos:

- **Reusable GitHub Actions workflows** (lint, test, build, deploy `dev → stg → prd`)
- **Shared configs** (eslint, tsconfig, prettier, lefthook, commitlint, gitleaks)
- **Org defaults**: PR template, CODEOWNERS, contribution guide
- **`scripts/apply-baseline.sh`** — idempotent installer that brings any repo into compliance

## How to adopt in a repo

```bash
# From the repo root
curl -sSL https://raw.githubusercontent.com/machina-sports/.github/main/scripts/apply-baseline.sh | bash
```

Then commit the changes and open a PR. See [docs/adoption-guide.md](docs/adoption-guide.md).

## Reusable workflows

Each repo's `.github/workflows/*.yml` calls one of:

| Workflow | Purpose | Trigger in caller |
|---|---|---|
| `reusable-pr-checks.yml` | Lint, typecheck, test, build, secret scan | `pull_request` |
| `reusable-semantic-pr.yml` | PR title must match `feat:`, `fix:`, etc | `pull_request_target` |
| `reusable-build-staging.yml` | Docker build + push on `v.staging-*` tag | `push: tags: 'v.staging-*'` |
| `reusable-release-staging.yml` | `kubectl set image` on AKS | `workflow_call` after build |
| `reusable-release-production.yml` | Gated production deploy on `v.production-*` | `push: tags: 'v.production-*'` |

See [docs/deploy-flow.md](docs/deploy-flow.md) for the canonical `dev → stg → prd` lifecycle.

## Layout

```
.github/
├── PULL_REQUEST_TEMPLATE.md     ← propagated to every repo
├── CODEOWNERS                   ← default org-level owners
├── workflows/                   ← reusable workflows (workflow_call)
└── actions/setup-and-build/     ← composite action used by builds
configs/                         ← templates copied into each repo
docs/
scripts/apply-baseline.sh
```

## Phases

- **Phase 1** (current): pilot in `machina-studio`. Configs distributed as **copyable templates** via `apply-baseline.sh`.
- **Phase 2**: replicate to `machina-client-api`, `machina-core-api`, `sportingbot-web`.
- **Phase 3** (deferred): promote configs to npm packages (`@machina/eslint-config`, `@machina/tsconfig`) when sync drift becomes painful.
