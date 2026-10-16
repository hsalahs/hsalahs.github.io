#!/usr/bin/env bash
# Publishes the site files of this branch to the staging repo (GitHub Pages mirror), WITHOUT CNAME,
# tests, docs or SQL. Not part of the live site. Usage: supabase/publish-staging.sh /path/to/da3wt-staging
# All four app pages run on Supabase now (event.html included); the Firebase scripts are not published.
set -euo pipefail
DEST="${1:?path to the da3wt-staging clone}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SRC"
find "$DEST" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git ls-files | grep -Ev '^(tests/|supabase/|docs/|rules-tests/|CNAME$|package|playwright|firestore|firebase|CLAUDE\.md$|\.claude|\.github|\.gitignore$|sitemap\.xml$|robots\.txt$)' \
  | while read -r f; do mkdir -p "$DEST/$(dirname "$f")"; cp "$f" "$DEST/$f"; done
touch "$DEST/.nojekyll"
# 1) no indexing: every page gets a robots meta tag (the copy only, never the branch)
for h in "$DEST"/*.html; do
  sed -i -E '/<meta name="robots"[^>]*>/d' "$h"   # drop any existing robots tag (privacy.html says index)
  sed -i -E '0,/<head[^>]*>/s//&\n<meta name="robots" content="noindex, nofollow">/' "$h"
  grep -q 'content="noindex, nofollow"' "$h" || { echo "noindex missing in $h"; exit 1; }
done
# 2) the staging copy lives on the SAME origin as the live site (da3wt.com). The live service worker deletes
# every cache that is not its own, so give the staging worker its own cache prefix and make it delete only
# caches with that prefix (otherwise the two workers erase each other's offline shell).
sed -i "s/const CACHE_NAME = 'dawaat-scan-/const CACHE_NAME = 'dawaat-staging-scan-/" "$DEST/sw.js"
sed -i "s/keys.filter((k) => k !== CACHE_NAME)/keys.filter((k) => k.indexOf('dawaat-staging-') === 0 \&\& k !== CACHE_NAME)/" "$DEST/sw.js"
grep -q "dawaat-staging-scan-" "$DEST/sw.js" && grep -q "indexOf('dawaat-staging-') === 0" "$DEST/sw.js" || { echo "sw.js patch failed"; exit 1; }
printf 'User-agent: *\nDisallow: /\n' > "$DEST/robots.txt"
cat > "$DEST/README.md" <<'EOT'
# da3wt-staging

Test copy of the Supabase migration branch (GitHub Pages). Connects to the STAGING Supabase project only.
Published by script from the main repo; do not edit by hand. Not the live site.
EOT
echo "files: $(find "$DEST" -type f ! -path '*/.git/*' | wc -l)"
