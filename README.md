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
| `reusable-evidence-gate.yml` | Reads the evidence block in the PR body and fails when a step has no evidence | `pull_request` |
| `reusable-secret-scan.yml` | gitleaks scan (also embedded in pr-checks) | `pull_request` |
| `reusable-deploy-aks.yml` | `kubectl set image` to AKS, optional gating via `environment` input | After per-app build, or as standalone redeploy |

> **Why no `reusable-build-*.yml`?** GitHub Actions does not allow `secrets.*` references inside `with:` blocks of workflow_call inputs. Studio (and most apps) need secrets in their docker `build-args`. Each app handles its own build (with its own `vars` / `secrets`) inline, then calls `reusable-deploy-aks.yml` to deploy. See [docs/deploy-flow.md](docs/deploy-flow.md).

See [docs/deploy-flow.md](docs/deploy-flow.md) for the canonical `dev → stg → prd` lifecycle.

## The evidence gate

`reusable-pr-checks.yml` proves the code builds. It cannot show that a human
exercised the change, and it leaves nothing a second person can re-check a week
later. `reusable-evidence-gate.yml` asks for exactly that, before merge, while the
author still remembers.

It reads five lines from the PR body — `task`, `repro`, `test`, `staging`,
`rollback` — and fails on an unticked box, an empty value, a leftover
`<placeholder>`, a one-word answer, a duplicated line, or a `staging:` line with
no deployed version and URL. Four of the five can be waived with
`n/a — <reason of at least 20 characters>`, printed in the check summary rather
than swallowed. `task:` cannot be waived.

The block lives in [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md),
so every repo without its own template gets it for free. Wiring the check is three
lines in the caller — see [docs/adoption-guide.md](docs/adoption-guide.md).

It ships in **warn** mode: with the repository variable `EVIDENCE_GATE` unset the
check annotates and never fails, so adopting it turns no open PR red. Two commands
make it blocking, and both are reversible.

**Why it exists.** On 2026-09-14, three `machina-studio` PRs had been open since
the 12th with all five required checks green, a well-written "Test plan" section,
and every box in it unticked. Nothing in CI read that section, so nothing said so.
They were mergeable that whole time with zero runtime verification.

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
