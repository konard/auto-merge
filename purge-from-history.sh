#!/usr/bin/env sh
#
# purge-from-history.sh — Delete a path (directory or file) from every commit
#                        in the repository’s history using **only** native Git
#                        tooling, then prune backup refs and force‑push.
#
# Usage:
#   ./purge-from-history.sh "<path‑pattern>"  [remote]
#
#   <path‑pattern>  Path or glob to purge, e.g. "kaiten-lib" or "secret*.txt"
#   [remote]        Remote name to push to (default: origin)
#
# Typical workflow:
#   git clone --mirror https://github.com/you/your-repo.git cleaned.git
#   cd cleaned.git
#   ../purge-from-history.sh "kaiten-lib"      # script lives one dir up
#
# Caveats:
#   • This rewrites **all** branches and tags.  Collaborators must re‑clone
#     or hard‑reset once you push.
#   • filter‑branch is slower than git‑filter‑repo; be patient on large repos.
#   • The script deletes refs/original/* and runs git‑gc automatically.
#   • Requires Git ≥ 2.13 (for --prune-empty in filter‑branch).
#
set -eu

die()       { printf >&2 '%s\n' "$*"; exit 1; }
warn_pause() { printf '%s\n' "$*"; sleep 5; }

PATTERN=${1:-}
REMOTE=${2:-origin}

[ -n "$PATTERN" ] || die "✖️  Usage: $0 <path-pattern> [remote]"

command -v git >/dev/null 2>&1 || die "✖️  git not found"

git rev-parse --git-dir >/dev/null 2>&1 || die "✖️  Not inside a Git repository."

# Strongly recommend running in a mirror/bare repo
if [ "$(git rev-parse --is-bare-repository)" = "false" ]; then
  warn_pause "⚠️  WARNING: This is NOT a bare/mirror repo. \
Rewriting a working clone may destroy local work.\n    Ctrl‑C to abort, or wait 5 seconds to continue…"
fi

printf '▶ Stripping "%s" from history with git filter-branch…\n' "$PATTERN"

git filter-branch --force \
  --index-filter "git rm -r --cached --ignore-unmatch -- \"$PATTERN\"" \
  --prune-empty \
  --tag-name-filter cat -- --all

printf '▶ Deleting backup refs (refs/original/*)…\n'
for ref in $(git for-each-ref --format='%(refname)' refs/original/); do
  git update-ref -d "$ref"
done

printf '▶ Performing aggressive garbage‑collection…\n'
git gc --prune=now --aggressive

printf '▶ Force‑pushing cleaned history to remote \"%s\"…\n' "$REMOTE"
git push --force --prune --tags "$REMOTE" 'refs/heads/*'

printf '\n✔ All done!\n   Collaborators must now re‑clone or reset to the new history.\n'