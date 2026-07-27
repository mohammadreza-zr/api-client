#!/usr/bin/env bash
#
# Publishes wiki/ to the repository's GitHub Wiki.
#
# One-time setup:
#   1. Enable the wiki: Repo → Settings → Features → check "Wikis"
#   2. Create the first page in the browser (GitHub does not create the
#      wiki git repository until a page exists)
#
# Then, whenever the docs change:
#   ./scripts/sync-wiki.sh
#
set -euo pipefail

REPO="${WIKI_REPO:-mohammadreza-zr/api-client}"
WIKI_URL="https://github.com/${REPO}.wiki.git"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/wiki"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ ! -d "$SRC" ]; then
  echo "✗ No wiki/ directory at $SRC" >&2
  exit 1
fi

echo "→ Cloning $WIKI_URL"
if ! git clone --quiet "$WIKI_URL" "$TMP/wiki" 2>/dev/null; then
  cat >&2 <<EOF
✗ Could not clone the wiki.

  The wiki git repository does not exist yet. To create it:
    1. Go to https://github.com/${REPO}/settings
       → Features → tick "Wikis"
    2. Go to https://github.com/${REPO}/wiki
       → "Create the first page" → Save (any content; it gets overwritten)
    3. Re-run this script.
EOF
  exit 1
fi

echo "→ Syncing pages"
find "$TMP/wiki" -maxdepth 1 -name '*.md' -delete
cp "$SRC"/*.md "$TMP/wiki/"

cd "$TMP/wiki"
if git diff --quiet && git diff --cached --quiet && [ -z "$(git status --porcelain)" ]; then
  echo "✓ Wiki already up to date"
  exit 0
fi

git add -A
git -c user.name="${GIT_AUTHOR_NAME:-docs-bot}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-docs-bot@users.noreply.github.com}" \
    commit --quiet -m "docs: sync wiki from repository"
git push --quiet origin HEAD

COUNT=$(find "$SRC" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')
echo "✓ Published $COUNT pages to https://github.com/${REPO}/wiki"
