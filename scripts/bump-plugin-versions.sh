#!/usr/bin/env bash
#
# bump-plugin-versions.sh — Increment the patch version of any plugin
# that has staged changes. Updates both the plugin's plugin.json and
# the top-level .claude-plugin/marketplace.json to keep them in sync.
#
# Usage:  bash scripts/bump-plugin-versions.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARKETPLACE="$REPO_ROOT/.claude-plugin/marketplace.json"

# ── Determine which plugins have staged changes ─────────────────────────────
staged_files="$(git -C "$REPO_ROOT" diff --cached --name-only)"

bumped=0

for plugin_dir in "$REPO_ROOT"/plugins/*/; do
  [ -d "$plugin_dir" ] || continue

  plugin_name="$(basename "$plugin_dir")"
  plugin_json="$plugin_dir.claude-plugin/plugin.json"

  [ -f "$plugin_json" ] || continue

  # Check if any staged file falls under this plugin's directory
  has_changes=false
  while IFS= read -r file; do
    case "$file" in
      plugins/"$plugin_name"/*) has_changes=true; break ;;
    esac
  done <<< "$staged_files"

  "$has_changes" || continue

  # Skip if the version was already manually bumped in this commit
  if echo "$staged_files" | grep -q "^plugins/${plugin_name}/.claude-plugin/plugin.json$"; then
    echo "skip: $plugin_name (plugin.json already staged — assuming manual version bump)"
    continue
  fi

  # ── Read current version and bump patch ──────────────────────────────────
  current_version="$(python3 -c "
import json, sys
with open('$plugin_json') as f:
    print(json.load(f)['version'])
")"

  IFS='.' read -r major minor patch <<< "$current_version"
  new_version="${major}.${minor}.$((patch + 1))"

  # ── Update plugin.json ───────────────────────────────────────────────────
  python3 -c "
import json
path = '$plugin_json'
with open(path) as f:
    data = json.load(f)
data['version'] = '$new_version'
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
"

  # ── Update marketplace.json ──────────────────────────────────────────────
  python3 -c "
import json, sys
path = '$MARKETPLACE'
with open(path) as f:
    data = json.load(f)
found = False
for plugin in data.get('plugins', []):
    if plugin['name'] == '$plugin_name':
        plugin['version'] = '$new_version'
        found = True
        break
if not found:
    print('WARNING: plugin \"$plugin_name\" not found in marketplace.json', file=sys.stderr)
    sys.exit(0)
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
"

  git -C "$REPO_ROOT" add "$plugin_json" "$MARKETPLACE"

  echo "bumped: $plugin_name $current_version -> $new_version"
  bumped=$((bumped + 1))
done

if [ "$bumped" -eq 0 ]; then
  echo "bump-plugin-versions: no plugins needed a version bump"
else
  echo ""
  echo "bump-plugin-versions: $bumped plugin(s) bumped"
fi
