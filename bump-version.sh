#!/usr/bin/env bash
set -euo pipefail

# Bump the project version.
#
# Usage:
#   ./bump-version.sh           # increment patch (e.g. 0.1.1 -> 0.1.2)
#   ./bump-version.sh 0.2.0     # set an explicit version
#
# Updates:
#   - package.json (version field)
#   - package-lock.json (via npm install)
#   - CHANGELOG.md (adds a new section header)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Read current version from package.json.
CURRENT=$(node -p "require('./package.json').version")

if [ -z "$CURRENT" ]; then
    echo "Error: could not read current version from package.json"
    exit 1
fi

if [ $# -ge 1 ]; then
    NEW="$1"
else
    # Increment patch version.
    IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
    PATCH=$((PATCH + 1))
    NEW="${MAJOR}.${MINOR}.${PATCH}"
fi

if [ "$NEW" = "$CURRENT" ]; then
    echo "Already at version ${CURRENT}."
    exit 0
fi

echo "Bumping version: ${CURRENT} -> ${NEW}"

# Update package.json and package-lock.json.
npm version "$NEW" --no-git-tag-version --quiet 2>/dev/null
echo "  Updated package.json and package-lock.json"

# Add new CHANGELOG section if it doesn't already exist.
if ! grep -q "^## ${NEW}" CHANGELOG.md 2>/dev/null; then
    sed -i "0,/^## /s//## ${NEW}\n\n\n## /" CHANGELOG.md
    echo "  Added CHANGELOG.md section for ${NEW}"
fi

echo "Done. Version is now ${NEW}."
echo ""
echo "Next steps:"
echo "  1. Edit CHANGELOG.md with release notes"
echo "  2. Commit: git add -A && git commit -m \"Bump version to ${NEW}\""
