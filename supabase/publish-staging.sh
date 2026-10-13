#!/usr/bin/env bash
# Publishes the site files of this branch to the staging repo (GitHub Pages mirror), WITHOUT CNAME,
# tests, docs or SQL. Not part of the live site. Usage: supabase/publish-staging.sh /path/to/da3wt-staging
# event.html and the Firebase scripts are left out until event.html moves to Supabase (they would talk to
# the live Firebase project).
set -euo pipefail
DEST="${1:?path to the da3wt-staging clone}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SRC"
find "$DEST" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git ls-files | grep -Ev '^(tests/|supabase/|docs/|rules-tests/|CNAME$|package|playwright|firestore|firebase|CLAUDE\.md$|\.claude|\.github|\.gitignore$|sitemap\.xml$|robots\.txt$|event\.html$)' \
  | while read -r f; do mkdir -p "$DEST/$(dirname "$f")"; cp "$f" "$DEST/$f"; done
touch "$DEST/.nojekyll"
printf 'User-agent: *\nDisallow: /\n' > "$DEST/robots.txt"
cat > "$DEST/README.md" <<'EOT'
# da3wt-staging

Test copy of the Supabase migration branch (GitHub Pages). Connects to the STAGING Supabase project only.
Published by script from the main repo; do not edit by hand. Not the live site.
EOT
echo "files: $(find "$DEST" -type f ! -path '*/.git/*' | wc -l)"
