---
name: setup-branch-protection
description: Configure branch protection rules on a machina-sports repo via gh api — requires PR + 1 review + the standard reusable-pr-checks status checks to be green before merge.
user_invocable: true
---

# Branch Protection Setup

You are configuring branch protection on a `machina-sports/<repo>` repository to enforce the org-level baseline. This applies the rules documented in [machina-sports/.github](https://github.com/machina-sports/.github) so that no merge to `main` / `master` / `staging` happens without:

- An open PR with at least 1 approval
- All required status checks green (semantic-pr, env-guard, secret-scan, runtime checks)
- The branch up-to-date with target

## Required information

Ask the user (or accept as args):

1. **Repo name** (default: detect from `git remote get-url origin` of the current working directory)
2. **Branches to protect** (default: the repo's default branch + `staging` if it exists)
3. **Runtime hint** (`node` | `python`) — for picking which `checks/Lint/typecheck/test/...` context applies. Auto-detect from `pr.yml` if not given.

## Steps

### 1. Verify prerequisites

```bash
# Must be authenticated with admin scope on the repo
gh auth status

# Verify the repo exists and you can access it
gh repo view <owner>/<repo> --json name,defaultBranchRef
```

If any of these fail, stop and explain what's needed.

### 2. Detect what status checks the repo's pr.yml emits

The `required_status_checks.contexts` array must contain exact-match check run names. Read the repo's `.github/workflows/pr.yml` (via `gh api`) to determine which contexts will actually run:

```bash
gh api "/repos/<owner>/<repo>/contents/.github/workflows/pr.yml" --jq '.content' | base64 -d
```

Look for `runtime: node` / `runtime: python` / `runtime: bun` to pick the right Node-or-Python context name.

The four standard contexts emitted by `reusable-pr-checks.yml`:

| Runtime | Context name (exact) |
|---|---|
| Always | `semantic-pr / Validate PR title` |
| Always | `checks / Block .env in diff` |
| Always | `checks / Secret scan (gitleaks)` |
| `node` or `bun` | `checks / Lint / typecheck / test / build (Node)` |
| `python` | `checks / Lint / typecheck / test (Python)` |

Some repos also have additional checks. Look for them and ASK the user whether to include them. Examples:
- `machina-core-api` has `test` from `unit-tests-pr.yml`
- Older repos may still have a legacy `notify` from `pull.yml` (do NOT include — it always passes vacuously)

### 3. Build the branch protection JSON

```json
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "semantic-pr / Validate PR title",
      "checks / Block .env in diff",
      "checks / Secret scan (gitleaks)",
      "checks / Lint / typecheck / test / build (Node)"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false,
  "required_conversation_resolution": true
}
```

Adjust `contexts` based on detection in step 2.

### 4. Apply the rule

```bash
# Save the JSON to a file
cat > /tmp/branch-protection.json <<'EOF'
{ ... }
EOF

# Apply to each branch
for branch in master staging; do
  echo "→ Protecting $branch on <owner>/<repo>..."
  gh api \
    --method PUT \
    -H "Accept: application/vnd.github+json" \
    "/repos/<owner>/<repo>/branches/$branch/protection" \
    --input /tmp/branch-protection.json
done
```

Catch and report 404s — the branch may not exist (e.g. `staging` is optional in some repos).

### 5. Verify

```bash
gh api "/repos/<owner>/<repo>/branches/master/protection" --jq '{
  required_status_checks: .required_status_checks.contexts,
  required_reviewers: .required_pull_request_reviews.required_approving_review_count,
  enforce_admins: .enforce_admins.enabled,
  allow_force_pushes: .allow_force_pushes.enabled
}'
```

Print a clean summary table to the user showing what was set per branch.

## Important guardrails

- **NEVER** include `enforce_admins: true` unless the user explicitly asks. The user is often the only admin and locking themselves out of emergency access is a real risk.
- **NEVER** include the legacy `notify` (Slack-only) check from `pull.yml` in required contexts — it always passes silently, defeats the purpose.
- **NEVER** set `restrictions` (push allowlist) without confirming with the user — easy to lock the team out.
- If the repo has zero existing PRs (brand new), the first PR will be the test. Tell the user.
- If any required context name is misspelled, branch protection will block ALL merges indefinitely. Verify the exact strings against actual past runs:
  ```bash
  gh run list -R <owner>/<repo> --workflow pr.yml --limit 1 --json status,conclusion --jq '.[0]'
  gh api "/repos/<owner>/<repo>/commits/<sha>/check-runs" --jq '.check_runs[].name'
  ```

## Recovery (if rules are wrong)

If the rule is misconfigured and blocks all merges, the user can override via UI (`Settings → Branches → Edit`) or via API:

```bash
# Remove the protection entirely
gh api --method DELETE "/repos/<owner>/<repo>/branches/master/protection"
```

Then re-run this skill with corrected inputs.
