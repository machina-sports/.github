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
| `reusable-semantic-pr.yml` | PR title must match `feat:`, `fix:`, etc | `pull_request` |
| `reusable-secret-scan.yml` | gitleaks scan (also embedded in pr-checks) | `pull_request` |
| `reusable-deploy-aks.yml` | `kubectl set image` to AKS, optional gating via `environment` input | After per-app build, or as standalone redeploy |

> **Why no `reusable-build-*.yml`?** GitHub Actions does not allow `secrets.*` references inside `with:` blocks of workflow_call inputs. Studio (and most apps) need secrets in their docker `build-args`. Each app handles its own build (with its own `vars` / `secrets`) inline, then calls `reusable-deploy-aks.yml` to deploy. See [docs/deploy-flow.md](docs/deploy-flow.md).

See [docs/deploy-flow.md](docs/deploy-flow.md) for the canonical `dev → stg → prd` lifecycle.

## Layout

```
.github/
├── PULL_REQUEST_TEMPLATE.md     ← propagated to every repo
├── CODEOWNERS                   ← default org-level owners
├── workflows/                   ← 4 reusable workflows (workflow_call)
└── actions/setup-and-build/     ← composite action used by builds
configs/                         ← templates copied into each repo
docs/
scripts/apply-baseline.sh
```

## Skills

This repo also exports a Claude Code plugin (`machina`) with org-level skills:

| Skill | Purpose |
|---|---|
| `/machina:setup-branch-protection` | Configure branch protection on a repo via `gh api` — required PR reviews, required status checks, force-push restrictions. See [skill.md](.claude/skills/setup-branch-protection/skill.md). |

To use, clone this repo locally and add the plugin path to your Claude Code config (or symlink `.claude-plugin/` into `~/.claude/skills/machina/`).

## Phases

- **Phase 1** (current): pilot in `machina-studio`. Configs distributed as **copyable templates** via `apply-baseline.sh`.
- **Phase 2**: replicate to `machina-client-api`, `machina-core-api`, `sportingbot-web`.
- **Phase 3** (deferred): promote configs to npm packages (`@machina/eslint-config`, `@machina/tsconfig`) when sync drift becomes painful.
