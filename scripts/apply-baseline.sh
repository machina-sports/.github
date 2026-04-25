#!/usr/bin/env bash
# apply-baseline.sh — idempotent installer that brings a Machina repo
# into compliance with the org-level baseline (configs + workflows).
#
# Usage:
#   ./apply-baseline.sh           # apply
#   ./apply-baseline.sh --check   # exit 1 if drift detected, no writes
#   ./apply-baseline.sh --remote  # fetch latest configs from machina-sports/.github
#
# Run from the target repo root.

set -euo pipefail

CHECK_MODE=0
REMOTE_MODE=0
for arg in "$@"; do
  case "$arg" in
    --check)  CHECK_MODE=1 ;;
    --remote) REMOTE_MODE=1 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [ ! -d .git ]; then
  echo "❌ Not a git repository (run from repo root)." >&2
  exit 1
fi

# Locate config source: either local sibling checkout or remote fetch.
if [ "$REMOTE_MODE" = "1" ]; then
  TMPDIR=$(mktemp -d)
  trap 'rm -rf "$TMPDIR"' EXIT
  echo "→ Fetching latest configs from machina-sports/.github main..."
  git clone --depth 1 https://github.com/machina-sports/.github.git "$TMPDIR/dot-github" >/dev/null 2>&1
  CONFIG_SRC="$TMPDIR/dot-github/configs"
else
  # Look for sibling checkout
  if [ -d "../machina-sports-org-github/configs" ]; then
    CONFIG_SRC="../machina-sports-org-github/configs"
  elif [ -d "../.github/configs" ]; then
    CONFIG_SRC="../.github/configs"
  else
    echo "❌ Cannot find configs/. Pass --remote or clone machina-sports/.github as a sibling." >&2
    exit 1
  fi
fi

echo "→ Source: $CONFIG_SRC"

# --- detect runtime ---
RUNTIME="unknown"
if [ -f package.json ]; then RUNTIME="node"; fi
if [ -f pyproject.toml ] || [ -f requirements.txt ]; then RUNTIME="python"; fi
echo "→ Detected runtime: $RUNTIME"

DRIFT=0

apply_or_diff() {
  local src="$1" dst="$2" label="$3"
  if [ ! -f "$src" ]; then
    echo "   skip $label (source missing)"
    return
  fi
  if [ "$CHECK_MODE" = "1" ]; then
    if [ ! -f "$dst" ] || ! diff -q "$src" "$dst" >/dev/null 2>&1; then
      echo "   DRIFT: $label"
      DRIFT=1
    else
      echo "   ok    $label"
    fi
  else
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    echo "   wrote $label"
  fi
}

# --- .gitignore: merge baseline at top, preserve repo-specific lines below marker ---
apply_gitignore() {
  local baseline="$CONFIG_SRC/.gitignore.base"
  local marker="# --- end of baseline (add repo-specific ignores below) ---"
  if [ ! -f .gitignore ]; then
    if [ "$CHECK_MODE" = "1" ]; then
      echo "   DRIFT: .gitignore (missing)"
      DRIFT=1
    else
      cp "$baseline" .gitignore
      echo "   wrote .gitignore"
    fi
    return
  fi
  # Extract local section (everything below marker)
  if grep -qF "$marker" .gitignore; then
    local_section=$(awk -v m="$marker" 'f{print} index($0,m){f=1}' .gitignore)
  else
    # Treat entire current file as local additions
    local_section=$(cat .gitignore)
  fi
  if [ "$CHECK_MODE" = "1" ]; then
    expected="$(cat "$baseline")"$'\n'"$local_section"
    actual="$(cat .gitignore)"
    if [ "$expected" != "$actual" ]; then
      echo "   DRIFT: .gitignore (baseline section)"
      DRIFT=1
    else
      echo "   ok    .gitignore"
    fi
  else
    {
      cat "$baseline"
      echo
      echo "$local_section"
    } > .gitignore.new
    mv .gitignore.new .gitignore
    echo "   wrote .gitignore (baseline merged, local additions preserved)"
  fi
}

echo
echo "→ Applying baseline files..."

apply_gitignore
apply_or_diff "$CONFIG_SRC/lefthook.yml"           "lefthook.yml"           "lefthook.yml"
apply_or_diff "$CONFIG_SRC/gitleaks.toml"          ".gitleaks.toml"         ".gitleaks.toml"
apply_or_diff "$CONFIG_SRC/actionlint.yaml"        ".github/actionlint.yaml" ".github/actionlint.yaml"

if [ "$RUNTIME" = "node" ]; then
  apply_or_diff "$CONFIG_SRC/prettier.config.mjs"  "prettier.config.mjs"    "prettier.config.mjs"
  apply_or_diff "$CONFIG_SRC/commitlint.config.mjs" "commitlint.config.mjs" "commitlint.config.mjs"
  # eslint and tsconfig are baselines — only write if missing (don't clobber repo-specific extends)
  if [ ! -f eslint.config.mjs ]; then
    apply_or_diff "$CONFIG_SRC/eslint.config.mjs"  "eslint.config.mjs"      "eslint.config.mjs (initial)"
  else
    echo "   skip eslint.config.mjs (already present — review manually)"
  fi
  if [ ! -f tsconfig.base.json ]; then
    apply_or_diff "$CONFIG_SRC/tsconfig.base.json" "tsconfig.base.json"     "tsconfig.base.json"
  else
    echo "   skip tsconfig.base.json (already present)"
  fi
fi

# --- post-apply hints (only on apply, not check) ---
if [ "$CHECK_MODE" = "0" ]; then
  echo
  echo "→ Next steps:"
  if [ "$RUNTIME" = "node" ]; then
    echo "   1. Install lefthook + commitlint:"
    echo "      npm i -D lefthook @commitlint/cli @commitlint/config-conventional"
    echo "      (or: pnpm add -D ... | bun add -d ...)"
    echo "   2. Activate hooks:  npx lefthook install"
    echo "   3. Remove old husky if present:  npm rm husky && rm -rf .husky"
  fi
  if [ "$RUNTIME" = "python" ]; then
    echo "   1. Install lefthook (brew install lefthook OR via npm):"
    echo "      brew install lefthook  # or  npm i -g lefthook"
    echo "   2. Activate hooks:  lefthook install"
  fi
  echo "   4. Verify CI:  open a draft PR and confirm reusable-pr-checks runs."
  echo "   5. Read docs/adoption-guide.md for the rest of the migration."
fi

echo
if [ "$CHECK_MODE" = "1" ]; then
  if [ "$DRIFT" = "1" ]; then
    echo "❌ Drift detected. Run without --check to apply."
    exit 1
  fi
  echo "✅ No drift — repo matches baseline."
else
  echo "✅ Baseline applied. Review changes with: git diff"
fi
