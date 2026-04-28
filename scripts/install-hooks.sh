#!/bin/sh
set -e

HOOK_DIR="$(git rev-parse --git-dir)/hooks"
HOOK_FILE="$HOOK_DIR/pre-commit"
CHECK_CMD="node scripts/check-record-writes.js"

if [ -f "$HOOK_FILE" ] && grep -qF "$CHECK_CMD" "$HOOK_FILE"; then
  echo "Pre-commit hook already contains the record-writes check."
  exit 0
fi

if [ -f "$HOOK_FILE" ]; then
  echo "$CHECK_CMD" >> "$HOOK_FILE"
  echo "Appended record-writes check to existing pre-commit hook."
else
  printf '#!/bin/sh\n%s\n' "$CHECK_CMD" > "$HOOK_FILE"
  chmod +x "$HOOK_FILE"
  echo "Pre-commit hook installed successfully."
fi
