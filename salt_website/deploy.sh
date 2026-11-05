#!/usr/bin/env bash
# deploy.sh — Build the SALT website and copy dist/ to a web server directory.
#
# Usage:
#   ./deploy.sh                          # Build only (outputs to dist/)
#   ./deploy.sh --target /var/www/salt   # Build and copy to target directory
#   ./deploy.sh --target user@host:/path # Build and rsync to remote
#
# Prerequisites:
#   - Node.js 22.23.4+ and npm installed (Astro 7)
#   - Run from inside salt_website/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
      ;;
    --help|-h)
      grep '^#' "$0" | cut -c3-
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

cd "$SCRIPT_DIR"

echo "==> Installing dependencies..."
npm install --prefer-offline 2>/dev/null || npm install

echo "==> Building site..."
npm run build

echo "==> Build complete. Output: $SCRIPT_DIR/dist/"

if [[ -n "$TARGET" ]]; then
  echo "==> Deploying to: $TARGET"
  if [[ "$TARGET" == *:* ]]; then
    # Remote target — use rsync over SSH
    rsync -avz --delete dist/ "$TARGET"
  else
    # Local target — copy
    mkdir -p "$TARGET"
    cp -r dist/. "$TARGET/"
  fi
  echo "==> Deployed."
fi
