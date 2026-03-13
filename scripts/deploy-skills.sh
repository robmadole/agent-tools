#!/usr/bin/env bash
#
# deploy-skills.sh — Synchronise top-level skills/ symlinks with
# the canonical skill directories under plugins/*/skills/*/.
#
# Usage:  bash scripts/deploy-skills.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_DIR="$REPO_ROOT/skills"

mkdir -p "$SKILLS_DIR"

# ── Remove stale symlinks (target no longer exists) ──────────────────────────
for link in "$SKILLS_DIR"/*; do
  [ -L "$link" ] || continue
  if [ ! -e "$link" ]; then
    echo "removing stale symlink: $(basename "$link")"
    rm "$link"
  fi
done

# ── Discover all plugin skills ───────────────────────────────────────────────
created=0
uptodate=0
errors=0

for skill_dir in "$REPO_ROOT"/plugins/*/skills/*/; do
  [ -d "$skill_dir" ] || continue

  skill_name="$(basename "$skill_dir")"
  link_path="$SKILLS_DIR/$skill_name"

  # Relative target from skills/ to the plugin skill directory
  rel_target="$(python3 -c "import os.path; print(os.path.relpath('$skill_dir', '$SKILLS_DIR'))")"

  # Check for collision: existing symlink pointing somewhere else
  if [ -L "$link_path" ]; then
    existing_target="$(readlink "$link_path")"
    if [ "$existing_target" = "$rel_target" ]; then
      uptodate=$((uptodate + 1))
      continue
    else
      echo "ERROR: naming collision for '$skill_name'"
      echo "  existing -> $existing_target"
      echo "  new      -> $rel_target"
      errors=$((errors + 1))
      continue
    fi
  fi

  # Check for collision: non-symlink file/directory already exists
  if [ -e "$link_path" ]; then
    echo "ERROR: '$link_path' exists and is not a symlink"
    errors=$((errors + 1))
    continue
  fi

  ln -s "$rel_target" "$link_path"
  echo "created symlink: skills/$skill_name -> $rel_target"
  created=$((created + 1))
done

echo ""
echo "deploy-skills: $created created, $uptodate up-to-date, $errors errors"

if [ "$errors" -gt 0 ]; then
  exit 1
fi
